// src/liq/percentiles.ts
// Pair-specific liquidation-SIZE percentiles, built from the recorded
// archive (`history.ts`). This is a byte-for-byte port of the bot's own
// `src/liq/size-percentiles.ts` (`buildLiqSizePercentiles`, nearest-rank,
// interpolation, the stop set, the caps) — the wire contract this hub serves
// at `GET /api/hub/liq-percentiles` IS that module's own output shape, so a
// bot reading it needs no translation, and `tests/liq-percentiles.test.mjs`
// asserts the two produce byte-identical output against a shared fixture by
// importing the bot repo's own compiled module directly.
//
// ── WINDOW AND SAMPLE CAP ────────────────────────────────────────────────
// 30 days, at most the NEWEST 1,000 prints per (source, symbol, side) — a
// hyperactive pair with tens of thousands of prints a month must not make
// this heavier than a quiet one, and the newest prints describe the CURRENT
// liquidity regime.
//
// ── WHY SIDE IS PART OF THE KEY ──────────────────────────────────────────
// Long and short liquidations on one pair are not the same population (one
// side's book is thinner in a trend), so every stop is keyed and thresholded
// PER SIDE.

import type { LiqHistory } from "./history.js";

/** One raw sample the table builder reads — the shape `history.ts` already
 *  stores, so nothing here re-derives a field from the recorder's rows. */
export interface LiqSizeSample {
  ts: number;
  symbol: string;
  side: string; // "long" | "short" as recorded — anything else is dropped
  sizeUsd: number;
  src?: string;
}

// v0.4.22 — the Screener shows the 20th–99th; 50 and 75 stay so a stored
// bot percentile keeps its exact stop and older bots interpolate the same.
export const LIQ_PCTL_STOPS = [20, 40, 50, 60, 75, 80, 90, 95, 99] as const;
export type LiqPctlStop = (typeof LIQ_PCTL_STOPS)[number];

/** Below this many samples for a (source, symbol, side), the caller should
 *  refuse to threshold on it rather than compute on a thin, noisy sample. The
 *  hub itself does not enforce this — it publishes every row with its own
 *  `count` and lets each client apply its own minimum, matching the bot's own
 *  `LIQ_PCTL_MIN_PRINTS` rule. */
export const LIQ_PCTL_MIN_PRINTS = 30;

/** At most this many of the NEWEST prints per (source, symbol, side) are
 *  ranked, however many the window actually holds. */
export const LIQ_PCTL_MAX_PRINTS = 1000;

/** The window every table is built over, in days. */
export const LIQ_PCTL_WINDOW_DAYS = 30;

export interface LiqSizePercentileRow {
  /** Samples actually ranked (after the 1,000-newest cap). */
  count: number;
  /** USD size at each of `LIQ_PCTL_STOPS`, nearest-rank on sizes sorted
   *  ascending. Keyed by the stop number (e.g. `usd[90]`). */
  usd: Record<number, number>;
}

export interface LiqSizePercentileTable {
  windowDays: number;
  generatedAtMs: number;
  stops: readonly number[];
  /** src → symbol → side ("long"|"short") → row. */
  rows: Record<string, Record<string, Record<string, LiqSizePercentileRow>>>;
}

const DEFAULT_SRC = "bybit-usdt";
const normSrc = (src: string | undefined | null): string => (src && src.trim()) ? src : DEFAULT_SRC;
const normSide = (side: string | undefined | null): string => (side === "short" ? "short" : side === "long" ? "long" : "");

/** nearest-rank percentile on a SORTED-ASCENDING array. */
function nearestRank(sortedAsc: readonly number[], pct: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.min(n, Math.max(1, Math.ceil((pct / 100) * n)));
  return sortedAsc[rank - 1];
}

/** Build the whole (source, symbol, side) percentile table from a rolling
 *  window of raw samples. Pure — the same function drives the hub's own
 *  build and the test suite's parity check against the bot's copy. */
export function buildLiqSizePercentiles(
  rows: Iterable<LiqSizeSample>,
  opts: { days?: number; now?: number; percentiles?: readonly number[]; maxPrints?: number } = {},
): LiqSizePercentileTable {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? LIQ_PCTL_WINDOW_DAYS;
  const stops = opts.percentiles && opts.percentiles.length ? [...opts.percentiles].sort((a, b) => a - b) : [...LIQ_PCTL_STOPS];
  const maxPrints = opts.maxPrints ?? LIQ_PCTL_MAX_PRINTS;
  const cutoff = now - days * 86_400_000;

  const buckets = new Map<string, Map<string, Map<string, Array<{ ts: number; sizeUsd: number }>>>>();
  for (const r of rows) {
    if (!r || !(r.ts >= cutoff && r.ts <= now)) continue;
    if (!(Number.isFinite(r.sizeUsd) && r.sizeUsd > 0)) continue;
    if (!r.symbol) continue;
    const side = normSide(r.side);
    if (!side) continue;
    const src = normSrc(r.src);
    let bySymbol = buckets.get(src);
    if (!bySymbol) { bySymbol = new Map(); buckets.set(src, bySymbol); }
    let bySide = bySymbol.get(r.symbol);
    if (!bySide) { bySide = new Map(); bySymbol.set(r.symbol, bySide); }
    let arr = bySide.get(side);
    if (!arr) { arr = []; bySide.set(side, arr); }
    arr.push({ ts: r.ts, sizeUsd: r.sizeUsd });
  }

  const out: LiqSizePercentileTable = { windowDays: days, generatedAtMs: now, stops, rows: {} };
  for (const [src, bySymbol] of buckets) {
    const symRows: Record<string, Record<string, LiqSizePercentileRow>> = {};
    for (const [symbol, bySide] of bySymbol) {
      const sideRows: Record<string, LiqSizePercentileRow> = {};
      for (const [side, samples] of bySide) {
        samples.sort((a, b) => b.ts - a.ts);
        const capped = samples.length > maxPrints ? samples.slice(0, maxPrints) : samples;
        const sizes = capped.map((s) => s.sizeUsd).sort((a, b) => a - b);
        const usd: Record<number, number> = {};
        for (const p of stops) usd[p] = nearestRank(sizes, p);
        sideRows[side] = { count: sizes.length, usd };
      }
      symRows[symbol] = sideRows;
    }
    out.rows[src] = symRows;
  }
  return out;
}

/** Rebuild the whole table from the recorded archive.
 *
 *  Reads day files NEWEST-FIRST (`LiqHistory.days()` is already sorted that
 *  way) and, within each day, walks the file newest-event-first too. A cheap
 *  per-(src,symbol,side) counter caps ingestion at `maxPrints` AS ROWS ARE
 *  READ — a busy pair's working set never grows past its own cap even while
 *  a quiet pair's whole 30-day window is still being read, and the kept rows
 *  are the NEWEST ones for that key by construction. Day files entirely
 *  older than the window are never opened at all. Mirrors the bot's own
 *  `LiqSizePercentileStore.rebuildLocal` exactly, applied here to the hub's
 *  install-wide archive instead of one process's local history. */
export async function rebuildLiqPercentileTable(
  history: Pick<LiqHistory, "dayFiles" | "readLines">,
  opts: { days?: number; maxPrints?: number; now?: number } = {},
): Promise<LiqSizePercentileTable> {
  // v0.4.20 — STREAMED. Day files newest-first off the `stat` listing, each
  // read a line at a time; a per-(src,symbol,side) reservoir keeps the newest
  // `maxPrints` and stops collecting a key once a newer day has filled it.
  // Day files entirely older than the window are never opened.
  const now = opts.now ?? Date.now();
  const days = opts.days ?? LIQ_PCTL_WINDOW_DAYS;
  const maxPrints = opts.maxPrints ?? LIQ_PCTL_MAX_PRINTS;
  const cutoff = now - days * 86_400_000;
  const kept = new Map<string, LiqSizeSample[]>(); // newest-first per key
  for (const d of history.dayFiles()) {
    const dayStart = Date.parse(`${d.day}T00:00:00Z`);
    if (!Number.isFinite(dayStart) || dayStart + 86_400_000 < cutoff) break; // older than the window — nothing further matters
    const dayRows = new Map<string, LiqSizeSample[]>(); // oldest-first, as written
    for await (const e of history.readLines(d.day)) {
      if (!(e.ts >= cutoff && e.ts <= now)) continue;
      if (e.side !== "long" && e.side !== "short") continue;
      if (!(Number(e.sizeUsd) > 0)) continue;
      const src = e.src && String(e.src).trim() ? e.src : DEFAULT_SRC;
      const key = `${src}|${e.symbol}|${e.side}`;
      if ((kept.get(key)?.length ?? 0) >= maxPrints) continue; // a newer day already filled this key
      let arr = dayRows.get(key);
      if (!arr) { arr = []; dayRows.set(key, arr); }
      arr.push({ ts: e.ts, symbol: e.symbol, side: e.side, sizeUsd: e.sizeUsd, src });
    }
    for (const [key, arr] of dayRows) {
      let k = kept.get(key);
      if (!k) { k = []; kept.set(key, k); }
      for (let i = arr.length - 1; i >= 0 && k.length < maxPrints; i--) k.push(arr[i]!);
    }
  }
  const rows: LiqSizeSample[] = [];
  for (const k of kept.values()) rows.push(...k);
  return buildLiqSizePercentiles(rows, { days, now, maxPrints });
}

/** Verify the SHAPE of a table before trusting it — a persisted snapshot
 *  restored across a restart, or a payload this hub is about to serve. */
export function liqPercentileTableLooksValid(t: unknown): t is LiqSizePercentileTable {
  if (!t || typeof t !== "object") return false;
  const table = t as LiqSizePercentileTable;
  if (typeof table.windowDays !== "number" || !Number.isFinite(table.windowDays)) return false;
  if (typeof table.generatedAtMs !== "number" || !Number.isFinite(table.generatedAtMs)) return false;
  if (!Array.isArray(table.stops) || !table.stops.every((s) => typeof s === "number")) return false;
  if (!table.rows || typeof table.rows !== "object") return false;
  return true;
}

/** Total (src, symbol, side) rows a table publishes — what a status line and
 *  a log both read, so they cannot disagree about what "covers N pair-sides"
 *  means. */
export function countLiqPercentilePairSides(table: LiqSizePercentileTable | null): number {
  if (!table) return 0;
  let n = 0;
  for (const bySymbol of Object.values(table.rows)) {
    for (const bySide of Object.values(bySymbol)) n += Object.keys(bySide).length;
  }
  return n;
}
