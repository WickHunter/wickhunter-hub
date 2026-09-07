// tests/liq-sources.test.mjs — the three venue normalizers, against the exact
// fixtures the bot's own `tests/liq-hub.test.mjs` drives (liqhunter-private),
// so a print this hub records is provably the SAME identity the bot itself
// would have produced from the same wire frame.
import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import {
  LIQ_SOURCES, LIQ_SOURCE_IDS, isLiqSourceId,
  baseQuoteOf, canonicalBase,
  normalizeBybitLiq, normalizeBinanceForce, normalizeOkxLiq,
} from "../dist/src/liq/sources.js";

await test("LIQ_SOURCE_IDS is exactly the bot's eight source ids", () => {
  assert.deepEqual(LIQ_SOURCE_IDS, [
    "bybit-usdt", "bybit-usdc", "bybit-inverse",
    "binance-usdt", "binance-inverse",
    "okx-usdt", "okx-usdc", "okx-inverse",
  ]);
  assert.equal(LIQ_SOURCES.length, 8);
  for (const id of LIQ_SOURCE_IDS) assert.ok(isLiqSourceId(id));
  assert.ok(!isLiqSourceId("bybit-usdt-extra"));
  assert.ok(!isLiqSourceId(42));
});

await test("baseQuoteOf: symbol → base/quote across every native format", () => {
  assert.deepEqual(baseQuoteOf("BTCUSDT"), { base: "BTC", quote: "USDT" });
  assert.deepEqual(baseQuoteOf("BTCUSDC"), { base: "BTC", quote: "USDC" });
  assert.deepEqual(baseQuoteOf("BTCPERP"), { base: "BTC", quote: "USDC" });
  assert.deepEqual(baseQuoteOf("BTCUSD"), { base: "BTC", quote: "USD" });
  assert.deepEqual(baseQuoteOf("BTCUSD_PERP"), { base: "BTC", quote: "USD" });
  assert.deepEqual(baseQuoteOf("BTC-USDT-SWAP"), { base: "BTC", quote: "USDT" });
  assert.deepEqual(baseQuoteOf("SOL-USD-SWAP"), { base: "SOL", quote: "USD" });
  assert.deepEqual(baseQuoteOf("SUIUSDT"), { base: "SUI", quote: "USDT" });
  assert.equal(baseQuoteOf("WHAT"), null);
  assert.equal(baseQuoteOf("USDT"), null);
});

await test("canonicalBase aliases the two coins any wired venue spells differently", () => {
  assert.equal(canonicalBase("XBT"), "BTC");
  assert.equal(canonicalBase("xbt"), "BTC");
  assert.equal(canonicalBase("XDG"), "DOGE");
  assert.equal(canonicalBase("SOL"), "SOL");
});

await test("normalizeBinanceForce: documented !forceOrder@arr shape (sampled stream)", () => {
  const msg = { e: "forceOrder", E: 1_700_000_000_100, o: { s: "BTCUSDT", S: "SELL", q: "0.014", p: "65000", ap: "65210.5", T: 1_700_000_000_000 } };
  const e = normalizeBinanceForce(msg, "binance-usdt");
  assert.ok(e);
  assert.equal(e.base, "BTC");
  assert.equal(e.side, "long", "SELL order = a long died → fade LONG");
  assert.ok(Math.abs(e.sizeUsd - 0.014 * 65210.5) < 1e-6, "notional = qty × avg price");
  assert.equal(e.ts, 1_700_000_000_000);

  const buy = normalizeBinanceForce({ o: { s: "ETHUSDT", S: "BUY", q: "2", ap: "3000", T: 1 } }, "binance-usdt");
  assert.equal(buy.side, "short", "BUY order = a short died → fade SHORT");

  assert.equal(normalizeBinanceForce({ o: { s: "ETHUSDT", q: "2", ap: "3000", T: 1 } }, "binance-usdt"), null,
    "missing Binance side is dropped, never coerced");
  assert.equal(normalizeBinanceForce({ o: { s: "ETHUSDT", S: "CLOSE", q: "2", ap: "3000", T: 1 } }, "binance-usdt"), null,
    "unknown Binance side is dropped, never coerced");
  assert.equal(normalizeBinanceForce({ o: { s: "BTCUSDC", S: "SELL", q: "1", ap: "65000", T: 1 } }, "binance-usdt"), null,
    "USDC-quoted symbol refused by the USDT source label");

  const inv = normalizeBinanceForce({ o: { s: "BTCUSD_PERP", S: "SELL", q: "12", ap: "65000", T: 1 } }, "binance-inverse", new Map([["BTCUSD_PERP", 100]]));
  assert.ok(Math.abs(inv.sizeUsd - 1200) < 1e-9, "inverse notional = contracts × $100");
  assert.equal(inv.quote, "USD");

  const invAlt = normalizeBinanceForce({ o: { s: "ETHUSD_PERP", S: "SELL", q: "5", ap: "3000", T: 1 } }, "binance-inverse");
  assert.ok(Math.abs(invAlt.sizeUsd - 50) < 1e-9, "no contract map → documented fallback $10 for alts");

  const invBtc = normalizeBinanceForce({ o: { s: "BTCUSD_PERP", S: "SELL", q: "5", ap: "65000", T: 1 } }, "binance-inverse");
  assert.ok(Math.abs(invBtc.sizeUsd - 500) < 1e-9, "no contract map → documented fallback $100 for BTC");
});

await test("normalizeOkxLiq: ctVal contract math, live-verified figures", () => {
  const ctVals = new Map([
    ["BTC-USDT-SWAP", { ctVal: 0.01, linear: true }],
    ["BTC-USD-SWAP", { ctVal: 100, linear: false }],
  ]);
  const msg = {
    arg: { channel: "liquidation-orders", instType: "SWAP" },
    data: [
      { instId: "BTC-USDT-SWAP", details: [{ side: "sell", sz: "25", bkPx: "65000", ts: "1700000000000" }] },
      { instId: "BTC-USD-SWAP", details: [{ side: "buy", sz: "40", bkPx: "65000", ts: "1700000000001" }] },
    ],
  };
  const out = normalizeOkxLiq(msg, ctVals);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, "okx-usdt");
  assert.ok(Math.abs(out[0].sizeUsd - 25 * 0.01 * 65000) < 1e-6, "linear notional = sz × ctVal × price");
  assert.equal(out[0].side, "long", "sell = fade long");
  assert.equal(out[1].source, "okx-inverse");
  assert.ok(Math.abs(out[1].sizeUsd - 4000) < 1e-9, "inverse notional = sz × ctVal (USD)");
  assert.equal(out[1].side, "short", "buy = fade short");

  const malformedSide = normalizeOkxLiq({
    data: [{
      instId: "BTC-USDT-SWAP", details: [
        { sz: "2", bkPx: "65000", ts: "1" },
        { side: "close", sz: "2", bkPx: "65000", ts: "2" },
      ],
    }],
  }, ctVals);
  assert.equal(malformedSide.length, 0, "missing/unknown OKX sides are dropped, never coerced to short");

  const dropped = normalizeOkxLiq({ data: [{ instId: "BTC-USDC-SWAP", details: [{ side: "sell", sz: "3", bkPx: "65000", ts: "1" }] }] }, new Map());
  assert.equal(dropped.length, 0, "unknown ctVal → event dropped, never guessed at ×1");

  const usdc = normalizeOkxLiq(
    { data: [{ instId: "BTC-USDC-SWAP", details: [{ side: "sell", sz: "3", bkPx: "65000", ts: "1" }] }] },
    new Map([["BTC-USDC-SWAP", { ctVal: 0.01, linear: true }]]),
  );
  assert.equal(usdc[0].source, "okx-usdc", "a USDC swap (if OKX ever lists one) classifies okx-usdc");
});

await test("normalizeBybitLiq: USDT/USDC/inverse, position-side convention", () => {
  const usdt = normalizeBybitLiq({ s: "BTCUSDT", S: "Sell", p: "65000", v: "0.2", T: 1_700_000_000_000 }, "bybit-usdt");
  assert.equal(usdt.side, "short", "S=Sell → a short died → fade short");
  assert.ok(Math.abs(usdt.sizeUsd - 0.2 * 65000) < 1e-9, "linear notional = v × p");

  const usdc = normalizeBybitLiq({ s: "BTCPERP", S: "Buy", p: "65000", v: "0.5", T: 1_700_000_000_000 }, "bybit-usdc");
  assert.equal(usdc.base, "BTC");
  assert.equal(usdc.side, "long", "S=Buy → a long died → fade long (Bybit names the POSITION side)");
  assert.ok(Math.abs(usdc.sizeUsd - 32_500) < 1e-9, "linear notional = v × p");

  const inv = normalizeBybitLiq({ s: "BTCUSD", S: "Sell", p: "65000", v: "5000", T: 1 }, "bybit-inverse");
  assert.ok(Math.abs(inv.sizeUsd - 5000) < 1e-9, "inverse notional = v (contracts ARE dollars)");
  assert.equal(inv.side, "short", "inverse fade side from S=Sell");

  assert.equal(normalizeBybitLiq({ s: "BTCUSDT", S: "Whatever", p: "65000", v: "1", T: 1 }, "bybit-usdt"), null,
    "an unknown side is dropped, never coerced to a direction nobody published");
  assert.equal(normalizeBybitLiq({ s: "BTCUSDT", S: "Buy", p: "0", v: "1", T: 1 }, "bybit-usdt"), null,
    "a non-positive price is refused");
  assert.equal(normalizeBybitLiq({ s: "NOTAPAIR", S: "Buy", p: "1", v: "1", T: 1 }, "bybit-usdt"), null,
    "an unparseable symbol is refused");
});

summary("liq-sources");
