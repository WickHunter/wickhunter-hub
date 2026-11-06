// src/candles/timeframe-seed-worker.ts
// v0.4.103 — long-window (> 60 days) signed timeframe seeds, built off the
// event loop.
//
// A 365-day hourly window is ~8,760 rows read from a dozen month files, folded
// into rows/gaps/segments and serialised to ~0.5 MB of canonical JSON. Done in
// the HTTP handler that is ~100 ms of blocked event loop per request, and an
// Alpha fleet booting asks for thousands. This worker does the READ-ONLY part:
// it opens the store, applies exactly the provenance rule request() applies
// (timeframeRowSafe, with the frontier/floor values passed in), assembles the
// payload with the same assembleTimeframe() and returns the canonical bytes.
// It holds NO key: the main thread signs, as it does for snapshots.
//
// Unlike the snapshot fold this worker is long-lived (a small pool in
// service.ts): one request is milliseconds of work, so starting a thread per
// request would cost more than the build.
import { parentPort, workerData } from "node:worker_threads";
import { buildTimeframeLong, type TimeframeLongJob, type TimeframeLongReply } from "./timeframe.js";

export type { TimeframeLongJob, TimeframeLongReply };

/** Exported for tests and the benchmark: the whole job, synchronously. */
export function buildTimeframeJob(job: TimeframeLongJob): TimeframeLongReply {
  return buildTimeframeLong(job);
}

export interface TimeframePoolMessage { id: number; job: TimeframeLongJob }
export interface TimeframePoolReply { id: number; reply: TimeframeLongReply }

if (parentPort && (workerData as { timeframeSeedPool?: boolean } | null)?.timeframeSeedPool) {
  const port = parentPort;
  port.on("message", (msg: TimeframePoolMessage) => {
    let reply: TimeframeLongReply;
    try { reply = buildTimeframeJob(msg.job); }
    catch (err) { reply = { ok: false, code: 500, error: (err as Error)?.message ?? String(err) }; }
    port.postMessage({ id: msg.id, reply } satisfies TimeframePoolReply,
      reply.ok ? [reply.canonical.buffer as ArrayBuffer] : []);
  });
}
