// src/candles/venues.ts
// One adapter per venue: how to list its instruments, how to page its 1-minute
// klines, and — the part that decides whether a seed is safe — how to tell a
// CLOSED candle from the one still forming.
//
// ── THE FORMING BAR, PER VENUE ──────────────────────────────────────────────
// Measured against each venue's live API rather than assumed from its docs.
// The method: read the clock, fetch, and compare the newest returned openMs
// against floor(now/60000) — the minute currently in progress. If they are
// equal the venue handed us a bar that has not closed.
//
//   bitget  /api/v2/mix/market/candles          INCLUDES the forming bar.
//           probed at 1786410774782 (minute in progress 1786410720000);
//           newest row returned openMs 1786410720000 — the forming bar itself.
//   bitget  /api/v2/mix/market/history-candles   EXCLUDES it.
//           same probe second; newest row 1786410660000, the just-closed bar.
//           This adapter therefore reads history-candles, not candles.
//   bitunix /api/v1/futures/market/kline         EXCLUDES it.
//           probed at 1786410780905 (905 ms into minute 1786410780000);
//           newest row 1786410720000 — the minute that had just closed, not
//           the one that had just opened. Returns NEWEST-FIRST.
//   bybit   /v5/market/kline                     INCLUDES it (documented).
//           NOT PROVED HERE: Bybit's edge blocks this build environment by
//           region on every host tried (api.bybit.com, api.bytick.com,
//           api.bybit.nl, api-testnet.bybit.com all answer with a CloudFront
//           country block). So Bybit's framing is taken from its v5 docs and
//           pinned by a REPLAY TEST against a recorded-shape page that contains
//           a forming bar, rather than by a live probe. See the note below on
//           why that is nonetheless safe.
//   binance /fapi/v1/klines                      INCLUDES it (documented).
//           This is USD-M MAINNET only. The exchangeInfo census below admits
//           only USDT-quoted, USDT-margined PERPETUAL contracts; after Binance's
//           UM/CM market-data merge that filter is the product boundary rather
//           than an assumption based on which public host answered.
//   aster   /fapi/v1/klines                      INCLUDES it.
//           probed at 1787004960000+ with an explicit endTime on the forming
//           minute; the forming bar came back. Probed WITHOUT a range it is
//           usually there and occasionally not (the venue publishes the bar
//           once the minute has a trade in it), which is a second reason the
//           answer never rests on the venue's framing.
//
// ── WHY THE ANSWER DOES NOT DEPEND ON GETTING THAT TABLE RIGHT ──────────────
// Every adapter's output passes through `dropUnclosed` against the hub's own
// clock, and `CandleStore.write` refuses anything newer than the newest closed
// minute a second time on the way to disk. A venue that starts including a
// forming bar tomorrow, or one whose behaviour is mis-documented today, loses
// that bar at both gates. The per-venue knowledge above is what lets us page
// efficiently and know what to expect; it is NOT what makes the result correct.
//
// ── VOLUME: A TRAP WORTH THE PARAGRAPH ──────────────────────────────────────
// `volume` on the wire is BASE volume (contracts/coins), consistently, on every
// venue. Bitget's array carries base at index 5 and quote at index 6. Bitunix
// returns an OBJECT WHOSE TWO VOLUME FIELDS ARE NAMED THE WRONG WAY ROUND:
// measured on BTCUSDT, `quoteVol` was 16.0341 and `baseVol` 1026789.19294 at a
// price near 64,045 — 16.0341 x 64,045 = 1,026,792, so the field LABELLED
// `quoteVol` is the base volume and the one labelled `baseVol` is the quote
// turnover. Reading the field by its name would inflate volume by roughly the
// price of the coin — about 64,000x on BTC — and every seeded band derived from
// it would be wrong. Bitunix's adapter therefore reads `quoteVol` for volume,
// and that is not a typo. Aster's row is Binance-shaped: index 5 is base volume
// and index 7 is the quote turnover, both honestly named in its docs.
import type { Candle } from "./store.js";
import { MINUTE_MS, newestClosedOpenMs } from "./store.js";

export const VENUE_IDS = ["bybit", "bitunix", "bitget", "binance", "aster", "weex"] as const;
export type VenueId = (typeof VENUE_IDS)[number];

export function isVenueId(v: unknown): v is VenueId {
  return typeof v === "string" && (VENUE_IDS as readonly string[]).includes(v);
}

export interface VenueSymbol {
  /** VENUE-NATIVE spelling, exactly as that venue writes it. Never normalised:
   *  `1000PEPEUSDT` on Bitunix and `PEPEUSDT` on Bitget are different books and
   *  different prices, and a band from one is worthless on the other. */
  symbol: string;
  /** False for instruments the venue lists but is not trading yet (Bitunix
   *  publishes `PREVIEW` rows for announced listings) or has suspended. */
  tradable: boolean;
}

/** Minimal fetch surface, injectable so tests never touch the network.
 *  `headers` is OPTIONAL so every existing stub still satisfies the type; when a
 *  real response carries `Retry-After` we honour it, and when it does not (or
 *  the caller is a stub) the collector falls back to its own backoff. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  headers?: { get(name: string): string | null };
}>;

// ── RATE LIMITING ───────────────────────────────────────────────────────────
// A venue saying "slow down" is NOT the same failure as a venue saying "that
// symbol does not exist", and treating them alike is how a collector gets
// itself banned: it counts the refusal, retries at the same rate next tick, and
// spends its whole budget on rejections that never become candles. This error
// type is the difference, and the collector backs off on it instead of
// counting it toward FAILING.
export class RateLimitError extends Error {
  readonly rateLimited = true;
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
  }
}

export function isRateLimit(err: unknown): err is RateLimitError {
  return !!err && typeof err === "object" && (err as RateLimitError).rateLimited === true;
}

/** OBSERVED, not guessed. `bitunix code 10006: request too frequently` and a
 *  bare `HTTP 429` on the same venue are both from the operator's own collector
 *  log; Bybit's `retCode 10006` ("Too many visits") is its documented v5 code.
 *  The message regex is a SAFETY NET over those, not the primary test: a venue
 *  that invents a new code but still says "too frequent" is still telling us to
 *  slow down, and mistaking that for a hard error is the expensive direction. */
const RATE_LIMIT_CODES = new Set(["10006", "10018", "429", "40018", "-1003"]);
const RATE_LIMIT_TEXT = /too many|too frequent|frequently|rate.?limit|request limit|visit limit|exceed.*limit/i;

function rateLimited(code: unknown, msg: unknown): boolean {
  return RATE_LIMIT_CODES.has(String(code)) || RATE_LIMIT_TEXT.test(String(msg ?? ""));
}

export interface KlinePage {
  candles: Candle[];
  /** True when the venue answered but has no rows in the asked-for range. */
  empty: boolean;
  /** ── v0.2.19 — "SLOW DOWN", SAID BEFORE THE REFUSAL ──────────────────────
   *
   *  Set when the venue's OWN budget readout says we are near its ceiling.
   *  Binance and Aster publish one (`x-mbx-used-weight-1m`); flat-rate venues
   *  leave this undefined and are bit-for-bit unchanged.
   *
   *  RETURNED BESIDE THE PAGE RATHER THAN THROWN, and that is the whole point:
   *  the weight for this request is already spent, so throwing the candles away
   *  would be the exact failure the `RateLimitError` note above describes — a
   *  collector spending its budget on requests that never become candles. The
   *  collector treats it as a refusal for PACING and keeps the page. */
  slowDown?: RateLimitError;
}

export interface VenueAdapter {
  readonly id: VenueId;
  /** Rows per kline page this venue will actually honour. */
  readonly pageLimit: number;
  /** Optional larger current-market page. It may be used only for a cold seed
   *  or a tail whose first missing minute is still inside this recent window;
   *  older work must continue through fetchKlines without skipping time. */
  readonly recentPageLimit?: number;
  /** ── v0.2.15 — THIS VENUE'S OWN PUBLIC-REQUEST CEILING, PER IP ────────────
   *
   *  A venue fact, so it belongs beside `pageLimit` rather than in one global
   *  number the collector applies to all three. The hub ran every venue at a
   *  single 3.2 req/s: 32% of Bitunix's documented limit, 16% of Bitget's and
   *  2.7% of Bybit's — so the collector was budget-starved on the two venues
   *  that need it most, and the operator's tails stayed ~100 minutes behind
   *  because there was never enough budget to do better.
   *
   *  DELIBERATELY ABOUT HALF of each venue's documented figure, not all of it.
   *  These are the hub's OWN requests, made continuously and forever, and the
   *  collector's adaptive backoff is a recovery mechanism rather than a licence
   *  to sit on the limit. An operator who sets HUB_CANDLE_RPS overrides this
   *  for every venue — their number always wins, including a lower one. */
  readonly publicRequestsPerSecond: number;
  /** Human note for the admin panel. */
  readonly klineEndpoint: string;
  listSymbols(fetchLike: FetchLike): Promise<VenueSymbol[]>;
  /** One page of 1m klines covering [startMs, endMs]. Ordering is normalised
   *  to OLDEST-FIRST here so no caller has to care which way a venue sorts. */
  fetchKlines(fetchLike: FetchLike, symbol: string, startMs: number, endMs: number): Promise<KlinePage>;
  /** A venue's cheaper/larger newest-page endpoint. Ordering and range
   *  filtering follow fetchKlines, but the endpoint itself is not historical. */
  fetchRecentKlines?(fetchLike: FetchLike, symbol: string, startMs: number, endMs: number): Promise<KlinePage>;
}

/** THE closed-candle gate. Drops every bar that has not finished, whatever the
 *  venue chose to send, and every bar that is not on the minute grid. */
export function dropUnclosed(candles: readonly Candle[], now: number): Candle[] {
  const newest = newestClosedOpenMs(now);
  return candles.filter(
    (c) => Number.isFinite(c.openMs) && c.openMs > 0 && c.openMs % MINUTE_MS === 0 && c.openMs <= newest,
  );
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Build a candle, or null when any field failed to parse. A partially parsed
 *  candle is worse than a missing one: the missing one shows up as a gap. */
function candle(t: unknown, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown): Candle | null {
  const cand: Candle = {
    openMs: num(t), open: num(o), high: num(h), low: num(l), close: num(c), volume: num(v),
  };
  for (const k of ["openMs", "open", "high", "low", "close", "volume"] as const) {
    if (!Number.isFinite(cand[k])) return null;
  }
  return cand;
}

/** `Retry-After` is seconds or an HTTP date. Anything unparseable returns
 *  undefined so the collector uses its own backoff rather than a bogus number. */
function retryAfterMs(res: { headers?: { get(name: string): string | null } }): number | undefined {
  const raw = res.headers?.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** THE http-status refusal rule, in ONE place because two venue readers now
 *  need it. 429 is the standard refusal; 418 is what several exchanges escalate
 *  to when a client keeps pushing after 429s, and it is the last warning before
 *  an IP ban. Both mean stop, not fail. */
function httpRefusal(res: { status: number; headers?: { get(name: string): string | null } }): RateLimitError | null {
  if (res.status === 429 || res.status === 418) {
    return new RateLimitError(`HTTP ${res.status} (rate limited)`, retryAfterMs(res));
  }
  return null;
}

async function getJson(fetchLike: FetchLike, url: string): Promise<unknown> {
  const res = await fetchLike(url);
  const refused = httpRefusal(res);
  if (refused) throw refused;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function sortOldestFirst(candles: Candle[]): Candle[] {
  return candles.sort((a, b) => a.openMs - b.openMs);
}

// ── BYBIT ───────────────────────────────────────────────────────────────────
// v5 linear perpetuals. Kline rows are ["startMs","o","h","l","c","volume",
// "turnover"], NEWEST-FIRST, and the first row is the FORMING bar.
// `dropUnclosed` removes it; the replay test in tests/candles.test.mjs pins
// that, because this environment cannot reach Bybit to prove it live.
const bybit: VenueAdapter = {
  id: "bybit",
  pageLimit: 1000,
  // 600 requests / 5s per IP, shared public+private. The hub reads PUBLIC only
  // and is the sole consumer here, but 15/s is 12.5% of that — deliberately far
  // below, because this venue's budget is the one an operator's own bots also
  // draw on when their install talks to Bybit directly.
  publicRequestsPerSecond: 15,
  klineEndpoint: "GET /v5/market/kline (category=linear, interval=1)",
  async listSymbols(fetchLike) {
    const out: VenueSymbol[] = [];
    let cursor = "";
    // Cursor-paged; bounded so a venue that never stops handing back cursors
    // cannot spin the collector forever.
    for (let page = 0; page < 20; page++) {
      const url = `https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = (await getJson(fetchLike, url)) as { result?: { list?: unknown[]; nextPageCursor?: string } };
      for (const raw of asArray(body.result?.list)) {
        const r = raw as { symbol?: unknown; quoteCoin?: unknown; status?: unknown; contractType?: unknown };
        if (typeof r.symbol !== "string") continue;
        if (r.quoteCoin !== "USDT") continue;
        if (typeof r.contractType === "string" && !r.contractType.includes("Perpetual")) continue;
        out.push({ symbol: r.symbol, tradable: r.status === "Trading" });
      }
      cursor = typeof body.result?.nextPageCursor === "string" ? body.result.nextPageCursor : "";
      if (!cursor) break;
    }
    return out;
  },
  async fetchKlines(fetchLike, symbol, startMs, endMs) {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=1&start=${startMs}&end=${endMs}&limit=${this.pageLimit}`;
    const body = (await getJson(fetchLike, url)) as { retCode?: unknown; retMsg?: unknown; result?: { list?: unknown[] } };
    if (body.retCode !== undefined && body.retCode !== 0) {
      const text = `bybit retCode ${String(body.retCode)}: ${String(body.retMsg ?? "")}`;
      throw rateLimited(body.retCode, body.retMsg) ? new RateLimitError(text) : new Error(text);
    }
    const list = asArray(body.result?.list);
    const candles: Candle[] = [];
    for (const raw of list) {
      const r = raw as unknown[];
      if (!Array.isArray(r) || r.length < 6) continue;
      const c = candle(r[0], r[1], r[2], r[3], r[4], r[5]);
      if (c) candles.push(c);
    }
    return { candles: sortOldestFirst(candles), empty: list.length === 0 };
  },
};

// ── BITUNIX ─────────────────────────────────────────────────────────────────
// Kline rows are OBJECTS, NEWEST-FIRST, and exclude the forming bar (probed).
// `limit` is capped at 200 server-side however much you ask for (probed: a
// request for 1000 returned exactly 200), so the collector must page.
const bitunix: VenueAdapter = {
  id: "bitunix",
  pageLimit: 200,
  // Documented 10 req/sec/ip for market data. Half of it.
  publicRequestsPerSecond: 5,
  klineEndpoint: "GET /api/v1/futures/market/kline (interval=1m)",
  async listSymbols(fetchLike) {
    const body = (await getJson(fetchLike, "https://fapi.bitunix.com/api/v1/futures/market/trading_pairs")) as { data?: unknown[] };
    const out: VenueSymbol[] = [];
    for (const raw of asArray(body.data)) {
      const r = raw as { symbol?: unknown; symbolStatus?: unknown };
      if (typeof r.symbol !== "string") continue;
      // OPEN = trading. PREVIEW = announced, not yet trading — listed by the
      // venue but with no candles behind it, so it is tracked and shown, never
      // polled as though it had history.
      out.push({ symbol: r.symbol, tradable: r.symbolStatus === "OPEN" });
    }
    return out;
  },
  async fetchKlines(fetchLike, symbol, startMs, endMs) {
    const url = `https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=${this.pageLimit}`;
    const body = (await getJson(fetchLike, url)) as { code?: unknown; msg?: unknown; data?: unknown[] };
    if (body.code !== undefined && Number(body.code) !== 0) {
      const text = `bitunix code ${String(body.code)}: ${String(body.msg ?? "")}`;
      throw rateLimited(body.code, body.msg) ? new RateLimitError(text) : new Error(text);
    }
    const list = asArray(body.data);
    const candles: Candle[] = [];
    for (const raw of list) {
      const r = raw as Record<string, unknown>;
      // `quoteVol` IS the base volume on this venue — see the header note. Do
      // not "fix" this to `baseVol`; that field is the USDT turnover.
      const c = candle(r.time, r.open, r.high, r.low, r.close, r.quoteVol);
      if (c) candles.push(c);
    }
    return { candles: sortOldestFirst(candles), empty: list.length === 0 };
  },
};

// ── BITGET ──────────────────────────────────────────────────────────────────
// Two kline endpoints with DIFFERENT framing (both probed). `/candles` returns
// the forming bar; `/history-candles` does not. We read history-candles.
// `limit` above 200 is rejected outright (probed: limit=1000 -> code 40053).
const bitget: VenueAdapter = {
  id: "bitget",
  pageLimit: 200,
  // Documented 20 times/1s per IP for market data. Half of it.
  publicRequestsPerSecond: 10,
  klineEndpoint: "GET /api/v2/mix/market/history-candles (granularity=1m)",
  async listSymbols(fetchLike) {
    const body = (await getJson(fetchLike, "https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures")) as { data?: unknown[] };
    const out: VenueSymbol[] = [];
    for (const raw of asArray(body.data)) {
      const r = raw as { symbol?: unknown; symbolStatus?: unknown };
      if (typeof r.symbol !== "string") continue;
      out.push({ symbol: r.symbol, tradable: r.symbolStatus === "normal" });
    }
    return out;
  },
  async fetchKlines(fetchLike, symbol, startMs, endMs) {
    const url = `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${encodeURIComponent(symbol)}&productType=usdt-futures&granularity=1m&startTime=${startMs}&endTime=${endMs}&limit=${this.pageLimit}`;
    const body = (await getJson(fetchLike, url)) as { code?: unknown; msg?: unknown; data?: unknown[] };
    if (body.code !== undefined && String(body.code) !== "00000") {
      const text = `bitget code ${String(body.code)}: ${String(body.msg ?? "")}`;
      throw rateLimited(body.code, body.msg) ? new RateLimitError(text) : new Error(text);
    }
    const list = asArray(body.data);
    const candles: Candle[] = [];
    for (const raw of list) {
      const r = raw as unknown[];
      if (!Array.isArray(r) || r.length < 6) continue;
      // [ts, open, high, low, close, baseVol, quoteVol] — index 5 is base.
      const c = candle(r[0], r[1], r[2], r[3], r[4], r[5]);
      if (c) candles.push(c);
    }
    return { candles: sortOldestFirst(candles), empty: list.length === 0 };
  },
};

// ── BINANCE USD-M ──────────────────────────────────────────────────────────
// Public MAINNET market data only. Binance's post-migration public endpoints
// may expose both USD-M and COIN-M products, so the host name is not the
// provenance boundary: exchangeInfo must say quoteAsset=USDT,
// marginAsset=USDT and contractType=PERPETUAL before a symbol is tracked.
// That exact native spelling becomes both the store directory and the signed
// seed symbol. There is no aliasing and no second-venue fallback.
const BINANCE_BASE = "https://fapi.binance.com";
const BINANCE_PAGE_LIMIT = 1000;

/** Published IP request-weight ceiling from USD-M exchangeInfo. */
export const BINANCE_REQUEST_WEIGHT_PER_MINUTE = 2400;
/** Response header carrying this IP's current one-minute weight spend. */
export const BINANCE_WEIGHT_HEADER = "x-mbx-used-weight-1m";
export const BINANCE_WEIGHT_SHARE = 0.5;
export const BINANCE_WEIGHT_ALARM_SHARE = 0.8;

/** Binance's documented kline weight schedule. */
export function binanceKlineWeight(limit: number): number {
  if (!Number.isFinite(limit) || limit < 100) return 1;
  if (limit < 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}

/** Convert Binance's weight/minute budget into this collector's request rate. */
export function binancePacedRps(pageLimit: number, share = BINANCE_WEIGHT_SHARE): number {
  return (BINANCE_REQUEST_WEIGHT_PER_MINUTE * share) / binanceKlineWeight(pageLimit) / 60;
}

function binanceWeightPressure(res: { headers?: { get(name: string): string | null } }): RateLimitError | undefined {
  const used = Number(res.headers?.get(BINANCE_WEIGHT_HEADER));
  if (!Number.isFinite(used) || used <= 0) return undefined;
  const alarm = BINANCE_REQUEST_WEIGHT_PER_MINUTE * BINANCE_WEIGHT_ALARM_SHARE;
  if (used < alarm) return undefined;
  return new RateLimitError(
    `binance reports ${used} of its published ${BINANCE_REQUEST_WEIGHT_PER_MINUTE}/min request-weight budget spent on this IP ` +
    `(over ${Math.round(BINANCE_WEIGHT_ALARM_SHARE * 100)}%) — backing off before it refuses`,
  );
}

async function binanceGet(fetchLike: FetchLike, url: string): Promise<{ body: unknown; slowDown?: RateLimitError }> {
  const res = await fetchLike(url);
  const refused = httpRefusal(res);
  if (refused) throw refused;
  let body: unknown;
  try { body = await res.json(); }
  catch { throw new Error(`HTTP ${res.status}: Binance returned unreadable JSON`); }
  const error = body && typeof body === "object" && !Array.isArray(body)
    ? body as { code?: unknown; msg?: unknown }
    : null;
  if (!res.ok || (error?.code !== undefined && Number(error.code) !== 0)) {
    const detail = error?.code !== undefined
      ? `binance code ${String(error.code)}: ${String(error.msg ?? "")}`
      : `HTTP ${res.status}`;
    throw rateLimited(error?.code, error?.msg) ? new RateLimitError(detail) : new Error(detail);
  }
  const slowDown = binanceWeightPressure(res);
  return { body, ...(slowDown ? { slowDown } : {}) };
}

const binance: VenueAdapter = {
  id: "binance",
  pageLimit: BINANCE_PAGE_LIMIT,
  // 1000 rows cost weight 5. Four requests/second spends 1200 weight/minute:
  // exactly half of the published 2400/minute IP ceiling. The 1500-row maximum
  // costs weight 10 and is worse value, so it is deliberately not used.
  publicRequestsPerSecond: binancePacedRps(BINANCE_PAGE_LIMIT),
  klineEndpoint: "GET /fapi/v1/klines (USD-M USDT perpetual, interval=1m, limit=1000, weight 5)",
  async listSymbols(fetchLike) {
    const { body } = await binanceGet(fetchLike, `${BINANCE_BASE}/fapi/v1/exchangeInfo`);
    const out: VenueSymbol[] = [];
    for (const raw of asArray((body as { symbols?: unknown[] }).symbols)) {
      const r = raw as {
        symbol?: unknown; quoteAsset?: unknown; marginAsset?: unknown;
        contractType?: unknown; status?: unknown;
      };
      if (typeof r.symbol !== "string") continue;
      if (r.quoteAsset !== "USDT" || r.marginAsset !== "USDT" || r.contractType !== "PERPETUAL") continue;
      out.push({ symbol: r.symbol, tradable: r.status === "TRADING" });
    }
    if (!out.length) throw new Error("binance exchangeInfo contained no USD-M USDT perpetual instruments");
    return out;
  },
  async fetchKlines(fetchLike, symbol, startMs, endMs) {
    // The collector speaks in inclusive OPEN times. Widening endTime to the
    // final millisecond of the requested minute cannot reach the next bar, and
    // keeps a one-minute final backfill window valid on Binance-shaped APIs.
    const url = `${BINANCE_BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m`
      + `&startTime=${startMs}&endTime=${endMs + MINUTE_MS - 1}&limit=${this.pageLimit}`;
    const { body, slowDown } = await binanceGet(fetchLike, url);
    const list = asArray(body);
    const candles: Candle[] = [];
    for (const raw of list) {
      const r = raw as unknown[];
      if (!Array.isArray(r) || r.length < 6) continue;
      // [openMs, o, h, l, c, BASE volume, closeMs, quote turnover, ...]
      const c = candle(r[0], r[1], r[2], r[3], r[4], r[5]);
      if (c) candles.push(c);
    }
    return { candles: sortOldestFirst(candles), empty: list.length === 0, ...(slowDown ? { slowDown } : {}) };
  },
};

// ── ASTER ───────────────────────────────────────────────────────────────────
// A Binance USD-M clone: the same `/fapi/v1` routes, the same array-shaped
// kline rows, the same weight-based rate limiting and the same `x-mbx-*`
// headers. MAINNET ONLY. There is a testnet base and it is deliberately not
// wired, not even as a fallback: testnet candles are a fiction, and a hub that
// quietly served them would be serving prices that verify against nothing.
//
// ── THE LIMIT IS WEIGHT PER MINUTE, NOT REQUESTS PER SECOND ─────────────────
// The other three venues publish a flat request rate. Aster does not, and
// pacing it as though it did would be a guess in the one direction that gets
// the hub IP-banned. Its ceiling is REQUEST_WEIGHT 2400 per minute per IP —
// which the venue states TWICE, in its docs and in the `rateLimits` array of
// its own /fapi/v1/exchangeInfo — and each kline request costs a weight that
// depends on the `limit` asked for:
//
//     LIMIT      weight       rows/weight
//     [1,100)      1              < 100
//     [100,500)    2              < 250
//     [500,1000]   5             up to 200      <- this adapter
//     >1000       10             up to 150
//
// MEASURED against the live venue, not merely read: three identical requests at
// each of limit=99/100/499/500/1000/1500 moved `x-mbx-used-weight-1m` by
// 1/2/2/5/5/10 respectively. `limit=1501` is refused (-1130), so 1500 is the
// documented and actual maximum.
//
// ── WHY THE PAGE IS 1000 AND NOT THE MAXIMUM 1500 ───────────────────────────
// 1000 rows for 5 weight is 200 rows per weight unit; 1500 rows for 10 weight
// is 150. The biggest page this venue allows is 25% WORSE VALUE than the one
// below it, so the obvious "ask for the maximum" would cost a third more budget
// for the same history. This is the same shape as the trap the bot repo's
// v0.78.0 review found on Bitunix/Bitget — the intuitive page-size choice being
// the wrong one — and the reason the arithmetic is written down here.
const ASTER_BASE = "https://fapi.asterdex.com";
const ASTER_PAGE_LIMIT = 1000;

/** The venue's published REQUEST_WEIGHT ceiling, per IP, per minute. */
export const ASTER_REQUEST_WEIGHT_PER_MINUTE = 2400;
/** Response header carrying THIS IP's weight spend inside the current minute. */
export const ASTER_WEIGHT_HEADER = "x-mbx-used-weight-1m";
/** The share of that budget the collector paces itself to — half, matching the
 *  convention the other three venues already use for their own limits. */
export const ASTER_WEIGHT_SHARE = 0.5;
/** The share at which the venue's own readout makes us back off anyway. Above
 *  our steady state by a wide margin, so this only fires when something ELSE is
 *  spending this IP's Aster budget (an operator's own bot on the same box, or
 *  an operator who raised HUB_CANDLE_RPS past what the venue allows). Aster
 *  bans repeat offenders for 2 minutes to 3 days, and an IP ban on the hub
 *  takes history away from every install at once. */
export const ASTER_WEIGHT_ALARM_SHARE = 0.8;

/** The documented weight of one /fapi/v1/klines request at a given `limit`.
 *  Exported because the rate this adapter runs at is DERIVED from it, and a
 *  test that cannot see the arithmetic can only re-assert the answer. */
export function asterKlineWeight(limit: number): number {
  if (!Number.isFinite(limit) || limit < 100) return 1;
  if (limit < 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}

/** Requests per second that spend `share` of the weight budget, at a page of
 *  `pageLimit` rows. This is the ONE conversion between the venue's units and
 *  the collector's; there is no second copy of these numbers to drift. */
export function asterPacedRps(pageLimit: number, share = ASTER_WEIGHT_SHARE): number {
  const perRequest = asterKlineWeight(pageLimit);
  return (ASTER_REQUEST_WEIGHT_PER_MINUTE * share) / perRequest / 60;
}

/** The venue's own budget readout, turned into a refusal when it crosses the
 *  alarm share. Undefined when the header is absent or unparseable — a missing
 *  header must never be read as "budget exhausted", which would silence a
 *  perfectly healthy collector. */
function asterWeightPressure(res: { headers?: { get(name: string): string | null } }): RateLimitError | undefined {
  const used = Number(res.headers?.get(ASTER_WEIGHT_HEADER));
  if (!Number.isFinite(used) || used <= 0) return undefined;
  const alarm = ASTER_REQUEST_WEIGHT_PER_MINUTE * ASTER_WEIGHT_ALARM_SHARE;
  if (used < alarm) return undefined;
  return new RateLimitError(
    `aster reports ${used} of its published ${ASTER_REQUEST_WEIGHT_PER_MINUTE}/min request-weight budget spent on this IP ` +
    `(over ${Math.round(ASTER_WEIGHT_ALARM_SHARE * 100)}%) — backing off before it refuses`,
  );
}

/** Read one Aster route. Unlike the other three, this venue answers a bad
 *  request with a 4xx AND a `{code,msg}` body, so its own words are one parse
 *  away — and "HTTP 400" on a collector card tells an operator nothing. */
async function asterGet(fetchLike: FetchLike, url: string): Promise<{ body: unknown; slowDown?: RateLimitError }> {
  const res = await fetchLike(url);
  const refused = httpRefusal(res);
  if (refused) throw refused;
  if (!res.ok) {
    let detail = "";
    try {
      const b = (await res.json()) as { code?: unknown; msg?: unknown };
      if (b && typeof b === "object" && b.code !== undefined) {
        detail = ` — aster code ${String(b.code)}: ${String(b.msg ?? "")}`;
      }
    } catch { /* not JSON; the status is all we have, which is what the others report */ }
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  return { body: await res.json(), slowDown: asterWeightPressure(res) };
}

const aster: VenueAdapter = {
  id: "aster",
  pageLimit: ASTER_PAGE_LIMIT,
  // 4/s: 2400 weight/min x 0.5, at 5 weight a page, over 60 seconds. Derived,
  // never typed in — see asterPacedRps. That is 240 pages a minute, so a
  // ~530-pair roster warms 30 days of 1m history in roughly an hour and a half
  // of paging while sitting on HALF of what the venue allows.
  publicRequestsPerSecond: asterPacedRps(ASTER_PAGE_LIMIT),
  klineEndpoint: "GET /fapi/v1/klines (interval=1m, limit=1000, weight 5)",
  async listSymbols(fetchLike) {
    // ~750 KB every symbolRefreshMs, for weight 1. The weight-pressure signal
    // this answer carries is deliberately IGNORED: one request per quarter hour
    // cannot be what overruns a 2400/min budget, the guard belongs on the path
    // that does the spending, and the very next kline request reads the same
    // header. Guarding here would mean throwing away a good instrument list.
    const { body } = await asterGet(fetchLike, `${ASTER_BASE}/fapi/v1/exchangeInfo`);
    const out: VenueSymbol[] = [];
    for (const raw of asArray((body as { symbols?: unknown[] }).symbols)) {
      const r = raw as { symbol?: unknown; quoteAsset?: unknown; contractType?: unknown; status?: unknown };
      if (typeof r.symbol !== "string") continue;
      if (r.quoteAsset !== "USDT") continue;
      // PERPETUAL, strictly. A `PENDING_TRADING` row on this venue carries an
      // EMPTY contractType — the venue has not said what the instrument is yet
      // — so an announced-but-unlaunched listing is not tracked until it has
      // one. It has no history to collect either way, and admitting an untyped
      // row would silently admit a dated future the day one is listed.
      if (r.contractType !== "PERPETUAL") continue;
      // SETTLING pairs stay tracked and stop being polled, exactly like a
      // delisting elsewhere: the candles that already happened stay true.
      out.push({ symbol: r.symbol, tradable: r.status === "TRADING" });
    }
    return out;
  },
  async fetchKlines(fetchLike, symbol, startMs, endMs) {
    // ── endTime + 59,999 ms, AND IT IS NOT A ROUNDING FUDGE ─────────────────
    // The collector's window is a pair of OPEN TIMES, inclusive at both ends.
    // Aster refuses `startTime === endTime` outright — measured: HTTP 400,
    // `-1023 "Start time is greater than end time."` — so a one-minute window
    // is an error on this venue and only on this venue. The collector CAN
    // produce one: backfill's last step is `[max(horizon, endMs - pageSpan),
    // digFrom - 60000]`, and those collapse to a single minute the pass that
    // lands on the retention horizon.
    //
    // Widening the end to the last millisecond of that same minute cannot
    // reach the next minute's open time, so every other window means exactly
    // what it did before (verified live: a two-minute range returns both ends,
    // a widened one-minute range returns exactly one row). This is the v0.2.6
    // Bitget incident — odd-shaped ranges answered with HTTP 400, 298 failures
    // in a row — headed off instead of repeated.
    const url = `${ASTER_BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m`
      + `&startTime=${startMs}&endTime=${endMs + MINUTE_MS - 1}&limit=${this.pageLimit}`;
    const { body, slowDown } = await asterGet(fetchLike, url);
    const list = asArray(body);
    const candles: Candle[] = [];
    for (const raw of list) {
      const r = raw as unknown[];
      if (!Array.isArray(r) || r.length < 6) continue;
      // [openMs, o, h, l, c, baseVolume, closeMs, quoteVolume, trades, ...]
      // Index 5 is BASE volume, honestly named in this venue's docs — index 7
      // is the quote turnover, and picking it would inflate volume by roughly
      // the price of the coin. Same trap as Bitget's index 6, no name to warn
      // you, so the index is the thing to check.
      const c = candle(r[0], r[1], r[2], r[3], r[4], r[5]);
      if (c) candles.push(c);
    }
    // Rows arrive oldest-first already; sorted anyway so no caller depends on
    // this venue continuing to do that.
    return { candles: sortOldestFirst(candles), empty: list.length === 0, ...(slowDown ? { slowDown } : {}) };
  },
};

// ── WEEX ──────────────────────────────────────────────────────────────────
// Mainnet USDT linear perpetuals only.  `apiTradingSymbols` is a separate
// public eligibility list; exchangeInfo alone contains instruments that are
// absent from the API-tradeable book, so both facts are required before the Hub
// collects or signs a candle under a WEEX venue name.
//
// HistoryKlines permits at most 100 rows and costs weight 5; current klines
// permit 1000 rows at weight 1. Older ranges retain bounded historical pages.
// Pacing still budgets the worst-case history cost at half of the 50/min lane:
// 25 / 5 / 60 = 1/12 request per second. The optional V3 candle stream owns
// the fresh tail; this REST adapter remains the source for gaps and backfill.
const WEEX_BASE = "https://api-contract.weex.com";
export const WEEX_HISTORY_KLINE_WEIGHT = 5;
export const WEEX_PUBLIC_WEIGHT_PER_MINUTE = 50;
export const WEEX_WEIGHT_SHARE = 0.5;
export const WEEX_PAGE_LIMIT = 100;
export const WEEX_RECENT_PAGE_LIMIT = 1000;
export const WEEX_RECENT_KLINE_WEIGHT = 1;

export function weexPacedRps(pageLimit = WEEX_PAGE_LIMIT, share = WEEX_WEIGHT_SHARE): number {
  if (!Number.isFinite(pageLimit) || pageLimit < 1 || pageLimit > WEEX_PAGE_LIMIT) {
    throw new Error(`WEEX history kline page limit must be 1..${WEEX_PAGE_LIMIT}`);
  }
  return (WEEX_PUBLIC_WEIGHT_PER_MINUTE * share) / WEEX_HISTORY_KLINE_WEIGHT / 60;
}

function weexRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  return asArray(row.data ?? row.symbols ?? row.list ?? row.rows);
}

/** WEEX public candles document numeric fields as JSON numbers or decimal
 * strings. Do not let JavaScript turn booleans, arrays, or blanks into prices. */
function weexWireNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function weexCandle(t: unknown, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown): Candle | null {
  const values = [t, o, h, l, c, v].map(weexWireNumber);
  if (values.some((value) => value === null)) return null;
  const [openMs, open, high, low, close, volume] = values as number[];
  return { openMs, open, high, low, close, volume };
}

function weexKlinePage(body: unknown, startMs: number, endMs: number): KlinePage {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const row = body as { code?: unknown; msg?: unknown };
    if (row.code !== undefined && String(row.code) !== "0" && String(row.code) !== "00000") {
      const detail = `weex code ${String(row.code)}: ${String(row.msg ?? "")}`;
      throw rateLimited(row.code, row.msg) ? new RateLimitError(detail) : new Error(detail);
    }
  }
  const list = weexRows(body);
  const candles: Candle[] = [];
  for (const raw of list) {
    if (!Array.isArray(raw) || raw.length < 6) continue;
    // [openMs, o, h, l, c, baseVolume, closeMs, quoteVolume, ...].
    const parsed = weexCandle(raw[0], raw[1], raw[2], raw[3], raw[4], raw[5]);
    if (parsed && parsed.openMs >= startMs && parsed.openMs <= endMs) candles.push(parsed);
  }
  return { candles: sortOldestFirst(candles), empty: list.length === 0 };
}

const weex: VenueAdapter = {
  id: "weex",
  pageLimit: WEEX_PAGE_LIMIT,
  recentPageLimit: WEEX_RECENT_PAGE_LIMIT,
  publicRequestsPerSecond: weexPacedRps(),
  klineEndpoint: "GET /capi/v3/market/klines (recent limit=1000, weight 1) + historyKlines (older limit=100, weight 5; REST only)",
  async listSymbols(fetchLike) {
    const [exchangeInfo, apiTradingSymbols] = await Promise.all([
      getJson(fetchLike, `${WEEX_BASE}/capi/v3/market/exchangeInfo`),
      getJson(fetchLike, `${WEEX_BASE}/capi/v3/market/apiTradingSymbols`),
    ]);
    const apiEligible = new Set(weexRows(apiTradingSymbols)
      .filter((value): value is string => typeof value === "string")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean));
    const out: VenueSymbol[] = [];
    for (const raw of weexRows(exchangeInfo)) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const symbol = typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
      if (!symbol || !apiEligible.has(symbol)) continue;
      const contractType = typeof row.contractType === "string" ? row.contractType.toUpperCase() : "";
      if (row.quoteAsset !== "USDT" || row.marginAsset !== "USDT"
        || !contractType.endsWith("PERPETUAL") || row.forwardContractFlag !== true) continue;
      // A missing status is the current WEEX mainnet shape; an explicit status
      // must say trading.  API eligibility is still required in both cases.
      const status = typeof row.status === "string" ? row.status.toUpperCase() : null;
      out.push({ symbol, tradable: status === null || status === "TRADING" });
    }
    if (!out.length) throw new Error("WEEX exchangeInfo/apiTradingSymbols contained no mainnet USDT perpetual instruments");
    return out;
  },
  async fetchKlines(fetchLike, symbol, startMs, endMs) {
    // The collector's plan constrains every page to `pageLimit` open-minute
    // rows. Keep the range explicit too: WEEX otherwise returns its newest
    // rows, which would make a historical backfill repeatedly write the tail.
    const url = `${WEEX_BASE}/capi/v3/market/historyKlines?symbol=${encodeURIComponent(symbol)}`
      + `&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=${WEEX_PAGE_LIMIT}&priceType=LAST`;
    const body = await getJson(fetchLike, url);
    return weexKlinePage(body, startMs, endMs);
  },
  async fetchRecentKlines(fetchLike, symbol, startMs, endMs) {
    // This endpoint always returns the newest native rows; it has no historical
    // range semantics. The collector proves continuity before writing an
    // existing tail and falls back to historyKlines if the requested first
    // minute is absent.
    const url = `${WEEX_BASE}/capi/v3/market/klines?symbol=${encodeURIComponent(symbol)}`
      + `&interval=1m&limit=${WEEX_RECENT_PAGE_LIMIT}`;
    return weexKlinePage(await getJson(fetchLike, url), startMs, endMs);
  },
};

export const ADAPTERS: Record<VenueId, VenueAdapter> = { bybit, bitunix, bitget, binance, aster, weex };
