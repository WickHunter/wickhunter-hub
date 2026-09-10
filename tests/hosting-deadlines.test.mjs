// tests/hosting-deadlines.test.mjs — H6's pure `deadlines()` policy, the
// explicit test target named in the handoff (Part 1B §16/§18). UTC-based
// arithmetic only, so every case below is DST-safe by construction; the
// last section proves it across a real US DST transition.
import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import { deadlines } from "../dist/src/hosting/deadlines.js";

const HOUR = 60 * 60 * 1000;
const policy = { renewalGraceHours: 72, retentionHours: 168, reminderHoursBeforeDelete: [72, 24] };

await test("nonpayment: T+72h suspend, T+240h (72+168) delete, reminders at delete-72h/-24h — the handoff's own worked example", () => {
  const T = Date.parse("2026-10-01T12:00:00Z");
  const d = deadlines(T, "renewal_unpaid", policy);
  assert.equal(new Date(d.suspendAt).toISOString(), "2026-10-04T12:00:00.000Z");
  assert.equal(new Date(d.threeDaysAt).toISOString(), "2026-10-08T12:00:00.000Z");
  assert.equal(new Date(d.oneDayAt).toISOString(), "2026-10-10T12:00:00.000Z");
  assert.equal(new Date(d.deleteAt).toISOString(), "2026-10-11T12:00:00.000Z");
  // "a ten-day maximum unpaid lifecycle" — exactly 240 hours from T.
  assert.equal(d.deleteAt - T, 240 * HOUR);
});

await test("voluntary cancellation: suspend AT T (no grace), delete T+168h", () => {
  const T = Date.parse("2026-10-01T12:00:00Z");
  const d = deadlines(T, "intentional_cancellation", policy);
  assert.equal(d.suspendAt, T);
  assert.equal(new Date(d.threeDaysAt).toISOString(), "2026-10-05T12:00:00.000Z");
  assert.equal(new Date(d.oneDayAt).toISOString(), "2026-10-07T12:00:00.000Z");
  assert.equal(new Date(d.deleteAt).toISOString(), "2026-10-08T12:00:00.000Z");
});

await test("rejects a non-finite entitlement anchor rather than producing NaN deadlines that compare false forever", () => {
  assert.throws(() => deadlines(Number.NaN, "renewal_unpaid", policy), /invalid entitlement anchor/);
  assert.throws(() => deadlines(Infinity, "renewal_unpaid", policy));
});

await test("DST-safe: the exact same 312-hour span across a US 'spring forward' boundary as across an ordinary week", () => {
  // 2026-03-08 is the US DST transition (02:00 -> 03:00 local, spring
  // forward) — a calendar-day-counting implementation would get this
  // wrong; UTC-millisecond arithmetic cannot, because it never looks at a
  // calendar at all.
  const acrossDst = deadlines(Date.parse("2026-03-01T12:00:00Z"), "renewal_unpaid", policy);
  const ordinary = deadlines(Date.parse("2026-06-01T12:00:00Z"), "renewal_unpaid", policy);
  assert.equal(acrossDst.deleteAt - acrossDst.suspendAt, ordinary.deleteAt - ordinary.suspendAt);
  assert.equal(acrossDst.suspendAt - Date.parse("2026-03-01T12:00:00Z"), 72 * HOUR);
  assert.equal(acrossDst.deleteAt - Date.parse("2026-03-01T12:00:00Z"), 240 * HOUR);
});

await test("an operator-configured policy (different grace/retention/reminders) is honoured, not the handoff's hard-coded constants", () => {
  const custom = { renewalGraceHours: 24, retentionHours: 48, reminderHoursBeforeDelete: [12, 2] };
  const T = Date.parse("2026-05-01T00:00:00Z");
  const d = deadlines(T, "renewal_unpaid", custom);
  assert.equal(d.suspendAt - T, 24 * HOUR);
  assert.equal(d.deleteAt - d.suspendAt, 48 * HOUR);
  assert.equal(d.deleteAt - d.threeDaysAt, 12 * HOUR);
  assert.equal(d.deleteAt - d.oneDayAt, 2 * HOUR);
});

await test("an anchor never moves because the caller re-derives at a different `now` — pure function of its inputs alone", () => {
  const T = Date.parse("2026-01-01T00:00:00Z");
  const a = deadlines(T, "renewal_unpaid", policy);
  const b = deadlines(T, "renewal_unpaid", policy);
  assert.deepEqual(a, b);
});

summary("hosting-deadlines");
