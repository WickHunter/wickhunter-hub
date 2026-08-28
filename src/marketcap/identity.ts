// src/marketcap/identity.ts
// WHICH COIN IS THIS INSTRUMENT ABOUT — resolved from the provider's own
// derivative pair map, and from nothing else.
//
// ── THE THREE AUTHORITIES, AND WHY THEY MUST NOT BLEED ──────────────────────
//
//   exchange instrument API  -> authority for which pairs EXIST and are tradeable
//   CMC derivative pair map  -> maps exchange-native symbol -> stable crypto id
//   CMC quotes by crypto id  -> supplies USD market cap, supply, price, stamp
//
// This file is the middle one and it does exactly one job. It may never decide
// that a pair exists (that is the exchange's answer, and a provider that lags a
// listing must not be able to delist a live market from under a bot), and it
// may never decide what a coin is worth (that is caps.ts, keyed on the id this
// file proves).
//
// ── AND NEVER, EVER ON TICKER TEXT ──────────────────────────────────────────
// `1000PEPEUSDT` is not a coin called "1000PEPE". It is a PEPE contract quoted
// in thousands, and it takes PEPE's market cap UNCHANGED — the multiplier is a
// contract size, not a supply, and multiplying or dividing a market cap by it
// is the single most expensive mistake available in this file. `1000SATS`, on
// the other hand, IS its own listed asset and is not Bitcoin, however much its
// name looks like a Bitcoin denomination. No parser can tell those two apart,
// because the difference is a fact about the world and not about the string.
//
// So identity comes from the pair map. `suggestMultiplier` below exists, is
// exported, and is wired to NOTHING that resolves anything: it produces a
// REVIEW SUGGESTION for a human looking at an unmapped instrument, and the type
// system carries that in its name. The genuine numeric-leading tickers —
// `1INCH`, `0G`, `2Z`, `4`, `100X` — must come out of it untouched, which is
// the property the suite pins.
import type { MarketCapVenueId } from "./venues.js";

/** One tradeable instrument as ITS OWN EXCHANGE describes it. `base` is the
 *  venue's own base-asset field, kept as raw evidence: deriving it by trimming
 *  "USDT" off the symbol would invent a base for every venue that spells one
 *  differently, and it is precisely the join key the pair map uses. */
export interface ExchangeInstrument {
  venue: MarketCapVenueId;
  symbol: string;
  base: string;
  quote: string;
  settle: string;
  /** The venue's own status word, verbatim, for the evidence trail. */
  status: string;
  /** The venue's own contract-type word, verbatim. */
  contractType: string;
  /** Active AND tradeable, decided by the venue's parser from the venue's own
   *  fields. The coverage invariant is stated over exactly this population. */
  active: boolean;
}

/** One row of the provider's derivative pair map. Verified live against
 *  `/v5/exchange/derivatives/market-pairs/list/latest?exchange_slug=aster-pro
 *  &category=perpetual`: `market_pair_base.exchange_symbol` carries the
 *  exchange's own base spelling and `market_pair_base.crypto_id` the stable
 *  canonical id (BTC 1, ETH 1027, SOL 5426). */
export interface ProviderPair {
  exchangeSlug: string;
  /** The exchange's own base spelling, e.g. "1000PEPE". */
  exchangeSymbol: string;
  /** The exchange's own quote spelling when the provider states one. */
  quoteSymbol: string | null;
  cryptoId: number;
  cryptoSymbol: string;
  cryptoName: string;
  /** The provider's own market-pair label, e.g. "1000PEPE/USDT". */
  marketPair: string | null;
}

export type IdentityState = "mapped" | "ambiguous" | "provider_untracked" | "not_applicable";

export interface IdentityRow {
  venue: MarketCapVenueId;
  symbol: string;
  exchangeBase: string;
  exchangeQuote: string;
  state: IdentityState;
  /** Set only when `state === "mapped"`. */
  cryptoId: number | null;
  cryptoSymbol: string | null;
  cryptoName: string | null;
  /** How the id was proven. An override is an OPERATOR decision recorded in a
   *  file; it outranks the map because it exists to correct it. */
  source: "provider-pair-map" | "operator-override" | null;
  /** Every distinct id the map offered for this instrument. Length > 1 is what
   *  makes a row ambiguous, and the ids are kept so the operator can decide. */
  candidateIds: number[];
  /** Why this row is not mapped, in words a human can act on. Null when it is. */
  reason: string | null;
  /** REVIEW ONLY. Never consulted by anything above. */
  multiplierSuggestion: MultiplierSuggestion | null;
}

/** A prefix/suffix reading of a ticker. A SUGGESTION for a human, never an
 *  identity: the field is named for what it is so no caller can pretend it is
 *  a resolution. */
export interface MultiplierSuggestion {
  /** The contract multiplier the naming implies, e.g. 1000. NEVER applied to a
   *  market cap — see the header. */
  multiplier: number;
  /** The base name the naming implies, e.g. "PEPE". */
  impliedBase: string;
  /** Fixed true. Present on the wire so a consumer reading this field is told,
   *  in the data itself, that it is not evidence. */
  reviewOnly: true;
}

const MULTIPLIER_LETTERS: Record<string, number> = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };

/** ── THE PREFIX PARSER, AND EVERYTHING IT MUST NOT EAT ──────────────────────
 *
 *  Recognised, because the naming convention is real and an operator staring at
 *  an unmapped row wants the hint: `1000PEPE`, `1000000BABYDOGE`, `1MBABYDOGE`,
 *  `SHIB1000`, `1000CAT`, `1000000MOG` — and `1000SATS`, which is recognised as
 *  a naming SHAPE while being a genuinely separate asset from Bitcoin. That the
 *  hint is right about the shape and wrong about the world is the whole reason
 *  it may not resolve anything.
 *
 *  Left alone, because they are ordinary tickers that merely begin with digits:
 *  `1INCH` (no run of zeros), `0G` (does not start with 1), `2Z`, `4`, `100X`
 *  (two zeros, not three). The rule is `1` followed by at least THREE zeros, or
 *  `1` followed by K/M/B — nothing looser, because looser eats `1INCH`. */
export function suggestMultiplier(base: string): MultiplierSuggestion | null {
  const s = String(base ?? "").trim().toUpperCase();
  if (!s) return null;
  const ok = (multiplier: number, impliedBase: string): MultiplierSuggestion | null =>
    // A one-character remainder is not a coin name we would bet a hint on.
    impliedBase.length >= 2 ? { multiplier, impliedBase, reviewOnly: true } : null;

  let m = /^1(0{3,})([A-Z][A-Z0-9]*)$/.exec(s);
  if (m) return ok(10 ** m[1]!.length, m[2]!);

  m = /^1([KMB])([A-Z][A-Z0-9]*)$/.exec(s);
  if (m) return ok(MULTIPLIER_LETTERS[m[1]!]!, m[2]!);

  m = /^([A-Z][A-Z0-9]*[A-Z])1(0{3,})$/.exec(s);
  if (m) return ok(10 ** m[2]!.length, m[1]!);

  return null;
}

/** Operator decisions, read from `asset-identity-overrides-v1.json`. Keyed
 *  `<venue>:<venue-native symbol>` — never by base, because two venues can
 *  spell one asset differently and an override is a statement about one book. */
export interface IdentityOverride {
  /** Prove this instrument as this canonical id. */
  cryptoId?: number;
  /** Or declare that no market cap applies to it at all (an index, a basket, a
   *  non-crypto underlying). Both together is a contradiction and is refused. */
  notApplicable?: boolean;
  note?: string;
}

export type OverrideMap = Record<string, IdentityOverride>;

export const instrumentKey = (venue: string, symbol: string): string => `${venue}:${symbol}`;

interface PairIndexEntry {
  ids: number[];
  byId: Map<number, ProviderPair>;
}

export interface PairIndex {
  /** slug + base -> entry, and slug + base + quote -> entry. */
  readonly byBase: Map<string, PairIndexEntry>;
  readonly byBaseQuote: Map<string, PairIndexEntry>;
  readonly slugs: Set<string>;
  readonly rows: number;
}

const norm = (s: string): string => String(s ?? "").trim().toUpperCase();

function add(map: Map<string, PairIndexEntry>, key: string, p: ProviderPair): void {
  let e = map.get(key);
  if (!e) {
    e = { ids: [], byId: new Map() };
    map.set(key, e);
  }
  if (!e.byId.has(p.cryptoId)) {
    e.byId.set(p.cryptoId, p);
    e.ids.push(p.cryptoId);
  }
}

/** Index the provider's pair rows for lookup. Rows with no usable id are
 *  DROPPED here rather than admitted as a zero: an id of 0 is not an identity,
 *  and a row that cannot name a coin is the same as a row that is not there. */
export function buildPairIndex(pairs: readonly ProviderPair[]): PairIndex {
  const byBase = new Map<string, PairIndexEntry>();
  const byBaseQuote = new Map<string, PairIndexEntry>();
  const slugs = new Set<string>();
  let rows = 0;
  for (const p of pairs) {
    if (!Number.isInteger(p.cryptoId) || p.cryptoId <= 0) continue;
    if (!p.exchangeSymbol) continue;
    const slug = norm(p.exchangeSlug);
    const base = norm(p.exchangeSymbol);
    slugs.add(slug);
    rows++;
    add(byBase, `${slug}|${base}`, p);
    if (p.quoteSymbol) add(byBaseQuote, `${slug}|${base}|${norm(p.quoteSymbol)}`, p);
  }
  return { byBase, byBaseQuote, slugs, rows };
}

export interface ResolveDeps {
  /** venue id -> the provider's exchange slug (e.g. aster -> "aster-pro"). */
  slugOf(venue: MarketCapVenueId): string | null;
  index: PairIndex;
  overrides: OverrideMap;
}

/** Resolve ONE instrument. Pure; every branch names its own reason, because a
 *  row that is unmapped without saying why is a row nobody can fix. */
export function resolveIdentity(inst: ExchangeInstrument, deps: ResolveDeps): IdentityRow {
  const base = norm(inst.base);
  const quote = norm(inst.quote);
  const suggestion = suggestMultiplier(inst.base);
  const row: IdentityRow = {
    venue: inst.venue,
    symbol: inst.symbol,
    exchangeBase: inst.base,
    exchangeQuote: inst.quote,
    state: "provider_untracked",
    cryptoId: null,
    cryptoSymbol: null,
    cryptoName: null,
    source: null,
    candidateIds: [],
    reason: null,
    multiplierSuggestion: suggestion,
  };

  // ── 1. THE OPERATOR'S OWN DECISION, WHICH OUTRANKS THE PROVIDER ──────────
  // An override exists to correct the map, so a map that disagrees with it is
  // not a conflict to resolve — it is the thing being corrected.
  const ov = ownOverride(deps.overrides, instrumentKey(inst.venue, inst.symbol));
  if (ov) {
    if (ov.notApplicable && ov.cryptoId !== undefined) {
      return { ...row, state: "ambiguous", reason: "override names both a crypto id and not-applicable" };
    }
    if (ov.notApplicable) {
      return {
        ...row,
        state: "not_applicable",
        source: "operator-override",
        reason: ov.note ?? "operator marked this instrument as having no market-cap subject",
      };
    }
    if (Number.isInteger(ov.cryptoId) && (ov.cryptoId as number) > 0) {
      return {
        ...row,
        state: "mapped",
        cryptoId: ov.cryptoId!,
        source: "operator-override",
        candidateIds: [ov.cryptoId!],
      };
    }
    return { ...row, state: "ambiguous", reason: "override carries no usable crypto id" };
  }

  const slug = deps.slugOf(inst.venue);
  if (!slug) {
    return { ...row, reason: `no provider exchange slug is configured for ${inst.venue}` };
  }
  if (!deps.index.slugs.has(norm(slug))) {
    // The provider knows nothing about this exchange at all. Distinct from "it
    // knows the exchange and not this pair", and the operator's next action is
    // different in each case (validate the slug vs. add an override).
    return { ...row, reason: `the provider pair map carries no rows for exchange slug "${slug}"` };
  }

  // ── 2. THE PROVIDER'S MAP, quote-qualified first ─────────────────────────
  const qualified = deps.index.byBaseQuote.get(`${norm(slug)}|${base}|${quote}`);
  const bare = deps.index.byBase.get(`${norm(slug)}|${base}`);
  const entry = qualified ?? bare;
  if (!entry) {
    return {
      ...row,
      reason: `the provider pair map has no row for base "${inst.base}" on ${slug}`
        + (suggestion
          ? ` (naming suggests a x${suggestion.multiplier} ${suggestion.impliedBase} contract — REVIEW ONLY, not applied)`
          : ""),
    };
  }
  if (entry.ids.length > 1) {
    // Two different coins behind one exchange spelling. Refused rather than
    // picked: guessing here attaches one coin's market cap to another coin's
    // book, and the row would look perfectly healthy on every screen.
    return {
      ...row,
      state: "ambiguous",
      candidateIds: [...entry.ids].sort((a, b) => a - b),
      reason: `the provider pair map offers ${entry.ids.length} different crypto ids for base "${inst.base}" on ${slug} — an override must decide`,
    };
  }
  const p = entry.byId.get(entry.ids[0]!)!;
  return {
    ...row,
    state: "mapped",
    cryptoId: p.cryptoId,
    cryptoSymbol: p.cryptoSymbol || null,
    cryptoName: p.cryptoName || null,
    source: "provider-pair-map",
    candidateIds: [p.cryptoId],
  };
}

/** OWN key only. An override map read from a hand-edited file can carry a
 *  literal `__proto__` member, and looking it up on a plain object resolves
 *  through the prototype — v0.2.12's finding in flags.ts, one file along. */
function ownOverride(overrides: OverrideMap, key: string): IdentityOverride | null {
  if (!overrides || typeof overrides !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(overrides, key)) return null;
  const v = overrides[key];
  return v && typeof v === "object" ? v : null;
}

export interface IdentityCensus {
  activeInstruments: number;
  mapped: number;
  ambiguous: number;
  provider_untracked: number;
  not_applicable: number;
  /** THE INVARIANT: the four states account for every active instrument. */
  invariantOk: boolean;
  /** Distinct crypto ids the mapped rows point at — the exact set the cap
   *  stage will request, so the two stages cannot disagree about scope. */
  uniqueMappedAssets: number;
}

/** Resolve a whole universe, and CHECK THE INVARIANT while the numbers are
 *  still in hand. A census computed later, from a different walk, is a second
 *  scoping of one idea and is where two implementations drift apart. */
export function resolveUniverse(
  instruments: readonly ExchangeInstrument[],
  deps: ResolveDeps,
): { rows: IdentityRow[]; census: IdentityCensus; mappedIds: number[] } {
  const active = instruments.filter((i) => i.active);
  const rows = active.map((i) => resolveIdentity(i, deps));
  const census: IdentityCensus = {
    activeInstruments: active.length,
    mapped: 0,
    ambiguous: 0,
    provider_untracked: 0,
    not_applicable: 0,
    invariantOk: false,
    uniqueMappedAssets: 0,
  };
  const ids = new Set<number>();
  for (const r of rows) {
    census[r.state]++;
    if (r.state === "mapped" && r.cryptoId !== null) ids.add(r.cryptoId);
  }
  census.uniqueMappedAssets = ids.size;
  census.invariantOk =
    census.mapped + census.ambiguous + census.provider_untracked + census.not_applicable === census.activeInstruments;
  return { rows, census, mappedIds: [...ids].sort((a, b) => a - b) };
}
