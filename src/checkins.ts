// src/checkins.ts
// Tester check-in recording. Two artifacts, deliberately redundant:
//   data/checkins.jsonl — append-only ledger, every check-in ever, one line each
//   data/roster.json    — compact latest-state per license, what the admin list reads
// The ledger is the truth; the roster is a cache that could be rebuilt from it.
import fs from "node:fs";
import path from "node:path";
import { appendJsonl, readJson, writeJsonAtomic } from "./jsonfile.js";

export interface CheckinInput {
  licenseId: string;
  installId: string;
  version: string;
  ts: number; // client clock, unix-ms — recorded as claimed, not trusted
}

export interface RosterEntry {
  installId: string;
  version: string;
  ip: string;
  ts: number; // client's claimed clock at last check-in
  lastSeen: number; // OUR clock (unix-ms) — the one to trust for staleness
  checkins: number;
}

const CHECKINS_FILE = "checkins.jsonl";
const ROSTER_FILE = "roster.json";

export function recordCheckin(dataDir: string, c: CheckinInput, ip: string, now = Date.now()): void {
  appendJsonl(path.join(dataDir, CHECKINS_FILE), { ...c, ip, at: now });
  const rosterFile = path.join(dataDir, ROSTER_FILE);
  // ── v0.2.12 — THE SAME ROOT CAUSE AS THE FLAGS ROUTE, ON AN UNAUTHENTICATED
  // PATH. `licenseId` here comes straight off the wire from any caller. Writing
  // `roster["__proto__"] = {...}` on a plain object does not create an entry —
  // it SETS THAT OBJECT'S PROTOTYPE — so the row silently vanishes from the
  // roster (and from `sharingSignals`, which is the one thing that catches a
  // shared key). A `Map`-like bare object has no prototype to reassign, so the
  // id becomes an ordinary key and the row is recorded like any other.
  //
  // The LEDGER above is unaffected either way — it is append-only JSONL and the
  // id is just a string in it. That is why the ledger, not the roster, is the
  // truth (see the note below).
  const roster: Record<string, RosterEntry> = Object.assign(
    Object.create(null) as Record<string, RosterEntry>,
    readJson<Record<string, RosterEntry>>(rosterFile, {}),
  );
  const prev = roster[c.licenseId];
  roster[c.licenseId] = {
    installId: c.installId,
    version: c.version,
    ip,
    ts: c.ts,
    lastSeen: now,
    checkins: (prev?.checkins ?? 0) + 1,
  };
  writeJsonAtomic(rosterFile, roster);
}

export function readRoster(dataDir: string): Record<string, RosterEntry> {
  return readJson<Record<string, RosterEntry>>(path.join(dataDir, ROSTER_FILE), {});
}

// ── IS ONE KEY BEING RUN ON MORE THAN ONE MACHINE? ──────────────────────────
//
// Nothing binds a licence to a machine: the token carries no install or seat,
// every gate asks only "is this token valid", and `installId` is a random UUID
// the bot writes under data/. So a shared key installs everywhere at once, and
// the roster — one last-write-wins row per licence — hides it, because the two
// installs simply overwrite each other and Last-seen keeps looking healthy.
//
// The ledger already holds the answer. Every check-in ever is appended with its
// `licenseId`, `installId` and IP, so this is a read over data already
// collected: nothing new is asked of the client, and a sharer cannot opt out of
// it the way they could refuse a new field.
//
// CONCURRENT, NOT CUMULATIVE — this is the whole design, and getting it wrong
// would make the signal useless. A tester who reinstalls, moves VPS or loses
// data/ legitimately mints a NEW installId, so "more than one id ever" is true
// of half an honest roster and means nothing. What a reinstall does NOT do is
// keep the old install phoning home: it goes quiet immediately. So the question
// asked here is "how many DISTINCT installs checked in inside the same recent
// window", where the window is wide enough for a daily check-in to land twice
// and narrow enough that a replaced install has dropped out of it.
//
// This REPORTS; it does not enforce. Locking a licence to its first install
// would kill a legitimate reinstall with no way back, so that needs a rebind
// control before it could be safe — see the admin page.
const SHARING_WINDOW_MS = 48 * 3_600_000;
/** Cap the tail read so a long-lived ledger cannot turn the admin list into an
 *  unbounded file read. At one line per tester per day this is years of them. */
const SHARING_TAIL_BYTES = 4 * 1024 * 1024;

export interface SharingSignal {
  /** Distinct installs seen inside the window. >1 is the flag. */
  installs: number;
  /** Distinct client IPs in the same window. Informational only — a dynamic
   *  address or a VPS reboot moves an IP without any sharing. */
  ips: number;
  windowHours: number;
}

export function sharingSignals(
  dataDir: string,
  now = Date.now(),
  windowMs = SHARING_WINDOW_MS,
): Record<string, SharingSignal> {
  const file = path.join(dataDir, CHECKINS_FILE);
  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - SHARING_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
      // A tail can begin mid-line; drop the partial first record rather than
      // letting JSON.parse decide what it was.
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally { fs.closeSync(fd); }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  const since = now - windowMs;
  const byLicense = new Map<string, { installs: Set<string>; ips: Set<string> }>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: { licenseId?: unknown; installId?: unknown; ip?: unknown; at?: unknown };
    // A crash can leave a torn final line; a bad row is skipped, never fatal —
    // this is a diagnostic, and it must not be able to break the admin list.
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row.licenseId !== "string" || typeof row.installId !== "string") continue;
    // `at` is OUR clock, stamped on receipt — deliberately not the client's
    // `ts`, which is self-reported and could be set to anything.
    if (typeof row.at !== "number" || row.at < since) continue;
    let e = byLicense.get(row.licenseId);
    if (!e) { e = { installs: new Set(), ips: new Set() }; byLicense.set(row.licenseId, e); }
    e.installs.add(row.installId);
    if (typeof row.ip === "string" && row.ip) e.ips.add(row.ip);
  }

  const out: Record<string, SharingSignal> = {};
  const windowHours = Math.round(windowMs / 3_600_000);
  for (const [id, e] of byLicense) {
    out[id] = { installs: e.installs.size, ips: e.ips.size, windowHours };
  }
  return out;
}
