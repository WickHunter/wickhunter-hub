// src/candles/seed.ts
// Builds and SIGNS the /api/candles/seed payload. Wire contract v1 — pinned,
// exactly like the LHK1 licence format: the bot is built against these bytes,
// so any change needs a v:2, never a mutation of v:1.
//
// ── THE HUB IS A SEED, NEVER A SOURCE OF TRUTH ──────────────────────────────
// The bot re-checks this payload against the venue before trusting it and
// throws the whole seed away on any mismatch. Everything below is written so
// that the check passes because the data is RIGHT — never because it is vague.
// In particular nothing here rounds, resamples, back-fills, interpolates or
// "repairs" a candle: a minute we do not hold is reported as a gap, not
// smoothed over with its neighbours.
import type { CandleStore, Gap, Row } from "./store.js";
import { MINUTE_MS, floorMinute } from "./store.js";
import type { VenueId } from "./venues.js";

/** Contract v1: 1-minute candles, and the string "1" is what goes on the wire. */
export const SEED_WIRE_VERSION = 1;
export const SEED_INTERVAL = "1";

/** The unsigned payload, in the PINNED CANONICAL KEY ORDER. */
export interface SeedUnsigned {
  v: number;
  venue: VenueId;
  symbol: string;
  interval: string;
  fromMs: number;
  toMs: number;
  lastClosedMs: number;
  rows: Row[];
  gaps: Gap[];
  keyId: string;
}

export interface SeedSigned extends SeedUnsigned {
  sig: string;
}

// ── CANONICAL BYTES FOR THE SIGNATURE ───────────────────────────────────────
//
//   sig = Ed25519( UTF-8 JSON of the payload with `sig` REMOVED and the keys
//                  serialised in EXACTLY this order:
//
//        v, venue, symbol, interval, fromMs, toMs, lastClosedMs, rows, gaps, keyId
//
// The verifier must reproduce those bytes byte-for-byte or every signature
// fails, so the order is not a stylistic choice and must never be "tidied"
// alphabetically. It is enforced mechanically by `canonicalBytes` below, which
// builds a FRESH object literal in that order rather than re-serialising
// whatever object it was handed: JavaScript preserves object key insertion
// order through JSON.stringify, so writing the literal in order IS the
// canonicalisation. (Same technique, and the same reason, as the pinned v1 key
// order in license.ts.)
//
// No whitespace, no indentation, no trailing newline — plain JSON.stringify
// with no replacer and no space argument.
//
// Numbers are emitted by JSON.stringify's own double formatting, which is the
// shortest representation that round-trips to the same IEEE-754 double. Both
// sides are JavaScript and every candle field is stored as a float64 on the
// hub, so a value that survives JSON.parse re-serialises to identical bytes.
// This is exactly why the store keeps candles as binary doubles rather than the
// decimal STRINGS the venues send: "63990" and "63990.0" are the same number
// but different bytes, and only one of them can be the signed one.
export const SEED_CANONICAL_KEY_ORDER = [
  "v", "venue", "symbol", "interval", "fromMs", "toMs", "lastClosedMs", "rows", "gaps", "keyId",
] as const;

export function canonicalBytes(p: SeedUnsigned): Buffer {
  const ordered = {
    v: p.v,
    venue: p.venue,
    symbol: p.symbol,
    interval: p.interval,
    fromMs: p.fromMs,
    toMs: p.toMs,
    lastClosedMs: p.lastClosedMs,
    rows: p.rows,
    gaps: p.gaps,
    keyId: p.keyId,
  };
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

export type SeedOutcome =
  | { ok: true; payload: SeedSigned }
  /** 400 — the request itself is malformed. */
  | { ok: false; code: 400; error: string }
  /** 404 — this venue does not list that symbol. */
  | { ok: false; code: 404; error: string }
  /** 503 — the collector holds nothing we can serve for that window yet. */
  | { ok: false; code: 503; error: string };

export interface SeedRequest {
  venue: VenueId;
  symbol: string;
  fromMs: number;
  toMs: number;
}

export interface SeedDeps {
  store: CandleStore;
  keyId: string;
  sign(bytes: Buffer): Buffer;
  /** null when the venue lists the symbol, a reason string when it does not. */
  symbolKnown(venue: VenueId, symbol: string): boolean;
}

/** Largest window one response may carry. 30 days of 1m is 43,200 rows, which
 *  is the configured warm depth the bot asks for; the cap is set a little above
 *  that so a 30-day request is never the thing that trips it, while a request
 *  for a year cannot ask the hub to build a gigabyte in memory. */
export const SEED_MAX_ROWS = 50_000;

export function buildSeed(req: SeedRequest, deps: SeedDeps): SeedOutcome {
  const { venue, symbol, fromMs, toMs } = req;

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { ok: false, code: 400, error: "fromMs and toMs must be epoch-ms numbers" };
  }
  if (!Number.isInteger(fromMs) || !Number.isInteger(toMs) || fromMs < 0 || toMs < 0) {
    return { ok: false, code: 400, error: "fromMs and toMs must be non-negative integers" };
  }
  if (toMs < fromMs) {
    return { ok: false, code: 400, error: "toMs must be greater than or equal to fromMs" };
  }
  if ((toMs - fromMs) / MINUTE_MS > SEED_MAX_ROWS) {
    return { ok: false, code: 400, error: `window too large: at most ${SEED_MAX_ROWS} minutes per request` };
  }
  if (!deps.symbolKnown(venue, symbol)) {
    // 404, not 503: 503 says "ask me again later", and for a symbol this venue
    // does not list, later will not help.
    return { ok: false, code: 404, error: `symbol ${symbol} is not listed on ${venue}` };
  }

  // `lastClosedMs` is read off the DATA — the newest slot actually filled —
  // never off a collector cursor or a "we think we are caught up" flag. It is
  // the field the contract makes authoritative for how far the seed reaches, so
  // it has to be a measurement, not a belief.
  const coverage = deps.store.coverage(venue, symbol);
  if (coverage.lastClosedMs === null || coverage.firstClosedMs === null) {
    return { ok: false, code: 503, error: `collector has no data yet for ${venue} ${symbol}` };
  }

  // ── WHY THE WINDOW IS CLAMPED TO lastClosedMs ───────────────────────────
  // Gaps mean "missing history inside the window that we could not fill". The
  // stretch of a window that lies AFTER our newest closed candle is not missing
  // history — it is time that has not happened, or has not been collected yet,
  // and `lastClosedMs` states precisely where we stop. Reporting it as a gap
  // would put an unfillable gap on every single response and train the reader
  // to ignore the field that carries the real ones.
  const scanTo = Math.min(floorMinute(toMs), coverage.lastClosedMs);
  const { rows, gaps } = deps.store.readWindow(venue, symbol, fromMs, scanTo);

  // ── NEVER 200 WITH EMPTY ROWS ───────────────────────────────────────────
  // The contract forbids it, because "I hold nothing" and "this window is
  // genuinely empty" would become the same answer. A window entirely before we
  // began collecting the pair lands here, and 503 is the honest reply: come
  // back, the collector may have backfilled it by then.
  if (rows.length === 0) {
    return { ok: false, code: 503, error: `no closed candles held for ${venue} ${symbol} in the requested window` };
  }

  // ── THE NEW-LISTING TRAP ────────────────────────────────────────────────
  // A pair listed three hours ago genuinely has three hours of history. It is
  // served — with the leading absence stated as an explicit gap running from
  // the requested fromMs up to the minute before our first candle, so a 30-day
  // request against a 3-hour-old pair comes back carrying a 29.9-day gap that
  // the reader cannot miss and cannot mistake for completeness. That is the
  // whole point of `gaps` being explicit, and it is the incident this service
  // exists to make impossible: a thin history that LOOKS complete. `readWindow`
  // already emits that leading run, because absence is stored per minute rather
  // than inferred from how many rows came back.
  const payload: SeedUnsigned = {
    v: SEED_WIRE_VERSION,
    venue,
    symbol,
    interval: SEED_INTERVAL,
    fromMs,
    toMs,
    lastClosedMs: coverage.lastClosedMs,
    rows,
    gaps,
    keyId: deps.keyId,
  };
  const sig = deps.sign(canonicalBytes(payload)).toString("base64");
  // `sig` last: the wire object is the canonical object plus the signature.
  return { ok: true, payload: { ...payload, sig } };
}
