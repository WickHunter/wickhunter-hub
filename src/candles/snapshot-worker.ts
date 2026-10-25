// src/candles/snapshot-worker.ts
// v0.4.99 — the snapshot FOLD, off the event loop.
//
// A 30-day daily snapshot of an 800-pair venue reads ~24,000 day files. Done
// synchronously in the HTTP process it blocked every request on the Hub for
// up to two minutes (nginx's 75 s upstream timeout fired on unrelated routes
// during every such build). This worker does only the read + fold + canonical
// serialisation. It holds NO key material: the main thread signs the canonical
// bytes it returns, so a signing key never crosses a thread boundary.
//
// One worker per build, exiting when done, so the fold's buffers are released
// with the thread instead of growing the Hub's own heap.
import { parentPort, workerData } from "node:worker_threads";
import { CandleStore } from "./store.js";
import { canonicalSnapshotBytes, foldSnapshot } from "./snapshot.js";
import type { VenueId } from "./venues.js";

export interface SnapshotWorkerJob {
  rootDir: string;
  venue: VenueId;
  interval: number;
  depth: number;
  now: number;
  keyId: string;
  symbols: string[];
}

export type SnapshotWorkerReply =
  | {
    ok: true;
    canonical: Uint8Array;
    lastClosedMs: number;
    symbolCount: number;
    skipped: Array<[string, "gap" | "short"]>;
    fingerprints: Record<string, string>;
  }
  | { ok: false; code: 400 | 503; error: string }
  | { ok: false; code: 500; error: string };

function run(job: SnapshotWorkerJob): { reply: SnapshotWorkerReply; transfer: ArrayBuffer[] } {
  const store = new CandleStore(job.rootDir);
  const folded = foldSnapshot(
    { venue: job.venue, interval: job.interval, depth: job.depth, now: job.now },
    { store, keyId: job.keyId, symbols: () => job.symbols, fast: true, fingerprints: true },
  );
  if (!folded.ok) return { reply: folded, transfer: [] };
  const bytes = canonicalSnapshotBytes(folded.payload);
  // Copy into a standalone ArrayBuffer so it can be TRANSFERRED (a Buffer from
  // the pool shares its ArrayBuffer with unrelated allocations).
  const canonical = new Uint8Array(bytes.length);
  canonical.set(bytes);
  return {
    reply: {
      ok: true,
      canonical,
      lastClosedMs: folded.payload.lastClosedMs,
      symbolCount: folded.payload.symbols.length,
      skipped: folded.payload.skipped,
      fingerprints: folded.fingerprints,
    },
    transfer: [canonical.buffer as ArrayBuffer],
  };
}

if (parentPort) {
  try {
    const { reply, transfer } = run(workerData as SnapshotWorkerJob);
    parentPort.postMessage(reply, transfer);
  } catch (err) {
    parentPort.postMessage({ ok: false, code: 500, error: (err as Error)?.message ?? String(err) } satisfies SnapshotWorkerReply);
  }
}
