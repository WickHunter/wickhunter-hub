// tests/license.test.mjs — the token format itself: round-trip, tampering,
// expiry, revocation, and the pinned v1 wire shape the bot is built against.
import assert from "node:assert/strict";
import { freshStore, test, summary } from "./helpers.mjs";
import { generateSigningKey, LicenseStore } from "../dist/src/license.js";

const { store } = freshStore();

await test("issue -> verify round-trips", () => {
  const { payload, token } = store.issue("Ada Lovelace", 30);
  const v = store.verify(token);
  assert.equal(v.ok, true);
  assert.deepEqual(v.payload, payload);
  assert.equal(v.payload.plan, "beta");
  assert.equal(v.payload.v, 1);
});

await test("payload wire shape is the pinned v1 key order", () => {
  const { token } = store.issue("Shape Check", 1);
  const json = Buffer.from(token.split(".")[1], "base64url").toString("utf8");
  // The bot may verify against these exact bytes; key ORDER is part of v1.
  assert.match(json, /^\{"v":1,"id":"[0-9a-f-]{36}","name":"Shape Check","exp":\d+,"iat":\d+,"plan":"beta"\}$/);
  assert.equal(token.startsWith("LHK1."), true);
});

await test("tampered payload fails signature", () => {
  const { token } = store.issue("Mallory", 30);
  const [prefix, payloadB64, sig] = token.split(".");
  const doctored = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  doctored.exp += 86_400_000 * 365; // give himself a year
  const evil = `${prefix}.${Buffer.from(JSON.stringify(doctored)).toString("base64url")}.${sig}`;
  assert.deepEqual(store.verify(evil), { ok: false, reason: "signature" });
});

await test("tampered signature fails", () => {
  const { token } = store.issue("Sig Tamper", 30);
  const parts = token.split(".");
  const sig = Buffer.from(parts[2], "base64url");
  sig[0] ^= 0xff;
  assert.deepEqual(store.verify(`${parts[0]}.${parts[1]}.${sig.toString("base64url")}`), {
    ok: false,
    reason: "signature",
  });
});

await test("token signed by a DIFFERENT key fails", () => {
  const { store: other } = freshStore();
  const { token } = other.issue("Wrong Hub", 30);
  assert.deepEqual(store.verify(token), { ok: false, reason: "signature" });
});

await test("garbage and wrong-prefix tokens fail as format", () => {
  for (const bad of ["", "hello", "LHK1.abc", "LHK2.a.b", "a.b.c", "LHK1.a.b.c"]) {
    assert.deepEqual(store.verify(bad), { ok: false, reason: "format" }, `token: ${JSON.stringify(bad)}`);
  }
});

await test("expiry is enforced (boundary: exp itself is expired)", () => {
  const { payload, token } = store.issue("Short Lived", 1);
  assert.equal(store.verify(token, payload.exp - 1).ok, true);
  assert.deepEqual(store.verify(token, payload.exp), { ok: false, reason: "expired" });
  assert.deepEqual(store.verify(token, payload.exp + 1), { ok: false, reason: "expired" });
});

await test("revocation is durable and idempotent", () => {
  const { payload, token } = store.issue("Revoke Me", 30);
  assert.equal(store.verify(token).ok, true);
  assert.equal(store.revoke(payload.id), true);
  assert.deepEqual(store.verify(token), { ok: false, reason: "revoked" });
  assert.equal(store.revoke(payload.id), true); // second revoke: still fine
  // Durable: a brand-new store over the same dataDir still sees it.
  const reopened = new LicenseStore(store.dataDir);
  assert.deepEqual(reopened.verify(token), { ok: false, reason: "revoked" });
});

await test("revoking an unknown id reports failure", () => {
  assert.equal(store.revoke("00000000-0000-0000-0000-000000000000"), false);
});

await test("issue validates inputs", () => {
  assert.throws(() => store.issue("", 30));
  assert.throws(() => store.issue("x".repeat(121), 30));
  assert.throws(() => store.issue("Ok", 0));
  assert.throws(() => store.issue("Ok", NaN));
});

await test("list shows issued licenses with revocation state", () => {
  const { store: s } = freshStore();
  const a = s.issue("Alpha", 10).payload;
  const b = s.issue("Beta", 10).payload;
  s.revoke(b.id);
  const listed = s.list();
  assert.equal(listed.length, 2);
  assert.equal(listed.find((l) => l.id === a.id).revoked, false);
  const rb = listed.find((l) => l.id === b.id);
  assert.equal(rb.revoked, true);
  assert.equal(typeof rb.revokedAt, "string");
});

await test("keygen refuses to overwrite; public raw key is 32 bytes", () => {
  assert.throws(() => store.writeKey(generateSigningKey().privatePem), /refusing to overwrite/);
  const keys = generateSigningKey();
  assert.equal(Buffer.from(keys.publicRawB64u, "base64url").length, 32);
  assert.match(keys.publicPem, /BEGIN PUBLIC KEY/);
  assert.match(keys.privatePem, /BEGIN PRIVATE KEY/);
});


await test("tokenFor rebuilds the EXACT original token; revoked/unknown get nothing", async () => {
  const { store } = freshStore();
  const issued = store.issue("Reinvite", 30);
  assert.equal(store.tokenFor(issued.payload.id), issued.token); // byte-identical — Ed25519 is deterministic
  assert.equal(store.verify(store.tokenFor(issued.payload.id)).ok, true);
  store.revoke(issued.payload.id);
  assert.equal(store.tokenFor(issued.payload.id), null); // a revoked tester gets no fresh copy
  assert.equal(store.tokenFor("never-issued"), null);
});

summary("license");
