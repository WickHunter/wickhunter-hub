// src/jsonfile.ts
// Small durable-file helpers. Writes go tmp-then-rename in the same directory
// so a crash mid-write can never leave a torn licenses/revoked/roster file —
// the reader sees either the old file or the new one, never half of each.
import fs from "node:fs";
import path from "node:path";

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
  fs.renameSync(tmp, file);
}

/** Append one JSON line. Append-only ledgers (check-ins) use this; a partial
 *  final line after a crash is tolerated by readers, prior lines are safe. */
export function appendJsonl(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
}
