// tests/candle-key.test.mjs — the candle seed's dedicated signing key, and the
// switch that decides whether it or the licence key signs.
//
// What this suite is defending, in one line: the hub must not start emitting
// keyId "candle-1" until a bot build exists that knows it, because the bot pins
// verifying keys by keyId and refuses an unknown one — and the failure is
// SILENT (every pair quietly falls back to a 12-hour venue warm-up). So the
// default is pinned here, hard, and so is the rule that the signing key and the
// emitted keyId always move together.
//
// NO WALL-CLOCK ELAPSED-TIME REASONING ANYWHERE IN THIS FILE: nothing here
// measures a duration, so there is no clock to inject and nothing to rot.
import assert from "node:assert/strict";
import fs from "node:fs";
import { verify as edVerify, createPublicKey } from "node:crypto";
import { freshHub, jsonReq, test, summary, tmpDir } from "./helpers.mjs";
import {
  CANDLE_KEY_ID, CANDLE_SIGNING_KEY_FILE, CandleKeyStore, LICENSE_SEED_KEY_ID, candleKeyBanner,
} from "../dist/src/candles/key.js";
import { candleSigningFromEnv, configFromEnv } from "../dist/src/config.js";
import { CandleStore, MINUTE_MS } from "../dist/src/candles/store.js";
import { canonicalBytes } from "../dist/src/candles/seed.js";

const DAY0 = Date.parse("2026-08-01T00:00:00.000Z");
const mk = (t, i) => ({ openMs: t, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000 + i });

/** A hub with one candle planted, plus the URL that seeds it. */
async function seededHub(overrides = {}) {
  const h = await freshHub(overrides);
  new CandleStore(`${h.dataDir}/candles`).write("bitget", "BTCUSDT", [mk(DAY0, 0), mk(DAY0 + MINUTE_MS, 1)]);
  const token = h.store.issue("Seed Tester", 30).token;
  const url = `${h.origin}/api/candles/seed?venue=bitget&symbol=BTCUSDT&fromMs=${DAY0}&toMs=${DAY0 + MINUTE_MS}&key=${token}`;
  return { h, url };
}

const b64uToPub = (b64u) => createPublicKey({
  // SPKI wrapper for a raw Ed25519 public key: the fixed 12-byte header the
  // hub strips in publicKeyRawB64u, put back so node can import the 32 bytes.
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(b64u, "base64url")]),
  format: "der",
  type: "spki",
});

// ── THE KEY ITSELF ──────────────────────────────────────────────────────────

await test("the candle signing key is generated on first use, beside the licence key, mode 600", async () => {
  const dataDir = tmpDir("candlekey");
  const ks = new CandleKeyStore(dataDir);
  assert.equal(ks.hasKey(), false, "nothing on disk until something needs it");
  const pub = ks.publicKeyRawB64u();
  assert.equal(ks.hasKey(), true, "reading the public half generated it");
  assert.equal(ks.keyFile, `${dataDir}/${CANDLE_SIGNING_KEY_FILE}`, "beside data/license-signing.key");
  assert.equal(fs.statSync(ks.keyFile).mode & 0o777, 0o600, "private key is not world-readable");
  assert.match(fs.readFileSync(ks.keyFile, "utf8"), /BEGIN PRIVATE KEY/, "PKCS8 PEM, same as the licence key");
  assert.equal(Buffer.from(pub, "base64url").length, 32, "32 raw Ed25519 bytes, base64url — the bot's encoding");
});

await test("the candle signing key survives a restart: generated once, never regenerated", async () => {
  // Regenerating would invalidate every signature already served AND every
  // public key the operator has already pasted into a bot.
  const dataDir = tmpDir("candlekey-restart");
  const first = new CandleKeyStore(dataDir);
  const pub = first.publicKeyRawB64u();
  const bytesOnDisk = fs.readFileSync(first.keyFile);

  // A brand new process reading the same data dir.
  const second = new CandleKeyStore(dataDir);
  assert.equal(second.publicKeyRawB64u(), pub, "same public key after a restart");
  assert.deepEqual(fs.readFileSync(second.keyFile), bytesOnDisk, "the private key file was not rewritten");

  // And a third, once more, because "generated once" must survive repetition.
  assert.equal(new CandleKeyStore(dataDir).publicKeyRawB64u(), pub, "still the same on the next start");

  // Signatures from before and after the restart verify under the one key.
  const msg = Buffer.from("candle-seed-canonical-bytes");
  assert.equal(edVerify(null, msg, b64uToPub(pub), first.sign(msg)), true);
  assert.equal(edVerify(null, msg, b64uToPub(pub), second.sign(msg)), true);
});

await test("the candle key is a DIFFERENT key from the licence key", async () => {
  // The whole point: a seed signature must fail the licence verifier at the
  // SIGNATURE step, not at a shape check that runs afterwards.
  const h = await freshHub();
  assert.notEqual(h.hub.candleKey.publicKeyRawB64u(), h.store.publicKeyRawB64u(), "two distinct keys");
  const msg = Buffer.from("some payload bytes");
  const candleSig = h.hub.candleKey.sign(msg);
  assert.equal(edVerify(null, msg, createPublicKey(h.store.publicKeyPem()), candleSig), false,
    "a candle signature does not verify under the licence key");
  assert.equal(edVerify(null, msg, createPublicKey(h.hub.candleKey.publicKeyPem()), h.store.sign(msg)), false,
    "and a licence signature does not verify under the candle key");
  await h.close();
});

// ── THE DEFAULT, WHICH MUST NOT FLIP ────────────────────────────────────────

await test("the default signer is the LICENCE key and the default keyId is seed-1", async () => {
  const fromEmpty = candleSigningFromEnv({});
  assert.equal(fromEmpty.signer, "license", "unchanged default: the licence key still signs");
  assert.equal(fromEmpty.keyId, LICENSE_SEED_KEY_ID, "unchanged default: seeds are still labelled seed-1");
  assert.equal(fromEmpty.keyId, "seed-1", "spelled out, because a bot pins this literal");
  const cfg = configFromEnv({ HUB_DATA_DIR: tmpDir("cfg") });
  assert.equal(cfg.candleSigner, "license");
  assert.equal(cfg.candleKeyId, "seed-1");
});

await test("a default hub emits keyId seed-1 and its seed verifies under the LICENCE key", async () => {
  const { h, url } = await seededHub();
  const body = JSON.parse(await (await fetch(url)).text());
  assert.equal(body.keyId, "seed-1", "the wire label is unchanged");
  const { sig, ...unsigned } = body;
  assert.equal(edVerify(null, canonicalBytes(unsigned), createPublicKey(h.store.publicKeyPem()), Buffer.from(sig, "base64")), true,
    "an existing bot, pinned to the licence key under seed-1, still verifies today's seeds");
  assert.equal(edVerify(null, canonicalBytes(unsigned), b64uToPub(h.hub.candleKey.publicKeyRawB64u()), Buffer.from(sig, "base64")), false,
    "and it is NOT the dedicated key doing the signing yet");
  await h.close();
});

// ── THE SWITCH: BOTH HALVES MOVE, OR NEITHER ────────────────────────────────

await test("HUB_CANDLE_SIGNER=candle switches the key AND the keyId together", async () => {
  const s = candleSigningFromEnv({ HUB_CANDLE_SIGNER: "candle" });
  assert.equal(s.signer, "candle");
  assert.equal(s.keyId, CANDLE_KEY_ID, "the label follows the key with no second env var to forget");
  assert.equal(s.keyId, "candle-1");
});

await test("a switched hub emits candle-1 and its seed verifies under the CANDLE key, not the licence key", async () => {
  const { h, url } = await seededHub({ candleSigner: "candle", candleKeyId: CANDLE_KEY_ID });
  const body = JSON.parse(await (await fetch(url)).text());
  assert.equal(body.keyId, "candle-1", "labelled with the key that actually signed it");
  const { sig, ...unsigned } = body;
  const bytes = canonicalBytes(unsigned);
  assert.equal(edVerify(null, bytes, b64uToPub(h.hub.candleKey.publicKeyRawB64u()), Buffer.from(sig, "base64")), true,
    "the dedicated key signed it, and the key the admin page shows is the one that verifies");
  assert.equal(edVerify(null, bytes, createPublicKey(h.store.publicKeyPem()), Buffer.from(sig, "base64")), false,
    "the licence key did NOT sign it — the overlap the operator asked to remove is gone");
  await h.close();
});

await test("a keyId reserved for the other signer refuses to start rather than mislabel a payload", async () => {
  // A payload signed by one key and labelled another verifies nowhere, and the
  // symptom appears in someone else's process with no hint of the cause.
  assert.throws(() => candleSigningFromEnv({ HUB_CANDLE_KEY_ID: "candle-1" }),
    /reserved for HUB_CANDLE_SIGNER=candle/, "candle-1 while the licence key signs");
  assert.throws(() => candleSigningFromEnv({ HUB_CANDLE_SIGNER: "candle", HUB_CANDLE_KEY_ID: "seed-1" }),
    /reserved for HUB_CANDLE_SIGNER=license/, "seed-1 while the dedicated key signs");
  assert.throws(() => candleSigningFromEnv({ HUB_CANDLE_SIGNER: "dedicated" }),
    /HUB_CANDLE_SIGNER must be one of/, "a typo fails loudly instead of picking a signer for you");
  // A free-form label (rotation naming) is still allowed with either signer.
  assert.equal(candleSigningFromEnv({ HUB_CANDLE_KEY_ID: "seed-2026-08" }).keyId, "seed-2026-08");
});

// ── THE PUBLIC HALF IS EASY TO COPY; THE PRIVATE HALF IS NOWHERE ────────────

await test("the admin candles route offers the dedicated public key whether or not the switch is thrown", async () => {
  for (const [label, overrides, expectKeyId] of [
    ["default", {}, "seed-1"],
    ["switched", { candleSigner: "candle", candleKeyId: CANDLE_KEY_ID }, "candle-1"],
  ]) {
    const h = await freshHub(overrides);
    const r = await jsonReq(`${h.origin}/admin/api/candles`, { headers: { "x-hub-admin": h.cfg.adminToken } });
    assert.equal(r.status, 200, label);
    assert.equal(r.body.keyId, expectKeyId, label);
    assert.equal(r.body.candleKeyId, "candle-1", `${label}: the dedicated key is always named`);
    assert.equal(r.body.candlePublicKey, h.hub.candleKey.publicKeyRawB64u(),
      `${label}: rollout step (b) is possible BEFORE the switch is thrown`);
    // `seedPublicKey` means "the key verifying seeds right now", so it follows.
    assert.equal(r.body.seedPublicKey,
      overrides.candleSigner === "candle" ? h.hub.candleKey.publicKeyRawB64u() : h.store.publicKeyRawB64u(),
      `${label}: the advertised verifying key is the one that signed`);
    await h.close();
  }
});

await test("the admin page shows the public key, says it is public, and states the four-step order", async () => {
  const h = await freshHub();
  const page = await (await fetch(`${h.origin}/admin`)).text();
  assert.match(page, /id="seedkey"/, "a home for the key on the Exchanges panel");
  assert.match(page, /candlePublicKey/, "wired to the field the route serves");
  assert.match(page, /PUBLIC KEY, safe to copy/, "the operator is told plainly that copying it is safe");
  assert.match(page, /OLB_SEED_KEYS/, "and exactly where it goes in the bot");
  assert.match(page, /Copy public key/, "one click, because a half-selected key is a wasted afternoon");
  assert.match(page, /HUB_CANDLE_SIGNER=candle/, "the switch is named on the page");
  assert.match(page, /Only then/i, "the ordering warning is on the page, not just in a comment");
  await h.close();
});

await test("the startup banner carries the PUBLIC key and no private material", async () => {
  const dataDir = tmpDir("banner");
  const ks = new CandleKeyStore(dataDir);
  const pub = ks.publicKeyRawB64u();
  for (const [signer, keyId] of [["license", "seed-1"], ["candle", "candle-1"]]) {
    const banner = candleKeyBanner(pub, signer, keyId);
    assert.ok(banner.includes(pub), "the string to paste is printed in full");
    assert.match(banner, /PUBLIC key, safe to copy/, "labelled public");
    assert.match(banner, /OLB_SEED_KEYS/, "labelled with its destination");
    assert.ok(banner.includes(keyId), "and states which keyId is being emitted right now");
    assert.doesNotMatch(banner, /PRIVATE/i, "no private key material, ever");
  }
});

await test("the private key appears in no response, no page and no admin payload", async () => {
  const { h, url } = await seededHub();
  const pub = h.hub.candleKey.publicKeyRawB64u(); // as the startup banner does, generating the key
  const privatePem = fs.readFileSync(h.hub.candleKey.keyFile, "utf8");
  const privateBody = privatePem.split("\n").filter((l) => l && !l.includes("-----")).join("");
  assert.ok(privateBody.length > 10, "precondition: we have the private key's base64 body to hunt for");

  const surfaces = {
    seed: await (await fetch(url)).text(),
    adminPage: await (await fetch(`${h.origin}/admin`)).text(),
    adminCandles: JSON.stringify((await jsonReq(`${h.origin}/admin/api/candles`, { headers: { "x-hub-admin": h.cfg.adminToken } })).body),
    health: await (await fetch(`${h.origin}/api/health`)).text(),
  };
  for (const [name, text] of Object.entries(surfaces)) {
    assert.ok(!text.includes(privateBody), `${name} must not carry the private key`);
    assert.ok(!text.includes("PRIVATE KEY"), `${name} must not carry a private key PEM`);
    assert.ok(!text.includes("BEGIN"), `${name} must not carry PEM material at all`);
  }
  // The public half IS on the admin route, deliberately — that is the feature.
  assert.ok(surfaces.adminCandles.includes(pub), "public half is offered");
  await h.close();
});

// ── THE LICENCE PATH IS UNTOUCHED ───────────────────────────────────────────

await test("licences are still issued, signed and verified by the licence key, switch or no switch", async () => {
  for (const overrides of [{}, { candleSigner: "candle", candleKeyId: CANDLE_KEY_ID }]) {
    const h = await freshHub(overrides);
    const { token, payload } = h.store.issue("Unaffected Tester", 30);
    assert.equal(h.store.verify(token).ok, true, "the licence path does not know the candle key exists");
    assert.equal(h.store.tokenFor(payload.id), token, "and still re-mints byte-identically");
    assert.equal(typeof h.store.sign(Buffer.from("x")).length, "number", "LicenseStore.sign() is still there");
    await h.close();
  }
});

summary("candle-key");
