// bin/marketcapkey.ts
// Generate the market-cap snapshot signing keypair.
//
//   npm run marketcapkey
//
// ── THIS IS A REQUIRED DEPLOY STEP, AND SKIPPING IT IS QUIET ────────────────
// Unlike the licence key and the candle key, this one is NOT generated on first
// use and NOT stored in the data directory: the spec puts it in the
// environment, so there is nothing on disk for the hub to find and nothing for
// it to invent. A hub started without it refuses to run the producer and says
// why — but a hub started WITH a key nobody wrote down produces snapshots that
// verify nowhere, and that failure lands in a client's process with no hint of
// the cause. Same shape as flipping HUB_CANDLE_SIGNER too early.
//
// So: run this ONCE, put the private half in /etc/wickhunter-hub/env, and give
// the PUBLIC half plus the keyId to whoever is building the client.
//
// The private half is printed HERE and nowhere else — never logged by the
// running hub, never written to a file by it, never in a payload.
import { generateKeyPairSync } from "node:crypto";

const keyId = process.argv[2] ?? "market-data-1";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pkcs8 = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" }));
const spki = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
// An Ed25519 SPKI is a fixed 12-byte algorithm header + the 32 key bytes.
const pub = spki.subarray(spki.length - 32).toString("base64url");

console.log("Add these two lines to /etc/wickhunter-hub/env (chmod 600) and restart the hub:");
console.log("");
console.log(`MARKET_DATA_SIGNING_PRIVATE_KEY_B64U=${pkcs8.toString("base64url")}`);
console.log(`MARKET_DATA_SIGNING_KEY_ID=${keyId}`);
console.log("");
console.log("Give the CLIENT these two — this is a PUBLIC key, safe to copy and paste anywhere:");
console.log("");
console.log(`  keyId       ${keyId}`);
console.log(`  public key  ${pub}`);
console.log("");
console.log("The hub prints the public half at startup and shows it on the admin page, so you");
console.log("never need to keep this output. The PRIVATE line above is shown ONCE, here.");
