import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { freshStore, test, summary } from './helpers.mjs';
import { BillingService } from '../dist/src/billing/service.js';
import { CHECKOUT_SESSIONS_DIR } from '../dist/src/billing/store.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-01T12:00:00Z');

function setup() {
  const { store, dataDir } = freshStore();
  let now = NOW;
  const billing = new BillingService(dataDir, store, 'https://hub.example.test', path.resolve('templates'), { now: () => now, log: () => {} });
  billing.updateConfig({ mode: 'live', stripe: { live: { priceIds: { lifetime: 'price_lifetime' } } } });
  const setNow = value => { now = value; };
  const checkout = (paymentStatus = 'paid', paymentIntent = 'pi_paid_lifetime') => ({
    id: 'evt_lifetime_' + paymentStatus,
    type: 'checkout.session.completed', livemode: true, createdMs: now,
    object: { id: 'cs_paid_lifetime', mode: 'payment', status: 'complete', payment_status: paymentStatus,
      customer: 'cus_paid_lifetime', customer_details: { email: 'paid@example.test', name: 'Paid buyer' },
      subscription: null, payment_intent: paymentIntent, metadata: { plan: 'lifetime' } },
  });
  return { store, dataDir, billing, setNow, checkout };
}

await test('an applied paid Lifetime session migrates the missing flag and renews the technical token', async () => {
  const f = setup(); await f.billing.applyEvent(f.checkout());
  const rec = f.billing.store.getCustomer('cus_paid_lifetime');
  const first = f.store.get(rec.licenseId);
  delete rec.lifetimeAccess; delete rec.firstActualPaymentAtMs;
  rec.chargeIds = rec.chargeIds.filter(id => !id.startsWith('pi_'));
  rec.subscriptionId = 'sub_previous'; rec.subscriptionStatus = 'active';
  f.billing.store.putCustomer(rec);
  f.setNow(first.exp - 30 * DAY);
  f.billing.refreshLifetimeLicense(rec.licenseId);
  const after = f.store.get(rec.licenseId);
  assert.equal(f.billing.store.getCustomer(rec.key).lifetimeAccess, true);
  assert.equal(after.id, first.id);
  assert.equal(after.exp, first.exp - 30 * DAY + 3650 * DAY);
  assert.equal(f.billing.subscriptionInfoFor(rec.licenseId).currentPeriodEndMs, null);
  f.billing.refreshLifetimeLicense(rec.licenseId);
  assert.equal(f.store.get(rec.licenseId).exp, after.exp, 'migration and renewal are idempotent');
});

await test('a pre-marker paid Lifetime row needs both surviving Checkout and payment-intent evidence', async () => {
  const f = setup(); await f.billing.applyEvent(f.checkout());
  const rec = f.billing.store.getCustomer('cus_paid_lifetime');
  const before = f.store.get(rec.licenseId);
  fs.rmSync(path.join(f.dataDir, CHECKOUT_SESSIONS_DIR), { recursive: true, force: true });
  delete rec.lifetimeAccess; delete rec.firstActualPaymentAtMs;
  rec.subscriptionId = 'sub_previous'; rec.subscriptionStatus = 'canceled';
  f.billing.store.putCustomer(rec);
  f.setNow(before.exp - 20 * DAY);
  f.billing.refreshLifetimeLicense(rec.licenseId);
  assert.equal(f.billing.store.getCustomer(rec.key).lifetimeAccess, true);
  assert(f.store.get(rec.licenseId).exp > before.exp);
});

await test('plan text alone, or an unpaid Lifetime Checkout, cannot mint a recurring Lifetime entitlement', async () => {
  const noProof = setup(); await noProof.billing.applyEvent(noProof.checkout());
  const rec = noProof.billing.store.getCustomer('cus_paid_lifetime');
  const before = noProof.store.get(rec.licenseId);
  fs.rmSync(path.join(noProof.dataDir, CHECKOUT_SESSIONS_DIR), { recursive: true, force: true });
  rec.chargeIds = []; delete rec.lifetimeAccess;
  noProof.billing.store.putCustomer(rec);
  noProof.setNow(before.exp - 20 * DAY);
  noProof.billing.refreshLifetimeLicense(rec.licenseId);
  assert.equal(noProof.billing.store.getCustomer(rec.key).lifetimeAccess, undefined);
  assert.equal(noProof.store.get(rec.licenseId).exp, before.exp);

  const free = setup(); await free.billing.applyEvent(free.checkout('no_payment_required', null));
  const freeRec = free.billing.store.getCustomer('cus_paid_lifetime');
  const finite = free.store.get(freeRec.licenseId).exp;
  assert.equal(freeRec.lifetimeAccess, undefined, 'zero-due payment session is not paid evidence');
  free.setNow(finite - 20 * DAY);
  free.billing.refreshLifetimeLicense(freeRec.licenseId);
  assert.equal(free.store.get(freeRec.licenseId).exp, finite);
});

await test('pre-marker charge indexes do not prove Lifetime while another subscription remains active', async () => {
  const f = setup(); await f.billing.applyEvent(f.checkout());
  const rec = f.billing.store.getCustomer('cus_paid_lifetime');
  const before = f.store.get(rec.licenseId);
  fs.rmSync(path.join(f.dataDir, CHECKOUT_SESSIONS_DIR), { recursive: true, force: true });
  delete rec.lifetimeAccess;
  rec.subscriptionId = 'sub_other'; rec.subscriptionStatus = 'active';
  f.billing.store.putCustomer(rec);
  f.setNow(before.exp - 20 * DAY);
  f.billing.refreshLifetimeLicense(rec.licenseId);
  assert.equal(f.billing.store.getCustomer(rec.key).lifetimeAccess, undefined);
  assert.equal(f.store.get(rec.licenseId).exp, before.exp);
});

await test('refunded, disputed, mismatched, and corrupt evidence cannot migrate the Lifetime flag', async () => {
  for (const state of ['refunded', 'disputed', 'mismatched', 'corrupt']) {
    const f = setup(); await f.billing.applyEvent(f.checkout());
    const rec = f.billing.store.getCustomer('cus_paid_lifetime');
    const before = f.store.get(rec.licenseId);
    delete rec.lifetimeAccess;
    if (state === 'refunded') rec.refunded = true;
    if (state === 'disputed') rec.disputed = true;
    f.billing.store.putCustomer(rec);
    if (state === 'mismatched') {
      const marker = f.billing.store.getCheckoutSession('cs_paid_lifetime');
      marker.planKey = 'yearly';
      f.billing.store.putCheckoutSession(marker);
    }
    if (state === 'corrupt') {
      const digest = createHash('sha256').update('cs_paid_lifetime').digest('hex');
      fs.writeFileSync(path.join(f.dataDir, CHECKOUT_SESSIONS_DIR, `${digest}.json`), '{"sessionId":"wrong"}\n');
    }
    f.setNow(before.exp - 20 * DAY);
    f.billing.refreshLifetimeLicense(rec.licenseId);
    assert.equal(f.billing.store.getCustomer(rec.key).lifetimeAccess, undefined, state);
    assert.equal(f.store.get(rec.licenseId).exp, before.exp, state);
  }
});

summary();
