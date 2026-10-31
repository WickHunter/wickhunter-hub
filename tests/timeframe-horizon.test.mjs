// v0.4.103 — the standing long timeframe horizon: config, per-interval
// retention, month files, incremental gap cursors, two-proof venue-empty
// floors, the off-thread long-window path, venue adapter fixes, admin health,
// and the byte-identical <=60-day (Beta) contract.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { test, summary, tmpDir, freshHub } from "./helpers.mjs";
import { CandleStore, MINUTE_MS } from "../dist/src/candles/store.js";
import { VenueCollector, DEFAULT_COLLECTOR_OPTIONS, VENUE_EMPTY_CONFIRM_GAP_MS, VENUE_EMPTY_RECHECK_MS } from "../dist/src/candles/collector.js";
import {
  TimeframeHistory, TimeframeStore, parseTimeframeHorizon, buildTimeframeLong, signedTimeframeBody, canonicalTimeframeBytes,
  HORIZON_EMPTY_CONFIRM_GAP_MS, HORIZON_EMPTY_RECHECK_MS, HORIZON_RETRY_MS,
} from "../dist/src/candles/timeframe.js";
import { TimeframeSeedPool, TimeframePoolBusyError } from "../dist/src/candles/timeframe-seed-pool.js";
import { ADAPTERS, fetchNativeTimeframeKlines, nativeTimeframePageRows, nativeTimeframeWeight } from "../dist/src/candles/venues.js";
import { timeframeHorizonFromEnv } from "../dist/src/config.js";
import { goldenBodies, digest } from "./fixtures/timeframe-golden-scenarios.mjs";
import { appEnvelope, appContent, appSignatureOk } from "./fixtures/app-timeframe-verifier.mjs";

const HOUR = 60 * MINUTE_MS;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-20T12:07:30.000Z");
const pair = generateKeyPairSync("ed25519");
const sign = (bytes) => edSign(null, bytes, pair.privateKey);
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "dist");

const px = (i) => ({ open: 100 + (i % 7), high: 109 + (i % 5), low: 95 - (i % 3), close: 101 + (i % 6), volume: 1 + (i % 9) * 0.25 });
const rowsFrom = (from, step, n) => Array.from({ length: n }, (_, i) => ({ openMs: from + i * step, ...px(i) }));
const newestClosed = (interval, now = NOW) => { const s = interval * MINUTE_MS; return Math.floor((now - MINUTE_MS) / s) * s - s; };
const horizonOf = (text) => { const p = parseTimeframeHorizon(text); assert.ok(p.ok, p.error); return p.value; };

function make(prefix, horizonText, opts = {}) {
  const root = tmpDir(prefix);
  const minutes = new CandleStore(`${root}/minutes`);
  const h = new TimeframeHistory(`${root}/tf`, minutes, opts.retentionDays ?? 30,
    horizonText ? { horizon: horizonOf(horizonText), clock: opts.clock } : { clock: opts.clock });
  return { root, minutes, h };
}

/** Write native rows through the ordinary (legacy-shaped) record path. */
function seed(h, venue, symbol, interval, from, to, now = NOW, skip = () => false) {
  const step = interval * MINUTE_MS;
  const cap = 1000;
  for (let s = from; s <= to; s += cap * step) {
    const e = Math.min(to, s + (cap - 1) * step);
    const rows = rowsFrom(s, step, (e - s) / step + 1).filter((r) => !skip(r.openMs));
    h.record({ key: `${venue}\u0000${symbol}\u0000${interval}`, venue, symbol, targetInterval: interval, interval, startMs: s, endMs: e },
      { candles: rows, empty: false }, now);
  }
  h.flush();
}

const venueRows = (from, to, step) => rowsFrom(from, step, (to - from) / step + 1);

/** work() at `t` after serving any newly closed tail bucket with venue rows
 *  (a cursor offers its newest gap first, and these tests move the clock). */
function workAfterTails(h, venue, t) {
  for (let i = 0; i < 5; i++) {
    const pages = h.work(venue, t, 1000);
    const tail = pages.filter((p) => p.endMs === newestClosed(p.interval, t));
    if (!tail.length) return pages;
    for (const p of tail) { h.attempted(p, t); h.record(p, { candles: venueRows(p.proofFromMs, p.endMs, p.interval * MINUTE_MS), empty: false }, t); }
  }
  throw new Error("tail never settled");
}

// ── config ────────────────────────────────────────────────────────────────
await test("HUB_TIMEFRAME_HORIZON parses venue lists and refuses any malformed value as a whole", () => {
  assert.deepEqual(parseTimeframeHorizon(undefined), { ok: true, value: {} });
  assert.deepEqual(parseTimeframeHorizon("  "), { ok: true, value: {} });
  const all = horizonOf("bybit,bitget,bitunix,binance,aster,weex:60,120,240,1440:365");
  assert.deepEqual(Object.keys(all).sort(), ["aster", "binance", "bitget", "bitunix", "bybit", "weex"]);
  assert.deepEqual(all.bitget, { intervals: [60, 120, 240, 1440], days: 365 });
  assert.deepEqual(horizonOf("bybit:240,60:365; weex:1440:30").weex, { intervals: [1440], days: 30 });
  for (const bad of ["bybit:60", "bybitx:60:365", "bybit:61:365", "bybit:60:0", "bybit:60:1096", "bybit:60:abc",
    "bybit:60:365;bybit:240:365", "bybit:3:365", "bybit,:60:365", "bybit:60,,240:365"]) {
    const p = parseTimeframeHorizon(bad);
    assert.equal(p.ok, false, `${bad} must be refused`);
  }
  const env = timeframeHorizonFromEnv({ HUB_TIMEFRAME_HORIZON: "bybit:60:365;nope:60:1" });
  assert.deepEqual(env.candleTimeframeHorizon, {}, "a refused value runs with NO horizon, never a partial one");
  assert.match(env.candleTimeframeHorizonError, /HUB_TIMEFRAME_HORIZON refused: unknown venue/);
  assert.deepEqual(timeframeHorizonFromEnv({}), { candleTimeframeHorizon: {}, candleTimeframeHorizonError: null });
});

await test("timeframe venue-empty timing equals the 1m lane's two-proof rule", () => {
  assert.equal(HORIZON_EMPTY_CONFIRM_GAP_MS, VENUE_EMPTY_CONFIRM_GAP_MS);
  assert.equal(HORIZON_EMPTY_RECHECK_MS, VENUE_EMPTY_RECHECK_MS);
});

// ── Beta: <=60-day responses byte-identical to 0.4.102 ──────────────────────
await test("<=60-day v2 responses are byte-identical to the 0.4.102 golden fixture, horizon unset AND set", async () => {
  const golden = JSON.parse(fs.readFileSync(new URL("./fixtures/timeframe-v2-golden.json", import.meta.url)));
  const plain = digest(await goldenBodies(DIST));
  const withHorizon = digest(await goldenBodies(DIST, { horizon: horizonOf("bybit,bitget,bitunix,binance,aster,weex:60,120,240,1440:365") }));
  assert.equal(Object.keys(golden.scenarios).length, 10);
  for (const [name, want] of Object.entries(golden.scenarios)) {
    assert.deepEqual(plain[name], want, `${name}: horizon unset`);
    assert.deepEqual(withHorizon[name], want, `${name}: horizon set (month files, standing cursors)`);
  }
});

// ── storage ─────────────────────────────────────────────────────────────────
await test("month files: the same rows read identically from day and month layouts, with ~30x fewer files", () => {
  const root = tmpDir("tf-month");
  const day = new TimeframeStore(`${root}/day`);
  const month = new TimeframeStore(`${root}/month`, () => "month");
  const step = HOUR;
  const from = Date.parse("2026-01-30T00:00:00Z");
  const rows = rowsFrom(from, step, 24 * 70).filter((_, i) => i % 97 !== 5);
  assert.equal(day.write("bybit", "BTCUSDT", 60, rows, "native", 60, NOW), rows.length);
  assert.equal(month.write("bybit", "BTCUSDT", 60, rows, "native", 60, NOW), rows.length);
  const a = day.read("bybit", "BTCUSDT", 60, from - DAY, from + 80 * DAY);
  const b = month.read("bybit", "BTCUSDT", 60, from - DAY, from + 80 * DAY);
  assert.equal(a.length, rows.length);
  assert.deepEqual(b, a);
  assert.deepEqual(month.read("bybit", "BTCUSDT", 60, from + 3 * HOUR + 1, from + 40 * DAY), day.read("bybit", "BTCUSDT", 60, from + 3 * HOUR + 1, from + 40 * DAY));
  const files = (dir) => fs.readdirSync(dir).filter((f) => !f.includes(".tmp."));
  assert.equal(files(`${root}/day/bybit/BTCUSDT/60`).length, 70);
  assert.deepEqual(files(`${root}/month/bybit/BTCUSDT/60`).sort(), ["2026-01.ctf3", "2026-02.ctf3", "2026-03.ctf3", "2026-04.ctf3"]);
  // February has 28 days: 672 hourly slots of 56 bytes.
  assert.equal(fs.statSync(`${root}/month/bybit/BTCUSDT/60/2026-02.ctf3`).size, 28 * 24 * 56);
});

await test("migration on write: a month's 0.4.102 day files fold into its month file once, idempotently", () => {
  const root = tmpDir("tf-migrate");
  const day = new TimeframeStore(root);
  const step = 4 * HOUR;
  const from = Date.parse("2026-09-01T00:00:00Z");
  const old = rowsFrom(from, step, 6 * 20);
  day.write("binance", "ETHUSDT", 240, old, "native", 240, NOW);
  day.write("binance", "ETHUSDT", 240, [{ openMs: from + 200 * step, ...px(1) }], "aggregate", 60, NOW);
  const before = day.read("binance", "ETHUSDT", 240, from, from + 60 * DAY);
  const month = new TimeframeStore(root, () => "month");
  assert.deepEqual(month.read("binance", "ETHUSDT", 240, from, from + 60 * DAY), before, "dual read before any month file exists");
  const extra = { openMs: from + 6 * 20 * step, ...px(3) };
  month.write("binance", "ETHUSDT", 240, [extra], "native", 240, NOW);
  const dir = `${root}/binance/ETHUSDT/240`;
  assert.ok(fs.existsSync(`${dir}/2026-09.ctf3`));
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith("2026-09-")).length, 0, "September day files folded and removed");
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("2026-10-")), "October day files wait for October's first write");
  const after = month.read("binance", "ETHUSDT", 240, from, from + 60 * DAY);
  assert.deepEqual(after, [...before.filter((c) => c.openMs < extra.openMs), { ...extra, source: "native", baseInterval: 240 },
    ...before.filter((c) => c.openMs > extra.openMs)]);
  // A leftover day file after a crash (month already folded) is ignored by
  // reads and re-folding it fills empty slots only.
  const stale = Buffer.from(fs.readFileSync(`${dir}/2026-09.ctf3`).subarray(6 * 56, 12 * 56));
  for (let slot = 0; slot < 6; slot++) stale.writeDoubleLE(1.5 + slot, slot * 56 + 40); // different volume, still valid
  fs.writeFileSync(`${dir}/2026-09-02.ctf2`, stale);
  assert.deepEqual(month.read("binance", "ETHUSDT", 240, from, from + 60 * DAY), after);
  month.write("binance", "ETHUSDT", 240, [extra], "native", 240, NOW);
  assert.deepEqual(month.read("binance", "ETHUSDT", 240, from, from + 60 * DAY), after);
  assert.equal(fs.existsSync(`${dir}/2026-09-02.ctf2`), false);
});

await test("horizon switched off: day layout still reads month files and a new day file keeps the month's slots", () => {
  const root = tmpDir("tf-rollback");
  const month = new TimeframeStore(root, () => "month");
  const from = Date.parse("2026-10-01T00:00:00Z");
  month.write("bybit", "SOLUSDT", 60, rowsFrom(from, HOUR, 48), "native", 60, NOW);
  const day = new TimeframeStore(root);
  assert.equal(day.read("bybit", "SOLUSDT", 60, from, from + 2 * DAY).length, 48);
  day.write("bybit", "SOLUSDT", 60, [{ openMs: from + 50 * HOUR, ...px(2) }], "native", 60, NOW);
  day.write("bybit", "SOLUSDT", 60, [{ openMs: from + 30 * HOUR, ...px(9) }], "native", 60, NOW);
  const read = day.read("bybit", "SOLUSDT", 60, from, from + 3 * DAY);
  assert.equal(read.length, 49, "the day file created for day 2 was seeded from the month file");
  assert.equal(read.find((c) => c.openMs === from + 30 * HOUR).open, px(9).open);
});

await test("per-interval retention keeps the year of horizon intervals and prunes everything else at minute retention", () => {
  const { h, root } = make("tf-retention", "bybit:60,120:365");
  const step = HOUR;
  const from = newestClosed(60) - 300 * DAY;
  seed(h, "bybit", "BTCUSDT", 60, from, newestClosed(60));
  seed(h, "bybit", "BTCUSDT", 3, newestClosed(3) - 40 * DAY, newestClosed(3));
  seed(h, "binance", "BTCUSDT", 60, newestClosed(60) - 40 * DAY, newestClosed(60));
  h.prune(NOW);
  assert.equal(h.store.read("bybit", "BTCUSDT", 60, from, NOW).length, 300 * 24 + 1, "365-day horizon interval kept whole");
  const threeFrom = h.store.read("bybit", "BTCUSDT", 3, 0, NOW)[0].openMs;
  assert.ok(threeFrom >= NOW - 32 * DAY, "3m pruned at minute retention + 1 day");
  const binFrom = h.store.read("binance", "BTCUSDT", 60, 0, NOW)[0].openMs;
  assert.ok(binFrom >= NOW - 32 * DAY && binFrom < NOW - 30 * DAY, "a venue without a horizon keeps 0.4.102 retention");
  assert.ok(fs.readdirSync(`${root}/tf/binance/BTCUSDT/60`).every((f) => f.endsWith(".ctf2")));
  assert.ok(fs.readdirSync(`${root}/tf/bybit/BTCUSDT/60`).every((f) => f.endsWith(".ctf3")));
  // A month leaves only when its whole month is past the horizon.
  h.prune(NOW + 200 * DAY);
  const left = h.store.read("bybit", "BTCUSDT", 60, 0, NOW + 400 * DAY)[0].openMs;
  assert.ok(left <= NOW + 200 * DAY - 367 * DAY && left >= NOW + 200 * DAY - 367 * DAY - 31 * DAY);
  void step;
});

await test("frontier sidecar writes are debounced; a crash before the write leaves new slots unproven", () => {
  let clock = 1_000_000;
  const { h, root, minutes } = make("tf-debounce", null, { clock: () => clock });
  const file = `${root}/tf/native-frontier.v2.json`;
  const step = HOUR;
  const a = newestClosed(60) - 10 * step;
  seed(h, "bybit", "AUSDT", 60, a, a + 2 * step);
  const first = fs.readFileSync(file, "utf8");
  h.record({ key: "bybit\u0000AUSDT\u000060", venue: "bybit", symbol: "AUSDT", targetInterval: 60, interval: 60, startMs: a + 3 * step, endMs: a + 5 * step },
    { candles: rowsFrom(a + 3 * step, step, 3), empty: false }, NOW);
  assert.equal(fs.readFileSync(file, "utf8"), first, "second write inside the debounce window is deferred");
  const crashed = new TimeframeHistory(`${root}/tf`, minutes, 30);
  const served = crashed.request("bybit", "AUSDT", 60, a, a + 5 * step, NOW, null, "seed-1", sign);
  assert.equal(served.payload.availableRows, 3, "rows past the persisted frontier are not served after a crash");
  clock += 2_001;
  h.flush(false);
  assert.notEqual(fs.readFileSync(file, "utf8"), first);
  const recovered = new TimeframeHistory(`${root}/tf`, minutes, 30);
  assert.equal(recovered.request("bybit", "AUSDT", 60, a, a + 5 * step, NOW, null, "seed-1", sign).payload.availableRows, 6);
});

// ── cursors ─────────────────────────────────────────────────────────────────
await test("standing demand: the roster is warm before anyone asks, pages newest-first, and never expires", () => {
  const { h } = make("tf-standing", "bybit:60,240:30");
  const last = newestClosed(60);
  seed(h, "bybit", "BTCUSDT", 60, last - 5 * DAY, last - 2 * DAY);
  h.warm("bybit", ["BTCUSDT", "ETHUSDT"], NOW);
  assert.equal(h.horizonPending(), 4);
  assert.deepEqual(h.primeHorizon(NOW, 50), { primed: 4, remaining: 0, done: true });
  const pages = h.work("bybit", NOW, 1000);
  assert.equal(pages.length, 4, "one page per standing series, no request needed");
  const btc60 = pages.find((p) => p.symbol === "BTCUSDT" && p.interval === 60);
  assert.equal(btc60.endMs, last, "the newest missing range comes first");
  assert.equal(btc60.startMs, last - 2 * DAY + HOUR);
  assert.equal(btc60.horizon, true);
  assert.deepEqual(btc60.targets, [60]);
  // A short request with gaps adds no per-request demand beside the cursor
  // (which would re-read the window from disk every pass).
  h.request("bybit", "ETHUSDT", 60, last - 10 * DAY, last, NOW, null, "seed-1", sign);
  assert.equal(h.demands.size, 0);
  assert.ok(h.work("bybit", NOW, 1000).every((p) => p.horizon === true));
  // Far past the 6 h TTL that retires request-driven demand.
  const later = NOW + 7 * HOUR;
  h.warm("bybit", ["BTCUSDT", "ETHUSDT"], later);
  assert.equal(h.work("bybit", later, 1000).length, 4);
  // A symbol leaving the roster loses its cursors.
  h.warm("bybit", ["BTCUSDT"], later);
  assert.ok(h.work("bybit", later, 1000).every((p) => p.symbol === "BTCUSDT"));
});

await test("incremental gap cursor: work() performs zero disk reads once primed and recorded pages close gaps", () => {
  const { h } = make("tf-cursor", "bybit:60:30");
  const last = newestClosed(60);
  const symbols = Array.from({ length: 30 }, (_, i) => `C${i}USDT`);
  for (const s of symbols) seed(h, "bybit", s, 60, last - 30 * DAY, last, NOW, (at) => at % (7 * HOUR) === 0);
  h.warm("bybit", symbols, NOW);
  h.primeHorizon(NOW, 1000);
  let reads = 0;
  const realRead = h.store.read.bind(h.store);
  h.store.read = (...a) => { reads++; return realRead(...a); };
  const realFixed = h.store.readFixed.bind(h.store);
  h.store.readFixed = (...a) => { reads++; return realFixed(...a); };
  for (let i = 0; i < 5; i++) h.work("bybit", NOW + i * MINUTE_MS, 1000);
  assert.equal(reads, 0, "a warm cursor emits work without reading the store");
  h.store.read = realRead; h.store.readFixed = realFixed;
  // Fill every gap of one symbol through its own pages.
  let guard = 0;
  for (;;) {
    const page = h.work("bybit", NOW, 1000).find((p) => p.symbol === "C0USDT");
    if (!page || guard++ > 500) break;
    h.attempted(page, NOW);
    h.record(page, { candles: venueRows(page.startMs, page.endMs, HOUR), empty: false }, NOW);
  }
  assert.ok(guard > 100 && guard < 500, `pages: ${guard}`);
  assert.equal(h.work("bybit", NOW, 1000).filter((p) => p.symbol === "C0USDT").length, 0);
  const served = h.request("bybit", "C0USDT", 60, last - 29 * DAY, last, NOW, null, "seed-1", sign);
  assert.equal(served.payload.complete, true);
  const status = h.horizonStatus(NOW)[0].intervals[0];
  assert.equal(status.symbols, 30);
  assert.equal(status.complete, 1);
  assert.equal(status.backfilling, 29);
});

await test("an unproductive page waits HORIZON_RETRY_MS; a productive one earns the next page at once", () => {
  const { h } = make("tf-retry", "binance:240:30");
  const last = newestClosed(240);
  const step = 4 * HOUR;
  seed(h, "binance", "XUSDT", 240, last - 20 * DAY, last - 3 * step);
  h.warm("binance", ["XUSDT"], NOW);
  h.primeHorizon(NOW, 50);
  const page = h.work("binance", NOW, 1000)[0];
  assert.deepEqual([page.startMs, page.endMs], [last - 2 * step, last], "the tail first");
  h.attempted(page, NOW);
  // An empty answer for the newest buckets proves nothing (they may simply
  // not be published yet): the cursor waits like legacy demand work.
  h.record(page, { candles: [], empty: true }, NOW);
  assert.equal(h.boundary("binance", "XUSDT", 240, NOW).floor, null);
  assert.equal(h.work("binance", NOW + HORIZON_RETRY_MS - 1, 1000).length, 0);
  const retry = h.work("binance", NOW + HORIZON_RETRY_MS, 1000)[0];
  assert.equal(retry.endMs, last);
  h.attempted(retry, NOW + HORIZON_RETRY_MS);
  h.record(retry, { candles: venueRows(last - 2 * step, last, step), empty: false }, NOW + HORIZON_RETRY_MS);
  assert.equal(h.work("binance", NOW + HORIZON_RETRY_MS, 1000).length, 1, "progress: the next (older) page at once");
});

await test("young listing: an empty older page is a venue-empty floor only after two proofs >= 1 h apart; then zero work for a day", () => {
  const { h } = make("tf-floor", "bybit:60:30");
  const last = newestClosed(60);
  const listing = last - 5 * DAY;
  seed(h, "bybit", "NEWUSDT", 60, listing, last);
  h.noteInstrumentRoster("bybit", [{ symbol: "NEWUSDT", generation: "bybit:usdt-perpetual:100" }]);
  h.warm("bybit", ["NEWUSDT"], NOW);
  h.primeHorizon(NOW, 50);
  // The cursor offers its newest gap first: serve any new tail bucket (time
  // moves on in this test) before looking for the leading page.
  const leading = (t) => {
    for (let i = 0; i < 5; i++) {
      const pages = h.work("bybit", t, 1000);
      const tail = pages.filter((p) => p.endMs >= listing);
      if (!tail.length) return pages;
      for (const p of tail) { h.attempted(p, t); h.record(p, { candles: venueRows(p.startMs, p.endMs, HOUR), empty: false }, t); }
    }
    throw new Error("tail never settled");
  };
  const [p1] = leading(NOW);
  assert.equal(p1.endMs, listing - HOUR, "paged backwards from the held edge");
  h.attempted(p1, NOW);
  h.record(p1, { candles: [], empty: true }, NOW);
  let b = h.boundary("bybit", "NEWUSDT", 60, NOW);
  assert.deepEqual([b.floor.atMs, b.floor.confirmations], [listing, 1]);
  assert.equal(leading(NOW).length, 0, "a single proof stops asking for an hour, not forever");
  assert.equal(leading(NOW + HORIZON_EMPTY_CONFIRM_GAP_MS - 1).length, 0);
  const t2 = NOW + HORIZON_EMPTY_CONFIRM_GAP_MS;
  const [p2] = leading(t2);
  assert.ok(p2, "re-asked once after an hour");
  h.attempted(p2, t2);
  h.record(p2, { candles: [], empty: true }, t2);
  b = h.boundary("bybit", "NEWUSDT", 60, t2);
  assert.equal(b.floor.confirmations, 2);
  for (const dt of [MINUTE_MS, 6 * HOUR, HORIZON_EMPTY_RECHECK_MS - 1]) assert.equal(leading(t2 + dt).length, 0, `floored: no work at +${dt}`);
  assert.equal(leading(t2 + HORIZON_EMPTY_RECHECK_MS).length, 1, "confirmed floors are re-read daily");
  const st = h.horizonStatus(t2)[0].intervals[0];
  assert.deepEqual([st.floored, st.complete, st.backfilling], [1, 0, 0]);
  // The signed body still shows the leading gap: the floor stops asking, it is not proof for the app.
  const served = h.request("bybit", "NEWUSDT", 60, last - 20 * DAY, last, NOW, null, "seed-1", sign);
  assert.equal(served.payload.complete, false);
  assert.deepEqual(served.payload.gaps[0], [last - 20 * DAY, listing - HOUR]);
  // A new listing generation drops the floor with the cursor.
  h.noteInstrumentRoster("bybit", [{ symbol: "NEWUSDT", generation: "bybit:usdt-perpetual:200" }]);
  h.warm("bybit", ["NEWUSDT"], t2);
  assert.equal(h.boundary("bybit", "NEWUSDT", 60, t2).floor, null);
});

await test("a listing inside the page: rows from x are written and x becomes the floor candidate", () => {
  const { h } = make("tf-floor-mid", "binance:240:60");
  const step = 4 * HOUR;
  const last = newestClosed(240);
  const held = last - 10 * DAY;
  seed(h, "binance", "MIDUSDT", 240, held, last);
  h.warm("binance", ["MIDUSDT"], NOW);
  h.primeHorizon(NOW, 50);
  const page = h.work("binance", NOW, 1000).find((p) => p.endMs < held);
  const x = held - 7 * step;
  h.attempted(page, NOW);
  h.record(page, { candles: venueRows(x, held - step, step), empty: false }, NOW);
  const b = h.boundary("binance", "MIDUSDT", 240, NOW);
  assert.equal(b.floor.atMs, x);
  assert.equal(b.floor.checkedFromMs, page.startMs);
  assert.equal(h.request("binance", "MIDUSDT", 240, x, last, NOW, null, "seed-1", sign).payload.complete, true);
  // The venue later publishing an older row retires the floor.
  const later = NOW + 2 * HOUR;
  const older = { key: page.key, venue: "binance", symbol: "MIDUSDT", targetInterval: 240, interval: 240,
    startMs: x - 3 * step, endMs: x - step, horizon: true, route: "recent", weight: 1, proofFromMs: x - 3 * step, targets: [240] };
  h.record(older, { candles: venueRows(x - 3 * step, x - step, step), empty: false }, later);
  assert.equal(h.boundary("binance", "MIDUSDT", 240, later).floor, null);
});

await test("Bitunix: pages carry one predecessor row and a raw (carried-open) first venue row still bounds the floor", () => {
  const { h } = make("tf-floor-bitunix", "bitunix:60:30");
  const last = newestClosed(60);
  const held = last - 3 * DAY;
  seed(h, "bitunix", "BXUSDT", 60, held, last);
  h.warm("bitunix", ["BXUSDT"], NOW);
  h.primeHorizon(NOW, 50);
  const page = h.work("bitunix", NOW, 1000).find((p) => p.endMs < held);
  assert.equal(page.proofFromMs - page.startMs, HOUR, "one predecessor slot");
  assert.equal((page.endMs - page.proofFromMs) / HOUR + 1, 199);
  const x = held - 5 * HOUR;
  const rows = venueRows(x, held - HOUR, HOUR);
  rows[0] = { ...rows[0], open: rows[0].high + 1 }; // listing bar: open outside its own range (carried)
  h.attempted(page, NOW);
  h.record(page, { candles: rows, empty: false }, NOW);
  assert.equal(h.boundary("bitunix", "BXUSDT", 60, NOW).floor.atMs, x, "the venue's first row, not the first servable one");
});

await test("an interior venue hole is proven twice and then left alone; a later venue row retires the proof", () => {
  const { h } = make("tf-interior", "bybit:60:30");
  const last = newestClosed(60);
  const hole = [last - 3 * DAY, last - 3 * DAY + 5 * HOUR];
  seed(h, "bybit", "HOLEUSDT", 60, last - 31 * DAY, last, NOW, (at) => at >= hole[0] && at <= hole[1]);
  h.warm("bybit", ["HOLEUSDT"], NOW);
  h.primeHorizon(NOW, 50);
  const ask = (t) => workAfterTails(h, "bybit", t).filter((p) => p.endMs === hole[1]);
  const [p1] = ask(NOW);
  assert.equal(p1.startMs, hole[0]);
  h.attempted(p1, NOW); h.record(p1, { candles: [], empty: true }, NOW);
  assert.equal(ask(NOW + 30 * MINUTE_MS).length, 0);
  const t2 = NOW + HOUR;
  const [p2] = ask(t2);
  h.attempted(p2, t2); h.record(p2, { candles: [], empty: true }, t2);
  assert.equal(ask(t2 + 12 * HOUR).length, 0, "proven interior hole: no work until the daily recheck");
  const t3 = t2 + HORIZON_EMPTY_RECHECK_MS;
  const [p3] = ask(t3);
  h.attempted(p3, t3);
  h.record(p3, { candles: venueRows(hole[0], hole[1], HOUR), empty: false }, t3);
  assert.equal(h.request("bybit", "HOLEUSDT", 60, last - 5 * DAY, last, NOW, null, "seed-1", sign).payload.complete, true);
});

// ── the long path ───────────────────────────────────────────────────────────
await test("a 365-day (8,760-row) window built by the read-only worker is byte-identical to the synchronous build and the app accepts it", () => {
  const { h } = make("tf-long", "bybit:60:365");
  const last = Math.floor(NOW / HOUR) * HOUR - HOUR;
  const from = last - 8759 * HOUR;
  seed(h, "bybit", "BTCUSDT", 60, from - 24 * HOUR, newestClosed(60));
  assert.equal(h.isLongRequest("bybit", 60, from, last, NOW), true);
  assert.equal(h.isLongRequest("bybit", 60, last - 1439 * HOUR, last, NOW), false, "60 days stays synchronous");
  assert.equal(h.isLongRequest("binance", 60, from, last, NOW), false, "not on the horizon: synchronous as 0.4.102");
  const prepared = h.prepareLongRequest("bybit", "BTCUSDT", 60, from, last, NOW, null, "seed-1");
  assert.ok(prepared.ok);
  assert.deepEqual(Object.keys(prepared.job).sort(), ["foldBase", "fromMs", "generation", "interval", "keyId", "layouts", "requiredClosedToMs",
    "requiredFromMs", "requiredRows", "rootDir", "safety", "symbol", "toMs", "venue"], "the job carries values, never key material");
  const reply = buildTimeframeLong(structuredClone(prepared.job));
  const long = h.finishLongRequest(prepared, reply, sign);
  const sync = h.request("bybit", "BTCUSDT", 60, from, last, NOW, null, "seed-1", sign);
  assert.equal(long.body.toString("utf8"), JSON.stringify(sync.payload), "signed bytes identical to JSON.stringify({...payload, sig})");
  const env = appEnvelope(JSON.parse(long.body));
  assert.ok(env.ok, env.error);
  assert.equal(appSignatureOk(env.value, publicPem), true);
  const content = appContent(env.value, { venue: "bybit", symbol: "BTCUSDT", intervalMinutes: 60, fromMs: from, toMs: last, nowMs: NOW });
  assert.ok(content.ok, content.error);
  assert.equal(content.value.rows.length, 8760);
  assert.equal(content.value.complete, true);
  assert.throws(() => signedTimeframeBody(new Uint8Array([1, 2]), "x"), /do not end an object/);
  // A relisting fenced while the worker read is not signed under the new listing.
  h.noteInstrumentRoster("bybit", [{ symbol: "BTCUSDT", generation: "bybit:usdt-perpetual:1" }]);
  const racing = h.prepareLongRequest("bybit", "BTCUSDT", 60, from, last, NOW, null, "seed-1");
  const racingReply = buildTimeframeLong(racing.job);
  h.noteInstrumentRoster("bybit", [{ symbol: "BTCUSDT", generation: "bybit:usdt-perpetual:2" }]);
  const refused = h.finishLongRequest(racing, racingReply, sign);
  assert.deepEqual([refused.ok, refused.code], [false, 503]);
  void canonicalTimeframeBytes;
});

await test("a long window for a young listing is a signed partial with its leading gap, accepted (not ready) by the app", () => {
  const { h } = make("tf-long-young", "bybit:60:365");
  const last = Math.floor(NOW / HOUR) * HOUR - HOUR;
  const from = last - 8759 * HOUR;
  seed(h, "bybit", "YNGUSDT", 60, last - 99 * DAY, newestClosed(60));
  const prepared = h.prepareLongRequest("bybit", "YNGUSDT", 60, from, last, NOW, null, "seed-1");
  const long = h.finishLongRequest(prepared, buildTimeframeLong(prepared.job), sign);
  const body = JSON.parse(long.body);
  assert.equal(body.complete, false);
  assert.deepEqual(body.gaps, [[from, last - 99 * DAY - HOUR]]);
  const content = appContent(appEnvelope(body).value, { venue: "bybit", symbol: "YNGUSDT", intervalMinutes: 60, fromMs: from, toMs: last, nowMs: NOW });
  assert.ok(content.ok, content.error);
  assert.equal(content.value.complete, false);
});

await test("the long path never reads 1m or writes aggregates beyond minute retention; aggregate-only targets fold from native 1h", () => {
  const { h, minutes } = make("tf-long-fold", "bitget:60,120:365", { retentionDays: 30 });
  const step = 2 * HOUR;
  const last = Math.floor(NOW / step) * step - step;
  const from = last - 4379 * step;
  seed(h, "bitget", "SOLUSDT", 60, last - 100 * DAY, newestClosed(60));
  const mins = rowsFrom(Math.floor(NOW / MINUTE_MS) * MINUTE_MS - 2 * DAY, MINUTE_MS, 2 * 1440 - 3);
  minutes.write("bitget", "SOLUSDT", mins, mins.at(-1).openMs);
  const minuteFrom = [];
  const realWindow = minutes.readWindow.bind(minutes);
  minutes.readWindow = (v, s, a, b) => { minuteFrom.push(a); return realWindow(v, s, a, b); };
  const aggregateFrom = [];
  const realWrite = h.store.write.bind(h.store);
  h.store.write = (v, s, i, c, source, base, n) => { if (source === "aggregate" && c.length) aggregateFrom.push(Math.min(...c.map((x) => x.openMs))); return realWrite(v, s, i, c, source, base, n); };
  const prepared = h.prepareLongRequest("bitget", "SOLUSDT", 120, from, last, NOW, mins.at(-1).openMs, "seed-1");
  const floor = NOW - 30 * DAY - step;
  assert.ok(minuteFrom.length > 0 && minuteFrom.every((a) => a >= floor), "1m reads only inside minute retention");
  assert.ok(aggregateFrom.every((a) => a >= floor), "aggregate writes only inside minute retention");
  assert.equal(prepared.job.foldBase, 60);
  const reply = buildTimeframeLong(prepared.job);
  const body = JSON.parse(h.finishLongRequest(prepared, reply, sign).body);
  const content = appContent(appEnvelope(body).value, { venue: "bitget", symbol: "SOLUSDT", intervalMinutes: 120, fromMs: from, toMs: last, nowMs: NOW });
  assert.ok(content.ok, content.error);
  assert.equal(body.availableFromMs, last - 100 * DAY);
  assert.equal(body.availableRows, 100 * 12 + 1);
  assert.ok(body.segments.every((s) => s[2] === "aggregate" && s[3] === 60));
  // Exact OHLC from the two hourly bars.
  const r = body.rows[0];
  const a = h.store.read("bitget", "SOLUSDT", 60, r[0], r[0] + HOUR);
  assert.deepEqual(r.slice(1, 5), [a[0].open, Math.max(a[0].high, a[1].high), Math.min(a[0].low, a[1].low), a[1].close]);
});

await test("worker pool: bounded, refuses beyond its queue, times out a stuck build and recovers", async () => {
  const { h } = make("tf-pool", "bybit:60:365");
  const last = Math.floor(NOW / HOUR) * HOUR - HOUR;
  seed(h, "bybit", "PUSDT", 60, last - 400 * DAY, newestClosed(60));
  const prepared = h.prepareLongRequest("bybit", "PUSDT", 60, last - 8759 * HOUR, last, NOW, null, "seed-1");
  const pool = new TimeframeSeedPool(1, 0, 60_000);
  try {
    const first = pool.run(prepared.job);
    await assert.rejects(() => pool.run(prepared.job), (e) => e instanceof TimeframePoolBusyError && /busy; retry shortly/.test(e.message));
    const reply = await first;
    assert.equal(reply.ok, true);
    assert.equal(h.finishLongRequest(prepared, reply, sign).body.toString(), JSON.stringify(
      h.request("bybit", "PUSDT", 60, last - 8759 * HOUR, last, NOW, null, "seed-1", sign).payload));
    assert.equal(pool.status().refusedBusy, 1);
  } finally { pool.close(); }
  const slow = new TimeframeSeedPool(1, 4, 1);
  try {
    await assert.rejects(() => slow.run(prepared.job), /exceeded 1ms/);
    assert.equal(slow.status().failed, 1);
    slow.timeoutMs = 60_000;
    const recovered = await slow.run(prepared.job);
    assert.equal(recovered.ok, true, "the terminated worker is replaced on the next job");
  } finally { slow.close(); }
});

await test("HTTP: long windows come from the worker with unsigned boundary headers; <=60-day windows are 0.4.102 responses", async () => {
  const listing = [{ symbol: "BTCUSDT", status: "Trading", quoteCoin: "USDT", contractType: "LinearPerpetual" }];
  const h = await freshHub({
    candleVenues: ["bybit"], candleTimeframeHorizon: horizonOf("bybit:60:365"),
  }, {
    candleNow: () => NOW,
    candleFetch: async (url) => ({ ok: true, status: 200, json: async () => url.includes("instruments-info")
      ? { retCode: 0, result: { list: listing } } : { retCode: 0, result: { list: [] } } }),
  });
  try {
    const { token } = h.store.issue("tf-long", 1);
    const tfh = h.candles.timeframeHistory;
    const last = Math.floor(NOW / HOUR) * HOUR - HOUR;
    h.candles.store.write("bybit", "BTCUSDT", [{ openMs: last, ...px(1) }], last);
    seed(tfh, "bybit", "BTCUSDT", 60, last - 200 * DAY, newestClosed(60));
    tfh.warm("bybit", ["BTCUSDT"], NOW);
    const longUrl = `${h.origin}/api/candles/seed?venue=bybit&symbol=BTCUSDT&interval=60&fromMs=${last - 8759 * HOUR}&toMs=${last}`;
    const res = await fetch(longUrl, { headers: { "x-license": token } });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("x-wh-horizon-from-ms"));
    const text = await res.text();
    const env = appEnvelope(JSON.parse(text));
    assert.ok(env.ok, env.error);
    assert.equal(appSignatureOk(env.value, h.store.publicKeyPem()), true);
    assert.equal(env.value.availableRows, 200 * 24 + 1);
    const again = await fetch(longUrl, { headers: { "x-license": token, "if-none-match": res.headers.get("etag") } });
    assert.equal(again.status, 304);
    assert.ok(again.headers.get("x-wh-horizon-from-ms"));
    const gz = await fetch(longUrl, { headers: { "x-license": token, "accept-encoding": "gzip" } });
    assert.equal(gz.status, 200);
    assert.equal(await gz.text(), text, "gzip path serves the same signed bytes");
    // <=60 days: synchronous, no new header, the exact 0.4.102 serialisation.
    const shortReq = { venue: "bybit", symbol: "BTCUSDT", interval: 60, fromMs: last - 1439 * HOUR, toMs: last };
    const short = await fetch(`${h.origin}/api/candles/seed?venue=bybit&symbol=BTCUSDT&interval=60&fromMs=${shortReq.fromMs}&toMs=${shortReq.toMs}`,
      { headers: { "x-license": token } });
    assert.equal(short.status, 200);
    assert.equal(short.headers.get("x-wh-horizon-from-ms"), null);
    const shortText = await short.text();
    assert.equal(shortText, JSON.stringify(h.candles.timeframeSeed(shortReq).payload));
    assert.equal(short.headers.get("etag"), `"${createHash("sha256").update(Buffer.from(shortText)).digest("base64url").slice(0, 32)}"`);
    // Admin health names the horizon.
    const admin = await fetch(`${h.origin}/admin/api/candles`, { headers: { "x-hub-admin": h.cfg.adminToken } });
    const status = await admin.json();
    assert.equal(status.timeframeHorizon.configured, true);
    assert.equal(status.timeframeHorizon.error, null);
    const bybit = status.timeframeHorizon.venues.find((v) => v.venue === "bybit");
    assert.deepEqual(bybit.intervals.map((i) => [i.interval, i.symbols]), [[60, 1]]);
    assert.equal(typeof bybit.etaMs === "number" || bybit.etaMs === null, true);
  } finally { await h.close(); }

  const busy = await freshHub({ candleVenues: ["bybit"], candleTimeframeHorizon: horizonOf("bybit:60:365") }, {
    candleNow: () => NOW,
    candleFetch: async () => ({ ok: true, status: 200, json: async () => ({ retCode: 0, result: { list: [] } }) }),
    candleTimeframeBuild: async () => { throw new TimeframePoolBusyError(); },
  });
  try {
    const { token } = busy.store.issue("tf-busy", 1);
    const last = Math.floor(NOW / HOUR) * HOUR - HOUR;
    busy.candles.store.write("bybit", "BTCUSDT", [{ openMs: last, ...px(1) }], last);
    const res = await fetch(`${busy.origin}/api/candles/seed?venue=bybit&symbol=BTCUSDT&interval=60&fromMs=${last - 8759 * HOUR}&toMs=${last}`,
      { headers: { "x-license": token } });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "1");
    assert.match((await res.json()).error, /busy; retry shortly/);
  } finally { await busy.close(); }
});

await test("service: a discovered roster gets standing cursors in the same pass, primed in bounded timer turns", async () => {
  const listing = ["AUSDT", "BUSDT", "CUSDT"].map((symbol) => ({ symbol, status: "Trading", quoteCoin: "USDT", contractType: "LinearPerpetual" }));
  const h = await freshHub({
    candleVenues: ["bybit"], candleTimeframeHorizon: horizonOf("bybit:60,240:365"),
  }, {
    candleNow: () => NOW,
    candleFetch: async (url) => ({ ok: true, status: 200, json: async () => url.includes("instruments-info")
      ? { retCode: 0, result: { list: listing } } : { retCode: 0, result: { list: [] } } }),
  });
  try {
    const tfh = h.candles.timeframeHistory;
    assert.equal(tfh.horizonPending(), 0, "no roster before the first listing pass");
    await h.candles.tickAll(NOW);
    const health = h.candles.horizonHealth(NOW).venues[0];
    assert.deepEqual(health.intervals.map((i) => [i.interval, i.symbols]), [[60, 3], [240, 3]]);
    for (let i = 0; i < 50 && tfh.horizonPending() > 0; i++) await new Promise((r) => setTimeout(r, 30));
    assert.equal(tfh.horizonPending(), 0, "primed by the timer turns, without another tick");
  } finally { await h.close(); }
});

// ── venues ──────────────────────────────────────────────────────────────────
await test("Bitget: daily is 1Dutc, ranges ask [start, end+span] (close-time framing), pages respect the 90-day span", async () => {
  const urls = [];
  const fetchLike = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ code: "00000", data: [] }) }; };
  const d0 = Date.parse("2026-01-01T00:00:00Z");
  await fetchNativeTimeframeKlines(fetchLike, "bitget", "BTCUSDT", 1440, d0, d0 + 89 * DAY);
  assert.match(urls[0], /granularity=1Dutc&/);
  assert.match(urls[0], new RegExp(`startTime=${d0}&endTime=${d0 + 90 * DAY}&`));
  await fetchNativeTimeframeKlines(fetchLike, "bitget", "BTCUSDT", 60, d0, d0 + 199 * HOUR);
  assert.match(urls[1], new RegExp(`granularity=1H&startTime=${d0}&endTime=${d0 + 200 * HOUR}&`));
  assert.equal(nativeTimeframePageRows("bitget", 1440), 90);
  assert.equal(nativeTimeframePageRows("bitget", 720), 180);
  assert.equal(nativeTimeframePageRows("bitget", 60), 200);
  // A 16:00 UTC (`1D`) open can never be stored on the UTC daily grid; 1Dutc can.
  const { h } = make("tf-bitget-daily", "bitget:1440:365");
  const day = Math.floor(NOW / DAY) * DAY - 3 * DAY;
  const work = { key: "bitget\u0000BTCUSDT\u00001440", venue: "bitget", symbol: "BTCUSDT", targetInterval: 1440, interval: 1440, startMs: day - DAY, endMs: day + DAY };
  assert.equal(h.record(work, { candles: [{ openMs: day - 8 * HOUR, ...px(1) }, { openMs: day + 16 * HOUR, ...px(2) }], empty: false }, NOW), 0);
  assert.equal(h.record(work, { candles: [{ openMs: day, ...px(1) }], empty: false }, NOW), 1);
});

await test("Bitget daily migration drops any bitget 1440 native frontier exactly once (marker-guarded)", () => {
  const root = tmpDir("tf-bitget-mig");
  const minutes = new CandleStore(`${root}/m`);
  fs.mkdirSync(`${root}/tf`, { recursive: true });
  const frontiers = { "bitget\u0000BTCUSDT\u00001440": 1, "bitget\u0000BTCUSDT\u000060": 5, "bybit\u0000BTCUSDT\u00001440": 7 };
  fs.writeFileSync(`${root}/tf/native-frontier.v2.json`, JSON.stringify({ v: 2, frontiers }));
  new TimeframeHistory(`${root}/tf`, minutes, 30);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${root}/tf/native-frontier.v2.json`)).frontiers,
    { "bitget\u0000BTCUSDT\u000060": 5, "bybit\u0000BTCUSDT\u00001440": 7 });
  assert.ok(fs.existsSync(`${root}/tf/bitget-1dutc.v1.done`));
  fs.writeFileSync(`${root}/tf/native-frontier.v2.json`, JSON.stringify({ v: 2, frontiers }));
  new TimeframeHistory(`${root}/tf`, minutes, 30);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${root}/tf/native-frontier.v2.json`)).frontiers, frontiers, "runs once");
});

await test("WEEX: old ranges use historyKlines (100 rows, weight 5, 1h/4h/1d); the newest 990 rows use the weight-1 page", async () => {
  const urls = [];
  const fetchLike = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => [] }; };
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  await fetchNativeTimeframeKlines(fetchLike, "weex", "BTCUSDT", 60, t0, t0 + 99 * HOUR, "history");
  assert.match(urls[0], /\/capi\/v3\/market\/historyKlines\?symbol=BTCUSDT&interval=1h&startTime=\d+&endTime=\d+&limit=100&priceType=LAST/);
  assert.match(urls[0], new RegExp(`startTime=${t0}&endTime=${t0 + 100 * HOUR - 1}&`));
  await assert.rejects(() => fetchNativeTimeframeKlines(fetchLike, "weex", "BTCUSDT", 720, t0, t0, "history"), /no proved history route/);
  await assert.rejects(() => fetchNativeTimeframeKlines(fetchLike, "weex", "BTCUSDT", 60, t0, t0 + 100 * HOUR, "history"), /1\.\.100 rows/);
  await fetchNativeTimeframeKlines(fetchLike, "weex", "BTCUSDT", 1440, t0, t0);
  assert.match(urls[1], /\/capi\/v3\/market\/klines\?symbol=BTCUSDT&interval=1d&limit=1000/);
  assert.deepEqual([nativeTimeframeWeight("weex", "history"), nativeTimeframeWeight("weex", "recent"), nativeTimeframeWeight("bybit", "recent")], [5, 1, 1]);
  assert.equal(parseTimeframeHorizon("weex:120:365").ok, true, "WEEX 2h folds from native 1h");

  const { h } = make("tf-weex", "weex:60,120,1440:365");
  h.warm("weex", ["ZUSDT"], NOW);
  h.primeHorizon(NOW, 50);
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const got = h.work("weex", NOW, 1000).filter((p) => p.interval === 60);
    for (const p of got) { pages.push(p); h.attempted(p, NOW); h.record(p, { candles: venueRows(p.proofFromMs, p.endMs, HOUR), empty: false }, NOW); }
  }
  assert.equal(pages[0].route, "recent");
  assert.equal(pages[0].weight, 1);
  assert.equal((pages[0].endMs - pages[0].startMs) / HOUR + 1, 990);
  assert.equal(pages[1].route, "history");
  assert.equal(pages[1].weight, 5);
  assert.equal((pages[1].endMs - pages[1].startMs) / HOUR + 1, 100);
  assert.equal(pages[1].endMs, pages[0].startMs - HOUR, "history continues backwards from the recent window");
  const daily = h.work("weex", NOW, 1000).find((p) => p.interval === 1440);
  assert.equal(daily.route, "recent", "a year of WEEX daily is one weight-1 page");
  assert.deepEqual(h.horizonStatus(NOW)[0].intervals.map((i) => [i.interval, i.fetchInterval]), [[60, 60], [120, 60], [1440, 1440]]);
});

await test("WEEX collector: a history-route horizon page is charged weight 5 and queues behind legacy 1m work", async () => {
  const { h, minutes, root } = make("tf-weex-collector", "weex:60:365");
  const current = Math.floor((NOW - 2 * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
  const symbols = ["AUSDT", "BUSDT", "CUSDT"];
  for (const s of symbols) minutes.write("weex", s, [{ openMs: current, ...px(0) }], current);
  const collector = new VenueCollector("weex", minutes, `${root}/state`, {
    ...DEFAULT_COLLECTOR_OPTIONS, requestsPerSecond: ADAPTERS.weex.publicRequestsPerSecond,
    minRequestsPerSecond: Math.min(DEFAULT_COLLECTOR_OPTIONS.minRequestsPerSecond, ADAPTERS.weex.publicRequestsPerSecond),
    retentionDays: 30,
  }, NOW, () => {}, h);
  await collector.refreshSymbols(async (url) => ({ ok: true, status: 200,
    json: async () => url.includes("apiTradingSymbols") ? symbols : { symbols: symbols.map((symbol) => ({
      symbol, quoteAsset: "USDT", marginAsset: "USDT", contractType: "PERPETUAL", forwardContractFlag: true, status: "TRADING",
    })) } }), NOW);
  await collector.prepareCoverage();
  h.warm("weex", symbols, NOW);
  h.primeHorizon(NOW, 50);
  // Take the recent window first so the remaining work is history-route.
  for (const p of h.work("weex", NOW, 1000)) { h.attempted(p, NOW); h.record(p, { candles: venueRows(p.proofFromMs, p.endMs, HOUR), empty: false }, NOW); }
  const queue = collector.scheduledWork(NOW);
  const costly = queue.filter((w) => w.kind === "timeframe" && w.weight === 5);
  assert.equal(costly.length, 3);
  const firstCostly = queue.indexOf(costly[0]);
  assert.ok(queue.slice(0, firstCostly).some((w) => w.kind === "backfill"), "legacy 1m backfill keeps its turn first");
  const plan = collector.workBudgetFor(60_000);
  let clock = NOW;
  const urls = [];
  const ran = await collector.tick(async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => [] }; },
    collector.budgetFor(60_000), NOW, {
      clock: () => clock, sleep: async (ms) => { clock += ms; }, deadlineMs: 48_000,
      maxRequests: plan.maxRequests, maxWeight: plan.maxWeight, weightPerSecond: plan.weightPerSecond,
    });
  const history = urls.filter((u) => u.includes("historyKlines")).length;
  assert.ok(ran.requests >= 1 && history * 5 <= plan.maxWeight, `history pages charged weight 5 (${history} in ${plan.maxWeight})`);
  assert.ok(urls.some((u) => u.includes("historyKlines") && u.includes("interval=1h")), "a horizon history page was sent");
});

await test("non-WEEX: tails and repairs keep first claim; horizon pages share the history turn with 1m backfill", async () => {
  const { h, minutes, root } = make("tf-priority", "bybit:60:365");
  const stale = Math.floor((NOW - 3 * HOUR) / MINUTE_MS) * MINUTE_MS;
  minutes.write("bybit", "BTCUSDT", rowsFrom(stale - 2 * DAY, MINUTE_MS, 2 * 1440), stale);
  const collector = new VenueCollector("bybit", minutes, `${root}/state`, DEFAULT_COLLECTOR_OPTIONS, NOW, () => {}, h);
  await collector.refreshSymbols(async () => ({ ok: true, status: 200, json: async () => ({ retCode: 0, result: { list: [
    { symbol: "BTCUSDT", status: "Trading", quoteCoin: "USDT", contractType: "LinearPerpetual" }] } }) }), NOW);
  await collector.prepareCoverage();
  h.warm("bybit", ["BTCUSDT"], NOW);
  h.primeHorizon(NOW, 50);
  const kinds = collector.scheduledWork(NOW).map((w) => w.kind);
  assert.ok(kinds.includes("timeframe"));
  const firstTf = kinds.indexOf("timeframe");
  assert.ok(kinds.indexOf("tail") >= 0 && kinds.indexOf("tail") < firstTf, `tail first: ${kinds.join(",")}`);
});

summary("timeframe horizon");
