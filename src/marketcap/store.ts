// src/marketcap/store.ts
// Durable state for the market-cap producer: the published snapshot, the credit
// ledger, and the operator's identity overrides.
//
// ── WHY THE WRITE IS tmp + fsync + rename AND NOT jsonfile.ts's WRITE ───────
// `jsonfile.ts` already writes tmp-then-rename, which is what makes a licence
// file un-tearable. It does NOT fsync, and for licences that is a fair trade: a
// crash losing the last few writes costs a re-issue. This file is different in
// one way that matters — the snapshot is the thing clients READ WHEN THE
// PRODUCER IS DOWN. A rename that reached the directory entry while the DATA
// was still in the page cache leaves, after a host crash, a file that exists,
// parses as far as its first truncated row, and is served as last-known-good.
// So the bytes are flushed before the rename, and the DIRECTORY is flushed
// after it, because on ext4 the rename itself is the metadata operation that
// must survive.
import fs from "node:fs";
import path from "node:path";
import { readJson } from "../jsonfile.js";
import type { CreditLedger } from "./budget.js";
import { emptyLedger } from "./budget.js";
import type { OverrideMap, IdentityOverride } from "./identity.js";
import type { SnapshotSigned } from "./snapshot.js";

/** Atomic, durable JSON write. Mode 600 like every other file this hub owns. */
export function writeJsonDurable(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // Flush the DIRECTORY so the rename itself is durable. Best effort: some
  // filesystems refuse to open a directory for reading, and failing the whole
  // publish because of that would be worse than the durability it buys.
  try {
    const dfd = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* not fatal: the data is already flushed and the rename is atomic */
  }
}

export const SNAPSHOT_FILE_DEFAULT = "market-cap-snapshot-v1.json";
export const OVERRIDES_FILE_DEFAULT = "asset-identity-overrides-v1.json";
export const LEDGER_FILE_DEFAULT = "market-cap-credits-v1.json";

export class MarketCapStore {
  constructor(
    readonly snapshotFile: string,
    readonly overridesFile: string,
    readonly ledgerFile: string,
  ) {}

  /** The last published snapshot, or null. A file that will not PARSE is
   *  reported to the caller as null and left on disk untouched: `readJson`
   *  throws on corruption by design ("a CORRUPT file is a real problem; do not
   *  silently reset state"), and this producer's answer to that is to keep
   *  serving nothing rather than to overwrite the evidence. */
  readSnapshot(): SnapshotSigned | null {
    try {
      const v = readJson<SnapshotSigned | null>(this.snapshotFile, null);
      return v && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  }

  writeSnapshot(snapshot: SnapshotSigned): void {
    writeJsonDurable(this.snapshotFile, snapshot);
  }

  readLedger(now: number): CreditLedger {
    try {
      const raw = readJson<Partial<CreditLedger> | null>(this.ledgerFile, null);
      if (!raw || typeof raw !== "object" || typeof raw.month !== "string") return emptyLedger(now);
      const byKind: Record<string, number> = Object.create(null);
      for (const [k, v] of Object.entries(raw.byKind ?? {})) {
        if (typeof v === "number" && Number.isFinite(v) && !UNSAFE.has(k)) byKind[k] = v;
      }
      return {
        month: raw.month,
        used: Number.isFinite(raw.used) ? Number(raw.used) : 0,
        byKind,
        updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : now,
        refusals: Number.isFinite(raw.refusals) ? Number(raw.refusals) : 0,
        lastRefusal: typeof raw.lastRefusal === "string" ? raw.lastRefusal : null,
      };
    } catch {
      // A ledger we cannot read is a ledger that cannot be trusted to say how
      // much has been spent — and the conservative direction is to assume the
      // month is FRESH only because the alternative (assume exhausted) would
      // stop a healthy install permanently on one bad byte. The refusal count
      // and the month roll make this self-correcting within the hour.
      return emptyLedger(now);
    }
  }

  writeLedger(ledger: CreditLedger): void {
    writeJsonDurable(this.ledgerFile, ledger);
  }

  /** Operator identity decisions. Prototype-hostile keys are refused rather
   *  than sanitised — flags.ts's v0.2.12 finding, and this map is looked up by
   *  a string built from a VENUE-SUPPLIED symbol. */
  readOverrides(): OverrideMap {
    const out: OverrideMap = Object.create(null) as OverrideMap;
    let raw: unknown;
    try {
      raw = readJson<unknown>(this.overridesFile, null);
    } catch {
      return out;
    }
    const rows = (raw as { overrides?: unknown })?.overrides ?? raw;
    if (!rows || typeof rows !== "object" || Array.isArray(rows)) return out;
    for (const [k, v] of Object.entries(rows as Record<string, unknown>)) {
      if (UNSAFE.has(k) || !v || typeof v !== "object" || Array.isArray(v)) continue;
      const o = v as Record<string, unknown>;
      const entry: IdentityOverride = {};
      if (typeof o.cryptoId === "number" && Number.isInteger(o.cryptoId) && o.cryptoId > 0) entry.cryptoId = o.cryptoId;
      if (o.notApplicable === true) entry.notApplicable = true;
      if (typeof o.note === "string") entry.note = o.note.slice(0, 500);
      out[k] = entry;
    }
    return out;
  }
}

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
