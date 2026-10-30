// src/candles/bitunix-fold.ts
// v0.4.102 — WHEN IS A BITUNIX 1m BAR CLOSED? THE BOUNDARY THE VENUE SENDS.
//
// Bitunix's `market_kline_1min` push carries no candle open time and no closed
// flag — only the message `ts` (stream.ts). Through 0.4.101 the Hub closed a
// bar with the generic `ClosureBuffer` rule: the first frame stamped in a
// later minute publishes the held one. Measured 2026-10-29 (app repo,
// docs/BITUNIX-WS-PRIMARY-CANDLES-2026-10-29.md, 67 + 265 pairs) that rule
// publishes the WRONG frame at every boundary, because the venue sends:
//
//   1. one or two FINALISATION snapshots of the closing bar M, stamped in M+1
//      (+5…348 ms after the boundary, median +156 ms), with M's open and the
//      last trades of M included;
//   2. the SEED of M+1: flat, zero volume, open == M's final close, usually at
//      the SAME `ts` as the last finalisation (927 of 934), else ≤ 30 ms later.
//
// So the first M+1-stamped frame is M's own finalisation; `ClosureBuffer`
// published the last PRE-boundary snapshot of M (short the final trades: 260
// of 924 minutes disagreed with REST) and then held M's finalisation as though
// it were M+1. That is the "[candles] bitunix: 300–2,900 WS-folded rows
// corrected from REST this pass" journal line (together with the volume-unit
// mix, bitunix-volume.ts).
//
// THE PROOF THIS MODULE CLOSES A BAR WITH. A flat zero-volume frame in bucket
// M+1 says no trade has yet happened in M+1. Volume is cumulative within one
// bar (never seen to fall: 29,208 of 29,208 successions) and one socket
// delivers in the venue's send order, so any EARLIER-arrived M+1-stamped frame
// with volume > 0 that continues M (same open, volume not lower, range
// enclosing) is M's finalisation. The seed's open then proves M's close
// (seed open == REST prior close, 1,005 of 1,005). Closed that way, 8,161 of
// 8,161 bars equalled REST on o/h/l/c/v. Timing is only a NECESSARY condition
// (finalisation and seed within `BITUNIX_FINALISE_WINDOW_MS`); it never proves
// anything by itself.
//
// This is a port of the app's `applyBitunixPush` (0.91.27,
// src/venues/bitunix-public-data.ts) with the same branches:
//   · an older `ts` is dropped; an EQUAL `ts` is judged, not dropped — a flat
//     zero seed or a same-bar snapshot whose volume did not fall is accepted,
//     an exact duplicate is dropped;
//   · a traded first frame (no predecessor, e.g. after a reconnect) proves
//     nothing: quarantined until a seed;
//   · same bucket: forming updated; a frame that moves the seeded open or
//     lowers cumulative volume breaks the bar's identity → unresolved;
//   · next bucket, a continuing frame inside the window → M's finalisation
//     CANDIDATE (a later one supersedes it); nothing published;
//   · next bucket, the seed → M CLOSES iff seed.open === candidate.close;
//     otherwise `stale-tail`. With NO finalisation frame (the 2026-10-09
//     regime) the v0.90.181 rule is kept: M closes iff the seed opens at the
//     held close;
//   · next bucket, anything else, or a late frame → `ambiguous-boundary`,
//     quarantined until a seed; a jump of two or more buckets → `silent`.
//
// An unresolved minute is simply NOT PUBLISHED. The Hub's REST collector then
// sees a hole / an unconfirmed span and fills it from the venue's book of
// record (collector.ts reconcile + repair) — and `buildSeed` never serves a
// minute REST has not looked at in any case. Nothing here synthesises a bar.

import { MINUTE_MS, type Candle } from "./store.js";
import type { StreamTick, TickCloser } from "./stream.js";

/** How far past a boundary a finalisation frame and the successor's seed may
 *  arrive and still close the bar: measured +5…348 ms (2026-10-29) and
 *  +5…430 ms (2026-10-09), so 5 s is >10x the worst seen. */
export const BITUNIX_FINALISE_WINDOW_MS = 5_000;

export type BitunixUnresolvedReason = "stale-tail" | "silent" | "ambiguous-repeat" | "ambiguous-boundary";

type Bar = { open: number; high: number; low: number; close: number; volume: number };

interface FoldState {
  /** Bucket of the bar being built, or (at a boundary) being finalised. */
  bucketStart: number | null;
  /** The bar for `bucketStart`, or null when its identity is unproven. */
  forming: Candle | null;
  /** Newest nonzero snapshot whose minute is uncertain. Never published. */
  carry: Candle | null;
  /** Greatest accepted wire `ts` and the payload that set it. */
  lastPushTs: number | null;
  lastPush: Bar | null;
  /** Only a fresh flat zero seed resumes folding. */
  awaitingSeed: boolean;
  /** At a boundary: the newest post-boundary snapshot of `bucketStart`'s bar,
   *  held until the successor's seed proves it. */
  finalCandidate: Candle | null;
}

const empty = (): FoldState => ({
  bucketStart: null, forming: null, carry: null, lastPushTs: null, lastPush: null,
  awaitingSeed: false, finalCandidate: null,
});

/** A flat zero-volume snapshot: the venue's seed of a new bar. */
export function bitunixIsSeed(p: Bar): boolean {
  return p.volume === 0 && p.open === p.high && p.high === p.low && p.low === p.close;
}

/** May `push` be a later snapshot of the SAME bar as `bar`? Same seeded open,
 *  cumulative volume nonzero and not lower; the range encloses the held one
 *  unless the held snapshot is the seed itself (a seeded open can sit outside
 *  the traded range — TOSHIUSDT o 0.0001123 / h 0.0001122, as REST serves it). */
export function bitunixPushContinuesBar(bar: Bar, push: Bar): boolean {
  if (push.open !== bar.open || !(push.volume > 0) || push.volume < bar.volume) return false;
  return bar.volume === 0 || (push.high >= bar.high && push.low <= bar.low);
}

function repeats(bar: Bar, push: Bar): boolean {
  return push.open === bar.open && push.high === bar.high && push.low === bar.low
    && push.close === bar.close && push.volume === bar.volume;
}

export interface BitunixFoldStats {
  closed: number;
  closedFinalised: number;
  dropped: number;
  unresolved: Record<BitunixUnresolvedReason, number>;
}

/** Per-symbol Bitunix closure, same surface as `ClosureBuffer`. `push` returns
 *  a CLOSED tick only when the successor's seed proved it; every other outcome
 *  returns null and publishes nothing. Requires `tick.ts` (the wire `ts`). */
export class BitunixClosureBuffer implements TickCloser {
  private readonly states = new Map<string, FoldState>();
  readonly stats: BitunixFoldStats = {
    closed: 0, closedFinalised: 0, dropped: 0,
    unresolved: { "stale-tail": 0, silent: 0, "ambiguous-repeat": 0, "ambiguous-boundary": 0 },
  };
  /** Test/diagnostic hook: every minute this fold refused to publish. */
  onUnresolved?: (symbol: string, fromMs: number, throughMs: number, reason: BitunixUnresolvedReason) => void;

  push(tick: StreamTick): StreamTick | null {
    const ts = tick.ts;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
    const prior = this.states.get(tick.symbol) ?? empty();
    const { state, closed } = this.apply(tick.symbol, prior, ts, tick.candle);
    if (state !== prior) this.states.set(tick.symbol, state);
    if (!closed) return null;
    return { symbol: tick.symbol, openMs: closed.openMs, candle: closed, closed: true, ts };
  }

  private unresolved(symbol: string, from: number, through: number, reason: BitunixUnresolvedReason): void {
    this.stats.unresolved[reason] += (Math.max(from, through) - from) / MINUTE_MS + 1;
    this.onUnresolved?.(symbol, from, Math.max(from, through), reason);
  }

  private apply(symbol: string, prior: FoldState, ts: number, wire: Candle): { state: FoldState; closed: Candle | null } {
    const bucketStart = Math.floor(ts / MINUTE_MS) * MINUTE_MS;
    const candle: Candle = { openMs: bucketStart, open: wire.open, high: wire.high, low: wire.low, close: wire.close, volume: wire.volume };
    const payload: Bar = { open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume };
    const next = (s: Partial<FoldState>): FoldState => ({
      ...empty(), ...s, lastPushTs: ts, lastPush: payload,
    });
    const seeded = (): FoldState => next({ bucketStart, forming: candle });
    const quarantine = (): FoldState => next({ bucketStart, carry: candle, awaitingSeed: true });
    const drop = () => { this.stats.dropped++; return { state: prior, closed: null }; };
    const isSeed = bitunixIsSeed(candle);
    const inWindow = ts - bucketStart <= BITUNIX_FINALISE_WINDOW_MS;

    // ── The fence. An equal ts is the venue stamping a finalisation and its
    // successor's seed in the same millisecond: judged, not discarded.
    if (prior.lastPushTs !== null && ts <= prior.lastPushTs) {
      if (ts < prior.lastPushTs) return drop();
      const last = prior.lastPush;
      if (!last) return drop();
      const sameBarLater = payload.open === last.open && payload.volume >= last.volume && payload.volume > 0;
      if (repeats(last, payload) || (!isSeed && !sameBarLater)) return drop();
    }
    if (prior.bucketStart === null) {
      if (isSeed) return { state: seeded(), closed: null };
      this.unresolved(symbol, bucketStart, bucketStart, "ambiguous-boundary");
      return { state: quarantine(), closed: null };
    }
    if (bucketStart < prior.bucketStart) return drop();

    // ── A boundary in progress: `prior.bucketStart` is M, its finalisation held.
    const candidate = prior.finalCandidate;
    if (candidate && prior.forming) {
      const M = prior.bucketStart;
      if (bucketStart === M + MINUTE_MS) {
        if (isSeed) {
          if (inWindow && candle.open === candidate.close) {
            this.stats.closed++; this.stats.closedFinalised++;
            return { state: seeded(), closed: candidate };
          }
          this.unresolved(symbol, M, M, inWindow ? "stale-tail" : "ambiguous-boundary");
          return { state: seeded(), closed: null };
        }
        if (inWindow && bitunixPushContinuesBar(candidate, candle)) {
          return { state: { ...prior, finalCandidate: { ...candle, openMs: M }, lastPushTs: ts, lastPush: payload }, closed: null };
        }
        this.unresolved(symbol, M, M, "ambiguous-boundary");
        return { state: quarantine(), closed: null };
      }
      // Two or more buckets on: M and every skipped minute are unknown.
      const through = isSeed ? bucketStart - MINUTE_MS : bucketStart;
      this.unresolved(symbol, M, through, "silent");
      return { state: isSeed ? seeded() : quarantine(), closed: null };
    }

    if (bucketStart === prior.bucketStart) {
      if (prior.awaitingSeed || !prior.forming) {
        if (isSeed) return { state: seeded(), closed: null };
        if (prior.carry && repeats(prior.carry, candle)) {
          return { state: { ...prior, lastPushTs: ts, lastPush: payload }, closed: null };
        }
        // A traded snapshot after an unresolved bucket is not an identity proof.
        if (prior.awaitingSeed) {
          return { state: { ...prior, lastPushTs: ts, lastPush: payload, carry: candle }, closed: null };
        }
        this.unresolved(symbol, bucketStart, bucketStart, "ambiguous-boundary");
        return { state: quarantine(), closed: null };
      }
      // One bar keeps its seeded open and never loses cumulative volume.
      if (candle.open !== prior.forming.open || candle.volume < prior.forming.volume) {
        this.unresolved(symbol, bucketStart, bucketStart, "ambiguous-boundary");
        return { state: quarantine(), closed: null };
      }
      return { state: next({ bucketStart, forming: candle }), closed: null };
    }

    // A later bucket.
    const adjacent = bucketStart === prior.bucketStart + MINUTE_MS;
    if (prior.awaitingSeed || !prior.forming || !adjacent) {
      // A zero seed identifies its own minute, so the unknown interval ends at
      // the preceding bucket; a traded first frame could still be a delayed
      // finalisation for its own timestamp bucket, which is included.
      const through = isSeed ? bucketStart - MINUTE_MS : bucketStart;
      this.unresolved(symbol, prior.bucketStart, through, adjacent ? "ambiguous-boundary" : "silent");
      return { state: isSeed ? seeded() : quarantine(), closed: null };
    }
    const held = prior.forming;
    if (isSeed) {
      // No finalisation frame arrived (the 2026-10-09 regime): the v0.90.181
      // rule — the seeded open proves the held close; a stale tail is refused.
      if (candle.open === held.close) {
        this.stats.closed++;
        return { state: seeded(), closed: held };
      }
      this.unresolved(symbol, prior.bucketStart, prior.bucketStart, "stale-tail");
      return { state: seeded(), closed: null };
    }
    if (inWindow && bitunixPushContinuesBar(held, candle)) {
      return {
        state: { ...prior, finalCandidate: { ...candle, openMs: prior.bucketStart }, carry: null, lastPushTs: ts, lastPush: payload },
        closed: null,
      };
    }
    if (repeats(held, candle) && held.volume > 0) {
      this.unresolved(symbol, prior.bucketStart, prior.bucketStart, "ambiguous-repeat");
      return { state: quarantine(), closed: null };
    }
    this.unresolved(symbol, prior.bucketStart, prior.bucketStart, "ambiguous-boundary");
    return { state: quarantine(), closed: null };
  }

  /** Symbols currently holding fold state. */
  size(): number { return this.states.size; }
  forget(symbol: string): void { this.states.delete(symbol); }
  /** A transport gap: no bar in flight can be proven complete any more. */
  clear(): void { this.states.clear(); }
}
