// tests/marketcap-budget.test.mjs
// THE CREDIT BUDGET — the binding constraint on this whole service.
//
// 15,000 credits a month, 50 requests a minute. The measured reason the
// schedule is what it is: a 5-minute pair-map refresh costs ~34,560 credits a
// month for the MAPPING ALONE, two to three times the entire plan, before a
// single market cap is fetched. This suite holds the agreed schedule to the
// plan, and holds the REFUSAL to actually refusing.
import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import {
  AGREED_SCHEDULE, QUOTE_BATCH_SIZE, charge, creditsForCall, creditsForQuoteCall, emptyLedger,
  estimateMonthlyCredits, monthKey, nextCallDelayMs, noteRefusal, planRefresh, rolled,
} from "../dist/src/marketcap/budget.js";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const CEILING = 15_000;

await test("quotes are billed per 100 ids — which is WHY the cap stage batches", () => {
  assert.equal(QUOTE_BATCH_SIZE, 100);
  assert.equal(creditsForQuoteCall(1), 1);
  assert.equal(creditsForQuoteCall(100), 1);
  assert.equal(creditsForQuoteCall(101), 2);
  assert.equal(creditsForQuoteCall(700), 7);
  // One request per coin instead: 528 credits an hour is ~380,000 a month —
  // twenty-five times the plan for exactly the same facts.
  const perCoinMonthly = 528 * 24 * 30;
  assert.ok(perCoinMonthly > CEILING * 20, "the naive shape is off by more than an order of magnitude");
  assert.equal(creditsForCall("derivative-pair-map"), 1);
  assert.equal(creditsForCall("coingecko"), 0, "a different provider is not billed against this plan");
});

await test("the AGREED schedule fits the plan, with the 5-minute one measured against it", () => {
  const est = estimateMonthlyCredits();
  assert.ok(est.total <= CEILING, `agreed schedule costs ${est.total} credits/month, ceiling ${CEILING}`);
  assert.equal(est.mapping, 750, "daily mapping: (4 exchanges x 6 pages + 1 list) x 30");
  assert.equal(est.caps, 5040, "hourly caps: 7 batch-credits x 720");
  assert.equal(est.total, 6990);

  // The rejected shape, priced with the SAME function so the comparison cannot
  // drift out of date the way a comment would.
  const fiveMinute = estimateMonthlyCredits({ ...AGREED_SCHEDULE, mappingRefreshesPerMonth: 12 * 24 * 30, capRefreshesPerMonth: 12 * 24 * 30 });
  assert.ok(fiveMinute.mapping > CEILING * 2, `5-minute mapping alone is ${fiveMinute.mapping} credits/month`);
});

// ── the refusal ─────────────────────────────────────────────────────────────

await test("a refresh that would cross the ceiling DOES NOT START, and says so", () => {
  const nearly = { ...emptyLedger(NOW), used: 14_995 };
  const d = planRefresh(nearly, 7, CEILING, NOW);
  assert.equal(d.allowed, false);
  assert.equal(d.remaining, 5);
  // Named numbers, because a refusal that says only "budget exceeded" leaves
  // the operator with nothing to decide from.
  assert.match(d.reason, /would spend 7 credits: 14995 of 15000 are already used this month \(5 remain\)/);
  // And it is judged on the WHOLE planned cost, not the next call — a refresh
  // that stops halfway publishes a snapshot with a third of the book missing,
  // which is the one outcome this service exists to prevent.
  assert.equal(planRefresh(nearly, 5, CEILING, NOW).allowed, true, "a refresh that fits is still allowed");
});

await test("a zero ceiling refuses everything rather than meaning 'unlimited'", () => {
  const d = planRefresh(emptyLedger(NOW), 1, 0, NOW);
  assert.equal(d.allowed, false);
  assert.match(d.reason, /set to zero/);
});

await test("refusals are COUNTED, so 'we are not refreshing' has a number behind it", () => {
  let l = emptyLedger(NOW);
  l = noteRefusal(l, "over ceiling", NOW);
  l = noteRefusal(l, "over ceiling again", NOW);
  assert.equal(l.refusals, 2);
  assert.equal(l.lastRefusal, "over ceiling again");
});

await test("charging accumulates per kind, and the month rolls on its own", () => {
  let l = emptyLedger(NOW);
  l = charge(l, "quotes", 7, NOW);
  l = charge(l, "quotes", 7, NOW);
  l = charge(l, "derivative-pair-map", 6, NOW);
  assert.equal(l.used, 20);
  assert.equal(l.byKind.quotes, 14);
  assert.equal(l.byKind["derivative-pair-map"], 6);
  assert.equal(l.month, monthKey(NOW));

  const nextMonth = Date.UTC(2026, 8, 1, 0, 0, 1);
  const r = rolled(l, nextMonth);
  assert.equal(r.used, 0, "a new month starts from zero");
  assert.equal(r.month, "2026-09");
  // And a charge in the new month rolls first rather than adding to August.
  assert.equal(charge(l, "quotes", 1, nextMonth).used, 1);
});

// ── the per-minute rate ─────────────────────────────────────────────────────

await test("50 requests a minute is spaced evenly, not burst-then-wait", () => {
  // Even spacing at 50/min is one call every 1.2s. A burst that trips the
  // provider's limiter costs the refused calls AND the ones behind them.
  assert.equal(nextCallDelayMs([], 50, NOW), 0, "the first call waits for nothing");
  assert.equal(nextCallDelayMs([NOW], 50, NOW), 1200);
  assert.equal(nextCallDelayMs([NOW - 1200], 50, NOW), 0);

  // A full window waits for its oldest call to age out.
  const full = Array.from({ length: 50 }, (_, i) => NOW - 59_000 + i * 10);
  const wait = nextCallDelayMs(full, 50, NOW);
  assert.equal(wait, 1000, "the oldest call in the window ages out one second from now");
  // Calls older than a minute are simply not in the window.
  assert.equal(nextCallDelayMs([NOW - 120_000], 50, NOW), 0);
});

summary("marketcap-budget");
