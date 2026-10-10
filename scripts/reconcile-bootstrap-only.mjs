#!/usr/bin/env node
// scripts/reconcile-bootstrap-only.mjs — operator bulk driver for the Hub's
// "reconcile subscription from Stripe" (Hub >= 0.4.94):
//   POST /admin/api/billing/reconcile-subscription
//
// DRY RUN BY DEFAULT. Nothing is written unless --apply is given, and an
// apply also needs --by and --reason (both land in the billing audit
// ledger). Exclusions are filtered out BEFORE any request, so an excluded
// customer or subscription is never sent to the Hub and never read from
// Stripe.
//
// This script never opens the data directory and never talks to Stripe
// itself. Every read and write is the running Hub's own, through its admin
// API: the Hub owns its data files while it runs (two writers would lose
// updates), and the Hub's Stripe client and secret key never leave it. The
// only secret here is the admin token, read from the environment or the
// Hub's env file and sent as `x-hub-admin` to the local Hub; it is never
// printed.
//
// Usage (on the Hub box, as root so /etc/wickhunter-hub/env is readable):
//   node scripts/reconcile-bootstrap-only.mjs --from-audit=/root/audit-….json            # dry run
//   node scripts/reconcile-bootstrap-only.mjs --from-audit=/root/audit-….json \
//        --exclude=cus_…,cus_… --apply --by=<initials> --reason="<why>"                  # writes
//
// Targets (one of):
//   --from-audit=<file>     the `bootstrapOnly` list of
//                           `scripts/audit-ignored-initial-invoices.mjs --json`
//   --all                   every billing customer of the mode (live unless --test)
//   --subscriptions=sub_…,… explicit subscription ids
//   --customers=cus_…,…     explicit customer keys
// Options:
//   --exclude=cus_…,sub_…   never sent, never read from Stripe (verdict EXCLUDED)
//   --apply --by=… --reason=…
//   --json                  machine-readable rows + summary
//   --hub=http://127.0.0.1:8091  (default: HUB_URL, else 127.0.0.1 and HUB_PORT from the env file, else 8091)
//   --env-file=/etc/wickhunter-hub/env  (HUB_ADMIN_TOKEN from the environment wins)
//   --test                  with --all: test-mode customers instead of live
//
// Exit status: 0 when every row got an answer (applied, would apply, nothing
// to apply, needs review, excluded, skipped); 1 when a row failed (Stripe
// unreadable, Hub unreachable, bad request); 2 on a usage error.
import fs from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const usage = (msg) => { console.error(`reconcile-bootstrap-only: ${msg}`); process.exit(2); };
const list = (v) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
const apply = args.apply === true;
const json = args.json === true;
const by = typeof args.by === "string" ? args.by.trim() : "";
const reason = typeof args.reason === "string" ? args.reason.trim() : "";
if (apply && (!by || !reason)) usage("--apply needs --by=<who> and --reason=<why> (they are written to the billing audit ledger)");
const exclude = new Set(list(args.exclude));
for (const id of exclude) if (!/^(cus|sub)_[A-Za-z0-9_]+$/.test(id) && !id.startsWith("email:")) usage(`--exclude entry ${JSON.stringify(id)} is not a cus_…/sub_… id`);

function envFileValue(file, name) {
  try { return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).replace(/^["']|["']$/g, "") ?? ""; }
  catch { return ""; }
}
const envFile = typeof args["env-file"] === "string" ? args["env-file"] : "/etc/wickhunter-hub/env";
const token = process.env.HUB_ADMIN_TOKEN || envFileValue(envFile, "HUB_ADMIN_TOKEN");
if (!token) usage(`no admin token: set HUB_ADMIN_TOKEN or make ${envFile} readable (run as root)`);
const hub = (typeof args.hub === "string" ? args.hub : process.env.HUB_URL || `http://127.0.0.1:${envFileValue(envFile, "HUB_PORT") || 8091}`).replace(/\/+$/, "");

async function call(method, p, body) {
  const res = await fetch(hub + p, { method, headers: { "x-hub-admin": token, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

// ── targets ──
const targets = [];
const add = (customerKey, subscriptionId, source) => {
  if (targets.some((t) => (subscriptionId && t.subscriptionId === subscriptionId) || (!subscriptionId && customerKey && t.customerKey === customerKey))) return;
  targets.push({ customerKey: customerKey || null, subscriptionId: subscriptionId || null, source });
};
const sources = ["from-audit", "all", "subscriptions", "customers"].filter((k) => args[k] !== undefined);
if (sources.length !== 1) usage("name exactly one target source: --from-audit=<file>, --all, --subscriptions=… or --customers=…");
if (typeof args["from-audit"] === "string") {
  let audit;
  try { audit = JSON.parse(fs.readFileSync(args["from-audit"], "utf8")); } catch (err) { usage(`cannot read the audit JSON: ${err.message}`); }
  if (!Array.isArray(audit?.bootstrapOnly)) usage("the audit JSON has no bootstrapOnly list (run the audit with --json)");
  for (const row of audit.bootstrapOnly) add(row?.customerKey, row?.subscriptionId, "audit");
} else if (args.all === true) {
  const r = await call("GET", "/admin/api/billing/customers").catch((err) => usage(`the Hub at ${hub} is unreachable: ${err.message}`));
  if (r.status !== 200 || !Array.isArray(r.body?.customers)) usage(`GET /admin/api/billing/customers answered ${r.status}`);
  const livemode = args.test !== true;
  for (const c of r.body.customers) if (c.livemode === livemode) add(c.customerId, c.subscriptionId, "customers");
} else if (args.subscriptions !== undefined) {
  for (const id of list(args.subscriptions)) { if (!/^sub_[A-Za-z0-9_]+$/.test(id)) usage(`${id} is not a sub_… id`); add(null, id, "argument"); }
} else {
  for (const id of list(args.customers)) add(id, null, "argument");
}

// ── one request per target, sequentially ──
const iso = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "null");
const rows = [];
for (const t of targets) {
  if ((t.customerKey && exclude.has(t.customerKey)) || (t.subscriptionId && exclude.has(t.subscriptionId))) {
    rows.push({ ...t, verdict: "EXCLUDED", needsReview: false, changed: false, note: "on the --exclude list; not sent to the Hub, not read from Stripe" });
    continue;
  }
  if (!t.subscriptionId && t.source !== "argument") {
    rows.push({ ...t, verdict: "NO_SUBSCRIPTION", needsReview: false, changed: false, note: "no Stripe subscription is bound to this customer (Lifetime, one-time or complimentary); there is no paid term to reconcile — skipped" });
    continue;
  }
  const body = { ...(t.subscriptionId ? { subscriptionId: t.subscriptionId } : { customerId: t.customerKey }), dryRun: !apply, ...(apply ? { by, reason } : {}) };
  try {
    const r = await call("POST", "/admin/api/billing/reconcile-subscription", body);
    if (!r.body || typeof r.body.verdict !== "string") rows.push({ ...t, verdict: "HUB_ERROR", error: true, needsReview: false, changed: false, note: `the Hub answered ${r.status} without a verdict${r.body?.error ? `: ${r.body.error}` : ""}` });
    else rows.push({ ...t, ...r.body, customerKey: r.body.customerKey ?? t.customerKey, subscriptionId: r.body.subscriptionId ?? t.subscriptionId, httpStatus: r.status, error: r.status >= 400 && r.status !== 404 && r.status !== 409 });
  } catch (err) {
    rows.push({ ...t, verdict: "HUB_UNREACHABLE", error: true, needsReview: false, changed: false, note: `request failed: ${err.message}` });
  }
}

// ── report ──
const change = (c, label, fmt = iso) => (!c ? `${label} ?` : c.changed ? `${label} ${fmt(c.before)}→${fmt(c.after)}` : `${label} ${fmt(c.before)} unchanged`);
function line(r) {
  const head = `${r.customerKey ?? "?"} ${r.subscriptionId ?? "-"} → ${r.needsReview ? `NEEDS OPERATOR REVIEW (${r.verdict})` : r.verdict}`;
  const s = r.stripe;
  const stripe = s ? `Stripe ${s.status}${s.cancelAtPeriodEnd ? " cancel_at_period_end" : ""} current_period_end ${iso(s.currentPeriodEndMs)}; ${s.paidInvoice ? `paid invoice ${s.paidInvoice.id} ${s.paidInvoice.billingReason} ${s.paidInvoice.amountPaid} ${s.paidInvoice.currency} period ${iso(s.paidInvoice.periodStartMs)}→${iso(s.paidInvoice.periodEndMs)}` : `no paid invoice${s.latestInvoice ? ` (latest ${s.latestInvoice.id} ${s.latestInvoice.status} ${s.latestInvoice.billingReason})` : ""}`}` : null;
  const c = r.changes;
  const diff = c ? [change(c.periodEndMs, "periodEnd"), change(c.paidThroughMs, "paidThrough"), change(c.firstActualPaymentAtMs, "firstActualPayment"), change(c.licenseExp, "exp")].join("; ") : null;
  return [head, stripe, diff, r.note].filter(Boolean).join(" | ");
}
const count = (v) => rows.filter((r) => r.verdict === v).length;
const summary = {
  hub, mode: apply ? "apply" : "dry-run", generatedAt: new Date().toISOString(), targets: rows.length,
  applied: count("APPLIED"), wouldApply: count("WOULD_APPLY"), nothingToApply: count("NOTHING_TO_APPLY"),
  needsOperatorReview: rows.filter((r) => r.needsReview).map((r) => ({ customerKey: r.customerKey, subscriptionId: r.subscriptionId, verdict: r.verdict, reason: r.note })),
  excluded: rows.filter((r) => r.verdict === "EXCLUDED").map((r) => r.customerKey ?? r.subscriptionId),
  skippedNoSubscription: rows.filter((r) => r.verdict === "NO_SUBSCRIPTION").map((r) => r.customerKey),
  errors: rows.filter((r) => r.error).map((r) => ({ customerKey: r.customerKey, subscriptionId: r.subscriptionId, verdict: r.verdict, reason: r.note })),
};
if (json) process.stdout.write(JSON.stringify({ summary, rows }, null, 2) + "\n");
else {
  const out = (s = "") => process.stdout.write(s + "\n");
  out(`Hub reconcile from Stripe — ${apply ? "APPLY" : "DRY RUN (nothing is written)"} — ${summary.generatedAt} — ${hub}`);
  for (const r of rows) out(line(r));
  out();
  out(`summary: ${summary.targets} target(s); ${apply ? `applied ${summary.applied}` : `would apply ${summary.wouldApply}`}; nothing to apply ${summary.nothingToApply}; needs operator review ${summary.needsOperatorReview.length}; excluded ${summary.excluded.length}; skipped (no subscription) ${summary.skippedNoSubscription.length}; errors ${summary.errors.length}`);
  if (summary.needsOperatorReview.length) {
    out("needs operator review:");
    for (const r of summary.needsOperatorReview) out(`  ${r.customerKey ?? "?"} ${r.subscriptionId ?? "-"} ${r.verdict}: ${r.reason}`);
  }
  if (summary.excluded.length) out(`excluded: ${summary.excluded.join(", ")}`);
  if (summary.skippedNoSubscription.length) out(`skipped (no subscription): ${summary.skippedNoSubscription.join(", ")}`);
  for (const e of summary.errors) out(`ERROR ${e.customerKey ?? "?"} ${e.subscriptionId ?? "-"} ${e.verdict}: ${e.reason}`);
  out(apply ? "Applied rows are in the billing audit ledger as admin.billing.reconcile-subscription." : "Dry run: nothing was written. Re-run with --apply --by=<who> --reason=<why> to write.");
}
process.exit(summary.errors.length ? 1 : 0);
