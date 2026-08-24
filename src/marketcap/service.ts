// src/marketcap/service.ts
// THE PRODUCER. Owns the schedule, the credit ledger, the last-known-good
// snapshot, and the one rule that outranks all of them: a snapshot is
// published WHOLE AND VALIDATED, or the previous one keeps serving.
//
// ── THE PUBLISH SEQUENCE, AND WHY IT IS IN THIS ORDER ───────────────────────
//   1. fetch EVERY page of every catalogue and every pair map
//   2. validate the shapes (the parsers drop unusable rows and COUNT them)
//   3. compare each catalogue against the last good one — a collapse or an
//      identity change is refused, because a truncated page and a mass
//      delisting are the same bytes
//   4. build a row for EVERY active instrument, mapped or not
//   5. check both coverage invariants
//   6. only then sign, write tmp+fsync+rename, and swap the served pointer
//
// Any step failing leaves the previous snapshot exactly where it was and emits
// ONE feed-health error. The failure this ordering exists to prevent is the
// quiet one: a half-fetched map published as a whole one, making hundreds of
// live pairs look unmapped, on a screen where "unmapped" and "the provider is
// down" are indistinguishable.
//
// ── NOTHING THROWS INTO A TIMER ─────────────────────────────────────────────
// Every timer callback is `void this.guarded(...)`, and `guarded` catches. The
// candle service does the same, and the bot repo records what the alternative
// costs: an unhandled rejection inside a periodic pass is `process.exit(1)`,
// which on a systemd unit with `Restart=always` is a crash loop that looks like
// anything except a crash loop.
import type { FetchLike, VenueId } from "../candles/venues.js";
import {
  AGREED_SCHEDULE, charge, creditsForQuoteCall, emptyLedger, monthKey, nextCallDelayMs, noteRefusal,
  planRefresh, QUOTE_BATCH_SIZE, rolled, type CallKind, type CreditLedger,
} from "./budget.js";
import { acceptCmcQuote, capCensus, missingForOmittedId, omittedIds, type CapFact } from "./caps.js";
import { batchIds, fetchDerivativeExchanges, fetchDerivativePairs, fetchQuotes, isProviderRefusal, type FetchDeps, type HttpLike } from "./cmc.js";
import { CoinGeckoFallback } from "./coingecko.js";
import { catalogueSanity, fetchInstruments } from "./exchanges.js";
import { buildPairIndex, resolveUniverse, type ExchangeInstrument, type ProviderPair } from "./identity.js";
import { buildSnapshot, signSnapshot, type SignerKey, type SnapshotSigned } from "./snapshot.js";
import { MarketCapStore } from "./store.js";
import { createHash } from "node:crypto";

/** The provider's slug for each venue we serve. EXPECTED, and VALIDATED at run
 *  time against the provider's own exchange list — never hard-coded forever. A
 *  slug that silently stops matching turns one venue's entire book into
 *  `provider_untracked`, which reads exactly like a provider outage. */
export const DEFAULT_EXCHANGE_SLUGS: Record<VenueId, string> = {
  bybit: "bybit",
  aster: "aster-pro",
  bitget: "bitget",
  bitunix: "bitunix",
};

export const DAY_MS = 24 * 3_600_000;
export const HOUR_MS = 3_600_000;

/** Per-symbol retry ladder for a listing the provider has not mapped yet.
 *  PER SYMBOL, never a sweep: the retry exists for the one pair that just
 *  listed, and re-mapping four exchanges because of it is the overspend the
 *  whole schedule was rebuilt to avoid. */
export const NEW_SYMBOL_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface MarketCapConfig {
  /** Venues to cover. EMPTY = the service is off and says so, exactly like the
   *  candle collectors: this one spends real money per call, so it is an
   *  operator action and never something an upgrade starts doing. */
  venues: VenueId[];
  slugs: Record<VenueId, string>;
  monthlyCeiling: number;
  requestsPerMinute: number;
  mappingIntervalMs: number;
  capIntervalMs: number;
  tickMs: number;
  /** How long a published snapshot stays usable. */
  ttlMs: number;
  snapshotFile: string;
  overridesFile: string;
  ledgerFile: string;
  quoteBatchSize: number;
}

export interface MarketCapDeps {
  http: HttpLike;
  apiKey: string;
  /** The venues' own public endpoints; the candle service's fetch shape. */
  venueFetch: FetchLike;
  signer: SignerKey;
  gecko?: CoinGeckoFallback;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface FeedHealthEvent {
  at: number;
  stage: "mapping" | "caps" | "publish" | "budget";
  message: string;
}

export interface MarketCapHealth {
  enabled: boolean;
  venues: VenueId[];
  slugs: Record<string, { slug: string; validated: boolean; pairs: number }>;
  lastMappingAt: number | null;
  lastCapsAt: number | null;
  lastPublishAt: number | null;
  published: { generatedAt: number; expiresAt: number; instruments: number; assets: number; invariantOk: boolean } | null;
  credits: CreditLedger & { ceiling: number };
  /** Newest first, bounded. The invariant failure is emitted here ONCE per
   *  attempt rather than per row — a per-row log of a systemic failure is how a
   *  systemic failure gets skimmed past. */
  errors: FeedHealthEvent[];
  pendingRetries: number;
}

interface RetryEntry {
  venue: VenueId;
  symbol: string;
  attempts: number;
  nextAt: number;
}

const MAX_ERRORS = 20;

export class MarketCapService {
  private readonly store: MarketCapStore;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  private readonly gecko: CoinGeckoFallback;

  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  /** LAST GOOD, per venue. Never replaced by a catalogue that failed sanity. */
  private catalogues = new Map<VenueId, ExchangeInstrument[]>();
  private pairs = new Map<VenueId, ProviderPair[]>();
  private pairPages = new Map<VenueId, number>();
  private validatedSlugs = new Set<string>();
  private capFacts = new Map<number, CapFact>();
  private lastRequestedIds: number[] = [];
  private capOmissions: number[] = [];

  private lastMappingAt: number | null = null;
  private lastCapsAt: number | null = null;
  private lastPublishAt: number | null = null;
  private lastExchangeListAt = 0;

  private ledger: CreditLedger;
  private callTimes: number[] = [];
  private retries = new Map<string, RetryEntry>();
  private errors: FeedHealthEvent[] = [];

  private published: SnapshotSigned | null = null;
  private publishedEtag: string | null = null;
  private publishedBody: Buffer | null = null;

  constructor(private readonly cfg: MarketCapConfig, private readonly deps: MarketCapDeps) {
    this.store = new MarketCapStore(cfg.snapshotFile, cfg.overridesFile, cfg.ledgerFile);
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? ((m) => console.log(`[marketcap] ${m}`));
    this.gecko = deps.gecko ?? new CoinGeckoFallback(null);
    this.ledger = this.store.readLedger(this.now());
    // The last published snapshot is adopted at construction, so a restart
    // serves the same bytes it was serving a second earlier — a producer that
    // came back with nothing would look, to a client, exactly like a producer
    // that never had anything.
    const prior = this.store.readSnapshot();
    if (prior) this.adopt(prior);
  }

  get enabled(): boolean {
    return this.cfg.venues.length > 0 && !!this.deps.apiKey;
  }

  start(): void {
    if (this.timer || !this.enabled) return;
    this.timer = setInterval(() => void this.guardedTick(), this.cfg.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The served payload, its ETag, and its bytes. Null until something has
   *  been published — and a null is a 503 at the route, never a 200 with an
   *  empty body, for the reason the candle seed never answers 200 with empty
   *  rows: "I have nothing" and "there is nothing" must not be one answer. */
  snapshot(): { payload: SnapshotSigned; etag: string; body: Buffer } | null {
    if (!this.published || !this.publishedEtag || !this.publishedBody) return null;
    return { payload: this.published, etag: this.publishedEtag, body: this.publishedBody };
  }

  health(): MarketCapHealth {
    const slugs: MarketCapHealth["slugs"] = {};
    for (const v of this.cfg.venues) {
      const slug = this.cfg.slugs[v];
      slugs[v] = { slug, validated: this.validatedSlugs.has(slug), pairs: this.pairs.get(v)?.length ?? 0 };
    }
    return {
      enabled: this.enabled,
      venues: [...this.cfg.venues],
      slugs,
      lastMappingAt: this.lastMappingAt,
      lastCapsAt: this.lastCapsAt,
      lastPublishAt: this.lastPublishAt,
      published: this.published
        ? {
          generatedAt: this.published.generatedAt,
          expiresAt: this.published.expiresAt,
          instruments: this.published.instruments.length,
          assets: this.published.assets.length,
          invariantOk: this.published.coverage.invariantOk,
        }
        : null,
      credits: { ...rolled(this.ledger, this.now()), ceiling: this.cfg.monthlyCeiling },
      errors: [...this.errors],
      pendingRetries: this.retries.size,
    };
  }

  /** ONE PASS. Public so a suite can drive it without a timer; the timer only
   *  ever calls the guarded wrapper. */
  async tick(): Promise<void> {
    if (!this.enabled || this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      let changed = false;
      if (this.lastMappingAt === null || now - this.lastMappingAt >= this.cfg.mappingIntervalMs) {
        changed = (await this.refreshMapping()) || changed;
      } else if (this.dueRetry(now)) {
        changed = (await this.runRetry(now)) || changed;
      }
      if (this.lastCapsAt === null || now - this.lastCapsAt >= this.cfg.capIntervalMs) {
        changed = (await this.refreshCaps()) || changed;
      }
      // Republish when something moved, or when what we serve has expired —
      // an expired snapshot with a healthy producer behind it is a client
      // refusing perfectly good data because nobody restamped it.
      if (changed || (this.published && this.now() > this.published.expiresAt - this.cfg.tickMs)) {
        this.publish();
      }
    } finally {
      this.busy = false;
    }
  }

  private async guardedTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      // The last line of defence. Every stage below already catches its own
      // failures; this exists so that a bug in the SCHEDULER cannot become an
      // unhandled rejection inside setInterval.
      this.noteError("publish", `unexpected error in the market-cap pass: ${(err as Error).message}`);
    }
  }

  // ── stage 1: identity ─────────────────────────────────────────────────────

  /** Refresh every catalogue and every pair map. Returns true when anything
   *  usable changed. NEVER THROWS. */
  async refreshMapping(): Promise<boolean> {
    const now = this.now();
    const venues = this.cfg.venues;
    // The plan is priced on what it will ACTUALLY cost, using last run's page
    // counts, before a single call is made.
    const listCost = now - this.lastExchangeListAt >= DAY_MS ? 2 : 0;
    const pairCost = venues.reduce((n, v) => n + (this.pairPages.get(v) ?? AGREED_SCHEDULE.pairPagesPerExchange), 0);
    const decision = planRefresh(this.ledger, listCost + pairCost, this.cfg.monthlyCeiling, now);
    if (!decision.allowed) {
      this.ledger = noteRefusal(this.ledger, decision.reason!, now);
      this.persistLedger();
      this.noteError("budget", decision.reason!);
      return false;
    }

    let changed = false;
    // Slug validation first, and its failure is NOT fatal: the provider's
    // exchange directory being unreachable must not stop us re-reading pair
    // maps that are keyed on slugs we already validated yesterday.
    if (listCost) {
      try {
        const list = await fetchDerivativeExchanges(this.fetchDeps());
        if (list.length) {
          this.validatedSlugs = new Set(list.map((e) => e.slug));
          this.lastExchangeListAt = now;
          for (const v of venues) {
            if (!this.validatedSlugs.has(this.cfg.slugs[v])) {
              this.noteError("mapping", `the provider's derivative exchange list does not contain slug "${this.cfg.slugs[v]}" for ${v} — every ${v} pair will read provider_untracked until this is corrected`);
            }
          }
        }
      } catch (err) {
        this.noteError("mapping", `could not read the provider's derivative exchange list: ${(err as Error).message}`);
      }
    }

    for (const venue of venues) {
      // The exchange's own catalogue. Its failure is per venue: one venue's
      // outage may not blank the other three.
      try {
        const cat = await fetchInstruments(venue, this.deps.venueFetch);
        const verdict = catalogueSanity(this.catalogues.get(venue) ?? null, cat.instruments);
        if (!verdict.ok) {
          this.noteError("mapping", `${venue}: ${verdict.reason} — keeping the previous catalogue`);
        } else {
          const before = new Set((this.catalogues.get(venue) ?? []).map((i) => i.symbol));
          this.catalogues.set(venue, cat.instruments);
          changed = true;
          if (cat.unparsed) this.noteError("mapping", `${venue}: ${cat.unparsed} instrument row(s) could not be parsed`);
          // UNSEEN SYMBOLS get a targeted re-map, not a sweep.
          for (const i of cat.instruments) {
            if (i.active && before.size && !before.has(i.symbol)) this.queueRetry(venue, i.symbol, now);
          }
        }
      } catch (err) {
        this.noteError("mapping", `${venue}: instrument catalogue fetch failed: ${(err as Error).message} — keeping the previous one`);
      }

      if ((await this.refreshPairsFor(venue)) === true) changed = true;
    }

    this.lastMappingAt = now;
    return changed;
  }

  /** ONE exchange's pair map. Also the targeted-refresh path, which is why it
   *  is its own method: an unseen symbol costs one exchange's pages and not a
   *  full re-map. */
  private async refreshPairsFor(venue: VenueId): Promise<boolean> {
    const slug = this.cfg.slugs[venue];
    try {
      const r = await fetchDerivativePairs(this.fetchDeps(), slug);
      if (!r.pairs.length) {
        this.noteError("mapping", `${venue}: the provider returned no derivative pairs for slug "${slug}" — keeping the previous map`);
        return false;
      }
      // The venue's own count is free evidence that the paging loop finished.
      // A short read looks exactly like a shrinking exchange, and only this
      // comparison tells them apart.
      if (r.expected !== null && r.pairs.length < r.expected * 0.9) {
        this.noteError("mapping", `${venue}: read ${r.pairs.length} pair rows against the provider's own count of ${r.expected} — keeping the previous map rather than publishing a short one`);
        return false;
      }
      this.pairs.set(venue, r.pairs);
      this.pairPages.set(venue, r.pages);
      return true;
    } catch (err) {
      const refusal = isProviderRefusal(err) ? " (the provider refused — not retried this pass)" : "";
      this.noteError("mapping", `${venue}: pair map fetch failed: ${(err as Error).message}${refusal} — keeping the previous map`);
      return false;
    }
  }

  // ── stage 2: caps ─────────────────────────────────────────────────────────

  /** Fetch caps for every id the current mapping proves. NEVER THROWS. */
  async refreshCaps(): Promise<boolean> {
    const now = this.now();
    const { mappedIds } = this.resolveNow();
    if (!mappedIds.length) {
      this.lastCapsAt = now;
      return false;
    }
    const planned = creditsForQuoteCall(mappedIds.length);
    const decision = planRefresh(this.ledger, planned, this.cfg.monthlyCeiling, now);
    if (!decision.allowed) {
      this.ledger = noteRefusal(this.ledger, decision.reason!, now);
      this.persistLedger();
      this.noteError("budget", decision.reason!);
      return false;
    }

    const facts = new Map<number, CapFact>();
    const missingIds: number[] = [];
    let failed = false;
    for (const batch of batchIds(mappedIds, this.cfg.quoteBatchSize)) {
      try {
        const receivedAt = this.now();
        const { quotes, returnedIds } = await fetchQuotes(this.fetchDeps(), batch);
        for (const id of batch) {
          const q = quotes.get(id);
          if (!q) continue;
          facts.set(id, acceptCmcQuote(q, { receivedAt, identityProven: true }));
        }
        // ── THE OMISSION, MADE EXPLICIT ────────────────────────────────────
        // `skip_invalid=true` makes a batch succeed while silently dropping
        // rows. Every id we asked for and did not get back becomes a `missing`
        // FACT with a reason, so the coverage invariant still balances and an
        // operator can see WHICH listing the provider does not know about.
        for (const id of omittedIds(batch, returnedIds)) {
          facts.set(id, missingForOmittedId(id, receivedAt));
          missingIds.push(id);
        }
      } catch (err) {
        failed = true;
        this.noteError("caps", `quote batch of ${batch.length} id(s) failed: ${(err as Error).message}`);
        // A FAILED BATCH IS NOT A BATCH OF MISSING ASSETS. Recording it as
        // `missing` would publish "these coins have no market cap" on the
        // strength of one HTTP error. The previous facts for those ids stay,
        // and the snapshot below reuses them.
        for (const id of batch) {
          const prior = this.capFacts.get(id);
          if (prior) facts.set(id, prior);
        }
      }
    }

    // The optional secondary provider fills ABSENCES only — never a disputed
    // or stale row, which are answers we already have and disbelieve.
    const gaps = mappedIds.filter((id) => (facts.get(id)?.status ?? "missing") === "missing");
    if (gaps.length && this.gecko.enabled) {
      try {
        const fallback = await this.gecko.fetchFallbackCaps(gaps, this.now());
        for (const [id, fact] of fallback) if (fact.status === "fallback") facts.set(id, fact);
      } catch (err) {
        this.noteError("caps", `fallback provider failed: ${(err as Error).message}`);
      }
    }

    // Every requested id ends the pass holding exactly one verdict. Without
    // this line a batch that threw before producing anything would leave an id
    // with no fact at all, and the invariant would fail on a producer bug that
    // has nothing to do with the provider.
    for (const id of mappedIds) {
      if (!facts.has(id)) facts.set(id, missingForOmittedId(id, now, "the batch carrying this id failed and no earlier fact exists"));
    }

    this.capFacts = facts;
    this.lastRequestedIds = mappedIds;
    this.capOmissions = [...new Set(missingIds)].sort((a, b) => a - b);
    this.lastCapsAt = now;
    // The fact set was REPLACED, so there is something new to publish even when
    // a batch failed — the failed ids kept their previous verdicts and the rest
    // moved. `failed` is already on the record as a feed-health error.
    void failed;
    return true;
  }

  // ── stage 3: publish ──────────────────────────────────────────────────────

  private resolveNow(): ReturnType<typeof resolveUniverse> {
    const instruments: ExchangeInstrument[] = [];
    for (const v of this.cfg.venues) instruments.push(...(this.catalogues.get(v) ?? []));
    const allPairs: ProviderPair[] = [];
    for (const v of this.cfg.venues) allPairs.push(...(this.pairs.get(v) ?? []));
    return resolveUniverse(instruments, {
      slugOf: (v) => this.cfg.slugs[v] ?? null,
      index: buildPairIndex(allPairs),
      // Read fresh on every publish: an operator adding an override to fix a
      // wrong mapping must not have to restart the hub to apply it.
      overrides: this.store.readOverrides(),
    });
  }

  /** Build, validate, sign, write, swap. Returns true when it published. */
  publish(): boolean {
    const now = this.now();
    const { rows, census, mappedIds } = this.resolveNow();
    if (!rows.length) return false;
    const requested = this.lastRequestedIds.length ? this.lastRequestedIds : mappedIds;
    const facts = new Map<number, CapFact>();
    for (const id of requested) {
      const f = this.capFacts.get(id);
      if (f) facts.set(id, f);
    }
    // A mapped id with no fact at all — the mapping moved since the last cap
    // pass. Reported as `missing` with the reason, never left absent: an absent
    // id would fail the invariant and lose the whole snapshot over a listing
    // that is 55 minutes from its first cap.
    for (const id of mappedIds) {
      if (!facts.has(id)) facts.set(id, missingForOmittedId(id, now, "this asset was mapped after the last cap refresh and has not been priced yet"));
    }
    const built = buildSnapshot({
      now,
      ttlMs: this.cfg.ttlMs,
      keyId: this.deps.signer.keyId,
      identityRows: rows,
      identityCensus: census,
      capFacts: facts,
      capCensus: capCensus([...facts.keys()], [...facts.values()]),
      omittedIds: this.capOmissions,
      sources: {
        caps: { provider: "coinmarketcap", fetchedAt: this.lastCapsAt ?? 0 },
        pairMap: {
          provider: "coinmarketcap",
          fetchedAt: this.lastMappingAt ?? 0,
          exchanges: this.cfg.venues.map((v) => ({ venue: v, slug: this.cfg.slugs[v], pairs: this.pairs.get(v)?.length ?? 0 })),
        },
      },
      credits: {
        month: monthKey(now),
        used: rolled(this.ledger, now).used,
        ceiling: this.cfg.monthlyCeiling,
        refusals: rolled(this.ledger, now).refusals,
      },
    });
    if (!built.ok) {
      // ONE error, and the previous snapshot keeps serving. Publishing a
      // snapshot whose own census does not add up is the failure this service
      // exists to make impossible.
      this.noteError("publish", `${built.error} — keeping the last known good snapshot`);
      return false;
    }
    const signed = signSnapshot(built.snapshot, this.deps.signer);
    try {
      this.store.writeSnapshot(signed);
    } catch (err) {
      // The bytes could not be made durable. The IN-MEMORY swap is skipped too,
      // deliberately: serving a snapshot we could not persist means a restart
      // silently reverts to an older one with nothing saying why.
      this.noteError("publish", `could not write the snapshot file: ${(err as Error).message}`);
      return false;
    }
    this.adopt(signed);
    this.lastPublishAt = now;
    this.log(`published ${signed.instruments.length} instruments / ${signed.assets.length} assets`
      + ` (${signed.coverage.instruments.mapped} mapped, ${signed.coverage.assets.verified} verified)`);
    return true;
  }

  private adopt(snapshot: SnapshotSigned): void {
    this.published = snapshot;
    this.publishedBody = Buffer.from(JSON.stringify(snapshot), "utf8");
    // The ETag is over the SERVED BYTES, so a client that gets a 304 has
    // exactly what a 200 would have handed it.
    this.publishedEtag = `"${createHash("sha256").update(this.publishedBody).digest("base64url").slice(0, 32)}"`;
  }

  // ── the unseen-symbol retry ───────────────────────────────────────────────

  /** Record a symbol whose identity we could not resolve, for a targeted
   *  re-map. Public so the route/admin can nudge one in. */
  queueRetry(venue: VenueId, symbol: string, now: number): void {
    const key = `${venue}:${symbol}`;
    if (this.retries.has(key)) return;
    this.retries.set(key, { venue, symbol, attempts: 0, nextAt: now + NEW_SYMBOL_RETRY_MS[0]! });
  }

  private dueRetry(now: number): boolean {
    for (const e of this.retries.values()) if (e.nextAt <= now) return true;
    return false;
  }

  private async runRetry(now: number): Promise<boolean> {
    // ONE per pass, and one EXCHANGE per retry. Ten new listings on one venue
    // must not become ten full pair-map reads.
    let pick: RetryEntry | null = null;
    for (const e of this.retries.values()) {
      if (e.nextAt <= now && (!pick || e.nextAt < pick.nextAt)) pick = e;
    }
    if (!pick) return false;
    const key = `${pick.venue}:${pick.symbol}`;
    const cost = this.pairPages.get(pick.venue) ?? AGREED_SCHEDULE.pairPagesPerExchange;
    const decision = planRefresh(this.ledger, cost, this.cfg.monthlyCeiling, now);
    if (!decision.allowed) {
      this.ledger = noteRefusal(this.ledger, decision.reason!, now);
      this.persistLedger();
      this.noteError("budget", decision.reason!);
      return false;
    }
    const changed = await this.refreshPairsFor(pick.venue);
    // Every symbol on that venue that was waiting has now had its chance, so
    // they all advance together — otherwise ten listings on one venue would
    // each pay for the same re-map in turn.
    for (const [k, e] of this.retries) {
      if (e.venue !== pick.venue || e.nextAt > now) continue;
      const resolved = changed && this.isMapped(e.venue, e.symbol);
      const attempts = e.attempts + 1;
      if (resolved || attempts >= NEW_SYMBOL_RETRY_MS.length) {
        // Giving up is not a silent event: an unmapped listing stays in the
        // snapshot as `provider_untracked` WITH ITS REASON, which is where an
        // operator sees it and writes an override.
        this.retries.delete(k);
      } else {
        this.retries.set(k, { ...e, attempts, nextAt: now + NEW_SYMBOL_RETRY_MS[attempts]! });
      }
    }
    return changed;
  }

  private isMapped(venue: VenueId, symbol: string): boolean {
    const inst = (this.catalogues.get(venue) ?? []).find((i) => i.symbol === symbol);
    if (!inst) return true; // it went away again; nothing left to map
    const { rows } = resolveUniverse([inst], {
      slugOf: (v) => this.cfg.slugs[v] ?? null,
      index: buildPairIndex(this.pairs.get(venue) ?? []),
      overrides: this.store.readOverrides(),
    });
    return rows[0]?.state === "mapped";
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  /** The credit + rate gate every provider call goes through. Charged BEFORE
   *  the request (v0.79.1's reservation rule: a budget checked after the await
   *  is a budget several concurrent callers all pass), and never refunded —
   *  the provider does not refund a call it answered with an error either. */
  private fetchDeps(): FetchDeps {
    return {
      http: this.deps.http,
      apiKey: this.deps.apiKey,
      spend: async (kind: CallKind, credits: number) => {
        const now = this.now();
        const delay = nextCallDelayMs(this.callTimes, this.cfg.requestsPerMinute, now);
        if (delay > 0) await this.sleep(delay);
        const at = this.now();
        this.callTimes = [...this.callTimes.filter((t) => at - t < 60_000), at];
        this.ledger = charge(this.ledger, kind, credits, at);
        this.persistLedger();
      },
    };
  }

  private persistLedger(): void {
    try {
      this.store.writeLedger(this.ledger);
    } catch (err) {
      // A ledger we cannot persist still governs THIS process; losing it across
      // a restart would let a crash loop spend the month twice, so it is worth
      // an error line even though nothing else stops.
      this.noteError("budget", `could not persist the credit ledger: ${(err as Error).message}`);
    }
  }

  private noteError(stage: FeedHealthEvent["stage"], message: string): void {
    const ev: FeedHealthEvent = { at: this.now(), stage, message };
    this.errors = [ev, ...this.errors].slice(0, MAX_ERRORS);
    this.log(`${stage}: ${message}`);
  }

  /** Test seam: install a starting state without a network. Deliberately named
   *  for what it is rather than hidden behind a cast — `as unknown as` is how a
   *  defect becomes invisible to the compiler (the bot repo's v0.76.5). */
  __setStateForTests(state: {
    catalogues?: Map<VenueId, ExchangeInstrument[]>;
    pairs?: Map<VenueId, ProviderPair[]>;
    capFacts?: Map<number, CapFact>;
    requestedIds?: number[];
    ledger?: CreditLedger;
  }): void {
    if (state.catalogues) this.catalogues = state.catalogues;
    if (state.pairs) this.pairs = state.pairs;
    if (state.capFacts) this.capFacts = state.capFacts;
    if (state.requestedIds) this.lastRequestedIds = state.requestedIds;
    if (state.ledger) this.ledger = state.ledger;
  }
}

/** A fresh ledger, for a caller building a service by hand. */
export function defaultLedger(now: number): CreditLedger {
  return emptyLedger(now);
}

export { QUOTE_BATCH_SIZE };
