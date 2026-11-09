#!/usr/bin/env node
// scripts/earn-fee-recalc-dryrun.mjs — READ-ONLY dry run of the 0.4.109
// net-of-fee referral commission recalculation against a Hub data directory.
//
// It never writes the data directory: the three files the Earn service reads
// (earn.v1.json, earn-stripe-config.v1.json, billing-config.v1.json) are
// copied into a private 0700 temp directory, the service runs there, and the
// copy is removed afterwards. Stripe is reached with GET requests only (any
// other method or host is refused before a request is made). The Stripe key is
// read inside this process from the copied billing config and never printed.
// The output is the dry-run report (no keys, no customer identities).
//
// Usage (on the Hub box, as root; nothing is changed):
//   node scripts/earn-fee-recalc-dryrun.mjs --data=/opt/wickhunter-hub/data [--dist=./dist] > report.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const dataDir = String(args.data || process.env.HUB_DATA_DIR || "/opt/wickhunter-hub/data");
const dist = path.resolve(String(args.dist || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist")));
const { EarnService } = await import(pathToFileURL(path.join(dist, "src", "earn.js")).href);
const { EarnStripeService } = await import(pathToFileURL(path.join(dist, "src", "earn-stripe.js")).href);
const { readBillingConfig } = await import(pathToFileURL(path.join(dist, "src", "billing", "config.js")).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wh-earn-fee-dryrun-"));
fs.chmodSync(tmp, 0o700);
const copy = (name) => {
  const from = path.join(dataDir, name);
  if (!fs.existsSync(from)) return false;
  fs.copyFileSync(from, path.join(tmp, name), fs.constants.COPYFILE_EXCL);
  fs.chmodSync(path.join(tmp, name), 0o600);
  return true;
};
let stripeGets = 0;
const readOnlyFetch = async (url, init = {}) => {
  const u = new URL(url);
  if ((init.method ?? "GET") !== "GET" || u.hostname !== "api.stripe.com") throw new Error("dry run refuses a non-GET or non-Stripe request");
  stripeGets++;
  return fetch(url, init);
};
try {
  for (const name of ["earn.v1.json", "earn-stripe-config.v1.json", "billing-config.v1.json"]) if (!copy(name) && name === "earn.v1.json") throw new Error("earn.v1.json is missing");
  const ledger = new EarnService(tmp);
  const svc = new EarnStripeService(tmp, ledger, () => readBillingConfig(tmp), "https://dry-run.invalid", Date.now, readOnlyFetch);
  const report = await svc.feeRecalculation({ dryRun: true });
  process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), stripeGets, ...report }, null, 1) + "\n");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
