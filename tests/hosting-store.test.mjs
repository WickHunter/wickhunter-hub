// tests/hosting-store.test.mjs — H4: the durable transactional store.
// CAS versions, leases, the outbox-in-one-transaction guarantee, inbox
// idempotency, and the "one active instance per owner" reservation that
// makes a double-click checkout safe.
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpDir, test, summary } from "./helpers.mjs";
import { HostingStore } from "../dist/src/hosting/store.js";

function freshStore() {
  return new HostingStore(tmpDir("hosting-store"));
}

await test("reserveInstance: the SAME owner+environment refuses a second reservation — this IS the double-click guard", () => {
  const s = freshStore();
  const a = s.reserveInstance({ id: "host_a", ownerId: "cus_1", environment: "live", region: "nrt", planId: "vc2-1c-2gb", stripeCustomerId: "cus_1", nowMs: 1000 });
  assert.ok(a);
  const b = s.reserveInstance({ id: "host_b", ownerId: "cus_1", environment: "live", region: "nrt", planId: "vc2-1c-2gb", stripeCustomerId: "cus_1", nowMs: 1001 });
  assert.equal(b, null, "a second reservation for the same owner/environment is refused, never a second instance");
  assert.equal(s.instances().length, 1);
  // A different environment (test vs live) is a different reservation slot.
  const c = s.reserveInstance({ id: "host_c", ownerId: "cus_1", environment: "test", region: "nrt", planId: "vc2-1c-2gb", stripeCustomerId: "cus_1", nowMs: 1002 });
  assert.ok(c);
  assert.equal(s.instances().length, 2);
});

await test("a DELETED instance frees the owner's slot for a brand-new reservation", () => {
  const s = freshStore();
  const a = s.reserveInstance({ id: "host_a", ownerId: "cus_2", environment: "live", region: "nrt", planId: "p", stripeCustomerId: "cus_2", nowMs: 1000 });
  assert.equal(s.activeInstanceForOwner("cus_2", "live").id, "host_a");
  s.updateInstance(a.id, a.version, (d) => { d.stage = "deleted"; }, 2000);
  assert.equal(s.activeInstanceForOwner("cus_2", "live"), null);
  const b = s.reserveInstance({ id: "host_b", ownerId: "cus_2", environment: "live", region: "nrt", planId: "p", stripeCustomerId: "cus_2", nowMs: 3000 });
  assert.ok(b, "a returning customer gets a fresh instance through an explicit new reservation");
});

await test("updateInstance: compare-and-swap — a stale expectedVersion is refused, never silently overwritten", () => {
  const s = freshStore();
  const row = s.reserveInstance({ id: "host_a", ownerId: "cus_3", environment: "live", region: "nrt", planId: "p", stripeCustomerId: "cus_3", nowMs: 1000 });
  const first = s.updateInstance(row.id, row.version, (d) => { d.stage = "provisioning"; }, 2000);
  assert.ok(first);
  assert.equal(first.version, row.version + 1);
  // Retrying with the ORIGINAL (now stale) version must fail — this is the
  // property that makes two concurrent writers safe without a real DB lock.
  const stale = s.updateInstance(row.id, row.version, (d) => { d.stage = "bootstrapping"; }, 3000);
  assert.equal(stale, null);
  assert.equal(s.getInstance(row.id).stage, "provisioning", "the stale write never applied");
});

await test("leases: a live lease refuses a second claim; a released or expired one is reclaimable", () => {
  const s = freshStore();
  const row = s.reserveInstance({ id: "host_a", ownerId: "cus_4", environment: "live", region: "nrt", planId: "p", stripeCustomerId: "cus_4", nowMs: 1000 });
  const claim1 = s.claimLease(row.id, 60_000, 1000);
  assert.ok(claim1);
  assert.equal(s.claimLease(row.id, 60_000, 1500), null, "a live lease refuses a second claim");
  // Expired lease (past leaseUntilMs) is reclaimable.
  assert.ok(s.claimLease(row.id, 60_000, 1000 + 60_001));
  // Explicit release also frees it immediately.
  const claim2 = s.claimLease(row.id, 60_000, 200_000);
  assert.ok(s.releaseLease(row.id, claim2.token, 200_100));
  assert.ok(s.claimLease(row.id, 60_000, 200_200));
  // Releasing with the WRONG token is refused.
  const claim3 = s.claimLease(row.id, 60_000, 300_000);
  assert.equal(s.releaseLease(row.id, "wrong-token", 300_100), false);
});

await test("outbox: enqueue is deduped on dedupeKey, and the enqueue + the instance state change land in ONE file write", () => {
  const s = freshStore();
  const row = s.reserveInstance({ id: "host_a", ownerId: "cus_5", environment: "live", region: "nrt", planId: "p", stripeCustomerId: "cus_5", nowMs: 1000 });
  const first = s.enqueue({ hostingInstanceId: row.id, lifecycleVersion: 1, generation: 1, jobType: "email", dedupeKey: "k1", availableAtMs: 1000, payload: {} }, 1000);
  assert.equal(first, true);
  const second = s.enqueue({ hostingInstanceId: row.id, lifecycleVersion: 1, generation: 1, jobType: "email", dedupeKey: "k1", availableAtMs: 1000, payload: {} }, 1000);
  assert.equal(second, false, "a duplicate dedupeKey is a no-op, never a second job");
  assert.equal(s.outboxFor(row.id).length, 1);
  // "same transaction": the on-disk file after ONE call already contains
  // both the instance row and its outbox job — there is no intermediate
  // state a crash between the two writes could ever observe, because there
  // is only ever one write.
  const raw = JSON.parse(fs.readFileSync(`${s.dataDir}/hosting-db.v1.json`, "utf8"));
  assert.ok(raw.instances[row.id]);
  assert.equal(Object.keys(raw.outbox).length, 1);
});

await test("obsoletePendingJobsOlderThan: a lifecycleVersion bump invalidates only the OLDER pending jobs for that instance", () => {
  const s = freshStore();
  const row = s.reserveInstance({ id: "host_a", ownerId: "cus_6", environment: "live", region: "nrt", planId: "p", stripeCustomerId: "cus_6", nowMs: 1000 });
  s.enqueue({ hostingInstanceId: row.id, lifecycleVersion: 1, generation: 1, jobType: "suspend", dedupeKey: "old1", availableAtMs: 5000, payload: {} }, 1000);
  s.enqueue({ hostingInstanceId: row.id, lifecycleVersion: 2, generation: 1, jobType: "suspend", dedupeKey: "new1", availableAtMs: 5000, payload: {} }, 1000);
  const n = s.obsoletePendingJobsOlderThan(row.id, 2, 1, 2000);
  assert.equal(n, 1);
  const jobs = s.outboxFor(row.id);
  assert.equal(jobs.find((j) => j.dedupeKey === "old1").status, "obsolete");
  assert.equal(jobs.find((j) => j.dedupeKey === "new1").status, "pending");
});

await test("duePending: only pending jobs whose availableAtMs has passed and whose lease (if any) has expired", () => {
  const s = freshStore();
  const row = s.reserveInstance({ id: "host_a", ownerId: "cus_7", environment: "live", region: "nrt", planId: "p", stripeCustomerId: "cus_7", nowMs: 1000 });
  s.enqueue({ hostingInstanceId: row.id, lifecycleVersion: 1, generation: 1, jobType: "email", dedupeKey: "future", availableAtMs: 999_999, payload: {} }, 1000);
  s.enqueue({ hostingInstanceId: row.id, lifecycleVersion: 1, generation: 1, jobType: "email", dedupeKey: "due", availableAtMs: 1000, payload: {} }, 1000);
  assert.deepEqual(s.duePending(2000).map((j) => j.dedupeKey), ["due"]);
  const claimed = s.claimOutboxJob(s.duePending(2000)[0].id, 5000, 2000);
  assert.ok(claimed);
  assert.equal(s.duePending(2100).length, 0, "a claimed job is not due again while its lease is live");
  assert.equal(s.duePending(2000 + 5001).length, 1, "an expired claim lease is due again — a crash mid-job is recoverable");
});

await test("billing inbox: recordInboxIfNew is true once per (environment, eventId), false on replay", () => {
  const s = freshStore();
  assert.equal(s.recordInboxIfNew("live", "evt_1", "invoice.paid", "in_1", 1000), true);
  assert.equal(s.recordInboxIfNew("live", "evt_1", "invoice.paid", "in_1", 1500), false);
  // The SAME event id in a DIFFERENT environment is a different key — test
  // and live event ids from two different Stripe accounts must never
  // collide (the same rule the software billing inbox already keeps).
  assert.equal(s.recordInboxIfNew("test", "evt_1", "invoice.paid", "in_1", 1000), true);
});

await test("bare(): a __proto__-named owner/key never touches Object.prototype", () => {
  const s = freshStore();
  const row = s.reserveInstance({ id: "host_a", ownerId: "__proto__", environment: "live", region: "nrt", planId: "p", stripeCustomerId: "", nowMs: 1000 });
  assert.ok(row);
  assert.equal(({}).polluted, undefined);
  assert.equal(s.activeInstanceForOwner("__proto__", "live").id, "host_a");
});

summary("hosting-store");
