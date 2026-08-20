// tests/aster.test.mjs — the Aster collector: the weight budget it is paced to,
// the venue quirks that would otherwise cost a live collector its whole pass,
// and the one thing this venue does that no other here does — state, on the
// wire, that a candle is closed.
//
// EVERY PAYLOAD AND EVERY NUMBER BELOW WAS TAKEN FROM THE LIVE MAINNET API
// while this adapter was written. Nothing here is transcribed from a Binance
// doc and assumed to carry over, because "it is a Binance clone" is exactly the
// kind of assumption that puts a wrong candle in front of every install at once.
// Where a fact came from the docs as well as the wire, both are named.
//
// What these pin, in order of how badly each would hurt:
//
//  1. THE PACING. Aster's ceiling is REQUEST_WEIGHT 2400/min per IP, not a
//     request rate, and a kline page's weight depends on the `limit` asked for.
//     Pace it as though it were requests and the hub earns an IP ban — which
//     takes history away from every install at once, not from one.
//  2. THE PAGE SIZE. The venue's MAXIMUM page (1500 rows / 10 weight) is worse
//     value than the one below it (1000 rows / 5 weight). "Ask for the maximum"
//     is the obvious optimisation and it is the wrong one.
//  3. start === end IS AN ERROR ON THIS VENUE. The collector can produce that
//     window, and the v0.2.6 Bitget incident is what it looks like when a venue
//     refuses an odd-shaped range: 298 consecutive failures, 157 requests for
//     zero candles.
//  4. THE CLOSURE FLAG. `x` is documented AND was observed flipping. It is the
//     only closure statement in this repo that was proved rather than inherited.
import assert from "node:assert/strict";
import { test, summary, tmpDir } from "./helpers.mjs";
import {
  ADAPTERS, VENUE_IDS, dropUnclosed, isRateLimit,
  ASTER_REQUEST_WEIGHT_PER_MINUTE, ASTER_WEIGHT_HEADER, ASTER_WEIGHT_ALARM_SHARE,
  asterKlineWeight, asterPacedRps,
} from "../dist/src/candles/venues.js";
import { STREAM_ADAPTERS } from "../dist/src/candles/stream.js";
import { CandleStore, MINUTE_MS, newestClosedOpenMs, floorMinute } from "../dist/src/candles/store.js";
import { VenueCollector, DEFAULT_COLLECTOR_OPTIONS } from "../dist/src/candles/collector.js";

const aster = ADAPTERS.aster;

// ── FROZEN CLOCK ────────────────────────────────────────────────────────────
// A real probe instant: at NOW the minute FORMING has opened and not closed.
const NOW = 1787004534092;
const FORMING = floorMinute(NOW);          // 1787004480000
const NEWEST_CLOSED = newestClosedOpenMs(NOW); // 1787004420000

await test("the frozen clock puts FORMING in progress and NEWEST_CLOSED behind it", () => {
  assert.equal(FORMING, 1787004480000);
  assert.equal(NEWEST_CLOSED, 1787004420000);
});

await test("aster is in the venue registry, with both an adapter and a stream adapter", () => {
  assert.ok(VENUE_IDS.includes("aster"), "listed, so it gets an admin card and an env-selectable collector");
  assert.equal(aster.id, "aster");
  assert.equal(STREAM_ADAPTERS.aster.id, "aster");
});

await test("MAINNET ONLY — no testnet host may appear anywhere in the two adapters", async () => {
  // A silent testnet fallback would serve prices that verify against nothing,
  // and it would look exactly like a working collector. Read out of the built
  // files rather than asserted about a variable, because the risk is somebody
  // adding a second base URL later.
  const fs = await import("node:fs");
  for (const f of ["dist/src/candles/venues.js", "dist/src/candles/stream.js"]) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const hosts = [...src.matchAll(/https?:\/\/[a-z0-9.-]+|wss:\/\/[a-z0-9.-]+/g)].map((m) => m[0]);
    const asterHosts = hosts.filter((h) => h.includes("aster"));
    assert.ok(asterHosts.length > 0, `${f} names an aster host`);
    for (const h of asterHosts) {
      assert.ok(!/testnet/i.test(h), `${f} must never reach a testnet host: ${h}`);
    }
  }
});

// ── 1. THE WEIGHT BUDGET ────────────────────────────────────────────────────

await test("the kline weight table is the venue's own, and it was MEASURED not assumed", () => {
  // Three identical requests at each limit, live, moved x-mbx-used-weight-1m by
  // exactly these amounts. The documented table says the same thing.
  assert.equal(asterKlineWeight(1), 1);
  assert.equal(asterKlineWeight(99), 1);
  assert.equal(asterKlineWeight(100), 2);
  assert.equal(asterKlineWeight(499), 2);
  assert.equal(asterKlineWeight(500), 5);
  assert.equal(asterKlineWeight(1000), 5);
  assert.equal(asterKlineWeight(1001), 10);
  assert.equal(asterKlineWeight(1500), 10);
  // Nonsense in must not become a free request out: an unreadable limit costs
  // at least something, never zero.
  assert.ok(asterKlineWeight(NaN) >= 1);
  assert.ok(asterKlineWeight(-5) >= 1);
});

await test("the collect rate is DERIVED from the weight budget, never typed in", () => {
  assert.equal(ASTER_REQUEST_WEIGHT_PER_MINUTE, 2400, "the venue publishes this in its own exchangeInfo");
  // 2400 weight/min, half of it, at 5 weight a page, over 60 seconds = 4/s.
  assert.equal(asterPacedRps(1000), 4);
  assert.equal(
    aster.publicRequestsPerSecond,
    asterPacedRps(aster.pageLimit),
    "the adapter's rate IS the derivation at its own page size — change one and the other follows",
  );
  // And it really is half, in the venue's units, matching what the other three
  // venues do with their own published figures.
  const spend = aster.publicRequestsPerSecond * 60 * asterKlineWeight(aster.pageLimit);
  assert.equal(spend, ASTER_REQUEST_WEIGHT_PER_MINUTE / 2,
    "steady-state spend is exactly half the published budget");
});

// ── 2. THE PAGE SIZE ────────────────────────────────────────────────────────

await test("1000 rows a page, NOT the venue's 1500 maximum — the maximum is worse value", () => {
  assert.equal(aster.pageLimit, 1000);
  const rowsPerWeight = (limit) => limit / asterKlineWeight(limit);
  assert.equal(rowsPerWeight(1000), 200);
  assert.equal(rowsPerWeight(1500), 150);
  assert.ok(
    rowsPerWeight(aster.pageLimit) >= rowsPerWeight(1500),
    "asking for the biggest page the venue allows would cost a third more budget for the same history",
  );
  // 1500 is genuinely the ceiling (1501 is refused with -1130), so this is a
  // choice between two legal page sizes rather than a limit we cannot reach.
  assert.ok(aster.pageLimit < 1500, "and it is deliberately below what the venue would allow");
});

// ── 3. THE REQUEST SHAPE ────────────────────────────────────────────────────

function captureUrl() {
  const urls = [];
  const fetchLike = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => [] };
  };
  return { urls, fetchLike };
}

await test("a ONE-MINUTE window is never sent as start === end, which this venue refuses", async () => {
  // Measured: startTime === endTime answers HTTP 400, code -1023 "Start time is
  // greater than end time." The collector's backfill produces exactly that
  // window on the pass that lands on the retention horizon.
  const { urls, fetchLike } = captureUrl();
  await aster.fetchKlines(fetchLike, "BTCUSDT", NEWEST_CLOSED, NEWEST_CLOSED);
  const u = new URL(urls[0]);
  assert.equal(Number(u.searchParams.get("startTime")), NEWEST_CLOSED);
  assert.ok(
    Number(u.searchParams.get("endTime")) > Number(u.searchParams.get("startTime")),
    "start and end are never equal on the wire",
  );
});

await test("…and widening the end cannot reach the NEXT minute, so no window changed meaning", async () => {
  const { urls, fetchLike } = captureUrl();
  await aster.fetchKlines(fetchLike, "BTCUSDT", NEWEST_CLOSED - 10 * MINUTE_MS, NEWEST_CLOSED);
  const end = Number(new URL(urls[0]).searchParams.get("endTime"));
  assert.ok(end < NEWEST_CLOSED + MINUTE_MS,
    "endTime stays inside the last requested minute, so the forming bar cannot be pulled in by this");
  assert.equal(end, NEWEST_CLOSED + MINUTE_MS - 1, "the last millisecond of the last requested minute");
});

await test("the request asks for 1m klines at the adapter's own page size", async () => {
  const { urls, fetchLike } = captureUrl();
  await aster.fetchKlines(fetchLike, "BTCUSDT", NEWEST_CLOSED - 100 * MINUTE_MS, NEWEST_CLOSED);
  const u = new URL(urls[0]);
  assert.equal(u.searchParams.get("interval"), "1m");
  assert.equal(Number(u.searchParams.get("limit")), aster.pageLimit);
  assert.equal(u.searchParams.get("symbol"), "BTCUSDT");
});

// ── THE PAGE ITSELF ─────────────────────────────────────────────────────────

function stubPage(rows, headers = {}) {
  return async () => ({
    ok: true, status: 200,
    json: async () => rows,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  });
}

// Captured live from /fapi/v1/klines?symbol=BTCUSDT&interval=1m.
const LIVE_ROWS = [
  [1787004300000, "64344.0", "64344.0", "64320.4", "64320.4", "1.565", 1787004359999, "100684.5863", 39, "0.795", "51146.6951", "0"],
  [NEWEST_CLOSED, "64320.4", "64335.1", "64312.9", "64319.2", "3.287", 1787004479999, "211444.6048", 81, "1.134", "72944.0953", "0"],
  [FORMING, "64319.2", "64322.9", "64319.2", "64322.9", "3.351", 1787004539999, "215538.6172", 26, "1.743", "112110.5290", "0"],
];

await test("a live page parses, oldest-first, with BASE volume from index 5", async () => {
  const { candles } = await aster.fetchKlines(stubPage(LIVE_ROWS), "BTCUSDT", 0, 0);
  assert.deepEqual(candles.map((c) => c.openMs), [1787004300000, NEWEST_CLOSED, FORMING], "oldest first");
  assert.equal(candles[1].open, 64320.4);
  assert.equal(candles[1].high, 64335.1);
  assert.equal(candles[1].low, 64312.9);
  assert.equal(candles[1].close, 64319.2);
  // Index 5 is base volume; index 7 is the quote turnover. Reading 7 would
  // inflate volume by roughly the price of the coin and nothing would flag it.
  assert.equal(candles[1].volume, 3.287);
  assert.notEqual(candles[1].volume, 211444.6048);
});

await test("the forming bar this venue sends is dropped, like every other venue's", async () => {
  const { candles } = await aster.fetchKlines(stubPage(LIVE_ROWS), "BTCUSDT", 0, 0);
  assert.ok(candles.some((c) => c.openMs === FORMING), "precondition: the raw page carries it");
  const closed = dropUnclosed(candles, NOW);
  assert.ok(!closed.some((c) => c.openMs === FORMING), "and it does not survive");
  assert.equal(closed.at(-1).openMs, NEWEST_CLOSED);
});

await test("an empty range answers `empty`, which is what stops backfill digging forever", async () => {
  const { candles, empty } = await aster.fetchKlines(stubPage([]), "BTCUSDT", 0, 0);
  assert.equal(candles.length, 0);
  assert.equal(empty, true, "a range before the pair was listed reads as EMPTY, not as a failure");
});

await test("a row with an unparseable field is dropped rather than stored as NaN", async () => {
  const { candles } = await aster.fetchKlines(
    stubPage([[NEWEST_CLOSED, "x", "y", "z", "w", "v", 0, "0"]]), "BTCUSDT", 0, 0,
  );
  assert.equal(candles.length, 0);
});

// ── 4. RATE LIMITS AND THE WEIGHT READOUT ───────────────────────────────────

function stubStatus(status, body = {}, headers = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  });
}

await test("429 and 418 both stop the pass — and 418 is a BAN, handled in tests/venue-ban.test.mjs", async () => {
  // Both satisfy `isRateLimit`, which is what makes every existing caller's
  // "stop the pass, do not count this as FAILING" handling correct for both.
  // They are NOT the same thing: since v0.2.20 a 418 is a `VenueBanError` — the
  // venue has banned this IP for 2 minutes to 3 days and every further request
  // lengthens it — and it gets its own wait, its own state and its own counter.
  // That split is pinned in tests/venue-ban.test.mjs; this check only holds the
  // inheritance that keeps the shared handling intact.
  for (const code of [429, 418]) {
    const err = await aster.fetchKlines(stubStatus(code), "BTCUSDT", 0, 0).then(() => null, (e) => e);
    assert.equal(isRateLimit(err), true, `HTTP ${code}`);
  }
  const withRetry = await aster
    .fetchKlines(stubStatus(429, {}, { "retry-after": "45" }), "BTCUSDT", 0, 0)
    .then(() => null, (e) => e);
  assert.equal(withRetry.retryAfterMs, 45_000, "the venue's own Retry-After is honoured when it sends one");
});

await test("an ordinary venue error is NOT a rate limit, and carries the venue's own words", async () => {
  // Live: an unknown symbol answers HTTP 400 with {"code":-1121,"msg":"Invalid symbol."}
  const err = await aster
    .fetchKlines(stubStatus(400, { code: -1121, msg: "Invalid symbol." }), "NOSUCHUSDT", 0, 0)
    .then(() => null, (e) => e);
  assert.ok(err, "it throws");
  assert.equal(isRateLimit(err), false, "and counts toward FAILING, where a real fault belongs");
  assert.match(err.message, /-1121/, "the venue's code survives — 'HTTP 400' alone tells an operator nothing");
  assert.match(err.message, /Invalid symbol/);
});

await test("a non-JSON error body still reports the status rather than throwing over it", async () => {
  const res = async () => ({ ok: false, status: 502, json: async () => { throw new Error("not json"); } });
  const err = await aster.fetchKlines(res, "BTCUSDT", 0, 0).then(() => null, (e) => e);
  assert.match(err.message, /HTTP 502/);
});

const ALARM = Math.ceil(ASTER_REQUEST_WEIGHT_PER_MINUTE * ASTER_WEIGHT_ALARM_SHARE);

await test("the venue's own weight readout raises SLOW DOWN — and the candles are still returned", async () => {
  const page = await aster.fetchKlines(
    stubPage(LIVE_ROWS, { [ASTER_WEIGHT_HEADER]: String(ALARM) }), "BTCUSDT", 0, 0,
  );
  assert.ok(page.slowDown, "over the alarm share, the adapter says so");
  assert.equal(isRateLimit(page.slowDown), true, "and it is the same kind of thing a 429 is");
  assert.match(page.slowDown.message, /2400/, "the message names the budget it is measured against");
  // THE POINT: the weight is already spent. Throwing the page away would be the
  // failure the RateLimitError note warns about — budget spent on requests that
  // never become candles.
  assert.equal(page.candles.length, LIVE_ROWS.length, "the page we paid for is kept");
});

await test("below the alarm share, and with no header at all, nothing is said", async () => {
  const quiet = await aster.fetchKlines(
    stubPage(LIVE_ROWS, { [ASTER_WEIGHT_HEADER]: String(ALARM - 1) }), "BTCUSDT", 0, 0,
  );
  assert.equal(quiet.slowDown, undefined, "under the alarm the collector runs at full rate");
  const headerless = await aster.fetchKlines(stubPage(LIVE_ROWS), "BTCUSDT", 0, 0);
  assert.equal(headerless.slowDown, undefined,
    "a MISSING header must never read as 'budget exhausted' — that would silence a healthy collector");
});

await test("the other three venues never set slowDown, so their behaviour is unchanged", async () => {
  const bybitPage = await ADAPTERS.bybit.fetchKlines(
    stubPage({ retCode: 0, result: { list: [] } }), "BTCUSDT", 0, 0,
  );
  assert.equal(bybitPage.slowDown, undefined);
  const bitgetPage = await ADAPTERS.bitget.fetchKlines(stubPage({ code: "00000", data: [] }), "BTCUSDT", 0, 0);
  assert.equal(bitgetPage.slowDown, undefined);
});

// ── THE COLLECTOR ACTS ON IT ────────────────────────────────────────────────

function asterStub({ usedWeight = null, symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] } = {}) {
  const state = { klineRequests: 0, usedWeight };
  const fetchLike = async (url) => {
    const headers = { get: (n) => (n.toLowerCase() === ASTER_WEIGHT_HEADER && state.usedWeight !== null ? String(state.usedWeight) : null) };
    if (url.includes("/fapi/v1/exchangeInfo")) {
      return {
        ok: true, status: 200, headers,
        json: async () => ({
          symbols: symbols.map((s) => ({ symbol: s, quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" })),
        }),
      };
    }
    state.klineRequests++;
    const u = new URL(url);
    const startMs = Number(u.searchParams.get("startTime"));
    const endMs = Number(u.searchParams.get("endTime"));
    const rows = [];
    for (let t = startMs; t <= endMs && rows.length < 1000; t += MINUTE_MS) {
      if (t % MINUTE_MS !== 0) continue;
      if (t > floorMinute(NOW)) break;
      rows.push([t, "100", "102", "99", "101", "5.5", t + MINUTE_MS - 1, "550", 3, "1", "1", "0"]);
    }
    return { ok: true, status: 200, headers, json: async () => rows };
  };
  return { state, fetchLike };
}

function freshCollector(opts = {}) {
  const dir = tmpDir("aster");
  const store = new CandleStore(`${dir}/candles`);
  const collector = new VenueCollector("aster", store, `${dir}/candles`, { ...DEFAULT_COLLECTOR_OPTIONS, ...opts }, NOW);
  return { collector, store, dir };
}

const tickDeps = { clock: () => NOW, sleep: async () => {} };

await test("a collector under weight pressure keeps the candles, halves its rate and goes COOLING", async () => {
  const { collector } = freshCollector();
  const venue = asterStub({ usedWeight: ALARM });
  await collector.refreshSymbols(venue.fetchLike, NOW);
  const before = collector.health(NOW).effectiveRps;
  const { written } = await collector.tick(venue.fetchLike, 10, NOW, tickDeps);

  assert.ok(written > 0, "the page that triggered the warning still reached the store");
  const h = collector.health(NOW);
  assert.equal(h.state, "cooling", "the pass stops and the venue is left alone for a while");
  assert.ok(h.effectiveRps < before, `rate dropped from ${before} to ${h.effectiveRps}`);
  assert.equal(h.consecutiveFailures, 0,
    "being told to slow down is NOT the collector failing — reporting it as FAILING would bury the reason");
  assert.match(h.detail, /rate limited/);
});

await test("…and it stops the pass, rather than spending the rest of the budget into the ceiling", async () => {
  const { collector } = freshCollector();
  const venue = asterStub({ usedWeight: ALARM });
  await collector.refreshSymbols(venue.fetchLike, NOW);
  const { requests } = await collector.tick(venue.fetchLike, 10, NOW, tickDeps);
  assert.equal(requests, 1, "one request, then silence — climbing the 429/418/ban ladder is what this avoids");
});

await test("with the same venue answering under the alarm, the collector runs at full rate", async () => {
  const { collector } = freshCollector();
  const venue = asterStub({ usedWeight: ALARM - 1 });
  await collector.refreshSymbols(venue.fetchLike, NOW);
  const before = collector.health(NOW).effectiveRps;
  const { requests, written } = await collector.tick(venue.fetchLike, 3, NOW, tickDeps);
  assert.equal(requests, 3, "the whole budget is used");
  assert.ok(written > 0);
  const h = collector.health(NOW);
  assert.equal(h.state, "running");
  assert.equal(h.effectiveRps, before, "and nothing was backed off");
});

// ── THE INSTRUMENT LIST ─────────────────────────────────────────────────────

const EXCHANGE_INFO = {
  symbols: [
    { symbol: "BTCUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" },
    { symbol: "ASTERUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" },
    // SETTLING: still a real pair with real history, on its way out.
    { symbol: "TONUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "SETTLING" },
    // PENDING_TRADING rows carry an EMPTY contractType on this venue — the
    // venue has not said what the instrument is yet.
    { symbol: "MBLUSDT", quoteAsset: "USDT", contractType: "", status: "PENDING_TRADING" },
    // Not USDT-quoted; a different book we do not collect.
    { symbol: "BTCUSD1", quoteAsset: "USD1", contractType: "PERPETUAL", status: "TRADING" },
  ],
};

await test("the instrument list is USDT PERPETUALS only, with SETTLING kept but not polled", async () => {
  const listed = await aster.listSymbols(stubPage(EXCHANGE_INFO));
  assert.deepEqual(listed.map((s) => s.symbol).sort(), ["ASTERUSDT", "BTCUSDT", "TONUSDT"]);
  assert.equal(listed.find((s) => s.symbol === "TONUSDT").tradable, false,
    "SETTLING is tracked and left alone: the candles that already happened stay true");
  assert.equal(listed.find((s) => s.symbol === "BTCUSDT").tradable, true);
});

await test("an untyped PENDING_TRADING row is not tracked — the venue has not said what it is", async () => {
  const listed = await aster.listSymbols(stubPage(EXCHANGE_INFO));
  assert.ok(!listed.some((s) => s.symbol === "MBLUSDT"),
    "it has no history to collect either way, and admitting an untyped row admits a dated future too");
});

await test("a symbol that cannot be a directory name is refused by the collector, not sanitised", async () => {
  // NOT hypothetical: Aster lists four live USDT perpetuals whose venue-native
  // spelling is CJK. The symbol becomes a path segment, so `refreshSymbols`
  // refuses it — it shows up as a missing pair rather than a surprise path, and
  // the seed route refuses the same spelling with a 400.
  const { collector } = freshCollector();
  const fetchLike = stubPage({
    symbols: [
      { symbol: "BTCUSDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" },
      { symbol: "龙虾USDT", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" },
    ],
  });
  const { added } = await collector.refreshSymbols(fetchLike, NOW);
  assert.deepEqual(added, ["BTCUSDT"]);
  assert.equal(collector.isTracked("龙虾USDT"), false);
});

await test("the list request is a plain exchangeInfo read", async () => {
  const { urls, fetchLike } = captureUrl();
  await aster.listSymbols(async (u) => { urls.push(u); return { ok: true, status: 200, json: async () => ({ symbols: [] }) }; });
  assert.match(urls[0], /^https:\/\/fapi\.asterdex\.com\/fapi\/v1\/exchangeInfo$/);
  assert.ok(fetchLike);
});

// ── 5. THE WEBSOCKET TAIL ───────────────────────────────────────────────────
// Frames below were captured live from wss://fstream.asterdex.com, including
// the closing one — `x` was observed going false -> true on the boundary.

const ASTER_FORMING = '{"e":"kline","E":1787004809101,"s":"BTCUSDT","k":{"t":1787004780000,"T":1787004839999,"s":"BTCUSDT","i":"1m","f":144886903,"L":144886920,"o":"64294.9","c":"64287.4","h":"64294.9","l":"64287.4","v":"0.556","n":18,"x":false,"q":"35744.9857","V":"0.289","Q":"18579.7248","B":"0"}}';
const ASTER_CLOSED = '{"e":"kline","E":1787004721172,"s":"BTCUSDT","k":{"t":1787004660000,"T":1787004719999,"s":"BTCUSDT","i":"1m","f":144886836,"L":144886871,"o":"64292.7","c":"64289.4","h":"64292.7","l":"64289.4","v":"1.638","n":36,"x":true,"q":"105308.1757","V":"0.782","Q":"50275.4098","B":"0"}}';
const ASTER_COMBINED = '{"stream":"btcusdt@kline_1m","data":{"e":"kline","E":1787004695421,"s":"BTCUSDT","k":{"t":1787004660000,"T":1787004719999,"s":"BTCUSDT","i":"1m","f":144886836,"L":144886858,"o":"64292.7","c":"64289.4","h":"64292.7","l":"64289.4","v":"1.223","n":23,"x":false,"q":"78628.0747","V":"0.582","Q":"37417.5298","B":"0"}}}';
const ASTER_ACK = '{"id":1,"result":null}';

await test("aster STATES closure on the wire — the flag is the venue's own assertion", () => {
  const [forming] = STREAM_ADAPTERS.aster.parse(ASTER_FORMING);
  const [closed] = STREAM_ADAPTERS.aster.parse(ASTER_CLOSED);
  assert.equal(forming.closed, false);
  assert.equal(closed.closed, true, "`x` is documented as 'Is this kline closed?' and was seen flipping");
  assert.equal(closed.openMs, 1787004660000, "and the candle states its OWN open time — nothing is derived from a clock");
  assert.equal(closed.symbol, "BTCUSDT", "read back in the UPPERCASE spelling the REST collector stores under");
  assert.equal(closed.candle.volume, 1.638, "`v` is base volume, not the `q` turnover");
  assert.equal(closed.candle.close, 64289.4);
});

await test("a truthy-but-not-true `x` falls back to the ordering rule instead of being coerced", () => {
  const stringy = ASTER_CLOSED.replace('"x":true', '"x":"true"');
  const [t] = STREAM_ADAPTERS.aster.parse(stringy);
  assert.equal(t.closed, false, "a venue that changed the field's type must not silently publish forming bars");
});

await test("both the raw and the combined stream shapes parse to the same candle", () => {
  const [bare] = STREAM_ADAPTERS.aster.parse(ASTER_FORMING.replace("1787004780000", "1787004660000"));
  const [wrapped] = STREAM_ADAPTERS.aster.parse(ASTER_COMBINED);
  assert.equal(wrapped.openMs, bare.openMs);
  assert.equal(wrapped.symbol, "BTCUSDT");
});

await test("acks, junk and non-kline events are ignored, never fatal", () => {
  for (const f of [ASTER_ACK, "", "{", "not json", '{"e":"aggTrade","s":"BTCUSDT"}', '{"e":"kline","s":"X"}']) {
    const got = STREAM_ADAPTERS.aster.parse(f);
    assert.ok(Array.isArray(got) && got.length === 0, `ignored: ${f.slice(0, 24)}`);
  }
});

await test("ONE subscribe frame carries the whole chunk — the venue caps INCOMING messages at 10/s", () => {
  const a = STREAM_ADAPTERS.aster;
  const symbols = Array.from({ length: a.maxTopicsPerConnection }, (_, i) => `SYM${i}USDT`);
  const frames = a.subscribeFrames(symbols);
  assert.equal(frames.length, 1,
    "a frame per symbol would be 200 messages against a documented cap of 10/s — the socket is dropped and repeat offenders are banned");
  assert.equal(frames[0].method, "SUBSCRIBE");
  assert.equal(frames[0].params.length, symbols.length);
});

await test("stream names are LOWERCASE, which is the venue's own requirement", () => {
  const [frame] = STREAM_ADAPTERS.aster.subscribeFrames(["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(frame.params, ["btcusdt@kline_1m", "ethusdt@kline_1m"]);
});

await test("aster sends NO application-level ping, because its pings are protocol frames", () => {
  const a = STREAM_ADAPTERS.aster;
  assert.equal(a.pingFrame, undefined,
    "a JSON ping would be an unrecognised INCOMING message on a venue that caps those at 10/s");
  assert.equal(a.pingIntervalMs, undefined);
  assert.equal(a.maxTopicsPerConnection, 200, "documented: a single connection may listen to at most 200 streams");
});

summary("aster");
