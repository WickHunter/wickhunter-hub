#!/usr/bin/env node
// scripts/bench-candle-ingest.mjs — v0.4.102 synthetic CPU benchmark of the
// candle websocket ingest path (parse → closure → defer/settle → store.write).
//
//   node scripts/bench-candle-ingest.mjs [distDir] [symbols] [minutes]
//
// Six runners (bybit, bitget, bitunix, binance, aster, and a second bitget
// standing in for weex), `symbols` pairs each, one forming frame per pair per
// second plus the venue's own closing pattern, `minutes` of venue time driven
// through an injected clock and socket. Store writes go to a temp dir under
// TMPDIR (removed afterwards). Reports main-thread CPU ms per simulated minute
// for the ingest calls only, and the store.write / deferred-scan counts.
// Offline: no network, no live data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dist = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), "..", "dist"));
const SYMBOLS = Number(process.argv[3] ?? 800);
const MINUTES = Number(process.argv[4] ?? 3);
const { VenueStreamRunner } = await import(pathToFileURL(path.join(dist, "src/candles/stream-runner.js")).href);
const { STREAM_ADAPTERS } = await import(pathToFileURL(path.join(dist, "src/candles/stream.js")).href);
const { CandleStore } = await import(pathToFileURL(path.join(dist, "src/candles/store.js")).href);

const MIN = 60_000;
const T0 = 1_793_300_400_000;
const syms = Array.from({ length: SYMBOLS }, (_, i) => `S${String(i).padStart(4, "0")}USDT`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wickhub-bench-"));
const store = new CandleStore(dir);
let clock = T0 + 5_000;
let writes = 0, rows = 0;

function px(i, minute, sec) { return 100 + (i % 50) + minute * 0.01 + sec * 0.0001; }
const frames = {
  // [venue]: (symbol, i, minute index, second, isFirstOfMinute) => string[]
  bybit: (s, i, m, sec) => [JSON.stringify({ topic: `kline.1.${s}`, data: [{ start: T0 + m * MIN, open: "100", high: "200", low: "50", close: String(px(i, m, sec)), volume: String(sec + 1), confirm: sec === 59 }] })],
  binance: (s, i, m, sec) => [JSON.stringify({ e: "kline", s, st: 1, k: { t: T0 + m * MIN, i: "1m", o: "100", h: "200", l: "50", c: String(px(i, m, sec)), v: String(sec + 1), x: sec === 59 } })],
  aster: (s, i, m, sec) => [JSON.stringify({ e: "kline", s, k: { t: T0 + m * MIN, i: "1m", o: "100", h: "200", l: "50", c: String(px(i, m, sec)), v: String(sec + 1), x: sec === 59 } })],
  bitget: (s, i, m, sec) => [JSON.stringify({ action: "update", arg: { instId: s }, data: [[String(T0 + m * MIN), "100", "200", "50", String(px(i, m, sec)), String(sec + 1), "9", "9"]] })],
  bitunix: (s, i, m, sec) => {
    const open = m === 0 ? 100 : px(i, m - 1, 59);
    const k = (ts, o, h, l, c, b) => JSON.stringify({ ch: "market_kline_1min", symbol: s, ts, data: { o: String(o), h: String(h), l: String(l), c: String(c), b: String(b), q: String(b * c) } });
    const base = T0 + m * MIN;
    if (sec === 0) {
      const out = [];
      if (m > 0) {
        const pOpen = m === 1 ? 100 : px(i, m - 2, 59);
        out.push(k(base + 120, pOpen, 1000, 1, px(i, m - 1, 59), 60)); // finalisation of m-1
      }
      out.push(k(base + 120, open, open, open, open, 0)); // seed of m
      return out;
    }
    return [k(base + sec * 1000, open, 1000, 1, px(i, m, sec), sec)];
  },
};
const venues = [["bybit", "bybit"], ["bitget", "bitget"], ["bitunix", "bitunix"], ["binance", "binance"], ["aster", "aster"], ["weex*", "bitget"]];
const runners = [];
for (const [label, adapterId] of venues) {
  const made = [];
  const factory = (url, h) => { const sock = { url, h, send() {}, close() {} }; made.push(sock); return sock; };
  const r = new VenueStreamRunner({
    adapter: { ...STREAM_ADAPTERS[adapterId], maxTopicsPerConnection: 100_000 },
    symbols: () => syms, socket: factory, now: () => clock, settleFlushMs: 3_600_000,
    write: (symbol, candles, notAfterMs) => { writes++; rows += candles.length; store.write(adapterId, symbol, candles, notAfterMs); },
  });
  r.start(); made[0].h.onOpen();
  runners.push({ label, adapterId, r, sock: made[0] });
}
const perMinute = [];
let cpuUs = 0;
for (let m = 0; m < MINUTES; m++) {
  let minuteUs = 0;
  for (let sec = 0; sec < 60; sec++) {
    clock = T0 + m * MIN + sec * 1000 + 500;
    for (const { adapterId, sock } of runners) {
      const batch = [];
      for (let i = 0; i < syms.length; i++) batch.push(...frames[adapterId](syms[i], i, m, sec));
      const before = process.cpuUsage();
      for (const f of batch) sock.h.onMessage(f);
      const d = process.cpuUsage(before);
      minuteUs += d.user + d.system;
    }
  }
  perMinute.push(Math.round(minuteUs / 1000));
  cpuUs += minuteUs;
}
const scans = runners.reduce((n, x) => n + (x.r.deferredScans ?? NaN), 0);
console.log(JSON.stringify({
  dist, symbolsPerVenue: SYMBOLS, venues: venues.length, minutes: MINUTES,
  framesPerMinute: SYMBOLS * 60 * venues.length,
  ingestCpuMsPerMinute: perMinute, ingestCpuMsTotal: Math.round(cpuUs / 1000),
  storeWrites: writes, rowsWritten: rows, deferredScans: Number.isNaN(scans) ? "n/a" : scans,
}));
for (const { r } of runners) r.stop();
fs.rmSync(dir, { recursive: true, force: true });
