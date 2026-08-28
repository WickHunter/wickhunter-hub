// The market-cap producer has its own explicitly verified exchange catalogue.
// Do not reuse the candle venue registry here: adding a free public candle
// source must never start spending paid provider credits for a new exchange.
import type { VenueId } from "../candles/venues.js";

export const MARKET_CAP_VENUE_IDS = ["bybit", "bitunix", "bitget", "aster"] as const satisfies readonly VenueId[];
export type MarketCapVenueId = (typeof MARKET_CAP_VENUE_IDS)[number];

export function isMarketCapVenueId(v: unknown): v is MarketCapVenueId {
  return typeof v === "string" && (MARKET_CAP_VENUE_IDS as readonly string[]).includes(v);
}
