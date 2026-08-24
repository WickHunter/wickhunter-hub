// tests/marketcap-snapshot.test.mjs
// THE SIGNED PAYLOAD: its bytes, its refusals, and the invariant that decides
// whether it may be published at all.
//
// The bytes matter more here than in most places. A client in another language
// has to reproduce them EXACTLY or every signature fails, and the failure lands
// in that client's process with no hint of where it came from — which is the
// same trap `candles/key.ts` records for the seed keyId. So the canonical form
// is RFC 8785, `signatures` is removed WHOLE, and both properties are pinned.
import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import { generateKeyPairSync } from "node:crypto";
import { canonicalize } from "../dist/src/marketcap/jcs.js";
import {
  buildSnapshot, loadSigningKey, publicKeyRawB64u, signSnapshot, snapshotSigningBytes, verifySnapshot,
} from "../dist/src/marketcap/snapshot.js";
import { buildPairIndex, resolveUniverse, instrumentKey } from "../dist/src/marketcap/identity.js";
import { acceptCmcQuote, capCensus, missingForOmittedId } from "../dist/src/marketcap/caps.js";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

function freshSigner(keyId = "market-data-1") {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  const signer = loadSigningKey(Buffer.from(der).toString("base64url"), keyId);
  return { signer, pub: publicKeyRawB64u(signer) };
}

// ── 1. RFC 8785 ─────────────────────────────────────────────────────────────

await test("canonicalization sorts keys by code unit and refuses what it cannot express", () => {
  assert.equal(canonicalize({ b: 1, a: 2, A: 3 }), '{"A":3,"a":2,"b":1}');
  assert.equal(canonicalize({ "\u00e4": 1, "\u000b": 2 }), '{"\\u000b":2,"\u00e4":1}');
  assert.equal(canonicalize([1, "x", true, null]), '[1,"x",true,null]');
  assert.equal(canonicalize({ n: 1e21 }), '{"n":1e+21}', "ECMAScript number-to-string, by reference");
  // Money never arrives here as a number — it is a decimal STRING — so a
  // refusal costs a bug report rather than a payment.
  assert.throws(() => canonicalize({ n: NaN }), /no JSON representation/);
  assert.throws(() => canonicalize({ n: Infinity }), /no JSON representation/);
  assert.throws(() => canonicalize({ n: -0 }), /-0 is refused/);
  const loop = { a: 1 };
  loop.self = loop;
  assert.throws(() => canonicalize(loop), /nests deeper/);
});

// ── 2. the signing bytes ────────────────────────────────────────────────────

const sampleUnsigned = () => ({
  v: 1,
  kind: "market-caps",
  generatedAt: NOW,
  expiresAt: NOW + 3_600_000,
  sources: { caps: { provider: "coinmarketcap", fetchedAt: NOW }, pairMap: { provider: "coinmarketcap", fetchedAt: NOW, exchanges: [] } },
  instruments: [],
  assets: [],
  coverage: {
    instruments: { activeInstruments: 0, mapped: 0, ambiguous: 0, provider_untracked: 0, not_applicable: 0, invariantOk: true, uniqueMappedAssets: 0 },
    assets: { requested: 0, verified: 0, fallback: 0, missing: 0, disputed: 0, stale: 0, not_applicable: 0, invariantOk: true },
    invariantOk: true,
    omittedIds: [],
  },
  credits: { month: "2026-08", used: 12, ceiling: 15000, refusals: 0 },
  keyId: "market-data-1",
});

await test("the signed bytes EXCLUDE the whole `signatures` field", () => {
  const unsigned = sampleUnsigned();
  const before = snapshotSigningBytes(unsigned);
  const { signer } = freshSigner();
  const signed = signSnapshot(unsigned, signer);
  const after = snapshotSigningBytes(signed);
  assert.equal(before.toString("utf8"), after.toString("utf8"), "adding a signature must not move the bytes it covers");
  assert.ok(!before.toString("utf8").includes("signatures"));
  // Removing the FIELD rather than emptying the `sig` is what lets a second
  // signature (key rotation) be added later without invalidating the first.
  const two = { ...signed, signatures: [...signed.signatures, { keyId: "other", alg: "ed25519", sig: "AA" }] };
  assert.equal(snapshotSigningBytes(two).toString("utf8"), before.toString("utf8"));
});

await test("a good signature verifies; a moved byte does not", () => {
  const { signer, pub } = freshSigner();
  const signed = signSnapshot(sampleUnsigned(), signer);
  assert.deepEqual(verifySnapshot(signed, { keys: { "market-data-1": pub }, now: NOW }), { ok: true });

  const tampered = { ...signed, credits: { ...signed.credits, used: 13 } };
  const bad = verifySnapshot(tampered, { keys: { "market-data-1": pub }, now: NOW });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /no signature verifies/);
});

await test("an unknown keyId and an unknown algorithm are both REFUSALS", () => {
  const { signer, pub } = freshSigner();
  const signed = signSnapshot(sampleUnsigned(), signer);

  const wrongKeyId = verifySnapshot(signed, { keys: { "someone-else": pub }, now: NOW });
  assert.equal(wrongKeyId.ok, false);
  assert.match(wrongKeyId.reason, /no signature from a known keyId/);

  // "alg" has been the hole in more than one signature format: a payload naming
  // an algorithm we do not implement must not be verified with the one we have.
  const wrongAlg = verifySnapshot(
    { ...signed, signatures: [{ ...signed.signatures[0], alg: "none" }] },
    { keys: { "market-data-1": pub }, now: NOW },
  );
  assert.equal(wrongAlg.ok, false);

  assert.equal(verifySnapshot({ ...signed, signatures: [] }, { keys: { "market-data-1": pub }, now: NOW }).ok, false);
  assert.equal(verifySnapshot({ ...signed, v: 2 }, { keys: { "market-data-1": pub }, now: NOW }).ok, false);
});

await test("during a rotation, a client holding EITHER key verifies", () => {
  // Two signatures over the same bytes. A verifier that failed on the first
  // mismatch would make which key a client happens to hold decide whether a
  // perfectly good snapshot verifies — which is the whole rotation window.
  const a = freshSigner("market-data-1");
  const b = freshSigner("market-data-2");
  const signed = signSnapshot(sampleUnsigned(), a.signer);
  const rotating = { ...signed, signatures: [...signed.signatures, signSnapshot(sampleUnsigned(), b.signer).signatures[0]] };
  assert.deepEqual(verifySnapshot(rotating, { keys: { "market-data-1": a.pub }, now: NOW }), { ok: true });
  assert.deepEqual(verifySnapshot(rotating, { keys: { "market-data-2": b.pub }, now: NOW }), { ok: true });
  // And a client holding a key that signed NOTHING here still refuses.
  const c = freshSigner("market-data-3");
  assert.equal(verifySnapshot(rotating, { keys: { "market-data-3": c.pub }, now: NOW }).ok, false);
});

await test("expiry is judged AFTER the signature, never before", () => {
  const { signer, pub } = freshSigner();
  const signed = signSnapshot(sampleUnsigned(), signer);
  const expired = verifySnapshot(signed, { keys: { "market-data-1": pub }, now: signed.expiresAt + 1 });
  assert.equal(expired.ok, false);
  assert.match(expired.reason, /expired at/);
  // An expiry read off an UNVERIFIED payload is an expiry the sender chose: a
  // forged payload claiming a distant expiry must fail on the signature first.
  const forged = { ...signed, expiresAt: NOW + 10 ** 12 };
  assert.match(verifySnapshot(forged, { keys: { "market-data-1": pub }, now: NOW }).reason, /no signature verifies/);
});

await test("the signing key is loaded from env material and its PRIVATE half never leaves", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).subarray(-32);
  const fromSeed = loadSigningKey(seed.toString("base64url"), "k1");
  const fromDer = loadSigningKey(Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString("base64url"), "k1");
  assert.equal(publicKeyRawB64u(fromSeed), publicKeyRawB64u(fromDer), "both accepted forms name one key");
  const signed = signSnapshot(sampleUnsigned(), fromSeed);
  assert.equal(JSON.stringify(signed).includes(seed.toString("base64url")), false, "no private material on the wire");
  assert.throws(() => loadSigningKey("", "k1"), /is required/);
  assert.throws(() => loadSigningKey(seed.toString("base64url"), ""), /KEY_ID is required/);
  assert.throws(() => loadSigningKey("nonsense!!", "k1"), /not a usable Ed25519 private key/);
});

// ── 3. what the payload says ────────────────────────────────────────────────

function buildFixture(over = {}) {
  const instruments = [
    { venue: "bybit", symbol: "1000PEPEUSDT", base: "1000PEPE", quote: "USDT", settle: "USDT", status: "Trading", contractType: "LinearPerpetual", active: true },
    { venue: "bybit", symbol: "PEPEUSDT", base: "PEPE", quote: "USDT", settle: "USDT", status: "Trading", contractType: "LinearPerpetual", active: true },
    { venue: "bybit", symbol: "NEWUSDT", base: "NEW", quote: "USDT", settle: "USDT", status: "Trading", contractType: "LinearPerpetual", active: true },
  ];
  const pairs = [
    { exchangeSlug: "bybit", exchangeSymbol: "1000PEPE", quoteSymbol: "USDT", cryptoId: 24478, cryptoSymbol: "PEPE", cryptoName: "Pepe", marketPair: "1000PEPE/USDT" },
    { exchangeSlug: "bybit", exchangeSymbol: "PEPE", quoteSymbol: "USDT", cryptoId: 24478, cryptoSymbol: "PEPE", cryptoName: "Pepe", marketPair: "PEPE/USDT" },
  ];
  const { rows, census, mappedIds } = resolveUniverse(instruments, {
    slugOf: () => "bybit",
    index: buildPairIndex(pairs),
    overrides: {},
  });
  const fact = acceptCmcQuote({
    cryptoId: 24478, symbol: "PEPE", name: "Pepe",
    price: "0.00001", circulatingSupply: "420690000000000", marketCap: "4206900000",
    lastUpdated: new Date(NOW - 10_000).toISOString(), isMarketCapIncludedInCalc: 1,
  }, { receivedAt: NOW, identityProven: true });
  const capFacts = new Map([[24478, fact]]);
  return buildSnapshot({
    now: NOW, ttlMs: 3_600_000, keyId: "market-data-1",
    identityRows: rows, identityCensus: census,
    capFacts, capCensus: capCensus(mappedIds, [...capFacts.values()]),
    omittedIds: [],
    sources: { caps: { provider: "coinmarketcap", fetchedAt: NOW }, pairMap: { provider: "coinmarketcap", fetchedAt: NOW, exchanges: [{ venue: "bybit", slug: "bybit", pairs: 2 }] } },
    credits: { month: "2026-08", used: 10, ceiling: 15000, refusals: 0 },
    ...over,
  });
}

await test("A x1000 CONTRACT CARRIES ITS UNDERLYING'S CAP, UNCHANGED", () => {
  const built = buildFixture();
  assert.equal(built.ok, true, built.error);
  const thousand = built.snapshot.instruments.find((r) => r.symbol === "1000PEPEUSDT");
  const plain = built.snapshot.instruments.find((r) => r.symbol === "PEPEUSDT");
  assert.equal(thousand.cryptoId, 24478);
  assert.equal(thousand.marketCapUsd, "4206900000");
  assert.equal(
    thousand.marketCapUsd, plain.marketCapUsd,
    "the multiplier is a CONTRACT SIZE. Nothing multiplies or divides a market cap by it.",
  );
  // And the hint that could have tempted a parser is present, and marked.
  assert.equal(thousand.multiplierSuggestion.multiplier, 1000);
  assert.equal(thousand.multiplierSuggestion.reviewOnly, true);
});

await test("a pair with no cap still gets a row AND a reason", () => {
  const built = buildFixture();
  const unmapped = built.snapshot.instruments.find((r) => r.symbol === "NEWUSDT");
  assert.ok(unmapped, "an unmapped pair is never dropped from the snapshot");
  assert.equal(unmapped.marketCapUsd, null);
  assert.equal(unmapped.capStatus, null, "identity never got far enough to ask about a cap");
  assert.ok(unmapped.reason && unmapped.reason.length > 10, unmapped.reason);
  for (const row of built.snapshot.instruments) {
    if (row.marketCapUsd === null) assert.ok(row.reason, `${row.symbol} has no cap and no reason`);
  }
});

await test("BOTH invariants ride on the wire, and a failing one is NOT PUBLISHED", () => {
  const ok = buildFixture();
  assert.equal(ok.snapshot.coverage.invariantOk, true);
  assert.equal(ok.snapshot.coverage.instruments.activeInstruments, 3);
  assert.equal(
    ok.snapshot.coverage.instruments.mapped + ok.snapshot.coverage.instruments.ambiguous
    + ok.snapshot.coverage.instruments.provider_untracked + ok.snapshot.coverage.instruments.not_applicable,
    3,
  );

  // A census that does not add up refuses the build outright — the caller keeps
  // its last known good and emits one feed-health error.
  const broken = buildFixture({
    identityCensus: { activeInstruments: 9, mapped: 1, ambiguous: 0, provider_untracked: 1, not_applicable: 0, invariantOk: false, uniqueMappedAssets: 1 },
  });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /instrument coverage invariant failed/);

  const brokenAssets = buildFixture({ capCensus: { requested: 5, verified: 1, fallback: 0, missing: 0, disputed: 0, stale: 0, not_applicable: 0, invariantOk: false } });
  assert.equal(brokenAssets.ok, false);
  assert.match(brokenAssets.error, /asset coverage invariant failed/);
});

await test("a mapped instrument with no cap verdict at all is a PRODUCER bug and is caught", () => {
  const built = buildFixture({ capFacts: new Map(), capCensus: { requested: 0, verified: 0, fallback: 0, missing: 0, disputed: 0, stale: 0, not_applicable: 0, invariantOk: true } });
  assert.equal(built.ok, false);
  assert.match(built.error, /produced no cap verdict at all/);
});

await test("a disputed or stale asset yields NO usable cap on its instruments", () => {
  const stale = missingForOmittedId(24478, NOW);
  const built = buildFixture({ capFacts: new Map([[24478, { ...stale, status: "stale", reason: "provider stamp is 1200s old" }]]) });
  assert.equal(built.ok, true, built.error);
  for (const row of built.snapshot.instruments.filter((r) => r.cryptoId === 24478)) {
    assert.equal(row.marketCapUsd, null, "only verified and fallback are usable");
    assert.equal(row.capStatus, "stale");
    assert.match(row.reason, /1200s old/);
  }
});

summary("marketcap-snapshot");
