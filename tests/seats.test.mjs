// tests/seats.test.mjs — one licence, one VPS, decided at the check-in seam.
// Real HTTP on loopback; IPs are simulated through X-Forwarded-For, which the
// Hub trusts from its loopback nginx peer; the seat clock is injected so a
// 30-minute silence takes no time.
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { SeatStore, DEFAULT_SEAT_POLICY } from "../dist/src/seats.js";
import { tmpDir } from "./helpers.mjs";

const MIN = 60_000;
let clock = Math.floor(Date.now() / 1000) * 1000;
const h = await freshHub({}, { seatNow: () => clock });
const AUTH = { "x-hub-admin": "test-admin-token", "content-type": "application/json" };
const admin = (p, opts = {}) => jsonReq(`${h.origin}${p}`, { ...opts, headers: { ...AUTH, ...(opts.headers ?? {}) } });

const issued = h.store.issue("Seat Tester", 30);
const L = issued.payload.id;
async function checkin(installId, ip, extra = {}) {
  return jsonReq(`${h.origin}/api/license/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ licenseId: L, installId, version: "0.90.6", ts: Date.now(), ...extra }),
  });
}
const seatOf = async () => (await admin("/admin/api/licenses")).body.licenses.find((l) => l.id === L).seat;

await test("first install binds the seat and is not revoked", async () => {
  const r = await checkin("inst-A", "203.0.113.10");
  assert.equal(r.status, 200);
  assert.equal(r.body.revoked, undefined);
  const seat = await seatOf();
  assert.equal(seat.installs.length, 1);
  assert.equal(seat.installs[0].installId, "inst-A");
  assert.equal(seat.installs[0].alive, true);
  assert.equal(seat.limit, 1);
  assert.equal(seat.refused, 0);
});

await test("a second live install is answered revoked (exit-only) and the holder is untouched", async () => {
  clock += 5 * MIN;
  const b = await checkin("inst-B", "198.51.100.7");
  assert.equal(b.status, 200);
  assert.equal(b.body.revoked, true);
  assert.match(b.body.reason, /another install already holds/);
  const a = await checkin("inst-A", "203.0.113.10");
  assert.equal(a.body.revoked, undefined, "the seat holder keeps working");
  const seat = await seatOf();
  assert.equal(seat.refused, 1);
  assert.equal(seat.lastRefusedInstallId, "inst-B");
  assert.equal(seat.lastRefusedIp, "198.51.100.7");
  assert.equal(h.store.isRevoked(L), false, "the LICENCE is not revoked in the registry");
});

await test("a refused install never receives a re-minted key, even when an extension is pending", async () => {
  const oldToken = issued.token;
  h.store.setExpiry(L, issued.payload.exp + 10 * 86_400_000);
  const b = await checkin("inst-B", "198.51.100.7", { token: oldToken });
  assert.equal(b.body.revoked, true);
  assert.equal(b.body.token, undefined);
  const a = await checkin("inst-A", "203.0.113.10", { token: oldToken });
  assert.ok(a.body.token, "the holder gets the longer key");
});

await test("after the holder goes silent for the release window, the new install takes the seat; the old one returning is refused", async () => {
  clock += 31 * MIN; // inst-A has not checked in for 31 minutes
  const b = await checkin("inst-B", "198.51.100.7");
  assert.equal(b.body.revoked, undefined, "the seat was free");
  let seat = await seatOf();
  assert.equal(seat.installs.length, 1);
  assert.equal(seat.installs[0].installId, "inst-B");
  clock += 5 * MIN;
  const a = await checkin("inst-A", "203.0.113.10");
  assert.equal(a.body.revoked, true, "the old box coming back is now the intruder");
  seat = await seatOf();
  assert.equal(seat.installs[0].installId, "inst-B");
});

await test("admin release frees the seat immediately", async () => {
  const r = await admin("/admin/api/licenses/seat/release", { method: "POST", body: JSON.stringify({ id: L }) });
  assert.deepEqual(r.body, { ok: true, released: true });
  let seat = await seatOf();
  assert.equal(seat.installs.length, 0);
  assert.ok(seat.releasedAtMs);
  clock += MIN;
  const a = await checkin("inst-A", "203.0.113.10");
  assert.equal(a.body.revoked, undefined);
  seat = await seatOf();
  assert.equal(seat.installs[0].installId, "inst-A");
  assert.equal(seat.releasedAtMs, null);
});

await test("a per-licence limit of 2 admits two installs and refuses the third", async () => {
  const r = await admin("/admin/api/licenses/seat/limit", { method: "POST", body: JSON.stringify({ id: L, limit: 2 }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.seat.limit, 2);
  clock += MIN;
  assert.equal((await checkin("inst-B", "198.51.100.7")).body.revoked, undefined);
  assert.equal((await checkin("inst-C", "192.0.2.99")).body.revoked, true);
  const back = await admin("/admin/api/licenses/seat/limit", { method: "POST", body: JSON.stringify({ id: L, limit: null }) });
  assert.equal(back.body.seat.limit, 1);
  const bad = await admin("/admin/api/licenses/seat/limit", { method: "POST", body: JSON.stringify({ id: L, limit: 0 }) });
  assert.equal(bad.status, 400);
  const unknown = await admin("/admin/api/licenses/seat/limit", { method: "POST", body: JSON.stringify({ id: "nope", limit: 2 }) });
  assert.equal(unknown.status, 404);
});

await test("a copied install id checking in from alternating IPs raises the clone signal (reported, not enforced by default)", async () => {
  await admin("/admin/api/licenses/seat/release", { method: "POST", body: JSON.stringify({ id: L }) });
  const ips = ["203.0.113.10", "198.51.100.7", "203.0.113.10", "198.51.100.7", "203.0.113.10"];
  for (const ip of ips) {
    clock += 2 * MIN;
    const r = await checkin("inst-A", ip);
    assert.equal(r.body.revoked, undefined, `ip ${ip} not refused while cloneEnforce is off`);
  }
  const seat = await seatOf();
  const holder = seat.installs.find((i) => i.installId === "inst-A");
  assert.ok(holder.clone, "clone signal present");
  assert.equal(holder.clone.ips, 2);
  assert.ok(holder.clone.switches >= 3);
});

await test("a revoked or unknown licence is still answered revoked regardless of seats", async () => {
  const unknown = await jsonReq(`${h.origin}/api/license/checkin`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ licenseId: "never-issued", installId: "x", version: "0.90.6", ts: Date.now() }),
  });
  assert.equal(unknown.body.revoked, true);
  assert.equal(unknown.body.reason, undefined, "no seat reason on a registry refusal");
});

await test("the licences list carries the seat policy so the page can say whether it is enforcing", async () => {
  const r = await admin("/admin/api/licenses");
  assert.equal(r.body.seatPolicy.enforce, true);
  assert.equal(r.body.seatPolicy.defaultLimit, 1);
});

await h.close();

// ── the store alone: enforcement off records but never refuses; clone enforcement refuses ──

await test("enforce:false records every install and never refuses", () => {
  const s = new SeatStore(tmpDir("seats"), { ...DEFAULT_SEAT_POLICY, enforce: false });
  let t = 1_000_000;
  assert.equal(s.admit("L", "a", "1.1.1.1", t).admitted, true);
  const b = s.admit("L", "b", "2.2.2.2", t += MIN);
  assert.equal(b.admitted, true);
  assert.equal(s.view("L", t).installs.length, 1, "bounded to the limit, newest kept");
  assert.equal(s.view("L", t).installs[0].installId, "b");
});

await test("cloneEnforce:true refuses an id that alternates IPs three times", () => {
  const s = new SeatStore(tmpDir("seats"), { ...DEFAULT_SEAT_POLICY, cloneEnforce: true });
  let t = 1_000_000;
  const seq = ["1.1.1.1", "2.2.2.2", "1.1.1.1", "2.2.2.2"];
  const results = seq.map((ip) => s.admit("L", "a", ip, t += 2 * MIN));
  assert.equal(results[0].admitted, true);
  assert.equal(results[1].admitted, true);
  assert.equal(results[2].admitted, true);
  assert.equal(results[3].admitted, false);
  assert.equal(results[3].reason, "clone");
  // A single move (one switch) is never refused.
  const s2 = new SeatStore(tmpDir("seats"), { ...DEFAULT_SEAT_POLICY, cloneEnforce: true });
  assert.equal(s2.admit("L", "a", "1.1.1.1", t).admitted, true);
  assert.equal(s2.admit("L", "a", "3.3.3.3", t + MIN).admitted, true);
});

summary("seats");
