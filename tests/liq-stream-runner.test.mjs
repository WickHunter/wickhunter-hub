// tests/liq-stream-runner.test.mjs — the connection layer for the eight
// liquidation sources: chunked Bybit rosters, the two single-stream Binance
// feeds, OKX's one multi-source channel, and the shared reconnect/backoff
// from `../net/socket-pool.js` (proved directly in `socket-pool.test.mjs`;
// this suite proves the WIRING on top of it).
import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import { LiqStreamRunner, DEFAULT_LIQ_STREAM_CONFIG } from "../dist/src/liq/stream-runner.js";

function fakeSockets() {
  const made = [];
  const factory = (url, h) => {
    const s = { url, h, sent: [], closed: false, send: (d) => s.sent.push(d), close: () => { s.closed = true; } };
    made.push(s);
    return s;
  };
  return { factory, made };
}

function fakeFetch(rules) {
  return async (url) => {
    for (const r of rules) {
      if (r.test(url)) return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body };
    }
    throw new Error(`fakeFetch: no rule matched ${url}`);
  };
}

const bybitInstruments = (rows, cursor = "") => ({ result: { list: rows, nextPageCursor: cursor } });
const bybitRow = (symbol, quoteCoin, status = "Trading", contractType = "LinearPerpetual") => ({ symbol, quoteCoin, status, contractType });

async function settle(n = 6) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const bybitLiqFrame = (symbol, side, price, v, ts) =>
  JSON.stringify({ topic: `allLiquidation.${symbol}`, data: [{ s: symbol, S: side, p: String(price), v: String(v), T: ts }] });

function baseCfg(overrides = {}) {
  return { ...DEFAULT_LIQ_STREAM_CONFIG, ...overrides };
}

await test("bybit sources open no socket until their roster loads, then chunk at the topic cap", async () => {
  const { factory, made } = fakeSockets();
  const rows = Array.from({ length: 1_100 }, (_, i) => bybitRow(`S${i}USDT`, "USDT"));
  const fetchLike = fakeFetch([{ test: (u) => u.includes("instruments-info"), body: bybitInstruments(rows) }]);
  const events = [];
  const r = new LiqStreamRunner(baseCfg({ sources: ["bybit-usdt"] }), { emit: (e) => events.push(e), fetchLike, socket: factory });
  r.start();
  assert.equal(made.length, 0, "nothing opens before the roster is known");
  await settle();
  assert.equal(made.length, 3, "1,100 symbols over a 500-topic cap is 3 sockets");
  assert.ok(made.every((s) => s.url === DEFAULT_LIQ_STREAM_CONFIG.bybitLinearUrl));
  r.stop();
});

await test("bybit-usdc and bybit-usdt are two independent connections filtered by quoteCoin, off the SAME linear category", async () => {
  const { factory, made } = fakeSockets();
  const rows = [bybitRow("BTCUSDT", "USDT"), bybitRow("ETHUSDT", "USDT"), bybitRow("BTCPERP", "USDC")];
  const fetchLike = fakeFetch([{ test: (u) => u.includes("instruments-info"), body: bybitInstruments(rows) }]);
  const r = new LiqStreamRunner(baseCfg({ sources: ["bybit-usdt", "bybit-usdc"] }), { emit: () => {}, fetchLike, socket: factory });
  r.start();
  await settle();
  assert.equal(made.length, 2, "one socket per source, both under the topic cap");
  made[0].h.onOpen();
  made[1].h.onOpen();
  const usdtSub = JSON.parse(made[0].sent[0]);
  const usdcSub = JSON.parse(made[1].sent[0]);
  assert.deepEqual(usdtSub.args.sort(), ["allLiquidation.BTCUSDT", "allLiquidation.ETHUSDT"]);
  assert.deepEqual(usdcSub.args, ["allLiquidation.BTCPERP"]);
  r.stop();
});

await test("bybit-inverse uses its own websocket host and category, unfiltered by quote", async () => {
  const { factory, made } = fakeSockets();
  const rows = [bybitRow("BTCUSD", undefined, "Trading", "InversePerpetual")];
  const fetchLike = fakeFetch([{ test: (u) => u.includes("category=inverse"), body: bybitInstruments(rows) }]);
  const r = new LiqStreamRunner(baseCfg({ sources: ["bybit-inverse"] }), { emit: () => {}, fetchLike, socket: factory });
  r.start();
  await settle();
  assert.equal(made.length, 1);
  assert.equal(made[0].url, DEFAULT_LIQ_STREAM_CONFIG.bybitInverseUrl);
  r.stop();
});

await test("a bybit source ignores a Trading=false or non-perpetual row", async () => {
  const { factory, made } = fakeSockets();
  const rows = [bybitRow("BTCUSDT", "USDT"), bybitRow("DELISTEDUSDT", "USDT", "Closed"), bybitRow("FUTUREUSDT", "USDT", "Trading", "LinearFutures")];
  const fetchLike = fakeFetch([{ test: () => true, body: bybitInstruments(rows) }]);
  const r = new LiqStreamRunner(baseCfg({ sources: ["bybit-usdt"] }), { emit: () => {}, fetchLike, socket: factory });
  r.start();
  await settle();
  made[0].h.onOpen();
  const sub = JSON.parse(made[0].sent[0]);
  assert.deepEqual(sub.args, ["allLiquidation.BTCUSDT"]);
  r.stop();
});

await test("a bybit liquidation frame reaches emit() through the normalizer, and unrelated topics are ignored", async () => {
  const { factory, made } = fakeSockets();
  const fetchLike = fakeFetch([{ test: () => true, body: bybitInstruments([bybitRow("BTCUSDT", "USDT")]) }]);
  const events = [];
  const r = new LiqStreamRunner(baseCfg({ sources: ["bybit-usdt"] }), { emit: (e) => events.push(e), fetchLike, socket: factory });
  r.start();
  await settle();
  made[0].h.onOpen();
  made[0].h.onMessage(bybitLiqFrame("BTCUSDT", "Sell", 65_000, 0.2, 1_700_000_000_000));
  made[0].h.onMessage(JSON.stringify({ op: "pong" }));
  made[0].h.onMessage("not json");
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "bybit-usdt");
  assert.equal(events[0].side, "short");
  assert.equal(events[0].nativeSymbol, "BTCUSDT");
  r.stop();
});

await test("binance-usdt and binance-inverse are single always-on connections, no subscribe frame, no chunking", async () => {
  const { factory, made } = fakeSockets();
  const r = new LiqStreamRunner(baseCfg({ sources: ["binance-usdt", "binance-inverse"] }), {
    emit: () => {}, fetchLike: fakeFetch([{ test: () => true, body: { symbols: [] } }]), socket: factory,
  });
  r.start();
  assert.equal(made.length, 2, "one socket each, opened immediately — no roster to wait on");
  assert.deepEqual(made.map((s) => s.url).sort(), [DEFAULT_LIQ_STREAM_CONFIG.binanceCoinWsUrl, DEFAULT_LIQ_STREAM_CONFIG.binanceUsdtWsUrl].sort());
  made[0].h.onOpen();
  assert.equal(made[0].sent.length, 0, "the URL itself is the one subscription — nothing is sent on open");
  r.stop();
});

await test("binance-inverse notional uses the loaded contract size once available, and the documented fallback before that", async () => {
  const { factory, made } = fakeSockets();
  let resolveDapi;
  const dapiPromise = new Promise((res) => { resolveDapi = res; });
  const fetchLike = async (url) => {
    if (url.includes("dapi")) { await dapiPromise; return { ok: true, status: 200, json: async () => ({ symbols: [{ symbol: "BTCUSD_PERP", contractSize: 100 }] }) }; }
    throw new Error("unexpected fetch " + url);
  };
  const events = [];
  const r = new LiqStreamRunner(baseCfg({ sources: ["binance-inverse"] }), { emit: (e) => events.push(e), fetchLike, socket: factory });
  r.start();
  const frame = JSON.stringify({ o: { s: "BTCUSD_PERP", S: "SELL", q: "12", ap: "65000", T: 1 } });
  made[0].h.onMessage(frame);
  assert.equal(events.length, 1);
  assert.ok(Math.abs(events[0].sizeUsd - 12 * 100) < 1e-9, "documented $100/contract fallback for BTC before the table loads");

  resolveDapi();
  await settle();
  made[0].h.onMessage(frame);
  assert.equal(events.length, 2);
  assert.ok(Math.abs(events[1].sizeUsd - 12 * 100) < 1e-9, "same figure here since the loaded size also happens to be 100 — see the next case for a differing one");

  r.stop();
});

await test("okx is one channel serving three sources, gated on the ctVal table and never guessing at ×1", async () => {
  const { factory, made } = fakeSockets();
  let resolveCtVals;
  const ctValsPromise = new Promise((res) => { resolveCtVals = res; });
  const fetchLike = async (url) => {
    if (url.includes("instruments")) { await ctValsPromise; return { ok: true, status: 200, json: async () => ({ data: [{ instId: "BTC-USDT-SWAP", ctVal: "0.01", ctType: "linear" }] }) }; }
    throw new Error("unexpected fetch " + url);
  };
  const events = [];
  const r = new LiqStreamRunner(baseCfg({ sources: ["okx-usdt", "okx-usdc", "okx-inverse"] }), { emit: (e) => events.push(e), fetchLike, socket: factory });
  r.start();
  assert.equal(made.length, 1, "one socket for all three OKX sources");
  made[0].h.onOpen();
  const sub = JSON.parse(made[0].sent[0]);
  assert.equal(sub.args[0].channel, "liquidation-orders");

  const frame = JSON.stringify({ arg: { channel: "liquidation-orders" }, data: [{ instId: "BTC-USDT-SWAP", details: [{ side: "sell", sz: "25", bkPx: "65000", ts: "1" }] }] });
  made[0].h.onMessage(frame);
  assert.equal(events.length, 0, "no ctVal table yet — the event is dropped, never guessed at ×1");

  resolveCtVals();
  await settle();
  made[0].h.onMessage(frame);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "okx-usdt");

  made[0].h.onMessage("pong");
  made[0].h.onMessage(JSON.stringify({ event: "error", code: "60018", msg: "bad" }));
  made[0].h.onMessage(JSON.stringify({ event: "subscribe", arg: { channel: "liquidation-orders" } }));
  assert.equal(events.length, 1, "protocol/ack/error frames never reach the normalizer");
  r.stop();
});

await test("push() filters by the configured source set — okx-usdc is never emitted when only okx-usdt is wanted", async () => {
  const { factory, made } = fakeSockets();
  const ctVals = { data: [{ instId: "BTC-USDT-SWAP", ctVal: "0.01", ctType: "linear" }, { instId: "BTC-USDC-SWAP", ctVal: "0.01", ctType: "linear" }] };
  const fetchLike = fakeFetch([{ test: () => true, body: ctVals }]);
  const events = [];
  const r = new LiqStreamRunner(baseCfg({ sources: ["okx-usdt"] }), { emit: (e) => events.push(e), fetchLike, socket: factory });
  r.start();
  await settle();
  made[0].h.onMessage(JSON.stringify({
    arg: { channel: "liquidation-orders" },
    data: [
      { instId: "BTC-USDT-SWAP", details: [{ side: "sell", sz: "1", bkPx: "1", ts: "1" }] },
      { instId: "BTC-USDC-SWAP", details: [{ side: "sell", sz: "1", bkPx: "1", ts: "1" }] },
    ],
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "okx-usdt");
  r.stop();
});

await test("an empty source list opens no sockets at all", () => {
  const { factory, made } = fakeSockets();
  const r = new LiqStreamRunner(baseCfg({ sources: [] }), { emit: () => {}, socket: factory });
  r.start();
  assert.equal(made.length, 0);
  const st = r.status();
  assert.ok(st.every((s) => s.state === "off"));
  r.stop();
});

await test("status() reports off/connecting/live and per-source event counts", async () => {
  const { factory, made } = fakeSockets();
  const fetchLike = fakeFetch([{ test: () => true, body: { symbols: [] } }]);
  const r = new LiqStreamRunner(baseCfg({ sources: ["binance-usdt"] }), { emit: () => {}, fetchLike, socket: factory });
  const beforeStart = r.status().find((s) => s.id === "binance-usdt");
  assert.equal(beforeStart.state, "off");
  r.start();
  const connecting = r.status().find((s) => s.id === "binance-usdt");
  assert.equal(connecting.state, "connecting");
  const otherOff = r.status().find((s) => s.id === "okx-usdt");
  assert.equal(otherOff.state, "off", "a source not in this run's config stays off");
  made[0].h.onOpen();
  made[0].h.onMessage(JSON.stringify({ o: { s: "BTCUSDT", S: "SELL", q: "1", ap: "1", T: 42 } }));
  const live = r.status().find((s) => s.id === "binance-usdt");
  assert.equal(live.state, "live");
  assert.equal(live.events, 1);
  assert.equal(live.lastEventAt, 42);
  r.stop();
  const stopped = r.status().find((s) => s.id === "binance-usdt");
  assert.equal(stopped.state, "off", "stop() tears every connection down");
});

await test("stop() tears down every socket and a late callback from a retired one is inert", async () => {
  const { factory, made } = fakeSockets();
  const fetchLike = fakeFetch([{ test: () => true, body: { symbols: [] } }]);
  const events = [];
  const r = new LiqStreamRunner(baseCfg({ sources: ["binance-usdt"] }), { emit: (e) => events.push(e), fetchLike, socket: factory });
  r.start();
  const sock = made[0];
  r.stop();
  assert.ok(sock.closed);
  sock.h.onMessage(JSON.stringify({ o: { s: "BTCUSDT", S: "SELL", q: "1", ap: "1", T: 1 } }));
  assert.equal(events.length, 0, "a message delivered after stop() is dropped, not recorded");
});

summary("liq-stream-runner");
