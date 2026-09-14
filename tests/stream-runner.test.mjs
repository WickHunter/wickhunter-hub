// tests/stream-runner.test.mjs — the socket half of the websocket tail.
//
// `stream.test.mjs` proves the PROTOCOL against frames captured from the live
// venues. This file proves the CONNECTION behaviour, which cannot be observed
// against a live venue at all: you cannot ask an exchange to drop your socket on
// cue, and a reconnect storm is exactly the thing you must not test in
// production. So the socket is injected and driven by hand.
//
// The four properties, in the order they would hurt:
//
//  1. A CLOSED CANDLE REACHES THE STORE, and a forming one never does.
//  2. SYMBOLS ARE CHUNKED at the venue's own topic cap. One socket for a
//     528-pair roster is refused by the venue; one per symbol blows the
//     connection cap.
//  3. RECONNECT IS BOUNDED AND JITTERED, and the held forming bar is DROPPED
//     across it — publishing it after a gap would emit a bar built from a
//     fraction of its trades.
//  4. NOTHING THROWS OUT. A parse failure, a store failure, or a socket that
//     cannot open must leave the process alive and degrade to REST.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test, summary, tmpDir } from "./helpers.mjs";
import { VenueStreamRunner } from "../dist/src/candles/stream-runner.js";
import { STREAM_ADAPTERS } from "../dist/src/candles/stream.js";
import { CandleStore, DAY_MS } from "../dist/src/candles/store.js";
import { VenueCollector, DEFAULT_COLLECTOR_OPTIONS } from "../dist/src/candles/collector.js";

const MIN = 60_000;
const T0 = 1786650720000;

/** A hand-driven socket. `open()`, `frame()` and `drop()` are the test's hands. */
function fakeSockets() {
  const made = [];
  const factory = (url, h) => {
    const s = {
      url, h, sent: [], closed: false,
      send: (d) => s.sent.push(d),
      close: () => { s.closed = true; },
    };
    made.push(s);
    return s;
  };
  return { factory, made };
}

const bitgetFrame = (openMs, close) =>
  JSON.stringify({
    action: "update", arg: { instId: "BTCUSDT" },
    data: [[String(openMs), "1", "2", "0.5", String(close), "3", "9", "9"]],
  });

// Observed on Bitget's public candle1m stream: each subscription starts with
// 500 ascending rows. Across the production roster, per-row writes rewrote
// roughly 27 GB of day files before the event loop could answer health.
const bitgetSnapshot = (firstOpenMs, count = 500) => JSON.stringify({
  action: "snapshot", arg: { instId: "BTCUSDT" },
  data: Array.from({ length: count }, (_, i) => [
    String(firstOpenMs + i * MIN), "1", "2", "0.5", String(10 + i), "3", "9", "9",
  ]),
});

function nativeClosingFrames(venue, openMs, symbol = "BTCUSDT") {
  if (venue === "bitget") return [openMs, openMs + MIN].map(t => JSON.stringify({
    action: "update", arg: { instId: symbol }, data: [[String(t), "1", "2", "0.5", "1.5", "3"]],
  }));
  if (venue === "bitunix") return [openMs, openMs + MIN].map(t => JSON.stringify({
    ch: "market_kline_1min", symbol, ts: t + 30_000,
    data: { o: "1", h: "2", l: "0.5", c: "1.5", b: "3" },
  }));
  if (venue === "bybit") return [JSON.stringify({
    topic: `kline.1.${symbol}`,
    data: [{ start: openMs, open: "1", high: "2", low: "0.5", close: "1.5", volume: "3", confirm: true }],
  })];
  return [JSON.stringify({
    e: "kline", s: symbol, st: 1,
    k: { t: openMs, i: "1m", o: "1", h: "2", l: "0.5", c: "1.5", v: "3", x: true },
  })];
}

const weexFrame = (openMs, close) =>
  JSON.stringify({
    e: "kline", E: openMs + 10, s: "BTCUSDT", p: "LAST_PRICE",
    d: [{ t: openMs, T: openMs + MIN, s: "BTCUSDT", i: "1m", o: "1", h: "2", l: "0.5", c: String(close), v: "3" }],
  });

const weexSnapshot = (firstOpenMs, count) =>
  JSON.stringify({
    // A multi-row observation frame through the currently forming minute.
    e: "kline", E: firstOpenMs + (count - 1) * MIN + 30_000, s: "BTCUSDT", p: "LAST_PRICE",
    d: Array.from({ length: count }, (_, i) => ({
      t: firstOpenMs + i * MIN, T: firstOpenMs + (i + 1) * MIN,
      s: "BTCUSDT", i: "1m", o: "1", h: "2", l: "0.5", c: String(10 + i), v: "3",
    })),
  });

await test("a closed candle reaches the store; a forming one never does", () => {
  const { factory, made } = fakeSockets();
  const wrote = [];
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.bitget,
    symbols: () => ["BTCUSDT"],
    write: (symbol, candles, notAfterMs) => wrote.push({ symbol, candles, notAfterMs }),
    socket: factory,
    now: () => T0 + 5 * MIN,
  });
  r.start();
  assert.equal(made.length, 1, "one socket for one symbol");
  made[0].h.onOpen();
  assert.ok(made[0].sent.length > 0, "it subscribed on open");
  assert.ok(made[0].sent[0].includes("BTCUSDT"), "…naming the symbol");

  // The bar forms. Nothing may be stored: it is not finished.
  made[0].h.onMessage(bitgetFrame(T0, 10));
  made[0].h.onMessage(bitgetFrame(T0, 11));
  assert.equal(wrote.length, 0, "a forming bar is never written");

  // The venue moves to the next minute — THAT closes the previous one.
  made[0].h.onMessage(bitgetFrame(T0 + MIN, 20));
  assert.equal(wrote.length, 1, "the finished minute is written");
  assert.equal(wrote[0].symbol, "BTCUSDT");
  assert.equal(wrote[0].candles[0].openMs, T0);
  assert.equal(wrote[0].candles[0].close, 11, "the LAST value of that minute, not the first");
  // The store's own settled gate is applied here too rather than trusted from
  // the stream, so this route cannot put a forming bar in the store either.
  assert.ok(wrote[0].notAfterMs > 0 && wrote[0].notAfterMs < T0 + 5 * MIN, "a settled ceiling is passed");
  r.stop();
});

await test("symbols are chunked at the venue's own topic cap", () => {
  const { factory, made } = fakeSockets();
  const symbols = Array.from({ length: 120 }, (_, i) => `S${i}USDT`);
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.bitget, // cap 50
    symbols: () => symbols,
    write: () => {},
    socket: factory,
  });
  r.start();
  const cap = STREAM_ADAPTERS.bitget.maxTopicsPerConnection;
  assert.equal(made.length, Math.ceil(120 / cap), `120 symbols over ${cap}-topic sockets`);
  const st = r.status();
  assert.equal(st.symbols, 120, "every symbol is assigned exactly once");
  assert.equal(st.sockets, made.length);
  r.stop();
  assert.ok(made.every((s) => s.closed), "stop closes every socket");
});

await test("Bitget's 500-row startup snapshot writes once and preserves every closed row across midnight", () => {
  const dir = tmpDir("bitget-snapshot");
  const store = new CandleStore(dir);
  const { factory, made } = fakeSockets();
  const first = Math.floor(T0 / DAY_MS) * DAY_MS + DAY_MS - 10 * MIN;
  const wrote = [];
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.bitget,
    symbols: () => ["BTCUSDT"],
    write: (symbol, candles, notAfterMs) => {
      wrote.push({ symbol, candles, notAfterMs });
      store.write("bitget", symbol, candles, notAfterMs);
    },
    socket: factory,
    now: () => first + 502 * MIN,
  });
  try {
    r.start();
    made[0].h.onOpen();
    made[0].h.onMessage(bitgetSnapshot(first));
    assert.equal(wrote.length, 1, "499 closed rows must not cause 499 synchronous store calls");
    assert.equal(wrote[0].candles.length, 499);
    const rows = store.readWindow("bitget", "BTCUSDT", first, first + 499 * MIN).rows;
    assert.equal(rows.length, 499, "all closed rows survive the real day-file boundary");
    assert.deepEqual(rows.map(row => row[0]), Array.from({ length: 499 }, (_, i) => first + i * MIN));
    assert.equal(rows[0][4], 10);
    assert.equal(rows.at(-1)[4], 508);
    assert.equal(r.status().closedCandles, 499, "status counts candles, not durable batches");
    assert.equal(r.status().holding, 1, "the snapshot's final observation remains forming");
    made[0].h.onMessage(bitgetFrame(first + 500 * MIN, 999));
    assert.equal(wrote.length, 2, "the next live minute is still written immediately");
    assert.equal(wrote[1].candles[0].openMs, first + 499 * MIN);
    assert.equal(wrote[1].candles[0].close, 509);
  } finally {
    r.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("Bitget snapshot batching excludes an unsettled close from both storage and counters", () => {
  const { factory, made } = fakeSockets();
  const wrote = [];
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.bitget,
    symbols: () => ["BTCUSDT"],
    write: (symbol, candles, notAfterMs) => wrote.push({ symbol, candles, notAfterMs }),
    socket: factory,
    // N is forming, N-1 is logically closed, but the clock-skew guard only
    // admits N-2. The closed tail must wait for the settlement timer.
    now: () => T0 + 499 * MIN + 30_000,
  });
  try {
    r.start();
    made[0].h.onOpen();
    made[0].h.onMessage(bitgetSnapshot(T0));
    assert.equal(wrote.length, 1);
    assert.equal(wrote[0].candles.length, 498);
    assert.equal(wrote[0].candles.at(-1).openMs, T0 + 497 * MIN);
    assert.ok(wrote[0].candles.every(c => c.openMs <= wrote[0].notAfterMs));
    assert.equal(r.status().closedCandles, 498, "a clock-skew rejection is not counted as stored");
    assert.equal(r.status().holding, 2, "one deferred close plus the forming tail");
  } finally { r.stop(); }
});

for (const venue of ["bitget", "bitunix", "bybit", "binance", "aster"]) {
  await test(`${venue} retains a native live close until clock-only settlement, without asserting REST provenance`, async () => {
    const dir = tmpDir(`${venue}-settlement`);
    const store = new CandleStore(dir);
    const collector = new VenueCollector(venue, store, dir, DEFAULT_COLLECTOR_OPTIONS, T0);
    const { factory, made } = fakeSockets();
    const wrote = [];
    let clock = T0 + MIN + 30_000;
    const r = new VenueStreamRunner({
      adapter: STREAM_ADAPTERS[venue], symbols: () => ["BTCUSDT"],
      socket: factory, now: () => clock, settleFlushMs: 5,
      write: (symbol, candles, notAfterMs) => {
        wrote.push({ symbol, candles });
        const result = store.write(venue, symbol, candles, notAfterMs);
        collector.noteStoredCandles(symbol, candles, result.written, result.newlyFilled);
      },
    });
    try {
      r.start(); made[0].h.onOpen();
      for (const frame of nativeClosingFrames(venue, T0)) made[0].h.onMessage(frame);
      assert.equal(wrote.length, 0, "a venue close cannot bypass the local one-minute grace");
      assert.equal(r.status().closedCandles, 0, "deferred candles are not counted as stored");
      assert.equal(store.readWindow(venue, "BTCUSDT", T0, T0).rows.length, 0);
      clock += MIN;
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(wrote.length, 1, "the timer must store the close without another venue frame");
      assert.equal(wrote[0].candles.length, 1);
      assert.equal(wrote[0].candles[0].openMs, T0);
      assert.equal(store.readWindow(venue, "BTCUSDT", T0, T0 + MIN).rows.length, 1,
        "the next forming observation, if any, never reaches disk");
      assert.equal(r.status().closedCandles, 1);
      assert.equal(collector.restConfirmedMs("BTCUSDT"), null, "a deferred WS write still cannot establish REST provenance");
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.equal(wrote.length, 1, "later timer ticks never replay the flushed row");
    } finally {
      r.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

await test("native deferred closes stay bounded, survive reconnect and re-sharding, and discard removed symbols", async () => {
  const { factory, made } = fakeSockets();
  const wrote = [];
  let clock = T0 + MIN + 30_000;
  let symbols = ["BTCUSDT"];
  const r = new VenueStreamRunner({
    adapter: { ...STREAM_ADAPTERS.bybit, maxTopicsPerConnection: 1 },
    symbols: () => symbols, socket: factory, now: () => clock,
    settleFlushMs: 5, reconnectMs: 5, reconnectMaxMs: 5,
    write: (symbol, candles) => wrote.push({ symbol, candles }),
  });
  try {
    r.start(); made[0].h.onOpen();
    for (let i = 0; i < 7; i++) made[0].h.onMessage(nativeClosingFrames("bybit", T0 + i * MIN)[0]);
    made[0].h.onMessage(nativeClosingFrames("bybit", T0, "UNASSIGNEDUSDT")[0]);
    assert.equal(r.status().holding, 3, "only the three oldest complete rows of an assigned symbol are retained");
    const duplicate = JSON.parse(nativeClosingFrames("bybit", T0)[0]);
    duplicate.data[0].close = "1.75";
    made[0].h.onMessage(JSON.stringify(duplicate));
    assert.equal(r.status().holding, 3, "duplicate confirmations replace a row rather than growing the queue");
    made[0].h.onClose(1006);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.ok(made.length >= 2, "an ordinary reconnect occurred");
    symbols = ["AAAUSDT", "BTCUSDT"];
    r.resync();
    assert.equal(r.status().sockets, 2, "BTC moves to a different owner after re-sharding");
    clock += 10 * MIN;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(wrote.length, 1);
    assert.deepEqual(wrote[0].candles.map(c => c.openMs), [T0, T0 + MIN, T0 + 2 * MIN]);
    assert.equal(wrote[0].candles[0].close, 1.75);
    assert.equal(r.status().closedCandles, 3, "the replacement shard owns the flushed rows' counter");

    const btcSocket = made.at(-1);
    const nextClose = T0 + 10 * MIN;
    btcSocket.h.onMessage(nativeClosingFrames("bybit", nextClose)[0]);
    assert.equal(r.status().holding, 1);
    symbols = ["AAAUSDT"];
    r.resync();
    clock += MIN;
    btcSocket.h.onMessage(nativeClosingFrames("bybit", nextClose)[0]);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(wrote.length, 1, "removal and a retired callback cannot restore a discarded deferred row");

    const aaaSocket = made.at(-1);
    aaaSocket.h.onMessage(nativeClosingFrames("bybit", T0 + 11 * MIN, "AAAUSDT")[0]);
    assert.equal(r.status().holding, 1);
    r.stop();
    clock += MIN;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(wrote.length, 1, "stop cancels deferred work for native streams too");
  } finally { r.stop(); }
});

await test("WEEX shards its 100 documented channels, replies to ping, and stores only an advanced bar", () => {
  const { factory, made } = fakeSockets();
  const wrote = [];
  const symbols = ["BTCUSDT", ...Array.from({ length: 100 }, (_, i) => `S${i}USDT`)];
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.weex,
    symbols: () => symbols,
    write: (symbol, candles) => wrote.push({ symbol, candles }),
    socket: factory,
    now: () => T0 + 5 * MIN,
  });
  r.start();
  assert.equal(made.length, 2, "101 topics are split at WEEX's 100-channel ceiling");
  for (const s of made) s.h.onOpen();
  const firstSubscription = JSON.parse(made[0].sent[0]);
  assert.equal(firstSubscription.method, "SUBSCRIBE");
  assert.equal(firstSubscription.params.length, 100, "each chunk is subscribed in one operation");

  made[0].h.onMessage('{"event":"ping","time":"1788578130482"}');
  assert.deepEqual(JSON.parse(made[0].sent.at(-1)), { method: "PONG", id: 1 });
  made[0].h.onMessage(weexFrame(T0, 10));
  made[0].h.onMessage(weexFrame(T0, 11));
  assert.equal(wrote.length, 0, "same-minute updates are still forming");
  made[0].h.onMessage(weexFrame(T0 + MIN, 20));
  assert.equal(wrote.length, 1, "only the stream's advance publishes the earlier candle");
  assert.equal(wrote[0].candles[0].close, 11);
  made[0].h.onMessage(weexFrame(T0 + 2 * MIN, 30));
  assert.equal(wrote.length, 2, "a later incremental advance still writes immediately in its own frame");
  assert.equal(wrote[1].candles[0].close, 20);
  r.stop();
});

await test("a multi-row WEEX kline frame batches its closed rows and holds its forming tail", () => {
  const { factory, made } = fakeSockets();
  const wrote = [];
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.weex,
    symbols: () => ["BTCUSDT"],
    write: (symbol, candles, notAfterMs) => wrote.push({ symbol, candles, notAfterMs }),
    socket: factory,
    now: () => T0 + 400 * MIN,
  });
  r.start();
  made[0].h.onOpen();
  made[0].h.onMessage(weexSnapshot(T0, 301));
  assert.equal(wrote.length, 1, "one snapshot frame causes one durable write, not one per row");
  assert.equal(wrote[0].symbol, "BTCUSDT");
  assert.equal(wrote[0].candles.length, 300, "all 300 closed prefix rows survive batching");
  assert.equal(wrote[0].candles[0].openMs, T0, "the live oldest-first order is preserved");
  assert.equal(wrote[0].candles.at(-1).openMs, T0 + 299 * MIN);
  assert.equal(r.status().closedCandles, 300, "status still counts candles rather than write calls");
  assert.equal(r.status().holding, 1, "the current minute remains buffered as forming");

  made[0].h.onMessage(weexFrame(T0 + 301 * MIN, 999));
  assert.equal(wrote.length, 2, "the next incremental frame writes the held minute separately");
  assert.equal(wrote[1].candles.length, 1);
  assert.equal(wrote[1].candles[0].openMs, T0 + 300 * MIN);
  assert.equal(r.status().closedCandles, 301);
  assert.equal(r.status().holding, 1, "the newly forming incremental minute replaces it");
  r.stop();
});

await test("WEEX defers the newest closed snapshot row until locally settled, without losing delta continuity", async () => {
  const { factory, made } = fakeSockets();
  const wrote = [];
  let clock = T0 + 300 * MIN + 30_000;
  const realNow = Date.now;
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.weex, symbols: () => ["BTCUSDT"],
    write: (symbol, candles) => wrote.push({ symbol, candles }),
    socket: factory, now: () => clock, settleFlushMs: 10,
  });
  try {
    Date.now = () => clock;
    r.start(); made[0].h.onOpen();
    const snapshot = JSON.parse(weexSnapshot(T0, 301));
    snapshot.e = "klineSnapshot";
    snapshot.d.reverse();
    made[0].h.onMessage(JSON.stringify(snapshot));
    assert.equal(wrote.length, 1);
    assert.equal(wrote[0].candles.length, 299, "only rows through the N-2 settlement boundary write immediately");
    assert.equal(wrote[0].candles[0].openMs, T0);
    assert.equal(wrote[0].candles.at(-1).openMs, T0 + 298 * MIN);
    assert.equal(r.status().holding, 1, "only the deferred closed N-1 row is held; the snapshot's forming tail is discarded");

    // Replaying the same snapshot replaces the one deferred N-1 row by key;
    // it must not make two copies eligible when the timer reaches its boundary.
    made[0].h.onMessage(JSON.stringify(snapshot));
    made[0].h.onMessage(weexFrame(T0 + 300 * MIN, 311));
    assert.equal(r.status().holding, 2, "deferred N-1 and forming N remain distinct and neither is stored early");
    clock += MIN;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const nMinus1 = wrote.flatMap((batch) => batch.candles)
      .filter((candle) => candle.openMs === T0 + 299 * MIN);
    assert.equal(nMinus1.length, 1, "the deferred N-1 row flushes once when it becomes locally settled");
    assert.equal(r.status().holding, 1, "only forming N remains after the N-1 flush");

    made[0].h.onMessage(weexFrame(T0 + 301 * MIN, 312));
    assert.equal(r.status().holding, 2, "closed-but-unsettled N is deferred while N+1 forms");
    assert.equal(wrote.flatMap((batch) => batch.candles)
      .some((candle) => candle.openMs === T0 + 300 * MIN), false, "closed N remains deferred at the N-1 settled boundary");
    clock += MIN;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const n = wrote.flatMap((batch) => batch.candles)
      .filter((candle) => candle.openMs === T0 + 300 * MIN);
    assert.equal(n.length, 1, "N flushes on the following settlement boundary");
    assert.equal(r.status().holding, 1, "only the N+1 forming observation remains");
  } finally { Date.now = realNow; r.stop(); }
});

await test("WEEX clears deferred settlement rows when a symbol is removed or the runner stops", async () => {
  let clock = T0 + 10 * MIN + 30_000;
  const oneDeferred = () => JSON.stringify({
    e: "klineSnapshot", E: clock, s: "BTCUSDT", p: "LAST_PRICE",
    d: [{ t: T0 + 9 * MIN, T: T0 + 10 * MIN, s: "BTCUSDT", i: "1m", o: "1", h: "2", l: "0.5", c: "1.5", v: "3" }],
  });

  const removedSockets = fakeSockets();
  const removedWrites = [];
  let symbols = ["BTCUSDT"];
  const removed = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.weex, symbols: () => symbols,
    write: (_symbol, candles) => removedWrites.push(...candles),
    socket: removedSockets.factory, now: () => clock, settleFlushMs: 10,
  });
  removed.start(); removedSockets.made[0].h.onOpen();
  const retiredSocket = removedSockets.made[0];
  retiredSocket.h.onMessage(oneDeferred());
  assert.equal(removedWrites.length, 0, "N-1 starts deferred while only N-2 is settled");
  symbols = [];
  removed.resync();
  clock += MIN;
  retiredSocket.h.onMessage(oneDeferred());
  retiredSocket.h.onClose(1006);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(removedWrites.length, 0, "removal discards deferred state and ignores a retired socket's late frame");
  assert.equal(removedSockets.made.length, 1, "a retired socket's late close cannot schedule an orphan reconnect");
  removed.stop();

  clock = T0 + 20 * MIN + 30_000;
  const stoppedSockets = fakeSockets();
  const stoppedWrites = [];
  const stopped = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.weex, symbols: () => ["BTCUSDT"],
    write: (_symbol, candles) => stoppedWrites.push(...candles),
    socket: stoppedSockets.factory, now: () => clock, settleFlushMs: 10,
  });
  stopped.start(); stoppedSockets.made[0].h.onOpen();
  const deferredAtStop = JSON.stringify({
    e: "klineSnapshot", E: clock, s: "BTCUSDT", p: "LAST_PRICE",
    d: [{ t: T0 + 19 * MIN, T: T0 + 20 * MIN, s: "BTCUSDT", i: "1m", o: "1", h: "2", l: "0.5", c: "1.5", v: "3" }],
  });
  const stoppedSocket = stoppedSockets.made[0];
  stoppedSocket.h.onMessage(deferredAtStop);
  stopped.stop();
  clock += MIN;
  stoppedSocket.h.onMessage(deferredAtStop);
  stoppedSocket.h.onClose(1006);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(stoppedWrites.length, 0, "stop cancels the timer and clears all deferred rows");
  assert.equal(stoppedSockets.made.length, 1, "callbacks after stop cannot reopen the socket");
});

await test("WEEX retains a complete deferred candle across an ordinary reconnect", async () => {
  const { factory, made } = fakeSockets();
  const wrote = [];
  let clock = T0 + 10 * MIN + 30_000;
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.weex, symbols: () => ["BTCUSDT"],
    write: (_symbol, candles) => wrote.push(...candles),
    socket: factory, now: () => clock,
    settleFlushMs: 10, reconnectMs: 5, reconnectMaxMs: 5,
  });
  r.start(); made[0].h.onOpen();
  made[0].h.onMessage(JSON.stringify({
    e: "klineSnapshot", E: clock, s: "BTCUSDT", p: "LAST_PRICE",
    d: [{ t: T0 + 9 * MIN, T: T0 + 10 * MIN, s: "BTCUSDT", i: "1m", o: "1", h: "2", l: "0.5", c: "1.5", v: "3" }],
  }));
  assert.equal(wrote.length, 0, "the complete N-1 row is waiting only for local settlement");
  made[0].h.onClose(1006);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(made.length >= 2, "the ordinary reconnect opens a replacement socket");
  clock += MIN;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(wrote.length, 1, "the reconnect does not discard the already-complete deferred row");
  assert.equal(wrote[0].openMs, T0 + 9 * MIN);
  r.stop();
});

await test("a changed symbol set rebuilds; an unchanged one does not", () => {
  const { factory, made } = fakeSockets();
  let symbols = ["AAAUSDT"];
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.bitget, symbols: () => symbols, write: () => {}, socket: factory,
  });
  r.start();
  assert.equal(made.length, 1);
  r.resync();
  assert.equal(made.length, 1, "an identical set does not churn the socket");
  symbols = ["AAAUSDT", "BBBUSDT"];
  r.resync();
  assert.equal(made.length, 2, "a changed set rebuilds");
  r.stop();
});

await test("reconnect is bounded, jittered, and DROPS the held forming bar", async () => {
  const { factory, made } = fakeSockets();
  const wrote = [];
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.bitget,
    symbols: () => ["BTCUSDT"],
    write: (symbol, candles) => wrote.push({ symbol, candles }),
    socket: factory,
    reconnectMs: 10,
    reconnectMaxMs: 40,
  });
  r.start();
  made[0].h.onOpen();
  // A minute is held, unpublished, when the socket dies.
  made[0].h.onMessage(bitgetFrame(T0, 10));
  assert.equal(r.status().holding, 1, "the forming bar is held");
  made[0].h.onClose(1006);
  assert.equal(r.status().holding, 0, "the held bar is DROPPED across a reconnect");

  await new Promise((res) => setTimeout(res, 120));
  assert.ok(made.length >= 2, "it reconnected");
  made[made.length - 1].h.onOpen();

  // …and the dropped minute is NOT resurrected by the next frame. Publishing a
  // bar assembled from a fraction of its trades is worse than the gap the REST
  // tail will repair.
  made[made.length - 1].h.onMessage(bitgetFrame(T0 + MIN, 20));
  assert.equal(wrote.length, 0, "the pre-gap minute is never written");
  r.stop();
});

await test("nothing a venue or a store can do throws out of the runner", () => {
  const { factory, made } = fakeSockets();
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.bitget,
    symbols: () => ["BTCUSDT"],
    // A store that always fails — a full disk, a bad path.
    write: () => { throw new Error("disk on fire"); },
    socket: factory,
  });
  r.start();
  made[0].h.onOpen();
  assert.doesNotThrow(() => {
    made[0].h.onMessage("not json");
    made[0].h.onMessage("");
    made[0].h.onMessage(JSON.stringify({ action: "update", arg: {}, data: [] }));
    made[0].h.onError(new Error("socket exploded"));
    made[0].h.onMessage(bitgetFrame(T0, 10));
    made[0].h.onMessage(bitgetFrame(T0 + MIN, 20)); // triggers the failing write
  }, "a failing store and a garbage frame are both survivable");
  r.stop();
});

await test("a socket factory that throws does not take the process with it", () => {
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.bitunix,
    symbols: () => ["BTCUSDT"],
    write: () => {},
    socket: () => { throw new Error("no network"); },
    reconnectMs: 10_000, // long, so the retry does not fire during the test
  });
  assert.doesNotThrow(() => r.start(), "an unopenable socket is a log line, not a crash");
  assert.equal(r.status().open, 0);
  r.stop();
});

await test("an empty roster opens no sockets at all", () => {
  const { factory, made } = fakeSockets();
  const r = new VenueStreamRunner({
    adapter: STREAM_ADAPTERS.bybit, symbols: () => [], write: () => {}, socket: factory,
  });
  r.start();
  assert.equal(made.length, 0, "nothing to stream, nothing opened");
  assert.equal(r.status().sockets, 0);
  r.stop();
});

// ── the wiring: WEEX starts with an enabled collector; others remain opt-in ─
await test("WEEX streams with an enabled collector unless explicitly disabled, and never exceeds it", async () => {
  const { configFromEnv } = await import("../dist/src/config.js");
  const base = { HUB_CANDLE_VENUES: "bitget,bitunix" };

  const off = configFromEnv({ ...base });
  assert.deepEqual(off.candleStreamVenues ?? [], ["weex"], "the auto-added WEEX collector starts its verified stream");

  const on = configFromEnv({ ...base, HUB_CANDLE_STREAM: "bitget" });
  assert.deepEqual(on.candleStreamVenues, ["bitget", "weex"], "existing venue selection is preserved");

  const optedOut = configFromEnv({ ...base, HUB_CANDLE_STREAM: "bitget,-weex" });
  assert.deepEqual(optedOut.candleStreamVenues, ["bitget"], "operators can explicitly keep WEEX REST-only");

  // Junk and unknown venues are dropped rather than opening a socket at a url
  // that does not exist.
  const junk = configFromEnv({ ...base, HUB_CANDLE_STREAM: "bitget, nonsense ,,BITUNIX" });
  assert.deepEqual(junk.candleStreamVenues, ["bitget", "bitunix", "weex"], "trimmed, lowercased, filtered");

  // A venue named for streaming that is NOT collecting must not open sockets:
  // the server intersects the two lists, so this is asserted on the same
  // expression the server uses rather than on the parse alone.
  const wide = configFromEnv({ HUB_CANDLE_VENUES: "bitget", HUB_CANDLE_STREAM: "bitget,bitunix" });
  const effective = wide.candleStreamVenues.filter((v) => wide.candleVenues.includes(v));
  assert.deepEqual(effective, ["bitget", "weex"], "a stream venue that is not collecting is dropped");
});

summary("stream-runner");
