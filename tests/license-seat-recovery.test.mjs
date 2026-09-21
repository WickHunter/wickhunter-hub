import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";

const h = await freshHub();
const admin = (path, body) => jsonReq(h.origin + path, {
  method: body ? "POST" : "GET",
  headers: { "x-hub-admin": h.cfg.adminToken, "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
function machine(id) {
  const pair = generateKeyPairSync("ed25519");
  return { id, privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url") };
}
async function activate(issued, install) {
  const headers = { "content-type": "application/json", "x-license": issued.token };
  const c = await jsonReq(h.origin + "/api/license/lease/challenge", {
    method: "POST", headers, body: JSON.stringify({ purpose: "activate",
      installId: install.id, installPublicKey: install.publicKey }),
  });
  assert.equal(c.status, 200);
  return jsonReq(h.origin + "/api/license/lease/activate", {
    method: "POST", headers, body: JSON.stringify({ nonce: c.body.challenge.nonce,
      signature: sign(null, Buffer.from(c.body.challenge.proofBytesB64u, "base64url"), install.privateKey).toString("base64url") }),
  });
}
async function checkin(issued, install) {
  return jsonReq(h.origin + "/api/license/checkin", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ licenseId: issued.payload.id, installId: install.id, version: "0.90.127", ts: Date.now() }),
  });
}
const old = machine("wrong-server");
const intended = machine("intended-server");
const issued = h.store.issue("Server move", 30);
let originalActivation;
await test("seat release reports the surviving Go binding; replacement licence activates on the intended server", async () => {
  assert.equal((await checkin(issued, old)).body.revoked, undefined);
  const a = await activate(issued, old);
  assert.equal(a.status, 200);
  originalActivation = a.body.activation;
  assert.equal((await checkin(issued, intended)).body.revoked, true);
  const released = await admin("/admin/api/licenses/seat/release", { id: issued.payload.id });
  assert.equal(released.status, 200);
  assert.equal(released.body.released, true);
  assert.equal(released.body.goLease.state, "bound");
  assert.deepEqual(released.body.goLease.boundInstallIds, [old.id]);
  assert.match(released.body.goLease.message, /different server still cannot obtain a Go lease/);
  assert.doesNotMatch(JSON.stringify(released.body), /WHL1\.|LHK1\.|installPublicKey|privateKey/);
  assert.equal((await checkin(issued, intended)).body.revoked, undefined, "check-in restriction cleared");
  assert.equal((await activate(issued, intended)).status, 409, "Go restriction remains enforced");
  const replacement = h.store.issue("Replacement", 30);
  assert.equal((await checkin(replacement, intended)).body.revoked, undefined);
  const recovered = await activate(replacement, intended);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.activation.installId, intended.id);
  assert.equal(recovered.body.lease.payload.sequence, 1);
});
await test("admin deactivation remains recovery-locked after releasing the check-in seat", async () => {
  const deactivated = await admin("/admin/api/license-leases/deactivate", {
    licenseId: issued.payload.id, activationId: originalActivation.id,
    expectedRevision: originalActivation.revision, reason: "Verified server move",
  });
  assert.equal(deactivated.status, 200);
  const r = await admin("/admin/api/licenses/seat/release", { id: issued.payload.id });
  assert.equal(r.body.goLease.state, "recovery-locked");
  assert.deepEqual(r.body.goLease.boundInstallIds, []);
  assert.match(r.body.goLease.message, /replacement licence/);
  assert.equal((await activate(issued, intended)).status, 409);
});
await test("unknown licence cannot create a released seat", async () => {
  const r = await admin("/admin/api/licenses/seat/release", { id: "missing" });
  assert.equal(r.status, 404);
});
await test("unreadable lease audit is reported as unavailable, never unbound", async () => {
  const ledger = join(h.cfg.dataDir, "license-lease-audit.v1.jsonl");
  const lines = readFileSync(ledger, "utf8").split("\n");
  lines[0] = "not-json";
  writeFileSync(ledger, lines.join("\n"));
  const r = await admin("/admin/api/licenses/seat/release", { id: issued.payload.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.goLease.state, "unavailable");
  assert.match(r.body.goLease.message, /could not be checked/);
});
await h.close();
summary();
