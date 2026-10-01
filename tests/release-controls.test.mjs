import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  customerChannel,
  defaultReleaseControlState,
  evaluateProductionPromotion,
  promotionSigningBytes,
  readReleaseControlState,
  recordBetaPublication,
  releaseShelf,
  setProductionHold,
  writeReleaseControlState,
} from "../dist/src/release-controls.js";
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

await test("Production needs the full gated evidence set and is disabled by default", () => {
  const dir = tmpDir("release-gate");
  const p = policy(dir);
  assert.equal(evaluateProductionPromotion(p).eligible, true);
  assert.ok(evaluateProductionPromotion({ ...p, autoPromotionEnabled: false }).reasons.some((reason) => /disabled/.test(reason)));
  assert.ok(evaluateProductionPromotion({ ...p, state: setProductionHold(p.state, true, "incident", now) }).reasons.some((reason) => /hold/.test(reason)));
  assert.ok(evaluateProductionPromotion({ ...p, state: stateAt(now - 6 * 86400_000) }).reasons.some((reason) => /seven consecutive days/.test(reason)));
  assert.ok(evaluateProductionPromotion({ ...p, production: { ...production, sha256: "f".repeat(64) } }).reasons.some((reason) => /exactly match/.test(reason)));
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
