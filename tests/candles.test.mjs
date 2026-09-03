// tests/candles.test.mjs — the three things that decide whether a seed is safe:
// forming-bar exclusion per venue, gap reporting, and signature canonicalisation.
//
// Every venue page below is a REPLAY of a real response shape captured from the
// live API (Bybit's from its v5 contract — see venues.ts for why it could not be
// probed from the build environment). The clock is frozen so "which bar is still
// forming" is a fact of the fixture, not of when the suite happens to run.
import assert from "node:assert/strict";
import fs from "node:fs";
import { verify as edVerify, createPublicKey } from "node:crypto";
import { test, summary, freshStore, tmpDir } from "./helpers.mjs";
import {
  CandleStore, MINUTE_MS, newestClosedOpenMs, floorMinute, dayKey, DAY_FILE_BYTES,
} from "../dist/src/candles/store.js";
import { ADAPTERS, dropUnclosed, isRateLimit } from "../dist/src/candles/venues.js";
import { buildSeed, canonicalBytes, SEED_CANONICAL_KEY_ORDER } from "../dist/src/candles/seed.js";
import {
  buildSnapshot, canonicalSnapshotBytes, foldSymbolWindow, newestCompleteBucketOpenMs,
  snapshotExpiresAtMs, SNAPSHOT_CANONICAL_KEY_ORDER, SNAPSHOT_INTERVALS, SNAPSHOT_MAX_DEPTH,
  SNAPSHOT_SETTLE_LAG_MS,
} from "../dist/src/candles/snapshot.js";

// ── FROZEN CLOCK ────────────────────────────────────────────────────────────
// Taken from a real probe instant. At NOW the minute 1786410720000 has OPENED
// but not closed, so it is the forming bar; 1786410660000 is the newest closed.
const NOW = 1786410725631;
const FORMING = 1786410720000;
const NEWEST_CLOSED = 1786410660000;

await test("the frozen clock really does put FORMING in progress and NEWEST_CLOSED behind it", () => {
  assert.equal(floorMinute(NOW), FORMING, "FORMING is the minute in progress at NOW");
  assert.equal(newestClosedOpenMs(NOW), NEWEST_CLOSED, "newest CLOSED bar is one minute earlier");
});

// ── FORMING BAR, PER VENUE ──────────────────────────────────────────────────

function stubFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

await test("BITGET: the /candles page really does carry the forming bar (recorded shape)", async () => {
  // Captured live: probed at 1786410774782 with the minute 1786410720000 in
  // progress, and 1786410720000 was the newest row returned.
  const page = {
    code: "00000", msg: "success", data: [
      ["1786410600000", "63990", "64034", "63989.9", "64033.9", "16.9593", "1085773.54733"],
      ["1786410660000", "64033.9", "64048.7", "64026.3", "64048.7", "12.421", "795438.67863"],
      [String(FORMING), "64048.7", "64057.7", "64048.6", "64049.2", "3.7217", "238376.89904"],
    ],
  };
  const { candles } = await ADAPTERS.bitget.fetchKlines(stubFetch(page), "BTCUSDT", 0, 0);
  assert.ok(candles.some((c) => c.openMs === FORMING), "precondition: the raw page contains the forming bar");
  const closed = dropUnclosed(candles, NOW);
  assert.ok(!closed.some((c) => c.openMs === FORMING), "the forming bar is dropped");
  assert.equal(closed.at(-1).openMs, NEWEST_CLOSED, "the newest surviving bar is the newest CLOSED one");
  assert.equal(closed.length, 2, "exactly one bar was removed");
});

await test("BITGET: volume is BASE volume (index 5), not the quote turnover at index 6", async () => {
  const page = { code: "00000", data: [["1786410600000", "63990", "64034", "63989.9", "64033.9", "16.9593", "1085773.54733"]] };
  const { candles } = await ADAPTERS.bitget.fetchKlines(stubFetch(page), "BTCUSDT", 0, 0);
  assert.equal(candles[0].volume, 16.9593, "base volume, not 1085773.54733");
});

await test("BITUNIX: rows arrive NEWEST-FIRST and are normalised to oldest-first", async () => {
  const page = {
    code: 0, msg: "Success", data: [
      { open: "64034.3", high: "64045.1", low: "64030.9", close: "64045.1", quoteVol: "16.0341", baseVol: "1026789.19294", time: String(NEWEST_CLOSED) },
      { open: "63978.5", high: "64023", low: "63978.4", close: "64022.9", quoteVol: "7.5528", baseVol: "483424.02372", time: "1786410600000" },
      { open: "63955.2", high: "63978.5", low: "63950", close: "63978.5", quoteVol: "4.29", baseVol: "274370.23937", time: "1786410540000" },
    ],
  };
  const { candles } = await ADAPTERS.bitunix.fetchKlines(stubFetch(page), "BTCUSDT", 0, 0);
  assert.deepEqual(candles.map((c) => c.openMs), [1786410540000, 1786410600000, NEWEST_CLOSED], "oldest first");
});

await test("BITUNIX: volume comes from `quoteVol`, which on this venue holds the BASE volume", async () => {
  // The venue's two volume fields are named the wrong way round. Measured on
  // BTCUSDT: quoteVol 16.0341 x price ~64045 = 1,026,792 = the value it calls
  // baseVol. Reading `baseVol` would inflate volume by roughly the coin price.
  const page = {
    code: 0, data: [
      { open: "64034.3", high: "64045.1", low: "64030.9", close: "64045.1", quoteVol: "16.0341", baseVol: "1026789.19294", time: String(NEWEST_CLOSED) },
    ],
  };
  const { candles } = await ADAPTERS.bitunix.fetchKlines(stubFetch(page), "BTCUSDT", 0, 0);
  assert.equal(candles[0].volume, 16.0341, "base volume from the field LABELLED quoteVol");
  assert.notEqual(candles[0].volume, 1026789.19294, "not the quote turnover from the field labelled baseVol");
});

await test("BYBIT: the forming bar leads its NEWEST-FIRST list and is dropped (replay)", async () => {
  // Bybit's edge blocks this build environment by region, so this pins the
  // documented v5 shape rather than a live probe: list is newest-first and its
  // first element is the bar still forming.
  const page = {
    retCode: 0, retMsg: "OK", result: {
      list: [
        [String(FORMING), "64048.7", "64057.7", "64048.6", "64049.2", "3.7217", "238376.89904"],
        [String(NEWEST_CLOSED), "64033.9", "64048.7", "64026.3", "64048.7", "12.421", "795438.67863"],
        ["1786410600000", "63990", "64034", "63989.9", "64033.9", "16.9593", "1085773.54733"],
      ],
    },
  };
  const { candles } = await ADAPTERS.bybit.fetchKlines(stubFetch(page), "BTCUSDT", 0, 0);
  assert.ok(candles.some((c) => c.openMs === FORMING), "precondition: the raw page contains the forming bar");
  const closed = dropUnclosed(candles, NOW);
  assert.ok(!closed.some((c) => c.openMs === FORMING), "the forming bar is dropped");
  assert.equal(closed.at(-1).openMs, NEWEST_CLOSED, "newest surviving bar is the newest CLOSED one");
});

// ── RATE LIMITS ARE NOT FAILURES ────────────────────────────────────────────
// A venue saying "slow down" and a venue saying "that symbol does not exist"
// arrive down the same pipe and must not be treated alike: one wants a backoff,
// the other wants counting toward FAILING. These pin the classification at the
// adapter, which is the only place that can read the venue's own wording.
//
// The two Bitunix cases are the operator's OWN collector log, verbatim:
// `bitunix code 10006: request too frequently` and a bare `HTTP 429` on
// ONDOUSDT. Everything else here is the same shape on the other two venues.

function stubStatus(status, body = {}, headers = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  });
}

await test("HTTP 429 is classified as a rate limit, not a plain failure", async () => {
  for (const venue of ["bybit", "bitunix", "bitget", "binance"]) {
    const err = await ADAPTERS[venue].fetchKlines(stubStatus(429), "BTCUSDT", 0, 0).then(
      () => null, (e) => e,
    );
    assert.ok(err, `${venue}: 429 throws`);
    assert.equal(isRateLimit(err), true, `${venue}: 429 is a RateLimitError`);
  }
});

await test("HTTP 418 counts too — it is the last warning before an IP ban", async () => {
  const err = await ADAPTERS.bitget.fetchKlines(stubStatus(418), "BTCUSDT", 0, 0).then(() => null, (e) => e);
  assert.equal(isRateLimit(err), true);
});

await test("Retry-After is read off the response, in seconds and as an HTTP date", async () => {
  const secs = await ADAPTERS.bitunix
    .fetchKlines(stubStatus(429, {}, { "retry-after": "90" }), "BTCUSDT", 0, 0)
    .then(() => null, (e) => e);
  assert.equal(secs.retryAfterMs, 90_000, "seconds form");

  const when = new Date(Date.now() + 120_000).toUTCString();
  const dated = await ADAPTERS.bitunix
    .fetchKlines(stubStatus(429, {}, { "retry-after": when }), "BTCUSDT", 0, 0)
    .then(() => null, (e) => e);
  assert.ok(dated.retryAfterMs > 110_000 && dated.retryAfterMs <= 120_000, "HTTP-date form");

  const junk = await ADAPTERS.bitunix
    .fetchKlines(stubStatus(429, {}, { "retry-after": "soon-ish" }), "BTCUSDT", 0, 0)
    .then(() => null, (e) => e);
  assert.equal(junk.retryAfterMs, undefined, "unparseable Retry-After yields no number, never a bogus one");
});

await test("BITUNIX code 10006 — the operator's own refusal — is a rate limit", async () => {
  const err = await ADAPTERS.bitunix
    .fetchKlines(stubStatus(200, { code: "10006", msg: "request too frequently" }), "ONDOUSDT", 0, 0)
    .then(() => null, (e) => e);
  assert.equal(isRateLimit(err), true);
  assert.match(err.message, /bitunix code 10006/, "the venue's own wording survives into the message");
});

await test("BYBIT retCode 10006 and a 'too many visits' message are both rate limits", async () => {
  const byCode = await ADAPTERS.bybit
    .fetchKlines(stubStatus(200, { retCode: 10006, retMsg: "Too many visits!" }), "BTCUSDT", 0, 0)
    .then(() => null, (e) => e);
  assert.equal(isRateLimit(byCode), true, "by code");

  // A venue that invents a new code but still says it in words is still saying
  // slow down; the text is the safety net over the code list.
  const byText = await ADAPTERS.bybit
    .fetchKlines(stubStatus(200, { retCode: 99999, retMsg: "rate limit exceeded" }), "BTCUSDT", 0, 0)
    .then(() => null, (e) => e);
  assert.equal(isRateLimit(byText), true, "by wording");
});

await test("an ORDINARY venue error is NOT a rate limit — the distinction is the point", async () => {
  // Bitget's real 40053: `limit` above 200 is rejected outright. That is our
  // bug, not the venue's budget, and backing off would hide it forever.
  const err = await ADAPTERS.bitget
    .fetchKlines(stubStatus(200, { code: "40053", msg: "limit is invalid" }), "BTCUSDT", 0, 0)
    .then(() => null, (e) => e);
  assert.ok(err, "it still throws");
  assert.equal(isRateLimit(err), false, "but it is a plain failure that must count toward FAILING");

  const missing = await ADAPTERS.bitget.fetchKlines(stubStatus(404), "NOSUCHUSDT", 0, 0).then(() => null, (e) => e);
  assert.equal(isRateLimit(missing), false, "and so is a 404");
});

await test("a bar that is not on the minute grid is dropped whatever its age", () => {
  const closed = dropUnclosed([{ openMs: NEWEST_CLOSED + 137, open: 1, high: 1, low: 1, close: 1, volume: 1 }], NOW);
  assert.equal(closed.length, 0, "off-grid openMs never survives");
});

await test("the STORE refuses a forming bar even if an adapter let one through", () => {
  const store = new CandleStore(tmpDir("candles"));
  const mk = (t) => ({ openMs: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
  const r = store.write("bybit", "BTCUSDT", [mk(NEWEST_CLOSED), mk(FORMING)], newestClosedOpenMs(NOW));
  assert.equal(r.newlyFilled, 1, "only the closed bar reached disk");
  const { rows } = store.readWindow("bybit", "BTCUSDT", NEWEST_CLOSED, FORMING);
  assert.deepEqual(rows.map((r2) => r2[0]), [NEWEST_CLOSED], "the forming minute is not stored");
});

// ── STORE: PRESENCE, GAPS, ROUND-TRIP ───────────────────────────────────────

const DAY0 = Date.parse("2026-08-01T00:00:00.000Z");
function mkCandle(t, i) {
  return { openMs: t, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000 + i };
}

await test("candles round-trip through the binary day file exactly", () => {
  const store = new CandleStore(tmpDir("candles"));
  const src = [mkCandle(DAY0, 0), mkCandle(DAY0 + MINUTE_MS, 1), mkCandle(DAY0 + 2 * MINUTE_MS, 2)];
  store.write("bitget", "BTCUSDT", src);
  const { rows, gaps } = store.readWindow("bitget", "BTCUSDT", DAY0, DAY0 + 2 * MINUTE_MS);
  assert.deepEqual(gaps, [], "no gaps in a contiguous range");
  assert.deepEqual(rows, src.map((c) => [c.openMs, c.open, c.high, c.low, c.close, c.volume]));
  assert.ok(rows.every((r) => r.every((n) => typeof n === "number")), "numbers on the wire, never strings");
});

await test("a missing minute is reported as an explicit gap, not smoothed over", () => {
  const store = new CandleStore(tmpDir("candles"));
  // minutes 0,1,   3,4   — minute 2 deliberately absent
  store.write("bitget", "ETHUSDT", [
    mkCandle(DAY0, 0), mkCandle(DAY0 + MINUTE_MS, 1),
    mkCandle(DAY0 + 3 * MINUTE_MS, 3), mkCandle(DAY0 + 4 * MINUTE_MS, 4),
  ]);
  const { rows, gaps } = store.readWindow("bitget", "ETHUSDT", DAY0, DAY0 + 4 * MINUTE_MS);
  assert.equal(rows.length, 4, "the four held minutes are returned");
  assert.deepEqual(gaps, [[DAY0 + 2 * MINUTE_MS, DAY0 + 2 * MINUTE_MS]], "the one hole is listed exactly");
});

await test("several separate holes each get their own gap range", () => {
  const store = new CandleStore(tmpDir("candles"));
  const keep = [0, 1, 4, 7, 8];
  store.write("bitget", "SOLUSDT", keep.map((i) => mkCandle(DAY0 + i * MINUTE_MS, i)));
  const { gaps } = store.readWindow("bitget", "SOLUSDT", DAY0, DAY0 + 8 * MINUTE_MS);
  assert.deepEqual(gaps, [
    [DAY0 + 2 * MINUTE_MS, DAY0 + 3 * MINUTE_MS],
    [DAY0 + 5 * MINUTE_MS, DAY0 + 6 * MINUTE_MS],
  ], "two distinct runs, each with its true start and end");
});

await test("a window that starts before our history reports the LEADING absence as a gap", () => {
  // This is the new-listing shape and the incident this service exists against:
  // a thin history must never come back looking complete.
  const store = new CandleStore(tmpDir("candles"));
  store.write("bitunix", "NEWUSDT", [mkCandle(DAY0 + 10 * MINUTE_MS, 10), mkCandle(DAY0 + 11 * MINUTE_MS, 11)]);
  const { rows, gaps } = store.readWindow("bitunix", "NEWUSDT", DAY0, DAY0 + 11 * MINUTE_MS);
  assert.equal(rows.length, 2);
  assert.deepEqual(gaps, [[DAY0, DAY0 + 9 * MINUTE_MS]], "the ten minutes we never had are stated");
});

await test("gaps span across a day-file boundary as one range", () => {
  const store = new CandleStore(tmpDir("candles"));
  const dayEnd = DAY0 + 1439 * MINUTE_MS;
  store.write("bitget", "XRPUSDT", [mkCandle(dayEnd - MINUTE_MS, 1), mkCandle(dayEnd + 3 * MINUTE_MS, 2)]);
  const { gaps } = store.readWindow("bitget", "XRPUSDT", dayEnd - MINUTE_MS, dayEnd + 3 * MINUTE_MS);
  assert.deepEqual(gaps, [[dayEnd, dayEnd + 2 * MINUTE_MS]], "one gap crossing midnight, not two");
});

await test("re-writing the same minutes is idempotent and adds nothing", () => {
  const store = new CandleStore(tmpDir("candles"));
  const src = [mkCandle(DAY0, 0), mkCandle(DAY0 + MINUTE_MS, 1)];
  const first = store.write("bybit", "ADAUSDT", src);
  const again = store.write("bybit", "ADAUSDT", src);
  assert.equal(first.newlyFilled, 2, "first write fills two slots");
  assert.equal(again.newlyFilled, 0, "a repeat fetch fills none");
  assert.equal(store.coverage("bybit", "ADAUSDT", true).count, 2, "still two candles held");
});

await test("a day file is exactly 1440 fixed slots and named for its UTC day", () => {
  const root = tmpDir("candles");
  const store = new CandleStore(root);
  store.write("bitget", "BTCUSDT", [mkCandle(DAY0, 0)]);
  const file = `${root}/bitget/BTCUSDT/${dayKey(DAY0)}.c1m`;
  assert.equal(fs.statSync(file).size, DAY_FILE_BYTES, "fixed-width, so a slot is a seek not a scan");
  assert.equal(dayKey(DAY0), "2026-08-01");
});

await test("a slot whose stored openMs contradicts its position is treated as ABSENT", () => {
  // Corruption or an older layout must surface as a gap, never as a candle at
  // the wrong minute — a wrong price at a right-looking time is the one error
  // the bot's verification could not distinguish from a venue disagreement.
  const root = tmpDir("candles");
  const store = new CandleStore(root);
  store.write("bitget", "BTCUSDT", [mkCandle(DAY0, 0), mkCandle(DAY0 + MINUTE_MS, 1)]);
  const file = `${root}/bitget/BTCUSDT/${dayKey(DAY0)}.c1m`;
  const buf = fs.readFileSync(file);
  buf.writeBigInt64LE(BigInt(DAY0 + 999 * MINUTE_MS), 48); // slot 1 now claims a different minute
  fs.writeFileSync(file, buf);
  const { rows, gaps } = store.readWindow("bitget", "BTCUSDT", DAY0, DAY0 + MINUTE_MS);
  assert.deepEqual(rows.map((r) => r[0]), [DAY0], "the mismatched slot is not returned");
  assert.deepEqual(gaps, [[DAY0 + MINUTE_MS, DAY0 + MINUTE_MS]], "it shows up as a gap instead");
});

// ── SIGNATURE CANONICALISATION ──────────────────────────────────────────────

await test("the canonical key order is exactly the contract's, in order", () => {
  assert.deepEqual([...SEED_CANONICAL_KEY_ORDER],
    ["v", "venue", "symbol", "interval", "fromMs", "toMs", "lastClosedMs", "rows", "gaps", "keyId"]);
});

await test("canonicalBytes serialises in the pinned order regardless of the input object's order", () => {
  const scrambled = {
    keyId: "seed-1", gaps: [], rows: [[DAY0, 1, 2, 0.5, 1.5, 10]], lastClosedMs: DAY0,
    toMs: DAY0, fromMs: DAY0, interval: "1", symbol: "BTCUSDT", venue: "bitget", v: 1,
  };
  const bytes = canonicalBytes(scrambled).toString("utf8");
  assert.equal(
    bytes,
    '{"v":1,"venue":"bitget","symbol":"BTCUSDT","interval":"1","fromMs":' + DAY0 +
    ',"toMs":' + DAY0 + ',"lastClosedMs":' + DAY0 + ',"rows":[[' + DAY0 + ',1,2,0.5,1.5,10]],"gaps":[],"keyId":"seed-1"}',
    "byte-for-byte the documented serialisation",
  );
  assert.ok(!bytes.includes("\n") && !bytes.includes("  "), "no whitespace, no indentation");
});

await test("canonicalBytes ignores any `sig` present on the input", () => {
  const base = {
    v: 1, venue: "bitget", symbol: "BTCUSDT", interval: "1", fromMs: 0, toMs: 0,
    lastClosedMs: 0, rows: [], gaps: [], keyId: "seed-1",
  };
  assert.equal(
    canonicalBytes({ ...base, sig: "AAAA" }).toString("utf8"),
    canonicalBytes(base).toString("utf8"),
    "the signature is not part of what is signed",
  );
});

function seedDeps(store, sign, known = () => true) {
  return { store, keyId: "seed-1", sign, symbolKnown: known };
}

await test("a built seed verifies under Ed25519 over exactly the canonical bytes", () => {
  const { store: licenseStore } = freshStore();
  const candleStore = new CandleStore(tmpDir("candles"));
  candleStore.write("bitget", "BTCUSDT", [mkCandle(DAY0, 0), mkCandle(DAY0 + MINUTE_MS, 1)]);
  const out = buildSeed(
    { venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 + MINUTE_MS },
    seedDeps(candleStore, (b) => licenseStore.sign(b)),
  );
  assert.equal(out.ok, true);
  const { sig, ...unsigned } = out.payload;
  const pub = createPublicKey(licenseStore.publicKeyPem());
  assert.equal(
    edVerify(null, canonicalBytes(unsigned), pub, Buffer.from(sig, "base64")),
    true,
    "signature verifies over the sig-stripped canonical bytes",
  );
});

await test("the serialised response's own key order IS the canonical order plus sig last", () => {
  const { store: licenseStore } = freshStore();
  const candleStore = new CandleStore(tmpDir("candles"));
  candleStore.write("bitget", "BTCUSDT", [mkCandle(DAY0, 0)]);
  const out = buildSeed({ venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 },
    seedDeps(candleStore, (b) => licenseStore.sign(b)));
  assert.deepEqual(Object.keys(out.payload),
    [...SEED_CANONICAL_KEY_ORDER, "sig"],
    "a verifier that strips the last key and re-signs gets identical bytes");
});

await test("tampering with a single row makes the signature fail", () => {
  const { store: licenseStore } = freshStore();
  const candleStore = new CandleStore(tmpDir("candles"));
  candleStore.write("bitget", "BTCUSDT", [mkCandle(DAY0, 0)]);
  const out = buildSeed({ venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 },
    seedDeps(candleStore, (b) => licenseStore.sign(b)));
  const { sig, ...unsigned } = out.payload;
  unsigned.rows[0][4] += 0.01; // move one close price
  const pub = createPublicKey(licenseStore.publicKeyPem());
  assert.equal(edVerify(null, canonicalBytes(unsigned), pub, Buffer.from(sig, "base64")), false);
});

await test("a seed signed for one venue does not verify as another", () => {
  const { store: licenseStore } = freshStore();
  const candleStore = new CandleStore(tmpDir("candles"));
  candleStore.write("bitget", "BTCUSDT", [mkCandle(DAY0, 0)]);
  const out = buildSeed({ venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 },
    seedDeps(candleStore, (b) => licenseStore.sign(b)));
  const { sig, ...unsigned } = out.payload;
  unsigned.venue = "bybit";
  const pub = createPublicKey(licenseStore.publicKeyPem());
  assert.equal(edVerify(null, canonicalBytes(unsigned), pub, Buffer.from(sig, "base64")), false,
    "venue is inside the signed bytes, so one venue's candles cannot be relabelled as another's");
});

// ── SEED SEMANTICS ──────────────────────────────────────────────────────────

await test("lastClosedMs is the newest candle HELD, not the end of the asked-for window", () => {
  const { store: licenseStore } = freshStore();
  const candleStore = new CandleStore(tmpDir("candles"));
  candleStore.write("bitget", "BTCUSDT", [mkCandle(DAY0, 0), mkCandle(DAY0 + MINUTE_MS, 1)]);
  const out = buildSeed(
    { venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 + 5000 * MINUTE_MS },
    seedDeps(candleStore, (b) => licenseStore.sign(b)),
  );
  assert.equal(out.payload.lastClosedMs, DAY0 + MINUTE_MS, "authoritative reach comes from the data");
  assert.equal(out.payload.toMs, DAY0 + 5000 * MINUTE_MS, "toMs still echoes what was asked");
});

await test("the stretch after lastClosedMs is NOT reported as a gap", () => {
  const { store: licenseStore } = freshStore();
  const candleStore = new CandleStore(tmpDir("candles"));
  candleStore.write("bitget", "BTCUSDT", [mkCandle(DAY0, 0), mkCandle(DAY0 + MINUTE_MS, 1)]);
  const out = buildSeed(
    { venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 + 5000 * MINUTE_MS },
    seedDeps(candleStore, (b) => licenseStore.sign(b)),
  );
  assert.deepEqual(out.payload.gaps, [], "time that has not happened is not missing history — lastClosedMs says where we stop");
});

await test("a thin new listing is served WITH its leading gap stated, never as a complete seed", () => {
  const { store: licenseStore } = freshStore();
  const candleStore = new CandleStore(tmpDir("candles"));
  // 120 minutes of history against a request for 30 days.
  const start = DAY0 + 40000 * MINUTE_MS;
  const held = [];
  for (let i = 0; i < 120; i++) held.push(mkCandle(start + i * MINUTE_MS, i));
  candleStore.write("bitunix", "NEWUSDT", held);
  const fromMs = start - 43200 * MINUTE_MS;
  const out = buildSeed({ venue: "bitunix", symbol: "NEWUSDT", fromMs, toMs: start + 119 * MINUTE_MS },
    seedDeps(candleStore, (b) => licenseStore.sign(b)));
  assert.equal(out.ok, true, "it IS served — the two hours are real");
  assert.equal(out.payload.rows.length, 120);
  assert.deepEqual(out.payload.gaps, [[fromMs, start - MINUTE_MS]],
    "the 30 days we never had is one explicit gap the reader cannot miss");
});

await test("an empty result is 503, never a 200 with empty rows", () => {
  const { store: licenseStore } = freshStore();
  const candleStore = new CandleStore(tmpDir("candles"));
  candleStore.write("bitget", "BTCUSDT", [mkCandle(DAY0 + 5000 * MINUTE_MS, 0)]);
  // Window entirely before anything we hold.
  const out = buildSeed({ venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 + 10 * MINUTE_MS },
    seedDeps(candleStore, (b) => licenseStore.sign(b)));
  assert.equal(out.ok, false);
  assert.equal(out.code, 503, "'I hold nothing here' must be distinguishable from 'the window is empty'");
});

await test("a symbol with nothing collected at all is 503; one the venue does not list is 404", () => {
  const { store: licenseStore } = freshStore();
  const candleStore = new CandleStore(tmpDir("candles"));
  const sign = (b) => licenseStore.sign(b);
  const known = buildSeed({ venue: "bitget", symbol: "FRESHUSDT", fromMs: DAY0, toMs: DAY0 + MINUTE_MS },
    seedDeps(candleStore, sign, () => true));
  assert.equal(known.code, 503, "tracked but not yet collected: ask again later");
  const unknown = buildSeed({ venue: "bitget", symbol: "NOTAPAIR", fromMs: DAY0, toMs: DAY0 + MINUTE_MS },
    seedDeps(candleStore, sign, () => false));
  assert.equal(unknown.code, 404, "not listed on this venue: later will not help");
});

await test("a malformed or oversized window is 400", () => {
  const { store: licenseStore } = freshStore();
  const candleStore = new CandleStore(tmpDir("candles"));
  const d = seedDeps(candleStore, (b) => licenseStore.sign(b));
  assert.equal(buildSeed({ venue: "bitget", symbol: "BTCUSDT", fromMs: 10, toMs: 5 }, d).code, 400, "reversed window");
  assert.equal(buildSeed({ venue: "bitget", symbol: "BTCUSDT", fromMs: NaN, toMs: 5 }, d).code, 400, "non-numeric");
  assert.equal(buildSeed({ venue: "bitget", symbol: "BTCUSDT", fromMs: 0, toMs: 60_000 * 60_001 }, d).code, 400, "too large");
});

// ── v0.2.15 — PER-VENUE REQUEST CEILINGS ──────────────────────────────────
await test("each venue collects at its OWN documented rate, not one global figure", async () => {
  const { ADAPTERS, VENUE_IDS } = await import("../dist/src/candles/venues.js");
  const { collectorOptionsFromEnv } = await import("../dist/src/candles/service.js");

  // Every venue must state a ceiling, and none may exceed its documented
  // public limit. These are the numbers the hub promises the operator it will
  // stay under, so they are asserted rather than left to a comment.
  //
  // v0.2.19 — Aster's published limit is not a request rate at all: it is
  // REQUEST_WEIGHT 2400 per minute, and a kline page costs 5 of it. Its budget
  // is therefore expressed in the venue's OWN units and converted, because a
  // request-count entry here would be a number nobody at Aster ever published.
  const documented = { bybit: 120, bitunix: 10, bitget: 20 };
  const weightBudgeted = {
    binance: { perMinute: 2400, weightPerRequest: 5 },
    aster: { perMinute: 2400, weightPerRequest: 5 },
  };
  for (const v of VENUE_IDS) {
    const rps = ADAPTERS[v].publicRequestsPerSecond;
    assert.ok(rps > 0, `${v} states a ceiling`);
    const w = weightBudgeted[v];
    if (w) {
      const allowedRps = w.perMinute / w.weightPerRequest / 60;
      assert.ok(rps <= allowedRps / 2,
        `${v} sits at or below HALF the ${allowedRps.toFixed(1)}/s its ${w.perMinute} weight/min allows (got ${rps})`);
      continue;
    }
    assert.ok(rps <= documented[v] / 2,
      `${v} sits at or below HALF its documented ${documented[v]}/s (got ${rps})`);
  }
  assert.ok(
    VENUE_IDS.every((v) => documented[v] !== undefined || weightBudgeted[v] !== undefined),
    "a venue added to the registry must state which published limit it is paced to",
  );

  // With no operator override, the per-venue table is populated…
  const auto = collectorOptionsFromEnv({});
  assert.ok(auto.perVenueRequestsPerSecond, "the per-venue table is present when HUB_CANDLE_RPS is unset");
  assert.equal(auto.perVenueRequestsPerSecond.bitunix, ADAPTERS.bitunix.publicRequestsPerSecond);
  assert.equal(auto.perVenueRequestsPerSecond.bitget, ADAPTERS.bitget.publicRequestsPerSecond);
  assert.equal(auto.perVenueRequestsPerSecond.binance, ADAPTERS.binance.publicRequestsPerSecond);

  // …and the operator's own number CLEARS it, so one figure they set means the
  // same thing on every venue — including when it is LOWER than the defaults,
  // which is the direction that matters if they are being rate limited.
  const forced = collectorOptionsFromEnv({ HUB_CANDLE_RPS: "1.5" });
  assert.equal(forced.perVenueRequestsPerSecond, undefined, "an explicit rate clears the table");
  assert.equal(forced.requestsPerSecond, 1.5);
  assert.ok(forced.minRequestsPerSecond <= 1.5, "and the floor can never sit above it");
});


// ── THE WHOLE-VENUE SNAPSHOT ────────────────────────────────────────────────
//
// The bot's volatility filter asks the same question of every pair at once —
// "the last N closed candles at this timeframe" — so what is asserted here is
// what makes one response usable for that: the fold's arithmetic, the buckets'
// UTC alignment and contiguity, that the forming bucket never appears, and that
// a pair we cannot answer for completely is NAMED rather than served short.

const SNAP_DAY = Date.parse("2026-08-02T00:00:00.000Z");

/** A clock at which `lastClosedMs` is the newest COMPLETE bucket: one bucket
 *  past it, plus the settle lag. Derived rather than typed, so the fixtures
 *  cannot drift from the rule the module actually applies. */
function clockFor(lastClosedMs, intervalMinutes) {
  return lastClosedMs + intervalMinutes * MINUTE_MS + SNAPSHOT_SETTLE_LAG_MS;
}

function snapDeps(store, sign, symbols) {
  return { store, keyId: "seed-1", sign, symbols: () => symbols };
}

/** Write `minutes` consecutive 1m candles from `startMs`, one per entry of
 *  `rows` = [open, high, low, close, volume]. */
function writeMinutes(store, venue, symbol, startMs, rows) {
  store.write(venue, symbol, rows.map((r, i) => ({
    openMs: startMs + i * MINUTE_MS,
    open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4],
  })));
}

await test("the newest COMPLETE bucket is UTC-aligned, and the forming one is never it", () => {
  const dayOpen = SNAP_DAY;
  // Mid-afternoon on the day: the daily bucket that OPENED today is still
  // forming, so the newest complete one is yesterday's.
  const midday = dayOpen + 14 * 3_600_000;
  assert.equal(newestCompleteBucketOpenMs(midday, 1440), dayOpen - 1440 * MINUTE_MS,
    "the bucket in progress is never published; the one before it is");
  assert.equal(newestCompleteBucketOpenMs(midday, 1440) % (1440 * MINUTE_MS), 0, "UTC-aligned");
  for (const interval of SNAPSHOT_INTERVALS) {
    const last = newestCompleteBucketOpenMs(midday, interval);
    assert.equal(last % (interval * MINUTE_MS), 0, `${interval}m buckets sit on the grid`);
    assert.ok(last + interval * MINUTE_MS <= midday, `${interval}m: the published bucket has already closed`);
  }
});

await test("a bucket is not published until its LAST MINUTE has had time to land", () => {
  const boundary = SNAP_DAY + 3_600_000; // an hourly boundary
  const justAfter = boundary + 1_000;
  assert.equal(newestCompleteBucketOpenMs(justAfter, 60), boundary - 2 * 3_600_000,
    "one second after the boundary the freshly-closed hour is not served — its last minute may not be collected yet");
  assert.equal(newestCompleteBucketOpenMs(boundary + SNAPSHOT_SETTLE_LAG_MS, 60), boundary - 3_600_000,
    "once the settle lag has passed it is");
});

await test("the cache window turns over exactly on the next boundary plus the lag", () => {
  const last = SNAP_DAY - 1440 * MINUTE_MS;
  const expires = snapshotExpiresAtMs(last, 1440);
  assert.equal(newestCompleteBucketOpenMs(expires - 1, 1440), last, "one ms early: the same window, so a rebuild would repeat itself");
  assert.equal(newestCompleteBucketOpenMs(expires, 1440), last + 1440 * MINUTE_MS, "at the instant it expires, a NEWER window exists");
});

await test("the fold is first open, max high, min low, last close, summed volume", () => {
  const store = new CandleStore(tmpDir("candles"));
  // Ten minutes = two 5m buckets, values written out so the assertions are the
  // contract's arithmetic and not a second implementation of it.
  writeMinutes(store, "bitget", "FOLDUSDT", SNAP_DAY, [
    [10, 12, 9, 11, 1], [11, 18, 10, 13, 2], [13, 14, 4, 12, 3], [12, 15, 11, 14, 4], [14, 16, 13, 15, 5],
    [20, 22, 19, 21, 6], [21, 28, 20, 23, 7], [23, 24, 14, 22, 8], [22, 25, 21, 24, 9], [24, 26, 23, 25, 10],
  ]);
  const { rows } = store.readWindow("bitget", "FOLDUSDT", SNAP_DAY, SNAP_DAY + 9 * MINUTE_MS);
  const folded = foldSymbolWindow(rows, SNAP_DAY, 2, 5);
  assert.equal(folded.ok, true);
  assert.deepEqual(folded.rows, [
    [SNAP_DAY, 10, 18, 4, 15, 15],
    [SNAP_DAY + 5 * MINUTE_MS, 20, 28, 14, 25, 40],
  ], "open from the first minute, close from the last, high/low across the bucket, volume summed");
});

await test("a hole inside the window skips the symbol as `gap` — never a bucket folded from what survived", () => {
  const store = new CandleStore(tmpDir("candles"));
  const ten = Array.from({ length: 10 }, (_, i) => [10 + i, 20 + i, 5 + i, 12 + i, 1]);
  // Minute 7 is never collected, so the SECOND 5m bucket has a hole in it while
  // the first is perfect.
  ten.forEach((r, i) => {
    if (i !== 7) writeMinutes(store, "bitget", "HOLEUSDT", SNAP_DAY + i * MINUTE_MS, [r]);
  });
  const { rows } = store.readWindow("bitget", "HOLEUSDT", SNAP_DAY, SNAP_DAY + 9 * MINUTE_MS);
  assert.equal(rows.length, 9, "precondition: nine of the ten minutes are held");
  const folded = foldSymbolWindow(rows, SNAP_DAY, 2, 5);
  assert.equal(folded.ok, false);
  assert.equal(folded.reason, "gap", "the whole symbol is skipped, including the bucket that WAS complete");
});

await test("a tail we have not collected is a `gap`, and history that starts mid-window is `short`", () => {
  const store = new CandleStore(tmpDir("candles"));
  const ten = Array.from({ length: 10 }, () => [1, 2, 0.5, 1.5, 1]);
  // Trailing absence: minutes 0..7 held, 8 and 9 never fetched.
  writeMinutes(store, "bitget", "TAILUSDT", SNAP_DAY, ten.slice(0, 8));
  const tail = store.readWindow("bitget", "TAILUSDT", SNAP_DAY, SNAP_DAY + 9 * MINUTE_MS).rows;
  assert.equal(foldSymbolWindow(tail, SNAP_DAY, 2, 5).reason, "gap", "a stale tail is a hole in what we hold");
  // Leading absence: the pair was listed halfway through the window.
  writeMinutes(store, "bitget", "NEWUSDT", SNAP_DAY + 5 * MINUTE_MS, ten.slice(0, 5));
  const lead = store.readWindow("bitget", "NEWUSDT", SNAP_DAY, SNAP_DAY + 9 * MINUTE_MS).rows;
  assert.equal(foldSymbolWindow(lead, SNAP_DAY, 2, 5).reason, "short", "not a collector fault — the history is simply not that deep");
  assert.equal(foldSymbolWindow([], SNAP_DAY, 2, 5).reason, "short", "and nothing at all is short, not gapped");
  // The same leading absence on a pair we were ALREADY collecting is a hole in
  // what we hold, not a shallow history — which is a different fault with a
  // different owner, so the two are not one label.
  assert.equal(foldSymbolWindow(lead, SNAP_DAY, 2, 5, SNAP_DAY - 60 * MINUTE_MS).reason, "gap",
    "history that reaches back BEFORE the window plus a missing leading minute is a gap");
});

await test("a full window yields EXACTLY depth buckets, contiguous and UTC-aligned", () => {
  const store = new CandleStore(tmpDir("candles"));
  // Three whole days of 1m candles: the shipped rule is 1d x 10, so the daily
  // fold is the case this feature exists for.
  const days = 3;
  for (let d = 0; d < days; d++) {
    const start = SNAP_DAY + d * 1440 * MINUTE_MS;
    writeMinutes(store, "binance", "BTCUSDT", start,
      Array.from({ length: 1440 }, (_, i) => [100 + i, 200 + i, 50 + i, 150 + i, 2]));
  }
  const lastClosedMs = SNAP_DAY + 2 * 1440 * MINUTE_MS;
  const out = buildSnapshot(
    { venue: "binance", interval: 1440, depth: 3, now: clockFor(lastClosedMs, 1440) },
    snapDeps(store, () => Buffer.alloc(64), ["BTCUSDT"]),
  );
  assert.equal(out.ok, true);
  assert.equal(out.payload.lastClosedMs, lastClosedMs);
  assert.equal(out.payload.symbols.length, 1);
  const [symbol, rows] = out.payload.symbols[0];
  assert.equal(symbol, "BTCUSDT");
  assert.equal(rows.length, 3, "exactly `depth` buckets, never more and never fewer");
  rows.forEach((r, i) => {
    assert.equal(r[0] % (1440 * MINUTE_MS), 0, "each bucket opens on a UTC day boundary");
    if (i > 0) assert.equal(r[0] - rows[i - 1][0], 1440 * MINUTE_MS, "contiguous on the interval grid");
    assert.ok(r.every((n) => typeof n === "number" && Number.isFinite(n)), "finite JSON numbers");
  });
  assert.equal(rows.at(-1)[0], lastClosedMs, "the newest bucket is the newest COMPLETE one");
  assert.equal(rows[0][5], 2880, "a day's volume is the sum of its 1,440 minutes");
});

await test("the forming day is never in the snapshot, however many of its minutes we hold", () => {
  const store = new CandleStore(tmpDir("candles"));
  for (let d = 0; d < 2; d++) {
    writeMinutes(store, "binance", "ETHUSDT", SNAP_DAY + d * 1440 * MINUTE_MS,
      Array.from({ length: 1440 }, () => [1, 2, 0.5, 1.5, 1]));
  }
  // And 600 minutes of the day after that — a bucket in progress.
  const forming = SNAP_DAY + 2 * 1440 * MINUTE_MS;
  writeMinutes(store, "binance", "ETHUSDT", forming, Array.from({ length: 600 }, () => [1, 2, 0.5, 1.5, 1]));
  const out = buildSnapshot(
    { venue: "binance", interval: 1440, depth: 2, now: forming + 600 * MINUTE_MS },
    snapDeps(store, () => Buffer.alloc(64), ["ETHUSDT"]),
  );
  assert.equal(out.ok, true);
  const opens = out.payload.symbols[0][1].map((r) => r[0]);
  assert.deepEqual(opens, [SNAP_DAY, SNAP_DAY + 1440 * MINUTE_MS], "the two closed days");
  assert.ok(!opens.includes(forming), "the day in progress is absent, not folded short");
});

await test("skipped symbols carry no rows, and every tracked symbol is accounted for exactly once", () => {
  const store = new CandleStore(tmpDir("candles"));
  const full = Array.from({ length: 10 }, () => [1, 2, 0.5, 1.5, 1]);
  writeMinutes(store, "bitget", "GOODUSDT", SNAP_DAY, full);
  writeMinutes(store, "bitget", "LATEUSDT", SNAP_DAY + 5 * MINUTE_MS, full.slice(0, 5)); // short
  full.forEach((r, i) => { if (i !== 3) writeMinutes(store, "bitget", "HOLYUSDT", SNAP_DAY + i * MINUTE_MS, [r]); }); // gap
  const lastClosedMs = SNAP_DAY + 5 * MINUTE_MS;
  const tracked = ["GOODUSDT", "LATEUSDT", "HOLYUSDT", "UNSEENUSDT"];
  const out = buildSnapshot(
    { venue: "bitget", interval: 5, depth: 2, now: clockFor(lastClosedMs, 5) },
    snapDeps(store, () => Buffer.alloc(64), tracked),
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.payload.symbols.map((s) => s[0]), ["GOODUSDT"]);
  assert.deepEqual(out.payload.skipped, [
    ["HOLYUSDT", "gap"],
    ["LATEUSDT", "short"],
    ["UNSEENUSDT", "short"],
  ], "each skipped pair is named with the reason it was skipped");
  const named = new Set([...out.payload.symbols.map((s) => s[0]), ...out.payload.skipped.map((s) => s[0])]);
  assert.equal(named.size, tracked.length, "every tracked symbol appears exactly once, served or skipped");
});

await test("a venue where nothing is deep enough is 503, never a 200 with no symbols", () => {
  const store = new CandleStore(tmpDir("candles"));
  writeMinutes(store, "bitget", "COLDUSDT", SNAP_DAY, [[1, 2, 0.5, 1.5, 1]]);
  const out = buildSnapshot(
    { venue: "bitget", interval: 5, depth: 2, now: clockFor(SNAP_DAY + 5 * MINUTE_MS, 5) },
    snapDeps(store, () => Buffer.alloc(64), ["COLDUSDT"]),
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 503, "'come back later' — not an empty roster that reads as 'this venue has nothing'");
});

await test("a bad interval or depth is refused by the builder as well as by the route", () => {
  const store = new CandleStore(tmpDir("candles"));
  const d = snapDeps(store, () => Buffer.alloc(64), ["BTCUSDT"]);
  const now = clockFor(SNAP_DAY, 5);
  for (const interval of [0, 2, 7, 1441, 1.5, NaN]) {
    assert.equal(buildSnapshot({ venue: "bitget", interval, depth: 2, now }, d).code, 400, `interval ${interval}`);
  }
  for (const depth of [0, -1, 1.5, SNAPSHOT_MAX_DEPTH + 1, NaN]) {
    assert.equal(buildSnapshot({ venue: "bitget", interval: 5, depth, now }, d).code, 400, `depth ${depth}`);
  }
});

// ── SNAPSHOT SIGNATURE CANONICALISATION ─────────────────────────────────────

await test("the snapshot's canonical key order is exactly the contract's, in order", () => {
  assert.deepEqual([...SNAPSHOT_CANONICAL_KEY_ORDER],
    ["v", "venue", "interval", "depth", "generatedAtMs", "lastClosedMs", "symbols", "skipped", "keyId"]);
});

await test("canonicalSnapshotBytes serialises in the pinned order and ignores any `sig`", () => {
  const base = {
    v: 1, venue: "binance", interval: 1440, depth: 1, generatedAtMs: 7, lastClosedMs: SNAP_DAY,
    symbols: [["BTCUSDT", [[SNAP_DAY, 1, 2, 0.5, 1.5, 10]]]], skipped: [["ETHUSDT", "gap"]], keyId: "seed-1",
  };
  const scrambled = {
    keyId: "seed-1", skipped: base.skipped, symbols: base.symbols, lastClosedMs: SNAP_DAY,
    generatedAtMs: 7, depth: 1, interval: 1440, venue: "binance", v: 1,
  };
  const bytes = canonicalSnapshotBytes(scrambled).toString("utf8");
  assert.equal(
    bytes,
    '{"v":1,"venue":"binance","interval":1440,"depth":1,"generatedAtMs":7,"lastClosedMs":' + SNAP_DAY +
    ',"symbols":[["BTCUSDT",[[' + SNAP_DAY + ',1,2,0.5,1.5,10]]]],"skipped":[["ETHUSDT","gap"]],"keyId":"seed-1"}',
    "byte-for-byte the documented serialisation",
  );
  assert.ok(!bytes.includes("\n") && !bytes.includes("  "), "no whitespace, no indentation");
  assert.equal(canonicalSnapshotBytes({ ...base, sig: "AAAA" }).toString("utf8"), bytes,
    "the signature is not part of what is signed");
});

await test("a built snapshot verifies under Ed25519 over exactly the canonical bytes", () => {
  const { store: licenseStore } = freshStore();
  const store = new CandleStore(tmpDir("candles"));
  writeMinutes(store, "bitget", "BTCUSDT", SNAP_DAY,
    Array.from({ length: 10 }, (_, i) => [100 + i, 110 + i, 90 + i, 105 + i, 1 + i]));
  const out = buildSnapshot(
    { venue: "bitget", interval: 5, depth: 2, now: clockFor(SNAP_DAY + 5 * MINUTE_MS, 5) },
    snapDeps(store, (b) => licenseStore.sign(b), ["BTCUSDT"]),
  );
  assert.equal(out.ok, true);
  assert.equal(out.payload.keyId, "seed-1", "the keyId names the key that signed it");
  const { sig, ...unsigned } = out.payload;
  const pub = createPublicKey(licenseStore.publicKeyPem());
  assert.equal(edVerify(null, canonicalSnapshotBytes(unsigned), pub, Buffer.from(sig, "base64")), true,
    "a client that strips `sig` and re-serialises in the documented order verifies it");
  // And the wire bytes are the canonical bytes plus the signature, so a reader
  // that parses the response and re-serialises the other nine keys gets what
  // was signed without re-ordering anything.
  const wire = JSON.stringify(out.payload);
  assert.ok(wire.startsWith(canonicalSnapshotBytes(unsigned).toString("utf8").slice(0, -1)),
    "`sig` rides last on the wire object");

  for (const tamper of [
    (p) => { p.symbols[0][1][0][4] += 0.01; },      // a close price
    (p) => { p.venue = "bybit"; },                   // relabel the venue
    (p) => { p.interval = 15; },                     // relabel the timeframe
    (p) => { p.lastClosedMs += 5 * MINUTE_MS; },     // move the window
    (p) => { p.skipped.push(["ETHUSDT", "gap"]); },  // add a skip nobody signed
  ]) {
    const copy = JSON.parse(JSON.stringify(unsigned));
    tamper(copy);
    assert.equal(edVerify(null, canonicalSnapshotBytes(copy), pub, Buffer.from(sig, "base64")), false,
      "every field in the envelope is inside the signed bytes");
  }
});

summary("candles");
