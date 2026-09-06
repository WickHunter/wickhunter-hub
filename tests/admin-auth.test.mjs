// tests/admin-auth.test.mjs — v0.4.17 admin-auth hardening: the per-IP
// exponential backoff on repeated x-hub-admin failures, and the optional
// HUB_ADMIN_IP_ALLOWLIST checked before the token. tests/admin.test.mjs keeps
// covering the ORDINARY auth shape (right/wrong/disabled); this file drives
// the NEW dimension with an injected, hand-advanced clock so the exact
// doubling sequence and its cap are asserted rather than timed.
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";

// ── exponential backoff ─────────────────────────────────────────────────────
{
  let clock = 1_000_000;
  const h = await freshHub({
    adminAuth: { failureThreshold: 3, backoffBaseMs: 10_000, backoffMaxMs: 40_000, ipAllowlist: [] },
  }, { rateLimitNow: () => clock });
  const RIGHT = { "x-hub-admin": "test-admin-token" };
  const WRONG = { "x-hub-admin": "not-the-token" };
  const ip = "203.0.113.1";
  const call = (headers) => jsonReq(`${h.origin}/admin/api/licenses`, { headers: { ...headers, "x-forwarded-for": ip } });

  await test("below the failure threshold, wrong tokens are plain 401s — no Retry-After, no lockout", async () => {
    for (let i = 0; i < 2; i++) {
      const r = await call(WRONG);
      assert.equal(r.status, 401);
    }
    // The RIGHT token still works — two failures alone never opened a lockout.
    const ok = await call(RIGHT);
    assert.equal(ok.status, 200);
  });

  await test("crossing the threshold opens a lockout at exactly backoffBaseMs, refusing even the RIGHT token", async () => {
    // The prior test's success reset the counter; three fresh failures cross
    // the threshold=3 on the third.
    for (let i = 0; i < 3; i++) await call(WRONG);
    const blocked = await call(RIGHT);
    assert.equal(blocked.status, 429, "even the correct token is refused while locked out — no compare is even attempted");
    assert.ok(blocked.body.retryAfterSeconds >= 1 && blocked.body.retryAfterSeconds <= 10);
    const raw = await fetch(`${h.origin}/admin/api/licenses`, { headers: { ...RIGHT, "x-forwarded-for": ip } });
    assert.equal(raw.headers.get("retry-after"), String(blocked.body.retryAfterSeconds));
  });

  await test("a failure that arrives while still locked out doubles the NEXT lockout", async () => {
    clock += 10_001; // past the first (10s) lockout
    const stillWrong = await call(WRONG); // crosses the threshold again -> doubles to 20s
    assert.equal(stillWrong.status, 401, "the lockout had expired, so the compare runs and reports the real outcome");
    const blocked = await call(RIGHT);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.retryAfterSeconds, 20, "the second escalation is 2x backoffBaseMs");
  });

  await test("doubling is capped at backoffMaxMs however many times it escalates further", async () => {
    clock += 20_001; // past the 20s lockout
    await call(WRONG); // -> would double to 40s, which IS backoffMaxMs here
    let blocked = await call(RIGHT);
    assert.equal(blocked.body.retryAfterSeconds, 40);
    clock += 40_001;
    await call(WRONG); // would double to 80s — capped at 40s
    blocked = await call(RIGHT);
    assert.equal(blocked.body.retryAfterSeconds, 40, "never exceeds backoffMaxMs");
  });

  await test("one successful token clears the lockout AND the failure count outright", async () => {
    clock += 40_001; // past the current lockout so the right token is even attempted
    const ok = await call(RIGHT);
    assert.equal(ok.status, 200);
    // Immediately after success, two more wrong attempts (below threshold=3
    // again) are plain 401s, not a refused-by-lockout 429 — proving the
    // count really reset to zero rather than merely un-blocking.
    for (let i = 0; i < 2; i++) assert.equal((await call(WRONG)).status, 401);
    assert.equal((await call(RIGHT)).status, 200, "still under the threshold, so no lockout was opened");
  });

  await test("a DIFFERENT source IP has its own untouched backoff state", async () => {
    // Exhaust the ip's budget again.
    for (let i = 0; i < 3; i++) await call(WRONG);
    assert.equal((await call(RIGHT)).status, 429, "ip is now locked out");
    const other = await jsonReq(`${h.origin}/admin/api/licenses`, { headers: { ...RIGHT, "x-forwarded-for": "198.51.100.9" } });
    assert.equal(other.status, 200, "a different IP was never touched");
  });

  await h.close();
}

// ── HUB_ADMIN_IP_ALLOWLIST ───────────────────────────────────────────────────
{
  const h = await freshHub({
    adminAuth: { failureThreshold: 5, backoffBaseMs: 60_000, backoffMaxMs: 3_600_000, ipAllowlist: ["10.0.0.0/8", "198.51.100.42"] },
  });
  const RIGHT = { "x-hub-admin": "test-admin-token" };
  const allowed = (ip) => jsonReq(`${h.origin}/admin/api/licenses`, { headers: { ...RIGHT, "x-forwarded-for": ip } });

  await test("an IP inside an allowlisted CIDR is admitted with the right token", async () => {
    const r = await allowed("10.1.2.3");
    assert.equal(r.status, 200);
  });

  await test("an IP matching an allowlisted exact address is admitted", async () => {
    const r = await allowed("198.51.100.42");
    assert.equal(r.status, 200);
  });

  await test("an IP outside every allowlist entry is refused BEFORE the token is even compared — the RIGHT token does not help", async () => {
    const r = await allowed("203.0.113.9");
    assert.equal(r.status, 403);
    assert.equal(r.body.ok, false);
  });

  await test("a wrong token from a disallowed IP is still 403, not 401 — the allowlist is checked first", async () => {
    const r = await jsonReq(`${h.origin}/admin/api/licenses`, { headers: { "x-hub-admin": "nope", "x-forwarded-for": "203.0.113.9" } });
    assert.equal(r.status, 403);
  });

  await test("a disallowed IP never spends a backoff attempt — it cannot be locked out at all", async () => {
    for (let i = 0; i < 10; i++) await allowed("203.0.113.9");
    const r = await allowed("203.0.113.9");
    assert.equal(r.status, 403, "still a plain allowlist refusal, never escalates to a lease-style lockout");
  });

  await h.close();
}

// ── admin disabled still short-circuits before the allowlist/backoff ───────
{
  const h = await freshHub({
    adminToken: "",
    adminAuth: { failureThreshold: 5, backoffBaseMs: 60_000, backoffMaxMs: 3_600_000, ipAllowlist: ["198.51.100.1"] },
  });

  await test("with no HUB_ADMIN_TOKEN, every caller still gets 503 — the allowlist never even runs", async () => {
    const r = await jsonReq(`${h.origin}/admin/api/licenses`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /admin disabled/);
  });

  await h.close();
}

summary("admin-auth");
