// tests/foreign-product-family.test.mjs — B15 (the app repo's acceptance
// matrix, tests/marketplace-acceptance-matrix.test.mjs): "a marketplace
// invoice can never reach the licence billing endpoint." The app's own
// marketplace-subscription Stripe rail (src/marketplace-hub/rail-stripe.ts,
// a SEPARATE Stripe account/webhook secret from this Hub's licence billing)
// tags every checkout session and subscription it creates with
// `metadata.productFamily = "marketplace_strategy"`. A misconfigured
// webhook URL — or the two products sharing one Stripe account — can
// deliver that event to THIS Hub's licence endpoint instead
// (`POST /api/billing/stripe/{test,live}`). It must mint no licence, extend
// no expiry, and revoke nothing, ever.
//
// Section 1 proves the pure decision (`foreignProductFamilyRefusal`).
// Section 2 drives the DAY-1 DEFAULT scenario end to end over real HTTP —
// no hosting allowlist configured, which is roles.ts's OWN documented
// default ("no id match at all, and hosting has never been configured:
// default to software") and the exact gap a marketplace event would
// otherwise fall through: it carries no price/product id this Hub's
// allowlist could ever match (a marketplace price is created inline via
// Stripe's `price_data`, never one of this Hub's catalogued prices) and no
// `metadata.plan` this Hub's plan catalogue recognises, so nothing in
// roles.ts's id/allowlist dispatcher would ever call it "unknown" on its
// own — see foreign-product-family.ts's header for why this check must run
// BEFORE that dispatcher. Mutation-verified by hand against a copy of
// dist/ (never source, per CLAUDE.md): with the gate's call site removed
// from applyEvent, this suite's two B15 cases turn red — the marketplace
// checkout mints a licence and the marketplace renewal invoice extends the
// unrelated software customer's expiry. See the unit's report for the
// exact failures observed.
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { signStripePayload } from "../dist/src/billing/stripe.js";
import { foreignProductFamilyRefusal, KNOWN_FOREIGN_PRODUCT_FAMILY_MARKETPLACE } from "../dist/src/billing/foreign-product-family.js";

const DAY = 86_400_000;
const TEST_WHSEC = "whsec_test_foreign_0123456789";

// ── Section 1: the pure decision ────────────────────────────────────────────

await test("foreignProductFamilyRefusal: pure — blank/absent is never foreign, a tagged family always is", () => {
  assert.equal(foreignProductFamilyRefusal({ productFamily: "" }), null);
  assert.equal(foreignProductFamilyRefusal({ productFamily: "   " }), null, "whitespace-only is treated as blank");
  const marketplace = foreignProductFamilyRefusal({ productFamily: KNOWN_FOREIGN_PRODUCT_FAMILY_MARKETPLACE });
  assert.ok(marketplace, "a marketplace-tagged event is refused");
  assert.match(marketplace, /marketplace_strategy/);
  assert.match(marketplace, /not this Hub's own licence billing/);
  assert.match(marketplace, /refused before any licence was touched/);
  // a future, as-yet-unnamed foreign family is refused the same way — the
  // gate is "present at all", not an allowlist of known bad values:
  const other = foreignProductFamilyRefusal({ productFamily: "some_other_product" });
  assert.ok(other);
  assert.match(other, /some_other_product/);
});

// ── Section 2: driven end to end, the day-1 default (no hosting configured) ─

let clock = Math.floor(Date.now() / 1000) * 1000;
const h = await freshHub({}, { billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }), billingNow: () => clock });
const admin = (p, opts = {}) => jsonReq(`${h.origin}${p}`, { ...opts, headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json", ...(opts.headers ?? {}) } });

await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ stripe: { test: { webhookSecret: TEST_WHSEC } } }) });

let evSeq = 0;
const sec = () => Math.floor(clock / 1000);
const event = (type, object, id = `evt_${++evSeq}`) => ({ id, object: "event", type, livemode: false, created: sec(), data: { object } });
async function postEvent(ev, secret = TEST_WHSEC) {
  const body = JSON.stringify(ev);
  const res = await fetch(`${h.origin}/api/billing/stripe/test`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, secret, sec()) },
    body,
  });
  return { status: res.status, body: await res.json() };
}
const licenses = () => h.store.list();
const swRec = (key) => h.hub.billing.store.getCustomer(key);
const lastEventNote = async () => (await admin("/admin/api/billing/events?limit=1")).body.events[0];

// The app's own checkout-session shape (marketplace-hub/rail-stripe.ts's
// buildStripeCheckoutSessionRequest): `metadata.productFamily` on the
// SESSION itself.
const marketplaceCheckoutSession = () => ({
  id: "cs_mkt_1", object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
  customer: "cus_marketplace_follower", customer_details: { email: "follower@example.com", name: "A Follower" },
  subscription: "sub_mkt_1", payment_intent: null,
  metadata: { subscriptionId: "sub-int-1", checkoutId: "stc_1", followerId: "lic:alice", strategyId: "strategy-1", productFamily: "marketplace_strategy" },
});

// The app's own invoice shape for a renewal (BILL-02:
// subscription-billing-webhook.ts's own fixture) — `billing_reason:
// "subscription_cycle"`, the app's correlating metadata on
// `subscription_details.metadata`, and a price/product id from the app's
// OWN Stripe price (never one of this Hub's catalogued licence prices).
const marketplaceRenewalInvoice = () => ({
  id: "in_mkt_1", object: "invoice", customer: "cus_marketplace_follower",
  customer_email: "follower@example.com", customer_name: "A Follower",
  subscription: "sub_mkt_1", charge: "ch_mkt_1", payment_intent: "pi_mkt_1", paid: true, status: "paid",
  billing_reason: "subscription_cycle",
  subscription_details: { metadata: { subscriptionId: "sub-int-1", checkoutId: "stc_1", followerId: "lic:alice", strategyId: "strategy-1", productFamily: "marketplace_strategy" } },
  lines: { data: [{ period: { start: sec(), end: sec() + 30 * 86_400 }, price: { id: "price_marketplace_strategy_1", product: "prod_marketplace_strategy_1" } }] },
});

await test("B15: a marketplace checkout.session.completed hitting the licence endpoint mints NO licence, and the refusal is recorded", async () => {
  const beforeLicenses = licenses().length;
  const r = await postEvent(event("checkout.session.completed", marketplaceCheckoutSession()));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, "ignored", JSON.stringify(r.body));
  assert.equal(licenses().length, beforeLicenses, "no licence was minted for the marketplace checkout");
  assert.equal(swRec("cus_marketplace_follower"), null, "no CustomerRecord was created either");
  const ev = await lastEventNote();
  assert.equal(ev.outcome, "ignored");
  assert.match(ev.note, /marketplace_strategy/);
  assert.match(ev.note, /refused before any licence was touched/);
});

await test("B15: a marketplace invoice.paid (billing_reason: subscription_cycle) extends NO licence, and the refusal is recorded", async () => {
  // Seed an UNRELATED, real software customer first so there is a licence in
  // the store the marketplace event could wrongly reach if the gate failed —
  // sharing the Stripe account is exactly the hazard being reproduced.
  await postEvent(event("checkout.session.completed", {
    id: "cs_sw_1", object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
    customer: "cus_marketplace_follower", customer_details: { email: "follower@example.com", name: "A Follower" },
    subscription: "sub_software_real", payment_intent: null, metadata: { plan: "monthly" },
  }));
  const before = { ...swRec("cus_marketplace_follower") };
  assert.ok(before.licenseId, "the real software licence exists before the marketplace invoice arrives");

  const r = await postEvent(event("invoice.paid", marketplaceRenewalInvoice()));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, "ignored", JSON.stringify(r.body));
  const after = swRec("cus_marketplace_follower");
  assert.deepEqual(after, before, "THE FIX: the marketplace renewal invoice leaves the real software CustomerRecord byte-for-byte unchanged (no extension)");
  const ev = await lastEventNote();
  assert.equal(ev.outcome, "ignored");
  assert.match(ev.note, /marketplace_strategy/);
  assert.match(ev.note, /refused before any licence was touched/);
});

await test("the ordinary licence event still mints/extends exactly as before", async () => {
  const r = await postEvent(event("invoice.paid", {
    id: "in_sw_2", object: "invoice", customer: "cus_marketplace_follower",
    customer_email: "follower@example.com", customer_name: "A Follower",
    subscription: "sub_software_real", charge: "ch_sw_2", payment_intent: "pi_sw_2", paid: true, status: "paid",
    billing_reason: "subscription_cycle",
    lines: { data: [{ period: { start: sec(), end: sec() + 30 * 86_400 } }] },
  }));
  assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
  assert.equal(swRec("cus_marketplace_follower").periodEndMs, sec() * 1000 + 30 * DAY, "the real invoice DOES extend the licence — the gate refuses only the foreign-tagged event");
});

await h.close();

summary("foreign-product-family");
