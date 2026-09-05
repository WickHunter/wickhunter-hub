// src/candles/stream-runner.ts
// v0.2.17 — the connection half of the websocket tail.
//
// `stream.ts` owns the PROTOCOL: what a frame means and when a minute is
// closed. This file owns the SOCKETS: how many, which symbols on each, what
// happens when one drops, and getting closed candles into the store.
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
//
// ── RECONNECT IS BOUNDED AND JITTERED ──────────────────────────────────────
// Exponential backoff to a ceiling, with jitter. Without jitter, one network
// blip reconnects every chunk of every venue on the same tick — a thundering
// herd of our own making, which is the shape of thing a venue rate-limits for.

import { settledOpenMs, type Candle } from "./store.js";
import { ClosureBuffer, type StreamAdapter, type StreamTick } from "./stream.js";

/** The socket seam. Node's global `WebSocket` is one implementation; the tests
 *  drive another. Injected rather than imported so the reconnect and chunking
 *  logic can be tested without a network, which is the half most likely to be
 *  wrong and the half hardest to observe against a live venue. */
export interface StreamSocket {
  send(data: string): void;
  close(): void;
}

export interface StreamSocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number): void;
  onError(err: unknown): void;
}

export type SocketFactory = (url: string, h: StreamSocketHandlers) => StreamSocket;

/** The real one. Kept tiny and dependency-free — Node >= 22 has `WebSocket`. */
export const nodeSocketFactory: SocketFactory = (url, h) => {
  const ws = new WebSocket(url);
  ws.onopen = () => h.onOpen();
  ws.onmessage = (ev: MessageEvent) => { if (typeof ev.data === "string") h.onMessage(ev.data); };
  ws.onclose = (ev: CloseEvent) => h.onClose(ev?.code ?? 0);
  ws.onerror = (ev: Event) => h.onError(ev);
  return {
    send: (d) => { try { ws.send(d); } catch { /* a dead socket closes itself */ } },
    close: () => { try { ws.close(); } catch { /* already gone */ } },
  };
};

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

interface Conn {
  index: number;
  symbols: string[];
  sock: StreamSocket | null;
  buf: ClosureBuffer;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  ping: ReturnType<typeof setInterval> | null;
  opened: boolean;
  closedCandles: number;
}

const DEFAULT_RECONNECT_MS = 2_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const DEFAULT_SETTLE_FLUSH_MS = 1_000;
/** Normally one row: WEEX advances N while the store still admits only N-1.
 *  Three leaves bounded room for clock movement and duplicate snapshots while
 *  still refusing an unbounded remote-input queue. Oldest rows win because
 *  they become eligible first and preserve a contiguous tail. */
const MAX_WEEX_DEFERRED_PER_SYMBOL = 3;

export class VenueStreamRunner {
  private conns: Conn[] = [];
  private running = false;
  private readonly now: () => number;
  private settleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly weexDeferred = new Map<string, Map<number, Candle>>();

  constructor(private readonly deps: StreamRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Chunk the current symbol set and open a socket per chunk. Idempotent:
   *  calling it again re-chunks only if the symbol set actually changed, so a
   *  scheduler may call it as often as it likes. */
  start(): void {
    this.running = true;
    if (this.deps.adapter.id === "weex" && !this.settleTimer) {
      this.settleTimer = setInterval(
        () => this.flushWeexDeferred(),
        Math.max(1, this.deps.settleFlushMs ?? DEFAULT_SETTLE_FLUSH_MS),
      );
      this.settleTimer.unref();
    }
    this.resync();
  }

  stop(): void {
    this.running = false;
    if (this.settleTimer) { clearInterval(this.settleTimer); this.settleTimer = null; }
    for (const c of this.conns) this.teardown(c);
    this.conns = [];
    this.weexDeferred.clear();
  }

  /** Re-read the symbol set. A CHANGED set rebuilds every connection, which is
   *  blunt but correct: venues have no unsubscribe-and-resubscribe primitive
   *  that is cheaper than a reconnect, and the set changes on the collector's
   *  15-minute listing cadence rather than continuously. */
  resync(): void {
    if (!this.running) return;
    const want = [...new Set(this.deps.symbols())].filter(Boolean).sort();
    const have = this.conns.flatMap((c) => c.symbols).sort();
    if (this.conns.length && want.length === have.length && want.every((s, i) => s === have[i])) return;

    // A retained symbol keeps its already-complete deferred minute across a
    // reconnect/rechunk. A removed symbol cannot write after leaving the
    // authoritative roster.
    const wanted = new Set(want);
    for (const symbol of this.weexDeferred.keys()) {
      if (!wanted.has(symbol)) this.weexDeferred.delete(symbol);
    }

    for (const c of this.conns) this.teardown(c);
    this.conns = [];
    const cap = Math.max(1, this.deps.adapter.maxTopicsPerConnection);
    for (let i = 0; i < want.length; i += cap) {
      const c: Conn = {
        index: this.conns.length, symbols: want.slice(i, i + cap), sock: null,
        buf: new ClosureBuffer(), attempts: 0, timer: null, ping: null,
        opened: false, closedCandles: 0,
      };
      this.conns.push(c);
      this.open(c);
    }
    if (want.length) {
      this.deps.log?.(`${this.deps.adapter.id}: streaming ${want.length} symbol(s) over ${this.conns.length} socket(s)`);
    }
  }

  private open(c: Conn): void {
    if (!this.running) return;
    const a = this.deps.adapter;
    const factory = this.deps.socket ?? nodeSocketFactory;
    c.opened = false;
    try {
      c.sock = factory(a.url, {
        onOpen: () => {
          c.opened = true;
          c.attempts = 0;
          for (const f of a.subscribeFrames(c.symbols)) c.sock?.send(JSON.stringify(f));
          if (a.pingIntervalMs && a.pingFrame) {
            c.ping = setInterval(() => c.sock?.send(a.pingFrame!), a.pingIntervalMs);
          }
        },
        onMessage: (data) => this.ingest(c, data),
        onClose: () => this.reopen(c),
        // An error is not itself a close on every implementation, so the
        // reconnect hangs off `onClose` alone and this only records the reason.
        onError: (e) => this.deps.log?.(`${a.id}[${c.index}]: socket error — ${(e as Error)?.message ?? "unknown"}`),
      });
    } catch (e) {
      this.deps.log?.(`${a.id}[${c.index}]: could not open — ${(e as Error)?.message ?? "unknown"}`);
      this.reopen(c);
    }
  }

  private ingest(c: Conn, data: string): void {
    // Closing a retired socket can deliver one last callback after a roster
    // rebuild or stop. WEEX owns deferred state outside the connection, so it
    // must reject that callback before it can repopulate a removed symbol.
    if (this.deps.adapter.id === "weex" && (!this.running || !this.conns.includes(c))) return;
    // WEEX V3 uses an application-level JSON ping rather than websocket ping
    // frames. A heartbeat has no business entering the closure buffer.
    try {
      for (const reply of this.deps.adapter.replyFrames?.(data) ?? []) c.sock?.send(JSON.stringify(reply));
    } catch { /* malformed heartbeats degrade to REST, like malformed candles */ }
    let ticks: StreamTick[];
    // A parse that throws must never kill the socket: a venue adding a field is
    // not an outage, and the REST tail covers whatever this drops.
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
        const done = c.buf.push(t);
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
      const done = c.buf.push(t);
      if (!done) continue;
      try {
        // `settledOpenMs` is the SAME gate REST output passes, applied here too
        // rather than trusted from the stream — so a venue that published a bar
        // early cannot put a forming candle in the store by this route either.
        this.deps.write(done.symbol, [done.candle], settledOpenMs(this.now()));
        c.closedCandles++;
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
        const owner = this.conns.find((c) => c.symbols.includes(symbol));
        if (owner) owner.closedCandles += candles.length;
      } catch (e) {
        this.deps.log?.(`${this.deps.adapter.id}: could not store ${symbol} — ${(e as Error)?.message ?? "unknown"}`);
      }
    }
  }

  private flushWeexDeferred(): void {
    if (!this.running || this.deps.adapter.id !== "weex" || !this.weexDeferred.size) return;
    const notAfterMs = settledOpenMs(this.now());
    const ready = new Map<string, Map<number, Candle>>();
    this.takeSettledWeexDeferred(notAfterMs, ready);
    this.writeWeexReady(ready, notAfterMs);
  }

  private reopen(c: Conn): void {
    if (this.deps.adapter.id === "weex" && (!this.running || !this.conns.includes(c))) return;
    this.clearTimers(c);
    c.sock = null;
    if (!this.running) return;
    c.attempts++;
    const base = this.deps.reconnectMs ?? DEFAULT_RECONNECT_MS;
    const ceiling = this.deps.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    const backoff = Math.min(ceiling, base * 2 ** Math.min(c.attempts - 1, 10));
    // JITTER. Without it a single blip reconnects every chunk of every venue on
    // the same tick — a thundering herd of our own making, aimed at the venue
    // whose limits this whole release exists to stay under.
    const wait = Math.round(backoff * (0.5 + Math.random() * 0.5));
    // The forming bar this socket was holding is NOT carried across a
    // reconnect: after a gap the venue's next tick may be minutes later, and
    // publishing the held minute then would emit a bar built from a fraction of
    // its trades. Dropping it leaves a gap, which is the one thing this system
    // already knows how to repair.
    c.buf.clear();
    c.timer = setTimeout(() => this.open(c), wait);
  }

  private clearTimers(c: Conn): void {
    if (c.timer) { clearTimeout(c.timer); c.timer = null; }
    if (c.ping) { clearInterval(c.ping); c.ping = null; }
  }

  private teardown(c: Conn): void {
    this.clearTimers(c);
    try { c.sock?.close(); } catch { /* already gone */ }
    c.sock = null;
    c.buf.clear();
  }

  /** For the admin panel and the tests. */
  status(): { venue: string; sockets: number; open: number; symbols: number; closedCandles: number; holding: number } {
    return {
      venue: this.deps.adapter.id,
      sockets: this.conns.length,
      open: this.conns.filter((c) => c.opened).length,
      symbols: this.conns.reduce((n, c) => n + c.symbols.length, 0),
      closedCandles: this.conns.reduce((n, c) => n + c.closedCandles, 0),
      holding: this.conns.reduce((n, c) => n + c.buf.size(), 0)
        + [...this.weexDeferred.values()].reduce((n, rows) => n + rows.size, 0),
    };
  }
}
