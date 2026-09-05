// WEEX's current kline page is larger and cheaper than historyKlines, but it
// is a newest-page endpoint. These checks pin the collector boundary: use it
// for a cold contiguous suffix and a provably contiguous tail; use bounded
// history for old gaps so recent data can never jump over missing minutes.
import assert from "node:assert/strict";
import { test, summary, tmpDir } from "./helpers.mjs";
import { VenueCollector, DEFAULT_COLLECTOR_OPTIONS } from "../dist/src/candles/collector.js";
import { CandleStore, MINUTE_MS, settledOpenMs } from "../dist/src/candles/store.js";
import { WEEX_PAGE_LIMIT, WEEX_RECENT_PAGE_LIMIT } from "../dist/src/candles/venues.js";

const NOW = 1_788_000_000_000;

function response(body) {
  return { ok: true, status: 200, json: async () => body };
}

function rows(first, count) {
  return Array.from({ length: count }, (_, i) => {
    const at = first + i * MINUTE_MS;
    return [at, "10", "12", "9", "11", "2.5", at + MINUTE_MS - 1, "27.5"];
  });
}

function fixture() {
  const store = new CandleStore(tmpDir("weex-recent-store"));
  const calls = [];
  let currentRows = [];
  let historyRows = [];
  const fetchLike = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.pathname.endsWith("/exchangeInfo")) return response({ symbols: [
      { symbol: "BTCUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", forwardContractFlag: true },
    ] });
    if (u.pathname.endsWith("/apiTradingSymbols")) return response(["BTCUSDT"]);
    if (u.pathname.endsWith("/historyKlines")) return response(historyRows);
    if (u.pathname.endsWith("/klines")) return response(currentRows);
    throw new Error(`unexpected URL ${url}`);
  };
  const collector = new VenueCollector("weex", store, tmpDir("weex-recent-state"), {
    ...DEFAULT_COLLECTOR_OPTIONS,
    requestsPerSecond: 100,
    minRequestsPerSecond: 0.1,
    tailFillMinutes: 5,
  }, NOW);
  return {
    store, calls, collector, fetchLike,
    setCurrent(value) { currentRows = value; },
    setHistory(value) { historyRows = value; },
  };
}

await test("WEEX cold start drops the forming and grace rows from a real-shaped 1000-row current page", async () => {
  const f = fixture();
  const newest = settledOpenMs(NOW);
  const forming = newest + 2 * MINUTE_MS;
  const wireFirst = forming - (WEEX_RECENT_PAGE_LIMIT - 1) * MINUTE_MS;
  const firstStored = wireFirst;
  // Live WEEX returns the current forming row in its 1000-row page. The Hub's
  // independent one-minute settlement grace removes the row immediately before
  // it too, leaving 998 safe rows rather than manufacturing a 1000-row claim.
  f.setCurrent(rows(wireFirst, WEEX_RECENT_PAGE_LIMIT).reverse());
  const result = await f.collector.tick(f.fetchLike, 1, NOW, { sleep: async () => {} });
  assert.equal(result.requests, 1);
  assert.equal(result.written, WEEX_RECENT_PAGE_LIMIT - 2);
  const recent = f.calls.find((u) => u.pathname.endsWith("/klines"));
  assert.ok(recent, "cold seed uses the native current endpoint");
  assert.equal(recent.searchParams.get("limit"), String(WEEX_RECENT_PAGE_LIMIT));
  assert.equal(f.calls.some((u) => u.pathname.endsWith("/historyKlines")), false);
  const coverage = f.collector.coverage("BTCUSDT");
  assert.equal(coverage.firstClosedMs, firstStored);
  assert.equal(coverage.lastClosedMs, newest);
  assert.equal(coverage.count, WEEX_RECENT_PAGE_LIMIT - 2);
  assert.equal(coverage.interiorMissing, 0);
});

await test("WEEX recent tail advances only from the exact next minute", async () => {
  const f = fixture();
  const firstNow = settledOpenMs(NOW);
  const seedFirst = firstNow - (WEEX_RECENT_PAGE_LIMIT - 1) * MINUTE_MS;
  f.setCurrent(rows(seedFirst, WEEX_RECENT_PAGE_LIMIT));
  await f.collector.tick(f.fetchLike, 1, NOW, { sleep: async () => {} });

  const nextNow = NOW + 5 * MINUTE_MS;
  const nextClosed = settledOpenMs(nextNow);
  // A full current page overlaps held data; the collector must range-filter it
  // and append only the five exact successor minutes.
  f.setCurrent(rows(nextClosed - (WEEX_RECENT_PAGE_LIMIT - 1) * MINUTE_MS, WEEX_RECENT_PAGE_LIMIT));
  const result = await f.collector.tick(f.fetchLike, 1, nextNow, { sleep: async () => {} });
  assert.equal(result.written, 5);
  const coverage = f.collector.coverage("BTCUSDT");
  assert.equal(coverage.lastClosedMs, nextClosed);
  assert.equal(coverage.count, WEEX_RECENT_PAGE_LIMIT + 5);
  assert.equal(coverage.interiorMissing, 0);
  assert.equal(f.calls.filter((u) => u.pathname.endsWith("/historyKlines")).length, 0);
});

await test("WEEX tail older than the current window uses one bounded historical page without jumping a gap", async () => {
  const f = fixture();
  const seedEnd = settledOpenMs(NOW);
  const seedFirst = seedEnd - (WEEX_RECENT_PAGE_LIMIT - 1) * MINUTE_MS;
  f.setCurrent(rows(seedFirst, WEEX_RECENT_PAGE_LIMIT));
  await f.collector.tick(f.fetchLike, 1, NOW, { sleep: async () => {} });

  const muchLater = NOW + (WEEX_RECENT_PAGE_LIMIT + 50) * MINUTE_MS;
  const missingFirst = seedEnd + MINUTE_MS;
  f.setHistory(rows(missingFirst, WEEX_PAGE_LIMIT));
  const result = await f.collector.tick(f.fetchLike, 1, muchLater, { sleep: async () => {} });
  assert.equal(result.written, WEEX_PAGE_LIMIT);
  const history = f.calls.filter((u) => u.pathname.endsWith("/historyKlines")).at(-1);
  assert.ok(history, "old tail uses historyKlines rather than a newest-page jump");
  assert.equal(history.searchParams.get("startTime"), String(missingFirst));
  assert.equal(history.searchParams.get("endTime"), String(missingFirst + (WEEX_PAGE_LIMIT - 1) * MINUTE_MS));
  assert.equal(history.searchParams.get("limit"), String(WEEX_PAGE_LIMIT));
  const coverage = f.collector.coverage("BTCUSDT");
  assert.equal(coverage.lastClosedMs, missingFirst + (WEEX_PAGE_LIMIT - 1) * MINUTE_MS);
  assert.equal(coverage.interiorMissing, 0, "historical fallback remains contiguous with held data");
});

await test("WEEX recent page missing the first tail minute defers one separately paced historical fallback", async () => {
  const f = fixture();
  const seedEnd = settledOpenMs(NOW);
  const seedFirst = seedEnd - (WEEX_RECENT_PAGE_LIMIT - 1) * MINUTE_MS;
  f.setCurrent(rows(seedFirst, WEEX_RECENT_PAGE_LIMIT));
  await f.collector.tick(f.fetchLike, 1, NOW, { sleep: async () => {} });

  const later = NOW + 5 * MINUTE_MS;
  const missingFirst = seedEnd + MINUTE_MS;
  // This newest page starts one minute too late. Writing any of it would create
  // a permanent hole, so this pass must spend exactly one request and write 0.
  f.setCurrent(rows(missingFirst + MINUTE_MS, 4));
  const before = f.calls.length;
  const missed = await f.collector.tick(f.fetchLike, 1, later, { sleep: async () => {} });
  assert.equal(missed.requests, 1);
  assert.equal(missed.written, 0);
  assert.equal(f.calls.length, before + 1, "fallback is not hidden inside the recent request's budget slot");
  assert.ok(f.calls.at(-1).pathname.endsWith("/klines"));
  assert.equal(f.collector.coverage("BTCUSDT").lastClosedMs, seedEnd);

  // The next pass gets its own paced/budgeted request and asks history for the
  // exact first missing minute. Only then can the tail move forward.
  f.setHistory(rows(missingFirst, 5));
  const fallback = await f.collector.tick(f.fetchLike, 1, later, { sleep: async () => {} });
  assert.equal(fallback.requests, 1);
  assert.equal(fallback.written, 5);
  const history = f.calls.at(-1);
  assert.ok(history.pathname.endsWith("/historyKlines"));
  assert.equal(history.searchParams.get("startTime"), String(missingFirst));
  assert.equal(history.searchParams.get("limit"), String(WEEX_PAGE_LIMIT));
  assert.equal(f.collector.coverage("BTCUSDT").lastClosedMs, settledOpenMs(later));
  assert.equal(f.collector.coverage("BTCUSDT").interiorMissing, 0);
});

summary("weex-recent");
