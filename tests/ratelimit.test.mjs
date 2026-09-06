// tests/ratelimit.test.mjs — the pure decisions in src/ratelimit.ts, driven
// directly with an injected clock so every edge (right at the limit, exactly
// at a window boundary, the exact backoff doubling sequence and its cap) is
// exact rather than timing-dependent.
import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import {
  AdminBackoffLimiter,
  SlidingWindowLimiter,
  ipMatchesAllowlist,
  ipMatchesEntry,
  ipv4ToInt,
  ipv6ToBigInt,
  parseIpAllowlist,
  rateLimitPolicyFromEnv,
  adminAuthPolicyFromEnv,
  DEFAULT_RATE_LIMIT_POLICY,
  DEFAULT_ADMIN_AUTH_POLICY,
} from "../dist/src/ratelimit.js";

// ── SlidingWindowLimiter ─────────────────────────────────────────────────────

await test("admits up to max, then refuses with a positive retryAfterSeconds", () => {
  const lim = new SlidingWindowLimiter({ max: 3, windowMs: 60_000 });
  let now = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(lim.take("k", now).ok, true, `attempt ${i}`);
  const refused = lim.take("k", now);
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfterSeconds >= 1);
  assert.equal(Number.isInteger(refused.retryAfterSeconds), true);
});

await test("refusing does NOT consume a slot — a still-refused caller sees the SAME retryAfterSeconds shrink only with real time", () => {
  const lim = new SlidingWindowLimiter({ max: 1, windowMs: 10_000 });
  let now = 0;
  assert.equal(lim.take("k", now).ok, true);
  const first = lim.take("k", now);
  assert.equal(first.ok, false);
  assert.equal(first.retryAfterSeconds, 10);
  now += 4_000;
  const second = lim.take("k", now);
  assert.equal(second.ok, false);
  assert.equal(second.retryAfterSeconds, 6, "retryAfterSeconds tracks the ORIGINAL admitted stamp, not a fresh window");
});

await test("exactly at the window boundary the oldest attempt has aged out", () => {
  const lim = new SlidingWindowLimiter({ max: 1, windowMs: 10_000 });
  assert.equal(lim.take("k", 0).ok, true);
  assert.equal(lim.take("k", 9_999).ok, false, "still inside the window");
  assert.equal(lim.take("k", 10_001).ok, true, "past the window, the old stamp is gone");
});

await test("keys are independent — a flood on one key never refuses another", () => {
  const lim = new SlidingWindowLimiter({ max: 1, windowMs: 60_000 });
  assert.equal(lim.take("a", 0).ok, true);
  assert.equal(lim.take("a", 0).ok, false);
  assert.equal(lim.take("b", 0).ok, true, "key b has its own budget");
});

await test("peek never consumes — the SAME caller can peek any number of times without spending its budget", () => {
  const lim = new SlidingWindowLimiter({ max: 1, windowMs: 60_000 });
  for (let i = 0; i < 5; i++) assert.equal(lim.peek("k", 0).ok, true);
  assert.equal(lim.take("k", 0).ok, true);
  assert.equal(lim.peek("k", 0).ok, false, "peek still SEES the consumed slot");
});

await test("a bounded key population shares one overflow bucket rather than growing without limit", () => {
  const lim = new SlidingWindowLimiter({ max: 1, windowMs: 60_000, maxKeys: 2 });
  assert.equal(lim.take("a", 0).ok, true);
  assert.equal(lim.take("b", 0).ok, true);
  // A third distinct key with no room left lands in the shared overflow
  // bucket, which is ALREADY spent by a and b having filled the table (both
  // still inside their window, so nothing is evictable) — refused.
  const third = lim.take("c", 0);
  assert.equal(third.ok, false, "no room for a third distinct key while a/b are still live");
});

await test("constructor refuses a non-positive max or windowMs", () => {
  assert.throws(() => new SlidingWindowLimiter({ max: 0, windowMs: 1000 }));
  assert.throws(() => new SlidingWindowLimiter({ max: 1, windowMs: 0 }));
  assert.throws(() => new SlidingWindowLimiter({ max: -1, windowMs: 1000 }));
});

// ── AdminBackoffLimiter ──────────────────────────────────────────────────────

await test("below the failure threshold, check() stays ok — only crossing it opens a lockout", () => {
  const lim = new AdminBackoffLimiter({ failureThreshold: 5, baseMs: 60_000, maxMs: 3_600_000 });
  let now = 0;
  for (let i = 0; i < 4; i++) {
    lim.recordFailure("ip", now);
    assert.equal(lim.check("ip", now).ok, true, `still ok after failure ${i + 1}`);
  }
});

await test("the threshold-crossing failure opens exactly baseMs, and doubles on each escalation past it", () => {
  const lim = new AdminBackoffLimiter({ failureThreshold: 5, baseMs: 60_000, maxMs: 3_600_000 });
  const now = 0;
  for (let i = 0; i < 5; i++) lim.recordFailure("ip", now);
  const blocked = lim.check("ip", now);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterSeconds, 60, "the FIRST lockout is exactly baseMs");
  // A sixth failure (still within/at the lockout) doubles it.
  lim.recordFailure("ip", now);
  const doubled = lim.check("ip", now);
  assert.equal(doubled.retryAfterSeconds, 120, "the second escalation is 2x baseMs");
  lim.recordFailure("ip", now);
  assert.equal(lim.check("ip", now).retryAfterSeconds, 240);
});

await test("doubling is capped at maxMs and never exceeds it however many times it escalates", () => {
  const lim = new AdminBackoffLimiter({ failureThreshold: 1, baseMs: 60_000, maxMs: 200_000 });
  const now = 0;
  lim.recordFailure("ip", now); // -> 60_000
  lim.recordFailure("ip", now); // -> 120_000
  lim.recordFailure("ip", now); // -> would be 240_000, capped at 200_000
  const blocked = lim.check("ip", now);
  assert.equal(blocked.retryAfterSeconds, 200);
  lim.recordFailure("ip", now); // stays at the cap
  assert.equal(lim.check("ip", now).retryAfterSeconds, 200);
});

await test("a lockout expires on its own — check() returns ok once blockedUntil has passed", () => {
  const lim = new AdminBackoffLimiter({ failureThreshold: 1, baseMs: 60_000, maxMs: 3_600_000 });
  lim.recordFailure("ip", 0);
  assert.equal(lim.check("ip", 0).ok, false);
  assert.equal(lim.check("ip", 59_999).ok, false);
  assert.equal(lim.check("ip", 60_000).ok, true, "blockedUntil is inclusive of the boundary");
});

await test("recordSuccess forgives completely — the NEXT failure sequence starts over at baseMs", () => {
  const lim = new AdminBackoffLimiter({ failureThreshold: 2, baseMs: 60_000, maxMs: 3_600_000 });
  const now = 0;
  lim.recordFailure("ip", now);
  lim.recordFailure("ip", now); // crosses threshold -> 60_000 lockout
  assert.equal(lim.check("ip", now).ok, false);
  lim.recordSuccess("ip");
  assert.equal(lim.check("ip", now).ok, true, "success clears the lockout immediately");
  lim.recordFailure("ip", now);
  assert.equal(lim.check("ip", now).ok, true, "one failure alone is still under a reset threshold");
  lim.recordFailure("ip", now);
  assert.equal(lim.check("ip", now).retryAfterSeconds, 60, "the sequence restarted at baseMs, not doubled from before");
});

await test("distinct keys never share a lockout", () => {
  const lim = new AdminBackoffLimiter({ failureThreshold: 1, baseMs: 60_000, maxMs: 3_600_000 });
  lim.recordFailure("a", 0);
  assert.equal(lim.check("a", 0).ok, false);
  assert.equal(lim.check("b", 0).ok, true);
});

await test("constructor validates its options", () => {
  assert.throws(() => new AdminBackoffLimiter({ failureThreshold: 0, baseMs: 1000, maxMs: 2000 }));
  assert.throws(() => new AdminBackoffLimiter({ failureThreshold: 1, baseMs: 0, maxMs: 2000 }));
  assert.throws(() => new AdminBackoffLimiter({ failureThreshold: 1, baseMs: 2000, maxMs: 1000 }), /maxMs must be >= baseMs/);
});

// ── IP parsing / CIDR matching ───────────────────────────────────────────────

await test("ipv4ToInt parses dotted-quads and rejects garbage", () => {
  assert.equal(ipv4ToInt("127.0.0.1"), (127 << 24 | 0 << 16 | 0 << 8 | 1) >>> 0);
  assert.equal(ipv4ToInt("255.255.255.255"), 0xffffffff);
  assert.equal(ipv4ToInt("0.0.0.0"), 0);
  assert.equal(ipv4ToInt("256.0.0.1"), null);
  assert.equal(ipv4ToInt("1.2.3"), null);
  assert.equal(ipv4ToInt("1.2.3.4.5"), null);
  assert.equal(ipv4ToInt("01.0.0.1"), null, "no leading zeros — avoids octal-shaped ambiguity");
  assert.equal(ipv4ToInt("not.an.ip.addr"), null);
});

await test("ipv6ToBigInt handles :: compression, full form, and an IPv4-mapped tail", () => {
  assert.equal(ipv6ToBigInt("::1"), 1n);
  assert.equal(ipv6ToBigInt("::"), 0n);
  assert.equal(ipv6ToBigInt("2001:db8::1"), (0x2001n << 112n) | (0x0db8n << 96n) | 1n);
  assert.equal(
    ipv6ToBigInt("2001:0db8:0000:0000:0000:0000:0000:0001"),
    ipv6ToBigInt("2001:db8::1"),
    "compressed and expanded forms of the same address agree",
  );
  const mapped = ipv6ToBigInt("::ffff:127.0.0.1");
  assert.equal(mapped, (0xffffn << 32n) | 0x7f000001n);
  assert.equal(ipv6ToBigInt("1::2::3"), null, "more than one :: is invalid");
  assert.equal(ipv6ToBigInt("not:an:ip"), null);
  assert.equal(ipv6ToBigInt("127.0.0.1"), null, "a plain IPv4 literal is not an IPv6 one");
});

await test("ipMatchesEntry: exact match for both families, CIDR for both families, mixed families never match", () => {
  assert.equal(ipMatchesEntry("127.0.0.1", "127.0.0.1"), true);
  assert.equal(ipMatchesEntry("127.0.0.1", "127.0.0.2"), false);
  assert.equal(ipMatchesEntry("::1", "::1"), true);
  assert.equal(ipMatchesEntry("::1", "::2"), false);
  assert.equal(ipMatchesEntry("10.1.2.3", "10.0.0.0/8"), true);
  assert.equal(ipMatchesEntry("10.1.2.3", "10.0.0.0/16"), false);
  assert.equal(ipMatchesEntry("192.168.1.1", "192.168.1.0/24"), true);
  assert.equal(ipMatchesEntry("192.168.2.1", "192.168.1.0/24"), false);
  assert.equal(ipMatchesEntry("0.0.0.1", "0.0.0.0/0"), true, "a /0 admits every address in its family");
  assert.equal(ipMatchesEntry("2001:db8::5", "2001:db8::/32"), true);
  assert.equal(ipMatchesEntry("2001:db9::5", "2001:db8::/32"), false);
  assert.equal(ipMatchesEntry("10.0.0.1", "2001:db8::/32"), false, "a v4 address never matches a v6 CIDR");
  assert.equal(ipMatchesEntry("::1", "10.0.0.0/8"), false, "a v6 address never matches a v4 CIDR");
  assert.equal(ipMatchesEntry("10.0.0.1", "10.0.0.0/abc"), false, "a non-numeric prefix length never matches");
  assert.equal(ipMatchesEntry("10.0.0.1", "10.0.0.0/33"), false, "an out-of-range v4 prefix never matches");
});

await test("parseIpAllowlist trims and drops empty entries", () => {
  assert.deepEqual(parseIpAllowlist(undefined), []);
  assert.deepEqual(parseIpAllowlist(""), []);
  assert.deepEqual(parseIpAllowlist(" 10.0.0.1 , , 10.0.0.2/32 "), ["10.0.0.1", "10.0.0.2/32"]);
});

await test("ipMatchesAllowlist: an empty list admits everything (no allowlist configured); a non-empty list is fail-closed", () => {
  assert.equal(ipMatchesAllowlist("203.0.113.5", []), true);
  assert.equal(ipMatchesAllowlist("10.0.0.5", ["10.0.0.0/8"]), true);
  assert.equal(ipMatchesAllowlist("203.0.113.5", ["10.0.0.0/8"]), false);
  assert.equal(ipMatchesAllowlist("unknown", ["10.0.0.0/8"]), false, "an unparseable peer never matches a configured allowlist");
  assert.equal(ipMatchesAllowlist("unknown", []), true, "but is admitted when no allowlist is configured at all");
});

// ── env-driven policy ─────────────────────────────────────────────────────────

await test("rateLimitPolicyFromEnv: absent env falls back to every documented default", () => {
  assert.deepEqual(rateLimitPolicyFromEnv({}), DEFAULT_RATE_LIMIT_POLICY);
});

await test("rateLimitPolicyFromEnv: every HUB_RATE_* variable is independently overridable", () => {
  const p = rateLimitPolicyFromEnv({
    HUB_RATE_CHECKIN_LICENSE_MAX: "5",
    HUB_RATE_CHECKIN_LICENSE_WINDOW_MS: "1000",
    HUB_RATE_CHECKIN_IP_MAX: "7",
    HUB_RATE_CHECKIN_IP_WINDOW_MS: "2000",
    HUB_RATE_LEASE_LICENSE_MAX: "3",
    HUB_RATE_LEASE_LICENSE_WINDOW_MS: "3000",
    HUB_RATE_LEASE_IP_MAX: "9",
    HUB_RATE_LEASE_IP_WINDOW_MS: "4000",
    HUB_RATE_IP_MAX: "11",
    HUB_RATE_IP_WINDOW_MS: "5000",
    HUB_RATE_WEBHOOK_IP_MAX: "1200",
    HUB_RATE_WEBHOOK_IP_WINDOW_MS: "6000",
  });
  assert.deepEqual(p, {
    checkinLicenseMax: 5, checkinLicenseWindowMs: 1000,
    checkinIpMax: 7, checkinIpWindowMs: 2000,
    leaseLicenseMax: 3, leaseLicenseWindowMs: 3000,
    leaseIpMax: 9, leaseIpWindowMs: 4000,
    generalIpMax: 11, generalIpWindowMs: 5000,
    webhookIpMax: 1200, webhookIpWindowMs: 6000,
  });
});

await test("rateLimitPolicyFromEnv rejects a non-positive override rather than silently falling back", () => {
  assert.throws(() => rateLimitPolicyFromEnv({ HUB_RATE_CHECKIN_LICENSE_MAX: "0" }), /HUB_RATE_CHECKIN_LICENSE_MAX/);
  assert.throws(() => rateLimitPolicyFromEnv({ HUB_RATE_IP_MAX: "-1" }));
  assert.throws(() => rateLimitPolicyFromEnv({ HUB_RATE_IP_MAX: "not-a-number" }));
});

await test("adminAuthPolicyFromEnv: absent env is the documented default, no allowlist", () => {
  assert.deepEqual(adminAuthPolicyFromEnv({}), DEFAULT_ADMIN_AUTH_POLICY);
});

await test("adminAuthPolicyFromEnv reads HUB_ADMIN_IP_ALLOWLIST and the HUB_RATE_ADMIN_* overrides", () => {
  const p = adminAuthPolicyFromEnv({
    HUB_ADMIN_IP_ALLOWLIST: "10.0.0.1, 192.168.0.0/16",
    HUB_RATE_ADMIN_FAILURE_THRESHOLD: "3",
    HUB_RATE_ADMIN_BACKOFF_BASE_MS: "5000",
    HUB_RATE_ADMIN_BACKOFF_MAX_MS: "50000",
  });
  assert.deepEqual(p, {
    failureThreshold: 3, backoffBaseMs: 5000, backoffMaxMs: 50000,
    ipAllowlist: ["10.0.0.1", "192.168.0.0/16"],
  });
});

summary("ratelimit");
