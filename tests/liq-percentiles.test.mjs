// tests/liq-percentiles.test.mjs — the pair-percentile table builder, and its
// PARITY against the bot's own copy of the same algorithm.
//
// `src/liq/percentiles.ts` is a deliberate byte-for-byte port of the bot's
// `src/liq/size-percentiles.ts` (`buildLiqSizePercentiles`). The contract
// this hub serves at `GET /api/hub/liq-percentiles` IS that function's
// output shape, so the two must never drift — this suite imports the BOT
// REPO'S OWN COMPILED MODULE directly (an absolute path outside this repo,
// dev-time only — nothing in `dist/` here depends on it) and asserts
// byte-identical JSON output on a shared, varied fixture.
import assert from "node:assert/strict";
import path from "node:path";
import { test, summary, tmpDir } from "./helpers.mjs";
import {
  buildLiqSizePercentiles, rebuildLiqPercentileTable, liqPercentileTableLooksValid,
  countLiqPercentilePairSides, LIQ_PCTL_STOPS, LIQ_PCTL_WINDOW_DAYS, LIQ_PCTL_MAX_PRINTS,
} from "../dist/src/liq/percentiles.js";
import { LiqHistory } from "../dist/src/liq/history.js";

const BOT_MODULE_PATH = "/home/user/liqhunter-private/dist/liq/size-percentiles.js";

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0xffffffff;
  };
}

/** A varied, deterministic fixture: several sources, several symbols, both
 *  sides, a spread of sample counts (some below the min-print floor, some
 *  well above the 1,000-print cap), and timestamps spanning outside and
 *  inside the 30-day window. */
function buildFixture(now) {
  const rnd = seededRandom(20260907);
  const rows = [];
  const sources = ["bybit-usdt", "bybit-usdc", "bybit-inverse", "binance-usdt", "okx-usdt"];
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BTCPERP"];
  const sides = ["long", "short"];
  for (const src of sources) {
    for (const symbol of symbols) {
      for (const side of sides) {
        // A varied population per key: some thin (5), some at the exact
        // min-print floor, some blowing well past the 1,000-print cap.
        const n = [5, 30, 1_200][Math.floor(rnd() * 3)];
        for (let i = 0; i < n; i++) {
          // Spread across ~25 days, inside the 30-day window, so the
          // 1,200-sample groups actually exercise the newest-1,000 cap
          // rather than being thinned by the window cutoff first.
          const ts = now - Math.floor(rnd() * 25 * 86_400_000);
          const sizeUsd = 50 + rnd() * 500_000;
          rows.push({ ts, src, symbol, side, sizeUsd });
        }
      }
    }
  }
  // A few rows worth refusing: bad side, zero/negative size, no symbol, and
  // one well outside the 30-day window.
  rows.push({ ts: now, src: "bybit-usdt", symbol: "BTCUSDT", side: "sideways", sizeUsd: 1_000 });
  rows.push({ ts: now, src: "bybit-usdt", symbol: "BTCUSDT", side: "long", sizeUsd: 0 });
  rows.push({ ts: now, src: "bybit-usdt", symbol: "", side: "long", sizeUsd: 100 });
  rows.push({ ts: now - 35 * 86_400_000, src: "bybit-usdt", symbol: "OUTOFWINDOWUSDT", side: "long", sizeUsd: 999_999 });
  return rows;
}

await test("buildLiqSizePercentiles is byte-identical to the bot's own copy", async () => {
  const bot = await import(BOT_MODULE_PATH);
  const now = Date.parse("2026-09-01T00:00:00Z");
  const rows = buildFixture(now);

  const hubTable = buildLiqSizePercentiles(rows, { now });
  const botTable = bot.buildLiqSizePercentiles(rows, { now });

  assert.deepEqual(hubTable, botTable, "identical output on an identical fixture");
  // The parity claim is only meaningful if the fixture actually exercised
  // every interesting branch — assert that, so a fixture that quietly
  // stopped generating rows cannot pass this suite vacuously.
  assert.equal(hubTable.windowDays, LIQ_PCTL_WINDOW_DAYS);
  assert.deepEqual(hubTable.stops, [...LIQ_PCTL_STOPS]);
  const pairSides = countLiqPercentilePairSides(hubTable);
  assert.ok(pairSides >= 5 * 4 * 2 - 2, `expected close to every (src,symbol,side) populated, got ${pairSides}`);
  // At least one row exercised the 1,000-print cap.
  let sawCapped = false;
  for (const bySymbol of Object.values(hubTable.rows)) {
    for (const bySide of Object.values(bySymbol)) {
      for (const r of Object.values(bySide)) if (r.count === LIQ_PCTL_MAX_PRINTS) sawCapped = true;
    }
  }
  assert.ok(sawCapped, "the fixture must exercise the newest-1000 cap for the parity check to mean anything");
  assert.ok(!hubTable.rows["bybit-usdt"]?.["OUTOFWINDOWUSDT"], "a row outside the 30-day window is excluded on both sides of the parity check");
});

await test("interpolation between stored stops matches nearest-rank on the exact stops", () => {
  // 100 evenly spaced sizes 1..100 — nearest-rank at p90 is exactly the 90th.
  const rows = Array.from({ length: 100 }, (_, i) => ({ ts: 1, src: "bybit-usdt", symbol: "BTCUSDT", side: "long", sizeUsd: i + 1 }));
  const table = buildLiqSizePercentiles(rows, { now: 1, days: 1 });
  const row = table.rows["bybit-usdt"]["BTCUSDT"]["long"];
  assert.equal(row.count, 100);
  assert.equal(row.usd[90], 90);
  assert.equal(row.usd[50], 50);
  assert.equal(row.usd[99], 99);
});

await test("a row outside the window, an unrecognised side, or a non-positive size is excluded", () => {
  const now = 100 * 86_400_000;
  const rows = [
    { ts: now - 40 * 86_400_000, src: "bybit-usdt", symbol: "BTCUSDT", side: "long", sizeUsd: 1_000 }, // too old
    { ts: now, src: "bybit-usdt", symbol: "BTCUSDT", side: "sideways", sizeUsd: 1_000 },
    { ts: now, src: "bybit-usdt", symbol: "BTCUSDT", side: "long", sizeUsd: -5 },
    { ts: now, src: "bybit-usdt", symbol: "", side: "long", sizeUsd: 5 },
  ];
  const table = buildLiqSizePercentiles(rows, { now });
  assert.deepEqual(table.rows, {}, "every row was excluded for its own stated reason");
});

await test("an absent src defaults to bybit-usdt, matching the recorder's own convention", () => {
  const table = buildLiqSizePercentiles([{ ts: 1, symbol: "BTCUSDT", side: "long", sizeUsd: 500 }], { now: 1, days: 1 });
  assert.ok(table.rows["bybit-usdt"], "an absent src bucketed under the historical default");
});

await test("liqPercentileTableLooksValid refuses a malformed shape", () => {
  assert.equal(liqPercentileTableLooksValid(null), false);
  assert.equal(liqPercentileTableLooksValid({}), false);
  assert.equal(liqPercentileTableLooksValid({ windowDays: 30, generatedAtMs: 1, stops: [50], rows: {} }), true);
  assert.equal(liqPercentileTableLooksValid({ windowDays: "30", generatedAtMs: 1, stops: [50], rows: {} }), false);
  assert.equal(liqPercentileTableLooksValid({ windowDays: 30, generatedAtMs: 1, stops: "nope", rows: {} }), false);
  assert.equal(liqPercentileTableLooksValid({ windowDays: 30, generatedAtMs: 1, stops: [50] }), false, "rows is required");
});

// ── rebuildLiqPercentileTable: the day-walk, newest-first, per-key cap ─────

await test("rebuildLiqPercentileTable reads day files newest-first and caps ingestion per (src,symbol,side) AS ROWS ARE READ", () => {
  const dir = tmpDir("liq-pctl-rebuild");
  const history = new LiqHistory(dir, 60);
  const now = Date.parse("2026-09-07T00:00:00Z");
  const DAY = 86_400_000;
  // Three days of BTCUSDT longs, 800/day = 2,400 total, far over the
  // 1,000-print cap. The kept rows must be the newest 1,000 — i.e. all of
  // day 3 (800) plus the newest 200 of day 2, and NONE of day 1, without
  // day 1 ever being opened (each day is a separate file; reading it would
  // still produce the right COUNT, but the point of the newest-first walk
  // is that it need not).
  for (let d = 0; d < 3; d++) {
    for (let i = 0; i < 800; i++) {
      history.record({ ts: now - d * DAY + i, src: "bybit-usdt", symbol: "BTCUSDT", side: "long", sizeUsd: 100 + i });
    }
  }
  history.flush();
  assert.equal(history.days().length, 3);

  const table = rebuildLiqPercentileTable(history, { now, maxPrints: 1_000, days: 30 });
  const row = table.rows["bybit-usdt"]["BTCUSDT"]["long"];
  assert.equal(row.count, 1_000, "capped at the newest 1,000 prints for this key");
});

await test("rebuildLiqPercentileTable never opens a day file entirely older than the window", () => {
  const dir = tmpDir("liq-pctl-rebuild-bound");
  const history = new LiqHistory(dir, 60);
  const DAY = 86_400_000;
  const now = 100 * DAY;
  history.record({ ts: now - 45 * DAY, src: "bybit-usdt", symbol: "OLDUSDT", side: "long", sizeUsd: 1_000 });
  history.record({ ts: now - 1 * DAY, src: "bybit-usdt", symbol: "NEWUSDT", side: "long", sizeUsd: 1_000 });
  history.flush();

  const table = rebuildLiqPercentileTable(history, { now, days: 30 });
  assert.ok(table.rows["bybit-usdt"]?.["NEWUSDT"], "the in-window pair is present");
  assert.ok(!table.rows["bybit-usdt"]?.["OLDUSDT"], "the pair whose only day file is outside the window is absent");
});

await test("rebuildLiqPercentileTable and buildLiqSizePercentiles agree on a shared fixture (same function, different entry)", () => {
  const dir = tmpDir("liq-pctl-agree");
  const history = new LiqHistory(dir, 60);
  const now = Date.parse("2026-09-07T00:00:00Z");
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const r = { ts: now - i * 3_600_000, src: "okx-usdt", symbol: "ETHUSDT", side: i % 2 ? "long" : "short", sizeUsd: 1_000 + i };
    rows.push(r);
    history.record(r);
  }
  history.flush();
  const viaHistory = rebuildLiqPercentileTable(history, { now, days: 30 });
  const viaRows = buildLiqSizePercentiles(rows, { now, days: 30 });
  assert.deepEqual(viaHistory.rows, viaRows.rows);
});

summary("liq-percentiles");
