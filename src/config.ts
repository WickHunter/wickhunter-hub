// src/config.ts
// Every path and listener setting in one place, all overridable by env so the
// tests can point a hub instance at a temp directory. Production values are
// pinned by the systemd unit that install-hub.sh writes.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isVenueId, type VenueId } from "./candles/venues.js";
import { collectorOptionsFromEnv } from "./candles/service.js";
import type { CollectorOptions } from "./candles/collector.js";

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
  /** Names the signing key in the seed payload so it can be rotated without
   *  breaking clients. Rotating the hub's Ed25519 key means changing this. */
  candleKeyId: string;
  /** Seeding requires a valid licence key, exactly like every other download
   *  surface. Set HUB_CANDLE_REQUIRE_LICENSE=0 only for a local test hub. */
  candleRequireLicense: boolean;
  candleTickMs: number;
  candleOptions: CollectorOptions;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const port = Number(env.HUB_PORT ?? 8091);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`HUB_PORT is not a valid port: ${env.HUB_PORT}`);
  }
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
    candleKeyId: env.HUB_CANDLE_KEY_ID ?? "seed-1",
    // Default ON: the seed is a licensed benefit and multi-GB of egress, and
    // every other download surface here is keyed. `=0` is the escape hatch.
    candleRequireLicense: (env.HUB_CANDLE_REQUIRE_LICENSE ?? "1") !== "0",
    candleTickMs: Math.max(1000, Number(env.HUB_CANDLE_TICK_MS ?? 60_000) || 60_000),
    candleOptions: collectorOptionsFromEnv(env),
  };
}
