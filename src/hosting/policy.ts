// src/hosting/policy.ts
// Hosting configuration: the product's price/lifecycle policy, the region and
// plan an instance may be created in, the per-venue reachability probe list,
// and the provider account material — one JSON file under data/, mirroring
// billing/config.ts's shape (write-only secret, `configured` + last four
// echoed back, validated partial patch). Everything here is server-side
// configuration; a client-supplied price, region, plan or policy version is
// never authoritative (src/hosting/service.ts re-reads this file itself).
//
// Defaults come from docs/HOSTING-REGION-2026-09-10.md's research: Vultr
// Tokyo (`nrt`) primary, Osaka (`itm`) same-price fallback — the only two
// Vultr regions among the ones checked that no supported exchange's public
// ToS names as restricted, per that research; Frankfurt/Amsterdam are
// deliberately NOT defaulted-to for a Binance USD-M customer until a live
// readiness probe from a box in that region actually returns 200 (Binance's
// documented NL/DE futures withdrawal is a real, unverified-by-IP risk).
// Plan `vc2-1c-2gb` (1 vCPU / 2 GB / 55 GB SSD, $10/mo at the time of that
// research) — the 1 GB floor is disqualified by this repo's own v0.90.63
// crash-loop incident (CLAUDE.md, liqhunter-private).
import path from "node:path";
import { readJson, writeJsonAtomic } from "../jsonfile.js";

export const HOSTING_POLICY_FILE = "hosting-policy.v1.json";

export class HostingPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostingPolicyError";
  }
}

/** One venue's public, unauthenticated reachability check, run FROM the new
 *  instance (never from the provisioner's own host — the point is testing
 *  THAT box's egress IP). A non-200 is refused by name; see
 *  src/hosting/readiness.ts for the verdict this list feeds. */
export interface ProbeVenue {
  /** Stable id, e.g. "bybit" — never renamed once shipped (an instance's
   *  stored readiness result names venues by this id). */
  id: string;
  label: string;
  method: "GET";
  url: string;
  /** The one accepted status. Vultr/CDN geo-blocks answer 403 (Bybit's
   *  CloudFront shape) or 451 (Binance's "restricted location" shape); a
   *  timeout after retry is a hard block too — see readiness.ts. */
  expectStatus: 200;
}

/** The seven venues this Hub's software supports, and their public
 *  reachability-check endpoints (docs/HOSTING-REGION-2026-09-10.md §4,
 *  corrected against the app team's own verified list — the customer
 *  artifact ships no reachability-probe module of its own, so a hosted
 *  VPS's bootstrap script must run these exact plain-curl checks itself;
 *  see src/hosting/bootstrap.ts). Order is display order only; the probe
 *  runs every configured venue every time regardless of which venues a
 *  given customer has connected, because venues can be added to an account
 *  later (the research's own recommendation: "run all seven regardless"). */
export const DEFAULT_PROBE_VENUES: readonly ProbeVenue[] = Object.freeze([
  { id: "bybit", label: "Bybit", method: "GET", url: "https://api.bybit.com/v5/market/time", expectStatus: 200 },
  { id: "binance", label: "Binance USD-M", method: "GET", url: "https://fapi.binance.com/fapi/v1/time", expectStatus: 200 },
  { id: "bitget", label: "Bitget", method: "GET", url: "https://api.bitget.com/api/v2/public/time", expectStatus: 200 },
  { id: "bitunix", label: "Bitunix", method: "GET", url: "https://fapi.bitunix.com/api/v1/futures/market/tickers?symbols=BTCUSDT", expectStatus: 200 },
  { id: "blofin", label: "BloFin", method: "GET", url: "https://openapi.blofin.com/api/v1/market/instruments?instType=SWAP", expectStatus: 200 },
  { id: "weex", label: "WEEX", method: "GET", url: "https://api-contract.weex.com/capi/v3/market/time", expectStatus: 200 },
  { id: "aster", label: "Aster", method: "GET", url: "https://fapi.asterdex.com/fapi/v3/time", expectStatus: 200 },
]);

export interface HostingRegion {
  /** Provider region id, e.g. "nrt". */
  id: string;
  label: string;
}

/** Ordered: index 0 is the primary region every new instance tries first;
 *  later entries are fallbacks tried, at most once each, only when the
 *  readiness probe refuses the previous one (see readiness.ts /
 *  service.ts's `RETRY_REGION_ONCE` rule — H6's "fallback region once"). */
export const DEFAULT_REGIONS: readonly HostingRegion[] = Object.freeze([
  { id: "nrt", label: "Tokyo" },
  { id: "itm", label: "Osaka" },
]);

export const DEFAULT_PLAN_ID = "vc2-1c-2gb";
export const DEFAULT_MONTHLY_PRICE_CENTS = 1500; // proposed, per the handoff — not a verified margin

export interface HostingPolicy {
  version: number;
  currency: "usd";
  /** Proposed retail price — see the handoff's §2/§12: $15 pending a real
   *  Vultr quote and benchmarked resource usage. Labeled "proposed" on every
   *  customer-facing surface until an operator confirms it. */
  monthlyPriceCents: number;
  renewalGraceHours: number;
  retentionHours: number;
  reminderHoursBeforeDelete: readonly number[];
  /** Informational only on this Hub — the temporary-password flow itself is
   *  app-side (liqhunter-private CLAUDE.md's forced-password-change
   *  contract, out of this repo's scope). Carried here because the welcome
   *  email states it and an operator may want it configurable in one place. */
  temporaryPasswordTtlHours: number;
  /** V1: one active hosting instance per owner (H6's explicit recommendation
   *  — "support multiple only through an explicit product expansion"). */
  maxInstancesPerCustomer: number;
  managedBackupsIncluded: boolean;
  /** Ordered primary-then-fallback region list. */
  regions: readonly HostingRegion[];
  /** The one plan this Hub offers at launch. */
  planId: string;
  planLabel: string;
  /** The per-venue reachability probe the bootstrap script runs from the new
   *  instance and reports back (POST /api/hosting/instances/:id/readiness). */
  probeVenues: readonly ProbeVenue[];
  /** Re-run the readiness probe on this cadence against a `ready` instance's
   *  region, so a venue that re-geofences a datacenter range after
   *  provisioning is caught (the research's own caveat: "an exchange can
   *  re-geofence a datacenter range tomorrow with no notice"). */
  readinessRecheckHours: number;
  /** Master switch: purchasable checkout/provisioning stays OFF until an
   *  operator has a real Vultr quote, a confirmed OS image, and a released
   *  artifact digest — the handoff's own launch gate (§10: "enable
   *  purchasable regions/plans only after benchmarking and commercial
   *  configuration"). Off by default on every install. */
  provisioningEnabled: boolean;
  /** Vultr project/account label, for the admin page and audit log — never a
   *  secret by itself. */
  providerAccountRef: string;
  /** OS image id on the provider (e.g. a Vultr `os_id`) — required before
   *  `provisioningEnabled` may be true; unverified defaults are never
   *  guessed (H6/§12: "don't copy obsolete example plan or OS IDs"). */
  osId: string;
  /** What `createInstance` installs: a pinned release reference (a git ref,
   *  tag or artifact digest) — never "latest" silently, so a customer's
   *  install is reproducible and auditable. */
  releaseRef: string;
  bootstrapTokenTtlMinutes: number;
  maximumConcurrentProvisionJobs: number;
  /** A soft budget ceiling in cents/month across all instances — surfaced on
   *  the admin page; provisioning refuses new instances (not existing ones)
   *  once projected spend would exceed it. 0 = no ceiling configured. */
  maximumProjectedMonthlyProviderCostCents: number;
  updatedAtMs: number | null;
}

export interface HostingSecrets {
  /** The Vultr API key — write-only over the wire, exactly like a Stripe
   *  secret key (billing/config.ts's `secretUpdate`). Never logged, never
   *  placed in cloud-init/user-data (the customer VPS never needs it). */
  vultrApiKey: string;
}

export function defaultHostingPolicy(): HostingPolicy {
  return {
    version: 1,
    currency: "usd",
    monthlyPriceCents: DEFAULT_MONTHLY_PRICE_CENTS,
    renewalGraceHours: 72,
    retentionHours: 168,
    reminderHoursBeforeDelete: [72, 24],
    temporaryPasswordTtlHours: 24,
    maxInstancesPerCustomer: 1,
    managedBackupsIncluded: false,
    regions: DEFAULT_REGIONS,
    planId: DEFAULT_PLAN_ID,
    planLabel: "1 vCPU / 2 GB RAM / 55 GB SSD",
    probeVenues: DEFAULT_PROBE_VENUES,
    readinessRecheckHours: 24,
    provisioningEnabled: false,
    providerAccountRef: "",
    osId: "",
    releaseRef: "",
    bootstrapTokenTtlMinutes: 60,
    maximumConcurrentProvisionJobs: 3,
    maximumProjectedMonthlyProviderCostCents: 0,
    updatedAtMs: null,
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function regionsFrom(raw: unknown): readonly HostingRegion[] {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_REGIONS;
  const out: HostingRegion[] = [];
  for (const r of raw) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const id = str(o.id).trim();
    if (!id || !/^[a-z0-9-]{1,16}$/.test(id)) continue;
    out.push({ id, label: str(o.label).trim() || id });
  }
  return out.length ? out : DEFAULT_REGIONS;
}
function probesFrom(raw: unknown): readonly ProbeVenue[] {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_PROBE_VENUES;
  const out: ProbeVenue[] = [];
  for (const r of raw) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const id = str(o.id).trim();
    const url = str(o.url).trim();
    if (!id || !url || !/^https:\/\//.test(url)) continue;
    out.push({ id, label: str(o.label).trim() || id, method: "GET", url, expectStatus: 200 });
  }
  return out.length ? out : DEFAULT_PROBE_VENUES;
}

export function readHostingPolicy(dataDir: string): HostingPolicy {
  const raw = readJson<Record<string, unknown>>(path.join(dataDir, HOSTING_POLICY_FILE), {});
  const d = defaultHostingPolicy();
  const reminders = Array.isArray(raw.reminderHoursBeforeDelete) && raw.reminderHoursBeforeDelete.every((n) => typeof n === "number")
    ? (raw.reminderHoursBeforeDelete as number[])
    : d.reminderHoursBeforeDelete;
  return {
    version: num(raw.version, d.version),
    currency: "usd",
    monthlyPriceCents: num(raw.monthlyPriceCents, d.monthlyPriceCents),
    renewalGraceHours: num(raw.renewalGraceHours, d.renewalGraceHours),
    retentionHours: num(raw.retentionHours, d.retentionHours),
    reminderHoursBeforeDelete: reminders,
    temporaryPasswordTtlHours: num(raw.temporaryPasswordTtlHours, d.temporaryPasswordTtlHours),
    maxInstancesPerCustomer: num(raw.maxInstancesPerCustomer, d.maxInstancesPerCustomer),
    managedBackupsIncluded: bool(raw.managedBackupsIncluded, d.managedBackupsIncluded),
    regions: regionsFrom(raw.regions),
    planId: str(raw.planId, d.planId) || d.planId,
    planLabel: str(raw.planLabel, d.planLabel) || d.planLabel,
    probeVenues: probesFrom(raw.probeVenues),
    readinessRecheckHours: num(raw.readinessRecheckHours, d.readinessRecheckHours),
    provisioningEnabled: bool(raw.provisioningEnabled, d.provisioningEnabled),
    providerAccountRef: str(raw.providerAccountRef),
    osId: str(raw.osId),
    releaseRef: str(raw.releaseRef),
    bootstrapTokenTtlMinutes: num(raw.bootstrapTokenTtlMinutes, d.bootstrapTokenTtlMinutes),
    maximumConcurrentProvisionJobs: num(raw.maximumConcurrentProvisionJobs, d.maximumConcurrentProvisionJobs),
    maximumProjectedMonthlyProviderCostCents: num(raw.maximumProjectedMonthlyProviderCostCents, d.maximumProjectedMonthlyProviderCostCents),
    updatedAtMs: typeof raw.updatedAtMs === "number" ? raw.updatedAtMs : null,
  };
}

export function writeHostingPolicy(dataDir: string, policy: HostingPolicy): void {
  writeJsonAtomic(path.join(dataDir, HOSTING_POLICY_FILE), policy);
}

const SECRETS_FILE = "hosting-secrets.v1.json";

export function readHostingSecrets(dataDir: string): HostingSecrets {
  const raw = readJson<Record<string, unknown>>(path.join(dataDir, SECRETS_FILE), {});
  return { vultrApiKey: str(raw.vultrApiKey) };
}
export function writeHostingSecrets(dataDir: string, secrets: HostingSecrets): void {
  writeJsonAtomic(path.join(dataDir, SECRETS_FILE), secrets);
}

export function maskedHostingSecrets(secrets: HostingSecrets): { vultrApiKey: { configured: boolean; last4: string } } {
  return {
    vultrApiKey: { configured: !!secrets.vultrApiKey, last4: secrets.vultrApiKey.slice(-4) },
  };
}

/** Wire semantics identical to billing/config.ts's `secretUpdate`: absent or
 *  "" leaves it unchanged, null clears it, a string sets it. */
export function applySecretPatch(current: HostingSecrets, patch: unknown): HostingSecrets {
  if (patch === undefined) return current;
  if (!patch || typeof patch !== "object") throw new HostingPolicyError("secrets patch must be an object");
  const p = patch as Record<string, unknown>;
  const next = { ...current };
  if (p.vultrApiKey !== undefined && p.vultrApiKey !== "") {
    // "" = unchanged, null = clear, a string = set — billing/config.ts's
    // `secretUpdate` wire semantics, repeated here rather than imported so
    // this module has no dependency on src/billing/.
    if (p.vultrApiKey === null) next.vultrApiKey = "";
    else {
      if (typeof p.vultrApiKey !== "string" || /\s/.test(p.vultrApiKey) || p.vultrApiKey.length > 512) throw new HostingPolicyError("Vultr API key looks malformed");
      next.vultrApiKey = p.vultrApiKey;
    }
  }
  return next;
}

/** Validated partial update, mirroring billing/config.ts's applyBillingPatch
 *  shape: throws HostingPolicyError with an operator-safe message, returns
 *  the NEW policy (unsaved) on success. */
export function applyHostingPolicyPatch(current: HostingPolicy, patch: unknown): HostingPolicy {
  if (!patch || typeof patch !== "object") throw new HostingPolicyError("patch must be an object");
  const p = patch as Record<string, unknown>;
  const next: HostingPolicy = { ...current };
  if (p.monthlyPriceCents !== undefined) {
    const n = p.monthlyPriceCents;
    if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 10_000_000) throw new HostingPolicyError("monthlyPriceCents must be a whole number of cents");
    next.monthlyPriceCents = n as number;
  }
  if (p.renewalGraceHours !== undefined) next.renewalGraceHours = intField(p.renewalGraceHours, 0, 24 * 30, "renewalGraceHours");
  if (p.retentionHours !== undefined) next.retentionHours = intField(p.retentionHours, 0, 24 * 365, "retentionHours");
  if (p.reminderHoursBeforeDelete !== undefined) {
    if (!Array.isArray(p.reminderHoursBeforeDelete) || !p.reminderHoursBeforeDelete.every((n) => Number.isFinite(n) && (n as number) >= 0)) {
      throw new HostingPolicyError("reminderHoursBeforeDelete must be an array of non-negative hour counts");
    }
    next.reminderHoursBeforeDelete = [...(p.reminderHoursBeforeDelete as number[])];
  }
  if (p.temporaryPasswordTtlHours !== undefined) next.temporaryPasswordTtlHours = intField(p.temporaryPasswordTtlHours, 1, 24 * 30, "temporaryPasswordTtlHours");
  if (p.maxInstancesPerCustomer !== undefined) next.maxInstancesPerCustomer = intField(p.maxInstancesPerCustomer, 1, 10, "maxInstancesPerCustomer");
  if (p.managedBackupsIncluded !== undefined) {
    if (typeof p.managedBackupsIncluded !== "boolean") throw new HostingPolicyError("managedBackupsIncluded must be a boolean");
    next.managedBackupsIncluded = p.managedBackupsIncluded;
  }
  if (p.regions !== undefined) {
    const regions = regionsFrom(p.regions);
    if (!Array.isArray(p.regions) || !p.regions.length) throw new HostingPolicyError("regions must be a non-empty array");
    next.regions = regions;
  }
  if (p.planId !== undefined) {
    if (typeof p.planId !== "string" || !/^[a-z0-9-]{1,32}$/.test(p.planId)) throw new HostingPolicyError("planId looks malformed");
    next.planId = p.planId;
  }
  if (p.planLabel !== undefined) {
    if (typeof p.planLabel !== "string" || !p.planLabel.trim() || p.planLabel.length > 80) throw new HostingPolicyError("planLabel must be 1 to 80 characters");
    next.planLabel = p.planLabel.trim();
  }
  if (p.probeVenues !== undefined) {
    if (!Array.isArray(p.probeVenues) || !p.probeVenues.length) throw new HostingPolicyError("probeVenues must be a non-empty array");
    next.probeVenues = probesFrom(p.probeVenues);
  }
  if (p.readinessRecheckHours !== undefined) next.readinessRecheckHours = intField(p.readinessRecheckHours, 1, 24 * 30, "readinessRecheckHours");
  if (p.provisioningEnabled !== undefined) {
    if (typeof p.provisioningEnabled !== "boolean") throw new HostingPolicyError("provisioningEnabled must be a boolean");
    if (p.provisioningEnabled && (!next.osId && !p.osId)) throw new HostingPolicyError("cannot enable provisioning without an osId configured");
    if (p.provisioningEnabled && (!next.releaseRef && !p.releaseRef)) throw new HostingPolicyError("cannot enable provisioning without a releaseRef configured");
    next.provisioningEnabled = p.provisioningEnabled;
  }
  if (p.providerAccountRef !== undefined) {
    if (typeof p.providerAccountRef !== "string" || p.providerAccountRef.length > 120) throw new HostingPolicyError("providerAccountRef looks malformed");
    next.providerAccountRef = p.providerAccountRef;
  }
  if (p.osId !== undefined) {
    if (typeof p.osId !== "string" || p.osId.length > 40) throw new HostingPolicyError("osId looks malformed");
    next.osId = p.osId;
  }
  if (p.releaseRef !== undefined) {
    if (typeof p.releaseRef !== "string" || p.releaseRef.length > 200) throw new HostingPolicyError("releaseRef looks malformed");
    next.releaseRef = p.releaseRef;
  }
  if (p.bootstrapTokenTtlMinutes !== undefined) next.bootstrapTokenTtlMinutes = intField(p.bootstrapTokenTtlMinutes, 5, 24 * 60, "bootstrapTokenTtlMinutes");
  if (p.maximumConcurrentProvisionJobs !== undefined) next.maximumConcurrentProvisionJobs = intField(p.maximumConcurrentProvisionJobs, 1, 50, "maximumConcurrentProvisionJobs");
  if (p.maximumProjectedMonthlyProviderCostCents !== undefined) next.maximumProjectedMonthlyProviderCostCents = intField(p.maximumProjectedMonthlyProviderCostCents, 0, 1_000_000_000, "maximumProjectedMonthlyProviderCostCents");
  return next;
}

function intField(v: unknown, min: number, max: number, label: string): number {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new HostingPolicyError(`${label} must be a whole number from ${min} to ${max}`);
  return n;
}
