// Persistent, signed higher-timeframe candle history for Optimized startup.
// The minute seed in seed.ts is pinned v1; this module owns only v2 requests.
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readJson } from "../jsonfile.js";
import { CLOSED_GRACE_MS, DAY_MS, MINUTE_MS, dayKey, dayStartOf, isSafeSegment, type Candle, type CandleStore, type Gap, type Row } from "./store.js";
import {
  VENUE_IDS, isVenueId, nativeTimeframeHistoryRoute, nativeTimeframeIntervals, nativeTimeframePageRows,
  nativeTimeframeWeight, WEEX_RECENT_TIMEFRAME_ROWS,
  type KlinePage, type NativeTimeframeRoute, type VenueId,
} from "./venues.js";

export const TIMEFRAME_WIRE_VERSION = 2;
export const TIMEFRAME_INTERVALS = [3, 5, 15, 30, 60, 120, 180, 240, 360, 720, 1440] as const;
export type TimeframeInterval = (typeof TIMEFRAME_INTERVALS)[number];
export type TimeframeSource = "native" | "aggregate";
export type TimeframeSegment = [number, number, TimeframeSource, number];

export function isTimeframeInterval(value: unknown): value is TimeframeInterval {
  return typeof value === "number" && Number.isInteger(value)
    && (TIMEFRAME_INTERVALS as readonly number[]).includes(value);
}

interface CachedCandle extends Candle {
  source: TimeframeSource;
  baseInterval: number;
}

const RECORD_BYTES = 56;
const SOURCE_NATIVE = 1;
const SOURCE_AGGREGATE = 2;
const FILE_EXT = ".ctf2";
/** v0.4.103 — one file per UTC month for horizon intervals (same 56 B record). */
const MONTH_EXT = ".ctf3";

/** Where a (venue, interval) series keeps its slots. `day` is the 0.4.102
 *  layout; `month` is used for intervals held on a long horizon, where a year
 *  of day files would be ~1.2 M files per venue and 365 reads per request. */
export type TimeframeLayout = "day" | "month";

export function monthStartOf(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function nextMonthStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function monthKey(monthStartMs: number): string {
  return new Date(monthStartMs).toISOString().slice(0, 7);
}

function basicValues(openMs: number, open: number, high: number, low: number, close: number, volume: number): boolean {
  return Number.isSafeInteger(openMs) && openMs > 0
    && Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low)
    && Number.isFinite(close) && Number.isFinite(volume)
    && open > 0 && high > 0 && low > 0 && close > 0 && volume >= 0
    && high >= low && high >= close && low <= close;
}

function basicCandle(c: Candle): boolean {
  return basicValues(c.openMs, c.open, c.high, c.low, c.close, c.volume);
}

function strictCandle(c: Candle): boolean {
  return basicCandle(c) && c.high >= c.open && c.low <= c.open;
}

function validAfter(venue: VenueId, interval: number, c: Candle, previous: Candle | undefined): boolean {
  return strictCandle(c) || (basicCandle(c) && venue === "bitunix" && previous !== undefined
    && c.openMs - previous.openMs === interval * MINUTE_MS && c.open === previous.close);
}

/** Fixed slots keep absence authoritative and writes idempotent, as in CandleStore. */
export class TimeframeStore {
  constructor(readonly rootDir: string,
    private readonly layoutOf: (venue: string, interval: number) => TimeframeLayout = () => "day") {}

  layout(venue: string, interval: number): TimeframeLayout { return this.layoutOf(venue, interval); }

  private intervalDir(venue: string, symbol: string, interval: number): string {
    if (!isSafeSegment(venue) || !isSafeSegment(symbol) || !isTimeframeInterval(interval)) {
      throw new Error("unsafe timeframe cache identity");
    }
    return path.join(this.rootDir, venue, symbol, String(interval));
  }

  private file(venue: string, symbol: string, interval: TimeframeInterval, day: number): string {
    return path.join(this.intervalDir(venue, symbol, interval), `${dayKey(day)}${FILE_EXT}`);
  }

  private monthFile(venue: string, symbol: string, interval: TimeframeInterval, month: number): string {
    return path.join(this.intervalDir(venue, symbol, interval), `${monthKey(month)}${MONTH_EXT}`);
  }

  private slots(interval: TimeframeInterval): number { return 1440 / interval; }

  private monthSlots(interval: TimeframeInterval, month: number): number {
    return (nextMonthStart(month) - month) / (interval * MINUTE_MS);
  }

  invalidateSymbol(venue: VenueId, symbol: string): void {
    if (!isSafeSegment(venue) || !isSafeSegment(symbol)) throw new Error("unsafe timeframe invalidation identity");
    fs.rmSync(path.join(this.rootDir, venue, symbol), { recursive: true, force: true });
  }

  private readFixed(file: string, bytes: number): Buffer | null {
    try {
      const held = fs.readFileSync(file);
      if (held.length === bytes) return held;
      const padded = Buffer.alloc(bytes);
      held.copy(padded, 0, 0, Math.min(bytes, held.length));
      return padded;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private readDay(venue: string, symbol: string, interval: TimeframeInterval, day: number): Buffer | null {
    return this.readFixed(this.file(venue, symbol, interval, day), this.slots(interval) * RECORD_BYTES);
  }

  private readMonth(venue: string, symbol: string, interval: TimeframeInterval, month: number): Buffer | null {
    return this.readFixed(this.monthFile(venue, symbol, interval, month), this.monthSlots(interval, month) * RECORD_BYTES);
  }

  /** File names in one series directory (month layout reads list once rather
   *  than paying a failed open for every absent day or month). */
  private listing(venue: string, symbol: string, interval: TimeframeInterval): Set<string> {
    try { return new Set(fs.readdirSync(this.intervalDir(venue, symbol, interval))); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set(); throw err; }
  }

  private decode(buf: Buffer, slot: number, day: number, interval: TimeframeInterval): CachedCandle | null {
    const off = slot * RECORD_BYTES;
    const openMs = Number(buf.readBigInt64LE(off));
    const expected = day + slot * interval * MINUTE_MS;
    if (openMs !== expected || openMs === 0) return null;
    const sourceCode = buf.readUInt8(off + 48);
    const baseInterval = buf.readUInt16LE(off + 49);
    if ((sourceCode !== SOURCE_NATIVE && sourceCode !== SOURCE_AGGREGATE)
      || !Number.isInteger(baseInterval) || baseInterval < 1 || interval % baseInterval !== 0
      || (sourceCode === SOURCE_NATIVE && baseInterval !== interval)
      || (sourceCode === SOURCE_AGGREGATE && baseInterval >= interval)) return null;
    const candle: CachedCandle = {
      openMs,
      open: buf.readDoubleLE(off + 8), high: buf.readDoubleLE(off + 16),
      low: buf.readDoubleLE(off + 24), close: buf.readDoubleLE(off + 32),
      volume: buf.readDoubleLE(off + 40),
      source: sourceCode === SOURCE_NATIVE ? "native" : "aggregate",
      baseInterval,
    };
    return basicCandle(candle) ? candle : null;
  }

  write(venue: VenueId, symbol: string, interval: TimeframeInterval, candles: readonly Candle[],
    source: TimeframeSource, baseInterval: number, notAfterMs: number): number {
    if (!Number.isInteger(baseInterval) || baseInterval < 1 || interval % baseInterval !== 0
      || (source === "native" && baseInterval !== interval)
      || (source === "aggregate" && baseInterval >= interval)) return 0;
    const bucketMs = interval * MINUTE_MS;
    const monthly = this.layoutOf(venue, interval) === "month";
    const containerOf = monthly ? monthStartOf : dayStartOf;
    const byDay = new Map<number, Candle[]>();
    let previous: Candle | undefined;
    for (const c of [...candles].sort((a, b) => a.openMs - b.openMs)) {
      if (!basicCandle(c) || c.openMs % bucketMs !== 0 || c.openMs > notAfterMs) continue;
      let valid = strictCandle(c);
      if (!valid && source === "native" && venue === "bitunix") {
        // A first page row can be retained solely as raw boundary evidence.
        // read() will not serve it without a cached predecessor.
        valid = previous === undefined || validAfter(venue, interval, c, previous);
      }
      if (!valid) { previous = undefined; continue; }
      const d = containerOf(c.openMs);
      const list = byDay.get(d);
      if (list) list.push(c); else byDay.set(d, [c]);
      previous = c;
    }
    let written = 0;
    const listing = monthly && byDay.size ? this.listing(venue, symbol, interval) : null;
    for (const [day, list] of byDay) {
      let file: string;
      let buf: Buffer;
      const folded: string[] = [];
      if (monthly) {
        file = this.monthFile(venue, symbol, interval, day);
        buf = this.readMonth(venue, symbol, interval, day) ?? Buffer.alloc(this.monthSlots(interval, day) * RECORD_BYTES);
        // Migration on write: fold this month's 0.4.102 day files in before the
        // month file exists, so a present month file is always the whole month.
        // A day slot fills only an empty month slot, or upgrades an aggregate
        // to native evidence; re-running after a crash changes nothing.
        for (let d = day, end = nextMonthStart(day); d < end; d += DAY_MS) {
          const name = `${dayKey(d)}${FILE_EXT}`;
          if (!listing!.has(name)) continue;
          const dbuf = this.readDay(venue, symbol, interval, d);
          if (dbuf) {
            const first = (d - day) / bucketMs;
            for (let s = 0; s < this.slots(interval); s++) {
              const held = this.decode(dbuf, s, d, interval);
              if (!held) continue;
              const existing = this.decode(buf, first + s, day, interval);
              if (existing && !(existing.source === "aggregate" && held.source === "native")) continue;
              dbuf.copy(buf, (first + s) * RECORD_BYTES, s * RECORD_BYTES, (s + 1) * RECORD_BYTES);
            }
          }
          folded.push(path.join(path.dirname(file), name));
        }
      } else {
        file = this.file(venue, symbol, interval, day);
        let held = this.readDay(venue, symbol, interval, day);
        if (!held) {
          // A day file created after a month file (horizon switched off) must
          // carry that day's month slots, or creating it would hide them.
          const month = monthStartOf(day);
          const mbuf = this.readMonth(venue, symbol, interval, month);
          if (mbuf) {
            held = Buffer.alloc(this.slots(interval) * RECORD_BYTES);
            const first = (day - month) / bucketMs;
            mbuf.copy(held, 0, first * RECORD_BYTES, (first + this.slots(interval)) * RECORD_BYTES);
          }
        }
        buf = held ?? Buffer.alloc(this.slots(interval) * RECORD_BYTES);
      }
      for (const c of list) {
        const slot = (c.openMs - day) / bucketMs;
        const existing = this.decode(buf, slot, day, interval);
        // Direct venue evidence always wins over a derived cache row.
        if (existing?.source === "native" && source === "aggregate") continue;
        const off = slot * RECORD_BYTES;
        buf.writeBigInt64LE(BigInt(c.openMs), off);
        buf.writeDoubleLE(c.open, off + 8); buf.writeDoubleLE(c.high, off + 16);
        buf.writeDoubleLE(c.low, off + 24); buf.writeDoubleLE(c.close, off + 32);
        buf.writeDoubleLE(c.volume, off + 40);
        buf.writeUInt8(source === "native" ? SOURCE_NATIVE : SOURCE_AGGREGATE, off + 48);
        buf.writeUInt16LE(baseInterval, off + 49);
        written++;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      for (const f of folded) fs.rmSync(f, { force: true });
    }
    return written;
  }

  read(venue: VenueId, symbol: string, interval: TimeframeInterval, fromMs: number, toMs: number): CachedCandle[] {
    const bucketMs = interval * MINUTE_MS;
    const from = Math.ceil(fromMs / bucketMs) * bucketMs;
    const to = Math.floor(toMs / bucketMs) * bucketMs;
    const out: CachedCandle[] = [];
    if (to < from) return out;
    let previous: CachedCandle | undefined;
    const scanFrom = venue === "bitunix" ? from - bucketMs : from;
    const monthly = this.layoutOf(venue, interval) === "month";
    const listing = monthly ? this.listing(venue, symbol, interval) : null;
    const months = new Map<number, Buffer | null>();
    const monthBuf = (month: number): Buffer | null => {
      if (!months.has(month)) {
        months.set(month, listing && !listing.has(`${monthKey(month)}${MONTH_EXT}`)
          ? null : this.readMonth(venue, symbol, interval, month));
      }
      return months.get(month)!;
    };
    for (let day = dayStartOf(scanFrom); day <= to; day += DAY_MS) {
      // The layout's own container wins; the other is the fallback for data
      // written before the horizon was switched on (or after it was removed).
      let buf: Buffer | null;
      let base = day;
      if (monthly) {
        const month = monthStartOf(day);
        buf = monthBuf(month);
        if (buf) base = month;
        else buf = listing!.has(`${dayKey(day)}${FILE_EXT}`) ? this.readDay(venue, symbol, interval, day) : null;
      } else {
        buf = this.readDay(venue, symbol, interval, day);
        if (!buf) {
          const month = monthStartOf(day);
          buf = monthBuf(month);
          if (buf) base = month;
        }
      }
      if (!buf) { previous = undefined; continue; }
      const offset = (day - base) / bucketMs;
      const lo = Math.max(0, Math.ceil((scanFrom - day) / bucketMs));
      const hi = Math.min(this.slots(interval) - 1, Math.floor((to - day) / bucketMs));
      for (let slot = lo; slot <= hi; slot++) {
        const c = this.decode(buf, offset + slot, base, interval);
        if (!c) { previous = undefined; continue; }
        const valid = validAfter(venue, interval, c, previous);
        if (c.openMs >= from && valid) out.push(c);
        previous = valid || c.openMs < from ? c : undefined;
      }
    }
    return out;
  }

  gaps(venue: VenueId, symbol: string, interval: TimeframeInterval, from: number, to: number): Gap[] {
    if (to < from) return [];
    const step = interval * MINUTE_MS;
    const held = new Set(this.read(venue, symbol, interval, from, to).map((c) => c.openMs));
    const gaps: Gap[] = [];
    let start: number | null = null;
    for (let at = from; at <= to; at += step) {
      if (!held.has(at) && start === null) start = at;
      if (held.has(at) && start !== null) { gaps.push([start, at - step]); start = null; }
    }
    if (start !== null) gaps.push([start, to]);
    return gaps;
  }

  /** Remove files wholly older than the cutoff. `olderThan` is one instant for
   *  every series (0.4.102) or a per-(venue, interval) resolver (v0.4.103
   *  horizon retention). A month file goes only when its whole month is older. */
  prune(olderThan: number | ((venue: string, interval: number) => number)): number {
    const cutoffFor = typeof olderThan === "number" ? () => olderThan : olderThan;
    let removed = 0;
    const entries = (dir: string): fs.Dirent[] => {
      try { return fs.readdirSync(dir, { withFileTypes: true }); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
    };
    for (const v of entries(this.rootDir)) {
      if (!v.isDirectory()) continue;
      for (const sym of entries(path.join(this.rootDir, v.name))) {
        if (!sym.isDirectory()) continue;
        for (const iv of entries(path.join(this.rootDir, v.name, sym.name))) {
          if (!iv.isDirectory()) continue;
          const dir = path.join(this.rootDir, v.name, sym.name, iv.name);
          const cutoff = dayStartOf(cutoffFor(v.name, Number(iv.name)));
          if (!Number.isFinite(cutoff)) continue;
          for (const entry of entries(dir)) {
            if (!entry.isFile()) continue;
            if (entry.name.endsWith(FILE_EXT)) {
              const key = entry.name.slice(0, -FILE_EXT.length);
              const day = /^\d{4}-\d{2}-\d{2}$/.test(key) ? Date.parse(`${key}T00:00:00.000Z`) : NaN;
              if (Number.isFinite(day) && day < cutoff) { fs.unlinkSync(path.join(dir, entry.name)); removed++; }
            } else if (entry.name.endsWith(MONTH_EXT)) {
              const key = entry.name.slice(0, -MONTH_EXT.length);
              const month = /^\d{4}-\d{2}$/.test(key) ? Date.parse(`${key}-01T00:00:00.000Z`) : NaN;
              if (Number.isFinite(month) && nextMonthStart(month) <= cutoff) { fs.unlinkSync(path.join(dir, entry.name)); removed++; }
            }
          }
        }
      }
    }
    return removed;
  }
}

export interface TimeframeUnsigned {
  v: 2;
  venue: VenueId;
  symbol: string;
  interval: string;
  fromMs: number;
  toMs: number;
  requiredFromMs: number;
  requiredClosedToMs: number;
  closedFrontierMs: number;
  availableFromMs: number;
  availableRows: number;
  requiredRows: number;
  complete: boolean;
  rows: Row[];
  gaps: Gap[];
  segments: TimeframeSegment[];
  keyId: string;
}
export interface TimeframeSigned extends TimeframeUnsigned { sig: string }

export const TIMEFRAME_CANONICAL_KEY_ORDER = [
  "v", "venue", "symbol", "interval", "fromMs", "toMs", "requiredFromMs", "requiredClosedToMs",
  "closedFrontierMs", "availableFromMs", "availableRows", "requiredRows", "complete", "rows", "gaps",
  "segments", "keyId",
] as const;

export function canonicalTimeframeBytes(p: TimeframeUnsigned): Buffer {
  return Buffer.from(JSON.stringify({
    v: p.v, venue: p.venue, symbol: p.symbol, interval: p.interval, fromMs: p.fromMs, toMs: p.toMs,
    requiredFromMs: p.requiredFromMs, requiredClosedToMs: p.requiredClosedToMs,
    closedFrontierMs: p.closedFrontierMs, availableFromMs: p.availableFromMs,
    availableRows: p.availableRows, requiredRows: p.requiredRows, complete: p.complete,
    rows: p.rows, gaps: p.gaps, segments: p.segments, keyId: p.keyId,
  }), "utf8");
}

/** Rows, gaps and maximally compressed provenance segments for one window.
 *  Shared by the synchronous path and the read-only long-window worker, so the
 *  two can never disagree about the signed body for the same held rows. */
export function assembleTimeframe(
  venue: VenueId, symbol: string, interval: TimeframeInterval, fromMs: number, toMs: number,
  requiredFromMs: number, requiredClosedToMs: number, requiredRows: number,
  held: readonly CachedCandle[], keyId: string,
): { payload: TimeframeUnsigned | null; gaps: Gap[] } {
  const bucketMs = interval * MINUTE_MS;
  const rows: Row[] = held.map((c) => [c.openMs, c.open, c.high, c.low, c.close, c.volume]);
  const present = new Set(held.map((c) => c.openMs));
  const gaps: Gap[] = [];
  let gapStart: number | null = null;
  for (let at = requiredFromMs; at <= requiredClosedToMs; at += bucketMs) {
    if (!present.has(at) && gapStart === null) gapStart = at;
    if (present.has(at) && gapStart !== null) { gaps.push([gapStart, at - bucketMs]); gapStart = null; }
  }
  if (gapStart !== null) gaps.push([gapStart, requiredClosedToMs]);
  if (!rows.length) return { payload: null, gaps };
  const segments: TimeframeSegment[] = [];
  for (const candle of held) {
    const prior = segments.at(-1);
    if (prior && prior[1] + bucketMs === candle.openMs && prior[2] === candle.source && prior[3] === candle.baseInterval) {
      prior[1] = candle.openMs;
    } else segments.push([candle.openMs, candle.openMs, candle.source, candle.baseInterval]);
  }
  return {
    gaps,
    payload: {
      v: 2, venue, symbol, interval: String(interval), fromMs, toMs, requiredFromMs, requiredClosedToMs,
      closedFrontierMs: rows.at(-1)![0], availableFromMs: rows[0]![0], availableRows: rows.length,
      requiredRows, complete: gaps.length === 0 && rows.length === requiredRows,
      rows, gaps, segments, keyId,
    },
  };
}

/** The provenance rule a served row must satisfy, as a pure function of the
 *  sidecar values, so the worker applies exactly what request() applies. */
export interface TimeframeSafety {
  /** Native frontier per interval for this (venue, symbol); absent = none. */
  frontiers: Readonly<Record<string, number>>;
  minuteFloor: number | null;
  minuteRestFrontier: number | null;
}

export function timeframeRowSafe(interval: number, candle: CachedCandle, safety: TimeframeSafety): boolean {
  if (!basicCandle(candle) || candle.openMs < (safety.minuteFloor ?? -Infinity)) return false;
  if (candle.source === "native") {
    return candle.baseInterval === interval && candle.openMs <= (safety.frontiers[String(interval)] ?? -Infinity);
  }
  if (candle.baseInterval >= interval || interval % candle.baseInterval !== 0) return false;
  const lastBaseOpen = candle.openMs + interval * MINUTE_MS - candle.baseInterval * MINUTE_MS;
  if (candle.baseInterval === 1) return safety.minuteRestFrontier !== null && lastBaseOpen <= safety.minuteRestFrontier;
  return lastBaseOpen <= (safety.frontiers[String(candle.baseInterval)] ?? -Infinity);
}

/** Exact OHLCV fold of `target / base` consecutive base rows (first open, max
 *  high, min low, last close, summed volume — the materialize() arithmetic in
 *  the same order), or null unless every base row is present. */
export function foldBaseRows(target: number, base: number, openMs: number, byOpen: ReadonlyMap<number, Candle>): CachedCandle | null {
  const expected = target / base;
  const baseMs = base * MINUTE_MS;
  let open = 0, high = -Infinity, low = Infinity, close = 0, volume = 0;
  for (let i = 0; i < expected; i++) {
    const row = byOpen.get(openMs + i * baseMs);
    if (!row) return null;
    if (i === 0) open = row.open;
    high = Math.max(high, row.high);
    low = Math.min(low, row.low);
    close = row.close;
    volume += row.volume;
  }
  return { openMs, open, high, low, close, volume, source: "aggregate", baseInterval: base };
}

// ── v0.4.103 — THE LONG HORIZON ─────────────────────────────────────────────
/** One venue's standing horizon: target intervals held for `days`. */
export interface TimeframeHorizonVenue { intervals: TimeframeInterval[]; days: number }
export type TimeframeHorizon = Partial<Record<VenueId, TimeframeHorizonVenue>>;
export const TIMEFRAME_HORIZON_MAX_DAYS = 1095;
/** Rows a v2 request may ask for; a horizon deeper than this could never be served whole. */
export const TIMEFRAME_MAX_REQUEST_ROWS = 50_000;
/** Same values as collector.ts VENUE_EMPTY_CONFIRM_GAP_MS / VENUE_EMPTY_RECHECK_MS
 *  (pinned equal by tests/timeframe-horizon.test.mjs): a venue-empty proof needs
 *  a second read at least an hour later, and a confirmed one is re-read daily. */
export const HORIZON_EMPTY_CONFIRM_GAP_MS = 3_600_000;
export const HORIZON_EMPTY_RECHECK_MS = 24 * 3_600_000;
/** An unanswered or unproductive page waits this long, as legacy demand work does. */
export const HORIZON_RETRY_MS = 5 * MINUTE_MS;
/** The served horizon reaches one day further back than configured, so an app
 *  asking for exactly `days` plus a Bitunix boundary row is not short a row. */
export const HORIZON_PAD_DAYS = 1;
/** At most this long between frontier/proof sidecar writes (crash between
 *  writes: unproven native slots are refetched, see work()). */
export const TIMEFRAME_SIDECAR_DEBOUNCE_MS = 2_000;
/** Long requests: more rows than a 60-day window of the interval. */
export const TIMEFRAME_SHORT_WINDOW_DAYS = 60;
const HORIZON_MAX_ITEMS_PER_CALL = 4096;
const HORIZON_INLINE_INIT_BUDGET_MS = 10;

/** The largest native interval a target can be built from (itself if native). */
export function horizonFetchInterval(venue: VenueId, target: number): TimeframeInterval | null {
  const supported = nativeTimeframeIntervals(venue)
    .filter((n): n is TimeframeInterval => n > 1 && isTimeframeInterval(n) && n <= target && target % n === 0)
    .sort((a, b) => b - a);
  return supported[0] ?? null;
}

/** `HUB_TIMEFRAME_HORIZON` — `venue[,venue…]:interval[,interval…]:days`,
 *  entries separated by `;`. Unset or blank = no horizon (0.4.102 behaviour).
 *  Anything malformed refuses the WHOLE value (never a partial or default
 *  horizon); the caller logs the reason and runs without one. */
export function parseTimeframeHorizon(raw: string | undefined): { ok: true; value: TimeframeHorizon } | { ok: false; error: string } {
  const out: TimeframeHorizon = {};
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, value: out };
  for (const entry of text.split(";").map((e) => e.trim()).filter(Boolean)) {
    const parts = entry.split(":").map((p) => p.trim());
    if (parts.length !== 3) return { ok: false, error: `"${entry.slice(0, 80)}" is not venue:intervals:days` };
    const [venuesText, intervalsText, daysText] = parts as [string, string, string];
    if (!/^\d{1,4}$/.test(daysText)) return { ok: false, error: `days "${daysText.slice(0, 16)}" is not a whole number` };
    const days = Number(daysText);
    if (days < 1 || days > TIMEFRAME_HORIZON_MAX_DAYS) return { ok: false, error: `days must be 1..${TIMEFRAME_HORIZON_MAX_DAYS}` };
    const venues = venuesText.split(",").map((v) => v.trim().toLowerCase());
    const intervalTexts = intervalsText.split(",").map((v) => v.trim());
    if (!venues.length || venues.some((v) => !v) || !intervalTexts.length || intervalTexts.some((v) => !v)) {
      return { ok: false, error: `"${entry.slice(0, 80)}" has an empty venue or interval` };
    }
    for (const venue of venues) {
      if (!isVenueId(venue)) return { ok: false, error: `unknown venue "${venue.slice(0, 32)}"` };
      if (out[venue]) return { ok: false, error: `venue ${venue} is listed twice` };
      const intervals: TimeframeInterval[] = [];
      for (const it of intervalTexts) {
        const interval = /^\d{1,4}$/.test(it) ? Number(it) : NaN;
        if (!isTimeframeInterval(interval)) return { ok: false, error: `interval "${it.slice(0, 16)}" is not a v2 timeframe interval` };
        const fetch = horizonFetchInterval(venue, interval);
        if (fetch === null) return { ok: false, error: `${venue} has no native interval that ${interval}m can be built from` };
        if (Math.ceil((days + HORIZON_PAD_DAYS) * 1440 / interval) > TIMEFRAME_MAX_REQUEST_ROWS) {
          return { ok: false, error: `${venue} ${interval}m over ${days} days exceeds ${TIMEFRAME_MAX_REQUEST_ROWS} rows` };
        }
        if (!nativeTimeframeHistoryRoute(venue, fetch) && (days + HORIZON_PAD_DAYS) * 1440 / fetch > WEEX_RECENT_TIMEFRAME_ROWS) {
          return { ok: false, error: `${venue} ${fetch}m has no ranged history route deep enough for ${days} days` };
        }
        if (!intervals.includes(interval)) intervals.push(interval);
      }
      out[venue] = { intervals: intervals.sort((a, b) => a - b), days };
    }
  }
  return { ok: true, value: out };
}

/** [from, to, firstProofAt, lastProofAt, confirmations] — as collector.ts. */
type EmptyRange = [number, number, number, number, number];
/** The oldest row the venue has: nothing in [checkedFromMs, atMs) twice. */
export interface HorizonFloor {
  atMs: number; checkedFromMs: number; firstAt: number; lastAt: number; confirmations: number;
  /** The venue's first row is a raw Bitunix boundary row the read path cannot
   *  serve (no predecessor exists): its slot is part of the boundary too. */
  rawFirst?: true;
}
interface HorizonProofs { gen: string; floor: HorizonFloor | null; empty: EmptyRange[] }
interface ProofFile { v: 1; entries: Record<string, HorizonProofs> }

interface HorizonCursor {
  key: string; venue: VenueId; symbol: string; interval: TimeframeInterval; targets: TimeframeInterval[];
  ready: boolean; fromMs: number; coveredTo: number;
  /** Sorted, disjoint missing native ranges in [fromMs, coveredTo]. Kept from
   *  rows actually written, so work() never re-reads disk for this series. */
  gaps: Gap[];
  retryAt: number;
}

/** Venue-empty boundary facts surfaced (unsigned) beside a long response. */
export interface TimeframeBoundary {
  horizonFromMs: number;
  floor: HorizonFloor | null;
}

export interface HorizonIntervalStatus {
  interval: TimeframeInterval; fetchInterval: TimeframeInterval; symbols: number; primed: number;
  complete: number; backfilling: number; floored: number; remainingPages: number; remainingWeight: number;
}
export interface HorizonVenueStatus { venue: VenueId; days: number; intervals: HorizonIntervalStatus[] }

export interface TimeframeLongJob {
  rootDir: string;
  layouts: Record<string, TimeframeLayout>;
  venue: VenueId; symbol: string; interval: TimeframeInterval;
  fromMs: number; toMs: number; requiredFromMs: number; requiredClosedToMs: number; requiredRows: number;
  keyId: string; safety: TimeframeSafety;
  /** Fold missing target rows from this native base (aggregate-only targets). */
  foldBase: TimeframeInterval | null;
  /** Listing generation the safety values belong to (checked again on finish). */
  generation: string;
}
export type TimeframeLongReply =
  | { ok: true; canonical: Uint8Array; rows: number; complete: boolean }
  | { ok: false; code: 503 | 500; error: string };
export type TimeframeLongPrepared =
  | { ok: true; job: TimeframeLongJob; boundary: TimeframeBoundary | null }
  | { ok: false; code: 400 | 404 | 503; error: string };
export type TimeframeLongOutcome =
  | { ok: true; body: Buffer; boundary: TimeframeBoundary | null }
  | { ok: false; code: 400 | 404 | 500 | 503; error: string };

/** Read-only build of one long window: the worker's whole job. */
export function buildTimeframeLong(job: TimeframeLongJob): TimeframeLongReply {
  const store = new TimeframeStore(job.rootDir, (_venue, interval) => job.layouts[String(interval)] ?? "day");
  const { venue, symbol, interval, requiredFromMs, requiredClosedToMs } = job;
  const step = interval * MINUTE_MS;
  let held = store.read(venue, symbol, interval, requiredFromMs, requiredClosedToMs)
    .filter((c) => timeframeRowSafe(interval, c, job.safety));
  if (job.foldBase !== null && held.length < job.requiredRows) {
    const base = job.foldBase;
    const byOpen = new Map<number, Candle>();
    for (const c of store.read(venue, symbol, base, requiredFromMs, requiredClosedToMs + step - base * MINUTE_MS)) {
      if (c.source === "native" && timeframeRowSafe(base, c, job.safety)) byOpen.set(c.openMs, c);
    }
    const present = new Set(held.map((c) => c.openMs));
    const merged: CachedCandle[] = [];
    let i = 0;
    for (let at = requiredFromMs; at <= requiredClosedToMs; at += step) {
      if (present.has(at)) { merged.push(held[i++]!); continue; }
      const folded = foldBaseRows(interval, base, at, byOpen);
      if (folded && basicCandle(folded) && folded.openMs >= (job.safety.minuteFloor ?? -Infinity)) merged.push(folded);
    }
    held = merged;
  }
  const built = assembleTimeframe(venue, symbol, interval, job.fromMs, job.toMs, requiredFromMs, requiredClosedToMs,
    job.requiredRows, held, job.keyId);
  if (!built.payload) return { ok: false, code: 503, error: `no closed ${interval}m candles cached yet for ${venue} ${symbol}` };
  const bytes = canonicalTimeframeBytes(built.payload);
  const canonical = new Uint8Array(bytes.length);
  canonical.set(bytes);
  return { ok: true, canonical, rows: built.payload.availableRows, complete: built.payload.complete };
}

/** canonical bytes + signature, byte-identical to JSON.stringify({...payload, sig}). */
export function signedTimeframeBody(canonical: Uint8Array, sig: string): Buffer {
  const head = Buffer.from(canonical.buffer, canonical.byteOffset, canonical.byteLength - 1);
  if (canonical[canonical.byteLength - 1] !== 0x7d) throw new Error("canonical timeframe bytes do not end an object");
  return Buffer.concat([head, Buffer.from(`,"sig":${JSON.stringify(sig)}}`, "utf8")]);
}

interface Demand {
  venue: VenueId; symbol: string; targetInterval: TimeframeInterval;
  fetchInterval: TimeframeInterval; fromMs: number; toMs: number; touchedAt: number;
}
export interface TimeframeWork {
  key: string; venue: VenueId; symbol: string; targetInterval: TimeframeInterval;
  interval: TimeframeInterval; startMs: number; endMs: number;
  /** v0.4.103 — set on standing-horizon pages only. */
  horizon?: true;
  route?: NativeTimeframeRoute;
  /** Venue request weight of this page (WEEX distinguishes 1 and 5). */
  weight?: number;
  /** First slot the page answers for (startMs + one Bitunix predecessor). */
  proofFromMs?: number;
  targets?: TimeframeInterval[];
}
interface FrontierFile { v: 2; frontiers: Record<string, number> }
interface IdentityFile { v: 2; identities: Record<string, string>; minuteFloors?: Record<string, number> }

interface InterestState { targets: Set<TimeframeInterval>; touchedAt: number }
interface MaterializedState { fromMs: number; toMs: number; minuteFrontier: number | null; touchedAt: number }

const ACTIVE_TTL_MS = 6 * 3_600_000;
const MAX_DEMANDS = 4096;
const MAX_INTERESTS = 4096;
// 700 pairs can keep every offered higher interval active without eviction.
const MAX_MATERIALIZED = 8192;

export type TimeframeOutcome =
  | { ok: true; payload: TimeframeSigned }
  | { ok: false; code: 400 | 404 | 503; error: string };

export interface TimeframeHistoryOptions {
  /** v0.4.103 — standing long-horizon intervals per venue. Absent = none. */
  horizon?: TimeframeHorizon;
  /** Sidecar debounce clock (wall ms). Defaults to Date.now. */
  clock?: () => number;
}

function subtractOpens(gaps: Gap[], opens: readonly number[], step: number): Gap[] {
  if (!gaps.length || !opens.length) return gaps;
  const sorted = [...new Set(opens)].sort((a, b) => a - b);
  const out: Gap[] = [];
  let k = 0;
  for (const [g0, g1] of gaps) {
    let start = g0;
    while (k < sorted.length && sorted[k]! < g0) k++;
    while (k < sorted.length && sorted[k]! <= g1) {
      const at = sorted[k]!;
      if (at > start) out.push([start, at - step]);
      start = at + step;
      k++;
    }
    if (start <= g1) out.push([start, g1]);
  }
  return out;
}

function inGaps(gaps: readonly Gap[], at: number): boolean {
  for (const [a, b] of gaps) { if (at < a) return false; if (at <= b) return true; }
  return false;
}

function subtractRanges(gap: Gap, cut: readonly Gap[], step: number): Gap[] {
  let parts: Gap[] = [gap];
  for (const [a, b] of cut) {
    const next: Gap[] = [];
    for (const [p0, p1] of parts) {
      if (b < p0 || a > p1) { next.push([p0, p1]); continue; }
      if (a > p0) next.push([p0, a - step]);
      if (b < p1) next.push([b + step, p1]);
    }
    parts = next;
  }
  return parts;
}

export class TimeframeHistory {
  readonly store: TimeframeStore;
  private readonly demands = new Map<string, Demand>();
  private readonly frontierFile: string;
  private readonly identityFile: string;
  private readonly proofFile: string;
  private readonly frontiers = new Map<string, number>();
  private readonly identities = new Map<string, string>();
  private readonly minuteFloors = new Map<string, number>();
  private cursorByVenue = new Map<VenueId, number>();
  private readonly lastAttempts = new Map<string, number>();
  private readonly interests = new Map<string, InterestState>();
  private readonly materialized = new Map<string, MaterializedState>();
  private readonly horizon: TimeframeHorizon;
  /** fetch interval -> targets it serves, per horizon venue. */
  private readonly horizonFetches = new Map<VenueId, Map<TimeframeInterval, TimeframeInterval[]>>();
  /** Every interval retained to the horizon (targets and their fetch bases). */
  private readonly horizonRetained = new Map<VenueId, Set<number>>();
  private readonly cursors = new Map<string, HorizonCursor>();
  private readonly proofs = new Map<string, HorizonProofs>();
  private readonly horizonRotation = new Map<VenueId, number>();
  private readonly clock: () => number;
  private frontiersDirty = false;
  private proofsDirty = false;
  private lastSidecarWriteAt = -Infinity;

  constructor(rootDir: string, private readonly minutes: CandleStore, private readonly retentionDays: number,
    options: TimeframeHistoryOptions = {}) {
    this.horizon = options.horizon ?? {};
    this.clock = options.clock ?? Date.now;
    for (const venue of VENUE_IDS) {
      const h = this.horizon[venue];
      if (!h) continue;
      const fetches = new Map<TimeframeInterval, TimeframeInterval[]>();
      const retained = new Set<number>();
      for (const target of h.intervals) {
        const fetch = horizonFetchInterval(venue, target);
        if (fetch === null) continue;
        const list = fetches.get(fetch) ?? [];
        list.push(target);
        fetches.set(fetch, list);
        retained.add(target); retained.add(fetch);
      }
      this.horizonFetches.set(venue, fetches);
      this.horizonRetained.set(venue, retained);
    }
    this.store = new TimeframeStore(rootDir, (venue, interval) =>
      isVenueId(venue) && this.horizonRetained.get(venue)?.has(interval) ? "month" : "day");
    this.frontierFile = path.join(rootDir, "native-frontier.v2.json");
    this.identityFile = path.join(rootDir, "instrument-identity.v2.json");
    this.proofFile = path.join(rootDir, "horizon-proofs.v1.json");
    const persisted = readJson<FrontierFile>(this.frontierFile, { v: 2, frontiers: {} });
    if (persisted.v === 2) for (const [key, value] of Object.entries(persisted.frontiers ?? {})) {
      if (Number.isSafeInteger(value) && value > 0) this.frontiers.set(key, value);
    }
    const identities = readJson<IdentityFile>(this.identityFile, { v: 2, identities: {} });
    if (identities.v === 2) for (const [key, value] of Object.entries(identities.identities ?? {})) {
      if (typeof value === "string" && value.length <= 128) this.identities.set(key, value);
    }
    if (identities.v === 2) for (const [key, value] of Object.entries(identities.minuteFloors ?? {})) {
      if (Number.isSafeInteger(value) && value > 0) this.minuteFloors.set(key, value);
    }
    const proofs = readJson<ProofFile>(this.proofFile, { v: 1, entries: {} });
    if (proofs.v === 1) for (const [key, entry] of Object.entries(proofs.entries ?? {})) {
      if (!entry || typeof entry !== "object" || typeof entry.gen !== "string") continue;
      const floor = entry.floor && [entry.floor.atMs, entry.floor.checkedFromMs, entry.floor.firstAt, entry.floor.lastAt, entry.floor.confirmations]
        .every((v) => Number.isSafeInteger(v)) ? { ...entry.floor } : null;
      const empty = Array.isArray(entry.empty) ? entry.empty.filter((r) => Array.isArray(r) && r.length === 5
        && r.every((v) => Number.isSafeInteger(v)) && r[0] <= r[1]).map((r) => [...r] as EmptyRange) : [];
      this.proofs.set(key, { gen: entry.gen, floor, empty });
    }
    this.migrateBitgetDaily(rootDir);
  }

  /** v0.4.103 — Bitget's native daily moved from `1D` (16:00 UTC opens) to
   *  `1Dutc`. A `1D` row could never have been stored (record() refuses an
   *  open off the UTC day grid), so there is no data to rewrite; any bitget
   *  1440 native frontier is nevertheless dropped once, so no native daily
   *  row can be served without being refetched through `1Dutc`. Marker-guarded. */
  private migrateBitgetDaily(rootDir: string): void {
    const marker = path.join(rootDir, "bitget-1dutc.v1.done");
    // A Hub that has never held timeframe data has nothing to migrate and
    // gets no directory created on its behalf.
    if (!fs.existsSync(rootDir) || fs.existsSync(marker)) return;
    let changed = false;
    for (const key of [...this.frontiers.keys()]) {
      const [venue, , interval] = key.split("\u0000");
      if (venue === "bitget" && interval === "1440") { this.frontiers.delete(key); changed = true; }
    }
    if (changed) writeJsonAtomic(this.frontierFile, { v: 2, frontiers: Object.fromEntries(this.frontiers) } satisfies FrontierFile);
    try {
      fs.writeFileSync(marker, "bitget native daily = 1Dutc\n");
    } catch { /* re-run next start: the step is idempotent */ }
  }

  private identity(venue: VenueId, symbol: string, interval: number): string {
    return `${venue}\u0000${symbol}\u0000${interval}`;
  }

  private instrumentIdentity(venue: VenueId, symbol: string): string {
    return `${venue}\u0000${symbol}`;
  }

  private persistIdentities(): void {
    writeJsonAtomic(this.identityFile, {
      v: 2, identities: Object.fromEntries(this.identities), minuteFloors: Object.fromEntries(this.minuteFloors),
    } satisfies IdentityFile);
  }

  /** Write the frontier/proof sidecars if they changed. `force` ignores the
   *  debounce (service stop, end of a collector pass, tests). */
  flush(force = true): void {
    if (!this.frontiersDirty && !this.proofsDirty) return;
    const at = this.clock();
    if (!force && at - this.lastSidecarWriteAt < TIMEFRAME_SIDECAR_DEBOUNCE_MS) return;
    this.lastSidecarWriteAt = at;
    if (this.frontiersDirty) {
      this.frontiersDirty = false;
      writeJsonAtomic(this.frontierFile, { v: 2, frontiers: Object.fromEntries(this.frontiers) } satisfies FrontierFile);
    }
    if (this.proofsDirty) {
      this.proofsDirty = false;
      writeJsonAtomic(this.proofFile, { v: 1, entries: Object.fromEntries(this.proofs) } satisfies ProofFile);
    }
  }

  private maxMaterialized(): number { return Math.max(MAX_MATERIALIZED, this.cursors.size * 2); }
  private maxInterests(): number { return Math.max(MAX_INTERESTS, this.cursors.size); }

  private trimState(now: number): void {
    for (const [key, d] of this.demands) if (now - d.touchedAt > ACTIVE_TTL_MS) this.demands.delete(key);
    for (const [key, state] of this.interests) if (now - state.touchedAt > ACTIVE_TTL_MS) this.interests.delete(key);
    for (const [key, state] of this.materialized) if (now - state.touchedAt > ACTIVE_TTL_MS) this.materialized.delete(key);
    for (const [key, at] of this.lastAttempts) if (now - at > ACTIVE_TTL_MS) this.lastAttempts.delete(key);
    while (this.demands.size > MAX_DEMANDS) this.demands.delete(this.demands.keys().next().value!);
    const maxInterests = this.maxInterests();
    while (this.interests.size > maxInterests) this.interests.delete(this.interests.keys().next().value!);
    const maxMaterialized = this.maxMaterialized();
    while (this.materialized.size > maxMaterialized) this.materialized.delete(this.materialized.keys().next().value!);
    while (this.lastAttempts.size > 8192) this.lastAttempts.delete(this.lastAttempts.keys().next().value!);
  }

  /** Fence persisted bars to one venue census lifecycle. A symbol spelling
   * reused after delisting cannot inherit the previous instrument's prices. */
  noteInstrumentRoster(venue: VenueId, rows: readonly { symbol: string; generation: string }[]): void {
    let identitiesChanged = false;
    let frontiersChanged = false;
    for (const row of rows) {
      if (!isSafeSegment(row.symbol) || !row.generation || row.generation.length > 128) continue;
      const key = this.instrumentIdentity(venue, row.symbol);
      const prior = this.identities.get(key);
      if (prior !== undefined && prior !== row.generation) {
        this.store.invalidateSymbol(venue, row.symbol);
        const prefix = `${key}\u0000`;
        for (const id of [...this.frontiers.keys()]) if (id.startsWith(prefix)) { this.frontiers.delete(id); frontiersChanged = true; }
        for (const id of [...this.demands.keys()]) if (id.startsWith(prefix)) this.demands.delete(id);
        for (const id of [...this.materialized.keys()]) if (id.startsWith(prefix)) this.materialized.delete(id);
        for (const id of [...this.cursors.keys()]) if (id.startsWith(prefix)) this.cursors.delete(id);
        for (const id of [...this.proofs.keys()]) if (id.startsWith(prefix)) { this.proofs.delete(id); this.proofsDirty = true; }
        this.interests.delete(this.identity(venue, row.symbol, 1));
        const generationAt = Number(row.generation.slice(row.generation.lastIndexOf(":") + 1));
        if (Number.isSafeInteger(generationAt) && generationAt > 0) this.minuteFloors.set(key, generationAt);
      }
      if (prior !== row.generation) { this.identities.set(key, row.generation); identitiesChanged = true; }
    }
    if (identitiesChanged) this.persistIdentities();
    if (frontiersChanged) {
      // A removed frontier is written at once (undebounced): it is the fence
      // that stops a reused symbol serving its predecessor's rows.
      this.frontiersDirty = false;
      writeJsonAtomic(this.frontierFile, { v: 2, frontiers: Object.fromEntries(this.frontiers) } satisfies FrontierFile);
    }
    if (this.proofsDirty) this.flush();
  }

  private bestNativeBase(venue: VenueId, target: TimeframeInterval): TimeframeInterval | null {
    return horizonFetchInterval(venue, target);
  }

  /** Rebuild derived rows from the largest complete compatible cached source. */
  materialize(venue: VenueId, symbol: string, target: TimeframeInterval, from: number, to: number,
    minuteRestFrontier: number | null): void {
    const targetMs = target * MINUTE_MS;
    const safeFrom = Math.ceil(from / targetMs) * targetMs;
    const safeTo = Math.floor(to / targetMs) * targetMs;
    if (safeTo < safeFrom) return;
    const bases = [
      ...nativeTimeframeIntervals(venue).filter((n) => n > 1 && n < target && target % n === 0), 1,
    ].filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => b - a);
    const existingNative = new Set(this.store.read(venue, symbol, target, safeFrom, safeTo)
      .filter((c) => this.safe(venue, symbol, target, c, minuteRestFrontier) && c.source === "native")
      .map((c) => c.openMs));
    if (existingNative.size === (safeTo - safeFrom) / targetMs + 1) return;

    // Read each compatible source once. The old per-target implementation read
    // and atomically rewrote day files for every output bar; a 700 x 720 warmup
    // therefore caused roughly half a million synchronous scans and rewrites.
    const byBase = new Map<number, Map<number, Row> | { rows: Row[]; firstMs: number }>();
    const minuteFloor = this.minuteFloors.get(this.instrumentIdentity(venue, symbol)) ?? -Infinity;
    for (const base of bases) {
      const baseMs = base * MINUTE_MS;
      const sourceFrom = venue === "bitunix" ? Math.max(0, safeFrom - baseMs) : safeFrom;
      const sourceTo = safeTo + targetMs - baseMs;
      let rows: Row[];
      if (base === 1) {
        if (minuteRestFrontier === null || sourceTo > minuteRestFrontier) {
          // A shorter confirmed suffix may still complete earlier targets.
          if (minuteRestFrontier === null || minuteRestFrontier < safeFrom) continue;
        }
        rows = this.minutes.readWindow(venue, symbol, sourceFrom, Math.min(sourceTo, minuteRestFrontier!)).rows;
      } else {
        if (!isTimeframeInterval(base)) continue;
        if (!this.frontiers.has(this.identity(venue, symbol, base))) continue;
        rows = this.store.read(venue, symbol, base, sourceFrom, sourceTo)
          .filter((c) => this.safe(venue, symbol, base, c, minuteRestFrontier))
          .map((c) => [c.openMs, c.open, c.high, c.low, c.close, c.volume]);
      }
      // A regular, strictly valid series needs no timestamp hash index. Prove
      // every row before choosing direct offsets; gaps, duplicates, disorder,
      // invalid values and Bitunix carried opens retain the original fallback.
      let dense = rows.length > 0;
      const firstMs = rows[0]?.[0] ?? 0;
      for (let i = 0; dense && i < rows.length; i++) {
        const row = rows[i];
        dense = row[0] === firstMs + i * baseMs && row[0] % baseMs === 0
          && basicValues(row[0], row[1], row[2], row[3], row[4], row[5])
          && row[0] >= minuteFloor && row[2] >= row[1] && row[3] <= row[1];
      }
      if (dense) {
        byBase.set(base, { rows, firstMs });
        continue;
      }
      const indexed = new Map<number, Row>();
      let previous: Row | undefined;
      for (const row of rows) {
        // Validate the source tuple once without allocating a Candle or a
        // finite-check array for every minute in a deep history window.
        const structurallyValid = row[0] % baseMs === 0
          && basicValues(row[0], row[1], row[2], row[3], row[4], row[5]) && row[0] >= minuteFloor;
        const valid = structurallyValid && ((row[2] >= row[1] && row[3] <= row[1])
          || (venue === "bitunix" && previous !== undefined
            && row[0] - previous[0] === baseMs && row[1] === previous[4]));
        if (valid) {
          indexed.set(row[0], row);
        }
        // Bitunix's first raw row may be the predecessor for the next carried
        // open, but a malformed interior row cannot bridge a gap.
        previous = valid || (structurallyValid && venue === "bitunix" && previous === undefined)
          ? row : undefined;
      }
      byBase.set(base, indexed);
    }

    const writes = new Map<number, Candle[]>();
    for (let openMs = safeFrom; openMs <= safeTo; openMs += targetMs) {
      if (existingNative.has(openMs)) continue;
      for (const base of bases) {
        const baseMs = base * MINUTE_MS;
        const indexed = byBase.get(base);
        if (!indexed) continue;
        const dense = indexed instanceof Map ? null : indexed;
        const sparse = indexed instanceof Map ? indexed : null;
        const offset = dense ? (openMs - dense.firstMs) / baseMs : 0;
        const expected = target / base;
        let count = 0;
        let open = 0;
        let high = -Infinity;
        let low = Infinity;
        let close = 0;
        let volume = 0;
        for (let i = 0; i < expected; i++) {
          const row = dense ? dense.rows[offset + i] : sparse!.get(openMs + i * baseMs);
          if (!row) break;
          if (i === 0) open = row[1];
          high = Math.max(high, row[2]);
          low = Math.min(low, row[3]);
          close = row[4];
          volume += row[5];
          count++;
        }
        if (count !== expected) continue;
        const candle: Candle = { openMs, open, high, low, close, volume };
        const batch = writes.get(base);
        if (batch) batch.push(candle); else writes.set(base, [candle]);
        break;
      }
    }
    for (const [base, candles] of writes) {
      this.store.write(venue, symbol, target, candles, "aggregate", base, safeTo);
    }
  }

  private ensureMaterialized(venue: VenueId, symbol: string, target: TimeframeInterval,
    fromMs: number, toMs: number, minuteRestFrontier: number | null, now: number): void {
    const id = this.identity(venue, symbol, target);
    const prior = this.materialized.get(id);
    if (!prior) {
      this.materialize(venue, symbol, target, fromMs, toMs, minuteRestFrontier);
      this.materialized.set(id, { fromMs, toMs, minuteFrontier: minuteRestFrontier, touchedAt: now });
      this.trimState(now);
      return;
    }
    const bucketMs = target * MINUTE_MS;
    if (fromMs < prior.fromMs) this.materialize(venue, symbol, target, fromMs, prior.fromMs - bucketMs, minuteRestFrontier);
    if (toMs > prior.toMs) this.materialize(venue, symbol, target, prior.toMs + bucketMs, toMs, minuteRestFrontier);
    // A frontier advance can complete only buckets whose final minute lies in
    // the newly confirmed suffix. Corrections at an unchanged frontier arrive
    // through noteMinuteRows(), below, with their exact affected range.
    if (minuteRestFrontier !== null && (prior.minuteFrontier === null || minuteRestFrontier > prior.minuteFrontier)) {
      const changedAt = prior.minuteFrontier === null ? fromMs : prior.minuteFrontier + MINUTE_MS;
      const affected = Math.floor(changedAt / bucketMs) * bucketMs;
      this.materialize(venue, symbol, target, Math.max(fromMs, affected), toMs, minuteRestFrontier);
    }
    this.materialized.set(id, {
      fromMs: Math.min(fromMs, prior.fromMs), toMs: Math.max(toMs, prior.toMs),
      minuteFrontier: minuteRestFrontier, touchedAt: now,
    });
    this.trimState(now);
  }

  /** REST writes are the invalidation event. Rebuild only target buckets that
   * overlap the admitted rows; websocket rows remain ineligible until their
   * ordinary reconcile establishes REST provenance. */
  noteMinuteRows(venue: VenueId, symbol: string, candles: readonly Candle[], minuteRestFrontier: number | null): void {
    if (!candles.length) return;
    const interest = this.interests.get(this.identity(venue, symbol, 1));
    if (!interest?.targets.size) return;
    const first = Math.min(...candles.map((c) => c.openMs));
    const last = Math.max(...candles.map((c) => c.openMs));
    for (const target of interest.targets) {
      const bucketMs = target * MINUTE_MS;
      const from = Math.floor(first / bucketMs) * bucketMs;
      const to = Math.floor(last / bucketMs) * bucketMs;
      this.materialize(venue, symbol, target, from, to, minuteRestFrontier);
      const id = this.identity(venue, symbol, target);
      const prior = this.materialized.get(id);
      if (prior) prior.minuteFrontier = minuteRestFrontier;
    }
  }

  /** The required window both request paths derive from the caller's range. */
  private window(interval: TimeframeInterval, fromMs: number, toMs: number, now: number):
    { ok: true; requiredFromMs: number; requiredClosedToMs: number; requiredRows: number }
    | { ok: false; code: 400 | 503; error: string } {
    if (![fromMs, toMs, now].every((v) => Number.isSafeInteger(v) && v >= 0) || toMs < fromMs) {
      return { ok: false, code: 400, error: "fromMs and toMs must be non-negative epoch-ms integers in ascending order" };
    }
    const bucketMs = interval * MINUTE_MS;
    const requiredFromMs = Math.ceil(fromMs / bucketMs) * bucketMs;
    const requiredClosedToMs = Math.min(Math.floor(toMs / bucketMs) * bucketMs,
      Math.floor(now / bucketMs) * bucketMs - bucketMs);
    if (requiredClosedToMs < requiredFromMs) {
      return { ok: false, code: 503, error: `no closed ${interval}m candle exists in the requested window` };
    }
    const requiredRows = (requiredClosedToMs - requiredFromMs) / bucketMs + 1;
    if (requiredRows > TIMEFRAME_MAX_REQUEST_ROWS) {
      return { ok: false, code: 400, error: "window too large: at most 50000 timeframe rows per request" };
    }
    return { ok: true, requiredFromMs, requiredClosedToMs, requiredRows };
  }

  private noteInterest(venue: VenueId, symbol: string, interval: TimeframeInterval, now: number): void {
    const interestId = this.identity(venue, symbol, 1);
    let interest = this.interests.get(interestId);
    if (!interest) this.interests.set(interestId, interest = { targets: new Set(), touchedAt: now });
    interest.targets.add(interval);
    interest.touchedAt = now;
  }

  /** The standing cursor that keeps this target's native base filled, if any. */
  private standingCursor(venue: VenueId, symbol: string, target: TimeframeInterval): HorizonCursor | undefined {
    const fetch = this.horizonFetches.get(venue) ? horizonFetchInterval(venue, target) : null;
    if (fetch === null || !this.horizonFetches.get(venue)!.get(fetch)?.includes(target)) return undefined;
    return this.cursors.get(this.identity(venue, symbol, fetch));
  }

  request(venue: VenueId, symbol: string, interval: TimeframeInterval, fromMs: number, toMs: number, now: number,
    minuteRestFrontier: number | null, keyId: string, sign: (bytes: Buffer) => Buffer): TimeframeOutcome {
    const w = this.window(interval, fromMs, toMs, now);
    if (!w.ok) return w;
    const { requiredFromMs, requiredClosedToMs, requiredRows } = w;
    this.noteInterest(venue, symbol, interval, now);
    this.ensureMaterialized(venue, symbol, interval, requiredFromMs, requiredClosedToMs, minuteRestFrontier, now);
    const held = this.store.read(venue, symbol, interval, requiredFromMs, requiredClosedToMs)
      .filter((c) => this.safe(venue, symbol, interval, c, minuteRestFrontier));
    const built = assembleTimeframe(venue, symbol, interval, fromMs, toMs, requiredFromMs, requiredClosedToMs,
      requiredRows, held, keyId);
    // A standing horizon cursor already owns this series' venue work; a
    // per-request demand beside it would rescan the window every tick.
    const standing = this.standingCursor(venue, symbol, interval) !== undefined;
    if (!built.payload) {
      if (!standing) this.demand(venue, symbol, interval, requiredFromMs, requiredClosedToMs, now);
      return { ok: false, code: 503, error: `no closed ${interval}m candles cached yet for ${venue} ${symbol}` };
    }
    if (built.gaps.length) { if (!standing) this.demand(venue, symbol, interval, requiredFromMs, requiredClosedToMs, now); }
    else this.demands.delete(this.identity(venue, symbol, interval));
    const payload = built.payload;
    return { ok: true, payload: { ...payload, sig: sign(canonicalTimeframeBytes(payload)).toString("base64") } };
  }

  /** v0.4.103 — a window longer than 60 days of a horizon-held interval is
   *  built off the main thread. Everything else keeps the synchronous path. */
  isLongRequest(venue: VenueId, interval: number, fromMs: number, toMs: number, now: number): boolean {
    if (!isTimeframeInterval(interval) || !this.horizon[venue]?.intervals.includes(interval)) return false;
    const w = this.window(interval, fromMs, toMs, now);
    return w.ok && w.requiredRows > Math.floor(TIMEFRAME_SHORT_WINDOW_DAYS * 1440 / interval);
  }

  private safetyFor(venue: VenueId, symbol: string, minuteRestFrontier: number | null): TimeframeSafety {
    const prefix = `${this.instrumentIdentity(venue, symbol)}\u0000`;
    const frontiers: Record<string, number> = {};
    for (const interval of TIMEFRAME_INTERVALS) {
      const f = this.frontiers.get(`${prefix}${interval}`);
      if (f !== undefined) frontiers[String(interval)] = f;
    }
    return { frontiers, minuteFloor: this.minuteFloors.get(this.instrumentIdentity(venue, symbol)) ?? null, minuteRestFrontier };
  }

  /** Main-thread half of a long request: validation, interest, aggregate
   *  materialization limited to the minute-retention suffix (the only part a
   *  1m fold can complete), and the worker's read-only job. */
  prepareLongRequest(venue: VenueId, symbol: string, interval: TimeframeInterval, fromMs: number, toMs: number,
    now: number, minuteRestFrontier: number | null, keyId: string): TimeframeLongPrepared {
    const w = this.window(interval, fromMs, toMs, now);
    if (!w.ok) return w;
    const { requiredFromMs, requiredClosedToMs, requiredRows } = w;
    const step = interval * MINUTE_MS;
    this.noteInterest(venue, symbol, interval, now);
    const suffixFrom = Math.max(requiredFromMs, Math.ceil((now - this.retentionDays * DAY_MS) / step) * step);
    if (suffixFrom <= requiredClosedToMs) {
      this.ensureMaterialized(venue, symbol, interval, suffixFrom, requiredClosedToMs, minuteRestFrontier, now);
    }
    const fetch = horizonFetchInterval(venue, interval);
    const foldBase = fetch !== null && fetch !== interval ? fetch : null;
    const layouts: Record<string, TimeframeLayout> = { [String(interval)]: this.store.layout(venue, interval) };
    if (foldBase !== null) layouts[String(foldBase)] = this.store.layout(venue, foldBase);
    return {
      ok: true,
      boundary: this.boundary(venue, symbol, interval, now),
      job: {
        rootDir: this.store.rootDir, layouts, venue, symbol, interval, fromMs, toMs,
        requiredFromMs, requiredClosedToMs, requiredRows, keyId,
        safety: this.safetyFor(venue, symbol, minuteRestFrontier), foldBase,
        generation: this.identities.get(this.instrumentIdentity(venue, symbol)) ?? "",
      },
    };
  }

  /** Main-thread tail of a long request: sign the worker's canonical bytes. */
  finishLongRequest(prepared: Extract<TimeframeLongPrepared, { ok: true }>, reply: TimeframeLongReply,
    sign: (bytes: Buffer) => Buffer): TimeframeLongOutcome {
    if (!reply.ok) return reply;
    // A relisting fenced while the worker read (files removed, frontiers
    // dropped) must not be signed under the new listing.
    const job = prepared.job;
    if ((this.identities.get(this.instrumentIdentity(job.venue, job.symbol)) ?? "") !== job.generation) {
      return { ok: false, code: 503, error: `${job.venue} ${job.symbol} was relisted during the build; retry shortly` };
    }
    const canonical = Buffer.from(reply.canonical.buffer, reply.canonical.byteOffset, reply.canonical.byteLength);
    const sig = sign(canonical).toString("base64");
    return { ok: true, body: signedTimeframeBody(reply.canonical, sig), boundary: prepared.boundary };
  }

  /** Unsigned venue-boundary facts for one horizon target, or null. */
  boundary(venue: VenueId, symbol: string, interval: TimeframeInterval, now: number): TimeframeBoundary | null {
    const c = this.standingCursor(venue, symbol, interval);
    if (!c) return null;
    const proofs = this.proofs.get(c.key);
    const gen = this.identities.get(this.instrumentIdentity(venue, symbol)) ?? "";
    const floor = proofs && proofs.gen === gen ? proofs.floor : null;
    return { horizonFromMs: this.horizonFrom(c, now), floor: floor ? { ...floor } : null };
  }

  private safe(venue: VenueId, symbol: string, interval: number, candle: CachedCandle,
    minuteRestFrontier: number | null): boolean {
    if (!basicCandle(candle)
      || candle.openMs < (this.minuteFloors.get(this.instrumentIdentity(venue, symbol)) ?? -Infinity)) return false;
    if (candle.source === "native") {
      return candle.baseInterval === interval
        && candle.openMs <= (this.frontiers.get(this.identity(venue, symbol, interval)) ?? -Infinity);
    }
    if (candle.baseInterval >= interval || interval % candle.baseInterval !== 0) return false;
    const lastBaseOpen = candle.openMs + interval * MINUTE_MS - candle.baseInterval * MINUTE_MS;
    if (candle.baseInterval === 1) return minuteRestFrontier !== null && lastBaseOpen <= minuteRestFrontier;
    return lastBaseOpen <= (this.frontiers.get(this.identity(venue, symbol, candle.baseInterval)) ?? -Infinity);
  }

  private demand(venue: VenueId, symbol: string, targetInterval: TimeframeInterval, fromMs: number, toMs: number, now: number): void {
    const fetchInterval = this.bestNativeBase(venue, targetInterval);
    if (fetchInterval === null) return;
    const key = this.identity(venue, symbol, targetInterval);
    const prior = this.demands.get(key);
    const next: Demand = { venue, symbol, targetInterval, fetchInterval,
      fromMs: Math.min(fromMs, prior?.fromMs ?? fromMs), toMs: Math.max(toMs, prior?.toMs ?? toMs), touchedAt: now };
    this.demands.delete(key); this.demands.set(key, next);
    while (this.demands.size > MAX_DEMANDS) this.demands.delete(this.demands.keys().next().value!);
  }

  // ── standing horizon cursors ─────────────────────────────────────────────

  /** Upsert one standing cursor per (symbol, native fetch interval) for the
   *  venue's tracked, tradable roster. Called every collector pass, so the
   *  horizon is warm before anyone asks; symbols that left the roster lose
   *  their cursor (their files age out through prune). */
  warm(venue: VenueId, symbols: readonly string[], now: number): void {
    const fetches = this.horizonFetches.get(venue);
    if (!fetches) return;
    const keep = new Set<string>();
    for (const symbol of symbols) {
      if (!isSafeSegment(symbol)) continue;
      for (const [fetch, targets] of fetches) {
        const key = this.identity(venue, symbol, fetch);
        keep.add(key);
        if (this.cursors.has(key)) continue;
        this.cursors.set(key, { key, venue, symbol, interval: fetch, targets: [...targets], ready: false,
          fromMs: 0, coveredTo: 0, gaps: [], retryAt: 0 });
      }
    }
    const prefix = `${venue}\u0000`;
    for (const key of [...this.cursors.keys()]) if (key.startsWith(prefix) && !keep.has(key)) this.cursors.delete(key);
    this.trimState(now);
  }

  private horizonFrom(c: HorizonCursor, now: number): number {
    const step = c.interval * MINUTE_MS;
    const days = this.horizon[c.venue]?.days ?? 0;
    let from = Math.ceil((now - (days + HORIZON_PAD_DAYS) * DAY_MS) / step) * step;
    const floor = this.minuteFloors.get(this.instrumentIdentity(c.venue, c.symbol));
    if (floor !== undefined) from = Math.max(from, Math.ceil(floor / step) * step);
    return from;
  }

  private newestClosed(interval: number, now: number): number {
    const step = interval * MINUTE_MS;
    return Math.floor((now - CLOSED_GRACE_MS) / step) * step - step;
  }

  /** One disk scan per cursor, ever (until its identity changes): the held
   *  safe native slots across the horizon become its gap list. */
  private initCursor(c: HorizonCursor, now: number): void {
    const step = c.interval * MINUTE_MS;
    const from = this.horizonFrom(c, now);
    const newest = this.newestClosed(c.interval, now);
    c.fromMs = from;
    c.coveredTo = Math.max(newest, from - step);
    c.ready = true;
    if (newest < from) { c.gaps = []; return; }
    const held = this.store.read(c.venue, c.symbol, c.interval, from, newest)
      .filter((row) => row.source === "native" && this.safe(c.venue, c.symbol, c.interval, row, null))
      .map((row) => row.openMs);
    c.gaps = subtractOpens([[from, newest]], held, step);
  }

  /** Cursors still waiting for their one scan. */
  horizonPending(): number {
    let n = 0;
    for (const c of this.cursors.values()) if (!c.ready) n++;
    return n;
  }

  /** Initialise unprimed cursors for at most `budgetMs` of synchronous time. */
  primeHorizon(now: number, budgetMs: number, clock: () => number = () => performance.now()): { primed: number; remaining: number; done: boolean } {
    const started = clock();
    let primed = 0;
    for (const c of this.cursors.values()) {
      if (c.ready) continue;
      if (primed > 0 && clock() - started >= budgetMs) break;
      this.initCursor(c, now);
      primed++;
    }
    const remaining = this.horizonPending();
    return { primed, remaining, done: remaining === 0 };
  }

  /** Move a cursor's window with the clock: a new closed bucket is a new tail
   *  gap; buckets that left the horizon are forgotten. No disk access. */
  private advanceCursor(c: HorizonCursor, now: number): void {
    const step = c.interval * MINUTE_MS;
    const newest = this.newestClosed(c.interval, now);
    if (newest > c.coveredTo) {
      const last = c.gaps.at(-1);
      if (last && last[1] === c.coveredTo) last[1] = newest; else c.gaps.push([c.coveredTo + step, newest]);
      c.coveredTo = newest;
    }
    const from = this.horizonFrom(c, now);
    if (from > c.fromMs) {
      c.gaps = c.gaps.filter((g) => g[1] >= from).map((g) => [Math.max(g[0], from), g[1]] as Gap);
      c.fromMs = from;
      const proofs = this.proofs.get(c.key);
      if (proofs && proofs.empty.some((r) => r[1] < from)) {
        proofs.empty = proofs.empty.filter((r) => r[1] >= from);
        this.proofsDirty = true;
      }
    }
  }

  private proofsFor(c: HorizonCursor): HorizonProofs {
    const gen = this.identities.get(this.instrumentIdentity(c.venue, c.symbol)) ?? "";
    let p = this.proofs.get(c.key);
    if (!p || p.gen !== gen) {
      p = { gen, floor: null, empty: [] };
      this.proofs.set(c.key, p);
      this.proofsDirty = true;
    }
    return p;
  }

  /** Missing ranges this cursor may ask the venue for now, newest first. */
  private workableGaps(c: HorizonCursor, now: number): Gap[] {
    const step = c.interval * MINUTE_MS;
    const proofs = this.proofs.get(c.key);
    const gen = this.identities.get(this.instrumentIdentity(c.venue, c.symbol)) ?? "";
    const waiting: Gap[] = [];
    if (proofs && proofs.gen === gen) {
      const f = proofs.floor;
      if (f && now - f.lastAt < (f.confirmations >= 2 ? HORIZON_EMPTY_RECHECK_MS : HORIZON_EMPTY_CONFIRM_GAP_MS)) {
        waiting.push([0, f.rawFirst ? f.atMs : f.atMs - step]);
      }
      for (const r of proofs.empty) {
        if (now - r[3] < (r[4] >= 2 ? HORIZON_EMPTY_RECHECK_MS : HORIZON_EMPTY_CONFIRM_GAP_MS)) waiting.push([r[0], r[1]]);
      }
    }
    const out: Gap[] = [];
    for (let i = c.gaps.length - 1; i >= 0; i--) {
      const parts = waiting.length ? subtractRanges(c.gaps[i]!, waiting, step) : [c.gaps[i]!];
      for (let j = parts.length - 1; j >= 0; j--) out.push(parts[j]!);
    }
    return out;
  }

  /** The next page for one cursor, or null. Newest missing range first, paged
   *  backwards, so the served tail is current first and a young listing's
   *  boundary is met from its held side (where an empty older page proves it). */
  private cursorPage(c: HorizonCursor, now: number): TimeframeWork | null {
    if (now < c.retryAt) return null;
    const step = c.interval * MINUTE_MS;
    const newest = c.coveredTo;
    for (const [g0, g1] of this.workableGaps(c, now)) {
      let route: NativeTimeframeRoute = "recent";
      let lo = g0;
      if (c.venue === "weex") {
        const windowStart = newest - (WEEX_RECENT_TIMEFRAME_ROWS - 1) * step;
        if (g1 >= windowStart) lo = Math.max(g0, windowStart);
        else if (nativeTimeframeHistoryRoute("weex", c.interval)) route = "history";
        else continue;
      }
      const cap = nativeTimeframePageRows(c.venue, c.interval, route);
      const predecessor = c.venue === "bitunix" ? 1 : 0;
      const capacity = Math.max(1, cap - predecessor);
      const pageStart = Math.max(lo, g1 - (capacity - 1) * step);
      return {
        key: c.key, venue: c.venue, symbol: c.symbol, targetInterval: c.interval, interval: c.interval,
        startMs: Math.max(0, pageStart - predecessor * step), endMs: g1,
        horizon: true, route, weight: nativeTimeframeWeight(c.venue, route), proofFromMs: pageStart,
        targets: [...c.targets],
      };
    }
    return null;
  }

  private horizonWork(venue: VenueId, now: number): { tail: TimeframeWork[]; older: TimeframeWork[] } {
    const tail: TimeframeWork[] = [];
    const older: TimeframeWork[] = [];
    if (!this.horizonFetches.has(venue)) return { tail, older };
    const list = [...this.cursors.values()].filter((c) => c.venue === venue);
    if (!list.length) return { tail, older };
    // Fallback for a pass that arrives before the boot prime has run.
    const started = performance.now();
    for (const c of list) {
      if (c.ready) continue;
      if (performance.now() - started >= HORIZON_INLINE_INIT_BUDGET_MS) break;
      this.initCursor(c, now);
    }
    const offset = (this.horizonRotation.get(venue) ?? 0) % list.length;
    for (let n = 0; n < list.length && tail.length + older.length < HORIZON_MAX_ITEMS_PER_CALL; n++) {
      const c = list[(offset + n) % list.length]!;
      if (!c.ready) continue;
      this.advanceCursor(c, now);
      const page = this.cursorPage(c, now);
      if (!page) continue;
      (page.endMs === c.coveredTo ? tail : older).push(page);
    }
    return { tail, older };
  }

  work(venue: VenueId, now: number, pageLimit: number): TimeframeWork[] {
    this.trimState(now);
    const demands = [...this.demands.entries()].filter(([, d]) => d.venue === venue);
    const out: TimeframeWork[] = [];
    for (const [key, d] of demands) {
      const step = d.fetchInterval * MINUTE_MS;
      const from = Math.floor(d.fromMs / step) * step;
      const to = Math.floor((d.toMs + d.targetInterval * MINUTE_MS - step) / step) * step;
      // Raw occupancy is not proof. A crash can persist a native slot before
      // its frontier sidecar, and an aggregate may occupy the exact native
      // target slot. request() refuses both; the repair selector must see the
      // same absence or it will delete the demand forever without refetching.
      const safeNative = new Set(this.store.read(venue, d.symbol, d.fetchInterval, from, to)
        .filter((c) => c.source === "native" && this.safe(venue, d.symbol, d.fetchInterval, c, null))
        .map((c) => c.openMs));
      const gaps: Gap[] = [];
      let gapStart: number | null = null;
      for (let at = from; at <= to; at += step) {
        if (!safeNative.has(at) && gapStart === null) gapStart = at;
        if (safeNative.has(at) && gapStart !== null) { gaps.push([gapStart, at - step]); gapStart = null; }
      }
      if (gapStart !== null) gaps.push([gapStart, to]);
      if (!gaps.length) { this.demands.delete(key); continue; }
      const gap = gaps[0]!;
      // Bitunix carried opens need one adjacent raw predecessor. Spend one page
      // slot on it so the first requested bar can be proved without trusting a
      // row outside the venue response.
      // v0.4.103 — Bitget pages also respect its 90-day span limit.
      const limit = venue === "bitget" ? Math.min(pageLimit, nativeTimeframePageRows(venue, d.fetchInterval)) : pageLimit;
      const startMs = venue === "bitunix" ? Math.max(0, gap[0] - step) : gap[0];
      const capacity = venue === "bitunix" ? Math.max(1, limit - 1) : limit;
      const endMs = Math.min(gap[1], gap[0] + (capacity - 1) * step);
      const attemptKey = `${key}\u0000${startMs}\u0000${endMs}`;
      if (now - (this.lastAttempts.get(attemptKey) ?? -Infinity) < 5 * MINUTE_MS) continue;
      out.push({ key, venue, symbol: d.symbol, targetInterval: d.targetInterval, interval: d.fetchInterval,
        startMs, endMs });
    }
    if (out.length) {
      const cursor = this.cursorByVenue.get(venue) ?? 0;
      const k = cursor % out.length; out.push(...out.splice(0, k));
    }
    this.flush(false);
    if (!this.horizonFetches.has(venue)) return out;
    // Horizon tails keep served history current; request-driven demand comes
    // next; standing backfill takes what budget is left.
    const { tail, older } = this.horizonWork(venue, now);
    return [...tail, ...out, ...older];
  }

  attempted(work: TimeframeWork, now: number): void {
    if (work.horizon) {
      this.horizonRotation.set(work.venue, (this.horizonRotation.get(work.venue) ?? 0) + 1);
      const c = this.cursors.get(work.key);
      if (c) c.retryAt = now + HORIZON_RETRY_MS;
      return;
    }
    this.cursorByVenue.set(work.venue, (this.cursorByVenue.get(work.venue) ?? 0) + 1);
    this.lastAttempts.set(`${work.key}\u0000${work.startMs}\u0000${work.endMs}`, now);
    while (this.lastAttempts.size > 8192) this.lastAttempts.delete(this.lastAttempts.keys().next().value!);
  }

  private pageCandles(work: TimeframeWork, page: KlinePage, newestClosed: number): Candle[] {
    const bucketMs = work.interval * MINUTE_MS;
    const candles: Candle[] = [];
    let previous: Candle | undefined;
    for (const c of [...page.candles].sort((a, b) => a.openMs - b.openMs)) {
      const bounded = c.openMs >= work.startMs && c.openMs <= work.endMs
        && c.openMs % bucketMs === 0 && c.openMs <= newestClosed && basicCandle(c)
        && c.openMs >= (this.minuteFloors.get(this.instrumentIdentity(work.venue, work.symbol)) ?? -Infinity);
      const valid = bounded && (validAfter(work.venue, work.interval, c, previous)
        || (work.venue === "bitunix" && previous === undefined));
      if (valid) candles.push(c);
      previous = valid ? c : undefined;
    }
    return candles;
  }

  private advanceFrontier(work: TimeframeWork, candles: readonly Candle[]): void {
    if (!candles.length) return;
    const id = this.identity(work.venue, work.symbol, work.interval);
    let frontier = this.frontiers.get(id) ?? -Infinity;
    for (const c of candles) if (c.openMs > frontier) frontier = c.openMs;
    this.frontiers.set(id, frontier);
    this.frontiersDirty = true;
  }

  record(work: TimeframeWork, page: KlinePage, now: number): number {
    if (work.horizon) return this.recordHorizon(work, page, now);
    const bucketMs = work.interval * MINUTE_MS;
    const newestClosed = Math.floor((now - CLOSED_GRACE_MS) / bucketMs) * bucketMs - bucketMs;
    const candles = this.pageCandles(work, page, newestClosed);
    // The v2 contract closes on exact bucket boundaries, while storage keeps
    // the existing clock-skew grace. If the requested newest bar is merely
    // inside that grace, retry on the next collector pass instead of applying
    // the ordinary five-minute empty/error throttle.
    if (work.endMs > newestClosed) {
      this.lastAttempts.delete(`${work.key}\u0000${work.startMs}\u0000${work.endMs}`);
    }
    const written = this.store.write(work.venue, work.symbol, work.interval, candles, "native", work.interval, newestClosed);
    // v0.4.103 — the frontier sidecar is debounced (flush()); a crash before it
    // is written leaves the new slots unproven, and they are refetched.
    this.advanceFrontier(work, candles);
    this.flush(false);
    this.materialize(work.venue, work.symbol, work.targetInterval,
      work.startMs, work.endMs + work.targetInterval * MINUTE_MS, null);
    return written;
  }

  /** A standing page's rows, the cursor's gap update and its venue-empty
   *  verdict. No disk read beyond the write itself. */
  private recordHorizon(work: TimeframeWork, page: KlinePage, now: number): number {
    const step = work.interval * MINUTE_MS;
    const newestClosed = Math.floor((now - CLOSED_GRACE_MS) / step) * step - step;
    const candles = this.pageCandles(work, page, newestClosed);
    const c = this.cursors.get(work.key);
    const written = this.store.write(work.venue, work.symbol, work.interval, candles, "native", work.interval, newestClosed);
    this.advanceFrontier(work, candles);
    // Rows the read path will serve: strictly valid, or a Bitunix carried open
    // after a row of this page. A raw boundary row stays a gap.
    const servable: number[] = [];
    let prev: Candle | undefined;
    for (const row of candles) {
      if (strictCandle(row) || (prev !== undefined && validAfter(work.venue, work.interval, row, prev))) servable.push(row.openMs);
      prev = row;
    }
    if (c && c.ready) {
      c.gaps = subtractOpens(c.gaps, servable, step);
      let proved = false;
      const proofFrom = work.proofFromMs ?? work.startMs;
      const pe = work.endMs;
      // Proof needs the page to have been wholly answerable (constructed so),
      // a closed range, and a held/returned row right after it.
      if (pe + step <= c.coveredTo && pe <= newestClosed && proofFrom >= c.fromMs && !inGaps(c.gaps, pe + step)) {
        // Emptiness is judged on every bounded venue row (a Bitunix raw
        // boundary row is still a venue row, even though it is not served).
        const inRange = candles.map((row) => row.openMs).filter((at) => at >= proofFrom && at <= pe);
        let provenTo: number | null = null;
        let boundaryAt = 0;
        if (!inRange.length) { provenTo = pe; boundaryAt = pe + step; }
        else {
          const x = inRange[0]!;
          if (x > proofFrom && inRange.length === (pe - x) / step + 1) { provenTo = x - step; boundaryAt = x; }
        }
        if (provenTo !== null) {
          const proofs = this.proofsFor(c);
          const rawFirst = !servable.includes(boundaryAt) && candles.some((row) => row.openMs === boundaryAt);
          const first = c.gaps[0];
          const leading = first !== undefined && first[0] <= c.fromMs && first[1] >= provenTo;
          if (leading) {
            const f = proofs.floor;
            if (f && f.atMs === boundaryAt) {
              f.lastAt = now;
              f.checkedFromMs = Math.min(f.checkedFromMs, proofFrom);
              if (now - f.firstAt >= HORIZON_EMPTY_CONFIRM_GAP_MS && f.confirmations < 2) { f.confirmations = 2; proved = true; }
              else if (now - f.firstAt >= HORIZON_EMPTY_CONFIRM_GAP_MS) f.confirmations = Math.min(f.confirmations + 1, 1_000_000);
              if (rawFirst) f.rawFirst = true; else delete f.rawFirst;
            } else {
              proofs.floor = { atMs: boundaryAt, checkedFromMs: proofFrom, firstAt: now, lastAt: now, confirmations: 1,
                ...(rawFirst ? { rawFirst: true as const } : {}) };
              proved = true;
            }
          } else {
            const same = proofs.empty.find((r) => r[0] === proofFrom && r[1] === provenTo);
            if (same) {
              same[3] = now;
              if (now - same[2] >= HORIZON_EMPTY_CONFIRM_GAP_MS) { if (same[4] < 2) proved = true; same[4] = Math.min(same[4] + 1, 1_000_000); }
            } else {
              proved = true;
              proofs.empty = proofs.empty.filter(([a, b]) => b < proofFrom || a > provenTo!);
              proofs.empty.push([proofFrom, provenTo, now, now, 1]);
              proofs.empty.sort((x, y) => x[0] - y[0]);
              if (proofs.empty.length > 64) proofs.empty = proofs.empty.slice(-64);
            }
          }
          this.proofsDirty = true;
        }
      }
      // A venue row inside a proven-empty range retires that proof.
      const proofs = this.proofs.get(c.key);
      if (proofs && servable.length) {
        if (proofs.floor && servable.some((at) => at < proofs.floor!.atMs)) { proofs.floor = null; this.proofsDirty = true; }
        const kept = proofs.empty.filter(([a, b]) => !servable.some((at) => at >= a && at <= b));
        if (kept.length !== proofs.empty.length) { proofs.empty = kept; this.proofsDirty = true; }
      }
      // Progress (or a new proof or confirmation — not a mere re-read of a
      // known boundary) earns the next page this pass; the grace tail retries
      // next pass; anything else waits HORIZON_RETRY_MS.
      if (servable.length || proved || work.endMs > newestClosed) c.retryAt = 0;
    }
    for (const target of work.targets ?? []) {
      if (target === work.interval) continue;
      this.materialize(work.venue, work.symbol, target, work.startMs, work.endMs + target * MINUTE_MS, null);
    }
    this.flush(false);
    return written;
  }

  /** Per-interval retention: horizon intervals keep `days` (+ padding), every
   *  other series keeps the minute retention + 1 day, as in 0.4.102. */
  retentionCutoff(venue: string, interval: number, now: number): number {
    const days = isVenueId(venue) && this.horizonRetained.get(venue)?.has(interval) ? this.horizon[venue]!.days : null;
    return days !== null ? now - (days + HORIZON_PAD_DAYS + 1) * DAY_MS : now - this.retentionDays * DAY_MS - DAY_MS;
  }

  prune(now: number): number {
    // Preserve a complete UTC boundary bar beyond the configured 30-day minute horizon.
    this.trimState(now);
    if (!this.horizonRetained.size) return this.store.prune(now - this.retentionDays * DAY_MS - DAY_MS);
    return this.store.prune((venue, interval) => this.retentionCutoff(venue, interval, now));
  }

  /** Is (venue, interval) held on the standing horizon? */
  horizonHolds(venue: VenueId, interval: number): boolean {
    return !!this.horizon[venue]?.intervals.includes(interval as TimeframeInterval);
  }

  horizonVenues(): VenueId[] {
    return VENUE_IDS.filter((v) => this.horizon[v]);
  }

  /** Admin progress per venue × target interval, from cursor state only. */
  horizonStatus(now: number): HorizonVenueStatus[] {
    const out: HorizonVenueStatus[] = [];
    for (const venue of this.horizonVenues()) {
      const h = this.horizon[venue]!;
      const intervals: HorizonIntervalStatus[] = [];
      for (const interval of h.intervals) {
        const fetch = horizonFetchInterval(venue, interval)!;
        const s: HorizonIntervalStatus = { interval, fetchInterval: fetch, symbols: 0, primed: 0, complete: 0,
          backfilling: 0, floored: 0, remainingPages: 0, remainingWeight: 0 };
        const step = fetch * MINUTE_MS;
        for (const c of this.cursors.values()) {
          if (c.venue !== venue || c.interval !== fetch) continue;
          s.symbols++;
          if (!c.ready) continue;
          s.primed++;
          const proofs = this.proofs.get(c.key);
          const floor = proofs?.floor && proofs.floor.confirmations >= 2 ? proofs.floor : null;
          const proven: Gap[] = [];
          if (floor) proven.push([0, floor.atMs - step]);
          for (const r of proofs?.empty ?? []) if (r[4] >= 2) proven.push([r[0], r[1]]);
          let pages = 0, weight = 0;
          const newest = this.newestClosed(fetch, now);
          for (const gap of c.gaps) {
            for (const [a, b] of proven.length ? subtractRanges(gap, proven, step) : [gap]) {
              // Estimated in each route's own page size and request weight.
              if (venue === "weex") {
                const windowStart = newest - (WEEX_RECENT_TIMEFRAME_ROWS - 1) * step;
                if (b >= windowStart) { pages += 1; weight += nativeTimeframeWeight(venue, "recent"); }
                const historyTo = Math.min(b, windowStart - step);
                if (historyTo >= a) {
                  const n = Math.ceil(((historyTo - a) / step + 1) / nativeTimeframePageRows(venue, fetch, "history"));
                  pages += n; weight += n * nativeTimeframeWeight(venue, "history");
                }
                continue;
              }
              const cap = Math.max(1, nativeTimeframePageRows(venue, fetch) - (venue === "bitunix" ? 1 : 0));
              const n = Math.ceil(((b - a) / step + 1) / cap);
              pages += n; weight += n;
            }
          }
          if (pages === 0) { if (floor) s.floored++; else s.complete++; }
          else s.backfilling++;
          s.remainingPages += pages;
          s.remainingWeight += weight;
        }
        intervals.push(s);
      }
      out.push({ venue, days: h.days, intervals });
    }
    return out;
  }
}
