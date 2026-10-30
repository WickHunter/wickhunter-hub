// tests/bitunix-fold.test.mjs — v0.4.102: the Bitunix 1m websocket fold and
// the Bitunix base-volume contract.
//
// The fixture is the app repo's live public capture
// (docs/audit-2026-10-29/BITUNIX-KLINE-BOUNDARY-20261029.json, 67 pairs x 15
// boundaries, frames within ±6 s of each boundary, REST read afterwards). It
// is replayed through the Hub's REAL adapter parse and the REAL fold, and every
// bar the fold closes must equal the venue's REST row on o/h/l/c AND on volume
// read as `baseVol` — which pins the unit as well as the boundary rule.
//
// MUTATION EVIDENCE (each applied to an isolated copy of dist, this suite
// re-run; all RED on 2026-10-30):
//   M1 fold: an equal ts is dropped (the pre-fix fence) → replay red.
//   M2 fold: close a candidate without the seed-open proof → "seed mismatch" red.
//   M3 fold: no finalise window → "late frames" red.
//   M4 stream: generic ClosureBuffer for bitunix → replay red (stale tails).
//   M5 REST reads quoteVol again → "REST vs WS units" red.
//   M6 no quote-consistency check → "coin-margined" red.
//   M7 migration keeps the timeframe cache → "stored data" red.
//   M8 migration ignores a rollback → "rollback" red.
//   M9 listSymbols tracks USD contracts → "linear" red.
//   M10 the marker dir is created on a Hub without Bitunix → "fresh" red.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, summary } from "./helpers.mjs";
import { STREAM_ADAPTERS, ClosureBuffer } from "../dist/src/candles/stream.js";
import { BitunixClosureBuffer, BITUNIX_FINALISE_WINDOW_MS } from "../dist/src/candles/bitunix-fold.js";
import { bitunixBaseVolume } from "../dist/src/candles/bitunix-volume.js";
import { ADAPTERS, fetchNativeTimeframeKlines } from "../dist/src/candles/venues.js";

const MIN = 60_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "bitunix-kline-boundary-20261029.json"), "utf8"));
const adapter = STREAM_ADAPTERS.bitunix;

const frame = (symbol, [ts, o, h, l, c, b, q]) =>
  JSON.stringify({ ch: "market_kline_1min", symbol, ts, data: { o, c, h, l, b, q } });

function replay(symbol, rows, closer = adapter.closer()) {
  const closed = [];
  const unresolved = [];
  if (closer instanceof BitunixClosureBuffer) closer.onUnresolved = (s, from, through, reason) => unresolved.push({ from, through, reason });
  for (const r of rows) {
    for (const t of adapter.parse(frame(symbol, r))) {
      const done = closer.push(t);
      if (done) closed.push(done.candle);
    }
  }
  return { closed, unresolved, closer };
}

const linear = (s) => /USD[TC]$/.test(s);

await test("replay of the 2026-10-29 capture: every closed bar equals REST on o/h/l/c and BASE volume", () => {
  let closedTotal = 0, compared = 0, finalised = 0;
  const mismatches = [];
  for (const symbol of CAPTURE.symbols) {
    if (!linear(symbol)) continue;
    const { closed, closer } = replay(symbol, CAPTURE.frames[symbol] ?? []);
    finalised += closer.stats.closedFinalised;
    closedTotal += closed.length;
    const rest = new Map((CAPTURE.rest[symbol] ?? []).map((r) => [Number(r.time), r]));
    for (const c of closed) {
      const r = rest.get(c.openMs);
      if (!r) continue;
      compared++;
      const same = c.open === Number(r.open) && c.high === Number(r.high) && c.low === Number(r.low)
        && c.close === Number(r.close) && c.volume === Number(r.baseVol);
      if (!same) mismatches.push({ symbol, c, r });
    }
  }
  assert.deepEqual(mismatches.slice(0, 3), [], `${mismatches.length} closed bars disagree with REST`);
  assert.ok(closedTotal >= 850, `the fold closes the venue's bars (closed ${closedTotal})`);
  assert.ok(compared >= 800, `most closed bars are comparable with the REST read (compared ${compared})`);
  assert.ok(finalised >= 800, `closures come from the finalisation + seed proof (finalised ${finalised})`);
});

await test("coin-margined USD pairs never close a bar (their b/q fail the base-volume proof)", () => {
  for (const symbol of CAPTURE.symbols.filter((s) => !linear(s))) {
    const { closed } = replay(symbol, CAPTURE.frames[symbol] ?? []);
    assert.equal(closed.length, 0, symbol);
  }
});

await test("the pre-0.4.102 generic rule on the same capture publishes stale pre-boundary snapshots", () => {
  // The motivating defect, pinned: the old rule disagrees with REST on a large
  // share of minutes; the new fold disagrees on none (test above).
  let wrong = 0, compared = 0;
  for (const symbol of CAPTURE.symbols.filter(linear)) {
    const { closed } = replay(symbol, CAPTURE.frames[symbol] ?? [], new ClosureBuffer());
    const rest = new Map((CAPTURE.rest[symbol] ?? []).map((r) => [Number(r.time), r]));
    for (const c of closed) {
      const r = rest.get(c.openMs); if (!r) continue; compared++;
      if (c.close !== Number(r.close) || c.volume !== Number(r.baseVol) || c.open !== Number(r.open)) wrong++;
    }
  }
  assert.ok(compared > 0 && wrong > compared * 0.2, `old rule wrong on ${wrong}/${compared}`);
});

// ── synthetic negatives ─────────────────────────────────────────────────────
const T0 = 1_793_300_400_000; // a minute boundary
const SYM = "BTCUSDT";
// [ts, o, h, l, c, b, q] with q = b * c so the volume proof holds.
const row = (ts, o, h, l, c, b) => [ts, String(o), String(h), String(l), String(c), String(b), String(b * c)];
function feed(rows) { return replay(SYM, rows); }
// A bar M = [T0-60s, T0): seeded at 100, trades to 101, then a finalisation and seed.
const seedM = row(T0 - MIN + 150, 100, 100, 100, 100, 0);
const midM = row(T0 - 30_000, 100, 101, 99, 100.5, 2);
const lastM = row(T0 - 2_000, 100, 101, 99, 100.6, 3);
const finalM = row(T0 + 150, 100, 101.2, 99, 100.8, 4);
const seedN = row(T0 + 150, 100.8, 100.8, 100.8, 100.8, 0);

await test("finalisation + same-ts seed closes M with the FINAL snapshot", () => {
  const { closed } = feed([seedM, midM, lastM, finalM, seedN]);
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0], { openMs: T0 - MIN, open: 100, high: 101.2, low: 99, close: 100.8, volume: 4 });
});

await test("no finalisation frame (2026-10-09 regime): the legacy seeded-open rule still closes", () => {
  const seedAtLast = row(T0 + 200, 100.6, 100.6, 100.6, 100.6, 0);
  const { closed } = feed([seedM, midM, lastM, seedAtLast]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].close, 100.6);
});

await test("seed mismatch → unresolved, not closed", () => {
  const badSeed = row(T0 + 150, 100.9, 100.9, 100.9, 100.9, 0);
  const { closed, unresolved } = feed([seedM, midM, lastM, finalM, badSeed]);
  assert.equal(closed.length, 0);
  assert.deepEqual(unresolved.map((u) => [u.from, u.reason]), [[T0 - MIN, "stale-tail"]]);
});

await test("late frames: a finalisation or seed outside the window never closes", () => {
  const lateFinal = row(T0 + BITUNIX_FINALISE_WINDOW_MS + 1, 100, 101.2, 99, 100.8, 4);
  const lateSeed = row(T0 + BITUNIX_FINALISE_WINDOW_MS + 2, 100.8, 100.8, 100.8, 100.8, 0);
  let r = feed([seedM, midM, lastM, lateFinal, lateSeed]);
  assert.equal(r.closed.length, 0, "late finalisation");
  r = feed([seedM, midM, lastM, finalM, lateSeed]);
  assert.equal(r.closed.length, 0, "late seed after an in-window finalisation");
  assert.equal(r.unresolved[0].reason, "ambiguous-boundary");
});

await test("an older ts is dropped and an exact equal-ts duplicate is dropped", () => {
  const stale = row(T0 - 40_000, 100, 101, 99, 100.1, 1.5);
  const { closed, closer } = feed([seedM, midM, stale, lastM, lastM, finalM, finalM, seedN]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].close, 100.8);
  assert.equal(closer.stats.dropped, 3);
});

await test("a volume decrease inside one bar breaks its identity → unresolved", () => {
  const lower = row(T0 - 10_000, 100, 101, 99, 100.4, 1);
  const { closed, unresolved } = feed([seedM, midM, lower, lastM, finalM, seedN]);
  assert.equal(closed.length, 0);
  assert.equal(unresolved[0].reason, "ambiguous-boundary");
});

await test("reconnect: after clear(), a traded first frame is price-only until a seed", () => {
  const closer = adapter.closer();
  replay(SYM, [seedM, midM], closer);
  closer.clear();
  const r = replay(SYM, [lastM, finalM, seedN], closer);
  assert.equal(r.closed.length, 0, "M was not observed from its seed on this socket");
  // ... and the next full bar closes normally.
  const midN = row(T0 + 30_000, 100.8, 101, 100.7, 100.9, 1);
  const finN = row(T0 + MIN + 100, 100.8, 101, 100.7, 100.95, 1.2);
  const seedO = row(T0 + MIN + 100, 100.95, 100.95, 100.95, 100.95, 0);
  const r2 = replay(SYM, [midN, finN, seedO], closer);
  assert.equal(r2.closed.length, 1);
  assert.equal(r2.closed[0].openMs, T0);
});

await test("a silent pair (skipped minutes) publishes nothing for the skipped span", () => {
  const seedLater = row(T0 + 3 * MIN + 100, 100.6, 100.6, 100.6, 100.6, 0);
  const { closed, unresolved } = feed([seedM, midM, lastM, finalM, seedLater]);
  assert.equal(closed.length, 0);
  assert.equal(unresolved[0].reason, "silent");
  assert.equal(unresolved[0].from, T0 - MIN);
  assert.equal(unresolved[0].through, T0 + 2 * MIN);
});

await test("a zero-volume minute closes from its flat finalisation and seed", () => {
  const flatFinal = row(T0 + 120, 100, 100, 100, 100, 0);
  const seedFlat = row(T0 + 120, 100, 100, 100, 100, 0);
  const { closed } = feed([seedM, flatFinal, seedFlat]);
  // The repeated flat seed is the same untraded bar; the next bucket's seed
  // opens at its close: closed by the legacy rule with zero volume (REST has it).
  assert.equal(closed.length, 1);
  assert.equal(closed[0].volume, 0);
});

// ── volume units ────────────────────────────────────────────────────────────
await test("bitunixBaseVolume: base proven by turnover; contradiction, swap and one-sided zero are unknown", () => {
  assert.equal(bitunixBaseVolume("28.2534", "2185328.73403", 77308.9, 77371.2), 28.2534);
  assert.equal(bitunixBaseVolume("2185328.73403", "28.2534", 77308.9, 77371.2), null, "swapped labels refused");
  assert.equal(bitunixBaseVolume("145.05473", "1834.973872936507", 0.079, 0.07908), null, "coin-margined refused");
  assert.equal(bitunixBaseVolume("0", "0", 1, 1), 0);
  assert.equal(bitunixBaseVolume("0", "5", 1, 1), null);
  assert.equal(bitunixBaseVolume("", "5", 1, 1), null);
  assert.equal(bitunixBaseVolume(undefined, "5", 1, 1), null);
  assert.equal(bitunixBaseVolume("1", "1", 0, 1), null, "nonpositive low");
});

const restBody = (rows) => ({ code: 0, data: rows });
const fetchJson = (body) => async () => ({ ok: true, status: 200, json: async () => body });

await test("REST vs WS units: the same minute stores the same base volume from either path", async () => {
  const r = CAPTURE.rest.BTCUSDT.find((x) => Number(x.time) === T0 - 2 * MIN) ?? CAPTURE.rest.BTCUSDT[3];
  const page = await ADAPTERS.bitunix.fetchKlines(fetchJson(restBody([r])), "BTCUSDT", Number(r.time), Number(r.time));
  assert.equal(page.candles.length, 1);
  assert.equal(page.candles[0].volume, Number(r.baseVol), "REST stores baseVol");
  const [t] = adapter.parse(frame("BTCUSDT", [Number(r.time) + 59_000, r.open, r.high, r.low, r.close, r.baseVol, r.quoteVol]));
  assert.equal(t.candle.volume, page.candles[0].volume, "WS b equals REST baseVol");
  const tf = await fetchNativeTimeframeKlines(fetchJson(restBody([{ ...r, time: String(Math.floor(Number(r.time) / (5 * MIN)) * 5 * MIN) }])), "bitunix", "BTCUSDT", 5,
    Math.floor(Number(r.time) / (5 * MIN)) * 5 * MIN, Math.floor(Number(r.time) / (5 * MIN)) * 5 * MIN);
  assert.equal(tf.candles[0].volume, Number(r.baseVol), "native timeframe pages use the same contract");
});

await test("contradiction: a REST page whose units cannot be proven is refused whole; a WS frame is ignored", async () => {
  const good = { time: String(T0 - MIN), open: "100", high: "101", low: "99", close: "100", baseVol: "2", quoteVol: "200" };
  const swapped = { time: String(T0 - 2 * MIN), open: "100", high: "101", low: "99", close: "100", baseVol: "200", quoteVol: "2" };
  await assert.rejects(ADAPTERS.bitunix.fetchKlines(fetchJson(restBody([good, swapped])), "BTCUSDT", T0 - 2 * MIN, T0 - MIN), /volume is unreadable or contradictory/);
  assert.deepEqual(adapter.parse(frame("BTCUSDT", [T0, "100", "101", "99", "100", "200", "2"])), []);
});

await test("listSymbols tracks linear USDT/USDC contracts only", async () => {
  const body = { data: [
    { symbol: "BTCUSDT", quote: "USDT", symbolStatus: "OPEN" },
    { symbol: "BTCUSDC", quote: "USDC", symbolStatus: "OPEN" },
    { symbol: "DOGEUSD", quote: "USD", symbolStatus: "OPEN" },
    { symbol: "ETHUSDT", symbolStatus: "PREVIEW" },
    { symbol: "XLMUSD", symbolStatus: "OPEN" },
  ] };
  const out = await ADAPTERS.bitunix.listSymbols(fetchJson(body));
  assert.deepEqual(out, [
    { symbol: "BTCUSDT", tradable: true }, { symbol: "BTCUSDC", tradable: true }, { symbol: "ETHUSDT", tradable: false },
  ]);
});

// ── stored data: the one-shot discard of the mixed-unit store ───────────────
import { migrateBitunixVolumeContract, BITUNIX_VOLUME_MARKER } from "../dist/src/candles/bitunix-migration.js";
import { BITUNIX_VOLUME_CONTRACT } from "../dist/src/candles/bitunix-volume.js";
import { tmpDir } from "./helpers.mjs";

function legacyDataDir() {
  const d = tmpDir("bitunix-migration");
  const put = (rel, text = "x") => { const f = path.join(d, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put("candles/bitunix/BTCUSDT/2026-10-28.c1m");
  put("candles/bitunix/ETHUSDT/2026-10-29.c1m");
  put("candles/bitunix/symbols.json", JSON.stringify({ symbols: { BTCUSDT: { symbol: "BTCUSDT" } } }));
  put("candles/bitunix/rest-frontier.json", JSON.stringify({ restConfirmed: { BTCUSDT: 60_000 } }));
  put("candles/bybit/BTCUSDT/2026-10-28.c1m");
  put("candles/bybit/rest-frontier.json", JSON.stringify({ restConfirmed: { BTCUSDT: 60_000 } }));
  put("candle-timeframes-v2/bitunix/BTCUSDT/60/2026-10-28.tf");
  put("candle-timeframes-v2/bybit/BTCUSDT/60/2026-10-28.tf");
  put("candle-timeframes-v2/native-frontier.v2.json", JSON.stringify({ v: 2, frontiers: { "bitunix\u0000BTCUSDT\u000060": 1, "bybit\u0000BTCUSDT\u000060": 2 } }));
  return d;
}
const exists = (d, rel) => fs.existsSync(path.join(d, rel));

await test("stored data: pre-contract Bitunix rows are discarded once; other venues and the roster are untouched", () => {
  const d = legacyDataDir();
  const logs = [];
  try {
    const r = migrateBitunixVolumeContract(d, (m) => logs.push(m));
    assert.equal(r.migrated, true);
    assert.equal(r.removedSymbols, 2);
    assert.equal(r.removedTimeframeSymbols, 1);
    assert.equal(r.removedFrontiers, 1);
    assert.ok(!exists(d, "candles/bitunix/BTCUSDT") && !exists(d, "candles/bitunix/ETHUSDT"));
    assert.ok(!exists(d, "candles/bitunix/rest-frontier.json"), "no REST frontier vouches for discarded rows");
    assert.ok(exists(d, "candles/bitunix/symbols.json"), "the roster carries no candle values");
    assert.ok(!exists(d, "candle-timeframes-v2/bitunix"));
    assert.ok(exists(d, "candles/bybit/BTCUSDT/2026-10-28.c1m") && exists(d, "candles/bybit/rest-frontier.json"));
    assert.ok(exists(d, "candle-timeframes-v2/bybit/BTCUSDT/60/2026-10-28.tf"));
    const nf = JSON.parse(fs.readFileSync(path.join(d, "candle-timeframes-v2/native-frontier.v2.json"), "utf8"));
    assert.deepEqual(Object.keys(nf.frontiers), ["bybit\u0000BTCUSDT\u000060"]);
    assert.equal(fs.readFileSync(path.join(d, "candles/bitunix", BITUNIX_VOLUME_MARKER), "utf8").trim(), BITUNIX_VOLUME_CONTRACT);
    assert.equal(logs.length, 1);
    // Second boot: marker present, new rows written under the contract → no-op.
    fs.mkdirSync(path.join(d, "candles/bitunix/BTCUSDT"), { recursive: true });
    fs.writeFileSync(path.join(d, "candles/bitunix/BTCUSDT/2026-10-30.c1m"), "new");
    fs.writeFileSync(path.join(d, "candles/bitunix/rest-frontier.json"), JSON.stringify({ restConfirmed: {}, volumeContract: BITUNIX_VOLUME_CONTRACT }));
    const again = migrateBitunixVolumeContract(d, (m) => logs.push(m));
    assert.equal(again.migrated, false);
    assert.ok(exists(d, "candles/bitunix/BTCUSDT/2026-10-30.c1m"), "base-volume rows survive later boots");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

await test("stored data: a rollback to <=0.4.101 after the migration is detected and its rows discarded again", () => {
  const d = legacyDataDir();
  try {
    migrateBitunixVolumeContract(d);
    // 0.4.101 runs: re-collects quote turnover, rewrites the frontier without the field.
    fs.mkdirSync(path.join(d, "candles/bitunix/BTCUSDT"), { recursive: true });
    fs.writeFileSync(path.join(d, "candles/bitunix/BTCUSDT/2026-10-30.c1m"), "quote");
    fs.writeFileSync(path.join(d, "candles/bitunix/rest-frontier.json"), JSON.stringify({ restConfirmed: { BTCUSDT: 60_000 } }));
    const r = migrateBitunixVolumeContract(d);
    assert.equal(r.migrated, true);
    assert.ok(!exists(d, "candles/bitunix/BTCUSDT"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

await test("stored data: a fresh Bitunix-collecting install only writes the marker; a Hub without Bitunix creates nothing", () => {
  const d = tmpDir("bitunix-fresh");
  try {
    const r = migrateBitunixVolumeContract(d);
    assert.equal(r.migrated, false);
    assert.ok(exists(d, `candles/bitunix/${BITUNIX_VOLUME_MARKER}`));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  const e = tmpDir("bitunix-none");
  try {
    migrateBitunixVolumeContract(e, () => {}, false);
    assert.deepEqual(fs.readdirSync(e), [], "no candles dir appears in a Hub that does not collect");
  } finally { fs.rmSync(e, { recursive: true, force: true }); }
  const f = legacyDataDir();
  try {
    assert.equal(migrateBitunixVolumeContract(f, () => {}, false).migrated, true, "stale data is still discarded when Bitunix collection was turned off");
  } finally { fs.rmSync(f, { recursive: true, force: true }); }
});

await test("the Bitunix collector's REST frontier names the volume contract it vouches for", async () => {
  const { VenueCollector, DEFAULT_COLLECTOR_OPTIONS } = await import("../dist/src/candles/collector.js");
  const { CandleStore } = await import("../dist/src/candles/store.js");
  const d = tmpDir("bitunix-frontier");
  try {
    const now = 1_793_328_600_000;
    const store = new CandleStore(d);
    const c = new VenueCollector("bitunix", store, d, DEFAULT_COLLECTOR_OPTIONS, now, () => {});
    const fetchLike = async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/trading_pairs")) return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ symbol: "BTCUSDT", quote: "USDT", symbolStatus: "OPEN" }] }) };
      const end = Number(u.searchParams.get("endTime"));
      const t = Math.floor(Math.min(end, now - 2 * MIN) / MIN) * MIN;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ time: String(t), open: "1", high: "1", low: "1", close: "1", baseVol: "2", quoteVol: "2" }] }) };
    };
    let clock = now;
    await c.tick(fetchLike, 3, now, { clock: () => clock, sleep: async (ms) => { clock += ms; } });
    const f = JSON.parse(fs.readFileSync(path.join(d, "bitunix", "rest-frontier.json"), "utf8"));
    assert.equal(f.volumeContract, BITUNIX_VOLUME_CONTRACT);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

summary("bitunix-fold");
