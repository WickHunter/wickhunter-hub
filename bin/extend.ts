// bin/extend.ts
// Extend EVERY active licence to one date, over SSH, no web UI needed.
//   npm run extend -- --to 2026-09-30
// Every non-revoked licence expiring earlier than the end of that UTC day
// moves to 23:59:59.999 UTC on it; nothing is shortened. Running bots pick the
// re-minted key up at their next check-in; a bot too old to do that still
// needs its per-row install command from the admin page.
import { parseArgs } from "node:util";
import { configFromEnv } from "../src/config.js";
import { LicenseStore } from "../src/license.js";

const { values } = parseArgs({ options: { to: { type: "string" } } });
if (!values.to || !/^\d{4}-\d{2}-\d{2}$/.test(values.to)) {
  console.error("usage: npm run extend -- --to YYYY-MM-DD   (end of that UTC day)");
  process.exit(1);
}
const exp = Date.parse(`${values.to}T23:59:59.999Z`);
if (!Number.isFinite(exp)) { console.error(`not a date: ${values.to}`); process.exit(1); }
const cfg = configFromEnv();
const store = new LicenseStore(cfg.dataDir);
const out = store.extendAll(exp);
console.log(`Extended ${out.extended.length} licence(s) to ${new Date(exp).toISOString()}; ${out.unchanged} already past that date.`);
for (const p of out.extended) console.log(`  ${p.id}  ${p.name}`);
for (const r of out.refused) console.log(`  REFUSED ${r.id}  ${r.name}: ${r.error}`);
console.log("Running bots pick the new key up at their next check-in (within five minutes on the current build).");
