import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { freshStore, test, summary } from "./helpers.mjs";
import {
  LEASE_LEDGER_FILE,
  LEASE_LEDGER_HEAD_FILE,
  LEASE_KEYRING_FILE,
  LicenseLeaseKeyStore,
  LicenseLeaseService,
  challengeProofBytes,
  evaluateLicenseLease,
  verifyLicenseLease,
} from "../dist/src/license-leases.js";

await test("challenge proof v1 has a pinned cross-repository byte vector", () => {
  const bytes = challengeProofBytes({
    purpose: "rebind", licenseId: "lic-vector", activationId: "act-vector",
    activationRevision: 7, installId: "install-old", installPublicKey: "pub-old",
    newInstallId: "install-new", newInstallPublicKey: "pub-new",
    issuedAtMs: 1_700_000_000_000, expiresAtMs: 1_700_000_300_000,
  }, "nonce-vector");
  assert.equal(bytes.toString("utf8"), '{"v":1,"domain":"wickhunter.license.challenge.v1","purpose":"rebind","nonce":"nonce-vector","licenseId":"lic-vector","activationId":"act-vector","activationRevision":7,"installId":"install-old","installPublicKey":"pub-old","newInstallId":"install-new","newInstallPublicKey":"pub-new","issuedAtMs":1700000000000,"expiresAtMs":1700000300000}');
});

function installKey() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return {
    privateKey: pair.privateKey,
    publicKey: der.subarray(der.length - 32).toString("base64url"),
  };
}

function proof(challenge, privateKey) {
  return sign(null, Buffer.from(challenge.proofBytesB64u, "base64url"), privateKey).toString("base64url");
}

function serviceFixture(overrides = {}) {
  const { store, dataDir } = freshStore();
  const issued = store.issue("Lease Tester", 30, 1_700_000_000_000);
  let now = 1_700_000_001_000;
  let monotonic = 0;
  let ids = 0;
  const service = new LicenseLeaseService(dataDir, store, {
    leaseDurationMs: 60 * 60_000,
    cachedGraceMs: 6 * 60 * 60_000,
    challengeTtlMs: 60_000,
    maxClockSkewMs: 30_000,
    defaultMaxMachines: 1,
    ...overrides.config,
  }, {
    now: () => now,
    monotonicNow: () => monotonic,
    randomId: () => `id-${++ids}`,
    featuresFor: () => ["marketplace_alpha"],
    ...overrides.deps,
  });
  return {
    store, dataDir, issued, service,
    get now() { return now; },
    set now(v) { monotonic += Math.max(0, v - now); now = v; },
    set wallOnly(v) { now = v; },
  };
}

function activate(f, key, installId = "install-a") {
  const challenge = f.service.challenge(f.issued.token, {
    purpose: "activate", installId, installPublicKey: key.publicKey,
  });
  return {
    challenge,
    result: f.service.activate(f.issued.token, challenge.nonce, proof(challenge, key.privateKey)),
  };
}

await test("upgrade creates separate signed lease state without mutating legacy LHK1 files", () => {
  const { store, dataDir } = freshStore();
  const issued = store.issue("Legacy", 30, 1_700_000_000_000);
  const beforeLicenses = fs.readFileSync(path.join(dataDir, "licenses.json"), "utf8");
  const beforeToken = store.tokenFor(issued.payload.id);
  const leases = new LicenseLeaseService(dataDir, store, {}, { now: () => 1_700_000_001_000 });
  assert.ok(leases.adminSnapshot().publicKeys.keys["lease-1"]);
  assert.equal(fs.readFileSync(path.join(dataDir, "licenses.json"), "utf8"), beforeLicenses);
  assert.equal(store.tokenFor(issued.payload.id), beforeToken);
  assert.equal(store.verify(issued.token, 1_700_000_001_000).ok, true);
});

await test("activation binds the install key and returns a strict signed short lease", () => {
  const f = serviceFixture();
  const key = installKey();
  const { result } = activate(f, key);
  assert.equal(result.replayed, false);
  assert.equal(result.activation.installPublicKey, key.publicKey);
  assert.equal(result.activation.lastSequence, 1);
  assert.equal(result.lease.payload.kid, "lease-1");
  assert.equal(result.lease.payload.installPublicKey, key.publicKey);
  assert.equal(result.lease.payload.expiresAtMs, f.now + 60 * 60_000);
  assert.equal(result.lease.payload.policy.cachedGraceUntilMs, f.now + 7 * 60 * 60_000);
  assert.equal(result.lease.payload.policy.exitsAlwaysAllowed, true);
  assert.equal(result.lease.payload.policy.revocationBehavior, "exit_only");
  assert.deepEqual(result.lease.payload.features, ["beta", "marketplace_alpha"]);
  const verified = verifyLicenseLease(result.lease.token, f.service.keyStore.publicKeyring());
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.payload, result.lease.payload);
  assert.notEqual(
    f.service.keyStore.publicKeyring().keys["lease-1"].publicKey,
    f.store.publicKeyRawB64u(),
    "lease authority reused the LHK1 signing key",
  );
  const [prefix, payloadPart, sigPart] = result.lease.token.split(".");
  assert.equal(prefix, "WHL1");
  const leasePubRaw = Buffer.from(f.service.keyStore.publicKeyring().keys["lease-1"].publicKey, "base64url");
  const leasePub = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), leasePubRaw]),
    format: "der", type: "spki",
  });
  assert.equal(verify(null, Buffer.from(payloadPart, "base64url"), leasePub, Buffer.from(sigPart, "base64url")), false,
    "lease signature lacked explicit protocol-domain separation");
  assert.deepEqual(verifyLicenseLease(result.lease.token, { v: 1, keys: {} }), { ok: false, reason: "unknown_key" });
  const edited = Buffer.from(JSON.stringify({ ...result.lease.payload, sequence: 99 })).toString("base64url");
  assert.equal(verifyLicenseLease(`WHL1.${edited}.${sigPart}`, f.service.keyStore.publicKeyring()).reason, "signature");
});

await test("nonce replay is exact and never increments the monotonic sequence", () => {
  const f = serviceFixture();
  const key = installKey();
  const challenge = f.service.challenge(f.issued.token, {
    purpose: "activate", installId: "install-a", installPublicKey: key.publicKey,
  });
  const signature = proof(challenge, key.privateKey);
  const first = f.service.activate(f.issued.token, challenge.nonce, signature);
  const replay = f.service.activate(f.issued.token, challenge.nonce, signature);
  assert.equal(replay.replayed, true);
  assert.equal(replay.activation.lastSequence, 1);
  assert.equal(replay.lease.token, first.lease.token);
  assert.throws(() => f.service.activate(f.issued.token, challenge.nonce, proof(challenge, installKey().privateKey)),
    /proof signature/);
});

await test("challenge storage is bounded by outstanding and hourly per-license caps", () => {
  const f = serviceFixture();
  const key = installKey();
  for (let batch = 0; batch < 15; batch++) {
    for (let i = 0; i < 8; i++) {
      f.service.challenge(f.issued.token, {
        purpose: "activate", installId: `rate-${batch}-${i}`, installPublicKey: key.publicKey,
      });
    }
    assert.throws(() => f.service.challenge(f.issued.token, {
      purpose: "activate", installId: `outstanding-${batch}`, installPublicKey: key.publicKey,
    }), /too many unconsumed challenges/);
    f.now += 60_001;
  }
  assert.throws(() => f.service.challenge(f.issued.token, {
    purpose: "activate", installId: "hourly-overflow", installPublicKey: key.publicKey,
  }), /rate limit reached/);
});

await test("expired challenges and wrong machine proofs are refused", () => {
  const f = serviceFixture();
  const key = installKey();
  const challenge = f.service.challenge(f.issued.token, {
    purpose: "activate", installId: "install-a", installPublicKey: key.publicKey,
  });
  assert.throws(() => f.service.activate(f.issued.token, challenge.nonce, proof(challenge, installKey().privateKey)),
    /proof signature/);
  f.now += 60_000;
  assert.throws(() => f.service.activate(f.issued.token, challenge.nonce, proof(challenge, key.privateKey)),
    /expired/);
});

await test("machine limit is enforced and an auditable admin override is required", () => {
  const f = serviceFixture();
  activate(f, installKey(), "install-a");
  const second = installKey();
  const challenge = f.service.challenge(f.issued.token, {
    purpose: "activate", installId: "install-b", installPublicKey: second.publicKey,
  });
  assert.throws(() => f.service.activate(f.issued.token, challenge.nonce, proof(challenge, second.privateKey)),
    /machine limit reached/);
  f.service.setSeatOverride(f.issued.payload.id, 2, "approved second VPS for migration", f.service.adminSnapshot().auditRevision);
  const admitted = f.service.activate(f.issued.token, challenge.nonce, proof(challenge, second.privateKey));
  assert.equal(admitted.activation.installId, "install-b");
  const snap = f.service.adminSnapshot(f.issued.payload.id);
  assert.equal(snap.seatOverrides[f.issued.payload.id], 2);
  assert.ok(snap.audit.some((e) => e.kind === "seat_override_set" && e.reason.includes("migration")));
});

await test("renewal survives restart, advances sequence, and resists a backwards clock", () => {
  const f = serviceFixture();
  const key = installKey();
  const activated = activate(f, key).result;
  f.now += 30_000;
  const restarted = new LicenseLeaseService(f.dataDir, f.store, {
    leaseDurationMs: 60 * 60_000, cachedGraceMs: 6 * 60 * 60_000,
    challengeTtlMs: 60_000, maxClockSkewMs: 30_000,
  }, { now: () => f.now, randomId: () => `restart-${f.now}` });
  const challenge = restarted.challenge(f.issued.token, {
    purpose: "renew", activationId: activated.activation.id,
    installId: "install-a", installPublicKey: key.publicKey,
  });
  f.now -= 20_000;
  const renewed = restarted.renew(f.issued.token, challenge.nonce, proof(challenge, key.privateKey));
  assert.equal(renewed.activation.lastSequence, 2);
  assert.ok(renewed.lease.payload.serverTimeMs >= activated.lease.payload.serverTimeMs);
});

await test("rebind requires both old and replacement private keys and invalidates the old binding", () => {
  const f = serviceFixture();
  const oldKey = installKey();
  const nextKey = installKey();
  const active = activate(f, oldKey).result.activation;
  const challenge = f.service.challenge(f.issued.token, {
    purpose: "rebind", activationId: active.id, installId: active.installId,
    installPublicKey: oldKey.publicKey, newInstallId: "install-new",
    newInstallPublicKey: nextKey.publicKey,
  });
  assert.throws(() => f.service.rebind(
    f.issued.token, challenge.nonce, proof(challenge, oldKey.privateKey), proof(challenge, installKey().privateKey),
  ), /replacement install/);
  const rebound = f.service.rebind(
    f.issued.token, challenge.nonce, proof(challenge, oldKey.privateKey), proof(challenge, nextKey.privateKey),
  );
  assert.equal(rebound.activation.installPublicKey, nextKey.publicKey);
  assert.equal(rebound.activation.lastSequence, 2);
  assert.throws(() => f.service.challenge(f.issued.token, {
    purpose: "renew", activationId: active.id, installId: active.installId, installPublicKey: oldKey.publicKey,
  }), /does not match/);
});

await test("every pre-rebind challenge is invalid after the binding revision changes", () => {
  const f = serviceFixture();
  const oldKey = installKey(), nextKey = installKey(), thirdKey = installKey();
  const active = activate(f, oldKey).result.activation;
  const staleRenew = f.service.challenge(f.issued.token, {
    purpose: "renew", activationId: active.id, installId: active.installId, installPublicKey: oldKey.publicKey,
  });
  const staleDeactivate = f.service.challenge(f.issued.token, {
    purpose: "deactivate", activationId: active.id, installId: active.installId, installPublicKey: oldKey.publicKey,
  });
  const staleRebind = f.service.challenge(f.issued.token, {
    purpose: "rebind", activationId: active.id, installId: active.installId, installPublicKey: oldKey.publicKey,
    newInstallId: "install-third", newInstallPublicKey: thirdKey.publicKey,
  });
  const currentRebind = f.service.challenge(f.issued.token, {
    purpose: "rebind", activationId: active.id, installId: active.installId, installPublicKey: oldKey.publicKey,
    newInstallId: "install-next", newInstallPublicKey: nextKey.publicKey,
  });
  f.service.rebind(f.issued.token, currentRebind.nonce,
    proof(currentRebind, oldKey.privateKey), proof(currentRebind, nextKey.privateKey));
  assert.throws(() => f.service.renew(f.issued.token, staleRenew.nonce, proof(staleRenew, oldKey.privateKey)), /stale machine binding revision/);
  assert.throws(() => f.service.deactivate(f.issued.token, staleDeactivate.nonce, proof(staleDeactivate, oldKey.privateKey)), /stale machine binding revision/);
  assert.throws(() => f.service.rebind(f.issued.token, staleRebind.nonce,
    proof(staleRebind, oldKey.privateKey), proof(staleRebind, thirdKey.privateKey)), /stale machine binding revision/);
});

await test("revocation blocks renewals but a bound revoked install may deactivate; exits remain allowed", () => {
  const f = serviceFixture();
  const key = installKey();
  const active = activate(f, key).result;
  assert.equal(active.lease.payload.policy.exitsAlwaysAllowed, true);
  f.store.revoke(f.issued.payload.id, new Date(f.now));
  assert.throws(() => f.service.challenge(f.issued.token, {
    purpose: "renew", activationId: active.activation.id, installId: "install-a", installPublicKey: key.publicKey,
  }), /revoked/);
  const challenge = f.service.challenge(f.issued.token, {
    purpose: "deactivate", activationId: active.activation.id,
    installId: "install-a", installPublicKey: key.publicKey,
  });
  const stopped = f.service.deactivate(f.issued.token, challenge.nonce, proof(challenge, key.privateKey));
  assert.equal(stopped.activation.status, "deactivated");
});

await test("key rotation overlaps old leases and signs new leases with the new kid", () => {
  const f = serviceFixture();
  const key = installKey();
  const oldLease = activate(f, key).result.lease;
  assert.throws(() => new LicenseLeaseService(f.dataDir, f.store, { activeKeyId: "lease-2" }, { now: () => f.now + 1_000 }),
    /not pre-provisioned/);
  new LicenseLeaseKeyStore(f.dataDir, "lease-2", () => f.now + 1_000).provisionActiveKey();
  const rotated = new LicenseLeaseService(f.dataDir, f.store, {
    activeKeyId: "lease-2", leaseDurationMs: 60 * 60_000,
    cachedGraceMs: 6 * 60 * 60_000, challengeTtlMs: 60_000, maxClockSkewMs: 30_000,
  }, { now: () => f.now + 1_000, randomId: () => `rotated-${Date.now()}` });
  const ring = rotated.keyStore.publicKeyring();
  assert.deepEqual(Object.keys(ring.keys).sort(), ["lease-1", "lease-2"]);
  assert.equal(verifyLicenseLease(oldLease.token, ring).ok, true);
  const challenge = rotated.challenge(f.issued.token, {
    purpose: "renew", activationId: oldLease.payload.activationId,
    installId: "install-a", installPublicKey: key.publicKey,
  });
  const renewed = rotated.renew(f.issued.token, challenge.nonce, proof(challenge, key.privateKey));
  assert.equal(renewed.lease.payload.kid, "lease-2");
  assert.equal(verifyLicenseLease(renewed.lease.token, ring).ok, true);
});

await test("historical public verification keys cannot be removed after rotation", () => {
  const f = serviceFixture();
  activate(f, installKey());
  new LicenseLeaseKeyStore(f.dataDir, "lease-2", () => f.now + 1_000).provisionActiveKey();
  const file = path.join(f.dataDir, LEASE_KEYRING_FILE);
  const ring = JSON.parse(fs.readFileSync(file, "utf8"));
  delete ring.keys["lease-1"];
  fs.writeFileSync(file, JSON.stringify(ring));
  assert.throws(() => new LicenseLeaseService(f.dataDir, f.store, { activeKeyId: "lease-2" }, { now: () => f.now + 2_000 }),
    /unknown key lease-1|unknown retained key lease-1/);
});

await test("concurrent keyring provisioning refuses instead of losing a retained verifier kid", () => {
  const f = serviceFixture();
  const before = f.service.keyStore.publicKeyring();
  const lock = path.join(f.dataDir, "license-lease-keyring.v1.lock");
  fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  assert.throws(() => new LicenseLeaseKeyStore(f.dataDir, "lease-2", () => f.now).provisionActiveKey(), /writer is busy/);
  assert.deepEqual(f.service.keyStore.publicKeyring(), before);
  assert.equal(fs.existsSync(path.join(f.dataDir, "license-lease-signing.lease-2.key")), false);
  fs.unlinkSync(lock);
});

await test("key loss refuses replacement and leaves legacy LHK1 usable", () => {
  const f = serviceFixture();
  const keyFile = path.join(f.dataDir, "license-lease-signing.lease-1.key");
  const published = f.service.keyStore.publicKeyring().keys["lease-1"].publicKey;
  fs.unlinkSync(keyFile);
  assert.throws(() => new LicenseLeaseService(f.dataDir, f.store, {}, { now: () => f.now }),
    /restore it from backup|refusing to replace/);
  assert.equal(fs.existsSync(keyFile), false, "a replacement authority was generated after key loss");
  assert.equal(JSON.parse(fs.readFileSync(f.service.keyStore.keyringFile, "utf8")).keys["lease-1"].publicKey, published);
  assert.equal(f.store.verify(f.issued.token, f.now).ok, true, "additive lease key loss broke LHK1");
});

await test("signed server time and grace are bounded by the current registry expiry", () => {
  const f = serviceFixture();
  f.store.setExpiry(f.issued.payload.id, f.now + 20 * 60_000);
  const lease = activate(f, installKey()).result.lease.payload;
  assert.equal(lease.entitlementExpiresAtMs, f.now + 20 * 60_000);
  assert.equal(lease.expiresAtMs, f.now + 20 * 60_000);
  assert.equal(lease.policy.cachedGraceUntilMs, f.now + 20 * 60_000);
  assert.equal(lease.notBeforeMs, f.now - 30_000);
});

await test("a checkpoint-safe torn tail is repaired, a complete no-newline line is retained, and signed edits fail closed", () => {
  const f = serviceFixture();
  activate(f, installKey());
  const file = path.join(f.dataDir, LEASE_LEDGER_FILE);
  fs.appendFileSync(file, '{"v":1,"torn"');
  const recovered = new LicenseLeaseService(f.dataDir, f.store, {}, { now: () => f.now + 1_000 });
  assert.equal(recovered.adminSnapshot().activations.length, 1);
  recovered.setSeatOverride(f.issued.payload.id, 2, "prove append repairs torn tail", recovered.adminSnapshot().auditRevision);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
  const withoutNewline = fs.readFileSync(file, "utf8").trimEnd();
  fs.writeFileSync(file, withoutNewline);
  const noNewline = new LicenseLeaseService(f.dataDir, f.store, {}, { now: () => f.now + 1_500 });
  assert.equal(noNewline.adminSnapshot().seatOverrides[f.issued.payload.id], 2,
    "a complete signed final line was discarded merely because its newline was absent");
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  const edited = JSON.parse(lines[1]);
  edited.event.atMs += 1;
  lines[1] = JSON.stringify(edited);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  assert.throws(() => new LicenseLeaseService(f.dataDir, f.store, {}, { now: () => f.now + 2_000 }),
    /signature is invalid|hash chain/);
});

await test("missing, zeroed, or suffix-rolled-back ledger state refuses against the signed checkpoint", () => {
  for (const mode of ["missing", "zero", "suffix", "missing-head"]) {
    const f = serviceFixture();
    activate(f, installKey());
    const ledger = path.join(f.dataDir, LEASE_LEDGER_FILE);
    const head = path.join(f.dataDir, LEASE_LEDGER_HEAD_FILE);
    if (mode === "missing") fs.unlinkSync(ledger);
    if (mode === "zero") fs.writeFileSync(ledger, "");
    if (mode === "suffix") {
      const lines = fs.readFileSync(ledger, "utf8").trimEnd().split("\n");
      fs.writeFileSync(ledger, lines.slice(0, -1).join("\n") + "\n");
    }
    if (mode === "missing-head") fs.unlinkSync(head);
    assert.throws(() => new LicenseLeaseService(f.dataDir, f.store, {}, { now: () => f.now + 2_000 }),
      /incomplete|empty|does not match|checkpoint is missing/, mode);
  }
});

await test("admin lost-key deactivation is revision-bound and permanently blocks bearer-race re-enrolment", () => {
  const f = serviceFixture();
  const first = activate(f, installKey()).result.activation;
  assert.throws(() => f.service.adminDeactivate(f.issued.payload.id, first.id, first.revision + 1, "stale view"), /revision changed/);
  const stopped = f.service.adminDeactivate(f.issued.payload.id, first.id, first.revision, "machine key was lost");
  assert.equal(stopped.status, "deactivated");
  const attacker = installKey();
  const challenge = f.service.challenge(f.issued.token, {
    purpose: "activate", installId: "attacker", installPublicKey: attacker.publicKey,
  });
  assert.throws(() => f.service.activate(f.issued.token, challenge.nonce, proof(challenge, attacker.privateKey)), /recovery-locked/);
  assert.deepEqual(f.service.adminSnapshot(f.issued.payload.id).recoveryLockedLicenses, [f.issued.payload.id]);
});

await test("semantic verifier enforces machine, monotonic sequence, active, grace, and exit-only states", () => {
  const f = serviceFixture();
  const key = installKey();
  const lease = activate(f, key).result.lease;
  const ring = f.service.keyStore.publicKeyring();
  assert.equal(evaluateLicenseLease(lease.token, ring, { nowMs: lease.payload.notBeforeMs, installPublicKey: key.publicKey, minimumSequence: 1 }).state, "active");
  assert.deepEqual(evaluateLicenseLease(lease.token, ring, { nowMs: lease.payload.notBeforeMs - 1, installPublicKey: key.publicKey, minimumSequence: 1 }), { state: "exit_only", payload: lease.payload, reason: "clock" });
  assert.equal(evaluateLicenseLease(lease.token, ring, { nowMs: lease.payload.issuedAtMs, installPublicKey: key.publicKey, minimumSequence: 1 }).state, "active");
  assert.equal(evaluateLicenseLease(lease.token, ring, { nowMs: lease.payload.expiresAtMs, installPublicKey: key.publicKey, minimumSequence: 1 }).state, "cached_grace");
  assert.equal(evaluateLicenseLease(lease.token, ring, { nowMs: lease.payload.policy.cachedGraceUntilMs + 1, installPublicKey: key.publicKey, minimumSequence: 1 }).state, "exit_only");
  assert.deepEqual(evaluateLicenseLease(lease.token, ring, { nowMs: lease.payload.issuedAtMs, installPublicKey: installKey().publicKey, minimumSequence: 1 }), { state: "refused", reason: "machine" });
  assert.deepEqual(evaluateLicenseLease(lease.token, ring, { nowMs: lease.payload.issuedAtMs, installPublicKey: key.publicKey, minimumSequence: 2 }), { state: "refused", reason: "sequence" });
});

await test("a temporary far-future clock cannot poison later lease issuance", () => {
  const f = serviceFixture();
  const key = installKey();
  const active = activate(f, key).result.activation;
  const normal = f.now;
  f.wallOnly = f.now + 10 * 86_400_000;
  assert.throws(() => f.service.challenge(f.issued.token, {
    purpose: "renew", activationId: active.id, installId: active.installId, installPublicKey: key.publicKey,
  }), /clock jumped forward/);
  f.wallOnly = normal + 5_000;
  const challenge = f.service.challenge(f.issued.token, {
    purpose: "renew", activationId: active.id, installId: active.installId, installPublicKey: key.publicKey,
  });
  assert.equal(f.service.renew(f.issued.token, challenge.nonce, proof(challenge, key.privateKey)).activation.lastSequence, 2);
});

summary("license-leases");
