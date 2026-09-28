import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { freshStore, test, summary } from "./helpers.mjs";
import { BillingService } from "../dist/src/billing/service.js";
import { AfterCommitOutbox } from "../dist/src/billing/after-commit-outbox.js";
import { signStripePayload } from "../dist/src/billing/stripe.js";

const { store, dataDir } = freshStore();
const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates");
const secret = "whsec_outbox_fixture";
const now = Math.floor(Date.now() / 1000) * 1000;
const event = (id, type = "invoice.paid") => ({
  id, object: "event", type, livemode: false, created: now / 1000,
  data: { object: {
    id: "in_" + id, object: "invoice", customer: "cus_outbox", customer_email: "outbox@example.com",
    customer_name: "Outbox Customer", subscription: "sub_outbox", paid: true, status: "paid",
    lines: { data: [{ period: { start: now / 1000, end: now / 1000 + 30 * 86_400 } }] },
  } },
});
const service = (hook) => {
  const svc = new BillingService(dataDir, store, "https://hub.test/hub", templates, {
    now: () => now, onVerifiedEvent: hook, log: () => {},
  });
  svc.updateConfig({ stripe: { test: { webhookSecret: secret } } });
  return svc;
};
const deliver = (svc, wire) => {
  const raw = Buffer.from(JSON.stringify(wire));
  return svc.handleWebhook("test", raw, { "stripe-signature": signStripePayload(raw, secret, now / 1000) });
};

await test("applied core event acknowledges before blocked Earn work and survives a restart", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const first = service(async () => { calls++; await blocked; });
  const wire = event("evt_outbox_applied");
  const reply = await deliver(first, wire);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.outcome, "applied");
  assert.equal(first.store.seenEvent(wire.id), true);
  assert.equal(store.list().length, 1, "core licence mutation completed before acknowledgement");
  assert.equal(calls, 0, "Earn hook is not awaited in the webhook");
  const pending = new AfterCommitOutbox(dataDir).pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].committed, true);
  const restarted = service(async () => { calls++; });
  assert.deepEqual(await restarted.drainAfterCommit(), { completed: 1, failed: 0 });
  assert.equal(calls, 1);
  assert.equal(new AfterCommitOutbox(dataDir).pending().length, 0);
  assert.equal(store.list().length, 1, "restart did not reapply core billing");
  release();
});

await test("a staged but uncommitted event cannot run Earn until core truth is seen", async () => {
  const wire = event("evt_outbox_staged");
  const parsed = { id: wire.id, type: wire.type, livemode: wire.livemode, createdMs: now, object: wire.data.object };
  new AfterCommitOutbox(dataDir).stage(parsed, now);
  let calls = 0;
  const restarted = service(async () => { calls++; });
  assert.deepEqual(await restarted.drainAfterCommit(), { completed: 0, failed: 0 });
  assert.equal(calls, 0);
  assert.equal((await deliver(restarted, wire)).status, 200);
  assert.deepEqual(await restarted.drainAfterCommit(), { completed: 1, failed: 0 });
  assert.equal(calls, 1);
});

await test("crash after core seen marker but before outbox promotion recovers Earn", async () => {
  const wire = event("evt_outbox_promote", "charge.dispute.closed");
  const parsed = { id: wire.id, type: wire.type, livemode: wire.livemode, createdMs: now, object: wire.data.object };
  const outbox = new AfterCommitOutbox(dataDir);
  outbox.stage(parsed, now);
  const svc = service(async () => {});
  svc.store.markSeen(wire.id, now);
  let calls = 0;
  const restarted = service(async () => { calls++; });
  assert.deepEqual(await restarted.drainAfterCommit(), { completed: 1, failed: 0 });
  assert.equal(calls, 1);
  assert.equal(outbox.pending().length, 0);
});

await test("failed Earn work remains durable; a later pass retries only the hook", async () => {
  const wire = event("evt_outbox_retry");
  let calls = 0;
  const svc = service(async () => { calls++; throw new Error("temporary provider outage"); });
  const before = store.list().length;
  assert.equal((await deliver(svc, wire)).status, 200);
  assert.deepEqual(await svc.drainAfterCommit(), { completed: 0, failed: 1 });
  assert.equal(new AfterCommitOutbox(dataDir).pending().length, 1);
  const restarted = service(async () => { calls++; });
  assert.deepEqual(await restarted.drainAfterCommit(), { completed: 1, failed: 0 });
  assert.equal(calls, 2);
  assert.equal(store.list().length, before);
});

await test("an outbox conflict fails before core mutation", async () => {
  const wire = event("evt_outbox_conflict");
  const other = { id: wire.id, type: wire.type, livemode: false, createdMs: now, object: { id: "different" } };
  new AfterCommitOutbox(dataDir).stage(other, now);
  const svc = service(async () => {});
  const before = store.list().length;
  const reply = await deliver(svc, wire);
  assert.equal(reply.status, 500);
  assert.equal(svc.store.seenEvent(wire.id), false);
  assert.equal(store.list().length, before);
});

summary("billing-after-commit-outbox");
