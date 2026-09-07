// src/liq/sources.ts
// Pure normalizers for the eight liquidation feeds the bot itself listens to
// (`src/liq/hub.ts` in the liqhunter repo — LIQ_SOURCES). Ported so the hub
// records the SAME identity of print the bot would, keyed by the SAME source
// ids: a percentile table built here must join cleanly onto a bot's own
// (source, symbol, side) lookups with no translation layer in between.
//
// ── WIRE FACTS (carried over from the bot's own header, 2026-07-24) ────────
//  · Bybit allLiquidation `S` names the LIQUIDATED POSITION side ('Buy' = a
//    long died). USDC perps ride the same linear stream as USDT; inverse has
//    its own endpoint.
//  · Binance !forceOrder@arr `o.S` is the ORDER side (SELL order = a long
//    died). Sampled since 2021: at most one event per symbol per second, so
//    per-event sizes understate a cascade.
//  · OKX liquidation-orders (public WS) publishes RECENT SWAP liquidation
//    orders on one channel; OKX explicitly says this is not total coverage.
//    `details[].side` is the order side; `sz` is in CONTRACTS — notional needs
//    `ctVal` from the public instruments endpoint.
//
// This module is deliberately dependency-free (this repo ships zero runtime
// dependencies) and network-free: every function here is total over a parsed
// JSON payload, so the connection layer (`stream-runner.ts`) can be tested
// without a socket and these can be tested without either.

export type LiqSourceId =
  | "bybit-usdt" | "bybit-usdc" | "bybit-inverse"
  | "binance-usdt" | "binance-inverse"
  | "okx-usdt" | "okx-usdc" | "okx-inverse";

export const LIQ_SOURCES: Array<{ id: LiqSourceId; label: string; group: string }> = [
  { id: "bybit-usdt", label: "Bybit USDT Perps", group: "Bybit" },
  { id: "bybit-usdc", label: "Bybit USDC Perps", group: "Bybit" },
  { id: "bybit-inverse", label: "Bybit Inverse Perps", group: "Bybit" },
  { id: "binance-usdt", label: "Binance USDT Perps", group: "Binance" },
  { id: "binance-inverse", label: "Binance Inverse Perps", group: "Binance" },
  { id: "okx-usdt", label: "OKX USDT Perps", group: "OKX" },
  { id: "okx-usdc", label: "OKX USDC Perps", group: "OKX" },
  { id: "okx-inverse", label: "OKX Inverse Perps", group: "OKX" },
];
export const LIQ_SOURCE_IDS = LIQ_SOURCES.map((s) => s.id);

export function isLiqSourceId(v: unknown): v is LiqSourceId {
  return typeof v === "string" && (LIQ_SOURCE_IDS as readonly string[]).includes(v);
}

/** A raw, normalized liquidation print — the shape recorded to disk, one row
 *  per physical event. `nativeSymbol` is the venue's own spelling, never
 *  canonicalised: a percentile table is joined by (source, native symbol,
 *  side), exactly what a deal bot's own history was traded under. */
export interface RawLiq {
  source: LiqSourceId;
  base: string;
  quote: string;
  nativeSymbol: string;
  side: "long" | "short";
  price: number;
  sizeUsd: number;
  ts: number;
}

/** Venue-native base ticker → canonical. Kept to the same tiny alias table the
 *  bot's `symbol-alias.ts` carries — XBT/XDG are the only two coins any wired
 *  venue spells differently, and this is DATA, not a decision, so drift here
 *  would silently split one coin's liquidation history into two rows. */
const BASE_ALIASES: Readonly<Record<string, string>> = { XBT: "BTC", XDG: "DOGE" };
export function canonicalBase(base: string): string {
  if (!base) return base;
  const b = base.toUpperCase();
  return BASE_ALIASES[b] ?? b;
}

/** BTCUSDT→BTC/USDT · BTCUSDC→BTC/USDC · BTCPERP→BTC/USDC · BTCUSD→BTC/USD ·
 *  BTCUSD_PERP→BTC/USD · BTC-USDT-SWAP→BTC/USDT. Null when unparseable. */
export function baseQuoteOf(symbol: string): { base: string; quote: string } | null {
  const s = String(symbol ?? "").toUpperCase().replace(/_PERP$/, "").replace(/-SWAP$/, "").replace(/-/g, "");
  const mk = (b: string, quote: string) => (b ? { base: canonicalBase(b), quote } : null);
  if (s.endsWith("USDT")) return mk(s.slice(0, -4), "USDT");
  if (s.endsWith("USDC")) return mk(s.slice(0, -4), "USDC");
  if (s.endsWith("PERP")) return mk(s.slice(0, -4), "USDC");
  if (s.endsWith("USD")) return mk(s.slice(0, -3), "USD");
  return null;
}

/** Bybit names the LIQUIDATED position's side; the fade side IS that side. */
function fadeSideFromLiq(bybitS: "Buy" | "Sell"): "long" | "short" {
  return bybitS === "Buy" ? "long" : "short";
}

/** Bybit `allLiquidation.{symbol}` row (dedicated USDT/USDC/inverse streams).
 *  Inverse `v` is CONTRACTS (1 contract = 1 USD) so sizeUsd = v directly;
 *  linear/USDC `v` is base qty (sizeUsd = v×p). */
export function normalizeBybitLiq(row: unknown, source: "bybit-usdt" | "bybit-usdc" | "bybit-inverse"): RawLiq | null {
  const r = row as Record<string, unknown> | null;
  const sym = String(r?.s ?? "");
  const bq = baseQuoteOf(sym);
  if (!sym || !bq) return null;
  const price = parseFloat(String(r?.p ?? "0"));
  const v = parseFloat(String(r?.v ?? "0"));
  if (!(price > 0) || !(v > 0)) return null;
  const S = String(r?.S ?? "");
  // An unknown side is never coerced to a direction nobody published.
  if (S !== "Buy" && S !== "Sell") return null;
  return {
    source, base: bq.base, quote: bq.quote, nativeSymbol: sym,
    side: fadeSideFromLiq(S),
    price, sizeUsd: source === "bybit-inverse" ? v : v * price,
    ts: Number(r?.T ?? Date.now()),
  };
}

/** Binance `!forceOrder@arr` payload → RawLiq. Handles USDT-M (qty in base)
 *  and coin-M (qty in contracts × contractSize USD). `o.S` is the ORDER side:
 *  SELL = a long was liquidated = we fade LONG. */
export function normalizeBinanceForce(
  msg: unknown, source: "binance-usdt" | "binance-inverse", contractSizes?: ReadonlyMap<string, number>,
): RawLiq | null {
  const m = msg as { o?: Record<string, unknown>; E?: unknown } | null;
  const o = m?.o ?? (m as Record<string, unknown> | null) ?? {};
  const sym = String((o as Record<string, unknown>)?.s ?? "");
  const bq = baseQuoteOf(sym);
  if (!sym || !bq) return null;
  if (source === "binance-usdt" && bq.quote !== "USDT") return null;
  if (source === "binance-inverse" && bq.quote !== "USD") return null;
  const qty = parseFloat(String((o as Record<string, unknown>)?.q ?? "0"));
  const price = parseFloat(String((o as Record<string, unknown>)?.ap ?? (o as Record<string, unknown>)?.p ?? "0"));
  if (!(qty > 0) || !(price > 0)) return null;
  const orderSide = String((o as Record<string, unknown>)?.S ?? "").toUpperCase();
  if (orderSide !== "BUY" && orderSide !== "SELL") return null;
  const sizeUsd = source === "binance-inverse"
    ? qty * (contractSizes?.get(sym) ?? (bq.base === "BTC" ? 100 : 10)) // contracts are USD-denominated
    : qty * price;
  return {
    source, base: bq.base, quote: bq.quote, nativeSymbol: sym,
    side: orderSide === "SELL" ? "long" : "short",
    price, sizeUsd, ts: Number((o as Record<string, unknown>)?.T ?? m?.E ?? Date.now()),
  };
}

/** OKX `liquidation-orders` push → RawLiq[]. `sz` is CONTRACTS; linear ctVal
 *  is base units (notional = sz×ctVal×price), inverse ctVal is USD (notional
 *  = sz×ctVal). `details[].side` is the order side (sell = fade long). */
export function normalizeOkxLiq(
  msg: unknown, ctVals: ReadonlyMap<string, { ctVal: number; linear: boolean }>,
): RawLiq[] {
  const out: RawLiq[] = [];
  const rows = (msg as { data?: unknown[] } | null)?.data ?? [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const instId = String(r?.instId ?? "");
    const bq = baseQuoteOf(instId);
    if (!instId || !bq) continue;
    const source: LiqSourceId = bq.quote === "USDT" ? "okx-usdt" : bq.quote === "USDC" ? "okx-usdc" : "okx-inverse";
    // NEVER default ctVal to 1: until the instruments load succeeds, DROP the
    // event rather than emit a garbage notional — a missing print is honest,
    // a phantom whale is not.
    const cv = ctVals.get(instId);
    if (!cv) continue;
    const details = (r?.details as unknown[] | undefined) ?? [];
    for (const raw of details) {
      const d = raw as Record<string, unknown>;
      const sz = parseFloat(String(d?.sz ?? "0"));
      const price = parseFloat(String(d?.bkPx ?? d?.px ?? "0"));
      if (!(sz > 0) || !(price > 0)) continue;
      const orderSide = String(d?.side ?? "").toLowerCase();
      if (orderSide !== "buy" && orderSide !== "sell") continue;
      const sizeUsd = cv.linear ? sz * cv.ctVal * price : sz * cv.ctVal;
      out.push({
        source, base: bq.base, quote: bq.quote, nativeSymbol: instId,
        side: orderSide === "sell" ? "long" : "short",
        price, sizeUsd, ts: Number(d?.ts ?? Date.now()),
      });
    }
  }
  return out;
}
