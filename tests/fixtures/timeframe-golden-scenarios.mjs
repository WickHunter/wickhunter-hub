// Deterministic <=60-day v2 timeframe scenarios. The SAME builder runs against
// the 0.4.102 dist (to produce tests/fixtures/timeframe-v2-golden.json) and
// against the current dist (tests/timeframe-horizon.test.mjs), so a Beta app's
// short-window response is proved byte-identical, not merely "still valid".
//
// Usage (generator): node tests/fixtures/timeframe-golden-scenarios.mjs <distDir> <outJson>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { pathToFileURL } from "node:url";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const GOLDEN_NOW = Date.parse("2026-10-20T12:07:30.000Z");
const SEED = Buffer.alloc(32, 7);
const KEY = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), SEED]), format: "der", type: "pkcs8",
});
export const goldenSign = (bytes) => edSign(null, bytes, KEY);

function px(i, base = 100) {
  const o = base + ((i * 37) % 23) / 7;
  const c = base + ((i * 53) % 19) / 5;
  return { open: o, high: Math.max(o, c) + 0.25 + (i % 3) / 10, low: Math.min(o, c) - 0.5 - (i % 5) / 20, close: c, volume: 1 + (i % 11) * 0.125 };
}

function nativeRows(fromMs, stepMs, n, skip = new Set(), base = 100) {
  const out = [];
  for (let i = 0; i < n; i++) if (!skip.has(i)) out.push({ openMs: fromMs + i * stepMs, ...px(i, base) });
  return out;
}

function work(venue, symbol, target, interval, startMs, endMs) {
  return { key: `${venue}\u0000${symbol}\u0000${target}`, venue, symbol, targetInterval: target, interval, startMs, endMs };
}

/** Build every scenario in a fresh temp root. `options` is passed through to
 * TimeframeHistory (the 0.4.102 constructor ignores a fourth argument). */
export async function goldenBodies(distDir, options = undefined, tmpRoot = os.tmpdir()) {
  const { CandleStore } = await import(pathToFileURL(path.join(distDir, "src/candles/store.js")).href);
  const { TimeframeHistory } = await import(pathToFileURL(path.join(distDir, "src/candles/timeframe.js")).href);
  const root = fs.mkdtempSync(path.join(tmpRoot, "wh-tf-golden-"));
  try {
    const minutes = new CandleStore(path.join(root, "candles"));
    const h = options === undefined
      ? new TimeframeHistory(path.join(root, "tf"), minutes, 30)
      : new TimeframeHistory(path.join(root, "tf"), minutes, 30, options);
    const now = GOLDEN_NOW;
    const at = (step) => Math.floor(now / step) * step - step; // newest closed open
    const out = {};
    const req = (name, venue, symbol, interval, fromMs, toMs, minuteFrontier = null) => {
      const r = h.request(venue, symbol, interval, fromMs, toMs, now, minuteFrontier, "seed-1", goldenSign);
      out[name] = r.ok ? JSON.stringify(r.payload) : JSON.stringify(r);
    };
    // 1) Bybit native 60m, a full 60-day window (exactly the short threshold).
    {
      const step = 60 * MIN; const last = at(step); const n = 60 * 24; const from = last - (n - 1) * step;
      for (let s = from; s <= last; s += 1000 * step) {
        const e = Math.min(last, s + 999 * step);
        h.record(work("bybit", "BTCUSDT", 60, 60, s, e), { candles: nativeRows(s, step, (e - s) / step + 1), empty: false }, now);
      }
      req("bybit-60-60d", "bybit", "BTCUSDT", 60, from, last + step - 1);
      req("bybit-60-7d", "bybit", "BTCUSDT", 60, last - 167 * step, last);
      // 2) 240m folded from those natives (no native 240 frontier).
      req("bybit-240-fold-30d", "bybit", "BTCUSDT", 240, last - 30 * DAY, now);
    }
    // 3) Gapped native 240 window with interior and leading holes.
    {
      const step = 240 * MIN; const last = at(step); const n = 120; const from = last - (n - 1) * step;
      h.record(work("binance", "ETHUSDT", 240, 240, from, last),
        { candles: nativeRows(from + 10 * step, step, n - 10, new Set([20, 21, 22, 70])), empty: false }, now);
      req("binance-240-gapped", "binance", "ETHUSDT", 240, from, last);
    }
    // 4) Bitget 120m aggregated from REST-confirmed minutes.
    {
      const mins = []; const end = Math.floor(now / MIN) * MIN - 5 * MIN; const start = end - 2 * DAY;
      for (let t = start, i = 0; t <= end; t += MIN, i++) mins.push({ openMs: t, ...px(i, 50) });
      minutes.write("bitget", "SOLUSDT", mins, end);
      req("bitget-120-minutes", "bitget", "SOLUSDT", 120, start, end, end);
      req("bitget-1440-minutes", "bitget", "SOLUSDT", 1440, start - DAY, end, end);
    }
    // 5) Bitunix native 60m with a carried open (open == previous close, outside range).
    {
      const step = 60 * MIN; const last = at(step); const from = last - 47 * step;
      const rows = nativeRows(from, step, 48, new Set(), 10);
      for (let i = 1; i < rows.length; i++) rows[i].open = rows[i - 1].close;
      rows[30].open = rows[29].close = rows[30].high + 0.5; rows[29].high = Math.max(rows[29].high, rows[29].close);
      h.record(work("bitunix", "XRPUSDT", 60, 60, from - step, last), { candles: rows, empty: false }, now);
      req("bitunix-60-carried", "bitunix", "XRPUSDT", 60, from, last);
    }
    // 6) WEEX daily and hourly natives.
    {
      const d = 1440 * MIN; const lastD = at(d); const fromD = lastD - 44 * d;
      h.record(work("weex", "BTCUSDT", 1440, 1440, fromD, lastD), { candles: nativeRows(fromD, d, 45, new Set([3])), empty: false }, now);
      req("weex-1440-45d", "weex", "BTCUSDT", 1440, fromD, lastD);
      const step = 60 * MIN; const last = at(step); const from = last - 99 * step;
      h.record(work("weex", "BTCUSDT", 60, 60, from, last), { candles: nativeRows(from, step, 100), empty: false }, now);
      req("weex-60-100h", "weex", "BTCUSDT", 60, from, last);
      // 7) Cold identity: honest 503.
      req("aster-60-cold", "aster", "NEWUSDT", 60, last - 10 * step, last);
    }
    return out;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function digest(bodies) {
  return Object.fromEntries(Object.entries(bodies).map(([k, v]) => [k, {
    sha256: createHash("sha256").update(v).digest("hex"), bytes: Buffer.byteLength(v),
  }]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [distDir, outFile] = process.argv.slice(2);
  const bodies = await goldenBodies(path.resolve(distDir));
  fs.writeFileSync(outFile, `${JSON.stringify({ generatedFrom: "wickhunter-hub 0.4.102 (a135d24) dist", now: GOLDEN_NOW, scenarios: digest(bodies) }, null, 2)}\n`);
  console.log(`wrote ${Object.keys(bodies).length} scenarios to ${outFile}`);
}
