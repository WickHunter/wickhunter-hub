// src/liq/service.ts
// The one process-wide liquidation service: records every print from every
// wired source (`stream-runner.ts`) into the durable archive (`history.ts`),
// and periodically rebuilds the pair-percentile table (`percentiles.ts`) that
// `GET /api/hub/liq-percentiles` serves. Mirrors `CandleService`'s shape —
// one collector-ish object `createHub` constructs, starts at `listen()` and
// stops at `close()`.
import path from "node:path";
import { readJson, writeJsonAtomic } from "../jsonfile.js";
import { LiqHistory, LIQ_HISTORY_RETENTION_DAYS_DEFAULT } from "./history.js";
import {
  rebuildLiqPercentileTable, liqPercentileTableLooksValid, countLiqPercentilePairSides,
  LIQ_PCTL_WINDOW_DAYS, LIQ_PCTL_MAX_PRINTS,
  type LiqSizePercentileTable,
} from "./percentiles.js";
import {
  LiqStreamRunner, DEFAULT_LIQ_STREAM_CONFIG,
  type LiqStreamConfig, type LiqFetchLike, type LiqSourceStatus,
} from "./stream-runner.js";
export type { LiqFetchLike, LiqSourceStatus } from "./stream-runner.js";
import type { SocketFactory } from "../net/socket-pool.js";
import { isLiqSourceId, type LiqSourceId } from "./sources.js";

export interface LiqServiceConfig {
  dataDir: string;
  /** EMPTY MEANS NONE — see `stream-runner.ts`'s `LiqStreamConfig.sources`.
   *  "Unset env means every source" is resolved once, in `config.ts`. */
  sources: readonly LiqSourceId[];
  retentionDays: number;
  windowDays: number;
  maxPrints: number;
  /** How often the buffered archive is flushed to disk. */
  flushMs: number;
  /** How often day files older than `retentionDays` are pruned. */
  pruneMs: number;
  /** How often the percentile table is rebuilt from the archive (and once at
   *  boot, immediately — a fresh install must not wait an hour to see its
   *  first table). */
  rebuildMs: number;
  bybitLinearUrl: string;
  bybitInverseUrl: string;
  bybitRestBase: string;
  binanceUsdtWsUrl: string;
  binanceCoinWsUrl: string;
  binanceDapiBase: string;
  okxWsUrl: string;
  okxRestBase: string;
  rosterRefreshMs: number;
}

export const DEFAULT_LIQ_SERVICE_CONFIG: LiqServiceConfig = {
  ...DEFAULT_LIQ_STREAM_CONFIG,
  dataDir: "",
  retentionDays: LIQ_HISTORY_RETENTION_DAYS_DEFAULT,
  windowDays: LIQ_PCTL_WINDOW_DAYS,
  maxPrints: LIQ_PCTL_MAX_PRINTS,
  flushMs: 2_000,
  pruneMs: 3_600_000,
  rebuildMs: 3_600_000,
};

export interface LiqServiceDeps {
  fetchLike?: LiqFetchLike;
  socket?: SocketFactory;
  log?: (msg: string) => void;
  now?: () => number;
  reconnectMs?: number;
  reconnectMaxMs?: number;
}

const SNAPSHOT_FORMAT = 1;
interface LiqTableSnapshot { format: number; table: LiqSizePercentileTable; builtAtMs: number; }

export class LiqService {
  readonly history: LiqHistory;
  private readonly stream: LiqStreamRunner;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private table: LiqSizePercentileTable | null = null;
  private lastRebuildAt: number | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private rebuildTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cfg: LiqServiceConfig, deps: LiqServiceDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.history = new LiqHistory(path.join(cfg.dataDir, "liq-history"), cfg.retentionDays);
    const streamCfg: LiqStreamConfig = {
      sources: cfg.sources.filter(isLiqSourceId),
      bybitLinearUrl: cfg.bybitLinearUrl, bybitInverseUrl: cfg.bybitInverseUrl, bybitRestBase: cfg.bybitRestBase,
      binanceUsdtWsUrl: cfg.binanceUsdtWsUrl, binanceCoinWsUrl: cfg.binanceCoinWsUrl, binanceDapiBase: cfg.binanceDapiBase,
      okxWsUrl: cfg.okxWsUrl, okxRestBase: cfg.okxRestBase, rosterRefreshMs: cfg.rosterRefreshMs,
    };
    this.stream = new LiqStreamRunner(streamCfg, {
      emit: (e) => this.history.record({ ts: e.ts, src: e.source, symbol: e.nativeSymbol, side: e.side, price: e.price, sizeUsd: e.sizeUsd }),
      fetchLike: deps.fetchLike, socket: deps.socket, log: deps.log,
      reconnectMs: deps.reconnectMs, reconnectMaxMs: deps.reconnectMaxMs,
    });
    this.loadSnapshot();
  }

  private snapshotPath(): string { return path.join(this.cfg.dataDir, "liq-percentiles.json"); }

  /** Restore the last-built table across a restart — a cold boot must not be
   *  a cold start for every client asking within the first hour. A file that
   *  will not parse, or does not verify shape, is dropped silently: nothing
   *  here trusts disk, it re-derives from `history/` on the next rebuild. */
  private loadSnapshot(): void {
    try {
      const raw = readJson<LiqTableSnapshot | null>(this.snapshotPath(), null);
      if (raw && raw.format === SNAPSHOT_FORMAT && liqPercentileTableLooksValid(raw.table)) {
        this.table = raw.table;
        this.lastRebuildAt = typeof raw.builtAtMs === "number" ? raw.builtAtMs : raw.table.generatedAtMs;
      }
    } catch { /* corrupt or foreign file — rebuilt from the archive regardless */ }
  }

  private saveSnapshot(): void {
    if (!this.table) return;
    try {
      const builtAtMs = this.lastRebuildAt ?? this.table.generatedAtMs;
      writeJsonAtomic(this.snapshotPath(), { format: SNAPSHOT_FORMAT, table: this.table, builtAtMs } satisfies LiqTableSnapshot);
    } catch (e) { this.log(`[liq] could not persist the percentile snapshot: ${(e as Error).message}`); }
  }

  private rebuild(): void {
    try {
      this.table = rebuildLiqPercentileTable(this.history, { days: this.cfg.windowDays, maxPrints: this.cfg.maxPrints, now: this.now() });
      this.lastRebuildAt = this.now();
      this.saveSnapshot();
      this.log(`[liq] percentile table rebuilt: ${countLiqPercentilePairSides(this.table)} pair-side(s)`);
    } catch (e) {
      // A rebuild running on a timer must never take the process down with it.
      this.log(`[liq] percentile rebuild failed: ${(e as Error).message}`);
    }
  }

  start(): void {
    this.stream.start();
    this.rebuild(); // immediate at boot — a fresh install sees a table within its first minute, not its first hour
    this.flushTimer = setInterval(() => this.history.flush(), Math.max(500, this.cfg.flushMs));
    this.flushTimer.unref?.();
    this.pruneTimer = setInterval(() => { try { this.history.prune(this.now()); } catch { /* best effort */ } }, Math.max(60_000, this.cfg.pruneMs));
    this.pruneTimer.unref?.();
    this.rebuildTimer = setInterval(() => this.rebuild(), Math.max(60_000, this.cfg.rebuildMs));
    this.rebuildTimer.unref?.();
  }

  stop(): void {
    this.stream.stop();
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    if (this.rebuildTimer) { clearInterval(this.rebuildTimer); this.rebuildTimer = null; }
    this.history.flush();
  }

  /** `table: null` is a real, servable answer — "nothing has been built yet"
   *  is not the same claim as "the table is empty", and a caller checking
   *  `ok` first (as every hub route does) tells the two apart. */
  getTable(): LiqSizePercentileTable | null { return this.table; }

  /** Force an immediate rebuild — the admin surface's "rebuild now" and the
   *  test suite's way to drive one deterministically without waiting out
   *  `rebuildMs`. Same function the boot rebuild and the timer call. */
  rebuildNow(): void { this.rebuild(); }

  status(): {
    sources: LiqSourceStatus[];
    eventsToday: number;
    pairSides: number;
    lastRebuildAtMs: number | null;
  } {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const day = this.history.days().find((d) => d.day === today);
    return {
      sources: this.stream.status(),
      eventsToday: day?.events ?? 0,
      pairSides: countLiqPercentilePairSides(this.table),
      lastRebuildAtMs: this.lastRebuildAt,
    };
  }
}
