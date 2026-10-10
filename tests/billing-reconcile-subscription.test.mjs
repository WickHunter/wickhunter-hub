// tests/billing-reconcile-subscription.test.mjs — the operator's "reconcile
// subscription from Stripe" (Hub 0.4.94): BillingService.reconcileSubscriptionFromStripe
// behind POST /admin/api/billing/reconcile-subscription, and the bulk driver
// scripts/reconcile-bootstrap-only.mjs.
//
// The record shapes are the two the 2026-10-10 production audit found on a
// bootstrap-only grant (periodEndMs null, lastEventType checkout.session.*):
//   - hosted: a mixed v2 software+VPS checkout on 10-06 whose initial paid
//     invoice the Hub discarded under 0.4.90, the licence expiry since
//     repaired by hand to Stripe's period end + 3 days;
//   - launch cohort: a software-only launch subscription anchored to the
//     first charge on 2026-10-15T04:00Z, Stripe active with only a $0 anchor
//     invoice, licence 10-18T04:00Z.
// Every Stripe object is an offline fixture (Stripe-Version 2025-03-31.basil
// shapes for what the reconcile reads); no network leaves 127.0.0.1.
// Identifiers are fixture values, never a customer's.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { freshHub, jsonReq, tmpDir, test, summary } from "./helpers.mjs";
import { FakeProvider } from "../dist/src/hosting/provider.js";
import { signStripePayload } from "../dist/src/billing/stripe.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BULK = path.join(ROOT, "scripts", "reconcile-bootstrap-only.mjs");
const SECRET = "whsec_reconcile_offline_fixture";
const TOKEN = "test-admin-token";
const DAY = 86_400_000;
const GRACE_DAYS = 3, BOOTSTRAP_DAYS = 3; // the live box's policy
const SUB_CREATED = Date.parse("2026-10-06T03:39:55Z");
const CHECKOUT_COMPLETED = Date.parse("2026-10-06T03:39:59Z");
const INVOICE_PAID = CHECKOUT_COMPLETED - 1000; // Stripe pays the first invoice, THEN completes the session
const PERIOD_END = Date.parse("2026-11-06T03:39:55Z");
const PAID_TERM_EXP = PERIOD_END + GRACE_DAYS * DAY; // 2026-11-09T03:39:55Z
const BOOTSTRAP_EXP = CHECKOUT_COMPLETED + BOOTSTRAP_DAYS * DAY;
const RECONCILE_AT = Date.parse("2026-10-10T05:00:00Z");
const LAUNCH_ANCHOR = Date.parse("2026-10-15T04:00:00Z");
const LAUNCH_EXP = LAUNCH_ANCHOR + GRACE_DAYS * DAY; // 2026-10-18T04:00Z
const SOFTWARE_CENTS = 9900, SOFTWARE_DISCOUNT_CENTS = 3960, VPS_CENTS = 2000;
const sec = (ms) => Math.floor(ms / 1000);

function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = createHash("sha256").update(fs.readFileSync(f)).digest("hex") + ":" + fs.statSync(f).mtimeMs; } };
  walk(dir); return out;
}
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function setup() {
  let clock = CHECKOUT_COMPLETED - 60_000, n = 0;
  const sessions = new Map(), calls = [];
  // Stripe's side of the world, as the reconcile reads it.
  const stripeSubs = new Map(), stripeInvoices = new Map(), failing = new Set();
  const fake = async (input, init = {}) => {
    const url = new URL(input), p = url.pathname, method = init.method ?? "GET", params = new URLSearchParams(init.body ?? "");
    calls.push({ p, method, query: Object.fromEntries(url.searchParams) });
    const json = (out, status = 200) => ({ ok: status < 400, status, json: async () => out, text: async () => JSON.stringify(out) });
    if (failing.has(p)) return json({ error: { code: "api_error" } }, 500);
    let out;
    if (p === "/v1/subscriptions" && method === "GET") {
      const customer = url.searchParams.get("customer");
      out = { object: "list", has_more: false, data: [...stripeSubs.values()].filter((s) => s.customer === customer) };
    } else if (p.startsWith("/v1/subscriptions/") && method === "GET") {
      out = stripeSubs.get(p.split("/").at(-1));
      if (!out) return json({ error: { code: "resource_missing" } }, 404);
    } else if (p.startsWith("/v1/subscriptions/") && method === "POST") {
      out = { id: p.split("/").at(-1), object: "subscription", cancel_at_period_end: params.get("cancel_at_period_end") === "true" };
    } else if (p === "/v1/invoices" && method === "GET") {
      out = { object: "list", has_more: false, data: stripeInvoices.get(url.searchParams.get("subscription")) ?? [] };
    } else if (p.startsWith("/v1/prices/")) {
      const id = p.split("/").at(-1), host = id.startsWith("price_host"), annual = id === "price_yearly" || id === "price_hostyear", life = id === "price_lifetime";
      out = { id, active: true, livemode: true, type: life ? "one_time" : "recurring", currency: "usd", unit_amount: host ? (annual ? 24000 : VPS_CENTS) : life ? 99900 : annual ? 69900 : SOFTWARE_CENTS, product: host ? "prod_vps" : "prod_software", recurring: life ? null : { interval: annual ? "year" : "month", interval_count: 1 } };
    } else if (p === "/v1/account") out = { capabilities: { crypto_payments: "active" } };
    else if (p === "/v1/checkout/sessions" && method === "POST") {
      const key = init.headers["Idempotency-Key"]; out = sessions.get(key);
      if (!out) {
        const id = `cs_rec${++n}`, meta = Object.fromEntries([...params].filter(([k]) => /^metadata\[/.test(k)).map(([k, v]) => [k.slice(9, -1), v]));
        const lines = [0, 1].map((i) => params.get(`line_items[${i}][price]`)).filter(Boolean).map((pid) => {
          const host = pid.startsWith("price_host");
          return { quantity: 1, price: { id: pid, product: host ? "prod_vps" : "prod_software" }, amount_subtotal: host ? VPS_CENTS : SOFTWARE_CENTS, amount_discount: 0 };
        });
        out = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get("mode"), metadata: meta, client_reference_id: params.get("client_reference_id"), livemode: true, status: "open", payment_status: "unpaid", subscription: null, payment_intent: null, lines };
        sessions.set(key, out);
      }
    } else if (p.startsWith("/v1/checkout/sessions/") && method === "GET") {
      const parts = p.split("/"), session = [...sessions.values()].find((s) => s.id === parts[4]); assert(session, "known fixture session");
      out = parts[5] === "line_items" ? { data: session.lines, has_more: false } : session;
    } else throw Error("Unexpected outbound fixture request " + method + " " + p);
    return json(out);
  };
  const logs = [];
  const h = await freshHub({}, { billingNow: () => clock, hostingNow: () => clock, launchFetch: fake, hostingFetch: fake,
    billingFetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "mail_fixture" }) }),
    hostingProvider: new FakeProvider({ now: () => clock }) });
  h.hub.hosting.stop(); // the hosting lifecycle is not under test; its timer must not write mid-proof
  h.hub.billing.log = (line) => logs.push(line);
  const admin = (p, body, headers = {}) => jsonReq(h.origin + p, { method: "POST", headers: { "x-hub-admin": TOKEN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const configured = await admin("/admin/api/billing/config", {
    mode: "live",
    policy: { graceDays: GRACE_DAYS, bootstrapDays: BOOTSTRAP_DAYS },
    plans: [...h.hub.billing.config().plans, { key: "hosting-monthly", name: "Hosting", amountCents: VPS_CENTS, currency: "usd", interval: "month", role: "hosting" }],
    stripe: { live: { secretKey: "sk_live_offline_only", webhookSecret: SECRET, priceIds: { monthly: "price_monthly", yearly: "price_yearly", lifetime: "price_lifetime", "hosting-monthly": "price_hostold" } } },
    roles: { live: { hosting: { priceIds: ["price_hostold"] }, software: { priceIds: ["price_monthly", "price_yearly", "price_lifetime"], productIds: ["prod_software"] } } },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal((await admin("/admin/api/hosting/policy", { policy: { provisioningEnabled: true, monthlyPriceCents: VPS_CENTS, osId: "2284", releaseRef: "b".repeat(64), maximumProjectedMonthlyProviderCostCents: 1_000_000 } })).status, 200);
  assert.equal((await admin("/admin/api/billing/hosted-offer", { monthlyPriceId: "price_hostmonth", yearlyPriceId: "price_hostyear" })).status, 200);
  assert.equal((await admin("/admin/api/billing/launch", { action: "prepare" })).status, 200);
  await admin("/admin/api/billing/launch", { enabled: true, cryptoEnabled: true });

  const key = (s) => "cus_" + s.id, sub = (s) => "sub_" + s.id;
  const post = async (type, object, created = clock) => {
    const id = "evt_" + randomUUID();
    const body = JSON.stringify({ id, object: "event", type, livemode: true, created: sec(created), data: { object } });
    return jsonReq(h.origin + "/api/billing/stripe/live", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, SECRET, sec(clock)) }, body });
  };
  const settle = async () => { await new Promise((r) => setTimeout(r, 20)); await h.hub.billing.drainAfterCommit(); await new Promise((r) => setTimeout(r, 20)); };
  /** basil-shaped Stripe subscription (period end on the items). */
  const stripeSubscription = (s, over = {}) => ({ id: sub(s), object: "subscription", livemode: true, customer: key(s), status: "active", cancel_at_period_end: false, metadata: s.metadata,
    items: { object: "list", has_more: false, data: s.lines.map((l) => ({ price: l.price, quantity: 1, current_period_start: sec(over.periodStart ?? SUB_CREATED), current_period_end: sec(over.periodEnd ?? PERIOD_END) })) }, ...over });
  /** basil-shaped paid invoice: subscription under `parent`, prices under `pricing`, discounts as pretax credits. */
  const basilInvoice = (s, over = {}) => {
    const { periodStart = SUB_CREATED, periodEnd = PERIOD_END, ...rest } = over;
    const lines = s.lines.map((l, i) => {
      const host = l.price.id.startsWith("price_host"), amount = s.launch ? 0 : l.amount_subtotal;
      return { id: `il_${s.id}_${i}`, object: "line_item", amount, pricing: { type: "price_details", price_details: { price: l.price.id, product: l.price.product } },
        pretax_credit_amounts: host || s.launch ? [] : [{ type: "discount", amount: SOFTWARE_DISCOUNT_CENTS, discount: "di_fixture" }], taxes: [], quantity: 1, period: { start: sec(periodStart), end: sec(periodEnd) } };
    });
    const paid = s.launch ? 0 : SOFTWARE_CENTS - SOFTWARE_DISCOUNT_CENTS + VPS_CENTS;
    return { id: "in_" + s.id, object: "invoice", livemode: true, status: "paid", created: sec(INVOICE_PAID), amount_paid: paid, currency: "usd", customer: key(s), customer_email: s.id + "@example.test",
      billing_reason: "subscription_create", parent: { type: "subscription_details", subscription_details: { subscription: sub(s), metadata: s.metadata } },
      status_transitions: { paid_at: sec(INVOICE_PAID) }, lines: { object: "list", has_more: false, data: lines }, ...rest };
  };
  /** A hosted v2 checkout whose initial invoice never reached the record (the
   *  0.4.90 discard), with Stripe's subscription and paid invoice on file. */
  const hosted = async ({ repairExp } = {}) => {
    clock = CHECKOUT_COMPLETED - 60_000;
    const started = await jsonReq(h.origin + "/api/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", payment: "card", hosting: true, attemptId: randomUUID() }) });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const s = [...sessions.values()].at(-1); s.lines[0].amount_discount = SOFTWARE_DISCOUNT_CENTS;
    stripeSubs.set(sub(s), stripeSubscription(s));
    stripeInvoices.set(sub(s), [basilInvoice(s)]);
    clock = CHECKOUT_COMPLETED;
    const completed = { id: s.id, mode: "subscription", payment_status: "paid", customer: key(s), customer_details: { email: s.id + "@example.test" }, subscription: sub(s), metadata: s.metadata,
      amount_subtotal: SOFTWARE_CENTS + VPS_CENTS, total_details: { amount_discount: SOFTWARE_DISCOUNT_CENTS }, amount_total: SOFTWARE_CENTS - SOFTWARE_DISCOUNT_CENTS + VPS_CENTS };
    const r = await post("checkout.session.completed", completed, CHECKOUT_COMPLETED);
    assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
    clock = RECONCILE_AT - 3_600_000;
    const rec = h.hub.billing.store.getCustomer(key(s));
    if (repairExp) {
      const fixed = await admin("/admin/api/licenses/expiry", { id: rec.licenseId, exp: repairExp, by: "op", reason: "hand repair of a discarded initial invoice" });
      assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    }
    clock = RECONCILE_AT;
    await settle();
    return s;
  };
  /** A software-only launch subscription anchored to the 10-15 first charge. */
  const launch = async ({ repairExp = LAUNCH_EXP, zeroInvoice = true } = {}) => {
    clock = CHECKOUT_COMPLETED - 60_000;
    const started = await jsonReq(h.origin + "/api/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", payment: "card", attemptId: randomUUID() }) });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const s = [...sessions.values()].at(-1); s.launch = true;
    stripeSubs.set(sub(s), stripeSubscription(s, { periodStart: CHECKOUT_COMPLETED, periodEnd: LAUNCH_ANCHOR }));
    stripeInvoices.set(sub(s), zeroInvoice ? [basilInvoice(s, { periodStart: CHECKOUT_COMPLETED, periodEnd: LAUNCH_ANCHOR, created: sec(CHECKOUT_COMPLETED), status_transitions: { paid_at: sec(CHECKOUT_COMPLETED) } })] : []);
    clock = CHECKOUT_COMPLETED;
    const r = await post("checkout.session.completed", { id: s.id, mode: "subscription", payment_status: "no_payment_required", customer: key(s), customer_details: { email: s.id + "@example.test" }, subscription: sub(s), metadata: s.metadata, amount_subtotal: 0, amount_total: 0 }, CHECKOUT_COMPLETED);
    assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
    const rec = h.hub.billing.store.getCustomer(key(s));
    assert.equal(h.store.get(rec.licenseId).exp, LAUNCH_ANCHOR, "the launch grant runs to the first charge");
    clock = RECONCILE_AT - 3_600_000;
    if (repairExp) assert.equal((await admin("/admin/api/licenses/expiry", { id: rec.licenseId, exp: repairExp })).status, 200);
    clock = RECONCILE_AT;
    await settle();
    return s;
  };
  const reconcile = (body) => admin("/admin/api/billing/reconcile-subscription", body);
  const customer = (s) => h.hub.billing.store.getCustomer(key(s));
  const exp = (s) => h.store.get(customer(s).licenseId)?.exp ?? null;
  const audit = (type) => h.hub.billing.store.recentEvents(500).filter((e) => e.type === type).map((e) => ({ ...e, note: JSON.parse(e.note) }));
  const stripeReads = (id) => calls.filter((c) => c.p.includes(id) || Object.values(c.query).includes(id));
  return { h, calls, logs, post, stripeSubs, stripeInvoices, failing, admin, reconcile, hosted, launch, customer, exp, audit, key, sub, settle, stripeSubscription, basilInvoice, stripeReads, set: (ms) => { clock = ms; } };
}

await test("the nine-hosted shape (initial invoice discarded, exp already repaired by hand to period end + grace): the dry run reports the exact diff with exp unchanged and writes nothing; the apply fills the paid term through the invoice.paid code path, leaves exp, hosting and the cancellation flag alone, and audits; a repeat is a no-op", async () => {
  const c = await setup();
  try {
    const s = await c.hosted({ repairExp: PAID_TERM_EXP });
    const before = c.customer(s);
    assert.equal(before.periodEndMs, null); assert.equal(before.lastEventType, "checkout.session.completed");
    assert.equal(before.firstActualPaymentAtMs, CHECKOUT_COMPLETED, "checkout recorded the payment instant from its own event");
    assert.equal(c.exp(s), PAID_TERM_EXP, "the hand repair already set the paid term's expiry");
    const hostingRoleBefore = c.h.hub.billing.store.getRoleSubscription(c.key(s), "hosting");
    assert.equal(hostingRoleBefore.periodEndMs, null);

    // Dry run (the default: no dryRun field at all).
    const files = snapshot(c.h.dataDir);
    const callsBefore = c.calls.length;
    const dry = await c.reconcile({ subscriptionId: c.sub(s) });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.verdict, "WOULD_APPLY"); assert.equal(dry.body.dryRun, true); assert.equal(dry.body.changed, true); assert.equal(dry.body.wrote, false); assert.equal(dry.body.needsReview, false);
    assert.deepEqual(dry.body.stripe, { status: "active", cancelAtPeriodEnd: false, currentPeriodEndMs: PERIOD_END, activeSubscriptionCount: 1,
      latestInvoice: { id: "in_" + s.id, status: "paid", billingReason: "subscription_create" },
      paidInvoice: { id: "in_" + s.id, billingReason: "subscription_create", amountPaid: 7940, currency: "usd", periodStartMs: SUB_CREATED, periodEndMs: PERIOD_END, paidAtMs: INVOICE_PAID } });
    assert.deepEqual(dry.body.changes, {
      periodEndMs: { before: null, after: PERIOD_END, changed: true },
      paidThroughMs: { before: null, after: PAID_TERM_EXP, changed: true },
      firstActualPaymentAtMs: { before: CHECKOUT_COMPLETED, after: INVOICE_PAID, changed: true },
      licenseExp: { before: PAID_TERM_EXP, after: PAID_TERM_EXP, changed: false },
      subscriptionStatus: { before: "active", after: "active", changed: false },
      discountPercent: { before: 40, after: 40, changed: false },
      lastEventType: { before: "checkout.session.completed", after: "admin.billing.reconcile-subscription", changed: true },
    });
    assert.match(dry.body.note, /licence exp 2026-11-09T03:39:55\.000Z unchanged/);
    assert.deepEqual(dry.body.hosting, { status: "active", periodEndMs: null }, "the hosting role is reported, read-only");
    assert.deepEqual(snapshot(c.h.dataDir), files, "the dry run wrote nothing: every data file's sha256 and mtime are unchanged");
    const reads = c.calls.slice(callsBefore);
    assert.deepEqual(reads.map((x) => `${x.method} ${x.p}`), [`GET /v1/subscriptions/${c.sub(s)}`, "GET /v1/subscriptions", "GET /v1/invoices"], "three read-only Stripe calls, nothing else");
    assert.deepEqual(reads[1].query, { customer: c.key(s), status: "all", limit: "20" }); assert.equal(reads[2].query.subscription, c.sub(s));

    // Apply.
    const licensesSha = sha(path.join(c.h.dataDir, "licenses.json"));
    const hostingDbSha = sha(path.join(c.h.dataDir, "hosting-db.v1.json"));
    const roleSha = sha(path.join(c.h.dataDir, "billing-role-subscriptions.v1.json"));
    assert.equal((await c.reconcile({ subscriptionId: c.sub(s), dryRun: false })).status, 400, "an apply without by/reason is refused");
    const applied = await c.reconcile({ subscriptionId: c.sub(s), dryRun: false, by: "op", reason: "0.4.90 discarded initial invoice" });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.verdict, "APPLIED"); assert.equal(applied.body.wrote, true); assert.equal(applied.body.dryRun, false);
    assert.deepEqual(applied.body.changes, dry.body.changes, "the apply did exactly what the dry run said");
    const after = c.customer(s);
    assert.equal(after.periodEndMs, PERIOD_END); assert.equal(after.firstActualPaymentAtMs, INVOICE_PAID); assert.equal(after.subscriptionStatus, "active");
    assert.equal(after.cancelAtPeriodEnd ?? false, false); assert.equal(after.discountPercent, 40);
    assert.equal(after.lastEventType, "admin.billing.reconcile-subscription"); assert.equal(after.lastEventId, "reconcile:in_" + s.id); assert.equal(after.lastEventAtMs, RECONCILE_AT);
    assert.equal(c.exp(s), PAID_TERM_EXP, "exp unchanged");
    assert.equal(sha(path.join(c.h.dataDir, "licenses.json")), licensesSha, "an exp already at period end + grace is not rewritten");
    assert.equal(sha(path.join(c.h.dataDir, "hosting-db.v1.json")), hostingDbSha, "hosting lifecycle untouched");
    assert.equal(sha(path.join(c.h.dataDir, "billing-role-subscriptions.v1.json")), roleSha, "the hosting role record is not changed by this tool");
    assert.deepEqual([...new Set(c.calls.filter((x) => x.method !== "GET").map((x) => `${x.method} ${x.p}`))], ["POST /v1/checkout/sessions"], "no Stripe write anywhere but the fixture's own checkout creation");
    const rows = c.audit("admin.billing.reconcile-subscription");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, applied.body.auditEventId); assert.equal(rows[0].livemode, true); assert.equal(rows[0].outcome, "applied");
    assert.equal(rows[0].note.actor, "operator"); assert.equal(rows[0].note.by, "op"); assert.equal(rows[0].note.reason, "0.4.90 discarded initial invoice");
    assert.equal(rows[0].note.subscriptionId, c.sub(s)); assert.equal(rows[0].note.customerKey, c.key(s)); assert.equal(rows[0].note.invoiceId, "in_" + s.id); assert.equal(rows[0].note.amountPaid, 7940);
    assert.deepEqual(rows[0].note.before, { periodEndMs: null, paidThroughMs: null, firstActualPaymentAtMs: CHECKOUT_COMPLETED, licenseExp: PAID_TERM_EXP, subscriptionStatus: "active", discountPercent: 40, lastEventType: "checkout.session.completed" });
    assert.deepEqual(rows[0].note.after, { periodEndMs: PERIOD_END, paidThroughMs: PAID_TERM_EXP, firstActualPaymentAtMs: INVOICE_PAID, licenseExp: PAID_TERM_EXP, subscriptionStatus: "active", discountPercent: 40, lastEventType: "admin.billing.reconcile-subscription" });
    assert.ok(c.logs.some((l) => l.includes(`reconcile ${c.sub(s)}`) && l.includes("by op")));
    // The check-in reply now carries the paid term.
    assert.equal(c.h.hub.billing.subscriptionInfoFor(after.licenseId).currentPeriodEndMs, PERIOD_END);

    // Idempotent repeat: nothing new → nothing written, changed:false, no second audit row.
    const files2 = snapshot(c.h.dataDir);
    const again = await c.reconcile({ subscriptionId: c.sub(s), dryRun: false, by: "op", reason: "repeat" });
    assert.equal(again.status, 200); assert.equal(again.body.verdict, "NOTHING_TO_APPLY"); assert.equal(again.body.changed, false); assert.equal(again.body.wrote, false);
    assert.ok(Object.values(again.body.changes).every((f) => f.changed === false));
    assert.deepEqual(snapshot(c.h.dataDir), files2);
    assert.equal(c.audit("admin.billing.reconcile-subscription").length, 1);
    // The same answer by customer key.
    assert.equal((await c.reconcile({ customerId: c.key(s) })).body.verdict, "NOTHING_TO_APPLY");
  } finally { await c.h.close(); }
});

await test("exp is max(existing, period end + grace): a lapsed bootstrap grant is extended to the paid term; a longer hand-set exp is never shortened", async () => {
  const c = await setup();
  try {
    const lapsed = await c.hosted();
    assert.equal(c.exp(lapsed), BOOTSTRAP_EXP);
    const dry = await c.reconcile({ subscriptionId: c.sub(lapsed) });
    assert.deepEqual(dry.body.changes.licenseExp, { before: BOOTSTRAP_EXP, after: PAID_TERM_EXP, changed: true });
    const r = await c.reconcile({ subscriptionId: c.sub(lapsed), dryRun: false, by: "op", reason: "lapsed" });
    assert.equal(r.body.verdict, "APPLIED");
    assert.equal(c.exp(lapsed), PAID_TERM_EXP);
    assert.equal(c.customer(lapsed).periodEndMs, PERIOD_END);

    const longer = await c.hosted({ repairExp: PAID_TERM_EXP + 7 * DAY });
    const r2 = await c.reconcile({ subscriptionId: c.sub(longer), dryRun: false, by: "op", reason: "longer" });
    assert.equal(r2.body.verdict, "APPLIED");
    assert.deepEqual(r2.body.changes.licenseExp, { before: PAID_TERM_EXP + 7 * DAY, after: PAID_TERM_EXP + 7 * DAY, changed: false });
    assert.equal(c.exp(longer), PAID_TERM_EXP + 7 * DAY, "never shortened");
    assert.equal(c.customer(longer).periodEndMs, PERIOD_END);
  } finally { await c.h.close(); }
});

await test("the launch-cohort shape (Stripe active to 10-15T04:00Z, only a $0 anchor invoice — or none — and exp 10-18T04:00Z): needs operator review, 'no paid invoice yet', nothing written", async () => {
  const c = await setup();
  try {
    const s = await c.launch();
    assert.equal(c.customer(s).periodEndMs, null); assert.equal(c.exp(s), LAUNCH_EXP); assert.equal(c.customer(s).firstActualPaymentAtMs ?? null, null);
    const files = snapshot(c.h.dataDir);
    for (const dryRun of [true, false]) {
      const r = await c.reconcile({ subscriptionId: c.sub(s), dryRun, by: "op", reason: "launch" });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.verdict, "NO_PAID_INVOICE_YET"); assert.equal(r.body.needsReview, true); assert.equal(r.body.changed, false); assert.equal(r.body.wrote, false);
      assert.match(r.body.note, /^no paid invoice yet/); assert.match(r.body.note, /2026-10-15T04:00:00\.000Z/);
      assert.equal(r.body.stripe.status, "active"); assert.equal(r.body.stripe.currentPeriodEndMs, LAUNCH_ANCHOR);
      assert.equal(r.body.stripe.paidInvoice, null, "a $0 anchor invoice is not a paid term");
      assert.deepEqual(r.body.stripe.latestInvoice, { id: "in_" + s.id, status: "paid", billingReason: "subscription_create" });
    }
    assert.deepEqual(snapshot(c.h.dataDir), files);
    assert.equal(c.audit("admin.billing.reconcile-subscription").length, 0);
    const none = await c.launch({ zeroInvoice: false });
    const r = await c.reconcile({ subscriptionId: c.sub(none) });
    assert.equal(r.body.verdict, "NO_PAID_INVOICE_YET"); assert.equal(r.body.stripe.latestInvoice, null);
  } finally { await c.h.close(); }
});

await test("a record whose paid term is already applied — a resumed Hub-originated cancellation, or the customer's own cancel_at_period_end — is 'nothing to apply': no change, no audit row, the cancellation marker untouched", async () => {
  const c = await setup();
  try {
    // Resumed: the term arrived by webhook (here the 0.4.91 admission of the
    // late initial invoice, which the bundle path applies).
    const resumed = await c.hosted();
    c.set(RECONCILE_AT - 1000);
    const inv = c.basilInvoice(resumed);
    const webhookInvoice = { ...inv, subscription: c.sub(resumed), subscription_details: { metadata: resumed.metadata }, paid: true,
      lines: { has_more: false, data: resumed.lines.map((l) => ({ price: l.price, amount: l.amount_subtotal, discount_amounts: [{ amount: l.price.id.startsWith("price_host") ? 0 : SOFTWARE_DISCOUNT_CENTS }], taxes: [], quantity: 1, period: { start: sec(SUB_CREATED), end: sec(PERIOD_END) } })) } };
    const late = await c.post("invoice.paid", webhookInvoice, INVOICE_PAID);
    assert.equal(late.body.outcome, "applied", JSON.stringify(late.body));
    c.set(RECONCILE_AT); await c.settle();
    assert.equal(c.customer(resumed).periodEndMs, PERIOD_END);
    // Customer-initiated: Stripe active with cancel_at_period_end, the record mirrors it.
    const cancelling = await c.hosted({ repairExp: PAID_TERM_EXP });
    c.stripeSubs.set(c.sub(cancelling), c.stripeSubscription(cancelling, { cancel_at_period_end: true }));
    const rec = c.customer(cancelling);
    c.h.hub.billing.store.putCustomer({ ...rec, periodEndMs: PERIOD_END, subscriptionStatus: "active (cancels at period end)", cancelAtPeriodEnd: true, lastEventType: "customer.subscription.updated" });
    for (const s of [resumed, cancelling]) {
      const files = snapshot(c.h.dataDir);
      for (const dryRun of [true, false]) {
        const r = await c.reconcile({ subscriptionId: c.sub(s), dryRun, by: "op", reason: "check" });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.verdict, "NOTHING_TO_APPLY"); assert.equal(r.body.changed, false); assert.equal(r.body.needsReview, false);
        assert.match(r.body.note, /already recorded; nothing to apply/);
        assert.ok(Object.values(r.body.changes).every((f) => f.changed === false && f.before === f.after), JSON.stringify(r.body.changes));
      }
      assert.deepEqual(snapshot(c.h.dataDir), files);
    }
    assert.equal(c.customer(cancelling).subscriptionStatus, "active (cancels at period end)"); assert.equal(c.customer(cancelling).cancelAtPeriodEnd, true);
    assert.equal(c.audit("admin.billing.reconcile-subscription").length, 0, "no audit row for a no-op");
  } finally { await c.h.close(); }
});

await test("refusals, each by name, each writing nothing: not active (canceled before the first charge), latest invoice open / uncollectible / draft, two live subscriptions on the customer, a paid term that does not contain Stripe's current period end, disputed, refunded, revoked, identity mismatch, Lifetime", async () => {
  const c = await setup();
  try {
    const cases = [
      ["SUBSCRIPTION_NOT_ACTIVE", (s) => c.stripeSubs.set(c.sub(s), c.stripeSubscription(s, { status: "canceled" })), /canceled, not active or trialing/],
      ["LATEST_INVOICE_UNSETTLED", (s) => c.stripeInvoices.get(c.sub(s)).push(c.basilInvoice(s, { id: "in_open_" + s.id, status: "open", amount_paid: 0, billing_reason: "subscription_cycle", created: sec(RECONCILE_AT - 60_000), periodStart: PERIOD_END, periodEnd: PERIOD_END + 30 * DAY })), /in_open_.* is open \(subscription_cycle\), not paid/],
      ["LATEST_INVOICE_UNSETTLED", (s) => c.stripeInvoices.get(c.sub(s)).push(c.basilInvoice(s, { id: "in_bad_" + s.id, status: "uncollectible", amount_paid: 0, created: sec(RECONCILE_AT - 60_000) })), /is uncollectible/],
      ["LATEST_INVOICE_UNSETTLED", (s) => c.stripeInvoices.get(c.sub(s)).push(c.basilInvoice(s, { id: "in_draft_" + s.id, status: "draft", amount_paid: 0, created: sec(RECONCILE_AT - 60_000) })), /is draft/],
      ["MULTIPLE_ACTIVE_SUBSCRIPTIONS", (s) => c.stripeSubs.set("sub_second_" + s.id, { ...c.stripeSubscription(s), id: "sub_second_" + s.id }), /has 2 subscriptions that have not ended/],
      ["PERIOD_MISMATCH", (s) => c.stripeSubs.set(c.sub(s), c.stripeSubscription(s, { periodStart: PERIOD_END, periodEnd: PERIOD_END + 30 * DAY })), /does not contain Stripe's current period end 2026-12-06/],
      ["REFUNDED_OR_DISPUTED", (s) => c.h.hub.billing.store.putCustomer({ ...c.customer(s), disputed: true }), /disputed/],
      ["REFUNDED_OR_DISPUTED", (s) => { const r = c.h.hub.billing.store.getRoleSubscription(c.key(s), "hosting"); c.h.hub.billing.store.putRoleSubscription({ ...r, refunded: true }); }, /refunded/],
      ["LICENSE_REVOKED", (s) => c.h.store.revoke(c.customer(s).licenseId), /is revoked/],
      ["IDENTITY_MISMATCH", (s) => c.stripeSubs.set(c.sub(s), c.stripeSubscription(s, { customer: "cus_someone_else" })), /does not match this record/],
      ["LIFETIME_NOT_A_TERM", (s) => c.h.hub.billing.store.putCustomer({ ...c.customer(s), lifetimeAccess: true }), /one-time purchase/],
    ];
    for (const [verdict, mutate, note] of cases) {
      const s = await c.hosted({ repairExp: PAID_TERM_EXP });
      mutate(s);
      await c.settle();
      const files = snapshot(c.h.dataDir);
      for (const dryRun of [true, false]) {
        const r = await c.reconcile({ subscriptionId: c.sub(s), dryRun, by: "op", reason: "refusal" });
        assert.equal(r.status, 409, `${verdict}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.verdict, verdict); assert.equal(r.body.needsReview, true); assert.equal(r.body.changed, false); assert.equal(r.body.wrote, false);
        assert.match(r.body.note, note, verdict);
      }
      assert.deepEqual(snapshot(c.h.dataDir), files, `${verdict} wrote nothing`);
      assert.equal(c.customer(s).periodEndMs, null);
    }
    assert.equal(c.audit("admin.billing.reconcile-subscription").length, 0);
  } finally { await c.h.close(); }
});

await test("a Stripe read failure or a missing key writes nothing and names the error; bad requests, unknown subscriptions, customers without a subscription, and a missing admin token are answered by name", async () => {
  const c = await setup();
  try {
    const s = await c.hosted({ repairExp: PAID_TERM_EXP });
    for (const p of [`/v1/subscriptions/${c.sub(s)}`, "/v1/subscriptions", "/v1/invoices"]) {
      c.failing.clear(); c.failing.add(p);
      const files = snapshot(c.h.dataDir);
      const r = await c.reconcile({ subscriptionId: c.sub(s), dryRun: false, by: "op", reason: "read failure" });
      assert.equal(r.status, 502, JSON.stringify(r.body));
      assert.equal(r.body.verdict, "STRIPE_READ_FAILED"); assert.equal(r.body.wrote, false);
      assert.match(r.body.error, /Stripe read failed \(Stripe request failed \(500, api_error\)\); nothing was written/);
      assert.deepEqual(snapshot(c.h.dataDir), files, `a failed ${p} read wrote nothing`);
    }
    c.failing.clear();
    assert.equal(c.customer(s).periodEndMs, null);
    // Unknown subscription / malformed / no subscription / no token.
    assert.equal((await c.reconcile({ subscriptionId: "sub_unknown" })).status, 404);
    assert.equal((await c.reconcile({ subscriptionId: "not-a-sub" })).body.verdict, "INVALID_REQUEST");
    assert.equal((await c.reconcile({})).status, 400);
    const lifetime = { ...c.customer(s), key: "cus_lifetime_fixture", stripeCustomerId: "cus_lifetime_fixture", licenseId: "lic_lifetime_fixture", subscriptionId: null, lifetimeAccess: true, planKey: "lifetime" };
    c.h.hub.billing.store.putCustomer(lifetime);
    const skipped = await c.reconcile({ customerId: "cus_lifetime_fixture" });
    assert.equal(skipped.status, 200); assert.equal(skipped.body.verdict, "NO_SUBSCRIPTION"); assert.match(skipped.body.note, /no Stripe subscription is bound to this customer \(Lifetime\)/);
    assert.equal((await jsonReq(c.h.origin + "/admin/api/billing/reconcile-subscription", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscriptionId: c.sub(s) }) })).status, 401);
    // No secret key in this mode: nothing is read or written.
    const cfg = c.h.hub.billing.config();
    fs.writeFileSync(path.join(c.h.dataDir, "billing-config.v1.json"), JSON.stringify({ ...cfg, stripe: { ...cfg.stripe, live: { ...cfg.stripe.live, secretKey: "" } } }));
    const files = snapshot(c.h.dataDir);
    const reads = c.calls.length;
    const r = await c.reconcile({ subscriptionId: c.sub(s) });
    assert.equal(r.status, 503); assert.equal(r.body.verdict, "STRIPE_UNAVAILABLE");
    assert.equal(c.calls.length, reads, "no Stripe call without a key");
    assert.deepEqual(snapshot(c.h.dataDir), files);
  } finally { await c.h.close(); }
});

await test("an admin licence expiry edit now writes an admin.license.expiry row to the billing audit ledger (actor, by, reason, licence, customer, before/after)", async () => {
  const c = await setup();
  try {
    const s = await c.hosted({ repairExp: PAID_TERM_EXP });
    const rows = c.audit("admin.license.expiry");
    assert.equal(rows.length, 1);
    const lic = c.customer(s).licenseId;
    assert.deepEqual(rows[0].note, { actor: "operator", by: "op", reason: "hand repair of a discarded initial invoice", licenseId: lic, customerKey: c.key(s), before: { exp: BOOTSTRAP_EXP }, after: { exp: PAID_TERM_EXP } });
    assert.equal(rows[0].outcome, "applied"); assert.equal(rows[0].livemode, true);
    // The admin page's call (no by/reason) is audited too, with nulls.
    const r = await c.admin("/admin/api/licenses/expiry", { id: lic, exp: PAID_TERM_EXP + DAY });
    assert.equal(r.status, 200);
    const latest = c.audit("admin.license.expiry")[0];
    assert.deepEqual(latest.note, { actor: "operator", by: null, reason: null, licenseId: lic, customerKey: c.key(s), before: { exp: PAID_TERM_EXP }, after: { exp: PAID_TERM_EXP + DAY } });
    // A refused edit writes no row.
    assert.equal((await c.admin("/admin/api/licenses/expiry", { id: "no-such-licence", exp: PAID_TERM_EXP })).status, 404);
    assert.equal(c.audit("admin.license.expiry").length, 2);
  } finally { await c.h.close(); }
});

function runBulk(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BULK, ...args], { env: { ...process.env, HUB_ADMIN_TOKEN: TOKEN, ...env }, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr });
    });
  });
}

await test("the bulk script over a fixture audit JSON: dry run by default (nothing written), exclusions never read from Stripe, launch-cohort rows reported as 'needs operator review: no paid invoice yet', no-subscription rows skipped; --apply needs --by/--reason and then applies exactly the hosted rows", async () => {
  const c = await setup();
  try {
    const a = await c.hosted({ repairExp: PAID_TERM_EXP });
    const b = await c.hosted({ repairExp: PAID_TERM_EXP });
    const excluded = await c.hosted({ repairExp: PAID_TERM_EXP });
    const l = await c.launch();
    const auditFile = path.join(tmpDir("reconcile-audit"), "audit.json");
    const row = (s) => ({ customerKey: c.key(s), licenseId: c.customer(s).licenseId, subscriptionId: c.sub(s), verdict: "AT_RISK_UNTIL_PAID_PERIOD_APPLIED" });
    fs.writeFileSync(auditFile, JSON.stringify({ summary: { mode: "live" }, bootstrapOnly: [row(a), row(b), row(excluded), row(l), { customerKey: "cus_comp_fixture", licenseId: "lic_comp", subscriptionId: null }] }));
    const hub = ["--hub=" + c.h.origin];
    const files = snapshot(c.h.dataDir);
    const callsBefore = c.calls.length;
    const dry = await runBulk([...hub, "--from-audit=" + auditFile, "--exclude=" + c.key(excluded)]);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /DRY RUN \(nothing is written\)/);
    const lines = dry.stdout.split("\n");
    const lineFor = (s) => lines.find((x) => x.startsWith(c.key(s) + " "));
    assert.match(lineFor(a), new RegExp(`^${c.key(a)} ${c.sub(a)} → WOULD_APPLY \\| Stripe active current_period_end 2026-11-06T03:39:55\\.000Z; paid invoice in_${a.id} subscription_create 7940 usd period 2026-10-06T03:39:55\\.000Z→2026-11-06T03:39:55\\.000Z \\| periodEnd null→2026-11-06T03:39:55\\.000Z; paidThrough null→2026-11-09T03:39:55\\.000Z; firstActualPayment 2026-10-06T03:39:59\\.000Z→2026-10-06T03:39:58\\.000Z; exp 2026-11-09T03:39:55\\.000Z unchanged \\|`));
    assert.match(lineFor(l), /→ NEEDS OPERATOR REVIEW \(NO_PAID_INVOICE_YET\) \| Stripe active current_period_end 2026-10-15T04:00:00\.000Z; no paid invoice \(latest in_\S+ paid subscription_create\) \| no paid invoice yet/);
    assert.match(lineFor(excluded), /→ EXCLUDED \| on the --exclude list; not sent to the Hub, not read from Stripe/);
    assert.match(dry.stdout, /cus_comp_fixture - → NO_SUBSCRIPTION \| no Stripe subscription is bound/);
    assert.match(dry.stdout, /summary: 5 target\(s\); would apply 2; nothing to apply 0; needs operator review 1; excluded 1; skipped \(no subscription\) 1; errors 0/);
    assert.match(dry.stdout, new RegExp(`needs operator review:\\n  ${c.key(l)} ${c.sub(l)} NO_PAID_INVOICE_YET: no paid invoice yet`));
    assert.match(dry.stdout, /Dry run: nothing was written/);
    assert.deepEqual(snapshot(c.h.dataDir), files, "the bulk dry run wrote nothing");
    assert.equal(c.calls.slice(callsBefore).filter((x) => x.p.includes(c.sub(excluded)) || Object.values(x.query).includes(c.sub(excluded)) || Object.values(x.query).includes(c.key(excluded))).length, 0, "the excluded customer and subscription were never read from Stripe by the run");
    assert.ok(c.calls.slice(callsBefore).some((x) => x.p.includes(c.sub(a))), "the included ones were");

    const refused = await runBulk([...hub, "--from-audit=" + auditFile, "--apply"]);
    assert.equal(refused.status, 2); assert.match(refused.stderr, /--apply needs --by=<who> and --reason=<why>/);
    assert.deepEqual(snapshot(c.h.dataDir), files);

    const applied = await runBulk([...hub, "--from-audit=" + auditFile, "--exclude=" + c.key(excluded), "--apply", "--by=op", "--reason=bulk repair", "--json"]);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    const out = JSON.parse(applied.stdout);
    assert.equal(out.summary.mode, "apply"); assert.equal(out.summary.applied, 2); assert.equal(out.summary.errors.length, 0);
    assert.deepEqual(out.summary.needsOperatorReview.map((x) => [x.customerKey, x.verdict]), [[c.key(l), "NO_PAID_INVOICE_YET"]]);
    assert.deepEqual(out.summary.excluded, [c.key(excluded)]); assert.deepEqual(out.summary.skippedNoSubscription, ["cus_comp_fixture"]);
    const ra = out.rows.find((x) => x.customerKey === c.key(a));
    assert.equal(ra.verdict, "APPLIED"); assert.equal(ra.stripe.paidInvoice.amountPaid, 7940); assert.equal(ra.stripe.paidInvoice.currency, "usd");
    assert.deepEqual(ra.changes.licenseExp, { before: PAID_TERM_EXP, after: PAID_TERM_EXP, changed: false });
    for (const s of [a, b]) assert.equal(c.customer(s).periodEndMs, PERIOD_END);
    assert.equal(c.customer(excluded).periodEndMs, null, "the excluded customer is untouched");
    assert.equal(c.customer(l).periodEndMs, null, "the launch customer heals when its first paid invoice arrives, not here");
    assert.equal(c.audit("admin.billing.reconcile-subscription").length, 2);
    assert.ok(c.audit("admin.billing.reconcile-subscription").every((x) => x.note.by === "op" && x.note.reason === "bulk repair"));

    const repeat = await runBulk([...hub, "--from-audit=" + auditFile, "--exclude=" + c.key(excluded), "--apply", "--by=op", "--reason=bulk repair"]);
    assert.equal(repeat.status, 0);
    assert.match(repeat.stdout, /summary: 5 target\(s\); applied 0; nothing to apply 2; needs operator review 1; excluded 1; skipped \(no subscription\) 1; errors 0/);
    assert.equal(c.audit("admin.billing.reconcile-subscription").length, 2, "a repeat writes no new audit row");
    assert.ok(!applied.stdout.includes(TOKEN) && !dry.stdout.includes(TOKEN), "the admin token is never printed");
    // --all: every live billing customer; one without a subscription (Lifetime/complimentary) is skipped by name, not an error.
    c.h.hub.billing.store.putCustomer({ ...c.customer(a), key: "cus_life_fixture", stripeCustomerId: "cus_life_fixture", licenseId: "lic_life_fixture", subscriptionId: null, lifetimeAccess: true, planKey: "lifetime" });
    const all = await runBulk([...hub, "--all", "--exclude=" + c.key(excluded), "--json"]);
    assert.equal(all.status, 0, all.stderr);
    const allOut = JSON.parse(all.stdout);
    assert.deepEqual(Object.fromEntries(allOut.rows.map((x) => [x.customerKey, x.verdict])), { [c.key(a)]: "NOTHING_TO_APPLY", [c.key(b)]: "NOTHING_TO_APPLY", [c.key(excluded)]: "EXCLUDED", [c.key(l)]: "NO_PAID_INVOICE_YET", cus_life_fixture: "NO_SUBSCRIPTION" });
    assert.equal(allOut.summary.mode, "dry-run"); assert.deepEqual(allOut.summary.errors, []);
    const down = await runBulk(["--hub=http://127.0.0.1:9", "--subscriptions=" + c.sub(a)]);
    assert.equal(down.status, 1); assert.match(down.stdout, /HUB_UNREACHABLE/);
  } finally { await c.h.close(); }
});

summary("billing-reconcile-subscription");
