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

summary("weex");
