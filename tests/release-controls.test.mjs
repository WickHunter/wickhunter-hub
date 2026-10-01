import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  customerChannel,
  commitReleasePublication,
  defaultReleaseControlState,
  evaluateProductionPromotion,
  promotionSigningBytes,
  readReleaseControlState,
  recoverPendingReleasePublication,
  recordBetaPublication,
  releaseShelf,
  setProductionHold,
  writeReleaseControlState,
} from "../dist/src/release-controls.js";
import { releaseSigningBytes } from "../dist/src/release-manifest.js";
import { test, summary, tmpDir } from "./helpers.mjs";

const pair = generateKeyPairSync("ed25519");
const kid = "release-control-test";
const publicKeys = { [kid]: pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url") };
const now = Date.now();
const beta = { product: "wickhunter", channel: "beta", version: "1.2.3", buildId: "same-build", file: "same.tar.gz", sha256: "a".repeat(64), sourceCommit: "b".repeat(40) };
const production = { ...beta, channel: "production" };

function stateAt(at = now - 7 * 24 * 60 * 60 * 1000) {
  const state = defaultReleaseControlState();
  return recordBetaPublication(state, { ...beta, issuedAt: new Date(at).toISOString() }, at);
}
function attestation(overrides = {}) {
  const unsigned = {
    schema: "wickhunter.production-promotion.v1",
    betaBuildId: beta.buildId,
    betaSha256: beta.sha256,
    sourceCommit: beta.sourceCommit,
    tests: { passed: true, commit: beta.sourceCommit, completedAt: new Date(now - 7 * 86400_000 + 60_000).toISOString(), runId: "ci-123" },
    health: { passed: true, checkedAt: new Date(now - 30_000).toISOString(), probeId: "health-123" },
    bugs: { unresolved: 0, checkedAt: new Date(now - 30_000).toISOString(), reportSet: "feedback-sha256" },
    rollback: {
      fromBuildId: beta.buildId, fromSha256: beta.sha256, targetBuildId: "previous-build", targetSha256: "c".repeat(64),
      stateCompatible: true, settingsVersion: 8, restartHealthProtocol: "restart-v1", nativeCoreProtocol: "core-v1",
      coreSha256: "d".repeat(64), certifiedAt: new Date(now - 30_000).toISOString(), expiresAt: new Date(now + 86400_000).toISOString(),
    },
    ...overrides,
  };
  return { ...unsigned, signatures: [{ kid, alg: "Ed25519", sig: edSign(null, promotionSigningBytes(unsigned), pair.privateKey).toString("base64url") }] };
}
function policy(dir, extra = {}) {
  const feedbackFile = path.join(dir, "feedback.jsonl");
  if (!fs.existsSync(feedbackFile)) fs.writeFileSync(feedbackFile, "");
  return { publicKeys, now, autoPromotionEnabled: true, state: stateAt(), beta, production, attestation: attestation(), feedbackFile, ...extra };
}

await test("customer channel defaults to Production and requires both explicit opt-in and eligibility", () => {
  assert.equal(customerChannel({}), "production");
  assert.equal(customerChannel({ earlyAccessOptIn: true, betaEligible: false }), "production");
  assert.equal(customerChannel({ earlyAccessOptIn: true, betaEligible: true }), "beta");
  assert.equal(releaseShelf("/tmp/releases", "production"), "/tmp/releases/production");
  assert.throws(() => releaseShelf("/tmp/releases", "alpha"), /private/);
});

await test("Beta soak starts on a new artifact and preserves time only for the same digest and build", () => {
  const first = stateAt(now - 123456);
  const same = recordBetaPublication(first, beta, now);
  assert.equal(same.beta.publishedAt, first.beta.publishedAt);
  const changed = recordBetaPublication(first, { ...beta, sha256: "e".repeat(64) }, now);
  assert.equal(Date.parse(changed.beta.publishedAt), now);
});

await test("release state writes atomically and malformed state is rejected", () => {
  const dir = tmpDir("release-state");
  const file = path.join(dir, "state.json");
  writeReleaseControlState(file, stateAt());
  assert.equal(readReleaseControlState(file).beta.buildId, beta.buildId);
  fs.writeFileSync(file, "{}");
  assert.throws(() => readReleaseControlState(file), /schema/);
});

await test("failed post-pointer verification restores both prior files and their modes", () => {
  const dir = tmpDir("release-pointer-rollback");
  const pointer = path.join(dir, "latest.json");
  const stateFile = path.join(dir, "control.json");
  const oldPointer = Buffer.from('{"build":"old"}\n');
  fs.writeFileSync(pointer, oldPointer);
  fs.chmodSync(pointer, 0o644);
  const previous = stateAt();
  writeReleaseControlState(stateFile, previous);
  const oldState = fs.readFileSync(stateFile);
  const next = { ...previous, production: { buildId: "same-build", file: "same.tar.gz",
    publishedAt: new Date(now).toISOString(), sha256: "a".repeat(64), version: "1.2.3" } };

  assert.throws(() => commitReleasePublication({ latestFile: pointer, latestBytes: Buffer.from('{"build":"new"}\n'),
    controlStateFile: stateFile, nextControlState: next }, {
      replaceLatest(file, bytes) {
        fs.writeFileSync(file, bytes);
        throw new Error("injected failure after pointer replacement");
      },
    }), /injected failure/);
  assert.deepEqual(fs.readFileSync(pointer), oldPointer);
  assert.deepEqual(fs.readFileSync(stateFile), oldState);
  assert.equal(fs.statSync(pointer).mode & 0o777, 0o644);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
});

await test("stale pending marker after state-first crash restores prior state without advancing soak", () => {
  const dir = tmpDir("release-pending-recovery");
  const pointer = path.join(dir, "latest.json");
  const stateFile = path.join(dir, "control.json");
  const pendingFile = `${stateFile}.pending.v1.json`;
  const prior = stateAt();
  const priorPointer = Buffer.from('{"release":"old"}\n');
  fs.writeFileSync(pointer, priorPointer, { mode: 0o644 });
  writeReleaseControlState(stateFile, prior);
  const priorStateBytes = fs.readFileSync(stateFile);
  const targetState = { ...prior, production: { buildId: "same-build", file: "same.tar.gz",
    publishedAt: new Date(now).toISOString(), sha256: "a".repeat(64), version: "1.2.3" } };
  const targetStateBytes = Buffer.from(JSON.stringify(targetState) + "\n");
  const targetPointer = Buffer.from('{"release":"candidate"}\n');
  const marker = {
    schema: "wickhunter.release-publication-pending.v1", latestFile: path.resolve(pointer),
    priorLatest: { base64: priorPointer.toString("base64"), mode: 0o644 },
    priorControl: { base64: priorStateBytes.toString("base64"), mode: 0o600 },
    targetLatest: { base64: targetPointer.toString("base64"), mode: 0o644 },
    targetControl: { base64: targetStateBytes.toString("base64"), mode: 0o600 },
  };
  fs.writeFileSync(pendingFile, JSON.stringify(marker), { mode: 0o600 });
  writeReleaseControlState(stateFile, targetState);

  assert.equal(recoverPendingReleasePublication(stateFile, pointer, publicKeys), "rolled-back");
  assert.deepEqual(fs.readFileSync(pointer), priorPointer);
  assert.deepEqual(fs.readFileSync(stateFile), priorStateBytes);
  assert.equal(fs.existsSync(pendingFile), false);
  assert.equal(readReleaseControlState(stateFile).production, null);
});

await test("pending marker with a signed target pointer and matching state recovers as committed", () => {
  const dir = tmpDir("release-pending-complete");
  const pointer = path.join(dir, "latest.json");
  const stateFile = path.join(dir, "control.json");
  const pendingFile = `${stateFile}.pending.v1.json`;
  const artifact = Buffer.from("signed production recovery archive");
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const unsigned = { schema: "wickhunter.release.v1", product: "wickhunter", channel: "production",
    platform: "linux", arch: "x64", version: "1.2.3", buildId: "same-build",
    file: "wickhunter-production-1.2.3.tar.gz", sha256, issuedAt: new Date(now).toISOString(), minUpdateProtocol: 1 };
  const targetManifest = { ...unsigned, signatures: [{ kid, alg: "Ed25519",
    sig: edSign(null, releaseSigningBytes(unsigned), pair.privateKey).toString("base64url") }] };
  const targetPointer = Buffer.from(JSON.stringify(targetManifest));
  fs.writeFileSync(pointer, targetPointer, { mode: 0o644 });
  fs.writeFileSync(path.join(dir, targetManifest.file), artifact);

  const prior = stateAt();
  const targetState = { ...prior, production: { buildId: targetManifest.buildId, file: targetManifest.file,
    publishedAt: new Date(now).toISOString(), sha256, version: targetManifest.version } };
  writeReleaseControlState(stateFile, targetState);
  const targetStateBytes = fs.readFileSync(stateFile);
  const priorPointer = Buffer.from('{"release":"before"}\n');
  const priorStateBytes = Buffer.from(JSON.stringify(prior) + "\n");
  fs.writeFileSync(pendingFile, JSON.stringify({
    schema: "wickhunter.release-publication-pending.v1", latestFile: path.resolve(pointer),
    priorLatest: { base64: priorPointer.toString("base64"), mode: 0o644 },
    priorControl: { base64: priorStateBytes.toString("base64"), mode: 0o600 },
    targetLatest: { base64: targetPointer.toString("base64"), mode: 0o644 },
    targetControl: { base64: targetStateBytes.toString("base64"), mode: 0o600 },
  }), { mode: 0o600 });

  assert.equal(recoverPendingReleasePublication(stateFile, pointer, publicKeys), "completed");
  assert.deepEqual(fs.readFileSync(pointer), targetPointer);
  assert.equal(readReleaseControlState(stateFile).production.sha256, sha256);
  assert.equal(fs.existsSync(pendingFile), false);
});

await test("Production needs the full gated evidence set and is disabled by default", () => {
  const dir = tmpDir("release-gate");
  const p = policy(dir);
  assert.equal(evaluateProductionPromotion(p).eligible, true);
  assert.ok(evaluateProductionPromotion({ ...p, autoPromotionEnabled: false }).reasons.some((reason) => /disabled/.test(reason)));
  assert.ok(evaluateProductionPromotion({ ...p, state: setProductionHold(p.state, true, "incident", now) }).reasons.some((reason) => /hold/.test(reason)));
  assert.ok(evaluateProductionPromotion({ ...p, state: stateAt(now - 6 * 86400_000) }).reasons.some((reason) => /seven consecutive days/.test(reason)));
  assert.ok(evaluateProductionPromotion({ ...p, production: { ...production, sha256: "f".repeat(64) } }).reasons.some((reason) => /exactly match/.test(reason)));
  assert.ok(evaluateProductionPromotion({ ...p, production: { ...production, version: "1.2.4" } }).reasons.some((reason) => /version and minimum update protocol must match/.test(reason)));
  assert.ok(evaluateProductionPromotion({ ...p, production: { ...production, minUpdateProtocol: 2 } }).reasons.some((reason) => /version and minimum update protocol must match/.test(reason)));
  assert.ok(evaluateProductionPromotion({ ...p, attestation: { ...p.attestation, signatures: [] } }).reasons.some((reason) => /valid release-key-signed/.test(reason)));
});

await test("unresolved build bugs, stale health, and incompatible rollback each block promotion", () => {
  const dir = tmpDir("release-gate-evidence");
  const p = policy(dir);
  fs.writeFileSync(p.feedbackFile, JSON.stringify({ kind: "bug", version: beta.version, status: "new" }) + "\n");
  assert.ok(evaluateProductionPromotion(p).reasons.some((reason) => /unresolved Hub bug/.test(reason)));
  fs.writeFileSync(p.feedbackFile, "");
  const stale = attestation({ health: { passed: true, checkedAt: new Date(now - 60 * 60_000).toISOString(), probeId: "old" } });
  assert.ok(evaluateProductionPromotion({ ...p, attestation: stale }).reasons.some((reason) => /health evidence/.test(reason)));
  const rollback = attestation({ rollback: { ...p.attestation.rollback, stateCompatible: false } });
  assert.ok(evaluateProductionPromotion({ ...p, attestation: rollback }).reasons.some((reason) => /rollback certification/.test(reason)));
});

await test("malformed feedback ledger fails closed", () => {
  const dir = tmpDir("release-gate-feedback");
  const p = policy(dir);
  fs.writeFileSync(p.feedbackFile, "{bad json}\n");
  assert.ok(evaluateProductionPromotion(p).reasons.some((reason) => /unreadable/.test(reason)));
});

summary("release-controls");
