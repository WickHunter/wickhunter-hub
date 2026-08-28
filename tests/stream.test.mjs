// tests/stream.test.mjs — the websocket tail.
//
// EVERY BITGET AND BITUNIX FRAME BELOW WAS CAPTURED LIVE from the real public
// endpoints while this module was written, not transcribed from documentation.
// The Bybit frame is from its v5 contract and the working client in the bot
// repo: this build environment is geo-blocked from Bybit (CloudFront refuses by
// country) and could not probe it, which is stated here rather than left for
// someone to discover when a field name turns out wrong.
//
// What these pin, in order of how badly each would hurt:
//
//  1. THE CLOSURE RULE. Bitget and Bitunix never mark a candle closed, so a
//     minute is published only once the venue sends a LATER minute. Get this
//     wrong and the hub stores forming bars as final — a wrong candle, which
//     this repo's own header calls worse than a missing one because the missing
//     one shows up as a gap.
//  2. BITUNIX HAS NO CANDLE OPEN TIME. Only a message `ts`. The minute is
//     derived, and that derivation is the one place a stored candle's bucket
//     comes from a clock reading rather than from the venue stating it.
//  3. A frame that cannot be parsed is NEVER an error. A venue adding a field
//     must not stop the tail.
import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import { STREAM_ADAPTERS, ClosureBuffer, openMsFromTs } from "../dist/src/candles/stream.js";
import { VENUE_IDS } from "../dist/src/candles/venues.js";

const MIN = 60_000;

// ── captured live, 2026-08-13 ───────────────────────────────────────────────
const BITGET_UPDATE = '{"action":"update","arg":{"instType":"USDT-FUTURES","channel":"candle1m","instId":"BTCUSDT"},"data":[["1786650720000","63415.3","63415.4","63415.2","63415.2","0.2824","17908.4799","17908.4799"]],"ts":1786650728706}';
const BITGET_ACK = '{"event":"subscribe","arg":{"instType":"USDT-FUTURES","channel":"candle1m","instId":"BTCUSDT"}}';
const BITUNIX_TICK = '{"ch":"market_kline_1min","symbol":"BTCUSDT","ts":1786650732204,"data":{"o":"63404.6","c":"63404.7","h":"63404.8","l":"63404.5","b":"0.2413","q":"15299.54977"}}';
const BITUNIX_ACK = '{"op":"connect","data":{"result":true}}';
const BYBIT_FORMING = '{"topic":"kline.1.BTCUSDT","data":[{"start":1786650720000,"open":"63415.3","high":"63415.4","low":"63415.2","close":"63415.2","volume":"0.28","confirm":false}]}';
const BYBIT_CLOSED = '{"topic":"kline.1.BTCUSDT","data":[{"start":1786650720000,"open":"63415.3","high":"63415.4","low":"63415.2","close":"63415.2","volume":"0.28","confirm":true}]}';

await test("bitget: a real update frame parses, and is NOT claimed closed", () => {
  const [t] = STREAM_ADAPTERS.bitget.parse(BITGET_UPDATE);
  assert.ok(t, "the captured frame parsed");
  assert.equal(t.symbol, "BTCUSDT");
  assert.equal(t.openMs, 1786650720000);
  assert.equal(t.candle.open, 63415.3);
  assert.equal(t.candle.high, 63415.4);
  assert.equal(t.candle.low, 63415.2);
  assert.equal(t.candle.close, 63415.2);
  // Row index 5 is BASE volume; 6 and 7 are quote volume repeated. Picking the
  // wrong one stores a number ~63,000x too large and nothing would flag it.
  assert.equal(t.candle.volume, 0.2824);
  assert.equal(t.closed, false, "bitget never states closure");
});

await test("bitunix: the minute is DERIVED from the message clock", () => {
  const [t] = STREAM_ADAPTERS.bitunix.parse(BITUNIX_TICK);
  assert.ok(t, "the captured frame parsed");
  assert.equal(t.symbol, "BTCUSDT");
  // ts 1786650732204 sits inside the minute opening at 1786650720000.
  assert.equal(t.openMs, 1786650720000);
  assert.equal(t.openMs, openMsFromTs(1786650732204));
  assert.equal(t.candle.volume, 0.2413, "`b` is base volume, not `q`");
  assert.equal(t.closed, false, "bitunix never states closure");
});

await test("bybit: `confirm` is its authoritative closure statement", () => {
  const [forming] = STREAM_ADAPTERS.bybit.parse(BYBIT_FORMING);
  const [closed] = STREAM_ADAPTERS.bybit.parse(BYBIT_CLOSED);
  assert.equal(forming.closed, false);
  assert.equal(closed.closed, true);
  assert.equal(closed.openMs, 1786650720000);
});

await test("acks, heartbeats and junk are ignored, never fatal", () => {
  for (const [venue, frames] of [
    ["bitget", [BITGET_ACK, "pong", "not json", "{}", '{"action":"update","arg":{},"data":[]}']],
    ["bitunix", [BITUNIX_ACK, "", "{", '{"ch":"other","symbol":"X"}']],
    ["bybit", ['{"op":"pong"}', '{"topic":"tickers.BTCUSDT","data":{}}', "garbage"]],
  ]) {
    for (const f of frames) {
      const got = STREAM_ADAPTERS[venue].parse(f);
      assert.ok(Array.isArray(got) && got.length === 0, `${venue} ignored: ${f.slice(0, 30)}`);
    }
  }
});

await test("a malformed row is dropped, not stored as NaN", () => {
  const bad = '{"action":"update","arg":{"instId":"BTCUSDT"},"data":[["1786650720000","x","y","z","w","v"]]}';
  assert.equal(STREAM_ADAPTERS.bitget.parse(bad).length, 0);
  // …and an off-grid minute, which would corrupt the day file's indexing.
  const offGrid = '{"action":"update","arg":{"instId":"BTCUSDT"},"data":[["1786650720123","1","2","0.5","1.5","3"]]}';
  assert.equal(STREAM_ADAPTERS.bitget.parse(offGrid).length, 0);
  // …and high < low, which no real bar can be.
  const inverted = '{"action":"update","arg":{"instId":"BTCUSDT"},"data":[["1786650720000","1","0.5","2","1.5","3"]]}';
  assert.equal(STREAM_ADAPTERS.bitget.parse(inverted).length, 0);
});

await test("THE CLOSURE RULE: a minute publishes only when the venue moves past it", () => {
  const buf = new ClosureBuffer();
  const tick = (openMs, close, closed = false) => ({
    symbol: "BTCUSDT", openMs, closed,
    candle: { openMs, open: 1, high: 2, low: 0.5, close, volume: 1 },
  });
  const t0 = 1786650720000;

  // The bar forms. Nothing may be published — it is not finished.
  assert.equal(buf.push(tick(t0, 10)), null, "first observation is held");
  assert.equal(buf.push(tick(t0, 11)), null, "an update to the same minute is held");
  assert.equal(buf.push(tick(t0, 12)), null);

  // The venue moves to the next minute. THAT is what closes the previous one,
  // and the published bar must carry the LAST values seen, not the first.
  const out = buf.push(tick(t0 + MIN, 20));
  assert.ok(out, "the previous minute is published");
  assert.equal(out.openMs, t0);
  assert.equal(out.candle.close, 12, "the LAST observation of that minute wins");

  // The new minute is now the held one, and is itself unpublished.
  assert.equal(buf.size(), 1);
});

await test("a reordered or stale tick can never reopen a published minute", () => {
  const buf = new ClosureBuffer();
  const tick = (openMs, close) => ({
    symbol: "BTCUSDT", openMs, closed: false,
    candle: { openMs, open: 1, high: 2, low: 0.5, close, volume: 1 },
  });
  const t0 = 1786650720000;
  buf.push(tick(t0, 10));
  assert.ok(buf.push(tick(t0 + MIN, 20)), "t0 published");
  // A late frame for t0 arrives after a reconnect. Publishing it again would
  // let a PARTIAL bar overwrite a complete one in the store.
  assert.equal(buf.push(tick(t0, 99)), null, "the stale minute is dropped");
  assert.equal(buf.push(tick(t0 - MIN, 99)), null, "and so is an older one");
});

await test("a venue that STATES closure short-circuits the ordering rule", () => {
  const buf = new ClosureBuffer();
  const t0 = 1786650720000;
  const forming = { symbol: "BTCUSDT", openMs: t0, closed: false, candle: { openMs: t0, open: 1, high: 2, low: 0.5, close: 5, volume: 1 } };
  const confirmed = { symbol: "BTCUSDT", openMs: t0, closed: true, candle: { openMs: t0, open: 1, high: 2, low: 0.5, close: 7, volume: 1 } };
  assert.equal(buf.push(forming), null);
  const out = buf.push(confirmed);
  assert.ok(out, "a confirmed bar publishes at once — no need to wait for the next minute");
  assert.equal(out.candle.close, 7, "and the CONFIRMED values supersede the forming ones");
  assert.equal(buf.size(), 0, "nothing is left held for that symbol");
});

await test("symbols do not interfere with each other", () => {
  const buf = new ClosureBuffer();
  const t0 = 1786650720000;
  const mk = (symbol, openMs) => ({ symbol, openMs, closed: false, candle: { openMs, open: 1, high: 2, low: 0.5, close: 1, volume: 1 } });
  buf.push(mk("AAAUSDT", t0));
  buf.push(mk("BBBUSDT", t0));
  assert.equal(buf.size(), 2);
  // Advancing one must publish only that one.
  const out = buf.push(mk("AAAUSDT", t0 + MIN));
  assert.equal(out.symbol, "AAAUSDT");
  assert.equal(buf.size(), 2, "BBBUSDT is still holding its own minute");
});

await test("every venue states a topic cap and a reachable url", () => {
  // Iterated over VENUE_IDS, not a typed-out list: a venue added to the
  // registry with no stream adapter is a `streams.set(v, undefined)` and a
  // socket runner reading fields off nothing, at the first tick after an
  // operator names it in HUB_CANDLE_STREAM. A hardcoded list here would have
  // been edited to add the venue and would never have asked the question.
  for (const v of VENUE_IDS) {
    const a = STREAM_ADAPTERS[v];
    assert.ok(a, `${v} has a stream adapter`);
    assert.equal(a.id, v);
    assert.ok(/^wss:\/\//.test(a.url), `${v} url is a websocket`);
    assert.ok(a.maxTopicsPerConnection > 0, `${v} states a topic cap`);
    const frames = a.subscribeFrames(["BTCUSDT", "ETHUSDT"]);
    assert.ok(Array.isArray(frames) && frames.length > 0, `${v} builds a subscribe frame`);
    // Case-insensitively: Aster's stream names must be lowercase, which is the
    // venue's own rule and the one place a subscription is not spelled the way
    // the store spells the symbol.
    assert.match(JSON.stringify(frames).toUpperCase(), /BTCUSDT/, `${v} names the symbol`);
  }
});

summary("stream");
