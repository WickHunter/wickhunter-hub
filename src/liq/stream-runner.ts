// src/liq/stream-runner.ts
// Owns the live sockets for every liquidation source the bot itself listens
// to (`LIQ_SOURCE_IDS` in `sources.ts`). Connection mechanics — chunking,
// jittered reconnect/backoff, protocol ping — are `SocketPool`
// (`../net/socket-pool.js`), the SAME class the candle collector's websocket
// tail uses: there is exactly one reconnect implementation in this repo, not
// two written against two different wire protocols.
//
// ── SIX PHYSICAL CONNECTIONS COVER EIGHT SOURCES ────────────────────────────
// Bybit's `allLiquidation.{symbol}` is per-symbol and chunked at its topic
// cap, so USDT and USDC perps (both on the `linear` category, filtered by
// quote) and inverse perps (its own category and its own websocket host) are
// three separate rosters and three separate connection sets. Binance and OKX
// each publish an ALL-MARKET firehose on one socket: Binance's USDT-M and
// coin-M feeds are two dedicated single-stream endpoints
// (`!forceOrder@arr`), and OKX's one `liquidation-orders` channel carries
// every quote at once, split into `okx-usdt`/`okx-usdc`/`okx-inverse` by the
// normalizer reading each print's own instrument. `SocketPool` is used for
// all six the same way: a single-stream venue supplies a fixed one-token
// symbol list (`["ALL"]`) so the ordinary chunking loop opens exactly one
// connection and sends no subscribe topics per symbol.
//
// ── A SOURCE THAT IS DOWN IS A LOG LINE, NOT AN ALARM ───────────────────────
// `status()` reports connection state for the admin surface; nothing here
// throws, retries a write, or halts on one source's failure. A stream that
// dies and stays dead is just a source recording nothing until it reconnects
// — there is no downstream "silent halt" to protect against, because nothing
// downstream promises a source is live.
import {
  SocketPool, nodeSocketFactory,
  type SocketFactory,
} from "../net/socket-pool.js";
import {
  LIQ_SOURCES, LIQ_SOURCE_IDS, isLiqSourceId,
  normalizeBybitLiq, normalizeBinanceForce, normalizeOkxLiq,
  type LiqSourceId, type RawLiq,
} from "./sources.js";

export interface LiqFetchResponse { ok: boolean; status: number; json(): Promise<unknown>; }
export type LiqFetchLike = (url: string) => Promise<LiqFetchResponse>;

const realFetch: LiqFetchLike = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

export interface LiqStreamConfig {
  /** Which of the eight sources this process records. EMPTY MEANS NONE —
   *  this module never invents a fallback roster. "An unset env var means
   *  record everything" is a decision made exactly once, at `config.ts`'s
   *  `liqSourcesFromEnv`; a hand-built config (every test, most tools) that
   *  leaves this empty must open no sockets, the same rule `candleVenues: []`
   *  already keeps for the candle collector. */
  sources: readonly LiqSourceId[];
  bybitLinearUrl: string;
  bybitInverseUrl: string;
  bybitRestBase: string;
  binanceUsdtWsUrl: string;
  binanceCoinWsUrl: string;
  binanceDapiBase: string;
  okxWsUrl: string;
  okxRestBase: string;
  /** How often a symbol roster / ctVal table / contract-size table is
   *  re-fetched. A new listing must reach the socket without a restart. */
  rosterRefreshMs: number;
}

export const DEFAULT_LIQ_STREAM_CONFIG: LiqStreamConfig = {
  sources: LIQ_SOURCE_IDS,
  bybitLinearUrl: "wss://stream.bybit.com/v5/public/linear",
  bybitInverseUrl: "wss://stream.bybit.com/v5/public/inverse",
  bybitRestBase: "https://api.bybit.com",
  binanceUsdtWsUrl: "wss://fstream.binance.com/market/ws/!forceOrder@arr",
  binanceCoinWsUrl: "wss://dstream.binance.com/market/ws/!forceOrder@arr",
  binanceDapiBase: "https://dapi.binance.com",
  okxWsUrl: "wss://ws.okx.com:8443/ws/v5/public",
  okxRestBase: "https://www.okx.com",
  rosterRefreshMs: 6 * 3_600_000,
};

export interface LiqStreamDeps {
  /** Every normalized print, from whichever source produced it. */
  emit: (e: RawLiq) => void;
  fetchLike?: LiqFetchLike;
  socket?: SocketFactory;
  log?: (msg: string) => void;
  reconnectMs?: number;
  reconnectMaxMs?: number;
}

export interface LiqSourceStatus {
  id: LiqSourceId;
  label: string;
  group: string;
  state: "off" | "connecting" | "live";
  events: number;
  lastEventAt: number | null;
  note: string;
}

/** The connection LABEL each source's prints arrive on — several sources can
 *  share one physical socket (OKX's one channel serves three; a currently-
 *  unconfigured Binance side is simply absent). Read only by `status()`. */
const CONNECTION_OF: Record<LiqSourceId, string> = {
  "bybit-usdt": "bybit-usdt", "bybit-usdc": "bybit-usdc", "bybit-inverse": "bybit-inverse",
  "binance-usdt": "binance-usdt", "binance-inverse": "binance-inverse",
  "okx-usdt": "okx", "okx-usdc": "okx", "okx-inverse": "okx",
};

/** Retry-with-backoff-then-refresh-on-an-interval, the ONE shape every REST
 *  lookup here needs (a Bybit symbol roster, OKX's ctVal table, Binance's
 *  coin-M contract sizes) — extracted so there is one retry policy rather
 *  than three copies that could drift. Mirrors the bot's own OKX ctVal
 *  loader (`src/liq/hub.ts`): up to 10 attempts with doubling backoff capped
 *  at 60s, then wait for the next scheduled refresh. */
function startRetryableLoader<T>(opts: {
  label: string;
  load: () => Promise<T>;
  onLoaded: (v: T) => void;
  refreshMs: number;
  isStopped: () => boolean;
  log?: (msg: string) => void;
}): { stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const alive = () => !stopped && !opts.isStopped();

  async function attempt(): Promise<void> {
    for (let n = 0; alive(); n++) {
      try {
        const v = await opts.load();
        if (!alive()) return;
        opts.onLoaded(v);
        break;
      } catch (e) {
        if (!alive()) return;
        const wait = Math.min(60_000, 2_000 * 2 ** n);
        opts.log?.(`[liq] ${opts.label}: load failed (attempt ${n + 1}): ${(e as Error).message} — retrying in ${wait / 1000}s`);
        if (n >= 10) { opts.log?.(`[liq] ${opts.label}: giving up until the next refresh`); break; }
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (alive() && !timer) {
      timer = setInterval(() => { void attempt(); }, opts.refreshMs);
      timer.unref?.();
    }
  }

  void attempt();
  return { stop() { stopped = true; if (timer) { clearInterval(timer); timer = null; } } };
}

async function fetchBybitSymbols(
  fetchLike: LiqFetchLike, restBase: string, category: "linear" | "inverse", quote: "USDT" | "USDC" | null,
): Promise<string[]> {
  const out: string[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const url = `${restBase}/v5/market/instruments-info?category=${category}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetchLike(url);
    if (!res.ok) throw new Error(`bybit instruments-info ${res.status}`);
    const body = await res.json() as { result?: { list?: unknown[]; nextPageCursor?: string } };
    for (const raw of body?.result?.list ?? []) {
      const r = raw as { symbol?: unknown; quoteCoin?: unknown; status?: unknown; contractType?: unknown };
      if (typeof r.symbol !== "string") continue;
      if (quote && r.quoteCoin !== quote) continue;
      if (typeof r.contractType === "string" && !r.contractType.includes("Perpetual")) continue;
      if (r.status !== "Trading") continue;
      out.push(r.symbol);
    }
    cursor = typeof body?.result?.nextPageCursor === "string" ? body.result.nextPageCursor : "";
    if (!cursor) break;
  }
  return out;
}

async function fetchOkxCtVals(fetchLike: LiqFetchLike, restBase: string): Promise<Map<string, { ctVal: number; linear: boolean }>> {
  const res = await fetchLike(`${restBase}/api/v5/public/instruments?instType=SWAP`);
  if (!res.ok) throw new Error(`okx instruments ${res.status}`);
  const body = await res.json() as { data?: unknown[] };
  const out = new Map<string, { ctVal: number; linear: boolean }>();
  for (const raw of body?.data ?? []) {
    const i = raw as { instId?: unknown; ctVal?: unknown; ctType?: unknown };
    const instId = String(i?.instId ?? "");
    const ctVal = parseFloat(String(i?.ctVal ?? ""));
    if (instId && Number.isFinite(ctVal) && ctVal > 0) out.set(instId, { ctVal, linear: String(i?.ctType) !== "inverse" });
  }
  if (!out.size) throw new Error("okx instruments returned 0 usable rows");
  return out;
}

async function fetchBinanceContractSizes(fetchLike: LiqFetchLike, dapiBase: string): Promise<Map<string, number>> {
  const res = await fetchLike(`${dapiBase}/dapi/v1/exchangeInfo`);
  if (!res.ok) throw new Error(`binance dapi exchangeInfo ${res.status}`);
  const body = await res.json() as { symbols?: unknown[] };
  const out = new Map<string, number>();
  for (const raw of body?.symbols ?? []) {
    const s = raw as { symbol?: unknown; contractSize?: unknown };
    const sym = String(s?.symbol ?? "");
    const cs = Number(s?.contractSize ?? 0);
    if (sym && cs > 0) out.set(sym, cs);
  }
  return out;
}

export class LiqStreamRunner {
  private stopped = true;
  private readonly pools = new Map<string, SocketPool<Record<string, never>>>();
  private readonly loaders: Array<{ stop(): void }> = [];
  private readonly wanted: Set<LiqSourceId>;
  private readonly counts = new Map<LiqSourceId, { events: number; lastAt: number | null }>();
  private readonly notes = new Map<LiqSourceId, string>();
  private okxCtVals = new Map<string, { ctVal: number; linear: boolean }>();
  private binanceContractSizes = new Map<string, number>();
  private bybitRoster = new Map<"bybit-usdt" | "bybit-usdc" | "bybit-inverse", string[]>();

  constructor(private readonly cfg: LiqStreamConfig, private readonly deps: LiqStreamDeps) {
    // EMPTY MEANS OFF, deliberately — unlike the bot's own `LiqHub` (which
    // never goes "fully deaf" because it needs SOME liq signal to trade on),
    // this is a recording archive with no decision riding on it. An empty
    // roster must open no sockets, matching `candleVenues: []`'s meaning
    // everywhere else in this hub. "Absent env var means record everything"
    // is decided once, at `config.ts`'s `liqSourcesFromEnv` — not here.
    this.wanted = new Set(cfg.sources.filter(isLiqSourceId));
    for (const s of LIQ_SOURCE_IDS) this.counts.set(s, { events: 0, lastAt: null });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const fetchLike = this.deps.fetchLike ?? realFetch;

    if (this.wanted.has("bybit-usdt")) this.startBybit("bybit-usdt", this.cfg.bybitLinearUrl, "linear", "USDT", fetchLike);
    if (this.wanted.has("bybit-usdc")) this.startBybit("bybit-usdc", this.cfg.bybitLinearUrl, "linear", "USDC", fetchLike);
    if (this.wanted.has("bybit-inverse")) this.startBybit("bybit-inverse", this.cfg.bybitInverseUrl, "inverse", null, fetchLike);
    if (this.wanted.has("binance-usdt")) this.startBinanceUsdt();
    if (this.wanted.has("binance-inverse")) this.startBinanceCoin(fetchLike);
    if (this.wanted.has("okx-usdt") || this.wanted.has("okx-usdc") || this.wanted.has("okx-inverse")) this.startOkx(fetchLike);
  }

  stop(): void {
    this.stopped = true;
    for (const pool of this.pools.values()) pool.stop();
    this.pools.clear();
    for (const l of this.loaders) l.stop();
    this.loaders.length = 0;
  }

  private push(e: RawLiq | null): void {
    if (this.stopped || !e || !this.wanted.has(e.source)) return;
    const c = this.counts.get(e.source)!;
    c.events++; c.lastAt = e.ts;
    this.deps.emit(e);
  }

  // ── Bybit: allLiquidation.{symbol}, chunked per its documented topic cap ──
  private startBybit(
    id: "bybit-usdt" | "bybit-usdc" | "bybit-inverse", url: string,
    category: "linear" | "inverse", quote: "USDT" | "USDC" | null, fetchLike: LiqFetchLike,
  ): void {
    this.bybitRoster.set(id, []);
    const pool = new SocketPool<Record<string, never>>({
      adapter: {
        id, url, maxTopicsPerConnection: 500, // matches the candle bybit kline stream's documented cap
        pingIntervalMs: 20_000, pingFrame: JSON.stringify({ op: "ping" }),
        subscribeFrames: (symbols) => symbols.length
          ? [{ op: "subscribe", args: symbols.map((s) => `allLiquidation.${s}`) }]
          : [],
      },
      symbols: () => this.bybitRoster.get(id) ?? [],
      makeExtra: () => ({}),
      onMessage: (_c, data) => this.handleBybitMessage(id, data),
      log: this.deps.log, socket: this.deps.socket,
      reconnectMs: this.deps.reconnectMs, reconnectMaxMs: this.deps.reconnectMaxMs,
    });
    this.pools.set(id, pool);
    pool.start();
    this.loaders.push(startRetryableLoader({
      label: id,
      isStopped: () => this.stopped,
      refreshMs: this.cfg.rosterRefreshMs,
      load: () => fetchBybitSymbols(fetchLike, this.cfg.bybitRestBase, category, quote),
      onLoaded: (list) => {
        this.bybitRoster.set(id, list);
        this.notes.set(id, `${list.length} perp(s) subscribed`);
        pool.resync();
      },
      log: this.deps.log,
    }));
  }

  private handleBybitMessage(id: "bybit-usdt" | "bybit-usdc" | "bybit-inverse", data: string): void {
    let m: { topic?: unknown; data?: unknown; op?: unknown; success?: unknown; ret_msg?: unknown };
    try { m = JSON.parse(data); } catch { return; }
    // v0.4.21 — THE VENUE'S OWN ANSWER TO THE SUBSCRIBE IS RECORDED. A
    // refused `allLiquidation.*` subscription used to be an unread frame on
    // an open socket, so a source could sit at "LIVE · 0 prints" for ever
    // and look exactly like a quiet market. The ack (or the refusal, in the
    // venue's own words) rides the source's note on the admin card.
    if (m?.op === "subscribe") {
      const roster = this.bybitRoster.get(id) ?? [];
      if (m.success === false) {
        const why = String(m.ret_msg ?? "no reason given");
        this.notes.set(id, `${roster.length} perp(s) requested · subscribe REFUSED: ${why}`);
        this.deps.log?.(`[liq] ${id}: subscribe refused — ${why}`);
      } else if (m.success === true) {
        this.notes.set(id, `${roster.length} perp(s) subscribed · acknowledged`);
      }
      return;
    }
    const topic = String(m?.topic ?? "");
    if (!topic.startsWith("allLiquidation.") || !Array.isArray(m.data)) return;
    for (const row of m.data) this.push(normalizeBybitLiq(row, id));
  }

  // ── Binance: one dedicated all-market stream per product ─────────────────
  private startBinanceUsdt(): void {
    const pool = this.buildSingleStreamPool("binance-usdt", this.cfg.binanceUsdtWsUrl, undefined,
      (data) => this.push(normalizeBinanceForce(this.parseJson(data), "binance-usdt")));
    this.pools.set("binance-usdt", pool);
    pool.start();
  }

  private startBinanceCoin(fetchLike: LiqFetchLike): void {
    const pool = this.buildSingleStreamPool("binance-inverse", this.cfg.binanceCoinWsUrl, undefined,
      (data) => this.push(normalizeBinanceForce(this.parseJson(data), "binance-inverse", this.binanceContractSizes)));
    this.pools.set("binance-inverse", pool);
    pool.start();
    this.loaders.push(startRetryableLoader({
      label: "binance-inverse-contract-sizes",
      isStopped: () => this.stopped,
      refreshMs: this.cfg.rosterRefreshMs,
      load: () => fetchBinanceContractSizes(fetchLike, this.cfg.binanceDapiBase),
      onLoaded: (map) => { this.binanceContractSizes = map; },
      log: this.deps.log,
    }));
  }

  private parseJson(data: string): unknown {
    try { return JSON.parse(data); } catch { return null; }
  }

  // ── OKX: one channel, three sources split by the print's own quote ───────
  private startOkx(fetchLike: LiqFetchLike): void {
    const pool = new SocketPool<Record<string, never>>({
      adapter: {
        id: "okx", url: this.cfg.okxWsUrl, maxTopicsPerConnection: 1,
        // OKX requires a client-sent text ping to keep the socket open; it
        // answers plain-text "pong", handled below before JSON.parse.
        pingIntervalMs: 25_000, pingFrame: "ping",
        subscribeFrames: () => [{ op: "subscribe", args: [{ channel: "liquidation-orders", instType: "SWAP" }] }],
      },
      symbols: () => ["ALL"],
      makeExtra: () => ({}),
      onMessage: (_c, data) => this.handleOkxMessage(data),
      log: this.deps.log, socket: this.deps.socket,
      reconnectMs: this.deps.reconnectMs, reconnectMaxMs: this.deps.reconnectMaxMs,
    });
    this.pools.set("okx", pool);
    pool.start();
    this.loaders.push(startRetryableLoader({
      label: "okx-ctvals",
      isStopped: () => this.stopped,
      refreshMs: this.cfg.rosterRefreshMs,
      load: () => fetchOkxCtVals(fetchLike, this.cfg.okxRestBase),
      onLoaded: (map) => { this.okxCtVals = map; },
      log: this.deps.log,
    }));
  }

  private handleOkxMessage(data: string): void {
    if (data === "pong") return;
    let m: { event?: unknown; code?: unknown; msg?: unknown; arg?: { channel?: unknown } };
    try { m = JSON.parse(data); } catch { return; }
    if (m?.event === "error") { this.deps.log?.(`[liq] okx error frame: ${String(m?.code ?? "?")} ${String(m?.msg ?? "")}`); return; }
    if (m?.event === "subscribe") return;
    if (m?.arg?.channel === "liquidation-orders") for (const e of normalizeOkxLiq(m, this.okxCtVals)) this.push(e);
  }

  // ── shared single-always-on-stream connection builder ─────────────────────
  private buildSingleStreamPool(
    id: string, url: string, pingFrame: string | undefined, onMessage: (data: string) => void,
  ): SocketPool<Record<string, never>> {
    return new SocketPool<Record<string, never>>({
      adapter: {
        id, url, maxTopicsPerConnection: 1,
        // No JSON ping: Binance uses protocol ping/pong and Node's own
        // WebSocket answers it — an application-level frame here would be an
        // unrecognised incoming message on a venue that rate-limits those.
        ...(pingFrame ? { pingIntervalMs: 25_000, pingFrame } : {}),
        subscribeFrames: () => [], // the URL itself IS the one subscription
      },
      symbols: () => ["ALL"],
      makeExtra: () => ({}),
      onMessage: (_c, data) => onMessage(data),
      log: this.deps.log, socket: this.deps.socket,
      reconnectMs: this.deps.reconnectMs, reconnectMaxMs: this.deps.reconnectMaxMs,
    });
  }

  status(): LiqSourceStatus[] {
    return LIQ_SOURCES.map((s) => {
      const c = this.counts.get(s.id)!;
      const pool = this.pools.get(CONNECTION_OF[s.id]);
      const state: LiqSourceStatus["state"] = !pool ? "off"
        : pool.status().open > 0 ? "live"
        : "connecting";
      return {
        id: s.id, label: s.label, group: s.group,
        state, events: c.events, lastEventAt: c.lastAt,
        note: this.notes.get(s.id) ?? "",
      };
    });
  }
}

export { nodeSocketFactory };
export type { SocketFactory };
