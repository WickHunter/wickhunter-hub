// tests/candle-warming.test.mjs — v0.4.102: status coverage after boot.
//
// Live 2026-10-30 (all six collectors running and fresh): `warming` 205 of
// 813 Bybit, 176 Bitunix, 280 Bitget symbols hours after a restart. An
// unprimed symbol also gets NO REST work from `workQueue`. Three causes, one
// regression each:
//   1. the per-tick prime slice was bounded by WALL time including its
//      `setImmediate` yields, so on a busy loop it primed one symbol a tick;
//   2. nothing primed the roster except that slice (32 per 60 s tick);
//   3. retention pruned a day from every symbol at the UTC day change and
//      threw every exact coverage row away with it.
// MUTATION EVIDENCE (isolated dist copy; all RED 2026-10-30):
//   W1 slice bound back to wall time → "busy loop" red.
//   W2 no background prime at start → "boot" red.
//   W4 the prime runs every venue concurrently → "one venue per turn" red.
//   W5 a turn ignores its scan budget → "one venue per turn" red.
//   W3 prune drops coverage again → "prune" red.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, summary, tmpDir } from "./helpers.mjs";
import { CandleStore, MINUTE_MS, DAY_MS, newestClosedOpenMs } from "../dist/src/candles/store.js";
import { VenueCollector, DEFAULT_COLLECTOR_OPTIONS } from "../dist/src/candles/collector.js";
import { CandleService } from "../dist/src/candles/service.js";

const NOW = Date.UTC(2026, 9, 30, 6, 0, 30);
const N = 60;
const symbols = Array.from({ length: N }, (_, i) => `W${i}USDT`);

function seededDir(days = 3) {
  const dataDir = tmpDir("warming");
  const store = new CandleStore(path.join(dataDir, "candles"));
  const end = newestClosedOpenMs(NOW) - MINUTE_MS;
  for (const sym of symbols) {
    const rows = [];
    for (let t = end - days * DAY_MS; t <= end; t += MINUTE_MS) rows.push({ openMs: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 });
    store.write("bitget", sym, rows);
  }
  return { dataDir, store, end };
}

const fetchLike = async (url) => {
  if (url.includes("/v5/market/instruments-info")) {
    return { ok: true, status: 200, json: async () => ({ retCode: 0, result: { list: symbols.map((symbol) => ({ symbol, quoteCoin: "USDT", status: "Trading", contractType: "LinearPerpetual" })), nextPageCursor: "" } }) };
  }
  if (url.includes("/mix/market/contracts")) {
    return { ok: true, status: 200, json: async () => ({ code: "00000", data: symbols.map((symbol) => ({ symbol, symbolStatus: "normal" })) }) };
  }
  return { ok: true, status: 200, json: async () => ({ code: "00000", data: [] }) };
};

await test("busy loop: the per-tick prime slice is bounded by its own scan time, not by how long yields take", async () => {
  const { dataDir, store } = seededDir();
  try {
    const col = new VenueCollector("bitget", store, path.join(dataDir, "candles"), DEFAULT_COLLECTOR_OPTIONS, NOW, () => {});
    await col.refreshSymbols(fetchLike, NOW);
    // Every event-loop turn costs 5 s of "wall" time (a saturated loop); the
    // synchronous scans themselves cost nothing on this clock.
    let fake = NOW, spinning = true;
    const spin = () => { fake += 5_000; if (spinning) setImmediate(spin); };
    setImmediate(spin);
    try {
      await col.tick(fetchLike, 0, NOW, { clock: () => fake, sleep: async () => {}, maxRequests: 0 });
    } finally { spinning = false; }
    const primed = symbols.filter((s) => col.cachedCoverage(s) !== null).length;
    assert.ok(primed >= 32, `one tick primed ${primed} symbols (a wall-time bound primes 1)`);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

await test("boot: CandleService.start() primes the whole roster's exact coverage without any tick or admin poll", async () => {
  const { dataDir } = seededDir();
  try {
    const pre = new VenueCollector("bitget", new CandleStore(path.join(dataDir, "candles")), path.join(dataDir, "candles"), DEFAULT_COLLECTOR_OPTIONS, NOW, () => {});
    await pre.refreshSymbols(fetchLike, NOW); // persists symbols.json, as a running Hub has
    const svc = new CandleService(
      { dataDir, venues: ["bitget"], keyId: "seed-1", options: { ...DEFAULT_COLLECTOR_OPTIONS }, tickMs: 3_600_000, coveragePrime: { delayMs: 0 } },
      { sign: () => Buffer.alloc(64), fetchLike, now: () => NOW, sleep: async () => {}, log: () => {} },
    );
    const warming = () => svc.status(NOW).find((v) => v.venue === "bitget").counts.warming;
    assert.equal(warming(), N, "nothing is primed at construction");
    svc.start();
    try {
      const deadline = Date.now() + 20_000;
      while (warming() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.equal(warming(), 0, "every symbol primed in the background");
      assert.equal(svc.status(NOW).find((v) => v.venue === "bitget").counts.seedable + svc.status(NOW).find((v) => v.venue === "bitget").counts.backfilling, N);
    } finally { svc.stop(); }
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

await test("prune: retention removing a day keeps exact coverage (no roster-wide re-warming), and the figures equal a fresh scan", async () => {
  const { dataDir, store, end } = seededDir(4);
  try {
    // An interior hole on day 2, so interiorMissing is non-trivial.
    const hole = end - 2 * DAY_MS;
    const opts = { ...DEFAULT_COLLECTOR_OPTIONS, retentionDays: 3 };
    const col = new VenueCollector("bitget", store, path.join(dataDir, "candles"), opts, NOW, () => {});
    await col.refreshSymbols(fetchLike, NOW);
    // Remove one minute from every symbol's day-2 file behind the store's back
    // BEFORE priming, so the cached figures include it.
    for (const sym of symbols) {
      const f = path.join(dataDir, "candles", "bitget", sym, `${new Date(Math.floor(hole / DAY_MS) * DAY_MS).toISOString().slice(0, 10)}.c1m`);
      const buf = fs.readFileSync(f); buf.fill(0, ((hole % DAY_MS) / MINUTE_MS) * 48, ((hole % DAY_MS) / MINUTE_MS) * 48 + 48); fs.writeFileSync(f, buf);
    }
    await col.prepareCoverage();
    const removed = col.prune(NOW + DAY_MS);
    assert.ok(removed >= N, `retention removed a day per symbol (${removed})`);
    for (const sym of symbols) {
      const cached = col.cachedCoverage(sym);
      assert.ok(cached, `${sym} is still primed after prune`);
      const fresh = store.coverage("bitget", sym, true);
      assert.deepEqual(cached, fresh, `${sym}: carried-forward coverage equals a fresh deep scan`);
    }
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

await test("one venue per turn: the boot prime serialises venues, bounds each turn's scan time and yields on a timer between turns", async () => {
  const { dataDir, end } = seededDir(2);
  try {
    // A second venue with the same roster.
    const store = new CandleStore(path.join(dataDir, "candles"));
    for (const sym of symbols) {
      const rows = [];
      for (let t = end - 2 * DAY_MS; t <= end; t += MINUTE_MS) rows.push({ openMs: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 });
      store.write("bybit", sym, rows);
    }
    for (const v of ["bitget", "bybit"]) {
      const pre = new VenueCollector(v, store, path.join(dataDir, "candles"), DEFAULT_COLLECTOR_OPTIONS, NOW, () => {});
      await pre.refreshSymbols(fetchLike, NOW);
      assert.equal(pre.symbols().length, N, `${v} roster`);
    }
    // Every scan costs exactly 5 ms on the prime's clock (two reads); budget 25.
    let fake = 0;
    const turns = [];
    const svc = new CandleService(
      { dataDir, venues: ["bitget", "bybit"], keyId: "seed-1", options: { ...DEFAULT_COLLECTOR_OPTIONS }, tickMs: 3_600_000,
        coveragePrime: { delayMs: 0, turnBudgetMs: 25, yieldMs: 1, clock: () => (fake += 5), onTurn: (t) => turns.push({ ...t, at: Date.now() }) } },
      { sign: () => Buffer.alloc(64), fetchLike, now: () => NOW, sleep: async () => {}, log: () => {} },
    );
    // A concurrent timer proves the loop is free between turns.
    let ticks = 0; const beat = setInterval(() => ticks++, 1);
    svc.start();
    try {
      const deadline = Date.now() + 20_000;
      const warming = () => svc.status(NOW).filter((v) => v.configured).reduce((n, v) => n + v.counts.warming, 0);
      while (warming() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      assert.equal(warming(), 0, "both venues primed");
    } finally { svc.stop(); clearInterval(beat); }
    assert.ok(turns.every((t) => t.scanned >= 1 && t.scanned <= 5 && t.spentMs <= 25 + 5), `each turn scans within its budget (${turns.map((t) => t.scanned).join(",")})`);
    const order = turns.map((t) => t.venue);
    const firstBybit = order.indexOf("bybit");
    assert.ok(firstBybit > 0 && order.slice(0, firstBybit).every((v) => v === "bitget") && order.slice(firstBybit).every((v) => v === "bybit"),
      "venues are primed one after another, never interleaved or concurrent");
    assert.equal(turns.reduce((n, t) => n + t.scanned, 0), 2 * N, "every symbol scanned exactly once");
    assert.ok(turns.length >= Math.ceil((2 * N) / 5), "many short turns, not one long one");
    assert.ok(ticks > 0, "other timers ran while the prime was in progress");
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

summary("candle-warming");
