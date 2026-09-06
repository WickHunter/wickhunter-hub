// tests/backup-script.test.mjs — smoke test for scripts/backup-data.sh
// against a real temp data directory: it must actually run (not merely
// parse), write a mode-0600 timestamped tarball whose content round-trips,
// and prune down to the configured keep count while printing what it kept.
// This is a REAL subprocess/filesystem test (spawnSync + tmpdir), the same
// shape tests/marketplace-inputs.test.mjs and tests/operations.test.mjs
// already use for shelling out — not something a pure-function unit test
// could stand in for.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, summary } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "backup-data.sh");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wickhub-backup-${prefix}-`));
}

function run(dataDir, backupDir, env = {}) {
  return spawnSync("bash", [SCRIPT, dataDir, backupDir], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function backups(dir) {
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith("wickhunter-hub-data-") && f.endsWith(".tar.gz")).sort()
    : [];
}

await test("the script exists, is executable, and is syntactically valid bash", () => {
  assert.ok(fs.existsSync(SCRIPT), SCRIPT);
  const mode = fs.statSync(SCRIPT).mode & 0o777;
  assert.ok(mode & 0o100, "owner-executable");
  const syntax = spawnSync("bash", ["-n", SCRIPT]);
  assert.equal(syntax.status, 0, syntax.stderr);
});

await test("refuses when the data directory does not exist, and writes nothing", () => {
  const dataDir = path.join(tmp("missing"), "data"); // never created
  const backupDir = tmp("out-missing");
  const r = run(dataDir, backupDir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not exist/);
  assert.deepEqual(backups(backupDir), []);
});

await test("a single run writes exactly one mode-0600 tarball whose content round-trips", () => {
  const dataDir = tmp("data-1");
  fs.writeFileSync(path.join(dataDir, "license-signing.key"), "not-a-real-key\n");
  fs.mkdirSync(path.join(dataDir, "sub"));
  fs.writeFileSync(path.join(dataDir, "sub", "roster.json"), JSON.stringify({ ok: true }));
  const backupDir = tmp("out-1");

  const r = run(dataDir, backupDir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote wickhunter-hub-data-\d{8}T\d{6}Z\.tar\.gz/);
  assert.match(r.stdout, /kept 1 of \d+ backup\(s\)/);

  const files = backups(backupDir);
  assert.equal(files.length, 1);
  const full = path.join(backupDir, files[0]);
  assert.equal(fs.statSync(full).mode & 0o777, 0o600, "the archive is owner-read/write only");

  // Content round-trips: extract and diff against the source.
  const extractTo = tmp("extracted-1");
  const untar = spawnSync("tar", ["-xzf", full, "-C", extractTo]);
  assert.equal(untar.status, 0, untar.stderr);
  const dataBase = path.basename(dataDir);
  assert.equal(
    fs.readFileSync(path.join(extractTo, dataBase, "license-signing.key"), "utf8"),
    "not-a-real-key\n",
  );
  assert.equal(
    fs.readFileSync(path.join(extractTo, dataBase, "sub", "roster.json"), "utf8"),
    JSON.stringify({ ok: true }),
  );
});

await test("pruning keeps only the newest HUB_BACKUP_KEEP by filename stamp, and prints the survivors newest-first", () => {
  const dataDir = tmp("data-2");
  fs.writeFileSync(path.join(dataDir, "roster.json"), "{}");
  const backupDir = tmp("out-2");
  fs.mkdirSync(backupDir, { recursive: true });
  // Pre-seed four backups with STRICTLY OLDER, distinct stamps (the script
  // sorts by filename, so pre-dated fixtures avoid sleeping out real seconds
  // between runs) — the real clock (2026 in this environment) sorts after
  // every one of these fakes.
  const older = ["20250101T000001Z", "20250101T000002Z", "20250101T000003Z", "20250101T000004Z"];
  for (const stamp of older) {
    const f = path.join(backupDir, `wickhunter-hub-data-${stamp}.tar.gz`);
    fs.writeFileSync(f, "not a real archive");
    fs.chmodSync(f, 0o600);
  }
  const r = run(dataDir, backupDir, { HUB_BACKUP_KEEP: "3" });
  assert.equal(r.status, 0, r.stderr);
  const finalFiles = backups(backupDir);
  assert.equal(finalFiles.length, 3, `expected exactly HUB_BACKUP_KEEP=3 to survive, got ${JSON.stringify(finalFiles)}`);
  // The two OLDEST fakes are the ones pruned; the newest fake and the
  // real run's own new backup both survive.
  assert.deepEqual(finalFiles.slice(0, 2), [
    `wickhunter-hub-data-${older[2]}.tar.gz`,
    `wickhunter-hub-data-${older[3]}.tar.gz`,
  ]);
  assert.match(r.stdout, /pruning wickhunter-hub-data-20250101T000001Z\.tar\.gz/);
  assert.match(r.stdout, /pruning wickhunter-hub-data-20250101T000002Z\.tar\.gz/);
  assert.match(r.stdout, /kept 3 of 3 backup\(s\), newest first:/);
  // "newest first" in the printed list: the just-written real backup (today's
  // stamp) is line one.
  const printedFirst = r.stdout.split("newest first:\n")[1].split("\n")[0].trim();
  assert.equal(printedFirst, finalFiles[2], "the newest survivor is printed first");
});

await test("HUB_BACKUP_KEEP must be a positive integer — a bad value refuses rather than silently defaulting", () => {
  const dataDir = tmp("data-3");
  fs.writeFileSync(path.join(dataDir, "roster.json"), "{}");
  const backupDir = tmp("out-3");
  // "" is deliberately NOT tested here: `${HUB_BACKUP_KEEP:-14}` treats an
  // EMPTY value the same as unset (the standard shell idiom), so it falls
  // back to the default rather than refusing — that is intentional, not the
  // gap this test is for.
  for (const bad of ["0", "-1", "abc", "3.5"]) {
    const r = run(dataDir, backupDir, { HUB_BACKUP_KEEP: bad });
    assert.notEqual(r.status, 0, `HUB_BACKUP_KEEP=${JSON.stringify(bad)} should refuse`);
  }
  assert.deepEqual(backups(backupDir), []);
});

await test("defaults (no explicit DATA_DIR/BACKUP_DIR args) read HUB_DATA_DIR / HUB_BACKUP_DIR from the environment", () => {
  const dataDir = tmp("data-4");
  fs.writeFileSync(path.join(dataDir, "roster.json"), "{}");
  const backupDir = tmp("out-4");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, HUB_DATA_DIR: dataDir, HUB_BACKUP_DIR: backupDir },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(backups(backupDir).length, 1);
});

summary("backup-script");
