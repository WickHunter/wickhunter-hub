// tests/hosting-holds.test.mjs — the admin deletion hold and the provider
// cost ceiling (H6 follow-up): both were previously a 501 stub / a stored-
// but-unenforced policy field. FakeProvider only, exactly like
// hosting-service.test.mjs's own harness (no live Stripe/Vultr/email call is
// ever made).
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { signStripePayload } from "../dist/src/billing/stripe.js";
import { FakeProvider } from "../dist/src/hosting/provider.js";

const TEST_WHSEC = "whsec_test_hosting_holds_0123456789";
const HOUR = 60 * 60 * 1000;

function mkEvSeq() { let n = 0; return () => ++n; }

async function newHub(overrides = {}) {
  let clock = Math.floor(Date.now() / 1000) * 1000;
  const provider = overrides.provider ?? new FakeProvider({ now: () => clock });
  const h = await freshHub({}, {
    billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    billingNow: () => clock,
    hostingNow: () => clock,
    hostingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    hostingProvider: provider,
  });
  const admin = (p, opts = {}) => jsonReq(`${h.origin}${p}`, { ...opts, headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json", ...(opts.headers ?? {}) } });
  await admin("/admin/api/billing/config", {
    method: "POST",
    body: JSON.stringify({
      stripe: { test: { webhookSecret: TEST_WHSEC } },
      roles: { test: { hosting: { priceIds: ["price_host1"], productIds: [] } } },
      plans: [
        { key: "monthly", name: "Monthly", amountCents: 9900, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "software" },
        { key: "hosting-monthly", name: "Hosting", amountCents: 1500, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "hosting" },
      ],
    }),
  });
  await admin("/admin/api/hosting/policy", {
    method: "POST",
    body: JSON.stringify({ policy: { provisioningEnabled: true, osId: "1743", releaseRef: "v-test" } }),
  });
  const nextEv = mkEvSeq();
  const sec = () => Math.floor(clock / 1000);
  const event = (type, object, id = `evt_${nextEv()}`) => ({ id, object: "event", type, livemode: false, created: sec(), data: { object } });
  async function postEvent(ev) {
    const body = JSON.stringify(ev);
    const res = await fetch(`${h.origin}/api/billing/stripe/test`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, TEST_WHSEC, sec()) },
      body,
    });
    return { status: res.status, body: await res.json() };
  }
  function advance(ms) { clock += ms; }
  return { h, admin, event, postEvent, advance, provider, getClock: () => clock };
}

/** A software licence for `customerId`/`email` only — eligible to check out
 *  hosting, but with no hosting instance yet. */
async function softwareOnly(ctx, customerId, email) {
  const r = await ctx.postEvent(ctx.event("checkout.session.completed", {
    id: `cs_sw_${customerId}`, mode: "subscription", payment_status: "paid", customer: customerId,
    customer_details: { email }, subscription: `sub_sw_${customerId}`, metadata: { plan: "monthly" },
  }));
  assert.equal(r.status, 200);
}

/** Software licence + a reserved hosting instance (mirrors
 *  hosting-service.test.mjs's own `boughtHosting`, duplicated rather than
 *  imported — that file exports nothing, by design, since each suite owns
 *  its harness). */
async function boughtHosting(ctx, customerId, email) {
  await softwareOnly(ctx, customerId, email);
  const r2 = await ctx.postEvent(ctx.event("checkout.session.completed", {
    id: `cs_host_${customerId}`, mode: "subscription", payment_status: "paid", customer: customerId,
    customer_details: { email }, subscription: `sub_host_${customerId}`, metadata: { plan: "hosting-monthly" },
  }));
  assert.equal(r2.status, 200);
  return instancesFor(ctx, customerId);
}
function instancesFor(ctx, customerId) {
  return ctx.h.hub.hosting.store.instances().filter((i) => i.ownerId === customerId);
}

/** Drains the provision job (no clock advance yet, so it is the only due
 *  job) — captures `providerPlanMonthlyCostCents` from FakeProvider's own
 *  plan quote, independent of readiness/bootstrapping. */
async function provisionedInstance(ctx, customerId, email) {
  const rows = await boughtHosting(ctx, customerId, email);
  const row = rows[0];
  await ctx.h.hub.hosting.tick(ctx.getClock());
  const fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.notEqual(fresh.providerPlanMonthlyCostCents, null, "drainProvision captured FakeProvider's plan quote");
  return fresh;
}

/** Exactly hosting-service.test.mjs's own nonpayment sequence, stopped at
 *  `suspended` — an admin hold is placed on instances that are already
 *  suspended in the real product ("it stays suspended with the hold
 *  named"). Note this sequence never lets the provision job run before the
 *  invoice.paid webhook bumps lifecycleVersion (obsoleting it) — matching
 *  hosting-service.test.mjs's own `cus_np` case, where `providerInstanceId`
 *  stays null throughout and a delete therefore completes in a single tick
 *  (no provider resource to confirm gone). */
async function driveToSuspended(ctx, customerId, email) {
  const rows = await boughtHosting(ctx, customerId, email);
  const row = rows[0];
  const T = ctx.getClock();
  const paidThrough = T + 1000;
  await ctx.postEvent(ctx.event("invoice.paid", {
    id: `in_${customerId}_1`, customer: customerId, paid: true, status: "paid",
    lines: { data: [{ period: { end: Math.floor(paidThrough / 1000) }, price: { id: "price_host1", product: "prod_host1" } }] },
  }));
  await ctx.postEvent(ctx.event("invoice.payment_failed", { id: `in_${customerId}_2`, customer: customerId, subscription: `sub_host_${customerId}` }));
  let fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.stage, "past_due");
  const expectSuspendAt = paidThrough + 72 * HOUR;
  ctx.advance(expectSuspendAt - T + 1000);
  await ctx.h.hub.hosting.tick(ctx.getClock());
  fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.stage, "suspended");
  assert.equal(fresh.cancellationReason, "renewal_unpaid");
  return fresh;
}

// ── the deletion hold ────────────────────────────────────────────────────

await test("an admin deletion hold blocks the delete transition across ticks, even long past the original deadline", async () => {
  const ctx = await newHub();
  const suspended = await driveToSuspended(ctx, "cus_hold1", "hold1@example.com");
  assert.ok(suspended.deleteAtMs);

  const r = ctx.h.hub.hosting.adminHoldDeletion(suspended.id, "alice", "chargeback review", ctx.getClock());
  assert.equal(r.ok, true);
  let held = ctx.h.hub.hosting.store.getInstance(suspended.id);
  assert.ok(held.deletionHold);
  assert.equal(held.deletionHold.by, "alice");
  assert.equal(held.deletionHold.reason, "chargeback review");

  // Advance well past the original delete deadline and tick repeatedly —
  // the very case the delete job's own `availableAtMs` would otherwise fire
  // on, over and over.
  ctx.advance(suspended.deleteAtMs - ctx.getClock() + 10 * HOUR);
  for (let i = 0; i < 5; i++) {
    await ctx.h.hub.hosting.tick(ctx.getClock());
    ctx.advance(HOUR);
  }
  const stillHeld = ctx.h.hub.hosting.store.getInstance(suspended.id);
  assert.equal(stillHeld.stage, "suspended", "never transitioned toward deleting/deleted while held");
  assert.ok(stillHeld.deletionHold, "the hold itself is still in effect");
  assert.equal(stillHeld.deletionHold.atMs, held.deletionHold.atMs, "the hold's own instant never moved");

  // The customer-facing view says so, with no dates.
  const view = ctx.h.hub.hosting.customerView("cus_hold1");
  assert.equal(view.instance.onHold, true);
  assert.equal(view.instance.suspendAtMs, null);
  assert.equal(view.instance.deleteAtMs, null);
  assert.match(view.instance.failureReason, /on hold by support/i);
  await ctx.h.close();
});

await test("an admin cannot force-delete a held instance either — refused by name, not silently swallowed by the pipeline", async () => {
  const ctx = await newHub();
  const suspended = await driveToSuspended(ctx, "cus_hold4", "hold4@example.com");
  ctx.h.hub.hosting.adminHoldDeletion(suspended.id, "dave", "under review", ctx.getClock());
  const r = ctx.h.hub.hosting.adminForceDelete(suspended.id, "trying anyway", ctx.getClock());
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_CANCELLABLE");
  assert.match(r.error, /hold/i);
  const still = ctx.h.hub.hosting.store.getInstance(suspended.id);
  assert.equal(still.stage, "suspended");
  await ctx.h.close();
});

await test("release: recomputes the delete deadline from the ORIGINAL nonpayment instant plus exactly how long it was held — never from the release clock", async () => {
  const ctx = await newHub();
  const suspended = await driveToSuspended(ctx, "cus_hold2", "hold2@example.com");
  const originalDeleteAt = suspended.deleteAtMs;
  const originalSuspendAt = suspended.suspendAtMs;

  const holdAtMs = originalDeleteAt - 50 * HOUR; // placed well before the original deadline
  ctx.advance(holdAtMs - ctx.getClock());
  const held = ctx.h.hub.hosting.adminHoldDeletion(suspended.id, "bob", "reviewing a dispute", ctx.getClock());
  assert.equal(held.ok, true);

  const heldForMs = 500 * HOUR;
  ctx.advance(heldForMs);
  const releaseAtMs = ctx.getClock();
  const r = ctx.h.hub.hosting.adminReleaseHold(suspended.id, releaseAtMs);
  assert.equal(r.ok, true);

  const released = ctx.h.hub.hosting.store.getInstance(suspended.id);
  assert.equal(released.deletionHold, null);
  assert.equal(released.deleteAtMs, originalDeleteAt + heldForMs, "shifted forward by exactly the held duration, from the ORIGINAL deadline");
  assert.equal(released.suspendAtMs, originalSuspendAt + heldForMs);
  // MUTATION CHECK: a "recompute from now" implementation would anchor on
  // `releaseAtMs` instead of the original nonpayment instant and land
  // somewhere else entirely — assert the actual result is not that.
  assert.notEqual(released.deleteAtMs, releaseAtMs + 168 * HOUR);

  // Deletion has not happened yet (still in the future) — a fresh reminder
  // was queued for the recomputed 3-day mark.
  assert.equal(released.stage, "suspended");
  const threeDayJobs = ctx.h.hub.hosting.store.outboxFor(released.id).filter((j) => j.dedupeKey.includes("three_days") && j.status === "pending");
  assert.equal(threeDayJobs.length, 1);
  assert.equal(threeDayJobs[0].availableAtMs, released.deleteAtMs - 72 * HOUR);
  await ctx.h.close();
});

await test("release: if the recomputed deadline had already elapsed by the time the hold was placed, deletion proceeds on the very next tick — exactly one terminated email, no stale 3-day/1-day reminders", async () => {
  const ctx = await newHub();
  const suspended = await driveToSuspended(ctx, "cus_hold3", "hold3@example.com");
  const originalDeleteAt = suspended.deleteAtMs;

  // The operator catches it AFTER the deadline had effectively arrived, but
  // before any tick actually processed the (already overdue) delete job.
  ctx.advance(originalDeleteAt - ctx.getClock() + 5 * HOUR);
  ctx.h.hub.hosting.adminHoldDeletion(suspended.id, "carol", "escalated", ctx.getClock());

  // Released only an hour later — nowhere near enough held time to push
  // the recomputed deadline back into the future.
  ctx.advance(HOUR);
  const r = ctx.h.hub.hosting.adminReleaseHold(suspended.id, ctx.getClock());
  assert.equal(r.ok, true);
  const released = ctx.h.hub.hosting.store.getInstance(suspended.id);
  assert.ok(released.deleteAtMs <= ctx.getClock(), "the recomputed deadline is already in the past");
  assert.equal(released.stage, "suspended", "not deleted yet — that happens on the NEXT tick, never inline with release");

  await ctx.h.hub.hosting.tick(ctx.getClock());
  const gone = ctx.h.hub.hosting.store.getInstance(suspended.id);
  assert.equal(gone.stage, "deleted", "deletion proceeded on the very next tick");

  const jobs = ctx.h.hub.hosting.store.outboxFor(suspended.id);
  assert.equal(jobs.filter((j) => j.dedupeKey.includes("terminated")).length, 1, "exactly one terminated email");
  assert.equal(jobs.filter((j) => j.status === "pending" && (j.dedupeKey.includes("three_days") || j.dedupeKey.includes("one_day"))).length, 0, "no stale/fresh reminder jobs for a deadline that had already elapsed");
  await ctx.h.close();
});

await test("holding twice never moves the hold's own instant — the clock a release measures elapsed-held-time from", async () => {
  const ctx = await newHub();
  const suspended = await driveToSuspended(ctx, "cus_hold5", "hold5@example.com");
  const t1 = ctx.getClock();
  ctx.h.hub.hosting.adminHoldDeletion(suspended.id, "eve", "first pass", t1);
  ctx.advance(10 * HOUR);
  const t2 = ctx.getClock();
  const r = ctx.h.hub.hosting.adminHoldDeletion(suspended.id, "frank", "handed off", t2);
  assert.equal(r.ok, true);
  const held = ctx.h.hub.hosting.store.getInstance(suspended.id);
  assert.equal(held.deletionHold.atMs, t1, "atMs stays at the FIRST hold instant");
  assert.equal(held.deletionHold.by, "frank", "by/reason are updated by a later hold call");
  await ctx.h.close();
});

// ── the provider cost ceiling ───────────────────────────────────────────

await test("cost ceiling: exactly at the ceiling passes, one cent over refuses — checked with no provider call", async () => {
  const ctx = await newHub();
  const existing = await provisionedInstance(ctx, "cus_cost1", "cost1@example.com");
  assert.equal(existing.providerPlanMonthlyCostCents, 1000, "FakeProvider's vc2-1c-2gb quote");

  await softwareOnly(ctx, "cus_cost2", "cost2@example.com");

  // ceiling = the existing instance's 1000c + this plan's own 1000c quote
  // (reused from the existing instance, since planId is shared — V1 offers
  // one plan) = 2000 exactly -> passes.
  await ctx.admin("/admin/api/hosting/policy", { method: "POST", body: JSON.stringify({ policy: { maximumProjectedMonthlyProviderCostCents: 2000 } }) });
  const atCeiling = ctx.h.hub.hosting.checkoutUrl("cus_cost2", "cost2@example.com");
  assert.equal(atCeiling.ok, true, "projected total exactly equals the ceiling — passes");
  assert.ok(atCeiling.value.url.includes("/buy?plan="));

  // One cent under what would be needed -> refuses, by name, before any
  // provider call (FakeProvider's createCalls proves nothing new was
  // attempted — the one existing call is cus_cost1's own provisioning).
  const callsBefore = ctx.provider.createCalls.length;
  await ctx.admin("/admin/api/hosting/policy", { method: "POST", body: JSON.stringify({ policy: { maximumProjectedMonthlyProviderCostCents: 1999 } }) });
  const overCeiling = ctx.h.hub.hosting.checkoutUrl("cus_cost2", "cost2@example.com");
  assert.equal(overCeiling.ok, false);
  assert.equal(overCeiling.code, "PROVISIONING_DISABLED");
  assert.match(overCeiling.error, /cost ceiling/);
  assert.equal(ctx.provider.createCalls.length, callsBefore, "no instance for cus_cost2 was ever attempted");
  await ctx.h.close();
});

await test("an instance whose provider quote was never captured makes the WHOLE projection unknown, and a new checkout is refused rather than assuming 0 cost", async () => {
  const ctx = await newHub();
  // Reserved but never ticked — drainProvision (and its quote capture)
  // never ran, so providerPlanMonthlyCostCents stays null.
  const rows = await boughtHosting(ctx, "cus_unk1", "unk1@example.com");
  assert.equal(rows[0].providerPlanMonthlyCostCents, null);

  const unset = ctx.h.hub.hosting.projectedMonthlyProviderCostCents();
  assert.equal(unset.known, false, "one unquoted non-deleted instance makes the sum unknown, not silently 0");

  await softwareOnly(ctx, "cus_unk2", "unk2@example.com");
  await ctx.admin("/admin/api/hosting/policy", { method: "POST", body: JSON.stringify({ policy: { maximumProjectedMonthlyProviderCostCents: 500000 } }) });
  const r = ctx.h.hub.hosting.checkoutUrl("cus_unk2", "unk2@example.com");
  assert.equal(r.ok, false, "an unknown projection refuses even under a ceiling that would obviously not be exceeded — never guessed as 0");
  assert.equal(r.code, "PROVISIONING_DISABLED");
  assert.match(r.error, /cost ceiling/);
  await ctx.h.close();
});

await test("0 = no ceiling — a checkout is never refused for cost, whatever the projection", async () => {
  const ctx = await newHub();
  const rows = await boughtHosting(ctx, "cus_zero1", "zero1@example.com"); // unquoted, unknown projection
  assert.equal(rows[0].providerPlanMonthlyCostCents, null);
  const policy = ctx.h.hub.hosting.policy();
  assert.equal(policy.maximumProjectedMonthlyProviderCostCents, 0, "the default — existing semantics");

  await softwareOnly(ctx, "cus_zero2", "zero2@example.com");
  const r = ctx.h.hub.hosting.checkoutUrl("cus_zero2", "zero2@example.com");
  assert.equal(r.ok, true, "an unknown projection is never even consulted when the ceiling is 0");
  await ctx.h.close();
});

await test("admin GET /admin/api/hosting/policy reports projected vs ceiling", async () => {
  const ctx = await newHub();
  await provisionedInstance(ctx, "cus_admview", "admview@example.com");
  await ctx.admin("/admin/api/hosting/policy", { method: "POST", body: JSON.stringify({ policy: { maximumProjectedMonthlyProviderCostCents: 5000 } }) });
  const r = await ctx.admin("/admin/api/hosting/policy");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.projectedMonthlyProviderCostCents, { known: true, cents: 1000 });
  assert.equal(r.body.policy.maximumProjectedMonthlyProviderCostCents, 5000);
  await ctx.h.close();
});

// ── admin routes: hold / release-hold over HTTP ─────────────────────────

await test("POST …/hold and …/release-hold over HTTP, admin-token gated, wire straight through to the service", async () => {
  const ctx = await newHub();
  const suspended = await driveToSuspended(ctx, "cus_httphold", "httphold@example.com");

  const unauthed = await jsonReq(`${ctx.h.origin}/admin/api/hosting/instances/${suspended.id}/hold`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(unauthed.status, 401);

  const holdRes = await ctx.admin(`/admin/api/hosting/instances/${suspended.id}/hold`, { method: "POST", body: JSON.stringify({ by: "grace", reason: "audit hold" }) });
  assert.equal(holdRes.status, 200);
  assert.equal(holdRes.body.ok, true);
  let row = ctx.h.hub.hosting.store.getInstance(suspended.id);
  assert.equal(row.deletionHold.by, "grace");

  const releaseRes = await ctx.admin(`/admin/api/hosting/instances/${suspended.id}/release-hold`, { method: "POST", body: "{}" });
  assert.equal(releaseRes.status, 200);
  assert.equal(releaseRes.body.ok, true);
  row = ctx.h.hub.hosting.store.getInstance(suspended.id);
  assert.equal(row.deletionHold, null);

  const notHeld = await ctx.admin(`/admin/api/hosting/instances/${suspended.id}/release-hold`, { method: "POST", body: "{}" });
  assert.equal(notHeld.status, 409);
  assert.equal(notHeld.body.ok, false);

  const unknownId = await ctx.admin(`/admin/api/hosting/instances/nonexistent/hold`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(unknownId.status, 404);
  await ctx.h.close();
});

summary("hosting-holds");
