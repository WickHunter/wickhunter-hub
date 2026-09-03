// src/candles/snapshot.ts
// Builds and SIGNS the /api/candles/snapshot payload: for ONE venue, the last
// N CLOSED candles at one timeframe, for EVERY symbol that venue tracks, in a
// single signed response.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The bot's configurable-volatility filter judges a pair on the last N closed
// candles at a rule's timeframe. Asked of the venue, that is one request per
// pair: a 500-pair roster spends about nine minutes of paced venue reads before
// the filter can decide anything, and every install pays it again. The hub is
// already holding those minutes for every pair on the venue, so it can answer
// the whole roster at once.
//
// ── THE SAME THREE RULES THE SEED IS BUILT ON ───────────────────────────────
// This is the seed's argument at a coarser timeframe, so it keeps the seed's
// properties rather than inventing softer ones:
//
//   1. CLOSED BUCKETS ONLY, and completeness is a fact about the ROWS. A bucket
//      is published only when every one of its minutes is present in the store
//      and closed. The bucket still forming is never included — not trimmed,
//      not "mostly complete", not extrapolated from the minutes we do hold.
//   2. NOTHING IS INVENTED. A symbol whose window has a hole is SKIPPED and
//      named in `skipped`; it never comes back with a bucket folded from the
//      minutes that happened to survive. A short bucket is a DIFFERENT candle,
//      and a filter that refuses new exposure on a 10% move would read one as
//      calm.
//   3. PER VENUE, VENUE-NATIVE SPELLINGS, NEVER JOINED. `1000PEPEUSDT` on one
//      venue and `PEPEUSDT` on another are different books at different prices.
//
// ── THE FOLD ────────────────────────────────────────────────────────────────
// first open, max high, min low, last close, summed base volume — the same
// aggregation the bot does for itself over native rows, so a hub-fed window and
// a venue-fed one are the same numbers.
import type { CandleStore, Row } from "./store.js";
import { MINUTE_MS, newestClosedOpenMs } from "./store.js";
import type { VenueId } from "./venues.js";

/** Contract v1. Like the seed's v1 and the LHK1 token format, these bytes are
 *  what a shipped bot is built against: any change needs a v:2, never a
 *  mutation of v:1. */
export const SNAPSHOT_WIRE_VERSION = 1;

/** The timeframes a bot's volatility rules can ask for, in MINUTES. Exactly the
 *  bot's own rule set — a timeframe it cannot configure is one nobody can ask
 *  for, and an arbitrary integer here would let a caller make the hub fold work
 *  no rule will ever read. */
export const SNAPSHOT_INTERVALS: readonly number[] = [1, 3, 5, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440];

/** Depth ceiling. 500 candles is far past any rule the bot's form can express
 *  (the shipped one asks for 10) and is what bounds the work one request can
 *  ask for at the coarsest timeframe. */
export const SNAPSHOT_MAX_DEPTH = 500;

/** ── THE SETTLE LAG ────────────────────────────────────────────────────────
 *
 *  A bucket closes on the grid; the minute that ends it reaches this store a
 *  little later — the collector's tail cadence, or the stream's own frame. The
 *  newest bucket is therefore not asked for until it has had 90 seconds to
 *  land, so a snapshot built the instant a boundary passed does not report the
 *  whole roster as `gap` for the one minute nobody has fetched yet.
 *
 *  It is the SAME number on both sides of the cache deliberately: the served
 *  window is chosen against `now - lag`, and the cache is reused until the next
 *  boundary PLUS that lag, so the entry that expires is exactly the entry whose
 *  successor can now be built completely. Two different lags here would mean a
 *  rebuild that reproduces the answer it just replaced. */
export const SNAPSHOT_SETTLE_LAG_MS = 90_000;

/** Why a symbol carries no rows. Both mean "do not use this pair from this
 *  snapshot"; they differ in what the operator should do about it.
 *   · "gap"   — we hold history here and it has a hole in it (interior, or a
 *               tail we have not collected yet). A collector problem.
 *   · "short" — our history does not reach back far enough: a new listing, a
 *               pair pruned by retention, or a depth nobody has collected yet.
 *               Time fixes it; nothing else has to. */
export type SnapshotSkipReason = "gap" | "short";

/** `["BTCUSDT", [[openMs,open,high,low,close,volume], ...]]` — an ARRAY pair,
 *  not an object map: it keeps the canonical bytes ordered by construction
 *  (a JSON object's key order would become part of the signature) and it is
 *  meaningfully smaller across 500 pairs. */
export type SnapshotSymbolRows = [string, Row[]];
export type SnapshotSkipped = [string, SnapshotSkipReason];

/** The unsigned payload, in the PINNED CANONICAL KEY ORDER. */
export interface SnapshotUnsigned {
  v: number;
  venue: VenueId;
  interval: number;
  depth: number;
  generatedAtMs: number;
  lastClosedMs: number;
  symbols: SnapshotSymbolRows[];
  skipped: SnapshotSkipped[];
  keyId: string;
}

export interface SnapshotSigned extends SnapshotUnsigned {
  sig: string;
}

// ── CANONICAL BYTES FOR THE SIGNATURE ───────────────────────────────────────
//
//   sig = Ed25519( UTF-8 JSON of the payload with `sig` REMOVED and the keys
//                  serialised in EXACTLY this order:
//
//        v, venue, interval, depth, generatedAtMs, lastClosedMs, symbols,
//        skipped, keyId
//
// Same technique and the same reason as seed.ts: a FRESH object literal written
// in the pinned order IS the canonicalisation, because JSON.stringify preserves
// insertion order. Never "tidy" it alphabetically — the verifier reproduces
// these bytes or every signature fails, everywhere, at once.
//
// No whitespace, no indentation, no trailing newline. Numbers are JSON's own
// double formatting, which is why the store keeps candles as binary doubles
// rather than the decimal strings the venues send.
export const SNAPSHOT_CANONICAL_KEY_ORDER = [
  "v", "venue", "interval", "depth", "generatedAtMs", "lastClosedMs", "symbols", "skipped", "keyId",
] as const;

export function canonicalSnapshotBytes(p: SnapshotUnsigned): Buffer {
  const ordered = {
    v: p.v,
    venue: p.venue,
    interval: p.interval,
    depth: p.depth,
    generatedAtMs: p.generatedAtMs,
    lastClosedMs: p.lastClosedMs,
    symbols: p.symbols,
    skipped: p.skipped,
    keyId: p.keyId,
  };
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

export function isSnapshotInterval(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && SNAPSHOT_INTERVALS.includes(n);
}

export function isSnapshotDepth(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= SNAPSHOT_MAX_DEPTH;
}

export function snapshotBucketMs(intervalMinutes: number): number {
  return intervalMinutes * MINUTE_MS;
}

/** The open time of the newest bucket that is COMPLETE at `now`, on the UTC
 *  grid, with the settle lag already spent.
 *
 *  Read off the CLOCK, not off any symbol's data, so every symbol in one
 *  snapshot answers for the same window — a per-symbol newest bucket would make
 *  two pairs in one response describe different stretches of time, which is
 *  exactly the comparison a volatility rule is making. A symbol that cannot
 *  fill this window is skipped rather than served a window of its own. */
export function newestCompleteBucketOpenMs(now: number, intervalMinutes: number): number {
  const bucketMs = snapshotBucketMs(intervalMinutes);
  // The newest minute that is closed at (now - lag); +MINUTE_MS is the instant
  // it closed, and the boundary at or before that instant ends a bucket whose
  // every minute is closed.
  const closedAt = newestClosedOpenMs(now - SNAPSHOT_SETTLE_LAG_MS) + MINUTE_MS;
  return Math.floor(closedAt / bucketMs) * bucketMs - bucketMs;
}

/** When a snapshot built for `lastClosedMs` stops being the newest one: the
 *  boundary after next, plus the settle lag. Before that instant a rebuild can
 *  only reproduce the same window. */
export function snapshotExpiresAtMs(lastClosedMs: number, intervalMinutes: number): number {
  return lastClosedMs + 2 * snapshotBucketMs(intervalMinutes) + SNAPSHOT_SETTLE_LAG_MS;
}

export type SymbolFold =
  | { ok: true; rows: Row[] }
  | { ok: false; reason: SnapshotSkipReason };

/** Fold one symbol's 1m rows into `depth` complete buckets, or say why not.
 *
 *  `rows` is what the store holds inside [windowStart, windowEnd] — oldest
 *  first, strictly increasing, one per present minute. The decision, in this
 *  order, and the order is the contract:
 *
 *    1. nothing held in the window            -> "short"
 *    2. our history BEGINS inside the window
 *       (a new listing, or retention)         -> "short"
 *    3. a minute missing at or after that
 *       first held minute (interior, or a
 *       tail we have not collected)           -> "gap"
 *    4. otherwise: exactly `depth` complete buckets.
 *
 *  Steps 2 and 3 are separate because they are different problems with
 *  different fixes, and because a single "anything missing is a gap" rule would
 *  report every newly-listed pair as a collector fault. */
export function foldSymbolWindow(
  rows: readonly Row[],
  windowStart: number,
  depth: number,
  intervalMinutes: number,
  /** The oldest minute we hold for this symbol ANYWHERE, when the caller knows
   *  it. It is what tells a pair whose history begins inside the window from
   *  one we were already collecting that has a hole at the window's leading
   *  edge — the same absence, two different faults. Without it the honest
   *  reading of a leading absence is "not that deep". */
  firstHeldMs?: number,
): SymbolFold {
  const bucketMs = snapshotBucketMs(intervalMinutes);
  if (rows.length === 0) return { ok: false, reason: "short" };
  if (rows[0]![0] > windowStart) {
    return { ok: false, reason: (firstHeldMs ?? rows[0]![0]) > windowStart ? "short" : "gap" };
  }

  const out: Row[] = [];
  // ONE PASS over the rows, not one pass per bucket: at the coarsest timeframe
  // and the deepest window a per-bucket rescan is 500 x 720,000 comparisons for
  // a single symbol, on a route a licence holder may call.
  let i = 0;
  for (let b = 0; b < depth; b++) {
    const start = windowStart + b * bucketMs;
    const end = start + bucketMs; // exclusive
    while (i < rows.length && rows[i]![0] < start) i++;
    let open = NaN, high = -Infinity, low = Infinity, close = NaN, volume = 0, minutes = 0;
    for (; i < rows.length && rows[i]![0] < end; i++) {
      const r = rows[i]!;
      if (minutes === 0) open = r[1];
      if (r[2] > high) high = r[2];
      if (r[3] < low) low = r[3];
      close = r[4];
      volume += r[5];
      minutes++;
    }
    // ── COMPLETE MEANS EVERY MINUTE, COUNTED ────────────────────────────
    // This one test is what detects a hole, wherever it sits — interior, or a
    // tail nobody has collected — because a store row is one closed minute and
    // the rows are unique and ordered, so a count IS a contiguity proof. It is
    // deliberately not backed up by a second "is the window contiguous" test
    // higher up: two rules for one property is where two rules disagree, and
    // the one that folds the numbers is the one that has to be right.
    if (minutes !== intervalMinutes) return { ok: false, reason: "gap" };
    out.push([start, open, high, low, close, volume]);
  }
  return { ok: true, rows: out };
}

export type SnapshotOutcome =
  | { ok: true; payload: SnapshotSigned }
  /** 400 — the request itself is malformed. */
  | { ok: false; code: 400; error: string }
  /** 503 — nothing complete to publish yet. NEVER a 200 with no symbols: "we
   *  hold nothing" and "this venue lists nothing" must not be one answer. */
  | { ok: false; code: 503; error: string };

export interface SnapshotRequest {
  venue: VenueId;
  interval: number;
  depth: number;
  /** Build clock. The window is derived from it, never from a symbol's data. */
  now: number;
}

export interface SnapshotDeps {
  store: CandleStore;
  keyId: string;
  sign(bytes: Buffer): Buffer;
  /** Every symbol this venue tracks, venue-native spellings. Read from memory
   *  by the caller — this build never waits on a collector. */
  symbols(venue: VenueId): readonly string[];
}

export function buildSnapshot(req: SnapshotRequest, deps: SnapshotDeps): SnapshotOutcome {
  const { venue, interval, depth, now } = req;
  if (!isSnapshotInterval(interval)) {
    return { ok: false, code: 400, error: `interval must be one of ${SNAPSHOT_INTERVALS.join(",")} minutes` };
  }
  if (!isSnapshotDepth(depth)) {
    return { ok: false, code: 400, error: `depth must be an integer 1..${SNAPSHOT_MAX_DEPTH}` };
  }
  if (!Number.isFinite(now)) {
    return { ok: false, code: 400, error: "the build clock is not a finite epoch-ms number" };
  }
  const bucketMs = snapshotBucketMs(interval);
  const lastClosedMs = newestCompleteBucketOpenMs(now, interval);
  const windowStart = lastClosedMs - (depth - 1) * bucketMs;
  if (lastClosedMs < 0 || windowStart < 0) {
    return { ok: false, code: 503, error: `no complete ${interval}m window of ${depth} candles exists yet` };
  }
  const windowEnd = lastClosedMs + bucketMs - MINUTE_MS;

  const symbols: SnapshotSymbolRows[] = [];
  const skipped: SnapshotSkipped[] = [];
  for (const symbol of [...deps.symbols(venue)].sort()) {
    // ── THE CHEAP REFUSALS COME FIRST, AND THEY ANSWER THE SAME WAY THE FOLD
    // WOULD ─────────────────────────────────────────────────────────────────
    // `coverage` is a readdir and at most two day-file reads; reading the whole
    // window is up to `depth * interval` minutes of day files PER SYMBOL, and a
    // 500-deep daily request across a 500-pair venue would do that for pairs
    // whose history provably cannot reach. These two tests are steps 1-3 of
    // `foldSymbolWindow` asked of the coverage summary rather than of the rows,
    // in the same order, so the label cannot depend on which path answered.
    const cov = deps.store.coverage(venue, symbol);
    if (cov.lastClosedMs === null || cov.firstClosedMs === null || cov.firstClosedMs > windowStart) {
      skipped.push([symbol, "short"]);
      continue;
    }
    if (cov.lastClosedMs < windowEnd) {
      skipped.push([symbol, "gap"]);
      continue;
    }
    const { rows } = deps.store.readWindow(venue, symbol, windowStart, windowEnd);
    const folded = foldSymbolWindow(rows, windowStart, depth, interval, cov.firstClosedMs);
    if (folded.ok) symbols.push([symbol, folded.rows]);
    else skipped.push([symbol, folded.reason]);
  }

  // ── NEVER 200 WITH NO SYMBOLS ───────────────────────────────────────────
  // The seed never answers 200 with empty rows for the same reason: a cold hub
  // and a venue with nothing on it would become the same answer, and a caller
  // cannot tell "come back later" from "there is nothing to have".
  if (symbols.length === 0) {
    return {
      ok: false,
      code: 503,
      error: `no symbol on ${venue} holds ${depth} complete ${interval}m candles yet`,
    };
  }

  const payload: SnapshotUnsigned = {
    v: SNAPSHOT_WIRE_VERSION,
    venue,
    interval,
    depth,
    generatedAtMs: now,
    lastClosedMs,
    symbols,
    skipped,
    keyId: deps.keyId,
  };
  const sig = deps.sign(canonicalSnapshotBytes(payload)).toString("base64");
  // `sig` last: the wire object is the canonical object plus the signature.
  return { ok: true, payload: { ...payload, sig } };
}
