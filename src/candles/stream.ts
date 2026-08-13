// src/candles/stream.ts
// v0.2.16 — THE TAIL, BY WEBSOCKET, SO REST CAN SPEND ITS WHOLE BUDGET ON DEPTH.
//
// The collector polls. That is why `tailFillMinutes` is 100: a request that
// returns one row is a request wasted, so a symbol is not tail-due until it has
// accumulated most of a page. The cost is stated in that file — the newest
// candle the hub holds is up to that old.
//
// A stream removes the reason for the trade. Closed minutes arrive as they
// happen, at no REST cost, so the tail is current AND the entire request budget
// goes to backfill depth. This module is only the tail; `collector.ts` remains
// the sole owner of history, listings, retention and rate limiting.
//
// ── ZERO NEW DEPENDENCIES ──────────────────────────────────────────────────
// Node >= 22 (this package's own `engines`) ships a global `WebSocket`. This
// repo has NO runtime dependencies at all, and a candle feed is not the place
// to start: every added package is code that runs beside the licence signing
// key.
//
// ── THE HARD PART: TWO OF THREE VENUES NEVER SAY "CLOSED" ───────────────────
// Frames captured live from the real endpoints while writing this (Bybit's leg
// is from its documented v5 contract and the working client in the bot repo —
// this build environment is geo-blocked from Bybit and could not probe it):
//
//   BITGET  wss://ws.bitget.com/v2/ws/public
//     {"action":"update","arg":{"instId":"BTCUSDT",...},
//      "data":[["1786650720000","63415.3","63415.3","63415.3","63415.3",
//               "0.2742","17388.47526","17388.47526"]],"ts":...}
//     Row is [openMs, o, h, l, c, baseVol, quoteVol, quoteVol]. Consecutive
//     updates REPEAT the same openMs with changing values — that is the bar
//     forming. There is no closed flag.
//
//   BITUNIX  wss://fapi.bitunix.com/public/
//     {"ch":"market_kline_1min","symbol":"BTCUSDT","ts":1786650730275,
//      "data":{"o":"63404.6","c":"63404.6","h":"63404.7","l":"63404.6",
//              "b":"0.226","q":"14329.45786"}}
//     No closed flag AND NO CANDLE OPEN TIME — only the message `ts`. The
//     minute has to be derived from it. That is a materially weaker guarantee
//     than the other two and it is why `openMsFromTs` is named rather than
//     inlined: the bucket a Bitunix candle lands in is the venue's own clock
//     reading, not a field the venue stated.
//
//   BYBIT  wss://stream.bybit.com/v5/public/linear
//     {"topic":"kline.1.BTCUSDT","data":[{"start":...,"confirm":true,...}]}
//     The only one that states closure outright, and it is authoritative.
//
// ── THE CLOSURE RULE, AND WHY IT IS NOT A CLOCK READ ────────────────────────
// For the two venues with no flag, a minute is published only once a tick for a
// LATER minute has arrived. That is an ORDERING fact about the venue's own
// stream — the exchange has moved on — rather than a comparison against this
// machine's clock. `olb-venue-candles.ts` in the bot repo refuses the clock
// version explicitly ("NTP drift is not a thing to gate entries on"), and a hub
// feeding every install's trading candles has no more right to it than a bot.
//
// The store's own `settledOpenMs` filter still runs on write, so a stream that
// somehow published early is caught by the same gate REST output passes.
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ──────────────────────────────
// It never backfills, never decides retention, and never touches the tracked
// symbol set. A stream that dropped frames for an hour must leave no trace
// except a gap the REST collector's existing tail work repairs on its own
// schedule — so a stream failure degrades to exactly today's behaviour, which
// is the property that makes it safe to turn on.

import { MINUTE_MS, floorMinute, type Candle } from "./store.js";
import type { VenueId } from "./venues.js";

/** One parsed candle observation off the wire. `closed` is TRUE only when the
 *  venue itself said so; everything else is settled by the ordering rule. */
export interface StreamTick {
  symbol: string;
  openMs: number;
  candle: Candle;
  closed: boolean;
}

export interface StreamAdapter {
  readonly id: VenueId;
  readonly url: string;
  /** Topics one connection may carry. Bitget documents 1000 but advises far
   *  fewer; Bitunix documents 300. Exceeded, the stream opens more sockets. */
  readonly maxTopicsPerConnection: number;
  /** Subscribe frames for a batch of symbols, already within the cap. */
  subscribeFrames(symbols: readonly string[]): unknown[];
  /** Parse one TEXT frame. Returns [] for acks, heartbeats and anything
   *  unrecognised — an unparseable frame is never an error, because a venue
   *  adding a field must not stop the tail. */
  parse(frame: string): StreamTick[];
  /** Some venues want a periodic ping to keep the socket open. */
  readonly pingIntervalMs?: number;
  readonly pingFrame?: string;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** A candle is only usable if every field parsed and the minute is on grid. */
function usable(t: StreamTick | null): t is StreamTick {
  if (!t) return false;
  const c = t.candle;
  return Number.isFinite(t.openMs) && t.openMs > 0 && t.openMs % MINUTE_MS === 0
    && [c.open, c.high, c.low, c.close, c.volume].every((n) => Number.isFinite(n))
    && c.high >= c.low;
}

/** Bitunix carries no candle open time — only the message timestamp. Named
 *  rather than inlined because it is the one place a stored candle's MINUTE
 *  comes from a clock reading instead of from the venue stating it. */
export function openMsFromTs(tsMs: number): number {
  return floorMinute(num(tsMs));
}

// ── the three adapters ──────────────────────────────────────────────────────

const bitget: StreamAdapter = {
  id: "bitget",
  url: "wss://ws.bitget.com/v2/ws/public",
  maxTopicsPerConnection: 50, // the venue's own recommendation, not its 1000 cap
  pingIntervalMs: 25_000,
  pingFrame: "ping",
  subscribeFrames(symbols) {
    return [{
      op: "subscribe",
      args: symbols.map((s) => ({ instType: "USDT-FUTURES", channel: "candle1m", instId: s })),
    }];
  },
  parse(frame) {
    if (frame === "pong") return [];
    let m: { action?: string; arg?: { instId?: string }; data?: unknown[] };
    try { m = JSON.parse(frame); } catch { return []; }
    // `event` frames are subscribe/error acks and carry no candles.
    if (!m || (m.action !== "snapshot" && m.action !== "update")) return [];
    const symbol = String(m.arg?.instId ?? "");
    if (!symbol || !Array.isArray(m.data)) return [];
    const out: StreamTick[] = [];
    for (const row of m.data) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const t: StreamTick = {
        symbol,
        openMs: num(row[0]),
        candle: {
          openMs: num(row[0]), open: num(row[1]), high: num(row[2]),
          low: num(row[3]), close: num(row[4]), volume: num(row[5]),
        },
        closed: false, // Bitget never says
      };
      if (usable(t)) out.push(t);
    }
    return out;
  },
};

const bitunix: StreamAdapter = {
  id: "bitunix",
  url: "wss://fapi.bitunix.com/public/",
  maxTopicsPerConnection: 300, // documented
  pingIntervalMs: 20_000,
  pingFrame: JSON.stringify({ op: "ping", ping: 0 }),
  subscribeFrames(symbols) {
    return [{ op: "subscribe", args: symbols.map((s) => ({ symbol: s, ch: "market_kline_1min" })) }];
  },
  parse(frame) {
    let m: { ch?: string; symbol?: string; ts?: number; data?: Record<string, unknown> };
    try { m = JSON.parse(frame); } catch { return []; }
    if (!m || m.ch !== "market_kline_1min" || !m.data || typeof m.data !== "object") return [];
    const symbol = String(m.symbol ?? "");
    if (!symbol) return [];
    // NO openMs on the wire — derived from the venue's own message clock.
    const openMs = openMsFromTs(num(m.ts));
    const d = m.data;
    const t: StreamTick = {
      symbol,
      openMs,
      candle: {
        openMs, open: num(d.o), high: num(d.h), low: num(d.l), close: num(d.c),
        volume: num(d.b), // `b` is base volume; `q` is quote
      },
      closed: false, // Bitunix never says
    };
    return usable(t) ? [t] : [];
  },
};

const bybit: StreamAdapter = {
  id: "bybit",
  url: "wss://stream.bybit.com/v5/public/linear",
  maxTopicsPerConnection: 500,
  pingIntervalMs: 20_000,
  pingFrame: JSON.stringify({ op: "ping" }),
  subscribeFrames(symbols) {
    return [{ op: "subscribe", args: symbols.map((s) => `kline.1.${s}`) }];
  },
  parse(frame) {
    let m: { topic?: string; data?: Array<Record<string, unknown>> };
    try { m = JSON.parse(frame); } catch { return []; }
    const topic = String(m?.topic ?? "");
    if (!topic.startsWith("kline.1.") || !Array.isArray(m.data)) return [];
    const symbol = topic.slice("kline.1.".length);
    if (!symbol) return [];
    const out: StreamTick[] = [];
    for (const k of m.data) {
      const openMs = num(k.start);
      const t: StreamTick = {
        symbol, openMs,
        candle: {
          openMs, open: num(k.open), high: num(k.high), low: num(k.low),
          close: num(k.close), volume: num(k.volume),
        },
        // THE ONLY VENUE THAT STATES IT. Trusted, because it is the venue's
        // own assertion rather than an inference of ours.
        closed: k.confirm === true,
      };
      if (usable(t)) out.push(t);
    }
    return out;
  },
};

export const STREAM_ADAPTERS: Record<VenueId, StreamAdapter> = { bybit, bitunix, bitget };

// ── the closure buffer ──────────────────────────────────────────────────────

/** Turns a stream of forming-bar observations into CLOSED candles.
 *
 *  A venue that states closure short-circuits this. For the two that do not, a
 *  minute is emitted only once the venue has sent a tick for a LATER minute —
 *  an ordering fact about the venue's own stream, never a comparison with this
 *  machine's clock.
 *
 *  A tick for an OLDER minute than the one pending is dropped: streams reorder
 *  on reconnect, and re-opening a minute already published would let a partial
 *  bar overwrite a complete one. The REST collector repairs anything lost here,
 *  which is the whole reason this may be lossy and still be safe. */
export class ClosureBuffer {
  private readonly pending = new Map<string, StreamTick>();

  /** Feed one tick; get back any candle that just became closed. */
  push(tick: StreamTick): StreamTick | null {
    if (tick.closed) {
      // The venue said so. Drop any pending bar for the same minute — the
      // confirmed one supersedes it — and publish.
      const held = this.pending.get(tick.symbol);
      if (held && held.openMs <= tick.openMs) this.pending.delete(tick.symbol);
      return tick;
    }
    const held = this.pending.get(tick.symbol);
    if (!held) { this.pending.set(tick.symbol, tick); return null; }
    if (tick.openMs === held.openMs) { this.pending.set(tick.symbol, tick); return null; }
    if (tick.openMs < held.openMs) return null; // reordered/stale — never reopen
    this.pending.set(tick.symbol, tick);
    return held;                                 // the venue moved on: `held` is closed
  }

  /** Symbols currently holding an unpublished forming bar. */
  size(): number { return this.pending.size; }

  forget(symbol: string): void { this.pending.delete(symbol); }
  clear(): void { this.pending.clear(); }
}
