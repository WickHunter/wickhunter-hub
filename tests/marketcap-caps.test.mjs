// tests/marketcap-caps.test.mjs
// WHAT IS IT WORTH — and, mostly, WHEN DO WE REFUSE TO SAY.
//
// Every check here is about a refusal being reachable, because the expensive
// failures in this area are all the same shape: a figure that is present, is a
// number, and is the WRONG QUANTITY. FDV, a self-reported cap, total supply x
// price, an averaged pair of providers and a null read as zero all pass "is it
// a number"; none of them may pass this file.
import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import {
  CAP_CROSS_CHECK_TOLERANCE_PPM, CAP_MAX_AGE_MS, acceptCmcQuote, capCensus, missingForOmittedId,
  omittedIds, parseProviderStamp,
} from "../dist/src/marketcap/caps.js";
import { dec, decToString, relativeErrorPpm } from "../dist/src/marketcap/decimal.js";
import { parseQuotes } from "../dist/src/marketcap/cmc.js";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

const quote = (over = {}) => ({
  cryptoId: 1027,
  symbol: "ETH",
  name: "Ethereum",
  price: 3000,
  circulatingSupply: 120_000_000,
  marketCap: 360_000_000_000,
  lastUpdated: iso(NOW - 30_000),
  isMarketCapIncludedInCalc: 1,
  ...over,
});

const accept = (q, over = {}) => acceptCmcQuote(q, { receivedAt: NOW, identityProven: true, ...over });

// ── 1. the happy path, and what it proves about itself ──────────────────────

await test("a strict cap needs cap, price and supply, a fresh stamp, and self-agreement", () => {
  const f = accept(quote());
  assert.equal(f.status, "verified");
  assert.equal(f.reason, null);
  assert.equal(f.marketCapUsd, "360000000000", "money is a DECIMAL STRING on the wire");
  assert.equal(f.source, "cmc");
  assert.equal(f.marketCapIncludedInCalc, true, "the provider's own caveat flag is RETAINED");
  assert.equal(f.crossCheck.impliedMarketCapUsd, "360000000000");
  assert.equal(f.crossCheck.relativeErrorPpm, 0);
});

await test("the row PROVES the claim: cap vs price x supply, within 2%", () => {
  // 1.9% out — inside tolerance, still verified, and the arithmetic is kept.
  const near = accept(quote({ marketCap: 360_000_000_000 * 1.019 }));
  assert.equal(near.status, "verified");
  assert.ok(near.crossCheck.relativeErrorPpm > 0);

  // 5% out — DISPUTED. Not "corrected", not silently replaced by the implied
  // figure: two numbers disagree and picking one is how a book stops being
  // reconcilable.
  const far = accept(quote({ marketCap: 360_000_000_000 * 1.05 }));
  assert.equal(far.status, "disputed");
  assert.match(far.reason, /disagrees with price x circulating supply by 4\.7/);
  assert.ok(far.marketCapUsd, "the disputed figure is still carried, so the contradiction can be investigated");
  assert.equal(Number(CAP_CROSS_CHECK_TOLERANCE_PPM), 20_000, "2%, in ppm");
});

// ── 2. absence is never zero, and never something else's number ─────────────

await test("a null market cap is MISSING — never zero", () => {
  const f = accept(quote({ marketCap: null }));
  assert.equal(f.status, "missing");
  assert.equal(f.marketCapUsd, null, "a null cap must never arrive downstream as 0");
  assert.match(f.reason, /published no market cap/);
});

await test("a self-reported cap sitting beside a null one is NAMED and NOT USED", () => {
  const f = accept(quote({ marketCap: null, selfReportedMarketCap: 9_000_000_000 }));
  assert.equal(f.status, "missing");
  assert.equal(f.marketCapUsd, null);
  assert.match(f.reason, /self-reported figure is present and is deliberately not used/);
});

await test("FDV is never substituted for a cap", () => {
  const f = accept(quote({ marketCap: null, fullyDilutedMarketCap: 1_000_000_000_000 }));
  assert.equal(f.marketCapUsd, null, "FDV prices tokens that do not exist yet");
  assert.equal(f.status, "missing");
});

await test("a zero or negative figure in any of the three is refused by name", () => {
  assert.match(accept(quote({ marketCap: 0 })).reason, /market cap is not greater than zero/);
  assert.match(accept(quote({ price: 0 })).reason, /price is not greater than zero/);
  assert.match(accept(quote({ circulatingSupply: null })).reason, /circulating supply is absent or unparseable/);
  for (const q of [{ marketCap: 0 }, { price: 0 }, { circulatingSupply: null }]) {
    assert.equal(accept(quote(q)).marketCapUsd, null);
  }
});

await test("a cap for an UNPROVEN identity is refused outright", () => {
  const f = accept(quote(), { identityProven: false });
  assert.equal(f.status, "missing");
  assert.match(f.reason, /was not proven by the pair map/);
});

// ── 3. freshness ────────────────────────────────────────────────────────────

await test("freshness: 0 <= age <= 15 min, allowing 2 minutes of future skew", () => {
  assert.equal(accept(quote({ lastUpdated: iso(NOW - CAP_MAX_AGE_MS + 1000) })).status, "verified");
  const old = accept(quote({ lastUpdated: iso(NOW - CAP_MAX_AGE_MS - 1000) }));
  assert.equal(old.status, "stale");
  assert.match(old.reason, /old, ceiling 900s/);
  assert.equal(old.marketCapUsd, null, "a stale figure is not handed out as a usable one");

  assert.equal(accept(quote({ lastUpdated: iso(NOW + 90_000) })).status, "verified", "90s of skew is ordinary");
  const future = accept(quote({ lastUpdated: iso(NOW + 200_000) }));
  assert.equal(future.status, "stale");
  assert.match(future.reason, /in the future/);
});

await test("an unreadable stamp is STALE, not assumed fresh", () => {
  const f = accept(quote({ lastUpdated: "yesterday-ish" }));
  assert.equal(f.status, "stale");
  assert.match(f.reason, /no readable last-updated stamp/);
  assert.equal(parseProviderStamp("yesterday-ish"), null);
  assert.equal(parseProviderStamp(1_756_000_000), 1_756_000_000_000, "epoch seconds are recognised");
  assert.equal(parseProviderStamp(1_756_000_000_000), 1_756_000_000_000);
});

// ── 4. THE OMISSION CASE — skip_invalid ─────────────────────────────────────

await test("an id the provider omits becomes an explicit MISSING fact, never a silence", () => {
  // `skip_invalid=true` makes a batch of 100 succeed while dropping rows. The
  // omission is what the coverage invariant exists to catch.
  const body = {
    status: { error_code: 0 },
    data: {
      1027: { id: 1027, symbol: "ETH", name: "Ethereum", circulating_supply: 120_000_000, quote: { USD: { price: 3000, market_cap: 360_000_000_000, last_updated: iso(NOW - 5000) } } },
    },
  };
  const { quotes, returnedIds } = parseQuotes(body);
  const requested = [1027, 24478, 5426];
  const missing = omittedIds(requested, returnedIds);
  assert.deepEqual(missing, [5426, 24478].sort((a, b) => a - b));

  const facts = [];
  for (const id of requested) {
    const q = quotes.get(id);
    facts.push(q ? accept(q) : missingForOmittedId(id, NOW));
  }
  const census = capCensus(requested, facts);
  assert.equal(census.requested, 3);
  assert.equal(census.verified, 1);
  assert.equal(census.missing, 2);
  assert.equal(census.invariantOk, true, "every requested id is accounted for");
  for (const f of facts.filter((f) => f.status === "missing")) {
    assert.match(f.reason, /requested and the provider returned no row for it/);
    assert.match(f.reason, /skip_invalid, provider lag, or a malformed row/);
  }
});

await test("the census invariant FAILS when a requested id produced no fact at all", () => {
  // The whole point of passing the requested set in rather than deriving it:
  // derived, this could never fail, and an id that silently fell out of a batch
  // would be invisible.
  const census = capCensus([1, 2, 3], [missingForOmittedId(1, NOW)]);
  assert.equal(census.invariantOk, false);
});

// ── 5. money is exact ───────────────────────────────────────────────────────

await test("decimal strings, not floats, decide the threshold", () => {
  // 0.1 + 0.2 famously is not 0.3 in binary; the exact path must not care.
  assert.equal(decToString(dec("0.1")), "0.1");
  assert.equal(decToString(dec(1e21)), "1000000000000000000000", "no exponent form reaches the wire");
  assert.equal(decToString(dec("1.2300")), "1.23", "equal values serialise to identical bytes — they get SIGNED");
  assert.equal(dec("not a number"), null);
  assert.equal(dec(Infinity), null);
  assert.equal(dec(NaN), null);
  // A relative error against zero is UNDEFINED, not enormous.
  assert.equal(relativeErrorPpm(dec("0"), dec("5")), null);
  assert.equal(relativeErrorPpm(dec("100"), dec("102")), 20_000n);
  const f = acceptCmcQuote(quote({ marketCap: 0, price: 1, circulatingSupply: 1 }), { receivedAt: NOW, identityProven: true });
  assert.equal(f.status, "missing", "a zero cap is refused before any division can be attempted");
});

summary("marketcap-caps");
