import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { freshStore, test, summary } from './helpers.mjs';
import { BillingService } from '../dist/src/billing/service.js';
import { LaunchBilling, LAUNCH_FIRST_PAYMENT_MS, LAUNCH_REDEEM_UNTIL_MS, LAUNCH_YEARLY_END_MS, launchGrant } from '../dist/src/billing/launch.js';

const { store, dataDir } = freshStore();
let clock = Date.parse('2026-10-01T12:00:00Z');
const billing = new BillingService(dataDir, store, 'https://hub.example.test', path.resolve('templates'), { now: () => clock, log: () => {} });
billing.updateConfig({ mode: 'live', stripe: { live: { secretKey: 'sk_live_offline_fixture_only', priceIds: { monthly: 'price_monthly', yearly: 'price_yearly', lifetime: 'price_lifetime' } } } });
const calls = [];
let loseResponse = false;
let number = 0;
let promotionExists = false;
let couponProducts = [];
let couponOverrides = {};
const sessions = new Map();
const fake = async (url, init) => {
  const parsed = new URL(url), p = parsed.pathname, params = new URLSearchParams(init.body ?? '');
  calls.push({ p, params, query: parsed.searchParams, key: init.headers['Idempotency-Key'] });
  let result;
  if (p.startsWith('/v1/prices/')) {
    const key = p.slice('/v1/prices/price_'.length), plan = billing.plan(key);
    result = { id: `price_${key}`, active: true, currency: plan.currency, unit_amount: plan.amountCents, product: 'prod_software', recurring: plan.interval ? { interval: plan.interval, interval_count: 1 } : null };
  } else if (p === '/v1/promotion_codes' && init.method === 'GET') result = { data: promotionExists ? [{ id: 'promo_launch', coupon: { id: 'coupon_launch', percent_off: 25, duration: 'forever' }, expires_at: LAUNCH_REDEEM_UNTIL_MS / 1000, customer: null, max_redemptions: null, restrictions: {} }] : [], has_more: false };
  else if (p === '/v1/coupons' && init.method === 'POST') { couponProducts = [...params].filter(([key]) => key.startsWith('applies_to[products][' )).map(([, value]) => value); result = { id: 'coupon_launch' }; }
  else if (p === '/v1/coupons/coupon_launch' && init.method === 'GET') result = { id: 'coupon_launch', percent_off: 25, duration: 'forever', ...couponOverrides, ...(parsed.searchParams.get('expand[0]') === 'applies_to' ? { applies_to: { products: [...couponProducts] } } : {}) };
  else if (p === '/v1/promotion_codes' && init.method === 'POST') { promotionExists = true; result = { id: 'promo_launch' }; }
  else if (p === '/v1/account') result = { capabilities: { crypto_payments: 'active' } };
  else if (p.startsWith('/v1/checkout/sessions/') && init.method === 'GET') {
    const parts = p.split('/'), session = [...sessions.values()].find(s => s.id === parts[4]);
    if (!session) throw Error('Unknown fixture session');
    result = parts[5] === 'line_items'
      ? { data: [{ quantity: 1, price: { id: session.priceId, product: session.product, unit_amount: session.amount } }], has_more: false }
      : session;
  }
  else if (p === '/v1/checkout/sessions') {
    const key = init.headers['Idempotency-Key'];
    result = sessions.get(key);
    if (!result) {
      result = { id: `cs_fixture${++number}`, url: `https://checkout.stripe.com/c/pay/cs_fixture${number}`, mode: params.get('mode'), metadata: metadata(params), livemode: true,
        client_reference_id: params.get('client_reference_id'), priceId: params.get('line_items[0][price]'), product: params.get('line_items[0][price_data][product]'), amount: Number(params.get('line_items[0][price_data][unit_amount]')) };
      sessions.set(key, result);
    }
    if (loseResponse) { loseResponse = false; throw Error('simulated lost response'); }
  } else throw Error(`Unexpected request ${p}`);
  return { ok: true, json: async () => result };
};
const launch = new LaunchBilling(dataDir, billing, store, 'https://hub.example.test', fake, () => clock);
const checkoutCalls = () => calls.filter(c => c.p === '/v1/checkout/sessions');
const input = (over = {}) => ({ plan: 'monthly', payment: 'card', attemptId: randomUUID(), ...over });
const metadata = params => Object.fromEntries([...params].filter(([k]) => /^metadata\[/.test(k)).map(([k,v]) => [k.slice(9,-1), v]));
const event = (type, object, id = randomUUID()) => ({ id: `evt_${id}`, type, livemode: true, createdMs: clock, object });
const paidSession = (meta, over = {}) => ({ id: `cs_fixture${number}`, mode: 'subscription', status: 'complete', payment_status: 'no_payment_required', customer: `cus_${number}`, customer_details: { email: `customer${number}@example.test`, name: 'Buyer' }, subscription: `sub_${number}`, metadata: meta, ...over });

await test('launch is opt-in and exact plan prices are prepared without activating checkout', async () => {
  await assert.rejects(launch.checkout(input()), /not enabled/);
  const prepared = await launch.prepare();
  assert.equal(prepared.prepared, true); assert.equal(prepared.enabled, false);
  assert.equal(prepared.cryptoCapable, true); assert.equal(prepared.cryptoEnabled, false);
  assert.equal(calls.find(c => c.p === '/v1/coupons').params.get('duration'), 'forever');
  assert.equal(calls.find(c => c.p === '/v1/promotion_codes' && c.params.size).params.get('expires_at'), String(LAUNCH_REDEEM_UNTIL_MS / 1000));
  await launch.prepare();
  const couponRead = calls.findLast(c => c.p === '/v1/coupons/coupon_launch');
  assert.equal(couponRead.query.get('expand[0]'), 'applies_to');
  launch.setEnabled(true, true);
  assert.equal(launch.status().cryptoEnabled, true);
  launch.setEnabled(false, false);
  assert.equal(launch.status().cryptoCapable, true);
  launch.setEnabled(true, true);
});
await test('existing UNLEASHED25 coupon with changed scope or terms is refused', async () => {
  couponOverrides = { percent_off: 20 };
  await assert.rejects(launch.prepare(), /different terms/);
  couponOverrides = {};
  couponProducts = ['prod_unrelated'];
  await assert.rejects(launch.prepare(), /different terms/);
  couponProducts = ['prod_software'];
});
await test('authenticated app checkout retains license; free period binds to fixed Eastern date', async () => {
  const license = store.issueUntil('Existing tester', LAUNCH_FIRST_PAYMENT_MS, 'beta', clock);
  const request = input({ licenseId: license.payload.id, token: license.token });
  await launch.checkout(request);
  const params = checkoutCalls().at(-1).params;
  assert.equal(params.get('subscription_data[billing_cycle_anchor]'), String(LAUNCH_FIRST_PAYMENT_MS / 1000));
  assert.equal(params.get('subscription_data[proration_behavior]'), 'none');
  assert.equal(params.get('payment_method_collection'), 'always');
  assert.equal(params.get('discounts[0][promotion_code]'), 'promo_launch');
  assert(!params.toString().includes(license.token)); assert(!params.toString().includes(license.payload.id));
  const meta = metadata(params), result = await billing.applyEvent(event('checkout.session.completed', paidSession(meta)));
  assert.equal(result.outcome, 'applied');
  const customer = billing.store.findByLicense(license.payload.id);
  assert(customer); assert.equal(customer.firstPaymentAtMs, LAUNCH_FIRST_PAYMENT_MS);
  assert.equal(customer.firstActualPaymentAtMs ?? null, null);
  assert.equal(store.list().length, 1);
  assert.equal((await launch.checkout(request)).ok, true);
  await assert.rejects(launch.checkout({ ...request, plan: 'yearly' }), /another request/);
});
await test('the first real paid invoice starts the refund clock after a free card period', async () => {
  await launch.checkout(input());
  const meta = metadata(checkoutCalls().at(-1).params);
  const session = paidSession(meta, { customer: 'cus_first_actual', subscription: 'sub_first_actual', customer_details: { email: 'actual@example.test', name: 'Actual' } });
  await billing.applyEvent(event('checkout.session.completed', session));
  assert.equal(billing.store.getCustomer(session.customer).firstActualPaymentAtMs ?? null, null);
  const invoice = { id: 'in_first_actual', customer: session.customer, paid: true, amount_paid: 7425,
    status_transitions: { paid_at: LAUNCH_FIRST_PAYMENT_MS / 1000 },
    parent: { subscription_details: { subscription: session.subscription, metadata: meta } },
    lines: { data: [{ period: { end: LAUNCH_FIRST_PAYMENT_MS / 1000 + 30 * 86400 }, price: { id: 'price_monthly', product: 'prod_software' } }] } };
  await billing.applyEvent(event('invoice.paid', invoice));
  assert.equal(billing.store.getCustomer(session.customer).firstActualPaymentAtMs, LAUNCH_FIRST_PAYMENT_MS);
});
await test('forged license proof, hosting plan and monthly crypto cannot create sessions', async () => {
  const n = checkoutCalls().length;
  await assert.rejects(launch.checkout(input({ licenseId: 'someone-else', token: 'invalid' })), /authentication/);
  await assert.rejects(launch.checkout(input({ plan: 'monthly-hosted' })), /software plan/);
  await assert.rejects(launch.checkout(input({ payment: 'crypto' })), /Yearly and Lifetime/);
  assert.equal(checkoutCalls().length, n);
});
await test('lost response reuses persisted Stripe request and idempotency key', async () => {
  const req = input(); loseResponse = true;
  await assert.rejects(launch.checkout(req), /lost response/);
  const previous = checkoutCalls().at(-1);
  clock += 60_000;
  await launch.checkout(req);
  assert.equal(checkoutCalls().at(-1).key, previous.key);
  assert.equal(checkoutCalls().at(-1).params.toString(), previous.params.toString());
});
await test('a paid webhook reconciles an exact session after the create response was lost', async () => {
  const req = input(); loseResponse = true;
  await assert.rejects(launch.checkout(req), /lost response/);
  const call = checkoutCalls().at(-1), session = sessions.get(call.key);
  const recovery = new BillingService(dataDir, store, 'https://hub.example.test', path.resolve('templates'), { now: () => clock, log: () => {}, launchFetch: fake });
  const paid = paidSession(metadata(call.params), { id: session.id, customer: 'cus_recovered', subscription: 'sub_recovered', customer_details: { email: 'recovered@example.test', name: 'Recovered' } });
  assert.equal((await recovery.applyEvent(event('checkout.session.completed', paid))).outcome, 'applied');
  assert.equal(recovery.store.getCustomer('cus_recovered').subscriptionId, 'sub_recovered');
  const intent = launchGrant(dataDir, metadata(call.params), true, session.id);
  assert.equal(intent.sessionId, session.id);
});
await test('a delayed paid webhook can recover a lost response after the idempotency window using exact Stripe line items', async () => {
  const req = input(); loseResponse = true;
  await assert.rejects(launch.checkout(req), /lost response/);
  const call = checkoutCalls().at(-1), session = sessions.get(call.key);
  clock += 24 * 3600_000;
  const recovery = new BillingService(dataDir, store, 'https://hub.example.test', path.resolve('templates'), { now: () => clock, log: () => {}, launchFetch: fake });
  const paid = paidSession(metadata(call.params), { id: session.id, customer: 'cus_late_recovery', subscription: 'sub_late_recovery', customer_details: { email: 'late@example.test', name: 'Late' } });
  assert.equal((await recovery.applyEvent(event('checkout.session.completed', paid))).outcome, 'applied');
  assert.equal(recovery.store.getCustomer('cus_late_recovery').subscriptionId, 'sub_late_recovery');
});
await test('a launch grant cannot be fulfilled by a different Checkout Session', async () => {
  await launch.checkout(input());
  const meta = metadata(checkoutCalls().at(-1).params);
  await assert.rejects(billing.applyEvent(event('checkout.session.completed', paidSession(meta, { id: 'cs_wrong' }))), /session does not match/);
});
await test('authenticated installations retain one durable pending attempt across service instances', async () => {
  const license = store.issueUntil('Pending', clock + 30 * 86400000, 'beta', clock);
  const first = input({ licenseId: license.payload.id, token: license.token });
  const original = await launch.checkout(first);
  const restarted = new LaunchBilling(dataDir, billing, store, 'https://hub.example.test', fake, () => clock);
  assert.equal((await restarted.checkout(input({ licenseId: license.payload.id, token: license.token }))).url, original.url);
  await assert.rejects(restarted.checkout(input({ licenseId: license.payload.id, token: license.token, plan: 'yearly' })), /already pending/);
  assert.equal((await restarted.checkout(first)).ok, true);
});
await test('a Stripe-confirmed expired checkout releases its authenticated installation for a new attempt', async () => {
  const license = store.issueUntil('Expired pending', clock + 30 * 86400000, 'beta', clock);
  const first = input({ licenseId: license.payload.id, token: license.token });
  await launch.checkout(first);
  const old = sessions.get(checkoutCalls().at(-1).key);
  old.status = 'expired';
  clock += 25 * 3600_000;
  const next = await launch.checkout(input({ licenseId: license.payload.id, token: license.token }));
  assert.notEqual(next.url, old.url);
});
await test('anonymous purchases sharing an email remain separate Stripe customers and licenses', async () => {
  const buy = async (customer) => {
    await launch.checkout(input());
    const meta = metadata(checkoutCalls().at(-1).params);
    const paid = paidSession(meta, { customer, subscription: `sub_${customer}`, customer_details: { email: 'shared@example.test', name: 'Buyer' } });
    assert.equal((await billing.applyEvent(event('checkout.session.completed', paid))).outcome, 'applied');
    return billing.store.getCustomer(customer);
  };
  const first = await buy('cus_shared_a'), second = await buy('cus_shared_b');
  assert.notEqual(first.licenseId, second.licenseId);
  assert.equal(first.subscriptionId, 'sub_cus_shared_a');
  assert.equal(second.subscriptionId, 'sub_cus_shared_b');
});
await test('a canceled subscriber can return on the same Stripe customer without stale cancellation undoing the new subscription', async () => {
  const license = store.issueUntil('Returning', clock + 30 * 86400000, 'beta', clock);
  const first = input({ licenseId: license.payload.id, token: license.token });
  await launch.checkout(first);
  const oldMeta = metadata(checkoutCalls().at(-1).params);
  const oldSub = 'sub_returning_old', customerId = 'cus_returning';
  await billing.applyEvent(event('checkout.session.completed', paidSession(oldMeta, { customer: customerId, subscription: oldSub, customer_details: { email: 'returning@example.test', name: 'Returning' } })));
  const row = billing.store.getCustomer(customerId);
  row.subscriptionStatus = 'canceled'; billing.store.putCustomer(row);
  const next = input({ licenseId: license.payload.id, token: license.token });
  await launch.checkout(next);
  const call = checkoutCalls().at(-1);
  assert.equal(call.params.get('customer'), customerId);
  const newSub = 'sub_returning_new';
  await billing.applyEvent(event('checkout.session.completed', paidSession(metadata(call.params), { customer: customerId, subscription: newSub, customer_details: { email: 'returning@example.test', name: 'Returning' } })));
  const canceled = event('customer.subscription.deleted', { id: oldSub, customer: customerId, status: 'canceled', items: { data: [{ price: { id: 'price_monthly', product: 'prod_software' } }] } });
  assert.equal((await billing.applyEvent(canceled)).outcome, 'ignored');
  assert.equal(billing.store.getCustomer(customerId).subscriptionId, newSub);
  assert.equal(billing.store.getCustomer(customerId).subscriptionStatus, 'active');
});
await test('an authenticated legacy email-keyed license follows its new Stripe customer identity', async () => {
  const email = 'legacy-bound@example.test';
  await billing.applyEvent(event('checkout.session.completed', { id: 'cs_legacy_bound', mode: 'payment', status: 'complete', payment_status: 'paid',
    customer: null, customer_details: { email, name: 'Legacy' }, metadata: { plan: 'yearly' }, payment_intent: 'pi_legacy_bound' }));
  const before = billing.store.getCustomer(`email:${email}`), token = store.tokenFor(before.licenseId);
  await launch.checkout(input({ licenseId: before.licenseId, token }));
  const call = checkoutCalls().at(-1), stripeCustomer = 'cus_legacy_bound', subscription = 'sub_legacy_bound';
  assert.equal(call.params.get('customer'), null);
  await billing.applyEvent(event('checkout.session.completed', paidSession(metadata(call.params), { customer: stripeCustomer, subscription, customer_details: { email, name: 'Legacy' } })));
  assert.equal(billing.store.getCustomer(`email:${email}`).stripeCustomerId, stripeCustomer);
  assert.equal(billing.store.findByStripeCustomer(stripeCustomer).licenseId, before.licenseId);
  const update = event('customer.subscription.updated', { id: subscription, customer: stripeCustomer, status: 'active', items: { data: [{ price: { id: 'price_monthly', product: 'prod_software' } }] } });
  assert.equal((await billing.applyEvent(update)).outcome, 'applied');
});
await test('prelaunch crypto yearly is paid once, grants Oct15 2027 only after settlement, and deduplicates', async () => {
  await launch.checkout(input({ plan: 'yearly', payment: 'crypto' }));
  const params = checkoutCalls().at(-1).params, meta = metadata(params);
  assert.equal(params.get('mode'), 'payment'); assert.equal(params.get('payment_method_types[0]'), 'crypto');
  assert.equal(params.get('line_items[0][price_data][unit_amount]'), '69900');
  assert.equal(params.get('subscription_data[billing_cycle_anchor]'), null);
  const session = paidSession(meta, { mode: 'payment', payment_status: 'unpaid', subscription: null });
  const before = store.list().length;
  assert.equal((await billing.applyEvent(event('checkout.session.completed', session))).outcome, 'ignored');
  assert.equal(store.list().length, before);
  const paid = { ...session, payment_status: 'paid' };
  assert.equal((await billing.applyEvent(event('checkout.session.async_payment_succeeded', paid))).outcome, 'applied');
  const customer = billing.store.getCustomer(session.customer), exp = store.get(customer.licenseId).exp;
  assert.equal(exp, LAUNCH_YEARLY_END_MS); assert.equal(customer.nonRenewing, true);
  assert.equal(customer.firstActualPaymentAtMs, clock);
  assert.equal((await billing.applyEvent(event('checkout.session.completed', paid))).outcome, 'duplicate');
  assert.equal(store.get(customer.licenseId).exp, exp);
});
await test('launch dates come from a mode-bound durable intent, not arbitrary webhook metadata', () => {
  assert.throws(() => launchGrant(dataDir, { wh_launch_intent: 'a'.repeat(64), plan: 'yearly' }, true), /persisted checkout/);
  const meta = metadata(checkoutCalls().at(-1).params);
  assert.throws(() => launchGrant(dataDir, meta, false), /persisted checkout/);
});
await test('October15 card charges immediately with discount; next day loses only new-redemption discount', async () => {
  clock = LAUNCH_FIRST_PAYMENT_MS;
  await launch.checkout(input());
  assert.equal(checkoutCalls().at(-1).params.get('subscription_data[billing_cycle_anchor]'), null);
  assert.equal(checkoutCalls().at(-1).params.get('discounts[0][promotion_code]'), 'promo_launch');
  assert.equal(checkoutCalls().at(-1).params.get('expires_at'), String(LAUNCH_REDEEM_UNTIL_MS / 1000));
  clock = LAUNCH_REDEEM_UNTIL_MS;
  await launch.checkout(input());
  assert.equal(checkoutCalls().at(-1).params.get('discounts[0][promotion_code]'), null);
});
await test('Checkout Sessions are bounded by the free-period cutoff when Stripe permits a 30-minute minimum', async () => {
  clock = LAUNCH_FIRST_PAYMENT_MS - 12 * 3600_000;
  await launch.checkout(input());
  assert.equal(checkoutCalls().at(-1).params.get('expires_at'), String(LAUNCH_FIRST_PAYMENT_MS / 1000));
  clock = LAUNCH_FIRST_PAYMENT_MS - 15 * 60_000;
  await launch.checkout(input());
  assert.equal(checkoutCalls().at(-1).params.get('expires_at'), null);
});
await test('a paid Lifetime purchase renews its technical token without another payment or a new identity', async () => {
  await launch.checkout(input({ plan: 'lifetime' }));
  const meta = metadata(checkoutCalls().at(-1).params);
  const session = paidSession(meta, { mode: 'payment', payment_status: 'paid', subscription: null });
  await billing.applyEvent(event('checkout.session.completed', session));
  const customer = billing.store.getCustomer(session.customer);
  assert.equal(customer.lifetimeAccess, true);
  assert.equal(customer.firstActualPaymentAtMs, clock);
  const before = store.get(customer.licenseId), oldToken = store.tokenFor(before.id);
  billing.refreshLifetimeLicense(before.id);
  assert.equal(store.tokenFor(before.id), oldToken, 'far from expiry does not rewrite tokens');
  clock = before.exp - 30 * 86400000;
  billing.refreshLifetimeLicense(before.id);
  const renewed = store.get(before.id);
  assert.equal(renewed.id, before.id); assert.equal(renewed.iat, clock);
  assert.equal(renewed.exp, clock + 3650 * 86400000);
  assert(store.decodeGenuine(oldToken), 'old authentic token can request its renewal');
  assert.equal(billing.subscriptionInfoFor(before.id).currentPeriodEndMs, null);
  clock = renewed.exp - 86400000;
  customer.refunded = true; billing.store.putCustomer(customer);
  billing.refreshLifetimeLicense(before.id);
  assert.equal(store.get(before.id).exp, renewed.exp, 'refunded entitlement never renews');
});
await test('test and live purchases with the same email cannot share a license or a Lifetime entitlement', async () => {
  clock = Date.parse('2026-10-01T12:00:00Z');
  billing.updateConfig({ mode: 'test' });
  const make = (customer, sessionId) => paidSession({ plan: 'lifetime' }, { customer, id: sessionId, mode: 'payment', payment_status: 'paid', subscription: null, customer_details: { email: 'same@example.test', name: 'Same buyer' } });
  const testEvent = { ...event('checkout.session.completed', make('cus_testmode', 'cs_testmode')), livemode: false };
  await billing.applyEvent(testEvent);
  await billing.applyEvent(event('checkout.session.completed', make('cus_livemode', 'cs_livemode')));
  const testCustomer = billing.store.getCustomer('cus_testmode'), liveCustomer = billing.store.getCustomer('cus_livemode');
  assert.notEqual(testCustomer.licenseId, liveCustomer.licenseId);
  assert.equal(testCustomer.lifetimeAccess, undefined); assert.equal(liveCustomer.lifetimeAccess, true);
  assert(store.get(testCustomer.licenseId).exp <= clock + 14 * 86400000);
});
await test('referrals retain attribution and free access while selecting a single best discount', async () => {
  billing.updateConfig({ mode: 'live' }); clock = Date.parse('2026-10-03T12:00:00Z');
  const referralLaunch = new LaunchBilling(dataDir, billing, store, 'https://hub.example.test', fake, () => clock,
    code => ({ code: 'MEMBER', promotionId: 'promo_referral', discountPercent: code === 'FORTY' ? 40 : 20 }));
  await referralLaunch.checkout(input({ referral: 'TWENTY' }));
  let params = checkoutCalls().at(-1).params;
  assert.equal(params.get('discounts[0][promotion_code]'), 'promo_launch');
  assert.equal(params.get('metadata[wh_earn_code]'), 'MEMBER');
  assert.equal(params.get('subscription_data[metadata][wh_earn_code]'), 'MEMBER');
  assert.equal(params.get('subscription_data[billing_cycle_anchor]'), String(LAUNCH_FIRST_PAYMENT_MS / 1000));
  await referralLaunch.checkout(input({ referral: 'FORTY' }));
  params = checkoutCalls().at(-1).params;
  assert.equal(params.get('discounts[0][promotion_code]'), 'promo_referral');
  assert.equal(params.get('metadata[launch_discount_percent]'), '40');
  assert.equal(params.get('discounts[1][promotion_code]'), null);
});
fs.rmSync(dataDir, { recursive: true, force: true });
summary('Launch billing');
