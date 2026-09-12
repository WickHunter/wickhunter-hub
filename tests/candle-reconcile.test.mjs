// tests/candle-reconcile.test.mjs — v0.4.31: a WS-folded candle is never
// served until this collector's OWN REST fetch has looked at the same minute
// and, if it disagrees, corrected it.
//
// The reproduction below is the operator's own field report, verbatim:
// NBISUSDT on WEEX, 2026-09-11 — the websocket's ClosureBuffer closed the
// 23:23:00 UTC minute by ORDERING (the venue's kline stream states no closure
// of its own; see stream.ts) with a trade still settling into the venue's book
// a moment later, so the bar's OWN o/h/l/c matched exactly and its volume read
// 0.65 against REST `historyKlines`'s 0.71 for the identical minute — served
// to a bot as part of a signed seed, and rejected by the bot's own live
// cross-check ("HUB SEED REJECTED — candle … disagrees with the venue").
import assert from "node:assert/strict";
import { test, summary, tmpDir } from "./helpers.mjs";
import { VenueCollector, DEFAULT_COLLECTOR_OPTIONS } from "../dist/src/candles/collector.js";
import { CandleStore, MINUTE_MS, settledOpenMs } from "../dist/src/candles/store.js";
import { buildSeed } from "../dist/src/candles/seed.js";

// Minute-aligned, otherwise arbitrary.
const NOW = 1_800_000_000_000;
assert.equal(NOW % MINUTE_MS, 0, "precondition: NOW is minute-aligned");

function response(body) {
  return { ok: true, status: 200, json: async () => body };
}

/** WEEX wire row: [openMs, o, h, l, c, v]. Strings, as the venue sends them. */
function weexRow(openMs, o, h, l, c, v) {
  return [String(openMs), String(o), String(h), String(l), String(c), String(v)];
}

/** One collector + fake WEEX fetchLike, tracking exactly one symbol. Fails the
 *  test outright if a reconcile ever reaches the CURRENT-page endpoint: the
 *  venue's settled book of record is `historyKlines`, never `klines`, and a
 *  reconcile that read the still-updating current page would just repeat the
 *  same class of drift it exists to correct. */
function fixture(overrides = {}) {
  const store = new CandleStore(tmpDir("reconcile-store"));
  const historyCalls = [];
  const recentCalls = [];
  let historyRows = [];
  let recentRows = [];
  const fetchLike = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/exchangeInfo")) {
      return response({ symbols: [
        { symbol: "NBISUSDT", quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", forwardContractFlag: true },
      ] });
    }
    if (u.pathname.endsWith("/apiTradingSymbols")) return response(["NBISUSDT"]);
    if (u.pathname.endsWith("/historyKlines")) { historyCalls.push(u); return response(historyRows); }
    // The current-page endpoint: never used by a reconcile (see below), but a
    // real cold "nothing at all yet" tail item legitimately reaches it — it
    // is tracked, not refused, so the reconcile-specific tests can assert
    // `recentCalls.length === 0` rather than relying on an exception.
    if (u.pathname.endsWith("/klines")) { recentCalls.push(u); return response(recentRows); }
    throw new Error(`unexpected URL ${url}`);
  };
  const collector = new VenueCollector("weex", store, tmpDir("reconcile-state"), {
    ...DEFAULT_COLLECTOR_OPTIONS,
    requestsPerSecond: 100,
    minRequestsPerSecond: 0.1,
    reconcileWsGapMinutes: overrides.reconcileWsGapMinutes ?? 10,
  }, NOW);
  return {
    store, collector, fetchLike, historyCalls, recentCalls,
    setHistory(rows) { historyRows = rows; },
    setRecent(rows) { recentRows = rows; },
  };
}

/** Same wiring `CandleService.seed()` uses in production — a collector present
 *  answers `restConfirmedMs(symbol) ?? -Infinity`. */
function seedDepsFor(f, sign = (b) => b) {
  return {
    store: f.store,
    keyId: "seed-1",
    sign,
    symbolKnown: () => true,
    restConfirmedMs: (_venue, symbol) => f.collector.restConfirmedMs(symbol) ?? -Infinity,
  };
}

await test("a websocket write is never served before this collector's own REST fetch has looked at it", async () => {
  const f = fixture();
  await f.collector.refreshSymbols(f.fetchLike, NOW);

  const wsOpenMs = NOW - 5 * MINUTE_MS;
  const wsCandle = { openMs: wsOpenMs, open: 224.73, high: 224.75, low: 224.66, close: 224.66, volume: 0.65 };
  const w = f.store.write("weex", "NBISUSDT", [wsCandle], settledOpenMs(NOW));
  assert.equal(w.written, 1, "precondition: the websocket row reached the store");
  f.collector.noteStoredCandles("NBISUSDT", [wsCandle], w.written, w.newlyFilled);

  // Invariant: BEFORE any REST fetch has looked at this minute, it is not
  // servable at all — never served at the websocket's own (possibly short)
  // value.
  const before = buildSeed(
    { venue: "weex", symbol: "NBISUSDT", fromMs: wsOpenMs, toMs: wsOpenMs },
    seedDepsFor(f),
  );
  assert.equal(before.ok, false, "an unconfirmed websocket-only minute is refused, not served");
  assert.equal(before.code, 503);
  assert.match(before.error, /not yet REST-confirmed/);

  // The venue's REST book disagrees on volume only — o/h/l/c match exactly,
  // which is exactly the operator's reproduction.
  f.setHistory([weexRow(wsOpenMs, 224.73, 224.75, 224.66, 224.66, 0.71)]);
  const result = await f.collector.tick(f.fetchLike, 5, NOW, { sleep: async () => {} });

  assert.equal(result.corrected, 1, "tick() reports the one row whose value it corrected");
  const reconcileCall = f.historyCalls.find((u) =>
    Number(u.searchParams.get("startTime")) === wsOpenMs && Number(u.searchParams.get("endTime")) === wsOpenMs);
  assert.ok(reconcileCall, "a request spanning exactly the unconfirmed minute was made");
  assert.equal(f.recentCalls.length, 0, "a reconcile never reads the venue's current/forming page");

  const { rows } = f.store.readWindow("weex", "NBISUSDT", wsOpenMs, wsOpenMs);
  assert.deepEqual(rows, [[wsOpenMs, 224.73, 224.75, 224.66, 224.66, 0.71]],
    "the store holds the venue's REST figure — never the websocket's 0.65");

  const after = buildSeed(
    { venue: "weex", symbol: "NBISUSDT", fromMs: wsOpenMs, toMs: wsOpenMs },
    seedDepsFor(f),
  );
  assert.equal(after.ok, true, "the now-confirmed minute is servable");
  assert.equal(after.payload.lastClosedMs, wsOpenMs);
  assert.deepEqual(after.payload.rows, [[wsOpenMs, 224.73, 224.75, 224.66, 224.66, 0.71]],
    "served at 0.71, never at the websocket's 0.65");
});

await test("the served lastClosedMs never names a minute only the websocket has seen", async () => {
  const f = fixture();
  await f.collector.refreshSymbols(f.fetchLike, NOW);

  // A run of websocket-only minutes, none of them reconciled yet.
  const base = NOW - 20 * MINUTE_MS;
  const wsCandles = Array.from({ length: 5 }, (_, i) => ({
    openMs: base + i * MINUTE_MS, open: 10, high: 10, low: 10, close: 10, volume: 1,
  }));
  const w = f.store.write("weex", "NBISUSDT", wsCandles, settledOpenMs(NOW));
  f.collector.noteStoredCandles("NBISUSDT", wsCandles, w.written, w.newlyFilled);
  assert.equal(f.store.coverage("weex", "NBISUSDT").lastClosedMs, base + 4 * MINUTE_MS,
    "precondition: the store's own newest slot is the newest WS write");

  const out = buildSeed(
    { venue: "weex", symbol: "NBISUSDT", fromMs: base, toMs: base + 4 * MINUTE_MS },
    seedDepsFor(f),
  );
  // Nothing has been REST-confirmed yet, so nothing is servable — the seed
  // must not name ANY of these five minutes as its lastClosedMs.
  assert.equal(out.ok, false, "no websocket-only minute may be reported as the seed's reach");
  assert.equal(out.code, 503);

  // REST confirms only the first two minutes this pass (a bounded reconcile,
  // matching `reconcileWsGapMinutes`/`RECONCILE_MAX_SPAN_MINUTES`).
  f.setHistory([
    weexRow(base, 10, 10, 10, 10, 1),
    weexRow(base + MINUTE_MS, 10, 10, 10, 10, 1),
  ]);
  // A tiny gap threshold so two minutes of websocket-only data are already due.
  const f2 = fixture({ reconcileWsGapMinutes: 1 });
  await f2.collector.refreshSymbols(f2.fetchLike, NOW);
  const w2 = f2.store.write("weex", "NBISUSDT", wsCandles.slice(0, 2), settledOpenMs(NOW));
  f2.collector.noteStoredCandles("NBISUSDT", wsCandles.slice(0, 2), w2.written, w2.newlyFilled);
  f2.setHistory([
    weexRow(base, 10, 10, 10, 10, 1),
    weexRow(base + MINUTE_MS, 10, 10, 10, 10, 1),
  ]);
  await f2.collector.tick(f2.fetchLike, 5, NOW, { sleep: async () => {} });

  const confirmed = buildSeed(
    { venue: "weex", symbol: "NBISUSDT", fromMs: base, toMs: base + MINUTE_MS },
    seedDepsFor(f2),
  );
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.payload.lastClosedMs, base + MINUTE_MS,
    "the seed reaches exactly as far as REST has confirmed — no further");
});

await test("a symbol no websocket has ever touched never queues a reconcile request", async () => {
  const f = fixture();
  await f.collector.refreshSymbols(f.fetchLike, NOW);
  // Ordinary REST-only cold start: WEEX's own "nothing at all yet" tail
  // branch prefers `fetchRecentKlines` (the current-page endpoint) when it is
  // available — an existing behaviour this feature must not disturb.
  const openMs = NOW - 3 * MINUTE_MS;
  f.setRecent([weexRow(openMs, 1, 1, 1, 1, 1)]);
  const first = await f.collector.tick(f.fetchLike, 5, NOW, { sleep: async () => {} });
  assert.equal(first.corrected, 0, "an ordinary REST write is never counted as a correction");
  assert.equal(f.collector.restConfirmedMs("NBISUSDT"), openMs,
    "REST-only coverage keeps the confirmed frontier in lockstep automatically");

  // A second, otherwise-idle tick must not re-request the same settled minute
  // "to reconcile" it — nothing here was ever written by a websocket.
  f.historyCalls.length = 0;
  f.recentCalls.length = 0;
  f.setHistory([]);
  f.setRecent([]);
  const second = await f.collector.tick(f.fetchLike, 5, NOW + MINUTE_MS, { sleep: async () => {} });
  assert.equal(second.corrected, 0);
});

summary("candle-reconcile");
