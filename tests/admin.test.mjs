// tests/admin.test.mjs — the admin surface: auth (none/wrong/right/disabled),
// the issue -> list -> revoke lifecycle over HTTP, and the admin page itself.
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";

const h = await freshHub(); // adminToken: "test-admin-token"
const AUTH = { "x-hub-admin": "test-admin-token" };

await test("no token -> 401", async () => {
  const r = await jsonReq(`${h.origin}/admin/api/licenses`);
  assert.equal(r.status, 401);
});

await test("wrong token -> 401 (any length — compare is hash-then-timingSafeEqual)", async () => {
  for (const bad of ["x", "test-admin-tokeX", "test-admin-token-longer", "a".repeat(4096)]) {
    const r = await jsonReq(`${h.origin}/admin/api/licenses`, { headers: { "x-hub-admin": bad } });
    assert.equal(r.status, 401, `token: ${bad.slice(0, 32)}...`);
  }
});

await test("right token -> 200", async () => {
  const r = await jsonReq(`${h.origin}/admin/api/licenses`, { headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.licenses, []);
  assert.equal(r.body.origin, h.cfg.publicOrigin);
});

let issuedToken, issuedId;
await test("issue over HTTP returns a working token + install command", async () => {
  const r = await jsonReq(`${h.origin}/admin/api/licenses`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ name: "HTTP Issued", days: 14 }),
  });
  assert.equal(r.status, 200);
  issuedToken = r.body.token;
  issuedId = r.body.license.id;
  assert.equal(r.body.license.name, "HTTP Issued");
  assert.ok(r.body.installCommand.includes(`${h.cfg.publicOrigin}/install.sh?key=${issuedToken}`));
  // The token really verifies — not just shaped right.
  const v = h.store.verify(issuedToken);
  assert.equal(v.ok, true);
  assert.equal(v.payload.id, issuedId);
});

await test("issue with bad inputs -> 400", async () => {
  for (const body of [{}, { name: "X" }, { name: "", days: 30 }, { name: "X", days: 0 }]) {
    const r = await jsonReq(`${h.origin}/admin/api/licenses`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

await test("list shows the issued license with its last-seen", async () => {
  await jsonReq(`${h.origin}/api/license/checkin`, {
    method: "POST",
    body: JSON.stringify({ licenseId: issuedId, installId: "adm-inst", version: "0.9.1", ts: Date.now() }),
  });
  const r = await jsonReq(`${h.origin}/admin/api/licenses`, { headers: AUTH });
  const row = r.body.licenses.find((l) => l.id === issuedId);
  assert.equal(row.revoked, false);
  assert.equal(row.lastSeen.installId, "adm-inst");
  assert.equal(row.lastSeen.version, "0.9.1");
});

await test("revoke over HTTP flips the license and kills its downloads", async () => {
  const r = await jsonReq(`${h.origin}/admin/api/licenses/revoke`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ id: issuedId }),
  });
  assert.deepEqual(r.body, { ok: true });
  const list = await jsonReq(`${h.origin}/admin/api/licenses`, { headers: AUTH });
  assert.equal(list.body.licenses.find((l) => l.id === issuedId).revoked, true);
  // The revoked token can no longer fetch install.sh.
  const dl = await fetch(`${h.origin}/install.sh?key=${issuedToken}`);
  assert.equal(dl.status, 403);
});

await test("revoking an unknown id -> 404", async () => {
  const r = await jsonReq(`${h.origin}/admin/api/licenses/revoke`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ id: "does-not-exist" }),
  });
  assert.equal(r.status, 404);
});

await test("admin page is served and drives the three endpoints", async () => {
  const res = await fetch(`${h.origin}/admin`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /x-hub-admin/);
  assert.match(html, /\/admin\/api\/licenses/);
  assert.match(html, /revoke/i);
  assert.ok(!/document\.cookie|localStorage|sessionStorage/.test(html), "token must stay in memory only");
});

await h.close();

await test("with no HUB_ADMIN_TOKEN configured the whole admin surface is 503", async () => {
  const h2 = await freshHub({ adminToken: "" });
  for (const headers of [{}, { "x-hub-admin": "" }, { "x-hub-admin": "guess" }]) {
    const r = await jsonReq(`${h2.origin}/admin/api/licenses`, { headers });
    assert.equal(r.status, 503);
  }
  await h2.close();
});

summary("admin");
