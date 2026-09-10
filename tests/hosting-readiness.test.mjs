// tests/hosting-readiness.test.mjs — the pure per-venue reachability
// verdict (docs/HOSTING-REGION-2026-09-10.md §4): refuse readiness, naming
// the venue, on any non-200; never silently drop a venue and mark ready.
import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import { classifyProbeStatus, readinessVerdict } from "../dist/src/hosting/readiness.js";
import { DEFAULT_PROBE_VENUES } from "../dist/src/hosting/policy.js";

const venues = [
  { id: "bybit", label: "Bybit", method: "GET", url: "https://api.bybit.com/v5/market/time", expectStatus: 200 },
  { id: "binance", label: "Binance USD-M", method: "GET", url: "https://fapi.binance.com/fapi/v1/time", expectStatus: 200 },
];

await test("classifyProbeStatus: 200 is ok; 403 is a CDN geo-block; 451 is a legal block; anything else is unexpected", () => {
  assert.equal(classifyProbeStatus(200).kind, "ok");
  assert.deepEqual(classifyProbeStatus(403), { kind: "blocked", status: 403, reason: "cdn-geo-block" });
  assert.deepEqual(classifyProbeStatus(451), { kind: "blocked", status: 451, reason: "legal-block" });
  assert.equal(classifyProbeStatus(500).reason, "unexpected-status");
});

await test("all venues ok -> ready, no refusals", () => {
  const v = readinessVerdict(venues, [
    { venueId: "bybit", outcome: { kind: "ok", status: 200 } },
    { venueId: "binance", outcome: { kind: "ok", status: 200 } },
  ]);
  assert.equal(v.ready, true);
  assert.deepEqual(v.refusals, []);
});

await test("Bybit's own documented shape — a 403 from its edge — refuses readiness and NAMES Bybit", () => {
  const v = readinessVerdict(venues, [
    { venueId: "bybit", outcome: { kind: "blocked", status: 403, reason: "cdn-geo-block" } },
    { venueId: "binance", outcome: { kind: "ok", status: 200 } },
  ]);
  assert.equal(v.ready, false);
  assert.equal(v.refusals.length, 1);
  assert.match(v.refusals[0], /Bybit/);
  assert.match(v.refusals[0], /403/);
});

await test("Binance's own documented shape — a 451 — refuses readiness and NAMES Binance, not Bybit", () => {
  const v = readinessVerdict(venues, [
    { venueId: "bybit", outcome: { kind: "ok", status: 200 } },
    { venueId: "binance", outcome: { kind: "blocked", status: 451, reason: "legal-block" } },
  ]);
  assert.equal(v.ready, false);
  assert.equal(v.refusals.length, 1);
  assert.match(v.refusals[0], /Binance/);
  assert.doesNotMatch(v.refusals[0], /Bybit/);
});

await test("a timeout/unreachable venue refuses readiness too — a hard block, never treated as fine", () => {
  const v = readinessVerdict(venues, [
    { venueId: "bybit", outcome: { kind: "unreachable", reason: "timeout", detail: "8000ms" } },
    { venueId: "binance", outcome: { kind: "ok", status: 200 } },
  ]);
  assert.equal(v.ready, false);
  assert.match(v.refusals[0], /Bybit/);
  assert.match(v.refusals[0], /timeout/);
});

await test("a venue with NO reported result at all is a refusal, never assumed reachable — 'run all seven regardless'", () => {
  const v = readinessVerdict(venues, [{ venueId: "bybit", outcome: { kind: "ok", status: 200 } }]);
  assert.equal(v.ready, false);
  assert.match(v.refusals[0], /Binance/);
  assert.match(v.refusals[0], /no probe result/);
  assert.equal(v.perVenue.find((p) => p.venueId === "binance").status, "missing");
});

await test("two venues refused -> two named refusals, not folded into one bare sentence", () => {
  const v = readinessVerdict(venues, [
    { venueId: "bybit", outcome: { kind: "blocked", status: 403, reason: "cdn-geo-block" } },
    { venueId: "binance", outcome: { kind: "blocked", status: 451, reason: "legal-block" } },
  ]);
  assert.equal(v.refusals.length, 2);
});

await test("DEFAULT_PROBE_VENUES ships all seven supported exchanges", () => {
  const ids = DEFAULT_PROBE_VENUES.map((v) => v.id).sort();
  assert.deepEqual(ids, ["aster", "binance", "bitget", "bitunix", "blofin", "bybit", "weex"]);
  for (const v of DEFAULT_PROBE_VENUES) assert.match(v.url, /^https:\/\//);
});

summary("hosting-readiness");
