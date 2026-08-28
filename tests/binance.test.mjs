// Binance USD-M Hub candle collection.
//
// This suite pins the product boundary that matters to Optimized bots:
// Binance mainnet, USDT-quoted + USDT-margined perpetual, native symbol, 1m
// trade candles. It also proves the Hub's existing durable store keeps Binance
// partitioned from Bybit across restart and retention pruning.
import assert from "node:assert/strict";
import { test, summary, tmpDir } from "./helpers.mjs";
import {
  ADAPTERS, VENUE_IDS, dropUnclosed, isRateLimit,
  BINANCE_REQUEST_WEIGHT_PER_MINUTE, BINANCE_WEIGHT_HEADER,
  BINANCE_WEIGHT_ALARM_SHARE, binanceKlineWeight, binancePacedRps,
} from "../dist/src/candles/venues.js";
import { STREAM_ADAPTERS } from "../dist/src/candles/stream.js";
import {
  CandleStore, DAY_MS, MINUTE_MS, floorMinute, newestClosedOpenMs,
} from "../dist/src/candles/store.js";
import { marketCapConfigFromEnv } from "../dist/src/marketcap/config.js";

const binance = ADAPTERS.binance;
const NOW = 1_787_000_534_092;
const FORMING = floorMinute(NOW);
const NEWEST_CLOSED = newestClosedOpenMs(NOW);

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

await test("binance is a first-class Hub candle venue with REST and stream adapters", () => {
  assert.ok(VENUE_IDS.includes("binance"));
  assert.equal(binance.id, "binance");
  assert.equal(STREAM_ADAPTERS.binance.id, "binance");
  assert.equal(binance.pageLimit, 1000);
  assert.equal(binance.publicRequestsPerSecond, 4);
});

await test("the symbol census admits only exact USD-M USDT perpetuals", async () => {
  const urls = [];
  const fetchLike = async (url) => {
    urls.push(url);
    return response({ symbols: [
      { symbol: "BTCUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" },
      { symbol: "OLDUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", status: "SETTLING" },
      { symbol: "BTCUSDC", quoteAsset: "USDC", marginAsset: "USDC", contractType: "PERPETUAL", status: "TRADING" },
      { symbol: "BTCUSD_PERP", quoteAsset: "USD", marginAsset: "BTC", contractType: "PERPETUAL", status: "TRADING" },
      { symbol: "BTCUSDT_260925", quoteAsset: "USDT", marginAsset: "USDT", contractType: "CURRENT_QUARTER", status: "TRADING" },
    ] });
  };
  const rows = await binance.listSymbols(fetchLike);
  assert.deepEqual(rows, [
    { symbol: "BTCUSDT", tradable: true },
    { symbol: "OLDUSDT", tradable: false },
  ]);
  assert.deepEqual(urls, ["https://fapi.binance.com/fapi/v1/exchangeInfo"]);
  assert.ok(!urls.some((url) => /bybit|testnet/i.test(url)), "no Bybit or testnet fallback exists");
});

await test("REST pages exact mainnet 1m trade candles, oldest first, with BASE volume", async () => {
  const urls = [];
  const fetchLike = async (url) => {
    urls.push(url);
    return response([
      [FORMING, "105", "108", "104", "107", "3.5", FORMING + MINUTE_MS - 1, "370"],
      [NEWEST_CLOSED - MINUTE_MS, "99", "102", "98", "101", "7.25", NEWEST_CLOSED - 1, "720"],
      [NEWEST_CLOSED, "101", "106", "100", "105", "4.75", FORMING - 1, "495"],
    ]);
  };
  const start = NEWEST_CLOSED - MINUTE_MS;
  const page = await binance.fetchKlines(fetchLike, "BTCUSDT", start, FORMING);
  const u = new URL(urls[0]);
  assert.equal(u.origin, "https://fapi.binance.com");
  assert.equal(u.pathname, "/fapi/v1/klines");
  assert.equal(u.searchParams.get("symbol"), "BTCUSDT");
  assert.equal(u.searchParams.get("interval"), "1m");
  assert.equal(u.searchParams.get("startTime"), String(start));
  assert.equal(u.searchParams.get("endTime"), String(FORMING + MINUTE_MS - 1));
  assert.equal(u.searchParams.get("limit"), "1000");
  assert.deepEqual(page.candles.map((row) => row.openMs), [start, NEWEST_CLOSED, FORMING]);
  assert.equal(page.candles[0].volume, 7.25, "index 5 is base volume, never quote turnover");
  assert.deepEqual(dropUnclosed(page.candles, NOW).map((row) => row.openMs), [start, NEWEST_CLOSED]);
});

await test("Binance pacing is derived from its published weight budget", () => {
  assert.equal(BINANCE_REQUEST_WEIGHT_PER_MINUTE, 2400);
  assert.equal(binanceKlineWeight(99), 1);
  assert.equal(binanceKlineWeight(100), 2);
  assert.equal(binanceKlineWeight(499), 2);
  assert.equal(binanceKlineWeight(500), 5);
  assert.equal(binanceKlineWeight(1000), 5);
  assert.equal(binanceKlineWeight(1500), 10);
  assert.equal(binancePacedRps(1000), 4, "half of 2400/min at weight 5");
});

await test("Binance's own weight readout keeps the paid page and requests a backoff", async () => {
  const used = Math.ceil(BINANCE_REQUEST_WEIGHT_PER_MINUTE * BINANCE_WEIGHT_ALARM_SHARE);
  const page = await binance.fetchKlines(
    async () => response([[NEWEST_CLOSED, "1", "2", ".5", "1.5", "3"]], 200, { [BINANCE_WEIGHT_HEADER]: String(used) }),
    "BTCUSDT", NEWEST_CLOSED, NEWEST_CLOSED,
  );
  assert.equal(page.candles.length, 1, "the already-paid candle is retained");
  assert.equal(isRateLimit(page.slowDown), true, "the collector slows before a refusal");
});

await test("HTTP 429/-1003 are rate limits; an ordinary Binance error is not", async () => {
  const http = await binance.fetchKlines(async () => response({}, 429), "BTCUSDT", 0, 0).then(() => null, (e) => e);
  assert.equal(isRateLimit(http), true);
  const weighted = await binance.fetchKlines(
    async () => response({ code: -1003, msg: "Too much request weight used" }, 400), "BTCUSDT", 0, 0,
  ).then(() => null, (e) => e);
  assert.equal(isRateLimit(weighted), true);
  const badSymbol = await binance.fetchKlines(
    async () => response({ code: -1121, msg: "Invalid symbol." }, 400), "NOPEUSDT", 0, 0,
  ).then(() => null, (e) => e);
  assert.equal(isRateLimit(badSymbol), false);
  assert.match(badSymbol.message, /-1121/);
});

await test("the optional stream subscribes only exact 1m Binance USDT symbols", () => {
  const a = STREAM_ADAPTERS.binance;
  assert.equal(a.url, "wss://fstream.binance.com/market/stream");
  assert.deepEqual(a.subscribeFrames(["BTCUSDT", "ETHUSDT"]), [{
    method: "SUBSCRIBE", params: ["btcusdt@kline_1m", "ethusdt@kline_1m"], id: 1,
  }]);
  assert.deepEqual(a.subscribeFrames(["BTCUSD_PERP", "BTCUSDC"]), [], "CM/USDC topics cannot enter the USD-M collector");
});

await test("the stream accepts closed USD-M 1m frames and refuses CM or another timeframe", () => {
  const payload = {
    stream: "btcusdt@kline_1m",
    data: { e: "kline", s: "BTCUSDT", st: 1, k: {
      t: NEWEST_CLOSED, i: "1m", s: "BTCUSDT", o: "100", h: "105", l: "99", c: "104", v: "6.25", x: true,
    } },
  };
  const [tick] = STREAM_ADAPTERS.binance.parse(JSON.stringify(payload));
  assert.equal(tick.symbol, "BTCUSDT");
  assert.equal(tick.openMs, NEWEST_CLOSED);
  assert.equal(tick.candle.volume, 6.25);
  assert.equal(tick.closed, true);
  assert.deepEqual(STREAM_ADAPTERS.binance.parse(JSON.stringify({ ...payload, data: { ...payload.data, st: 2 } })), [], "explicit CM frame refused");
  assert.deepEqual(STREAM_ADAPTERS.binance.parse(JSON.stringify({
    ...payload, data: { ...payload.data, k: { ...payload.data.k, i: "5m" } },
  })), [], "only the stored 1m provenance is accepted");
});

await test("Binance store state survives restart, stays separate from Bybit, and prunes by retention day", () => {
  const root = tmpDir("binance-candles");
  const old = Date.parse("2026-07-01T00:00:00.000Z");
  const fresh = old + 2 * DAY_MS;
  const candle = (openMs, close) => ({ openMs, open: close, high: close + 1, low: close - 1, close, volume: 10 });
  const first = new CandleStore(root);
  first.write("binance", "BTCUSDT", [candle(old, 100), candle(fresh, 102)]);
  first.write("bybit", "BTCUSDT", [candle(old, 900), candle(fresh, 902)]);

  const restarted = new CandleStore(root);
  assert.deepEqual(restarted.readWindow("binance", "BTCUSDT", old, fresh).rows.map((row) => row[4]), [100, 102]);
  assert.deepEqual(restarted.readWindow("bybit", "BTCUSDT", old, fresh).rows.map((row) => row[4]), [900, 902]);
  assert.equal(restarted.prune("binance", "BTCUSDT", fresh), 1, "the old Binance day is pruned");
  assert.deepEqual(restarted.days("binance", "BTCUSDT"), [fresh]);
  assert.deepEqual(restarted.days("bybit", "BTCUSDT"), [old, fresh], "another venue's retention partition is untouched");
});

await test("Binance candle support cannot silently enter the paid market-cap producer", () => {
  const cfg = marketCapConfigFromEnv({
    MARKET_CAP_VENUES: "binance,bybit",
    MARKET_CAP_SLUGS: "binance:binance,bybit:bybit",
    MARKET_CAP_EXCHANGE_IDS: "binance:270,bybit:521",
  }, tmpDir("binance-marketcap-isolation"));
  assert.deepEqual(cfg.venues, ["bybit"]);
  assert.equal(Object.hasOwn(cfg.slugs, "binance"), false);
  assert.equal(Object.hasOwn(cfg.exchangeIds, "binance"), false);
});

summary("binance");
