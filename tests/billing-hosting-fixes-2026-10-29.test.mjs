// tests/billing-hosting-fixes-2026-10-29.test.mjs — three production
// defects found on 2026-10-29, each replayed on a hermetic hub with offline
// fixtures (no network beyond 127.0.0.1, fixture identifiers only).
//
// 1. Basil/dahlia invoice lines carry `price: null` and name their price
//    under `pricing.price_details`. `invoiceFacts` read only `price`, so a
//    live invoice had no ids and its role came only from the role index. An
//    initial invoice delivered before its checkout.session.completed (the
//    index is written by the checkout) was recorded "unclassified", marked
//    seen and never applied: the licence stayed at the bootstrap grant.
// 2. An owner without an eligible software licence whose VPS already exists
//    returned before `applyBillingSignal`, so the hosting subscription's
//    own "cancels at period end" / "canceled" never scheduled suspend and
//    delete, and the refusal was logged on every 30-second tick.
// 3. `setStripeCancellation` treated Stripe's refusal to update an already
//    ended subscription as "not confirmed", so its billing_reconcile job
//    retried every minute forever.
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { FakeProvider, hashBootstrapToken } from "../dist/src/hosting/provider.js";
import { invoiceFacts, signStripePayload } from "../dist/src/billing/stripe.js";

const DAY = 86_400_000;
const WHSEC = "whsec_fixes_20261029_offline_fixture";
const GRACE_DAYS = 3, BOOTSTRAP_DAYS = 3;
const SW_PRICE = "price_sw_fixture", SW_PRODUCT = "prod_sw_fixture";
const HOST_PRICE = "price_host_fixture", HOST_PRODUCT = "prod_host_fixture";
const PUBLIC_HEALTH_OK = async () => ({ ok: true, status: 200, body: JSON.stringify({ ok: true, version: "0.90.135" }) });

/** A dahlia-shaped invoice line: `price` is null, ids under `pricing`. */
const dahliaLine = (price, product, subscription, endSec, startSec) => ({
  price: null,
  pricing: { type: "price_details", price_details: { price, product }, unit_amount_decimal: "9900" },
  parent: { type: "subscription_item_details", subscription_item_details: { subscription, subscription_item: "si_fixture", proration: false } },
  period: { start: startSec, end: endSec }, amount: 9900, metadata: {},
});
const dahliaInvoice = ({ id, customer, subscription, price, product, startSec, endSec, metadata = {} }) => ({
  id, object: "invoice", customer, customer_email: `${customer}@example.test`, customer_name: "Fixture", paid: true, status: "paid",
  amount_paid: 9900, billing_reason: "subscription_create", status_transitions: { paid_at: startSec },
  parent: { type: "subscription_details", subscription_details: { subscription, metadata } },
  lines: { data: [dahliaLine(price, product, subscription, endSec, startSec)], has_more: false },
});

await test("invoiceFacts reads price and product ids from basil/dahlia `pricing.price_details`, and still from a pre-basil `price` object or id string", () => {
  const f = invoiceFacts(dahliaInvoice({ id: "in_x", customer: "cus_x", subscription: "sub_x", price: SW_PRICE, product: SW_PRODUCT, startSec: 1, endSec: 2 }));
  assert.deepEqual(f.priceIds, [SW_PRICE]);
  assert.deepEqual(f.productIds, [SW_PRODUCT]);
  assert.equal(f.subscriptionId, "sub_x");
  const legacy = invoiceFacts({ lines: { data: [{ price: { id: "price_old", product: { id: "prod_old" } } }, { price: "price_str" }] } });
  assert.deepEqual(legacy.priceIds, ["price_old", "price_str"]);
  assert.deepEqual(legacy.productIds, ["prod_old"]);
  assert.deepEqual(invoiceFacts({ lines: { data: [{ price: null, pricing: null }] } }).priceIds, [], "a line naming no price yields no id, never a guess");
});

// ── a hub that sells software and hosting as separate subscriptions ────────
async function hub({ stripe } = {}) {
  let clock = Date.parse("2026-10-23T18:54:00Z"), n = 0;
  const logs = [], stripeCalls = [], provider = new FakeProvider({ now: () => clock });
  const h = await freshHub({}, {
    billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }), billingNow: () => clock, hostingNow: () => clock, hostingProvider: provider, hostingPublicHealthFetch: PUBLIC_HEALTH_OK,
    hostingFetch: async (url, init = {}) => {
      if (url.includes("/v1/prices/")) return { ok: true, status: 200, text: async () => JSON.stringify({ id: HOST_PRICE, active: true, unit_amount: 2000, currency: "usd", type: "recurring", recurring: { interval: "month", interval_count: 1 } }) };
      if (url.endsWith("/v1/checkout/sessions")) return { ok: true, status: 200, text: async () => JSON.stringify({ url: "https://checkout.stripe.com/c/pay_test" }) };
      if (url.includes("/v1/subscriptions/")) {
        stripeCalls.push({ method: init.method, id: decodeURIComponent(url.split("/").at(-1)), body: init.body ?? null });
        if (stripe) return stripe(init.method, decodeURIComponent(url.split("/").at(-1)), init.body ?? "");
      }
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  h.hub.hosting.log = line => logs.push(line);
  const admin = (p, body) => jsonReq(`${h.origin}${p}`, { method: "POST", headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  const configured = await admin("/admin/api/billing/config", {
    policy: { graceDays: GRACE_DAYS, bootstrapDays: BOOTSTRAP_DAYS, testMaxDays: 365 }, // test mode caps licences at testMaxDays
    stripe: { test: { secretKey: "sk_test_fixes_0123456789", webhookSecret: WHSEC, paymentLinks: { "hosting-monthly": "https://buy.stripe.com/test_hosting" } } },
    roles: { test: { software: { priceIds: [SW_PRICE], productIds: [SW_PRODUCT] }, hosting: { priceIds: [HOST_PRICE], productIds: [HOST_PRODUCT] } } },
    plans: [
      { key: "monthly", name: "Monthly", amountCents: 9900, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "software" },
      { key: "hosting-monthly", name: "Hosting", amountCents: 2000, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "hosting" },
    ],
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  await admin("/admin/api/hosting/policy", { policy: { provisioningEnabled: true, monthlyPriceCents: 2000, osId: "1743", releaseRef: "a".repeat(64) } });
  const post = async (type, object) => {
    const body = JSON.stringify({ id: `evt_fix_${++n}`, object: "event", type, livemode: false, created: Math.floor(clock / 1000), data: { object } });
    return jsonReq(`${h.origin}/api/billing/stripe/test`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, WHSEC, Math.floor(clock / 1000)) }, body });
  };
  const exp = (owner) => h.store.get(h.hub.billing.store.getCustomer(owner).licenseId)?.exp ?? null;
  return { h, logs, stripeCalls, provider, post, exp, sec: () => Math.floor(clock / 1000), set: ms => { clock = ms; }, advance: ms => { clock += ms; }, now: () => clock, tick: () => h.hub.hosting.tick(clock) };
}

async function readyInstance(h, row, nowMs) {
  const rawToken = `tok-${row.id}`;
  h.hub.hosting.store.updateInstance(row.id, row.version, (d) => { d.bootstrapTokenHash = hashBootstrapToken(rawToken); d.bootstrapTokenExpiresAtMs = nowMs + 3_600_000; }, nowMs);
  const fresh = h.hub.hosting.store.getInstance(row.id);
  const results = ["bybit", "binance", "bitget", "bitunix", "blofin", "weex", "aster"].map((venueId) => ({ venueId, status: 200 }));
  const r = await jsonReq(`${h.origin}/api/hosting/instances/${row.id}/readiness`, { method: "POST", body: JSON.stringify({ token: rawToken, generation: fresh.generation, results }) });
  assert.equal(r.body.ready, true, JSON.stringify(r.body));
}

await test("2026-10-23 order: the initial software invoice.paid and its alias arrive BEFORE checkout.session.completed and still apply the paid term", async () => {
  const c = await hub();
  try {
    const owner = "cus_early_invoice", sub = "sub_early_invoice";
    const start = c.sec(), end = start + 31 * 86_400;
    const inv = dahliaInvoice({ id: "in_early", customer: owner, subscription: sub, price: SW_PRICE, product: SW_PRODUCT, startSec: start, endSec: end, metadata: { plan: "monthly" } });
    assert.equal(c.h.hub.billing.store.roleFor(sub), null, "the role index knows nothing yet — exactly the production race");
    const paid = await c.post("invoice.paid", inv);
    assert.equal(paid.body.outcome, "applied", `pre-fix this was "unclassified": ${JSON.stringify(paid.body)}`);
    const rec = c.h.hub.billing.store.getCustomer(owner);
    assert.ok(rec, "the paid invoice is attributed to the software customer");
    assert.equal(rec.periodEndMs, end * 1000);
    assert.equal(rec.paidPeriodEndMs, end * 1000);
    assert.equal(c.exp(owner), end * 1000 + GRACE_DAYS * DAY, "paid term plus grace, not the bootstrap grant");
    assert.equal((await c.post("invoice.payment_succeeded", inv)).body.outcome, "applied");
    c.advance(600);
    const co = await c.post("checkout.session.completed", { id: "cs_early", mode: "subscription", payment_status: "paid", customer: owner, customer_details: { email: `${owner}@example.test` }, subscription: sub, metadata: { plan: "monthly" } });
    assert.equal(co.body.outcome, "applied", JSON.stringify(co.body));
    assert.equal(c.exp(owner), end * 1000 + GRACE_DAYS * DAY, "the later checkout does not shorten the paid term back to a bootstrap grant");
    assert.equal(c.h.hub.billing.store.getCustomer(owner).periodEndMs, end * 1000);
  } finally { await c.h.close(); }
});

await test("a dahlia-shaped hosting invoice before its checkout is attributed to hosting and never touches the software record", async () => {
  const c = await hub();
  try {
    const owner = "cus_host_first";
    await c.post("checkout.session.completed", { id: "cs_sw_hf", mode: "subscription", payment_status: "paid", customer: owner, customer_details: { email: `${owner}@example.test` }, subscription: "sub_sw_hf", metadata: { plan: "monthly" } });
    const before = { ...c.h.hub.billing.store.getCustomer(owner) };
    const start = c.sec(), end = start + 30 * 86_400;
    const r = await c.post("invoice.paid", dahliaInvoice({ id: "in_hf", customer: owner, subscription: "sub_host_hf", price: HOST_PRICE, product: HOST_PRODUCT, startSec: start, endSec: end, metadata: { plan: "hosting-monthly", role: "hosting" } }));
    assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
    assert.deepEqual(c.h.hub.billing.store.getCustomer(owner), before, "the software record is byte-for-byte unchanged");
  } finally { await c.h.close(); }
});

/** Software subscription cancelled before it was ever paid, hosting bought
 *  and running (the 2026-10-08 shape of the owner seen on 2026-10-29). */
async function lapsedSoftwareWithServer(c) {
  const owner = "cus_lapsed_sw", email = `${owner}@example.test`;
  assert.equal((await c.post("checkout.session.completed", { id: "cs_sw_l", mode: "subscription", payment_status: "paid", customer: owner, customer_details: { email }, subscription: "sub_sw_l", metadata: { plan: "monthly" } })).status, 200);
  assert.equal((await c.h.hub.hosting.checkoutUrl(owner, email, c.now())).ok, true);
  assert.equal((await c.post("checkout.session.completed", { id: "cs_host_l", mode: "subscription", payment_status: "paid", customer: owner, customer_details: { email }, subscription: "sub_host_l", metadata: { plan: "hosting-monthly" } })).status, 200);
  const hostEnd = c.sec() + 31 * 86_400;
  assert.equal((await c.post("invoice.paid", dahliaInvoice({ id: "in_host_l", customer: owner, subscription: "sub_host_l", price: HOST_PRICE, product: HOST_PRODUCT, startSec: c.sec(), endSec: hostEnd }))).body.outcome, "applied");
  await c.tick();
  const instance = () => c.h.hub.hosting.store.instances().find(r => r.ownerId === owner);
  await readyInstance(c.h, instance(), c.now());
  assert.equal(instance().stage, "ready");
  assert.equal((await c.post("customer.subscription.deleted", { id: "sub_sw_l", customer: owner, status: "canceled", metadata: { plan: "monthly" }, items: { data: [{ price: { id: SW_PRICE, product: SW_PRODUCT } }] } })).body.outcome, "applied");
  c.set(c.exp(owner) + 16_000);
  return { owner, instance, hostEnd: hostEnd * 1000 };
}

await test("an ineligible owner's running server follows its hosting subscription's own end: the echoed 'cancels at period end' schedules suspend and delete; the refusal is logged once", async () => {
  const c = await hub();
  try {
    const { owner, instance, hostEnd } = await lapsedSoftwareWithServer(c);
    for (let i = 0; i < 4; i++) { await c.tick(); c.advance(30_000); }
    const cancels = c.h.hub.hosting.store.outboxFor(instance().id).filter(j => j.jobType === "billing_reconcile");
    assert.equal(cancels.length, 1); assert.equal(cancels[0].payload.reason, "software-ineligible"); assert.equal(cancels[0].status, "sent");
    assert.ok(c.stripeCalls.some(s => s.method === "POST" && s.id === "sub_host_l" && s.body === "cancel_at_period_end=true"));
    assert.equal(c.logs.filter(l => l.includes("refusing paid hosting provisioning")).length, 1, "one journal line, not one per tick");
    assert.equal(instance().stage, "ready", "nothing ends before Stripe says the hosting subscription ends");
    // Stripe echoes the Hub's own cancellation.
    const echo = await c.post("customer.subscription.updated", { id: "sub_host_l", customer: owner, status: "active", cancel_at_period_end: true, metadata: { plan: "hosting-monthly", role: "hosting" }, items: { data: [{ price: { id: HOST_PRICE, product: HOST_PRODUCT }, current_period_end: hostEnd / 1000 }] } });
    assert.equal(echo.body.outcome, "applied", JSON.stringify(echo.body));
    await c.tick(); c.advance(30_000); await c.tick();
    const row = instance();
    assert.equal(row.stage, "cancel_scheduled", "pre-fix the row stayed `ready` with no deadline and outlived the paid period");
    assert.equal(row.cancellationReason, "intentional_cancellation");
    assert.equal(row.suspendAtMs, hostEnd);
    assert.ok(row.deleteAtMs > row.suspendAtMs);
    const pending = c.h.hub.hosting.store.outboxFor(row.id).filter(j => j.status === "pending" && j.lifecycleVersion === row.lifecycleVersion);
    const kinds = pending.map(j => j.jobType === "email" ? `email:${j.payload.template}` : j.jobType).sort();
    assert.deepEqual(kinds, ["delete", "email:cancellation_scheduled", "email:one_day", "email:three_days", "suspend"], JSON.stringify(kinds));
    assert.equal(pending.find(j => j.jobType === "suspend").availableAtMs, hostEnd);
    assert.equal(c.h.hub.hosting.store.outboxFor(row.id).filter(j => j.jobType === "billing_reconcile").length, 1, "the queued cancellation was not duplicated or obsoleted");
    assert.equal(c.provider.createCalls.length, 1, "no second server");
    assert.equal(c.logs.filter(l => l.includes("refusing paid hosting provisioning")).length, 1);
  } finally { await c.h.close(); }
});

await test("end-only fail closed: an ineligible owner's 'cancels at period end' with no period end and no paid-through date schedules nothing (never an end at now) and logs once", async () => {
  const c = await hub();
  try {
    const { instance } = await lapsedSoftwareWithServer(c);
    const bs = c.h.hub.billing.store;
    const host = bs.findRoleSubscriptionBySubscription("hosting", "sub_host_l");
    bs.putRoleSubscription({ ...host, subscriptionStatus: "active (cancels at period end)", periodEndMs: null });
    const row0 = instance();
    assert.ok(c.h.hub.hosting.store.updateInstance(row0.id, row0.version, (d) => { d.paidThroughMs = null; }, c.now()));
    for (let i = 0; i < 3; i++) { await c.tick(); c.advance(30_000); }
    const row = instance();
    assert.equal(row.stage, "ready", `pre-fix: cancel_scheduled with suspendAt = now (${row.suspendAtMs})`);
    assert.equal(row.cancellationReason, null);
    assert.equal(row.suspendAtMs, null);
    assert.equal(row.deleteAtMs, null);
    assert.equal(c.h.hub.hosting.store.outboxFor(row.id).filter(j => j.status === "pending" && (j.jobType === "suspend" || j.jobType === "delete")).length, 0);
    assert.equal(c.logs.filter(l => l.includes("not scheduling the end of")).length, 1, "one journal line, not one per tick");
    // A later signal with a real period end schedules the end from it.
    const end = c.now() + 5 * DAY;
    bs.putRoleSubscription({ ...bs.findRoleSubscriptionBySubscription("hosting", "sub_host_l"), periodEndMs: end });
    await c.tick();
    assert.equal(instance().stage, "cancel_scheduled");
    assert.equal(instance().suspendAtMs, end);
  } finally { await c.h.close(); }
});

await test("an ineligible owner whose hosting subscription Stripe already ended is scheduled for its nonpayment-shaped end, not left running", async () => {
  const c = await hub();
  try {
    const { owner, instance, hostEnd } = await lapsedSoftwareWithServer(c);
    await c.tick();
    c.set(hostEnd + 60_000);
    assert.equal((await c.post("customer.subscription.deleted", { id: "sub_host_l", customer: owner, status: "canceled", metadata: { plan: "hosting-monthly", role: "hosting" }, items: { data: [{ price: { id: HOST_PRICE, product: HOST_PRODUCT } }] } })).body.outcome, "applied");
    await c.tick();
    const row = instance();
    assert.equal(row.stage, "past_due"); assert.equal(row.cancellationReason, "renewal_unpaid");
    assert.ok(row.suspendAtMs >= hostEnd && row.deleteAtMs > row.suspendAtMs);
  } finally { await c.h.close(); }
});

await test("billing_reconcile on a subscription Stripe already ended: the refused update is confirmed by Stripe's own read and the job completes; a live subscription refusing still retries", async () => {
  const states = { sub_host_l: "canceled" };
  const c = await hub({
    stripe: (method, id) => {
      if (method === "POST") return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "A canceled subscription can only update its cancellation_details and metadata." } }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id, object: "subscription", status: states[id] ?? "active" }) };
    },
  });
  try {
    const { instance } = await lapsedSoftwareWithServer(c);
    await c.tick();
    const job = () => c.h.hub.hosting.store.outboxFor(instance().id).find(j => j.jobType === "billing_reconcile");
    assert.equal(job().status, "sent", JSON.stringify(job()));
    assert.deepEqual(c.stripeCalls.filter(s => s.id === "sub_host_l").map(s => s.method), ["POST", "GET"]);
    assert.ok(c.logs.some(l => l.includes("sub_host_l has already ended (canceled)")));
    assert.equal(c.logs.filter(l => l.includes("Stripe did not confirm the durable cancellation request")).length, 0);

    // Same refusal while Stripe still reports the subscription active: not confirmed.
    states.sub_host_l = "active";
    const row = instance();
    c.h.hub.hosting.store.enqueue({ hostingInstanceId: row.id, lifecycleVersion: row.lifecycleVersion, generation: row.generation, jobType: "billing_reconcile", dedupeKey: `stripe-cancel:${row.id}:sub_host_l:fixture-retry`, availableAtMs: c.now(), payload: { subscriptionId: "sub_host_l", action: "cancel", reason: "fixture-retry" } }, c.now());
    await c.tick();
    const retry = c.h.hub.hosting.store.outboxFor(row.id).find(j => j.dedupeKey.endsWith(":fixture-retry"));
    assert.equal(retry.status, "pending"); assert.equal(retry.lastErrorCode, "Stripe did not confirm the durable cancellation request");
  } finally { await c.h.close(); }
});

await test("a read that names another subscription, or an unreadable read, never confirms a cancellation", async () => {
  for (const variant of ["other-id", "http-500", "bad-json"]) {
    const c = await hub({
      stripe: (method, id) => {
        if (method === "POST") return { ok: false, status: 400, text: async () => "{}" };
        if (variant === "http-500") return { ok: false, status: 500, text: async () => "{}" };
        if (variant === "bad-json") return { ok: true, status: 200, text: async () => "not json" };
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: "sub_someone_else", status: "canceled" }) };
      },
    });
    try {
      const { instance } = await lapsedSoftwareWithServer(c);
      await c.tick();
      const job = c.h.hub.hosting.store.outboxFor(instance().id).find(j => j.jobType === "billing_reconcile");
      assert.equal(job.status, "pending", variant);
    } finally { await c.h.close(); }
  }
});

summary("billing-hosting-fixes-2026-10-29");
