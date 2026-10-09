// tests/claude-deadline-charge-interleave.test.mjs — a regression pin written
// during the 2026-10-09 subscription-deadline recheck (see
// docs/claude-review-2026-10-09/SUBSCRIPTION-DEADLINE-RECHECK.md).
//
// v0.4.91 (8ac142d) admits an older `subscription_create` paid invoice that
// Stripe delivers AFTER the newer checkout event, but only while BOTH role
// records still read `lastEventType: checkout.session.*`. `charge.succeeded`
// is on the README's registered webhook list, is created at the same instant
// as that invoice, and is deliberately NOT ordering-relevant in the bundle
// ledger — so it can land between the checkout and the late invoice. This
// suite pins the two facts that keep it from defeating the admission:
//
//   1. With a hosting allowlist configured, a `charge.succeeded` for a bundle
//      customer whose charge nothing has indexed yet is `unclassified`
//      (roles.ts rule 5) and touches neither record, so the older initial
//      invoice is still admitted and the paid-through date still lands.
//   2. The one configuration in which that same charge WOULD classify as
//      "software" (roles.ts rule 3: hosting allowlist empty) is one in which
//      the Hub refuses to sell a bundle at all, so no bundle customer can
//      exist in it.
//
// Both were proved against the built service before this file was written;
// the first section is otherwise the shape of hosting-bundle.test.mjs's
// "checkout delivered before its older initial paid invoice" case.
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { signStripePayload } from "../dist/src/billing/stripe.js";
import { FakeProvider } from "../dist/src/hosting/provider.js";

const WHSEC = "whsec_test_bundle_0123456789";
const RELEASE = "b".repeat(64);
const DAY_MS = 86_400_000;

async function setup({ hostingAllowlist }) {
  let clock = Math.floor(Date.now() / 1000) * 1000;
  const provider = new FakeProvider({ now: () => clock });
  const h = await freshHub({}, {
    billingNow: () => clock, hostingNow: () => clock,
    billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    hostingProvider: provider,
    hostingFetch: async (url) => {
      if (url.includes("/v1/prices/")) {
        const id = url.split("/").pop();
        const annual = id === "price_bundle_year";
        return { ok: true, status: 200, text: async () => JSON.stringify({ id, active: true, unit_amount: annual ? 93900 : id === "price_bundle_month" ? 11900 : 2000, currency: "usd", type: "recurring", recurring: { interval: annual ? "year" : "month", interval_count: 1 } }) };
      }
      if (url.endsWith("/v1/checkout/sessions")) return { ok: true, status: 200, text: async () => JSON.stringify({ url: "https://checkout.stripe.com/c/pay_bundle" }) };
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  const admin = (p, body) => jsonReq(`${h.origin}${p}`, { method: "POST", headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  await admin("/admin/api/billing/config", {
    stripe: { test: { secretKey: "sk_test_bundle_0123456789", webhookSecret: WHSEC, priceIds: { "monthly-hosted": "price_bundle_month", "yearly-hosted": "price_bundle_year" } } },
    roles: { test: { hosting: { priceIds: hostingAllowlist } } },
    plans: [
      { key: "monthly", name: "Monthly", amountCents: 9900, currency: "usd", interval: "month", role: "software" },
      { key: "yearly", name: "Yearly", amountCents: 69900, currency: "usd", interval: "year", role: "software" },
      { key: "lifetime", name: "Lifetime", amountCents: 99900, currency: "usd", interval: null, licenseDays: 3650, lifetime: true, role: "software" },
      { key: "hosting-monthly", name: "Hosting", amountCents: 2000, currency: "usd", interval: "month", role: "hosting" },
      { key: "monthly-hosted", name: "Monthly + VPS", amountCents: 11900, currency: "usd", interval: "month", role: "software", checkout: "hosted-bundle" },
      { key: "yearly-hosted", name: "Yearly + VPS", amountCents: 93900, currency: "usd", interval: "year", role: "software", checkout: "hosted-bundle" },
    ],
  });
  await admin("/admin/api/hosting/policy", { policy: { provisioningEnabled: true, monthlyPriceCents: 2000, osId: "2284", releaseRef: RELEASE, maximumProjectedMonthlyProviderCostCents: 10000 } });
  const event = (id, type, object) => ({ id, object: "event", type, livemode: false, created: Math.floor(clock / 1000), data: { object } });
  async function post(ev) {
    const body = JSON.stringify(ev);
    const res = await fetch(`${h.origin}/api/billing/stripe/test`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, WHSEC, Math.floor(clock / 1000)) }, body });
    return { status: res.status, body: await res.json() };
  }
  return { h, event, post, advance: (ms) => { clock += ms; }, now: () => clock };
}

/** Checkout (newer) delivered first, then optionally the charge, then the
 *  older initial paid invoice. Returns what the records say afterwards. */
async function deliver(c, { withCharge, tag }) {
  const r = await c.h.hub.hosting.bundleCheckout("month", `123e4567-e89b-12d3-a456-4266141741${tag}`);
  assert.ok(r.ok, `bundle checkout reserved (${r.ok ? "" : r.error})`);
  const reserved = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const end = Math.floor((c.now() + 30 * DAY_MS) / 1000);
  const cus = `cus_${tag}`, sub = `sub_${tag}`;
  // T0: the initial paid invoice and its charge both pre-date the checkout.
  const invoice = c.event(`evt_inv_${tag}`, "invoice.paid", { id: `in_${tag}`, paid: true, status: "paid", billing_reason: "subscription_create", customer: cus, customer_email: `${tag}@example.com`, subscription: sub, subscription_details: { metadata }, charge: `ch_${tag}`, payment_intent: `pi_${tag}`, lines: { data: [{ period: { end }, price: { id: "price_bundle_month" } }] } });
  const charge = c.event(`evt_ch_${tag}`, "charge.succeeded", { id: `ch_${tag}`, customer: cus, payment_intent: `pi_${tag}`, invoice: `in_${tag}`, amount: 11900, billing_details: { email: `${tag}@example.com` } });
  c.advance(2000);
  const checkout = c.event(`evt_cs_${tag}`, "checkout.session.completed", { id: `cs_${tag}`, mode: "subscription", payment_status: "paid", customer: cus, customer_details: { email: `${tag}@example.com` }, subscription: sub, metadata });
  assert.equal((await c.post(checkout)).body.outcome, "applied", "checkout applied");
  const before = c.h.hub.billing.store.getCustomer(cus);
  assert.equal(before.periodEndMs, null, "checkout alone leaves the paid-through date unset (bootstrap grant)");
  const chargeOutcome = withCharge ? (await c.post(charge)).body.outcome : null;
  const between = c.h.hub.billing.store.getCustomer(cus);
  const hostingBetween = c.h.hub.billing.store.getRoleSubscription(cus, "hosting");
  const invoiceOutcome = (await c.post(invoice)).body.outcome;
  const after = c.h.hub.billing.store.getCustomer(cus);
  const policy = c.h.hub.billing.config().policy;
  return {
    chargeOutcome, invoiceOutcome,
    softwareLastEventTypeBetween: between.lastEventType,
    hostingLastEventTypeBetween: hostingBetween?.lastEventType ?? null,
    periodEndMs: after.periodEndMs, expectedPeriodEndMs: end * 1000,
    hostingPeriodEndMs: c.h.hub.billing.store.getRoleSubscription(cus, "hosting")?.periodEndMs ?? null,
    exp: c.h.hub.store.get(after.licenseId).exp,
    expectedExp: Math.min(end * 1000 + policy.graceDays * DAY_MS, before.createdAtMs + policy.testMaxDays * DAY_MS),
  };
}

await test("control: checkout then the older initial paid invoice is admitted (hosting-bundle.test.mjs's case)", async () => {
  const c = await setup({ hostingAllowlist: ["price_host1"] });
  try {
    const r = await deliver(c, { withCharge: false, tag: "ctl1" });
    assert.equal(r.invoiceOutcome, "applied");
    assert.equal(r.periodEndMs, r.expectedPeriodEndMs);
    assert.equal(r.hostingPeriodEndMs, r.expectedPeriodEndMs);
    assert.equal(r.exp, r.expectedExp);
  } finally { await c.h.close(); }
});

await test("a charge.succeeded delivered between the checkout and the older initial invoice cannot defeat the admission", async () => {
  const c = await setup({ hostingAllowlist: ["price_host1"] });
  try {
    const r = await deliver(c, { withCharge: true, tag: "chg1" });
    // The charge names nothing the bundle ledger or the role index has seen
    // yet, and hosting is configured, so roles.ts answers "unknown": it is
    // recorded for reconciliation and applied to neither record.
    assert.equal(r.chargeOutcome, "unclassified");
    assert.equal(r.softwareLastEventTypeBetween, "checkout.session.completed", "software record still reads checkout-only");
    assert.equal(r.hostingLastEventTypeBetween, "checkout.session.completed", "hosting record still reads checkout-only");
    // Therefore the admission in applyBundleEvent still fires.
    assert.equal(r.invoiceOutcome, "applied");
    assert.equal(r.periodEndMs, r.expectedPeriodEndMs, "paid-through date lands on the software record");
    assert.equal(r.hostingPeriodEndMs, r.expectedPeriodEndMs, "and on the hosting record");
    assert.equal(r.exp, r.expectedExp, "licence expiry is period end + grace (test-mode cap permitting), not the bootstrap grant");
  } finally { await c.h.close(); }
});

await test("the configuration in which that charge would classify as software cannot hold a bundle customer", async () => {
  const c = await setup({ hostingAllowlist: [] });
  try {
    // roles.ts rule 3 — an empty hosting allowlist defaults every unmatched
    // event to "software", which WOULD route charge.succeeded through
    // onChargeSucceeded's touch(). The Hub refuses to sell a bundle in that
    // state, so the ordering above cannot arise for a bundle customer.
    const r = await c.h.hub.hosting.bundleCheckout("month", "123e4567-e89b-12d3-a456-4266141741emp1");
    assert.equal(r.ok, false);
    assert.equal(r.code, "PROVISIONING_DISABLED");
    assert.match(r.error, /classified Stripe price/);
    assert.equal(c.h.hub.hosting.store.instances().length, 0);
  } finally { await c.h.close(); }
});

summary();
