// src/marketcap/cmc.ts
// The CoinMarketCap wire: how each call is shaped, and — separately, and
// exported — how each response is READ.
//
// The split is the rule the bot repo's v0.80.6 finding earned: there is no
// provider mock HTTP server in this repo and there never will be one for a
// paid API, so a decision taken inline in a fetch is a decision no test can
// drive. Everything below that DECIDES anything is a pure exported function
// taking a parsed body; the fetchers only compose a URL, spend a credit and
// hand the body over.
//
// ── WHAT WAS VERIFIED LIVE AGAINST THE OPERATOR'S KEY ───────────────────────
//   · GET /v5/exchange/derivatives/list — works on this tier, paginates,
//     DEFAULTS TO 100 rows, so it is paged explicitly.
//   · GET /v5/exchange/derivatives/market-pairs/list/latest
//        ?exchange_slug=aster-pro&category=perpetual
//     answers `num_market_pairs: 572` with `market_pair_base.exchange_symbol`
//     carrying the exchange's own base spelling and `market_pair_base.crypto_id`
//     the canonical id (BTC 1, ETH 1027, SOL 5426).
//
// So the tier includes derivatives and the mapping shape is confirmed. The
// EXCHANGE SLUGS are a different matter: `bybit`, `aster-pro`, `bitget` and
// `bitunix` are what we expect, and they are VALIDATED against the exchange
// list at run time rather than trusted forever — a slug that silently stops
// matching produces an entire venue of `provider_untracked` rows, which is a
// failure that looks exactly like a provider outage.
import type { ProviderPair } from "./identity.js";
import type { ProviderQuote } from "./caps.js";

export const CMC_BASE = "https://pro-api.coinmarketcap.com";

/** The API key travels in a HEADER, never in a query string: this hub's own
 *  server.ts opens with the note that URLs reach access logs, and a provider
 *  key in one is a paid subscription in somebody's log rotation. */
export const CMC_KEY_HEADER = "X-CMC_PRO_API_KEY";

/** Minimal HTTP surface. Separate from the candles' `FetchLike` because that
 *  one takes a URL and nothing else, and this provider needs a header. */
export type HttpLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  headers?: { get(name: string): string | null };
}>;

export class ProviderError extends Error {
  constructor(message: string, readonly status: number, readonly providerCode?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

/** True when the provider is telling us to stop, in either of its two dialects
 *  (HTTP 429, or its own 1008/1009/1010/1011 credit and rate codes). A refusal
 *  is not a failure to retry immediately — it is the one error that gets worse
 *  when you retry. */
export function isProviderRefusal(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (err.status === 429) return true;
  return err.providerCode !== undefined && err.providerCode >= 1008 && err.providerCode <= 1011;
}

async function cmcGet(http: HttpLike, apiKey: string, path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(path, CMC_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await http(url.toString(), { headers: { [CMC_KEY_HEADER]: apiKey, accept: "application/json" } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const status = readStatus(body);
  if (!res.ok || (status.errorCode !== 0 && status.errorCode !== null)) {
    throw new ProviderError(
      `coinmarketcap ${path} failed: HTTP ${res.status}${status.errorCode ? ` code ${status.errorCode}` : ""}`
      + `${status.errorMessage ? `: ${status.errorMessage}` : ""}`,
      res.status,
      status.errorCode ?? undefined,
    );
  }
  return body;
}

/** The provider's `status` envelope, which carries its own error code even on
 *  a 200. Read as a pure function so a test can drive every branch. */
export function readStatus(body: unknown): { errorCode: number | null; errorMessage: string | null; creditCount: number | null } {
  const s = (body as { status?: Record<string, unknown> })?.status;
  if (!s || typeof s !== "object") return { errorCode: null, errorMessage: null, creditCount: null };
  const code = typeof s.error_code === "number" ? s.error_code : Number(s.error_code);
  const credits = typeof s.credit_count === "number" ? s.credit_count : Number(s.credit_count);
  return {
    errorCode: Number.isFinite(code) ? code : null,
    errorMessage: typeof s.error_message === "string" ? s.error_message : null,
    creditCount: Number.isFinite(credits) ? credits : null,
  };
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export interface DerivativeExchange {
  id: number;
  slug: string;
  name: string;
}

export function parseDerivativeExchanges(body: unknown): DerivativeExchange[] {
  const out: DerivativeExchange[] = [];
  const data = (body as { data?: unknown })?.data;
  const rows = Array.isArray(data) ? data : asArray((data as { exchanges?: unknown[] })?.exchanges);
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const slug = str(r.slug) || str(r.exchange_slug);
    const id = Number(r.id ?? r.exchange_id);
    if (!slug || !Number.isFinite(id)) continue;
    out.push({ id, slug, name: str(r.name) || str(r.exchange_name) || slug });
  }
  return out;
}

/** ONE PAGE of the derivative pair map, read into the shape identity.ts joins
 *  on. Rows whose `crypto_id` is absent are DROPPED rather than admitted with a
 *  zero: identity.ts would refuse them anyway, and a zero id in an index is an
 *  identity waiting to be matched by accident. */
export function parseMarketPairs(body: unknown, exchangeSlug: string): { pairs: ProviderPair[]; numMarketPairs: number | null } {
  const data = (body as { data?: unknown })?.data as Record<string, unknown> | undefined;
  const rows = asArray(data?.market_pairs);
  const pairs: ProviderPair[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const b = (r.market_pair_base ?? {}) as Record<string, unknown>;
    const q = (r.market_pair_quote ?? {}) as Record<string, unknown>;
    const cryptoId = Number(b.crypto_id ?? b.currency_id);
    const exchangeSymbol = str(b.exchange_symbol) || str(b.currency_symbol);
    if (!Number.isFinite(cryptoId) || cryptoId <= 0 || !exchangeSymbol) continue;
    pairs.push({
      exchangeSlug,
      exchangeSymbol,
      quoteSymbol: str(q.exchange_symbol) || str(q.currency_symbol) || null,
      cryptoId,
      cryptoSymbol: str(b.currency_symbol),
      cryptoName: str(b.currency_name),
      marketPair: str(r.market_pair) || null,
    });
  }
  const n = Number(data?.num_market_pairs);
  return { pairs, numMarketPairs: Number.isFinite(n) ? n : null };
}

/** Quotes, read as a MAP KEYED BY THE ID WE ASKED FOR, plus the exact set of
 *  ids that came back. The second half is the point: `skip_invalid=true` lets a
 *  batch succeed while dropping rows, and an id that vanishes without leaving a
 *  fact behind is indistinguishable from an id nobody requested. Caller feeds
 *  `omittedIds(requested, returned)` straight into `missingForOmittedId`. */
export function parseQuotes(body: unknown): { quotes: Map<number, ProviderQuote>; returnedIds: number[] } {
  const data = (body as { data?: unknown })?.data;
  const quotes = new Map<number, ProviderQuote>();
  const returnedIds: number[] = [];
  if (!data || typeof data !== "object") return { quotes, returnedIds };
  for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
    // v2 keys the map by the requested id; some responses hand back an ARRAY
    // per id (the same coin listed twice). Take the first — and only the first
    // — because "two rows for one id" is not a merge we are entitled to do.
    const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
    if (!row || typeof row !== "object") continue;
    const id = Number(row.id ?? key);
    if (!Number.isFinite(id) || id <= 0) continue;
    const usd = ((row.quote as Record<string, unknown>)?.USD ?? {}) as Record<string, unknown>;
    quotes.set(id, {
      cryptoId: id,
      symbol: str(row.symbol),
      name: str(row.name),
      // Everything money-shaped is passed through UNTOUCHED for caps.ts to
      // judge. No `?? 0`, no `Number(...)`: a coercion here is a rule taken in
      // the wrong file, and `Number(null)` is 0.
      marketCap: usd.market_cap,
      circulatingSupply: row.circulating_supply,
      price: usd.price,
      lastUpdated: usd.last_updated ?? row.last_updated,
      isMarketCapIncludedInCalc: row.is_market_cap_included_in_calc,
      selfReportedMarketCap: row.self_reported_market_cap,
      fullyDilutedMarketCap: usd.fully_diluted_market_cap,
    });
    returnedIds.push(id);
  }
  return { quotes, returnedIds };
}

export interface FetchDeps {
  http: HttpLike;
  apiKey: string;
  /** Called BEFORE each request with what it will cost, so the ledger is
   *  charged for a call that was made even if its response never parses. */
  spend(kind: "derivative-exchange-list" | "derivative-pair-map" | "quotes", credits: number): Promise<void>;
}

export const EXCHANGE_LIST_PAGE = 100;

/** Every derivative exchange the provider knows, paged. Used to VALIDATE the
 *  slugs rather than to discover venues: which venues we serve is our decision,
 *  not the provider's. */
export async function fetchDerivativeExchanges(deps: FetchDeps, maxPages = 20): Promise<DerivativeExchange[]> {
  const out: DerivativeExchange[] = [];
  for (let page = 0; page < maxPages; page++) {
    await deps.spend("derivative-exchange-list", 1);
    // The endpoint verified live on the operator's key. IT DEFAULTS TO 100
    // ROWS, which is why `limit` and `start` are stated rather than left off:
    // a first page taken for the whole list would validate four slugs against
    // an alphabetical fragment of the exchanges that exist.
    const body = await cmcGet(deps.http, deps.apiKey, "/v5/exchange/derivatives/list", {
      start: String(page * EXCHANGE_LIST_PAGE + 1),
      limit: String(EXCHANGE_LIST_PAGE),
    });
    const rows = parseDerivativeExchanges(body);
    out.push(...rows);
    if (rows.length < EXCHANGE_LIST_PAGE) break;
  }
  return out;
}

export const PAIR_PAGE_LIMIT = 100;

/** THE DERIVATIVE PAIR MAP for one exchange, paged to exhaustion.
 *
 *  `num_market_pairs` from the first page is used as the EXPECTED TOTAL and is
 *  reported back: a paging loop that stops early looks identical to an exchange
 *  that delisted half its book, and the venue's own count is the free evidence
 *  that tells those apart. */
export async function fetchDerivativePairs(
  deps: FetchDeps,
  slug: string,
  category = "perpetual",
  maxPages = 40,
): Promise<{ pairs: ProviderPair[]; expected: number | null; pages: number }> {
  const pairs: ProviderPair[] = [];
  let expected: number | null = null;
  let pages = 0;
  for (let page = 0; page < maxPages; page++) {
    await deps.spend("derivative-pair-map", 1);
    const body = await cmcGet(deps.http, deps.apiKey, "/v5/exchange/derivatives/market-pairs/list/latest", {
      exchange_slug: slug,
      category,
      start: String(page * PAIR_PAGE_LIMIT + 1),
      limit: String(PAIR_PAGE_LIMIT),
    });
    const r = parseMarketPairs(body, slug);
    pages++;
    if (expected === null) expected = r.numMarketPairs;
    pairs.push(...r.pairs);
    if (r.pairs.length === 0) break;
    if (expected !== null && pairs.length >= expected) break;
  }
  return { pairs, expected, pages };
}

/** Quotes for a batch of ids. ONE REQUEST PER BATCH, never per coin.
 *  `skip_invalid` is deliberately ON — without it one delisted id fails the
 *  whole batch of a hundred — and the omission it causes is turned into an
 *  explicit `missing` fact by the caller. */
export async function fetchQuotes(deps: FetchDeps, ids: readonly number[]): Promise<{ quotes: Map<number, ProviderQuote>; returnedIds: number[] }> {
  if (!ids.length) return { quotes: new Map(), returnedIds: [] };
  await deps.spend("quotes", 1);
  const body = await cmcGet(deps.http, deps.apiKey, "/v2/cryptocurrency/quotes/latest", {
    id: ids.join(","),
    convert: "USD",
    skip_invalid: "true",
    aux: "is_market_cap_included_in_calc,circulating_supply",
  });
  return parseQuotes(body);
}

/** Split an id list into provider-sized batches. Exported because the credit
 *  estimate and the fetch loop must agree about the batch size, and two copies
 *  of that number is how a budget estimate stops describing the code. */
export function batchIds(ids: readonly number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
