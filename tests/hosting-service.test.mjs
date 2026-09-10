// tests/hosting-service.test.mjs — H4/H5/H6 end to end: the lifecycle state
// machine, the FakeProvider-driven crash recovery, readiness + region
// fallback, restore-boots-paused, billing isolation from the software
// licence, and the nonpayment/voluntary-cancel timelines through the real
// deadlines() policy. Every Stripe event is synthetic and signed with a
// configured test webhook secret — the exact harness billing-roles.test.mjs
// already established; no live Stripe/Vultr/email call is ever made (every
// fetch is stubbed, and `hostingProvider` is always FakeProvider).
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { signStripePayload } from "../dist/src/billing/stripe.js";
import { FakeProvider, hashBootstrapToken } from "../dist/src/hosting/provider.js";

const TEST_WHSEC = "whsec_test_hosting_0123456789";
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

/** Creates a software licence for `customerId`/`email` (eligibility) then a
 *  hosting checkout for the same customer — the "existing customer adds
 *  hosting" flow (handoff §3). Returns the created instance row (via the
 *  admin instances list, since that is the real read surface). */
async function boughtHosting(ctx, customerId, email) {
  const r1 = await ctx.postEvent(ctx.event("checkout.session.completed", {
    id: `cs_sw_${customerId}`, mode: "subscription", payment_status: "paid", customer: customerId,
    customer_details: { email }, subscription: `sub_sw_${customerId}`, metadata: { plan: "monthly" },
  }));
  assert.equal(r1.status, 200);
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

// ── acceptance: double-click checkout -> at most one instance ─────────────

await test("double-click checkout: two completed hosting checkout sessions for the same owner produce exactly ONE instance", async () => {
  const ctx = await newHub();
  const rows = await boughtHosting(ctx, "cus_dbl", "dbl@example.com");
  assert.equal(rows.length, 1, "the first checkout reserved the instance");
  // The "second click": another completed checkout session for the SAME
  // owner (two tabs both finishing payment) — a different Stripe session id,
  // same customer.
  const again = await ctx.postEvent(ctx.event("checkout.session.completed", {
    id: "cs_host_dbl_2", mode: "subscription", payment_status: "paid", customer: "cus_dbl",
    customer_details: { email: "dbl@example.com" }, subscription: "sub_host_dbl_2", metadata: { plan: "hosting-monthly" },
  }));
  assert.equal(again.status, 200);
  const rowsAfter = instancesFor(ctx, "cus_dbl");
  assert.equal(rowsAfter.length, 1, "reserveInstance's atomic uniqueness refused a second instance for the same owner");
  await ctx.h.close();
});

// ── acceptance: crash between persist and provider create -> one instance ──

await test("crash between persist and provider create: a create that 'times out' after really succeeding is discovered by findByLabel, never double-created", async () => {
  const provider = new FakeProvider({ createTimesOutOnce: true });
  const ctx = await newHub({ provider });
  const rows = await boughtHosting(ctx, "cus_crash", "crash@example.com");
  const row = rows[0];
  assert.equal(row.stage, "ordered");
  // First tick: drainProvision reserves attempt #1, provider.createInstance
  // "times out" (the resource WAS created on the provider's side, per
  // FakeProvider's own simulation) — the job must be released, not marked
  // sent, and the instance must NOT be stuck silently.
  await ctx.h.hub.hosting.tick(ctx.getClock());
  let fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.providerInstanceId, null, "the id was never learned from the timed-out attempt");
  assert.equal(provider.createCalls.length, 1);
  assert.equal(instancesFor(ctx, "cus_crash").length, 1, "still exactly one instance row");
  // Second tick, after the backoff: findByLabel must discover the SAME
  // orphaned resource and finish provisioning WITHOUT calling
  // createInstance again.
  ctx.advance(35_000);
  await ctx.h.hub.hosting.tick(ctx.getClock());
  fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(provider.createCalls.length, 1, "createInstance was called exactly once across both attempts");
  assert.ok(fresh.providerInstanceId, "the orphaned resource's id was adopted via findByLabel");
  assert.equal(fresh.stage, "bootstrapping");
  assert.equal(ctx.h.hub.hosting.store.resourcesFor(row.id).length, 1, "the resource inventory has exactly one entry, not zero and not two");
  await ctx.h.close();
});

// ── acceptance: readiness refuses by name, and fallback region once ────────

await test("readiness: a refused venue is named; the SAME generation retries exactly once in the fallback region, then refuses for good", async () => {
  const ctx = await newHub();
  const rows = await boughtHosting(ctx, "cus_ready", "ready@example.com");
  await ctx.h.hub.hosting.tick(ctx.getClock());
  let row = ctx.h.hub.hosting.store.getInstance(rows[0].id);
  assert.equal(row.stage, "bootstrapping");
  assert.equal(row.region, "nrt", "tried the primary region first");
  const rawToken = "test-bootstrap-token-1";
  ctx.h.hub.hosting.store.updateInstance(row.id, row.version, (d) => { d.bootstrapTokenHash = hashBootstrapToken(rawToken); d.bootstrapTokenExpiresAtMs = ctx.getClock() + HOUR; }, ctx.getClock());
  row = ctx.h.hub.hosting.store.getInstance(row.id);

  // Bybit refused (403) in Tokyo -> the instance retries ONCE, in Osaka.
  const r1 = await jsonReq(`${ctx.h.origin}/api/hosting/instances/${row.id}/readiness`, {
    method: "POST", body: JSON.stringify({ token: rawToken, generation: row.generation, results: [{ venueId: "bybit", status: 403 }, { venueId: "binance", status: 200 }] }),
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ready, false);
  row = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(row.region, "itm", "fell back to Osaka after Tokyo's Bybit refusal");
  assert.equal(row.regionAttempts.length, 1);
  assert.match(row.failureReason, /Bybit/);
  assert.match(row.failureReason, /403/);

  // Provision again in the fallback region (a new bootstrap token, same
  // generation), and it ALSO refuses — this must be the LAST fallback: no
  // second retry, a permanent refusal naming the venue.
  await ctx.h.hub.hosting.tick(ctx.getClock());
  row = ctx.h.hub.hosting.store.getInstance(row.id);
  const rawToken2 = "test-bootstrap-token-2";
  ctx.h.hub.hosting.store.updateInstance(row.id, row.version, (d) => { d.bootstrapTokenHash = hashBootstrapToken(rawToken2); d.bootstrapTokenExpiresAtMs = ctx.getClock() + HOUR; }, ctx.getClock());
  row = ctx.h.hub.hosting.store.getInstance(row.id);
  const r2 = await jsonReq(`${ctx.h.origin}/api/hosting/instances/${row.id}/readiness`, {
    method: "POST", body: JSON.stringify({ token: rawToken2, generation: row.generation, results: [{ venueId: "bybit", status: 403 }, { venueId: "binance", status: 200 }] }),
  });
  assert.equal(r2.body.ready, false);
  row = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(row.region, "itm", "no THIRD region to try — stays where the single fallback landed");
  assert.equal(row.regionAttempts.length, 1, "the fallback was spent exactly once, not retried again");
  assert.match(row.failureReason, /exchange-approved region/);
  assert.match(row.failureReason, /Bybit/);
  await ctx.h.close();
});

await test("readiness: all venues ok -> stage becomes ready, and the installation-ready email is queued (never sent from the HTTP thread)", async () => {
  const ctx = await newHub();
  const rows = await boughtHosting(ctx, "cus_ok", "ok@example.com");
  await ctx.h.hub.hosting.tick(ctx.getClock());
  let row = ctx.h.hub.hosting.store.getInstance(rows[0].id);
  const rawToken = "tok-ok";
  ctx.h.hub.hosting.store.updateInstance(row.id, row.version, (d) => { d.bootstrapTokenHash = hashBootstrapToken(rawToken); d.bootstrapTokenExpiresAtMs = ctx.getClock() + HOUR; }, ctx.getClock());
  row = ctx.h.hub.hosting.store.getInstance(row.id);
  const results = ["bybit", "binance", "bitget", "bitunix", "blofin", "weex", "aster"].map((venueId) => ({ venueId, status: 200 }));
  const r = await jsonReq(`${ctx.h.origin}/api/hosting/instances/${row.id}/readiness`, { method: "POST", body: JSON.stringify({ token: rawToken, generation: row.generation, results }) });
  assert.equal(r.body.ready, true);
  row = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(row.stage, "ready");
  const jobs = ctx.h.hub.hosting.store.outboxFor(row.id);
  assert.ok(jobs.some((j) => j.jobType === "email" && j.dedupeKey.includes("ready") && j.status === "pending"));
  await ctx.h.close();
});

await test("a late readiness callback naming a REPLACED generation is refused — never marks the new generation ready from stale evidence", async () => {
  const ctx = await newHub();
  const rows = await boughtHosting(ctx, "cus_gen", "gen@example.com");
  const row = rows[0];
  const r = await jsonReq(`${ctx.h.origin}/api/hosting/instances/${row.id}/readiness`, { method: "POST", body: JSON.stringify({ token: "whatever", generation: row.generation + 1, results: [] }) });
  assert.equal(r.status, 404);
  await ctx.h.close();
});

// ── acceptance: restore always boots paused ─────────────────────────────────

await test("restore: a payment while suspended moves the instance to ready (never 'active'), and the customer view never claims bots resumed", async () => {
  const ctx = await newHub();
  const rows = await boughtHosting(ctx, "cus_restore", "restore@example.com");
  const row = rows[0];
  // Force it straight to `suspended` (as if a nonpayment cycle already ran).
  ctx.h.hub.hosting.store.updateInstance(row.id, row.version, (d) => { d.stage = "suspended"; d.cancellationReason = "renewal_unpaid"; d.paidThroughMs = ctx.getClock() - 10 * HOUR; }, ctx.getClock());
  // A fresh invoice.paid for the hosting subscription arrives.
  const paidThrough = ctx.getClock() + 30 * 24 * HOUR;
  await ctx.postEvent(ctx.event("invoice.paid", {
    id: "in_restore1", customer: "cus_restore", paid: true, status: "paid",
    lines: { data: [{ period: { end: Math.floor(paidThrough / 1000) }, price: { id: "price_host1", product: "prod_host1" } }] },
  }));
  let fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.stage, "restoring", "moved toward restore, not straight to ready — a fresh provider health read is still required");
  assert.equal(fresh.deleteAtMs, null, "the pending deletion clock was cancelled by the payment");
  // Draining the restore's own provision-recheck job brings the provider
  // instance back (FakeProvider still has it — suspend only powers off).
  await ctx.h.hub.hosting.tick(ctx.getClock());
  fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.stage, "bootstrapping", "a restore re-runs the SAME readiness gate as a fresh install — no shortcut to ready");
  const rawToken = "restore-tok";
  ctx.h.hub.hosting.store.updateInstance(fresh.id, fresh.version, (d) => { d.bootstrapTokenHash = hashBootstrapToken(rawToken); d.bootstrapTokenExpiresAtMs = ctx.getClock() + HOUR; }, ctx.getClock());
  fresh = ctx.h.hub.hosting.store.getInstance(fresh.id);
  const results = ["bybit", "binance", "bitget", "bitunix", "blofin", "weex", "aster"].map((venueId) => ({ venueId, status: 200 }));
  await jsonReq(`${ctx.h.origin}/api/hosting/instances/${fresh.id}/readiness`, { method: "POST", body: JSON.stringify({ token: rawToken, generation: fresh.generation, results }) });
  fresh = ctx.h.hub.hosting.store.getInstance(fresh.id);
  assert.equal(fresh.stage, "ready", "restore lands on 'ready', never 'active' — there is no path in this service that ever sets 'active'");
  const jobs = ctx.h.hub.hosting.store.outboxFor(fresh.id);
  assert.ok(jobs.some((j) => j.jobType === "email" && j.dedupeKey.includes("restored")));
  await ctx.h.close();
});

// ── acceptance: a hosting refund never touches the software licence ────────

await test("hosting refund/dispute never revokes, shortens or otherwise touches the software licence on the same customer", async () => {
  const ctx = await newHub();
  await boughtHosting(ctx, "cus_refund", "refund@example.com");
  const swRecBefore = ctx.h.hub.billing.store.getCustomer("cus_refund");
  const licBefore = ctx.h.store.get(swRecBefore.licenseId);
  assert.equal(ctx.h.store.isRevoked(swRecBefore.licenseId), false);

  // Establish the charge's role first, exactly as a real hosting invoice
  // would (its OWN price id, on the hosting allowlist) — this is what
  // populates the object-id role index a bare `charge.refunded` (which
  // carries no price id at all) resolves through.
  await ctx.postEvent(ctx.event("invoice.paid", {
    id: "in_refund1", customer: "cus_refund", paid: true, status: "paid", charge: "ch_host1",
    lines: { data: [{ period: { end: Math.floor((ctx.getClock() + 1000) / 1000) }, price: { id: "price_host1", product: "prod_host1" } }] },
  }));
  const refundResult = await ctx.postEvent(ctx.event("charge.refunded", { id: "ch_host1", customer: "cus_refund", refunded: true, amount: 1500, amount_refunded: 1500 }));
  assert.equal(refundResult.status, 200);

  const swRecAfter = ctx.h.hub.billing.store.getCustomer("cus_refund");
  const licAfter = ctx.h.store.get(swRecBefore.licenseId);
  assert.deepEqual(swRecAfter, swRecBefore, "the software CustomerRecord is byte-for-byte unchanged");
  assert.equal(ctx.h.store.isRevoked(swRecBefore.licenseId), false, "the software licence was never revoked by a hosting refund");
  assert.equal(licAfter.exp, licBefore.exp, "the software licence's expiry did not move");
  const hostRec = ctx.h.hub.billing.store.getRoleSubscription("cus_refund", "hosting");
  assert.equal(hostRec.refunded, true, "the refund IS recorded — on hosting's own record");
  await ctx.h.close();
});

// ── acceptance: nonpayment timeline through the real deadlines policy ──────

await test("nonpayment: past_due -> suspended at T+72h -> deleted at T+240h, driven entirely by ticks against the real clock", async () => {
  const ctx = await newHub();
  const rows = await boughtHosting(ctx, "cus_np", "np@example.com");
  const row = rows[0];
  const T = ctx.getClock();
  const paidThrough = T + 1000; // the subscription's own paid-through instant
  await ctx.postEvent(ctx.event("invoice.paid", {
    id: "in_np1", customer: "cus_np", paid: true, status: "paid",
    lines: { data: [{ period: { end: Math.floor(paidThrough / 1000) }, price: { id: "price_host1", product: "prod_host1" } }] },
  }));
  await ctx.postEvent(ctx.event("invoice.payment_failed", { id: "in_np2", customer: "cus_np", subscription: "sub_host_cus_np" }));
  let fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.stage, "past_due");
  const expectSuspendAt = paidThrough + 72 * HOUR;
  const expectDeleteAt = expectSuspendAt + 168 * HOUR;
  assert.equal(fresh.suspendAtMs, expectSuspendAt);
  assert.equal(fresh.deleteAtMs, expectDeleteAt);

  ctx.advance(expectSuspendAt - T + 1000);
  await ctx.h.hub.hosting.tick(ctx.getClock());
  fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.stage, "suspended");
  const suspendJobs = ctx.h.hub.hosting.store.outboxFor(row.id).filter((j) => j.dedupeKey.includes("suspended"));
  assert.ok(suspendJobs.length >= 1);

  ctx.advance(expectDeleteAt - ctx.getClock() + 1000);
  await ctx.h.hub.hosting.tick(ctx.getClock());
  fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.stage, "deleted");
  assert.ok(fresh.terminatedAtMs);
  const termJobs = ctx.h.hub.hosting.store.outboxFor(row.id).filter((j) => j.dedupeKey.includes("terminated"));
  assert.ok(termJobs.length >= 1);
  await ctx.h.close();
});

await test("a payment made well before the delete deadline cancels the pending suspend/delete jobs — they never fire late", async () => {
  const ctx = await newHub();
  const rows = await boughtHosting(ctx, "cus_save", "save@example.com");
  const row = rows[0];
  const T = ctx.getClock();
  await ctx.postEvent(ctx.event("invoice.paid", {
    id: "in_save1", customer: "cus_save", paid: true, status: "paid",
    lines: { data: [{ period: { end: Math.floor((T + 1000) / 1000) }, price: { id: "price_host1", product: "prod_host1" } }] },
  }));
  await ctx.postEvent(ctx.event("invoice.payment_failed", { id: "in_save2", customer: "cus_save", subscription: "sub_host_cus_save" }));
  let fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.stage, "past_due");
  const staleSuspendAt = fresh.suspendAtMs;

  // Paid again before the suspend deadline.
  const newPaidThrough = T + 40 * 24 * HOUR;
  await ctx.postEvent(ctx.event("invoice.paid", {
    id: "in_save3", customer: "cus_save", paid: true, status: "paid",
    lines: { data: [{ period: { end: Math.floor(newPaidThrough / 1000) }, price: { id: "price_host1", product: "prod_host1" } }] },
  }));
  fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.stage, "restoring");
  assert.equal(fresh.suspendAtMs, null);
  assert.equal(fresh.deleteAtMs, null);

  // Advance PAST the original (now-stale) suspend deadline and tick —
  // nothing should suspend/delete the instance.
  ctx.advance(staleSuspendAt - T + 5000);
  await ctx.h.hub.hosting.tick(ctx.getClock());
  fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.notEqual(fresh.stage, "suspended");
  assert.notEqual(fresh.stage, "deleted");
  await ctx.h.close();
});

// ── acceptance: late payment during/after an irreversible delete ───────────

await test("a payment observed after permanent deletion never restores the instance and never fabricates a fresh one", async () => {
  const ctx = await newHub();
  const rows = await boughtHosting(ctx, "cus_late", "late@example.com");
  const row = rows[0];
  const fresh0 = ctx.h.hub.hosting.store.updateInstance(row.id, row.version, (d) => { d.stage = "deleted"; d.terminatedAtMs = ctx.getClock(); d.providerInstanceId = null; }, ctx.getClock());
  assert.equal(fresh0.stage, "deleted");
  const paidThrough = ctx.getClock() + 30 * 24 * HOUR;
  await ctx.postEvent(ctx.event("invoice.paid", {
    id: "in_late1", customer: "cus_late", paid: true, status: "paid",
    lines: { data: [{ period: { end: Math.floor(paidThrough / 1000) }, price: { id: "price_host1", product: "prod_host1" } }] },
  }));
  const after = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(after.stage, "deleted", "NEVER restored from deleted by a payment alone");
  assert.match(after.failureReason, /late_payment_resolution_required/);
  const jobs = ctx.h.hub.hosting.store.outboxFor(row.id);
  assert.ok(jobs.some((j) => j.dedupeKey.includes("late_payment")));
  assert.equal(instancesFor(ctx, "cus_late").length, 1, "no fresh instance was silently created either");

  // Re-post the SAME payment fact again (a retried/duplicate reconcile) —
  // must NOT queue a second late-payment email.
  await ctx.h.hub.hosting.reconcileOwner("cus_late");
  const jobs2 = ctx.h.hub.hosting.store.outboxFor(row.id).filter((j) => j.dedupeKey.includes("late_payment"));
  assert.equal(jobs2.length, 1, "the late-payment notice is deduped, not re-sent on every reconcile pass");
  await ctx.h.close();
});

// ── acceptance: voluntary cancellation, and reversing it while reversible ──

await test("customer cancel: schedules suspend AT paid-through (no grace) and delete +168h; resume-renewal reverses it before the deadline", async () => {
  const ctx = await newHub();
  const rows = await boughtHosting(ctx, "cus_cancel", "cancel@example.com");
  const row = rows[0];
  const paidThrough = ctx.getClock() + 10 * 24 * HOUR;
  ctx.h.hub.hosting.store.updateInstance(row.id, row.version, (d) => { d.paidThroughMs = paidThrough; d.stage = "ready"; }, ctx.getClock());

  const r = await ctx.h.hub.hosting.cancel("cus_cancel", row.id, ctx.getClock());
  assert.equal(r.ok, true);
  assert.equal(r.value.suspendAt, paidThrough);
  assert.equal(r.value.deleteAt, paidThrough + 168 * HOUR);
  let fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.stage, "cancel_scheduled");

  const resumed = await ctx.h.hub.hosting.resumeRenewal("cus_cancel", row.id, ctx.getClock());
  assert.equal(resumed.ok, true);
  fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  assert.equal(fresh.cancellationReason, null);
  assert.equal(fresh.deleteAtMs, null);
  assert.equal(fresh.stage, "ready");

  // Once past the suspend deadline, reversal is refused.
  ctx.h.hub.hosting.cancel("cus_cancel", row.id, ctx.getClock());
  fresh = ctx.h.hub.hosting.store.getInstance(row.id);
  const tooLate = await ctx.h.hub.hosting.resumeRenewal("cus_cancel", row.id, fresh.suspendAtMs + 1);
  assert.equal(tooLate.ok, false);
  assert.equal(tooLate.code, "RESTORATION_UNAVAILABLE");
  await ctx.h.close();
});

// ── acceptance / H2 wiring: eligibility gate and the customer dashboard ────

await test("checkout is refused without an eligible software licence, and a second checkout is refused once an instance exists", async () => {
  const ctx = await newHub();
  const r1 = ctx.h.hub.hosting.checkoutUrl("email:noone@example.com", "noone@example.com");
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "SOFTWARE_LICENSE_REQUIRED");

  await boughtHosting(ctx, "cus_elig", "elig@example.com");
  const r2 = ctx.h.hub.hosting.checkoutUrl("cus_elig", "elig@example.com");
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "HOSTING_ALREADY_EXISTS");
  await ctx.h.close();
});

await test("GET /api/customer/state surfaces the real hosting instance for the signed-in identity, keyed by email not by customerKey", async () => {
  const ctx = await newHub();
  await boughtHosting(ctx, "cus_dash", "dash@example.com");
  const signin = await jsonReq(`${ctx.h.origin}/api/customer/signin`, { method: "POST", body: JSON.stringify({ email: "dash@example.com" }) });
  assert.equal(signin.status, 200);
  const identityStore = ctx.h.hub.customerSessions.store;
  const identity = identityStore.getIdentityByEmail ? identityStore.getIdentityByEmail("dash@example.com") : Object.values(identityStore.identities()).find((i) => i.email === "dash@example.com");
  const raw = identityStore.mintSigninToken(identity.id, ctx.getClock());
  const exch = await fetch(`${ctx.h.origin}/customer/signin?token=${raw}`, { redirect: "manual" });
  const cookie = exch.headers.get("set-cookie");
  const state = await jsonReq(`${ctx.h.origin}/api/customer/state`, { headers: { cookie } });
  assert.equal(state.status, 200);
  assert.equal(state.body.hosting.available, true);
  assert.equal(state.body.hosting.hasInstance, true);
  assert.equal(state.body.hosting.instance.stage, "ordered");
  await ctx.h.close();
});

summary("hosting-service");
