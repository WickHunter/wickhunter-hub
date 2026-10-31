#!/usr/bin/env node
// Main-thread cost of the timeframe lane with a one-year horizon.
//
//   node scripts/bench-timeframe-horizon.mjs <distDir> [symbols=400]
//
// Runs against any Hub dist. On a 0.4.102 dist the year is driven the only way
// that release can: every pair asks for 365 days, which registers a demand per
// pair (young listings keep a permanent leading gap, so the demand never
// retires). On a 0.4.103+ dist the same pairs are a configured horizon.
// Reports, per collector tick, the synchronous time spent in work(), and per
// long (8,760-row) request, the time the event loop is held.
// Never run this on the production Hub box while the live app is observed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { createPrivateKey, sign as edSign } from "node:crypto";

const distDir = path.resolve(process.argv[2] ?? "dist");
const N = Number(process.argv[3] ?? 400);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const { CandleStore } = await import(pathToFileURL(path.join(distDir, "src/candles/store.js")).href);
const tf = await import(pathToFileURL(path.join(distDir, "src/candles/timeframe.js")).href);
const KEY = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 9)]), format: "der", type: "pkcs8" });
const sign = (b) => edSign(null, b, KEY);
const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "wh-tf-bench-"));
const horizonCapable = typeof tf.parseTimeframeHorizon === "function";
const now = Date.parse("2026-10-20T12:07:30.000Z");
const step = HOUR;
const last = Math.floor(now / step) * step - step;
const yearFrom = last - 8759 * step;
const px = (i) => ({ open: 100 + (i % 7), high: 108 + (i % 5), low: 95 - (i % 3), close: 101 + (i % 6), volume: 1 + (i % 9) });
const work = (sym, s, e) => ({ key: `bybit\u0000${sym}\u000060`, venue: "bybit", symbol: sym, targetInterval: 60, interval: 60, startMs: s, endMs: e });
try {
  const minutes = new CandleStore(path.join(root, "candles"));
  const opts = horizonCapable ? { horizon: tf.parseTimeframeHorizon("bybit:60:365").value } : undefined;
  const h = opts ? new tf.TimeframeHistory(path.join(root, "tf"), minutes, 30, opts) : new tf.TimeframeHistory(path.join(root, "tf"), minutes, 30);
  const symbols = Array.from({ length: N }, (_, i) => `S${i}USDT`);
  // Young listings: 60 days of natives each; 20 mature pairs hold the full year.
  const mature = new Set(symbols.slice(0, 20));
  const t0 = performance.now();
  for (const sym of symbols) {
    const from = mature.has(sym) ? yearFrom : last - (60 * 24 - 1) * step;
    for (let s = from; s <= last; s += 1000 * step) {
      const e = Math.min(last, s + 999 * step);
      const rows = []; for (let t = s, i = 0; t <= e; t += step, i++) rows.push({ openMs: t, ...px(i) });
      h.record(work(sym, s, e), { candles: rows, empty: false }, now);
    }
  }
  h.flush?.();
  const seedMs = performance.now() - t0;
  // Register the year: legacy = one 365-day request per pair; horizon = warm().
  const tReg = performance.now();
  if (horizonCapable) {
    h.warm("bybit", symbols, now);
    while (!h.primeHorizon(now, 50, () => performance.now()).done) { /* boot prime, bounded turns */ }
  } else {
    for (const sym of symbols) if (!mature.has(sym)) h.request("bybit", sym, 60, yearFrom, last, now, null, "seed-1", sign);
  }
  const regMs = performance.now() - tReg;
  const ticks = [];
  for (let i = 0; i < 5; i++) {
    const a = performance.now();
    const items = h.work("bybit", now + i * 1000, 1000);
    ticks.push({ ms: performance.now() - a, items: items.length });
  }
  const tickMs = ticks.map((t) => t.ms).sort((a, b) => a - b)[2];
  // Long request: full year for a mature pair.
  const req = [];
  for (const sym of [...mature].slice(0, 10)) {
    const a = performance.now();
    if (horizonCapable) {
      const prepared = h.prepareLongRequest("bybit", sym, 60, yearFrom, last, now, null, "seed-1");
      const held = performance.now() - a;
      if (!prepared.ok) throw new Error(JSON.stringify(prepared));
      // The worker's build (off-thread in production) is run inline here only
      // to obtain the canonical bytes; it is NOT counted as main-thread time.
      const { buildTimeframeJob } = await import(pathToFileURL(path.join(distDir, "src/candles/timeframe-seed-worker.js")).href);
      const built = buildTimeframeJob(prepared.job);
      const b = performance.now();
      const done = h.finishLongRequest(prepared, built, sign);
      req.push({ ms: held + (performance.now() - b), bytes: done.ok ? done.body.length : 0 });
    } else {
      const r = h.request("bybit", sym, 60, yearFrom, last, now, null, "seed-1", sign);
      const body = Buffer.from(JSON.stringify(r.payload));
      req.push({ ms: performance.now() - a, bytes: body.length });
    }
  }
  const reqMs = req.map((r) => r.ms).sort((a, b) => a - b)[5];
  console.log(JSON.stringify({
    dist: distDir, horizonCapable, symbols: N, seedMs: Math.round(seedMs), registerOrPrimeMs: Math.round(regMs), registerOrPrimeMsPerPair: +(regMs / N).toFixed(2),
    workTickMs: { median: +tickMs.toFixed(2), all: ticks.map((t) => +t.ms.toFixed(2)), items: ticks[0].items },
    workTickMsPerDemand: +(tickMs / (N - mature.size)).toFixed(4),
    longRequestMainThreadMs: { median: +reqMs.toFixed(2), bytes: req[0].bytes },
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
