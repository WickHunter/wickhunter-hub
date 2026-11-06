// src/candles/bitunix-volume.ts
// v0.4.102 — WHICH BITUNIX FIELD IS BASE VOLUME, PROVED PER ROW.
//
// The store's volume column is BASE volume on every venue (store.ts layout).
// Until 0.4.101 the Bitunix REST readers stored `quoteVol`, on a 2026-08
// measurement that the venue's two fields were labelled the wrong way round.
// They are not any more: probed live 2026-10-30, BTCUSDT `baseVol` 28.2534 and
// `quoteVol` 2,185,328.73 at ~77,364, i.e. `baseVol` is coin quantity and
// `quoteVol` is the USDT turnover (the 2026-10-29 boundary capture in the app
// repo agrees on 1,920 of 1,920 linear rows). The public websocket's `b`/`q`
// have the same meaning, so the 0.4.101 Hub stored quote turnover from REST and
// base volume from the socket and its windows mixed units.
//
// The fix is not "read the other field". A venue that flipped once can flip
// again, so the base field is accepted only when the paired turnover agrees
// with it: base x [low, high] must bracket the quote turnover (within the two
// fields' own published precision). A row that fails is UNKNOWN — the caller
// refuses it; volume is never derived by dividing turnover by a price, and an
// unreadable volume never becomes zero. Same rule as the app's
// `bitunixBaseCandleVolume` (src/venues/bitunix-candle-volume.ts, 0.91.27).
//
// Coin-margined `…USD` contracts (DOGEUSD, XLMUSD, …) fail this check on every
// row: their `baseVol` is USD contracts and `quoteVol` is coin. The app does
// not trade them on this contract and the Hub no longer tracks them
// (venues.ts `listSymbols`).

function published(value: unknown): { value: number; halfUnit: number } | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  const match = /^(?:\d+(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) return null;
  const n = Number(raw);
  const decimals = (match[1] ?? match[2] ?? "").length;
  const halfUnit = 0.5 * 10 ** (Number(match[3] ?? 0) - decimals);
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(halfUnit)) return null;
  if (n === 0 && /[1-9]/.test(raw.split(/[eE]/)[0]!)) return null;
  return { value: n, halfUnit };
}

/** The base (coin) volume of one Bitunix candle, or null when it cannot be
 *  proven from the two published fields. Both zero is a real zero-volume bar;
 *  exactly one zero is a contradiction. */
export function bitunixBaseVolume(base: unknown, quote: unknown, low: unknown, high: unknown): number | null {
  const lo = typeof low === "number" ? low : Number(low);
  const hi = typeof high === "number" ? high : Number(high);
  const b = published(base), q = published(quote);
  if (!b || !q || !Number.isFinite(lo) || !Number.isFinite(hi) || !(lo > 0 && hi >= lo)) return null;
  if (b.value === 0 || q.value === 0) return b.value === 0 && q.value === 0 ? 0 : null;
  const minQuote = b.value * lo, maxQuote = b.value * hi;
  const tolerance = hi * b.halfUnit + q.halfUnit + Math.max(q.value, maxQuote) * Number.EPSILON * 16;
  if (![minQuote, maxQuote, tolerance].every(Number.isFinite)
    || q.value < minQuote - tolerance || q.value > maxQuote + tolerance) return null;
  return b.value;
}

/** Quote currencies the Hub collects on Bitunix: linear contracts, whose
 *  `baseVol` is coin quantity. `USD` (coin-margined) is deliberately absent. */
export const BITUNIX_LINEAR_QUOTES: ReadonlySet<string> = new Set(["USDT", "USDC"]);

/** The on-disk marker that says every Bitunix row under this data dir was
 *  written under the base-volume contract. See service.ts. */
export const BITUNIX_VOLUME_CONTRACT = "bitunix-base-volume-v1";

/** v0.4.102 — a venue page refused because a row's volume units could not be
 *  proven. Typed, so the collector backs off that SYMBOL (and counts it in
 *  health) instead of treating it as a transient request failure that the
 *  next symbol's success silently resets. */
export class UnprovableVolumeError extends Error {
  readonly unprovableVolume = true;
  constructor(message: string) {
    super(message);
    this.name = "UnprovableVolumeError";
  }
}

export function isUnprovableVolume(err: unknown): err is UnprovableVolumeError {
  return !!err && typeof err === "object" && (err as UnprovableVolumeError).unprovableVolume === true;
}
