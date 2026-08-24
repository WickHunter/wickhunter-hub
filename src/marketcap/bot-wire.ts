// src/marketcap/bot-wire.ts
// THE SHAPE THE BOT ACTUALLY VALIDATES.
//
// ── ⚠ WHY THIS FILE EXISTS ─────────────────────────────────────────────────
//
// The producer and the consumer were built independently and never agreed on a
// wire format. An operator enabled the producer — 2707 instruments, published,
// signature verifying — and the bot refused every snapshot with:
//
//     "it could not be read from the hub (generatedAtMs is not a finite number)"
//
// That is the FIRST field the bot checks. Behind it the two shapes diverge
// almost everywhere: `generatedAt`/`expiresAt` vs `generatedAtMs`/`expiresAtMs`,
// a FLAT instrument row vs one with a nested `cap{}`, a coverage census of a
// completely different shape, and two different vocabularies for identity.
//
// ── THE RULE: ADD, NEVER RENAME ────────────────────────────────────────────
//
// ⚠ THE BOT TOLERATES UNKNOWN FIELDS AT EVERY LEVEL — proven both by reading
// its validator (it reads six named top-level keys and never enumerates
// `Object.keys`) and by feeding it an envelope carrying every hub extra plus a
// junk key, which it ACCEPTED. And `marketCapSignedBytes` copies every own
// enumerable key except `signatures`, so the extras are INSIDE the signature
// rather than ignored by it.
//
// So the hub emits the bot's names BESIDE its own and removes nothing. A pure
// rename would break `service.ts` (republish-on-near-expiry reads `expiresAt`),
// `snapshot.ts`'s own `verifySnapshot`, and the admin page. Two names for one
// fact is a cost; a broken producer is a bigger one, and the alternative is a
// fleet-wide bot deploy to change a field name.
//
// ── ⚠ THE ENUMS ARE WHERE THIS GOES SILENTLY WRONG ─────────────────────────
//
// The bot's `mappingStatus` is "resolved" | "ambiguous" | "unmapped". The hub's
// `IdentityState` is "mapped" | "ambiguous" | "provider_untracked" |
// "not_applicable". Only ONE spelling is shared. An unmapped value does not
// throw anywhere — it lands in a row the bot then judges, so getting this wrong
// filters pairs on a status nobody wrote.
//
// The cap statuses DO already share their six spellings; the work there is the
// NULL, which the hub uses for "identity never got far enough to ask".

import type { InstrumentRow, SnapshotUnsigned, SnapshotCoverage } from "./snapshot.js";
import type { AssetRow } from "./snapshot.js";

/** The bot's `MarketCapMappingStatus`. */
export type BotMappingStatus = "resolved" | "ambiguous" | "unmapped";
/** The bot's `MarketCapStatus`. */
export type BotCapStatus = "verified" | "fallback" | "missing" | "disputed" | "stale" | "not_applicable";

/** ⚠ THE ORDER AND SPELLING ARE THE BOT'S, and its coverage invariant sums over
 *  exactly this list. A status the bot does not know is not merely unrecognised
 *  — it makes the census disagree with the rows and the WHOLE SNAPSHOT is
 *  refused. */
export const BOT_CAP_STATUSES: readonly BotCapStatus[] =
  ["verified", "fallback", "missing", "disputed", "stale", "not_applicable"];

/** IDENTITY STATE → THE BOT'S MAPPING STATUS.
 *
 *  ⚠ `not_applicable` MAPS TO `resolved`, WHICH LOOKS WRONG AND IS NOT. The
 *  identity WAS resolved — we know the instrument tracks an RWA, an index or a
 *  commodity and therefore has no coin to capitalise. That fact travels in the
 *  CAP status, which is `not_applicable`. Mapping it to "unmapped" would claim
 *  we failed to identify something we identified precisely. */
export function botMappingStatus(state: InstrumentRow["identity"]): BotMappingStatus {
  switch (state) {
    case "mapped": return "resolved";
    case "not_applicable": return "resolved";
    case "ambiguous": return "ambiguous";
    case "provider_untracked": return "unmapped";
    default: {
      // An exhaustive switch with no `default:` would be better, but this
      // function is fed a value that crosses a repo boundary. Anything new is
      // "unmapped": the honest reading of a state this build does not know is
      // that it did not resolve, and it is the one value that cannot claim a
      // figure is trustworthy.
      const never: never = state;
      void never;
      return "unmapped";
    }
  }
}

/** CAP STATUS → THE BOT'S CAP STATUS.
 *
 *  ⚠ THE NULL IS THE WHOLE JOB. The hub writes `capStatus: null` when identity
 *  never got far enough to ask for a figure. The bot has no null: every row
 *  carries one of six words, and the census counts them. `missing` is the only
 *  honest bucket — the bot documents it as "the provider does not track this
 *  asset", which is exactly what an unresolved identity amounts to from the
 *  consumer's side, and the row's own `reason` carries the real sentence. */
export function botCapStatus(capStatus: InstrumentRow["capStatus"]): BotCapStatus {
  if (capStatus === null || capStatus === undefined) return "missing";
  return BOT_CAP_STATUSES.includes(capStatus as BotCapStatus) ? (capStatus as BotCapStatus) : "missing";
}

export interface BotInstrument {
  venue: string;
  symbol: string;
  base: string | null;
  asset: string | null;
  providerId: string | null;
  mappingSource: string;
  mappingStatus: BotMappingStatus;
  mappingNote: string | null;
  cap: {
    status: BotCapStatus;
    marketCapUsd: string | null;
    provider: string | null;
    asOfMs: number | null;
    reason: string | null;
    assetClass: string | null;
    disputed: Array<{ provider: string; marketCapUsd: string | null; asOfMs: number | null }>;
  };
}

/** ⚠ `unitMultiplier` IS DELIBERATELY NOT EMITTED. The bot defaults it to 1 when
 *  absent, and the hub's only related field is `multiplierSuggestion`, whose own
 *  comment calls it "review-only ticker reading; never used to resolve
 *  anything". Publishing a suggestion into a field the bot documents as
 *  "evidence that the identity was resolved rather than guessed" would turn a
 *  hint into a claim. Absent is honest; a wrong multiplier is not — and it
 *  scales nothing either way, on either side. */
export function botInstrument(r: InstrumentRow, assets: ReadonlyMap<number, AssetRow>): BotInstrument {
  const fact = r.cryptoId === null || r.cryptoId === undefined ? undefined : assets.get(r.cryptoId);
  return {
    venue: r.venue,
    symbol: r.symbol,
    base: r.exchangeBase ?? null,
    asset: r.cryptoSymbol ?? null,
    // The bot types this as a string; the hub holds a numeric provider id.
    // `String(0)` is "0", so the null check is explicit rather than falsy.
    providerId: r.cryptoId === null || r.cryptoId === undefined ? null : String(r.cryptoId),
    mappingSource: r.identitySource ?? "unknown",
    mappingStatus: botMappingStatus(r.identity),
    // A mapped row has nothing to explain; anything else carries its reason.
    mappingNote: r.identity === "mapped" ? null : (r.reason ?? null),
    cap: {
      status: botCapStatus(r.capStatus),
      marketCapUsd: r.marketCapUsd ?? null,
      provider: fact?.source ?? null,
      asOfMs: typeof fact?.providerLastUpdated === "number" ? fact.providerLastUpdated : null,
      reason: r.reason ?? null,
      // Neither is produced by this hub today. NULL and [] are the bot's own
      // "not known" and "none", never invented values.
      assetClass: null,
      disputed: [],
    },
  };
}

export interface BotCoverage {
  activeInstruments: number;
  byStatus: Record<BotCapStatus, number>;
}

/** ⚠ COUNTED OVER THE ROWS ACTUALLY EMITTED, BY THE STATUS ACTUALLY EMITTED.
 *
 *  The bot re-derives this census from the rows it received and REFUSES THE
 *  WHOLE SNAPSHOT if the two disagree — deliberately, because "a producer that
 *  under-counts a status is a producer that may have DROPPED rows". So this may
 *  never be computed from the hub's own `SnapshotCoverage`, which counts
 *  different things (assets vs instruments) over a different vocabulary. */
export function botCoverage(rows: readonly BotInstrument[]): BotCoverage {
  const byStatus = { verified: 0, fallback: 0, missing: 0, disputed: 0, stale: 0, not_applicable: 0 } as Record<BotCapStatus, number>;
  for (const r of rows) byStatus[r.cap.status] += 1;
  return { activeInstruments: rows.length, byStatus };
}

/** THE FIELDS ADDED TO THE ENVELOPE. Spread over the hub's own snapshot before
 *  signing, so they are covered by the signature like everything else. */
export interface BotWireFields {
  generatedAtMs: number;
  expiresAtMs: number;
  botInstruments: BotInstrument[];
  botCoverage: BotCoverage;
}

/** Build the bot-facing view of a snapshot the hub has already assembled.
 *
 *  ⚠ IT READS THE FINISHED ROWS RATHER THAN REBUILDING THEM, so the two views
 *  cannot describe different populations. A second pass over `identityRows`
 *  would be a second producer, and the census would then be a census of
 *  something the bot never received. */
export function botWireFor(snap: SnapshotUnsigned): {
  generatedAtMs: number;
  expiresAtMs: number;
  instruments: BotInstrument[];
  coverage: BotCoverage;
} {
  const assets = new Map<number, AssetRow>();
  for (const a of snap.assets ?? []) assets.set(a.cryptoId, a);
  const instruments = (snap.instruments ?? []).map((r) => botInstrument(r, assets));
  return {
    generatedAtMs: snap.generatedAt,
    expiresAtMs: snap.expiresAt,
    instruments,
    coverage: botCoverage(instruments),
  };
}

/** ⚠ THE HUB'S OWN COVERAGE IS LEFT ALONE. It answers different questions
 *  (per-asset censuses, the invariant flag, omitted ids) that the admin page
 *  reads. The bot's census is ADDED under the keys the bot looks for. */
export type { SnapshotCoverage };
