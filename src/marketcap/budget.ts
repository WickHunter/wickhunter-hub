// src/marketcap/budget.ts
// THE CREDIT BUDGET, WHICH IS THE BINDING CONSTRAINT ON THIS WHOLE SERVICE.
//
// The operator's CoinMarketCap plan is 15,000 credits a month and 50 requests a
// minute. Those two numbers, not correctness and not latency, are what decides
// the shape of the producer — so they are enforced by code with a refusal
// attached, never by a comment naming a cadence somebody is trusted to honour.
//
// ── THE ARITHMETIC THAT SET THE SCHEDULE ────────────────────────────────────
// The original 5-minute refresh was measured before anything was built:
// re-reading the derivative pair map for four exchanges every five minutes is
// 12 x 24 x 30 = 8,640 refreshes a month, and at ~4 calls per refresh that is
// ~34,560 credits for the MAPPING ALONE — two to three times the entire plan,
// before a single market cap is fetched. The agreed schedule instead:
//
//   · DERIVATIVE PAIR MAPPING — DAILY. Which coin a ticker refers to is a
//     fact that changes when an exchange lists something, i.e. a few times a
//     week, not every five minutes. Paying an hourly rate for a daily fact is
//     the whole overspend.
//   · AN UNSEEN SYMBOL gets an immediate TARGETED refresh — one exchange, not
//     a sweep — so a new listing is mapped in minutes without moving the
//     cadence for the other five hundred pairs.
//   · CAP FACTS — HOURLY, batched by stable id, 100 ids per call. Never one
//     request per coin: that is the same fact fetched five hundred times.
//   · A NEW SYMBOL that is still unmapped is retried at ~1, 5, 15 and 60
//     minutes. PER SYMBOL, never as a sweep — the retry exists for the one
//     pair that just listed, and a sweep would turn a single listing into a
//     full re-map.
//
// See `estimateMonthlyCredits` for what that comes to; the estimate is a
// function rather than a paragraph so the suite can hold it to the plan.
//
// ── AND THE REFUSAL ─────────────────────────────────────────────────────────
// A ceiling that is approached and then quietly degraded into (fewer ids, older
// data, a skipped exchange) produces a snapshot that is subtly wrong and says
// nothing. So a refresh that would cross the ceiling DOES NOT START, and the
// refusal is a reason string that reaches feed health and the admin panel. The
// last known good snapshot keeps serving, which is the honest outcome: old data
// that says how old it is, rather than new data that is missing a third of the
// book.

/** What one call costs, per CoinMarketCap's own credit model. */
export type CallKind =
  | "derivative-exchange-list"
  | "derivative-pair-map"
  | "quotes"
  | "coingecko";

/** The provider bills `quotes/latest` at ONE CREDIT PER 100 CRYPTOCURRENCIES
 *  per convert, so a 100-id batch and a 1-id batch cost the same. That is the
 *  entire reason the cap stage batches: 528 ids as singles is 528 credits an
 *  hour (380k a month, 25x the plan); as batches of 100 it is 6. */
export const QUOTE_BATCH_SIZE = 100;

export function creditsForQuoteCall(idCount: number, converts = 1): number {
  if (!Number.isFinite(idCount) || idCount <= 0) return 0;
  return Math.ceil(idCount / QUOTE_BATCH_SIZE) * Math.max(1, converts);
}

export function creditsForCall(kind: CallKind, idCount = 0): number {
  switch (kind) {
    case "quotes":
      return creditsForQuoteCall(idCount);
    case "coingecko":
      return 0; // a different provider, a different plan; never billed here
    default:
      return 1; // list and map pages are one credit per call
  }
}

export interface CreditLedger {
  /** "YYYY-MM", UTC. The provider's cycle is not the calendar month, so this is
   *  a CONSERVATIVE proxy: it can only make us stop earlier than we had to. */
  month: string;
  used: number;
  byKind: Record<string, number>;
  updatedAt: number;
  /** Refusals since the month began, so "we are not refreshing" has a count
   *  behind it on the admin panel rather than only a silence. */
  refusals: number;
  lastRefusal: string | null;
}

export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function emptyLedger(now: number): CreditLedger {
  return { month: monthKey(now), used: 0, byKind: Object.create(null) as Record<string, number>, updatedAt: now, refusals: 0, lastRefusal: null };
}

/** Roll the ledger onto the current month if it has moved. Pure: returns the
 *  ledger to use, never mutates the one it was handed. */
export function rolled(ledger: CreditLedger, now: number): CreditLedger {
  const m = monthKey(now);
  if (ledger.month === m) return ledger;
  return emptyLedger(now);
}

export interface BudgetDecision {
  allowed: boolean;
  /** What the month's total WOULD be if this refresh ran in full. */
  wouldBe: number;
  remaining: number;
  /** Null when allowed; a sentence naming the numbers when not. */
  reason: string | null;
}

/** ── THE ONE DECISION, AND IT IS TAKEN BEFORE THE REFRESH STARTS ────────────
 *
 *  Judged on the WHOLE planned cost, not on the next call: a refresh that stops
 *  halfway is a snapshot with a third of the book missing, and this service's
 *  entire contract is that a partial map never gets published. Refusing the
 *  whole thing keeps the last known good, which states its own age. */
export function planRefresh(ledger: CreditLedger, plannedCredits: number, monthlyCeiling: number, now: number): BudgetDecision {
  const l = rolled(ledger, now);
  const wouldBe = l.used + Math.max(0, plannedCredits);
  const remaining = Math.max(0, monthlyCeiling - l.used);
  if (monthlyCeiling <= 0) {
    return { allowed: false, wouldBe, remaining: 0, reason: "the monthly credit ceiling is set to zero, so no provider call may be made" };
  }
  if (wouldBe > monthlyCeiling) {
    return {
      allowed: false,
      wouldBe,
      remaining,
      reason: `refusing to start a refresh that would spend ${plannedCredits} credits: ${l.used} of ${monthlyCeiling} are already used this month (${remaining} remain)`,
    };
  }
  return { allowed: true, wouldBe, remaining, reason: null };
}

/** Charge the ledger. Returns a NEW ledger; the caller persists it. */
export function charge(ledger: CreditLedger, kind: CallKind, credits: number, now: number): CreditLedger {
  const l = rolled(ledger, now);
  const byKind: Record<string, number> = Object.create(null);
  for (const [k, v] of Object.entries(l.byKind)) byKind[k] = v;
  byKind[kind] = (byKind[kind] ?? 0) + credits;
  return { ...l, used: l.used + credits, byKind, updatedAt: now };
}

export function noteRefusal(ledger: CreditLedger, reason: string, now: number): CreditLedger {
  const l = rolled(ledger, now);
  return { ...l, refusals: l.refusals + 1, lastRefusal: reason, updatedAt: now };
}

/** ── THE PER-MINUTE RATE ────────────────────────────────────────────────────
 *
 *  50 requests a minute is a REQUEST rate and has nothing to do with credits: a
 *  100-id batch is one request and one credit, and a bare exchange list is one
 *  request and one credit. Spacing is even rather than bursty, exactly as the
 *  candle collector paces itself, because a burst that trips the provider's
 *  limiter costs the requests it refuses AND the ones queued behind them.
 *
 *  Returns how long to wait before making the next call. The caller keeps the
 *  window of recent call times; there is no hidden state here to get stale. */
export function nextCallDelayMs(recentCallTimesMs: readonly number[], requestsPerMinute: number, now: number): number {
  const perMinute = Math.max(1, Math.floor(requestsPerMinute));
  const window = recentCallTimesMs.filter((t) => now - t < 60_000).sort((a, b) => a - b);
  if (window.length < perMinute) {
    // Even spacing inside the minute: at 50/min that is one call every 1.2s.
    const spacing = Math.ceil(60_000 / perMinute);
    const last = window.length ? window[window.length - 1]! : -Infinity;
    return Math.max(0, last + spacing - now);
  }
  // The window is full: wait for the oldest call in it to age out.
  return Math.max(0, window[0]! + 60_000 - now);
}

export interface SchedulePlan {
  exchanges: number;
  /** Pair-map pages per exchange per refresh (paginated; ~6 at 100/page for a
   *  572-pair venue). */
  pairPagesPerExchange: number;
  /** Distinct canonical assets the cap stage requests. */
  uniqueAssets: number;
  /** Targeted single-exchange re-maps triggered by unseen symbols, per month. */
  targetedRemapsPerMonth: number;
  mappingRefreshesPerMonth: number;
  capRefreshesPerMonth: number;
}

export const AGREED_SCHEDULE: SchedulePlan = {
  exchanges: 4,
  pairPagesPerExchange: 6,
  uniqueAssets: 700,
  targetedRemapsPerMonth: 200,
  mappingRefreshesPerMonth: 30,   // daily
  capRefreshesPerMonth: 24 * 30,  // hourly
};

export interface CreditEstimate {
  mapping: number;
  targeted: number;
  caps: number;
  total: number;
}

/** WHAT A MONTH COSTS AT THE AGREED SCHEDULE. A function, not a paragraph, so
 *  the suite can assert it fits the plan and so changing a cadence changes the
 *  reported number instead of leaving a stale claim in a comment. */
export function estimateMonthlyCredits(plan: SchedulePlan = AGREED_SCHEDULE): CreditEstimate {
  const perMapping = plan.exchanges * plan.pairPagesPerExchange + 1; // + the exchange list itself
  const mapping = perMapping * plan.mappingRefreshesPerMonth;
  const targeted = plan.targetedRemapsPerMonth * plan.pairPagesPerExchange;
  const caps = creditsForQuoteCall(plan.uniqueAssets) * plan.capRefreshesPerMonth;
  return { mapping, targeted, caps, total: mapping + targeted + caps };
}
