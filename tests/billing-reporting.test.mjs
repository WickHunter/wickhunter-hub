import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BillingStore } from '../dist/src/billing/store.js';
import { defaultBillingConfig } from '../dist/src/billing/config.js';
import { LaunchBillingReporting } from '../dist/src/billing/reporting.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-launch-report-'));
const store = new BillingStore(dir);
const now = Date.parse('2026-10-01T12:00:00Z');
const customer = (key, stripeCustomerId, subscriptionId, planKey, livemode = false) => ({
  key, stripeCustomerId, email: `${key}@example.test`, name: 'Private Customer', livemode, licenseId: `license-${key}`,
  planKey, subscriptionId, subscriptionStatus: subscriptionId ? 'active' : null, periodEndMs: null, chargeIds: [],
  createdAtMs: now, updatedAtMs: now, welcomeSentAtMs: null, welcomeError: null, disputed: false, refunded: false,
  lastEventType: null, lastEventAtMs: null,
});
store.putCustomer(customer('one', 'cus_one', 'sub_one', 'monthly'));
store.putCustomer(customer('two', 'cus_two', 'sub_two', 'yearly'));
store.putCustomer(customer('scheduled', 'cus_scheduled', 'sub_scheduled', 'monthly'));
store.putCustomer(customer('unknown-amount', 'cus_unknown', 'sub_unknown', 'monthly'));
store.putCustomer({ ...customer('live', 'cus_live', 'sub_live', 'monthly', true), launchManaged: true, discountPercent: 0 });
store.putCustomer(customer('yearly-onetime', '', null, 'yearly'));
store.putCustomer(customer('lifetime-onetime', '', null, 'lifetime'));
store.putRoleSubscription({ key: 'cus_one::hosting', customerKey: 'cus_one', role: 'hosting', livemode: false,
  subscriptionId: 'sub_foreign', subscriptionStatus: 'active', periodEndMs: null, chargeIds: [], disputed: false,
  refunded: false, createdAtMs: now, updatedAtMs: now, lastEventType: null, lastEventAtMs: null });
const config = defaultBillingConfig();
config.stripe.test.secretKey = 'sk_test_reportingonly123';
config.stripe.live.secretKey = 'sk_live_reportingonly456';
const firstPaymentAtMs = Date.parse('2026-10-15T00:00:00-04:00');
assert.equal(firstPaymentAtMs, 1792036800000, '2026-10-15 00:00 America/New_York is 04:00 UTC');
const subscription = (id, customer, metadata, price, status = 'active') => ({
  id, customer, status, cancel_at_period_end: false, current_period_end: 1794628800, metadata,
  ...(metadata.launch_discount_percent !== undefined ? { discounts: Number(metadata.launch_discount_percent) ? [{ coupon: { percent_off: Number(metadata.launch_discount_percent), amount_off: null, duration: 'forever' } }] : [] } : {}),
  items: { data: [{ quantity: 1, price }] },
});
const fixtures = {
  sub_one: subscription('sub_one', 'cus_one', { managed_by: 'wh-launch', plan: 'monthly', launch_discount_percent: '25' },
    { currency: 'usd', unit_amount: 9900, recurring: { interval: 'month', interval_count: 1 } }),
  sub_two: subscription('sub_two', 'cus_two', { managed_by: 'wh-launch', plan: 'yearly', launch_discount_percent: '25' },
    { currency: 'usd', unit_amount: 69900, recurring: { interval: 'year', interval_count: 1 } }),
  sub_scheduled: subscription('sub_scheduled', 'cus_scheduled', { managed_by: 'wh-launch', plan: 'monthly', launch_discount_percent: '25', first_payment_at_ms: String(firstPaymentAtMs) },
    { currency: 'eur', unit_amount: 10000, recurring: { interval: 'month', interval_count: 1 } }, 'trialing'),
  sub_unknown: subscription('sub_unknown', 'cus_unknown', { managed_by: 'wh-launch', plan: 'monthly' },
    { currency: 'usd', unit_amount: 5000, recurring: { interval: 'month', interval_count: 1 } }),
  sub_live: subscription('sub_live', 'cus_live', { managed_by: 'wh-launch', plan: 'monthly', launch_discount_percent: '0' },
    { currency: 'eur', unit_amount: 8000, recurring: { interval: 'month', interval_count: 1 } }),
  sub_foreign: subscription('sub_foreign', 'cus_foreign', { managed_by: 'wh-hosting', plan: 'monthly', launch_discount_percent: '25' },
    { currency: 'usd', unit_amount: 990000, recurring: { interval: 'month', interval_count: 1 } }),
};
const requests = [];
const fetcher = async (url, init = {}) => {
  requests.push({ url, init });
  assert.equal(init.method, 'GET', 'reporting must never write to Stripe');
  const subId = new URL(url).pathname.split('/').at(-1);
  assert.ok(!String(init.body || '').includes('sk_'), 'API secret never belongs in a request body');
  return new Response(JSON.stringify(fixtures[subId]), { status: 200, headers: { 'content-type': 'application/json' } });
};
const notifications = [];
const reporter = new LaunchBillingReporting(store, () => config, fetcher, () => now, { enqueue: n => notifications.push(n) });
const initial = await reporter.refresh();
fixtures.sub_one.discounts = [];
assert.equal((await reporter.refresh()).byMode.test.subscriptions.find(s => s.subscriptionId === 'sub_one').netMrrMinor, 9900,
  'removed live discount overrides stale original launch metadata');
fixtures.sub_one.discounts = [{ coupon: { percent_off: 10, amount_off: null, duration: 'forever' } }];
assert.equal((await reporter.refresh()).byMode.test.subscriptions.find(s => s.subscriptionId === 'sub_one').netMrrMinor, 8910,
  'changed live discount drives current revenue');
fixtures.sub_one.discounts = [{ coupon: { percent_off: 25, amount_off: null, duration: 'forever' } }];
await reporter.refresh();
const report = initial.byMode.test;
assert.equal(report.activeRecurring, 3);
assert.equal(report.scheduledPrelaunchStarts, 1);
assert.equal(report.oneTimePurchases.yearly, 1);
assert.equal(report.oneTimePurchases.lifetime, 1);
assert.equal(report.mrrMinorByCurrency.usd, 7425 + 4368.75, 'monthly and annual plans are net of 25% discount; annual is divided by 12');
assert.equal(report.scheduledMrrMinorByCurrency.eur, 7500);
assert.equal(report.mrrMinorByCurrency.eur, undefined, 'future starts do not inflate active MRR');
assert.equal(report.unknownAmountCount, 1, 'unknown discounts remain counted as subscriptions but add no guessed revenue');
assert.equal(report.subscriptions.some(s => s.subscriptionId === 'sub_foreign'), false, 'role-subscription hosting rows are never fetched or counted');
assert.equal(initial.byMode.live.activeRecurring, 1, 'test and live customers have separate totals');
assert.equal(initial.byMode.live.mrrMinorByCurrency.eur, 8000, 'a 0% launch discount remains exact');
fixtures.sub_live.discounts = [{ coupon: { percent_off: 40, amount_off: null, duration: 'forever' } }];
const privateCodeReport = await reporter.refresh();
assert.equal(privateCodeReport.byMode.live.mrrMinorByCurrency.eur, 4800,
  'a privately entered Stripe discount overrides the original zero-discount checkout metadata');
assert.equal(privateCodeReport.byMode.live.subscriptions[0].discountPercent, 40);
assert.equal(store.getCustomer('live').discountPercent, 40, 'the app subscription card receives the verified private discount');
fixtures.sub_live.discounts = [];
await reporter.refresh();
assert.equal(store.getCustomer('live').discountPercent, 0, 'removing the Stripe discount clears the app card');
assert.ok(requests.every(r => r.url.startsWith('https://api.stripe.com/v1/subscriptions/')));
assert.equal(JSON.stringify(initial).includes('sk_test_reportingonly123'), false);
assert.equal(JSON.stringify(initial).includes('Private Customer'), false);

const event = (type, object) => ({ id: 'evt_' + Math.random().toString(36).slice(2), type, livemode: false, createdMs: now, object });
const paidInvoice = { id: 'in_renew_1', customer: 'cus_one', subscription: 'sub_one', billing_reason: 'subscription_cycle',
  status: 'paid', paid: true, subscription_details: { metadata: { managed_by: 'wh-launch', plan: 'monthly' } } };
let result = await reporter.handleVerifiedEvent(event('invoice.paid', paidInvoice));
assert.equal(result.notices, 2, JSON.stringify(result));
assert.deepEqual(notifications.slice(-2).map(n => n.kind).sort(), ['discount', 'renewal']);
assert.ok(notifications.at(-1).fields.some(f => f.name === 'Active recurring subscriptions' && f.value === '3'));
assert.ok(notifications.at(-1).fields.some(f => f.name === 'Expected monthly revenue (USD)' && f.value === '$117.94'));
result = await reporter.handleVerifiedEvent(event('invoice.payment_succeeded', paidInvoice));
assert.equal(result.notices, 0, 'invoice.paid and invoice.payment_succeeded share durable invoice dedupe');
assert.equal(notifications.length, 2);

const checkout = { id: 'cs_signup_1', mode: 'subscription', status: 'complete', payment_status: 'paid', customer: 'cus_one',
  subscription: 'sub_one', metadata: { managed_by: 'wh-launch', plan: 'monthly' } };
result = await reporter.handleVerifiedEvent(event('checkout.session.completed', checkout));
assert.equal(result.notices, 1);
assert.equal(notifications.at(-1).key, 'test:cs_signup_1:signup');
assert.equal((await reporter.handleVerifiedEvent(event('checkout.session.completed', checkout))).notices, 0);

const failedInvoice = { ...paidInvoice, id: 'in_failed_1', billing_reason: 'subscription_cycle', status: 'open', paid: false };
result = await reporter.handleVerifiedEvent(event('invoice.payment_failed', failedInvoice));
assert.equal(result.notices, 1);
assert.equal(notifications.at(-1).kind, 'paymentFailed');

const foreignInvoice = { ...paidInvoice, id: 'in_foreign', customer: 'cus_one', subscription: 'sub_foreign' };
result = await reporter.handleVerifiedEvent(event('invoice.paid', foreignInvoice));
assert.equal(result.notices, 0);
assert.equal(requests.some(r => new URL(r.url).pathname.endsWith('/sub_foreign')), false);
const unknownInvoice = { ...paidInvoice, id: 'in_unknown', customer: 'cus_unlisted' };
const requestsBeforeUnknown = requests.length;
result = await reporter.handleVerifiedEvent(event('invoice.paid', unknownInvoice));
assert.equal(result.refreshed, false);
assert.equal(requests.length, requestsBeforeUnknown, 'unknown customers cause no Stripe request');

const initialInvoice = { ...paidInvoice, id: 'in_create_1', customer: 'cus_two', subscription: 'sub_two', billing_reason: 'subscription_create' };
result = await reporter.handleVerifiedEvent(event('invoice.paid', initialInvoice));
assert.equal(result.notices, 2, 'initial paid subscription invoice emits signup and discount notices');
const customerTwoCheckout = { id: 'cs_signup_two', mode: 'subscription', status: 'complete', payment_status: 'paid', customer: 'cus_two',
  subscription: 'sub_two', metadata: { managed_by: 'wh-launch', plan: 'yearly' } };
assert.equal((await reporter.handleVerifiedEvent(event('checkout.session.completed', customerTwoCheckout))).notices, 0,
  'a late Checkout event cannot duplicate an invoice-first signup notice');

fixtures.sub_one.status = 'canceled';
result = await reporter.handleVerifiedEvent(event('customer.subscription.deleted', { id: 'sub_one', customer: 'cus_one', status: 'canceled' }));
assert.equal(result.refreshed, true);
assert.equal(result.notices, 0);
assert.equal(result.snapshot.byMode.test.activeRecurring, 2, 'a fresh Stripe cancellation removes the subscription from active totals');
assert.equal(result.snapshot.byMode.test.mrrMinorByCurrency.usd, 4368.75);

store.putCustomer({ ...customer('one-time-private', 'cus_one_time_private', null, 'lifetime'), launchManaged: true, discountPercent: 40 });
const oneTime = { id: 'cs_one_time_private', mode: 'payment', status: 'complete', payment_status: 'paid',
  customer: 'cus_one_time_private', metadata: { managed_by: 'wh-launch', plan: 'lifetime' },
  amount_subtotal: 99900, total_details: { amount_discount: 39960 } };
result = await reporter.handleVerifiedEvent(event('checkout.session.completed', oneTime));
assert.equal(result.notices, 2, 'a verified one-time private code emits signup and discount notices');
assert.deepEqual(notifications.slice(-2).map(n => n.kind), ['signup', 'discount']);
assert.ok(notifications.at(-1).fields.some(f => f.name === 'Discount' && f.value === '40%'));
assert.equal((await reporter.handleVerifiedEvent(event('checkout.session.completed', oneTime))).notices, 0,
  'one-time discount notices dedupe by Checkout Session');

console.log('Launch billing report: known software subscriptions, normalized net MRR, scheduled starts, one-time counts and event dedupe passed');
