// src/checkins.ts
// Tester check-in recording. Two artifacts, deliberately redundant:
//   data/checkins.jsonl — append-only ledger, every check-in ever, one line each
//   data/roster.json    — compact latest-state per license, what the admin list reads
// The ledger is the truth; the roster is a cache that could be rebuilt from it.
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
  const roster = readJson<Record<string, RosterEntry>>(rosterFile, {});
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
