// src/marketcap/exchanges.ts
// THE EXCHANGE IS THE AUTHORITY ON WHICH PAIRS EXIST. This file asks it, and
// keeps its answer as raw evidence.
//
// ── THE BASE FIELD IS EVIDENCE, NOT A DERIVATION ────────────────────────────
// It would be one line to take the base as `symbol.replace(/USDT$/, "")`. Do
// not: it invents a base for every instrument whose symbol is not spelled that
// way, it is wrong the moment a venue lists a USDC-settled book with a USDT
// name, and — the part that actually bites — it is EXACTLY THE JOIN KEY the
// provider's pair map uses. Joining on a string we made up instead of the one
// the exchange published is how a mapping quietly matches the wrong coin.
// Every parser below therefore reads the venue's own base/quote fields and a
// row that does not carry them is dropped rather than guessed at.
//
// ── AND ONE PAGE IS NOT A CATALOGUE ─────────────────────────────────────────
// Bybit lists well over 500 linear perps and its instruments-info answers 1000
// per page with a `nextPageCursor`; taking the first page and stopping would
// silently truncate the universe, which reads downstream as "those pairs no
// longer exist". The cursor is followed to exhaustion, bounded, and a venue
// that keeps handing back cursors is refused rather than looped on.
import type { FetchLike } from "../candles/venues.js";
import type { ExchangeInstrument } from "./identity.js";
import type { MarketCapVenueId } from "./venues.js";

/** Rows arrive as `unknown`; a field that is not a non-empty string is absent,
 *  and absent is never filled in. */
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface InstrumentCatalogue {
  venue: MarketCapVenueId;
  instruments: ExchangeInstrument[];
  /** Rows the venue published that this parser could not use, counted so a
   *  catalogue that starts arriving in a new shape is visible as a number
   *  rather than as pairs quietly vanishing. */
  unparsed: number;
}

// ── BYBIT ───────────────────────────────────────────────────────────────────
// GET /v5/market/instruments-info?category=linear&status=Trading&limit=1000,
// following nextPageCursor. Kept: status Trading, contractType LinearPerpetual,
// quoteCoin USDT, settleCoin USDT — all four from the venue's own fields.
export function parseBybitInstruments(body: unknown): { instruments: ExchangeInstrument[]; cursor: string; unparsed: number } {
  const b = body as { result?: { list?: unknown[]; nextPageCursor?: unknown } };
  const instruments: ExchangeInstrument[] = [];
  let unparsed = 0;
  for (const raw of asArray(b?.result?.list)) {
    const r = raw as Record<string, unknown>;
    const symbol = str(r.symbol);
    const base = str(r.baseCoin);
    const quote = str(r.quoteCoin);
    const settle = str(r.settleCoin);
    const status = str(r.status);
    const contractType = str(r.contractType);
    if (!symbol || !base || !quote) {
      unparsed++;
      continue;
    }
    if (quote !== "USDT" || settle !== "USDT" || contractType !== "LinearPerpetual") continue;
    instruments.push({ venue: "bybit", symbol, base, quote, settle, status, contractType, active: status === "Trading" });
  }
  return { instruments, cursor: str(b?.result?.nextPageCursor), unparsed };
}

// ── ASTER ───────────────────────────────────────────────────────────────────
// GET /fapi/v3/exchangeInfo — no pagination. PERPETUAL strictly: a
// PENDING_TRADING row on this venue carries an EMPTY contractType, and
// admitting an untyped row would admit a dated future the day one is listed.
export function parseAsterInstruments(body: unknown): { instruments: ExchangeInstrument[]; unparsed: number } {
  const instruments: ExchangeInstrument[] = [];
  let unparsed = 0;
  for (const raw of asArray((body as { symbols?: unknown[] })?.symbols)) {
    const r = raw as Record<string, unknown>;
    const symbol = str(r.symbol);
    const base = str(r.baseAsset);
    const quote = str(r.quoteAsset);
    const status = str(r.status);
    const contractType = str(r.contractType);
    if (!symbol || !base || !quote) {
      unparsed++;
      continue;
    }
    if (quote !== "USDT" || contractType !== "PERPETUAL") continue;
    instruments.push({
      venue: "aster", symbol, base, quote,
      settle: str(r.marginAsset) || quote,
      status, contractType, active: status === "TRADING",
    });
  }
  return { instruments, unparsed };
}

// ── BITGET ──────────────────────────────────────────────────────────────────
// GET /api/v2/mix/market/contracts?productType=usdt-futures. `symbolStatus`
// "normal" is trading; anything else (limit_open, restrictedAPI, off) is listed
// and not API-tradeable, so it stays in the catalogue and is not active.
export function parseBitgetInstruments(body: unknown): { instruments: ExchangeInstrument[]; unparsed: number } {
  const instruments: ExchangeInstrument[] = [];
  let unparsed = 0;
  for (const raw of asArray((body as { data?: unknown[] })?.data)) {
    const r = raw as Record<string, unknown>;
    const symbol = str(r.symbol);
    const base = str(r.baseCoin);
    const quote = str(r.quoteCoin);
    const status = str(r.symbolStatus);
    const contractType = str(r.symbolType) || str(r.futureType);
    if (!symbol || !base || !quote) {
      unparsed++;
      continue;
    }
    if (quote !== "USDT") continue;
    if (contractType && contractType !== "perpetual") continue;
    instruments.push({ venue: "bitget", symbol, base, quote, settle: quote, status, contractType, active: status === "normal" });
  }
  return { instruments, unparsed };
}

// ── BITUNIX ─────────────────────────────────────────────────────────────────
// GET /api/v1/futures/market/trading_pairs. OPEN is trading; PREVIEW is an
// announced listing with nothing behind it yet — tracked, never active.
export function parseBitunixInstruments(body: unknown): { instruments: ExchangeInstrument[]; unparsed: number } {
  const instruments: ExchangeInstrument[] = [];
  let unparsed = 0;
  for (const raw of asArray((body as { data?: unknown[] })?.data)) {
    const r = raw as Record<string, unknown>;
    const symbol = str(r.symbol);
    const base = str(r.base) || str(r.baseCoin);
    const quote = str(r.quote) || str(r.quoteCoin);
    const status = str(r.symbolStatus);
    if (!symbol || !base || !quote) {
      unparsed++;
      continue;
    }
    if (quote !== "USDT") continue;
    instruments.push({ venue: "bitunix", symbol, base, quote, settle: quote, status, contractType: "perpetual", active: status === "OPEN" });
  }
  return { instruments, unparsed };
}

async function getJson(fetchLike: FetchLike, url: string): Promise<unknown> {
  const res = await fetchLike(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const BYBIT_MAX_PAGES = 20;

export async function fetchInstruments(venue: MarketCapVenueId, fetchLike: FetchLike): Promise<InstrumentCatalogue> {
  switch (venue) {
    case "bybit": {
      const instruments: ExchangeInstrument[] = [];
      let unparsed = 0;
      let cursor = "";
      for (let page = 0; page < BYBIT_MAX_PAGES; page++) {
        const url = "https://api.bybit.com/v5/market/instruments-info?category=linear&status=Trading&limit=1000"
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        const r = parseBybitInstruments(await getJson(fetchLike, url));
        instruments.push(...r.instruments);
        unparsed += r.unparsed;
        cursor = r.cursor;
        if (!cursor) return { venue, instruments, unparsed };
      }
      // Bounded, and the bound is a REFUSAL rather than a truncation: a partial
      // catalogue published as a whole one is exactly the failure that makes
      // hundreds of live pairs look delisted.
      throw new Error(`bybit instruments-info kept returning a cursor after ${BYBIT_MAX_PAGES} pages`);
    }
    case "aster": {
      const r = parseAsterInstruments(await getJson(fetchLike, "https://fapi.asterdex.com/fapi/v3/exchangeInfo"));
      return { venue, ...r };
    }
    case "bitget": {
      const r = parseBitgetInstruments(await getJson(fetchLike, "https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures"));
      return { venue, ...r };
    }
    case "bitunix": {
      const r = parseBitunixInstruments(await getJson(fetchLike, "https://fapi.bitunix.com/api/v1/futures/market/trading_pairs"));
      return { venue, ...r };
    }
    default: {
      const never: never = venue;
      throw new Error(`no instrument source for ${String(never)}`);
    }
  }
}

export interface CatalogueVerdict {
  ok: boolean;
  reason: string | null;
  active: number;
  previousActive: number;
  overlap: number;
}

/** How far a catalogue may move in one refresh before we refuse to believe it.
 *  A venue that answers a truncated page, or a parser reading a reshaped
 *  response, both look exactly like a mass delisting — and a mass delisting is
 *  the one event that would make this producer publish hundreds of unmapped
 *  rows in a single pass. */
export const CATALOGUE_MIN_RETENTION = 0.8;
export const CATALOGUE_MIN_OVERLAP = 0.9;

/** Compare a fresh catalogue against the last good one. First-ever catalogue
 *  passes (there is nothing to compare it to, and refusing it would mean the
 *  service could never start). */
export function catalogueSanity(previous: readonly ExchangeInstrument[] | null, next: readonly ExchangeInstrument[]): CatalogueVerdict {
  const active = next.filter((i) => i.active).length;
  if (!previous || !previous.length) {
    return {
      ok: active > 0,
      reason: active > 0 ? null : "the venue's first catalogue contained no active instruments at all",
      active, previousActive: 0, overlap: 0,
    };
  }
  const prevActive = previous.filter((i) => i.active);
  const nextSymbols = new Set(next.filter((i) => i.active).map((i) => i.symbol));
  const kept = prevActive.filter((i) => nextSymbols.has(i.symbol)).length;
  const overlap = prevActive.length ? kept / prevActive.length : 1;
  const retention = prevActive.length ? active / prevActive.length : 1;
  if (retention < CATALOGUE_MIN_RETENTION) {
    return {
      ok: false,
      reason: `catalogue collapsed: ${active} active instruments against ${prevActive.length} last time `
        + `(${Math.round(retention * 100)}%, floor ${Math.round(CATALOGUE_MIN_RETENTION * 100)}%)`,
      active, previousActive: prevActive.length, overlap,
    };
  }
  if (overlap < CATALOGUE_MIN_OVERLAP) {
    return {
      ok: false,
      reason: `catalogue overlap is ${Math.round(overlap * 100)}% against last time (floor ${Math.round(CATALOGUE_MIN_OVERLAP * 100)}%) — `
        + "the symbols changed identity rather than the list merely growing",
      active, previousActive: prevActive.length, overlap,
    };
  }
  return { ok: true, reason: null, active, previousActive: prevActive.length, overlap };
}
