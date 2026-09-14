// Persistent, signed higher-timeframe candle history for Optimized startup.
// The minute seed in seed.ts is pinned v1; this module owns only v2 requests.
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readJson } from "../jsonfile.js";
import { CLOSED_GRACE_MS, DAY_MS, MINUTE_MS, dayKey, dayStartOf, isSafeSegment, type Candle, type CandleStore, type Gap, type Row } from "./store.js";
import { nativeTimeframeIntervals, type KlinePage, type VenueId } from "./venues.js";

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

function basicCandle(c: Candle): boolean {
  return Number.isSafeInteger(c.openMs) && c.openMs > 0
    && [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
    && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.volume >= 0
    && c.high >= c.low && c.high >= c.close && c.low <= c.close;
}

function strictCandle(c: Candle): boolean {
  return basicCandle(c) && c.high >= c.open && c.low <= c.open;
}

function validAfter(venue: VenueId, interval: number, c: Candle, previous: Candle | undefined): boolean {
  return strictCandle(c) || (basicCandle(c) && venue === "bitunix" && previous !== undefined
    && c.openMs - previous.openMs === interval * MINUTE_MS && c.open === previous.close);
}

function rowAsCandle(row: Row): Candle {
  return { openMs: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] };
}

/** Fixed slots keep absence authoritative and writes idempotent, as in CandleStore. */
export class TimeframeStore {
  constructor(readonly rootDir: string) {}

  private intervalDir(venue: string, symbol: string, interval: number): string {
    if (!isSafeSegment(venue) || !isSafeSegment(symbol) || !isTimeframeInterval(interval)) {
      throw new Error("unsafe timeframe cache identity");
    }
    return path.join(this.rootDir, venue, symbol, String(interval));
  }

  private file(venue: string, symbol: string, interval: TimeframeInterval, day: number): string {
    return path.join(this.intervalDir(venue, symbol, interval), `${dayKey(day)}${FILE_EXT}`);
  }

  private slots(interval: TimeframeInterval): number { return 1440 / interval; }

  invalidateSymbol(venue: VenueId, symbol: string): void {
    if (!isSafeSegment(venue) || !isSafeSegment(symbol)) throw new Error("unsafe timeframe invalidation identity");
    fs.rmSync(path.join(this.rootDir, venue, symbol), { recursive: true, force: true });
  }

  private readDay(venue: string, symbol: string, interval: TimeframeInterval, day: number): Buffer | null {
    const bytes = this.slots(interval) * RECORD_BYTES;
    try {
      const held = fs.readFileSync(this.file(venue, symbol, interval, day));
      if (held.length === bytes) return held;
      const padded = Buffer.alloc(bytes);
      held.copy(padded, 0, 0, Math.min(bytes, held.length));
      return padded;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
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
      const d = dayStartOf(c.openMs);
      const list = byDay.get(d);
      if (list) list.push(c); else byDay.set(d, [c]);
      previous = c;
    }
    let written = 0;
    for (const [day, list] of byDay) {
      const file = this.file(venue, symbol, interval, day);
      const buf = this.readDay(venue, symbol, interval, day)
        ?? Buffer.alloc(this.slots(interval) * RECORD_BYTES);
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
    for (let day = dayStartOf(scanFrom); day <= to; day += DAY_MS) {
      const buf = this.readDay(venue, symbol, interval, day);
      if (!buf) { previous = undefined; continue; }
      const lo = Math.max(0, Math.ceil((scanFrom - day) / bucketMs));
      const hi = Math.min(this.slots(interval) - 1, Math.floor((to - day) / bucketMs));
      for (let slot = lo; slot <= hi; slot++) {
        const c = this.decode(buf, slot, day, interval);
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

  prune(olderThanMs: number): number {
    const cutoff = dayStartOf(olderThanMs);
    let removed = 0;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && entry.name.endsWith(FILE_EXT)) {
          const key = entry.name.slice(0, -FILE_EXT.length);
          const day = /^\d{4}-\d{2}-\d{2}$/.test(key) ? Date.parse(`${key}T00:00:00.000Z`) : NaN;
          if (Number.isFinite(day) && day < cutoff) { fs.unlinkSync(file); removed++; }
        }
      }
    };
    walk(this.rootDir);
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

interface Demand {
  venue: VenueId; symbol: string; targetInterval: TimeframeInterval;
  fetchInterval: TimeframeInterval; fromMs: number; toMs: number; touchedAt: number;
}
export interface TimeframeWork {
  key: string; venue: VenueId; symbol: string; targetInterval: TimeframeInterval;
  interval: TimeframeInterval; startMs: number; endMs: number;
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

export class TimeframeHistory {
  readonly store: TimeframeStore;
  private readonly demands = new Map<string, Demand>();
  private readonly frontierFile: string;
  private readonly identityFile: string;
  private readonly frontiers = new Map<string, number>();
  private readonly identities = new Map<string, string>();
  private readonly minuteFloors = new Map<string, number>();
  private cursorByVenue = new Map<VenueId, number>();
  private readonly lastAttempts = new Map<string, number>();
  private readonly interests = new Map<string, InterestState>();
  private readonly materialized = new Map<string, MaterializedState>();

  constructor(rootDir: string, private readonly minutes: CandleStore, private readonly retentionDays: number) {
    this.store = new TimeframeStore(rootDir);
    this.frontierFile = path.join(rootDir, "native-frontier.v2.json");
    this.identityFile = path.join(rootDir, "instrument-identity.v2.json");
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

  private trimState(now: number): void {
    for (const [key, d] of this.demands) if (now - d.touchedAt > ACTIVE_TTL_MS) this.demands.delete(key);
    for (const [key, state] of this.interests) if (now - state.touchedAt > ACTIVE_TTL_MS) this.interests.delete(key);
    for (const [key, state] of this.materialized) if (now - state.touchedAt > ACTIVE_TTL_MS) this.materialized.delete(key);
    for (const [key, at] of this.lastAttempts) if (now - at > ACTIVE_TTL_MS) this.lastAttempts.delete(key);
    while (this.demands.size > MAX_DEMANDS) this.demands.delete(this.demands.keys().next().value!);
    while (this.interests.size > MAX_INTERESTS) this.interests.delete(this.interests.keys().next().value!);
    while (this.materialized.size > MAX_MATERIALIZED) this.materialized.delete(this.materialized.keys().next().value!);
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
        this.interests.delete(this.identity(venue, row.symbol, 1));
        const generationAt = Number(row.generation.slice(row.generation.lastIndexOf(":") + 1));
        if (Number.isSafeInteger(generationAt) && generationAt > 0) this.minuteFloors.set(key, generationAt);
      }
      if (prior !== row.generation) { this.identities.set(key, row.generation); identitiesChanged = true; }
    }
    if (identitiesChanged) this.persistIdentities();
    if (frontiersChanged) writeJsonAtomic(this.frontierFile,
      { v: 2, frontiers: Object.fromEntries(this.frontiers) } satisfies FrontierFile);
  }

  private bestNativeBase(venue: VenueId, target: TimeframeInterval): TimeframeInterval | null {
    const supported = nativeTimeframeIntervals(venue)
      .filter((n): n is TimeframeInterval => n > 1 && isTimeframeInterval(n) && n <= target && target % n === 0)
      .sort((a, b) => b - a);
    return supported[0] ?? null;
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
    const byBase = new Map<number, Map<number, Row>>();
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
      const indexed = new Map<number, Row>();
      let previous: Candle | undefined;
      for (const row of rows) {
        const candle = rowAsCandle(row);
        const structurallyValid = row[0] % baseMs === 0 && basicCandle(candle)
          && row[0] >= (this.minuteFloors.get(this.instrumentIdentity(venue, symbol)) ?? -Infinity);
        const valid = structurallyValid && validAfter(venue, base, candle, previous);
        if (valid) {
          indexed.set(row[0], row);
        }
        // Bitunix's first raw row may be the predecessor for the next carried
        // open, but a malformed interior row cannot bridge a gap.
        previous = valid || (structurallyValid && venue === "bitunix" && previous === undefined)
          ? candle : undefined;
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
        const expected = target / base;
        const rows: Row[] = [];
        for (let i = 0; i < expected; i++) {
          const row = indexed.get(openMs + i * baseMs);
          if (!row) break;
          rows.push(row);
        }
        if (rows.length !== expected) continue;
        const candle: Candle = {
          openMs, open: rows[0]![1], high: Math.max(...rows.map((r) => r[2])),
          low: Math.min(...rows.map((r) => r[3])), close: rows.at(-1)![4],
          volume: rows.reduce((sum, r) => sum + r[5], 0),
        };
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

  request(venue: VenueId, symbol: string, interval: TimeframeInterval, fromMs: number, toMs: number, now: number,
    minuteRestFrontier: number | null, keyId: string, sign: (bytes: Buffer) => Buffer): TimeframeOutcome {
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
    if (requiredRows > 50_000) {
      return { ok: false, code: 400, error: "window too large: at most 50000 timeframe rows per request" };
    }
    const interestId = this.identity(venue, symbol, 1);
    let interest = this.interests.get(interestId);
    if (!interest) this.interests.set(interestId, interest = { targets: new Set(), touchedAt: now });
    interest.targets.add(interval);
    interest.touchedAt = now;
    this.ensureMaterialized(venue, symbol, interval, requiredFromMs, requiredClosedToMs, minuteRestFrontier, now);
    const held = this.store.read(venue, symbol, interval, requiredFromMs, requiredClosedToMs)
      .filter((c) => this.safe(venue, symbol, interval, c, minuteRestFrontier));
    const rows: Row[] = held.map((c) => [c.openMs, c.open, c.high, c.low, c.close, c.volume]);
    const present = new Set(held.map((c) => c.openMs));
    const gaps: Gap[] = [];
    let gapStart: number | null = null;
    for (let at = requiredFromMs; at <= requiredClosedToMs; at += bucketMs) {
      if (!present.has(at) && gapStart === null) gapStart = at;
      if (present.has(at) && gapStart !== null) { gaps.push([gapStart, at - bucketMs]); gapStart = null; }
    }
    if (gapStart !== null) gaps.push([gapStart, requiredClosedToMs]);
    if (!rows.length) {
      this.demand(venue, symbol, interval, requiredFromMs, requiredClosedToMs, now);
      return { ok: false, code: 503, error: `no closed ${interval}m candles cached yet for ${venue} ${symbol}` };
    }
    if (gaps.length) this.demand(venue, symbol, interval, requiredFromMs, requiredClosedToMs, now);
    else this.demands.delete(this.identity(venue, symbol, interval));
    const segments: TimeframeSegment[] = [];
    for (const candle of held) {
      const prior = segments.at(-1);
      if (prior && prior[1] + bucketMs === candle.openMs && prior[2] === candle.source && prior[3] === candle.baseInterval) {
        prior[1] = candle.openMs;
      } else segments.push([candle.openMs, candle.openMs, candle.source, candle.baseInterval]);
    }
    const payload: TimeframeUnsigned = {
      v: 2, venue, symbol, interval: String(interval), fromMs, toMs, requiredFromMs, requiredClosedToMs,
      closedFrontierMs: rows.at(-1)![0], availableFromMs: rows[0]![0], availableRows: rows.length,
      requiredRows, complete: gaps.length === 0 && rows.length === requiredRows,
      rows, gaps, segments, keyId,
    };
    return { ok: true, payload: { ...payload, sig: sign(canonicalTimeframeBytes(payload)).toString("base64") } };
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
      const startMs = venue === "bitunix" ? Math.max(0, gap[0] - step) : gap[0];
      const capacity = venue === "bitunix" ? Math.max(1, pageLimit - 1) : pageLimit;
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
    return out;
  }

  attempted(work: TimeframeWork, now: number): void {
    this.cursorByVenue.set(work.venue, (this.cursorByVenue.get(work.venue) ?? 0) + 1);
    this.lastAttempts.set(`${work.key}\u0000${work.startMs}\u0000${work.endMs}`, now);
    while (this.lastAttempts.size > 8192) this.lastAttempts.delete(this.lastAttempts.keys().next().value!);
  }

  record(work: TimeframeWork, page: KlinePage, now: number): number {
    const bucketMs = work.interval * MINUTE_MS;
    const newestClosed = Math.floor((now - CLOSED_GRACE_MS) / bucketMs) * bucketMs - bucketMs;
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
    // The v2 contract closes on exact bucket boundaries, while storage keeps
    // the existing clock-skew grace. If the requested newest bar is merely
    // inside that grace, retry on the next collector pass instead of applying
    // the ordinary five-minute empty/error throttle.
    if (work.endMs > newestClosed) {
      this.lastAttempts.delete(`${work.key}\u0000${work.startMs}\u0000${work.endMs}`);
    }
    const written = this.store.write(work.venue, work.symbol, work.interval, candles, "native", work.interval, newestClosed);
    if (candles.length) {
      const id = this.identity(work.venue, work.symbol, work.interval);
      const frontier = Math.max(this.frontiers.get(id) ?? -Infinity, ...candles.map((c) => c.openMs));
      this.frontiers.set(id, frontier);
      writeJsonAtomic(this.frontierFile, { v: 2, frontiers: Object.fromEntries(this.frontiers) } satisfies FrontierFile);
    }
    this.materialize(work.venue, work.symbol, work.targetInterval,
      work.startMs, work.endMs + work.targetInterval * MINUTE_MS, null);
    return written;
  }

  prune(now: number): number {
    // Preserve a complete UTC boundary bar beyond the configured 30-day minute horizon.
    this.trimState(now);
    return this.store.prune(now - this.retentionDays * DAY_MS - DAY_MS);
  }
}
