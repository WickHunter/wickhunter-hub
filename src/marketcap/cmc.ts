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
// ── WHAT WAS VERIFIED LIVE, AND HOW ─────────────────────────────────────────
// `CMC_ENDPOINT_CLAIM` below is the record, in the style this codebase uses for
// a venue fact that cost a live call to obtain: it states the OBSERVATION, not
// just the conclusion. A claim that records how it was proved survives the next
// reader; a constant that merely asserts an answer does not.
//
// The EXCHANGE IDENTITY is a stable numeric `exchange_id`, and the slug is a
// LABEL that is validated against it. A slug is the provider's to rename, and a
// slug that silently stops matching produces an entire venue of
// `provider_untracked` rows — a failure that looks exactly like a provider
// outage. See `DEFAULT_EXCHANGE_IDS` in service.ts.
import type { ProviderPair } from "./identity.js";
import type { ProviderQuote } from "./caps.js";

export const CMC_BASE = "https://pro-api.coinmarketcap.com";

/** ── THE LIVE OBSERVATIONS, WITH THEIR DATE AND THEIR METHOD ────────────────
 *
 *  Never a boolean and never a bare constant: what makes this trustworthy is
 *  that a future reader can see WHAT WAS SEEN and decide whether it still
 *  applies. Anything not listed here is still an assumption. */
export const CMC_ENDPOINT_CLAIM = {
  verifiedOn: "2026-08-24",
  method: "live calls against the operator's own production key",
  plan: { creditsPerMonth: 15_000, requestsPerMinute: 50, creditsUsedBefore: 0 },
  derivativeExchangeList: {
    endpoint: "GET /v5/exchange/derivatives/list",
    /** ⚠ `data` is an OBJECT containing `exchanges`, NOT a bare array. The
     *  tolerant parse below keeps both arms; this is the one that fires. */
    shape: "data.exchanges[]",
    rowKeys: [
      "exchange_id", "exchange_name", "exchange_slug", "exchange_score", "fiats",
      "last_updated", "liquidity_score", "num_market_pairs", "quotes", "rank", "traffic_score",
    ],
    /** Proved by OBSERVATION rather than by documentation: two overlapping
     *  windows returned DISTINCT rows, which is what makes the parameter names
     *  right rather than merely plausible. */
    pagingProof: "start=1&limit=2 -> [binance, tapbit]; start=3&limit=2 -> [echobit, okx]",
    creditCountPerCall: 1,
    /** ⚠ NO `total_count` ON THIS ENDPOINT. End-of-pagination therefore cannot
     *  be read off a declared total and has to be inferred from a short page —
     *  which is why `fetchDerivativeExchanges` also stops on a page that adds
     *  no new exchange, so a provider repeating a full page cannot spin it. */
    totalCountPublished: false,
    totalExchanges: 134,
  },
  /** The venues, by their DURABLE numeric id. Pair counts are the
   *  provider's own `num_market_pairs` on the day, kept as a magnitude check —
   *  never as a threshold, since a venue legitimately lists and delists. */
  exchanges: [
    { venue: "bybit", slug: "bybit", exchangeId: 521, perpPairs: 743 },
    { venue: "bitget", slug: "bitget", exchangeId: 513, perpPairs: 698 },
    { venue: "bitunix", slug: "bitunix", exchangeId: 7302, perpPairs: 671 },
    { venue: "aster", slug: "aster-pro", exchangeId: 1452, perpPairs: 572 },
    { venue: "weex", slug: "weex", exchangeId: 5751, perpPairs: 779, verifiedOn: "2026-09-05" },
  ],
  marketPairs: {
    endpoint: "GET /v5/exchange/derivatives/market-pairs/list/latest?exchange_slug=aster-pro&category=perpetual",
    numMarketPairs: 572,
    join: "market_pair_base.exchange_symbol -> market_pair_base.crypto_id",
    idsSeen: { BTC: 1, ETH: 1027, SOL: 5426 },
    /** ⚠ `market_pair` CAME BACK NULL in that response. It is parsed for the
     *  evidence trail and NOTHING joins on it — the join is base/quote
     *  `exchange_symbol`, which is populated. */
    marketPairLabelNull: true,
  },
} as const;

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

async function cmcGet(
  http: HttpLike,
  apiKey: string,
  path: string,
  params: Record<string, string>,
  billed?: { deps: FetchDeps; kind: BilledKind; estimated: number },
): Promise<unknown> {
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
  // Reconciled only on a SUCCESSFUL, parsed response: a call that failed was
  // already charged at our estimate by `spend`, and a body we could not read
  // has no credit figure to believe.
  if (billed && status.creditCount !== null) billed.deps.settle?.(billed.kind, billed.estimated, status.creditCount);
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
  /** The DURABLE key. A slug is a label the provider may rename. */
  id: number;
  slug: string;
  name: string;
  /** The provider's own count of tracked pairs, for a magnitude check. */
  pairs: number | null;
}

/** Verified live 2026-08-24: `data` is an OBJECT carrying `exchanges`, and the
 *  row keys are `exchange_id` / `exchange_name` / `exchange_slug` (see
 *  `CMC_ENDPOINT_CLAIM`). The bare-array arm is kept because it costs one line
 *  and this endpoint's envelope is the provider's to change — but the observed
 *  arm is the object one, and that is which branch actually fires today. */
export function parseDerivativeExchanges(body: unknown): DerivativeExchange[] {
  const out: DerivativeExchange[] = [];
  const data = (body as { data?: unknown })?.data;
  const rows = Array.isArray(data) ? data : asArray((data as { exchanges?: unknown[] })?.exchanges);
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const slug = str(r.exchange_slug) || str(r.slug);
    const id = Number(r.exchange_id ?? r.id);
    if (!slug || !Number.isFinite(id) || id <= 0) continue;
    const pairs = Number(r.num_market_pairs);
    out.push({
      id,
      slug,
      name: str(r.exchange_name) || str(r.name) || slug,
      pairs: Number.isFinite(pairs) ? pairs : null,
    });
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
      // ⚠ OBSERVED NULL on the live response (2026-08-24). Carried for the
      // evidence trail; NOTHING joins on it — the join is the base/quote
      // `exchange_symbol` above, which is populated.
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

export type BilledKind = "derivative-exchange-list" | "derivative-pair-map" | "quotes";

export interface FetchDeps {
  http: HttpLike;
  apiKey: string;
  /** Called BEFORE each request with what it will cost, so the ledger is
   *  charged for a call that was made even if its response never parses. */
  spend(kind: BilledKind, credits: number): Promise<void>;
  /** ── THE PROVIDER'S OWN READOUT, AND IT OUTRANKS OUR ESTIMATE UPWARD ──────
   *
   *  Every response carries `status.credit_count`: what THIS call actually
   *  cost. Our own model (1 per list/map page, 1 per 100 ids) is an estimate of
   *  the provider's price list, and a price list is the provider's to change —
   *  so when its number is higher than ours the difference is charged, and when
   *  it is lower NOTHING IS REFUNDED. That asymmetry is the same one the candle
   *  collector applies to Aster's `x-mbx-used-weight-1m`: adopting a lower
   *  figure hands back budget on the strength of a number we cannot audit,
   *  which is exactly the direction that overspends. Optional, so a caller that
   *  does not care simply never reconciles. */
  settle?(kind: BilledKind, estimated: number, actual: number): void;
}

export const EXCHANGE_LIST_PAGE = 100;

/** Every derivative exchange the provider knows, paged. Used to VALIDATE the
 *  slugs and their ids rather than to discover venues: which venues we serve is
 *  our decision, not the provider's.
 *
 *  ── TWO STOP CONDITIONS, AND THE SECOND IS NOT BELT-AND-BRACES ────────────
 *  This endpoint publishes NO `total_count` (verified 2026-08-24), so the end
 *  of the list can only be inferred from a SHORT PAGE. That inference fails in
 *  exactly one way: a provider that answers a full page for a `start` past the
 *  end — by clamping, by repeating, or by ignoring the parameter — would keep
 *  the loop asking, one credit a time, until the page bound. So the loop also
 *  stops the moment a page adds no exchange it has not already seen. 134
 *  exchanges exist today and one page covers them; the paging stays because a
 *  venue we serve could fall past the first page later, which is precisely the
 *  failure this is here to prevent. */
export async function fetchDerivativeExchanges(deps: FetchDeps, maxPages = 20): Promise<DerivativeExchange[]> {
  const out: DerivativeExchange[] = [];
  const seen = new Set<number>();
  for (let page = 0; page < maxPages; page++) {
    await deps.spend("derivative-exchange-list", 1);
    // The endpoint verified live on the operator's key. IT DEFAULTS TO 100
    // ROWS, which is why `limit` and `start` are stated rather than left off:
    // a first page taken for the whole list would validate four slugs against
    // an alphabetical fragment of the exchanges that exist.
    const body = await cmcGet(deps.http, deps.apiKey, "/v5/exchange/derivatives/list", {
      start: String(page * EXCHANGE_LIST_PAGE + 1),
      limit: String(EXCHANGE_LIST_PAGE),
    }, { deps, kind: "derivative-exchange-list", estimated: 1 });
    const rows = parseDerivativeExchanges(body);
    let fresh = 0;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      fresh++;
    }
    // A short page ends the list; a full page that told us nothing new means
    // the cursor is not advancing, and asking again costs a credit per attempt.
    if (rows.length < EXCHANGE_LIST_PAGE || fresh === 0) break;
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
    }, { deps, kind: "derivative-pair-map", estimated: 1 });
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
  }, { deps, kind: "quotes", estimated: 1 });
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
