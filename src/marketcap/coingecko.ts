// src/marketcap/coingecko.ts
// THE SECONDARY PROVIDER — built so it can be switched on later, and ENTIRELY
// ABSENT-SAFE, because the operator has no CoinGecko key today.
//
// ── WHAT "FALLBACK" MEANS HERE, AND WHAT IT MUST NEVER MEAN ─────────────────
// It fills an ABSENCE and only an absence: an asset the primary had no figure
// for at all. It may never
//   · override a primary figure it disagrees with (that is a `disputed` row,
//     and picking the friendlier of two numbers is how a book stops being
//     reconcilable),
//   · be AVERAGED with one,
//   · lend its SUPPLY to the primary's price or vice versa — which would defeat
//     the cross-check, the only free evidence either row carries.
// A fallback row is stamped `source: "coingecko"` and counted in its own
// coverage bucket, so a consumer can tell at a glance how much of a snapshot
// came from where. Two providers averaged into one number is a figure neither
// of them would stand behind and nobody can reproduce.
//
// ── ABSENT-SAFE MEANS THE FEATURE DOES NOT EXIST WITHOUT A KEY ──────────────
// `enabled` is false with no key, `fetchFallbackCaps` answers an empty map
// without making a request, and the cap census counts zero `fallback`. Nothing
// anywhere waits on it, times out on it, or reports it as degraded — an
// optional provider that makes the service look unhealthy when it is absent is
// not optional.
import { dec, decMul, decToString, decIsPositive, relativeErrorPpm } from "./decimal.js";
import { CAP_CROSS_CHECK_TOLERANCE_PPM, CAP_MAX_AGE_MS, CAP_MAX_FUTURE_SKEW_MS, parseProviderStamp, type CapFact } from "./caps.js";
import type { HttpLike } from "./cmc.js";

export const COINGECKO_PRO_BASE = "https://pro-api.coingecko.com/api/v3";
export const COINGECKO_KEY_HEADER = "x-cg-pro-api-key";

export interface GeckoRow {
  /** CoinGecko's own id, e.g. "pepe". */
  id: string;
  symbol: string;
  name: string;
  marketCap: unknown;
  price: unknown;
  circulatingSupply: unknown;
  lastUpdated: unknown;
}

export function parseGeckoMarkets(body: unknown): GeckoRow[] {
  if (!Array.isArray(body)) return [];
  const out: GeckoRow[] = [];
  for (const raw of body) {
    const r = raw as Record<string, unknown>;
    if (typeof r?.id !== "string" || !r.id) continue;
    out.push({
      id: r.id,
      symbol: typeof r.symbol === "string" ? r.symbol.toUpperCase() : "",
      name: typeof r.name === "string" ? r.name : "",
      // Untouched, exactly like the primary's parser: coercion is a rule, and
      // rules do not belong in a reader.
      marketCap: r.market_cap,
      price: r.current_price,
      circulatingSupply: r.circulating_supply,
      lastUpdated: r.last_updated,
    });
  }
  return out;
}

export interface GeckoDeps {
  http: HttpLike;
  apiKey: string;
  /** CMC crypto id -> CoinGecko id. There is no reliable automatic join
   *  between the two providers' id spaces (symbols collide, names differ), so
   *  this is an OPERATOR-MAINTAINED map. An id with no entry simply has no
   *  fallback — never a symbol-text match, which is the join this whole service
   *  exists to avoid. */
  idMap: Record<number, string>;
}

/** A CoinGecko row judged by THE SAME RULES as the primary — all three figures
 *  positive, the stamp fresh, and the row agreeing with itself within 2%. A
 *  fallback that was accepted on looser terms than the figure it replaces would
 *  mean the least trustworthy rows in a snapshot are the ones nobody checked. */
export function acceptGeckoRow(row: GeckoRow, cryptoId: number, receivedAt: number): CapFact {
  const fact: CapFact = {
    cryptoId,
    symbol: row.symbol || null,
    name: row.name || null,
    status: "missing",
    reason: null,
    marketCapUsd: null,
    priceUsd: null,
    circulatingSupply: null,
    providerLastUpdated: null,
    receivedAt,
    source: "coingecko",
    marketCapIncludedInCalc: null,
    crossCheck: null,
  };
  const cap = dec(row.marketCap);
  const price = dec(row.price);
  const supply = dec(row.circulatingSupply);
  if (!cap || !price || !supply || !decIsPositive(cap) || !decIsPositive(price) || !decIsPositive(supply)) {
    return { ...fact, reason: `the fallback provider published no usable market cap, price and circulating supply for ${row.id}` };
  }
  fact.marketCapUsd = decToString(cap);
  fact.priceUsd = decToString(price);
  fact.circulatingSupply = decToString(supply);
  const stamp = parseProviderStamp(row.lastUpdated);
  fact.providerLastUpdated = stamp;
  if (stamp === null) return { ...fact, status: "stale", marketCapUsd: null, reason: `fallback row ${row.id} carries no readable last-updated stamp` };
  const age = receivedAt - stamp;
  if (age > CAP_MAX_AGE_MS) return { ...fact, status: "stale", marketCapUsd: null, reason: `fallback stamp is ${Math.round(age / 1000)}s old` };
  if (age < -CAP_MAX_FUTURE_SKEW_MS) return { ...fact, status: "stale", marketCapUsd: null, reason: `fallback stamp is ${Math.round(-age / 1000)}s in the future` };
  const implied = decMul(price, supply);
  const err = relativeErrorPpm(cap, implied);
  fact.crossCheck = { impliedMarketCapUsd: decToString(implied), relativeErrorPpm: err === null ? -1 : Number(err) };
  if (err === null || err > CAP_CROSS_CHECK_TOLERANCE_PPM) {
    return { ...fact, status: "disputed", reason: `fallback market cap disagrees with price x supply by ${err === null ? "an undefined amount" : `${(Number(err) / 10_000).toFixed(3)}%`}` };
  }
  return { ...fact, status: "fallback", reason: null };
}

export class CoinGeckoFallback {
  constructor(private readonly deps: GeckoDeps | null) {}

  get enabled(): boolean {
    return !!this.deps?.apiKey;
  }

  /** Caps for ids the primary could not answer. NO KEY, NO REQUEST, NO ERROR —
   *  an empty map, and the caller's census reports zero fallbacks, which is the
   *  truth on every install today. */
  async fetchFallbackCaps(cryptoIds: readonly number[], receivedAt: number): Promise<Map<number, CapFact>> {
    const out = new Map<number, CapFact>();
    if (!this.enabled || !this.deps || !cryptoIds.length) return out;
    const wanted = cryptoIds
      .map((id) => ({ id, gecko: Object.prototype.hasOwnProperty.call(this.deps!.idMap, id) ? this.deps!.idMap[id] : undefined }))
      .filter((x): x is { id: number; gecko: string } => !!x.gecko);
    if (!wanted.length) return out;
    const url = new URL(`${COINGECKO_PRO_BASE}/coins/markets`);
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("ids", wanted.map((w) => w.gecko).join(","));
    url.searchParams.set("per_page", "250");
    const res = await this.deps.http(url.toString(), { headers: { [COINGECKO_KEY_HEADER]: this.deps.apiKey, accept: "application/json" } });
    if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`);
    const rows = parseGeckoMarkets(await res.json());
    const byGeckoId = new Map(rows.map((r) => [r.id, r]));
    for (const w of wanted) {
      const row = byGeckoId.get(w.gecko);
      if (!row) continue; // an omission here is simply no fallback; the primary's `missing` fact stands
      out.set(w.id, acceptGeckoRow(row, w.id, receivedAt));
    }
    return out;
  }
}
