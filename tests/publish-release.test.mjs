import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { releaseSigningBytes } from "../dist/src/release-manifest.js";
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

summary("publish-release");
