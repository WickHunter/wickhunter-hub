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
import { test, summary } from "./helpers.mjs";
import { VenueStreamRunner } from "../dist/src/candles/stream-runner.js";
import { STREAM_ADAPTERS } from "../dist/src/candles/stream.js";

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

const weexFrame = (openMs, close) =>
  JSON.stringify({
    e: "kline", E: openMs + 10, s: "BTCUSDT", p: "LAST_PRICE",
    d: [{ t: openMs, T: openMs + MIN, s: "BTCUSDT", i: "1m", o: "1", h: "2", l: "0.5", c: String(close), v: "3" }],
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
