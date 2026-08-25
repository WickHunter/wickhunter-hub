// Security Phase 1: the Hub validates and serves, but cannot sign, releases.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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
  fs.writeFileSync(input, gzipSync(JSON.stringify({ ok: true, ...installerManifest })));
  execFileSync(process.execPath, [verifier, ...args]);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).buildId, manifest.buildId);
  fs.writeFileSync(input, JSON.stringify({ ok: true, ...installerManifest, file: "tampered.tar.gz" }));
  assert.throws(() => execFileSync(process.execPath, [verifier, ...args], { stdio: "pipe" }), /Command failed/);
});

await test("installer fetch is deterministic and binary transport errors are sanitized", async () => {
  const template = fs.readFileSync(new URL("../templates/install.sh", import.meta.url), "utf8");
  assert.match(template, /curl -q --fail --silent --show-error/);
  assert.doesNotMatch(template, /--compressed/);
  assert.match(template, /Accept-Encoding: identity/);
  assert.match(template, /head -c "\$\(\(fetch_max \+ 1\)\)"/);
  assert.ok(!template.includes("meta=$(curl"), "manifest bytes never pass through a shell variable");

  const match = /<<'VERIFY_RELEASE'\n([\s\S]*?)\nVERIFY_RELEASE/.exec(template);
  assert.ok(match);
  const dir = tmpDir("installer-corrupt-transport");
  const verifier = path.join(dir, "verify.cjs");
  const input = path.join(dir, "latest.json");
  const output = path.join(dir, "verified.json");
  const appDir = path.join(dir, "app");
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, "sentinel"), "running-version-untouched");
  fs.writeFileSync(verifier, match[1]);
  fs.writeFileSync(input, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff, 0x00]));
  const args = [input, output, Buffer.from(JSON.stringify(publicKeys)).toString("base64url"), String(policy.maxAgeMs), appDir];
  let stderr = "";
  try { execFileSync(process.execPath, [verifier, ...args], { stdio: "pipe" }); }
  catch (error) { stderr = String(error.stderr ?? ""); }
  assert.match(stderr, /not UTF-8 JSON|not valid JSON/);
  assert.doesNotMatch(stderr, /Unexpected token/);
  assert.ok(!fs.existsSync(output), "corrupt transport never creates a verified manifest");
  assert.equal(fs.readFileSync(path.join(appDir, "sentinel"), "utf8"), "running-version-untouched");
});

await test("the exact fetch pipeline hard-caps chunked and unknown-length bodies", async () => {
  const template = fs.readFileSync(new URL("../templates/install.sh", import.meta.url), "utf8");
  const from = template.indexOf("curl_hub() {");
  const to = template.indexOf("\nif fetch_bounded ", from);
  assert.ok(from >= 0 && to > from, "installer fetch helpers are extractable");
  const helpers = template.slice(from, to);
  const dir = tmpDir("installer-bounded-fetch");
  const fakeBin = path.join(dir, "bin");
  fs.mkdirSync(fakeBin);
  const fakeCurl = path.join(fakeBin, "curl");
  fs.writeFileSync(fakeCurl, "#!/usr/bin/env bash\ncat \"$FAKE_CURL_PAYLOAD\"\nexit \"${FAKE_CURL_EXIT:-0}\"\n", { mode: 0o755 });
  const runner = path.join(dir, "fetch.sh");
  fs.writeFileSync(runner, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${helpers}\nfetch_bounded 'https://hub.invalid/api/latest?key=fake' "$1" "$2" 'application/json'\n`, { mode: 0o755 });

  const small = path.join(dir, "small.input");
  const smallOut = path.join(dir, "small.out");
  fs.writeFileSync(small, "{\"ok\":true}");
  const baseEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
  const okRun = spawnSync("bash", [runner, smallOut, "1048576"], {
    env: { ...baseEnv, FAKE_CURL_PAYLOAD: small }, encoding: "utf8",
  });
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.equal(fs.readFileSync(smallOut, "utf8"), "{\"ok\":true}");

  const exact = path.join(dir, "exact.input");
  const exactOut = path.join(dir, "exact.out");
  fs.writeFileSync(exact, Buffer.alloc(1024 * 1024, 0x42));
  const exactRun = spawnSync("bash", [runner, exactOut, "1048576"], {
    env: { ...baseEnv, FAKE_CURL_PAYLOAD: exact }, encoding: "utf8",
  });
  assert.equal(exactRun.status, 0, exactRun.stderr);
  assert.equal(fs.statSync(exactOut).size, 1048576, "MAX bytes are accepted exactly");

  const partialOut = path.join(dir, "partial.out");
  const partial = spawnSync("bash", [runner, partialOut, "1048576"], {
    env: { ...baseEnv, FAKE_CURL_PAYLOAD: small, FAKE_CURL_EXIT: "7" }, encoding: "utf8",
  });
  assert.equal(partial.status, 1, "partial bytes plus a curl failure are never accepted");

  const huge = path.join(dir, "huge.input");
  const hugeOut = path.join(dir, "huge.out");
  fs.writeFileSync(huge, Buffer.alloc(2 * 1024 * 1024, 0x41));
  const capped = spawnSync("bash", [runner, hugeOut, "1048576"], {
    env: { ...baseEnv, FAKE_CURL_PAYLOAD: huge }, encoding: "utf8",
  });
  assert.equal(capped.status, 65, capped.stderr);
  assert.equal(fs.statSync(hugeOut).size, 1048577, "MAX+1 is refused and is all that reaches disk");
});

summary("release-manifest");
