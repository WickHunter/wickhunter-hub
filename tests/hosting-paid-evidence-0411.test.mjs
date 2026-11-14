// tests/hosting-paid-evidence-0411.test.mjs — Hub 0.4.111.
//
// 1. A hosting paid-through date moves only on PAID-invoice evidence. The
//    2026-11-08 sequence: Stripe's customer.subscription.updated moved the
//    subscription into its next period (status still active) about one hour
//    before the renewal charge failed. The 0.4.110 hosting role record took
//    that period end as paid, so invoice.payment_failed scheduled the
//    nonpayment suspend/delete from a month the customer never paid for.
// 2. A paid renewal whose period end equals an already-advanced paid-through
//    date never cleared the overdue schedule (three paid hosts still
//    scheduled to suspend). The 0.4.111 paid-evidence fields settle it on
//    the live path, and POST /admin/api/hosting/billing-repair settles the
//    rows written before 0.4.111 from Stripe's paid invoices (dry run first).
// 3. A region replacement released nothing on the lease ledger, so the
//    replacement server's install was refused "machine limit reached" for
//    five weeks, and the refusal was never written anywhere.
//
// Every Stripe object is an offline fixture signed with a test webhook
// secret; the provider is FakeProvider; no network leaves 127.0.0.1.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash, generateKeyPairSync, sign } from "node:crypto";
import { freshHub, freshStore, jsonReq, test, summary } from "./helpers.mjs";
import { FakeProvider, hashBootstrapToken } from "../dist/src/hosting/provider.js";
import { signStripePayload } from "../dist/src/billing/stripe.js";
import { recordCheckin } from "../dist/src/checkins.js";
import { LicenseLeaseService } from "../dist/src/license-leases.js";

const SECRET = "whsec_paid_evidence_offline_fixture";
const DAY = 86_400_000, HOUR = 3_600_000;
const GRACE_DAYS = 3;
const CHECKOUT_COMPLETED = Date.parse("2026-10-08T14:33:00Z");
const INVOICE_CREATED = CHECKOUT_COMPLETED - 1000;
const PERIOD_END = Date.parse("2026-11-08T14:33:00Z");       // the paid initial term
const NEXT_END = Date.parse("2026-12-08T14:33:00Z");         // the renewal Stripe moved into
const SUB_UPDATED = PERIOD_END + 5 * 60_000;                 // Stripe's period roll, status still active
const PAYMENT_FAILED = SUB_UPDATED + HOUR;                   // ~1 h later, the renewal charge fails
const SOFTWARE_CENTS = 9900, VPS_CENTS = 2000;
const PUBLIC_HEALTH_OK = async () => ({ ok: true, status: 200, body: JSON.stringify({ ok: true, version: "0.91.46" }) });

async function readyInstance(h, row, nowMs) {
  assert.equal(row.stage, "bootstrapping");
  const rawToken = `tok-${row.id}`;
  h.hub.hosting.store.updateInstance(row.id, row.version, (d) => { d.bootstrapTokenHash = hashBootstrapToken(rawToken); d.bootstrapTokenExpiresAtMs = nowMs + HOUR; }, nowMs);
  const fresh = h.hub.hosting.store.getInstance(row.id);
  const results = ["bybit", "binance", "bitget", "bitunix", "blofin", "weex", "aster"].map((venueId) => ({ venueId, status: 200 }));
  const r = await jsonReq(`${h.origin}/api/hosting/instances/${row.id}/readiness`, { method: "POST", body: JSON.stringify({ token: rawToken, generation: fresh.generation, results }) });
  assert.equal(r.body.ready, true, JSON.stringify(r.body));
}

// ── the mixed (software + VPS, one subscription) fixture ───────────────────
async function setup() {
  let clock = CHECKOUT_COMPLETED - 60_000, n = 0;
  const sessions = new Map(), logs = [], stripeWrites = [], stripeReads = [];
  // What a Stripe GET answers for the billing repair (set per test).
  const stripeState = { subscription: null, invoices: [] };
  const provider = new FakeProvider({ now: () => clock });
  const fake = async (input, init = {}) => {
    const url = new URL(input), p = url.pathname, params = new URLSearchParams(init.body ?? "");
    let out;
    if (p.startsWith("/v1/subscriptions/") && init.method === "POST") {
      stripeWrites.push({ p, body: init.body });
      out = { id: p.split("/").at(-1), object: "subscription", cancel_at_period_end: params.get("cancel_at_period_end") === "true" };
    } else if (p.startsWith("/v1/subscriptions/") && init.method === "GET") {
      stripeReads.push(p);
      out = stripeState.subscription;
      if (!out) return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
    } else if (p === "/v1/invoices" && init.method === "GET") {
      stripeReads.push(p + url.search);
      out = { object: "list", data: stripeState.invoices.filter(i => i.subscription === url.searchParams.get("subscription")), has_more: false };
    } else if (p.startsWith("/v1/prices/")) {
      const id = p.split("/").at(-1), host = id.startsWith("price_host"), annual = id === "price_yearly" || id === "price_hostyear", life = id === "price_lifetime";
      out = { id, active: true, livemode: true, type: life ? "one_time" : "recurring", currency: "usd", unit_amount: host ? (annual ? 24000 : VPS_CENTS) : life ? 99900 : annual ? 69900 : SOFTWARE_CENTS, product: host ? "prod_vps" : "prod_software", recurring: life ? null : { interval: annual ? "year" : "month", interval_count: 1 } };
    } else if (p === "/v1/account") out = { capabilities: { crypto_payments: "active" } };
    else if (p === "/v1/checkout/sessions" && init.method === "POST") {
      const key = init.headers["Idempotency-Key"]; out = sessions.get(key);
      if (!out) {
        const id = `cs_evid${++n}`, meta = Object.fromEntries([...params].filter(([k]) => /^metadata\[/.test(k)).map(([k, v]) => [k.slice(9, -1), v]));
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
  const h = await freshHub({}, { billingNow: () => clock, hostingNow: () => clock, launchFetch: fake, hostingFetch: fake, billingFetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "mail_fixture" }) }), hostingProvider: provider, hostingPublicHealthFetch: PUBLIC_HEALTH_OK,
    licenseLeaseNow: () => clock, licenseLeaseMonotonicNow: () => clock - (CHECKOUT_COMPLETED - 120_000) });
  h.hub.hosting.log = line => logs.push(line);
  const admin = (p, body, method = "POST") => jsonReq(h.origin + p, { method, headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await admin("/admin/api/billing/config", {
    mode: "live", policy: { graceDays: GRACE_DAYS, bootstrapDays: 3 },
    plans: [...h.hub.billing.config().plans, { key: "hosting-monthly", name: "Hosting", amountCents: VPS_CENTS, currency: "usd", interval: "month", role: "hosting" }],
    stripe: { live: { secretKey: "sk_live_offline_only", webhookSecret: SECRET, priceIds: { monthly: "price_monthly", yearly: "price_yearly", lifetime: "price_lifetime", "hosting-monthly": "price_hostold" } } },
    roles: { live: { hosting: { priceIds: ["price_hostold"] }, software: { priceIds: ["price_monthly", "price_yearly", "price_lifetime"], productIds: ["prod_software"] } } },
  })).status, 200);
  assert.equal((await admin("/admin/api/hosting/policy", { policy: { provisioningEnabled: true, monthlyPriceCents: VPS_CENTS, osId: "2284", releaseRef: "b".repeat(64), maximumProjectedMonthlyProviderCostCents: 10000 } })).status, 200);
  assert.equal((await admin("/admin/api/billing/hosted-offer", { monthlyPriceId: "price_hostmonth", yearlyPriceId: "price_hostyear" })).status, 200);
  assert.equal((await admin("/admin/api/billing/launch", { action: "prepare" })).status, 200);
  await admin("/admin/api/billing/launch", { enabled: true, cryptoEnabled: true });
  const checkout = () => jsonReq(h.origin + "/api/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", payment: "card", hosting: true, attemptId: randomUUID() }) });
  const last = () => [...sessions.values()].at(-1);
  const key = s => "cus_" + s.id, sub = s => "sub_" + s.id;
  const completed = s => ({ id: s.id, mode: "subscription", payment_status: "paid", customer: key(s), customer_details: { email: s.id + "@example.test" }, subscription: sub(s), metadata: s.metadata,
    amount_subtotal: SOFTWARE_CENTS + VPS_CENTS, total_details: { amount_discount: 0 }, amount_total: SOFTWARE_CENTS + VPS_CENTS });
  /** A subscription invoice for [startMs, endMs]. */
  const invoice = (s, { id = "in_" + s.id, startMs = CHECKOUT_COMPLETED, endMs = PERIOD_END, paid = true, reason = "subscription_create", created = INVOICE_CREATED } = {}) => ({
    id, object: "invoice", paid, status: paid ? "paid" : "open", amount_paid: paid ? SOFTWARE_CENTS + VPS_CENTS : 0, customer: key(s), customer_email: s.id + "@example.test", subscription: sub(s), subscription_details: { metadata: s.metadata }, billing_reason: reason,
    created: Math.floor(created / 1000), status_transitions: { paid_at: paid ? Math.floor(created / 1000) : null },
    lines: { data: s.lines.map(l => ({ price: l.price, amount: l.amount_subtotal, discount_amounts: [], taxes: [], quantity: 1, period: { start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000) } })), has_more: false },
    charge: paid ? "ch_" + id : null, payment_intent: paid ? "pi_" + id : null });
  const subscriptionObject = (s, over = {}) => ({ id: sub(s), object: "subscription", customer: key(s), status: "active", cancel_at_period_end: false, livemode: true, current_period_end: Math.floor(PERIOD_END / 1000), metadata: s.metadata,
    items: { data: s.lines.map(l => ({ price: l.price, current_period_end: over.current_period_end ?? Math.floor(PERIOD_END / 1000) })) }, ...over });
  const post = async (type, object, created = clock, id = "evt_" + randomUUID()) => {
    const body = JSON.stringify({ id, object: "event", type, livemode: true, created: Math.floor(created / 1000), data: { object } });
    return { id, ...(await jsonReq(h.origin + "/api/billing/stripe/live", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, SECRET, Math.floor(clock / 1000)) }, body })) };
  };
  const instance = s => h.hub.hosting.store.instances().find(r => r.ownerId === key(s)) ?? null;
  const host = s => h.hub.billing.store.getRoleSubscription(key(s), "hosting");
  const sw = s => h.hub.billing.store.getCustomer(key(s));
  const exp = s => h.store.get(sw(s).licenseId)?.exp ?? null;
  const tick = () => h.hub.hosting.tick(clock);
  const pendingEnd = s => h.hub.hosting.store.outboxFor(instance(s).id).filter(j => j.status === "pending" && ["suspend", "delete", "email"].includes(j.jobType));
  return { h, provider, logs, stripeWrites, stripeReads, stripeState, admin, checkout, last, key, sub, completed, invoice, subscriptionObject, post, instance, host, sw, exp, tick, pendingEnd,
    set: ms => { clock = ms; }, advance: ms => { clock += ms; }, now: () => clock };
}

/** Checkout, its initial paid invoice (CHECKOUT_COMPLETED → PERIOD_END), and a running VPS. */
async function paidAndRunning(c) {
  assert.equal((await c.checkout()).status, 200);
  const s = c.last();
  c.set(CHECKOUT_COMPLETED);
  assert.equal((await c.post("checkout.session.completed", c.completed(s), CHECKOUT_COMPLETED)).body.outcome, "applied");
  const paid = await c.post("invoice.paid", c.invoice(s), INVOICE_CREATED);
  assert.equal(paid.body.outcome, "applied", JSON.stringify(paid.body));
  await c.tick();
  assert.equal(c.provider.createCalls.length, 1);
  await readyInstance(c.h, c.instance(s), c.now());
  assert.equal(c.instance(s).stage, "ready");
  assert.equal(c.instance(s).paidThroughMs, PERIOD_END);
  assert.equal(c.host(s).paidPeriodEndMs, PERIOD_END, "a paid invoice records the 0.4.111 paid period end");
  return s;
}

/** The 2026-11-08 sequence on the current code. */
async function rolledThenFailed(c, s) {
  c.set(SUB_UPDATED);
  const upd = await c.post("customer.subscription.updated", c.subscriptionObject(s, { current_period_end: Math.floor(NEXT_END / 1000) }), SUB_UPDATED);
  assert.equal(upd.body.outcome, "applied", JSON.stringify(upd.body));
  await c.tick();
  c.set(PAYMENT_FAILED);
  const failed = await c.post("invoice.payment_failed", c.invoice(s, { id: "in_renew_" + s.id, startMs: PERIOD_END, endMs: NEXT_END, paid: false, reason: "subscription_cycle", created: PAYMENT_FAILED }), PAYMENT_FAILED);
  assert.equal(failed.body.outcome, "applied", JSON.stringify(failed.body));
  await c.tick();
}

const graceHours = c => c.h.hub.hosting.policy().renewalGraceHours;
const fileHash = f => fs.existsSync(f) ? createHash("sha256").update(fs.readFileSync(f)).digest("hex") : "absent";

await test("the 2026-11-08 order (subscription.updated rolls the period ~1 h before invoice.payment_failed) leaves hosting paid through the LAST PAID period; the nonpayment schedule anchors there; software is unchanged", async () => {
  const c = await setup();
  try {
    const s = await paidAndRunning(c);
    c.set(SUB_UPDATED);
    assert.equal((await c.post("customer.subscription.updated", c.subscriptionObject(s, { current_period_end: Math.floor(NEXT_END / 1000) }), SUB_UPDATED)).body.outcome, "applied");
    assert.equal(c.host(s).periodEndMs, PERIOD_END, "an active subscription.updated is not payment: the hosting period does not move");
    await c.tick();
    assert.equal(c.instance(s).paidThroughMs, PERIOD_END, "the row is not advanced by the period roll");
    assert.equal(c.instance(s).stage, "ready");
    const swBefore = { exp: c.exp(s), periodEndMs: c.sw(s).periodEndMs };
    c.set(PAYMENT_FAILED);
    assert.equal((await c.post("invoice.payment_failed", c.invoice(s, { id: "in_renew_" + s.id, startMs: PERIOD_END, endMs: NEXT_END, paid: false, reason: "subscription_cycle", created: PAYMENT_FAILED }), PAYMENT_FAILED)).body.outcome, "applied");
    const rec = c.host(s);
    assert.equal(rec.subscriptionStatus, "past_due");
    assert.equal(rec.periodEndMs, PERIOD_END);
    assert.equal(rec.unpaidPeriodEndMs, NEXT_END, "the failed renewal's own period is recorded");
    await c.tick();
    const row = c.instance(s);
    assert.equal(row.stage, "past_due"); assert.equal(row.cancellationReason, "renewal_unpaid");
    assert.equal(row.paidThroughMs, PERIOD_END, "paid through the last PAID period (0.4.110 said the next month)");
    assert.equal(row.suspendAtMs, PERIOD_END + graceHours(c) * HOUR, "suspend is derived from the true paid end — no free month");
    // Software side: exactly the established behavior.
    assert.equal(c.sw(s).subscriptionStatus, "past_due");
    assert.equal(c.exp(s), swBefore.exp, "the licence keeps its paid term plus grace");
    assert.equal(c.exp(s), PERIOD_END + GRACE_DAYS * DAY);
    assert.equal(c.sw(s).periodEndMs, swBefore.periodEndMs);
    // A cancels-at-period-end echo of the Hub's own software-ineligible
    // cancellation (Servers 1 and 2) is not payment either.
    c.advance(3 * DAY);
    assert.equal((await c.post("customer.subscription.updated", c.subscriptionObject(s, { cancel_at_period_end: true, current_period_end: Math.floor(NEXT_END / 1000) }), c.now())).body.outcome, "applied");
    assert.equal(c.host(s).periodEndMs, PERIOD_END, "a cancels-at-period-end echo grants no hosting period");
  } finally { await c.h.close(); }
});

await test("a late payment of the failed renewal advances paid-through, clears the overdue schedule and obsoletes its pending jobs; the licence extends", async () => {
  const c = await setup();
  try {
    const s = await paidAndRunning(c);
    await rolledThenFailed(c, s);
    const scheduled = c.instance(s);
    assert.equal(scheduled.cancellationReason, "renewal_unpaid");
    const endJobs = c.pendingEnd(s).map(j => j.dedupeKey);
    assert.ok(endJobs.some(k => k.startsWith("suspend:")) && endJobs.some(k => k.startsWith("delete:")));
    c.set(PAYMENT_FAILED + 2 * DAY);
    const paid = await c.post("invoice.paid", c.invoice(s, { id: "in_renew_" + s.id, startMs: PERIOD_END, endMs: NEXT_END, reason: "subscription_cycle", created: c.now() }), c.now());
    assert.equal(paid.body.outcome, "applied", JSON.stringify(paid.body));
    const rec = c.host(s);
    assert.equal(rec.periodEndMs, NEXT_END); assert.equal(rec.paidPeriodEndMs, NEXT_END);
    assert.equal(rec.unpaidPeriodEndMs, undefined, "the paid invoice reaches and settles the failed period");
    assert.equal(rec.subscriptionStatus, "active");
    await c.tick();
    const row = c.instance(s);
    assert.equal(row.paidThroughMs, NEXT_END);
    assert.equal(row.cancellationReason, null); assert.equal(row.suspendAtMs, null); assert.equal(row.deleteAtMs, null);
    assert.ok(row.lifecycleVersion > scheduled.lifecycleVersion);
    const statuses = Object.fromEntries(c.h.hub.hosting.store.outboxFor(row.id).map(j => [j.dedupeKey, j.status]));
    for (const k of endJobs) assert.notEqual(statuses[k], "pending", `${k} no longer pending`);
    assert.equal(c.exp(s), NEXT_END + GRACE_DAYS * DAY, "software licence extends exactly as before");
  } finally { await c.h.close(); }
});

await test("a delayed failure for a term a paid invoice already covers is ignored by hosting; a paid invoice for an earlier term never settles a later failed renewal", async () => {
  const c = await setup();
  try {
    const s = await paidAndRunning(c);
    c.set(PERIOD_END - DAY);
    const stale = await c.post("invoice.payment_failed", c.invoice(s, { id: "in_first_try_" + s.id, paid: false, created: INVOICE_CREATED - 60_000 }), c.now());
    assert.equal(stale.body.outcome, "ignored", JSON.stringify(stale.body));
    assert.equal(c.host(s).subscriptionStatus, "active");
    await c.tick();
    assert.equal(c.instance(s).stage, "ready", "no overdue schedule for a term already paid");
    await rolledThenFailed(c, s);
    assert.equal(c.instance(s).cancellationReason, "renewal_unpaid");
    // The ALIAS of the initial (earlier-term) invoice arrives again.
    await c.post("invoice.payment_succeeded", c.invoice(s), c.now());
    assert.equal(c.host(s).unpaidPeriodEndMs, NEXT_END, "an earlier-term payment does not pay the failed renewal");
    assert.equal(c.host(s).subscriptionStatus, "past_due");
    await c.tick();
    assert.equal(c.instance(s).stage, "past_due"); assert.equal(c.instance(s).cancellationReason, "renewal_unpaid");
  } finally { await c.h.close(); }
});

/** The pre-0.4.111 group-B shape: 0.4.110 advanced the row to NEXT_END on the
 *  period roll, the failure scheduled renewal_unpaid from NEXT_END, the late
 *  paid invoice (end == NEXT_END) "advanced" nothing. Records written by
 *  0.4.110 carry no paid-evidence fields. */
async function legacyGroupB(c, s, { paidLate = true } = {}) {
  const rec = c.host(s);
  rec.periodEndMs = NEXT_END; delete rec.paidPeriodEndMs; delete rec.unpaidPeriodEndMs;
  c.h.hub.billing.store.putRoleSubscription(rec);
  c.set(SUB_UPDATED); await c.tick();
  assert.equal(c.instance(s).paidThroughMs, NEXT_END, "0.4.110's free-month row");
  const failed = c.host(s); failed.subscriptionStatus = "past_due"; c.h.hub.billing.store.putRoleSubscription(failed);
  c.set(PAYMENT_FAILED); await c.tick();
  const row = c.instance(s);
  assert.equal(row.stage, "past_due"); assert.equal(row.cancellationReason, "renewal_unpaid");
  assert.equal(row.suspendAtMs, NEXT_END + graceHours(c) * HOUR, "suspend scheduled in December");
  if (paidLate) {
    const paid = c.host(s); paid.subscriptionStatus = "active"; c.h.hub.billing.store.putRoleSubscription(paid); // 0.4.110's late invoice.paid
    await c.tick();
    assert.equal(c.instance(s).stage, "past_due", "the defect: equality advanced nothing and cleared nothing");
  }
  return row;
}

await test("a pre-0.4.111 row (period end == paid-through) is NOT cleared by status alone, but the 0.4.111 paid-evidence record of a paid invoice clears it to ready with no email", async () => {
  const c = await setup();
  try {
    const s = await paidAndRunning(c);
    await legacyGroupB(c, s);
    for (let i = 0; i < 3; i++) { c.advance(30_000); await c.tick(); }
    assert.equal(c.instance(s).stage, "past_due", "absent paid-evidence fields prove nothing; the tick never clears on equality");
    // The live 0.4.111 path: a paid invoice for the renewal arrives (e.g. a retry).
    const emailsBefore = c.h.hub.hosting.store.outboxFor(c.instance(s).id).filter(j => j.jobType === "email").length;
    c.advance(HOUR);
    assert.equal((await c.post("invoice.paid", c.invoice(s, { id: "in_renew_" + s.id, startMs: PERIOD_END, endMs: NEXT_END, reason: "subscription_cycle", created: c.now() }), c.now())).body.outcome, "applied");
    assert.equal(c.host(s).paidPeriodEndMs, NEXT_END);
    await c.tick();
    const row = c.instance(s);
    assert.equal(row.stage, "ready"); assert.equal(row.cancellationReason, null); assert.equal(row.suspendAtMs, null); assert.equal(row.deleteAtMs, null);
    assert.equal(row.paidThroughMs, NEXT_END);
    assert.equal(c.pendingEnd(s).filter(j => j.jobType !== "email").length, 0, "suspend/delete obsoleted");
    assert.equal(c.h.hub.hosting.store.outboxFor(row.id).filter(j => j.jobType === "email").length, emailsBefore, "no new customer email is queued");
    assert.ok(c.h.hub.billing.store.recentEvents(50).some(e => e.type === "billing.hosting.nonpayment-settled"), "audited");
  } finally { await c.h.close(); }
});

await test("billing repair: dry run classifies a paid legacy row CLEAR_PAID and writes nothing; apply returns it to ready, writes the paid term onto the role record, obsoletes the end jobs, audits, and re-runs as NO_CHANGE", async () => {
  const c = await setup();
  try {
    const s = await paidAndRunning(c);
    await legacyGroupB(c, s);
    c.stripeState.subscription = c.subscriptionObject(s, { current_period_end: Math.floor(NEXT_END / 1000) });
    c.stripeState.invoices = [
      c.invoice(s, { id: "in_renew_" + s.id, startMs: PERIOD_END, endMs: NEXT_END, reason: "subscription_cycle", created: PAYMENT_FAILED + DAY }),
      c.invoice(s),
    ];
    const files = ["hosting-db.v1.json", "billing-role-subscriptions.v1.json", "billing-events.v1.jsonl"].map(f => path.join(c.h.dataDir, f));
    const before = files.map(fileHash);
    const dry = await c.admin("/admin/api/hosting/billing-repair", {});
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.dryRun, true);
    const r = dry.body.rows.find(x => x.instanceId === c.instance(s).id);
    assert.equal(r.action, "CLEAR_PAID", JSON.stringify(r));
    assert.equal(r.stripe.paidPeriodEndMs, NEXT_END);
    assert.deepEqual(r.stripe.paidInvoiceIds.sort(), ["in_" + s.id, "in_renew_" + s.id].sort());
    assert.equal(r.after.stage, "ready"); assert.equal(r.after.suspendAtMs, null);
    assert.deepEqual(files.map(fileHash), before, "a dry run writes nothing");
    assert.equal(c.stripeWrites.length, 0, "GET only");
    // An apply needs every guard.
    assert.equal((await c.admin("/admin/api/hosting/billing-repair", { dryRun: false, by: "op", reason: "x", instanceIds: [r.instanceId] })).status, 400, "confirm required");
    assert.equal((await c.admin("/admin/api/hosting/billing-repair", { dryRun: false, by: "op", reason: "x", confirm: "APPLY HOSTING BILLING REPAIR" })).status, 400, "explicit ids required");
    const versionBefore = c.instance(s).lifecycleVersion;
    const applied = await c.admin("/admin/api/hosting/billing-repair", { dryRun: false, by: "op", reason: "group B repair", instanceIds: [r.instanceId], confirm: "APPLY HOSTING BILLING REPAIR" });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.deepEqual(applied.body.applied, [r.instanceId]);
    const row = c.instance(s);
    assert.equal(row.stage, "ready"); assert.equal(row.cancellationReason, null); assert.equal(row.suspendAtMs, null); assert.equal(row.deleteAtMs, null);
    assert.ok(row.lifecycleVersion > versionBefore);
    assert.equal(c.pendingEnd(s).length, 0, "every pending suspend/delete/reminder is obsolete");
    const rec = c.host(s);
    assert.equal(rec.subscriptionStatus, "active"); assert.equal(rec.paidPeriodEndMs, NEXT_END); assert.equal(rec.periodEndMs, NEXT_END);
    const audit = c.h.hub.billing.store.recentEvents(50).filter(e => e.type === "admin.hosting.billing-repair");
    assert.equal(audit.length, 1); const note = JSON.parse(audit[0].note);
    assert.equal(note.by, "op"); assert.equal(note.before.stage, "past_due"); assert.equal(note.after.stage, "ready");
    for (let i = 0; i < 3; i++) { c.advance(30_000); await c.tick(); }
    assert.equal(c.instance(s).stage, "ready", "later ticks keep it ready");
    const again = await c.admin("/admin/api/hosting/billing-repair", {});
    assert.equal(again.body.rows.find(x => x.instanceId === r.instanceId).action, "NO_CHANGE");
    assert.equal(c.stripeWrites.length, 0, "the repair never writes to Stripe");
  } finally { await c.h.close(); }
});

await test("billing repair: an unpaid legacy row (group A) is CORRECT_PAID_THROUGH with the earlier suspend date reported, and an apply naming it changes nothing", async () => {
  const c = await setup();
  try {
    const s = await paidAndRunning(c);
    const row = await legacyGroupB(c, s, { paidLate: false });
    c.stripeState.subscription = c.subscriptionObject(s, { status: "past_due", cancel_at_period_end: true, current_period_end: Math.floor(NEXT_END / 1000) });
    c.stripeState.invoices = [
      c.invoice(s, { id: "in_renew_" + s.id, startMs: PERIOD_END, endMs: NEXT_END, paid: false, reason: "subscription_cycle", created: PAYMENT_FAILED }),
      c.invoice(s),
    ];
    const dry = await c.admin("/admin/api/hosting/billing-repair", { instanceIds: [row.id] });
    const r = dry.body.rows[0];
    assert.equal(r.action, "CORRECT_PAID_THROUGH", JSON.stringify(r));
    assert.equal(r.paidThroughMs, NEXT_END); assert.equal(r.after.paidThroughMs, PERIOD_END);
    assert.equal(r.suspendAtMs, NEXT_END + graceHours(c) * HOUR);
    assert.equal(r.after.suspendAtMs, PERIOD_END + graceHours(c) * HOUR, "the decision item: suspend moves a month earlier");
    assert.match(r.note, /Decision item/);
    const before = JSON.stringify(c.instance(s));
    const applied = await c.admin("/admin/api/hosting/billing-repair", { dryRun: false, by: "op", reason: "x", instanceIds: [row.id], confirm: "APPLY HOSTING BILLING REPAIR" });
    assert.equal(applied.status, 200); assert.deepEqual(applied.body.applied, []);
    assert.equal(JSON.stringify(c.instance(s)), before, "an unpaid row is never changed by this route");
  } finally { await c.h.close(); }
});

// ── 3. lease seat of a replaced generation ─────────────────────────────────

function installKey() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return { privateKey: pair.privateKey, publicKey: der.subarray(der.length - 32).toString("base64url") };
}
const proof = (challenge, privateKey) => sign(null, Buffer.from(challenge.proofBytesB64u, "base64url"), privateKey).toString("base64url");
function activate(leases, token, key, installId) {
  const ch = leases.challenge(token, { purpose: "activate", installId, installPublicKey: key.publicKey });
  return leases.activate(token, ch.nonce, proof(ch, key.privateKey));
}

await test("lease ledger: a hosting release frees the seat without the admin recovery lock, survives a fresh replay, is idempotent, and activation refusals are visible", () => {
  const { store, dataDir } = freshStore();
  const issued = store.issue("Hosted", 30, 1_700_000_000_000);
  let now = 1_700_000_001_000, ids = 0;
  const lines = [];
  const mk = () => new LicenseLeaseService(dataDir, store, { defaultMaxMachines: 1, leaseDurationMs: HOUR }, { now: () => now, monotonicNow: () => now - 1_700_000_001_000, randomId: () => `id-${++ids}`, log: l => lines.push(l) });
  const leases = mk();
  const oldKey = installKey(), newKey = installKey();
  const first = activate(leases, issued.token, oldKey, "install-old");
  assert.throws(() => activate(leases, issued.token, newKey, "install-new"), /machine limit reached \(1\/1\)/);
  assert.throws(() => activate(leases, issued.token, newKey, "install-new"), /machine limit reached/);
  const refusals = leases.adminSnapshot(issued.payload.id).activationRefusals;
  assert.equal(refusals.length, 1); assert.equal(refusals[0].installId, "install-new"); assert.equal(refusals[0].count, 2);
  assert.match(refusals[0].reason, /machine limit reached/);
  assert.equal(lines.filter(l => l.includes("activation refused")).length, 1, "one journal line per (licence, install, reason) per hour");
  assert.ok(!lines.some(l => l.includes(issued.token)), "never the bearer");
  const released = leases.releaseRetiredHostingMachine(issued.payload.id, "install-old", "hosting region replacement: test");
  assert.equal(released.length, 1); assert.equal(released[0].id, first.activation.id); assert.equal(released[0].status, "deactivated");
  assert.deepEqual(leases.releaseRetiredHostingMachine(issued.payload.id, "install-old", "again"), [], "idempotent");
  const snap = leases.adminSnapshot(issued.payload.id);
  assert.deepEqual(snap.recoveryLockedLicenses, [], "no admin recovery lock");
  const ev = snap.audit.find(e => e.kind === "activation_deactivated");
  assert.equal(ev.actor, "hosting"); assert.equal(ev.nonceHash, null);
  now += 60_000;
  const replay = mk();
  assert.equal(replay.adminSnapshot(issued.payload.id).activations.find(a => a.id === first.activation.id).status, "deactivated", "a fresh service replays the hosting release");
  const fresh = activate(replay, issued.token, newKey, "install-new");
  assert.equal(fresh.activation.installId, "install-new", "the replacement install activates");
});

await test("a region replacement releases the destroyed server's activation (identified by the licence's check-in from its address) and the replacement install activates; a check-in from elsewhere releases nothing", async () => {
  for (const sameAddress of [true, false]) {
    const c = await setup();
    try {
      const s = await paidAndRunning(c);
      // Back to a bootstrapping generation-1 server that has ALREADY activated
      // the single seat, then the venue probe refuses it (2026-10-05).
      let row = c.instance(s);
      const licenseId = c.sw(s).licenseId;
      const lic = { token: c.h.store.tokenFor(licenseId) };
      assert.ok(lic.token, "fixture licence token");
      assert.ok(row.ip, "the provider gave the server an address");
      const oldKey = installKey(), newKey = installKey();
      const leases = c.h.hub.licenseLeases;
      const first = activate(leases, lic.token, oldKey, "install-gen1");
      recordCheckin(c.h.dataDir, { licenseId, installId: "install-gen1", version: "0.91.46", ts: c.now() }, sameAddress ? row.ip : "203.0.113.77", c.now());
      c.h.hub.hosting.store.updateInstance(row.id, row.version, (d) => { d.stage = "bootstrapping"; }, c.now());
      row = c.instance(s);
      c.h.hub.hosting.store.enqueue({ hostingInstanceId: row.id, lifecycleVersion: row.lifecycleVersion, generation: row.generation, jobType: "readiness_recheck", dedupeKey: `replace-region:${row.id}:test`, availableAtMs: c.now(), payload: { kind: "replace-region", nextRegionId: "itm", refusals: ["Bybit 403"] } }, c.now());
      const gen = row.generation, oldIp = row.ip;
      await c.tick();
      row = c.instance(s);
      assert.equal(row.generation, gen + 1, "replaced into a new generation");
      assert.equal(row.region, "itm");
      const act = leases.adminSnapshot(licenseId).activations.find(a => a.id === first.activation.id);
      if (sameAddress) {
        assert.equal(act.status, "deactivated", "the destroyed server's seat is released");
        assert.match(act.deactivationReason, new RegExp(`${row.id} generation ${gen} at ${oldIp.replace(/\./g, "\\.")}`));
        assert.deepEqual(leases.adminSnapshot(licenseId).recoveryLockedLicenses, []);
        assert.ok(c.logs.some(l => l.includes(`released lease activation ${first.activation.id}`)), c.logs.join("\n"));
        assert.equal(activate(leases, lic.token, newKey, "install-gen2").activation.installId, "install-gen2", "the replacement install activates");
      } else {
        assert.equal(act.status, "active", "an install that last checked in from another address is never released");
        assert.ok(c.logs.some(l => l.includes("no lease activation released") && l.includes("from another address")), c.logs.join("\n"));
      }
    } finally { await c.h.close(); }
  }
});

summary("hosting-paid-evidence-0411");
