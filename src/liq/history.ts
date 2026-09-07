// src/liq/history.ts
// The rolling liquidation-print archive. Every wired venue's liquidation
// stream is WS-only — there is no public "give me history" endpoint on any
// of them — so anything not recorded the instant it prints is gone forever.
// One JSONL file per UTC day, mirroring the bot's own `LiqHistoryRecorder`
// (`src/server/liq-history.ts` in the liqhunter repo) field for field, so a
// day file downloaded from here reads identically to one an install wrote
// itself and the percentile builder in `percentiles.ts` is the same function
// either way.
import { readdirSync, readFileSync, rmSync, existsSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { appendJsonl } from "../jsonfile.js";
import type { LiqSourceId } from "./sources.js";

export interface LiqHistoryEvent {
  ts: number;
  src: LiqSourceId;
  symbol: string;   // venue-native spelling
  side: "long" | "short";
  price: number;
  sizeUsd: number;
}

const DAY_MS = 86_400_000;
const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export const LIQ_HISTORY_RETENTION_DAYS_DEFAULT = 60;
/** Cascades print in bursts — flush at this many buffered rows even between
 *  the periodic timer flushes, so a burst cannot grow the in-memory buffer
 *  without bound between two 2s ticks. */
const FLUSH_AT_ROWS = 500;

export class LiqHistory {
  private buf: LiqHistoryEvent[] = [];

  constructor(
    private readonly dir: string,
    private readonly retentionDays = LIQ_HISTORY_RETENTION_DAYS_DEFAULT,
  ) {}

  /** Buffered append — the periodic flush (or a burst past FLUSH_AT_ROWS)
   *  moves these to disk. Never throws: recording must never take a stream
   *  down with it. */
  record(e: LiqHistoryEvent): void {
    this.buf.push(e);
    const day = dayOf(e.ts);
    if (day !== this.todayKey) { this.todayKey = day; this.todayCount = 0; }
    this.todayCount++;
    if (this.buf.length >= FLUSH_AT_ROWS) this.flush();
  }

  private todayKey = "";
  private todayCount = 0;
  /** v0.4.20 — prints recorded today BY THIS PROCESS, counted as they arrive.
   *  `days()` answers the same question by reading every day file in full,
   *  which the status card was doing on every request. */
  recordedToday(now = Date.now()): number { return dayOf(now) === this.todayKey ? this.todayCount : 0; }

  /** v0.4.20 — THE CHEAP LISTING: day and byte size from `stat`, never a
   *  read. `days()` reads every file in full to count lines — an admin card
   *  may ask that on demand; the table builder must not, and did: on a box
   *  with 60 days of every print from every source that was gigabytes of
   *  JSON on the event loop at boot (the bot shipped the same shape in
   *  v0.90.44 and stalled the operator's install). */
  dayFiles(): Array<{ day: string; bytes: number }> {
    let files: string[] = [];
    try { files = readdirSync(this.dir); } catch { return []; }
    const out: Array<{ day: string; bytes: number }> = [];
    for (const f of files) {
      const m = DAY_RE.exec(f);
      if (!m) continue;
      try { out.push({ day: m[1], bytes: statSync(path.join(this.dir, f)).size }); } catch { /* skip unreadable */ }
    }
    return out.sort((a, b) => (a.day < b.day ? 1 : -1));
  }

  /** v0.4.20 — one day's events as a stream, a line at a time, so a large
   *  day is never one string, one split and a million objects at once, and
   *  the event loop breathes between chunks. Malformed lines skip. */
  async *readLines(day: string): AsyncGenerator<LiqHistoryEvent> {
    const p = path.join(this.dir, `${day}.jsonl`);
    if (!existsSync(p)) return;
    const rl = createInterface({ input: createReadStream(p, { encoding: "utf8" }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let e: LiqHistoryEvent | null = null;
        try { e = JSON.parse(line); } catch { continue; }
        if (e) yield e;
      }
    } finally { rl.close(); }
  }

  /** Write every buffered row, grouped by UTC day, through the shared
   *  tmp-then-rename-free append helper (`appendJsonl` — an append-only
   *  ledger tolerates a torn final line after a crash; prior lines are
   *  safe). Never throws out. */
  flush(): void {
    if (!this.buf.length) return;
    const rows = this.buf;
    this.buf = [];
    for (const e of rows) {
      try { appendJsonl(path.join(this.dir, `${dayOf(e.ts)}.jsonl`), e); }
      catch { /* recording never breaks the stream it is fed from */ }
    }
  }

  /** Delete day files older than the retention window. Returns count removed.
   *  Never touches a file that does not match the day-file name pattern. */
  prune(now = Date.now()): number {
    const cutoff = now - this.retentionDays * DAY_MS;
    let removed = 0;
    let files: string[] = [];
    try { files = readdirSync(this.dir); } catch { return 0; }
    for (const f of files) {
      const m = DAY_RE.exec(f);
      if (!m) continue;
      const ts = Date.parse(`${m[1]}T00:00:00Z`);
      if (Number.isFinite(ts) && ts < cutoff) {
        try { rmSync(path.join(this.dir, f), { force: true }); removed++; } catch { /* best effort */ }
      }
    }
    return removed;
  }

  /** Day files NEWEST-FIRST with event counts — what the table builder walks
   *  and what an admin/status surface would list. */
  days(): Array<{ day: string; events: number; bytes: number }> {
    let files: string[] = [];
    try { files = readdirSync(this.dir); } catch { return []; }
    const out: Array<{ day: string; events: number; bytes: number }> = [];
    for (const f of files) {
      const m = DAY_RE.exec(f);
      if (!m) continue;
      try {
        const raw = readFileSync(path.join(this.dir, f), "utf8");
        const events = raw.length ? raw.trim().split("\n").filter(Boolean).length : 0;
        out.push({ day: m[1], events, bytes: raw.length });
      } catch { /* skip unreadable */ }
    }
    return out.sort((a, b) => (a.day < b.day ? 1 : -1));
  }

  /** Parsed events for one day. Malformed lines are skipped rather than
   *  failing the whole read — a torn final line after a crash must not lose
   *  every line before it. */
  read(day: string): LiqHistoryEvent[] {
    const p = path.join(this.dir, `${day}.jsonl`);
    if (!existsSync(p)) return [];
    const out: LiqHistoryEvent[] = [];
    try {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as LiqHistoryEvent); } catch { /* skip malformed */ }
      }
    } catch { return []; }
    return out;
  }
}
