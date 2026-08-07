// src/config.ts
// Every path and listener setting in one place, all overridable by env so the
// tests can point a hub instance at a temp directory. Production values are
// pinned by the systemd unit that install-hub.sh writes.
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  };
}
