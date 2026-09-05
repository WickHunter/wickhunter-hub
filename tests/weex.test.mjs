// WEEX Hub candle collector: public mainnet REST only.
import assert from "node:assert/strict";
import { test, summary, tmpDir } from "./helpers.mjs";
import {
  ADAPTERS, VENUE_IDS, WEEX_HISTORY_KLINE_WEIGHT, WEEX_PAGE_LIMIT,
  WEEX_PUBLIC_WEIGHT_PER_MINUTE, weexPacedRps,
} from "../dist/src/candles/venues.js";
import { STREAM_ADAPTERS } from "../dist/src/candles/stream.js";
import { configFromEnv } from "../dist/src/config.js";
import { CandleService } from "../dist/src/candles/service.js";
import { DEFAULT_COLLECTOR_OPTIONS } from "../dist/src/candles/collector.js";
import { settledOpenMs } from "../dist/src/candles/store.js";

const weex = ADAPTERS.weex;
const MIN = 60_000;
const START = 1_788_000_000_000;

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

await test("WEEX is a REST-only candle venue with a conservative documented-weight pace", () => {
  assert.ok(VENUE_IDS.includes("weex"));
  assert.equal(weex.id, "weex");
  assert.equal(weex.pageLimit, 100);
  assert.equal(WEEX_PAGE_LIMIT, 100);
  assert.equal(WEEX_HISTORY_KLINE_WEIGHT, 5);
  assert.equal(WEEX_PUBLIC_WEIGHT_PER_MINUTE, 50);
  assert.equal(weex.publicRequestsPerSecond, 1 / 12);
  assert.equal(weexPacedRps(), 1 / 12);
  assert.equal(STREAM_ADAPTERS.weex, undefined, "a ticker socket is never presented as candle provenance");
});

await test("WEEX census requires mainnet USDT perpetual metadata and API eligibility", async () => {
  const urls = [];
  const fetchLike = async (url) => {
    urls.push(url);
    if (url.endsWith("/exchangeInfo")) return response({ symbols: [
      { symbol: "BTCUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", forwardContractFlag: true },
      { symbol: "SETTLINGUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", forwardContractFlag: true, status: "SETTLING" },
      { symbol: "USDCUSDT", quoteAsset: "USDC", marginAsset: "USDC", contractType: "PERPETUAL", forwardContractFlag: true },
      { symbol: "DELIVERYUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "CURRENT_QUARTER", forwardContractFlag: true },
      { symbol: "INVERSEUSDT", quoteAsset: "USDT", marginAsset: "BTC", contractType: "PERPETUAL", forwardContractFlag: true },
      { symbol: "DEMOUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", forwardContractFlag: false },
      { symbol: "UNLISTEDUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", forwardContractFlag: true },
    ] });
    if (url.endsWith("/apiTradingSymbols")) return response(["BTCUSDT", "SETTLINGUSDT", "USDCUSDT", "DELIVERYUSDT", "INVERSEUSDT", "DEMOUSDT"]);
    throw new Error(`unexpected URL ${url}`);
  };
  const rows = await weex.listSymbols(fetchLike);
  assert.deepEqual(rows, [
    { symbol: "BTCUSDT", tradable: true },
    { symbol: "SETTLINGUSDT", tradable: false },
  ]);
  assert.deepEqual(urls.sort(), [
    "https://api-contract.weex.com/capi/v3/market/apiTradingSymbols",
    "https://api-contract.weex.com/capi/v3/market/exchangeInfo",
  ]);
});

await test("WEEX history pages are bounded, range-filtered, base-volume rows normalized oldest first", async () => {
  const end = START + 2 * MIN;
  const seen = [];
  const page = await weex.fetchKlines(async (url) => {
    seen.push(url);
    return response([
      [end, "12", "13", "11", "12.5", "2.5", end + MIN - 1, "31"],
      [START - MIN, "1", "2", "0.5", "1.5", "9", START - 1, "12"],
      [START, "10", "12", "9", "11", "7.25", START + MIN - 1, "80"],
      [START + MIN, "11", "14", "10", "12", "4.5", START + 2 * MIN - 1, "54"],
    ]);
  }, "BTCUSDT", START, end);
  const url = new URL(seen[0]);
  assert.equal(url.origin, "https://api-contract.weex.com");
  assert.equal(url.pathname, "/capi/v3/market/historyKlines");
  assert.equal(url.searchParams.get("symbol"), "BTCUSDT");
  assert.equal(url.searchParams.get("interval"), "1m");
  assert.equal(url.searchParams.get("startTime"), String(START));
  assert.equal(url.searchParams.get("endTime"), String(end));
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.get("priceType"), "LAST");
  assert.deepEqual(page.candles.map((row) => row.openMs), [START, START + MIN, end]);
  assert.equal(page.candles[0].volume, 7.25, "index 5 is base volume, never quote turnover");
});

await test("an enabled legacy candle roster gains WEEX and starts a first pull without waiting for the interval", async () => {
  const configured = configFromEnv({ HUB_CANDLE_VENUES: "bybit,bitget" });
  assert.deepEqual(configured.candleVenues, ["bybit", "bitget", "weex"]);
  assert.deepEqual(configFromEnv({}).candleVenues, [], "the globally disabled service stays disabled");

  let calls = 0;
  const svc = new CandleService({
    dataDir: tmpDir("weex-start"), venues: ["weex"], keyId: "seed-1",
    options: { ...DEFAULT_COLLECTOR_OPTIONS, requestsPerSecond: 100, minRequestsPerSecond: 0.1 }, tickMs: 60_000,
  }, {
    sign: () => Buffer.alloc(64),
    fetchLike: async (url) => {
      calls++;
      if (url.endsWith("/exchangeInfo")) return response({ symbols: [] });
      if (url.endsWith("/apiTradingSymbols")) return response([]);
      throw new Error(`unexpected URL ${url}`);
    },
    sleep: async () => {},
  });
  svc.start();
  await new Promise((resolve) => setImmediate(resolve));
  svc.stop();
  assert.ok(calls >= 2, "start immediately requests WEEX discovery instead of waiting one tick");
});

await test("a newly API-eligible WEEX perpetual is refreshed, tracked, and seeded in the same pass", async () => {
  let apiEligible = new Set(["BTCUSDT"]);
  const candleSymbols = [];
  const svc = new CandleService({
    dataDir: tmpDir("weex-new-eligibility"), venues: ["weex"], keyId: "seed-1",
    // A high test-only allowance keeps the new pair's tail request ahead of
    // the existing pair's ordinary backfill in the refresh pass.
    options: { ...DEFAULT_COLLECTOR_OPTIONS, requestsPerSecond: 100, minRequestsPerSecond: 0.1 }, tickMs: 60_000,
  }, {
    sign: () => Buffer.alloc(64),
    fetchLike: async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/exchangeInfo")) return response({ symbols: [
        { symbol: "BTCUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", forwardContractFlag: true },
        // It exists in metadata at startup, but the separate API eligibility
        // list is the fact that makes it safe to fetch and store.
        { symbol: "NEWUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", forwardContractFlag: true },
      ] });
      if (u.pathname.endsWith("/apiTradingSymbols")) return response([...apiEligible]);
      if (u.pathname.endsWith("/historyKlines")) {
        const symbol = u.searchParams.get("symbol");
        const end = Number(u.searchParams.get("endTime"));
        candleSymbols.push(symbol);
        return response([[end, "10", "11", "9", "10.5", "2", end + MIN - 1, "21"]]);
      }
      if (u.pathname.endsWith("/klines")) {
        const symbol = u.searchParams.get("symbol");
        const end = settledOpenMs(START + DEFAULT_COLLECTOR_OPTIONS.symbolRefreshMs);
        candleSymbols.push(symbol);
        return response([[end, "10", "11", "9", "10.5", "2", end + MIN - 1, "21"]]);
      }
      throw new Error(`unexpected URL ${url}`);
    },
    sleep: async () => {},
  });

  await svc.tickAll(START);
  assert.equal(svc.collector("weex").isTracked("NEWUSDT"), false);
  assert.ok(!candleSymbols.includes("NEWUSDT"), "metadata alone never schedules an ineligible pair");

  // The eligibility endpoint changes after startup. A tick before the 15m
  // cadence is deliberately still the old set; the due tick re-reads both
  // endpoints and its work queue stores NEWUSDT without a restart.
  apiEligible = new Set(["BTCUSDT", "NEWUSDT"]);
  await svc.tickAll(START + DEFAULT_COLLECTOR_OPTIONS.symbolRefreshMs - 1);
  assert.equal(svc.collector("weex").isTracked("NEWUSDT"), false);
  await svc.tickAll(START + DEFAULT_COLLECTOR_OPTIONS.symbolRefreshMs);

  const collector = svc.collector("weex");
  assert.equal(collector.isTracked("NEWUSDT"), true, "fresh API eligibility joins the live collector");
  assert.ok(candleSymbols.includes("NEWUSDT"), "the newly tracked pair receives a native WEEX candle request");
  const newest = settledOpenMs(START + DEFAULT_COLLECTOR_OPTIONS.symbolRefreshMs);
  const stored = svc.store.readWindow("weex", "NEWUSDT", newest, newest).rows;
  assert.equal(stored.length, 1, "the fetched closed candle is persisted under the WEEX venue");
});

summary("weex");
