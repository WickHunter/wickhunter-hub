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
import fs from "node:fs";
import path from "node:path";
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
  const stateDir = tmpDir("reconcile-state");
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
  const collector = new VenueCollector("weex", store, stateDir, {
    ...DEFAULT_COLLECTOR_OPTIONS,
    requestsPerSecond: 100,
    minRequestsPerSecond: 0.1,
    reconcileWsGapMinutes: overrides.reconcileWsGapMinutes ?? 10,
  }, NOW);
  return {
    store, collector, stateDir, fetchLike, historyCalls, recentCalls,
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

await test("a restart never grandfathers a websocket-only row, and the next REST pass recovers it", async () => {
  const f = fixture({ reconcileWsGapMinutes: 1 });
  await f.collector.refreshSymbols(f.fetchLike, NOW);

  const wsOpenMs = NOW - 5 * MINUTE_MS;
  const wsCandle = { openMs: wsOpenMs, open: 224.73, high: 224.75, low: 224.66, close: 224.66, volume: 0.65 };
  const w = f.store.write("weex", "NBISUSDT", [wsCandle], settledOpenMs(NOW));
  f.collector.noteStoredCandles("NBISUSDT", [wsCandle], w.written, w.newlyFilled);

  // A new process must trust only the durable REST frontier. The old
  // shallow-store grandfathering treated this websocket-only row as confirmed.
  const restarted = new VenueCollector("weex", f.store, f.stateDir, {
    ...DEFAULT_COLLECTOR_OPTIONS,
    requestsPerSecond: 100,
    minRequestsPerSecond: 0.1,
    reconcileWsGapMinutes: 1,
  }, NOW);
  assert.equal(restarted.restConfirmedMs("NBISUSDT"), null,
    "a websocket-only disk row is not REST-confirmed after restart");
  const before = buildSeed(
    { venue: "weex", symbol: "NBISUSDT", fromMs: wsOpenMs, toMs: wsOpenMs },
    seedDepsFor({ ...f, collector: restarted }),
  );
  assert.equal(before.ok, false, "the restart still refuses the unconfirmed row instead of serving it");

  f.setHistory([weexRow(wsOpenMs, 224.73, 224.75, 224.66, 224.66, 0.71)]);
  const result = await restarted.tick(f.fetchLike, 5, NOW, { sleep: async () => {} });
  assert.equal(result.corrected, 1, "restart queues the unconfirmed row for REST reconciliation");
  assert.equal(restarted.restConfirmedMs("NBISUSDT"), wsOpenMs,
    "the REST frontier advances only after the recovery fetch");

  const checked = new VenueCollector("weex", f.store, f.stateDir, {
    ...DEFAULT_COLLECTOR_OPTIONS,
    requestsPerSecond: 100,
    minRequestsPerSecond: 0.1,
  }, NOW);
  assert.equal(checked.restConfirmedMs("NBISUSDT"), wsOpenMs,
    "a REST-confirmed frontier survives a later restart");
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


// Scheduling needs the real collector/venue adapters, but not gigabytes of
// repeated day-file rewrites. This exact in-memory candle store keeps the two
// production-sized rosters bounded; REST frontier persistence remains real.
function fairnessFixture(venue, count, opts = {}) {
  const symbols = Array.from({ length: count }, (_, i) => `PAIR${String(i).padStart(4, "0")}USDT`);
  const held = new Map();
  const store = {
    write(_venue, symbol, candles, notAfterMs = Infinity) {
      const rows = held.get(symbol) ?? new Map(); held.set(symbol, rows);
      let written = 0, newlyFilled = 0;
      for (const c of candles) {
        if (c.openMs > notAfterMs) continue;
        if (!rows.has(c.openMs)) newlyFilled++;
        rows.set(c.openMs, { ...c }); written++;
      }
      return { written, newlyFilled };
    },
    coverage(_venue, symbol) {
      const times = [...(held.get(symbol)?.keys() ?? [])].sort((a, b) => a - b);
      const firstClosedMs = times[0] ?? null, lastClosedMs = times.at(-1) ?? null;
      return { firstClosedMs, lastClosedMs, count: times.length,
        interiorMissing: times.length ? (lastClosedMs - firstClosedMs) / MINUTE_MS + 1 - times.length : 0 };
    },
    readWindow(_venue, symbol, from, to) {
      const rows = [], gaps = []; let gap = null;
      for (let t = from; t <= to; t += MINUTE_MS) {
        const c = held.get(symbol)?.get(t);
        if (c) {
          if (gap !== null) { gaps.push([gap, t - MINUTE_MS]); gap = null; }
          rows.push([t, c.open, c.high, c.low, c.close, c.volume]);
        } else if (gap === null) gap = t;
      }
      if (gap !== null) gaps.push([gap, to]);
      return { rows, gaps };
    },
  };
  const state = { now: NOW, listed: [...symbols], calls: [], refuse: new Map() };
  const stateDir = tmpDir("reconcile-fairness");
  const collector = new VenueCollector(venue, store, stateDir, {
    ...DEFAULT_COLLECTOR_OPTIONS, symbolRefreshMs: 1_000 * MINUTE_MS,
    requestsPerSecond: venue === "weex" ? 1 / 12 : 10,
    minRequestsPerSecond: venue === "weex" ? 1 / 12 : 0.5,
    ...opts,
  }, NOW);
  const fetchLike = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/contracts")) return response({ code: "00000", data: state.listed.map(symbol => ({ symbol, symbolStatus: "normal" })) });
    if (u.pathname.endsWith("/exchangeInfo")) return response({ symbols: state.listed.map(symbol => ({
      symbol, quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", forwardContractFlag: true,
    })) });
    if (u.pathname.endsWith("/apiTradingSymbols")) return response(state.listed);
    assert.ok(u.pathname.endsWith("/history-candles") || u.pathname.endsWith("/historyKlines"), "reconcile uses history only");
    const symbol = u.searchParams.get("symbol");
    state.calls.push(symbol);
    const refused = state.refuse.get(symbol);
    if (refused === "error") throw new Error("fixture request failure");
    if (refused === "429") return { ok: false, status: 429, json: async () => ({}), headers: { get: () => null } };
    const rows = refused === "empty" ? [] : store.readWindow(venue, symbol, Number(u.searchParams.get("startTime")), Number(u.searchParams.get("endTime"))).rows;
    return response(venue === "bitget" ? { code: "00000", data: rows } : rows);
  };
  const put = (symbol, t) => {
    const candles = [{ openMs: t, open: 100, high: 101, low: 99, close: 100, volume: 1 }];
    const w = store.write(venue, symbol, candles);
    collector.noteStoredCandles(symbol, candles, w.written, w.newlyFilled);
  };
  const tick = async (budget, now = state.now, deadlineMs = Infinity) => {
    state.now = now;
    return collector.tick(fetchLike, budget, now, {
      clock: () => state.now, sleep: async ms => { state.now += ms; }, deadlineMs,
    });
  };
  return { symbols, store, collector, state, stateDir, fetchLike, put, tick };
}

for (const [venue, count, budget] of [["bitget", 783, 100], ["weex", 239, 5]]) {
  await test(`${venue}: ${count} continuously advancing symbols share reconciliation before any repeat`, async () => {
    const f = fairnessFixture(venue, count);
    await f.collector.refreshSymbols(f.fetchLike, NOW);
    for (const symbol of f.symbols) {
      for (let t = NOW - 6 * MINUTE_MS; t <= settledOpenMs(NOW); t += MINUTE_MS) f.put(symbol, t);
    }
    assert.equal(f.collector.restConfirmedMs(f.symbols[0]), null, "WS history is not REST evidence");
    const ticks = Math.ceil(count / budget) + 1;
    for (let i = 0; i < ticks; i++) {
      const now = NOW + i * MINUTE_MS;
      if (i > 0) for (const symbol of f.symbols) f.put(symbol, settledOpenMs(now));
      const result = await f.tick(budget, now);
      assert.ok(result.requests <= budget, "the existing request budget is never exceeded");
    }
    assert.equal(new Set(f.state.calls.slice(0, count)).size, count,
      "every initially due symbol gets a turn before already checked symbols recur");
    assert.deepEqual(f.state.calls.slice(0, count), f.symbols, "turns follow the stable roster, not the shrinking due list");
    for (const symbol of f.symbols) assert.notEqual(f.collector.restConfirmedMs(symbol), null, `${symbol} received real REST evidence`);
    assert.ok(f.state.calls.filter(s => s === f.symbols[0]).length >= 2, "the first roster symbol is revisited after a full sweep");
    const persisted = JSON.parse(fs.readFileSync(path.join(f.stateDir, venue, "rest-frontier.json"), "utf8"));
    assert.equal(Object.keys(persisted.restConfirmed).length, count, "frontiers are persisted only after each successful response");
  });
}

await test("reconciliation resumes after the last attempted symbol through roster changes and zero-work ticks", async () => {
  const f = fairnessFixture("bitget", 5, { reconcileWsGapMinutes: 1 });
  await f.collector.refreshSymbols(f.fetchLike, NOW);
  for (const symbol of f.symbols) f.put(symbol, settledOpenMs(NOW));
  await f.tick(2, NOW);
  assert.deepEqual(f.state.calls, f.symbols.slice(0, 2));
  // The anchor remains in the tracked roster, even after it stops trading.
  f.state.listed = f.symbols.filter(s => s !== f.symbols[1]);
  await f.collector.refreshSymbols(f.fetchLike, NOW + MINUTE_MS);
  for (const symbol of f.state.listed) f.put(symbol, settledOpenMs(NOW + MINUTE_MS));
  const before = f.state.calls.length;
  await f.tick(0, NOW + MINUTE_MS);
  await f.tick(5, NOW + MINUTE_MS, 0);
  assert.equal(f.state.calls.length, before, "no request means no reconciliation turn was spent");
  await f.tick(2, NOW + MINUTE_MS);
  assert.deepEqual(f.state.calls.slice(before), f.symbols.slice(2, 4), "a delisted anchor still locates the next untouched peer");
  f.state.listed.push("NEWUSDT");
  await f.collector.refreshSymbols(f.fetchLike, NOW + 2 * MINUTE_MS);
  for (const symbol of f.state.listed) f.put(symbol, settledOpenMs(NOW + 2 * MINUTE_MS));
  await f.tick(2, NOW + 2 * MINUTE_MS);
  assert.deepEqual(f.state.calls.slice(-2), [f.symbols[4], "NEWUSDT"], "a new listing joins the stable sweep before wrapping");
});


await test("tail work exhausting a pass does not spend a reconciliation turn", async () => {
  const f = fairnessFixture("bitget", 3, { reconcileWsGapMinutes: 1 });
  await f.collector.refreshSymbols(f.fetchLike, NOW);
  for (const symbol of f.symbols) f.put(symbol, settledOpenMs(NOW));
  await f.tick(1, NOW);
  assert.equal(f.state.calls.at(-1), f.symbols[0]);
  f.state.listed.push("COLDUSDT");
  await f.collector.refreshSymbols(f.fetchLike, NOW + MINUTE_MS);
  for (const symbol of f.symbols) f.put(symbol, settledOpenMs(NOW + MINUTE_MS));
  const before = f.state.calls.length;
  await f.tick(1, NOW + MINUTE_MS);
  assert.deepEqual(f.state.calls.slice(before), ["COLDUSDT"], "higher-priority tail work keeps its request slot");
  assert.equal(f.collector.restConfirmedMs("COLDUSDT"), null, "an empty response cannot create evidence");
  f.state.listed = [...f.symbols];
  await f.collector.refreshSymbols(f.fetchLike, NOW + 2 * MINUTE_MS);
  await f.tick(1, NOW + 2 * MINUTE_MS);
  assert.equal(f.state.calls.at(-1), f.symbols[1], "the untouched reconciliation turn survives tail-only work");
});

await test("failed reconciliation yields its turn, cooldown preserves the next turn, and failed rows gain no frontier", async () => {
  const f = fairnessFixture("bitget", 4, { reconcileWsGapMinutes: 1 });
  await f.collector.refreshSymbols(f.fetchLike, NOW);
  for (const symbol of f.symbols) f.put(symbol, settledOpenMs(NOW));
  f.state.refuse.set(f.symbols[0], "429");
  f.state.refuse.set(f.symbols[2], "empty");
  await f.tick(3, NOW);
  assert.deepEqual(f.state.calls, [f.symbols[0]], "429 stops the pass after one actual request");
  assert.equal(f.collector.restConfirmedMs(f.symbols[0]), null);
  const cooldown = f.collector.health(f.state.now).cooldownUntil;
  await f.tick(3, cooldown - 1);
  assert.equal(f.state.calls.length, 1, "cooldown remains silent and cannot move the anchor");
  f.state.refuse.set(f.symbols[1], "error");
  await f.tick(1, cooldown);
  assert.equal(f.state.calls.at(-1), f.symbols[1], "a failed first symbol does not pin the retry queue");
  assert.equal(f.collector.restConfirmedMs(f.symbols[1]), null);
  await f.tick(1, f.state.now + 1000);
  assert.equal(f.state.calls.at(-1), f.symbols[2]);
  assert.equal(f.collector.restConfirmedMs(f.symbols[2]), null, "an empty reconcile yields without inventing a frontier");
  await f.tick(1, f.state.now + 1000);
  assert.equal(f.state.calls.at(-1), f.symbols[3]);
  assert.notEqual(f.collector.restConfirmedMs(f.symbols[3]), null);
  f.state.refuse.clear();
  await f.tick(1, f.state.now + 1000);
  assert.equal(f.state.calls.at(-1), f.symbols[0], "the failed symbol is retried after the sweep wraps");
  assert.notEqual(f.collector.restConfirmedMs(f.symbols[0]), null);
  assert.equal(f.collector.health(f.state.now).rateLimitHits, 1);
});

// Real day files and real adapters reproduce the 2026-09-14 Bitunix/Aster
// startup: a tick captured at 20:57 kept its 20:55 settled cutoff while the
// yielding coverage scan observed newer WS rows. REST returned 20:56, which
// the store rejected but the collector nevertheless declared confirmed.
function settlementFixture(venue, { graceOnDisk = false, advanceDuringScan = true } = {}) {
  const store = new CandleStore(tmpDir("settlement-store"));
  const stateDir = tmpDir("settlement-state");
  const state = { now: NOW, calls: [], rows: [], advanceDuringRequest: 0 };
  const candle = (openMs, volume = 1) => ({ openMs, open: 10, high: 12, low: 9, close: 11, volume });
  const collector = new VenueCollector(venue, store, stateDir, {
    ...DEFAULT_COLLECTOR_OPTIONS, reconcileWsGapMinutes: 4,
  }, NOW);
  const putWs = (rows) => {
    const w = store.write(venue, "BTCUSDT", rows, settledOpenMs(state.now));
    assert.equal(w.written, rows.length, "fixture WS writes obey their actual wall clock");
    collector.noteStoredCandles("BTCUSDT", rows, w.written, w.newlyFilled);
  };
  if (advanceDuringScan) {
    putWs([candle(NOW - 2 * MINUTE_MS)]);
    const coverage = store.coverage.bind(store);
    let scanned = false;
    store.coverage = (...args) => {
      if (!scanned) {
        scanned = true;
        state.now += 3 * MINUTE_MS;
        putWs([
          ...(graceOnDisk ? [candle(NOW - MINUTE_MS, 0.5)] : []),
          candle(NOW + MINUTE_MS),
        ]);
      }
      return coverage(...args);
    };
  }
  const fetchLike = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/trading_pairs")) return response({ code: 0, data: [{ symbol: "BTCUSDT", symbolStatus: "OPEN" }] });
    if (u.pathname.endsWith("/exchangeInfo")) return response({ symbols: [{ symbol: "BTCUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" }] });
    assert.match(u.pathname, /\/(kline|klines)$/);
    state.calls.push(u);
    state.now += state.advanceDuringRequest;
    const start = Number(u.searchParams.get("startTime"));
    const end = Number(u.searchParams.get("endTime"));
    const rows = state.rows.filter(c => c.openMs >= start && c.openMs <= end);
    return response(venue === "bitunix"
      ? { code: 0, data: rows.map(c => ({ time: c.openMs, open: c.open, high: c.high, low: c.low, close: c.close, quoteVol: c.volume })) }
      : rows.map(c => [c.openMs, c.open, c.high, c.low, c.close, c.volume]));
  };
  return {
    store, stateDir, collector, state, candle, fetchLike, putWs,
    tick: (now = NOW) => collector.tick(fetchLike, 1, now, {
      clock: () => state.now, sleep: async ms => { state.now += ms; },
    }),
    seed: () => buildSeed({ venue, symbol: "BTCUSDT", fromMs: NOW - 2 * MINUTE_MS, toMs: NOW + MINUTE_MS }, seedDepsFor({ store, collector })),
  };
}

for (const venue of ["bitunix", "aster"]) {
  for (const graceOnDisk of [false, true]) {
    await test(`${venue}: a long tick cannot confirm or count corrections for a rejected grace row (WS present=${graceOnDisk})`, async () => {
      const f = settlementFixture(venue, { graceOnDisk });
      await f.collector.refreshSymbols(f.fetchLike, NOW);
      f.state.rows = [-2, -1, 0, 1].map(i => f.candle(NOW + i * MINUTE_MS));
      f.state.advanceDuringRequest = 3 * MINUTE_MS;
      const result = await f.tick();
      assert.equal(result.requests, 1);
      assert.ok(Number(f.state.calls[0].searchParams.get("endTime")) > settledOpenMs(NOW),
        "the yielded scan really queued reconciliation beyond the captured tick cutoff");
      assert.ok(f.state.now >= NOW + 6 * MINUTE_MS, "both scan and pending request crossed minute boundaries");
      assert.equal(result.written, 1, "only the captured tick's settled row is admitted");
      assert.equal(result.corrected, 0, "a rejected REST value never counts as a correction of an existing WS row");
      const grace = f.store.readWindow(venue, "BTCUSDT", NOW - MINUTE_MS, NOW - MINUTE_MS);
      assert.deepEqual(grace.rows, graceOnDisk ? [[NOW - MINUTE_MS, 10, 12, 9, 11, 0.5]] : [],
        "REST cannot overwrite the grace slot before its captured cutoff allows it");
      assert.equal(f.collector.restConfirmedMs("BTCUSDT"), settledOpenMs(NOW),
        "only a row the store admitted may raise the REST frontier");
      const persisted = JSON.parse(fs.readFileSync(path.join(f.stateDir, venue, "rest-frontier.json"), "utf8"));
      assert.equal(persisted.restConfirmed.BTCUSDT, settledOpenMs(NOW));
      assert.deepEqual(f.collector.coverage("BTCUSDT"), f.store.coverage(venue, "BTCUSDT", true));
      const first = f.seed();
      assert.equal(first.ok, true);
      assert.equal(first.payload.lastClosedMs, settledOpenMs(NOW));
      assert.deepEqual(first.payload.gaps, [], "the seed cannot declare a missing grace slot as its frontier");
      assert.equal(first.payload.rows.length, 1, "WS-only grace data stays outside the confirmed seed");

      // Once a later tick's own clock permits those rows, normal reconciliation
      // writes them and advances evidence; no metadata or gap is rewritten.
      f.state.advanceDuringRequest = 0;
      f.putWs([f.candle(NOW + 4 * MINUTE_MS)]);
      f.state.rows = [-2, -1, 0, 1, 2, 3, 4].map(i => f.candle(NOW + i * MINUTE_MS));
      const later = await f.tick(f.state.now);
      assert.equal(later.corrected, graceOnDisk ? 1 : 0, "a correction counts only once its REST value is written");
      assert.deepEqual(f.store.readWindow(venue, "BTCUSDT", NOW - MINUTE_MS, NOW - MINUTE_MS).rows,
        [[NOW - MINUTE_MS, 10, 12, 9, 11, 1]]);
      assert.equal(f.collector.restConfirmedMs("BTCUSDT"), NOW + 4 * MINUTE_MS);
      assert.deepEqual(f.seed().payload.gaps, []);
    });
  }

  await test(`${venue}: short, grace-only and empty REST pages never credit their requested end`, async () => {
    for (const mode of ["short", "grace-only", "empty"]) {
      const f = settlementFixture(venue);
      await f.collector.refreshSymbols(f.fetchLike, NOW);
      f.state.rows = mode === "empty" ? [] : [f.candle(NOW - (mode === "short" ? 2 : 1) * MINUTE_MS)];
      const result = await f.tick();
      const admitted = mode === "short";
      assert.equal(result.written, admitted ? 1 : 0, mode);
      assert.equal(result.corrected, 0, mode);
      assert.equal(f.collector.restConfirmedMs("BTCUSDT"), admitted ? settledOpenMs(NOW) : null, mode);
      assert.deepEqual(f.collector.coverage("BTCUSDT"), f.store.coverage(venue, "BTCUSDT", true), mode);
      assert.equal(f.seed().ok, admitted, "no accepted REST rows means no seed evidence");
    }
  });
}

await test("a cold recent page selects its contiguous suffix after applying the store settlement cutoff", async () => {
  const f = fixture();
  await f.collector.refreshSymbols(f.fetchLike, NOW);
  f.setRecent([
    weexRow(NOW - 3 * MINUTE_MS, 10, 12, 9, 11, 1),
    weexRow(NOW - MINUTE_MS, 10, 12, 9, 11, 1),
  ]);
  const result = await f.collector.tick(f.fetchLike, 1, NOW, { sleep: async () => {} });
  assert.equal(result.written, 1, "an isolated grace row cannot displace the valid settled suffix");
  assert.equal(f.collector.restConfirmedMs("NBISUSDT"), NOW - 3 * MINUTE_MS);
  assert.deepEqual(f.collector.coverage("NBISUSDT"), f.store.coverage("weex", "NBISUSDT", true));
});

summary("candle-reconcile");
