// Detached self-upgrade worker. No shell is involved: the source checkout must
// be clean, on main, and fast-forward exactly to origin/main before the signed
// installer is allowed to replace the running build.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  HUB_UPGRADE_LOG_FILE,
  readBuildRecord,
  writeUpgradeStatus,
} from "../src/operations.js";
import { HUB_VERSION } from "../src/version.js";

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && typeof process.argv[at + 1] === "string" ? process.argv[at + 1]! : null;
}

const source = arg("source");
const dataDir = arg("data");
if (!source || !dataDir) throw new Error("usage: upgrade-runner --source DIR --data DIR");
const sourceDir: string = source;
const statusDataDir: string = dataDir;
const logFile = path.join(statusDataDir, HUB_UPGRADE_LOG_FILE);
fs.mkdirSync(statusDataDir, { recursive: true });

function log(line: string): void {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, { encoding: "utf8", mode: 0o600 });
}

function run(command: string, args: readonly string[]): string {
  log(`running ${command} ${args.map((v) => JSON.stringify(v)).join(" ")}`);
  const result = spawnSync(command, [...args], { cwd: sourceDir, encoding: "utf8", env: process.env });
  if (result.stdout) fs.appendFileSync(logFile, result.stdout, "utf8");
  if (result.stderr) fs.appendFileSync(logFile, result.stderr, "utf8");
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? "without a status"}`);
  return String(result.stdout ?? "").trim();
}

const before = readBuildRecord(statusDataDir, HUB_VERSION).commit;
const startedAtMs = Date.now();
writeUpgradeStatus(statusDataDir, {
  state: "running", startedAtMs, completedAtMs: null, fromCommit: before,
  targetCommit: null, message: "Fetching and verifying origin/main.",
});

try {
  const dirty = run("git", ["status", "--porcelain"]);
  if (dirty) throw new Error("source checkout has local changes; refusing to overwrite operator work");
  const branch = run("git", ["branch", "--show-current"]);
  if (branch !== "main") throw new Error(`source checkout is on ${branch || "detached HEAD"}, not main`);
  run("git", ["fetch", "--prune", "origin", "main"]);
  run("git", ["merge", "--ff-only", "origin/main"]);
  const head = run("git", ["rev-parse", "HEAD"]);
  const originMain = run("git", ["rev-parse", "origin/main"]);
  if (!/^[a-f0-9]{40}$/.test(head) || head !== originMain) {
    throw new Error("source checkout did not land exactly on origin/main");
  }
  writeUpgradeStatus(statusDataDir, {
    state: "running", startedAtMs, completedAtMs: null, fromCommit: before,
    targetCommit: head, message: "origin/main verified; installing the exact fetched commit.",
  });
  const result = spawnSync("bash", [path.join(sourceDir, "install-hub.sh")], {
    cwd: sourceDir,
    encoding: "utf8",
    env: { ...process.env, HUB_EXPECTED_SOURCE_COMMIT: head, HUB_EXPECTED_SOURCE_BRANCH: branch },
  });
  if (result.stdout) fs.appendFileSync(logFile, result.stdout, "utf8");
  if (result.stderr) fs.appendFileSync(logFile, result.stderr, "utf8");
  if (result.status !== 0) throw new Error(`install-hub.sh exited ${result.status ?? "without a status"}`);
  writeUpgradeStatus(statusDataDir, {
    state: "succeeded", startedAtMs, completedAtMs: Date.now(), fromCommit: before,
    targetCommit: head, message: "Hub upgraded from the verified origin/main checkout.",
  });
  log(`upgrade succeeded at ${head}`);
} catch (err) {
  const message = err instanceof Error ? err.message : "upgrade failed";
  writeUpgradeStatus(statusDataDir, {
    state: "failed", startedAtMs, completedAtMs: Date.now(), fromCommit: before,
    targetCommit: null, message: message.slice(0, 1_000),
  });
  log(`upgrade failed: ${message}`);
  process.exitCode = 1;
}
