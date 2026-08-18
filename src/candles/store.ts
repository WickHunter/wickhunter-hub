// src/candles/store.ts
// Per-venue, per-symbol 1-minute candle storage.
//
// WHY THIS SHAPE (fixed-slot binary day files, no database):
// The hub already stores everything as plain files under data/ with node
// builtins only — no runtime dependencies, and the operator's backup story is
// "tar the data dir". A database would be the first such dependency in the
// repo, and it would buy nothing here, because 1-minute candles are not a
// general query problem: they are a DENSE, EXACTLY-GRIDDED time series whose
// every key is known in advance (openMs is always a multiple of 60000).
//
// So each UTC day of one (venue, symbol) is one file of exactly 1440 fixed-width
// slots, slot i holding the candle whose openMs is dayStart + i*60000. That
// gives three properties that matter more than anything a database offers:
//
//   1. PRESENCE IS STORED, NOT INFERRED. A slot is either filled or it is zero.
//      "Do we have minute X" is a seek and a read, never a deduction from how
//      many rows a page returned. The live incident this whole service is
//      designed against — a short page being read as "no more history" — is not
//      expressible against this layout: absence is a fact on disk.
//   2. GAPS ARE COMPUTED FROM THE DATA. `readWindow` walks the slots and emits
//      the runs of empty ones. Nothing tracks gaps separately, so nothing can
//      disagree with the candles about where they are.
//   3. WRITES ARE IDEMPOTENT AND ORDER-FREE. Backfill and live tailing write
//      into the same slots by absolute time. Re-fetching a range costs nothing
//      and repairs it; there is no append cursor to corrupt or resume.
//
// Cost: 48 bytes/candle, 69,120 bytes/symbol/day, ~2 MB per symbol-month, and
// for the full ~2,630 venue-symbols about 5 GB raw at 30 days (Aster added ~530
// of those in v0.2.19) — in line with what the brief estimated, and it gzips to
// a fraction of that on the wire. Retention pruning is `unlink` of whole day
// files, which is why the day is the chunk boundary.
//
// RECORD LAYOUT — 48 bytes, little-endian:
//   [ 0.. 7) BigInt64  openMs   0 = EMPTY SLOT. Never a valid candle: a real
//                               openMs is an epoch-ms multiple of 60000 and
//                               1970-01-01 is not a market we collect.
//   [ 8..16) Float64   open
//   [16..24) Float64   high
//   [24..32) Float64   low
//   [32..40) Float64   close
//   [40..48) Float64   volume   BASE volume on every venue (see venues.ts)
//
// The stored openMs is redundant with the slot index on purpose: it is a
// self-check. A file truncated, torn or written by an older layout cannot be
// silently mistaken for data, because the slot's own timestamp will not match
// the position it was read from, and `readWindow` drops it as absent.
import fs from "node:fs";
import path from "node:path";

export const MINUTE_MS = 60_000;

/** ── v0.2.10 — THE CLOCK-SKEW GRACE ────────────────────────────────────────
 *
 *  Both gates that decide "is this candle closed" read the HUB's clock, never
 *  the venue's — deliberately, so a venue that changes its framing cannot fool
 *  us. That makes our clock the authority, and skew is asymmetric:
 *
 *    · clock BEHIND  — harmless. A closed candle is dropped and collected on
 *                      the next pass.
 *    · clock AHEAD   — the failure. `newestClosedOpenMs` is
 *                      floor(now) - 1 minute, so a hub running even a few
 *                      seconds fast accepts a bar the venue still considers
 *                      FORMING. And it is permanent: tails move forward,
 *                      backfill digs backward, and repair fills only ABSENT
 *                      slots. Nothing re-fetches a minute already written to
 *                      correct its value.
 *
 *  What that costs is invisible from both ends. The bot cross-checks every seed
 *  against a live venue page and discards the WHOLE seed on any mismatch, so a
 *  skewed hub does not corrupt anyone's bands — it silently serves seeds that
 *  always fail verification while this panel reports perfect health, and every
 *  bot falls back to a ~12-hour venue warm-up.
 *
 *  One minute of grace makes any skew under 60 seconds structurally incapable
 *  of admitting a forming bar. Against a 100-minute tail cadence the freshness
 *  it costs is nothing. */
export const CLOSED_GRACE_MS = 60_000;
export const SLOTS_PER_DAY = 1440;
export const RECORD_BYTES = 48;
export const DAY_MS = SLOTS_PER_DAY * MINUTE_MS;
export const DAY_FILE_BYTES = SLOTS_PER_DAY * RECORD_BYTES;
export const CANDLE_FILE_EXT = ".c1m";

/** One closed candle. Numbers, never strings — the wire contract says so and
 *  storing them as float64 is what guarantees it. */
export interface Candle {
  openMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Wire row form: [openMs, open, high, low, close, volume]. */
export type Row = [number, number, number, number, number, number];

/** An inclusive range of MISSING minute openMs values. */
export type Gap = [number, number];

export interface WindowResult {
  rows: Row[];
  gaps: Gap[];
}

export interface WriteResult {
  /** Slots written, including ones that already held the same minute. */
  written: number;
  /** Slots that were EMPTY before this write — the exact number of candles the
   *  store gained, which is what keeps the collector's count truthful without
   *  a rescan. Re-fetching a range is idempotent and adds zero. */
  newlyFilled: number;
}

export interface SymbolCoverage {
  /** openMs of the oldest closed candle held, or null when nothing is held. */
  firstClosedMs: number | null;
  /** openMs of the newest closed candle held. AUTHORITATIVE for seed reach. */
  lastClosedMs: number | null;
  /** Candles actually present between first and last (not the span). */
  count: number;
  /** Missing minutes strictly between firstClosedMs and lastClosedMs. Leading
   *  absence (before we ever collected the pair) is NOT a hole in what we hold
   *  — it is simply where our history starts, and `firstClosedMs` states it. */
  interiorMissing: number;
}

export function floorMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

export function dayStartOf(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** UTC YYYY-MM-DD for a day-start epoch-ms. The day file's name. */
export function dayKey(dayStartMs: number): string {
  return new Date(dayStartMs).toISOString().slice(0, 10);
}

/** The newest minute that is definitely CLOSED at wall-clock `now`.
 *
 *  The bar opening at floorMinute(now) is still forming — it closes at
 *  floorMinute(now) + 60000. So the newest closed bar opened one minute
 *  earlier. Every venue adapter's output is filtered through this, whatever
 *  that venue's own framing does, so "did this exchange hand us a forming bar"
 *  can never be the difference between a right and a wrong seed. */
/** The newest minute this collector is willing to treat as SETTLED: the newest
 *  closed minute, less `CLOSED_GRACE_MS`. Used for what we STORE. `dropUnclosed`
 *  keeps its own unmargined test — that one is about the venue's forming bar,
 *  this one is about our own clock being wrong. */
export function settledOpenMs(now: number): number {
  return newestClosedOpenMs(now) - CLOSED_GRACE_MS;
}

export function newestClosedOpenMs(now: number): number {
  return floorMinute(now) - MINUTE_MS;
}

/** Venue and symbol both become path segments, so both are whitelisted here.
 *  Symbols arrive from a venue's instrument list — remote input — and multiplier
 *  spellings like `1000PEPEUSDT` and quote variants like `1000PEPEUSDC` are
 *  legitimate, so the charset is permissive about content but absolute about
 *  shape: no separators, no dots, nothing that can climb out of the data dir. */
export function isSafeSegment(s: string): boolean {
  return typeof s === "string" && s.length > 0 && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s);
}

export class CandleStore {
  constructor(readonly rootDir: string) {}

  private symbolDir(venue: string, symbol: string): string {
    if (!isSafeSegment(venue)) throw new Error(`unsafe venue segment: ${venue}`);
    if (!isSafeSegment(symbol)) throw new Error(`unsafe symbol segment: ${symbol}`);
    return path.join(this.rootDir, venue, symbol);
  }

  private dayFile(venue: string, symbol: string, dayStartMs: number): string {
    return path.join(this.symbolDir(venue, symbol), `${dayKey(dayStartMs)}${CANDLE_FILE_EXT}`);
  }

  /** Symbols we hold any file for, whether or not the venue still lists them. */
  symbols(venue: string): string[] {
    if (!isSafeSegment(venue)) return [];
    try {
      return fs.readdirSync(path.join(this.rootDir, venue), { withFileTypes: true })
        .filter((e) => e.isDirectory() && isSafeSegment(e.name))
        .map((e) => e.name)
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Day-start timestamps we hold a file for, oldest first. */
  days(venue: string, symbol: string): number[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.symbolDir(venue, symbol));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: number[] = [];
    for (const n of names) {
      if (!n.endsWith(CANDLE_FILE_EXT)) continue;
      const key = n.slice(0, -CANDLE_FILE_EXT.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const ms = Date.parse(`${key}T00:00:00.000Z`);
      if (Number.isFinite(ms)) out.push(ms);
    }
    return out.sort((a, b) => a - b);
  }

  /** Read one day file whole, or null when we hold nothing for that day.
   *  A file that is short (a torn write, a truncated disk) is padded rather
   *  than rejected: the slots that survived are still true, and the slots that
   *  did not read back as EMPTY, which is exactly what they are. */
  private readDay(venue: string, symbol: string, dayStartMs: number): Buffer | null {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(this.dayFile(venue, symbol, dayStartMs));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (buf.length === DAY_FILE_BYTES) return buf;
    const padded = Buffer.alloc(DAY_FILE_BYTES);
    buf.copy(padded, 0, 0, Math.min(buf.length, DAY_FILE_BYTES));
    return padded;
  }

  /** Decode slot `i`, or null when the slot is empty OR its stored openMs does
   *  not match the position it was read from (a corrupt/legacy file). */
  private decodeSlot(buf: Buffer, i: number, dayStartMs: number): Candle | null {
    const off = i * RECORD_BYTES;
    const stored = buf.readBigInt64LE(off);
    if (stored === 0n) return null;
    const openMs = Number(stored);
    if (openMs !== dayStartMs + i * MINUTE_MS) return null; // self-check: never trust a mismatched slot
    return {
      openMs,
      open: buf.readDoubleLE(off + 8),
      high: buf.readDoubleLE(off + 16),
      low: buf.readDoubleLE(off + 24),
      close: buf.readDoubleLE(off + 32),
      volume: buf.readDoubleLE(off + 40),
    };
  }

  /** Write candles into their slots. Grouped per day so each file is read,
   *  patched and rewritten once. Writes go tmp-then-rename like the rest of the
   *  hub's durable state, so a crash mid-write leaves the old day intact rather
   *  than a half-patched one.
   *
   *  Anything not minute-aligned, non-finite, or (when `notAfterMs` is given)
   *  newer than the newest closed minute is DROPPED here rather than stored.
   *  This is the last line of defence against a forming bar: even if a venue
   *  adapter were wrong, an unclosed candle cannot reach the disk. */
  write(venue: string, symbol: string, candles: readonly Candle[], notAfterMs?: number): WriteResult {
    const byDay = new Map<number, Candle[]>();
    for (const c of candles) {
      if (!Number.isFinite(c.openMs) || c.openMs <= 0 || c.openMs % MINUTE_MS !== 0) continue;
      if (notAfterMs !== undefined && c.openMs > notAfterMs) continue;
      if (![c.open, c.high, c.low, c.close, c.volume].every((n) => Number.isFinite(n))) continue;
      const d = dayStartOf(c.openMs);
      const list = byDay.get(d);
      if (list) list.push(c);
      else byDay.set(d, [c]);
    }
    let written = 0;
    let newlyFilled = 0;
    for (const [dayStartMs, list] of byDay) {
      const file = this.dayFile(venue, symbol, dayStartMs);
      const buf = this.readDay(venue, symbol, dayStartMs) ?? Buffer.alloc(DAY_FILE_BYTES);
      for (const c of list) {
        const i = (c.openMs - dayStartMs) / MINUTE_MS;
        if (i < 0 || i >= SLOTS_PER_DAY) continue;
        const off = i * RECORD_BYTES;
        // Was this slot empty before? That is what lets the collector keep an
        // exact candle count in memory instead of rescanning gigabytes of day
        // files every time the admin panel asks how complete a venue is.
        if (this.decodeSlot(buf, i, dayStartMs) === null) newlyFilled++;
        buf.writeBigInt64LE(BigInt(c.openMs), off);
        buf.writeDoubleLE(c.open, off + 8);
        buf.writeDoubleLE(c.high, off + 16);
        buf.writeDoubleLE(c.low, off + 24);
        buf.writeDoubleLE(c.close, off + 32);
        buf.writeDoubleLE(c.volume, off + 40);
        written++;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
    }
    return { written, newlyFilled };
  }

  /** Rows present in [fromMs, toMs] (inclusive, minute-aligned internally),
   *  oldest first, plus every missing minute run inside that same range.
   *
   *  The caller is responsible for clamping `toMs` to what can exist — see
   *  seed.ts, which clamps to lastClosedMs so that "the future has not happened
   *  yet" is never reported as a gap in our history. */
  readWindow(venue: string, symbol: string, fromMs: number, toMs: number): WindowResult {
    const from = Math.ceil(fromMs / MINUTE_MS) * MINUTE_MS;
    const to = floorMinute(toMs);
    const rows: Row[] = [];
    const gaps: Gap[] = [];
    if (!(Number.isFinite(from) && Number.isFinite(to)) || to < from) return { rows, gaps };

    let gapStart: number | null = null;
    for (let dayStartMs = dayStartOf(from); dayStartMs <= to; dayStartMs += DAY_MS) {
      const buf = this.readDay(venue, symbol, dayStartMs);
      const lo = Math.max(0, (from - dayStartMs) / MINUTE_MS);
      const hi = Math.min(SLOTS_PER_DAY - 1, (to - dayStartMs) / MINUTE_MS);
      for (let i = lo; i <= hi; i++) {
        const openMs = dayStartMs + i * MINUTE_MS;
        const c = buf ? this.decodeSlot(buf, i, dayStartMs) : null;
        if (c) {
          if (gapStart !== null) {
            gaps.push([gapStart, openMs - MINUTE_MS]);
            gapStart = null;
          }
          rows.push([c.openMs, c.open, c.high, c.low, c.close, c.volume]);
        } else if (gapStart === null) {
          gapStart = openMs;
        }
      }
    }
    if (gapStart !== null) gaps.push([gapStart, to]);
    return { rows, gaps };
  }

  /** What we hold for one symbol. Scans day files from each end, so a healthy
   *  symbol costs two file reads; `count`/`interiorMissing` need the full scan
   *  and are only asked for by the admin status panel. */
  coverage(venue: string, symbol: string, deep = false): SymbolCoverage {
    const days = this.days(venue, symbol);
    let firstClosedMs: number | null = null;
    let lastClosedMs: number | null = null;
    let count = 0;

    for (const d of days) {
      const buf = this.readDay(venue, symbol, d);
      if (!buf) continue;
      for (let i = 0; i < SLOTS_PER_DAY; i++) {
        if (this.decodeSlot(buf, i, d)) { firstClosedMs = d + i * MINUTE_MS; break; }
      }
      if (firstClosedMs !== null) break;
    }
    for (let k = days.length - 1; k >= 0; k--) {
      const d = days[k]!;
      const buf = this.readDay(venue, symbol, d);
      if (!buf) continue;
      for (let i = SLOTS_PER_DAY - 1; i >= 0; i--) {
        if (this.decodeSlot(buf, i, d)) { lastClosedMs = d + i * MINUTE_MS; break; }
      }
      if (lastClosedMs !== null) break;
    }
    if (firstClosedMs === null || lastClosedMs === null) {
      return { firstClosedMs: null, lastClosedMs: null, count: 0, interiorMissing: 0 };
    }
    if (!deep) {
      return { firstClosedMs, lastClosedMs, count: 0, interiorMissing: 0 };
    }
    for (const d of days) {
      const buf = this.readDay(venue, symbol, d);
      if (!buf) continue;
      for (let i = 0; i < SLOTS_PER_DAY; i++) {
        const openMs = d + i * MINUTE_MS;
        if (openMs < firstClosedMs || openMs > lastClosedMs) continue;
        if (this.decodeSlot(buf, i, d)) count++;
      }
    }
    const span = (lastClosedMs - firstClosedMs) / MINUTE_MS + 1;
    return { firstClosedMs, lastClosedMs, count, interiorMissing: span - count };
  }

  /** Delete whole day files older than the retention horizon. Day-sized chunks
   *  exist so that pruning is unlink, never a rewrite. Returns files removed. */
  prune(venue: string, symbol: string, olderThanMs: number): number {
    const cutoff = dayStartOf(olderThanMs);
    let removed = 0;
    for (const d of this.days(venue, symbol)) {
      if (d >= cutoff) continue;
      try {
        fs.unlinkSync(this.dayFile(venue, symbol, d));
        removed++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return removed;
  }
}
