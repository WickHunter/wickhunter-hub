// WEEX Hub candle collector: public mainnet REST, with optional V3 candle tail.
import assert from "node:assert/strict";
import { test, summary, tmpDir } from "./helpers.mjs";
import {
  ADAPTERS, VENUE_IDS, WEEX_HISTORY_KLINE_WEIGHT, WEEX_PAGE_LIMIT,
  WEEX_PUBLIC_WEIGHT_PER_MINUTE, weexPacedRps,
} from "../dist/src/candles/venues.js";
import { STREAM_ADAPTERS, ClosureBuffer } from "../dist/src/candles/stream.js";
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

await test("WEEX has conservative REST history plus a documented V3 candle stream", () => {
  assert.ok(VENUE_IDS.includes("weex"));
  assert.equal(weex.id, "weex");
  assert.equal(weex.pageLimit, 100);
  assert.equal(WEEX_PAGE_LIMIT, 100);
  assert.equal(WEEX_HISTORY_KLINE_WEIGHT, 5);
  assert.equal(WEEX_PUBLIC_WEIGHT_PER_MINUTE, 50);
  assert.equal(weex.publicRequestsPerSecond, 1 / 12);
  assert.equal(weexPacedRps(), 1 / 12);
  assert.equal(STREAM_ADAPTERS.weex.id, "weex");
  assert.equal(STREAM_ADAPTERS.weex.url, "wss://ws-contract.weex.com/v3/ws/public");
  assert.equal(STREAM_ADAPTERS.weex.maxTopicsPerConnection, 100);
  const configured = configFromEnv({ HUB_CANDLE_VENUES: "bybit", HUB_CANDLE_STREAM: "weex" });
  assert.ok(configured.candleVenues.includes("weex"), "an enabled roster retains the auto-added WEEX collector");
  assert.deepEqual(configured.candleStreamVenues, ["weex"], "the verified stream is selectable through the existing opt-in");
});

await test("WEEX V3 forming candles publish only after the venue advances its own minute", () => {
  const a = STREAM_ADAPTERS.weex;
  const first = {
    e: "kline", E: 1788578130482, s: "BNBUSDT", p: "LAST_PRICE", d: [{
      // Live V3 observes T as the exclusive next-minute boundary. It is not a
      // close flag: WEEX carries no x/confirm field.
      t: 1788578100000, T: 1788578160000, s: "BNBUSDT", i: "1m",
      o: "721.80", c: "721.83", h: "722.20", l: "721.57", v: "12.51", n: 269, q: "9029.1252", V: "6.51", Q: "4697.8355",
    }],
  };
  const update = structuredClone(first);
  update.d[0].c = "721.90";
  update.d[0].v = "12.77";
  const next = structuredClone(first);
  next.d[0] = { ...next.d[0], t: 1788578160000, T: 1788578220000, o: "721.90", c: "722.10", h: "722.15", l: "721.80", v: "0.5" };

  const [forming] = a.parse(JSON.stringify(first));
  const [latest] = a.parse(JSON.stringify(update));
  const [advanced] = a.parse(JSON.stringify(next));
  assert.equal(forming.closed, false, "no endpoint arithmetic may claim closure");
  assert.equal(forming.candle.volume, 12.51, "v is base volume, never q quote turnover");
  const buf = new ClosureBuffer();
  assert.equal(buf.push(forming), null);
  assert.equal(buf.push(latest), null, "same-minute refresh remains forming");
  const closed = buf.push(advanced);
  assert.ok(closed, "a later venue minute closes the held bar");
  assert.equal(closed.openMs, first.d[0].t);
  assert.equal(closed.candle.close, 721.9, "the last forming update wins");
  assert.equal(closed.candle.volume, 12.77);
});

await test("WEEX V3 snapshot seeds only its closed prefix and skips its current forming bar", () => {
  const a = STREAM_ADAPTERS.weex;
  const now = Date.now();
  const currentOpen = Math.floor(now / MIN) * MIN;
  const priorOpen = currentOpen - 2 * MIN;
  const snapshot = {
    e: "klineSnapshot", E: now, s: "BTCUSDT", p: "LAST_PRICE", d: [
      // Deliberately newest-first: the adapter orders a snapshot before giving
      // it to ClosureBuffer, so a historical seed cannot be dropped as stale.
      { t: currentOpen, T: currentOpen + MIN, s: "BTCUSDT", i: "1m", o: "100", c: "101", h: "102", l: "99", v: "7" },
      { t: priorOpen, T: priorOpen + MIN, s: "BTCUSDT", i: "1m", o: "90", c: "100", h: "103", l: "89", v: "6" },
    ],
  };
  const ticks = a.parse(JSON.stringify(snapshot));
  assert.equal(ticks.length, 1, "current forming row is not stored from the snapshot");
  assert.equal(ticks[0].openMs, priorOpen);
  assert.equal(ticks[0].closed, true, "the explicit historical end creates the closed seed");
  assert.equal(new ClosureBuffer().push(ticks[0]).candle.close, 100);
  const inclusiveEnd = structuredClone(snapshot);
  inclusiveEnd.d = [{ ...snapshot.d[1], T: priorOpen + MIN - 1 }];
  assert.deepEqual(a.parse(JSON.stringify(inclusiveEnd)), [], "exclusive T is required by the live V3 wire contract");
});

await test("WEEX V3 rejects malformed wire values and non-exclusive incremental ends", () => {
  const a = STREAM_ADAPTERS.weex;
  const base = {
    e: "kline", s: "BTCUSDT", p: "LAST_PRICE", d: [{
      t: 1788578100000, T: 1788578160000, s: "BTCUSDT", i: "1m",
      o: "100", h: "102", l: "99", c: "101", v: "0",
    }],
  };
  assert.equal(a.parse(JSON.stringify(base)).length, 1, "zero base volume is a valid no-trade candle");
  for (const [field, value] of [
    ["o", null], ["o", ""], ["h", false], ["l", 0], ["c", -1],
    ["v", null], ["v", ""], ["v", false], ["v", -0.01], ["T", 1788578159999],
  ]) {
    const invalid = structuredClone(base);
    invalid.d[0][field] = value;
    assert.deepEqual(a.parse(JSON.stringify(invalid)), [], `${field}=${String(value)} is not a usable WEEX candle`);
  }
});

await test("WEEX V3 topics are exact, chunkable, and respond to its JSON heartbeat", () => {
  const a = STREAM_ADAPTERS.weex;
  const [frame] = a.subscribeFrames(["BTCUSDT", "ETHUSDT", "bad/pair"]);
  assert.deepEqual(frame, {
    method: "SUBSCRIBE", params: ["BTCUSDT@kline_1m_LAST_PRICE", "ETHUSDT@kline_1m_LAST_PRICE"], id: 1,
  });
  assert.deepEqual(a.replyFrames('{"event":"ping","time":"1788578130482"}'), [{ method: "PONG", id: 1 }]);
  assert.deepEqual(a.replyFrames('{"result":true,"id":1}'), []);
  assert.deepEqual(a.parse(JSON.stringify({ e: "kline", s: "BTCUSDT", p: "MARK_PRICE", d: [] })), [], "mark-price candles are not LAST_PRICE provenance");
});

await test("WEEX one-character base symbols subscribe and parse through snapshot and incremental paths", () => {
  const a = STREAM_ADAPTERS.weex;
  const [subscription] = a.subscribeFrames(["HUSDT", "WUSDT"]);
  assert.deepEqual(subscription.params, [
    "HUSDT@kline_1m_LAST_PRICE",
    "WUSDT@kline_1m_LAST_PRICE",
  ], "currently eligible one-character bases are not dropped from the socket roster");

  const now = Date.now();
  const currentOpen = Math.floor(now / MIN) * MIN;
  for (const symbol of ["HUSDT", "WUSDT"]) {
    const row = (openMs) => ({
      t: openMs, T: openMs + MIN, s: symbol, i: "1m",
      o: "1", h: "2", l: "0.5", c: "1.5", v: "3",
    });
    const snapshot = a.parse(JSON.stringify({
      e: "klineSnapshot", E: now, s: symbol, p: "LAST_PRICE",
      d: [row(currentOpen - 2 * MIN), row(currentOpen)],
    }));
    assert.equal(snapshot.length, 1, `${symbol} snapshot retains its closed prefix`);
    assert.equal(snapshot[0].symbol, symbol);
    assert.equal(snapshot[0].closed, true);

    const incremental = a.parse(JSON.stringify({
      e: "kline", E: now, s: symbol, p: "LAST_PRICE", d: [row(currentOpen)],
    }));
    assert.equal(incremental.length, 1, `${symbol} incremental frame is accepted`);
    assert.equal(incremental[0].symbol, symbol);
    assert.equal(incremental[0].closed, false, "ordinary WEEX updates still require minute advancement");
  }
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

await test("an enabled WEEX service opens its native stream as soon as discovery tracks a pair", async () => {
  const configured = configFromEnv({ HUB_CANDLE_VENUES: "bybit" });
  assert.deepEqual(configured.candleStreamVenues, ["weex"], "an existing producer receives WEEX streaming without an env edit");
  const sockets = [];
  const streamSocket = (url, h) => {
    const socket = { url, h, sent: [], close() {}, send(frame) { this.sent.push(frame); } };
    sockets.push(socket);
    return socket;
  };
  const svc = new CandleService({
    dataDir: tmpDir("weex-stream-start"), venues: ["weex"], streamVenues: configured.candleStreamVenues,
    keyId: "seed-1", options: { ...DEFAULT_COLLECTOR_OPTIONS, requestsPerSecond: 100, minRequestsPerSecond: 0.1 }, tickMs: 60_000,
  }, {
    sign: () => Buffer.alloc(64), now: () => START, sleep: async () => {}, streamSocket,
    fetchLike: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/exchangeInfo")) return response({ symbols: [
        { symbol: "BTCUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", forwardContractFlag: true },
      ] });
      if (pathname.endsWith("/apiTradingSymbols")) return response(["BTCUSDT"]);
      if (pathname.endsWith("/klines") || pathname.endsWith("/historyKlines")) return response([]);
      throw new Error(`unexpected URL ${url}`);
    },
  });
  svc.start();
  await svc.tickAll(START);
  assert.equal(sockets.length, 1, "post-discovery resync creates the WEEX public socket in the same tick");
  assert.equal(sockets[0].url, "wss://ws-contract.weex.com/v3/ws/public");
  sockets[0].h.onOpen();
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), {
    method: "SUBSCRIBE", params: ["BTCUSDT@kline_1m_LAST_PRICE"], id: 1,
  });
  svc.stop();
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
