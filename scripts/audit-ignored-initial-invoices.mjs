#!/usr/bin/env node
// scripts/audit-ignored-initial-invoices.mjs — READ-ONLY audit of a Hub data
// directory for the 2026-10-09 pattern: a hosted checkout whose initial paid
// invoice the Hub discarded ("older bundle lifecycle event ignored"), and a
// hosting `software-ineligible` Stripe cancellation queued while Stripe still
// reported the subscription active and paid.
//
// It opens the data files for reading only, writes nothing anywhere, and
// never contacts Stripe or the hosting provider. Stripe facts come from the
// Hub's own reporting cache (`launch-billing-report.v1.json`), refreshed by
// the running Hub; their age is printed so a stale fact is not read as live.
//
// Usage (on the Hub box, as root or the service user; nothing is changed):
//   HUB_DATA_DIR=/opt/wickhunter-hub/data node scripts/audit-ignored-initial-invoices.mjs
//   … --json            machine-readable output instead of the text report
//   … --since=2026-10-01 ignore ledger events received before that UTC day
//   … --window=300      seconds between a checkout and the ignored invoice
//                       events that are grouped under it (default 300)
//   … --test            audit test-mode records instead of live ones
//
// The webhook ledger (`billing-events.v1.jsonl`) records event id, type,
// outcome and note but NOT the subscription, so an ignored invoice is
// attributed to a customer by time: the applied `checkout.session.completed`
// received just before it, and the customer whose record that checkout
// created or stamped within the same window. Attribution is therefore a
// candidate list, labelled as such; the Stripe dashboard event ids confirm it.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DAY = 86_400_000;
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const dataDir = process.env.HUB_DATA_DIR || "/opt/wickhunter-hub/data";
const json = args.json === true;
const livemode = args.test !== true;
const windowMs = Math.max(1, Number(args.window ?? 300)) * 1000;
const sinceMs = typeof args.since === "string" ? Date.parse(args.since + (args.since.length === 10 ? "T00:00:00Z" : "")) : 0;
if (!Number.isFinite(sinceMs)) { console.error("--since must be a UTC date like 2026-10-01"); process.exit(2); }

const IGNORED_NOTE = "older bundle lifecycle event ignored";
const INVOICE_TYPES = new Set(["invoice.paid", "invoice.payment_succeeded"]);
const ACTIVE = new Set(["active", "trialing"]);
const iso = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const notes = [];

/** Read a JSON file through a read-only descriptor; a missing file is an
 *  empty default (noted), a malformed one is an error, never a rewrite. */
function readJsonRO(name, fallback) {
  const file = path.join(dataDir, name);
  let fd;
  try { fd = fs.openSync(file, "r"); }
  catch (err) { if (err.code === "ENOENT") { notes.push(`${name}: not present`); return fallback; } throw err; }
  try { return JSON.parse(fs.readFileSync(fd, "utf8")); }
  finally { fs.closeSync(fd); }
}

/** Stream the whole webhook ledger (not the 2 MiB admin tail). */
async function readLedger() {
  const file = path.join(dataDir, "billing-events.v1.jsonl");
  if (!fs.existsSync(file)) { notes.push("billing-events.v1.jsonl: not present"); return []; }
  const out = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { flags: "r", encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn final line */ }
  }
  return out;
}

const events = (await readLedger()).filter((e) => e && typeof e.receivedAtMs === "number" && e.receivedAtMs >= sinceMs && e.livemode === livemode);
const customers = Object.values(readJsonRO("billing-customers.v1.json", {})).filter((c) => c && c.livemode === livemode);
const roles = readJsonRO("billing-role-subscriptions.v1.json", {});
const bundles = readJsonRO("billing-bundle-subscriptions.v1.json", {});
const licenses = readJsonRO("licenses.json", {});
const revoked = readJsonRO("revoked.json", { revoked: {} }).revoked ?? {};
const graceDays = readJsonRO("billing-config.v1.json", { policy: {} }).policy?.graceDays ?? null;
const hostingDb = readJsonRO("hosting-db.v1.json", { v: 1, instances: {}, resources: {}, inbox: {}, outbox: {} });
const report = readJsonRO("launch-billing-report.v1.json", { facts: [] });
const facts = (report.facts ?? []).filter((f) => f && f.mode === (livemode ? "live" : "test"));
const nowMs = Date.now();

const hostingOf = (key) => roles[`${key}::hosting`] ?? null;
const factOf = (subscriptionId) => facts.find((f) => f.subscriptionId === subscriptionId) ?? null;
const instanceOf = (ownerId) => Object.values(hostingDb.instances ?? {}).find((r) => r.ownerId === ownerId && r.environment === (livemode ? "live" : "test") && r.stage !== "deleted") ?? null;
const licenceOf = (c) => ({ exp: licenses[c.licenseId]?.exp ?? null, revoked: Object.hasOwn(revoked, c.licenseId) });

function customerState(c) {
  const host = hostingOf(c.key), lic = licenceOf(c), fact = c.subscriptionId ? factOf(c.subscriptionId) : null, row = instanceOf(c.key);
  return {
    customerKey: c.key, licenseId: c.licenseId, subscriptionId: c.subscriptionId, planKey: c.planKey ?? null,
    software: { status: c.subscriptionStatus ?? null, periodEnd: iso(c.periodEndMs), cancelAtPeriodEnd: c.cancelAtPeriodEnd === true, lastEventType: c.lastEventType ?? null, lastEventAt: iso(c.lastEventAtMs), refunded: !!c.refunded, disputed: !!c.disputed },
    licence: { exp: iso(lic.exp), lapsed: typeof lic.exp === "number" && lic.exp <= nowMs, revoked: lic.revoked },
    hosting: host ? { status: host.subscriptionStatus ?? null, periodEnd: iso(host.periodEndMs), lastEventType: host.lastEventType ?? null } : null,
    bundle: c.subscriptionId && bundles[c.subscriptionId] ? { watermark: iso(bundles[c.subscriptionId].latestEventCreatedMs), pendingStatus: bundles[c.subscriptionId].pendingStatus ?? null, terminal: !!bundles[c.subscriptionId].terminal, initialPaidPending: !!bundles[c.subscriptionId].initialPaidPending } : null,
    instance: row ? { id: row.id, stage: row.stage, cancellationReason: row.cancellationReason ?? null, suspendAt: iso(row.suspendAtMs), deleteAt: iso(row.deleteAtMs), paidThrough: iso(row.paidThroughMs), onHold: !!row.deletionHold } : null,
    stripeFact: fact ? { status: fact.status, cancelAtPeriodEnd: !!fact.cancelAtPeriodEnd, currentPeriodEnd: iso(fact.currentPeriodEndMs), updatedAt: iso(fact.updatedAtMs), ageDays: typeof fact.updatedAtMs === "number" ? +((nowMs - fact.updatedAtMs) / DAY).toFixed(2) : null } : null,
    bootstrapOnly: c.periodEndMs === null && typeof c.lastEventType === "string" && c.lastEventType.startsWith("checkout.session."),
  };
}

// ── A. ignored initial invoices, grouped under the checkout received before them
const ignoredInvoices = events.filter((e) => INVOICE_TYPES.has(e.type) && e.outcome === "ignored" && e.note === IGNORED_NOTE);
const checkouts = events.filter((e) => e.type === "checkout.session.completed" && e.outcome === "applied");
const groups = new Map();
const orphans = [];
for (const ev of ignoredInvoices) {
  const anchor = checkouts.filter((c) => c.receivedAtMs <= ev.receivedAtMs && ev.receivedAtMs - c.receivedAtMs <= windowMs).sort((a, b) => b.receivedAtMs - a.receivedAtMs)[0];
  if (!anchor) { orphans.push({ eventId: ev.id, type: ev.type, receivedAt: iso(ev.receivedAtMs) }); continue; }
  const g = groups.get(anchor.id) ?? { checkoutEventId: anchor.id, checkoutReceivedAt: iso(anchor.receivedAtMs), ignored: [], candidates: [] };
  g.ignored.push({ eventId: ev.id, type: ev.type, receivedAt: iso(ev.receivedAtMs) });
  groups.set(anchor.id, g);
}
for (const g of groups.values()) {
  const at = Date.parse(g.checkoutReceivedAt);
  g.candidates = customers
    .filter((c) => c.subscriptionId && ((typeof c.firstActualPaymentAtMs === "number" && Math.abs(c.firstActualPaymentAtMs - at) <= windowMs) || (typeof c.createdAtMs === "number" && Math.abs(c.createdAtMs - at) <= windowMs)))
    .map(customerState)
    .map((s) => ({ ...s, verdict: s.bootstrapOnly ? (s.licence.lapsed ? "BOOTSTRAP_ONLY_LAPSED" : "BOOTSTRAP_ONLY") : s.instance?.cancellationReason === "intentional_cancellation" || s.software.cancelAtPeriodEnd ? "HEALED_BUT_CANCELLATION_SCHEDULED" : "HEALED" }));
}

// ── B. software-ineligible cancellations the Hub itself queued
const cancellationJobs = Object.values(hostingDb.outbox ?? {}).filter((j) => j && j.jobType === "billing_reconcile" && j.payload?.action === "cancel" && j.payload?.reason === "software-ineligible" && j.createdAtMs >= sinceMs);
const cancellations = cancellationJobs.map((j) => {
  const row = (hostingDb.instances ?? {})[j.hostingInstanceId] ?? null;
  const owner = row?.ownerId ?? null;
  const c = owner ? customers.find((x) => x.key === owner) ?? null : null;
  const fact = factOf(String(j.payload.subscriptionId ?? ""));
  const stripeActiveAtQueue = !!fact && ACTIVE.has(fact.status) && (typeof fact.currentPeriodEndMs !== "number" || fact.currentPeriodEndMs > j.createdAtMs);
  const hubOriginatedCancellationScheduled = j.status === "sent" && !!row && row.cancellationReason === "intentional_cancellation" && (c?.cancelAtPeriodEnd === true || (hostingOf(owner ?? "")?.subscriptionStatus ?? "") === "active (cancels at period end)");
  return {
    jobId: j.id, status: j.status, queuedAt: iso(j.createdAtMs), lastAttemptAt: iso(j.updatedAtMs), attempts: j.attemptCount ?? null, lastError: j.lastErrorCode ?? null,
    subscriptionId: j.payload.subscriptionId ?? null, instanceId: j.hostingInstanceId, ownerKey: owner,
    instance: row ? { stage: row.stage, cancellationReason: row.cancellationReason ?? null, suspendAt: iso(row.suspendAtMs), deleteAt: iso(row.deleteAtMs), onHold: !!row.deletionHold } : null,
    customer: c ? customerState(c) : null,
    stripeFact: fact ? { status: fact.status, cancelAtPeriodEnd: !!fact.cancelAtPeriodEnd, currentPeriodEnd: iso(fact.currentPeriodEndMs), updatedAt: iso(fact.updatedAtMs) } : null,
    flags: { stripeActiveAtQueue, hubOriginatedCancellationScheduled, noStripeFact: !fact },
  };
});

// ── C. customers still on a bootstrap-only grant (the state that lapses)
const bootstrapOnly = customers.filter((c) => c.subscriptionId && !licenceOf(c).revoked && c.periodEndMs === null && typeof c.lastEventType === "string" && c.lastEventType.startsWith("checkout.session."))
  .map(customerState).map((s) => ({ ...s, verdict: s.licence.lapsed ? "LAPSED_WHILE_SUBSCRIBED" : s.stripeFact && !ACTIVE.has(s.stripeFact.status) ? "STRIPE_NOT_ACTIVE" : "AT_RISK_UNTIL_PAID_PERIOD_APPLIED" }));

const summary = {
  dataDir, mode: livemode ? "live" : "test", generatedAt: iso(nowMs), graceDays, since: sinceMs ? iso(sinceMs) : null, windowSeconds: windowMs / 1000,
  ledgerEvents: events.length, ignoredInitialInvoiceEvents: ignoredInvoices.length, ignoredInvoiceGroups: groups.size, orphanIgnoredInvoices: orphans.length,
  softwareIneligibleCancellations: cancellations.length,
  cancellationsWhileStripeActive: cancellations.filter((x) => x.flags.stripeActiveAtQueue).length,
  hubOriginatedCancellationsScheduled: cancellations.filter((x) => x.flags.hubOriginatedCancellationScheduled).length,
  bootstrapOnlyCustomers: bootstrapOnly.length, bootstrapOnlyLapsed: bootstrapOnly.filter((x) => x.verdict === "LAPSED_WHILE_SUBSCRIBED").length,
  notes,
};
const result = { summary, ignoredInitialInvoices: [...groups.values()], orphanIgnoredInvoices: orphans, softwareIneligibleCancellations: cancellations, bootstrapOnly };

if (json) { process.stdout.write(JSON.stringify(result, null, 2) + "\n"); process.exit(0); }

const line = (s = "") => process.stdout.write(s + "\n");
line(`Hub billing audit (read-only) — ${summary.mode} — ${summary.generatedAt} — ${dataDir}`);
line(`ledger events considered: ${summary.ledgerEvents}${summary.since ? ` since ${summary.since}` : ""}; graceDays ${graceDays ?? "unknown"}; window ${summary.windowSeconds}s`);
for (const n of notes) line(`note: ${n}`);
line();
line(`A. invoice events discarded as "${IGNORED_NOTE}": ${summary.ignoredInitialInvoiceEvents} in ${summary.ignoredInvoiceGroups} checkout group(s), ${summary.orphanIgnoredInvoices} without a checkout in the window`);
for (const g of groups.values()) {
  line(`  checkout ${g.checkoutEventId} received ${g.checkoutReceivedAt}`);
  for (const i of g.ignored) line(`    ignored ${i.type} ${i.eventId} received ${i.receivedAt}`);
  if (!g.candidates.length) line("    candidate customer: none within the window (attribute from the Stripe dashboard by event id)");
  for (const s of g.candidates) line(`    candidate ${s.customerKey} licence ${s.licenseId} sub ${s.subscriptionId} → ${s.verdict}; software ${s.software.status} paid-through ${s.software.periodEnd ?? "null"} exp ${s.licence.exp}${s.instance ? `; VPS ${s.instance.id} ${s.instance.stage}${s.instance.cancellationReason ? ` (${s.instance.cancellationReason}, suspend ${s.instance.suspendAt}, delete ${s.instance.deleteAt})` : ""}` : ""}${s.stripeFact ? `; Stripe ${s.stripeFact.status}${s.stripeFact.cancelAtPeriodEnd ? " cancel_at_period_end" : ""} to ${s.stripeFact.currentPeriodEnd} (fact ${s.stripeFact.ageDays}d old)` : "; no Stripe fact"}`);
}
for (const o of orphans) line(`  orphan ignored ${o.type} ${o.eventId} received ${o.receivedAt}`);
line();
line(`B. software-ineligible Stripe cancellations queued by the Hub: ${summary.softwareIneligibleCancellations} (${summary.cancellationsWhileStripeActive} while Stripe reported active/paid; ${summary.hubOriginatedCancellationsScheduled} now mirrored as the customer's own cancellation)`);
for (const x of cancellations) line(`  job ${x.jobId} ${x.status} queued ${x.queuedAt} sub ${x.subscriptionId} owner ${x.ownerKey ?? "?"} VPS ${x.instanceId} ${x.instance?.stage ?? "?"}${x.instance?.cancellationReason ? ` (${x.instance.cancellationReason}, suspend ${x.instance.suspendAt}, delete ${x.instance.deleteAt})` : ""}; software ${x.customer?.software.status ?? "?"} exp ${x.customer?.licence.exp ?? "?"}; Stripe ${x.stripeFact ? `${x.stripeFact.status}${x.stripeFact.cancelAtPeriodEnd ? " cancel_at_period_end" : ""} to ${x.stripeFact.currentPeriodEnd}` : "no fact"}; flags ${Object.entries(x.flags).filter(([, v]) => v).map(([k]) => k).join(",") || "none"}`);
line();
line(`C. customers still on a bootstrap-only grant (no paid-through applied): ${summary.bootstrapOnlyCustomers} (${summary.bootstrapOnlyLapsed} already lapsed while their subscription is active)`);
for (const s of bootstrapOnly) line(`  ${s.customerKey} licence ${s.licenseId} sub ${s.subscriptionId} exp ${s.licence.exp} software ${s.software.status} → ${s.verdict}${s.stripeFact ? `; Stripe ${s.stripeFact.status} to ${s.stripeFact.currentPeriodEnd}` : "; no Stripe fact"}`);
line();
line("Nothing was written. Repair path for a short licence: POST /admin/api/licenses/expiry {id, exp: paidThrough + graceDays}; a Hub-originated cancellation is reversed by the customer's Resume renewal action (or Stripe cancel_at_period_end=false plus the instance reset it performs).");
