// Generate/read the dedicated machine-lease signing key and print only its
// public half. Rotating means choosing a new kid; prior public/private keys are
// retained so outstanding leases remain verifiable through the overlap.
//
//   npm run leasekey
//   npm run leasekey -- lease-2
import path from "node:path";
import { ROOT } from "../src/config.js";
import { DEFAULT_LEASE_KEY_ID, LicenseLeaseKeyStore } from "../src/license-leases.js";

const dataDir = process.env.HUB_DATA_DIR ?? path.join(ROOT, "data");
const kid = (process.argv[2] ?? process.env.HUB_LICENSE_LEASE_KEY_ID ?? DEFAULT_LEASE_KEY_ID).trim();
const store = new LicenseLeaseKeyStore(dataDir, kid);
const existed = store.hasActiveKey();
const ring = store.provisionActiveKey();
const entry = ring.keys[kid];
if (!entry) throw new Error(`lease key ${kid} was not added to the keyring`);

console.log(`${existed ? "Using" : "Generated"} dedicated machine-lease key "${kid}" in ${dataDir}.`);
console.log("Private key stays in data/ (mode 600); back up the whole data directory.");
console.log("");
console.log("Pin this PUBLIC key in the app before activating this kid on the Hub:");
console.log(`  ${kid} -> ${entry.publicKey}`);
console.log("");
console.log(`Keyring now contains: ${Object.keys(ring.keys).sort().join(", ")}`);
