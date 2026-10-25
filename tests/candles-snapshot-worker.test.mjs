// tests/candles-snapshot-worker.test.mjs — v0.4.99 snapshot build off the
// event loop, the fast fold, single-flight, failure handling, the
// unchanged-retry hold, the served-window health split, the repair back-off
// and the remembered refused rate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { test, summary, tmpDir } from "./helpers.mjs";
import { pathToFileURL } from "node:url";
import { CandleStore, MINUTE_MS, DAY_MS, RECORD_BYTES, newestClosedOpenMs } from "../dist/src/candles/store.js";
import {
  buildSnapshot, canonicalSnapshotBytes, foldSnapshot, newestCompleteBucketOpenMs, signedSnapshotBody,
  snapshotExpiresAtMs, snapshotSettleLagMs, snapshotWindow, SNAPSHOT_INTERVALS, SNAPSHOT_SETTLE_LAG_MS,
} from "../dist/src/candles/snapshot.js";
import {
  CandleService, runSnapshotWorker, SNAPSHOT_FAILURE_TTL_MS, SNAPSHOT_WORKER_CONCURRENCY, HEALTH_GAP_WINDOW_DAYS,
} from "../dist/src/candles/service.js";
import {
  DEFAULT_COLLECTOR_OPTIONS, RATE_REFUSED_MEMORY_MS, REPAIR_BACKOFF_BASE_MS,
} from "../dist/src/candles/collector.js";

const { privateKey } = generateKeyPairSync("ed25519");
const sign = (b) => edSign(null, b, privateKey);

// A deterministic PRNG so a failure reproduces.
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

const DAY0 = Date.UTC(2026, 8, 20); // 2026-09-20
const NOW = DAY0 + 9 * DAY_MS + 7 * 3_600_000 + 12_345; // inside day 10

/** Fill `store` with an awkward roster: complete pairs, interior holes, late
 *  listings, a stale tail, a missing day file, a torn (short) file, slots whose
 *  stored openMs does not match their position, and NaN-free but irregular
 *  prices so float summation order matters. */
function awkwardRoster(store, venue, seed) {
  const r = rng(seed);
  const names = [];
  const row = (openMs) => {
    const base = 1 + r() * 1000;
    return { openMs, open: base, high: base * (1 + r() * 0.01), low: base * (1 - r() * 0.01), close: base * (1 + (r() - 0.5) * 0.01), volume: r() * 1e6 + 0.1 };
  };
  const end = newestClosedOpenMs(NOW);
  for (let k = 0; k < 24; k++) {
    const symbol = `S${String(k).padStart(2, "0")}USDT`;
    names.push(symbol);
    const startDay = k % 5 === 0 ? 6 : 0; // some late listings
    const from = DAY0 + startDay * DAY_MS + (k % 3) * 17 * MINUTE_MS;
    const stop = k % 7 === 0 ? end - 3 * 3_600_000 : end; // some stale tails
    const rows = [];
    for (let t = from; t <= stop; t += MINUTE_MS) {
      if (k % 4 === 1 && r() < 0.0008) continue; // sparse interior holes
      if (k === 6 && t >= DAY0 + 8 * DAY_MS + 100 * MINUTE_MS && t < DAY0 + 8 * DAY_MS + 140 * MINUTE_MS) continue;
      rows.push(row(t));
    }
    store.write(venue, symbol, rows);
  }
  const dir = (s) => path.join(store.rootDir, venue, s);
  const file = (s, d) => path.join(dir(s), `${new Date(DAY0 + d * DAY_MS).toISOString().slice(0, 10)}.c1m`);
  fs.rmSync(file("S03USDT", 7)); // a whole day missing
  fs.truncateSync(file("S08USDT", 9), 600 * RECORD_BYTES + 13); // torn newest day
  const fd = fs.openSync(file("S10USDT", 8), "r+"); // two slots with the wrong timestamp
  const bad = Buffer.alloc(8); bad.writeBigInt64LE(123456789n * 60000n);
  fs.writeSync(fd, bad, 0, 8, 500 * RECORD_BYTES);
  bad.writeBigInt64LE(BigInt(DAY0 + 8 * DAY_MS + 900 * MINUTE_MS) + 2n ** 40n);
  fs.writeSync(fd, bad, 0, 8, 901 * RECORD_BYTES);
  fs.closeSync(fd);
  return names;
}

const store = new CandleStore(path.join(tmpDir("snapw"), "candles"));
const roster = awkwardRoster(store, "bitget", 7);

await test("the fast fold equals the reference fold, byte for byte, on every interval and a spread of depths", () => {
  let compared = 0;
  for (const interval of SNAPSHOT_INTERVALS) {
    for (const depth of [1, 2, 3, 7, 30, 120, 500]) {
      if (interval * depth > 12 * 1440) continue; // beyond the fixture's history: all "short", still compared below
      const req = { venue: "bitget", interval, depth, now: NOW };
      const ref = foldSnapshot(req, { store, keyId: "seed-1", symbols: () => roster });
      const fast = foldSnapshot(req, { store, keyId: "seed-1", symbols: () => roster, fast: true });
      assert.deepEqual(fast.ok, ref.ok, `${interval}m x${depth}`);
      if (ref.ok) {
        assert.ok(canonicalSnapshotBytes(fast.payload).equals(canonicalSnapshotBytes(ref.payload)), `${interval}m x${depth} canonical bytes`);
      } else {
        assert.deepEqual(fast, ref);
      }
      compared++;
    }
  }
  for (const depth of [400, 500]) {
    const req = { venue: "bitget", interval: 1440, depth, now: NOW };
    assert.deepEqual(
      foldSnapshot(req, { store, keyId: "seed-1", symbols: () => roster, fast: true }),
      foldSnapshot(req, { store, keyId: "seed-1", symbols: () => roster }),
    );
  }
  assert.ok(compared > 60, `compared ${compared} windows`);
  const sample = foldSnapshot({ venue: "bitget", interval: 1440, depth: 9, now: NOW }, { store, keyId: "seed-1", symbols: () => roster });
  const reasons = new Set(sample.payload.skipped.map(([, why]) => why));
  assert.ok(reasons.has("gap") && reasons.has("short"), `the fixture exercises both skip reasons: ${JSON.stringify(sample.payload.skipped)}`);
});

await test("signedSnapshotBody is exactly JSON.stringify of the wire object buildSnapshot returns", () => {
  const out = buildSnapshot({ venue: "bitget", interval: 15, depth: 40, now: NOW }, { store, keyId: "seed-1", sign, symbols: () => roster });
  assert.equal(out.ok, true);
  const { sig, ...unsigned } = out.payload;
  const spliced = signedSnapshotBody(canonicalSnapshotBytes(unsigned), sig);
  assert.ok(spliced.equals(Buffer.from(JSON.stringify(out.payload), "utf8")));
});

await test("the worker thread's reply signs to the SAME served bytes as the old synchronous build", async () => {
  for (const [interval, depth] of [[1440, 9], [60, 24], [5, 12], [1, 500], [240, 1]]) {
    const ref = buildSnapshot({ venue: "bitget", interval, depth, now: NOW }, { store, keyId: "seed-1", sign, symbols: () => roster });
    const reply = await runSnapshotWorker({ rootDir: store.rootDir, venue: "bitget", interval, depth, now: NOW, keyId: "seed-1", symbols: roster });
    assert.equal(reply.ok, ref.ok, `${interval}m x${depth}`);
    if (!ref.ok) { assert.deepEqual({ code: reply.code, error: reply.error }, { code: ref.code, error: ref.error }); continue; }
    const body = signedSnapshotBody(reply.canonical, sign(Buffer.from(reply.canonical)).toString("base64"));
    assert.ok(body.equals(Buffer.from(JSON.stringify(ref.payload), "utf8")), `${interval}m x${depth} served bytes`);
    assert.deepEqual(reply.skipped, ref.payload.skipped);
    assert.deepEqual(Object.keys(reply.fingerprints).sort(), ref.payload.skipped.map(([s]) => s).sort(), "a fingerprint for every skipped pair, and only those");
  }
});

function storeService(dataDir, deps = {}) {
  let clock = deps.clock ?? NOW;
  const logs = [];
  const svc = new CandleService(
    { dataDir, venues: [], keyId: "seed-1", options: { ...DEFAULT_COLLECTOR_OPTIONS }, tickMs: 60_000 },
    { sign, now: () => clock, log: (m) => logs.push(m), snapshotFold: deps.snapshotFold },
  );
  return { svc, logs, setClock: (t) => { clock = t; }, getClock: () => clock };
}

const svcDir = tmpDir("snapsvc");
fs.cpSync(store.rootDir, path.join(svcDir, "candles"), { recursive: true });

await test("CandleService.snapshot serves the same bytes and ETag the pre-worker build did", async () => {
  const { svc } = storeService(svcDir);
  const svcStore = new CandleStore(path.join(svcDir, "candles"));
  for (const [interval, depth] of [[1440, 9], [60, 24], [3, 100]]) {
    const r = await svc.snapshot("bitget", interval, depth);
    const ref = buildSnapshot({ venue: "bitget", interval, depth, now: NOW }, {
      store: svcStore, keyId: "seed-1", sign, symbols: () => svcStore.symbols("bitget"),
    });
    assert.equal(r.ok, true);
    const refBody = Buffer.from(JSON.stringify(ref.payload), "utf8");
    assert.ok(r.body.equals(refBody), `${interval}m x${depth}`);
    assert.equal(r.etag, `"${createHash("sha256").update(refBody).digest("base64url").slice(0, 32)}"`);
    assert.deepEqual(r.payload, ref.payload, "the lazily parsed payload is the wire object");
  }
});

await test("concurrent requests for one key share ONE build; different keys run at most SNAPSHOT_WORKER_CONCURRENCY at once", async () => {
  let calls = 0, live = 0, peak = 0;
  const fold = async (job) => {
    calls++; live++; peak = Math.max(peak, live);
    try { return await runSnapshotWorker(job); } finally { live--; }
  };
  const { svc } = storeService(svcDir, { snapshotFold: fold });
  const same = await Promise.all(Array.from({ length: 6 }, () => svc.snapshot("bitget", 60, 24)));
  assert.equal(calls, 1, "six simultaneous callers, one fold");
  assert.ok(same.every((r) => r === same[0] && r.ok), "and they all get the one result");
  const keys = [[1, 30], [3, 30], [5, 30], [15, 30], [30, 30], [120, 10]];
  const many = await Promise.all(keys.map(([i, d]) => svc.snapshot("bitget", i, d)));
  assert.ok(many.every((r) => r.ok), JSON.stringify(many.map((r) => r.ok || r.error)));
  assert.equal(calls, 1 + keys.length);
  assert.ok(peak <= SNAPSHOT_WORKER_CONCURRENCY, `at most ${SNAPSHOT_WORKER_CONCURRENCY} folds at once (saw ${peak})`);
});

await test("the event loop keeps turning while a large fold runs", async () => {
  // A heavier roster than the shared fixture, so the fold takes real time.
  const bigDir = tmpDir("snapbig");
  const big = new CandleStore(path.join(bigDir, "candles"));
  const end = newestClosedOpenMs(NOW);
  for (let k = 0; k < 120; k++) {
    const rows = [];
    for (let t = end - 10 * DAY_MS; t <= end; t += MINUTE_MS) rows.push({ openMs: t, open: 1 + k, high: 2 + k, low: 0.5, close: 1.5, volume: k + 0.25 });
    big.write("bybit", `B${k}USDT`, rows);
  }
  const { svc } = storeService(bigDir);
  let worst = 0, last = performance.now(), ticks = 0;
  const timer = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; ticks++; }, 5);
  const t0 = performance.now();
  const r = await svc.snapshot("bybit", 1, 500);
  const took = performance.now() - t0;
  clearInterval(timer);
  assert.equal(r.ok, true);
  const syncStart = performance.now();
  buildSnapshot({ venue: "bybit", interval: 1440, depth: 9, now: NOW }, { store: big, keyId: "seed-1", sign, symbols: () => big.symbols("bybit") });
  const syncMs = performance.now() - syncStart;
  console.log(`    (worker fold ${Math.round(took)}ms with ${ticks} timer turns, worst loop gap ${Math.round(worst)}ms; the same roster's synchronous 1440m x9 build blocks ${Math.round(syncMs)}ms)`);
  assert.ok(ticks >= 3, "timers fired during the build");
  assert.ok(worst < Math.max(250, syncMs / 2), `the worst event-loop gap (${Math.round(worst)}ms) stays far below a synchronous build (${Math.round(syncMs)}ms)`);
});

await test("a failed worker answers 503 — never partial data — caches the failure briefly, and keeps a complete answer for the same window", async () => {
  let mode = "fail";
  const fold = async (job) => {
    if (mode === "fail") throw new Error("injected worker crash");
    if (mode === "exit") return runSnapshotWorker({ ...job, rootDir: 42 }); // malformed job: the worker throws inside
    return runSnapshotWorker(job);
  };
  const { svc, logs, setClock } = storeService(svcDir, { snapshotFold: fold });
  const failed = await svc.snapshot("bitget", 30, 10);
  assert.deepEqual({ ok: failed.ok, code: failed.code }, { ok: false, code: 503 });
  assert.match(logs.at(-1), /FAILED \(injected worker crash\)/);
  mode = "ok";
  assert.equal((await svc.snapshot("bitget", 30, 10)).ok, false, "inside the failure TTL the cached 503 answers");
  setClock(NOW + SNAPSHOT_FAILURE_TTL_MS);
  const good = await svc.snapshot("bitget", 30, 10);
  assert.equal(good.ok, true, "after the TTL a healthy worker builds");
  mode = "exit";
  const crash = await runSnapshotWorker({ rootDir: 42, venue: "bitget", interval: 30, depth: 10, now: NOW, keyId: "seed-1", symbols: roster });
  assert.equal(crash.ok, false);
  assert.equal(crash.code, 500, "an exception inside the worker is a 500 reply, not a hang");
  setClock(NOW);
});

await test("a partial window is rechecked by fingerprint: identical files hold it, one rewritten file re-folds it", async () => {
  let calls = 0;
  const fold = async (job) => { calls++; return runSnapshotWorker(job); };
  const dir = tmpDir("snaprecheck");
  fs.cpSync(store.rootDir, path.join(dir, "candles"), { recursive: true });
  const s2 = new CandleStore(path.join(dir, "candles"));
  const { svc, logs, setClock } = storeService(dir, { snapshotFold: fold, clock: NOW });
  // A daily window: five and ten minutes later are still inside it.
  const first = await svc.snapshot("bitget", 1440, 9);
  assert.equal(first.ok, true);
  assert.ok(first.payload.skipped.length > 0, "precondition: a partial window");
  setClock(NOW + 5 * MINUTE_MS + 1);
  const same = await svc.snapshot("bitget", 1440, 9);
  assert.equal(same, first, "nothing moved: the very same result");
  assert.equal(calls, 1);
  assert.match(logs.at(-1), /^rechecked bitget 1440m x9: \d+ skipped pair\(s\) unchanged/);
  // Rewrite one skipped pair's window file without changing a value.
  const [victim] = first.payload.skipped.find(([, why]) => why === "gap");
  const { windowEnd } = snapshotWindow(NOW, 1440, 9);
  const keep = s2.readWindow("bitget", victim, windowEnd - 3 * 3_600_000, windowEnd).rows.at(-1);
  s2.write("bitget", victim, [{ openMs: keep[0], open: keep[1], high: keep[2], low: keep[3], close: keep[4], volume: keep[5] }]);
  setClock(NOW + 10 * MINUTE_MS + 2);
  const again = await svc.snapshot("bitget", 1440, 9);
  assert.equal(calls, 2, "a moved file is a real retry");
  assert.ok(again.ok && again.payload.generatedAtMs === NOW + 10 * MINUTE_MS + 2);
  setClock(NOW);
});

await test("the store's per-day held counts and the served-window split are exact against a brute-force count", () => {
  for (const symbol of roster) {
    const { coverage, heldByDay } = store.coverageDetail("bitget", symbol, true);
    if (coverage.firstClosedMs === null) continue;
    let total = 0;
    for (const n of heldByDay.values()) total += n;
    assert.equal(total, coverage.count, symbol);
    const rows = store.readWindow("bitget", symbol, coverage.firstClosedMs, coverage.lastClosedMs).rows;
    assert.equal(rows.length, coverage.count, `${symbol} count agrees with readWindow`);
  }
  // write() reports newly filled minutes per day, summing to newlyFilled.
  const w = store.write("bitget", "S06USDT", Array.from({ length: 60 }, (_, i) => ({
    openMs: DAY0 + 8 * DAY_MS + (90 + i) * MINUTE_MS, open: 1, high: 1, low: 1, close: 1, volume: 1,
  })));
  let sum = 0;
  for (const n of w.newlyFilledByDay.values()) sum += n;
  assert.equal(sum, w.newlyFilled);
  assert.equal(w.newlyFilled, 40, "only the 40 minutes of the hole were empty");
});

// ── collector-backed checks (no network: a stub venue) ──────────────────────
const BG_NOW = NOW;
function stub(opts) {
  const state = { now: opts.now, missing: opts.missing ?? {}, requests: [], limitAfter: opts.limitAfter ?? null, klines: 0 };
  const fetchLike = async (url) => {
    state.requests.push(url);
    if (url.includes("/mix/market/contracts")) {
      return { ok: true, status: 200, json: async () => ({ code: "00000", data: opts.symbols.map((symbol) => ({ symbol, symbolStatus: "normal" })) }) };
    }
    state.klines++;
    if (state.limitAfter !== null && state.klines > state.limitAfter) {
      return { ok: false, status: 429, json: async () => ({}), headers: { get: () => null } };
    }
    const u = new URL(url);
    const symbol = u.searchParams.get("symbol");
    const startMs = Number(u.searchParams.get("startTime"));
    const endMs = Number(u.searchParams.get("endTime"));
    const cap = Math.min(endMs, Math.floor(state.now / MINUTE_MS) * MINUTE_MS);
    const data = [];
    for (let t = Math.max(startMs, opts.since ?? 0); t <= cap; t += MINUTE_MS) {
      if (state.missing[symbol]?.has(t)) continue;
      data.push([String(t), "1", "2", "0.5", "1.5", "3", "4"]);
      if (data.length >= 200) break;
    }
    return { ok: true, status: 200, json: async () => ({ code: "00000", data }) };
  };
  return { state, fetchLike };
}

await test("a repair the venue cannot answer backs off instead of being re-requested every tick, and a younger hole is repaired behind it", async () => {
  const dataDir = tmpDir("repair");
  const s = new CandleStore(path.join(dataDir, "candles"));
  const end = newestClosedOpenMs(BG_NOW) - MINUTE_MS;
  const old1 = end - 5 * DAY_MS; // the venue has nothing for this minute
  const young = end - 2 * DAY_MS; // this one it does have
  const rows = [];
  for (let t = end - 6 * DAY_MS; t <= end; t += MINUTE_MS) if (t !== old1 && t !== young) rows.push({ openMs: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 });
  s.write("bitget", "HOLEUSDT", rows);
  let clock = BG_NOW;
  const venue = stub({ symbols: ["HOLEUSDT"], now: clock, missing: { HOLEUSDT: new Set([old1]) }, since: end - 6 * DAY_MS });
  const svc = new CandleService(
    { dataDir, venues: ["bitget"], keyId: "seed-1", options: { ...DEFAULT_COLLECTOR_OPTIONS, retentionDays: 6 }, tickMs: 60_000 },
    { sign, fetchLike: venue.fetchLike, now: () => clock, sleep: async () => {}, log: () => {} },
  );
  const repairsAt = (start) => venue.state.requests.filter((u) => u.includes(`startTime=${start}&`) || u.endsWith(`startTime=${start}`)).length;
  for (let i = 0; i < 12; i++) { venue.state.now = clock; await svc.tickAll(clock); clock += 60_000; }
  const col = svc.collector("bitget");
  assert.ok(repairsAt(old1) >= 1, "the old hole was tried");
  assert.ok(repairsAt(old1) <= 2, `and not re-requested every tick (${repairsAt(old1)} requests in 12 ticks)`);
  assert.equal(s.readWindow("bitget", "HOLEUSDT", young, young).rows.length, 1, "the younger hole behind it was repaired");
  assert.equal(col.cachedCoverage("HOLEUSDT").interiorMissing, 1, "only the unanswerable minute is still missing");
  const { windowStart, windowEnd } = snapshotWindow(clock, 1440, 6);
  assert.equal(col.snapshotSkipIsTransient("HOLEUSDT", "gap", windowStart, clock, windowEnd), false,
    "a gap no pending work can close is structural for the snapshot cache");
  // After the back-off it is tried again — a few times a day, not never.
  clock += REPAIR_BACKOFF_BASE_MS + 60_000;
  const before = repairsAt(old1);
  for (let i = 0; i < 12; i++) { venue.state.now = clock; await svc.tickAll(clock); clock += 60_000; }
  assert.ok(repairsAt(old1) > before, "retried once the back-off expired");
  // The health split: the hole is five days old, inside the 30-day window.
  const status = svc.status(clock).find((v) => v.venue === "bitget");
  assert.equal(status.liveMissingMinutes, 1);
  assert.equal(status.oldMissingMinutes, 0);
  assert.equal(status.counts.gapped, 1);
  assert.equal(status.gapWindowDays, HEALTH_GAP_WINDOW_DAYS);
});

await test("a hole older than the served window is reported as OLD and no longer makes the symbol gapped", async () => {
  const dataDir = tmpDir("oldgap");
  const s = new CandleStore(path.join(dataDir, "candles"));
  const end = newestClosedOpenMs(BG_NOW) - MINUTE_MS;
  const oldHole = end - 40 * DAY_MS;
  const rows = [];
  for (let t = end - 45 * DAY_MS; t <= end; t += MINUTE_MS) if (t < oldHole || t > oldHole + 2 * MINUTE_MS) rows.push({ openMs: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 });
  s.write("bitget", "OLDUSDT", rows);
  let clock = BG_NOW;
  const venue = stub({ symbols: ["OLDUSDT"], now: clock, missing: { OLDUSDT: new Set([oldHole, oldHole + MINUTE_MS, oldHole + 2 * MINUTE_MS]) }, since: end - 45 * DAY_MS });
  const svc = new CandleService(
    { dataDir, venues: ["bitget"], keyId: "seed-1", options: { ...DEFAULT_COLLECTOR_OPTIONS, retentionDays: 63 }, tickMs: 60_000 },
    { sign, fetchLike: venue.fetchLike, now: () => clock, sleep: async () => {}, log: () => {} },
  );
  for (let i = 0; i < 3; i++) { venue.state.now = clock; await svc.tickAll(clock); clock += 60_000; }
  const v = svc.status(clock).find((x) => x.venue === "bitget");
  const row = v.counts;
  assert.equal(v.totalMissingMinutes, 3, "the hole is still reported");
  assert.equal(v.oldMissingMinutes, 3);
  assert.equal(v.liveMissingMinutes, 0);
  assert.equal(row.gapped, 0, "nothing the Hub serves can read it");
  assert.equal(row.oldGapped, 1);
});

await test("after a refusal the rate recovers only to 80% of the refused rate for an hour, then may reach the ceiling", async () => {
  const dataDir = tmpDir("ratemem");
  let clock = BG_NOW;
  const symbols = Array.from({ length: 60 }, (_, i) => `R${i}USDT`);
  const venue = stub({ symbols, now: clock, limitAfter: 0 });
  const svc = new CandleService(
    { dataDir, venues: ["bitget"], keyId: "seed-1", options: { ...DEFAULT_COLLECTOR_OPTIONS, requestsPerSecond: 4, minRequestsPerSecond: 0.5, rateLimitCooldownMs: 1_000, rateLimitMaxCooldownMs: 1_000 }, tickMs: 60_000 },
    { sign, fetchLike: venue.fetchLike, now: () => clock, sleep: async (ms) => { clock += ms; }, log: () => {} },
  );
  const col = svc.collector("bitget");
  // First tick spends one request on the symbol list, then the first kline is refused at 4/s.
  await svc.tickAll(clock);
  assert.equal(col.health(clock).effectiveRps, 2);
  venue.state.limitAfter = null;
  const refusedAt = clock;
  let peak = 0;
  while (clock - refusedAt < RATE_REFUSED_MEMORY_MS - 10 * 60_000) {
    clock += 60_000; venue.state.now = clock;
    await svc.tickAll(clock);
    peak = Math.max(peak, col.health(clock).effectiveRps);
  }
  assert.ok(peak > 2 && peak <= 3.2 + 1e-9, `inside the hour recovery stops at 80% of 4/s (peak ${peak})`);
  clock = refusedAt + RATE_REFUSED_MEMORY_MS + 1;
  for (let i = 0; i < 30 && col.health(clock).effectiveRps < 4; i++) { clock += 60_000; venue.state.now = clock; await svc.tickAll(clock); }
  assert.equal(col.health(clock).effectiveRps, 4, "after the hour it probes the configured ceiling again");
});

await test("1m settle lag is one bucket: at every second of minute M the anchor is M-2 and it expires exactly at M+1; >=3m keep 90 s", async () => {
  assert.equal(snapshotSettleLagMs(1), MINUTE_MS);
  for (const i of SNAPSHOT_INTERVALS.filter((x) => x >= 3)) assert.equal(snapshotSettleLagMs(i), SNAPSHOT_SETTLE_LAG_MS, `${i}m unchanged`);
  const M = Date.UTC(2026, 9, 24, 21, 30);
  for (let ms = 0; ms < MINUTE_MS; ms += 250) {
    const anchor = newestCompleteBucketOpenMs(M + ms, 1);
    assert.equal(anchor, M - 2 * MINUTE_MS, `second ${ms / 1000}`);
    assert.equal(snapshotExpiresAtMs(anchor, 1), M + MINUTE_MS);
  }
  assert.equal(newestCompleteBucketOpenMs(M + MINUTE_MS - 1, 1), M - 2 * MINUTE_MS);
  assert.equal(newestCompleteBucketOpenMs(M + MINUTE_MS, 1), M - MINUTE_MS, "and rolls exactly on the boundary");
});

// The app's real verifier, when this box has the app build (it is not a
// dependency of the Hub; CI without it skips this one check, loudly).
const APP_VERIFIER = process.env.WH_APP_VOLHUB_MODULE ?? "/root/wh-0916-release/build-user/dist/engine/volatility-hub-seed.js";
await test("the app's own verifier accepts the Hub's 1m snapshot at every second of a minute (and 3m/5m across their buckets)", async () => {
  if (!fs.existsSync(APP_VERIFIER)) { console.log(`    (SKIPPED: no app build at ${APP_VERIFIER})`); return; }
  const { verifyVolatilityHubSnapshot, volatilityHubKeyFor } = await import(pathToFileURL(APP_VERIFIER).href);
  const { publicKey, privateKey: pk } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
  const dir = tmpDir("app1m");
  const st = new CandleStore(path.join(dir, "candles"));
  const M = Date.UTC(2026, 9, 24, 21, 30);
  const rows = [];
  for (let t = M - 3 * DAY_MS; t <= M + 20 * MINUTE_MS; t += MINUTE_MS) rows.push({ openMs: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 });
  st.write("bybit", "BTCUSDT", rows);
  let checked = 0;
  for (const [interval, depth, span] of [[1, 30, MINUTE_MS], [3, 10, 3 * MINUTE_MS], [5, 10, 5 * MINUTE_MS]]) {
    for (let ms = 0; ms < span; ms += 1000) {
      const now = M + 5 * MINUTE_MS + ms;
      const out = buildSnapshot({ venue: "bybit", interval, depth, now }, { store: st, keyId: "seed-1", sign: (b) => edSign(null, b, pk), symbols: () => ["BTCUSDT"] });
      assert.equal(out.ok, true);
      const body = JSON.parse(JSON.stringify(out.payload));
      const v = verifyVolatilityHubSnapshot(body, { venue: "bybit", tfMinutes: interval, depth, now, keyFor: (id) => volatilityHubKeyFor(id, pub) });
      assert.equal(v.ok, true, `${interval}m at +${ms / 1000}s: ${v.reason}`);
      checked++;
    }
  }
  console.log(`    (the app verifier accepted ${checked} snapshots across every second of the 1m, 3m and 5m phases)`);
});

await test("a build queued behind busy slots past a boundary folds the window of NOW, not of when it was asked", async () => {
  let clock = NOW - 3 * 3_600_000; // early enough that the rolled hour is still held
  const jobs = [];
  const gates = [];
  const fold = async (job) => {
    jobs.push(job);
    if (gates.length < SNAPSHOT_WORKER_CONCURRENCY) await new Promise((r) => gates.push(r));
    return runSnapshotWorker(job);
  };
  const dir = tmpDir("snapqueue");
  fs.cpSync(store.rootDir, path.join(dir, "candles"), { recursive: true });
  const svc = new CandleService(
    { dataDir: dir, venues: [], keyId: "seed-1", options: { ...DEFAULT_COLLECTOR_OPTIONS }, tickMs: 60_000 },
    { sign, now: () => clock, log: () => {}, snapshotFold: fold },
  );
  const blockers = [svc.snapshot("bitget", 1440, 3), svc.snapshot("bitget", 1440, 4)];
  while (gates.length < SNAPSHOT_WORKER_CONCURRENCY) await new Promise((r) => setImmediate(r));
  const asked = newestCompleteBucketOpenMs(clock, 60);
  const queued = svc.snapshot("bitget", 60, 5); // waits for a slot
  await new Promise((r) => setImmediate(r));
  clock += 60 * MINUTE_MS; // the hour rolls while it waits
  for (const g of gates) g();
  await Promise.all(blockers);
  const r = await queued;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(jobs.at(-1).now, clock, "the fold was given the clock at the moment it got a slot");
  assert.equal(r.payload.lastClosedMs, asked + 60 * MINUTE_MS, "and answers the rolled window");
  // An identical later request inside that window is a cache hit.
  const again = await svc.snapshot("bitget", 60, 5);
  assert.equal(again, r);
});

await test("the repair back-off resets: a filling repair zeroes its escalation, and an expired back-off whose hole is gone is forgotten", async () => {
  const dataDir = tmpDir("repairreset");
  const s = new CandleStore(path.join(dataDir, "candles"));
  const end = newestClosedOpenMs(BG_NOW) - MINUTE_MS;
  const hole = end - 4 * DAY_MS;
  const rows = [];
  for (let t = end - 5 * DAY_MS; t <= end; t += MINUTE_MS) if (t !== hole) rows.push({ openMs: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 });
  s.write("bitget", "RSTUSDT", rows);
  let clock = BG_NOW;
  const missing = new Set([hole]);
  const venue = stub({ symbols: ["RSTUSDT"], now: clock, missing: { RSTUSDT: missing }, since: end - 5 * DAY_MS });
  const svc = new CandleService(
    { dataDir, venues: ["bitget"], keyId: "seed-1", options: { ...DEFAULT_COLLECTOR_OPTIONS, retentionDays: 5 }, tickMs: 60_000 },
    { sign, fetchLike: venue.fetchLike, now: () => clock, sleep: async () => {}, log: () => {} },
  );
  const col = svc.collector("bitget");
  const tick = async (n) => { for (let i = 0; i < n; i++) { venue.state.now = clock; await svc.tickAll(clock); clock += 60_000; } };
  await tick(6);
  assert.equal(col.repairBackoff("RSTUSDT")?.failures, 1, "the unanswerable hole backed off once");
  // Twice more, so the escalation is real.
  clock = col.repairBackoff("RSTUSDT").until + 1; await tick(3);
  assert.equal(col.repairBackoff("RSTUSDT")?.failures, 2);
  // The venue publishes the minute after all. Once the back-off expires the
  // repair fills it; the escalation is gone with the hole.
  missing.clear();
  clock = col.repairBackoff("RSTUSDT").until + 1; await tick(4);
  assert.equal(s.readWindow("bitget", "RSTUSDT", hole, hole).rows.length, 1, "the repair filled the hole");
  assert.equal(col.repairBackoff("RSTUSDT"), null, "nothing left to back off from: forgotten, so the next hole starts at the base interval");

  // A filling repair of a younger hole zeroes the counter of a symbol whose
  // older hole is still proven empty.
  const old = end - 3 * DAY_MS, young = end - 2 * DAY_MS;
  const r2 = rows.filter((x) => x.openMs !== old && x.openMs !== young);
  const d2 = tmpDir("repairreset2");
  new CandleStore(path.join(d2, "candles")).write("bitget", "TWOUSDT", r2);
  const v2 = stub({ symbols: ["TWOUSDT"], now: clock, missing: { TWOUSDT: new Set([old]) }, since: end - 5 * DAY_MS });
  const svc2 = new CandleService(
    { dataDir: d2, venues: ["bitget"], keyId: "seed-1", options: { ...DEFAULT_COLLECTOR_OPTIONS, retentionDays: 5 }, tickMs: 60_000 },
    { sign, fetchLike: v2.fetchLike, now: () => clock, sleep: async () => {}, log: () => {} },
  );
  for (let i = 0; i < 8; i++) { v2.state.now = clock; await svc2.tickAll(clock); clock += 60_000; }
  const b2 = svc2.collector("bitget").repairBackoff("TWOUSDT");
  assert.ok(b2 && b2.afterMs > old, "the old hole is still skipped");
  assert.equal(b2.failures, 0, "but the younger hole's filling repair reset the escalation");
});

summary("candles-snapshot-worker");
