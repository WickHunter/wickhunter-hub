// Small semantic fixtures for allocation changes; the cold700 gate is unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { test } from 'node:test';
import { TimeframeHistory, canonicalTimeframeBytes } from '../dist/src/candles/timeframe.js';

const M = 60_000, D = Date.parse('2026-08-01T00:00:00Z');
const keys = generateKeyPairSync('ed25519');
const signer = bytes => sign(null, bytes, keys.privateKey);
const row = (i, n = i) => [D + i * M, 100 + n, 103 + n, 99 + n, 102 + n, n + 0.1];
const asCandle = r => ({ openMs: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] });
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wickhub-tf-allocation-'));
  let rows = [], reads = 0;
  const minutes = { readWindow: (_v, _s, from, to) => {
    reads++;
    return { rows: rows.filter(r => r[0] >= from && r[0] <= to), gaps: [] };
  } };
  const h = new TimeframeHistory(root, minutes, 30);
  const f = { root, h, minutes, set: value => { rows = value; }, reads: () => reads,
    request: (venue = 'bybit', symbol = 'PAIRUSDT', interval = 3, from = D, to = D + 5 * M, frontier = D + 5 * M, now = D + 60 * M) =>
      h.request(venue, symbol, interval, from, to, now, frontier, 'test-key', signer) };
  try { return fn(f); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function signed(out) {
  assert.equal(out.ok, true);
  const { sig, ...unsigned } = out.payload;
  assert.equal(verify(null, canonicalTimeframeBytes(unsigned), keys.publicKey, Buffer.from(sig, 'base64')), true);
  return out.payload;
}

test('ordered and shuffled duplicate minutes preserve exact OHLCV, sum order, signature and immutable inputs', () => fixture(f => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i));
  rows[0][5] = 1e16; rows[1][5] = 1; rows[2][5] = 1;
  const duplicate = [...rows[1]]; duplicate[2] = 999;
  const raw = [rows[4], rows[0], rows[1], rows[5], rows[2], rows[3], duplicate];
  raw.forEach(Object.freeze); Object.freeze(raw); f.set(raw);
  const out = signed(f.request());
  assert.deepEqual(out.rows, [[D, 100, 999, 99, 104, 1e16], [D + 3 * M, 103, 108, 102, 107, 12.299999999999999]]);
  assert.equal(out.complete, true); assert.deepEqual(out.gaps, []);
  assert.deepEqual(out.segments, [[D, D + 3 * M, 'aggregate', 1]]);
  const bytes = canonicalTimeframeBytes(out);
  assert.deepEqual(canonicalTimeframeBytes(signed(f.request())), bytes);
  assert.equal(f.reads(), 1, 'warm request performs no second minute read');
  assert.deepEqual(raw.map(r => r[0]), [4, 0, 1, 5, 2, 3, 1].map(i => D + i * M));
}));

test('each malformed field and a missing minute prevent only its complete target bucket', () => fixture(f => {
  const invalid = [
    [1, NaN], [2, Infinity], [3, -Infinity], [4, NaN], [5, Infinity],
    [1, 0], [2, -1], [3, 0], [4, -1], [5, -1],
    [1, 900], [2, 1], [3, 999],
  ];
  for (const [i, [field, value]] of invalid.entries()) {
    const rows = Array.from({ length: 6 }, (_, i) => row(i)); rows[1][field] = value; f.set(rows);
    const p = signed(f.request('bybit', `BAD${i}USDT`));
    assert.equal(p.complete, false); assert.deepEqual(p.gaps, [[D, D]]);
    assert.deepEqual(p.rows.map(r => r[0]), [D + 3 * M]);
  }
  f.set([row(0), row(2), row(3), row(4), row(5)]);
  assert.deepEqual(signed(f.request('bybit', 'MISSINGUSDT')).gaps, [[D, D]]);
}));

test('REST frontier and forming target exclusion advance without stale materialization reuse', () => fixture(f => {
  f.set(Array.from({ length: 6 }, (_, i) => row(i)));
  const partial = signed(f.request('bybit', 'FRONTUSDT', 3, D, D + 5 * M, D + 4 * M));
  assert.equal(partial.complete, false); assert.deepEqual(partial.gaps, [[D + 3 * M, D + 3 * M]]);
  const advanced = signed(f.request('bybit', 'FRONTUSDT'));
  assert.equal(advanced.complete, true); assert.equal(advanced.availableRows, 2);
  const forming = signed(f.request('bybit', 'FORMUSDT', 3, D, D + 5 * M, D + 5 * M, D + 5 * M));
  assert.equal(forming.requiredRows, 1); assert.equal(forming.requiredClosedToMs, D);
  assert.equal(f.request('bybit', 'NULLUSDT', 3, D, D + 5 * M, null).ok, false);
}));

test('Bitunix carried opens require an exact predecessor and malformed rows reset boundary evidence', () => fixture(f => {
  const predecessor = [D - M, 90, 102, 89, 101, 1];
  const carried = [D, 101, 103, 102, 102.5, 1];
  f.set([predecessor, carried, row(1), row(2)]);
  assert.equal(signed(f.request('bitunix', 'CARRYUSDT', 3, D, D + 2 * M, D + 2 * M)).complete, true);
  assert.equal(f.request('bybit', 'CARRYUSDT', 3, D, D + 2 * M, D + 2 * M).ok, false);
  f.set([carried, row(1), row(2)]);
  assert.equal(f.request('bitunix', 'NOPREVUSDT', 3, D, D + 2 * M, D + 2 * M).ok, false);
  f.set([predecessor, [D - M / 2, 1, 2, 1, 1, 1], carried, row(1), row(2)]);
  assert.equal(f.request('bitunix', 'RESETUSDT', 3, D, D + 2 * M, D + 2 * M).ok, false);
}));

test('minute corrections persist on restart; instrument generation fences the old cache and minute base', () => fixture(f => {
  let rows = Array.from({ length: 6 }, (_, i) => row(i)); f.set(rows);
  f.h.noteInstrumentRoster('bybit', [{ symbol: 'PAIRUSDT', generation: `first:${D}` }]);
  const before = signed(f.request());
  rows = rows.map((r, i) => i === 1 ? [r[0], r[1], 888, r[3], r[4], r[5]] : r); f.set(rows);
  f.h.noteMinuteRows('bybit', 'PAIRUSDT', [asCandle(rows[1])], D + 5 * M);
  const corrected = signed(f.request());
  assert.equal(corrected.rows[0][2], 888); assert.notEqual(corrected.sig, before.sig);
  const restart = new TimeframeHistory(f.root, f.minutes, 30);
  assert.deepEqual(restart.request('bybit', 'PAIRUSDT', 3, D, D + 5 * M, D + 60 * M, D + 5 * M, 'test-key', signer), { ok: true, payload: corrected });
  restart.noteInstrumentRoster('bybit', [{ symbol: 'PAIRUSDT', generation: `second:${D + 6 * M}` }]);
  assert.equal(restart.request('bybit', 'PAIRUSDT', 3, D, D + 5 * M, D + 60 * M, D + 5 * M, 'test-key', signer).ok, false);
}));

test('native target precedence survives aggregate corrections and compatible native base carries provenance', () => fixture(f => {
  f.set(Array.from({ length: 180 }, (_, i) => row(i)));
  const native = { openMs: D, open: 11, high: 15, low: 10, close: 12, volume: 3 };
  const work = { key: 'native', venue: 'bybit', symbol: 'NATIVEUSDT', interval: 60, targetInterval: 60, startMs: D, endMs: D + 120 * M };
  f.h.record(work, { candles: [native, { ...native, openMs: D + 60 * M }, { ...native, openMs: D + 120 * M }], empty: false }, D + 240 * M);
  const direct = signed(f.request('bybit', 'NATIVEUSDT', 60, D, D, D + 179 * M, D + 240 * M));
  f.h.noteMinuteRows('bybit', 'NATIVEUSDT', [asCandle(row(1))], D + 179 * M);
  assert.deepEqual(signed(f.request('bybit', 'NATIVEUSDT', 60, D, D, D + 179 * M, D + 240 * M)), direct);
  const derived = signed(f.request('bybit', 'NATIVEUSDT', 180, D, D, D + 179 * M, D + 240 * M));
  assert.deepEqual(derived.rows, [[D, 11, 15, 10, 12, 9]]);
  assert.deepEqual(derived.segments, [[D, D, 'aggregate', 60]]);
}));

test('failed atomic rename keeps prior cache intact and a later correction recovers normally', () => fixture(f => {
  let rows = Array.from({ length: 6 }, (_, i) => row(i)); f.set(rows); signed(f.request());
  const file = path.join(f.root, 'bybit', 'PAIRUSDT', '3', '2026-08-01.ctf2');
  const oldBytes = fs.readFileSync(file);
  rows = rows.map((r, i) => i === 1 ? [r[0], r[1], 777, r[3], r[4], r[5]] : r); f.set(rows);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw new Error('injected atomic rename failure'); return rename(from, to); };
  try { assert.throws(() => f.h.noteMinuteRows('bybit', 'PAIRUSDT', [asCandle(rows[1])], D + 5 * M), /injected atomic rename failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(file), oldBytes);
  f.h.noteMinuteRows('bybit', 'PAIRUSDT', [asCandle(rows[1])], D + 5 * M);
  assert.equal(signed(f.request()).rows[0][2], 777);
  assert.equal(fs.existsSync(`${file}.tmp.${process.pid}`), false);
}));

function cacheBytes(root) {
  const result = {};
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    result[path.relative(root, file)] = fs.readFileSync(file).toString('hex');
  }
  return result;
}
function countSourceIndexes(fn) {
  const OriginalMap = globalThis.Map;
  let inserted = 0;
  globalThis.Map = class extends OriginalMap {
    set(key, value) {
      if (Array.isArray(value) && value.length === 6 && typeof value[0] === 'number') inserted++;
      return super.set(key, value);
    }
  };
  try { return { value: fn(), inserted }; }
  finally { globalThis.Map = OriginalMap; }
}

test('dense and deliberately unordered fallback produce identical signed rows and persisted bytes across every interval and venue', () => {
  for (const venue of ['bybit', 'bitunix', 'bitget', 'binance', 'aster', 'weex']) {
    for (const target of [3, 5, 15, 30, 60, 120, 180, 240, 360, 720, 1440]) {
      const size = target * 2;
      const dense = Array.from({ length: size + 1 }, (_, j) => {
        const i = j - 1, n = j % 7;
        return [D + i * M, 100 + n, 103 + n, 99 + n, 102 + n, j % 3 ? 0.1 : 1e16];
      });
      // Strict rows stay independently valid on Bitunix too. Reversing only
      // switches indexing paths; it must not change chronological summation.
      dense.forEach(Object.freeze); Object.freeze(dense);
      const evaluate = rows => fixture(f => {
        f.set(rows);
        const observed = countSourceIndexes(() => signed(f.request(venue, 'PAIRUSDT', target,
          D, D + (size - 1) * M, D + (size - 1) * M, D + (size + target) * M)));
        const bytes = cacheBytes(f.root);
        assert.deepEqual(signed(f.request(venue, 'PAIRUSDT', target,
          D, D + (size - 1) * M, D + (size - 1) * M, D + (size + target) * M)), observed.value);
        assert.equal(f.reads(), 1, 'warm request does not rescan either representation');
        return { ...observed, bytes };
      });
      const fast = evaluate(dense), fallback = evaluate(Object.freeze([...dense].reverse()));
      assert.equal(fast.inserted, 0, `${venue}/${target}: dense rows allocate no timestamp Map entries`);
      assert.ok(fallback.inserted >= size, `${venue}/${target}: unordered rows exercise the preserved fallback`);
      assert.deepEqual(fast.value, fallback.value, `${venue}/${target}: exact signed payload, sum order and provenance`);
      assert.deepEqual(fast.bytes, fallback.bytes, `${venue}/${target}: exact persistent cache bytes`);
      assert.equal(dense[0][0], D - M, 'read-only source order is preserved');
    }
  }
});

test('dense prefixes and suffixes preserve missing buckets; irregular data exercises the original fallback', () => {
  for (const indices of [[1, 2, 3, 4, 5], [0, 1, 2, 3, 4]]) fixture(f => {
    f.set(indices.map(i => row(i)));
    const result = countSourceIndexes(() => signed(f.request()));
    assert.equal(result.inserted, 0, 'a contiguous partial window needs no timestamp Map');
    assert.equal(result.value.complete, false);
    assert.deepEqual(result.value.gaps, indices[0] === 1 ? [[D, D]] : [[D + 3 * M, D + 3 * M]]);
  });
  const variants = [
    ['gap', rows => { rows.splice(1, 1); }],
    ['duplicate last wins', rows => { const last = [...rows[1]]; last[2] = 999; rows.push(last); }],
    ['out of order', rows => { [rows[0], rows[1]] = [rows[1], rows[0]]; }],
    ['misaligned', rows => { rows[1][0] += M / 2; }],
    ['invalid finite field', rows => { rows[1][4] = NaN; }],
    ['invalid open envelope', rows => { rows[1][1] = 999; }],
  ];
  for (const [label, change] of variants) fixture(f => {
    const rows = Array.from({ length: 6 }, (_, i) => row(i)); change(rows);
    rows.forEach(Object.freeze); Object.freeze(rows); f.set(rows);
    const observed = countSourceIndexes(() => signed(f.request()));
    assert.ok(observed.inserted > 0, `${label}: exact original Map fallback is used`);
    if (label === 'duplicate last wins') assert.equal(observed.value.rows[0][2], 999);
    if (label === 'out of order') assert.equal(observed.value.complete, true);
    if (!['duplicate last wins', 'out of order'].includes(label)) assert.deepEqual(observed.value.gaps, [[D, D]]);
  });
  fixture(f => {
    f.set([[D - M, 90, 102, 89, 101, 1], [D, 101, 103, 102, 102.5, 1], row(1), row(2)]);
    const result = countSourceIndexes(() => signed(f.request('bitunix', 'CARRYUSDT', 3, D, D + 2 * M, D + 2 * M)));
    assert.ok(result.inserted > 0, 'Bitunix carried-open boundary remains on its predecessor-aware fallback');
    assert.equal(result.value.complete, true);
  });
});
