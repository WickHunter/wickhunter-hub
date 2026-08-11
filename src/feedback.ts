// src/feedback.ts
// Tester bug reports / feature requests. One artifact:
//   data/feedback.jsonl — append-only, one report per line, status edited in
//   place by rewrite (reports are few; a rewrite is simpler than a side index).
//
// The operator's loop: testers file from the beta UI → the bot forwards here
// with its license token → the admin page lists them → EXPORT hands the whole
// set (logs included) to the operator's assistant for triage. So the record
// keeps everything the diagnosis needs: version, install, logs, timestamps.
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { appendJsonl } from "./jsonfile.js";

export type FeedbackKind = "bug" | "feature";
export type FeedbackStatus = "new" | "discussing" | "fixed";

export interface FeedbackRecord {
  id: string;
  at: number; // OUR clock, unix-ms
  ts: number; // client's claimed clock, recorded not trusted
  ip: string;
  licenseId: string;
  name: string; // tester name from the VERIFIED token payload, never the body
  installId: string;
  version: string;
  kind: FeedbackKind;
  text: string;
  logs: string[];
  logsTruncated: boolean;
  status: FeedbackStatus;
}

// Caps, enforced server-side regardless of what the bot claims to cap:
export const FEEDBACK_TEXT_MAX = 8_000;
export const FEEDBACK_LOG_LINES_MAX = 300;
export const FEEDBACK_LOG_LINE_MAX = 2_000;
export const FEEDBACK_LOGS_BYTES_MAX = 200 * 1024;

const FILE = "feedback.jsonl";

export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = ["new", "discussing", "fixed"];

/** Clamp an incoming logs array to the caps. Newest lines win (drop oldest). */
export function clampLogs(raw: unknown): { logs: string[]; truncated: boolean } {
  if (!Array.isArray(raw)) return { logs: [], truncated: false };
  const strings = raw.filter((l): l is string => typeof l === "string");
  let truncated = strings.length !== raw.length;
  let lines = strings.map((l) => (l.length > FEEDBACK_LOG_LINE_MAX ? (truncated = true, l.slice(0, FEEDBACK_LOG_LINE_MAX)) : l));
  if (lines.length > FEEDBACK_LOG_LINES_MAX) {
    lines = lines.slice(lines.length - FEEDBACK_LOG_LINES_MAX);
    truncated = true;
  }
  // Byte cap: drop OLDEST lines until the serialized payload fits.
  let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
  while (lines.length > 0 && bytes > FEEDBACK_LOGS_BYTES_MAX) {
    bytes -= Buffer.byteLength(lines[0]!, "utf8") + 1;
    lines.shift();
    truncated = true;
  }
  return { logs: lines, truncated };
}

export function appendFeedback(
  dataDir: string,
  input: Omit<FeedbackRecord, "id" | "at" | "status">,
  now = Date.now(),
): FeedbackRecord {
  const rec: FeedbackRecord = { ...input, id: randomUUID(), at: now, status: "new" };
  appendJsonl(path.join(dataDir, FILE), rec);
  return rec;
}

/** Read every report, tolerant of a torn/garbage line (skipped, never fatal). */
export function listFeedback(dataDir: string): FeedbackRecord[] {
  const file = path.join(dataDir, FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: FeedbackRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as FeedbackRecord;
      if (typeof rec.id === "string" && typeof rec.kind === "string" && typeof rec.text === "string") out.push(rec);
    } catch {
      /* torn tail line — skip */
    }
  }
  return out;
}

/** Rewrite the whole file from a record set. Atomic (tmp + rename) so a crash
 *  mid-write leaves the previous file intact rather than a truncated one. An
 *  EMPTY set writes an empty file rather than deleting it — a missing file and
 *  a file with nothing in it read the same to `listFeedback`, and leaving the
 *  file in place keeps the directory listing honest about what this hub does. */
function rewrite(dataDir: string, all: FeedbackRecord[]): void {
  const file = path.join(dataDir, FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, all.length ? all.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");
  fs.renameSync(tmp, file);
}

/** Move a report between new/discussing/fixed. False = unknown id. */
export function setFeedbackStatus(dataDir: string, id: string, status: FeedbackStatus): boolean {
  if (!FEEDBACK_STATUSES.includes(status)) return false;
  const all = listFeedback(dataDir);
  const hit = all.find((r) => r.id === id);
  if (!hit) return false;
  hit.status = status;
  rewrite(dataDir, all);
  return true;
}

/** Delete reports outright. Returns how many were actually removed, which is
 *  how the caller distinguishes "deleted" from "already gone" — an id that
 *  matched nothing must not report success, or the admin page will show a row
 *  vanishing that is still on disk under a different id.
 *
 *  This is a REAL delete, not a status. The operator asked for it to stay
 *  organised, and a fourth status would leave the row in the export forever;
 *  the export is the artifact handed over for triage, so a deleted report has
 *  to leave that too. Deletion is therefore irreversible by design — the admin
 *  page confirms before calling, and the export is the backup. */
export function deleteFeedback(dataDir: string, ids: readonly string[]): number {
  const kill = new Set(ids.filter((i) => typeof i === "string" && i));
  if (kill.size === 0) return 0;
  const all = listFeedback(dataDir);
  const keep = all.filter((r) => !kill.has(r.id));
  const removed = all.length - keep.length;
  if (removed > 0) rewrite(dataDir, keep);
  return removed;
}
