// tests/audit-ignored-initial-invoices.test.mjs — the read-only data-directory
// audit (scripts/audit-ignored-initial-invoices.mjs) against an offline
// fixture shaped like the 2026-10-09 record set, an empty directory, and a
// hermetic hub's own data directory. It proves the script finds the pattern,
// attributes it, and writes nothing. Identifiers are fixture values.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { freshHub, tmpDir, test, summary } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "audit-ignored-initial-invoices.mjs");

function run(dataDir, ...flags) {
  const r = spawnSync(process.execPath, [SCRIPT, ...flags], { env: { ...process.env, HUB_DATA_DIR: dataDir }, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: flags.includes("--json") && r.status === 0 ? JSON.parse(r.stdout) : null };
}
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = createHash("sha256").update(fs.readFileSync(f)).digest("hex") + ":" + fs.statSync(f).mtimeMs; } };
  walk(dir); return out;
}

const T = {
  checkout: Date.parse("2026-10-06T03:39:59Z"), invoicesReceived: Date.parse("2026-10-06T03:40:00Z"),
  lapseTick: Date.parse("2026-10-09T03:40:15Z"), echo: Date.parse("2026-10-09T03:40:16Z"),
  periodEnd: Date.parse("2026-11-06T03:39:55Z"), exp: Date.parse("2026-11-09T03:39:55Z"), deleteAt: Date.parse("2026-11-13T03:39:55Z"),
  now: Date.now(),
};

/** A data directory shaped like the incident's durable records, with
 *  fixture identifiers: one affected bundle customer (healed licence,
 *  Hub-originated cancellation scheduled), one healthy renewing customer,
 *  one bootstrap-only customer whose grant has not lapsed yet. */
function incidentFixture() {
  const dir = tmpDir("audit-fixture");
  const w = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  const ev = (id, type, receivedAtMs, outcome, note) => JSON.stringify({ id, type, livemode: true, receivedAtMs, outcome, note });
  w("billing-events.v1.jsonl", [
    ev("evt_fx_checkout", "checkout.session.completed", T.checkout, "applied", "bundle software: licence issued (monthly); hosting: hosting checkout recorded; software licence untouched"),
    ev("evt_fx_paid", "invoice.paid", T.invoicesReceived, "ignored", "older bundle lifecycle event ignored"),
    ev("evt_fx_succeeded", "invoice.payment_succeeded", T.invoicesReceived, "ignored", "older bundle lifecycle event ignored"),
    ev("evt_fx_charge", "charge.succeeded", T.invoicesReceived, "unclassified", "charge.succeeded: could not attribute this event to a product role"),
    ev("evt_fx_healthy_checkout", "checkout.session.completed", T.checkout + 3 * 86_400_000, "applied", "licence issued (monthly)"),
    ev("evt_fx_healthy_paid", "invoice.paid", T.checkout + 3 * 86_400_000 + 1000, "applied", "licence extended to 2026-11-12"),
    ev("evt_fx_echo", "customer.subscription.updated", T.echo, "applied", "bundle software: status active (cancels at period end); licence extended; hosting: hosting status updated; software licence untouched"),
    ev("evt_fx_old_alias", "invoice.payment_succeeded", T.checkout - 40 * 86_400_000, "ignored", "older bundle lifecycle event ignored"),
    "",
  ].join("\n"));
  const customer = (key, over) => ({ key, stripeCustomerId: key, email: `${key}@example.test`, name: "", livemode: true, licenseId: `lic_${key}`, planKey: "monthly", chargeIds: [], disputed: false, refunded: false, welcomeSentAtMs: null, welcomeError: null, ...over });
  w("billing-customers.v1.json", {
    cus_fx_affected: customer("cus_fx_affected", { subscriptionId: "sub_fx_affected", subscriptionStatus: "active (cancels at period end)", periodEndMs: T.periodEnd, cancelAtPeriodEnd: true, createdAtMs: T.checkout, updatedAtMs: T.echo, lastEventType: "customer.subscription.updated", lastEventAtMs: T.echo, firstActualPaymentAtMs: T.checkout, launchManaged: true, discountPercent: 40 }),
    cus_fx_healthy: customer("cus_fx_healthy", { subscriptionId: "sub_fx_healthy", subscriptionStatus: "active", periodEndMs: T.periodEnd + 3 * 86_400_000, createdAtMs: T.checkout + 3 * 86_400_000, updatedAtMs: T.checkout + 3 * 86_400_000 + 1000, lastEventType: "invoice.paid", lastEventAtMs: T.checkout + 3 * 86_400_000 + 1000, firstActualPaymentAtMs: T.checkout + 3 * 86_400_000 }),
    cus_fx_bootstrap: customer("cus_fx_bootstrap", { subscriptionId: "sub_fx_bootstrap", subscriptionStatus: "active", periodEndMs: null, createdAtMs: T.now - 3_600_000, updatedAtMs: T.now - 3_600_000, lastEventType: "checkout.session.completed", lastEventAtMs: T.now - 3_600_000, firstActualPaymentAtMs: T.now - 3_600_000, launchManaged: true }),
    cus_fx_test: customer("cus_fx_test", { livemode: false, subscriptionId: "sub_fx_test", subscriptionStatus: "active", periodEndMs: null, createdAtMs: T.checkout, updatedAtMs: T.checkout, lastEventType: "checkout.session.completed", lastEventAtMs: T.checkout }),
  });
  w("billing-role-subscriptions.v1.json", {
    "cus_fx_affected::hosting": { key: "cus_fx_affected::hosting", customerKey: "cus_fx_affected", role: "hosting", livemode: true, subscriptionId: "sub_fx_affected", subscriptionStatus: "active (cancels at period end)", periodEndMs: T.periodEnd, chargeIds: [], disputed: false, refunded: false, createdAtMs: T.checkout, updatedAtMs: T.echo, lastEventType: "customer.subscription.updated", lastEventAtMs: T.echo },
  });
  w("billing-bundle-subscriptions.v1.json", { sub_fx_affected: { subscriptionId: "sub_fx_affected", reservationId: "host_fx_affected", customerId: "cus_fx_affected", planKey: "monthly", priceId: "price_fx_monthly", launchIntentId: "a".repeat(64), latestEventCreatedMs: T.echo, pendingStatus: null, terminal: false, updatedAtMs: T.echo } });
  w("licenses.json", { lic_cus_fx_affected: { v: 1, id: "lic_cus_fx_affected", iat: T.checkout, exp: T.exp }, lic_cus_fx_healthy: { v: 1, id: "lic_cus_fx_healthy", iat: T.checkout, exp: T.periodEnd + 6 * 86_400_000 }, lic_cus_fx_bootstrap: { v: 1, id: "lic_cus_fx_bootstrap", iat: T.now - 3_600_000, exp: T.now - 3_600_000 + 3 * 86_400_000 }, lic_cus_fx_test: { v: 1, id: "lic_cus_fx_test", iat: T.checkout, exp: T.exp } });
  w("revoked.json", { revoked: {} });
  w("billing-config.v1.json", { v: 1, mode: "live", policy: { graceDays: 3, bootstrapDays: 3 } });
  w("hosting-db.v1.json", {
    v: 1, resources: {}, inbox: {},
    instances: { host_fx_affected: { id: "host_fx_affected", ownerId: "cus_fx_affected", environment: "live", region: "nrt", planId: "vc2-1c-2gb", stage: "cancel_scheduled", cancellationReason: "intentional_cancellation", suspendAtMs: T.periodEnd, deleteAtMs: T.deleteAt, paidThroughMs: T.periodEnd, stripeCustomerId: "cus_fx_affected", stripeSubscriptionId: "sub_fx_affected", providerInstanceId: "provider-fx", deletionHold: null, lifecycleVersion: 3, generation: 1, version: 9, createdAtMs: T.checkout, updatedAtMs: T.echo } },
    outbox: {
      job_fx_cancel: { id: "job_fx_cancel", hostingInstanceId: "host_fx_affected", lifecycleVersion: 2, generation: 1, jobType: "billing_reconcile", dedupeKey: "stripe-cancel:host_fx_affected:sub_fx_affected:software-ineligible", availableAtMs: T.lapseTick, payload: { subscriptionId: "sub_fx_affected", action: "cancel", reason: "software-ineligible" }, status: "sent", attemptCount: 1, leaseUntilMs: null, providerMessageId: null, lastErrorCode: null, createdAtMs: T.lapseTick, updatedAtMs: T.lapseTick + 1000 },
      job_fx_email: { id: "job_fx_email", hostingInstanceId: "host_fx_affected", lifecycleVersion: 3, generation: 1, jobType: "email", dedupeKey: "email:cancel_scheduled:host_fx_affected:v3", availableAtMs: T.echo, payload: { template: "cancellation_scheduled" }, status: "sent", attemptCount: 1, leaseUntilMs: null, providerMessageId: "m1", lastErrorCode: null, createdAtMs: T.echo, updatedAtMs: T.echo + 30_000 },
      job_fx_other: { id: "job_fx_other", hostingInstanceId: "host_other", lifecycleVersion: 1, generation: 1, jobType: "billing_reconcile", dedupeKey: "stripe-cancel:host_other:sub_other:unreserved-payment", availableAtMs: T.checkout, payload: { subscriptionId: "sub_other", action: "cancel", reason: "unreserved-payment" }, status: "sent", attemptCount: 1, leaseUntilMs: null, providerMessageId: null, lastErrorCode: null, createdAtMs: T.checkout, updatedAtMs: T.checkout },
    },
  });
  w("launch-billing-report.v1.json", { schema: 1, signupSent: {}, lastRefreshAtMs: { live: T.now - 600_000 }, lastRefreshError: {}, facts: [
    { mode: "live", customerId: "cus_fx_affected", subscriptionId: "sub_fx_affected", plan: "monthly", status: "active", cancelAtPeriodEnd: true, currentPeriodEndMs: T.periodEnd, firstPaymentAtMs: null, discountPercent: 40, currency: "usd", grossMrrMinor: 7940, netMrrMinor: 7940, linesKnown: true, updatedAtMs: T.now - 600_000 },
    { mode: "live", customerId: "cus_fx_healthy", subscriptionId: "sub_fx_healthy", plan: "monthly", status: "active", cancelAtPeriodEnd: false, currentPeriodEndMs: T.periodEnd + 3 * 86_400_000, firstPaymentAtMs: null, discountPercent: null, currency: "usd", grossMrrMinor: 9900, netMrrMinor: 9900, linesKnown: true, updatedAtMs: T.now - 600_000 },
    { mode: "live", customerId: "cus_fx_bootstrap", subscriptionId: "sub_fx_bootstrap", plan: "monthly", status: "active", cancelAtPeriodEnd: false, currentPeriodEndMs: T.now + 29 * 86_400_000, firstPaymentAtMs: null, discountPercent: null, currency: "usd", grossMrrMinor: 9900, netMrrMinor: 9900, linesKnown: true, updatedAtMs: T.now - 600_000 },
  ] });
  return dir;
}

await test("the incident-shaped fixture: the two ignored invoice events are grouped under their checkout and attributed; the Hub-originated cancellation is flagged as queued while Stripe was active and now scheduled as the customer's own; the bootstrap-only row is listed", async () => {
  const dir = incidentFixture();
  const before = snapshot(dir);
  const r = run(dir, "--json");
  assert.equal(r.status, 0, r.stderr);
  const { summary: s, ignoredInitialInvoices, orphanIgnoredInvoices, softwareIneligibleCancellations, bootstrapOnly } = r.json;
  assert.equal(s.mode, "live"); assert.equal(s.graceDays, 3); assert.equal(s.ledgerEvents, 8);
  assert.equal(s.ignoredInitialInvoiceEvents, 3); assert.equal(s.ignoredInvoiceGroups, 1); assert.equal(s.orphanIgnoredInvoices, 1, "the old alias with no checkout in the window is reported separately, never attributed");
  assert.equal(ignoredInitialInvoices[0].checkoutEventId, "evt_fx_checkout");
  assert.deepEqual(ignoredInitialInvoices[0].ignored.map((i) => i.eventId).sort(), ["evt_fx_paid", "evt_fx_succeeded"]);
  assert.equal(ignoredInitialInvoices[0].candidates.length, 1);
  const cand = ignoredInitialInvoices[0].candidates[0];
  assert.equal(cand.customerKey, "cus_fx_affected"); assert.equal(cand.subscriptionId, "sub_fx_affected"); assert.equal(cand.verdict, "HEALED_BUT_CANCELLATION_SCHEDULED");
  assert.equal(cand.licence.exp, "2026-11-09T03:39:55.000Z"); assert.equal(cand.software.periodEnd, "2026-11-06T03:39:55.000Z"); assert.equal(cand.software.cancelAtPeriodEnd, true);
  assert.equal(cand.instance.stage, "cancel_scheduled"); assert.equal(cand.instance.deleteAt, "2026-11-13T03:39:55.000Z"); assert.equal(cand.bundle.watermark, "2026-10-09T03:40:16.000Z");
  assert.equal(orphanIgnoredInvoices[0].eventId, "evt_fx_old_alias");
  assert.equal(s.softwareIneligibleCancellations, 1, "the unreserved-payment cancellation is a different thing and is not counted");
  const job = softwareIneligibleCancellations[0];
  assert.equal(job.jobId, "job_fx_cancel"); assert.equal(job.status, "sent"); assert.equal(job.queuedAt, "2026-10-09T03:40:15.000Z"); assert.equal(job.ownerKey, "cus_fx_affected");
  assert.deepEqual(job.flags, { stripeActiveAtQueue: true, hubOriginatedCancellationScheduled: true, noStripeFact: false });
  assert.equal(s.cancellationsWhileStripeActive, 1); assert.equal(s.hubOriginatedCancellationsScheduled, 1);
  assert.equal(s.bootstrapOnlyCustomers, 1); assert.equal(bootstrapOnly[0].customerKey, "cus_fx_bootstrap"); assert.equal(bootstrapOnly[0].verdict, "AT_RISK_UNTIL_PAID_PERIOD_APPLIED"); assert.equal(s.bootstrapOnlyLapsed, 0);
  assert.ok(!JSON.stringify(r.json).includes("cus_fx_test"), "test-mode records are out of a live audit");
  const text = run(dir);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /A\. invoice events discarded .*: 3 in 1 checkout group\(s\), 1 without a checkout/);
  assert.match(text.stdout, /B\. software-ineligible Stripe cancellations queued by the Hub: 1 \(1 while Stripe reported active\/paid; 1 now mirrored/);
  assert.match(text.stdout, /HEALED_BUT_CANCELLATION_SCHEDULED/); assert.match(text.stdout, /Nothing was written/);
  assert.deepEqual(snapshot(dir), before, "the audit wrote nothing and touched no file");
  const sinceRun = run(dir, "--json", "--since=2026-10-09");
  assert.equal(sinceRun.json.summary.ignoredInitialInvoiceEvents, 0, "--since bounds the ledger scan"); assert.equal(sinceRun.json.summary.softwareIneligibleCancellations, 1);
  const testRun = run(dir, "--json", "--test");
  assert.equal(testRun.json.summary.bootstrapOnlyCustomers, 1); assert.equal(testRun.json.bootstrapOnly[0].customerKey, "cus_fx_test");
});

await test("an empty data directory and a hermetic hub's own data directory both audit clean, read-only", async () => {
  const empty = tmpDir("audit-empty");
  const r = run(empty, "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.summary.ignoredInitialInvoiceEvents, 0); assert.equal(r.json.summary.softwareIneligibleCancellations, 0); assert.equal(r.json.summary.bootstrapOnlyCustomers, 0);
  assert.ok(r.json.summary.notes.some((n) => n.startsWith("billing-events.v1.jsonl: not present")));
  assert.deepEqual(fs.readdirSync(empty), [], "nothing was created");
  const h = await freshHub({}, { billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }) });
  try {
    const before = snapshot(h.dataDir);
    const hub = run(h.dataDir, "--json");
    assert.equal(hub.status, 0, hub.stderr);
    assert.equal(hub.json.summary.ignoredInitialInvoiceEvents + hub.json.summary.softwareIneligibleCancellations + hub.json.summary.bootstrapOnlyCustomers, 0);
    assert.deepEqual(snapshot(h.dataDir), before);
  } finally { await h.close(); }
  assert.equal(run(empty, "--since=not-a-date").status, 2, "a malformed --since refuses instead of scanning everything");
});

summary("audit-ignored-initial-invoices");
