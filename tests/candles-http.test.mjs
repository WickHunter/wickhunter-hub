// tests/candles-http.test.mjs — the seed endpoint over real HTTP, plus the
// collector's symbol-set drift and the per-exchange status the admin page reads.
//
// The venue is a STUB: this suite makes no outbound request. It answers Bitget's
// real URL shapes with generated candles so the collector's paging, its handling
// of new listings and delistings, and its health states can all be driven from a
// frozen clock.
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { verify as edVerify, createPublicKey } from "node:crypto";
import { freshHub, jsonReq, test, summary, tmpDir } from "./helpers.mjs";
import { CandleStore, MINUTE_MS, newestClosedOpenMs } from "../dist/src/candles/store.js";
import { VenueCollector, DEFAULT_COLLECTOR_OPTIONS } from "../dist/src/candles/collector.js";
import { CandleService } from "../dist/src/candles/service.js";
import { canonicalBytes } from "../dist/src/candles/seed.js";

const NOW = 1786410725631;
const NEWEST_CLOSED = newestClosedOpenMs(NOW); // 1786410660000

// ── A STUB BITGET ───────────────────────────────────────────────────────────
// Serves whatever symbol list it is currently configured with, and synthesises
// 1m candles (including the forming bar, exactly as the real /candles does, so
// the collector is tested against the harder of the venue's two behaviours).
function stubVenue(opts = {}) {
  const state = {
    symbols: opts.symbols ?? ["BTCUSDT"],
    /** symbol -> the oldest minute this venue has any history for. */
    listedSince: opts.listedSince ?? {},
    failWith: opts.failWith ?? null,
    now: opts.now ?? NOW,
    requests: [],
    // Rate limiting, in the two shapes the venues actually use. `limitAfter` is
    // how many KLINE requests it serves before it starts refusing; null never
    // refuses. `limitAs` picks the shape: an HTTP 429 or a 200 carrying the
    // venue's own too-frequent code.
    limitAfter: opts.limitAfter ?? null,
    limitAs: opts.limitAs ?? "http429",
    retryAfter: opts.retryAfter ?? null,
    klineRequests: 0,
  };
  const fetchLike = async (url) => {
    state.requests.push(url);
    if (state.failWith) throw new Error(state.failWith);
    if (url.includes("/mix/market/contracts")) {
      return {
        ok: true, status: 200,
        json: async () => ({ code: "00000", data: state.symbols.map((s) => (typeof s === "string" ? { symbol: s, symbolStatus: "normal" } : s)) }),
      };
    }
    state.klineRequests++;
    if (state.limitAfter !== null && state.klineRequests > state.limitAfter) {
      if (state.limitAs === "http429") {
        return {
          ok: false, status: 429, json: async () => ({}),
          headers: { get: (n) => (n.toLowerCase() === "retry-after" ? state.retryAfter : null) },
        };
      }
      // Bitget's adapter reads `code`; this is the venue-body shape.
      return { ok: true, status: 200, json: async () => ({ code: "429", msg: "too many requests" }) };
    }
    const u = new URL(url);
    const symbol = u.searchParams.get("symbol");
    const startMs = Number(u.searchParams.get("startTime"));
    const endMs = Number(u.searchParams.get("endTime"));
    const since = state.listedSince[symbol] ?? 0;
    const data = [];
    // The forming minute is included on purpose — the collector must drop it.
    const cap = Math.min(endMs, Math.floor(state.now / MINUTE_MS) * MINUTE_MS);
    for (let t = Math.max(startMs, since); t <= cap; t += MINUTE_MS) {
      if (t % MINUTE_MS !== 0) continue;
      const i = t / MINUTE_MS;
      data.push([String(t), String(100 + (i % 7)), String(102 + (i % 7)), String(99 + (i % 7)), String(101 + (i % 7)), "5.5", "550"]);
      if (data.length >= 200) break;
    }
    return { ok: true, status: 200, json: async () => ({ code: "00000", data }) };
  };
  return { state, fetchLike };
}

function serviceWith(venue, fetchLike, overrides = {}, deps = {}) {
  const dataDir = tmpDir("cs");
  const slept = [];
  const svc = new CandleService(
    {
      dataDir,
      venues: [venue],
      keyId: "seed-1",
      options: { ...DEFAULT_COLLECTOR_OPTIONS, ...overrides },
      tickMs: 60_000,
    },
    // The collector's startedAt must come from the SAME frozen clock the
    // assertions use; otherwise elapsed time is measured against real wall
    // time and this suite silently rots about an hour after it is written.
    // That same clock now also paces requests, and `sleep` RECORDS instead of
    // waiting — so the pacing is exercised in full and asserted on, without the
    // suite spending 312 ms per request to observe it.
    {
      sign: (b) => Buffer.alloc(64),
      fetchLike,
      now: deps.now ?? (() => NOW),
      sleep: async (ms) => { slept.push(ms); },
    },
  );
  return { svc, dataDir, slept };
}

// ── THE ENDPOINT ────────────────────────────────────────────────────────────

const h = await freshHub();
const { token } = h.store.issue("Seed Tester", 30);
const DAY0 = Date.parse("2026-08-01T00:00:00.000Z");

// Plant candles directly into the hub's own store: minutes 0,1,  3,4 (2 absent).
const hubStore = new CandleStore(`${h.dataDir}/candles`);
const mk = (t, i) => ({ openMs: t, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000 + i });
hubStore.write("bitget", "BTCUSDT", [
  mk(DAY0, 0), mk(DAY0 + MINUTE_MS, 1), mk(DAY0 + 3 * MINUTE_MS, 3), mk(DAY0 + 4 * MINUTE_MS, 4),
]);

const seedUrl = (q) => `${h.origin}/api/candles/seed?${new URLSearchParams(q)}`;

await test("a valid key gets a signed seed whose signature verifies over the wire bytes", async () => {
  const res = await fetch(seedUrl({ venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 + 4 * MINUTE_MS, key: token }));
  assert.equal(res.status, 200);
  const body = JSON.parse(await res.text());
  assert.equal(body.v, 1);
  assert.equal(body.venue, "bitget");
  assert.equal(body.symbol, "BTCUSDT");
  assert.equal(body.interval, "1");
  assert.equal(body.keyId, "seed-1");
  assert.equal(body.lastClosedMs, DAY0 + 4 * MINUTE_MS);
  assert.equal(body.rows.length, 4);
  assert.deepEqual(body.gaps, [[DAY0 + 2 * MINUTE_MS, DAY0 + 2 * MINUTE_MS]], "the hole is stated on the wire");
  const { sig, ...unsigned } = body;
  const pub = createPublicKey(h.store.publicKeyPem());
  assert.equal(edVerify(null, canonicalBytes(unsigned), pub, Buffer.from(sig, "base64")), true,
    "a client that strips sig and re-serialises in the documented order verifies it");
});

await test("rows are numbers on the wire, oldest first, every openMs a multiple of 60000", async () => {
  const res = await fetch(seedUrl({ venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 + 4 * MINUTE_MS, key: token }));
  const body = JSON.parse(await res.text());
  let prev = -1;
  for (const r of body.rows) {
    assert.equal(r.length, 6);
    assert.ok(r.every((n) => typeof n === "number"), "numbers, not strings");
    assert.equal(r[0] % 60000, 0, "on the minute grid");
    assert.ok(r[0] > prev, "strictly increasing");
    prev = r[0];
  }
});

await test("the response is gzip-encoded when the client accepts it, and identical once inflated", async () => {
  const q = { venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 + 4 * MINUTE_MS, key: token };
  // Node's fetch inflates transparently, so go to the socket for the raw bytes.
  const plain = await fetch(seedUrl(q), { headers: { "accept-encoding": "identity" } });
  assert.equal(plain.headers.get("content-encoding"), null, "no encoding when not accepted");
  const gz = await fetch(seedUrl(q), { headers: { "accept-encoding": "gzip" } });
  assert.equal(gz.headers.get("content-encoding"), "gzip", "gzip when accepted");
  assert.equal(await gz.text(), await plain.text(), "same JSON either way");
});

await test("gzip actually shrinks a realistic seed", async () => {
  const many = [];
  for (let i = 0; i < 3000; i++) many.push(mk(DAY0 + i * MINUTE_MS, i));
  hubStore.write("bitget", "BULKUSDT", many);
  const res = await fetch(seedUrl({ venue: "bitget", symbol: "BULKUSDT", fromMs: DAY0, toMs: DAY0 + 2999 * MINUTE_MS, key: token }));
  const text = await res.text();
  const raw = Buffer.byteLength(text);
  const zipped = gzipSync(Buffer.from(text)).length;
  assert.ok(zipped * 3 < raw, `gzip should be well under a third: ${zipped} vs ${raw}`);
});

await test("no key, a bad key, an expired key and a revoked key are all refused", async () => {
  const base = { venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 + 4 * MINUTE_MS };
  const expired = h.store.issue("Lapsed Seeder", 1, Date.now() - 3 * 86_400_000);
  const revoked = h.store.issue("Banned Seeder", 30);
  h.store.revoke(revoked.payload.id);
  for (const [label, key] of [["none", ""], ["garbage", "LHK1.x.y"], ["expired", expired.token], ["revoked", revoked.token]]) {
    const r = await jsonReq(seedUrl({ ...base, key }));
    assert.equal(r.status, 403, `key: ${label}`);
    assert.equal(r.body.ok, false);
  }
});

await test("an unknown venue is 400", async () => {
  for (const venue of ["binance", "", "BITGET!"]) {
    const r = await jsonReq(seedUrl({ venue, symbol: "BTCUSDT", fromMs: DAY0, toMs: DAY0 + MINUTE_MS, key: token }));
    assert.equal(r.status, 400, `venue: ${venue}`);
  }
});

await test("with a collector running, a symbol the venue does not list is 404 — not 503", async () => {
  // The distinction is the whole point: 503 means "ask me again later", and for
  // a pair this venue does not list, later will never help.
  const venue = stubVenue({ symbols: ["BTCUSDT"] });
  const hub = await freshHub({ candleVenues: ["bitget"] }, { candleFetch: venue.fetchLike });
  const key = hub.store.issue("Collector Hub", 30).token;
  await hub.candles.tickAll(NOW);

  const listed = await jsonReq(`${hub.origin}/api/candles/seed?venue=bitget&symbol=BTCUSDT&fromMs=${NEWEST_CLOSED - 10 * MINUTE_MS}&toMs=${NEWEST_CLOSED}&key=${key}`);
  assert.equal(listed.status, 200, "precondition: the listed symbol serves");

  const missing = await jsonReq(`${hub.origin}/api/candles/seed?venue=bitget&symbol=NOSUCHUSDT&fromMs=${DAY0}&toMs=${DAY0 + MINUTE_MS}&key=${key}`);
  assert.equal(missing.status, 404, "not listed on this venue");
  assert.match(missing.body.error, /not listed/);
  await hub.close();
});

await test("a symbol the venue lists but we have not collected yet is 503, never a thin 200", async () => {
  // The new-listing shape at its most extreme: tracked, zero candles. It must
  // read as "come back later", not as a complete-but-empty seed.
  const venue = stubVenue({ symbols: ["BTCUSDT", "BRANDNEWUSDT"], listedSince: { BRANDNEWUSDT: Number.MAX_SAFE_INTEGER } });
  const hub = await freshHub({ candleVenues: ["bitget"] }, { candleFetch: venue.fetchLike });
  const key = hub.store.issue("New Pair Hub", 30).token;
  await hub.candles.tickAll(NOW);
  assert.ok(hub.candles.collector("bitget").isTracked("BRANDNEWUSDT"), "precondition: tracked");
  assert.equal(hub.candles.collector("bitget").coverage("BRANDNEWUSDT").lastClosedMs, null, "precondition: no candles");
  const r = await jsonReq(`${hub.origin}/api/candles/seed?venue=bitget&symbol=BRANDNEWUSDT&fromMs=${DAY0}&toMs=${DAY0 + MINUTE_MS}&key=${key}`);
  assert.equal(r.status, 503);
  await hub.close();
});

await test("a malformed window is 400 and never a 200", async () => {
  for (const q of [
    { fromMs: "abc", toMs: DAY0 },
    { fromMs: DAY0 + MINUTE_MS, toMs: DAY0 },
    { fromMs: DAY0, toMs: DAY0 + 60_001 * MINUTE_MS },
  ]) {
    const r = await jsonReq(seedUrl({ venue: "bitget", symbol: "BTCUSDT", key: token, ...q }));
    assert.equal(r.status, 400, JSON.stringify(q));
  }
  const missing = await jsonReq(`${h.origin}/api/candles/seed?venue=bitget&symbol=BTCUSDT&key=${token}`);
  assert.equal(missing.status, 400, "fromMs/toMs are required");
});

await test("a path-traversal symbol is rejected before it can reach the filesystem", async () => {
  for (const symbol of ["../../etc/passwd", "..", "BTC/USDT", "BTC.USDT"]) {
    const r = await jsonReq(seedUrl({ venue: "bitget", symbol, fromMs: DAY0, toMs: DAY0 + MINUTE_MS, key: token }));
    assert.equal(r.status, 400, `symbol: ${symbol}`);
  }
});

await test("a window entirely before our history is 503, never a 200 with empty rows", async () => {
  const r = await jsonReq(seedUrl({ venue: "bitget", symbol: "BTCUSDT", fromMs: DAY0 - 100 * MINUTE_MS, toMs: DAY0 - MINUTE_MS, key: token }));
  assert.equal(r.status, 503);
  assert.equal(r.body.ok, false);
});

await test("HUB_CANDLE_REQUIRE_LICENSE=0 opens the endpoint and changes nothing else", async () => {
  const open = await freshHub({ candleRequireLicense: false });
  new CandleStore(`${open.dataDir}/candles`).write("bitget", "BTCUSDT", [mk(DAY0, 0)]);
  const r = await fetch(`${open.origin}/api/candles/seed?venue=bitget&symbol=BTCUSDT&fromMs=${DAY0}&toMs=${DAY0}`);
  assert.equal(r.status, 200, "no key needed when the operator turns the gate off");
  // The licence path itself is untouched: a keyed download still demands one.
  const dl = await fetch(`${open.origin}/api/latest`);
  assert.equal(dl.status, 403, "the existing licence gate is not weakened by the seed flag");
  await open.close();
});

// ── SYMBOL-SET DRIFT ────────────────────────────────────────────────────────

await test("a symbol listed mid-run starts collecting WITHOUT a restart", async () => {
  const venue = stubVenue({ symbols: ["BTCUSDT"] });
  const { svc } = serviceWith("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  assert.deepEqual(svc.collector("bitget").symbols().map((s) => s.symbol), ["BTCUSDT"]);

  // The venue lists a new pair. Same process, same collector object.
  venue.state.symbols = ["BTCUSDT", "NEWCOINUSDT"];
  // Far enough ahead that the symbol refresh is due again.
  const later = NOW + DEFAULT_COLLECTOR_OPTIONS.symbolRefreshMs + MINUTE_MS;
  venue.state.now = later;
  await svc.tickAll(later);

  const tracked = svc.collector("bitget").symbols().map((s) => s.symbol);
  assert.ok(tracked.includes("NEWCOINUSDT"), "the new listing is tracked with no restart");
  const cov = svc.collector("bitget").coverage("NEWCOINUSDT");
  assert.notEqual(cov.lastClosedMs, null, "and it is already being collected");
});

await test("a delisted symbol stops being polled but keeps its history", async () => {
  const venue = stubVenue({ symbols: ["BTCUSDT", "DOOMEDUSDT"] });
  const { svc } = serviceWith("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  const before = svc.collector("bitget").coverage("DOOMEDUSDT").lastClosedMs;
  assert.notEqual(before, null, "precondition: we collected it while it was listed");

  venue.state.symbols = ["BTCUSDT"];
  const later = NOW + DEFAULT_COLLECTOR_OPTIONS.symbolRefreshMs + MINUTE_MS;
  venue.state.now = later;
  venue.state.requests.length = 0;
  await svc.tickAll(later);

  const rec = svc.collector("bitget").symbols().find((s) => s.symbol === "DOOMEDUSDT");
  assert.equal(rec.delisted, true, "marked delisted");
  assert.ok(!venue.state.requests.some((u) => u.includes("symbol=DOOMEDUSDT")), "no longer polled");
  assert.equal(svc.collector("bitget").coverage("DOOMEDUSDT").lastClosedMs, before, "history kept");
});

await test("a re-listed symbol resumes and does not count as new again", async () => {
  const venue = stubVenue({ symbols: ["BTCUSDT", "BACKUSDT"] });
  const { svc } = serviceWith("bitget", venue.fetchLike);
  const c = svc.collector("bitget");
  await c.refreshSymbols(venue.fetchLike, NOW);
  const firstSeen = c.symbols().find((s) => s.symbol === "BACKUSDT").firstSeenAt;
  venue.state.symbols = ["BTCUSDT"];
  await c.refreshSymbols(venue.fetchLike, NOW + 60_000);
  assert.equal(c.symbols().find((s) => s.symbol === "BACKUSDT").delisted, true);
  venue.state.symbols = ["BTCUSDT", "BACKUSDT"];
  await c.refreshSymbols(venue.fetchLike, NOW + 120_000);
  const rec = c.symbols().find((s) => s.symbol === "BACKUSDT");
  assert.equal(rec.delisted, false, "resumed");
  assert.equal(rec.firstSeenAt, firstSeen, "firstSeenAt is not reset, so it is not 'new' again");
});

await test("an instrument the venue lists but is not trading yet is tracked, not polled", async () => {
  // Bitunix publishes PREVIEW rows for announced listings. They have no
  // candles behind them; polling them would be noise and a stream of errors.
  const state = { symbols: [{ symbol: "BTCUSDT", symbolStatus: "normal" }, { symbol: "SOONUSDT", symbolStatus: "preview" }] };
  const fetchLike = async (url) => {
    if (url.includes("/mix/market/contracts")) return { ok: true, status: 200, json: async () => ({ code: "00000", data: state.symbols }) };
    return { ok: true, status: 200, json: async () => ({ code: "00000", data: [] }) };
  };
  const { svc } = serviceWith("bitget", fetchLike);
  await svc.tickAll(NOW);
  const rec = svc.collector("bitget").symbols().find((s) => s.symbol === "SOONUSDT");
  assert.equal(rec.tradable, false, "tracked but flagged not tradable");
});

await test("tracked symbols survive a restart, so 'new in the last 24h' stays true", async () => {
  const venue = stubVenue({ symbols: ["BTCUSDT", "OLDUSDT"] });
  const dataDir = tmpDir("cs-restart");
  const store = new CandleStore(`${dataDir}/candles`);
  const first = new VenueCollector("bitget", store, `${dataDir}/candles`, DEFAULT_COLLECTOR_OPTIONS, NOW);
  await first.refreshSymbols(venue.fetchLike, NOW);
  // A brand new process reading the same data dir.
  const second = new VenueCollector("bitget", store, `${dataDir}/candles`, DEFAULT_COLLECTOR_OPTIONS, NOW);
  assert.deepEqual(second.symbols().map((s) => s.symbol).sort(), ["BTCUSDT", "OLDUSDT"]);
  assert.equal(second.symbols().find((s) => s.symbol === "OLDUSDT").firstSeenAt, NOW, "firstSeenAt persisted");
});

await test("the collector never stores a forming bar even though the stub venue sends one", async () => {
  const venue = stubVenue({ symbols: ["BTCUSDT"] });
  const { svc } = serviceWith("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  const cov = svc.collector("bitget").coverage("BTCUSDT");
  assert.equal(cov.lastClosedMs, NEWEST_CLOSED, "stops at the newest CLOSED minute, not the one in progress");
});

// ── PER-EXCHANGE STATUS ─────────────────────────────────────────────────────

await test("a venue with no collector says so instead of showing zeroes", async () => {
  const venue = stubVenue();
  const { svc } = serviceWith("bitget", venue.fetchLike);
  const all = svc.status(NOW);
  assert.deepEqual(all.map((v) => v.venue), ["bybit", "bitunix", "bitget"], "every venue gets a card");
  const bybit = all.find((v) => v.venue === "bybit");
  assert.equal(bybit.configured, false, "explicitly not configured");
  assert.equal(bybit.health, null, "and no health numbers that could be mistaken for a running collector");
  assert.equal(all.find((v) => v.venue === "bitget").configured, true);
});

await test("a collector that just polled reads RUNNING with its last success stated", async () => {
  const venue = stubVenue({ symbols: ["BTCUSDT"] });
  const { svc } = serviceWith("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  const s = svc.status(NOW).find((v) => v.venue === "bitget");
  assert.equal(s.health.state, "running");
  assert.equal(s.health.lastSuccessAt, NOW);
  assert.equal(s.health.lastError, null);
});

await test("a collector that has not succeeded for 40 minutes reads STALLED, not idle", async () => {
  const venue = stubVenue({ symbols: ["BTCUSDT"] });
  const { svc } = serviceWith("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  const s = svc.status(NOW + 40 * MINUTE_MS).find((v) => v.venue === "bitget");
  assert.equal(s.health.state, "stalled", "nothing threw, but it is not keeping up");
  assert.match(s.health.detail, /40m ago/, "the age is stated plainly");
  assert.doesNotMatch(s.health.detail, /idle/i, "'stalled' is never softened into 'idle'");
});

await test("repeated request failures read FAILING and carry the last error and its time", async () => {
  const venue = stubVenue({ symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] });
  const { svc } = serviceWith("bitget", venue.fetchLike, { failingAfter: 2 });
  await svc.tickAll(NOW);
  venue.state.failWith = "connect ETIMEDOUT";
  await svc.tickAll(NOW + MINUTE_MS);
  const s = svc.status(NOW + MINUTE_MS).find((v) => v.venue === "bitget");
  assert.equal(s.health.state, "failing");
  assert.match(s.health.lastError.message, /ETIMEDOUT/);
  assert.equal(s.health.lastError.at, NOW + MINUTE_MS);
  assert.ok(s.health.consecutiveFailures >= 2);
});

await test("FAILING wins over STALLED, because it is the more actionable thing to say", async () => {
  const venue = stubVenue({ symbols: ["BTCUSDT"] });
  const { svc } = serviceWith("bitget", venue.fetchLike, { failingAfter: 1 });
  await svc.tickAll(NOW);
  venue.state.failWith = "HTTP 418";
  await svc.tickAll(NOW + MINUTE_MS);
  const s = svc.status(NOW + 90 * MINUTE_MS).find((v) => v.venue === "bitget");
  assert.equal(s.health.state, "failing", "stale AND erroring reports the error");
});

await test("a collector that has never succeeded is 'starting' briefly, then FAILING — never 'running'", async () => {
  const venue = stubVenue({ symbols: ["BTCUSDT"], failWith: "getaddrinfo ENOTFOUND" });
  const { svc } = serviceWith("bitget", venue.fetchLike, { failingAfter: 1000 });
  const early = svc.status(NOW).find((v) => v.venue === "bitget");
  assert.equal(early.health.state, "starting");
  const late = svc.status(NOW + 60 * MINUTE_MS).find((v) => v.venue === "bitget");
  assert.equal(late.health.state, "failing", "a collector that never worked must not sit in 'starting' forever");
});

await test("the status states oldest/newest held, gap totals and the worst offenders", async () => {
  const { svc, dataDir } = serviceWith("bitget", stubVenue().fetchLike);
  const store = new CandleStore(`${dataDir}/candles`);
  const c = svc.collector("bitget");
  await c.refreshSymbols(async (url) => ({
    ok: true, status: 200,
    json: async () => (url.includes("contracts")
      ? { code: "00000", data: [{ symbol: "AAAUSDT", symbolStatus: "normal" }, { symbol: "BBBUSDT", symbolStatus: "normal" }] }
      : { code: "00000", data: [] }),
  }), NOW - 10 * 86_400_000);

  // AAA: contiguous. BBB: three holes.
  const aaa = [];
  for (let i = 0; i < 100; i++) aaa.push(mk(DAY0 + i * MINUTE_MS, i));
  store.write("bitget", "AAAUSDT", aaa);
  const bbb = [];
  for (let i = 0; i < 100; i++) if (![10, 11, 12].includes(i)) bbb.push(mk(DAY0 + i * MINUTE_MS, i));
  store.write("bitget", "BBBUSDT", bbb);

  const s = svc.status(NOW).find((v) => v.venue === "bitget");
  assert.equal(s.oldestClosedMs, DAY0, "oldest candle held is a fact on screen");
  assert.equal(s.newestClosedMs, DAY0 + 99 * MINUTE_MS, "newest likewise");
  assert.equal(s.totalMissingMinutes, 3, "gap total is exact");
  assert.deepEqual(s.worstGaps, [{ symbol: "BBBUSDT", missingMinutes: 3 }], "worst offender named");
  assert.equal(s.counts.gapped, 1, "and counted in the gapped bucket");
});

await test("symbols fall into exactly one bucket and the counts add up to tracked", async () => {
  const { svc, dataDir } = serviceWith("bitget", stubVenue().fetchLike);
  const store = new CandleStore(`${dataDir}/candles`);
  const c = svc.collector("bitget");
  const syms = ["FULLUSDT", "THINUSDT", "HOLEUSDT", "NONEUSDT"];
  await c.refreshSymbols(async (url) => ({
    ok: true, status: 200,
    json: async () => (url.includes("contracts")
      ? { code: "00000", data: syms.map((symbol) => ({ symbol, symbolStatus: "normal" })) }
      : { code: "00000", data: [] }),
  }), NOW - 10 * 86_400_000);

  // FULL: 2000 contiguous minutes ending at the newest closed minute -> seedable
  const full = [];
  for (let i = 0; i < 2000; i++) full.push(mk(NEWEST_CLOSED - (1999 - i) * MINUTE_MS, i));
  store.write("bitget", "FULLUSDT", full);
  // THIN: only 30 minutes -> backfilling
  const thin = [];
  for (let i = 0; i < 30; i++) thin.push(mk(NEWEST_CLOSED - (29 - i) * MINUTE_MS, i));
  store.write("bitget", "THINUSDT", thin);
  // HOLE: deep and current but with an interior hole -> gapped
  const hole = [];
  for (let i = 0; i < 2000; i++) if (i !== 500) hole.push(mk(NEWEST_CLOSED - (1999 - i) * MINUTE_MS, i));
  store.write("bitget", "HOLEUSDT", hole);
  // NONE: nothing at all -> empty

  const s = svc.status(NOW).find((v) => v.venue === "bitget");
  assert.equal(s.counts.tracked, 4);
  assert.equal(s.counts.seedable, 1, "FULLUSDT");
  assert.equal(s.counts.backfilling, 1, "THINUSDT");
  assert.equal(s.counts.gapped, 1, "HOLEUSDT");
  assert.equal(s.counts.empty, 1, "NONEUSDT");
  assert.equal(
    s.counts.seedable + s.counts.backfilling + s.counts.gapped + s.counts.empty,
    s.counts.tracked,
    "one bucket per symbol — no symbol double-counted or dropped",
  );
});

/** A deep symbol whose newest candle is `behindMin` minutes old. */
async function deepSymbolBehind(behindMin) {
  const { svc, dataDir } = serviceWith("bitget", stubVenue().fetchLike);
  const store = new CandleStore(`${dataDir}/candles`);
  await svc.collector("bitget").refreshSymbols(async (url) => ({
    ok: true, status: 200,
    json: async () => (url.includes("contracts") ? { code: "00000", data: [{ symbol: "STALEUSDT", symbolStatus: "normal" }] } : { code: "00000", data: [] }),
  }), NOW - 10 * 86_400_000);
  const rows = [];
  const end = NEWEST_CLOSED - behindMin * MINUTE_MS;
  for (let i = 0; i < 2000; i++) rows.push(mk(end - (1999 - i) * MINUTE_MS, i));
  store.write("bitget", "STALEUSDT", rows);
  return svc.status(NOW).find((v) => v.venue === "bitget");
}

await test("a symbol that is deep but STALE is backfilling, not seedable", async () => {
  // v0.2.4 — the boundary is DERIVED, not typed in. This test used to plant a
  // 120-minute-old tail against a hard 15-minute ceiling; the tail cadence
  // change moved the ceiling to 180, so a fixed 120 would now be judged fresh
  // and the assertion would have been quietly inverted. Reading the ceiling
  // from the same function the service reads means the test cannot drift out
  // from under the behaviour again.
  const { seedableMaxTailAgeMs, DEFAULT_COLLECTOR_OPTIONS: D } = await import("../dist/src/candles/collector.js");
  const ceilingMin = seedableMaxTailAgeMs(D) / MINUTE_MS;
  const s = await deepSymbolBehind(ceilingMin + 30);
  assert.equal(s.counts.seedable, 0, "a stale tail cannot be seedable — the bot would reject it against the venue");
  assert.equal(s.counts.backfilling, 1);
});

await test("...but a tail INSIDE the polling cadence is seedable — that is the trade A bought", async () => {
  // The operator approved relaxing freshness so tail requests carry a full page
  // instead of ~29 rows. A symbol polled on schedule is up to `tailFillMinutes`
  // behind; if that read as un-seedable the collector would be working
  // perfectly and the panel would report nothing servable.
  const { DEFAULT_COLLECTOR_OPTIONS: D } = await import("../dist/src/candles/collector.js");
  const s = await deepSymbolBehind(D.tailFillMinutes);
  assert.equal(s.counts.seedable, 1, "a symbol polled on cadence is servable");
  assert.equal(s.counts.backfilling, 0);
});

await test("newly listed pairs are counted and named, with the still-backfilling ones separated", async () => {
  const venue = stubVenue({ symbols: ["OLDUSDT"] });
  const { svc } = serviceWith("bitget", venue.fetchLike);
  const c = svc.collector("bitget");
  // OLDUSDT first seen ten days ago.
  await c.refreshSymbols(venue.fetchLike, NOW - 10 * 86_400_000);
  // FRESHUSDT appears an hour ago.
  venue.state.symbols = ["OLDUSDT", "FRESHUSDT"];
  await c.refreshSymbols(venue.fetchLike, NOW - 3_600_000);

  const s = svc.status(NOW).find((v) => v.venue === "bitget");
  assert.equal(s.counts.newLast24h, 1, "only FRESHUSDT is new");
  assert.equal(s.counts.newLast24hBackfilling, 1, "and it is not seedable yet");
  assert.deepEqual(s.newlyListed.map((n) => n.symbol), ["FRESHUSDT"], "named, so 'why is this coin not trading' is answerable on sight");
  assert.equal(s.newlyListed[0].firstSeenAt, NOW - 3_600_000);
});

// ── PACING AND BACKOFF ──────────────────────────────────────────────────────
// The collector used to fire its ENTIRE per-minute budget back-to-back and then
// sit idle. The average was the configured rate; the instantaneous rate was
// whatever latency allowed, which is the window venues actually limit on — and
// the operator's box duly collected `bitunix code 10006: request too frequently`
// and `ONDOUSDT: HTTP 429`. Worse, a refusal was counted as a plain failure and
// retried at the same rate on the next tick, so a rate-limited backfill spent
// its whole budget on rejections and could never converge.
//
// The clock here is FROZEN, so every paced request asks for a sleep and the
// spacing is a fact of the fixture rather than of how fast this machine runs.

/** A service whose pacing clock the test drives by hand. */
function pacedService(venue, fetchLike, overrides = {}) {
  let t = NOW;
  const built = serviceWith(venue, fetchLike, overrides, { now: () => t });
  return { ...built, advance: (ms) => { t += ms; }, at: () => t };
}

await test("requests are SPACED at the configured rate, not fired in one burst", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT"] });
  const { svc, slept } = pacedService("bitget", venue.fetchLike);
  await svc.tickAll(NOW);

  // 1 symbol-list request + 4 klines, each waiting its turn behind the last.
  assert.ok(slept.length >= 4, `every request after the first waits its turn (got ${slept.length})`);
  // 3.2/s -> a 313 ms gap. The clock is frozen, so the n-th request is asked to
  // wait n gaps: the pacing is cumulative and does NOT reset per request.
  const gap = Math.round(1000 / DEFAULT_COLLECTOR_OPTIONS.requestsPerSecond);
  assert.equal(slept[0], gap, "the second request waits one gap");
  assert.equal(slept[1], gap * 2, "the third waits two — the schedule advances, it does not reset");
  assert.ok(venue.state.requests.length >= 5, "and all the work still happened");
});

await test("the pacing schedule CARRIES ACROSS ticks — no burst at the tick boundary", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT", "BBBUSDT"] });
  const { svc, slept, advance } = pacedService("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  const firstTick = slept.length;
  // Only a hair of real time passes before the next tick.
  advance(10);
  await svc.tickAll(NOW + MINUTE_MS);
  assert.ok(slept.length > firstTick, "the next tick still waits its turn rather than restarting at full speed");
});

await test("a rate limit STOPS the pass instead of spending the rest of the budget on refusals", async () => {
  // Ten symbols, refused from the third kline on. The old loop would have burned
  // all ten slots; this one must stop at the refusal.
  const symbols = Array.from({ length: 10 }, (_, i) => `S${i}USDT`);
  const venue = stubVenue({ symbols, limitAfter: 2 });
  const { svc } = pacedService("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  assert.equal(venue.state.klineRequests, 3, "two served, one refused, then silence — not ten");
});

await test("a rate limit is NOT a failure: the venue reads COOLING, never FAILING", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT"], limitAfter: 0 });
  const { svc } = pacedService("bitget", venue.fetchLike);
  // failingAfter is 5; refuse far more often than that.
  for (let i = 0; i < 8; i++) await svc.tickAll(NOW);
  const h = svc.collector("bitget").health(NOW);
  assert.equal(h.state, "cooling", "backing off is not the collector failing");
  assert.equal(h.consecutiveFailures, 0, "and a refusal never counts toward FAILING");
  assert.ok(h.rateLimitHits > 0, "the refusals are counted, under their own name");
  assert.match(h.detail, /rate limited/, "and the panel says why it is quiet");
});

await test("while cooling it makes NO request at all — the point of a cooldown is silence", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT"], limitAfter: 0 });
  const { svc } = pacedService("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  assert.ok(venue.state.requests.length > 0, "precondition: it did try once");
  venue.state.requests.length = 0;
  await svc.tickAll(NOW + MINUTE_MS);
  assert.equal(venue.state.requests.length, 0, "not even the symbol list is asked for");
});

await test("the backoff DOUBLES per consecutive refusal and is capped", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT"], limitAfter: 0 });
  const { svc, advance, at } = pacedService("bitget", venue.fetchLike, {
    rateLimitCooldownMs: 1_000, rateLimitMaxCooldownMs: 4_000,
  });
  const waits = [];
  for (let i = 0; i < 5; i++) {
    await svc.tickAll(at());
    waits.push(svc.collector("bitget").health(at()).cooldownUntil - at());
    advance(waits.at(-1) + 1); // ride out the cooldown so the next tick tries again
  }
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 4_000, 4_000], "1s, 2s, 4s, then held at the cap");
});

await test("the rate HALVES on a refusal and never goes below the floor", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT"], limitAfter: 0 });
  const { svc, advance, at } = pacedService("bitget", venue.fetchLike, {
    requestsPerSecond: 4, minRequestsPerSecond: 1, rateLimitCooldownMs: 1_000, rateLimitMaxCooldownMs: 1_000,
  });
  const seen = [];
  for (let i = 0; i < 5; i++) {
    await svc.tickAll(at());
    seen.push(svc.collector("bitget").health(at()).effectiveRps);
    advance(1_001);
  }
  assert.deepEqual(seen, [2, 1, 1, 1, 1], "4 -> 2 -> 1, then the floor holds it");
  assert.ok(seen.every((r) => r >= 1), "a limited venue is still polled slowly, never abandoned");
});

await test("a backed-off collector gets a SMALLER budget, not the same one spread thinner", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT"], limitAfter: 0 });
  const { svc, advance, at } = pacedService("bitget", venue.fetchLike, {
    requestsPerSecond: 4, minRequestsPerSecond: 0.5, rateLimitCooldownMs: 1_000, rateLimitMaxCooldownMs: 1_000,
  });
  const c = svc.collector("bitget");
  assert.equal(c.budgetFor(60_000), 240, "4/s over a minute");
  await svc.tickAll(at());
  advance(1_001);
  assert.equal(c.budgetFor(60_000), 120, "after one refusal, half as many requests are permitted");
});

await test("a venue's own Retry-After wins when it asks for LONGER than we chose", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT"], limitAfter: 0, retryAfter: "300" });
  const { svc, at } = pacedService("bitget", venue.fetchLike, {
    rateLimitCooldownMs: 1_000, rateLimitMaxCooldownMs: 2_000,
  });
  await svc.tickAll(at());
  assert.equal(svc.collector("bitget").health(at()).cooldownUntil - at(), 300_000, "we wait the 300s it asked for");
});

await test("a SHORTER Retry-After does not talk us back into the rate just refused", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT"], limitAfter: 0, retryAfter: "1" });
  const { svc, at } = pacedService("bitget", venue.fetchLike, {
    rateLimitCooldownMs: 30_000, rateLimitMaxCooldownMs: 60_000,
  });
  await svc.tickAll(at());
  assert.equal(svc.collector("bitget").health(at()).cooldownUntil - at(), 30_000, "our own backoff stands");
});

await test("the venue-BODY shape of a rate limit backs off the same as an HTTP 429", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT"], limitAfter: 0, limitAs: "body" });
  const { svc, at } = pacedService("bitget", venue.fetchLike);
  await svc.tickAll(at());
  const h = svc.collector("bitget").health(at());
  assert.equal(h.state, "cooling", "a 200 carrying a too-many-requests code is still a refusal");
  assert.equal(h.consecutiveFailures, 0);
});

await test("recovery creeps back up and NEVER climbs above the configured ceiling", async () => {
  // Refuse once to knock the rate down, then serve cleanly for a long run.
  const symbols = Array.from({ length: 40 }, (_, i) => `S${i}USDT`);
  const venue = stubVenue({ symbols, limitAfter: 0 });
  const { svc, advance, at } = pacedService("bitget", venue.fetchLike, {
    requestsPerSecond: 4, minRequestsPerSecond: 0.5, rateLimitCooldownMs: 1_000, rateLimitMaxCooldownMs: 1_000,
  });
  await svc.tickAll(at());
  assert.equal(svc.collector("bitget").health(at()).effectiveRps, 2, "knocked down to half");

  venue.state.limitAfter = null; // the venue is happy again
  advance(1_001);
  let ticks = 0;
  while (svc.collector("bitget").health(at()).effectiveRps < 4 && ticks < 40) {
    advance(MINUTE_MS);
    await svc.tickAll(at());
    ticks++;
  }
  const rps = svc.collector("bitget").health(at()).effectiveRps;
  assert.ok(rps > 2, `it does climb back (${rps})`);
  assert.ok(rps <= 4, "and stops at the ceiling — the configured rate is a maximum, not a target");
});

// ── PAGE UTILISATION ────────────────────────────────────────────────────────
// MEASURED on the operator's box: 202 requests returned 5,768 candles — 28.6
// rows against a 200-row page, i.e. 14% utilisation. A symbol entered the tail
// queue the moment it was one minute behind, so with 703 symbols each request
// collected only the ~29 minutes a sweep took, and backfill — the second half
// of the queue — never got a turn at all. A rate-limited venue could not
// converge, however long it ran.

await test("a symbol one minute behind is NOT polled — a request must carry a page", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT"] });
  const { svc } = pacedService("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  const first = venue.state.klineRequests;
  assert.ok(first > 0, "precondition: the first pass collects it");

  // One minute later it is one minute behind. That used to be a whole request
  // spent collecting one candle. The pass still WORKS — it digs instead — so
  // the assertion is on the tail specifically, not on request count: the newest
  // held candle must not advance, because nobody chased it.
  const tailBefore = svc.collector("bitget").coverage("AAAUSDT").lastClosedMs;
  venue.state.requests.length = 0;
  await svc.tickAll(NOW + MINUTE_MS);
  assert.equal(svc.collector("bitget").coverage("AAAUSDT").lastClosedMs, tailBefore,
    "the tail was not chased for one minute of backlog");
  const newest = newestClosedOpenMs(NOW + MINUTE_MS);
  assert.ok(!venue.state.requests.some((u) => u.includes(`endTime=${newest}`)),
    "and no request reached for the newest minute — every one was backfill");
});

await test("...and IS polled once it has a page's worth of backlog", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT"] });
  const { svc } = pacedService("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  const before = venue.state.klineRequests;
  const due = NOW + (DEFAULT_COLLECTOR_OPTIONS.tailFillMinutes + 1) * MINUTE_MS;
  venue.state.now = due;
  await svc.tickAll(due);
  assert.ok(venue.state.klineRequests > before, "the backlog is now worth a request");
});

await test("a symbol with NOTHING is polled immediately — the cadence is for a tail, not a cold start", async () => {
  // A brand-new listing must not wait 150 minutes for its first candle.
  const venue = stubVenue({ symbols: ["AAAUSDT"] });
  const { svc } = pacedService("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  assert.notEqual(svc.collector("bitget").coverage("AAAUSDT").lastClosedMs, null, "collected on the very first pass");
});

await test("the freed budget REACHES backfill — that is the entire point", async () => {
  // One symbol, already current on its tail but shallow. Under the old rule the
  // tail was re-requested every pass and depth never advanced.
  const venue = stubVenue({ symbols: ["AAAUSDT"] });
  const { svc } = pacedService("bitget", venue.fetchLike);
  await svc.tickAll(NOW);
  const oldestAfterFirst = svc.collector("bitget").coverage("AAAUSDT").firstClosedMs;
  // A minute later: the tail is not due, so the pass must spend itself digging.
  await svc.tickAll(NOW + MINUTE_MS);
  const oldestNow = svc.collector("bitget").coverage("AAAUSDT").firstClosedMs;
  assert.ok(oldestNow < oldestAfterFirst, `backfill advanced (${oldestAfterFirst} -> ${oldestNow})`);
});

await test("the SEEDABLE ceiling is derived from the cadence, never set beside it", async () => {
  // THE BUG THIS PREVENTS: poll every 150 minutes, judge seedable at 15, and
  // every symbol is permanently un-seedable while the collector works
  // perfectly. Two constants that must agree are two that will not.
  const { seedableMaxTailAgeMs, DEFAULT_COLLECTOR_OPTIONS: D } = await import("../dist/src/candles/collector.js");
  assert.ok(seedableMaxTailAgeMs(D) > D.tailFillMinutes * MINUTE_MS,
    "the ceiling is above the polling cadence, so a symbol polled on time is fresh");
  // And it tracks a changed cadence rather than staying put.
  assert.ok(seedableMaxTailAgeMs({ tailFillMinutes: 600 }) > seedableMaxTailAgeMs({ tailFillMinutes: 150 }),
    "a longer cadence raises the ceiling with it");
});

await test("an ORDINARY error still counts toward FAILING — backoff did not swallow real faults", async () => {
  const venue = stubVenue({ symbols: ["AAAUSDT"], failWith: "connect ECONNREFUSED" });
  const { svc, at } = pacedService("bitget", venue.fetchLike);
  for (let i = 0; i < 6; i++) await svc.tickAll(at());
  const h = svc.collector("bitget").health(at());
  assert.equal(h.state, "failing", "a broken venue is still reported broken");
  assert.equal(h.rateLimitHits, 0, "and it is not miscounted as a rate limit");
});

// ── ADMIN ROUTE ─────────────────────────────────────────────────────────────

await test("the admin candles route needs the admin token and reports every venue", async () => {
  const un = await jsonReq(`${h.origin}/admin/api/candles`);
  assert.equal(un.status, 401, "no admin token, no status");
  const r = await jsonReq(`${h.origin}/admin/api/candles`, { headers: { "x-hub-admin": h.cfg.adminToken } });
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false, "this test hub runs no collector");
  assert.equal(r.body.keyId, "seed-1");
  assert.equal(r.body.requiresLicense, true);
  assert.deepEqual(r.body.venues.map((v) => v.venue), ["bybit", "bitunix", "bitget"]);
  assert.ok(r.body.venues.every((v) => v.configured === false), "all three say 'no collector configured'");
  assert.ok(typeof r.body.seedPublicKey === "string" && r.body.seedPublicKey.length > 0, "public key offered for pairing");
});

await test("the admin page carries the per-exchange panel and refreshes it with the rest", async () => {
  const page = await (await fetch(`${h.origin}/admin`)).text();
  assert.match(page, /id="venues"/, "a container for the venue cards");
  assert.match(page, /admin\/api\/candles/, "wired to the status route");
  assert.match(page, /NO COLLECTOR/, "an unconfigured venue says so rather than showing zeroes");
  for (const field of ["seedable", "backfilling", "gapped", "Oldest candle", "Newest candle", "Missing minutes", "Worst gaps", "New in 24h"]) {
    assert.ok(page.includes(field), `panel states ${field}`);
  }
  assert.match(page, /document\.getElementById\("refresh"\)\.onclick = \(\) => \{ refresh\(\); cdRefresh\(\); fbRefresh\(\); \}/,
    "the page's Refresh button refreshes the venue cards too");
});

await h.close();
summary("candles-http");
