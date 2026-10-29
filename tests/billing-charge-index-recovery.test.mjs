// tests/billing-charge-index-recovery.test.mjs — crash windows and
// deterministic Stripe refusals in the 0.4.101 refund/dispute charge
// resolver (BillingService.resolveUnknownCharge), replayed on a hermetic hub
// with offline fixtures (no network, fixture identifiers only).
//
// S1. The resolver wrote the role index BEFORE the record that holds the
//     charge. A crash between the two left an index entry with no record;
//     the Stripe retry then short-circuited ("already known"), onDispute
//     looked only at the records and answered "dispute on unknown charge"
//     (200, marked seen): the licence stayed live. The same short-circuit
//     accepted a bundle whose hosting record was saved but whose software
//     record was not (a crash or hosting-hook failure between the two). Now
//     records are saved first and the index last, an index entry alone is
//     re-resolved, a record without its index entry is repaired from the
//     record, and a half-written bundle is re-resolved.
// S2. Every non-2xx from Stripe threw, so a deterministic 4xx (404
//     resource_missing, 401, 403) answered 500 on every retry for ~3 days.
//     Now a 4xx other than 408/409/429 parks the event as "unclassified"
//     with the status/code; 429, 5xx and transport errors still throw.
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { signStripePayload } from "../dist/src/billing/stripe.js";

const WHSEC = "whsec_charge_index_offline_fixture";
const SW_PRICE = "price_sw_cir", SW_PRODUCT = "prod_sw_cir";
const HOST_PRICE = "price_host_cir", HOST_PRODUCT = "prod_host_cir";

const dahliaInvoice = ({ id, customer, subscription, lines = [[SW_PRICE, SW_PRODUCT]], startSec, endSec }) => ({
  id, object: "invoice", livemode: false, customer, customer_email: `${customer}@example.test`, customer_name: "Fixture", paid: true, status: "paid",
  amount_paid: 9900, billing_reason: "subscription_cycle", status_transitions: { paid_at: startSec },
  parent: { type: "subscription_details", subscription_details: { subscription, metadata: {} } },
  lines: { data: lines.map(([price, product]) => ({ price: null, pricing: { type: "price_details", price_details: { price, product } }, period: { start: startSec, end: endSec }, amount: 9900, metadata: {} })), has_more: false },
});
const dahliaCharge = ({ id, pi, customer }) => ({
  id, object: "charge", livemode: false, customer, payment_intent: pi, amount: 9900, amount_refunded: 9900, refunded: true, billing_details: { email: `${customer}@example.test` },
});
const dispute = (id, ch, pi) => ({ id, object: "dispute", charge: ch, payment_intent: pi, reason: "fraudulent", status: "needs_response" });
const inpay = (invoice, pi) => ({ id: `inpay_${invoice}_${pi}`, object: "invoice_payment", invoice, livemode: false, status: "paid", amount_paid: 9900, currency: "usd", payment: { type: "payment_intent", payment_intent: pi } });
const list = (data, has_more = false) => ({ object: "list", data, has_more });
const stripeFor = (invoice, pi) => ({ "/v1/invoice_payments": list([inpay(invoice.id, pi)]), [`/v1/invoices/${invoice.id}`]: invoice });
const fail = (status, code) => new Response(JSON.stringify({ error: { code } }), { status });

async function hub() {
  let clock = Date.parse("2026-10-29T12:00:00Z"), n = 0;
  const calls = [];
  let routes = {};
  const launchFetch = async (input) => {
    const u = new URL(String(input));
    calls.push(u.pathname + u.search);
    const route = routes[u.pathname];
    if (!route) return fail(599, "fixture_unrouted"); // never a 4xx by accident
    const r = typeof route === "function" ? route(u) : route;
    return r instanceof Response ? r.clone() : new Response(JSON.stringify(r), { status: 200 });
  };
  const h = await freshHub({}, { billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }), billingNow: () => clock, launchFetch });
  const admin = (p, body) => jsonReq(`${h.origin}${p}`, { method: "POST", headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  const configured = await admin("/admin/api/billing/config", {
    policy: { graceDays: 3, bootstrapDays: 3, testMaxDays: 365 },
    stripe: { test: { secretKey: "sk_test_cir_0123456789", webhookSecret: WHSEC, priceIds: { monthly: SW_PRICE }, paymentLinks: { "hosting-monthly": "https://buy.stripe.com/test_hosting" } } },
    roles: { test: { software: { priceIds: [SW_PRICE], productIds: [SW_PRODUCT] }, hosting: { priceIds: [HOST_PRICE], productIds: [HOST_PRODUCT] } } },
    plans: [
      { key: "monthly", name: "Monthly", amountCents: 9900, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "software" },
      { key: "hosting-monthly", name: "Hosting", amountCents: 2000, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "hosting" },
    ],
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const post = async (type, object) => {
    const id = `evt_cir_${++n}`;
    const body = JSON.stringify({ id, object: "event", type, livemode: false, created: Math.floor(clock / 1000), data: { object } });
    const send = () => jsonReq(`${h.origin}/api/billing/stripe/test`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, WHSEC, Math.floor(clock / 1000)) }, body });
    const r = await send();
    return { ...r, id, resend: send };
  };
  const billing = h.hub.billing, store = billing.store;
  const rec = (owner) => store.getCustomer(owner);
  const revoked = (owner) => h.store.isRevoked(rec(owner).licenseId);
  const note = (evId) => store.recentEvents(1000).filter(e => e.id === evId).at(-1)?.note ?? "";
  return { h, calls, post, rec, revoked, billing, store, note, sec: () => Math.floor(clock / 1000), setRoutes: r => { routes = r; calls.length = 0; } };
}

async function paidMonthly(c, owner) {
  const sub = `sub_${owner}`;
  const co = await c.post("checkout.session.completed", { id: `cs_${owner}`, mode: "subscription", payment_status: "paid", customer: owner, customer_details: { email: `${owner}@example.test` }, subscription: sub, metadata: { plan: "monthly" } });
  assert.equal(co.body.outcome, "applied", JSON.stringify(co.body));
  const invoice = dahliaInvoice({ id: `in_${owner}`, customer: owner, subscription: sub, startSec: c.sec(), endSec: c.sec() + 31 * 86_400 });
  assert.equal((await c.post("invoice.paid", invoice)).body.outcome, "applied");
  assert.equal(c.revoked(owner), false);
  return { sub, invoice };
}

// ── S1: crash windows ─────────────────────────────────────────────────────

await test("S1 role index only: a charge the index names but no record holds (the old crash window) is re-resolved; the retried dispute revokes", async () => {
  const c = await hub();
  try {
    const owner = "cus_cir_index_only", pi = "pi_cir_index_only", ch = "ch_cir_index_only";
    const { invoice } = await paidMonthly(c, owner);
    // Exactly what the pre-fix resolver left behind when it crashed after
    // noteRole and before putCustomer.
    assert.equal(c.store.noteRole(ch, "software"), true);
    assert.equal(c.store.noteRole(pi, "software"), true);
    assert.equal(c.store.findByCharge(ch), null);
    c.setRoutes(stripeFor(invoice, pi));
    const r = await c.post("charge.dispute.created", dispute("dp_cir_index_only", ch, pi));
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "applied", `pre-fix: "dispute on unknown charge" (ignored, seen, licence live): ${JSON.stringify(r.body)} ${c.note(r.id)}`);
    assert.equal(c.rec(owner).disputed, true);
    assert.equal(c.revoked(owner), true);
    assert.ok(c.rec(owner).chargeIds.includes(ch) && c.rec(owner).chargeIds.includes(pi));
  } finally { await c.h.close(); }
});

await test("S1 order: the resolver saves the record before the role index — a failed record write leaves no index entry, and Stripe's retry revokes", async () => {
  const c = await hub();
  try {
    const owner = "cus_cir_order", pi = "pi_cir_order", ch = "ch_cir_order";
    const { invoice } = await paidMonthly(c, owner);
    c.setRoutes(stripeFor(invoice, pi));
    const real = c.store.putCustomer.bind(c.store);
    let armed = true;
    c.store.putCustomer = (rec) => {
      if (armed && rec.chargeIds.includes(ch)) { armed = false; throw Error("fixture: crash before the record write"); }
      return real(rec);
    };
    const r = await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }));
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(c.store.seenEvent(r.id), false);
    assert.equal(c.store.roleFor(ch), null, "pre-fix the role index already said \"software\" with no record holding the charge");
    assert.equal(c.store.roleFor(pi), null);
    const retry = await r.resend();
    assert.equal(retry.body.outcome, "applied", JSON.stringify(retry.body));
    assert.equal(c.revoked(owner), true);
    assert.equal(c.store.roleFor(ch), "software", "the index is written once the record holds the charge");
  } finally { await c.h.close(); }
});

await test("S1 record without its index entry (a crash after the record write): repaired from the record with no Stripe read; the refund revokes", async () => {
  const c = await hub();
  try {
    const owner = "cus_cir_noindex", pi = "pi_cir_noindex", ch = "ch_cir_noindex";
    await paidMonthly(c, owner);
    const r0 = c.rec(owner); r0.chargeIds.push(ch, pi); c.store.putCustomer(r0);
    assert.equal(c.store.roleFor(ch), null);
    c.setRoutes({});
    const r = await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }));
    assert.equal(r.body.outcome, "applied", `pre-fix the dispatcher found no role on a Hub that sells hosting: ${JSON.stringify(r.body)} ${c.note(r.id)}`);
    assert.equal(c.revoked(owner), true);
    assert.equal(c.store.roleFor(ch), "software");
    assert.deepEqual(c.calls, [], "the record already proves the attribution");
  } finally { await c.h.close(); }
});

/** One subscription that bills software and hosting (a pre-v2 bundle: the
 *  software and hosting records share the subscription and customer key). */
async function bundle(c, owner) {
  const { sub } = await paidMonthly(c, owner);
  const now = Date.parse("2026-10-29T12:00:00Z");
  c.store.putRoleSubscription({ key: `${owner}::hosting`, customerKey: owner, role: "hosting", livemode: false, subscriptionId: sub, subscriptionStatus: "active", periodEndMs: now + 31 * 86_400_000, chargeIds: [], disputed: false, refunded: false, createdAtMs: now, updatedAtMs: now, lastEventType: null, lastEventAtMs: null });
  const invoice = dahliaInvoice({ id: `in_${owner}_b`, customer: owner, subscription: sub, lines: [[SW_PRICE, SW_PRODUCT], [HOST_PRICE, HOST_PRODUCT]], startSec: c.sec(), endSec: c.sec() + 31 * 86_400 });
  const host = () => c.store.findRoleSubscriptionBySubscription("hosting", sub);
  return { sub, invoice, host };
}

await test("S1 bundle: hosting saved but software not (a hosting-hook failure between the writes) — the retried dispute indexes software and revokes", async () => {
  const c = await hub();
  try {
    const owner = "cus_cir_bundle", pi = "pi_cir_bundle", ch = "ch_cir_bundle";
    const { invoice, host } = await bundle(c, owner);
    c.setRoutes(stripeFor(invoice, pi));
    const realHook = c.billing.onHostingEvent;
    let armed = true;
    c.billing.onHostingEvent = (...a) => { if (armed) { armed = false; throw Error("fixture: hook down"); } return realHook(...a); };
    const r = await c.post("charge.dispute.created", dispute("dp_cir_bundle", ch, pi));
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.ok(host().chargeIds.includes(ch), "the hosting record was saved before the hook threw");
    assert.ok(!c.rec(owner).chargeIds.includes(ch), "the software record was not");
    const retry = await r.resend();
    assert.equal(retry.status, 200);
    assert.equal(retry.body.outcome, "applied", `pre-fix the retry short-circuited on the hosting record and the software licence stayed live: ${JSON.stringify(retry.body)} ${c.note(r.id)}`);
    assert.ok(c.rec(owner).chargeIds.includes(ch) && c.rec(owner).chargeIds.includes(pi));
    assert.equal(c.rec(owner).disputed, true);
    assert.equal(c.revoked(owner), true);
  } finally { await c.h.close(); }
});

await test("S1 bundle: a half-written bundle found at rest (hosting holds the charge, software does not) is completed on the next dispute", async () => {
  const c = await hub();
  try {
    const owner = "cus_cir_bundle_rest", pi = "pi_cir_bundle_rest", ch = "ch_cir_bundle_rest";
    const { invoice, host } = await bundle(c, owner);
    const h0 = host(); h0.chargeIds.push(ch, pi); c.store.putRoleSubscription(h0);
    c.setRoutes(stripeFor(invoice, pi));
    const r = await c.post("charge.dispute.created", dispute("dp_cir_bundle_rest", ch, pi));
    assert.equal(r.body.outcome, "applied", `${JSON.stringify(r.body)} ${c.note(r.id)}`);
    assert.equal(c.revoked(owner), true);
    assert.equal(host().chargeIds.filter(id => id === ch).length, 1, "the hosting record is not re-written with a duplicate");
  } finally { await c.h.close(); }
});

await test("S1 Lifetime bundle: a VPS-only renewal charge legitimately held by hosting alone is re-resolved best effort — a Stripe outage never turns it into a 500", async () => {
  const c = await hub();
  try {
    const owner = "cus_cir_lifetime", pi = "pi_cir_lifetime", ch = "ch_cir_lifetime";
    const { sub, host } = await bundle(c, owner);
    c.store.putBundleSubscription({ subscriptionId: sub, reservationId: "res_cir_lifetime", customerId: owner, planKey: "lifetime", priceId: "price_lifetime_cir" });
    const h0 = host(); h0.chargeIds.push(ch, pi); c.store.putRoleSubscription(h0);
    const before = JSON.stringify(c.rec(owner));
    c.setRoutes({ "/v1/invoice_payments": fail(503, "api_error") });
    const r = await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }));
    assert.equal(r.status, 200, `the re-resolution is best effort here: ${JSON.stringify(r.body)}`);
    assert.equal(c.calls.length, 1, "it was attempted");
    assert.ok(!c.rec(owner).chargeIds.includes(ch), "nothing indexed onto the Lifetime software record");
    assert.equal(c.revoked(owner), false);
    assert.equal(JSON.parse(before).licenseId, c.rec(owner).licenseId);
  } finally { await c.h.close(); }
});

// ── S2: deterministic Stripe refusals ─────────────────────────────────────

await test("S2: a deterministic Stripe 4xx (404 resource_missing, 401, 403, 400) parks the event as unclassified with its status/code — 200, seen, nothing indexed", async () => {
  const c = await hub();
  try {
    const owner = "cus_cir_4xx", pi = "pi_cir_4xx", ch = "ch_cir_4xx";
    const { invoice } = await paidMonthly(c, owner);
    const cases = [
      ["invoice 404", { "/v1/invoice_payments": list([inpay(invoice.id, pi)]), [`/v1/invoices/${invoice.id}`]: fail(404, "resource_missing") }, /Stripe answered 404 resource_missing/],
      ["list 401", { "/v1/invoice_payments": fail(401, "api_key_expired") }, /Stripe answered 401 api_key_expired/],
      ["list 403", { "/v1/invoice_payments": fail(403, "secret_key_required") }, /Stripe answered 403 secret_key_required/],
      ["charge 400", { [`/v1/charges/${ch}`]: fail(400, "parameter_invalid_empty") }, /Stripe answered 400 parameter_invalid_empty/],
    ];
    for (const [label, routes, pattern] of cases) {
      c.setRoutes(routes);
      const r = label === "charge 400"
        ? await c.post("charge.dispute.created", dispute(`dp_cir_${label.replace(/\W/g, "")}`, ch, null))
        : await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }));
      assert.equal(r.status, 200, `${label}: pre-fix this was a 500 on every retry: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.outcome, "unclassified", label);
      assert.match(c.note(r.id), pattern, label);
      assert.equal(c.store.seenEvent(r.id), true, `${label}: answered, not retried for days`);
      assert.equal(c.revoked(owner), false, label);
      assert.ok(!c.rec(owner).chargeIds.includes(ch), `${label}: nothing indexed`);
      assert.equal(c.store.roleFor(ch), null, `${label}: no role written`);
    }
  } finally { await c.h.close(); }
});

await test("S2: 429, 408, 409 and 5xx still throw (500, not seen, Stripe retries); the retry with good evidence revokes", async () => {
  const c = await hub();
  try {
    const owner = "cus_cir_retry", pi = "pi_cir_retry", ch = "ch_cir_retry";
    const { invoice } = await paidMonthly(c, owner);
    for (const [status, code] of [[429, "rate_limit"], [408, "timeout"], [409, "lock_timeout"], [500, "api_error"], [503, "api_error"]]) {
      c.setRoutes({ "/v1/invoice_payments": list([inpay(invoice.id, pi)]), [`/v1/invoices/${invoice.id}`]: fail(status, code) });
      const r = await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }));
      assert.equal(r.status, 500, `${status}: ${JSON.stringify(r.body)}`);
      assert.equal(c.store.seenEvent(r.id), false, `${status}: not seen`);
    }
    c.setRoutes(stripeFor(invoice, pi));
    assert.equal((await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }))).body.outcome, "applied");
    assert.equal(c.revoked(owner), true);
  } finally { await c.h.close(); }
});

summary("billing-charge-index-recovery");
