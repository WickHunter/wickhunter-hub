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

// ── EDITING AN ISSUED LICENSE'S EXPIRY ──────────────────────────────────────
// Operator ask: "allow edit to expiry date here". The load-bearing property is
// not that the stored date changes — it is that the token is RE-MINTED, because
// `exp` lives inside the signed payload and the bot checks it offline. A change
// that did not hand back a new install command would read as done on the admin
// page while every running bot kept the old date forever.
await test("editing expiry re-mints the token and hands back a new install command", async () => {
  const issued = await jsonReq(`${h.origin}/admin/api/licenses`, {
    method: "POST", headers: AUTH, body: JSON.stringify({ name: "Expiry Edit", days: 10 }),
  });
  const id = issued.body.license.id;
  const before = issued.body.license.exp;
  const beforeCmd = issued.body.installCommand;

  const exp = before + 30 * 86_400_000;
  const r = await jsonReq(`${h.origin}/admin/api/licenses/expiry`, {
    method: "POST", headers: AUTH, body: JSON.stringify({ id, exp }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.exp, exp);
  assert.ok(r.body.installCommand, "no install command returned — the new expiry would never reach the tester");
  assert.notEqual(r.body.installCommand, beforeCmd, "the token did not change, so the tester's expiry did not either");

  // The list agrees, and the re-minted token verifies with the NEW expiry.
  const list = await jsonReq(`${h.origin}/admin/api/licenses`, { headers: AUTH });
  assert.equal(list.body.licenses.find((l) => l.id === id).exp, exp);
  const token = r.body.installCommand.match(/key=([^"]+)"/)[1];
  const v = h.store.verify(token);
  assert.equal(v.ok, true, "the re-minted token does not verify");
  assert.equal(v.payload.exp, exp);
  // Identity is preserved — this is the SAME license, not a new one.
  assert.equal(v.payload.id, id);
  assert.equal(v.payload.iat, issued.body.license.iat);
});

await test("expiry edits are bounded, and a revoked license is refused", async () => {
  const issued = await jsonReq(`${h.origin}/admin/api/licenses`, {
    method: "POST", headers: AUTH, body: JSON.stringify({ name: "Expiry Bounds", days: 10 }),
  });
  const id = issued.body.license.id;
  const iat = issued.body.license.iat;

  for (const [exp, why] of [[iat - 1, "before issue"], [iat, "at issue"],
                            [iat + 3651 * 86_400_000, "beyond 3650 days"]]) {
    const r = await jsonReq(`${h.origin}/admin/api/licenses/expiry`, {
      method: "POST", headers: AUTH, body: JSON.stringify({ id, exp }),
    });
    assert.equal(r.status, 400, `expected refusal: ${why}`);
  }
  // Shape errors are refused before anything is written.
  const bad = await jsonReq(`${h.origin}/admin/api/licenses/expiry`, {
    method: "POST", headers: AUTH, body: JSON.stringify({ id }),
  });
  assert.equal(bad.status, 400);

  // A revoked tester does not get a fresh key — the same rule `tokenFor` obeys.
  await jsonReq(`${h.origin}/admin/api/licenses/revoke`, {
    method: "POST", headers: AUTH, body: JSON.stringify({ id }),
  });
  const after = await jsonReq(`${h.origin}/admin/api/licenses/expiry`, {
    method: "POST", headers: AUTH, body: JSON.stringify({ id, exp: iat + 60 * 86_400_000 }),
  });
  assert.equal(after.status, 404);
});

await test("the admin page offers the expiry control and prints versions with a v", async () => {
  const r = await fetch(`${h.origin}/admin`);
  const html = await r.text();
  assert.ok(html.includes('/admin/api/licenses/expiry'), "the page never calls the expiry endpoint");
  assert.ok(/function vlabel/.test(html), "no version formatter");
  // Both tables go through it — the licence row and the feedback row.
  assert.ok(html.includes("vlabel(l.lastSeen.version)"), "licence table does not use vlabel");
  assert.ok(html.includes("vlabel(r.version)"), "feedback table does not use vlabel");
  // And the operator is told the new date does not reach a running bot by itself.
  assert.ok(/keeps the OLD expiry until they run it/.test(html),
    "the page does not warn that a running bot keeps the old expiry");
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
