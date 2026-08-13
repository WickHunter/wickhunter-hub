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
// and that is not a typo.
import type { Candle } from "./store.js";
import { MINUTE_MS, newestClosedOpenMs } from "./store.js";

export const VENUE_IDS = ["bybit", "bitunix", "bitget"] as const;
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
const RATE_LIMIT_CODES = new Set(["10006", "10018", "429", "40018"]);
const RATE_LIMIT_TEXT = /too many|too frequent|frequently|rate.?limit|request limit|visit limit|exceed.*limit/i;

function rateLimited(code: unknown, msg: unknown): boolean {
  return RATE_LIMIT_CODES.has(String(code)) || RATE_LIMIT_TEXT.test(String(msg ?? ""));
}

export interface KlinePage {
  candles: Candle[];
  /** True when the venue answered but has no rows in the asked-for range. */
  empty: boolean;
}

export interface VenueAdapter {
  readonly id: VenueId;
  /** Rows per kline page this venue will actually honour. */
  readonly pageLimit: number;
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

async function getJson(fetchLike: FetchLike, url: string): Promise<unknown> {
  const res = await fetchLike(url);
  // 429 is the standard refusal; 418 is what several exchanges escalate to when
  // a client keeps pushing after 429s, and it is the last warning before an IP
  // ban. Both mean stop, not fail.
  if (res.status === 429 || res.status === 418) {
    throw new RateLimitError(`HTTP ${res.status} (rate limited)`, retryAfterMs(res));
  }
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

export const ADAPTERS: Record<VenueId, VenueAdapter> = { bybit, bitunix, bitget };
