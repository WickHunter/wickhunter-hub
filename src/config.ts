// src/config.ts
// Every path and listener setting in one place, all overridable by env so the
// tests can point a hub instance at a temp directory. Production values are
// pinned by the systemd unit that install-hub.sh writes.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isVenueId, type VenueId } from "./candles/venues.js";
import { collectorOptionsFromEnv } from "./candles/service.js";
import type { CollectorOptions } from "./candles/collector.js";
import {
  CANDLE_KEY_ID, CANDLE_SIGNERS, LICENSE_SEED_KEY_ID, RESERVED_KEY_IDS, isCandleSigner,
  type CandleSigner,
} from "./candles/key.js";
import { marketCapConfigFromEnv, type MarketCapEnvConfig } from "./marketcap/config.js";
import { DEFAULT_RELEASE_MAX_AGE_MS, parseReleasePublicKeys } from "./release-manifest.js";
import type { LicenseLeaseConfig } from "./license-leases.js";
import {
  marketplaceStatusBridgeFromEnv,
  type MarketplaceStatusBridgeConfig,
} from "./marketplace-status.js";
import type { MarketplaceInputsConfig } from "./marketplace-inputs.js";

// Compiled layout is dist/src/config.js, so the project root is two up.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");

export interface HubConfig {
  dataDir: string;      // signing key, licenses.json, revoked.json, roster, check-ins
  releasesDir: string;  // beta tarballs + latest.json (see README release contract)
  publicDir: string;    // admin.html
  templatesDir: string; // install.sh template served to testers
  host: string;         // always loopback in production; nginx owns the public side
  port: number;
  adminToken: string;   // HUB_ADMIN_TOKEN; empty = the whole admin surface answers 503
  publicOrigin: string; // what testers paste, e.g. https://45.76.105.174/hub
  srcDir: string;       // git checkout the self-upgrade pulls + reinstalls from
  /** Dedicated RELEASE public keys only. The Hub never accepts a release
   *  private key and never reuses its licence/candle/market-data authorities. */
  releasePublicKeys: Record<string, string>;
  releaseMaxAgeMs: number;
  releaseChannel: string;
  releasePlatform: string;
  releaseArch: string;

  // ── machine-bound licensing leases ──────────────────────────────────────
  /** Additive WHL1 lease service. Old LHK1/check-in clients do not read this
   * and retain their exact wire behavior during staged migration. */
  licenseLease?: LicenseLeaseConfig;

  // ── private Marketplace operations bridge ──────────────────────────────
  /** Optional, server-to-server, loopback-only status bridge. The browser
   * never receives its credential and this public repository imports no
   * Marketplace execution/payment code. */
  marketplaceStatus?: MarketplaceStatusBridgeConfig;
  /** Masked Marketplace configuration plane. Production names one fixed root
   * helper; the unprivileged HTTP process never opens its state or role files. */
  marketplaceInputs?: MarketplaceInputsConfig;

  // ── candle seed service ───────────────────────────────────────────────────
  /** Venues that run a 1m collector. EMPTY BY DEFAULT: collecting is hours of
   *  outbound requests and gigabytes on disk, so it is something the operator
   *  turns on deliberately (HUB_CANDLE_VENUES=bybit,bitunix,bitget,binance,aster), not
   *  something a hub upgrade silently starts doing. Venues left out report
   *  "no collector configured" on the admin page rather than looking broken. */
  candleVenues: VenueId[];
  /** v0.2.17 — OPTIONAL, because `HubConfig` is built by hand (tests, tools)
   *  as well as by `configFromEnv`. A required field here reads fine and then
   *  throws at the ONE call site that filters it — which is what it did. */
  candleStreamVenues?: VenueId[];
  /** WHICH KEY SIGNS A SEED. `"license"` (the default, and today's behaviour)
   *  signs with the licence key and emits keyId `"seed-1"`; `"candle"` signs
   *  with the hub's dedicated candle key and emits `"candle-1"`. Set by
   *  HUB_CANDLE_SIGNER — see the rollout order in `candleSigningFromEnv`. */
  candleSigner: CandleSigner;
  /** Names the signing key in the seed payload so it can be rotated without
   *  breaking clients. Derived from `candleSigner` so the label and the key can
   *  never drift apart; HUB_CANDLE_KEY_ID may rename it, but never to a keyId
   *  reserved for the other signer. */
  candleKeyId: string;
  /** Seeding requires a valid licence key, exactly like every other download
   *  surface. Set HUB_CANDLE_REQUIRE_LICENSE=0 only for a local test hub. */
  candleRequireLicense: boolean;
  candleTickMs: number;
  candleOptions: CollectorOptions;

  // ── market-cap snapshot producer ──────────────────────────────────────────
  /** OPTIONAL for the same reason `candleStreamVenues` is: `HubConfig` is built
   *  by hand in tests and tools as well as by `configFromEnv`, and a required
   *  field here reads fine and then throws at the one call site that filters
   *  it — which is exactly what v0.2.17 records happening. Absent = the
   *  producer does not exist, which is every install until an operator sets
   *  MARKET_CAP_VENUES and a CMC key. */
  marketCap?: MarketCapEnvConfig;
}

// ── THE SIGNING SWITCH, AND THE ORDER IT MUST BE THROWN IN ──────────────────
//
// The bot PINS its seed-verifying keys BY keyId and REFUSES an unknown one. So
// the hub emitting `candle-1` before a bot build exists that knows `candle-1`
// does not fail loudly — every seed is refused, every pair silently falls back
// to paging the venue for ~12 hours, and the feature dies quietly. That is the
// hardest failure shape in this whole service to notice, which is why the
// default here is the OLD behaviour and why the order below is not optional:
//
//   (a) SHIP THIS CHANGE. The dedicated key is generated on first use and its
//       public half appears in the startup log and on the admin Exchanges
//       panel. Seeds are still signed by the LICENCE key, still labelled
//       `seed-1`. Nothing on any bot changes.
//   (b) PASTE THE PUBLIC KEY into the bot's `OLB_SEED_KEYS`, keyed `candle-1`,
//       ALONGSIDE the existing `seed-1` entry — never instead of it.
//   (c) SHIP A BOT BUILD carrying that map, and let it reach the testers.
//   (d) ONLY THEN set HUB_CANDLE_SIGNER=candle on the hub and restart. Bots on
//       the new build verify `candle-1`; bots still on the old build refuse —
//       so (c) has to be actually out, not merely tagged.
//
// Rolling back is (d) in reverse: unset HUB_CANDLE_SIGNER, restart, and seeds
// are `seed-1` again. Keep the `seed-1` entry in the bot until every install
// has been on a `candle-1`-aware build for long enough to say so.
export function candleSigningFromEnv(env: NodeJS.ProcessEnv): { signer: CandleSigner; keyId: string } {
  const raw = (env.HUB_CANDLE_SIGNER ?? "license").trim().toLowerCase();
  if (!isCandleSigner(raw)) {
    throw new Error(`HUB_CANDLE_SIGNER must be one of ${CANDLE_SIGNERS.join(" | ")}: ${env.HUB_CANDLE_SIGNER}`);
  }
  const signer: CandleSigner = raw;
  const keyId = (env.HUB_CANDLE_KEY_ID ?? "").trim()
    || (signer === "candle" ? CANDLE_KEY_ID : LICENSE_SEED_KEY_ID);
  // A payload signed by one key and LABELLED another verifies nowhere, and the
  // symptom shows up in someone else's process with no hint of the cause. The
  // reserved ids therefore bind: refuse to start rather than serve a lie.
  const owner = RESERVED_KEY_IDS[keyId];
  if (owner && owner !== signer) {
    throw new Error(
      `HUB_CANDLE_KEY_ID=${keyId} is reserved for HUB_CANDLE_SIGNER=${owner}, but the signer is ${signer} — ` +
      "a seed signed by one key and labelled another cannot be verified by anyone",
    );
  }
  return { signer, keyId };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const port = Number(env.HUB_PORT ?? 8091);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HUB_PORT is not a valid port: ${env.HUB_PORT}`);
  }
  const signing = candleSigningFromEnv(env);
  const publicOrigin = env.HUB_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
  if (env.NODE_ENV === "production") {
    let url: URL;
    try { url = new URL(publicOrigin); } catch { throw new Error("HUB_PUBLIC_ORIGIN must be a valid HTTPS URL in production"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("HUB_PUBLIC_ORIGIN must use HTTPS without credentials, query or fragment in production");
    }
  }
  const releasePublicKeys = env.HUB_RELEASE_PUBLIC_KEYS_JSON
    ? parseReleasePublicKeys(env.HUB_RELEASE_PUBLIC_KEYS_JSON)
    : {};
  if (env.NODE_ENV === "production" && !Object.keys(releasePublicKeys).length) {
    throw new Error("HUB_RELEASE_PUBLIC_KEYS_JSON is required in production; the Hub must not receive the private release key");
  }
  const releaseMaxAgeMs = Number(env.HUB_RELEASE_MAX_AGE_MS ?? DEFAULT_RELEASE_MAX_AGE_MS);
  if (!Number.isFinite(releaseMaxAgeMs) || releaseMaxAgeMs <= 0) {
    throw new Error("HUB_RELEASE_MAX_AGE_MS must be a positive number");
  }
  return {
    dataDir: env.HUB_DATA_DIR ?? path.join(ROOT, "data"),
    releasesDir: env.HUB_RELEASES_DIR ?? path.join(ROOT, "releases"),
    publicDir: env.HUB_PUBLIC_DIR ?? path.join(ROOT, "public"),
    templatesDir: env.HUB_TEMPLATES_DIR ?? path.join(ROOT, "templates"),
    host: env.HUB_HOST ?? "127.0.0.1",
    port,
    adminToken: env.HUB_ADMIN_TOKEN ?? "",
    publicOrigin,
    srcDir: env.HUB_SRC_DIR ?? "/root/dev/wickhunter-hub",
    releasePublicKeys,
    releaseMaxAgeMs,
    releaseChannel: (env.HUB_RELEASE_CHANNEL ?? "beta").trim(),
    releasePlatform: (env.HUB_RELEASE_PLATFORM ?? "linux").trim(),
    releaseArch: (env.HUB_RELEASE_ARCH ?? "x64").trim(),
    licenseLease: {
      activeKeyId: (env.HUB_LICENSE_LEASE_KEY_ID ?? "lease-1").trim(),
      leaseDurationMs: Number(env.HUB_LICENSE_LEASE_DURATION_MS ?? 6 * 60 * 60 * 1_000),
      cachedGraceMs: Number(env.HUB_LICENSE_LEASE_GRACE_MS ?? 72 * 60 * 60 * 1_000),
      challengeTtlMs: Number(env.HUB_LICENSE_LEASE_CHALLENGE_TTL_MS ?? 5 * 60 * 1_000),
      maxClockSkewMs: Number(env.HUB_LICENSE_LEASE_CLOCK_SKEW_MS ?? 5 * 60 * 1_000),
      defaultMaxMachines: Number(env.HUB_LICENSE_LEASE_DEFAULT_MAX_MACHINES ?? 1),
    },
    marketplaceStatus: marketplaceStatusBridgeFromEnv(env),
    marketplaceInputs: {
      envFile: env.HUB_MARKETPLACE_ENV_FILE ?? "/etc/wickhunter-hub/marketplace-state.env",
      hubBridgeEnvFile: env.HUB_MARKETPLACE_BRIDGE_ENV_FILE ?? "/etc/wickhunter-hub/marketplace.env",
      rootHelper: env.HUB_ROOT_HELPER ?? "/usr/local/libexec/wickhunter-hub-root-helper",
    },
    candleVenues: (env.HUB_CANDLE_VENUES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(isVenueId),
    // v0.2.17 — venues whose TAIL comes from a websocket. A SUBSET of the
    // collecting venues, intersected below rather than trusted: naming a venue
    // here that is not collecting would open sockets for a roster nobody is
    // tracking. Absent = REST only, which is every install today.
    candleStreamVenues: (env.HUB_CANDLE_STREAM ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(isVenueId),
    // Both come out of one function so the key and its label move together.
    candleSigner: signing.signer,
    candleKeyId: signing.keyId,
    // Default ON: the seed is a licensed benefit and multi-GB of egress, and
    // every other download surface here is keyed. `=0` is the escape hatch.
    candleRequireLicense: (env.HUB_CANDLE_REQUIRE_LICENSE ?? "1") !== "0",
    candleTickMs: Math.max(1000, Number(env.HUB_CANDLE_TICK_MS ?? 60_000) || 60_000),
    candleOptions: collectorOptionsFromEnv(env),
    // Reads the same dataDir the rest of the hub uses, so a snapshot file with
    // no explicit path lands beside licenses.json rather than in a second state
    // root nobody remembers to back up.
    marketCap: marketCapConfigFromEnv(env, env.HUB_DATA_DIR ?? path.join(ROOT, "data")),
  };
}
