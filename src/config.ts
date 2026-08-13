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

  // ── candle seed service ───────────────────────────────────────────────────
  /** Venues that run a 1m collector. EMPTY BY DEFAULT: collecting is hours of
   *  outbound requests and gigabytes on disk, so it is something the operator
   *  turns on deliberately (HUB_CANDLE_VENUES=bybit,bitunix,bitget), not
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
  return {
    dataDir: env.HUB_DATA_DIR ?? path.join(ROOT, "data"),
    releasesDir: env.HUB_RELEASES_DIR ?? path.join(ROOT, "releases"),
    publicDir: env.HUB_PUBLIC_DIR ?? path.join(ROOT, "public"),
    templatesDir: env.HUB_TEMPLATES_DIR ?? path.join(ROOT, "templates"),
    host: env.HUB_HOST ?? "127.0.0.1",
    port,
    adminToken: env.HUB_ADMIN_TOKEN ?? "",
    publicOrigin: env.HUB_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
    srcDir: env.HUB_SRC_DIR ?? "/root/dev/wickhunter-hub",
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
  };
}
