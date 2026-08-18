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
  for (const venue of ["bybit", "bitunix", "bitget"]) {
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
  const weightBudgeted = { aster: { perMinute: 2400, weightPerRequest: 5 } };
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

  // …and the operator's own number CLEARS it, so one figure they set means the
  // same thing on every venue — including when it is LOWER than the defaults,
  // which is the direction that matters if they are being rate limited.
  const forced = collectorOptionsFromEnv({ HUB_CANDLE_RPS: "1.5" });
  assert.equal(forced.perVenueRequestsPerSecond, undefined, "an explicit rate clears the table");
  assert.equal(forced.requestsPerSecond, 1.5);
  assert.ok(forced.minRequestsPerSecond <= 1.5, "and the floor can never sit above it");
});

summary("candles");
