// src/candles/collector.ts
// One collector per venue. It does three things forever: re-read the venue's
// instrument list so new listings start collecting on their own, tail every
// tracked symbol to the newest CLOSED minute, and backfill each one down to the
// retention horizon.
//
// ── FRESHNESS BEFORE DEPTH ──────────────────────────────────────────────────
// Every tick spends its request budget on TAIL work first and only then on
// backfill. A seed that is 30 days deep but 40 minutes stale is worse than one
// that is 3 days deep and current, because staleness is the thing the bot
// cannot compensate for: it verifies the newest candles against the venue, and
// a stale tail fails that check and discards the whole seed. Depth merely
// arrives later.
//
// ── NEW LISTINGS, WITHOUT A RESTART ─────────────────────────────────────────
// `refreshSymbols` runs on its own cadence inside the same tick. A symbol that
// appears in the venue's instrument list is added to the tracked set, stamped
// with `firstSeenAt`, and picked up by the very next tick's work queue — no
// restart, no operator action. A symbol that DISAPPEARS is marked `delisted`
// and stops being polled, but its history is kept: a delisting does not make
// the candles that already happened untrue, and a symbol that comes back
// (venues do re-list) simply resumes.
//
// Symbols are stored under their VENUE-NATIVE spelling and never normalised.
// The same coin is `PEPEUSDT` on Bitget and `1000PEPEUSDT` on Bitunix — two
// different books at two different prices — and a measured comparison of the
// live instrument lists found 168 symbols on Bitget that Bitunix does not list
// and 126 the other way. Joining them would be inventing data.
import path from "node:path";
import { readJson, writeJsonAtomic } from "../jsonfile.js";
import {
  CandleStore, DAY_MS, MINUTE_MS, newestClosedOpenMs, type Candle, type SymbolCoverage,
} from "./store.js";
import { ADAPTERS, dropUnclosed, isRateLimit, type FetchLike, type VenueId } from "./venues.js";

export interface CollectorOptions {
  /** How deep to keep history. The bot's warm window; anything older is pruned. */
  retentionDays: number;
  /** Requests per second across ALL symbols of this venue. A CEILING, not a
   *  target: the collector paces itself to this and drops BELOW it whenever the
   *  venue says it is going too fast (see `minRequestsPerSecond`). It never
   *  climbs above it. */
  requestsPerSecond: number;
  /** The floor the adaptive rate may not go under. A venue that is limiting us
   *  hard still gets polled at this rate, slowly, rather than being abandoned. */
  minRequestsPerSecond: number;
  /** First cooldown after a rate-limit refusal. Doubles per consecutive
   *  refusal up to `rateLimitMaxCooldownMs`. */
  rateLimitCooldownMs: number;
  rateLimitMaxCooldownMs: number;
  /** ── v0.2.4 — HOW MUCH BACKLOG A TAIL REQUEST SHOULD CARRY ────────────────
   *
   *  MEASURED on the operator's box: 202 requests returned 5,768 candles — 28.6
   *  rows against a 200-row page, **14% page utilisation**. The collector was
   *  spending its whole Bitunix budget re-fetching tiny tails, because a symbol
   *  entered the tail queue the moment it was one minute behind, and with 703
   *  symbols a sweep took ~29 minutes. Backfill never got a turn, so a
   *  rate-limited venue could not converge at all.
   *
   *  A symbol is now TAIL-DUE only once it has accumulated this many minutes of
   *  backlog, so each request comes back most of a page full. The budget that
   *  frees goes to depth, which is the queue's second half and was previously
   *  starved. Same requests, ~7x the candles.
   *
   *  THE COST, STATED: the newest candle the hub holds is up to this old. The
   *  bot bridges that on download with ONE request of its own — which is the
   *  trade: one request per bot per seed, instead of the hub burning its entire
   *  venue budget so that bots need not make it. `seedableMaxTailAgeMs` is
   *  DERIVED from this number rather than set beside it, because two constants
   *  that must agree are two constants that will not. */
  tailFillMinutes: number;
  /** How often to re-read the venue's instrument list. */
  symbolRefreshMs: number;
  /** A collector whose last SUCCESS is older than this is STALLED, whether or
   *  not anything threw. Nothing is ever "idle" here — there is always a tail
   *  to advance — so silence is always a fault, never a rest. */
  stallAfterMs: number;
  /** Consecutive failed requests before the venue reads as FAILING. */
  failingAfter: number;
}

export const DEFAULT_COLLECTOR_OPTIONS: CollectorOptions = {
  retentionDays: 30,
  requestsPerSecond: 3.2,
  minRequestsPerSecond: 0.5,
  rateLimitCooldownMs: 60_000,
  rateLimitMaxCooldownMs: 15 * 60_000,
  // 150 minutes: three quarters of the 200-row page Bitunix and Bitget both
  // cap at. Bybit's page holds 1000, but the same 150 is used there rather than
  // 750 — a 12-hour-old tail buys nothing on a venue that is not refusing us,
  // and one number is easier to reason about than a per-venue table.
  tailFillMinutes: 150,
  symbolRefreshMs: 15 * 60_000,
  stallAfterMs: 10 * 60_000,
  failingAfter: 5,
};

/** How stale a symbol's tail may be and still count as SEEDABLE.
 *
 *  DERIVED from `tailFillMinutes`, never set beside it: a symbol is polled only
 *  once it is that far behind, so a ceiling below it would mark every symbol
 *  un-seedable forever — the collector would be working perfectly and the panel
 *  would report nothing servable. The 30-minute slack is for the sweep to come
 *  back round after the backlog is due. */
export function seedableMaxTailAgeMs(opts: Pick<CollectorOptions, "tailFillMinutes">): number {
  return (Math.max(1, opts.tailFillMinutes) + 30) * 60_000;
}

/** AIMD. Halve on a refusal, and only creep back up after a long clean run —
 *  the classic shape, chosen because the venue never tells us its actual budget
 *  and the only way to find it is to approach it slowly and retreat fast. */
const RATE_RECOVER_AFTER_SUCCESSES = 120;
const RATE_RECOVER_FACTOR = 1.25;

/** What we know about one tracked symbol. Persisted so `firstSeenAt` — which
 *  the admin panel uses to answer "what appeared today" — survives a restart. */
export interface TrackedSymbol {
  symbol: string;
  /** Venue says it is currently tradable (Bitunix PREVIEW rows are not). */
  tradable: boolean;
  /** OUR clock, first time this symbol appeared in the venue's list. */
  firstSeenAt: number;
  /** OUR clock, last time the venue's list still contained it. */
  lastListedAt: number;
  delisted: boolean;
  delistedAt?: number;
}

interface SymbolsFile {
  symbols: Record<string, TrackedSymbol>;
}

export type VenueState = "starting" | "running" | "cooling" | "stalled" | "failing";

export interface VenueHealth {
  venue: VenueId;
  state: VenueState;
  /** Why it is in that state, in the operator's words. */
  detail: string;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastError: { message: string; at: number } | null;
  consecutiveFailures: number;
  lastSymbolRefreshAt: number | null;
  requestsMade: number;
  candlesWritten: number;
  /** The rate the collector is ACTUALLY using right now, which is at or below
   *  the configured ceiling. Shown because "why is this venue so slow" and "why
   *  is this venue erroring" are different questions with different answers. */
  effectiveRps: number;
  /** Configured ceiling, so the panel can say 0.8 of 3.2 rather than a bare number. */
  configuredRps: number;
  /** Lifetime count of rate-limit refusals from this venue. */
  rateLimitHits: number;
  /** While this is in the future the collector is deliberately not asking. */
  cooldownUntil: number | null;
}

export class VenueCollector {
  private tracked = new Map<string, TrackedSymbol>();
  private coverageCache = new Map<string, SymbolCoverage>();
  private readonly symbolsFile: string;

  private lastPollAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: { message: string; at: number } | null = null;
  private consecutiveFailures = 0;
  private lastSymbolRefreshAt: number | null = null;
  private requestsMade = 0;
  private candlesWritten = 0;
  private startedAt: number;
  /** Round-robin cursor so one slow symbol cannot starve the rest. */
  private cursor = 0;

  // ── RATE STATE ────────────────────────────────────────────────────────────
  /** Current adaptive rate. Starts at the configured ceiling and only ever
   *  moves between `minRequestsPerSecond` and that ceiling. */
  private effectiveRps: number;
  /** REAL-clock instant the next request may start. Persists across ticks, so
   *  the pacing holds at the tick boundary instead of resetting into a burst. */
  private nextRequestAt = 0;
  private cooldownUntil = 0;
  private consecutiveRateLimits = 0;
  private rateLimitHits = 0;
  private successStreak = 0;

  constructor(
    readonly venue: VenueId,
    private readonly store: CandleStore,
    private readonly stateDir: string,
    private readonly opts: CollectorOptions = DEFAULT_COLLECTOR_OPTIONS,
    now = Date.now(),
  ) {
    this.symbolsFile = path.join(stateDir, venue, "symbols.json");
    this.startedAt = now;
    this.effectiveRps = opts.requestsPerSecond;
    const file = readJson<SymbolsFile>(this.symbolsFile, { symbols: {} });
    for (const [sym, rec] of Object.entries(file.symbols ?? {})) {
      if (rec && typeof rec.symbol === "string") this.tracked.set(sym, rec);
    }
  }

  private persistSymbols(): void {
    writeJsonAtomic(this.symbolsFile, { symbols: Object.fromEntries(this.tracked) });
  }

  symbols(): TrackedSymbol[] {
    return [...this.tracked.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  isTracked(symbol: string): boolean {
    return this.tracked.has(symbol);
  }

  /** Coverage for one symbol, memoised.
   *
   *  The FIRST call per symbol per process does a deep scan (about 2 MB of day
   *  files for a 30-day symbol) to get an exact candle count; after that the
   *  count is maintained incrementally from `store.write`'s `newlyFilled`. The
   *  collector owns every write to this venue's files, so its cache cannot go
   *  stale behind its back — which is what makes the admin panel's completeness
   *  figures free rather than a multi-gigabyte rescan per page refresh. */
  coverage(symbol: string): SymbolCoverage {
    let c = this.coverageCache.get(symbol);
    if (!c) {
      c = this.store.coverage(this.venue, symbol, true);
      this.coverageCache.set(symbol, c);
    }
    return c;
  }

  private noteCoverage(symbol: string, candles: readonly Candle[], newlyFilled: number): void {
    if (candles.length === 0) return;
    const c = this.coverage(symbol);
    let first = c.firstClosedMs;
    let last = c.lastClosedMs;
    for (const k of candles) {
      if (first === null || k.openMs < first) first = k.openMs;
      if (last === null || k.openMs > last) last = k.openMs;
    }
    const count = c.count + newlyFilled;
    const span = first === null || last === null ? 0 : (last - first) / MINUTE_MS + 1;
    this.coverageCache.set(symbol, {
      firstClosedMs: first,
      lastClosedMs: last,
      count,
      // Never negative: interior holes are span minus what we actually hold.
      interiorMissing: Math.max(0, span - count),
    });
  }

  /** Re-read the venue's instrument list; add newcomers, mark disappearances. */
  async refreshSymbols(fetchLike: FetchLike, now = Date.now()): Promise<{ added: string[]; delisted: string[] }> {
    const listed = await ADAPTERS[this.venue].listSymbols(fetchLike);
    this.requestsMade++;
    const added: string[] = [];
    const delisted: string[] = [];
    const seen = new Set<string>();

    for (const s of listed) {
      // The symbol becomes a directory name, so anything that is not a plain
      // instrument spelling is refused rather than sanitised into something
      // else — a venue that starts emitting odd symbols should show up as a
      // missing pair, not as a surprise path.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(s.symbol)) continue;
      seen.add(s.symbol);
      const prev = this.tracked.get(s.symbol);
      if (!prev) {
        this.tracked.set(s.symbol, {
          symbol: s.symbol, tradable: s.tradable, firstSeenAt: now, lastListedAt: now, delisted: false,
        });
        added.push(s.symbol);
      } else {
        // A re-listed symbol resumes: clear the delisted mark, keep firstSeenAt
        // so "new in the last 24h" does not fire again for an old pair.
        prev.tradable = s.tradable;
        prev.lastListedAt = now;
        if (prev.delisted) { prev.delisted = false; delete prev.delistedAt; }
      }
    }
    for (const rec of this.tracked.values()) {
      if (seen.has(rec.symbol) || rec.delisted) continue;
      rec.delisted = true;
      rec.delistedAt = now;
      delisted.push(rec.symbol);
    }
    this.lastSymbolRefreshAt = now;
    this.persistSymbols();
    return { added, delisted };
  }

  /** Symbols worth polling right now, tail work first then backfill. */
  /** Oldest known interior hole per symbol, memoised. Enumerating one costs a
   *  full-window scan of that symbol's day files, so it is done once per hole
   *  and re-done only after the hole has been written into. */
  private holeCache = new Map<string, { at: number; gap: [number, number] | null }>();

  /** The oldest interior hole in a symbol, or null. Interior holes are the one
   *  failure that poisons a seed while the symbol looks deep AND current, and
   *  NOTHING else repairs them: backfill only ever digs backward from
   *  `firstClosedMs`, so a hole inside the held range is permanent until
   *  something goes and gets it. This is that something. */
  private oldestHole(symbol: string, now: number): [number, number] | null {
    const cached = this.holeCache.get(symbol);
    if (cached && now - cached.at < 10 * 60_000) return cached.gap;
    const cov = this.coverage(symbol);
    if (cov.firstClosedMs === null || cov.lastClosedMs === null || cov.interiorMissing <= 0) {
      this.holeCache.set(symbol, { at: now, gap: null });
      return null;
    }
    let gap: [number, number] | null = null;
    try {
      const w = this.store.readWindow(this.venue, symbol, cov.firstClosedMs, cov.lastClosedMs);
      gap = w.gaps.length ? w.gaps[0]! : null;
    } catch { gap = null; }
    this.holeCache.set(symbol, { at: now, gap });
    return gap;
  }

  private workQueue(now: number): Array<{ symbol: string; startMs: number; endMs: number; kind: "tail" | "backfill" | "repair" }> {
    const adapter = ADAPTERS[this.venue];
    const newestClosed = newestClosedOpenMs(now);
    const horizon = newestClosed - this.opts.retentionDays * DAY_MS;
    const pageSpan = (adapter.pageLimit - 1) * MINUTE_MS;
    const tail: Array<{ symbol: string; startMs: number; endMs: number; kind: "tail" | "backfill" | "repair" }> = [];
    const backfill: typeof tail = [];
    // REPAIR sits between them: a hole is worse than shallow history (it
    // poisons a seed while the symbol reads deep and current) and less urgent
    // than a stale tail (which fails the bot's own verification outright).
    const repair: typeof tail = [];

    for (const rec of this.tracked.values()) {
      if (rec.delisted || !rec.tradable) continue;
      const cov = this.coverage(rec.symbol);
      if (cov.lastClosedMs === null) {
        // Nothing at all yet: one page ending at the newest closed minute gets
        // it serving something quickly, and backfill deepens it from there.
        tail.push({ symbol: rec.symbol, startMs: newestClosed - pageSpan, endMs: newestClosed, kind: "tail" });
        continue;
      }
      // TAIL-DUE, not merely tail-behind. Asking for one minute costs the same
      // request as asking for a hundred and fifty (see `tailFillMinutes`), so a
      // symbol waits until it has a page's worth of backlog to collect. Every
      // symbol still advances; it advances in useful strides.
      const behindMs = newestClosed - cov.lastClosedMs;
      if (behindMs >= this.opts.tailFillMinutes * MINUTE_MS) {
        // ── CONTIGUOUS FORWARD FILL (v0.2.5) ────────────────────────────────
        // ALWAYS from the minute after what we hold, never from
        // `newestClosed - pageSpan`. That older form asked for the NEWEST page
        // and, for a symbol more than one page behind, silently skipped every
        // minute between what we held and where the page began — writing a
        // permanent interior hole that NOTHING repairs. Backfill only ever digs
        // backward from `firstClosedMs`, so an interior gap is forever.
        //
        // This was live: with a 150-minute cadence against a 199-minute page
        // span the margin is 49 minutes, and a symbol not served the instant it
        // came due slipped past it. 155 symbols on two venues took ~25-minute
        // holes within one tick of the v0.2.4 deploy.
        //
        // Catching up now takes as many passes as it takes, each a FULL page,
        // and the series is contiguous at every moment in between.
        const startMs = cov.lastClosedMs + MINUTE_MS;
        tail.push({ symbol: rec.symbol, startMs, endMs: Math.min(newestClosed, startMs + pageSpan), kind: "tail" });
      }
      if (cov.interiorMissing > 0) {
        const hole = this.oldestHole(rec.symbol, now);
        // A FULL PAGE FORWARD FROM THE HOLE, exactly the shape of a tail
        // request — NOT a window clamped to the hole's own end.
        //
        // v0.2.6: clamping to `hole[1]` produced narrow, odd-shaped ranges that
        // Bitget's history-candles answered with HTTP 400. Every kline request
        // on the venue failed — 298 consecutive, 157 requests for 0 candles —
        // because 155 gapped symbols each queued one. Asking for a normal page
        // from the hole's start fills the hole AND whatever follows it, and is
        // the request shape already proven against all three venues.
        if (hole && hole[0] <= newestClosed) {
          const endMs = Math.min(newestClosed, hole[0] + pageSpan);
          if (endMs > hole[0]) repair.push({ symbol: rec.symbol, startMs: hole[0], endMs, kind: "repair" });
        }
      }
      if (cov.firstClosedMs !== null && cov.firstClosedMs > horizon) {
        const endMs = cov.firstClosedMs - MINUTE_MS;
        backfill.push({ symbol: rec.symbol, startMs: Math.max(horizon, endMs - pageSpan), endMs, kind: "backfill" });
      }
    }
    // Round-robin the tail so a long symbol list still gets even attention.
    if (tail.length > 0) {
      const k = this.cursor % tail.length;
      tail.push(...tail.splice(0, k));
    }
    this.cursor++;
    return [...tail, ...repair, ...backfill];
  }

  /** How many requests this collector may issue in a window of `tickMs`, at the
   *  rate it is CURRENTLY entitled to. The service asks rather than computing it
   *  from the configured ceiling, so a collector that has backed off actually
   *  gets a smaller budget instead of the same budget spread thinner. */
  budgetFor(tickMs: number): number {
    return Math.max(1, Math.round((this.effectiveRps * tickMs) / 1000));
  }

  /** True while the collector is deliberately silent after a refusal. */
  cooling(clockNow: number): boolean {
    return clockNow < this.cooldownUntil;
  }

  /** Wait until this collector's next request is due. The gap is derived from
   *  the CURRENT effective rate, and `nextRequestAt` carries across ticks — which
   *  is the whole point. The old code issued its entire per-minute budget in one
   *  back-to-back burst and then sat idle, so the AVERAGE was 3.2/s while the
   *  instantaneous rate was whatever latency allowed. Venues limit on the
   *  instantaneous window, which is exactly what they were refusing. */
  private async pace(clock: () => number, sleep: (ms: number) => Promise<void>): Promise<void> {
    const gapMs = Math.max(1, Math.round(1000 / Math.max(0.01, this.effectiveRps)));
    const t = clock();
    if (t < this.nextRequestAt) await sleep(this.nextRequestAt - t);
    this.nextRequestAt = Math.max(clock(), this.nextRequestAt) + gapMs;
  }

  /** A venue told us to slow down. Halve the rate, enter a doubling cooldown,
   *  and — deliberately — do NOT count this toward `consecutiveFailures`: being
   *  rate limited is not the collector failing, and reporting it as FAILING
   *  would bury the one fact that explains it. */
  private noteRateLimited(err: unknown, clockNow: number, at: number, label: string): void {
    this.rateLimitHits++;
    this.consecutiveRateLimits++;
    this.successStreak = 0;
    this.effectiveRps = Math.max(this.opts.minRequestsPerSecond, this.effectiveRps / 2);
    const backoff = Math.min(
      this.opts.rateLimitMaxCooldownMs,
      this.opts.rateLimitCooldownMs * 2 ** (this.consecutiveRateLimits - 1),
    );
    // The venue's own Retry-After wins when it asks for LONGER than we chose.
    // A shorter one is not taken: it would let a venue talk us back into the
    // rate it just refused.
    const asked = (err as { retryAfterMs?: number }).retryAfterMs;
    const wait = Math.max(backoff, Number.isFinite(asked) ? (asked as number) : 0);
    this.cooldownUntil = clockNow + wait;
    this.nextRequestAt = this.cooldownUntil;
    this.lastError = {
      message: `${label}: ${(err as Error).message} — backing off ${Math.round(wait / 1000)}s, rate now ${this.effectiveRps.toFixed(2)}/s`,
      at,
    };
  }

  /** A clean request. After a long clean run, creep the rate back toward the
   *  configured ceiling — never above it. */
  private noteSuccess(): void {
    this.consecutiveRateLimits = 0;
    this.successStreak++;
    if (this.successStreak >= RATE_RECOVER_AFTER_SUCCESSES && this.effectiveRps < this.opts.requestsPerSecond) {
      this.successStreak = 0;
      this.effectiveRps = Math.min(this.opts.requestsPerSecond, this.effectiveRps * RATE_RECOVER_FACTOR);
    }
  }

  /** One pass. `budget` caps the kline requests it may issue; `deps.deadlineMs`
   *  caps the WALL time it may spend, which matters now that the pass paces
   *  itself — without it a fully-paced tick fills its whole period and the
   *  service's next interval finds it still running and skips, halving the rate
   *  it was asked for. Returns what it did, for the tests. */
  async tick(
    fetchLike: FetchLike,
    budget: number,
    now = Date.now(),
    deps: { clock?: () => number; sleep?: (ms: number) => Promise<void>; deadlineMs?: number } = {},
  ): Promise<{ requests: number; written: number }> {
    const clock = deps.clock ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadlineMs = deps.deadlineMs ?? Infinity;
    const startedAt = clock();

    // Cooling: say nothing to the venue at all, not even the symbol list. The
    // point of a cooldown is silence.
    if (this.cooling(clock())) {
      this.lastPollAt = now;
      return { requests: 0, written: 0 };
    }

    if (
      this.lastSymbolRefreshAt === null ||
      now - this.lastSymbolRefreshAt >= this.opts.symbolRefreshMs
    ) {
      try {
        await this.pace(clock, sleep);
        await this.refreshSymbols(fetchLike, now);
        this.lastSuccessAt = now;
        this.consecutiveFailures = 0;
        this.noteSuccess();
      } catch (err) {
        if (isRateLimit(err)) {
          this.noteRateLimited(err, clock(), now, "symbol list");
          return { requests: 0, written: 0 };
        }
        this.lastError = { message: (err as Error).message, at: now };
        this.consecutiveFailures++;
      }
    }

    const queue = this.workQueue(now);
    const newestClosed = newestClosedOpenMs(now);
    let requests = 0;
    let written = 0;
    this.lastPollAt = now;

    for (const item of queue) {
      if (requests >= budget) break;
      if (clock() - startedAt >= deadlineMs) break;
      await this.pace(clock, sleep);
      requests++;
      this.requestsMade++;
      try {
        const page = await ADAPTERS[this.venue].fetchKlines(fetchLike, item.symbol, item.startMs, item.endMs);
        // TWO GATES, both against our own clock rather than the venue's word:
        // dropUnclosed here, and `notAfterMs` inside store.write. A forming bar
        // has to get past both, and neither asks the venue what it sent.
        const closed = dropUnclosed(page.candles, now);
        const w = this.store.write(this.venue, item.symbol, closed, newestClosed);
        written += w.written;
        this.candlesWritten += w.newlyFilled;
        this.noteCoverage(item.symbol, closed, w.newlyFilled);
        // A write may have closed the hole we were chasing; make the next pass
        // look again rather than re-requesting a range that is now filled.
        if (item.kind === "repair" && w.newlyFilled > 0) this.holeCache.delete(item.symbol);
        if (item.kind === "backfill" && page.empty) {
          // The venue has no more history here. Record that by moving our
          // first-held marker down to the range we just proved empty, so the
          // backfill does not ask for it again every tick forever.
          //
          // NOTE what this does NOT do: it does not mark the symbol "complete".
          // Completeness is never inferred from a short or empty page anywhere
          // in this service — the seed's `gaps` are read off stored presence,
          // so a range we could not fill stays visible as a gap regardless of
          // what this cursor says. This is only a politeness to the venue.
          const cov = this.coverage(item.symbol);
          this.coverageCache.set(item.symbol, {
            ...cov,
            firstClosedMs: cov.firstClosedMs === null ? null : Math.min(cov.firstClosedMs, item.startMs),
          });
        }
        this.lastSuccessAt = now;
        this.consecutiveFailures = 0;
        this.noteSuccess();
      } catch (err) {
        if (isRateLimit(err)) {
          // Stop the pass dead. Spending the rest of the budget on requests the
          // venue is already refusing is how a rate limit becomes a ban, and it
          // is also why the old backfill could never converge: every retry cost
          // a slot and returned no candle.
          this.noteRateLimited(err, clock(), now, item.symbol);
          break;
        }
        this.lastError = { message: `${item.symbol}: ${(err as Error).message}`, at: now };
        this.consecutiveFailures++;
      }
    }
    return { requests, written };
  }

  /** Drop day files older than the retention horizon, for every symbol we hold
   *  — including delisted ones, whose history ages out the same way. */
  prune(now = Date.now()): number {
    const horizon = now - this.opts.retentionDays * DAY_MS;
    let removed = 0;
    for (const symbol of this.store.symbols(this.venue)) {
      removed += this.store.prune(this.venue, symbol, horizon);
      this.coverageCache.delete(symbol);
    }
    return removed;
  }

  health(now = Date.now()): VenueHealth {
    const base = {
      venue: this.venue,
      lastPollAt: this.lastPollAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      lastSymbolRefreshAt: this.lastSymbolRefreshAt,
      requestsMade: this.requestsMade,
      candlesWritten: this.candlesWritten,
      effectiveRps: this.effectiveRps,
      configuredRps: this.opts.requestsPerSecond,
      rateLimitHits: this.rateLimitHits,
      cooldownUntil: this.cooldownUntil > now ? this.cooldownUntil : null,
    };
    // FAILING beats STALLED: if requests are actively erroring, that is the
    // more specific and more actionable thing to say.
    if (this.consecutiveFailures >= this.opts.failingAfter) {
      return {
        ...base, state: "failing",
        detail: `${this.consecutiveFailures} consecutive request failures — last: ${this.lastError?.message ?? "unknown"}`,
      };
    }
    // COOLING beats STALLED. A collector in a backoff is not keeping up either,
    // but "stalled" would send the operator looking for a fault when the
    // collector is doing precisely what it should — and the fix for the two is
    // opposite: one wants investigating, the other wants leaving alone.
    if (this.cooling(now)) {
      return {
        ...base, state: "cooling",
        detail: `rate limited — silent for another ${Math.max(1, Math.round((this.cooldownUntil - now) / 1000))}s, then resuming at ${this.effectiveRps.toFixed(2)}/s (ceiling ${this.opts.requestsPerSecond}/s, ${this.rateLimitHits} refusals so far)`,
      };
    }
    if (this.lastSuccessAt === null) {
      // Never succeeded. Before the grace period this is honest startup; after
      // it, the collector is not working and must not read as "starting".
      if (now - this.startedAt < this.opts.stallAfterMs) {
        return { ...base, state: "starting", detail: "collector started, first poll not completed yet" };
      }
      return {
        ...base, state: "failing",
        detail: `no successful poll since start ${Math.round((now - this.startedAt) / 60_000)}m ago`,
      };
    }
    const age = now - this.lastSuccessAt;
    if (age >= this.opts.stallAfterMs) {
      // Deliberately not "idle": this collector always has a tail to advance,
      // so there is no such thing as nothing to do. Silence is a fault.
      return {
        ...base, state: "stalled",
        detail: `last successful poll ${Math.round(age / 60_000)}m ago on a 1-minute cadence — nothing threw, but it is not keeping up`,
      };
    }
    // A collector running well below its ceiling is running CORRECTLY but
    // slowly, and the operator should not have to guess which. Say the rate
    // whenever it is throttled; stay quiet about it when it is at full speed.
    const throttled = this.effectiveRps < this.opts.requestsPerSecond - 1e-9
      ? ` — throttled to ${this.effectiveRps.toFixed(2)}/s of ${this.opts.requestsPerSecond}/s after ${this.rateLimitHits} rate-limit refusals`
      : "";
    return { ...base, state: "running", detail: `last successful poll ${Math.round(age / 1000)}s ago${throttled}` };
  }
}
