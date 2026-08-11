// src/candles/service.ts
// Owns one collector per configured venue, drives their ticks on a timer, and
// answers the two questions the rest of the hub asks: "build me a signed seed
// for this venue+symbol" and "what is each exchange's status right now".
import path from "node:path";
import { CandleStore, DAY_MS, MINUTE_MS, newestClosedOpenMs } from "./store.js";
import {
  DEFAULT_COLLECTOR_OPTIONS, VenueCollector, type CollectorOptions, type VenueHealth,
} from "./collector.js";
import { ADAPTERS, VENUE_IDS, type FetchLike, type VenueId } from "./venues.js";
import { buildSeed, type SeedOutcome, type SeedRequest } from "./seed.js";

/** How stale a symbol's tail may be and still count as SEEDABLE. Generous
 *  against a single missed poll, tight enough that a genuinely stuck symbol
 *  does not sit in the healthy bucket. */
export const SEEDABLE_MAX_TAIL_AGE_MS = 15 * MINUTE_MS;
/** Below this much held history a symbol is still BACKFILLING, not seedable.
 *  24 hours: enough for the bot to compute something meaningful, far short of
 *  the 30-day window it will ask for — which is exactly why the seed states
 *  `gaps` rather than relying on this threshold to protect anyone. */
export const SEEDABLE_MIN_MINUTES = 1440;
/** "New" for the admin panel's newly-listed count. */
export const NEW_SYMBOL_WINDOW_MS = 24 * 3_600_000;

export interface SymbolStatus {
  symbol: string;
  bucket: "seedable" | "backfilling" | "gapped" | "empty";
  firstClosedMs: number | null;
  lastClosedMs: number | null;
  heldMinutes: number;
  missingMinutes: number;
  newlyListed: boolean;
  delisted: boolean;
  tradable: boolean;
}

export interface VenueStatus {
  venue: VenueId;
  /** False when no collector is configured for this venue at all. Everything
   *  below is then meaningless and the panel must say so instead of drawing
   *  zeroes that look like a working collector with an empty store. */
  configured: boolean;
  health: VenueHealth | null;
  klineEndpoint: string;
  counts: {
    tracked: number;
    seedable: number;
    backfilling: number;
    gapped: number;
    empty: number;
    delisted: number;
    newLast24h: number;
    newLast24hBackfilling: number;
  };
  /** Oldest and newest closed candle held anywhere in this venue's store. */
  oldestClosedMs: number | null;
  newestClosedMs: number | null;
  /** Total missing minutes inside held ranges, across every tracked symbol. */
  totalMissingMinutes: number;
  /** Symbols with the most missing minutes — a venue quietly accumulating gaps
   *  is the failure that poisons seeds without ever throwing an error. */
  worstGaps: Array<{ symbol: string; missingMinutes: number }>;
  /** Symbols first listed inside the last 24h that are not seedable yet. */
  newlyListed: Array<{ symbol: string; firstSeenAt: number; heldMinutes: number; bucket: SymbolStatus["bucket"] }>;
}

export interface CandleServiceConfig {
  dataDir: string;
  /** Which venues actually run a collector. Empty = the service is off. */
  venues: VenueId[];
  keyId: string;
  options: CollectorOptions;
  /** Tick period. One minute matches the candle cadence. */
  tickMs: number;
}

export interface CandleServiceDeps {
  sign(bytes: Buffer): Buffer;
  /** Injectable so tests never touch the network. */
  fetchLike?: FetchLike;
  /** Injectable clock, read ONCE at construction to stamp each collector's
   *  `startedAt`. Without it a caller reasoning about a frozen clock gets
   *  negative elapsed time and the never-succeeded collector never reaches
   *  FAILING. Defaults to `Date.now`, so production is unchanged. */
  now?: () => number;
}

const realFetch: FetchLike = async (url: string) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

export class CandleService {
  readonly store: CandleStore;
  private readonly collectors = new Map<VenueId, VenueCollector>();
  private readonly fetchLike: FetchLike;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastPruneAt = 0;

  constructor(private readonly cfg: CandleServiceConfig, private readonly deps: CandleServiceDeps) {
    this.store = new CandleStore(path.join(cfg.dataDir, "candles"));
    this.fetchLike = deps.fetchLike ?? realFetch;
    for (const v of cfg.venues) {
      // v0.2.1 — the collector's START TIME comes from the injected clock, not
      // from `Date.now()` inside its own constructor. `VenueCollector` has
      // always taken `now` as a parameter; the service simply never passed it,
      // so `startedAt` was real time while a caller reasoning about a frozen
      // clock saw its elapsed-time arithmetic go NEGATIVE — and a collector
      // that has never succeeded then reads "starting" forever instead of
      // FAILING, which is the one state transition the operator asked for.
      this.collectors.set(v, new VenueCollector(v, this.store, path.join(cfg.dataDir, "candles"), cfg.options, deps.now?.() ?? Date.now()));
    }
  }

  get enabled(): boolean {
    return this.collectors.size > 0;
  }

  collector(venue: VenueId): VenueCollector | undefined {
    return this.collectors.get(venue);
  }

  start(): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => void this.tickAll(), this.cfg.tickMs);
    // Never hold the process open on the collector's account; the HTTP server
    // is what keeps the hub alive.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every venue. Re-entrancy guarded: a tick that overruns its
   *  period must not have a second one pile up behind it. */
  async tickAll(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // The per-second rate governs each venue independently — they are
      // different hosts and do not share a rate limit.
      const budget = Math.max(1, Math.round((this.cfg.options.requestsPerSecond * this.cfg.tickMs) / 1000));
      for (const c of this.collectors.values()) {
        try {
          await c.tick(this.fetchLike, budget, now);
        } catch {
          // A collector's own tick already records its errors in health(); an
          // unexpected throw must never stop the other venues from running.
        }
      }
      if (now - this.lastPruneAt >= DAY_MS) {
        this.lastPruneAt = now;
        for (const c of this.collectors.values()) c.prune(now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Build a signed seed. Delegates the contract to seed.ts. */
  seed(req: SeedRequest): SeedOutcome {
    return buildSeed(req, {
      store: this.store,
      keyId: this.cfg.keyId,
      sign: this.deps.sign,
      symbolKnown: (venue, symbol) => {
        const c = this.collectors.get(venue);
        // No collector for this venue: we cannot claim the symbol is unknown to
        // the VENUE, only that we do not track it. 503 (via the empty store) is
        // the right answer there, so report it as "known" and let the coverage
        // check produce the 503.
        if (!c) return true;
        // A delisted symbol whose history we still hold stays servable — the
        // candles happened, and a bot backtesting the window still wants them.
        return c.isTracked(symbol) || this.store.coverage(venue, symbol).lastClosedMs !== null;
      },
    });
  }

  /** Per-exchange status for the admin panel. Every venue in VENUE_IDS gets a
   *  card, including ones with no collector — which report `configured:false`
   *  rather than a row of zeroes indistinguishable from a broken collector. */
  status(now = Date.now()): VenueStatus[] {
    return VENUE_IDS.map((venue) => this.venueStatus(venue, now));
  }

  private venueStatus(venue: VenueId, now: number): VenueStatus {
    const collector = this.collectors.get(venue);
    const klineEndpoint = ADAPTERS[venue].klineEndpoint;
    if (!collector) {
      return {
        venue, configured: false, health: null, klineEndpoint,
        counts: {
          tracked: 0, seedable: 0, backfilling: 0, gapped: 0, empty: 0,
          delisted: 0, newLast24h: 0, newLast24hBackfilling: 0,
        },
        oldestClosedMs: null, newestClosedMs: null, totalMissingMinutes: 0,
        worstGaps: [], newlyListed: [],
      };
    }

    const per = this.symbolStatuses(collector, now);
    const counts = {
      tracked: per.length,
      seedable: 0, backfilling: 0, gapped: 0, empty: 0, delisted: 0,
      newLast24h: 0, newLast24hBackfilling: 0,
    };
    let oldestClosedMs: number | null = null;
    let newestClosedMs: number | null = null;
    let totalMissingMinutes = 0;

    for (const s of per) {
      counts[s.bucket]++;
      if (s.delisted) counts.delisted++;
      if (s.newlyListed) {
        counts.newLast24h++;
        if (s.bucket !== "seedable") counts.newLast24hBackfilling++;
      }
      totalMissingMinutes += s.missingMinutes;
      if (s.firstClosedMs !== null && (oldestClosedMs === null || s.firstClosedMs < oldestClosedMs)) {
        oldestClosedMs = s.firstClosedMs;
      }
      if (s.lastClosedMs !== null && (newestClosedMs === null || s.lastClosedMs > newestClosedMs)) {
        newestClosedMs = s.lastClosedMs;
      }
    }

    const worstGaps = per
      .filter((s) => s.missingMinutes > 0)
      .sort((a, b) => b.missingMinutes - a.missingMinutes)
      .slice(0, 8)
      .map((s) => ({ symbol: s.symbol, missingMinutes: s.missingMinutes }));

    const newlyListed = per
      .filter((s) => s.newlyListed)
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .slice(0, 20)
      .map((s) => ({
        symbol: s.symbol,
        firstSeenAt: 0,
        heldMinutes: s.heldMinutes,
        bucket: s.bucket,
      }));
    // firstSeenAt filled from the tracked record (kept out of the map above so
    // the lookup happens once per listed row rather than once per symbol).
    for (const row of newlyListed) {
      row.firstSeenAt = collector.symbols().find((t) => t.symbol === row.symbol)?.firstSeenAt ?? 0;
    }

    return {
      venue, configured: true, health: collector.health(now), klineEndpoint,
      counts, oldestClosedMs, newestClosedMs, totalMissingMinutes, worstGaps, newlyListed,
    };
  }

  private symbolStatuses(collector: VenueCollector, now: number): SymbolStatus[] {
    const newestClosed = newestClosedOpenMs(now);
    return collector.symbols().map((t) => {
      const cov = collector.coverage(t.symbol);
      const heldMinutes = cov.count;
      const missingMinutes = cov.interiorMissing;
      // ── ONE BUCKET PER SYMBOL, IN PRIORITY ORDER ────────────────────────
      // The buckets are reported as plain counts and never rolled into a
      // health score: an operator needs to know WHICH of these is wrong, and a
      // single number would hide exactly that.
      let bucket: SymbolStatus["bucket"];
      if (cov.lastClosedMs === null) {
        bucket = "empty";
      } else if (missingMinutes > 0) {
        // Holes inside the range we hold. Said first because a gapped symbol
        // is the one that can poison a seed while looking deep and current.
        bucket = "gapped";
      } else if (
        heldMinutes < SEEDABLE_MIN_MINUTES ||
        newestClosed - cov.lastClosedMs > SEEDABLE_MAX_TAIL_AGE_MS
      ) {
        bucket = "backfilling";
      } else {
        bucket = "seedable";
      }
      return {
        symbol: t.symbol,
        bucket,
        firstClosedMs: cov.firstClosedMs,
        lastClosedMs: cov.lastClosedMs,
        heldMinutes,
        missingMinutes,
        newlyListed: now - t.firstSeenAt < NEW_SYMBOL_WINDOW_MS,
        delisted: t.delisted,
        tradable: t.tradable,
      };
    });
  }
}

export function collectorOptionsFromEnv(env: NodeJS.ProcessEnv): CollectorOptions {
  const numOr = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    retentionDays: numOr(env.HUB_CANDLE_RETENTION_DAYS, DEFAULT_COLLECTOR_OPTIONS.retentionDays),
    requestsPerSecond: numOr(env.HUB_CANDLE_RPS, DEFAULT_COLLECTOR_OPTIONS.requestsPerSecond),
    symbolRefreshMs: numOr(env.HUB_CANDLE_SYMBOL_REFRESH_MS, DEFAULT_COLLECTOR_OPTIONS.symbolRefreshMs),
    stallAfterMs: numOr(env.HUB_CANDLE_STALL_AFTER_MS, DEFAULT_COLLECTOR_OPTIONS.stallAfterMs),
    failingAfter: numOr(env.HUB_CANDLE_FAILING_AFTER, DEFAULT_COLLECTOR_OPTIONS.failingAfter),
  };
}
