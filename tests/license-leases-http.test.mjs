import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { verifyLicenseLease } from "../dist/src/license-leases.js";

function machine() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return { privateKey: pair.privateKey, publicKey: der.subarray(-32).toString("base64url") };
}

function signature(challenge, privateKey) {
  return sign(null, Buffer.from(challenge.proofBytesB64u, "base64url"), privateKey).toString("base64url");
}

let leaseNow = Date.now();
let leaseMonotonic = 0;
const h = await freshHub({
  licenseLease: {
    leaseDurationMs: 60 * 60_000,
    cachedGraceMs: 6 * 60 * 60_000,
    challengeTtlMs: 60_000,
    maxClockSkewMs: 30_000,
    defaultMaxMachines: 1,
  },
}, {
  licenseLeaseNow: () => leaseNow,
  licenseLeaseMonotonicNow: () => leaseMonotonic,
});
const ADMIN = { "x-hub-admin": h.cfg.adminToken };
const issued = h.store.issue("HTTP Lease", 30);
const headers = { "content-type": "application/json", "x-license": issued.token };
const first = machine();

let activation;
await test("lease bootstrap is header-only and requires a valid LHK1 bearer", async () => {
  const body = JSON.stringify({ purpose: "activate", installId: "http-a", installPublicKey: first.publicKey });
  const absent = await jsonReq(`${h.origin}/api/license/lease/challenge?key=${encodeURIComponent(issued.token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  assert.equal(absent.status, 401, "new lease traffic must not put LHK1 in a URL");
  const noStore = await fetch(`${h.origin}/api/license/lease/challenge`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  assert.equal(noStore.headers.get("cache-control"), "no-store");
  const invalid = await jsonReq(`${h.origin}/api/license/lease/challenge`, {
    method: "POST", headers: { "content-type": "application/json", "x-license": "LHK1.bad.bad" }, body,
  });
  assert.equal(invalid.status, 403);
  assert.equal(invalid.body.code, "auth");
});

await test("possession failures and expired challenges have stable typed statuses and no-store", async () => {
  const key = machine();
  const challenged = await jsonReq(`${h.origin}/api/license/lease/challenge`, {
    method: "POST", headers,
    body: JSON.stringify({ purpose: "activate", installId: "http-expired", installPublicKey: key.publicKey }),
  });
  const wrong = await fetch(`${h.origin}/api/license/lease/activate`, {
    method: "POST", headers,
    body: JSON.stringify({ nonce: challenged.body.challenge.nonce,
      signature: signature(challenged.body.challenge, machine().privateKey) }),
  });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.headers.get("cache-control"), "no-store");
  assert.equal((await wrong.json()).code, "proof");
  leaseNow += 60_001;
  leaseMonotonic += 60_001;
  const expired = await jsonReq(`${h.origin}/api/license/lease/activate`, {
    method: "POST", headers,
    body: JSON.stringify({ nonce: challenged.body.challenge.nonce,
      signature: signature(challenged.body.challenge, key.privateKey) }),
  });
  assert.equal(expired.status, 410);
  assert.equal(expired.body.code, "expired");
});

await test("challenge and activation return a verifiable machine-bound lease", async () => {
  const challenged = await jsonReq(`${h.origin}/api/license/lease/challenge`, {
    method: "POST", headers,
    body: JSON.stringify({ purpose: "activate", installId: "http-a", installPublicKey: first.publicKey }),
  });
  assert.equal(challenged.status, 200);
  const challengeHeaders = await fetch(`${h.origin}/api/license/lease/challenge`, {
    method: "POST", headers,
    body: JSON.stringify({ purpose: "activate", installId: "http-cache", installPublicKey: machine().publicKey }),
  });
  assert.equal(challengeHeaders.headers.get("cache-control"), "no-store");
  const challenge = challenged.body.challenge;
  const activated = await jsonReq(`${h.origin}/api/license/lease/activate`, {
    method: "POST", headers,
    body: JSON.stringify({ nonce: challenge.nonce, signature: signature(challenge, first.privateKey) }),
  });
  assert.equal(activated.status, 200);
  activation = activated.body.activation;
  assert.equal(activated.body.lease.payload.installPublicKey, first.publicKey);
  const admin = await jsonReq(`${h.origin}/admin/api/license-leases?licenseId=${issued.payload.id}`, { headers: ADMIN });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.activations.length, 1);
  assert.equal(verifyLicenseLease(activated.body.lease.token, admin.body.publicKeys).ok, true);
  assert.equal(Object.hasOwn(activated.body, "privateKey"), false);
});

await test("HTTP seat refusal needs a reasoned admin override", async () => {
  const second = machine();
  const challenged = await jsonReq(`${h.origin}/api/license/lease/challenge`, {
    method: "POST", headers,
    body: JSON.stringify({ purpose: "activate", installId: "http-b", installPublicKey: second.publicKey }),
  });
  const challenge = challenged.body.challenge;
  const refused = await jsonReq(`${h.origin}/api/license/lease/activate`, {
    method: "POST", headers,
    body: JSON.stringify({ nonce: challenge.nonce, signature: signature(challenge, second.privateKey) }),
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "conflict");
  const badOverride = await jsonReq(`${h.origin}/admin/api/license-leases/seat-override`, {
    method: "POST", headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ licenseId: issued.payload.id, maxMachines: 2, expectedAuditRevision: 0, reason: "" }),
  });
  assert.equal(badOverride.status, 400);
  const beforeOverride = await jsonReq(`${h.origin}/admin/api/license-leases`, { headers: ADMIN });
  const override = await jsonReq(`${h.origin}/admin/api/license-leases/seat-override`, {
    method: "POST", headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ licenseId: issued.payload.id, maxMachines: 2,
      expectedAuditRevision: beforeOverride.body.auditRevision, reason: "approved migration overlap" }),
  });
  assert.equal(override.status, 200);
  assert.equal(override.body.auditRevision, beforeOverride.body.auditRevision + 1);
  assert.equal(override.body.publicKeys.keys["lease-1"].privateKey, undefined);
  const admitted = await jsonReq(`${h.origin}/api/license/lease/activate`, {
    method: "POST", headers,
    body: JSON.stringify({ nonce: challenge.nonce, signature: signature(challenge, second.privateKey) }),
  });
  assert.equal(admitted.status, 200);
});

await test("revocation blocks renewal while preserving authenticated deactivation", async () => {
  const renewChallenge = await jsonReq(`${h.origin}/api/license/lease/challenge`, {
    method: "POST", headers,
    body: JSON.stringify({
      purpose: "renew", activationId: activation.id,
      installId: activation.installId, installPublicKey: first.publicKey,
    }),
  });
  assert.equal(renewChallenge.status, 200);
  const revoked = await jsonReq(`${h.origin}/admin/api/licenses/revoke`, {
    method: "POST", headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ id: issued.payload.id }),
  });
  assert.equal(revoked.status, 200);
  const renewal = await jsonReq(`${h.origin}/api/license/lease/renew`, {
    method: "POST", headers,
    body: JSON.stringify({
      nonce: renewChallenge.body.challenge.nonce,
      signature: signature(renewChallenge.body.challenge, first.privateKey),
    }),
  });
  assert.equal(renewal.status, 403);

  const deactivateChallenge = await jsonReq(`${h.origin}/api/license/lease/challenge`, {
    method: "POST", headers,
    body: JSON.stringify({
      purpose: "deactivate", activationId: activation.id,
      installId: activation.installId, installPublicKey: first.publicKey,
    }),
  });
  assert.equal(deactivateChallenge.status, 200);
  const deactivated = await jsonReq(`${h.origin}/api/license/lease/deactivate`, {
    method: "POST", headers,
    body: JSON.stringify({
      nonce: deactivateChallenge.body.challenge.nonce,
      signature: signature(deactivateChallenge.body.challenge, first.privateKey),
    }),
  });
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.body.activation.status, "deactivated");
});

await test("legacy LHK1 check-in remains unchanged after lease activation", async () => {
  const legacy = await jsonReq(`${h.origin}/api/license/checkin`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ licenseId: issued.payload.id, installId: "legacy-install", version: "0.3.2", ts: Date.now() }),
  });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.ok, true);
  assert.equal(legacy.body.revoked, true); // revoked above; exact legacy semantics
  assert.equal(Object.hasOwn(legacy.body, "lease"), false);
});

await test("admin UI exposes only the full public lease verifier and rollout status", async () => {
  const html = await (await fetch(`${h.origin}/admin`)).text();
  assert.match(html, /id="leaseSummary"/);
  assert.match(html, /\/admin\/api\/license-leases/);
  assert.match(html, /Copy PUBLIC key/);
  assert.match(html, /Safe rollout order/);
  assert.match(html, /Private key<\/dt><dd>never returned or rendered/);
  assert.equal(html.includes(issued.token), false);
});

await h.close();
summary("license-leases-http");
