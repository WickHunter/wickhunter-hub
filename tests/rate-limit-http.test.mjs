// tests/rate-limit-http.test.mjs — the public-route limiters wired into
// src/server.ts, driven over real HTTP on loopback with an INJECTED,
// hand-advanced clock (never the auto-fast-forwarding default `freshHub`
// gives every other suite — see tests/helpers.mjs), so every window edge is
// exact. Covers: check-in refused at its per-licence AND per-IP limit with
// Retry-After and NO state change; the machine-bound lease routes the same
// way; the general "everything else public" bucket, scoped away from
// unrelated routes; and a Stripe-retry-shaped webhook burst that is never
// refused under the deliberately generous webhook allowance.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";

function machine() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return { privateKey: pair.privateKey, publicKey: der.subarray(-32).toString("base64url") };
}
function leaseSignature(challenge, privateKey) {
  return sign(null, Buffer.from(challenge.proofBytesB64u, "base64url"), privateKey).toString("base64url");
}

// ── check-in: per-licence and per-IP, no state change on refusal ───────────
{
  let clock = 1_000_000;
  const h = await freshHub({
    rateLimits: {
      checkinLicenseMax: 3, checkinLicenseWindowMs: 60_000,
      checkinIpMax: 5, checkinIpWindowMs: 60_000,
      leaseLicenseMax: 6, leaseLicenseWindowMs: 60_000,
      leaseIpMax: 60, leaseIpWindowMs: 60_000,
      generalIpMax: 60, generalIpWindowMs: 60_000,
      webhookIpMax: 600, webhookIpWindowMs: 60_000,
    },
  }, { rateLimitNow: () => clock });
  const AUTH = { "x-hub-admin": "test-admin-token" };
  const issued = h.store.issue("Rate Limit Tester", 30);
  const L = issued.payload.id;
  const checkin = (installId, ts, ip = "203.0.113.9") => jsonReq(`${h.origin}/api/license/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ licenseId: L, installId, version: "1.0.0", ts }),
  });
  const lastSeen = async () => (await jsonReq(`${h.origin}/admin/api/licenses`, { headers: AUTH }))
    .body.licenses.find((r) => r.id === L).lastSeen;

  await test("check-in: the licence's own bucket refuses past its per-minute max, with Retry-After, and records NOTHING for the refused attempts", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await checkin(`inst-${i}`, 1000 + i);
      assert.equal(r.status, 200, `attempt ${i} should be admitted`);
    }
    const before = await lastSeen();
    assert.equal(before.installId, "inst-2", "the third admitted attempt is the one on record");
    const refused = await checkin("inst-refused", 9999);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.ok, false);
    assert.ok(refused.body.retryAfterSeconds >= 1);
    assert.ok(/rate limited/.test(refused.body.error));
    const after = await lastSeen();
    assert.deepEqual(after, before, "a refused check-in never reaches recordCheckin — the roster is byte-for-byte unchanged");
  });

  await test("check-in: Retry-After header matches the JSON body exactly", async () => {
    const r = await checkin("inst-header-check", 1);
    assert.equal(r.status, 429);
    const raw = await fetch(`${h.origin}/api/license/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ licenseId: L, installId: "inst-header-check-2", version: "1.0.0", ts: 1 }),
    });
    assert.equal(raw.status, 429);
    const body = await raw.json();
    assert.equal(raw.headers.get("retry-after"), String(body.retryAfterSeconds));
    assert.equal(raw.headers.get("cache-control"), "no-store");
  });

  await test("check-in: once past the window, the licence bucket admits again — the refusal is temporary, not a ban", async () => {
    clock += 60_001;
    const r = await checkin("inst-after-window", 20000);
    assert.equal(r.status, 200);
  });

  await test("check-in: the per-IP bucket is a SEPARATE dimension — a flood of DIFFERENT claimed licence ids from one IP is still capped by IP", async () => {
    clock += 120_000; // fresh windows on both dimensions
    const otherIds = [h.store.issue("A", 30), h.store.issue("B", 30), h.store.issue("C", 30), h.store.issue("D", 30), h.store.issue("E", 30)]
      .map((x) => x.payload.id);
    let admitted = 0;
    let refused = 0;
    for (const id of otherIds) {
      const r = await jsonReq(`${h.origin}/api/license/checkin`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ licenseId: id, installId: "x", version: "1.0.0", ts: 1 }),
      });
      if (r.status === 200) admitted++;
      else { refused++; assert.equal(r.status, 429); }
    }
    assert.equal(admitted, 5, "the IP bucket was configured to 5/min and every id was distinct");
    assert.equal(refused, 0);
    const sixth = await jsonReq(`${h.origin}/api/license/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ licenseId: h.store.issue("F", 30).payload.id, installId: "x", version: "1.0.0", ts: 1 }),
    });
    assert.equal(sixth.status, 429, "the SIXTH distinct-licence attempt from the same IP this minute is refused by the IP bucket");
  });

  await test("check-in: a different source IP has its own untouched budget", async () => {
    const r = await checkin("inst-from-elsewhere", 1, "198.51.100.44");
    assert.equal(r.status, 200);
  });

  await h.close();
}

// ── machine-bound lease: per-licence and per-IP, no state change ───────────
{
  let clock = 1_000_000;
  const h = await freshHub({
    rateLimits: {
      checkinLicenseMax: 60, checkinLicenseWindowMs: 60_000,
      checkinIpMax: 60, checkinIpWindowMs: 60_000,
      leaseLicenseMax: 2, leaseLicenseWindowMs: 60_000,
      leaseIpMax: 3, leaseIpWindowMs: 60_000,
      generalIpMax: 60, generalIpWindowMs: 60_000,
      webhookIpMax: 600, webhookIpWindowMs: 60_000,
    },
    licenseLease: { leaseDurationMs: 3_600_000, cachedGraceMs: 6 * 3_600_000, challengeTtlMs: 60_000, maxClockSkewMs: 30_000, defaultMaxMachines: 1 },
  }, { rateLimitNow: () => clock, licenseLeaseNow: () => clock, licenseLeaseMonotonicNow: () => clock });
  const AUTH = { "x-hub-admin": "test-admin-token" };
  const issued = h.store.issue("Lease Rate Tester", 30);
  const headers = { "content-type": "application/json", "x-license": issued.token, "x-forwarded-for": "203.0.113.44" };
  const auditRevision = async () => (await jsonReq(`${h.origin}/admin/api/license-leases?licenseId=${issued.payload.id}`, { headers: AUTH }))
    .body.auditRevision;
  const challenge = (installId, key) => jsonReq(`${h.origin}/api/license/lease/challenge`, {
    method: "POST", headers,
    body: JSON.stringify({ purpose: "activate", installId, installPublicKey: key.publicKey }),
  });

  await test("lease: the per-licence bucket refuses the 3rd challenge inside the window, Retry-After present, and NO audit event is written", async () => {
    assert.equal((await challenge("lease-a", machine())).status, 200);
    assert.equal((await challenge("lease-b", machine())).status, 200);
    const before = await auditRevision();
    assert.ok(before >= 2, "two challenges were issued and audited");
    const refused = await challenge("lease-c", machine());
    assert.equal(refused.status, 429);
    assert.ok(refused.body.retryAfterSeconds >= 1);
    assert.equal("challenge" in refused.body, false, "no challenge is minted on a refusal");
    const after = await auditRevision();
    assert.equal(after, before, "a refused lease request never reaches the lease service — the ledger is unchanged");
  });

  await test("lease: a genuine token that fails to decode as anything real still buckets (bounded, not unbounded key growth) rather than bypassing the limiter", async () => {
    // Already exhausted above; a garbage bearer from the SAME IP hits the
    // (still-exhausted) per-IP bucket, not the per-licence one — proving the
    // IP dimension is checked independently.
    const r = await jsonReq(`${h.origin}/api/license/lease/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-license": "LHK1.garbage.garbage", "x-forwarded-for": "203.0.113.44" },
      body: JSON.stringify({ purpose: "activate", installId: "x", installPublicKey: machine().publicKey }),
    });
    assert.equal(r.status, 429, "the per-IP lease bucket (3/min) was already spent by the two prior successful challenges plus the refused one");
  });

  await test("lease: a different licence AND a different IP has its own untouched budget", async () => {
    clock += 60_001;
    const otherIssued = h.store.issue("Lease Rate Tester 2", 30);
    const r = await jsonReq(`${h.origin}/api/license/lease/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-license": otherIssued.token, "x-forwarded-for": "198.51.100.99" },
      body: JSON.stringify({ purpose: "activate", installId: "other", installPublicKey: machine().publicKey }),
    });
    assert.equal(r.status, 200);
  });

  await h.close();
}

// ── the general "everything else public" bucket ─────────────────────────────
{
  let clock = 1_000_000;
  const h = await freshHub({
    rateLimits: {
      checkinLicenseMax: 60, checkinLicenseWindowMs: 60_000,
      checkinIpMax: 60, checkinIpWindowMs: 60_000,
      leaseLicenseMax: 60, leaseLicenseWindowMs: 60_000,
      leaseIpMax: 60, leaseIpWindowMs: 60_000,
      generalIpMax: 2, generalIpWindowMs: 60_000,
      webhookIpMax: 600, webhookIpWindowMs: 60_000,
    },
  }, { rateLimitNow: () => clock });
  const ip = { "x-forwarded-for": "203.0.113.77" };

  await test("general bucket: /api/billing/plans is refused past its per-IP max", async () => {
    assert.equal((await jsonReq(`${h.origin}/api/billing/plans`, { headers: ip })).status, 200);
    assert.equal((await jsonReq(`${h.origin}/api/billing/plans`, { headers: ip })).status, 200);
    const third = await jsonReq(`${h.origin}/api/billing/plans`, { headers: ip });
    assert.equal(third.status, 429);
    assert.ok(third.body.retryAfterSeconds >= 1);
  });

  await test("general bucket is SHARED across its named routes — a second route from the same IP is already spent too", async () => {
    const r = await jsonReq(`${h.origin}/install.sh?key=nope`, { headers: ip });
    assert.equal(r.status, 429, "install.sh shares the same general bucket as /api/billing/plans");
  });

  await test("a route NOT in the general bucket is completely unaffected — /api/health stays live", async () => {
    const r = await jsonReq(`${h.origin}/api/health`, { headers: ip });
    assert.equal(r.status, 200);
  });

  await test("a different IP has its own untouched general budget", async () => {
    const r = await jsonReq(`${h.origin}/api/billing/plans`, { headers: { "x-forwarded-for": "198.51.100.5" } });
    assert.equal(r.status, 200);
  });

  await h.close();
}

// ── Stripe webhook: generous, never refused by a retry-shaped burst ────────
{
  let clock = 1_000_000;
  // A general bucket small enough that the SAME burst would visibly refuse
  // an ordinary public route — proving the webhook is on its OWN allowance,
  // not merely "large by coincidence".
  const h = await freshHub({
    rateLimits: {
      checkinLicenseMax: 60, checkinLicenseWindowMs: 60_000,
      checkinIpMax: 60, checkinIpWindowMs: 60_000,
      leaseLicenseMax: 60, leaseLicenseWindowMs: 60_000,
      leaseIpMax: 60, leaseIpWindowMs: 60_000,
      generalIpMax: 3, generalIpWindowMs: 60_000,
      webhookIpMax: 20, webhookIpWindowMs: 60_000,
    },
  }, { rateLimitNow: () => clock });
  const ip = "203.0.113.88";

  await test("webhook: a burst well past the general bucket's ceiling is never rate-limited (still processed/refused on its own merits — signature, config — never 429)", async () => {
    let sawRateLimited = false;
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`${h.origin}/api/billing/stripe/test`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip, "stripe-signature": "t=1,v1=deadbeef" },
        body: JSON.stringify({ id: `evt_${i}`, object: "event" }),
      });
      if (r.status === 429) sawRateLimited = true;
    }
    assert.equal(sawRateLimited, false, "15 webhook posts stayed under the webhook bucket's 20/min allowance");
  });

  await test("webhook: the SAME burst size against the general bucket (3/min) WOULD refuse — proving the webhook path is not merely reusing that bucket", async () => {
    let refused = 0;
    for (let i = 0; i < 15; i++) {
      const r = await jsonReq(`${h.origin}/api/billing/plans`, { headers: { "x-forwarded-for": "198.51.100.200" } });
      if (r.status === 429) refused++;
    }
    assert.ok(refused > 0, "the general bucket, sized to 3/min, refuses well before 15 requests");
  });

  await test("webhook: past ITS OWN ceiling, the webhook bucket refuses too — it is generous, not unlimited", async () => {
    for (let i = 15; i < 20; i++) {
      await fetch(`${h.origin}/api/billing/stripe/test`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip, "stripe-signature": "t=1,v1=deadbeef" },
        body: JSON.stringify({ id: `evt_${i}`, object: "event" }),
      });
    }
    const over = await fetch(`${h.origin}/api/billing/stripe/test`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip, "stripe-signature": "t=1,v1=deadbeef" },
      body: JSON.stringify({ id: "evt_over", object: "event" }),
    });
    assert.equal(over.status, 429);
  });

  await h.close();
}

summary("rate-limit-http");
