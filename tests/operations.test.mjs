import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir, test, summary } from "./helpers.mjs";
import {
  HUB_UPGRADE_LOG_FILE,
  probeSourceCheckout,
  readBuildRecord,
  readUpgradeLogTail,
  readUpgradeStatus,
  writeBuildRecord,
  writeUpgradeStatus,
} from "../dist/src/operations.js";

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

const mode = (filename) => fs.statSync(filename).mode & 0o777;

await test("installer normalization repairs a 0077 build without opening durable state", () => {
  const hubDir = tmpDir("ops-permissions");
  const runtimeDir = path.join(hubDir, "dist", "src", "marketcap");
  const runtimeFile = path.join(runtimeDir, "venues.js");
  const dataDir = path.join(hubDir, "data");
  const releaseDir = path.join(hubDir, "releases");
  const signingKey = path.join(dataDir, "license-signing.key");
  const artifact = path.join(releaseDir, "private-release.tgz");

  // Reproduce the live failure exactly: a new compiler directory and module
  // created while the root installer inherited umask 0077.
  const previousUmask = process.umask(0o077);
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(runtimeFile, "export const venue = 'binance';\n");
    fs.mkdirSync(dataDir);
    fs.writeFileSync(signingKey, "private\n");
    fs.mkdirSync(releaseDir);
    fs.writeFileSync(artifact, "licensed\n");
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(mode(runtimeDir), 0o700);
  assert.equal(mode(runtimeFile), 0o600);
  assert.equal(mode(dataDir), 0o700);
  assert.equal(mode(signingKey), 0o600);
  assert.equal(mode(releaseDir), 0o700);
  assert.equal(mode(artifact), 0o600);

  const helper = fileURLToPath(new URL("../bin/normalize-runtime-permissions.sh", import.meta.url));
  execFileSync("/bin/bash", [helper, hubDir]);

  assert.equal(mode(hubDir), 0o755, "the service can traverse the install root");
  assert.equal(mode(runtimeDir), 0o755, "the service can traverse a newly compiled directory");
  assert.equal(mode(runtimeFile), 0o644, "the service can read a newly compiled module");
  assert.equal(mode(dataDir), 0o700, "the state directory remains private");
  assert.equal(mode(signingKey), 0o600, "the signing key is never normalized as code");
  assert.equal(mode(releaseDir), 0o700, "the release shelf remains private");
  assert.equal(mode(artifact), 0o600, "licensed artifacts are never normalized as code");

  const installer = fs.readFileSync(new URL("../install-hub.sh", import.meta.url), "utf8");
  assert.match(installer, /normalize-runtime-permissions\.sh/);
  assert.match(installer, /chown -R "\$SERVICE_USER:\$SERVICE_USER" "\$HUB_DIR\/data" "\$HUB_DIR\/releases"/);
  assert.match(installer, /chmod 700 "\$HUB_DIR\/data" "\$HUB_DIR\/releases"/);
});

await test("durable build identity distinguishes installed runtime from current source and origin/main", () => {
  const dataDir = tmpDir("ops-data");
  const srcDir = tmpDir("ops-src");
  git(srcDir, "init", "-b", "main");
  git(srcDir, "config", "user.email", "hub-test@example.invalid");
  git(srcDir, "config", "user.name", "Hub Test");
  fs.writeFileSync(path.join(srcDir, "package.json"), JSON.stringify({ version: "0.3.3" }) + "\n");
  fs.writeFileSync(path.join(srcDir, "source.txt"), "one\n");
  git(srcDir, "add", "package.json", "source.txt");
  git(srcDir, "commit", "-m", "initial");
  const installedCommit = git(srcDir, "rev-parse", "HEAD");
  git(srcDir, "update-ref", "refs/remotes/origin/main", installedCommit);
  const build = writeBuildRecord(dataDir, {
    packageVersion: "0.3.3", commit: installedCommit, branch: "main", builtAtMs: 1_700_000_000_000,
  });
  assert.deepEqual(readBuildRecord(dataDir, "0.3.3"), build);
  const current = probeSourceCheckout(srcDir, build);
  assert.equal(current.relationToOriginMain, "current");
  assert.equal(current.relationToRuntime, "matches");
  assert.equal(current.dirty, false);

  fs.writeFileSync(path.join(srcDir, "source.txt"), "two\n");
  git(srcDir, "add", "source.txt");
  git(srcDir, "commit", "-m", "local next");
  const ahead = probeSourceCheckout(srcDir, build);
  assert.equal(ahead.relationToOriginMain, "ahead");
  assert.equal(ahead.relationToRuntime, "differs");
  fs.writeFileSync(path.join(srcDir, "source.txt"), "dirty\n");
  assert.equal(probeSourceCheckout(srcDir, build).dirty, true);
});

await test("upgrade outcome and bounded log tail survive restart without trusting malformed files", () => {
  const dataDir = tmpDir("ops-status");
  assert.equal(readUpgradeStatus(dataDir).state, "never");
  const status = writeUpgradeStatus(dataDir, {
    state: "failed", startedAtMs: 100, completedAtMs: 200,
    fromCommit: "a".repeat(40), targetCommit: "b".repeat(40), message: "installer refused wrong branch",
  });
  assert.deepEqual(readUpgradeStatus(dataDir), status);
  fs.writeFileSync(path.join(dataDir, HUB_UPGRADE_LOG_FILE),
    "HUB_ADMIN_TOKEN=" + "a".repeat(64) + "\nAuthorization: Bearer bearer-secret-value\nlatest\n");
  const redacted = readUpgradeLogTail(dataDir, 1_024);
  assert.equal(redacted.includes("a".repeat(64)), false);
  assert.equal(redacted.includes("bearer-secret-value"), false);
  const tail = readUpgradeLogTail(dataDir, 32);
  assert.ok(tail.endsWith("latest\n"));
  assert.ok(Buffer.byteLength(tail) <= 32);
  fs.writeFileSync(path.join(dataDir, "hub-build.v1.json"), JSON.stringify({ schemaVersion: 1, packageVersion: "not-a-version" }));
  assert.equal(readBuildRecord(dataDir, "0.3.3").commit, null);
});

summary("operations");
