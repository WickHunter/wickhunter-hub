// Higher-timeframe v2 cache, signature, provenance and warm-load behavior.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { test, summary, tmpDir, freshHub } from "./helpers.mjs";
import { CandleStore, MINUTE_MS, settledOpenMs } from "../dist/src/candles/store.js";
import { VenueCollector, DEFAULT_COLLECTOR_OPTIONS } from "../dist/src/candles/collector.js";
import {
  TimeframeHistory, canonicalTimeframeBytes, TIMEFRAME_CANONICAL_KEY_ORDER,
} from "../dist/src/candles/timeframe.js";
import { ADAPTERS, fetchNativeTimeframeKlines, nativeTimeframeIntervals } from "../dist/src/candles/venues.js";

const HOUR = 60 * MINUTE_MS;
const DAY = 24 * HOUR;
const DAY0 = Date.parse("2026-08-01T00:00:00.000Z");
const NOW = DAY0 + 2 * DAY + 17 * MINUTE_MS;
const pair = generateKeyPairSync("ed25519");
const sign = (bytes) => edSign(null, bytes, pair.privateKey);
const candle = (openMs, n = 0) => ({ openMs, open: 100 + n, high: 102 + n, low: 99 + n, close: 101 + n, volume: 2 + n });

function history(prefix = "tf") {
  const root = tmpDir(prefix);
  const minutes = new CandleStore(`${root}/minutes`);
  return { root, minutes, value: new TimeframeHistory(`${root}/higher`, minutes, 30) };
}

await test("v2 canonical bytes pin every field and signature while v1 remains selected by interval=1", async () => {
  assert.deepEqual(TIMEFRAME_CANONICAL_KEY_ORDER, [
    "v", "venue", "symbol", "interval", "fromMs", "toMs", "requiredFromMs", "requiredClosedToMs",
    "closedFrontierMs", "availableFromMs", "availableRows", "requiredRows", "complete", "rows", "gaps",
    "segments", "keyId",
  ]);
  const h = await freshHub();
  try {
    const { token } = h.store.issue("tf", 1);
    h.candles.store.write("bitget", "BTCUSDT", [candle(DAY0)], DAY0);
    const base = `${h.origin}/api/candles/seed?venue=bitget&symbol=BTCUSDT&fromMs=${DAY0}&toMs=${DAY0}&key=${encodeURIComponent(token)}`;
    const omitted = await (await fetch(base)).text();
    const explicit = await (await fetch(`${base}&interval=1`)).text();
    assert.equal(explicit, omitted, "explicit 1 is byte-for-byte pinned v1");
    assert.equal(JSON.parse(explicit).v, 1);
    const mins = Array.from({ length: 6 }, (_, i) => candle(DAY0 + i * MINUTE_MS, i));
    h.candles.store.write("bitget", "ETHUSDT", mins, mins.at(-1).openMs);
    const higherUrl = `${h.origin}/api/candles/seed?venue=bitget&symbol=ETHUSDT&interval=3`
      + `&fromMs=${DAY0}&toMs=${DAY0 + 5 * MINUTE_MS}&key=${encodeURIComponent(token)}`;
    const higher = await fetch(higherUrl);
    assert.equal(higher.status, 200);
    assert.ok(higher.headers.get("etag"));
    const body = await higher.json();
    assert.equal(body.v, 2);
    const { sig, ...unsigned } = body;
    assert.equal(edVerify(null, canonicalTimeframeBytes(unsigned), createPublicKey(h.store.publicKeyPem()), Buffer.from(sig, "base64")), true);
    const cached = await fetch(higherUrl, { headers: { "if-none-match": higher.headers.get("etag") } });
    assert.equal(cached.status, 304, "ETag reuses only the exact signed v2 bytes");
  } finally { await h.close(); }
});

await test("native adapters use proved interval tokens and preserve venue OHLCV", async () => {
  const seen = [];
  const bybit = await fetchNativeTimeframeKlines(async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({ retCode: 0, result: { list: [
      [String(DAY0 + HOUR), "2", "4", "1", "3", "8"], [String(DAY0), "1", "3", "0.5", "2", "7"],
    ] } }) };
  }, "bybit", "BTCUSDT", 60, DAY0, DAY0 + HOUR);
  assert.match(seen[0], /interval=60/);
  assert.deepEqual(bybit.candles.map((c) => c.openMs), [DAY0, DAY0 + HOUR]);
  assert.equal(bybit.candles[0].volume, 7);
  await assert.rejects(() => fetchNativeTimeframeKlines(async () => { throw new Error("should not fetch"); },
    "bybit", "BTCUSDT", 180, DAY0, DAY0), /no proved native 180m/);

  const fixtures = {
    bitunix: { code: 0, data: [{ time: String(DAY0), open: "1", high: "3", low: "0.5", close: "2", quoteVol: "7", baseVol: "14" }] },
    bitget: { code: "00000", data: [[String(DAY0), "1", "3", "0.5", "2", "7", "14"]] },
    binance: [[DAY0, "1", "3", "0.5", "2", "7"]],
    aster: [[DAY0, "1", "3", "0.5", "2", "7"]],
    weex: [[DAY0, "1", "3", "0.5", "2", "7"]],
  };
  for (const venue of ["bitunix", "bitget", "binance", "aster", "weex"]) {
    const urls = [];
    const page = await fetchNativeTimeframeKlines(async (url) => {
      urls.push(url); return { ok: true, status: 200, json: async () => fixtures[venue] };
    }, venue, "BTCUSDT", 60, DAY0, DAY0);
    assert.equal(page.candles[0].openMs, DAY0, `${venue} open time`);
    assert.equal(page.candles[0].volume, 7, `${venue} base volume`);
    assert.ok(urls[0].includes(venue === "bitget" ? "granularity=1H" : "interval=1h"), `${venue} native 1h token`);
  }
  for (const venue of ["bybit", "bitunix", "bitget", "binance", "aster", "weex"]) {
    assert.ok(nativeTimeframeIntervals(venue).includes(60), `${venue} exposes proved native 1h`);
  }
});

await test("complete aligned aggregates exclude forming buckets and sign mandatory empty gaps", () => {
  const h = history();
  const rows = Array.from({ length: 6 }, (_, i) => candle(DAY0 + i * MINUTE_MS, i));
  h.minutes.write("bitget", "BTCUSDT", rows, rows.at(-1).openMs);
  const out = h.value.request("bitget", "BTCUSDT", 3, DAY0, DAY0 + 6 * MINUTE_MS + 1,
    DAY0 + 7 * MINUTE_MS, rows.at(-1).openMs, "seed-1", sign);
  assert.equal(out.ok, true);
  assert.equal(out.payload.requiredClosedToMs, DAY0 + 3 * MINUTE_MS, "forming 3m bucket is excluded");
  assert.equal(out.payload.complete, true);
  assert.deepEqual(out.payload.gaps, []);
  assert.deepEqual(out.payload.segments, [[DAY0, DAY0 + 3 * MINUTE_MS, "aggregate", 1]]);
  assert.deepEqual(out.payload.rows.map((r) => r[0]), [DAY0, DAY0 + 3 * MINUTE_MS]);
  assert.equal(out.payload.rows[0][1], rows[0].open);
  assert.equal(out.payload.rows[0][2], Math.max(...rows.slice(0, 3).map((r) => r.high)));
  assert.equal(out.payload.rows[0][3], Math.min(...rows.slice(0, 3).map((r) => r.low)));
  assert.equal(out.payload.rows[0][4], rows[2].close);
  assert.equal(out.payload.rows[0][5], rows.slice(0, 3).reduce((n, r) => n + r.volume, 0));
  assert.equal(edVerify(null, canonicalTimeframeBytes(out.payload), pair.publicKey, Buffer.from(out.payload.sig, "base64")), true);
});

await test("missing base bars are never folded and cold/partial depth is reported honestly", () => {
  const h = history();
  const cold = h.value.request("bitget", "BTCUSDT", 60, DAY0, DAY0 + 2 * HOUR, NOW, null, "seed-1", sign);
  assert.deepEqual(cold, { ok: false, code: 503, error: "no closed 60m candles cached yet for bitget BTCUSDT" });
  assert.equal(h.value.work("bitget", NOW, 200).length, 1, "cold request registers one bounded native job");
  const minutes = Array.from({ length: 6 }, (_, i) => candle(DAY0 + i * MINUTE_MS, i))
    .filter((c) => c.openMs !== DAY0 + MINUTE_MS);
  h.minutes.write("bybit", "HOLEUSDT", minutes, minutes.at(-1).openMs);
  const partial = h.value.request("bybit", "HOLEUSDT", 3, DAY0, DAY0 + 5 * MINUTE_MS,
    DAY0 + 9 * MINUTE_MS, minutes.at(-1).openMs, "seed-1", sign);
  assert.equal(partial.ok, true);
  assert.equal(partial.payload.complete, false);
  assert.deepEqual(partial.payload.rows.map((r) => r[0]), [DAY0 + 3 * MINUTE_MS]);
  assert.deepEqual(partial.payload.gaps, [[DAY0, DAY0]]);
  assert.equal(partial.payload.requiredRows, 2);
  assert.equal(partial.payload.availableRows, 1);
});

await test("native work repairs raw slots that lack safe provenance without upgrading complete aggregates", () => {
  const lostFrontier = history("lost-frontier");
  lostFrontier.value.store.write("bybit", "BTCUSDT", 60, [candle(DAY0)], "native", 60, DAY0);
  assert.equal(lostFrontier.value.request("bybit", "BTCUSDT", 60, DAY0, DAY0,
    DAY0 + 2 * HOUR, null, "seed-1", sign).ok, false, "a raw native slot without its frontier is not served");
  assert.equal(lostFrontier.value.work("bybit", DAY0 + 2 * HOUR, 1000).length, 1,
    "the same unsafe slot remains missing to recovery work");

  const unsafeAggregate = history("unsafe-aggregate");
  unsafeAggregate.value.store.write("bybit", "ETHUSDT", 60, [candle(DAY0)], "aggregate", 1, DAY0);
  assert.equal(unsafeAggregate.value.request("bybit", "ETHUSDT", 60, DAY0, DAY0,
    DAY0 + 2 * HOUR, null, "seed-1", sign).ok, false);
  assert.equal(unsafeAggregate.value.work("bybit", DAY0 + 2 * HOUR, 1000).length, 1,
    "an aggregate occupying the native slot cannot suppress repair");

  const completeAggregate = history("complete-aggregate");
  completeAggregate.value.request("bybit", "SOLUSDT", 60, DAY0, DAY0 + HOUR - 1,
    DAY0 + 2 * HOUR, null, "seed-1", sign);
  assert.equal(completeAggregate.value.work("bybit", DAY0 + 2 * HOUR, 1000).length, 1,
    "the initial cold request creates bounded recovery work");
  const minutes = Array.from({ length: 60 }, (_, i) => candle(DAY0 + i * MINUTE_MS, i));
  completeAggregate.minutes.write("bybit", "SOLUSDT", minutes, minutes.at(-1).openMs);
  const ready = completeAggregate.value.request("bybit", "SOLUSDT", 60, DAY0, DAY0 + HOUR - 1,
    DAY0 + 2 * HOUR, minutes.at(-1).openMs, "seed-1", sign);
  assert.equal(ready.ok && ready.payload.complete, true);
  assert.deepEqual(ready.payload.segments, [[DAY0, DAY0, "aggregate", 1]]);
  assert.equal(completeAggregate.value.work("bybit", DAY0 + 2 * HOUR, 1000).length, 0,
    "a later complete safe derived series clears stale native work");
});

await test("native cache persists, supersedes aggregates, and unsupported 3h folds from native 1h", () => {
  const h = history("native");
  const nativeRows = [candle(DAY0, 10), candle(DAY0 + HOUR, 20), candle(DAY0 + 2 * HOUR, 30)];
  const work = { key: "k", venue: "bybit", symbol: "BTCUSDT", targetInterval: 180,
    interval: 60, startMs: DAY0, endMs: DAY0 + 2 * HOUR };
  h.value.record(work, { candles: nativeRows, empty: false }, DAY0 + 4 * HOUR);
  const out = h.value.request("bybit", "BTCUSDT", 180, DAY0, DAY0 + 3 * HOUR - 1,
    DAY0 + 4 * HOUR, null, "seed-1", sign);
  assert.equal(out.ok, true);
  assert.equal(out.payload.complete, true);
  assert.deepEqual(out.payload.segments, [[DAY0, DAY0, "aggregate", 60]]);
  const restarted = new TimeframeHistory(`${h.root}/higher`, h.minutes, 30);
  const persisted = restarted.request("bybit", "BTCUSDT", 180, DAY0, DAY0 + 3 * HOUR - 1,
    DAY0 + 4 * HOUR, null, "seed-1", sign);
  assert.equal(persisted.ok, true);
  assert.deepEqual(persisted.payload.rows, out.payload.rows);
  assert.ok(fs.existsSync(`${h.root}/higher/native-frontier.v2.json`));

  // A proved direct venue interval has stronger provenance than a minute fold.
  const minuteRows = Array.from({ length: 60 }, (_, i) => candle(DAY0 + i * MINUTE_MS, i));
  h.minutes.write("bitget", "ETHUSDT", minuteRows, minuteRows.at(-1).openMs);
  const derived = h.value.request("bitget", "ETHUSDT", 60, DAY0, DAY0 + HOUR - 1,
    DAY0 + 2 * HOUR, minuteRows.at(-1).openMs, "seed-1", sign);
  assert.deepEqual(derived.payload.segments, [[DAY0, DAY0, "aggregate", 1]]);
  h.value.record({ key: "direct", venue: "bitget", symbol: "ETHUSDT", targetInterval: 60,
    interval: 60, startMs: DAY0, endMs: DAY0 },
  { candles: [{ ...candle(DAY0, 99), high: 1000, close: 999 }], empty: false }, DAY0 + 2 * HOUR);
  const direct = h.value.request("bitget", "ETHUSDT", 60, DAY0, DAY0 + HOUR - 1,
    DAY0 + 2 * HOUR, minuteRows.at(-1).openMs, "seed-1", sign);
  assert.equal(direct.payload.rows[0][4], 999);
  assert.deepEqual(direct.payload.segments, [[DAY0, DAY0, "native", 60]]);
});

await test("persisted instrument generation invalidates a reused venue symbol", () => {
  const h = history("identity");
  h.value.noteInstrumentRoster("aster", [{ symbol: "REUSEUSDT", generation: `aster:usdt-perpetual:${DAY0}` }]);
  const oldMinutes = Array.from({ length: 60 }, (_, i) => candle(DAY0 + i * MINUTE_MS, i));
  h.minutes.write("aster", "REUSEUSDT", oldMinutes, oldMinutes.at(-1).openMs);
  h.value.record({ key: "old", venue: "aster", symbol: "REUSEUSDT", targetInterval: 60,
    interval: 60, startMs: DAY0, endMs: DAY0 }, { candles: [candle(DAY0)], empty: false }, DAY0 + 2 * HOUR);
  assert.equal(h.value.store.read("aster", "REUSEUSDT", 60, DAY0, DAY0).length, 1);
  h.value.noteInstrumentRoster("aster", [{ symbol: "REUSEUSDT", generation: `aster:usdt-perpetual:${DAY0 + HOUR}` }]);
  assert.equal(h.value.store.read("aster", "REUSEUSDT", 60, DAY0, DAY0).length, 0);
  const fenced = h.value.request("aster", "REUSEUSDT", 60, DAY0, DAY0 + HOUR - 1,
    DAY0 + 2 * HOUR, oldMinutes.at(-1).openMs, "seed-1", sign);
  assert.equal(fenced.ok, false, "pre-relist minute rows cannot repopulate the reused symbol cache");
  const restarted = new TimeframeHistory(`${h.root}/higher`, h.minutes, 30);
  restarted.noteInstrumentRoster("aster", [{ symbol: "REUSEUSDT", generation: `aster:usdt-perpetual:${DAY0 + HOUR}` }]);
  assert.equal(restarted.store.read("aster", "REUSEUSDT", 60, DAY0, DAY0).length, 0);
  assert.equal(restarted.request("aster", "REUSEUSDT", 60, DAY0, DAY0 + HOUR - 1,
    DAY0 + 2 * HOUR, oldMinutes.at(-1).openMs, "seed-1", sign).ok, false);
});

await test("aggregate rows refresh after a 1m correction and duplicate demand stays one job", () => {
  const h = history("correction");
  const rows = Array.from({ length: 5 }, (_, i) => candle(DAY0 + i * MINUTE_MS, i));
  h.minutes.write("bitunix", "BTCUSDT", rows, rows.at(-1).openMs);
  let out = h.value.request("bitunix", "BTCUSDT", 5, DAY0, DAY0 + 4 * MINUTE_MS,
    DAY0 + 10 * MINUTE_MS, rows.at(-1).openMs, "seed-1", sign);
  assert.equal(out.payload.rows[0][4], rows.at(-1).close);
  h.minutes.write("bitunix", "BTCUSDT", [{ ...rows.at(-1), high: 800, close: 777 }], rows.at(-1).openMs);
  h.value.noteMinuteRows("bitunix", "BTCUSDT", [{ ...rows.at(-1), high: 800, close: 777 }], rows.at(-1).openMs);
  out = h.value.request("bitunix", "BTCUSDT", 5, DAY0, DAY0 + 4 * MINUTE_MS,
    DAY0 + 10 * MINUTE_MS, rows.at(-1).openMs, "seed-1", sign);
  assert.equal(out.payload.rows[0][4], 777, "derived row was invalidated/rebuilt from corrected base");

  const cold = history("dedup");
  for (let i = 0; i < 5; i++) cold.value.request("binance", "BTCUSDT", 60, DAY0, DAY0 + HOUR, NOW, null, "seed-1", sign);
  assert.equal(cold.value.work("binance", NOW, 1000).length, 1);
});

await test("malformed native and corrupted persisted OHLCV/source identity never reach a signed response", () => {
  const h = history("invalid-native");
  const work = { key: "invalid", venue: "aster", symbol: "BADUSDT", targetInterval: 60,
    interval: 60, startMs: DAY0, endMs: DAY0 };
  assert.equal(h.value.record(work, { candles: [{ ...candle(DAY0), low: 500 }], empty: false }, DAY0 + 2 * HOUR), 0);
  assert.equal(h.value.request("aster", "BADUSDT", 60, DAY0, DAY0, DAY0 + 2 * HOUR,
    null, "seed-1", sign).ok, false);

  h.value.record(work, { candles: [candle(DAY0)], empty: false }, DAY0 + 2 * HOUR);
  const dayFile = `${h.root}/higher/aster/BADUSDT/60/2026-08-01.ctf2`;
  const corrupt = fs.readFileSync(dayFile);
  corrupt.writeUInt16LE(1, 49); // a native slot must name the target interval as its base
  fs.writeFileSync(dayFile, corrupt);
  const restarted = new TimeframeHistory(`${h.root}/higher`, h.minutes, 30);
  assert.equal(restarted.request("aster", "BADUSDT", 60, DAY0, DAY0, DAY0 + 2 * HOUR,
    null, "seed-1", sign).ok, false);
});

await test("Bitunix native carried opens require the exact contiguous prior close and persist raw", () => {
  const h = history("bitunix-carried");
  const rows = [
    { openMs: DAY0, open: 77287, high: 77287, low: 77277.6, close: 77277.6, volume: 1.1915 },
    { openMs: DAY0 + HOUR, open: 77277.6, high: 77288.1, low: 77277.7, close: 77288.1, volume: 1.2852 },
    { openMs: DAY0 + 2 * HOUR, open: 77288.1, high: 77288.1, low: 77288, close: 77288, volume: 0.9211 },
  ];
  const work = { key: "carried", venue: "bitunix", symbol: "BTCUSDT", targetInterval: 60,
    interval: 60, startMs: DAY0, endMs: DAY0 + 2 * HOUR };
  assert.equal(h.value.record(work, { candles: rows, empty: false }, DAY0 + 4 * HOUR), 3);
  let out = h.value.request("bitunix", "BTCUSDT", 60, DAY0, DAY0 + 2 * HOUR,
    DAY0 + 4 * HOUR, null, "seed-1", sign);
  assert.equal(out.ok && out.payload.complete, true);
  assert.deepEqual(out.payload.rows[1], [DAY0 + HOUR, 77277.6, 77288.1, 77277.7, 77288.1, 1.2852]);
  out = new TimeframeHistory(`${h.root}/higher`, h.minutes, 30).request("bitunix", "BTCUSDT", 60,
    DAY0, DAY0 + 2 * HOUR, DAY0 + 4 * HOUR, null, "seed-1", sign);
  assert.equal(out.ok && out.payload.complete, true, "persisted carried-open proof survives restart");

  const bad = history("bitunix-unproved");
  bad.value.record({ ...work, key: "unproved", symbol: "BADUSDT", startMs: DAY0 + HOUR, endMs: DAY0 + HOUR },
    { candles: [rows[1]], empty: false }, DAY0 + 4 * HOUR);
  assert.equal(bad.value.request("bitunix", "BADUSDT", 60, DAY0 + HOUR, DAY0 + HOUR,
    DAY0 + 4 * HOUR, null, "seed-1", sign).ok, false, "first boundary has no predecessor");
});

await test("a latest bucket held only by settlement grace retries on the next pass", () => {
  const h = history("grace-retry");
  const now = DAY0 + 2 * HOUR + 30_000;
  h.value.request("bitget", "BTCUSDT", 60, DAY0 + HOUR, DAY0 + HOUR, now, null, "seed-1", sign);
  const [work] = h.value.work("bitget", now, 200);
  assert.ok(work);
  h.value.attempted(work, now);
  assert.equal(h.value.work("bitget", now, 200).length, 0, "ordinary attempt throttle applies before outcome");
  h.value.record(work, { candles: [], empty: true }, now);
  assert.equal(h.value.work("bitget", now, 200).length, 1, "grace-only miss is eligible next pass");
});

await test("inactive demand, interest, materialization, and attempt state expire together", () => {
  const h = history("state-ttl");
  const rows = Array.from({ length: 60 }, (_, i) => candle(DAY0 + i * MINUTE_MS, i));
  h.minutes.write("bitget", "BTCUSDT", rows, rows.at(-1).openMs);
  h.value.request("bitget", "BTCUSDT", 60, DAY0, DAY0 + 2 * HOUR, NOW,
    rows.at(-1).openMs, "seed-1", sign);
  const [work] = h.value.work("bitget", NOW, 200);
  h.value.attempted(work, NOW);
  assert.ok(h.value.interests.size && h.value.materialized.size && h.value.lastAttempts.size);
  h.value.prune(NOW + 6 * HOUR + 1);
  assert.equal(h.value.demands.size, 0);
  assert.equal(h.value.interests.size, 0);
  assert.equal(h.value.materialized.size, 0);
  assert.equal(h.value.lastAttempts.size, 0);
});

await test("requested timeframe pages inherit the collector budget and 429 backoff", async () => {
  const h = history("fair");
  const current = settledOpenMs(NOW);
  h.minutes.write("bitget", "BTCUSDT", [candle(current)], current);
  const collector = new VenueCollector("bitget", h.minutes, `${h.root}/state`,
    { ...DEFAULT_COLLECTOR_OPTIONS, retentionDays: 0.0001 }, NOW, () => {}, h.value);
  await collector.refreshSymbols(async () => ({ ok: true, status: 200,
    json: async () => ({ code: "00000", data: [{ symbol: "BTCUSDT", symbolStatus: "normal" }] }) }), NOW);
  h.value.request("bitget", "BTCUSDT", 60, DAY0, DAY0 + HOUR, NOW, current, "seed-1", sign);
  assert.ok(collector.scheduledWork(NOW).some((w) => w.kind === "timeframe"));

  const refusal = async () => ({ ok: false, status: 429, json: async () => ({}),
    headers: { get: () => "2" } });
  await collector.tick(refusal, 1, NOW, { clock: () => NOW, sleep: async () => {}, deadlineMs: 1000 });
  const health = collector.health(NOW);
  assert.equal(health.state, "cooling");
  assert.equal(health.rateLimitHits, 1);
  assert.equal(health.requestsMade, 2, "one symbol-list request and one budgeted timeframe request");
});

await test("demanded native depth and background 1m depth alternate first history turn", async () => {
  const h = history("lanes");
  const current = settledOpenMs(NOW);
  h.minutes.write("bitget", "BTCUSDT", [candle(current)], current);
  const collector = new VenueCollector("bitget", h.minutes, `${h.root}/state`,
    DEFAULT_COLLECTOR_OPTIONS, NOW, () => {}, h.value);
  await collector.refreshSymbols(async () => ({ ok: true, status: 200,
    json: async () => ({ code: "00000", data: [{ symbol: "BTCUSDT", symbolStatus: "normal" }] }) }), NOW);
  h.value.request("bitget", "BTCUSDT", 60, DAY0, DAY0 + HOUR, NOW, current, "seed-1", sign);
  const a = collector.scheduledWork(NOW).map((w) => w.kind);
  const b = collector.scheduledWork(NOW).map((w) => w.kind);
  assert.ok(a.includes("backfill") && a.includes("timeframe"));
  assert.ok(b.includes("backfill") && b.includes("timeframe"));
  assert.ok(a.indexOf("backfill") < a.indexOf("timeframe"));
  assert.ok(b.indexOf("timeframe") < b.indexOf("backfill"));
});

await test("WEEX cheap native pages use documented weight headroom without raising history-page capacity", async () => {
  const h = history("weex-weight");
  h.minutes.write("weex", "TRACKUSDT", [candle(settledOpenMs(NOW))], settledOpenMs(NOW));
  const collector = new VenueCollector("weex", h.minutes, `${h.root}/state`, {
    ...DEFAULT_COLLECTOR_OPTIONS, requestsPerSecond: ADAPTERS.weex.publicRequestsPerSecond,
    minRequestsPerSecond: Math.min(DEFAULT_COLLECTOR_OPTIONS.minRequestsPerSecond, ADAPTERS.weex.publicRequestsPerSecond),
    retentionDays: 0,
  },
    NOW, () => {}, h.value);
  await collector.refreshSymbols(async (url) => ({ ok: true, status: 200,
    json: async () => url.includes("apiTradingSymbols") ? ["TRACKUSDT"] : { symbols: [{
      symbol: "TRACKUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL",
      forwardContractFlag: true, status: "TRADING",
    }] },
  }), NOW);
  for (let i = 0; i < 25; i++) h.value.request("weex", `PAIR${i}USDT`, 60, DAY0, DAY0, NOW, null, "seed-1", sign);
  const plan = collector.workBudgetFor(60_000);
  assert.equal(plan.maxRequests, 25);
  assert.equal(plan.maxWeight, 25, "five weight-5 history pages/minute become one conservative 25-weight envelope");
  assert.ok(Math.abs(plan.weightPerSecond - 5 / 12) < 1e-12);
  assert.equal(collector.budgetFor(60_000), 5, "legacy history request capacity is unchanged");
  let clock = NOW;
  let calls = 0;
  const fetched = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => [[DAY0, "1", "3", "0.5", "2", "7"]] };
  };
  const ran = await collector.tick(fetched, collector.budgetFor(60_000), NOW, {
    clock: () => clock, sleep: async (ms) => { clock += ms; }, deadlineMs: 48_000,
    maxRequests: plan.maxRequests, maxWeight: plan.maxWeight, weightPerSecond: plan.weightPerSecond,
  });
  assert.equal(ran.requests, 21, "the 80% scheduler deadline admits 21 evenly paced weight-1 pages");
  assert.equal(calls, 21);
  assert.ok(clock - NOW <= 48_000);
});

await test("WEEX mixed cold work gives native and legacy history equal request-weight shares", async () => {
  const h = history("weex-mixed-weight");
  const current = settledOpenMs(NOW);
  const symbols = Array.from({ length: 30 }, (_, i) => `MIX${i}USDT`);
  for (const symbol of symbols) h.minutes.write("weex", symbol, [candle(current)], current);
  const collector = new VenueCollector("weex", h.minutes, `${h.root}/state`, {
    ...DEFAULT_COLLECTOR_OPTIONS, requestsPerSecond: ADAPTERS.weex.publicRequestsPerSecond,
    minRequestsPerSecond: Math.min(DEFAULT_COLLECTOR_OPTIONS.minRequestsPerSecond, ADAPTERS.weex.publicRequestsPerSecond),
    retentionDays: 30,
  }, NOW, () => {}, h.value);
  await collector.refreshSymbols(async (url) => ({ ok: true, status: 200,
    json: async () => url.includes("apiTradingSymbols") ? symbols : { symbols: symbols.map((symbol) => ({
      symbol, quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL",
      forwardContractFlag: true, status: "TRADING",
    })) },
  }), NOW);
  for (const symbol of symbols) h.value.request("weex", symbol, 60, DAY0, DAY0, NOW, current, "seed-1", sign);
  const scheduled = collector.scheduledWork(NOW).slice(0, 12).map((w) => w.kind);
  assert.deepEqual(scheduled.slice(0, 6), ["backfill", "timeframe", "timeframe", "timeframe", "timeframe", "timeframe"]);
  assert.deepEqual(scheduled.slice(6, 12), ["backfill", "timeframe", "timeframe", "timeframe", "timeframe", "timeframe"]);

  const plan = collector.workBudgetFor(60_000);
  let clock = NOW;
  const urls = [];
  const ran = await collector.tick(async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => url.includes("historyKlines") ? []
      : [[DAY0, "1", "3", "0.5", "2", "7"]] };
  }, collector.budgetFor(60_000), NOW, {
    clock: () => clock, sleep: async (ms) => { clock += ms; }, deadlineMs: 48_000,
    maxRequests: plan.maxRequests, maxWeight: plan.maxWeight, weightPerSecond: plan.weightPerSecond,
  });
  const native = urls.filter((url) => url.includes("/market/klines?")).length;
  const legacy = urls.filter((url) => url.includes("historyKlines")).length;
  console.log(`    weex-mixed native=${native}, legacy=${legacy}, requests=${ran.requests}`);
  assert.equal(ran.requests, native + legacy);
  assert.ok(native >= 10, `mixed pass retained useful native throughput (${native})`);
  assert.ok(legacy >= 2, `mixed pass preserved legacy 1m progress (${legacy})`);
  assert.ok(native <= legacy * 5 + 1, "only the final partial block may exceed the equal-weight ratio by one page");
});

await test("WEEX demanded native history progresses across sustained 239-symbol reconcile and old-repair queues", async () => {
  const h = history("weex-live-fairness");
  const symbols = Array.from({ length: 239 }, (_, i) => `LIVE${String(i).padStart(3, "0")}USDT`);
  const collector = new VenueCollector("weex", h.minutes, `${h.root}/state`, {
    ...DEFAULT_COLLECTOR_OPTIONS,
    requestsPerSecond: ADAPTERS.weex.publicRequestsPerSecond,
    minRequestsPerSecond: Math.min(DEFAULT_COLLECTOR_OPTIONS.minRequestsPerSecond,
      ADAPTERS.weex.publicRequestsPerSecond),
    retentionDays: 0,
    reconcileWsGapMinutes: 5,
    symbolRefreshMs: DAY,
  }, NOW, () => {}, h.value);
  const roster = async (url) => ({ ok: true, status: 200, json: async () =>
    url.includes("apiTradingSymbols") ? symbols : { symbols: symbols.map((symbol) => ({
      symbol, quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL",
      forwardContractFlag: true, status: "TRADING",
    })) } });
  await collector.refreshSymbols(roster, NOW);

  let passNow = NOW;
  let current = settledOpenMs(passNow);
  const held = new Map();
  for (const symbol of symbols) {
    // A persistent old interior hole proves routine repair cannot regain the
    // old unconditional priority and starve demanded native work either.
    const rows = [candle(current - 300 * MINUTE_MS),
      ...Array.from({ length: 5 }, (_, i) => candle(current - (4 - i) * MINUTE_MS, i))];
    const w = h.minutes.write("weex", symbol, rows, current);
    collector.noteStoredCandles(symbol, rows, w.written, w.newlyFilled);
    held.set(symbol, rows);
  }
  const nativeOpen = Math.floor((current - DAY) / (12 * HOUR)) * 12 * HOUR;
  for (const symbol of symbols.slice(0, 225)) {
    const out = h.value.request("weex", symbol, 720, nativeOpen, nativeOpen,
      passNow, current, "seed-1", sign);
    assert.equal(out.ok, false, "cold native request registers bounded demand");
  }

  const perPass = [];
  for (let pass = 0; pass < 4; pass++) {
    if (pass > 0) {
      passNow += MINUTE_MS;
      current = settledOpenMs(passNow);
      for (const symbol of symbols) {
        const row = candle(current, pass + 10);
        const w = h.minutes.write("weex", symbol, [row], current);
        collector.noteStoredCandles(symbol, [row], w.written, w.newlyFilled);
        held.get(symbol).push(row);
      }
    }
    const urls = [];
    const plan = collector.workBudgetFor(60_000);
    let clock = passNow;
    const ran = await collector.tick(async (url) => {
      urls.push(url);
      const u = new URL(url);
      const symbol = u.searchParams.get("symbol");
      if (u.pathname.endsWith("/historyKlines")) return { ok: true, status: 200, json: async () => [] };
      if (u.searchParams.get("interval") === "12h") {
        return { ok: true, status: 200,
          json: async () => [[nativeOpen, "100", "102", "99", "101", "2"]] };
      }
      const rows = held.get(symbol) ?? [];
      return { ok: true, status: 200,
        json: async () => rows.map((row) => [row.openMs, row.open, row.high, row.low, row.close, row.volume]) };
    }, collector.budgetFor(60_000), passNow, {
      clock: () => clock, sleep: async (ms) => { clock += ms; }, deadlineMs: 48_000,
      maxRequests: plan.maxRequests, maxWeight: plan.maxWeight, weightPerSecond: plan.weightPerSecond,
    });
    const native = urls.filter((url) => new URL(url).searchParams.get("interval") === "12h").length;
    const reconcile = urls.filter((url) => new URL(url).searchParams.get("interval") === "1m"
      && new URL(url).pathname.endsWith("/klines")).length;
    const repair = urls.filter((url) => new URL(url).pathname.endsWith("/historyKlines")).length;
    const weight = native + reconcile + repair * 5;
    perPass.push({ native, reconcile, repair, requests: ran.requests, weight });
    assert.ok(native > 0, `pass ${pass + 1} advances demanded native history`);
    assert.ok(reconcile > 0, `pass ${pass + 1} advances routine recent reconciliation`);
    assert.ok(repair > 0, `pass ${pass + 1} advances old interior repair`);
    assert.ok(weight <= 25, `pass ${pass + 1} stays inside the shared 25-weight envelope`);
  }
  assert.ok(fs.existsSync(`${h.root}/higher/native-frontier.v2.json`),
    "native progress is durable during a production-sized competing sweep");
  assert.ok(perPass.reduce((sum, pass) => sum + pass.native, 0) >= 16);
  console.log(`    weex-live-fairness=${JSON.stringify(perPass)}`);
});

await test("warm 700-pair cache serves complete history without venue work", () => {
  const h = history("load700");
  const symbols = Array.from({ length: 700 }, (_, i) => `PAIR${String(i).padStart(3, "0")}USDT`);
  const rows = Array.from({ length: 24 }, (_, i) => candle(DAY0 + i * HOUR, i));
  for (const symbol of symbols) h.value.record({ key: symbol, venue: "bybit", symbol, targetInterval: 60,
    interval: 60, startMs: DAY0, endMs: DAY0 + 23 * HOUR }, { candles: rows, empty: false }, DAY0 + 25 * HOUR);
  const deepMinutes = Array.from({ length: 24 * 60 }, (_, i) => {
    const c = candle(DAY0 + i * MINUTE_MS, i % 10);
    return [c.openMs, c.open, c.high, c.low, c.close, c.volume];
  });
  let minuteReads = 0;
  h.minutes.readWindow = () => { minuteReads++; return { rows: deepMinutes, gaps: [] }; };
  const started = performance.now();
  for (const symbol of symbols) {
    const out = h.value.request("bybit", symbol, 60, DAY0, DAY0 + 23 * HOUR,
      DAY0 + 25 * HOUR, deepMinutes.at(-1)[0], "seed-1", sign);
    assert.equal(out.ok && out.payload.complete, true);
  }
  const elapsed = performance.now() - started;
  assert.equal(h.value.work("bybit", NOW, 1000).length, 0);
  assert.equal(minuteReads, 0, "complete native coverage never scans an available deep 1m base");
  assert.ok(elapsed < 10_000, `warm 700-pair load took ${elapsed.toFixed(1)}ms`);
  console.log(`    warm700=${elapsed.toFixed(1)}ms (${(elapsed / 700).toFixed(2)}ms/pair)`);
});

await test("700 minute-backed 30-day hourly windows materialize with one base read per pair", () => {
  const root = tmpDir("cold-minute700");
  const targetRows = 720;
  const minuteRows = Array.from({ length: targetRows * 60 }, (_, i) => {
    const c = candle(DAY0 + i * MINUTE_MS, i % 10);
    return [c.openMs, c.open, c.high, c.low, c.close, c.volume];
  });
  let reads = 0;
  const minutes = { readWindow: () => { reads++; return { rows: minuteRows, gaps: [] }; } };
  const tf = new TimeframeHistory(`${root}/higher`, minutes, 30);
  const started = performance.now();
  for (let i = 0; i < 700; i++) {
    const symbol = `PAIR${String(i).padStart(3, "0")}USDT`;
    const out = tf.request("bybit", symbol, 60, DAY0, DAY0 + (targetRows * 60 - 1) * MINUTE_MS,
      DAY0 + (targetRows + 1) * HOUR, minuteRows.at(-1)[0], "seed-1", sign);
    assert.equal(out.ok && out.payload.complete, true);
    assert.equal(out.payload.availableRows, targetRows);
  }
  const elapsed = performance.now() - started;
  assert.equal(reads, 700, "each pair reads the complete minute base once");
  assert.ok(elapsed < 60_000, `minute-backed 700 x 720 materialization took ${elapsed.toFixed(1)}ms`);
  console.log(`    cold-minute700x720=${elapsed.toFixed(1)}ms`);
});

summary("timeframe history");
