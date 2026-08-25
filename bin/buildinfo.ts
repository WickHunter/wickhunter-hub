// Write the installed build identity after TypeScript compiled successfully.
import { writeBuildRecord } from "../src/operations.js";

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && typeof process.argv[at + 1] === "string" ? process.argv[at + 1]! : null;
}

const dataDir = arg("data");
const packageVersion = arg("version");
const commitRaw = arg("commit");
const branchRaw = arg("branch");
if (!dataDir || !packageVersion) throw new Error("usage: buildinfo --data DIR --version X.Y.Z [--commit SHA] [--branch NAME]");

const record = writeBuildRecord(dataDir, {
  packageVersion,
  commit: commitRaw && commitRaw !== "unknown" ? commitRaw : null,
  branch: branchRaw && branchRaw !== "unknown" ? branchRaw : null,
  builtAtMs: Date.now(),
});
console.log(`Recorded Hub build ${record.packageVersion} ${record.commit ?? "unknown-commit"} (${record.branch ?? "unknown-branch"}).`);
