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
import { ADAPTERS, dropUnclosed, type FetchLike, type VenueId } from "./venues.js";

export interface CollectorOptions {
  /** How deep to keep history. The bot's warm window; anything older is pruned. */
  retentionDays: number;
  /** Requests per second across ALL symbols of this venue. */
  requestsPerSecond: number;
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
  symbolRefreshMs: 15 * 60_000,
  stallAfterMs: 10 * 60_000,
  failingAfter: 5,
};

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

export type VenueState = "starting" | "running" | "stalled" | "failing";

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

  constructor(
    readonly venue: VenueId,
    private readonly store: CandleStore,
    private readonly stateDir: string,
    private readonly opts: CollectorOptions = DEFAULT_COLLECTOR_OPTIONS,
    now = Date.now(),
  ) {
    this.symbolsFile = path.join(stateDir, venue, "symbols.json");
    this.startedAt = now;
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
  private workQueue(now: number): Array<{ symbol: string; startMs: number; endMs: number; kind: "tail" | "backfill" }> {
    const adapter = ADAPTERS[this.venue];
    const newestClosed = newestClosedOpenMs(now);
    const horizon = newestClosed - this.opts.retentionDays * DAY_MS;
    const pageSpan = (adapter.pageLimit - 1) * MINUTE_MS;
    const tail: Array<{ symbol: string; startMs: number; endMs: number; kind: "tail" | "backfill" }> = [];
    const backfill: typeof tail = [];

    for (const rec of this.tracked.values()) {
      if (rec.delisted || !rec.tradable) continue;
      const cov = this.coverage(rec.symbol);
      if (cov.lastClosedMs === null) {
        // Nothing at all yet: one page ending at the newest closed minute gets
        // it serving something quickly, and backfill deepens it from there.
        tail.push({ symbol: rec.symbol, startMs: newestClosed - pageSpan, endMs: newestClosed, kind: "tail" });
        continue;
      }
      if (cov.lastClosedMs < newestClosed) {
        const startMs = Math.max(cov.lastClosedMs + MINUTE_MS, newestClosed - pageSpan);
        tail.push({ symbol: rec.symbol, startMs, endMs: newestClosed, kind: "tail" });
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
    return [...tail, ...backfill];
  }

  /** One pass. `budget` caps the kline requests it may issue, which is how the
   *  caller governs the request rate. Returns what it did, for the tests. */
  async tick(fetchLike: FetchLike, budget: number, now = Date.now()): Promise<{ requests: number; written: number }> {
    if (
      this.lastSymbolRefreshAt === null ||
      now - this.lastSymbolRefreshAt >= this.opts.symbolRefreshMs
    ) {
      try {
        await this.refreshSymbols(fetchLike, now);
        this.lastSuccessAt = now;
        this.consecutiveFailures = 0;
      } catch (err) {
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
      } catch (err) {
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
    };
    // FAILING beats STALLED: if requests are actively erroring, that is the
    // more specific and more actionable thing to say.
    if (this.consecutiveFailures >= this.opts.failingAfter) {
      return {
        ...base, state: "failing",
        detail: `${this.consecutiveFailures} consecutive request failures — last: ${this.lastError?.message ?? "unknown"}`,
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
    return { ...base, state: "running", detail: `last successful poll ${Math.round(age / 1000)}s ago` };
  }
}
