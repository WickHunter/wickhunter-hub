// bin/revoke.ts
// Revoke a license by id (find ids with `npm run list`).
//   npm run revoke -- --id <uuid>
// Takes effect immediately for downloads/install.sh; the bot learns at its
// next check-in.
import { parseArgs } from "node:util";
import { configFromEnv } from "../src/config.js";
import { LicenseStore } from "../src/license.js";

const { values } = parseArgs({ options: { id: { type: "string" } } });
if (!values.id) {
  console.error("usage: npm run revoke -- --id <license-uuid>");
  process.exit(1);
}
const store = new LicenseStore(configFromEnv().dataDir);
if (!store.revoke(values.id)) {
  console.error(`no license with id ${values.id} — check \`npm run list\``);
  process.exit(1);
}
console.log(`revoked ${values.id}`);
