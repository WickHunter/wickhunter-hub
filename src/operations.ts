// Operator-visible build and upgrade facts.
//
// The running Hub is installed without `.git`, so its commit cannot be
// reconstructed from the deployed files. `install-hub.sh` therefore writes a
// small immutable build record after a successful compile. The live source
// checkout is probed separately and compared with that record; a stale runtime
// can no longer look like a current checkout merely because both processes are
// healthy.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const HUB_BUILD_RECORD_FILE = "hub-build.v1.json";
export const HUB_UPGRADE_STATUS_FILE = "upgrade-status.v1.json";
export const HUB_UPGRADE_LOG_FILE = "upgrade.log";

export interface HubBuildRecord {
  readonly schemaVersion: 1;
  readonly packageVersion: string;
  readonly commit: string | null;
  readonly branch: string | null;
  readonly builtAtMs: number;
}

export type UpgradeState = "never" | "queued" | "running" | "succeeded" | "failed";

export interface HubUpgradeStatus {
  readonly schemaVersion: 1;
  readonly state: UpgradeState;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly fromCommit: string | null;
  readonly targetCommit: string | null;
  readonly message: string;
}

export interface SourceCheckoutStatus {
  readonly available: boolean;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly originMainCommit: string | null;
  readonly packageVersion: string | null;
  readonly dirty: boolean | null;
  readonly relationToOriginMain: "current" | "behind" | "ahead" | "diverged" | "unknown";
  readonly relationToRuntime: "matches" | "differs" | "unknown";
  readonly refusal: string | null;
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function isBranch(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value);
}

function readObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

export function writeBuildRecord(dataDir: string, input: Omit<HubBuildRecord, "schemaVersion">): HubBuildRecord {
  if (!isVersion(input.packageVersion)) throw new Error("build package version is invalid");
  if (!(input.commit === null || isCommit(input.commit))) throw new Error("build commit must be a full lowercase SHA-1");
  if (!(input.branch === null || isBranch(input.branch))) throw new Error("build branch is invalid");
  if (!Number.isSafeInteger(input.builtAtMs) || input.builtAtMs < 0) throw new Error("build time is invalid");
  const row: HubBuildRecord = { schemaVersion: 1, ...input };
  writeJsonAtomic(path.join(dataDir, HUB_BUILD_RECORD_FILE), row);
  return row;
}

export function readBuildRecord(dataDir: string, runtimeVersion: string): HubBuildRecord {
  const row = readObject(path.join(dataDir, HUB_BUILD_RECORD_FILE));
  if (row?.schemaVersion === 1 && isVersion(row.packageVersion)
    && (row.commit === null || isCommit(row.commit))
    && (row.branch === null || isBranch(row.branch))
    && Number.isSafeInteger(row.builtAtMs) && Number(row.builtAtMs) >= 0) {
    return row as unknown as HubBuildRecord;
  }
  return { schemaVersion: 1, packageVersion: runtimeVersion, commit: null, branch: null, builtAtMs: 0 };
}

const NEVER_UPGRADED: HubUpgradeStatus = Object.freeze({
  schemaVersion: 1,
  state: "never",
  startedAtMs: null,
  completedAtMs: null,
  fromCommit: null,
  targetCommit: null,
  message: "No Hub upgrade has been recorded on this installation.",
});

export function readUpgradeStatus(dataDir: string): HubUpgradeStatus {
  const row = readObject(path.join(dataDir, HUB_UPGRADE_STATUS_FILE));
  const states: readonly UpgradeState[] = ["never", "queued", "running", "succeeded", "failed"];
  if (row?.schemaVersion !== 1 || !states.includes(row.state as UpgradeState)
    || !(row.startedAtMs === null || Number.isSafeInteger(row.startedAtMs))
    || !(row.completedAtMs === null || Number.isSafeInteger(row.completedAtMs))
    || !(row.fromCommit === null || isCommit(row.fromCommit))
    || !(row.targetCommit === null || isCommit(row.targetCommit))
    || typeof row.message !== "string" || row.message.length > 1_000) return NEVER_UPGRADED;
  return row as unknown as HubUpgradeStatus;
}

export function writeUpgradeStatus(dataDir: string, row: Omit<HubUpgradeStatus, "schemaVersion">): HubUpgradeStatus {
  const status: HubUpgradeStatus = { schemaVersion: 1, ...row };
  // Round-trip through the reader's validation before the durable replacement.
  if (!(["never", "queued", "running", "succeeded", "failed"] as readonly string[]).includes(status.state)
    || status.message.length > 1_000) throw new Error("upgrade status is invalid");
  writeJsonAtomic(path.join(dataDir, HUB_UPGRADE_STATUS_FILE), status);
  return status;
}

function git(srcDir: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", srcDir, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000,
  }).trim();
}

function ancestor(srcDir: string, older: string, newer: string): boolean {
  try {
    execFileSync("git", ["-C", srcDir, "merge-base", "--is-ancestor", older, newer], {
      stdio: "ignore", timeout: 2_000,
    });
    return true;
  } catch { return false; }
}

export function probeSourceCheckout(srcDir: string, runtime: HubBuildRecord): SourceCheckoutStatus {
  try {
    const commit = git(srcDir, ["rev-parse", "HEAD"]);
    const branchRaw = git(srcDir, ["branch", "--show-current"]);
    const branch = isBranch(branchRaw) ? branchRaw : null;
    const originRaw = git(srcDir, ["rev-parse", "origin/main"]);
    const originMainCommit = isCommit(originRaw) ? originRaw : null;
    if (!isCommit(commit) || originMainCommit === null) throw new Error("source checkout has no readable HEAD or origin/main");
    let packageVersion: string | null = null;
    try {
      const pkg: unknown = JSON.parse(fs.readFileSync(path.join(srcDir, "package.json"), "utf8"));
      const version = pkg !== null && typeof pkg === "object" ? (pkg as { version?: unknown }).version : null;
      packageVersion = isVersion(version) ? version : null;
    } catch { /* reported as null */ }
    const dirty = git(srcDir, ["status", "--porcelain"]).length > 0;
    const relationToOriginMain = commit === originMainCommit ? "current"
      : ancestor(srcDir, commit, originMainCommit) ? "behind"
        : ancestor(srcDir, originMainCommit, commit) ? "ahead" : "diverged";
    const relationToRuntime = runtime.commit === null ? "unknown"
      : runtime.commit === commit && runtime.packageVersion === packageVersion ? "matches" : "differs";
    return {
      available: true, branch, commit, originMainCommit, packageVersion, dirty,
      relationToOriginMain, relationToRuntime, refusal: null,
    };
  } catch {
    return {
      available: false, branch: null, commit: null, originMainCommit: null,
      packageVersion: null, dirty: null, relationToOriginMain: "unknown",
      relationToRuntime: "unknown", refusal: "The configured Hub source checkout could not be inspected.",
    };
  }
}

export function readUpgradeLogTail(dataDir: string, maxBytes = 16_384): string {
  const file = path.join(dataDir, HUB_UPGRADE_LOG_FILE);
  try {
    const fd = fs.openSync(file, "r");
    try {
      const stat = fs.fstatSync(fd);
      // Read context before the visible tail so a secret assignment that
      // crosses the display boundary is still redacted as one value.
      const size = Math.min(stat.size, maxBytes + 4_096);
      const out = Buffer.alloc(size);
      fs.readSync(fd, out, 0, size, Math.max(0, stat.size - size));
      return out.toString("utf8")
        .replace(/[^\t\n\r\x20-\x7e]/g, "�")
        .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi, "[redacted-database-url]")
        .replace(/\b(Authorization\s*:\s*Bearer|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
        .replace(/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|CREDENTIAL|PASSWORD|DATABASE_URL|VAULT_KEY|API_KEY)[A-Z0-9_]*)\s*=\s*[^\s,;]+/g,
          "$1=[redacted]")
        .replace(/\b[a-f0-9]{64}\b/gi, "[redacted-64-hex-value]")
        .slice(-maxBytes);
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}
