// Security Phase 1: the Hub validates and serves, but cannot sign, releases.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  releaseSigningBytes,
  verifyReleaseArtifact,
  verifyReleaseManifest,
} from "../dist/src/release-manifest.js";
import { configFromEnv } from "../dist/src/config.js";
import { test, summary, tmpDir } from "./helpers.mjs";

const pair = generateKeyPairSync("ed25519");
const kid = "release-test-1";
const publicKeys = { [kid]: pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url") };
const artifact = Buffer.from("authenticated artifact");
const unsigned = {
  schema: "wickhunter.release.v1",
  product: "wickhunter",
  channel: "beta",
  platform: "linux",
  arch: "x64",
  version: "4.5.6",
  buildId: "build-456abcdef",
  file: "wickhunter-beta-4.5.6.tar.gz",
  sha256: createHash("sha256").update(artifact).digest("hex"),
  issuedAt: "2026-08-25T00:00:00.000Z",
  minUpdateProtocol: 1,
};
const manifest = {
  ...unsigned,
  signatures: [{ kid, alg: "Ed25519", sig: edSign(null, releaseSigningBytes(unsigned), pair.privateKey).toString("base64url") }],
};
const policy = {
  publicKeys,
  now: Date.parse("2026-08-25T01:00:00.000Z"),
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  channel: "beta",
  platform: "linux",
  arch: "x64",
};

await test("valid dedicated Ed25519 release and artifact verify", async () => {
  assert.equal(verifyReleaseManifest(manifest, policy).buildId, unsigned.buildId);
  assert.doesNotThrow(() => verifyReleaseArtifact(manifest, artifact));
});

await test("wrong key, unknown kid, tamper, stale and wrong target fail closed", async () => {
  const other = generateKeyPairSync("ed25519");
  const otherRaw = other.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
  assert.throws(() => verifyReleaseManifest(manifest, { ...policy, publicKeys: { [kid]: otherRaw } }), /signature is invalid/);
  assert.throws(() => verifyReleaseManifest(manifest, { ...policy, publicKeys: { other: otherRaw } }), /trusted key id/);
  assert.throws(() => verifyReleaseManifest({ ...manifest, file: "other.tar.gz" }, policy), /signature is invalid/);
  assert.throws(() => verifyReleaseManifest(manifest, { ...policy, now: Date.parse("2026-10-01T00:00:01.000Z") }), /stale/);
  assert.throws(() => verifyReleaseManifest(manifest, { ...policy, arch: "arm64" }), /architecture/);
  assert.throws(() => verifyReleaseArtifact(manifest, Buffer.from("tampered")), /sha256/);
});

await test("old client/new Hub compatibility keeps legacy fields additive", async () => {
  const legacy = (({ version, file, sha256 }) => ({ version, file, sha256 }))(manifest);
  assert.deepEqual(legacy, { version: unsigned.version, file: unsigned.file, sha256: unsigned.sha256 });
  assert.ok(Object.keys(manifest).length > Object.keys(legacy).length);
});

await test("production config requires HTTPS and a public-only release keyring", async () => {
  assert.throws(() => configFromEnv({ NODE_ENV: "production", HUB_PUBLIC_ORIGIN: "http://hub.example" }), /HTTPS/);
  assert.throws(() => configFromEnv({ NODE_ENV: "production", HUB_PUBLIC_ORIGIN: "https://hub.example" }), /PUBLIC_KEYS/);
  const cfg = configFromEnv({
    NODE_ENV: "production",
    HUB_PUBLIC_ORIGIN: "https://hub.example/hub",
    HUB_RELEASE_PUBLIC_KEYS_JSON: JSON.stringify(publicKeys),
  });
  assert.deepEqual(cfg.releasePublicKeys, publicKeys);
  assert.equal(cfg.publicOrigin, "https://hub.example/hub");
});

await test("Hub source has no release private-key or licence-key signing seam", async () => {
  const source = fs.readFileSync(new URL("../src/release-manifest.ts", import.meta.url), "utf8");
  const config = fs.readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  assert.ok(!source.includes("createPrivateKey") && !source.includes("sign as") && !source.includes("LicenseStore"));
  assert.ok(!config.includes("RELEASE_SIGNING_PRIVATE") && !config.includes("releasePrivate"));
});

await test("the exact installer verifier accepts valid metadata and rejects tamper", async () => {
  const template = fs.readFileSync(new URL("../templates/install.sh", import.meta.url), "utf8");
  const match = /<<'VERIFY_RELEASE'\n([\s\S]*?)\nVERIFY_RELEASE/.exec(template);
  assert.ok(match, "installer carries an inline verifier");
  const dir = tmpDir("installer-verifier");
  const verifier = path.join(dir, "verify.cjs");
  const input = path.join(dir, "latest.json");
  const output = path.join(dir, "verified.json");
  const appDir = path.join(dir, "app");
  fs.mkdirSync(appDir);
  fs.writeFileSync(verifier, match[1]);
  const installerUnsigned = { ...unsigned, arch: process.arch, issuedAt: new Date().toISOString() };
  const installerManifest = {
    ...installerUnsigned,
    signatures: [{ kid, alg: "Ed25519", sig: edSign(null, releaseSigningBytes(installerUnsigned), pair.privateKey).toString("base64url") }],
  };
  fs.writeFileSync(input, JSON.stringify({ ok: true, ...installerManifest }));
  const args = [input, output, Buffer.from(JSON.stringify(publicKeys)).toString("base64url"), String(policy.maxAgeMs), appDir];
  execFileSync(process.execPath, [verifier, ...args]);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).buildId, manifest.buildId);
  fs.writeFileSync(input, JSON.stringify({ ok: true, ...installerManifest, file: "tampered.tar.gz" }));
  assert.throws(() => execFileSync(process.execPath, [verifier, ...args], { stdio: "pipe" }), /Command failed/);
});

summary("release-manifest");
