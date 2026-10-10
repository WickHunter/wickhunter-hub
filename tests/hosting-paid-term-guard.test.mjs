// tests/hosting-paid-term-guard.test.mjs — the 2026-10-09 combined
// software+VPS cancellation, replayed end to end on a hermetic hub with the
// incident's own event order and clock shape, plus the guard that keeps
// hosting reconciliation from cancelling a paid, active Stripe subscription
// on the strength of the Hub's own licence clock.
//
// The incident (UTC): a mixed v2 checkout completed at 03:39:59; Stripe had
// paid the subscription's first invoice one second earlier, so both
// `invoice.paid` and `invoice.payment_succeeded` carried an OLDER `created`
// than the checkout event that was delivered first, and the 0.4.90 stale
// guard discarded them. The licence kept only its three-day bootstrap grant.
// At 03:40:15 three days later hosting reconciliation found the licence
// lapsed, queued a `software-ineligible` Stripe cancellation, Stripe echoed
// it back as `customer.subscription.updated` (which extended the licence to
// the paid term but left the cancellation), and the customer was emailed
// that their hosting would end.
//
// Every Stripe object here is an offline fixture signed with a test webhook
// secret; the provider is FakeProvider; no network leaves 127.0.0.1.
// Identifiers are fixture values, never the customer's.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { FakeProvider, hashBootstrapToken } from "../dist/src/hosting/provider.js";
import { signStripePayload } from "../dist/src/billing/stripe.js";

const SECRET = "whsec_paid_term_guard_offline_fixture";
const DAY = 86_400_000;
const GRACE_DAYS = 3, BOOTSTRAP_DAYS = 3; // the live box's policy, not the 7-day default
// Instants shaped like the real ones (UTC).
const CHECKOUT_COMPLETED = Date.parse("2026-10-06T03:39:59Z");
const INVOICE_CREATED = CHECKOUT_COMPLETED - 1000; // Stripe pays the first invoice, THEN completes the session
const PERIOD_END = Date.parse("2026-11-06T03:39:55Z"); // one month after the subscription itself was created
const BOOTSTRAP_EXP = CHECKOUT_COMPLETED + BOOTSTRAP_DAYS * DAY; // 2026-10-09T03:39:59Z
const FIRST_TICK_AFTER_LAPSE = Date.parse("2026-10-09T03:40:15Z");
const ECHO_UPDATE = Date.parse("2026-10-09T03:40:16Z");
const PAID_TERM_EXP = PERIOD_END + GRACE_DAYS * DAY; // 2026-11-09T03:39:55Z
const SOFTWARE_CENTS = 9900, SOFTWARE_DISCOUNT_CENTS = 3960, VPS_CENTS = 2000; // $59.40 discounted software + $20 VPS = $79.40
const PUBLIC_HEALTH_OK = async () => ({ ok: true, status: 200, body: JSON.stringify({ ok: true, version: "0.90.135" }) });

/** Drive a freshly provisioned (`bootstrapping`) instance to `ready` through
 *  the real generation-bound readiness callback, as the customer's running
 *  VPS was. Without it the fixture would drift into the bootstrap-timeout
 *  re-provisioning lifecycle three days later, which has nothing to do with
 *  the guard under test. */
async function readyInstance(h, row, nowMs) {
  assert.equal(row.stage, "bootstrapping");
  const rawToken = `tok-${row.id}`;
  h.hub.hosting.store.updateInstance(row.id, row.version, (d) => { d.bootstrapTokenHash = hashBootstrapToken(rawToken); d.bootstrapTokenExpiresAtMs = nowMs + 3_600_000; }, nowMs);
  const fresh = h.hub.hosting.store.getInstance(row.id);
  const results = ["bybit", "binance", "bitget", "bitunix", "blofin", "weex", "aster"].map((venueId) => ({ venueId, status: 200 }));
  const r = await jsonReq(`${h.origin}/api/hosting/instances/${row.id}/readiness`, { method: "POST", body: JSON.stringify({ token: rawToken, generation: fresh.generation, results }) });
  assert.equal(r.body.ready, true, JSON.stringify(r.body));
  assert.equal(h.hub.hosting.store.getInstance(row.id).stage, "ready");
}

// ── the mixed v2 (software + VPS, one subscription) fixture ─────────────────
async function setup(over = {}) {
  let clock = CHECKOUT_COMPLETED - 60_000, n = 0;
  const sessions = new Map(), calls = [], logs = [], stripeCalls = [];
  const provider = new FakeProvider({ now: () => clock });
  let h;
  const fake = async (input, init = {}) => {
    const url = new URL(input), p = url.pathname, params = new URLSearchParams(init.body ?? "");
    calls.push({ p, method: init.method, params });
    let out;
    if (p.startsWith("/v1/subscriptions/") && init.method === "POST") {
      // The hosting service's own Stripe control path (`setStripeCancellation`).
      stripeCalls.push({ subscriptionId: decodeURIComponent(p.split("/").at(-1)), body: init.body });
      if (over.stripeRefuses) return { ok: false, status: 503, json: async () => ({ error: "unavailable" }), text: async () => "unavailable" };
      out = { id: p.split("/").at(-1), object: "subscription", cancel_at_period_end: params.get("cancel_at_period_end") === "true" };
    } else if (p.startsWith("/v1/prices/")) {
      const id = p.split("/").at(-1), host = id.startsWith("price_host"), annual = id === "price_yearly" || id === "price_hostyear", life = id === "price_lifetime";
      out = { id, active: true, livemode: true, type: life ? "one_time" : "recurring", currency: "usd", unit_amount: host ? (annual ? 24000 : VPS_CENTS) : life ? 99900 : annual ? 69900 : SOFTWARE_CENTS, product: host ? "prod_vps" : "prod_software", recurring: life ? null : { interval: annual ? "year" : "month", interval_count: 1 } };
    } else if (p === "/v1/account") out = { capabilities: { crypto_payments: "active" } };
    else if (p === "/v1/checkout/sessions" && init.method === "POST") {
      const key = init.headers["Idempotency-Key"]; out = sessions.get(key);
      if (!out) {
        const id = `cs_guard${++n}`, meta = Object.fromEntries([...params].filter(([k]) => /^metadata\[/.test(k)).map(([k, v]) => [k.slice(9, -1), v]));
        const lines = [0, 1].map(i => params.get(`line_items[${i}][price]`)).filter(Boolean).map(id => {
          const host = id.startsWith("price_host");
          return { quantity: 1, price: { id, product: host ? "prod_vps" : "prod_software" }, amount_subtotal: host ? VPS_CENTS : SOFTWARE_CENTS, amount_discount: 0 };
        });
        out = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get("mode"), metadata: meta, client_reference_id: params.get("client_reference_id"), livemode: true, status: "open", payment_status: "unpaid", subscription: null, payment_intent: null, lines };
        sessions.set(key, out);
      }
    } else if (p.startsWith("/v1/checkout/sessions/") && init.method === "GET") {
      const parts = p.split("/"), session = [...sessions.values()].find(s => s.id === parts[4]); assert(session, "known fixture session");
      out = parts[5] === "line_items" ? { data: session.lines, has_more: false } : session;
    } else throw Error("Unexpected outbound fixture request " + p);
    return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
  };
  h = await freshHub({}, { billingNow: () => clock, hostingNow: () => clock, launchFetch: fake, hostingFetch: fake, billingFetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "mail_fixture" }) }), hostingProvider: provider, hostingPublicHealthFetch: PUBLIC_HEALTH_OK });
  h.hub.hosting.log = line => logs.push(line); // the journal is part of the contract under test
  const admin = (p, body) => jsonReq(h.origin + p, { method: "POST", headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  const configured = await admin("/admin/api/billing/config", {
    mode: "live",
    policy: { graceDays: GRACE_DAYS, bootstrapDays: BOOTSTRAP_DAYS },
    plans: [...h.hub.billing.config().plans, { key: "hosting-monthly", name: "Hosting", amountCents: VPS_CENTS, currency: "usd", interval: "month", role: "hosting" }],
    stripe: { live: { secretKey: "sk_live_offline_only", webhookSecret: SECRET, priceIds: { monthly: "price_monthly", yearly: "price_yearly", lifetime: "price_lifetime", "hosting-monthly": "price_hostold" } } },
    roles: { live: { hosting: { priceIds: ["price_hostold"] }, software: { priceIds: ["price_monthly", "price_yearly", "price_lifetime"], productIds: ["prod_software"] } } },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal((await admin("/admin/api/hosting/policy", { policy: { provisioningEnabled: true, monthlyPriceCents: VPS_CENTS, osId: "2284", releaseRef: "b".repeat(64), maximumProjectedMonthlyProviderCostCents: 10000 } })).status, 200);
  assert.equal((await admin("/admin/api/billing/hosted-offer", { monthlyPriceId: "price_hostmonth", yearlyPriceId: "price_hostyear" })).status, 200);
  assert.equal((await admin("/admin/api/billing/launch", { action: "prepare" })).status, 200);
  await admin("/admin/api/billing/launch", { enabled: true, cryptoEnabled: true });
  const checkout = () => jsonReq(h.origin + "/api/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", payment: "card", hosting: true, attemptId: randomUUID() }) });
  const last = () => [...sessions.values()].at(-1);
  const key = s => "cus_" + s.id, sub = s => "sub_" + s.id;
  const completed = s => ({ id: s.id, mode: "subscription", payment_status: "paid", customer: key(s), customer_details: { email: s.id + "@example.test" }, subscription: sub(s), metadata: s.metadata,
    amount_subtotal: SOFTWARE_CENTS + VPS_CENTS, total_details: { amount_discount: SOFTWARE_DISCOUNT_CENTS }, amount_total: SOFTWARE_CENTS - SOFTWARE_DISCOUNT_CENTS + VPS_CENTS });
  const invoice = (s, over = {}) => ({ id: "in_" + s.id, paid: true, status: "paid", amount_paid: SOFTWARE_CENTS - SOFTWARE_DISCOUNT_CENTS + VPS_CENTS, customer: key(s), customer_email: s.id + "@example.test", subscription: sub(s), subscription_details: { metadata: s.metadata }, billing_reason: "subscription_create",
    status_transitions: { paid_at: Math.floor(INVOICE_CREATED / 1000) },
    lines: { data: s.lines.map(l => ({ price: l.price, amount: l.amount_subtotal, discount_amounts: [{ amount: l.price.id.startsWith("price_host") ? 0 : SOFTWARE_DISCOUNT_CENTS }], taxes: [], quantity: 1, period: { end: Math.floor(PERIOD_END / 1000) } })), has_more: false },
    charge: "ch_" + s.id, payment_intent: "pi_" + s.id, ...over });
  const subscriptionObject = (s, over = {}) => ({ id: sub(s), customer: key(s), status: "active", cancel_at_period_end: false, current_period_end: Math.floor(PERIOD_END / 1000), metadata: s.metadata,
    items: { data: s.lines.map(l => ({ price: l.price, current_period_end: Math.floor(PERIOD_END / 1000) })) }, ...over });
  const post = async (type, object, created = clock, id = "evt_" + randomUUID()) => {
    const body = JSON.stringify({ id, object: "event", type, livemode: true, created: Math.floor(created / 1000), data: { object } });
    return { id, ...(await jsonReq(h.origin + "/api/billing/stripe/live", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, SECRET, Math.floor(clock / 1000)) }, body })) };
  };
  const instance = s => h.hub.hosting.store.instances().find(r => r.ownerId === key(s)) ?? null;
  const cancellations = s => h.hub.hosting.store.outboxFor(instance(s).id).filter(j => j.jobType === "billing_reconcile");
  const exp = s => h.store.get(h.hub.billing.store.getCustomer(key(s)).licenseId)?.exp ?? null;
  const tick = () => h.hub.hosting.tick(clock);
  const audit = type => h.hub.billing.store.recentEvents(200).filter(e => e.type === type).map(e => ({ ...e, note: JSON.parse(e.note) }));
  return { h, provider, logs, calls, stripeCalls, admin, audit, checkout, last, key, sub, completed, invoice, subscriptionObject, post, instance, cancellations, exp, tick, set: ms => { clock = ms; }, advance: ms => { clock += ms; }, now: () => clock };
}

/** Checkout API call, then the incident's `checkout.session.completed` at 03:39:59. */
async function checkedOut(c) {
  assert.equal((await c.checkout()).status, 200);
  const s = c.last(); s.lines[0].amount_discount = SOFTWARE_DISCOUNT_CENTS;
  c.set(CHECKOUT_COMPLETED);
  const r = await c.post("checkout.session.completed", c.completed(s), CHECKOUT_COMPLETED);
  assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
  const rec = c.h.hub.billing.store.getCustomer(c.key(s));
  assert.equal(rec.periodEndMs, null, "checkout alone establishes no paid-through date");
  assert.equal(rec.subscriptionStatus, "active");
  assert.equal(c.exp(s), BOOTSTRAP_EXP, "the three-day bootstrap grant, exactly");
  return { s, rec, checkoutEventId: r.id };
}

/** Provision through the FakeProvider and complete readiness: a running VPS. */
async function provisioned(c, s) {
  await c.tick();
  assert.equal(c.provider.createCalls.length, 1);
  await readyInstance(c.h, c.instance(s), c.now());
}

const snapshot = (c, s) => {
  const sw = c.h.hub.billing.store.getCustomer(c.key(s)), host = c.h.hub.billing.store.getRoleSubscription(c.key(s), "hosting"), row = c.instance(s);
  return { exp: c.exp(s), swStatus: sw.subscriptionStatus, swPeriodEnd: sw.periodEndMs, cancelAtPeriodEnd: sw.cancelAtPeriodEnd ?? false, hostStatus: host.subscriptionStatus, hostPeriodEnd: host.periodEndMs,
    stage: row.stage, cancellationReason: row.cancellationReason, suspendAtMs: row.suspendAtMs, deleteAtMs: row.deleteAtMs, paidThroughMs: row.paidThroughMs, lifecycleVersion: row.lifecycleVersion, cancellations: c.cancellations(s).length };
};

await test("the incident's event order (newer checkout, then the older paid invoice and its alias, three days, reconciliation, a subscription update) keeps the paid term, queues no cancellation, keeps the subscription active, and replays as duplicates", async () => {
  const c = await setup();
  try {
    const { s, checkoutEventId } = await checkedOut(c);
    const paid = await c.post("invoice.paid", c.invoice(s), INVOICE_CREATED);
    assert.equal(paid.body.outcome, "applied", JSON.stringify(paid.body));
    assert.equal(c.exp(s), PAID_TERM_EXP, "the older initial invoice establishes the paid term plus grace");
    assert.equal(c.h.hub.billing.store.getCustomer(c.key(s)).periodEndMs, PERIOD_END);
    assert.equal(c.h.hub.billing.store.getRoleSubscription(c.key(s), "hosting").periodEndMs, PERIOD_END);
    assert.equal(c.h.hub.billing.store.getBundleSubscription(c.sub(s)).latestEventCreatedMs, CHECKOUT_COMPLETED, "the watermark never moves backwards");
    const alias = await c.post("invoice.payment_succeeded", c.invoice(s), INVOICE_CREATED);
    assert.equal(alias.body.outcome, "ignored", "the alias of an already-established term adds nothing");
    assert.equal(c.exp(s), PAID_TERM_EXP);
    await provisioned(c, s);

    c.set(FIRST_TICK_AFTER_LAPSE);
    await c.tick(); c.advance(30_000); await c.tick();
    assert.equal(c.cancellations(s).length, 0, "no software-ineligible cancellation: the licence runs to the paid term");
    assert.equal(c.instance(s).stage, "ready");
    assert.equal(c.logs.filter(l => /refusing paid hosting|withholding software-ineligible/.test(l)).length, 0);

    c.set(ECHO_UPDATE);
    const update = await c.post("customer.subscription.updated", c.subscriptionObject(s), ECHO_UPDATE);
    assert.equal(update.body.outcome, "applied", JSON.stringify(update.body));
    const sw = c.h.hub.billing.store.getCustomer(c.key(s));
    assert.equal(sw.subscriptionStatus, "active"); assert.equal(sw.cancelAtPeriodEnd, false); assert.equal(sw.periodEndMs, PERIOD_END);
    assert.equal(c.exp(s), PAID_TERM_EXP, "an update carrying the same period end extends nothing and shortens nothing");
    assert.equal(c.h.hub.billing.store.getRoleSubscription(c.key(s), "hosting").subscriptionStatus, "active");
    await c.tick();
    assert.equal(c.cancellations(s).length, 0);
    const row = c.instance(s);
    assert.equal(row.stage, "ready"); assert.equal(row.cancellationReason, null); assert.equal(row.suspendAtMs, null); assert.equal(row.deleteAtMs, null); assert.equal(row.paidThroughMs, PERIOD_END);

    const before = snapshot(c, s);
    for (const [type, created, id] of [["checkout.session.completed", CHECKOUT_COMPLETED, checkoutEventId], ["invoice.paid", INVOICE_CREATED, paid.id], ["invoice.payment_succeeded", INVOICE_CREATED, alias.id], ["customer.subscription.updated", ECHO_UPDATE, update.id]]) {
      const object = type === "checkout.session.completed" ? c.completed(s) : type === "customer.subscription.updated" ? c.subscriptionObject(s) : c.invoice(s);
      assert.equal((await c.post(type, object, created, id)).body.outcome, "duplicate", `${type} replay`);
    }
    await c.tick();
    assert.deepEqual(snapshot(c, s), before, "replayed events change nothing");
  } finally { await c.h.close(); }
});

await test("a bootstrap-only bundle whose initial invoice was discarded (the pre-0.4.91 state) is held, not cancelled, when the grant lapses; the hold is logged once; Stripe's next word lifts it", async () => {
  const c = await setup();
  try {
    const { s } = await checkedOut(c);
    await provisioned(c, s);
    c.set(FIRST_TICK_AFTER_LAPSE);
    assert.ok(c.exp(s) <= c.now(), "the bootstrap grant has lapsed on the Hub's clock");
    for (let i = 0; i < 3; i++) { await c.tick(); c.advance(30_000); }
    assert.equal(c.cancellations(s).length, 0, "no Stripe cancellation is queued on the strength of the local clock");
    const row = c.instance(s);
    assert.equal(row.stage, "ready"); assert.equal(row.cancellationReason, null); assert.equal(row.suspendAtMs, null); assert.equal(row.deleteAtMs, null);
    const held = c.logs.filter(l => l.includes("withholding software-ineligible cancellation"));
    assert.equal(held.length, 1, "one journal line per episode, not one per 30-second tick");
    assert.ok(held[0].includes(new Date(BOOTSTRAP_EXP).toISOString()) && held[0].includes(c.sub(s)) && held[0].includes("still active at Stripe") && held[0].includes("/admin/api/licenses/expiry"), held[0]);
    assert.equal(c.logs.filter(l => l.includes("refusing paid hosting provisioning")).length, 0);
    assert.equal(c.h.hub.hosting.store.outboxFor(row.id).filter(j => j.jobType === "email" && j.payload.template === "cancellation_scheduled").length, 0, "no cancellation email is queued");

    c.set(ECHO_UPDATE);
    assert.equal((await c.post("customer.subscription.updated", c.subscriptionObject(s), ECHO_UPDATE)).body.outcome, "applied");
    assert.equal(c.exp(s), PAID_TERM_EXP, "Stripe's active subscription with its period end extends the licence to the paid term");
    await c.tick();
    assert.equal(c.logs.filter(l => l.includes("software licence hold ended")).length, 1);
    assert.equal(c.cancellations(s).length, 0);
    assert.equal(c.instance(s).paidThroughMs, PERIOD_END);
    assert.equal(c.instance(s).stage, "ready");
  } finally { await c.h.close(); }
});

await test("the discarded older initial invoice delivered three days late still establishes the paid term and lifts the hold", async () => {
  const c = await setup();
  try {
    const { s } = await checkedOut(c);
    await provisioned(c, s);
    c.set(FIRST_TICK_AFTER_LAPSE);
    await c.tick();
    assert.equal(c.logs.filter(l => l.includes("withholding software-ineligible cancellation")).length, 1);
    c.advance(15_000);
    const late = await c.post("invoice.paid", c.invoice(s), INVOICE_CREATED);
    assert.equal(late.body.outcome, "applied", JSON.stringify(late.body));
    assert.equal(c.exp(s), PAID_TERM_EXP);
    assert.equal(c.h.hub.billing.store.getCustomer(c.key(s)).periodEndMs, PERIOD_END);
    assert.equal(c.h.hub.billing.store.getRoleSubscription(c.key(s), "hosting").periodEndMs, PERIOD_END);
    await c.tick();
    assert.equal(c.cancellations(s).length, 0);
    assert.equal(c.logs.filter(l => l.includes("software licence hold ended")).length, 1);
    assert.equal((await c.post("invoice.payment_succeeded", c.invoice(s), INVOICE_CREATED)).body.outcome, "ignored");
  } finally { await c.h.close(); }
});

await test("an order still unprovisioned when the grant lapses is neither cancelled nor provisioned while held; the queued provision job waits and runs once the paid period is applied", async () => {
  const c = await setup();
  try {
    const { s } = await checkedOut(c);
    assert.equal(c.instance(s).stage, "ordered");
    assert.ok(c.h.hub.hosting.store.outboxFor(c.instance(s).id).some(j => j.jobType === "provision" && j.status === "pending"), "checkout queued the provision job");
    c.set(FIRST_TICK_AFTER_LAPSE);
    await c.tick();
    assert.equal(c.provider.createCalls.length, 0, "no server is created for a licence that would refuse its own install");
    assert.equal(c.instance(s).stage, "ordered", "the order is kept, not deleted");
    assert.equal(c.cancellations(s).length, 0);
    const job = c.h.hub.hosting.store.outboxFor(c.instance(s).id).find(j => j.jobType === "provision");
    assert.equal(job.status, "pending"); assert.match(job.lastErrorCode, /software licence lapsed while its subscription is still active/);
    c.set(ECHO_UPDATE);
    assert.equal((await c.post("customer.subscription.updated", c.subscriptionObject(s), ECHO_UPDATE)).body.outcome, "applied");
    c.advance(31_000); // the job's retry backoff
    await c.tick();
    assert.equal(c.provider.createCalls.length, 1);
    assert.equal(c.instance(s).stage, "bootstrapping");
    assert.equal(c.cancellations(s).length, 0);
  } finally { await c.h.close(); }
});

await test("Stripe's own word still cancels: a failed payment, an ended subscription, and a full refund keep the software-ineligible path", async () => {
  for (const word of ["payment_failed", "deleted", "refunded"]) {
    const c = await setup();
    try {
      const { s } = await checkedOut(c);
      assert.equal((await c.post("invoice.paid", c.invoice(s), INVOICE_CREATED)).body.outcome, "applied");
      await provisioned(c, s);
      c.set(ECHO_UPDATE);
      if (word === "payment_failed") assert.equal((await c.post("invoice.payment_failed", c.invoice(s, { id: "in_fail_" + s.id, paid: false, status: "open", billing_reason: "subscription_cycle" }))).body.outcome, "applied");
      if (word === "deleted") assert.equal((await c.post("customer.subscription.deleted", c.subscriptionObject(s, { status: "canceled", cancel_at_period_end: false }))).body.outcome, "applied");
      if (word === "refunded") assert.equal((await c.post("charge.refunded", { id: "ch_" + s.id, customer: c.key(s), payment_intent: "pi_" + s.id, amount: SOFTWARE_CENTS - SOFTWARE_DISCOUNT_CENTS + VPS_CENTS, amount_refunded: SOFTWARE_CENTS - SOFTWARE_DISCOUNT_CENTS + VPS_CENTS, refunded: true })).body.outcome, "applied");
      const sw = c.h.hub.billing.store.getCustomer(c.key(s));
      if (word === "refunded") { assert.equal(sw.refunded, true); assert.equal(c.h.store.isRevoked(sw.licenseId), true); }
      else { assert.equal(sw.subscriptionStatus, word === "payment_failed" ? "past_due" : "canceled"); c.set(PAID_TERM_EXP + 60_000); assert.ok(c.exp(s) <= c.now()); }
      await c.tick();
      const jobs = c.cancellations(s);
      assert.equal(jobs.length, 1, `${word}: the software-ineligible cancellation is still queued`);
      assert.equal(jobs[0].payload.reason, "software-ineligible"); assert.equal(jobs[0].payload.subscriptionId, c.sub(s));
      assert.equal(c.logs.filter(l => l.includes("withholding software-ineligible cancellation")).length, 0, `${word} is Stripe's word, never held`);
      const refusal = c.logs.find(l => l.includes("refusing paid hosting provisioning"));
      assert.ok(refusal && refusal.includes(word === "refunded" ? "(revoked)" : `(lapsed, subscription ${word === "payment_failed" ? "past_due" : "canceled"})`), refusal);
    } finally { await c.h.close(); }
  }
});

await test("softwareIneligibility names the reason, and only a clock lapse against an active, unrefunded subscription is a hold", async () => {
  const c = await setup();
  try {
    const hosting = c.h.hub.hosting, billing = c.h.hub.billing;
    assert.deepEqual(hosting.softwareIneligibility("cus_nobody", c.now()), { kind: "unbound" });
    const { s } = await checkedOut(c);
    const owner = c.key(s);
    assert.equal(hosting.softwareIneligibility(owner, c.now()), null);
    assert.equal(hosting.softwareEligible(owner, c.now()), true);
    const lapsed = BOOTSTRAP_EXP + 1;
    assert.deepEqual(hosting.softwareIneligibility(owner, lapsed), { kind: "lapsed", licenseExp: BOOTSTRAP_EXP, subscriptionStatus: "active", subscriptionActive: true });
    assert.equal(hosting.softwareEligible(owner, lapsed), false);
    const rec = billing.store.getCustomer(owner);
    for (const [status, active] of [["active (cancels at period end)", true], ["trialing", true], ["past_due", false], ["canceled", false], ["unpaid", false], ["incomplete_expired", false], [null, false]]) {
      billing.store.putCustomer({ ...rec, subscriptionStatus: status });
      assert.equal(hosting.softwareIneligibility(owner, lapsed).subscriptionActive, active, `status ${status}`);
    }
    billing.store.putCustomer({ ...rec, subscriptionStatus: "active", subscriptionId: null });
    assert.equal(hosting.softwareIneligibility(owner, lapsed).subscriptionActive, false, "a one-time purchase has no subscription to contradict the clock");
    billing.store.putCustomer({ ...rec, subscriptionStatus: "active", disputed: true });
    assert.equal(hosting.softwareIneligibility(owner, lapsed).subscriptionActive, false, "a disputed record is never held");
    billing.store.putCustomer(rec);
    c.h.store.revoke(rec.licenseId);
    assert.deepEqual(hosting.softwareIneligibility(owner, c.now()), { kind: "revoked" });
  } finally { await c.h.close(); }
});

// ── a separate hosting subscription next to a software-only subscription ────
// The other shape the guard protects: a software-only launch subscription
// (licence bootstrapped at checkout, paid period applied later) with a
// hosting add-on on its own Stripe subscription. Here cancelling for
// `software-ineligible` is the intended behaviour once Stripe says the
// software subscription ended — and a wrong behaviour while it is active.
const TEST_WHSEC = "whsec_test_guard_separate_0123456789";
async function separateHub() {
  let clock = Date.parse("2026-10-12T04:00:00Z"), n = 0;
  const logs = [], provider = new FakeProvider({ now: () => clock });
  const h = await freshHub({}, {
    billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }), billingNow: () => clock, hostingNow: () => clock, hostingProvider: provider, hostingPublicHealthFetch: PUBLIC_HEALTH_OK,
    hostingFetch: async (url) => {
      if (url.includes("/v1/prices/")) return { ok: true, status: 200, text: async () => JSON.stringify({ id: "price_host1", active: true, unit_amount: 2000, currency: "usd", type: "recurring", recurring: { interval: "month", interval_count: 1 } }) };
      if (url.endsWith("/v1/checkout/sessions")) return { ok: true, status: 200, text: async () => JSON.stringify({ url: "https://checkout.stripe.com/c/pay_test" }) };
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  h.hub.hosting.log = line => logs.push(line);
  const admin = (p, body) => jsonReq(`${h.origin}${p}`, { method: "POST", headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  await admin("/admin/api/billing/config", {
    policy: { graceDays: GRACE_DAYS, bootstrapDays: BOOTSTRAP_DAYS },
    stripe: { test: { secretKey: "sk_test_guard_0123456789", webhookSecret: TEST_WHSEC, paymentLinks: { "hosting-monthly": "https://buy.stripe.com/test_hosting" } } },
    roles: { test: { hosting: { priceIds: ["price_host1"], productIds: [] } } },
    plans: [
      { key: "monthly", name: "Monthly", amountCents: 9900, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "software" },
      { key: "hosting-monthly", name: "Hosting", amountCents: 2000, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "hosting" },
    ],
  });
  await admin("/admin/api/hosting/policy", { policy: { provisioningEnabled: true, monthlyPriceCents: 2000, osId: "1743", releaseRef: "a".repeat(64) } });
  const post = async (type, object) => {
    const body = JSON.stringify({ id: `evt_sep_${++n}`, object: "event", type, livemode: false, created: Math.floor(clock / 1000), data: { object } });
    return jsonReq(`${h.origin}/api/billing/stripe/test`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, TEST_WHSEC, Math.floor(clock / 1000)) }, body });
  };
  const owner = "cus_separate", email = "separate@example.test";
  assert.equal((await post("checkout.session.completed", { id: "cs_sw_sep", mode: "subscription", payment_status: "paid", customer: owner, customer_details: { email }, subscription: "sub_sw_sep", metadata: { plan: "monthly" } })).status, 200);
  assert.equal((await h.hub.hosting.checkoutUrl(owner, email, clock)).ok, true);
  assert.equal((await post("checkout.session.completed", { id: "cs_host_sep", mode: "subscription", payment_status: "paid", customer: owner, customer_details: { email }, subscription: "sub_host_sep", metadata: { plan: "hosting-monthly" } })).status, 200);
  await h.hub.hosting.tick(clock);
  const instance = () => h.hub.hosting.store.instances().find(r => r.ownerId === owner);
  await readyInstance(h, instance(), clock);
  const sw = h.hub.billing.store.getCustomer(owner);
  const bootstrapExp = h.store.get(sw.licenseId).exp;
  assert.equal(bootstrapExp, clock + BOOTSTRAP_DAYS * DAY);
  return { h, logs, post, owner, sw, bootstrapExp, instance, cancellations: () => h.hub.hosting.store.outboxFor(instance().id).filter(j => j.jobType === "billing_reconcile"), tick: () => h.hub.hosting.tick(clock), set: ms => { clock = ms; }, advance: ms => { clock += ms; }, now: () => clock };
}

await test("separate subscriptions: a software licence that lapses while its own subscription is still active holds the hosting cancellation until the paid period lands", async () => {
  const c = await separateHub();
  try {
    c.set(c.bootstrapExp + 16_000);
    await c.tick(); c.advance(30_000); await c.tick();
    assert.equal(c.cancellations().length, 0, "the hosting subscription is not cancelled on the software clock alone");
    assert.equal(c.logs.filter(l => l.includes("withholding software-ineligible cancellation")).length, 1);
    const end = Math.floor((c.now() + 30 * DAY) / 1000);
    assert.equal((await c.post("invoice.paid", { id: "in_sw_sep", paid: true, status: "paid", customer: c.owner, customer_email: "separate@example.test", subscription: "sub_sw_sep", billing_reason: "subscription_cycle", lines: { data: [{ period: { end }, price: { id: "price_sw1", product: "prod_sw1" } }] }, subscription_details: { metadata: { plan: "monthly" } } })).body.outcome, "applied");
    assert.equal(c.h.store.get(c.sw.licenseId).exp, Math.min(end * 1000 + GRACE_DAYS * DAY, c.sw.createdAtMs + c.h.hub.billing.config().policy.testMaxDays * DAY), "the paid period extends the licence (test-mode cap applies)");
    await c.tick();
    assert.equal(c.cancellations().length, 0);
    assert.equal(c.logs.filter(l => l.includes("software licence hold ended")).length, 1);
  } finally { await c.h.close(); }
});

await test("separate subscriptions: once Stripe ends the software subscription and the licence lapses, the hosting subscription is cancelled as before", async () => {
  const c = await separateHub();
  try {
    assert.equal((await c.post("customer.subscription.deleted", { id: "sub_sw_sep", customer: c.owner, status: "canceled", metadata: { plan: "monthly" }, items: { data: [{ price: { id: "price_sw1" } }] } })).body.outcome, "applied");
    assert.equal(c.h.hub.billing.store.getCustomer(c.owner).subscriptionStatus, "canceled");
    await c.tick();
    assert.equal(c.cancellations().length, 0, "the licence still runs to its paid-through date; nothing to cancel yet");
    c.set(c.bootstrapExp + 16_000);
    await c.tick();
    const jobs = c.cancellations();
    assert.equal(jobs.length, 1); assert.equal(jobs[0].payload.reason, "software-ineligible"); assert.equal(jobs[0].payload.subscriptionId, "sub_host_sep");
    assert.equal(c.logs.filter(l => l.includes("withholding software-ineligible cancellation")).length, 0);
    assert.ok(c.logs.some(l => l.includes("refusing paid hosting provisioning") && l.includes("(lapsed, subscription canceled)")));
  } finally { await c.h.close(); }
});

// ── the operator-side reversal (`adminResumeRenewal`) ──────────────────────
// The customer's record set as the incident left it: checkout, the discarded
// invoice, the lapse, then Stripe's state after the 0.4.90 Hub's own
// `cancel_at_period_end=true` (modelled by the echo update with
// `cancel_at_period_end: true`, which is exactly what Stripe sent back),
// which the Hub mirrored as `intentional_cancellation` with the Nov 6
// suspend and Nov 13 delete, plus the admin deletion hold the proposal
// places first.
const END_JOB_KEYS = /^(suspend|delete|email:three_days|email:one_day|email:cancel_scheduled):/;
async function incidentCancelled(c, { hold = true, paid = false } = {}) {
  const { s } = await checkedOut(c);
  // `paid`: the initial invoice applied (charges indexed on both records), for
  // cases that need a charge-level event to be attributable to this bundle.
  // The default is the incident's own state: the invoice never applied.
  if (paid) assert.equal((await c.post("invoice.paid", c.invoice(s), INVOICE_CREATED)).body.outcome, "applied");
  await provisioned(c, s);
  c.set(FIRST_TICK_AFTER_LAPSE); await c.tick();
  c.set(ECHO_UPDATE);
  assert.equal((await c.post("customer.subscription.updated", c.subscriptionObject(s, { cancel_at_period_end: true }), ECHO_UPDATE)).body.outcome, "applied");
  assert.equal(c.exp(s), PAID_TERM_EXP, "the echo extended the licence to the paid term");
  await c.tick(); c.advance(30_000); await c.tick();
  const row = c.instance(s);
  assert.equal(row.stage, "cancel_scheduled"); assert.equal(row.cancellationReason, "intentional_cancellation");
  assert.equal(row.suspendAtMs, PERIOD_END); assert.equal(row.deleteAtMs, PERIOD_END + 7 * DAY);
  const pendingEnd = c.h.hub.hosting.store.outboxFor(row.id).filter(j => j.status === "pending" && END_JOB_KEYS.test(j.dedupeKey));
  assert.deepEqual(pendingEnd.map(j => j.dedupeKey.split(":")[0]).sort(), ["delete", "email", "email", "email", "suspend"], "the incident's pending end jobs");
  assert.equal(c.h.hub.billing.store.getCustomer(c.key(s)).subscriptionStatus, "active (cancels at period end)");
  if (hold) { assert.equal(c.h.hub.hosting.adminHoldDeletion(row.id, "operator", "Hub-originated cancellation under review", c.now()).ok, true); }
  c.stripeCalls.length = 0;
  return { s, row: c.instance(s) };
}
const adminResume = (c, id, body = { by: "operator", reason: "2026-10-09 initial-invoice defect" }) => c.admin(`/admin/api/hosting/instances/${id}/resume-renewal`, body);
const rowView = (c, s) => { const r = c.instance(s); return { stage: r.stage, cancellationReason: r.cancellationReason, suspendAtMs: r.suspendAtMs, deleteAtMs: r.deleteAtMs, deletionHold: r.deletionHold, lifecycleVersion: r.lifecycleVersion, paidThroughMs: r.paidThroughMs }; };
const jobStatuses = (c, s) => Object.fromEntries(c.h.hub.hosting.store.outboxFor(c.instance(s).id).map(j => [j.dedupeKey, j.status]).sort());

await test("operator reversal of the incident's scheduled cancellation: Stripe first, then the row back to running, end jobs obsoleted, hold released, licence unchanged at the paid term, audited as operator-originated; the echo and later ticks change nothing", async () => {
  const c = await setup();
  try {
    const { s, row } = await incidentCancelled(c);
    assert.ok(row.deletionHold, "the proposal's hold is in place");
    c.advance(60_000);
    const r = await adminResume(c, row.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual({ ok: r.body.ok, stage: r.body.stage, changed: r.body.changed }, { ok: true, stage: "ready", changed: true });
    assert.deepEqual(c.stripeCalls, [{ subscriptionId: c.sub(s), body: "cancel_at_period_end=false" }], "exactly one Stripe update, through the existing control path");
    const after = c.instance(s);
    assert.equal(after.stage, "ready"); assert.equal(after.cancellationReason, null); assert.equal(after.suspendAtMs, null); assert.equal(after.deleteAtMs, null);
    assert.equal(after.deletionHold, null, "the operator's hold is released by the reversal");
    assert.equal(after.lifecycleVersion, row.lifecycleVersion + 1); assert.equal(after.paidThroughMs, PERIOD_END);
    const jobs = c.h.hub.hosting.store.outboxFor(row.id);
    assert.equal(jobs.filter(j => j.status === "pending" && END_JOB_KEYS.test(j.dedupeKey)).length, 0, "no pending suspend/delete/reminder job remains");
    assert.deepEqual(jobs.filter(j => END_JOB_KEYS.test(j.dedupeKey) && j.status === "obsolete").map(j => j.dedupeKey.split(":")[0]).sort(), ["delete", "email", "email", "email", "suspend"], "every still-pending end job (suspend, delete, the two reminders and this fixture's undrained cancellation email) is obsolete");
    assert.equal(c.exp(s), PAID_TERM_EXP, "the licence keeps the paid term; nothing is shortened or extended");
    const audit = c.audit("admin.hosting.resume-renewal");
    assert.equal(audit.length, 1); assert.equal(audit[0].outcome, "applied"); assert.equal(audit[0].livemode, true);
    assert.equal(audit[0].note.actor, "operator"); assert.equal(audit[0].note.by, "operator"); assert.equal(audit[0].note.reason, "2026-10-09 initial-invoice defect");
    assert.equal(audit[0].note.instanceId, row.id); assert.equal(audit[0].note.subscriptionId, c.sub(s)); assert.equal(audit[0].note.obsoletedJobs, 5); assert.equal(audit[0].note.releasedHold.by, "operator");
    assert.ok(c.logs.some(l => l.includes(`${row.id}: scheduled cancellation reversed by operator (operator)`) && l.includes("deletion hold released")));
    assert.equal(c.h.hub.hosting.customerView(c.key(s)).instance.onHold, false);
    // Stripe's echo of the un-cancel, then ordinary ticks.
    c.advance(1000);
    assert.equal((await c.post("customer.subscription.updated", c.subscriptionObject(s, { cancel_at_period_end: false }), c.now())).body.outcome, "applied");
    const sw = c.h.hub.billing.store.getCustomer(c.key(s));
    assert.equal(sw.subscriptionStatus, "active"); assert.equal(sw.cancelAtPeriodEnd, false); assert.equal(sw.periodEndMs, PERIOD_END);
    assert.equal(c.h.hub.billing.store.getRoleSubscription(c.key(s), "hosting").subscriptionStatus, "active");
    const settled = rowView(c, s), settledJobs = jobStatuses(c, s);
    for (let i = 0; i < 3; i++) { c.advance(30_000); await c.tick(); }
    assert.deepEqual(rowView(c, s), settled); assert.deepEqual(jobStatuses(c, s), settledJobs);
    assert.equal(c.exp(s), PAID_TERM_EXP); assert.equal(c.cancellations(s).length, 0);
    // Idempotent repeat: nothing scheduled any more, no Stripe call, no second audit row.
    const again = await adminResume(c, row.id);
    assert.equal(again.status, 200); assert.deepEqual({ changed: again.body.changed, stage: again.body.stage }, { changed: false, stage: "ready" });
    assert.equal(c.stripeCalls.length, 1); assert.deepEqual(rowView(c, s), settled); assert.equal(c.audit("admin.hosting.resume-renewal").length, 1);
  } finally { await c.h.close(); }
});

await test("operator reversal refusals: admin token required, unknown instance, Stripe not confirming (row and hold untouched), refunded / disputed / canceled / past-due subscriptions, a nonpayment schedule, and a row with nothing scheduled", async () => {
  // Stripe refuses: nothing local changes and the operator can retry.
  {
    const c = await setup({ stripeRefuses: true });
    try {
      const { s, row } = await incidentCancelled(c);
      const before = rowView(c, s), jobs = jobStatuses(c, s);
      const r = await adminResume(c, row.id);
      assert.equal(r.status, 503); assert.equal(r.body.code, "PROVIDER_STATUS_UNKNOWN");
      assert.equal(c.stripeCalls.length, 1, "Stripe was asked");
      assert.deepEqual(rowView(c, s), before, "the schedule and the hold are unchanged"); assert.deepEqual(jobStatuses(c, s), jobs);
      assert.equal(c.audit("admin.hosting.resume-renewal").length, 0);
      const unauthed = await jsonReq(`${c.h.origin}/admin/api/hosting/instances/${row.id}/resume-renewal`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(unauthed.status, 401);
      assert.equal((await adminResume(c, "host_nonexistent")).status, 404);
    } finally { await c.h.close(); }
  }
  // Stripe's own word against the subscription refuses before any Stripe call.
  for (const word of ["refunded", "disputed", "canceled", "past_due"]) {
    const c = await setup();
    try {
      const { s, row } = await incidentCancelled(c, { paid: word === "refunded" || word === "disputed" });
      c.advance(60_000);
      const total = SOFTWARE_CENTS - SOFTWARE_DISCOUNT_CENTS + VPS_CENTS;
      if (word === "refunded") assert.equal((await c.post("charge.refunded", { id: "ch_" + s.id, customer: c.key(s), payment_intent: "pi_" + s.id, amount: total, amount_refunded: total, refunded: true })).body.outcome, "applied");
      if (word === "disputed") assert.equal((await c.post("charge.dispute.created", { id: "dp_" + s.id, charge: "ch_" + s.id, payment_intent: "pi_" + s.id, reason: "fraudulent" })).body.outcome, "applied");
      if (word === "canceled") assert.equal((await c.post("customer.subscription.deleted", c.subscriptionObject(s, { status: "canceled", cancel_at_period_end: false }))).body.outcome, "applied");
      if (word === "past_due") assert.equal((await c.post("invoice.payment_failed", c.invoice(s, { id: "in_fail_" + s.id, paid: false, status: "open", billing_reason: "subscription_cycle" }))).body.outcome, "applied");
      const host = c.h.hub.billing.store.getRoleSubscription(c.key(s), "hosting");
      if (word === "refunded" || word === "disputed") assert.equal(host[word], true); else assert.equal(host.subscriptionStatus, word);
      assert.equal(c.instance(s).stage, "cancel_scheduled", "the scheduled cancellation is still what the row says");
      const before = rowView(c, s);
      const r = await adminResume(c, row.id);
      assert.equal(r.status, 409, `${word}: ${JSON.stringify(r.body)}`); assert.equal(r.body.code, "SUBSCRIPTION_NOT_ACTIVE");
      assert.match(r.body.error, new RegExp(word));
      assert.equal(c.stripeCalls.length, 0, `${word}: Stripe is never asked`);
      assert.deepEqual(rowView(c, s), before); assert.equal(c.audit("admin.hosting.resume-renewal").length, 0);
    } finally { await c.h.close(); }
  }
  // A nonpayment schedule is not a cancellation; a running row has nothing to reverse.
  {
    const c = await setup();
    try {
      const { s } = await checkedOut(c);
      assert.equal((await c.post("invoice.paid", c.invoice(s), INVOICE_CREATED)).body.outcome, "applied");
      await provisioned(c, s);
      const running = await adminResume(c, c.instance(s).id);
      assert.equal(running.status, 200); assert.equal(running.body.changed, false); assert.equal(c.stripeCalls.length, 0);
      c.set(ECHO_UPDATE);
      assert.equal((await c.post("invoice.payment_failed", c.invoice(s, { id: "in_fail_" + s.id, paid: false, status: "open", billing_reason: "subscription_cycle" }))).body.outcome, "applied");
      await c.tick();
      const row = c.instance(s);
      assert.equal(row.stage, "past_due"); assert.equal(row.cancellationReason, "renewal_unpaid");
      const before = rowView(c, s);
      const r = await adminResume(c, row.id);
      assert.equal(r.status, 409); assert.equal(r.body.code, "RESTORATION_UNAVAILABLE"); assert.match(r.body.error, /nonpayment schedule is reversed by payment/);
      assert.equal(c.stripeCalls.length, 0); assert.deepEqual(rowView(c, s), before); assert.equal(c.instance(s).stage, "past_due");
    } finally { await c.h.close(); }
  }
});

await test("the customer's resume-renewal and the operator's reversal share one implementation and produce the same row, jobs and Stripe call; only the audit origin differs", async () => {
  const outcomes = {};
  for (const path of ["customer", "operator"]) {
    const c = await setup();
    try {
      const { s, row } = await incidentCancelled(c, { hold: false, paid: true });
      let shared = 0;
      const core = c.h.hub.hosting.reverseScheduledCancellation.bind(c.h.hub.hosting);
      c.h.hub.hosting.reverseScheduledCancellation = (...a) => { shared++; return core(...a); };
      c.advance(60_000);
      if (path === "customer") {
        const r = await c.h.hub.hosting.resumeRenewal(c.key(s), row.id, c.now());
        assert.equal(r.ok, true); assert.equal(r.value.stage, "ready");
      } else {
        const r = await adminResume(c, row.id, { by: "op", reason: "pin" });
        assert.equal(r.status, 200); assert.equal(r.body.changed, true);
      }
      assert.equal(shared, 1, `${path}: exactly one call into the shared core`);
      const customerAudit = c.audit("customer.hosting.resume-renewal"), operatorAudit = c.audit("admin.hosting.resume-renewal");
      assert.equal(customerAudit.length, path === "customer" ? 1 : 0); assert.equal(operatorAudit.length, path === "operator" ? 1 : 0);
      const audit = (customerAudit[0] ?? operatorAudit[0]).note;
      assert.equal(audit.actor, path); assert.equal(audit.instanceId, row.id); assert.equal(audit.subscriptionId, c.sub(s));
      outcomes[path] = { row: rowView(c, s), jobs: Object.fromEntries(Object.entries(jobStatuses(c, s)).map(([k, v]) => [k.replace(row.id, "<id>"), v])), stripe: c.stripeCalls.map(x => ({ ...x, subscriptionId: "<sub>" })), exp: c.exp(s), obsoleted: audit.obsoletedJobs };
      // The shared refusals apply to the customer path too.
      if (path === "customer") {
        const total = SOFTWARE_CENTS - SOFTWARE_DISCOUNT_CENTS + VPS_CENTS;
        await c.h.hub.hosting.cancel(c.key(s), row.id, c.now());
        assert.equal(c.instance(s).stage, "cancel_scheduled");
        assert.equal((await c.post("charge.refunded", { id: "ch_" + s.id, customer: c.key(s), payment_intent: "pi_" + s.id, amount: total, amount_refunded: total, refunded: true })).body.outcome, "applied");
        const refused = await c.h.hub.hosting.resumeRenewal(c.key(s), row.id, c.now());
        assert.equal(refused.ok, false); assert.equal(refused.code, "SUBSCRIPTION_NOT_ACTIVE");
      }
    } finally { await c.h.close(); }
  }
  assert.deepEqual(outcomes.operator, outcomes.customer, "identical outcome from either entry point");
  assert.equal(outcomes.operator.exp, PAID_TERM_EXP);
  const adminPage = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.ok(adminPage.includes("/resume-renewal") && adminPage.includes("hostingResumeRenewalAction") && adminPage.includes('inst.stage === "cancel_scheduled"'), "the admin page offers the reversal on cancel_scheduled rows");
});

summary("hosting-paid-term-guard");
