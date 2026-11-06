// A faithful JavaScript port of the Alpha app's v2 timeframe seed verifier
// (liqhunter origin/alpha/zack-qfl-0.91.12, src/bots/olb-timeframe-history.ts
// olbTimeframeEnvelope + olbTimeframeContent, and
// src/venues/bitunix-carried-open.ts). The Hub tests run long-window seeds
// through it so "the app accepts this" is proved, not assumed. Keep it in step
// with the app when either side changes the contract.
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

const M1 = 60_000;
const INTERVALS = [3, 5, 15, 30, 60, 120, 180, 240, 360, 720, 1440];
const KEY_ORDER = ["v", "venue", "symbol", "interval", "fromMs", "toMs", "requiredFromMs", "requiredClosedToMs",
  "closedFrontierMs", "availableFromMs", "availableRows", "requiredRows", "complete", "rows", "gaps", "segments", "keyId"];
const ENVELOPE_KEYS = [...KEY_ORDER, "sig"];
const safeInt = (v) => Number.isSafeInteger(v) && v >= 0;
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const bad = (error) => ({ ok: false, error });
const carried = (venue, current, previous, step) => venue === "bitunix" && previous !== undefined
  && current.start - previous.start === step && current.open === previous.close;

function canonical(e) {
  return Buffer.from(JSON.stringify({
    v: e.v, venue: e.venue, symbol: e.symbol, interval: e.interval, fromMs: e.fromMs, toMs: e.toMs,
    requiredFromMs: e.requiredFromMs, requiredClosedToMs: e.requiredClosedToMs, closedFrontierMs: e.closedFrontierMs,
    availableFromMs: e.availableFromMs, availableRows: e.availableRows, requiredRows: e.requiredRows,
    complete: e.complete, rows: e.rows, gaps: e.gaps, segments: e.segments, keyId: e.keyId,
  }), "utf8");
}

export function appEnvelope(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return bad("body is not a JSON object");
  const keys = Object.keys(o);
  if (keys.length !== ENVELOPE_KEYS.length || ENVELOPE_KEYS.some((k) => !Object.prototype.hasOwnProperty.call(o, k))) {
    return bad("timeframe seed fields do not match the Hub v2 contract");
  }
  if (o.v !== 2) return bad("unsupported version");
  return { ok: true, value: o };
}

export function appSignatureOk(e, publicKeyPem) {
  try { return cryptoVerify(null, canonical(e), createPublicKey(publicKeyPem), Buffer.from(e.sig, "base64")); }
  catch { return false; }
}

export function appContent(e, expect) {
  const interval = expect.intervalMinutes;
  const step = interval * M1;
  if (!INTERVALS.includes(interval)) return bad("target interval is outside the Hub v2 contract");
  if (e.venue !== expect.venue || e.symbol !== expect.symbol || e.interval !== String(interval)) return bad("identity");
  if (e.fromMs !== expect.fromMs || e.toMs !== expect.toMs) return bad("window echo");
  const requiredFromMs = Math.ceil(expect.fromMs / step) * step;
  const requiredClosedToMs = Math.min(Math.floor(expect.toMs / step) * step, Math.floor(expect.nowMs / step) * step - step);
  const requiredRows = requiredClosedToMs < requiredFromMs ? 0 : (requiredClosedToMs - requiredFromMs) / step + 1;
  if (requiredRows < 1 || requiredRows > 50_000) return bad("no closed rows or over the limit");
  if (e.requiredFromMs !== requiredFromMs || e.requiredClosedToMs !== requiredClosedToMs || e.requiredRows !== requiredRows) return bad("required-window arithmetic");
  if (e.availableRows !== e.rows.length) return bad("availableRows");
  const rows = [];
  let unprovenBoundary = false;
  for (let i = 0; i < e.rows.length; i++) {
    const r = e.rows[i];
    if (!Array.isArray(r) || r.length !== 6 || !r.every(finite)) return bad(`row ${i} shape`);
    const [start, open, high, low, close, volume] = r;
    if (!safeInt(start) || start % step !== 0 || start < requiredFromMs || start > requiredClosedToMs) return bad(`row ${i} outside window`);
    if (!(open > 0 && high > 0 && low > 0 && close > 0 && volume >= 0) || high < low || high < close || low > close) return bad(`row ${i} OHLCV`);
    if ((high < open || low > open) && !carried(e.venue, { start, open }, rows.at(-1), step)) {
      if (i === 0 && e.venue === "bitunix") unprovenBoundary = true;
      else return bad(`row ${i} unproven open`);
    }
    if (rows.length && start <= rows[rows.length - 1].start) return bad(`row ${i} order`);
    rows.push({ start, open, high, low, close, volume });
  }
  if (!rows.length) return bad("no rows");
  if (e.availableFromMs !== rows[0].start) return bad("availableFromMs");
  if (e.closedFrontierMs !== rows[rows.length - 1].start) return bad("closedFrontierMs");
  const exactGaps = [];
  const present = new Set(rows.map((r) => r.start));
  let gapStart = null;
  for (let at = requiredFromMs; at <= requiredClosedToMs; at += step) {
    if (!present.has(at) && gapStart === null) gapStart = at;
    if (present.has(at) && gapStart !== null) { exactGaps.push([gapStart, at - step]); gapStart = null; }
  }
  if (gapStart !== null) exactGaps.push([gapStart, requiredClosedToMs]);
  if (JSON.stringify(e.gaps) !== JSON.stringify(exactGaps)) return bad("gaps are not the exact missing ranges");
  let rowAt = 0;
  for (let i = 0; i < e.segments.length; i++) {
    const seg = e.segments[i];
    if (!Array.isArray(seg) || seg.length !== 4 || seg[0] > seg[1] || seg[0] % step || seg[1] % step) return bad(`segment ${i}`);
    if (seg[2] === "native" && seg[3] !== interval) return bad(`segment ${i} native base`);
    if (seg[2] === "aggregate" && seg[3] >= interval) return bad(`segment ${i} aggregate base`);
    if (rows[rowAt]?.start !== seg[0]) return bad(`segment ${i} start`);
    let expectedAt = seg[0];
    while (rowAt < rows.length && rows[rowAt].start <= seg[1]) {
      if (rows[rowAt].start !== expectedAt) return bad(`segment ${i} crosses a gap`);
      expectedAt += step; rowAt++;
    }
    if (expectedAt - step !== seg[1]) return bad(`segment ${i} end`);
    const prior = e.segments[i - 1];
    if (prior && prior[1] + step === seg[0] && prior[2] === seg[2] && prior[3] === seg[3]) return bad(`segment ${i} not compressed`);
  }
  if (rowAt !== rows.length) return bad("segments do not cover every row");
  const exactGrid = rows.length === requiredRows && rows.every((r, i) => r.start === requiredFromMs + i * step);
  const derivedComplete = exactGrid && exactGaps.length === 0;
  if (e.complete !== derivedComplete) return bad("complete disagrees");
  return { ok: true, value: { rows: unprovenBoundary ? rows.slice(1) : rows, complete: derivedComplete && !unprovenBoundary } };
}
