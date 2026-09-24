import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BillingService } from "../dist/src/billing/service.js";
import { defaultBillingConfig } from "../dist/src/billing/config.js";
import { BillingStore, CHECKOUT_SESSIONS_DIR } from "../dist/src/billing/store.js";
import { LicenseStore, generateSigningKey } from "../dist/src/license.js";
import { tmpDir, test, summary } from "./helpers.mjs";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const markerPath = (dir, sessionId) => path.join(dir, CHECKOUT_SESSIONS_DIR, `${crypto.createHash("sha256").update(sessionId).digest("hex")}.json`);

function setup(prefix) {
  const dir = tmpDir(prefix);
  const licenses = new LicenseStore(dir);
  licenses.writeKey(generateSigningKey().privatePem);
  const cfg = defaultBillingConfig();
  cfg.mode = "live";
  const billing = () => new BillingService(dir, new LicenseStore(dir), "https://hub.test", path.join(process.cwd(), "templates"), { now: () => NOW, log: () => {} });
  return { dir, cfg, licenses, billing };
}

function checkout(eventId, sessionId, over = {}) {
  return {
    id: eventId,
    type: "checkout.session.completed",
    livemode: true,
    createdMs: NOW,
    object: {
      id: sessionId,
      object: "checkout.session",
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      customer: "cus_replay",
      customer_details: { email: "replay@example.com", name: "Replay" },
      subscription: null,
      payment_intent: `pi_${sessionId}`,
      metadata: { license_days: "30" },
      ...over,
    },
  };
}

await test("durable checkout markers survive charge/event cache rotation and restart", async () => {
  const { dir, cfg, licenses, billing } = setup("payment-replay-rotation");
  const svc = billing();
  await svc.applyEvent(checkout("evt_0", "cs_0"), cfg);
  const first = licenses.list()[0].exp;
  for (let i = 1; i <= 55; i++) await svc.applyEvent(checkout(`evt_${i}`, `cs_${i}`), cfg);
  const afterPurchases = licenses.list()[0].exp;
  assert.equal(afterPurchases, first + 55 * 30 * DAY);
  assert.equal(new BillingStore(dir).getCheckoutSession("cs_0")?.status, "applied");
  assert.equal(licenses.list()[0].exp, afterPurchases);

  // The bounded customer chargeIds cache has rotated the old marker out;
  // the durable session ledger remains authoritative.
  assert.equal(new BillingStore(dir).getCustomer("cus_replay").chargeIds.includes("cs:cs_0"), false);
  await billing().applyEvent(checkout("evt_0_replay", "cs_0"), cfg);
  assert.equal(licenses.list()[0].exp, afterPurchases);
});

await test("legacy charge marker is migrated without extending again", async () => {
  const { dir, cfg, licenses, billing } = setup("payment-replay-legacy");
  const svc = billing();
  await svc.applyEvent(checkout("evt_legacy", "cs_legacy"), cfg);
  const before = licenses.list()[0].exp;
  fs.rmSync(path.join(dir, CHECKOUT_SESSIONS_DIR), { recursive: true, force: true });
  await billing().applyEvent(checkout("evt_legacy_replay", "cs_legacy"), cfg);
  assert.equal(licenses.list()[0].exp, before);
  assert.equal(new BillingStore(dir).getCheckoutSession("cs_legacy")?.status, "applied");
});

await test("concurrent duplicate sessions apply one payment and different sessions remain additive", async () => {
  const { cfg, licenses, billing } = setup("payment-replay-concurrency");
  const svc = billing();
  const duplicateResults = await Promise.all(Array.from({ length: 12 }, (_, i) => svc.applyEvent(checkout(`evt_same_${i}`, "cs_same"), cfg)));
  assert.equal(licenses.list().length, 1);
  const first = licenses.list()[0].exp;
  assert.equal(duplicateResults.filter((r) => r.outcome === "applied").length, 1);
  assert.equal(duplicateResults.filter((r) => r.outcome === "duplicate").length, 11);
  await Promise.all([
    svc.applyEvent(checkout("evt_a", "cs_a"), cfg),
    svc.applyEvent(checkout("evt_b", "cs_b"), cfg),
  ]);
  assert.equal(licenses.list()[0].exp, first + 2 * 30 * DAY);
});

await test("failure before marker claim makes no license mutation", async () => {
  const { cfg, licenses, billing } = setup("payment-replay-before-marker");
  const original = BillingStore.prototype.claimCheckoutSession;
  BillingStore.prototype.claimCheckoutSession = function claimCheckoutSessionFailure() {
    throw new Error("simulated marker write failure");
  };
  try {
    await assert.rejects(() => billing().applyEvent(checkout("evt_before", "cs_before"), cfg), /simulated marker write failure/);
  } finally {
    BillingStore.prototype.claimCheckoutSession = original;
  }
  assert.equal(licenses.list().length, 0);
  await billing().applyEvent(checkout("evt_before_retry", "cs_before"), cfg);
  assert.equal(licenses.list().length, 1);
});

await test("a new-customer crash immediately after claim preserves marker facts for recovery", async () => {
  const { cfg, licenses, billing, dir } = setup("payment-replay-claim-recovery");
  const original = BillingService.prototype.ensureCustomer;
  let failBeforeCustomer = true;
  BillingService.prototype.ensureCustomer = function ensureCustomerFailure(...args) {
    if (failBeforeCustomer) {
      failBeforeCustomer = false;
      throw new Error("simulated crash after marker claim");
    }
    return original.apply(this, args);
  };
  try { await assert.rejects(() => billing().applyEvent(checkout("evt_claim_a", "cs_claim_a")), /simulated crash after marker claim/); }
  finally { BillingService.prototype.ensureCustomer = original; }
  assert.equal(licenses.list().length, 0);
  const pending = new BillingStore(dir).getCheckoutSession("cs_claim_a");
  assert.equal(pending?.customerKey, "cus_replay");
  assert.equal(pending?.targetExpMs, NOW + 30 * DAY);
  assert.equal(pending?.email, "replay@example.com");
  assert.equal(pending?.name, "Replay");
  assert.equal(pending?.livemode, true);
  assert.equal(pending?.planKey, null);
  assert.equal(pending?.paymentIntentId, "pi_cs_claim_a");
  await billing().applyEvent(checkout("evt_claim_b", "cs_claim_b"), cfg);
  const afterB = licenses.list()[0].exp;
  assert.equal(afterB, NOW + 60 * DAY);
  assert.equal(new BillingStore(dir).getCheckoutSession("cs_claim_a")?.status, "applied");
  await billing().applyEvent(checkout("evt_claim_a_retry", "cs_claim_a"), cfg);
  assert.equal(licenses.list()[0].exp, afterB);
});

await test("failure after license write leaves pending marker and retry does not double extend", async () => {
  const { cfg, licenses, billing, dir } = setup("payment-replay-after-license");
  const original = BillingStore.prototype.putCheckoutSession;
  let failCommit = true;
  BillingStore.prototype.putCheckoutSession = function putCheckoutSessionFailure(record) {
    if (failCommit && record.status === "applied") {
      failCommit = false;
      throw new Error("simulated applied-marker failure");
    }
    return original.call(this, record);
  };
  try {
    await assert.rejects(() => billing().applyEvent(checkout("evt_after", "cs_after"), cfg), /simulated applied-marker failure/);
  } finally {
    BillingStore.prototype.putCheckoutSession = original;
  }
  const afterFailure = licenses.list()[0].exp;
  assert.equal(new BillingStore(dir).getCheckoutSession("cs_after")?.status, "pending");
  await billing().applyEvent(checkout("evt_after_retry", "cs_after"), cfg);
  assert.equal(licenses.list()[0].exp, afterFailure);
  assert.equal(new BillingStore(dir).getCheckoutSession("cs_after")?.status, "applied");
});

await test("failure while binding a newly issued license remains recoverable", async () => {
  const { cfg, licenses, billing, dir } = setup("payment-replay-bind-failure");
  const original = BillingStore.prototype.putCheckoutSession;
  let failBinding = true;
  BillingStore.prototype.putCheckoutSession = function putCheckoutSessionFailure(record) {
    if (failBinding && record.status === "pending" && record.licenseId) {
      failBinding = false;
      throw new Error("simulated pending-marker binding failure");
    }
    return original.call(this, record);
  };
  try {
    await assert.rejects(() => billing().applyEvent(checkout("evt_bind", "cs_bind"), cfg), /simulated pending-marker binding failure/);
  } finally {
    BillingStore.prototype.putCheckoutSession = original;
  }
  const afterFailure = licenses.list()[0].exp;
  assert.equal(new BillingStore(dir).getCheckoutSession("cs_bind")?.licenseId, null);
  await billing().applyEvent(checkout("evt_bind_retry", "cs_bind"), cfg);
  assert.equal(licenses.list()[0].exp, afterFailure);
  assert.ok(new BillingStore(dir).getCheckoutSession("cs_bind")?.licenseId);
});

await test("a later checkout recovers a pending earlier term before applying its own", async () => {
  const { cfg, licenses, billing, dir } = setup("payment-replay-pending-order");
  const original = BillingStore.prototype.putCheckoutSession;
  let failCommit = true;
  BillingStore.prototype.putCheckoutSession = function putCheckoutSessionFailure(record) {
    if (failCommit && record.status === "applied") {
      failCommit = false;
      throw new Error("simulated delayed final write");
    }
    return original.call(this, record);
  };
  try { await assert.rejects(() => billing().applyEvent(checkout("evt_a", "cs_a")), /simulated delayed final write/); }
  finally { BillingStore.prototype.putCheckoutSession = original; }
  const afterA = licenses.list()[0].exp;
  await billing().applyEvent(checkout("evt_b", "cs_b"), cfg);
  const afterB = licenses.list()[0].exp;
  assert.equal(afterB, afterA + 30 * DAY);
  await billing().applyEvent(checkout("evt_a_retry", "cs_a"), cfg);
  assert.equal(licenses.list()[0].exp, afterB);
  assert.equal(new BillingStore(dir).getPendingCheckout("cus_replay"), null);
});

await test("customer-id and email aliases serialize the same concurrent customer", async () => {
  const { cfg, licenses, billing } = setup("payment-replay-alias-lock");
  const svc = billing();
  const customerEvent = checkout("evt_alias_customer", "cs_alias_customer", {
    customer: "cus_alias",
    customer_details: { email: "alias@example.com", name: "Alias" },
  });
  const emailEvent = checkout("evt_alias_email", "cs_alias_email", {
    customer: null,
    customer_details: { email: "alias@example.com", name: "Alias" },
  });
  await Promise.all([svc.applyEvent(customerEvent, cfg), svc.applyEvent(emailEvent, cfg)]);
  assert.equal(licenses.list().length, 1);
  assert.equal(licenses.list()[0].exp, NOW + 60 * DAY);
});

await test("checkout markers are point records and never rewrite other durable purchases", async () => {
  const { cfg, billing, dir } = setup("payment-replay-point-records");
  const svc = billing();
  for (let i = 0; i < 80; i++) await svc.applyEvent(checkout(`evt_many_${i}`, `cs_many_${i}`), cfg);
  const files = fs.readdirSync(path.join(dir, CHECKOUT_SESSIONS_DIR)).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 80);
  const mtimes = new Map(files.map((name) => [name, fs.statSync(path.join(dir, CHECKOUT_SESSIONS_DIR, name)).mtimeMs]));
  assert.equal(new BillingStore(dir).getCheckoutSession("cs_many_0")?.status, "applied");
  for (const name of files) assert.equal(fs.statSync(path.join(dir, CHECKOUT_SESSIONS_DIR, name)).mtimeMs, mtimes.get(name));
  await svc.applyEvent(checkout("evt_many_new", "cs_many_new"), cfg);
  for (const name of files) assert.equal(fs.statSync(path.join(dir, CHECKOUT_SESSIONS_DIR, name)).mtimeMs, mtimes.get(name));
});

await test("corrupt checkout ledger fails closed before payment mutation", async () => {
  const { cfg, licenses, billing, dir } = setup("payment-replay-corrupt");
  fs.mkdirSync(path.join(dir, CHECKOUT_SESSIONS_DIR), { recursive: true });
  fs.writeFileSync(markerPath(dir, "cs_bad"), "null");
  await assert.rejects(() => billing().applyEvent(checkout("evt_bad", "cs_bad")), /corrupt checkout-session marker/);
  assert.equal(licenses.list().length, 0);
});

await test("null, array, and mismatched marker records fail closed", async () => {
  for (const [label, raw, expected] of [
    ["array", "[]", /corrupt checkout-session marker/],
    ["wrong session", JSON.stringify({ sessionId: "cs_other", customerKey: "cus_replay", licenseId: null, targetExpMs: NOW, newCustomer: true, status: "pending", createdAtMs: NOW, updatedAtMs: NOW }), /corrupt checkout-session marker/],
  ]) {
    const { dir } = setup(`payment-replay-corrupt-${label}`);
    fs.mkdirSync(path.join(dir, CHECKOUT_SESSIONS_DIR), { recursive: true });
    fs.writeFileSync(markerPath(dir, "cs_bad"), raw);
    assert.throws(() => new BillingStore(dir).getCheckoutSession("cs_bad"), expected);
  }
  const { dir, cfg, billing, licenses } = setup("payment-replay-corrupt-customer");
  const svc = billing();
  await svc.applyEvent(checkout("evt_good", "cs_good"), cfg);
  const file = markerPath(dir, "cs_good");
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  rec.customerKey = "cus_other";
  fs.writeFileSync(file, JSON.stringify(rec));
  await assert.rejects(() => billing().applyEvent(checkout("evt_replay", "cs_good"), cfg), /changed customer|corrupt/);
  assert.equal(licenses.list().length, 1);
});

summary("billing-payment-replay");
