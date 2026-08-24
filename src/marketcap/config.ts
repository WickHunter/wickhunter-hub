// src/marketcap/config.ts
// The market-cap producer's env contract, in one place, with the refusals it
// needs to make AT STARTUP rather than four hours later on a timer.
//
// ── OFF BY DEFAULT, AND FOR A HARDER REASON THAN THE CANDLE COLLECTORS ──────
// Those are off because collecting is hours of requests and gigabytes of disk.
// This one is off because every call SPENDS A CREDIT against a 15,000/month
// plan that the operator pays for. A hub upgrade that quietly started drawing
// on it would be spending somebody's money without being asked, so the switch
// is `MARKET_CAP_VENUES=` and there is no default value that turns it on.
import path from "node:path";
import { isVenueId, type VenueId } from "../candles/venues.js";
import { DEFAULT_EXCHANGE_IDS, DEFAULT_EXCHANGE_SLUGS, DAY_MS, HOUR_MS, type MarketCapConfig } from "./service.js";
import { QUOTE_BATCH_SIZE } from "./budget.js";
import { LEDGER_FILE_DEFAULT, OVERRIDES_FILE_DEFAULT, SNAPSHOT_FILE_DEFAULT } from "./store.js";

export interface MarketCapEnvConfig extends MarketCapConfig {
  apiKey: string;
  coingeckoApiKey: string;
  signingKeyB64u: string;
  signingKeyId: string;
  /** A shared secret that may read the snapshot without a licence, sent as
   *  `x-hub-key`. Empty = licence-only, which is every install by default. */
  hubKey: string;
}

const numOr = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** The operator's plan: 15,000 credits a month, 50 requests a minute. Both are
 *  DEFAULTS, not constants — a plan change is an env edit, not a release — and
 *  the ceiling is enforced with a refusal (see budget.ts) rather than trusted. */
export const CMC_MONTHLY_CREDIT_CEILING_DEFAULT = 15_000;
export const CMC_REQUESTS_PER_MINUTE_DEFAULT = 50;

/** How long a published snapshot stays usable. Caps refresh hourly, so three
 *  hours is comfortably more than one refresh (a client must not expire a
 *  perfectly good snapshot because one pass was late) and far less than a day
 *  (a producer that dies silently must stop being believed on its own). */
export const SNAPSHOT_TTL_MS_DEFAULT = 3 * HOUR_MS;

export function marketCapConfigFromEnv(env: NodeJS.ProcessEnv, dataDir: string): MarketCapEnvConfig {
  const venues = (env.MARKET_CAP_VENUES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(isVenueId);

  const slugs: Record<VenueId, string> = { ...DEFAULT_EXCHANGE_SLUGS };
  // `MARKET_CAP_SLUGS=aster:aster-pro,bybit:bybit` — an escape hatch for the
  // day a provider renames one, so a rename is an env edit and not a release.
  for (const pair of (env.MARKET_CAP_SLUGS ?? "").split(",")) {
    const [v, slug] = pair.split(":").map((s) => s.trim());
    if (v && slug && isVenueId(v)) slugs[v] = slug;
  }

  // `MARKET_CAP_EXCHANGE_IDS=aster:1452,bybit:521` — the same escape hatch the
  // slugs have, for the day the provider re-keys an exchange. Both are checked
  // against each other at run time; see DEFAULT_EXCHANGE_IDS.
  const exchangeIds: Partial<Record<VenueId, number>> = { ...DEFAULT_EXCHANGE_IDS };
  for (const pair of (env.MARKET_CAP_EXCHANGE_IDS ?? "").split(",")) {
    const [v, id] = pair.split(":").map((x) => x.trim());
    if (v && id && isVenueId(v) && Number.isInteger(Number(id)) && Number(id) > 0) exchangeIds[v] = Number(id);
  }

  return {
    venues,
    slugs,
    exchangeIds,
    apiKey: (env.CMC_PRO_API_KEY ?? "").trim(),
    coingeckoApiKey: (env.COINGECKO_PRO_API_KEY ?? "").trim(),
    signingKeyB64u: (env.MARKET_DATA_SIGNING_PRIVATE_KEY_B64U ?? "").trim(),
    signingKeyId: (env.MARKET_DATA_SIGNING_KEY_ID ?? "").trim(),
    hubKey: (env.MARKET_DATA_HUB_KEY ?? "").trim(),
    monthlyCeiling: numOr(env.CMC_MONTHLY_CREDIT_CEILING, CMC_MONTHLY_CREDIT_CEILING_DEFAULT),
    requestsPerMinute: numOr(env.CMC_REQUESTS_PER_MINUTE, CMC_REQUESTS_PER_MINUTE_DEFAULT),
    // DAILY and HOURLY. These two numbers ARE the credit budget — see the
    // arithmetic in budget.ts — so an operator lowering them is choosing to
    // spend more, and `planRefresh` is what stops that becoming an overspend.
    mappingIntervalMs: numOr(env.MARKET_CAP_MAP_INTERVAL_MS, DAY_MS),
    capIntervalMs: numOr(env.MARKET_CAP_REFRESH_INTERVAL_MS, HOUR_MS),
    tickMs: Math.max(5_000, numOr(env.MARKET_CAP_TICK_MS, 30_000)),
    ttlMs: numOr(env.MARKET_CAP_TTL_MS, SNAPSHOT_TTL_MS_DEFAULT),
    // ── THE SPEC'S PATHS ARE ABSOLUTE; THE DEFAULT HERE IS THE HUB'S OWN
    //    STATE DIRECTORY. The env var honours the spec exactly when set. The
    //    default is `<dataDir>/…` because this hub already owns one state root
    //    (`/opt/wickhunter-hub/data`, mode 700, excluded from the installer's
    //    rsync and backed up as a unit), and a second root is a second thing to
    //    permission, back up and remember.
    snapshotFile: (env.MARKET_CAP_SNAPSHOT_FILE ?? "").trim() || path.join(dataDir, SNAPSHOT_FILE_DEFAULT),
    overridesFile: (env.ASSET_IDENTITY_OVERRIDES_FILE ?? "").trim() || path.join(dataDir, OVERRIDES_FILE_DEFAULT),
    ledgerFile: (env.MARKET_CAP_CREDIT_LEDGER_FILE ?? "").trim() || path.join(dataDir, LEDGER_FILE_DEFAULT),
    quoteBatchSize: Math.min(QUOTE_BATCH_SIZE, Math.max(1, numOr(env.MARKET_CAP_QUOTE_BATCH, QUOTE_BATCH_SIZE))),
  };
}

/** Everything that must be true before the producer may run, as ONE list of
 *  sentences rather than a throw from whichever line noticed first.
 *
 *  A MISSING PIECE IS NOT A CRASH. The hub does licensing and candle seeding
 *  too, and a market-cap key that was never configured must not take those
 *  down; the service simply does not start and the reasons are printed once and
 *  visible on the admin surface. What it also is not, is SILENT — a producer
 *  that is configured-but-unable is the one state an operator must be told
 *  about, because from a client's side it is indistinguishable from a provider
 *  outage. */
export function marketCapStartupRefusals(cfg: MarketCapEnvConfig): string[] {
  const out: string[] = [];
  if (!cfg.venues.length) return out; // deliberately off; nothing to complain about
  if (!cfg.apiKey) out.push("CMC_PRO_API_KEY is not set — the market-cap producer cannot call the provider");
  if (!cfg.signingKeyB64u) out.push("MARKET_DATA_SIGNING_PRIVATE_KEY_B64U is not set — an unsigned snapshot is not servable");
  if (!cfg.signingKeyId) out.push("MARKET_DATA_SIGNING_KEY_ID is not set — a signature nobody can attribute is not a signature");
  if (cfg.monthlyCeiling <= 0) out.push("CMC_MONTHLY_CREDIT_CEILING is not a positive number of credits");
  return out;
}
