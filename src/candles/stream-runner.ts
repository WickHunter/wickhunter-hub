// src/candles/stream-runner.ts
// v0.2.17 — the connection half of the websocket tail.
//
// `stream.ts` owns the PROTOCOL: what a frame means and when a minute is
// closed. This file owns what a CLOSED CANDLE does once the connection layer
// (`../net/socket-pool.ts`) hands it a frame: turning ticks into closed bars
// through `ClosureBuffer`, and WEEX's cross-connection deferred-settlement
// batching. The sockets, chunking, reconnect/backoff and ping themselves are
// `SocketPool` — the SAME class `src/liq/stream-runner.ts` uses for the
// liquidation feed, so there is exactly one reconnect implementation in this
// codebase rather than two that can drift apart.
//
// ── THE PROPERTY THAT MAKES THIS SAFE TO TURN ON ───────────────────────────
// A stream failure must degrade to EXACTLY today's behaviour. This runner never
// backfills, never decides retention, never touches the tracked symbol set and
// never reports health the collector would act on. Everything it does is
// additive: a closed minute lands in the store earlier than REST would have
// fetched it. If every socket dies and stays dead, the collector's existing tail
// work repairs the gap on its own schedule and nobody has to notice.
//
// That is also why nothing here retries a WRITE or tracks what it missed. A
// dropped frame is a gap, and this codebase already has exactly one mechanism
// for gaps.
//
// ── ONE SOCKET IS NOT ENOUGH, AND NEITHER IS ONE PER SYMBOL ────────────────
// Symbols are chunked at the venue's own documented topic cap
// (`maxTopicsPerConnection`). Bitget advises ~50 per connection against a 1000
// cap and allows 100 connections per IP; Bitunix documents 300 topics. A socket
// per symbol would blow the connection cap on any real roster; one socket for
// everything exceeds the topic cap and is refused.

import { settledOpenMs, type Candle } from "./store.js";
import { ClosureBuffer, type StreamAdapter, type StreamTick } from "./stream.js";
import {
  SocketPool, nodeSocketFactory,
  type PoolConn, type SocketFactory, type StreamSocket, type StreamSocketHandlers,
} from "../net/socket-pool.js";

// Re-exported for existing importers (`candles/service.ts`) — the socket
// primitives now live in `../net/socket-pool.js`, but nothing outside this
// module needs to know that moved.
export { nodeSocketFactory };
export type { SocketFactory, StreamSocket, StreamSocketHandlers };

export interface StreamRunnerDeps {
  adapter: StreamAdapter;
  /** The symbols this venue should be streaming, read fresh on every resync so
   *  a new listing joins without a restart — the same property `refreshSymbols`
   *  gives the REST collector. */
  symbols: () => readonly string[];
  /** Where a CLOSED candle goes. Bound to this venue by the caller so this file
   *  can never write to the wrong one. */
  write: (symbol: string, candles: readonly Candle[], notAfterMs: number) => void;
  now?: () => number;
  log?: (msg: string) => void;
  socket?: SocketFactory;
  /** First reconnect delay; doubles per consecutive failure to the ceiling. */
  reconnectMs?: number;
  reconnectMaxMs?: number;
  /** How often WEEX's logically closed, but not yet skew-safe, minute is
   *  reconsidered. Injected only so clock-driven tests do not wait a second. */
  settleFlushMs?: number;
}

interface ConnExtra {
  buf: ClosureBuffer;
  closedCandles: number;
}

const DEFAULT_SETTLE_FLUSH_MS = 1_000;
/** Normally one row: WEEX advances N while the store still admits only N-1.
 *  Three leaves bounded room for clock movement and duplicate snapshots while
 *  still refusing an unbounded remote-input queue. Oldest rows win because
 *  they become eligible first and preserve a contiguous tail. */
const MAX_WEEX_DEFERRED_PER_SYMBOL = 3;

export class VenueStreamRunner {
  private readonly pool: SocketPool<ConnExtra>;
  private readonly now: () => number;
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly weexDeferred = new Map<string, Map<number, Candle>>();

  constructor(private readonly deps: StreamRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.pool = new SocketPool<ConnExtra>({
      adapter: deps.adapter,
      symbols: deps.symbols,
      makeExtra: () => ({ buf: new ClosureBuffer(), closedCandles: 0 }),
      onMessage: (c, data) => this.ingest(c, data),
      onDiscard: (c) => c.extra.buf.clear(),
      onBeforeResync: (wanted) => {
        for (const symbol of this.weexDeferred.keys()) {
          if (!wanted.has(symbol)) this.weexDeferred.delete(symbol);
        }
      },
      log: deps.log,
      socket: deps.socket,
      reconnectMs: deps.reconnectMs,
      reconnectMaxMs: deps.reconnectMaxMs,
    });
  }

  /** Chunk the current symbol set and open a socket per chunk. Idempotent:
   *  calling it again re-chunks only if the symbol set actually changed, so a
   *  scheduler may call it as often as it likes. */
  start(): void {
    if (this.deps.adapter.id === "weex" && !this.settleTimer) {
      this.settleTimer = setInterval(
        () => this.flushWeexDeferred(),
        Math.max(1, this.deps.settleFlushMs ?? DEFAULT_SETTLE_FLUSH_MS),
      );
      this.settleTimer.unref();
    }
    this.pool.start();
  }

  stop(): void {
    this.pool.stop();
    if (this.settleTimer) { clearInterval(this.settleTimer); this.settleTimer = null; }
    this.weexDeferred.clear();
  }

  resync(): void { this.pool.resync(); }

  private ingest(c: PoolConn<ConnExtra>, data: string): void {
    // WEEX V3 uses an application-level JSON ping rather than websocket ping
    // frames — already answered by the pool's own replyFrames step before
    // this runs. Parse failures here must never kill the socket: a venue
    // adding a field is not an outage, and the REST tail covers whatever
    // this drops.
    let ticks: StreamTick[];
    try { ticks = this.deps.adapter.parse(data); } catch { return; }

    // WEEX opens each subscription with a snapshot containing hundreds of
    // already-closed rows. `CandleStore.write` durably rewrites a whole day
    // file, so calling it once per row turns a 301-row snapshot across a full
    // roster into tens of thousands of synchronous file rewrites. Keep the
    // batching local to WEEX: one received frame becomes at most one durable
    // write per symbol, while every existing venue retains its exact delivery
    // behaviour. Incremental WEEX frames normally contain one row; a row the
    // ordering rule just closed waits here until the shared skew-safe store
    // boundary admits it.
    if (this.deps.adapter.id === "weex") {
      const notAfterMs = settledOpenMs(this.now());
      const closedBySymbol = new Map<string, Map<number, Candle>>();
      this.takeSettledWeexDeferred(notAfterMs, closedBySymbol);
      const assigned = new Set(c.symbols);
      for (const t of ticks) {
        if (!assigned.has(t.symbol)) continue;
        const done = c.extra.buf.push(t);
        if (!done) continue;
        if (done.candle.openMs <= notAfterMs) {
          this.addReadyWeex(closedBySymbol, done.symbol, done.candle);
          this.weexDeferred.get(done.symbol)?.delete(done.candle.openMs);
        } else {
          this.deferWeex(done.symbol, done.candle);
        }
      }
      this.writeWeexReady(closedBySymbol, notAfterMs);
      return;
    }

    for (const t of ticks) {
      const done = c.extra.buf.push(t);
      if (!done) continue;
      try {
        // `settledOpenMs` is the SAME gate REST output passes, applied here too
        // rather than trusted from the stream — so a venue that published a bar
        // early cannot put a forming candle in the store by this route either.
        this.deps.write(done.symbol, [done.candle], settledOpenMs(this.now()));
        c.extra.closedCandles++;
      } catch (e) {
        this.deps.log?.(`${this.deps.adapter.id}: could not store ${done.symbol} — ${(e as Error)?.message ?? "unknown"}`);
      }
    }
  }

  private addReadyWeex(
    ready: Map<string, Map<number, Candle>>,
    symbol: string,
    candle: Candle,
  ): void {
    let byOpen = ready.get(symbol);
    if (!byOpen) { byOpen = new Map(); ready.set(symbol, byOpen); }
    byOpen.set(candle.openMs, candle);
  }

  private deferWeex(symbol: string, candle: Candle): void {
    let byOpen = this.weexDeferred.get(symbol);
    if (!byOpen) { byOpen = new Map(); this.weexDeferred.set(symbol, byOpen); }
    if (byOpen.has(candle.openMs)) {
      byOpen.set(candle.openMs, candle);
      return;
    }
    if (byOpen.size >= MAX_WEEX_DEFERRED_PER_SYMBOL) {
      const newest = Math.max(...byOpen.keys());
      if (candle.openMs >= newest) return;
      byOpen.delete(newest);
    }
    byOpen.set(candle.openMs, candle);
  }

  private takeSettledWeexDeferred(
    notAfterMs: number,
    ready: Map<string, Map<number, Candle>>,
  ): void {
    for (const [symbol, byOpen] of this.weexDeferred) {
      for (const [openMs, candle] of byOpen) {
        if (openMs > notAfterMs) continue;
        this.addReadyWeex(ready, symbol, candle);
        byOpen.delete(openMs);
      }
      if (!byOpen.size) this.weexDeferred.delete(symbol);
    }
  }

  private writeWeexReady(ready: Map<string, Map<number, Candle>>, notAfterMs: number): void {
    for (const [symbol, byOpen] of ready) {
      const candles = [...byOpen.values()].sort((a, b) => a.openMs - b.openMs);
      if (!candles.length) continue;
      try {
        this.deps.write(symbol, candles, notAfterMs);
        const owner = this.pool.connections.find((c) => c.symbols.includes(symbol));
        if (owner) owner.extra.closedCandles += candles.length;
      } catch (e) {
        this.deps.log?.(`${this.deps.adapter.id}: could not store ${symbol} — ${(e as Error)?.message ?? "unknown"}`);
      }
    }
  }

  private flushWeexDeferred(): void {
    if (!this.pool.running || this.deps.adapter.id !== "weex" || !this.weexDeferred.size) return;
    const notAfterMs = settledOpenMs(this.now());
    const ready = new Map<string, Map<number, Candle>>();
    this.takeSettledWeexDeferred(notAfterMs, ready);
    this.writeWeexReady(ready, notAfterMs);
  }

  /** For the admin panel and the tests. */
  status(): { venue: string; sockets: number; open: number; symbols: number; closedCandles: number; holding: number } {
    const s = this.pool.status();
    return {
      venue: this.deps.adapter.id,
      sockets: s.sockets,
      open: s.open,
      symbols: s.symbols,
      closedCandles: this.pool.connections.reduce((n, c) => n + c.extra.closedCandles, 0),
      holding: this.pool.connections.reduce((n, c) => n + c.extra.buf.size(), 0)
        + [...this.weexDeferred.values()].reduce((n, rows) => n + rows.size, 0),
    };
  }
}
