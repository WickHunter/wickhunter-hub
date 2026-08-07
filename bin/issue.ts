// bin/issue.ts
// Issue a beta license over SSH, no web UI needed.
//   npm run issue -- --name "Ada Lovelace" --days 30
// Prints the token plus the ready-to-send install command.
import { parseArgs } from "node:util";
import { configFromEnv } from "../src/config.js";
import { LicenseStore } from "../src/license.js";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    days: { type: "string", default: "30" },
  },
});
if (!values.name) {
  console.error('usage: npm run issue -- --name "<tester name>" [--days 30]');
  process.exit(1);
}
const days = Number(values.days);
const cfg = configFromEnv();
const store = new LicenseStore(cfg.dataDir);

let issued;
try {
  issued = store.issue(values.name, days);
} catch (err) {
  console.error(`issue failed: ${(err as Error).message}`);
  process.exit(1);
}

const { payload, token } = issued;
console.log(`Issued license ${payload.id}`);
console.log(`  name:    ${payload.name}`);
console.log(`  plan:    ${payload.plan}`);
console.log(`  expires: ${new Date(payload.exp).toISOString()} (${days} days)`);
console.log("");
console.log("Token (send to the tester, treat like a password):");
console.log(token);
console.log("");
console.log("One-command install for the tester:");
console.log(`  curl -fsS "${cfg.publicOrigin}/install.sh?key=${token}" | sudo bash`);
