// tests/marketcap-service.test.mjs
// THE PRODUCER, end to end, against stubbed providers — never a paid API.
//
// The properties here are the ones that only exist once the pure pieces are
// wired together, and every one of them is about a FAILURE:
//
//   · a catalogue that collapses must not be published, because a truncated
//     page and a mass delisting are the same bytes;
//   · a refused budget must stop the refresh rather than degrade it;
//   · an id the provider omits must become a fact, not a silence;
//   · nothing may throw into the timer, because an unhandled rejection inside a
//     periodic pass is process.exit(1) on a unit with Restart=always — a crash
//     loop that looks like anything except a crash loop.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { test, summary, tmpDir } from "./helpers.mjs";
import { MarketCapService, DEFAULT_EXCHANGE_SLUGS, DAY_MS, HOUR_MS } from "../dist/src/marketcap/service.js";
import { loadSigningKey, publicKeyRawB64u, verifySnapshot } from "../dist/src/marketcap/snapshot.js";
import { emptyLedger } from "../dist/src/marketcap/budget.js";

const NOW0 = Date.UTC(2026, 7, 24, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function signer(keyId = "market-data-1") {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString("base64url");
  return loadSigningKey(der, keyId);
}

/** One mutable world the stubs read, so a check can break one thing at a time. */
function world() {
  return {
    calls: [],
    instruments: [
      { symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", settleCoin: "USDT", status: "Trading", contractType: "LinearPerpetual" },
      { symbol: "1000PEPEUSDT", baseCoin: "1000PEPE", quoteCoin: "USDT", settleCoin: "USDT", status: "Trading", contractType: "LinearPerpetual" },
      { symbol: "NEWUSDT", baseCoin: "NEW", quoteCoin: "USDT", settleCoin: "USDT", status: "Trading", contractType: "LinearPerpetual" },
    ],
    /** Paged deliberately: one page is not a catalogue on this venue. */
    paged: true,
    pairs: [
      { market_pair: "BTC/USDT", market_pair_base: { exchange_symbol: "BTC", crypto_id: 1, currency_symbol: "BTC", currency_name: "Bitcoin" }, market_pair_quote: { exchange_symbol: "USDT" } },
      { market_pair: "1000PEPE/USDT", market_pair_base: { exchange_symbol: "1000PEPE", crypto_id: 24478, currency_symbol: "PEPE", currency_name: "Pepe" }, market_pair_quote: { exchange_symbol: "USDT" } },
    ],
    /** ids the quotes endpoint will answer for; anything else is skip_invalid'd. */
    quoteIds: [1, 24478],
    venueThrows: null,
    cmcThrows: null,
    now: NOW0,
  };
}

const QUOTE_ROWS = {
  1: { id: 1, symbol: "BTC", name: "Bitcoin", circulating_supply: 19_800_000, is_market_cap_included_in_calc: 1, quote: { USD: { price: 65_000, market_cap: 1_287_000_000_000 } } },
  24478: { id: 24478, symbol: "PEPE", name: "Pepe", circulating_supply: 420_690_000_000_000, is_market_cap_included_in_calc: 1, quote: { USD: { price: 0.00001, market_cap: 4_206_900_000 } } },
};

/** The stub provider, extracted so a check can WRAP it rather than restate it —
 *  a second copy of a fixture is a second thing to keep true. */
async function baseHttp(w, url) {
  w.calls.push(url);
  if (w.cmcThrows) throw new Error(w.cmcThrows);
  const u = new URL(url);
  if (u.pathname === "/v5/exchange/derivatives/list") {
    const start = Number(u.searchParams.get("start") ?? 1);
    return json({ status: { error_code: 0 }, data: start === 1 ? [{ id: 521, slug: "bybit", name: "Bybit" }] : [] });
  }
  if (u.pathname === "/v5/exchange/derivatives/market-pairs/list/latest") {
    const start = Number(u.searchParams.get("start") ?? 1);
    const page = start === 1 ? w.pairs : [];
    return json({ status: { error_code: 0 }, data: { num_market_pairs: w.pairs.length, market_pairs: page } });
  }
  if (u.pathname === "/v2/cryptocurrency/quotes/latest") {
    const asked = (u.searchParams.get("id") ?? "").split(",").map(Number);
    const data = {};
    for (const id of asked) {
      // skip_invalid: an id the provider does not answer for simply is not in
      // the response. That silence is the case the invariant catches.
      if (w.quoteIds.includes(id) && QUOTE_ROWS[id]) {
        data[id] = { ...QUOTE_ROWS[id], quote: { USD: { ...QUOTE_ROWS[id].quote.USD, last_updated: iso(w.now - 20_000) } } };
      }
    }
    return json({ status: { error_code: 0 }, data });
  }
  return json({ status: { error_code: 400, error_message: "unexpected path" } }, 400);
}

function makeService(w, over = {}, depsOver = {}) {
  const dir = tmpDir("marketcap");
  const cfg = {
    venues: ["bybit"],
    slugs: { ...DEFAULT_EXCHANGE_SLUGS },
    monthlyCeiling: 15_000,
    requestsPerMinute: 50,
    mappingIntervalMs: DAY_MS,
    capIntervalMs: HOUR_MS,
    tickMs: 30_000,
    ttlMs: 3 * HOUR_MS,
    snapshotFile: path.join(dir, "market-cap-snapshot-v1.json"),
    overridesFile: path.join(dir, "asset-identity-overrides-v1.json"),
    ledgerFile: path.join(dir, "market-cap-credits-v1.json"),
    quoteBatchSize: 100,
    ...over,
  };
  const sign = depsOver.signer ?? signer();
  const svc = new MarketCapService(cfg, {
    apiKey: "test-key",
    signer: sign,
    now: () => w.now,
    sleep: async () => {},
    log: () => {},
    http: (url) => baseHttp(w, url),
    venueFetch: async (url) => {
      w.calls.push(url);
      if (w.venueThrows) throw new Error(w.venueThrows);
      const u = new URL(url);
      const cursor = u.searchParams.get("cursor");
      if (!w.paged) return json({ result: { list: w.instruments, nextPageCursor: "" } });
      // Two pages: taking the first and stopping would silently truncate the
      // universe, which reads downstream as "those pairs no longer exist".
      return cursor
        ? json({ result: { list: w.instruments.slice(1), nextPageCursor: "" } })
        : json({ result: { list: w.instruments.slice(0, 1), nextPageCursor: "page2" } });
    },
    ...depsOver,
  });
  return { svc, cfg, dir, signer: sign };
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: { get: () => null } });

// ── 1. a whole pass ─────────────────────────────────────────────────────────

await test("one pass produces a signed, invariant-checked snapshot on disk", async () => {
  const w = world();
  const { svc, cfg, signer: sign } = makeService(w);
  await svc.tick();

  const served = svc.snapshot();
  assert.ok(served, "something must be servable after a successful pass");
  assert.equal(served.payload.coverage.invariantOk, true);
  assert.equal(served.payload.instruments.length, 3, "every ACTIVE instrument gets a row, mapped or not");
  assert.deepEqual(
    verifySnapshot(served.payload, { keys: { "market-data-1": publicKeyRawB64u(sign) }, now: w.now }),
    { ok: true },
  );

  // The file is what a restart reads, so it must parse and it must be the same
  // bytes the client was served.
  const onDisk = JSON.parse(fs.readFileSync(cfg.snapshotFile, "utf8"));
  assert.equal(JSON.stringify(onDisk), JSON.stringify(served.payload));
  assert.equal(fs.readdirSync(path.dirname(cfg.snapshotFile)).filter((f) => f.includes(".tmp.")).length, 0, "no temp file is left behind");

  // Both pages of the catalogue were read.
  assert.equal(w.calls.filter((c) => c.includes("instruments-info")).length, 2);

  const pepe = served.payload.instruments.find((r) => r.symbol === "1000PEPEUSDT");
  const btc = served.payload.instruments.find((r) => r.symbol === "BTCUSDT");
  assert.equal(pepe.cryptoId, 24478);
  assert.equal(pepe.marketCapUsd, "4206900000", "PEPE's own cap, unscaled by the x1000 contract size");
  assert.equal(btc.marketCapUsd, "1287000000000");
  const unmapped = served.payload.instruments.find((r) => r.symbol === "NEWUSDT");
  assert.equal(unmapped.identity, "provider_untracked");
  assert.ok(unmapped.reason);
});

await test("credits are charged per call, persisted, and reported on the payload", async () => {
  const w = world();
  const { svc, cfg } = makeService(w);
  await svc.tick();
  const h = svc.health();
  // 1 exchange-list + 1 pair-map page + 1 quotes batch (2 ids -> 1 credit).
  assert.equal(h.credits.used, 3);
  assert.equal(h.credits.ceiling, 15_000);
  assert.equal(h.credits.byKind.quotes, 1, "a 2-id batch is ONE credit — never one call per coin");
  const ledger = JSON.parse(fs.readFileSync(cfg.ledgerFile, "utf8"));
  assert.equal(ledger.used, 3, "the ledger survives a restart, so a crash loop cannot spend the month twice");
  assert.equal(svc.snapshot().payload.credits.used, 3);
});

await test("the provider's OWN credit figure outranks our estimate — upward only", async () => {
  const w = world();
  // Every response says it cost 5 credits; our model priced each call at 1. A
  // price list is the provider's to change, so the difference is charged.
  const { svc } = makeService(w, {}, {
    http: async (url) => {
      const base = await baseHttp(w, url);
      const body = await base.json();
      return { ...base, json: async () => ({ ...body, status: { ...(body.status ?? {}), error_code: 0, credit_count: 5 } }) };
    },
  });
  await svc.tick();
  // 3 calls at an estimated 1 each, reconciled to 5 each.
  assert.equal(svc.health().credits.used, 15);
  assert.ok(svc.health().errors.some((e) => e.stage === "budget" && /billed 5 credits/.test(e.message)),
    "and the operator is told, because a price list that moved changes what the month costs");

  // A LOWER figure refunds nothing: handing back budget on a number we cannot
  // audit is the direction that overspends.
  const w2 = world();
  const cheap = makeService(w2, {}, {
    http: async (url) => {
      const base = await baseHttp(w2, url);
      const body = await base.json();
      return { ...base, json: async () => ({ ...body, status: { ...(body.status ?? {}), error_code: 0, credit_count: 0 } }) };
    },
  });
  await cheap.svc.tick();
  assert.equal(cheap.svc.health().credits.used, 3, "our own estimate stands");
});

// ── 2. the omission ─────────────────────────────────────────────────────────

await test("an id the provider omits becomes a MISSING row with a reason, and is NAMED", async () => {
  const w = world();
  w.quoteIds = [1]; // PEPE is skip_invalid'd out of the batch
  const { svc } = makeService(w);
  await svc.tick();
  const p = svc.snapshot().payload;
  assert.equal(p.coverage.invariantOk, true, "the census still balances — that is the point of the explicit fact");
  assert.deepEqual(p.coverage.omittedIds, [24478], "the omitted id is NAMED, not merely counted");
  assert.equal(p.coverage.assets.missing, 1);
  assert.equal(p.coverage.assets.verified, 1);
  const pepe = p.instruments.find((r) => r.symbol === "1000PEPEUSDT");
  assert.equal(pepe.marketCapUsd, null);
  assert.equal(pepe.capStatus, "missing");
  assert.match(pepe.reason, /returned no row for it/);
});

// ── 3. last known good ──────────────────────────────────────────────────────

await test("a collapsed catalogue KEEPS the last good snapshot and emits ONE feed-health error", async () => {
  const w = world();
  const { svc } = makeService(w);
  await svc.tick();
  const first = svc.snapshot();
  assert.equal(first.payload.instruments.length, 3);

  // The venue answers one instrument out of three: a truncated page and a mass
  // delisting are indistinguishable, so neither is published.
  w.instruments = w.instruments.slice(0, 1);
  w.paged = false;
  w.now += DAY_MS + 1;
  await svc.tick();

  const after = svc.snapshot();
  assert.equal(after.payload.instruments.length, 3, "the previous universe keeps serving");
  assert.deepEqual(
    after.payload.instruments.map((r) => r.symbol).sort(),
    first.payload.instruments.map((r) => r.symbol).sort(),
    "the same pairs, from the last good catalogue — never a book two thirds of which reads delisted",
  );
  const errs = svc.health().errors.filter((e) => e.stage === "mapping");
  assert.equal(errs.length, 1, "ONE error, not one per row");
  assert.match(errs[0].message, /catalogue collapsed: 1 active instruments against 3/);
  assert.match(errs[0].message, /keeping the previous catalogue/);
});

await test("a pair map that fails, or comes back short, keeps the previous map", async () => {
  const w = world();
  const { svc } = makeService(w);
  await svc.tick();
  const mapped = svc.snapshot().payload.coverage.instruments.mapped;
  assert.equal(mapped, 2);

  // The provider's own count says 2 and the page carries 0 — a short read looks
  // exactly like a shrinking exchange, and only that comparison tells them apart.
  const real = w.pairs;
  w.pairs = [];
  w.now += DAY_MS + 1;
  await svc.tick();
  assert.equal(svc.snapshot().payload.coverage.instruments.mapped, 2, "yesterday's map still resolves every pair");
  assert.match(svc.health().errors[0].message, /keeping the previous map/);
  w.pairs = real;
});

await test("a provider outage never publishes a book of unmapped pairs", async () => {
  const w = world();
  const { svc } = makeService(w);
  await svc.tick();
  const before = svc.snapshot().payload.coverage.instruments.mapped;

  w.cmcThrows = "ECONNRESET";
  w.now += DAY_MS + 1;
  await svc.tick();
  assert.equal(svc.snapshot().payload.coverage.instruments.mapped, before);
  assert.ok(svc.health().errors.length > 0, "the outage is reported rather than absorbed");
});

// ── 4. the budget refusal ───────────────────────────────────────────────────

await test("a refresh that would cross the ceiling makes NO calls at all", async () => {
  const w = world();
  const { svc } = makeService(w, { monthlyCeiling: 2 });
  svc.__setStateForTests({ ledger: { ...emptyLedger(w.now), used: 2 } });
  await svc.tick();
  assert.equal(w.calls.filter((c) => c.includes("coinmarketcap")).length, 0, "the provider is not called at all");
  assert.equal(svc.snapshot(), null, "and nothing is published on the strength of a partial fetch");
  const budget = svc.health().errors.filter((e) => e.stage === "budget");
  assert.ok(budget.length >= 1);
  assert.match(budget[0].message, /refusing to start a refresh/);
  assert.equal(svc.health().credits.refusals >= 1, true, "the refusal is counted, not merely logged");
});

// ── 5. the unseen symbol ────────────────────────────────────────────────────

await test("an unseen symbol queues a TARGETED re-map, never a sweep", async () => {
  const w = world();
  const { svc } = makeService(w);
  await svc.tick();
  assert.equal(svc.health().pendingRetries, 0, "the first catalogue has no 'new' symbols — everything is new");

  // A listing appears. The provider does not know it yet.
  w.instruments.push({ symbol: "FRESHUSDT", baseCoin: "FRESH", quoteCoin: "USDT", settleCoin: "USDT", status: "Trading", contractType: "LinearPerpetual" });
  w.now += DAY_MS + 1;
  await svc.tick();
  assert.equal(svc.health().pendingRetries, 1, "one symbol, queued");

  const before = w.calls.length;
  w.now += 61_000; // the first rung of the retry ladder
  w.pairs = [...w.pairs, { market_pair: "FRESH/USDT", market_pair_base: { exchange_symbol: "FRESH", crypto_id: 9999, currency_symbol: "FRESH", currency_name: "Fresh" }, market_pair_quote: { exchange_symbol: "USDT" } }];
  await svc.tick();
  const newCalls = w.calls.slice(before);
  assert.equal(newCalls.filter((c) => c.includes("instruments-info")).length, 0, "a targeted re-map does not re-read catalogues");
  assert.equal(newCalls.filter((c) => c.includes("market-pairs")).length, 1, "ONE exchange's pair map, not four");
  assert.equal(svc.health().pendingRetries, 0, "and the symbol leaves the queue once it maps");
  assert.equal(svc.snapshot().payload.instruments.find((r) => r.symbol === "FRESHUSDT").cryptoId, 9999);
});

// ── 6. nothing throws into a timer ──────────────────────────────────────────

await test("every provider and venue failure is contained; the pass RESOLVES", async () => {
  const w = world();
  w.venueThrows = "venue down";
  w.cmcThrows = "provider down";
  const { svc } = makeService(w);
  // The pass must not reject. Inside setInterval an unhandled rejection is
  // process.exit(1), and on a unit with Restart=always that is a crash loop
  // whose symptom is anything but a crash.
  await svc.tick();
  assert.equal(svc.snapshot(), null, "nothing was published, because nothing was fetched");
  assert.ok(svc.health().errors.length >= 2, "and both failures are on the record");
  // A second pass with everything healthy recovers with no restart.
  w.venueThrows = null;
  w.cmcThrows = null;
  w.now += DAY_MS + 1;
  await svc.tick();
  assert.ok(svc.snapshot(), "the producer recovers on its own");
});

await test("a hub whose producer is off does nothing and says nothing", async () => {
  const w = world();
  const { svc } = makeService(w, { venues: [] });
  assert.equal(svc.enabled, false);
  svc.start();
  await svc.tick();
  assert.equal(w.calls.length, 0, "an unconfigured producer never spends a credit");
});

// ── 7. restart ──────────────────────────────────────────────────────────────

await test("a restart serves the same bytes it was serving a second earlier", async () => {
  const w = world();
  const first = makeService(w);
  await first.svc.tick();
  const before = first.svc.snapshot();

  // Same files, new process.
  const second = new MarketCapService(first.cfg, {
    apiKey: "test-key", signer: first.signer, now: () => w.now, sleep: async () => {}, log: () => {},
    http: async () => json({}), venueFetch: async () => json({}),
  });
  const after = second.snapshot();
  assert.ok(after, "a producer that came back with nothing looks like one that never had anything");
  assert.equal(after.etag, before.etag);
  assert.equal(second.health().credits.used, 3, "and the credit ledger came back with it");
});

summary("marketcap-service");
