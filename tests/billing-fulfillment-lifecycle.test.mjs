import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { freshStore, test, summary } from './helpers.mjs';
import { BillingService } from '../dist/src/billing/service.js';
import { LaunchBilling, LAUNCH_FIRST_PAYMENT_MS } from '../dist/src/billing/launch.js';
import { FirstPaymentReminders } from '../dist/src/billing/reminders.js';
import { LaunchBillingReporting } from '../dist/src/billing/reporting.js';
import { AfterCommitOutbox } from '../dist/src/billing/after-commit-outbox.js';
import { signStripePayload } from '../dist/src/billing/stripe.js';

const { store, dataDir } = freshStore();
let now = Date.parse('2026-10-01T12:00:00Z');
const webhookSecret = 'whsec_lifecycle_fixture';
const providerMessages = [];
const processed = [];
const revoked = [];
const billingLogs = [];
const checkoutRequests = [];
const subs = new Map();
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const stripe = async (url, init = {}) => {
  const p = new URL(url).pathname;
  if (p.startsWith('/v1/prices/')) {
    const plan = p.split('/').at(-1).slice('price_'.length);
    const amounts = { monthly: 9900, yearly: 69900, lifetime: 99900 };
    return json({ id: `price_${plan}`, active: true, product: 'prod_software', unit_amount: amounts[plan], currency: 'usd',
      recurring: plan === 'lifetime' ? null : { interval: plan === 'monthly' ? 'month' : 'year', interval_count: 1 } });
  }
  if (p === '/v1/account') return json({ capabilities: { crypto_payments: 'active' } });
  if (p === '/v1/checkout/sessions' && init.method === 'POST') {
    const params = new URLSearchParams(init.body);
    checkoutRequests.push(params);
    const id = `cs_lifecycle_${checkoutRequests.length}`;
    return json({ id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get('mode'), metadata: metadata(params), livemode: true });
  }
  if (p.startsWith('/v1/subscriptions/') && init.method === 'GET') return json(subs.get(p.split('/').at(-1)));
  if (p === '/v1/invoices/create_preview' && init.method === 'POST') {
    const params = new URLSearchParams(init.body);
    return json({ customer: subs.get(params.get('subscription')).customer, currency: 'usd', amount_due: 7425 });
  }
  throw Error(`Unexpected fixture Stripe call: ${p}`);
};
const email = async (url, init) => {
  assert.equal(url, 'https://api.resend.com/emails');
  providerMessages.push(JSON.parse(init.body));
  return { ok: true, status: 200, text: async () => '{"id":"offline-fixture"}' };
};
const billing = new BillingService(dataDir, store, 'https://hub.example.test', path.resolve('templates'), {
  now: () => now, fetchLike: email, launchFetch: stripe, onVerifiedEvent: async event => { processed.push(event.id); },
  onRevoke: (id, reason) => revoked.push({ id, reason }), log: line => billingLogs.push(line),
});
billing.updateConfig({ mode: 'live', stripe: { live: { secretKey: 'sk_live_offlinefixtureonly', webhookSecret,
  priceIds: { monthly: 'price_monthly', yearly: 'price_yearly', lifetime: 'price_lifetime' } } },
email: { provider: 'resend', apiKey: 're_offline_fixture', from: 'Wick Hunter <billing@example.test>', replyTo: 'support@example.test' } });
const launch = new LaunchBilling(dataDir, billing, store, 'https://hub.example.test', stripe, () => now);
await launch.prepare();
launch.setEnabled(true, true);
const metadata = params => Object.fromEntries([...params].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value]));
let number = 0;
async function deliver(type, object) {
  const event = { id: `evt_lifecycle_${++number}`, object: 'event', type, livemode: true, created: Math.floor(now / 1000), data: { object } };
  const raw = Buffer.from(JSON.stringify(event));
  return { event, result: await billing.handleWebhook('live', raw, { 'stripe-signature': signStripePayload(raw, webhookSecret, Math.floor(now / 1000)) }) };
}
const invoice = (id, customer, subscription, meta, periodEndMs, amountPaid, reason = 'subscription_cycle') => ({
  id, object: 'invoice', customer, paid: true, amount_paid: amountPaid, billing_reason: reason,
  status_transitions: { paid_at: Math.floor(now / 1000) }, payment_intent: `pi_${id}`, charge: `ch_${id}`,
  parent: { subscription_details: { subscription, metadata: meta } },
  lines: { data: [{ period: { end: Math.floor(periodEndMs / 1000) }, price: { id: 'price_monthly', product: 'prod_software' } }] },
});

await test('signed trial checkout grants immediate access and pack, with one welcome and a durable post-commit event', async () => {
  await launch.checkout({ plan: 'monthly', payment: 'card', attemptId: randomUUID() });
  const params = checkoutRequests.at(-1), meta = metadata(params);
  assert.equal(params.get('subscription_data[billing_cycle_anchor]'), String(LAUNCH_FIRST_PAYMENT_MS / 1000));
  assert.equal(params.get('allow_promotion_codes'), 'true');
  const session = { id: 'cs_lifecycle_1', object: 'checkout.session', mode: 'subscription', status: 'complete',
    payment_status: 'no_payment_required', customer: 'cus_lifecycle', customer_details: { email: 'lifecycle@example.test', name: 'Lifecycle' },
    subscription: 'sub_lifecycle', metadata: meta };
  const { result } = await deliver('checkout.session.completed', session);
  assert.equal(result.status, 200); assert.equal(result.body.outcome, 'applied');
  const rec = billing.store.getCustomer(session.customer);
  assert.equal(rec.starterPackGrantedAtMs, now);
  assert.equal(rec.firstActualPaymentAtMs ?? null, null);
  assert.equal(rec.welcomeSentAtMs, now);
  assert.ok(store.get(rec.licenseId).exp >= LAUNCH_FIRST_PAYMENT_MS);
  assert.equal(providerMessages.length, 1);
  assert.match(providerMessages[0].text, /STARTER PACK/);
  const pageToken = /https:\/\/hub\.example\.test\/welcome\/([A-Za-z0-9_-]{40,})/.exec(providerMessages[0].text)?.[1];
  assert.ok(pageToken);
  const page = billing.welcomePage(pageToken, true);
  assert.equal(page.ok, true); assert.match(page.html, /Copy full pack/);
  assert.equal(processed.length, 0, 'after-commit work is not awaited by the webhook');
  assert.equal(new AfterCommitOutbox(dataDir).pending().length, 1);
  assert.deepEqual(await billing.drainAfterCommit(), { completed: 1, failed: 0 });
  assert.equal(processed.length, 1);
});

await test('verified preview produces one first-charge reminder, then paid and renewal invoices extend once', async () => {
  const rec = billing.store.getCustomer('cus_lifecycle');
  const meta = metadata(checkoutRequests[0]);
  subs.set(rec.subscriptionId, { id: rec.subscriptionId, customer: rec.stripeCustomerId, status: 'active',
    billing_cycle_anchor: LAUNCH_FIRST_PAYMENT_MS / 1000, cancel_at_period_end: false,
    metadata: { ...meta, first_payment_at_ms: String(LAUNCH_FIRST_PAYMENT_MS) },
    current_period_end: LAUNCH_FIRST_PAYMENT_MS / 1000,
    discounts: [{ coupon: { percent_off: 25, amount_off: null, duration: 'forever' } }],
    items: { data: [{ quantity: 1, price: { id: 'price_monthly', product: 'prod_software', currency: 'usd', unit_amount: 9900,
      recurring: { interval: 'month', interval_count: 1 } } }] } });
  const first = await deliver('invoice.paid', invoice('in_trial', rec.stripeCustomerId, rec.subscriptionId, meta, LAUNCH_FIRST_PAYMENT_MS, 0, 'subscription_create'));
  assert.equal(first.result.status, 200);
  assert.equal(billing.store.getCustomer(rec.key).firstActualPaymentAtMs ?? null, null);
  now = Date.parse('2026-10-13T12:00:00Z');
  const provider = async (url, init) => url === 'https://api.resend.com/emails'
    ? (providerMessages.push(JSON.parse(init.body)), json({ id: 'offline-reminder' })) : stripe(url, init);
  const reminders = new FirstPaymentReminders(billing, () => true, provider, () => now);
  await reminders.tick(); await new FirstPaymentReminders(billing, () => true, provider, () => now).tick();
  assert.equal(reminders.status().counts.sent, 1);
  assert.equal(providerMessages.length, 2);
  assert.match(providerMessages[1].text, /\$74\.25/);
  assert.match(providerMessages[1].text, /October 15, 2026/);
  const reporting = new LaunchBillingReporting(billing.store, () => billing.config(), stripe, () => now);
  const scheduled = await reporting.refresh();
  assert.equal(scheduled.byMode.live.scheduledPrelaunchStarts, 1);
  assert.equal(scheduled.byMode.live.scheduledMrrMinorByCurrency.usd, 7425);
  assert.equal(billing.store.getCustomer(rec.key).discountPercent, 25, 'the member discount follows the verified Stripe subscription');
  now = LAUNCH_FIRST_PAYMENT_MS;
  const november = Date.parse('2026-11-15T00:00:00-05:00');
  const paid = await deliver('invoice.paid', invoice('in_first_paid', rec.stripeCustomerId, rec.subscriptionId, meta, november, 7425));
  assert.equal(paid.result.status, 200);
  assert.equal(billing.store.getCustomer(rec.key).firstActualPaymentAtMs, now);
  const active = await reporting.refresh();
  assert.equal(active.byMode.live.activeRecurring, 1);
  assert.equal(active.byMode.live.mrrMinorByCurrency.usd, 7425);
  const firstExp = store.get(rec.licenseId).exp;
  now = november;
  const december = Date.parse('2026-12-15T00:00:00-05:00');
  const renewal = invoice('in_renewal', rec.stripeCustomerId, rec.subscriptionId, meta, december, 7425);
  assert.equal((await deliver('invoice.paid', renewal)).result.status, 200);
  const renewalExp = store.get(rec.licenseId).exp;
  assert.ok(renewalExp > firstExp);
  assert.equal(billing.store.getCustomer(rec.key).firstActualPaymentAtMs, LAUNCH_FIRST_PAYMENT_MS);
  assert.equal((await deliver('invoice.paid', renewal)).result.status, 200);
  assert.equal(store.get(rec.licenseId).exp, renewalExp, 'same invoice on a new event id adds no extra time');
  assert.equal(providerMessages.length, 2, 'invoices do not resend welcome or first-charge reminder');
});

await test('cancel retains paid-through access; full refund revokes it and hides starter pack', async () => {
  const rec = billing.store.getCustomer('cus_lifecycle');
  const before = store.get(rec.licenseId).exp;
  const update = { id: rec.subscriptionId, object: 'subscription', customer: rec.stripeCustomerId, status: 'active',
    cancel_at_period_end: true, items: { data: [{ price: { id: 'price_monthly', product: 'prod_software' } }] } };
  assert.equal((await deliver('customer.subscription.updated', update)).result.status, 200);
  assert.equal(billing.store.getCustomer(rec.key).subscriptionStatus, 'active (cancels at period end)');
  assert.equal((await deliver('customer.subscription.deleted', { ...update, status: 'canceled' })).result.status, 200);
  assert.equal(billing.store.getCustomer(rec.key).subscriptionStatus, 'canceled');
  assert.equal(store.get(rec.licenseId).exp, before);
  assert.equal(store.isRevoked(rec.licenseId), false);
  const refund = { id: 'ch_in_first_paid', object: 'charge', customer: rec.stripeCustomerId,
    payment_intent: 'pi_in_first_paid', amount: 7425, amount_refunded: 7425, refunded: true };
  assert.equal((await deliver('charge.refunded', refund)).result.status, 200);
  assert.equal(billing.store.getCustomer(rec.key).refunded, true);
  assert.equal(store.isRevoked(rec.licenseId), true);
  assert.equal(revoked.length, 1);
  const pageToken = /https:\/\/hub\.example\.test\/welcome\/([A-Za-z0-9_-]{40,})/.exec(providerMessages[0].text)[1];
  const page = billing.welcomePage(pageToken, true);
  assert.equal(page.ok, true);
  assert.doesNotMatch(page.html, /Copy full pack/);
});

await test('settled crypto and Lifetime purchases remain single grants on webhook retries', async () => {
  now = Date.parse('2026-10-02T12:00:00Z');
  for (const [plan, payment] of [['yearly', 'crypto'], ['lifetime', 'card']]) {
    await launch.checkout({ plan, payment, attemptId: randomUUID() });
    const params = checkoutRequests.at(-1), meta = metadata(params), sessionId = `cs_lifecycle_${checkoutRequests.length}`;
    const customerId = `cus_${plan}_lifecycle`;
    const discountPercent = plan === 'yearly' ? 25 : 40;
    const subtotal = plan === 'yearly' ? 69900 : 99900;
    const session = { id: sessionId, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid',
      customer: customerId, customer_details: { email: `${plan}-lifecycle@example.test`, name: 'One Time' },
      payment_intent: `pi_${plan}_lifecycle`, metadata: meta,
      amount_subtotal: subtotal, total_details: { amount_discount: subtotal * discountPercent / 100 } };
    const type = payment === 'crypto' ? 'checkout.session.async_payment_succeeded' : 'checkout.session.completed';
    const first = await deliver(type, session);
    assert.equal(first.result.status, 200);
    const rec = billing.store.getCustomer(customerId), exp = store.get(rec.licenseId).exp;
    assert.equal(rec.starterPackGrantedAtMs, now);
    assert.equal(rec.firstActualPaymentAtMs, now);
    assert.equal(rec.nonRenewing, true);
    assert.equal(rec.discountPercent, discountPercent, 'signed Checkout totals record the actual private discount');
    assert.equal((await deliver(type, session)).result.body.outcome, 'duplicate');
    assert.equal(store.get(rec.licenseId).exp, exp);
    if (plan === 'lifetime') {
      assert.equal(rec.lifetimeAccess, true);
      const priorToken = store.tokenFor(rec.licenseId);
      const refund = { id: 'ch_lifetime_lifecycle', object: 'charge', customer: customerId,
        payment_intent: session.payment_intent, amount: subtotal - session.total_details.amount_discount,
        amount_refunded: subtotal - session.total_details.amount_discount, refunded: true };
      assert.equal((await deliver('charge.refunded', refund)).result.status, 200);
      assert.equal(store.isRevoked(rec.licenseId), true);
      const replay = await deliver(type, session);
      assert.equal(replay.result.body.outcome, 'duplicate', JSON.stringify({ result: replay.result, lastLog: billingLogs.at(-1) }));
      assert.equal(store.isRevoked(rec.licenseId), true, 'a replay cannot restore refunded Lifetime access');
      await assert.rejects(launch.checkout({ plan: 'lifetime', payment: 'card', attemptId: randomUUID(),
        licenseId: rec.licenseId, token: priorToken }), /Invalid license authentication/,
      'a revoked license cannot be used to request a customer-bound replacement Checkout');
      await assert.rejects(billing.applyEvent({ id: 'evt_cross_customer_replay', type, livemode: true, createdMs: now,
        object: { ...session, customer: 'cus_other_lifecycle', customer_details: { email: 'other@example.test', name: 'Other' } } }),
      /changed customer/, 'another Stripe customer cannot reuse this applied session marker');
      assert.equal(billing.store.getCustomer('cus_other_lifecycle'), null);
      await launch.checkout({ plan: 'lifetime', payment: 'card', attemptId: randomUUID() });
      const nextParams = checkoutRequests.at(-1);
      assert.equal(nextParams.get('customer'), null);
      assert.equal(nextParams.get('customer_creation'), 'always');
      await assert.rejects(billing.applyEvent({ id: 'evt_same_customer_new_session', type, livemode: true, createdMs: now,
        object: { ...session, id: `cs_lifecycle_${checkoutRequests.length}`, metadata: metadata(nextParams) } }),
      /no license registry entry/, 'a new session assigned the revoked Stripe customer needs manual reconciliation');
      assert.equal(store.isRevoked(rec.licenseId), true);
      const repurchaseId = 'cus_lifetime_repurchase';
      const repurchase = await deliver(type, { ...session, id: `cs_lifecycle_${checkoutRequests.length}`,
        customer: repurchaseId, payment_intent: 'pi_lifetime_repurchase', metadata: metadata(nextParams) });
      assert.equal(repurchase.result.status, 200);
      const replacement = billing.store.getCustomer(repurchaseId);
      assert.notEqual(replacement.licenseId, rec.licenseId, 'anonymous Checkout creates a separate customer/license');
      assert.equal(store.isRevoked(replacement.licenseId), false);
      assert.equal(store.isRevoked(rec.licenseId), true, 'repurchase never unrevokes the old license');
    }
  }
  const queued = new AfterCommitOutbox(dataDir).pending().length;
  assert.ok(queued > 0);
  assert.deepEqual(await billing.drainAfterCommit(50), { completed: queued, failed: 0 });
  assert.equal(new AfterCommitOutbox(dataDir).pending().length, 0);
});

summary('billing-fulfillment-lifecycle');
