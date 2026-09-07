// src/net/socket-pool.ts
// THE one reconnect/ping/chunk/backoff implementation this repo runs a
// websocket tail on. Extracted out of `candles/stream-runner.ts` when the
// liquidation feed (`src/liq/stream-runner.ts`) needed the exact same
// mechanics against a different wire protocol — chunking symbols at a venue's
// topic cap, jittered exponential reconnect, protocol ping/pong, and a
// resync that rebuilds only when the wanted symbol set actually changed.
//
// This module owns CONNECTIONS. It knows nothing about what a message MEANS —
// closing a candle, matching a liquidation print, anything else — that is the
// caller's `onMessage` callback. Two products (candles, liquidations) share
// this file and diverge entirely in what they do with a parsed frame.
//
// ── THE PROPERTY THAT MAKES THIS SAFE ───────────────────────────────────────
// A stream failure degrades to "no stream" for whatever it is feeding — never
// a crash, never a duplicate socket, never a message delivered after its
// connection was torn down. See `stream-runner.ts`'s original header for the
// candle-specific argument; the same shape applies to every consumer.
//
// ── RECONNECT IS BOUNDED AND JITTERED ──────────────────────────────────────
// Exponential backoff to a ceiling, with jitter, so one network blip does not
// reconnect every chunk of every venue on the same tick.
//
// ── A CONNECTION CANNOT OUTLIVE ITS OWN TEARDOWN ────────────────────────────
// `reopen()` and `handleMessage()` both refuse to act once the connection
// object is no longer in the pool's own roster — a real socket's `close()`
// fires asynchronously, so a torn-down connection (resync rebuilt the roster,
// or the pool stopped) can still deliver one more callback. Generalised past
// the original candle-only WEEX guard: any venue's late callback would
// otherwise resurrect an untracked socket or process a message nobody is
// counting.

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

/** The real one. Node >= 22 ships a global `WebSocket`. */
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

export interface PoolAdapter {
  readonly id: string;
  readonly url: string;
  /** Topics one connection may carry before the pool opens another. */
  readonly maxTopicsPerConnection: number;
  /** Subscribe frames for a batch of symbols, already within the cap. A
   *  single always-on stream (no per-symbol subscription) returns one frame
   *  for a `symbols() => ["*"]`-shaped caller, or `[]` when nothing to send. */
  subscribeFrames(symbols: readonly string[]): unknown[];
  /** Immediate protocol replies for an incoming frame (e.g. a JSON ping that
   *  needs a JSON pong). Most venues use websocket-level ping/pong instead. */
  replyFrames?(frame: string): unknown[];
  readonly pingIntervalMs?: number;
  readonly pingFrame?: string;
}

export interface PoolConn<C> {
  readonly index: number;
  readonly symbols: readonly string[];
  sock: StreamSocket | null;
  opened: boolean;
  /** Caller-owned per-connection state (a candle's ClosureBuffer, a
   *  liquidation source's nothing-at-all). The pool never reads it. */
  extra: C;
}

export interface SocketPoolDeps<C> {
  adapter: PoolAdapter;
  /** The symbols this pool should be streaming, read fresh on every resync so
   *  a new listing joins without a restart. */
  symbols: () => readonly string[];
  /** Build a fresh per-connection extra-state value for a new chunk. */
  makeExtra: () => C;
  /** Every incoming text frame, after protocol replies are sent and the
   *  connection has been proven still current. */
  onMessage: (conn: PoolConn<C>, data: string) => void;
  /** Called right before a connection's socket is discarded — on an ordinary
   *  reconnect AND on teardown (stop, or a resync rebuild) — so the caller can
   *  clear buffered per-connection state. A candle's held forming bar must
   *  never survive a reconnect; this is the one place that is true for. */
  onDiscard?: (conn: PoolConn<C>) => void;
  /** Called with the full incoming wanted-symbol set, BEFORE old connections
   *  are torn down on a resync — the seam for state keyed by symbol rather
   *  than by connection (a symbol removed from the roster must stop owning
   *  anything, even though which connection carried it is about to change). */
  onBeforeResync?: (wanted: ReadonlySet<string>) => void;
  log?: (msg: string) => void;
  socket?: SocketFactory;
  /** First reconnect delay; doubles per consecutive failure to the ceiling. */
  reconnectMs?: number;
  reconnectMaxMs?: number;
}

interface InternalConn<C> extends PoolConn<C> {
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  ping: ReturnType<typeof setInterval> | null;
}

const DEFAULT_RECONNECT_MS = 2_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;

export class SocketPool<C> {
  private conns: InternalConn<C>[] = [];
  private runningFlag = false;

  constructor(private readonly deps: SocketPoolDeps<C>) {}

  get running(): boolean { return this.runningFlag; }
  get connections(): readonly PoolConn<C>[] { return this.conns; }

  start(): void {
    this.runningFlag = true;
    this.resync();
  }

  stop(): void {
    this.runningFlag = false;
    for (const c of this.conns) this.teardown(c);
    this.conns = [];
  }

  /** Re-read the symbol set. A CHANGED set rebuilds every connection — venues
   *  have no unsubscribe-and-resubscribe primitive cheaper than a reconnect,
   *  and the set changes on a listing cadence rather than continuously. */
  resync(): void {
    if (!this.runningFlag) return;
    const want = [...new Set(this.deps.symbols())].filter(Boolean).sort();
    const have = this.conns.flatMap((c) => c.symbols).sort();
    if (this.conns.length && want.length === have.length && want.every((s, i) => s === have[i])) return;

    const wanted = new Set(want);
    this.deps.onBeforeResync?.(wanted);

    for (const c of this.conns) this.teardown(c);
    this.conns = [];
    const cap = Math.max(1, this.deps.adapter.maxTopicsPerConnection);
    for (let i = 0; i < want.length; i += cap) {
      const c: InternalConn<C> = {
        index: this.conns.length, symbols: want.slice(i, i + cap), sock: null,
        extra: this.deps.makeExtra(), attempts: 0, timer: null, ping: null, opened: false,
      };
      this.conns.push(c);
      this.open(c);
    }
    if (want.length) {
      this.deps.log?.(`${this.deps.adapter.id}: streaming ${want.length} symbol(s) over ${this.conns.length} socket(s)`);
    }
  }

  private open(c: InternalConn<C>): void {
    if (!this.runningFlag) return;
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
        onMessage: (data) => this.handleMessage(c, data),
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

  private handleMessage(c: InternalConn<C>, data: string): void {
    // A retired connection's socket can deliver one last callback after a
    // roster rebuild or stop. Reject it before it can act on stale state.
    if (!this.runningFlag || !this.conns.includes(c)) return;
    try {
      for (const reply of this.deps.adapter.replyFrames?.(data) ?? []) c.sock?.send(JSON.stringify(reply));
    } catch { /* a malformed heartbeat must not stop the tail */ }
    this.deps.onMessage(c, data);
  }

  private reopen(c: InternalConn<C>): void {
    if (!this.runningFlag || !this.conns.includes(c)) return;
    this.clearTimers(c);
    c.sock = null;
    c.attempts++;
    const base = this.deps.reconnectMs ?? DEFAULT_RECONNECT_MS;
    const ceiling = this.deps.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    const backoff = Math.min(ceiling, base * 2 ** Math.min(c.attempts - 1, 10));
    // JITTER — without it a single blip reconnects every chunk of every venue
    // on the same tick, a thundering herd of our own making.
    const wait = Math.round(backoff * (0.5 + Math.random() * 0.5));
    this.deps.onDiscard?.(c);
    c.timer = setTimeout(() => this.open(c), wait);
  }

  private clearTimers(c: InternalConn<C>): void {
    if (c.timer) { clearTimeout(c.timer); c.timer = null; }
    if (c.ping) { clearInterval(c.ping); c.ping = null; }
  }

  private teardown(c: InternalConn<C>): void {
    this.clearTimers(c);
    this.deps.onDiscard?.(c);
    try { c.sock?.close(); } catch { /* already gone */ }
    c.sock = null;
  }

  status(): { sockets: number; open: number; symbols: number } {
    return {
      sockets: this.conns.length,
      open: this.conns.filter((c) => c.opened).length,
      symbols: this.conns.reduce((n, c) => n + c.symbols.length, 0),
    };
  }
}
