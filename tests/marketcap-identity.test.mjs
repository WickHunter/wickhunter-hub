// tests/marketcap-identity.test.mjs
// WHICH COIN IS THIS INSTRUMENT ABOUT.
//
// The property under test is a refusal as much as a resolution: identity comes
// from the provider's derivative pair map, and a ticker's own text may only
// ever produce a SUGGESTION for a human. The multiplier cases below are the
// ones that cost money if a parser is ever allowed to decide:
//
//   · `1000PEPE` must resolve to PEPE and take PEPE's cap UNCHANGED. It is a
//     contract size, not a supply.
//   · `1000SATS` must NOT be assumed to be Bitcoin. It is its own listed asset
//     and the ticker cannot tell you that — only the map can.
//   · `1INCH`, `0G`, `2Z`, `4`, `100X` are ordinary tickers that merely begin
//     with digits and must survive every parser untouched.
import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import {
  buildPairIndex, resolveIdentity, resolveUniverse, suggestMultiplier, instrumentKey,
} from "../dist/src/marketcap/identity.js";
import {
  catalogueSanity, parseAsterInstruments, parseBitgetInstruments, parseBitunixInstruments,
  parseBybitInstruments,
} from "../dist/src/marketcap/exchanges.js";

const inst = (over = {}) => ({
  venue: "bybit",
  symbol: "PEPEUSDT",
  base: "PEPE",
  quote: "USDT",
  settle: "USDT",
  status: "Trading",
  contractType: "LinearPerpetual",
  active: true,
  ...over,
});

const pair = (exchangeSymbol, cryptoId, over = {}) => ({
  exchangeSlug: "bybit",
  exchangeSymbol,
  quoteSymbol: "USDT",
  cryptoId,
  cryptoSymbol: exchangeSymbol,
  cryptoName: exchangeSymbol,
  marketPair: `${exchangeSymbol}/USDT`,
  ...over,
});

const deps = (pairs, overrides = {}) => ({
  slugOf: (v) => ({ bybit: "bybit", aster: "aster-pro", bitget: "bitget", bitunix: "bitunix" })[v] ?? null,
  index: buildPairIndex(pairs),
  overrides,
});

// ── 1. the prefix parser, and everything it must not eat ────────────────────

await test("multiplier SHAPES are recognised — as suggestions and nothing more", () => {
  for (const [ticker, mult, impliedBase] of [
    ["1000PEPE", 1000, "PEPE"],
    ["1000000BABYDOGE", 1_000_000, "BABYDOGE"],
    ["1MBABYDOGE", 1_000_000, "BABYDOGE"],
    ["SHIB1000", 1000, "SHIB"],
    ["1000CAT", 1000, "CAT"],
    ["1000000MOG", 1_000_000, "MOG"],
    // Recognised as a SHAPE while being a genuinely separate asset. That the
    // hint is right about the string and wrong about the world is exactly why
    // it may not resolve anything — see the next check.
    ["1000SATS", 1000, "SATS"],
  ]) {
    const s = suggestMultiplier(ticker);
    assert.ok(s, `${ticker} should produce a suggestion`);
    assert.equal(s.multiplier, mult, ticker);
    assert.equal(s.impliedBase, impliedBase, ticker);
    assert.equal(s.reviewOnly, true, "a suggestion must say so in the data itself");
  }
});

await test("genuine numeric-leading tickers survive untouched", () => {
  // Each of these IS the coin. A looser rule eats 1INCH, and a bot then sizes
  // an INCH position against a market cap belonging to nothing.
  for (const ticker of ["1INCH", "0G", "2Z", "4", "100X"]) {
    assert.equal(suggestMultiplier(ticker), null, `${ticker} must not be read as a multiplier`);
  }
});

// ── 2. identity comes from the map, never from the ticker ───────────────────

await test("1000PEPE resolves to PEPE's canonical id — from the MAP", () => {
  const r = resolveIdentity(inst({ symbol: "1000PEPEUSDT", base: "1000PEPE" }), deps([pair("1000PEPE", 24478)]));
  assert.equal(r.state, "mapped");
  assert.equal(r.cryptoId, 24478, "the id is PEPE's, taken from the pair map's crypto_id");
  assert.equal(r.source, "provider-pair-map");
  // The hint rides along and decided nothing.
  assert.equal(r.multiplierSuggestion.multiplier, 1000);
});

await test("1000SATS is NOT assumed to be Bitcoin", () => {
  // The map says 1000SATS is crypto id 28683 (its own asset). A parser reading
  // "1000 sats" as a Bitcoin denomination would attach BTC's ~$1.3T cap to a
  // small-cap book, and every screen would look perfectly healthy.
  const mapped = resolveIdentity(inst({ symbol: "1000SATSUSDT", base: "1000SATS" }), deps([pair("1000SATS", 28683), pair("BTC", 1)]));
  assert.equal(mapped.cryptoId, 28683);
  assert.notEqual(mapped.cryptoId, 1, "1000SATS must never resolve to BTC");

  // And with NO map row it is untracked with a reason — never guessed at from
  // the suggestion sitting right there in the same object.
  const unmapped = resolveIdentity(inst({ symbol: "1000SATSUSDT", base: "1000SATS" }), deps([pair("BTC", 1)]));
  assert.equal(unmapped.state, "provider_untracked");
  assert.equal(unmapped.cryptoId, null);
  assert.match(unmapped.reason, /REVIEW ONLY, not applied/);
});

await test("the join is on the exchange's OWN base field, not on trimmed ticker text", () => {
  // The instrument's symbol says PEPEUSDT; its base field says 1000PEPE (a
  // venue that spells them differently). Trimming "USDT" off the symbol would
  // look for "PEPE" and find the wrong row — or none.
  const index = deps([pair("1000PEPE", 24478), pair("PEPE", 99999)]);
  const r = resolveIdentity(inst({ symbol: "PEPEUSDT", base: "1000PEPE" }), index);
  assert.equal(r.cryptoId, 24478);
});

await test("two ids behind one spelling is AMBIGUOUS, never a pick", () => {
  const r = resolveIdentity(inst({ base: "CAT" }), deps([pair("CAT", 111), pair("CAT", 222)]));
  assert.equal(r.state, "ambiguous");
  assert.deepEqual(r.candidateIds, [111, 222], "both candidates are named so an operator can decide");
  assert.equal(r.cryptoId, null);
  assert.match(r.reason, /an override must decide/);
});

await test("a venue the provider does not know at all says SO, distinctly", () => {
  const r = resolveIdentity(inst({ venue: "aster", base: "BTC" }), deps([pair("BTC", 1)]));
  // The map carries bybit rows only. "no rows for slug aster-pro" and "no row
  // for this pair" call for different fixes, so they are different sentences.
  assert.equal(r.state, "provider_untracked");
  assert.match(r.reason, /no rows for exchange slug "aster-pro"/);
});

// ── 3. operator overrides ───────────────────────────────────────────────────

await test("an override outranks the map, and a not-applicable override is its own state", () => {
  const overrides = {
    [instrumentKey("bybit", "CATUSDT")]: { cryptoId: 111, note: "decided by hand" },
    [instrumentKey("bybit", "IDXUSDT")]: { notApplicable: true, note: "a basket index, no single asset" },
  };
  const d = deps([pair("CAT", 111), pair("CAT", 222)], overrides);
  const fixed = resolveIdentity(inst({ symbol: "CATUSDT", base: "CAT" }), d);
  assert.equal(fixed.state, "mapped");
  assert.equal(fixed.cryptoId, 111);
  assert.equal(fixed.source, "operator-override");

  const na = resolveIdentity(inst({ symbol: "IDXUSDT", base: "IDX" }), d);
  assert.equal(na.state, "not_applicable");
  assert.match(na.reason, /basket index/);
});

await test("a prototype-shaped override key cannot reach through the prototype", () => {
  // flags.ts's v0.2.12 finding, one file along: this map is looked up by a key
  // built out of a VENUE-SUPPLIED symbol.
  const overrides = Object.create({ "bybit:PEPEUSDT": { cryptoId: 666 } });
  const r = resolveIdentity(inst(), deps([pair("PEPE", 24478)], overrides));
  assert.equal(r.cryptoId, 24478, "an INHERITED override key must not decide an identity");
});

// ── 4. the coverage invariant ───────────────────────────────────────────────

await test("every ACTIVE instrument lands in exactly one of the four states", () => {
  const instruments = [
    inst({ symbol: "BTCUSDT", base: "BTC" }),                        // mapped
    inst({ symbol: "CATUSDT", base: "CAT" }),                        // ambiguous
    inst({ symbol: "NEWUSDT", base: "NEW" }),                        // untracked
    inst({ symbol: "IDXUSDT", base: "IDX" }),                        // not applicable
    inst({ symbol: "DEADUSDT", base: "DEAD", active: false, status: "Delisted" }), // not active at all
  ];
  const { rows, census, mappedIds } = resolveUniverse(instruments, deps(
    [pair("BTC", 1), pair("CAT", 111), pair("CAT", 222)],
    { [instrumentKey("bybit", "IDXUSDT")]: { notApplicable: true } },
  ));
  assert.equal(rows.length, 4, "an inactive instrument is not in the population the invariant is stated over");
  assert.equal(census.activeInstruments, 4);
  assert.equal(census.mapped, 1);
  assert.equal(census.ambiguous, 1);
  assert.equal(census.provider_untracked, 1);
  assert.equal(census.not_applicable, 1);
  assert.equal(census.invariantOk, true);
  assert.equal(
    census.mapped + census.ambiguous + census.provider_untracked + census.not_applicable,
    census.activeInstruments,
    "THE INVARIANT, stated the way the spec states it",
  );
  assert.deepEqual(mappedIds, [1], "the cap stage requests exactly the ids identity proved");
});

await test("every unmapped row carries a reason a human can act on", () => {
  const { rows } = resolveUniverse([inst({ base: "WAT" })], deps([]));
  for (const r of rows) {
    if (r.state === "mapped") continue;
    assert.ok(r.reason && r.reason.length > 10, `state ${r.state} must explain itself: ${r.reason}`);
  }
});

// ── 5. the exchange catalogues ──────────────────────────────────────────────

await test("every venue parser keeps the exchange's OWN base field", () => {
  // Not `symbol.replace(/USDT$/, "")`. That invents a base for anything spelled
  // differently, and it is exactly the join key the pair map uses — so a made-up
  // base is a mapping that quietly matches the wrong coin.
  const bybit = parseBybitInstruments({ result: { list: [
    { symbol: "1000PEPEUSDT", baseCoin: "1000PEPE", quoteCoin: "USDT", settleCoin: "USDT", status: "Trading", contractType: "LinearPerpetual" },
    { symbol: "BTCPERP", baseCoin: "BTC", quoteCoin: "USDC", settleCoin: "USDC", status: "Trading", contractType: "LinearPerpetual" },
    { symbol: "ETHUSDT", baseCoin: "ETH", quoteCoin: "USDT", settleCoin: "USDT", status: "PreLaunch", contractType: "LinearPerpetual" },
    { symbol: "BADROW" },
  ], nextPageCursor: "next" } });
  assert.equal(bybit.instruments.length, 2, "the USDC-settled book is not a USDT perp");
  assert.equal(bybit.instruments[0].base, "1000PEPE");
  assert.equal(bybit.instruments[1].active, false, "listed but not trading is tracked and NOT active");
  assert.equal(bybit.cursor, "next", "one page is not a catalogue on this venue");
  assert.equal(bybit.unparsed, 1, "a row we could not use is COUNTED, not silently dropped");

  const aster = parseAsterInstruments({ symbols: [
    { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", marginAsset: "USDT", status: "TRADING", contractType: "PERPETUAL" },
    // A PENDING_TRADING row carries an EMPTY contractType on this venue; an
    // untyped row would admit a dated future the day one is listed.
    { symbol: "SOONUSDT", baseAsset: "SOON", quoteAsset: "USDT", status: "PENDING_TRADING", contractType: "" },
  ] });
  assert.equal(aster.instruments.length, 1);
  assert.equal(aster.instruments[0].venue, "aster");

  const bitget = parseBitgetInstruments({ data: [
    { symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", symbolStatus: "normal", symbolType: "perpetual" },
    { symbol: "OFFUSDT", baseCoin: "OFF", quoteCoin: "USDT", symbolStatus: "off", symbolType: "perpetual" },
  ] });
  assert.equal(bitget.instruments.length, 2);
  assert.equal(bitget.instruments[1].active, false);

  const bitunix = parseBitunixInstruments({ data: [
    { symbol: "BTCUSDT", base: "BTC", quote: "USDT", symbolStatus: "OPEN" },
    { symbol: "PREUSDT", base: "PRE", quote: "USDT", symbolStatus: "PREVIEW" },
  ] });
  assert.equal(bitunix.instruments.length, 2);
  assert.equal(bitunix.instruments[1].active, false, "PREVIEW is an announced listing with nothing behind it");
});

await test("a catalogue that collapses, or changes identity, is REFUSED", () => {
  const mk = (syms) => syms.map((s) => ({ ...inst({ symbol: s, base: s.replace("USDT", "") }) }));
  const before = mk(["AUSDT", "BUSDT", "CUSDT", "DUSDT", "EUSDT"]);

  assert.equal(catalogueSanity(null, before).ok, true, "the first catalogue has nothing to compare against");
  assert.equal(catalogueSanity(null, []).ok, false, "but an EMPTY first catalogue is not a catalogue");
  assert.equal(catalogueSanity(before, mk(["AUSDT", "BUSDT", "CUSDT", "DUSDT", "EUSDT", "FUSDT"])).ok, true, "growing is normal");

  // A truncated page and a mass delisting are the same bytes.
  const collapsed = catalogueSanity(before, mk(["AUSDT", "BUSDT"]));
  assert.equal(collapsed.ok, false);
  assert.match(collapsed.reason, /catalogue collapsed/);

  // Same COUNT, different symbols — a parser reading a reshaped response looks
  // exactly like this, and it is not a healthy catalogue.
  const swapped = catalogueSanity(before, mk(["VUSDT", "WUSDT", "XUSDT", "YUSDT", "ZUSDT"]));
  assert.equal(swapped.ok, false);
  assert.match(swapped.reason, /overlap/);
});

summary("marketcap-identity");
