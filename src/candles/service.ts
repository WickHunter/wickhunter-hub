// src/candles/service.ts
// Owns one collector per configured venue, drives their ticks on a timer, and
// answers the two questions the rest of the hub asks: "build me a signed seed
// for this venue+symbol" and "what is each exchange's status right now".
import path from "node:path";
import { createHash } from "node:crypto";
import { CandleStore, DAY_MS, MINUTE_MS, newestClosedOpenMs } from "./store.js";
import {
  DEFAULT_COLLECTOR_OPTIONS, VenueCollector, seedableMaxTailAgeMs,
  type CollectorOptions, type VenueHealth,
} from "./collector.js";
import { ADAPTERS, VENUE_IDS, type FetchLike, type VenueId } from "./venues.js";
import { STREAM_ADAPTERS } from "./stream.js";
import { VenueStreamRunner } from "./stream-runner.js";
import { buildSeed, type SeedOutcome, type SeedRequest } from "./seed.js";
import {
  buildSnapshot, isSnapshotDepth, isSnapshotInterval, newestCompleteBucketOpenMs,
  snapshotExpiresAtMs, SNAPSHOT_INTERVALS, SNAPSHOT_MAX_DEPTH,
  type SnapshotSigned,
} from "./snapshot.js";

// v0.2.4 — the seedable tail ceiling is no longer a constant here. It is
// DERIVED from the collector's `tailFillMinutes` (see `seedableMaxTailAgeMs` in
// ./collector.ts), because a symbol is now polled only once it has a page's
// worth of backlog: a fixed 15-minute ceiling below that polling cadence would
// mark every symbol un-seedable forever, with the collector working perfectly
// and the panel reporting nothing servable.
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

/** What the snapshot route serves, or the refusal it answers with. The 404 for
 *  a venue this hub does not know belongs to the route, which owns the venue
 *  vocabulary; everything decidable from the data is decided here. */
export type CandleSnapshotResult =
  | { ok: true; payload: SnapshotSigned; etag: string; body: Buffer }
  | { ok: false; code: 400 | 503; error: string };

/** Distinct (interval, depth) combinations cached per venue. See `snapshot`. */
export const SNAPSHOT_CACHE_PER_VENUE = 16;

interface SnapshotCacheEntry {
  result: CandleSnapshotResult;
  /** Wall-clock instant at which a rebuild could produce a NEWER window. */
  expiresAt: number;
}

export interface CandleServiceConfig {
  dataDir: string;
  /** Which venues actually run a collector. Empty = the service is off. */
  venues: VenueId[];
  keyId: string;
  options: CollectorOptions;
  /** Tick period. One minute matches the candle cadence. */
  tickMs: number;
  /** ── v0.2.17 — VENUES WHOSE TAIL COMES FROM A WEBSOCKET ──────────────────
   *
   *  A SUBSET of `venues`, never a superset: a stream is a faster tail for a
   *  venue the collector already owns, not a way to collect one it does not.
   *  Absent/empty = REST only, which is every install's behaviour until an
   *  operator sets `HUB_CANDLE_STREAM`. */
  streamVenues?: VenueId[];
}

export interface CandleServiceDeps {
  sign(bytes: Buffer): Buffer;
  /** Injectable so tests never touch the network. */
  fetchLike?: FetchLike;
  /** Injectable clock. Read once at construction to stamp each collector's
   *  `startedAt` — without it a caller reasoning about a frozen clock gets
   *  negative elapsed time and the never-succeeded collector never reaches
   *  FAILING — and read again on every request as the PACING clock, so a
   *  suite can drive the rate limiter deterministically instead of against
   *  wall time. Defaults to `Date.now`, so production is unchanged. */
  now?: () => number;
  /** Where a snapshot rebuild reports its cost. Injectable so a suite can read
   *  the line instead of the console; production prints it. */
  log?: (message: string) => void;
  /** Injectable delay. The collector paces itself by sleeping between requests;
   *  a suite passes a no-op so the pacing is exercised without the suite
   *  actually waiting for it. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const realFetch: FetchLike = async (url: string) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  // `headers` is forwarded so a venue's own `Retry-After` can be honoured; the
  // collector falls back to its own backoff when the header is absent.
  return { ok: res.ok, status: res.status, json: () => res.json(), headers: res.headers };
};

export class CandleService {
  readonly store: CandleStore;
  private readonly collectors = new Map<VenueId, VenueCollector>();
  private readonly fetchLike: FetchLike;
  private timer: NodeJS.Timeout | null = null;
  private startupTick: NodeJS.Immediate | null = null;
  /** The initial startup pass and an operator-triggered pass share this one
   * promise.  Callers that await `tickAll()` must wait for an already-running
   * startup discovery instead of receiving a misleading completed no-op. */
  private tickInFlight: Promise<void> | null = null;
  /** ── v0.2.17 — THE WEBSOCKET TAIL, OFF UNLESS ASKED FOR ──────────────────
   *
   *  Empty unless `HUB_CANDLE_STREAM` names venues. OFF by default on purpose:
   *  the Bitget and Bitunix adapters were verified against their live streams,
   *  but BYBIT'S WAS NOT — this build environment is geo-blocked from Bybit and
   *  could not probe it, so its frame shape rests on the v5 contract and the
   *  working client in the bot repo. A default-on stream would make that
   *  unverified leg everyone's problem on upgrade.
   *
   *  Turning it on is additive and reversible: the runner only ever writes
   *  closed candles the REST tail would have fetched later, so switching it off
   *  again leaves nothing behind but a gap the collector already repairs. */
  private readonly streams = new Map<VenueId, VenueStreamRunner>();
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
      // v0.2.15 — each collector runs at ITS OWN venue's ceiling. The floor is
      // re-clamped here too: a per-venue ceiling below the shared floor would
      // otherwise let the floor quietly raise this venue back above its limit,
      // which is the same invariant `collectorOptionsFromEnv` protects.
      const venueRps = cfg.options.perVenueRequestsPerSecond?.[v] ?? cfg.options.requestsPerSecond;
      const venueOpts: CollectorOptions = {
        ...cfg.options,
        requestsPerSecond: venueRps,
        minRequestsPerSecond: Math.min(venueRps, cfg.options.minRequestsPerSecond),
      };
      this.collectors.set(v, new VenueCollector(v, this.store, path.join(cfg.dataDir, "candles"), venueOpts, deps.now?.() ?? Date.now()));
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
    // The stream is started BEFORE the REST timer so a restart's first closed
    // minutes arrive from the socket rather than being paged for.
    for (const v of this.cfg.streamVenues ?? []) {
      if (!this.collectors.has(v)) continue;
      const collector = this.collectors.get(v)!;
      const adapter = STREAM_ADAPTERS[v];
      // A configured collector remains useful when a venue has no verified
      // candle socket.  In particular WEEX is REST-only; never invent a stream
      // from another public topic or let an env typo crash startup.
      if (!adapter) {
        console.warn(`[candles·stream] ${v}: no verified candle websocket; continuing with REST collection`);
        continue;
      }
      const runner = new VenueStreamRunner({
        adapter,
        // Read fresh on every resync, so a new listing joins the stream on the
        // collector's own listing cadence with no restart.
        symbols: () => collector.symbols().filter((t) => !t.delisted).map((t) => t.symbol),
        write: (symbol, candles, notAfterMs) => { this.store.write(v, symbol, candles, notAfterMs); },
        now: this.deps.now,
        log: (m) => console.log(`[candles·stream] ${m}`),
      });
      this.streams.set(v, runner);
      runner.start();
    }
    this.timer = setInterval(() => void this.tickAll(), this.cfg.tickMs);
    // Never hold the process open on the collector's account; the HTTP server
    // is what keeps the hub alive.
    this.timer.unref();
    // WEEX joined existing enabled Hub rosters in this release. Do not make
    // that new collector wait one full scheduler period before it discovers
    // symbols and starts its bounded queue. Existing non-WEEX service seams
    // retain their timer-only cadence. Defer one event-loop turn so an
    // embedding caller may establish its clock/test seam first; this is still
    // startup work, never a 60-second scheduler wait.
    if (this.collectors.has("weex")) {
      this.startupTick = setImmediate(() => {
        this.startupTick = null;
        void this.tickAll().catch(() => undefined);
      });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.startupTick) clearImmediate(this.startupTick);
    this.startupTick = null;
    for (const r of this.streams.values()) r.stop();
    this.streams.clear();
  }

  /** Live socket state, for the admin panel. Empty when the tail is off. */
  streamStatus(): Array<ReturnType<VenueStreamRunner["status"]>> {
    return [...this.streams.values()].map((r) => r.status());
  }

  /** Re-chunk every runner against the current tracked set. Called on the same
   *  pass that refreshes listings, so a new symbol starts streaming without a
   *  restart; a no-op when the set has not changed. */
  resyncStreams(): void {
    for (const r of this.streams.values()) r.resync();
  }

  /** One pass over every venue. Re-entrancy guarded: a tick that overruns its
   *  period must not have a second one pile up behind it. */
  async tickAll(now = Date.now()): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    const run = this.tickAllOnce(now);
    this.tickInFlight = run;
    try { await run; }
    finally { if (this.tickInFlight === run) this.tickInFlight = null; }
  }

  private async tickAllOnce(now: number): Promise<void> {
    try {
      // The per-second rate governs each venue independently — they are
      // different hosts and do not share a rate limit. The BUDGET now comes from
      // the collector rather than from the configured ceiling, because a
      // collector that has backed off is entitled to fewer requests, not to the
      // same number spread thinner.
      //
      // The DEADLINE exists because the pass paces itself: a fully-paced tick
      // would otherwise consume its entire period, and the next interval would
      // find a prior pass still running and share it — rather than halving the
      // rate we set. 80%
      // leaves room for the venues that answer slowly.
      const deadlineMs = Math.max(1000, Math.round(this.cfg.tickMs * 0.8));
      const clock = this.deps.now ?? Date.now;
      const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      // CONCURRENTLY, not one venue after another. They are different hosts with
      // independent rate limits, and now that each pass paces itself across most
      // of the tick period, running them in series would mean the last venue
      // never got a turn at all.
      await Promise.all([...this.collectors.values()].map(async (c) => {
        try {
          await c.tick(this.fetchLike, c.budgetFor(this.cfg.tickMs), now, { clock, sleep, deadlineMs });
        } catch {
          // A collector's own tick already records its errors in health(); an
          // unexpected throw must never stop the other venues from running.
        }
      }));
      if (now - this.lastPruneAt >= DAY_MS) {
        this.lastPruneAt = now;
        for (const c of this.collectors.values()) c.prune(now);
      }
    } finally { /* the public wrapper releases the shared in-flight promise */ }
  }

  // ── THE SNAPSHOT CACHE ────────────────────────────────────────────────────
  //
  // A snapshot folds every tracked symbol's window, so it is by far the most
  // expensive thing this service builds — and its answer cannot change until
  // the next bucket boundary has passed and settled, because the window is
  // derived from the clock and the buckets in it are closed and immutable. So
  // it is built LAZILY on the first request for a (venue, interval, depth) and
  // reused verbatim until that instant.
  //
  // BOUNDED PER VENUE, and that bound is the point: the interval and depth come
  // from the caller, so an unbounded map lets one licence holder make the hub
  // fold 6,500 distinct windows and keep every one of them in memory. 16 is
  // more combinations than the bot's own rule set can produce at once (four
  // rows, each one timeframe and one depth) and the eviction is least-recently
  // USED, so the combinations actually being polled survive a probe.
  //
  // A REFUSAL IS CACHED TOO. A cold venue answers 503 out of the same full fold
  // over every symbol; without this, the one caller polling a venue that is
  // still backfilling would pay that fold on every request while a healthy
  // venue pays it once.
  private readonly snapshotCache = new Map<VenueId, Map<string, SnapshotCacheEntry>>();

  /** A signed snapshot for one venue/timeframe/depth, its ETag and its bytes.
   *
   *  NEVER BLOCKS ON THE COLLECTOR: the roster is read from the collector's
   *  in-memory tracked set and the candles come off the store's own day files.
   *  A venue that is rate-limited, cooling or mid-tick answers from what is
   *  already on disk rather than making a request path wait for it. */
  snapshot(venue: VenueId, interval: number, depth: number): CandleSnapshotResult {
    // Validated here as well as at the route: the route owns the 404 for a
    // venue nobody collects, this owns the shape of the two numbers, and a
    // malformed pair must never reach the cache and occupy a slot.
    if (!isSnapshotInterval(interval)) {
      return { ok: false, code: 400, error: `interval must be one of ${SNAPSHOT_INTERVALS.join(",")} minutes` };
    }
    if (!isSnapshotDepth(depth)) {
      return { ok: false, code: 400, error: `depth must be an integer 1..${SNAPSHOT_MAX_DEPTH}` };
    }
    const now = (this.deps.now ?? Date.now)();
    let perVenue = this.snapshotCache.get(venue);
    if (!perVenue) this.snapshotCache.set(venue, perVenue = new Map());
    const key = `${interval}:${depth}`;
    const held = perVenue.get(key);
    if (held && now < held.expiresAt) {
      // Re-insert so the map's insertion order IS the recency order.
      perVenue.delete(key);
      perVenue.set(key, held);
      return held.result;
    }

    const startedAt = Date.now();
    const outcome = buildSnapshot({ venue, interval, depth, now }, {
      store: this.store,
      keyId: this.cfg.keyId,
      sign: this.deps.sign,
      symbols: (v) => {
        const c = this.collectors.get(v);
        // No collector for this venue: answer for what we HOLD. Saying "this
        // venue tracks nothing" would be a claim about the venue that a hub
        // with the collector switched off is in no position to make.
        return c ? c.symbols().map((t) => t.symbol) : this.store.symbols(v);
      },
    });

    let result: CandleSnapshotResult;
    if (outcome.ok) {
      const body = Buffer.from(JSON.stringify(outcome.payload), "utf8");
      // The ETag is over the SERVED BYTES, so a 304 hands the client exactly
      // what a 200 would have.
      const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 32)}"`;
      result = { ok: true, payload: outcome.payload, etag, body };
      this.log(`built ${venue} ${interval}m x${depth}: ${outcome.payload.symbols.length} symbols`
        + ` (${outcome.payload.skipped.length} skipped), ${body.length} bytes in ${Date.now() - startedAt}ms`);
    } else {
      result = outcome;
      this.log(`built ${venue} ${interval}m x${depth}: ${outcome.code} ${outcome.error}`
        + ` (${Date.now() - startedAt}ms)`);
    }
    perVenue.set(key, { result, expiresAt: snapshotExpiresAtMs(this.snapshotWindowAnchor(now, interval), interval) });
    while (perVenue.size > SNAPSHOT_CACHE_PER_VENUE) {
      const oldest = perVenue.keys().next();
      if (oldest.done) break;
      perVenue.delete(oldest.value);
    }
    return result;
  }

  /** The window a build at `now` answers for, whether or not it produced a
   *  payload — a refusal expires on the same boundary its successor would. */
  private snapshotWindowAnchor(now: number, interval: number): number {
    return newestCompleteBucketOpenMs(now, interval);
  }

  private log(message: string): void {
    (this.deps.log ?? ((m: string) => console.log(`[candles·snapshot] ${m}`)))(message);
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
        newestClosed - cov.lastClosedMs > seedableMaxTailAgeMs(this.cfg.options)
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
  const rpsSet = Number.isFinite(Number(env.HUB_CANDLE_RPS)) && Number(env.HUB_CANDLE_RPS) > 0;
  const requestsPerSecond = numOr(env.HUB_CANDLE_RPS, DEFAULT_COLLECTOR_OPTIONS.requestsPerSecond);
  // The per-venue table applies ONLY when the operator has not named a rate.
  const perVenueRequestsPerSecond = rpsSet
    ? undefined
    : Object.fromEntries(VENUE_IDS.map((v) => [v, ADAPTERS[v].publicRequestsPerSecond])) as Partial<Record<VenueId, number>>;
  const cooldown = numOr(env.HUB_CANDLE_COOLDOWN_MS, DEFAULT_COLLECTOR_OPTIONS.rateLimitCooldownMs);
  return {
    retentionDays: numOr(env.HUB_CANDLE_RETENTION_DAYS, DEFAULT_COLLECTOR_OPTIONS.retentionDays),
    requestsPerSecond,
    // The floor can never sit ABOVE the ceiling: an operator who sets a very low
    // HUB_CANDLE_RPS must get that rate, not have a stale default floor quietly
    // raise it back up past what they asked for.
    minRequestsPerSecond: Math.min(
      requestsPerSecond,
      numOr(env.HUB_CANDLE_MIN_RPS, DEFAULT_COLLECTOR_OPTIONS.minRequestsPerSecond),
    ),
    rateLimitCooldownMs: cooldown,
    // Likewise the max cooldown cannot be shorter than the first one.
    rateLimitMaxCooldownMs: Math.max(
      cooldown,
      numOr(env.HUB_CANDLE_MAX_COOLDOWN_MS, DEFAULT_COLLECTOR_OPTIONS.rateLimitMaxCooldownMs),
    ),
    tailFillMinutes: numOr(env.HUB_CANDLE_TAIL_FILL_MIN, DEFAULT_COLLECTOR_OPTIONS.tailFillMinutes),
    symbolRefreshMs: numOr(env.HUB_CANDLE_SYMBOL_REFRESH_MS, DEFAULT_COLLECTOR_OPTIONS.symbolRefreshMs),
    stallAfterMs: numOr(env.HUB_CANDLE_STALL_AFTER_MS, DEFAULT_COLLECTOR_OPTIONS.stallAfterMs),
    failingAfter: numOr(env.HUB_CANDLE_FAILING_AFTER, DEFAULT_COLLECTOR_OPTIONS.failingAfter),
    perVenueRequestsPerSecond,
  };
}
