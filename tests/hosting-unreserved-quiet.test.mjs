// tests/hosting-unreserved-quiet.test.mjs — 0.4.94 noise fix. A hosting role
// record with paid evidence but NO Stripe subscription, whose only instance
// was irreversibly deleted (the operator's complimentary VPS test record of
// 2026-10-05), made every 30-second hosting tick log "refusing unreserved
// hosting payment … no customer-bound Checkout reservation exists" while
// doing nothing. It is now logged once per owner per process and still does
// nothing. An owner WITH a subscription keeps the existing refusal path
// (reserve a deleted row, queue the unreserved-payment Stripe cancellation).
// Offline fixtures only; nothing leaves 127.0.0.1.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { freshHub, test, summary } from "./helpers.mjs";
import { FakeProvider } from "../dist/src/hosting/provider.js";

const T0 = Date.parse("2026-10-10T04:00:00Z");
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function roleRecord(ownerId, over = {}) {
  return { key: `${ownerId}::hosting`, customerKey: ownerId, role: "hosting", livemode: true, subscriptionId: null, subscriptionStatus: "active", periodEndMs: T0 + 20 * 86_400_000,
    chargeIds: [], disputed: false, refunded: false, createdAtMs: T0 - 5 * 86_400_000, updatedAtMs: T0 - 5 * 86_400_000, lastEventType: "admin.complimentary_vps_test", lastEventAtMs: T0 - 5 * 86_400_000, ...over };
}

await test("an owner with paid evidence, no Stripe subscription and only a deleted instance is logged once, not every tick, and nothing changes; an owner with a subscription keeps the unreserved-payment cancellation", async () => {
  let clock = T0;
  const h = await freshHub({}, { hostingNow: () => clock, billingNow: () => clock, hostingProvider: new FakeProvider({ now: () => clock }), billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }) });
  try {
    const hosting = h.hub.hosting, billing = h.hub.billing;
    hosting.stop();
    const logs = [];
    hosting.log = (line) => logs.push(line);
    const owner = "admin-vps-test:20261005-fixture";
    billing.store.putRoleSubscription(roleRecord(owner));
    billing.store.putCustomer({ key: owner, stripeCustomerId: "", email: "ops@example.test", name: "ops", livemode: true, licenseId: "lic_fixture", planKey: null, subscriptionId: null, subscriptionStatus: null, periodEndMs: null, chargeIds: [],
      createdAtMs: T0, updatedAtMs: T0, welcomeSentAtMs: null, welcomeError: null, disputed: false, refunded: false, lastEventType: "admin.complimentary_vps_test", lastEventAtMs: T0 });
    const row = hosting.store.reserveInstance({ id: "host_fixture_deleted", ownerId: owner, environment: "live", region: "nrt", planId: "vc2-1c-2gb", stripeCustomerId: "", nowMs: T0 - 5 * 86_400_000 });
    assert.ok(row);
    assert.ok(hosting.store.updateInstance(row.id, row.version, (d) => { d.stage = "deleted"; }, T0 - 5 * 86_400_000));
    const db = path.join(h.dataDir, "hosting-db.v1.json"), roles = path.join(h.dataDir, "billing-role-subscriptions.v1.json");
    const before = [sha(db), sha(roles)];
    for (let i = 0; i < 5; i++) { await hosting.tick(clock); hosting.reconcileOwner(owner, clock); clock += 30_000; }
    const lines = logs.filter((l) => l.includes(`refusing unreserved hosting payment for ${owner}`));
    assert.equal(lines.length, 1, "once per owner per process, not every 30 seconds");
    assert.match(lines[0], /no customer-bound Checkout reservation exists \(no Stripe subscription is bound, so there is nothing to cancel; every instance for this owner is deleted; logged once\)/);
    assert.deepEqual([sha(db), sha(roles)], before, "nothing was reserved, cancelled or rewritten");
    assert.equal(hosting.store.instances().filter((r) => r.ownerId === owner).length, 1);

    // Preserved: the same shape WITH a subscription still refuses by reserving
    // a deleted row and queueing the unreserved-payment Stripe cancellation,
    // once; its own deleted row then keeps later ticks quiet, as before.
    const paying = "cus_unreserved_fixture";
    billing.store.putRoleSubscription(roleRecord(paying, { subscriptionId: "sub_unreserved_fixture", lastEventType: "invoice.paid" }));
    for (let i = 0; i < 3; i++) { hosting.reconcileOwner(paying, clock); clock += 30_000; }
    const refusals = logs.filter((l) => l.includes(`refusing unreserved hosting payment for ${paying}`));
    assert.equal(refusals.length, 1);
    assert.ok(!refusals[0].includes("logged once"), "the acting path keeps its original line");
    const rejected = hosting.store.instances().filter((r) => r.ownerId === paying);
    assert.equal(rejected.length, 1); assert.equal(rejected[0].stage, "deleted"); assert.equal(rejected[0].failureReason, "unreserved_payment");
    const jobs = hosting.store.outboxFor(rejected[0].id).filter((j) => j.jobType === "billing_reconcile");
    assert.equal(jobs.length, 1); assert.equal(jobs[0].payload.reason, "unreserved-payment"); assert.equal(jobs[0].payload.subscriptionId, "sub_unreserved_fixture");
  } finally { await h.close(); }
});

summary("hosting-unreserved-quiet");
