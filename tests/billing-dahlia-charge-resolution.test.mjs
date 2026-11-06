// tests/billing-dahlia-charge-resolution.test.mjs — a refund or dispute on a
// SUBSCRIPTION charge under Stripe API 2025-03-31.basil and later (the live
// endpoint renders 2026-08-26.dahlia), replayed on a hermetic hub with
// offline fixtures (no network, fixture identifiers only).
//
// Basil removed `invoice.charge` and `invoice.payment_intent` (payments live
// under the includable `invoice.payments` and the /v1/invoice_payments list)
// and removed `charge.invoice`. A paid monthly invoice therefore indexed no
// charge id, so on a Hub that sells hosting too the later `charge.refunded`
// was "unclassified" by the role dispatcher and `charge.dispute.created` was
// unclassified or "dispute on unknown charge": the licence stayed live.
// Lifetime/one-time purchases were unaffected (their Checkout Session names
// its PaymentIntent).
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { invoiceFacts, signStripePayload } from "../dist/src/billing/stripe.js";

const WHSEC = "whsec_dahlia_charge_offline_fixture";
const SW_PRICE = "price_sw_dahlia", SW_PRODUCT = "prod_sw_dahlia";
const HOST_PRICE = "price_host_dahlia", HOST_PRODUCT = "prod_host_dahlia";

const dahliaInvoice = ({ id, customer, subscription, price = SW_PRICE, product = SW_PRODUCT, startSec, endSec, payments }) => ({
  id, object: "invoice", livemode: false, customer, customer_email: `${customer}@example.test`, customer_name: "Fixture", paid: true, status: "paid",
  amount_paid: 9900, billing_reason: "subscription_cycle", status_transitions: { paid_at: startSec },
  parent: { type: "subscription_details", subscription_details: { subscription, metadata: {} } },
  lines: { data: [{ price: null, pricing: { type: "price_details", price_details: { price, product } }, period: { start: startSec, end: endSec }, amount: 9900, metadata: {} }], has_more: false },
  ...(payments ? { payments } : {}),
});
/** A dahlia Charge: no `invoice` field. */
const dahliaCharge = ({ id, pi, customer, refunded = 9900, amount = 9900 }) => ({
  id, object: "charge", livemode: false, customer, payment_intent: pi, amount, amount_refunded: refunded, refunded: refunded >= amount,
  billing_details: { email: `${customer}@example.test` },
});
const inpay = (invoice, pi) => ({ id: `inpay_${invoice}_${pi}`, object: "invoice_payment", invoice, livemode: false, status: "paid", amount_paid: 9900, currency: "usd", payment: { type: "payment_intent", payment_intent: pi } });
const list = (data, has_more = false) => ({ object: "list", data, has_more });

async function hub() {
  let clock = Date.parse("2026-10-29T12:00:00Z"), n = 0;
  const calls = [];
  let routes = {};
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  const launchFetch = async (input) => {
    const u = new URL(String(input));
    calls.push(u.pathname + u.search);
    const route = routes[u.pathname];
    if (!route) return reply(404, { error: { code: "resource_missing" } });
    const r = typeof route === "function" ? route(u) : route;
    return r instanceof Response ? r : reply(200, r);
  };
  const h = await freshHub({}, { billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }), billingNow: () => clock, launchFetch });
  const admin = (p, body) => jsonReq(`${h.origin}${p}`, { method: "POST", headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  const configured = await admin("/admin/api/billing/config", {
    policy: { graceDays: 3, bootstrapDays: 3, testMaxDays: 365 },
    stripe: { test: { secretKey: "sk_test_dahlia_0123456789", webhookSecret: WHSEC, paymentLinks: { "hosting-monthly": "https://buy.stripe.com/test_hosting" } } },
    roles: { test: { software: { priceIds: [SW_PRICE], productIds: [SW_PRODUCT] }, hosting: { priceIds: [HOST_PRICE], productIds: [HOST_PRODUCT] } } },
    plans: [
      { key: "monthly", name: "Monthly", amountCents: 9900, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "software" },
      { key: "hosting-monthly", name: "Hosting", amountCents: 2000, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "hosting" },
    ],
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const post = async (type, object) => {
    const id = `evt_dahlia_${++n}`;
    const body = JSON.stringify({ id, object: "event", type, livemode: false, created: Math.floor(clock / 1000), data: { object } });
    const r = await jsonReq(`${h.origin}/api/billing/stripe/test`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, WHSEC, Math.floor(clock / 1000)) }, body });
    return { ...r, id, body: r.body, resend: async () => jsonReq(`${h.origin}/api/billing/stripe/test`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, WHSEC, Math.floor(clock / 1000)) }, body }) };
  };
  const billing = h.hub.billing;
  const rec = (owner) => billing.store.getCustomer(owner);
  const revoked = (owner) => h.store.isRevoked(rec(owner).licenseId);
  return { h, calls, post, rec, revoked, billing, sec: () => Math.floor(clock / 1000), setRoutes: r => { routes = r; calls.length = 0; } };
}

/** A paid monthly software subscription whose invoice is dahlia-shaped. */
async function paidMonthly(c, owner, { payments } = {}) {
  const sub = `sub_${owner}`, inv = `in_${owner}`;
  const co = await c.post("checkout.session.completed", { id: `cs_${owner}`, mode: "subscription", payment_status: "paid", customer: owner, customer_details: { email: `${owner}@example.test` }, subscription: sub, metadata: { plan: "monthly" } });
  assert.equal(co.body.outcome, "applied", JSON.stringify(co.body));
  const invoice = dahliaInvoice({ id: inv, customer: owner, subscription: sub, startSec: c.sec(), endSec: c.sec() + 31 * 86_400, payments });
  const paid = await c.post("invoice.paid", invoice);
  assert.equal(paid.body.outcome, "applied", JSON.stringify(paid.body));
  assert.equal(c.revoked(owner), false);
  return { sub, inv, invoice };
}
const stripeFor = (invoice, pi, rows = [inpay(invoice.id, pi)]) => ({
  "/v1/invoice_payments": (u) => {
    assert.equal(u.searchParams.get("payment[type]"), "payment_intent");
    assert.equal(u.searchParams.get("payment[payment_intent]"), pi);
    return list(rows);
  },
  [`/v1/invoices/${invoice.id}`]: invoice,
});

await test("dahlia: a monthly subscription's full charge.refunded resolves through /v1/invoice_payments and revokes the licence", async () => {
  const c = await hub();
  try {
    const owner = "cus_dahlia_refund", pi = "pi_dahlia_refund", ch = "ch_dahlia_refund";
    const { invoice } = await paidMonthly(c, owner);
    assert.ok(!c.rec(owner).chargeIds.includes(ch) && !c.rec(owner).chargeIds.includes(pi), "the dahlia invoice names no charge — the gap");
    c.setRoutes(stripeFor(invoice, pi));
    const r = await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }));
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "applied", `pre-fix this was "unclassified": ${JSON.stringify(r.body)}`);
    assert.equal(c.revoked(owner), true, "the full refund revokes the subscription licence");
    assert.equal(c.rec(owner).refunded, true);
    assert.ok(c.rec(owner).chargeIds.includes(ch) && c.rec(owner).chargeIds.includes(pi), "the charge and payment are now indexed on the software record");
    assert.equal(c.billing.store.roleFor(ch), "software");
    assert.ok(c.calls.some(p => p.startsWith("/v1/invoice_payments")) && c.calls.includes(`/v1/invoices/${invoice.id}`));
  } finally { await c.h.close(); }
});

await test("dahlia: charge.dispute.created on a subscription charge follows revokeOnDispute (revoked); a dispute without payment_intent reads its charge first", async () => {
  const c = await hub();
  try {
    const owner = "cus_dahlia_dispute", pi = "pi_dahlia_dispute", ch = "ch_dahlia_dispute";
    const { invoice } = await paidMonthly(c, owner);
    c.setRoutes({ ...stripeFor(invoice, pi), [`/v1/charges/${ch}`]: { id: ch, object: "charge", livemode: false, payment_intent: pi, customer: owner } });
    const r = await c.post("charge.dispute.created", { id: "dp_dahlia", object: "dispute", charge: ch, payment_intent: null, reason: "fraudulent", status: "needs_response" });
    assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
    assert.equal(c.rec(owner).disputed, true);
    assert.equal(c.revoked(owner), true, "the default revokeOnDispute policy revokes");
    assert.equal(c.calls[0], `/v1/charges/${ch}`, "the dispute named no PaymentIntent, so the charge is read first");
  } finally { await c.h.close(); }
});

await test("dahlia: a partial refund on a subscription charge is recorded and leaves the licence live (existing policy)", async () => {
  const c = await hub();
  try {
    const owner = "cus_dahlia_partial", pi = "pi_dahlia_partial", ch = "ch_dahlia_partial";
    const { invoice } = await paidMonthly(c, owner);
    c.setRoutes(stripeFor(invoice, pi));
    const r = await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner, refunded: 1000 }));
    assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
    assert.equal(c.revoked(owner), false);
    assert.equal(c.rec(owner).refunded, false);
    assert.ok(c.rec(owner).chargeIds.includes(ch), "the charge is attributed (a later full refund or dispute matches without Stripe)");
  } finally { await c.h.close(); }
});

await test("dahlia: an invoice whose payload includes `payments` indexes the charge at invoice time; the later dispute needs no Stripe read", async () => {
  const c = await hub();
  try {
    const owner = "cus_dahlia_inline", pi = "pi_dahlia_inline", ch = "ch_dahlia_inline";
    const payments = list([{ ...inpay(`in_${owner}`, { id: pi, object: "payment_intent", latest_charge: ch }) }]);
    assert.deepEqual(invoiceFacts(dahliaInvoice({ id: "in_x", customer: owner, subscription: "sub_x", startSec: 1, endSec: 2, payments })).paymentIds.sort(), [ch, pi].sort());
    await paidMonthly(c, owner, { payments });
    assert.ok(c.rec(owner).chargeIds.includes(ch) && c.rec(owner).chargeIds.includes(pi));
    c.setRoutes({});
    const r = await c.post("charge.dispute.created", { id: "dp_inline", object: "dispute", charge: ch, payment_intent: pi, reason: "fraudulent", status: "needs_response" });
    assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
    assert.equal(c.revoked(owner), true);
    assert.deepEqual(c.calls, [], "a charge the invoice already named is never resolved through Stripe");
  } finally { await c.h.close(); }
});

await test("old shape: an invoice with top-level charge/payment_intent still indexes them; refund and dispute match with no Stripe read", async () => {
  const c = await hub();
  try {
    const owner = "cus_old_shape", pi = "pi_old_shape", ch = "ch_old_shape";
    const sub = `sub_${owner}`;
    await c.post("checkout.session.completed", { id: `cs_${owner}`, mode: "subscription", payment_status: "paid", customer: owner, customer_details: { email: `${owner}@example.test` }, subscription: sub, metadata: { plan: "monthly" } });
    const old = { id: `in_${owner}`, object: "invoice", customer: owner, subscription: sub, charge: ch, payment_intent: pi, paid: true, status: "paid", amount_paid: 9900, billing_reason: "subscription_cycle",
      lines: { data: [{ price: { id: SW_PRICE, product: SW_PRODUCT }, period: { start: c.sec(), end: c.sec() + 31 * 86_400 } }] } };
    assert.equal((await c.post("invoice.paid", old)).body.outcome, "applied");
    c.setRoutes({});
    const d = await c.post("charge.dispute.created", { id: "dp_old", object: "dispute", charge: ch, payment_intent: pi, reason: "general", status: "needs_response" });
    assert.equal(d.body.outcome, "applied", JSON.stringify(d.body));
    assert.equal(c.revoked(owner), true);
    const r = await c.post("charge.refunded", { ...dahliaCharge({ id: ch, pi, customer: owner }), invoice: old.id });
    assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
    assert.deepEqual(c.calls, [], "the old shape never calls Stripe");
  } finally { await c.h.close(); }
});

await test("a hosting subscription's charge resolves to hosting: the hosting record is marked refunded and the software licence is untouched", async () => {
  const c = await hub();
  try {
    const owner = "cus_dahlia_host", pi = "pi_dahlia_host", ch = "ch_dahlia_host";
    await paidMonthly(c, owner);
    const hostInv = dahliaInvoice({ id: "in_dahlia_host", customer: owner, subscription: "sub_dahlia_host", price: HOST_PRICE, product: HOST_PRODUCT, startSec: c.sec(), endSec: c.sec() + 30 * 86_400 });
    assert.equal((await c.post("invoice.paid", hostInv)).body.outcome, "applied");
    const before = JSON.stringify(c.rec(owner));
    c.setRoutes(stripeFor(hostInv, pi));
    const r = await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }));
    assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
    assert.equal(c.revoked(owner), false);
    assert.equal(JSON.stringify(c.rec(owner)), before, "the software record is byte-for-byte unchanged");
    const host = c.billing.store.findRoleSubscriptionBySubscription("hosting", "sub_dahlia_host");
    assert.equal(host.refunded, true);
    assert.ok(host.chargeIds.includes(ch));
    assert.equal(c.billing.store.roleFor(ch), "hosting");
  } finally { await c.h.close(); }
});

await test("fail closed: has_more, several invoices, or another customer's invoice park the event as unclassified and index nothing", async () => {
  const c = await hub();
  try {
    const owner = "cus_dahlia_ambig", pi = "pi_dahlia_ambig", ch = "ch_dahlia_ambig";
    const { invoice } = await paidMonthly(c, owner);
    const cases = [
      ["has_more", { "/v1/invoice_payments": list([inpay(invoice.id, pi)], true), [`/v1/invoices/${invoice.id}`]: invoice }, /more invoice payments than one complete page/],
      ["two invoices", stripeFor(invoice, pi, [inpay(invoice.id, pi), inpay("in_other_invoice", pi)]), /allocated to 2 invoices/],
      ["other customer", stripeFor({ ...invoice, customer: "cus_someone_else" }, pi), /names customer cus_someone_else/],
    ];
    for (const [label, routes, note] of cases) {
      c.setRoutes(routes);
      const r = await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }));
      assert.equal(r.status, 200, label);
      assert.equal(r.body.outcome, "unclassified", `${label}: ${JSON.stringify(r.body)}`);
      const row = c.billing.store.recentEvents(1000).filter(e => e.id === r.id).at(-1);
      assert.match(row.note, note, label);
      assert.equal(c.revoked(owner), false, `${label}: no licence change`);
      assert.ok(!c.rec(owner).chargeIds.includes(ch) && !c.rec(owner).chargeIds.includes(pi), `${label}: nothing indexed`);
      assert.equal(c.billing.store.roleFor(ch), null, `${label}: no role written`);
    }
  } finally { await c.h.close(); }
});

await test("fail closed: an unreadable or malformed Stripe answer is a 500 (not seen, Stripe retries); the retry with good evidence revokes", async () => {
  const c = await hub();
  try {
    const owner = "cus_dahlia_outage", pi = "pi_dahlia_outage", ch = "ch_dahlia_outage";
    const { invoice } = await paidMonthly(c, owner);
    for (const [label, routes] of [
      ["Stripe 500", { "/v1/invoice_payments": new Response(JSON.stringify({ error: { code: "api_error" } }), { status: 500 }) }],
      ["no list", { "/v1/invoice_payments": {} }],
      ["row for another payment", { "/v1/invoice_payments": list([inpay(invoice.id, "pi_not_this_one")]) }],
      ["invoice read fails", { "/v1/invoice_payments": list([inpay(invoice.id, pi)]), [`/v1/invoices/${invoice.id}`]: new Response(JSON.stringify({ error: { code: "api_error" } }), { status: 502 }) }],
    ]) {
      c.setRoutes(routes);
      const r = await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }));
      assert.equal(r.status, 500, `${label}: ${JSON.stringify(r.body)}`);
      assert.equal(c.billing.store.seenEvent(r.id), false, `${label}: not marked seen`);
      assert.equal(c.revoked(owner), false, label);
      assert.ok(!c.rec(owner).chargeIds.includes(ch), `${label}: nothing indexed`);
    }
    c.setRoutes(stripeFor(invoice, pi));
    const first = await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }));
    assert.equal(first.body.outcome, "applied");
    assert.equal(c.revoked(owner), true);
  } finally { await c.h.close(); }
});

await test("a payment Stripe proves funded no invoice falls through to the existing handling (unclassified on a Hub that also sells hosting)", async () => {
  const c = await hub();
  try {
    const owner = "cus_dahlia_noinv", pi = "pi_dahlia_noinv", ch = "ch_dahlia_noinv";
    await paidMonthly(c, owner);
    c.setRoutes({ "/v1/invoice_payments": list([]) });
    const r = await c.post("charge.refunded", dahliaCharge({ id: ch, pi, customer: owner }));
    assert.equal(r.body.outcome, "unclassified", JSON.stringify(r.body));
    assert.match(c.billing.store.recentEvents(1000).filter(e => e.id === r.id).at(-1).note, /could not attribute this event to a product role/);
    assert.equal(c.revoked(owner), false);
    assert.equal(c.calls.length, 1, "no invoice read without an invoice payment");
  } finally { await c.h.close(); }
});

summary("billing-dahlia-charge-resolution");
