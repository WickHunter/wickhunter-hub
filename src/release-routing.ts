import type { SignedReleaseManifest } from "./release-manifest.js";

export type CustomerReleaseChannel = "beta" | "production";
export type ReleaseTransition = "update-available" | "current-same-artifact" | "waiting-for-production";

export class ReleaseRoutingError extends Error {
  constructor(message: string) { super(message); this.name = "ReleaseRoutingError"; }
}

/** Customer routing never exposes private Alpha. Alpha is an operator build
 * flavor, not a customer update channel. */
export function parseCustomerReleaseChannel(value: string): CustomerReleaseChannel {
  if (value === "beta" || value === "production") return value;
  if (value === "alpha") throw new ReleaseRoutingError("Alpha is private and unavailable through customer release routes");
  throw new ReleaseRoutingError("unknown customer release channel");
}

/** Numeric x.y.z ordering matches the app's forward-only updater contract. */
export function compareReleaseVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (value: string): number[] | null => /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null;
  const left = parse(a), right = parse(b);
  if (!left || !right || [...left, ...right].some((part) => !Number.isSafeInteger(part))) {
    throw new ReleaseRoutingError("release version is malformed");
  }
  for (let i = 0; i < 3; i++) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return 0;
}

/** Leaving Beta changes the desired track, never the installed bytes. If
 * Production is behind, or has a different archive at the same numeric
 * version, withhold its manifest until a forward-safe target exists. */
export function productionTransition(installed: SignedReleaseManifest, production: SignedReleaseManifest): ReleaseTransition {
  if (installed.channel !== "beta" && installed.channel !== "production") {
    throw new ReleaseRoutingError("installed release is not a customer release");
  }
  if (production.channel !== "production") throw new ReleaseRoutingError("target is not a Production release");
  const order = compareReleaseVersions(production.version, installed.version);
  if (order < 0 || (order === 0 && production.sha256 !== installed.sha256)) return "waiting-for-production";
  if (order === 0) return "current-same-artifact";
  return "update-available";
}
