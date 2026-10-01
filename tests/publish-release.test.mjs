import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { releaseSigningBytes } from "../dist/src/release-manifest.js";
import {
  defaultReleaseControlState,
  promotionSigningBytes,
  recordBetaPublication,
  writeReleaseControlState,
} from "../dist/src/release-controls.js";
import { test, summary, tmpDir } from "./helpers.mjs";

const pair = generateKeyPairSync("ed25519");
const kid = "publish-test-1";
const publicKeys = { [kid]: pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url") };

function fixture(dir, overrides = {}) {
  const artifact = Buffer.from("authenticated customer package");
  const unsigned = {
    schema: "wickhunter.release.v1",
    product: "wickhunter",
    channel: "beta",
    platform: "linux",
    arch: "x64",
    version: "0.89.92",
    buildId: "release-0.89.92-test",
    file: "wickhunter-beta-0.89.92.tar.gz",
    sha256: createHash("sha256").update(artifact).digest("hex"),
    issuedAt: new Date().toISOString(),
    minUpdateProtocol: 1,
    ...overrides,
  };
  const manifest = {
    ...unsigned,
    signatures: [{ kid, alg: "Ed25519", sig: edSign(null, releaseSigningBytes(unsigned), pair.privateKey).toString("base64url") }],
  };
  const manifestPath = path.join(dir, "signed.json");
  const artifactPath = path.join(dir, manifest.file);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.writeFileSync(artifactPath, artifact);
  return { artifact, manifest, manifestPath, artifactPath };
}

function productionEvidence({ betaManifest, rollbackManifest, now, betaPublishedAt }) {
  const unsigned = {
    schema: "wickhunter.production-promotion.v1",
    betaBuildId: betaManifest.buildId,
    betaSha256: betaManifest.sha256,
    sourceCommit: betaManifest.sourceCommit,
    tests: { passed: true, commit: betaManifest.sourceCommit,
      completedAt: new Date(betaPublishedAt + 60_000).toISOString(), runId: "test-run-150" },
    health: { passed: true, checkedAt: new Date(now - 30_000).toISOString(), probeId: "health-check-1" },
    bugs: { unresolved: 0, checkedAt: new Date(now - 30_000).toISOString(), reportSet: "feedback-set-1" },
    rollback: {
      fromBuildId: betaManifest.buildId, fromSha256: betaManifest.sha256,
      targetBuildId: rollbackManifest.buildId, targetSha256: rollbackManifest.sha256,
      stateCompatible: true, settingsVersion: 8, restartHealthProtocol: "restart-health-v1",
      nativeCoreProtocol: "native-core-v1", coreSha256: "d".repeat(64),
      certifiedAt: new Date(now - 30_000).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(),
    },
  };
  return { ...unsigned, signatures: [{ kid, alg: "Ed25519",
    sig: edSign(null, promotionSigningBytes(unsigned), pair.privateKey).toString("base64url") }] };
}

function signedRelease(dir, channel, artifact, overrides = {}) {
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const unsigned = {
    schema: "wickhunter.release.v1", product: "wickhunter", channel, platform: "linux", arch: "x64",
    version: "0.89.91", buildId: `release-${channel}-0.89.91`,
    file: `wickhunter-${channel}-0.89.91.tar.gz`, sha256,
    issuedAt: new Date().toISOString(), minUpdateProtocol: 1, sourceCommit: "c".repeat(40), ...overrides,
  };
  const manifest = { ...unsigned, signatures: [{ kid, alg: "Ed25519",
    sig: edSign(null, releaseSigningBytes(unsigned), pair.privateKey).toString("base64url") }] };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `manifest-${sha256}.json`), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, manifest.file), artifact);
  return manifest;
}

function publish(releasesDir, item, env = {}, extraArgs = []) {
  return spawnSync(process.execPath, [
    fileURLToPath(new URL("../dist/bin/publish-release.js", import.meta.url)),
    "--manifest", item.manifestPath,
    "--artifact", item.artifactPath,
    "--releases-dir", releasesDir,
    ...extraArgs,
  ], {
    encoding: "utf8",
    env: { ...process.env, HUB_RELEASE_PUBLIC_KEYS_JSON: JSON.stringify(publicKeys), ...env },
  });
}

await test("publisher verifies and atomically shelves artifact, immutable manifest, then latest", () => {
  const input = tmpDir("publish-input");
  const releases = tmpDir("publish-shelf");
  const item = fixture(input);
  const result = publish(releases, item);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(releases, item.manifest.file)), item.artifact);
  const archive = fs.readFileSync(path.join(releases, `manifest-${item.manifest.sha256}.json`));
  assert.deepEqual(archive, fs.readFileSync(item.manifestPath), "archive retains the exact signed bytes");
  assert.deepEqual(fs.readFileSync(path.join(releases, "latest.json")), archive, "latest moves to the archived signed bytes");
  assert.equal(fs.readdirSync(releases).some((name) => name.endsWith(".tmp")), false);
});

await test("publisher refuses private Alpha and keeps Production promotion disabled unless explicitly enabled", () => {
  const input = tmpDir("publish-channel-input");
  const alphaShelf = tmpDir("publish-alpha-shelf");
  const item = fixture(input);
  const alpha = publish(alphaShelf, item, {}, ["--channel", "alpha"]);
  assert.notEqual(alpha.status, 0);
  assert.match(alpha.stderr, /Alpha is private/);
  assert.deepEqual(fs.readdirSync(alphaShelf), []);

  const productionShelf = tmpDir("publish-production-shelf");
  const prodItem = fixture(tmpDir("publish-production-input"), { channel: "production" });
  const production = publish(productionShelf, prodItem, { HUB_RELEASE_AUTO_PROMOTION_ENABLED: "false" }, ["--channel", "production"]);
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /automatic Production promotion is disabled/);
  assert.deepEqual(fs.readdirSync(productionShelf), []);

  const enabledButUnprovenShelf = tmpDir("publish-production-unproven-shelf");
  const enabledButUnproven = publish(enabledButUnprovenShelf, prodItem, { HUB_RELEASE_AUTO_PROMOTION_ENABLED: "true" }, ["--channel", "production"]);
  assert.notEqual(enabledButUnproven.status, 0);
  assert.match(enabledButUnproven.stderr, /Production requires/);
  assert.deepEqual(fs.readdirSync(enabledButUnprovenShelf), []);
});

await test("Production cannot target the Beta shelf, including a symlink alias", () => {
  const shelf = tmpDir("publish-channel-collision");
  const prod = fixture(tmpDir("publish-channel-collision-input"), { channel: "production" });
  const alias = path.join(tmpDir("publish-channel-alias"), "same-shelf");
  fs.symlinkSync(shelf, alias, "dir");
  for (const target of [shelf, alias]) {
    const result = publish(target, prod, { HUB_RELEASE_AUTO_PROMOTION_ENABLED: "true" }, [
      "--channel", "production", "--beta-releases-dir", shelf,
      "--control-state", path.join(shelf, "control.json"),
      "--promotion-attestation", path.join(shelf, "evidence.json"),
      "--feedback-file", path.join(shelf, "feedback.jsonl"), "--rollback-releases-dir", shelf,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /separate release shelves/);
    assert.deepEqual(fs.readdirSync(shelf), []);
  }
});

await test("publisher fails closed before changing the shelf on artifact or signature tamper", () => {
  for (const tamper of ["artifact", "signature"]) {
    const input = tmpDir(`publish-${tamper}-input`);
    const releases = tmpDir(`publish-${tamper}-shelf`);
    const item = fixture(input);
    if (tamper === "artifact") fs.appendFileSync(item.artifactPath, "tampered");
    else {
      const raw = JSON.parse(fs.readFileSync(item.manifestPath, "utf8"));
      raw.version = "9.9.9";
      fs.writeFileSync(item.manifestPath, JSON.stringify(raw));
    }
    const result = publish(releases, item);
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readdirSync(releases), [], `${tamper} left no partial publication`);
  }
});

await test("publisher never replaces a conflicting SHA-addressed manifest", () => {
  const input = tmpDir("publish-conflict-input");
  const releases = tmpDir("publish-conflict-shelf");
  const first = fixture(input);
  assert.equal(publish(releases, first).status, 0);
  const oldLatest = fs.readFileSync(path.join(releases, "latest.json"));

  const secondDir = tmpDir("publish-conflict-second");
  const second = fixture(secondDir, { buildId: "same-artifact-different-manifest" });
  const result = publish(releases, second);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /archived manifest already exists with different bytes/);
  assert.deepEqual(fs.readFileSync(path.join(releases, "latest.json")), oldLatest, "failed conflict cannot move latest");
});

await test("publisher refuses a concurrent or stale single-instance lock before touching the shelf", () => {
  const input = tmpDir("publish-lock-input");
  const releases = tmpDir("publish-lock-shelf");
  const item = fixture(input);
  const lock = path.join(releases, ".release-control.v1.json.publish.lock");
  fs.writeFileSync(lock, "another publisher\n", { mode: 0o600 });
  const result = publish(releases, item);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /publisher is active|stale publisher lock/);
  assert.deepEqual(fs.readdirSync(releases), [path.basename(lock)]);
});

await test("first Production publication requires and accepts an offline-signed rollback baseline", () => {
  const now = Date.now();
  const betaPublishedAt = now - 8 * 86400_000;
  const betaArtifact = Buffer.from("authenticated customer package");
  const sourceCommit = "b".repeat(40);
  const betaInput = tmpDir("publish-first-production-beta-input");
  const betaItem = fixture(betaInput, { issuedAt: new Date(betaPublishedAt).toISOString(), sourceCommit });
  const betaShelf = tmpDir("publish-first-production-beta-shelf");
  const betaResult = publish(betaShelf, betaItem);
  assert.equal(betaResult.status, 0, betaResult.stderr);

  const controlStateFile = path.join(betaShelf, ".release-control.v1.json");
  const initialState = recordBetaPublication(defaultReleaseControlState(), betaItem.manifest, betaPublishedAt);
  writeReleaseControlState(controlStateFile, initialState);
  assert.equal(initialState.production, null, "this exercises an empty first-production head");

  const productionInput = tmpDir("publish-first-production-input");
  const productionItem = fixture(productionInput, {
    channel: "production", file: "wickhunter-production-0.89.92.tar.gz", sourceCommit,
  });
  assert.equal(productionItem.manifest.sha256, betaItem.manifest.sha256);
  const rollbackDir = tmpDir("publish-first-production-rollback");
  const rollbackManifest = signedRelease(rollbackDir, "production", Buffer.from("previous tested production package"));
  const evidenceFile = path.join(tmpDir("publish-first-production-evidence"), "attestation.json");
  const evidence = productionEvidence({ betaManifest: betaItem.manifest, rollbackManifest, now, betaPublishedAt });
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence));
  const feedbackFile = path.join(tmpDir("publish-first-production-feedback"), "feedback.jsonl");
  fs.writeFileSync(feedbackFile, "");
  const productionArgs = [
    "--channel", "production", "--beta-releases-dir", betaShelf,
    "--control-state", controlStateFile, "--promotion-attestation", evidenceFile,
    "--feedback-file", feedbackFile, "--rollback-releases-dir", rollbackDir,
  ];
  const noRollbackShelf = tmpDir("publish-first-production-no-rollback-shelf");
  const noRollback = publish(noRollbackShelf, productionItem, { HUB_RELEASE_AUTO_PROMOTION_ENABLED: "true" }, [
    ...productionArgs.slice(0, -2), "--rollback-releases-dir", tmpDir("publish-first-production-missing-rollback"),
  ]);
  assert.notEqual(noRollback.status, 0);
  assert.deepEqual(fs.readdirSync(noRollbackShelf), [], "a missing signed Production rollback cannot create a head");

  const mismatchedVersion = fixture(tmpDir("publish-first-production-bad-version"), {
    channel: "production", file: "wickhunter-production-wrong-version.tar.gz", version: "0.89.93", sourceCommit,
  });
  const refusedShelf = tmpDir("publish-first-production-bad-version-shelf");
  const refused = publish(refusedShelf, mismatchedVersion, { HUB_RELEASE_AUTO_PROMOTION_ENABLED: "true" }, productionArgs);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /version and minimum update protocol must match/);
  assert.deepEqual(fs.readdirSync(refusedShelf), [], "mismatched release metadata never reaches Production latest");

  const productionShelf = tmpDir("publish-first-production-shelf");
  const result = publish(productionShelf, productionItem, { HUB_RELEASE_AUTO_PROMOTION_ENABLED: "true" }, productionArgs);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(productionShelf, productionItem.manifest.file)), betaArtifact);
  const published = fs.readFileSync(path.join(productionShelf, "latest.json"));
  assert.deepEqual(published, fs.readFileSync(path.join(productionShelf, `manifest-${productionItem.manifest.sha256}.json`)));
  assert.deepEqual(fs.readFileSync(path.join(productionShelf, `promotion-${betaItem.manifest.sha256}.json`)), fs.readFileSync(evidenceFile));
  const after = JSON.parse(fs.readFileSync(controlStateFile, "utf8"));
  assert.equal(after.beta.sha256, betaItem.manifest.sha256);
  assert.equal(after.production.sha256, productionItem.manifest.sha256);
  assert.equal(after.production.version, productionItem.manifest.version);
});

summary("publish-release");
