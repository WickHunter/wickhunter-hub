// src/marketcap/caps.ts
// WHAT IS THIS ASSET WORTH — and, far more importantly, WHEN DO WE REFUSE TO SAY.
//
// A market cap here decides whether a bot may trade a pair. Every wrong answer
// therefore costs money in one of two directions, and they are not symmetric: a
// figure we refuse costs an opportunity, a figure we invent costs a position.
// So every rule below fails toward the refusal, every refusal carries a reason
// in words, and NOTHING in this file ever substitutes one number for another.
//
// ── THE SUBSTITUTIONS THAT ARE FORBIDDEN, EACH FOR ITS OWN REASON ───────────
//   · FULLY DILUTED VALUATION is a different quantity — it prices tokens that
//     do not exist yet. On a low-float listing it can be 50x the market cap,
//     and a size filter fed FDV would size against a supply nobody holds.
//   · `self_reported_market_cap` is the ISSUER's number. It is present on
//     exactly the assets whose supply the provider could not verify, which is
//     to say exactly the assets where the issuer's own claim is worth least.
//   · `total_supply x price` is FDV with extra steps.
//   · AVERAGING TWO PROVIDERS produces a figure neither provider would stand
//     behind and that no third party can reproduce.
//   · ONE PROVIDER'S PRICE WITH ANOTHER'S SUPPLY is the same defect, wearing a
//     more convincing costume, and it defeats the cross-check below — which is
//     the only free evidence we have that the row is internally consistent.
//   · A NULL CAP IS NOT ZERO. Zero is a claim ("this asset is worth nothing")
//     and it passes every "is it a number" test on the way to a size filter.
//
// ── AND THE CROSS-CHECK, WHICH IS WHY THE ROW PROVES ITSELF ─────────────────
// The provider publishes `market_cap`, `price` and `circulating_supply` on the
// SAME row, and the first is the product of the other two. So the row carries
// its own audit for free: agree within 2% and the figure is internally
// consistent; disagree and something is stale, restated or mis-parsed, and we
// say `disputed` and name the size of the gap rather than picking a side.
// (Same rule, same reason, as the venue-by-venue decomposition check in the bot
// repo's `closed-pnl.ts`: the row PROVES the claim rather than declaring it.)
import { dec, decMul, decToString, decIsPositive, relativeErrorPpm, type Dec } from "./decimal.js";

/** 2%, in parts per million. The tolerance is this wide — rather than a few
 *  parts per billion — because the provider rounds `price` for publication and
 *  the product of two rounded figures cannot be tighter than its inputs. It is
 *  narrow enough that a restated supply or a stale price fails it. */
export const CAP_CROSS_CHECK_TOLERANCE_PPM = 20_000n;

/** How old the provider's own stamp may be when we receive it. */
export const CAP_MAX_AGE_MS = 15 * 60_000;

/** How far AHEAD of us the provider's clock may be. Two minutes of skew is
 *  ordinary between two machines; more than that and the row is not describing
 *  a moment we can place, so its freshness cannot be judged at all. */
export const CAP_MAX_FUTURE_SKEW_MS = 2 * 60_000;

export type CapStatus =
  /** A strict provider cap that passed every rule. */
  | "verified"
  /** A secondary provider's cap, used only where the primary had none. */
  | "fallback"
  /** No usable figure exists — including an id the provider omitted entirely. */
  | "missing"
  /** The row contradicts itself: cap vs price x supply beyond tolerance. */
  | "disputed"
  /** The figure is real but too old (or stamped in the future) to be used. */
  | "stale"
  /** No market cap is meaningful for this subject at all. */
  | "not_applicable";

/** The provider's row, exactly as parsed, with nothing coerced. Every field is
 *  `unknown` because the wire is not ours: a field we expected to be a number
 *  and that arrives as a string, a null, or missing entirely must reach the
 *  RULES rather than being flattened into a default on the way in. */
export interface ProviderQuote {
  cryptoId: number;
  symbol: string;
  name: string;
  marketCap: unknown;
  circulatingSupply: unknown;
  price: unknown;
  /** The provider's own last-updated stamp, its own format. */
  lastUpdated: unknown;
  /** RETAINED AND SURFACED, never acted on here. `0` means the provider does
   *  not count this asset in its aggregate market cap — almost always because
   *  it could not verify the supply. That is a real caveat about a figure that
   *  is otherwise well-formed, so it rides on the wire and the consumer decides;
   *  silently downgrading it here would hide a caveat under a status word. */
  isMarketCapIncludedInCalc: unknown;
  /** READ SO IT CAN BE REFUSED. Present in the type so nobody adds it later
   *  believing it to be an unused field worth wiring up; see the header. */
  selfReportedMarketCap?: unknown;
  /** Likewise: parsed, reported, never substituted. */
  fullyDilutedMarketCap?: unknown;
}

export interface CapFact {
  cryptoId: number;
  symbol: string | null;
  name: string | null;
  status: CapStatus;
  /** Always a sentence when the status is not `verified`; null when it is. */
  reason: string | null;
  /** Decimal STRINGS, or null. Never a float on the wire, never a zero standing
   *  in for an absence. */
  marketCapUsd: string | null;
  priceUsd: string | null;
  circulatingSupply: string | null;
  providerLastUpdated: number | null;
  receivedAt: number;
  source: "cmc" | "coingecko" | null;
  /** The provider's `is_market_cap_included_in_calc`, unchanged. Null when the
   *  provider did not say — which is not the same as `false`. */
  marketCapIncludedInCalc: boolean | null;
  /** The free audit: what price x supply came to, and how far that is from the
   *  published cap. Kept on EVERY row that could compute it, verified or not,
   *  because a consumer investigating a disputed figure wants the arithmetic
   *  and not just the verdict. */
  crossCheck: { impliedMarketCapUsd: string; relativeErrorPpm: number } | null;
}

export interface AcceptDeps {
  receivedAt: number;
  /** The id was proven by identity.ts. A cap for an unproven id is refused
   *  outright: an id we cannot justify is an id we might have guessed, and a
   *  guessed id attaches one coin's cap to another coin's book. */
  identityProven: boolean;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
  tolerancePpm?: bigint;
}

const base = (q: Pick<ProviderQuote, "cryptoId" | "symbol" | "name">, receivedAt: number): CapFact => ({
  cryptoId: q.cryptoId,
  symbol: q.symbol || null,
  name: q.name || null,
  status: "missing",
  reason: null,
  marketCapUsd: null,
  priceUsd: null,
  circulatingSupply: null,
  providerLastUpdated: null,
  receivedAt,
  source: null,
  marketCapIncludedInCalc: null,
  crossCheck: null,
});

/** The provider's stamp as epoch-ms, or null. ISO strings and epoch numbers are
 *  both accepted because both are seen in the wild; anything else is null, and
 *  a null stamp is a REFUSAL below rather than a "probably fine". */
export function parseProviderStamp(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    // Seconds vs milliseconds: a plausible epoch-seconds value is ~1.7e9 and a
    // plausible epoch-ms one is ~1.7e12. Nothing legitimate sits between.
    if (v > 1e12) return Math.round(v);
    if (v > 1e9) return Math.round(v * 1000);
    return null;
  }
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v.trim());
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function tri(v: unknown): boolean | null {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  return null;
}

/** THE ACCEPTANCE DECISION. Pure, one row in, one verdict out. */
export function acceptCmcQuote(q: ProviderQuote, deps: AcceptDeps): CapFact {
  const maxAge = deps.maxAgeMs ?? CAP_MAX_AGE_MS;
  const skew = deps.maxFutureSkewMs ?? CAP_MAX_FUTURE_SKEW_MS;
  const tol = deps.tolerancePpm ?? CAP_CROSS_CHECK_TOLERANCE_PPM;
  const fact = base(q, deps.receivedAt);
  fact.source = "cmc";
  fact.marketCapIncludedInCalc = tri(q.isMarketCapIncludedInCalc);

  if (!deps.identityProven) {
    return { ...fact, reason: `crypto id ${q.cryptoId} was not proven by the pair map — a cap is not attached to an unproven identity` };
  }

  // ── THE THREE FIGURES, PARSED EXACTLY OR NOT AT ALL ─────────────────────
  const cap = dec(q.marketCap);
  const price = dec(q.price);
  const supply = dec(q.circulatingSupply);
  if (cap === null) {
    // NOT zero, and NOT the self-reported figure sitting right beside it.
    const hasSelfReported = dec(q.selfReportedMarketCap) !== null;
    return {
      ...fact,
      reason: `the provider published no market cap for crypto id ${q.cryptoId}`
        + (hasSelfReported ? " (a self-reported figure is present and is deliberately not used)" : ""),
    };
  }
  // Record what we did read, whatever the verdict turns out to be — a refusal
  // an operator cannot see the inputs of is a refusal they cannot check.
  fact.marketCapUsd = decToString(cap);
  fact.priceUsd = price ? decToString(price) : null;
  fact.circulatingSupply = supply ? decToString(supply) : null;

  const notPositive = (name: string, d: Dec | null): string | null =>
    d === null ? `${name} is absent or unparseable` : !decIsPositive(d) ? `${name} is not greater than zero` : null;
  const bad = notPositive("market cap", cap) ?? notPositive("price", price) ?? notPositive("circulating supply", supply);
  if (bad) {
    return { ...fact, marketCapUsd: null, reason: `${bad} for crypto id ${q.cryptoId} — a strict cap needs all three` };
  }

  // ── FRESHNESS, BEFORE THE ARITHMETIC ───────────────────────────────────
  const stamp = parseProviderStamp(q.lastUpdated);
  fact.providerLastUpdated = stamp;
  if (stamp === null) {
    return { ...fact, status: "stale", marketCapUsd: null, reason: `crypto id ${q.cryptoId} carries no readable last-updated stamp, so its freshness cannot be judged` };
  }
  const age = deps.receivedAt - stamp;
  if (age > maxAge) {
    return { ...fact, status: "stale", marketCapUsd: null, reason: `provider stamp is ${Math.round(age / 1000)}s old, ceiling ${Math.round(maxAge / 1000)}s` };
  }
  if (age < -skew) {
    return { ...fact, status: "stale", marketCapUsd: null, reason: `provider stamp is ${Math.round(-age / 1000)}s in the future, beyond the ${Math.round(skew / 1000)}s clock-skew allowance` };
  }

  // ── THE ROW AUDITS ITSELF ──────────────────────────────────────────────
  const implied = decMul(price!, supply!);
  const err = relativeErrorPpm(cap, implied);
  fact.crossCheck = {
    impliedMarketCapUsd: decToString(implied),
    // Reported as a NUMBER because it is a diagnostic magnitude, not money —
    // nothing downstream compares it against a threshold except the line below,
    // which uses the exact BigInt.
    relativeErrorPpm: err === null ? -1 : Number(err),
  };
  if (err === null || err > tol) {
    return {
      ...fact,
      status: "disputed",
      // The FIGURE IS STILL CARRIED on a disputed row, and the status is what
      // makes it unusable. Dropping it would leave an operator investigating a
      // contradiction with neither of the two numbers that contradict.
      reason: `published market cap disagrees with price x circulating supply by ${err === null ? "an undefined amount" : `${(Number(err) / 10_000).toFixed(3)}%`}`
        + ` (published ${decToString(cap)}, implied ${decToString(implied)}, tolerance ${(Number(tol) / 10_000).toFixed(2)}%)`,
    };
  }

  return { ...fact, status: "verified", reason: null };
}

/** An id we asked for and the provider did not answer. ONE PER OMITTED ID,
 *  always — `skip_invalid=true` makes a batch succeed while quietly dropping
 *  rows, and provider lag on a fresh listing does the same. An omission that
 *  produced no row would be indistinguishable from an id we never requested,
 *  and the coverage invariant below is what makes that impossible. */
export function missingForOmittedId(cryptoId: number, receivedAt: number, detail?: string): CapFact {
  return {
    ...base({ cryptoId, symbol: "", name: "" }, receivedAt),
    reason: `crypto id ${cryptoId} was requested and the provider returned no row for it`
      + (detail ? ` (${detail})` : " — skip_invalid, provider lag, or a malformed row"),
  };
}

/** An instrument whose subject has no market cap by nature. */
export function notApplicableFact(cryptoId: number, receivedAt: number, reason: string): CapFact {
  return { ...base({ cryptoId, symbol: "", name: "" }, receivedAt), status: "not_applicable", reason };
}

export interface CapCensus {
  requested: number;
  verified: number;
  fallback: number;
  missing: number;
  disputed: number;
  stale: number;
  not_applicable: number;
  /** THE INVARIANT: every requested id ended up in exactly one bucket. */
  invariantOk: boolean;
}

/** Census over the facts for ONE requested id set. The requested set is passed
 *  in rather than inferred from the facts, because inferring it would make the
 *  invariant tautological — it exists precisely to catch an id that fell out. */
export function capCensus(requestedIds: readonly number[], facts: readonly CapFact[]): CapCensus {
  const census: CapCensus = {
    requested: new Set(requestedIds).size,
    verified: 0, fallback: 0, missing: 0, disputed: 0, stale: 0, not_applicable: 0,
    invariantOk: false,
  };
  const seen = new Set<number>();
  for (const f of facts) {
    if (seen.has(f.cryptoId)) continue; // one verdict per id; the first wins
    seen.add(f.cryptoId);
    census[f.status]++;
  }
  const bucketed = census.verified + census.fallback + census.missing + census.disputed + census.stale + census.not_applicable;
  census.invariantOk = bucketed === census.requested && seen.size === census.requested;
  return census;
}

/** THE OMISSION RULE, as a function rather than as a habit: everything asked
 *  for that did not come back. One caller, one meaning, no chance of a batch
 *  quietly shortening its own request. */
export function omittedIds(requestedIds: readonly number[], returnedIds: Iterable<number>): number[] {
  const back = new Set(returnedIds);
  return [...new Set(requestedIds)].filter((id) => !back.has(id)).sort((a, b) => a - b);
}
