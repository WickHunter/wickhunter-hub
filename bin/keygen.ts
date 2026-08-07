// bin/keygen.ts
// Generate the Ed25519 license-signing keypair.
//   npm run keygen            -> writes data/license-signing.key (chmod 600)
//   npm run keygen -- --force -> replace an existing key (orphans every token
//                                signed by the old one — deliberate action only)
// Prints the PUBLIC key (PEM + raw base64url) for baking into the bot.
// The private key is written to disk and NEVER printed or logged.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { configFromEnv } from "../src/config.js";
import { generateSigningKey, LicenseStore } from "../src/license.js";

const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });
const store = new LicenseStore(configFromEnv().dataDir);

if (store.hasKey() && !values.force) {
  console.error(`A signing key already exists at ${store.keyFile}.`);
  console.error("Replacing it invalidates every issued token. If you really mean it: --force");
  process.exit(1);
}
if (store.hasKey() && values.force) fs.rmSync(store.keyFile);

const keys = generateSigningKey();
store.writeKey(keys.privatePem);

console.log(`Private key written to ${store.keyFile} (mode 600). Back it up; never share it.`);
console.log("");
console.log("Public key — bake THIS into the bot (SPKI PEM):");
console.log(keys.publicPem.trimEnd());
console.log("");
console.log(`Public key, raw 32 bytes as base64url: ${keys.publicRawB64u}`);
