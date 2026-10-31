// src/candles/timeframe-seed-pool.ts
// v0.4.103 — a small bounded pool of long-lived timeframe seed workers.
//
// Bounded twice: at most `size` builds run at once, and at most `maxQueue`
// wait. Anything beyond is refused at once with TimeframePoolBusyError, which
// the route answers 503 "busy; retry shortly" — the shape the app already
// treats as retry with back-off. A build that has not answered within
// `timeoutMs` has its worker terminated (and replaced on the next job) and is
// answered 503, never partially.
import { Worker } from "node:worker_threads";
import type { TimeframeLongJob, TimeframeLongReply } from "./timeframe.js";
import type { TimeframePoolMessage, TimeframePoolReply } from "./timeframe-seed-worker.js";

export const TIMEFRAME_POOL_SIZE = 2;
export const TIMEFRAME_POOL_MAX_QUEUE = 32;
export const TIMEFRAME_POOL_TIMEOUT_MS = 60_000;

export class TimeframePoolBusyError extends Error {
  readonly busy = true;
  constructor() { super("timeframe history build is busy; retry shortly"); this.name = "TimeframePoolBusyError"; }
}

interface Pending { id: number; job: TimeframeLongJob; resolve: (r: TimeframeLongReply) => void; reject: (e: Error) => void }
interface Slot { worker: Worker | null; running: (Pending & { timer: NodeJS.Timeout }) | null }

export class TimeframeSeedPool {
  private readonly slots: Slot[];
  private readonly queue: Pending[] = [];
  private nextId = 1;
  private closed = false;
  completed = 0;
  failed = 0;
  refusedBusy = 0;

  constructor(private readonly size = TIMEFRAME_POOL_SIZE, private readonly maxQueue = TIMEFRAME_POOL_MAX_QUEUE,
    private readonly timeoutMs = TIMEFRAME_POOL_TIMEOUT_MS) {
    this.slots = Array.from({ length: Math.max(1, size) }, () => ({ worker: null, running: null }));
  }

  status(): { size: number; running: number; queued: number; maxQueue: number; completed: number; failed: number; refusedBusy: number } {
    return {
      size: this.slots.length, running: this.slots.filter((s) => s.running).length, queued: this.queue.length,
      maxQueue: this.maxQueue, completed: this.completed, failed: this.failed, refusedBusy: this.refusedBusy,
    };
  }

  /** Would run() accept a job now? Checked BEFORE any main-thread work. */
  hasCapacity(): boolean {
    return !this.closed && (this.slots.some((s) => !s.running) || this.queue.length < this.maxQueue);
  }

  run(job: TimeframeLongJob): Promise<TimeframeLongReply> {
    if (this.closed) return Promise.reject(new Error("timeframe seed pool is closed"));
    const idle = this.slots.some((s) => !s.running);
    if (!idle && this.queue.length >= this.maxQueue) {
      this.refusedBusy++;
      return Promise.reject(new TimeframePoolBusyError());
    }
    return new Promise<TimeframeLongReply>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, job, resolve, reject });
      this.dispatch();
    });
  }

  private spawn(slot: Slot): Worker {
    const worker = new Worker(new URL("./timeframe-seed-worker.js", import.meta.url), {
      workerData: { timeframeSeedPool: true },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    worker.unref();
    worker.on("message", (m: TimeframePoolReply) => {
      const run = slot.running;
      if (!run || run.id !== m.id) return;
      clearTimeout(run.timer);
      slot.running = null;
      this.completed++;
      run.resolve(m.reply);
      this.dispatch();
    });
    const lost = (err: Error): void => {
      if (slot.worker !== worker) return;
      slot.worker = null;
      const run = slot.running;
      slot.running = null;
      if (run) { clearTimeout(run.timer); this.failed++; run.reject(err); }
      this.dispatch();
    };
    worker.on("error", (err) => lost(err));
    worker.on("exit", (code) => lost(new Error(`timeframe seed worker exited (${code})`)));
    return worker;
  }

  private dispatch(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.running || !this.queue.length) continue;
      const next = this.queue.shift()!;
      const worker = slot.worker ?? (slot.worker = this.spawn(slot));
      const timer = setTimeout(() => {
        if (slot.running?.id !== next.id) return;
        slot.running = null;
        slot.worker = null;
        this.failed++;
        void worker.terminate().catch(() => undefined);
        next.reject(new Error(`timeframe seed build exceeded ${this.timeoutMs}ms`));
        this.dispatch();
      }, this.timeoutMs);
      timer.unref?.();
      slot.running = { ...next, timer };
      worker.postMessage({ id: next.id, job: next.job } satisfies TimeframePoolMessage);
    }
  }

  close(): void {
    this.closed = true;
    for (const slot of this.slots) {
      if (slot.running) { clearTimeout(slot.running.timer); slot.running.reject(new Error("timeframe seed pool closed")); slot.running = null; }
      const w = slot.worker;
      slot.worker = null;
      if (w) void w.terminate().catch(() => undefined);
    }
    for (const p of this.queue.splice(0)) p.reject(new Error("timeframe seed pool closed"));
  }
}
