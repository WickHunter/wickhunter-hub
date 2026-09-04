// src/jsonfile.ts
// Small durable-file helpers. Writes go tmp-then-rename in the same directory
// so a crash mid-write can never leave a torn licenses/revoked/roster file —
// the reader sees either the old file or the new one, never half of each.
//
// v0.3.20 — A FILE WRITTEN BY ROOT BELONGS TO THE DIRECTORY'S OWNER.
// `npm run extend` (and `issue`, `revoke`, `leasekey`) are run by the operator
// as root; every file here is created at mode 0600, so a registry rewritten by
// a root-run CLI came out root:root 0600 and the `wickhunter-hub` service user
// got EACCES on its next read — `GET /admin/api/licenses` and EVERY tester
// check-in answered 500 until someone ran chown by hand (2026-09-04, the
// night the beta extension was applied). The data directory's owner is the
// service user by installation, so when the writer is root the new file is
// handed to that owner before it is renamed into place. Nothing changes for
// the service itself, which is never root.
import fs from "node:fs";
import path from "node:path";

type OwnershipHooks = {
  isRoot: () => boolean;
  ownerOf: (dir: string) => { uid: number; gid: number };
  chown: (file: string, uid: number, gid: number) => void;
};
const REAL_HOOKS: OwnershipHooks = {
  isRoot: () => typeof process.getuid === "function" && process.getuid() === 0,
  ownerOf: (dir) => { const s = fs.statSync(dir); return { uid: s.uid, gid: s.gid }; },
  chown: (file, uid, gid) => fs.chownSync(file, uid, gid),
};
let hooks: OwnershipHooks = REAL_HOOKS;
/** Test seam: whether the suite runs as root and who owns its temp directory
 *  are facts about the CI box, so all three reads are driven here. */
export function __setOwnershipHooksForTests(next: Partial<OwnershipHooks> | null): void {
  hooks = next ? { ...REAL_HOOKS, ...next } : REAL_HOOKS;
}

/** Hand `file` to the owner of its directory when this process is root. A
 *  non-root writer already produces a file it can read, and a root process
 *  whose directory is ALSO root-owned (a bare dev checkout) is left alone. */
function matchDirectoryOwner(file: string): void {
  if (!hooks.isRoot()) return;
  const owner = hooks.ownerOf(path.dirname(file));
  if (owner.uid === 0 && owner.gid === 0) return;
  hooks.chown(file, owner.uid, owner.gid);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err; // a CORRUPT file is a real problem; do not silently reset state
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  matchDirectoryOwner(tmp); // before the rename: the service never sees a root-owned registry
  fs.renameSync(tmp, file);
}

/** Append one JSON line. Append-only ledgers (check-ins) use this; a partial
 *  final line after a crash is tolerated by readers, prior lines are safe. */
export function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
  matchDirectoryOwner(file);
}
