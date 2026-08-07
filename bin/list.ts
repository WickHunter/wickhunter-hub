// bin/list.ts
// List every issued license with revocation state and last check-in.
//   npm run list
import { readRoster } from "../src/checkins.js";
import { configFromEnv } from "../src/config.js";
import { LicenseStore } from "../src/license.js";

const cfg = configFromEnv();
const store = new LicenseStore(cfg.dataDir);
const roster = readRoster(cfg.dataDir);
const licenses = store.list();

if (licenses.length === 0) {
  console.log("no licenses issued yet");
  process.exit(0);
}

const rows = licenses.map((l) => {
  const seen = roster[l.id];
  const state = l.revoked ? "REVOKED" : l.exp <= Date.now() ? "expired" : "active";
  return {
    id: l.id,
    name: l.name,
    state,
    expires: new Date(l.exp).toISOString().slice(0, 10),
    lastSeen: seen ? new Date(seen.lastSeen).toISOString().replace("T", " ").slice(0, 16) : "-",
    version: seen?.version ?? "-",
    ip: seen?.ip ?? "-",
  };
});

const cols = ["id", "name", "state", "expires", "lastSeen", "version", "ip"] as const;
const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
const line = (vals: readonly string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join("  ");
console.log(line(cols));
console.log(line(widths.map((w) => "-".repeat(w))));
for (const r of rows) console.log(line(cols.map((c) => String(r[c]))));
