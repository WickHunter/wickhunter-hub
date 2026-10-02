/** Fail closed when origin/main would replace the installed Hub with an older
 * or unrelated build. The automated updater is not a rollback mechanism. */
function parsedVersion(value: string): { major: number; minor: number; patch: number; prerelease: string[] | null } | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4] ? match[4].split(".") : null;
  if (prerelease?.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith("0"))) return null;
  return { major, minor, patch, prerelease };
}

function comparePrerelease(left: string[] | null, right: string[] | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) {
    const a = left[i], b = right[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^(0|[1-9]\d*)$/.test(a), bNumeric = /^(0|[1-9]\d*)$/.test(b);
    if (aNumeric && bNumeric) return a.length === b.length ? a < b ? -1 : 1 : a.length < b.length ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Return a reason when automatic origin/main installation is unsafe. */
export function upgradeRefusal(
  runningVersion: string,
  recordedVersion: string,
  targetVersion: string,
  runtimeCommit: string | null,
  targetCommit: string,
  targetDescendsFromRuntime: boolean,
): string | null {
  const running = parsedVersion(runningVersion), recorded = parsedVersion(recordedVersion), target = parsedVersion(targetVersion);
  if (!running || !recorded || !target) return "The running or source Hub version could not be verified; automatic upgrade refused.";
  if (recordedVersion !== runningVersion) return "The installed build record does not match the running Hub version; automatic upgrade refused.";
  const versionOrder = running.major - target.major || running.minor - target.minor || running.patch - target.patch
    || comparePrerelease(running.prerelease, target.prerelease);
  if (versionOrder > 0) return `origin/main version ${targetVersion} is older than running v${runningVersion}; automatic downgrade refused.`;
  if (!runtimeCommit || !/^[a-f0-9]{40}$/.test(runtimeCommit) || !/^[a-f0-9]{40}$/.test(targetCommit)
    || !targetDescendsFromRuntime) {
    return "origin/main is not verifiably based on the installed Hub build; automatic upgrade refused.";
  }
  return null;
}
