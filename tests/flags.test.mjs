// tests/flags.test.mjs — v0.2.11, per-licence feature flags.
//
// The bot ships ONE build for alpha and beta, with unfinished features compiled
// in but DARK. This is the hub half of that: the daily check-in reply names
// which flags a given licence may see.
//
// THE TWO PROPERTIES THAT MATTER, and both are about the DEFAULT being dark:
//
//  1. `flags` is ALWAYS in the reply, even empty. The bot distinguishes an
//     absent key ("this hub predates flags — leave my cache alone") from `{}`
//     ("the hub says none"), and only the second can turn a feature back OFF.
//     A hub that omitted the key when it had nothing to say could never darken
//     anything it had previously lit.
//  2. Only TRUE flags are emitted. An explicit `false` in `byLicense` exists to
//     cancel a default for one tester; once cancelled there is nothing to say,
//     because the bot treats absent and false identically.
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";

const h = await freshHub();
const AUTH = { "x-hub-admin": "test-admin-token" };

const issue = async (name) => {
  const r = await jsonReq(`${h.origin}/admin/api/licenses`, {
    method: "POST", headers: AUTH, body: JSON.stringify({ name, days: 30 }),
  });
  assert.equal(r.status, 200, `issue ${name}`);
  return r.body.license.id;
};
const checkin = async (licenseId) => {
  const r = await jsonReq(`${h.origin}/api/license/checkin`, {
    method: "POST",
    body: JSON.stringify({ licenseId, installId: "install-1", version: "0.75.2", ts: Date.now() }),
  });
  assert.equal(r.status, 200);
  return r.body;
};
const setFlag = async (id, flag, state) => {
  const r = await jsonReq(`${h.origin}/admin/api/flags`, {
    method: "POST", headers: AUTH, body: JSON.stringify({ id, flag, state }),
  });
  return r;
};

const alpha = await issue("Alpha (operator)");
const beta = await issue("Beta tester");

await test("a fresh hub tells every licence: no flags — but tells them", async () => {
  const b = await checkin(alpha);
  assert.equal(b.ok, true);
  // PRESENT and empty, not absent. This is the whole distinction the bot's
  // recordLicenseFlags depends on.
  assert.deepEqual(b.flags, {});
  assert.ok(Object.prototype.hasOwnProperty.call(b, "flags"), "`flags` must be present even when empty");
});

await test("a flag set for ONE licence reaches only that licence", async () => {
  const r = await setFlag(alpha, "dcaStyles", true);
  assert.equal(r.status, 200);
  assert.deepEqual((await checkin(alpha)).flags, { dcaStyles: true });
  assert.deepEqual((await checkin(beta)).flags, {}, "the other tester must be unaffected");
});

await test("a default reaches everyone", async () => {
  await setFlag("default", "dcaStyles", true);
  assert.deepEqual((await checkin(beta)).flags, { dcaStyles: true });
});

await test("…and ONE tester can be excluded from a default with an explicit false", async () => {
  await setFlag(beta, "dcaStyles", false);
  assert.deepEqual((await checkin(beta)).flags, {}, "excluded: nothing to say, so nothing is said");
  assert.deepEqual((await checkin(alpha)).flags, { dcaStyles: true }, "everyone else keeps it");
});

await test("null removes the override and the default applies again", async () => {
  await setFlag(beta, "dcaStyles", null);
  assert.deepEqual((await checkin(beta)).flags, { dcaStyles: true });
});

await test("turning the default off darkens everyone who has no override", async () => {
  await setFlag("default", "dcaStyles", false);
  assert.deepEqual((await checkin(beta)).flags, {});
  // alpha still has its own explicit true from earlier.
  assert.deepEqual((await checkin(alpha)).flags, { dcaStyles: true });
});

await test("an unknown licence id still gets a reply with flags (and no crash)", async () => {
  const b = await checkin("not-a-licence-this-hub-issued");
  assert.equal(b.ok, true);
  assert.equal(b.revoked, true, "unknown ids are revoked — that is the kill switch");
  // Flags travel to revoked installs for the same reason `latest` does: the
  // reply describes what this BUILD would show, and nothing here grants access
  // to anything. The licence gate is a separate mechanism at the submit seam.
  assert.ok(Object.prototype.hasOwnProperty.call(b, "flags"));
});

await test("a revoked licence still receives its flags", async () => {
  await jsonReq(`${h.origin}/admin/api/licenses/revoke`, {
    method: "POST", headers: AUTH, body: JSON.stringify({ id: alpha }),
  });
  const b = await checkin(alpha);
  assert.equal(b.revoked, true);
  assert.deepEqual(b.flags, { dcaStyles: true });
});

await test("the admin read-back shows the whole file", async () => {
  const r = await jsonReq(`${h.origin}/admin/api/flags`, { headers: AUTH });
  assert.equal(r.status, 200);
  assert.equal(r.body.flags.default.dcaStyles, false);
  assert.equal(r.body.flags.byLicense[alpha].dcaStyles, true);
});

await test("the flags admin surface needs the admin token", async () => {
  for (const init of [{}, { method: "POST", body: JSON.stringify({ id: "default", flag: "x", state: true }) }]) {
    const r = await jsonReq(`${h.origin}/admin/api/flags`, init);
    assert.equal(r.status, 401);
  }
});

await test("a malformed write is refused rather than half-applied", async () => {
  for (const body of [
    { id: "", flag: "dcaStyles", state: true },
    { id: "default", flag: "", state: true },
    { id: "default", flag: "dcaStyles", state: "yes" },   // not a boolean or null
    { id: "default", flag: "dcaStyles" },                 // no state at all
    { id: "default", flag: "bad name!", state: true },    // charset
    { id: "default", flag: "x".repeat(41), state: true }, // length
  ]) {
    const r = await jsonReq(`${h.origin}/admin/api/flags`, {
      method: "POST", headers: AUTH, body: JSON.stringify(body),
    });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // …and nothing changed.
  const r = await jsonReq(`${h.origin}/admin/api/flags`, { headers: AUTH });
  assert.equal(Object.keys(r.body.flags.default).length, 1);
});

await test("the hub keeps NO registry of valid flag names — the bot owns that", async () => {
  // Deliberate: the build that IMPLEMENTS a flag is the authority on what it
  // means, and the bot ignores names it does not know. A hub registry would
  // have to be redeployed in lockstep with every bot release.
  const r = await setFlag("default", "someFutureFeature", true);
  assert.equal(r.status, 200);
  assert.deepEqual((await checkin(beta)).flags, { someFutureFeature: true });
});

await h.close();
summary();
