// src/ratelimit.ts
// Pure, in-memory rate-limiting primitives for the hub's public HTTP surface.
//
// ADDITIVE ONLY: nothing here changes what a VALID request is answered with —
// every limiter is consulted strictly BEFORE the state-changing work a route
// does (recording a check-in, admitting a seat, issuing a lease, appending a
// webhook event), so a refusal never rolls anything back and a request that
// stays under its limit is byte-for-byte what it was before this file
// existed. A limiter only ever adds a 429 in front of a caller that is
// already over its own stated budget.
//
// Two independent shapes:
//
//   SlidingWindowLimiter — "at most N events per key per rolling window."
//   Generalises the sliding-window log `FeedbackRateLimiter` (src/feedback.ts)
//   has used since the tester-report surface got its own limiter: the same
//   technique (a per-key timestamp list, pruned to the window, with a bounded
//   overflow bucket so unlimited source cardinality cannot grow the map
//   forever), factored so every OTHER public route can share one
//   implementation instead of growing its own. feedback.ts keeps its own
//   copy untouched on purpose — its four interacting buckets (raw IP /
//   authenticated licence / accepted-per-licence / accepted-per-IP) are a
//   documented, already-pinned contract and this file must not risk it.
//
//   AdminBackoffLimiter — exponential per-IP lockout for repeated admin-token
//   failures, reset by one success. A different shape on purpose: a sliding
//   window answers "how many recent attempts", which is the wrong question
//   for a token guess — the defence that actually slows a guesser down is to
//   make each consecutive failure cost more wall-clock time than the last,
//   uncapped in count but capped in duration.
//
// Both classes are deliberately clock-injected (`now` is always a parameter,
// never `Date.now()` read internally) so a test can drive every edge — right
// at the limit, exactly at a window boundary, the exact backoff sequence and
// its cap — without waiting out a real timer.
export interface RateDecision {
  readonly ok: boolean;
  /** Seconds until the next attempt could succeed. 0 when ok; always >= 1
   *  when refused, so a caller can always emit a meaningful Retry-After. */
  readonly retryAfterSeconds: number;
}

const DEFAULT_MAX_KEYS = 20_000;

export interface SlidingWindowLimiterOptions {
  /** Events admitted per key inside one window. */
  readonly max: number;
  readonly windowMs: number;
  /** Bound on distinct keys tracked at once; extra keys share one overflow
   *  bucket so a caller with unlimited source cardinality (spoofed licence
   *  ids, a claimed installId, distinct IPs) cannot grow this map without
   *  bound. Mirrors `FeedbackRateLimiter.boundedKey`. */
  readonly maxKeys?: number;
}

/** "At most `max` events per key per rolling `windowMs`." One instance per
 *  route/dimension (e.g. one for check-in-per-licence, a separate one for
 *  check-in-per-IP) — mixing dimensions into one instance would let a flood
 *  on one dimension evict the other's history. */
export class SlidingWindowLimiter {
  private readonly rows = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private attempts = 0;

  constructor(opts: SlidingWindowLimiterOptions) {
    if (!Number.isFinite(opts.max) || opts.max < 1) {
      throw new Error("SlidingWindowLimiter: max must be a positive integer");
    }
    if (!Number.isFinite(opts.windowMs) || opts.windowMs < 1) {
      throw new Error("SlidingWindowLimiter: windowMs must be a positive integer");
    }
    this.max = Math.floor(opts.max);
    this.windowMs = Math.floor(opts.windowMs);
    this.maxKeys = Math.max(1, Math.floor(opts.maxKeys ?? DEFAULT_MAX_KEYS));
  }

  /** Decide, and — when allowed — record the attempt. Call once per request,
   *  before the work that request would otherwise do. */
  take(rawKey: string, now: number): RateDecision {
    return this.inspect(rawKey, now, true);
  }

  /** Decide WITHOUT recording. Kept symmetric with
   *  `FeedbackRateLimiter.checkAccepted`/`recordAccepted` for a caller that
   *  must peek before an expensive or possibly-failing step and only spend
   *  the allowance once that step actually succeeds. */
  peek(rawKey: string, now: number): RateDecision {
    return this.inspect(rawKey, now, false);
  }

  private inspect(rawKey: string, now: number, consume: boolean): RateDecision {
    // A backwards clock must not retain an entry forever — clamp, then
    // discard anything outside this process's current window (same rule
    // FeedbackRateLimiter states for the identical reason).
    const at = Number.isFinite(now) ? now : Date.now();
    const cutoff = at - this.windowMs;
    const key = this.boundedKey(rawKey, cutoff, at);
    const active = (this.rows.get(key) ?? []).filter((stamp) => stamp > cutoff && stamp <= at);
    if (active.length >= this.max) {
      this.rows.set(key, active);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((active[0]! + this.windowMs - at) / 1_000)) };
    }
    if (consume) {
      active.push(at);
      this.rows.set(key, active);
    } else if (active.length) {
      this.rows.set(key, active);
    } else {
      this.rows.delete(key);
    }
    if (consume && ++this.attempts % 256 === 0) this.prune(at);
    return { ok: true, retryAfterSeconds: 0 };
  }

  private prune(at: number): void {
    const cutoff = at - this.windowMs;
    for (const [id, stamps] of this.rows) {
      const live = stamps.filter((stamp) => stamp > cutoff && stamp <= at);
      if (live.length) this.rows.set(id, live);
      else this.rows.delete(id);
    }
  }

  /** A deliberately shared overflow bucket keeps attacker-controlled key
   *  cardinality bounded without granting fresh allowance by evicting a
   *  live key. Mirrors `FeedbackRateLimiter.boundedKey` exactly. */
  private boundedKey(rawKey: string, cutoff: number, at: number): string {
    const overflow = "!overflow";
    const hasRoom = (): boolean => this.rows.size < this.maxKeys - (this.rows.has(overflow) ? 0 : 1);
    if (this.rows.has(rawKey) || hasRoom()) return rawKey;
    for (const [id, stamps] of this.rows) {
      if (!stamps.some((stamp) => stamp > cutoff && stamp <= at)) this.rows.delete(id);
    }
    return this.rows.has(rawKey) || hasRoom() ? rawKey : overflow;
  }
}

export interface AdminBackoffOptions {
  /** Consecutive failures (from a clean slate) before the FIRST lockout
   *  begins. Failures below this threshold are still refused (401) by the
   *  caller, but this limiter itself stays silent about them. */
  readonly failureThreshold: number;
  /** Lockout duration the first time the threshold is crossed. */
  readonly baseMs: number;
  /** A lockout never exceeds this, however many times it has doubled. */
  readonly maxMs: number;
  readonly maxKeys?: number;
}

interface AdminBackoffRow {
  failures: number;
  blockedUntil: number;
  /** The duration of the most recent lockout this key earned, so the NEXT
   *  one (a failure that arrives while still blocked, or the first failure
   *  after a lockout has expired) doubles it rather than recomputing from
   *  `failures` — a key that keeps failing across several lockout windows
   *  must keep doubling, not restart at baseMs because nothing here ever
   *  resets `failures` to zero on its own. */
  lockoutMs: number;
}

/** Exponential per-key lockout for repeated authentication failures. One
 *  success (`recordSuccess`) forgives the key completely — proof of the real
 *  secret means a legitimate caller who mistyped it a few times must not go
 *  on paying for that. Nothing here compares the secret itself; the caller
 *  decides right/wrong and reports the outcome. */
export class AdminBackoffLimiter {
  private readonly rows = new Map<string, AdminBackoffRow>();
  private readonly failureThreshold: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly maxKeys: number;

  constructor(opts: AdminBackoffOptions) {
    if (!Number.isFinite(opts.failureThreshold) || opts.failureThreshold < 1) {
      throw new Error("AdminBackoffLimiter: failureThreshold must be a positive integer");
    }
    if (!Number.isFinite(opts.baseMs) || opts.baseMs < 1) {
      throw new Error("AdminBackoffLimiter: baseMs must be a positive integer");
    }
    if (!Number.isFinite(opts.maxMs) || opts.maxMs < opts.baseMs) {
      throw new Error("AdminBackoffLimiter: maxMs must be >= baseMs");
    }
    this.failureThreshold = Math.floor(opts.failureThreshold);
    this.baseMs = Math.floor(opts.baseMs);
    this.maxMs = Math.floor(opts.maxMs);
    this.maxKeys = Math.max(1, Math.floor(opts.maxKeys ?? DEFAULT_MAX_KEYS));
  }

  /** Call BEFORE comparing the secret. A blocked key is refused with no
   *  compare attempted at all, so a caller cannot use the token comparison's
   *  own timing to learn anything while locked out. */
  check(key: string, now: number): RateDecision {
    const row = this.rows.get(key);
    if (!row || row.blockedUntil <= now) return { ok: true, retryAfterSeconds: 0 };
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((row.blockedUntil - now) / 1_000)) };
  }

  /** Call after a WRONG secret. Escalates the lockout once `failures`
   *  reaches the threshold; every failure at or past the threshold doubles
   *  the previous lockout duration, capped at `maxMs`. */
  recordFailure(rawKey: string, now: number): void {
    const key = this.boundedKey(rawKey);
    const row = this.rows.get(key) ?? { failures: 0, blockedUntil: 0, lockoutMs: 0 };
    row.failures += 1;
    if (row.failures >= this.failureThreshold) {
      row.lockoutMs = row.lockoutMs > 0 ? Math.min(this.maxMs, row.lockoutMs * 2) : this.baseMs;
      row.blockedUntil = now + row.lockoutMs;
    }
    this.rows.set(key, row);
  }

  /** Call after a RIGHT secret. Deletes the row outright — failures, the
   *  current lockout duration, everything — so a later run of bad guesses
   *  against this key starts the whole sequence over at `baseMs`. */
  recordSuccess(rawKey: string): void {
    this.rows.delete(rawKey);
  }

  /** A deliberately shared overflow bucket, same rule as
   *  `SlidingWindowLimiter.boundedKey`: bounded key cardinality, no
   *  allowance granted by evicting a key that is still meaningfully tracked
   *  (still failing, or still inside its lockout). */
  private boundedKey(rawKey: string): string {
    const overflow = "!overflow";
    const hasRoom = (): boolean => this.rows.size < this.maxKeys - (this.rows.has(overflow) ? 0 : 1);
    if (this.rows.has(rawKey) || hasRoom()) return rawKey;
    const now = Date.now();
    for (const [id, row] of this.rows) {
      if (row.failures < this.failureThreshold && row.blockedUntil <= now) this.rows.delete(id);
    }
    return this.rows.has(rawKey) || hasRoom() ? rawKey : overflow;
  }
}

// ── env-driven policy for the public-route limiters ─────────────────────────

export interface HubRateLimitPolicy {
  readonly checkinLicenseMax: number;
  readonly checkinLicenseWindowMs: number;
  readonly checkinIpMax: number;
  readonly checkinIpWindowMs: number;
  readonly leaseLicenseMax: number;
  readonly leaseLicenseWindowMs: number;
  readonly leaseIpMax: number;
  readonly leaseIpWindowMs: number;
  /** The general "everything else public" bucket: install.sh, /api/latest,
   *  /download/*, /welcome/*, /install/<token>, /api/billing/plans, /buy,
   *  /billing, /api/billing/portal-session. */
  readonly generalIpMax: number;
  readonly generalIpWindowMs: number;
  /** Stripe webhooks: signature-verified already, so this exists only to cap
   *  a runaway or hostile sender — deliberately generous so a burst of
   *  Stripe's own retries is never refused. */
  readonly webhookIpMax: number;
  readonly webhookIpWindowMs: number;
}

export const DEFAULT_RATE_LIMIT_POLICY: HubRateLimitPolicy = Object.freeze({
  checkinLicenseMax: 12,
  checkinLicenseWindowMs: 60_000,
  checkinIpMax: 60,
  checkinIpWindowMs: 60_000,
  leaseLicenseMax: 6,
  leaseLicenseWindowMs: 60_000,
  leaseIpMax: 60,
  leaseIpWindowMs: 60_000,
  generalIpMax: 60,
  generalIpWindowMs: 60_000,
  webhookIpMax: 600,
  webhookIpWindowMs: 60_000,
});

function positiveIntFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new Error(`${name} must be a positive integer: ${raw}`);
  return Math.floor(n);
}

export function rateLimitPolicyFromEnv(env: NodeJS.ProcessEnv): HubRateLimitPolicy {
  return {
    checkinLicenseMax: positiveIntFromEnv(env, "HUB_RATE_CHECKIN_LICENSE_MAX", DEFAULT_RATE_LIMIT_POLICY.checkinLicenseMax),
    checkinLicenseWindowMs: positiveIntFromEnv(env, "HUB_RATE_CHECKIN_LICENSE_WINDOW_MS", DEFAULT_RATE_LIMIT_POLICY.checkinLicenseWindowMs),
    checkinIpMax: positiveIntFromEnv(env, "HUB_RATE_CHECKIN_IP_MAX", DEFAULT_RATE_LIMIT_POLICY.checkinIpMax),
    checkinIpWindowMs: positiveIntFromEnv(env, "HUB_RATE_CHECKIN_IP_WINDOW_MS", DEFAULT_RATE_LIMIT_POLICY.checkinIpWindowMs),
    leaseLicenseMax: positiveIntFromEnv(env, "HUB_RATE_LEASE_LICENSE_MAX", DEFAULT_RATE_LIMIT_POLICY.leaseLicenseMax),
    leaseLicenseWindowMs: positiveIntFromEnv(env, "HUB_RATE_LEASE_LICENSE_WINDOW_MS", DEFAULT_RATE_LIMIT_POLICY.leaseLicenseWindowMs),
    leaseIpMax: positiveIntFromEnv(env, "HUB_RATE_LEASE_IP_MAX", DEFAULT_RATE_LIMIT_POLICY.leaseIpMax),
    leaseIpWindowMs: positiveIntFromEnv(env, "HUB_RATE_LEASE_IP_WINDOW_MS", DEFAULT_RATE_LIMIT_POLICY.leaseIpWindowMs),
    generalIpMax: positiveIntFromEnv(env, "HUB_RATE_IP_MAX", DEFAULT_RATE_LIMIT_POLICY.generalIpMax),
    generalIpWindowMs: positiveIntFromEnv(env, "HUB_RATE_IP_WINDOW_MS", DEFAULT_RATE_LIMIT_POLICY.generalIpWindowMs),
    webhookIpMax: positiveIntFromEnv(env, "HUB_RATE_WEBHOOK_IP_MAX", DEFAULT_RATE_LIMIT_POLICY.webhookIpMax),
    webhookIpWindowMs: positiveIntFromEnv(env, "HUB_RATE_WEBHOOK_IP_WINDOW_MS", DEFAULT_RATE_LIMIT_POLICY.webhookIpWindowMs),
  };
}

// ── env-driven policy for the admin-auth limiter ────────────────────────────

export interface AdminAuthPolicy {
  readonly failureThreshold: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** Parsed, trimmed, non-empty entries. Empty = no allowlist configured =
   *  every IP may attempt the token compare (today's behaviour, unchanged). */
  readonly ipAllowlist: readonly string[];
}

export const DEFAULT_ADMIN_AUTH_POLICY: AdminAuthPolicy = Object.freeze({
  failureThreshold: 5,
  backoffBaseMs: 60_000,
  backoffMaxMs: 60 * 60_000,
  ipAllowlist: [],
});

export function adminAuthPolicyFromEnv(env: NodeJS.ProcessEnv): AdminAuthPolicy {
  return {
    failureThreshold: positiveIntFromEnv(env, "HUB_RATE_ADMIN_FAILURE_THRESHOLD", DEFAULT_ADMIN_AUTH_POLICY.failureThreshold),
    backoffBaseMs: positiveIntFromEnv(env, "HUB_RATE_ADMIN_BACKOFF_BASE_MS", DEFAULT_ADMIN_AUTH_POLICY.backoffBaseMs),
    backoffMaxMs: positiveIntFromEnv(env, "HUB_RATE_ADMIN_BACKOFF_MAX_MS", DEFAULT_ADMIN_AUTH_POLICY.backoffMaxMs),
    ipAllowlist: parseIpAllowlist(env.HUB_ADMIN_IP_ALLOWLIST),
  };
}

export function parseIpAllowlist(raw: string | undefined): readonly string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── IP allowlist matching (exact IPv4/IPv6 and CIDR) ────────────────────────
//
// No runtime dependency exists for this (the repo is zero-dependency by
// design — see the README), so both address families are parsed by hand.
// IPv4 fits in a 32-bit int; IPv6 needs a 128-bit compare, done in BigInt so
// no precision is lost. Every helper below is pure and exported so a test can
// drive the parsing directly rather than only through the allowlist as a
// whole.

/** `null` = not a syntactically valid dotted-quad. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p[0] === "0")) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/** `null` = not a syntactically valid IPv6 literal (no brackets, no zone id —
 *  `clientIp()` never hands out either). Handles `::` compression and a
 *  trailing IPv4-mapped tail (`::ffff:1.2.3.4`). */
export function ipv6ToBigInt(ip: string): bigint | null {
  if (!isIPv6Shaped(ip)) return null; // the detailed parse below still validates every group
  const doubleColonAt = ip.indexOf("::");
  const hasDoubleColon = doubleColonAt !== -1;
  if (hasDoubleColon && ip.indexOf("::", doubleColonAt + 1) !== -1) return null; // "::" at most once
  const headStr = hasDoubleColon ? ip.slice(0, doubleColonAt) : ip;
  const tailStr = hasDoubleColon ? ip.slice(doubleColonAt + 2) : "";
  const headParts = headStr ? headStr.split(":") : [];
  const tailParts = tailStr ? tailStr.split(":") : [];
  const expandV4Tail = (parts: string[]): string[] | null => {
    if (parts.length === 0 || !parts[parts.length - 1]!.includes(".")) return parts;
    const v4 = ipv4ToInt(parts[parts.length - 1]!);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    return [...parts.slice(0, -1), hi, lo];
  };
  const head = expandV4Tail(headParts);
  const tail = expandV4Tail(tailParts);
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (!hasDoubleColon) {
    if (head.length !== 8 || tail.length !== 0) return null;
  } else if (missing < 0) {
    return null;
  }
  const groups = hasDoubleColon ? [...head, ...Array(missing).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Cheap shape check before the detailed parse: hex groups and colons only,
 *  at most one "::", and (for the non-compressed case) exactly 8 groups. This
 *  is deliberately loose — `ipv6ToBigInt` re-validates every group — it just
 *  keeps garbage from reaching the group-splitting logic. */
function isIPv6Shaped(ip: string): boolean {
  return /^[0-9a-fA-F:.]+$/.test(ip) && ip.includes(":");
}

function ipv4InCidr(ip: string, base: string, bits: number): boolean {
  if (bits < 0 || bits > 32) return false;
  const ipN = ipv4ToInt(ip);
  const baseN = ipv4ToInt(base);
  if (ipN === null || baseN === null) return false;
  if (bits === 0) return true;
  const shift = 32 - bits;
  return (ipN >>> shift) === (baseN >>> shift);
}

function ipv6InCidr(ip: string, base: string, bits: number): boolean {
  if (bits < 0 || bits > 128) return false;
  const ipN = ipv6ToBigInt(ip);
  const baseN = ipv6ToBigInt(base);
  if (ipN === null || baseN === null) return false;
  if (bits === 0) return true;
  const shift = BigInt(128 - bits);
  return (ipN >> shift) === (baseN >> shift);
}

/** One allowlist entry: a bare IPv4/IPv6 address (exact match) or a
 *  `<address>/<prefix-bits>` CIDR range. Mixed families never match. */
export function ipMatchesEntry(ip: string, entry: string): boolean {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    const v4 = ipv4ToInt(ip);
    const v4Entry = ipv4ToInt(entry);
    if (v4 !== null && v4Entry !== null) return v4 === v4Entry;
    const v6 = ipv6ToBigInt(ip);
    const v6Entry = ipv6ToBigInt(entry);
    return v6 !== null && v6Entry !== null && v6 === v6Entry;
  }
  const base = entry.slice(0, slash);
  const bitsRaw = entry.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bitsRaw)) return false;
  const bits = Number(bitsRaw);
  if (ipv4ToInt(ip) !== null && ipv4ToInt(base) !== null) return ipv4InCidr(ip, base, bits);
  if (ipv6ToBigInt(ip) !== null && ipv6ToBigInt(base) !== null) return ipv6InCidr(ip, base, bits);
  return false;
}

/** `entries.length === 0` (no `HUB_ADMIN_IP_ALLOWLIST` set) means "no
 *  allowlist configured" — every IP may attempt the admin token, which is
 *  today's behaviour, unchanged. A non-empty list is fail-closed: an IP that
 *  matches nothing in it (including an unparseable `"unknown"` from
 *  `clientIp()`) is refused before the token is even looked at. */
export function ipMatchesAllowlist(ip: string, entries: readonly string[]): boolean {
  if (entries.length === 0) return true;
  return entries.some((entry) => ipMatchesEntry(ip, entry));
}
