// tests/liq-route.test.mjs — GET /api/hub/liq-percentiles: the same
// `communityLicense` auth as the community gallery, `table: null` for a hub
// that has recorded nothing, a real table once one has been built, and the
// admin status route. Also: persistence of the built table across a restart
// (`LiqService`'s own snapshot file, driven directly rather than through a
// real hub restart — a service is cheap to construct twice, a whole hub is
// not).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { freshHub, jsonReq, test, summary, tmpDir } from "./helpers.mjs";
import { LiqService, DEFAULT_LIQ_SERVICE_CONFIG } from "../dist/src/liq/service.js";

// ── the route: auth, null-before-build, served table ───────────────────────

await test("GET /api/hub/liq-percentiles refuses without a valid license", async () => {
  const h = await freshHub();
  const res = await jsonReq(`${h.origin}/api/hub/liq-percentiles`);
  assert.equal(res.status, 403);
  assert.equal(res.body.ok, false);
  await h.close();
});

await test("GET /api/hub/liq-percentiles refuses a revoked license", async () => {
  const h = await freshHub();
  const revoked = h.store.issue("Revoked", 30);
  h.store.revoke(revoked.payload.id);
  const res = await jsonReq(`${h.origin}/api/hub/liq-percentiles`, { headers: { "x-license": revoked.token } });
  assert.equal(res.status, 403);
  await h.close();
});

await test("table: null with 200 for a hub that has recorded nothing (HUB_LIQ_RECORD off)", async () => {
  const h = await freshHub({ liqRecord: false });
  const alice = h.store.issue("Alice", 30);
  const res = await jsonReq(`${h.origin}/api/hub/liq-percentiles`, { headers: { "x-license": alice.token } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.table, null, "nothing built yet reads as null, never an empty-looking table");
  await h.close();
});

await test("a built table is served whole, with Cache-Control: no-store", async () => {
  // No liqService override needed: `createHub` defaults an absent one to
  // `{ ...DEFAULT_LIQ_SERVICE_CONFIG, dataDir: cfg.dataDir, sources: [] }`,
  // so `hub.liq` is the real service, pointed at this test's real temp dir,
  // recording nothing on its own (no sockets — see stream-runner's own
  // suite for that) until fed by hand below.
  const h = await freshHub({ liqRecord: true });
  const now = Date.now();
  h.liq.history.record({ ts: now, src: "bybit-usdt", symbol: "BTCUSDT", side: "long", sizeUsd: 12_345 });
  h.liq.history.record({ ts: now, src: "bybit-usdt", symbol: "BTCUSDT", side: "long", sizeUsd: 22_000 });
  h.liq.history.flush();
  h.liq.rebuildNow();

  const alice = h.store.issue("Alice", 30);
  const res = await jsonReq(`${h.origin}/api/hub/liq-percentiles`, { headers: { "x-license": alice.token } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.table, "a built table is served");
  assert.deepEqual(res.body.table.stops, [50, 75, 90, 95, 99]);
  assert.equal(res.body.table.rows["bybit-usdt"]["BTCUSDT"]["long"].count, 2);
  const raw = await fetch(`${h.origin}/api/hub/liq-percentiles`, { headers: { "x-license": alice.token } });
  assert.equal(raw.headers.get("cache-control"), "no-store");
  await h.close();
});

await test("GET /admin/api/liq is admin-gated and reports source status, events today, pair-sides and last rebuild", async () => {
  const h = await freshHub();
  const denied = await jsonReq(`${h.origin}/admin/api/liq`, { headers: { "x-forwarded-for": "203.0.113.211" } });
  assert.equal(denied.status, 401, "no admin token, no data");

  const now = Date.now();
  h.liq.history.record({ ts: now, src: "bybit-usdt", symbol: "ETHUSDT", side: "short", sizeUsd: 5_000 });
  h.liq.history.flush();
  h.liq.rebuildNow();

  const res = await jsonReq(`${h.origin}/admin/api/liq`, { headers: { "x-hub-admin": h.cfg.adminToken } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.recording, "boolean");
  assert.ok(Array.isArray(res.body.sources));
  assert.equal(res.body.sources.length, 8, "every source is reported, connected or not");
  assert.equal(res.body.pairSides, 1);
  assert.equal(res.body.eventsToday, 1);
  assert.ok(typeof res.body.lastRebuildAtMs === "number");
  await h.close();
});

// ── LiqService persistence across a restart ─────────────────────────────────

await test("a built table survives a restart via the persisted snapshot, and is served immediately", () => {
  const dataDir = tmpDir("liq-service-persist");
  const cfg = { ...DEFAULT_LIQ_SERVICE_CONFIG, dataDir, sources: [] };
  const svc1 = new LiqService(cfg);
  svc1.history.record({ ts: Date.now(), src: "okx-usdt", symbol: "SOLUSDT", side: "long", sizeUsd: 9_999 });
  svc1.history.flush();
  svc1.rebuildNow();
  assert.equal(svc1.getTable().rows["okx-usdt"]["SOLUSDT"]["long"].count, 1);

  // A FRESH service over the SAME dataDir, never started — the constructor's
  // own snapshot load must find last night's table without a rebuild.
  const svc2 = new LiqService(cfg);
  const restored = svc2.getTable();
  assert.ok(restored, "the snapshot was restored at construction, before start() ever runs");
  assert.equal(restored.rows["okx-usdt"]["SOLUSDT"]["long"].count, 1);
});

await test("a corrupt snapshot file is dropped silently, never thrown, and the service still boots", () => {
  const dataDir = tmpDir("liq-service-corrupt");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "liq-percentiles.json"), "{not json");
  const cfg = { ...DEFAULT_LIQ_SERVICE_CONFIG, dataDir, sources: [] };
  let svc;
  assert.doesNotThrow(() => { svc = new LiqService(cfg); });
  assert.equal(svc.getTable(), null, "a corrupt file is dropped, never trusted");
});

summary("liq-route");
