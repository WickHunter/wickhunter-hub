// tests/hosting-fleet-key.test.mjs — v0.4.104: the operator fleet update key
// on NEW hosted servers, their SSH host-key fingerprints, and the dry-run
// "install update key on existing servers" action. The bash blocks are run
// for real against temp directories (never /root/.ssh); everything else is
// offline (FakeProvider, stubbed fetch).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { freshHub, tmpDir, jsonReq, test, summary } from "./helpers.mjs";
import { buildBootstrapUserData, fleetKeyBlock, HOST_KEY_BLOCK } from "../dist/src/hosting/bootstrap.js";
import { applyHostingPolicyPatch, defaultHostingPolicy, DEFAULT_PROBE_VENUES, sshPublicKeyFingerprint } from "../dist/src/hosting/policy.js";
import { FakeProvider, hashBootstrapToken } from "../dist/src/hosting/provider.js";

function newKey(dir, name, type = "ed25519") {
  const file = path.join(dir, name);
  execFileSync("ssh-keygen", ["-q", "-t", type, "-N", "", "-C", `${name}-comment`, "-f", file]);
  return fs.readFileSync(`${file}.pub`, "utf8").trim();
}
const keyDir = tmpDir("fleetkeys");
const FLEET = newKey(keyDir, "fleet");
const OTHER = newKey(keyDir, "customer");

function scriptOf(userData) { return JSON.parse(userData.replace(/^#cloud-config\n/, "")).runcmd[0][2]; }
function block(script, name) {
  const a = script.indexOf(`# BEGIN ${name}`), b = script.indexOf(`# END ${name}`);
  assert.ok(a >= 0 && b > a, name);
  return script.slice(a, b + `# END ${name}`.length);
}
const input = { instanceId: "host_abc", generation: 1, bootstrapToken: "tok", managementToken: "mtok", hubOrigin: "https://hub.example.com", maxAccounts: 5, probeVenues: DEFAULT_PROBE_VENUES };

function runFleet(keys, sshDir) {
  const body = `set -euo pipefail\n${fleetKeyBlock(keys)}\necho "present=$WH_FLEET_KEYS_PRESENT"`;
  const r = spawnSync("bash", ["-c", body], { env: { PATH: process.env.PATH, WH_ROOT_SSH_DIR: sshDir }, encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

await test("policy: fleetAuthorizedKeys accepts plain public-key lines only (no options, no private key, at most 4) and fingerprints match ssh-keygen", () => {
  const p = applyHostingPolicyPatch(defaultHostingPolicy(), { fleetAuthorizedKeys: [FLEET, FLEET] });
  assert.deepEqual(p.fleetAuthorizedKeys, [FLEET], "deduplicated");
  for (const bad of [`command="rm -rf /" ${FLEET}`, `from="1.2.3.4" ${FLEET}`, "-----BEGIN OPENSSH PRIVATE KEY-----", `${FLEET}\n${OTHER}`, `${FLEET}'; touch /tmp/x; '`, "ssh-ed25519 short"]) {
    assert.throws(() => applyHostingPolicyPatch(defaultHostingPolicy(), { fleetAuthorizedKeys: [bad] }), /OpenSSH public key/, bad);
  }
  assert.throws(() => applyHostingPolicyPatch(defaultHostingPolicy(), { fleetAuthorizedKeys: [FLEET, OTHER, FLEET + "x", OTHER + "y", FLEET] }), /at most 4/);
  const sshFp = execFileSync("ssh-keygen", ["-lf", path.join(keyDir, "fleet.pub")], { encoding: "utf8" }).split(" ")[1];
  assert.equal(sshPublicKeyFingerprint(FLEET), sshFp);
  assert.deepEqual(defaultHostingPolicy().fleetAuthorizedKeys, []);
});

await test("bootstrap: the fleet key block runs before the installer, appends the key once, keeps every other key, repairs a missing final newline, and is idempotent", () => {
  const script = scriptOf(buildBootstrapUserData({ ...input, fleetAuthorizedKeys: [FLEET] }));
  assert.ok(script.indexOf("# BEGIN HOSTING FLEET KEY") < script.indexOf('bash "$INSTALLER"'), "installed before the app install, so a failed install is still reachable");
  assert.ok(script.includes(FLEET));
  const dir = path.join(tmpDir("rootssh"), ".ssh");
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "authorized_keys"), OTHER); // no trailing newline
  let r = runFleet([FLEET], dir);
  assert.equal(r.status, 0, r.err); assert.match(r.out, /present=1/);
  let lines = fs.readFileSync(path.join(dir, "authorized_keys"), "utf8").split("\n").filter(Boolean);
  assert.deepEqual(lines, [OTHER, FLEET], "the customer's key is untouched and the fleet key is its own line");
  r = runFleet([FLEET], dir);
  assert.equal(r.status, 0); assert.match(r.out, /present=1/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "authorized_keys"), "utf8").split("\n").filter(Boolean), [OTHER, FLEET], "a rerun adds nothing");
  assert.equal(fs.statSync(path.join(dir, "authorized_keys")).mode & 0o777, 0o600);
  // A missing ~/.ssh is created 0700.
  const fresh = path.join(tmpDir("rootssh2"), ".ssh");
  r = runFleet([FLEET], fresh);
  assert.equal(r.status, 0); assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
  assert.deepEqual(fs.readFileSync(path.join(fresh, "authorized_keys"), "utf8"), `${FLEET}\n`);
  // Non-fatal: an unwritable target reports 0 present and the script goes on.
  const ro = tmpDir("rootssh3"); fs.writeFileSync(path.join(ro, "notadir"), "");
  r = runFleet([FLEET], path.join(ro, "notadir", ".ssh"));
  assert.equal(r.status, 0); assert.match(r.out, /present=0/); assert.match(r.err, /could not be updated/);
  // No keys configured = a no-op that reports 0.
  r = runFleet([], fresh);
  assert.equal(r.status, 0); assert.match(r.out, /present=0/);
  assert.throws(() => fleetKeyBlock([`command="x" ${FLEET}`]), /not a plain OpenSSH public key/);
});

await test("bootstrap: host-key fingerprints are reported in the readiness proof with the fleet-key count, exact shapes only", () => {
  const script = scriptOf(buildBootstrapUserData({ ...input, fleetAuthorizedKeys: [FLEET] }));
  assert.match(script, /"sshHostKeys":\[%s\],"fleetKeysPresent":%s\}' "\$WH_BOOTSTRAP_TOKEN" "\$WH_GENERATION" "\$RESULTS" "\$WH_HOST_KEYS" "\$WH_FLEET_KEYS_PRESENT"/);
  assert.ok(script.indexOf("# BEGIN HOSTING HOST KEYS") < script.lastIndexOf("/readiness"));
  const hk = tmpDir("hostkeys");
  newKey(hk, "ssh_host_ed25519_key"); newKey(hk, "ssh_host_ecdsa_key", "ecdsa");
  fs.writeFileSync(path.join(hk, "ssh_host_bogus_key.pub"), "not a key\n");
  const r = spawnSync("bash", ["-c", `set -euo pipefail\n${HOST_KEY_BLOCK}\nprintf '[%s]' "$WH_HOST_KEYS"`], { env: { PATH: process.env.PATH, WH_SSH_HOST_KEY_GLOB: `${hk}/ssh_host_*_key.pub` }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const keys = JSON.parse(r.stdout);
  assert.deepEqual(keys.map((k) => k.type).sort(), ["ECDSA", "ED25519"]);
  const ed = keys.find((k) => k.type === "ED25519");
  assert.equal(ed.fingerprint, execFileSync("ssh-keygen", ["-lf", path.join(hk, "ssh_host_ed25519_key.pub")], { encoding: "utf8" }).split(" ")[1]);
});

async function hub() {
  let clock = Date.parse("2026-11-04T12:00:00Z");
  const provider = new FakeProvider({ now: () => clock });
  const h = await freshHub({}, { billingNow: () => clock, hostingNow: () => clock, hostingProvider: provider,
    billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }), hostingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    hostingPublicHealthFetch: async () => ({ ok: true, status: 200, body: JSON.stringify({ ok: true, version: "0.91.32" }) }) });
  const headers = { "x-hub-admin": "test-admin-token", "x-hub-csrf": "marketplace-config-v1", "content-type": "application/json" };
  const admin = (p, body) => jsonReq(`${h.origin}${p}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
  const hosting = h.hub.hosting; hosting.stop(); hosting.log = () => {};
  return { h, hosting, provider, admin, now: () => clock };
}

await test("a new server's cloud-init carries the policy key; the readiness proof records host keys (pinned, never overwritten) and confirms the key; the admin API exposes both", async () => {
  const f = await hub();
  try {
    assert.equal((await f.admin("/admin/api/hosting/policy", { policy: { provisioningEnabled: true, osId: "2284", releaseRef: "c".repeat(64), fleetAuthorizedKeys: [FLEET] } })).status, 200);
    const bad = await f.admin("/admin/api/hosting/policy", { policy: { fleetAuthorizedKeys: [`command="x" ${FLEET}`] } });
    assert.equal(bad.status, 400);
    // A reserved, paid-equivalent row: reuse the store directly and queue provisioning.
    const owner = "cus_fleet";
    f.h.hub.billing.store.putRoleSubscription({ key: `${owner}::hosting`, customerKey: owner, role: "hosting", livemode: false, subscriptionId: "sub_fleet", subscriptionStatus: "active", periodEndMs: f.now() + 30 * 86_400_000, chargeIds: [], disputed: false, refunded: false, createdAtMs: f.now(), updatedAtMs: f.now(), lastEventType: "invoice.paid", lastEventAtMs: f.now() });
    const lic = f.h.store.issueUntil("fleet fixture", f.now() + 30 * 86_400_000, "unleashed", f.now());
    f.h.hub.billing.store.putCustomer({ key: owner, stripeCustomerId: owner, email: "fleet@example.test", name: "Fleet Fixture", livemode: false, licenseId: lic.payload.id, planKey: "monthly", subscriptionId: "sub_sw", subscriptionStatus: "active", periodEndMs: null, chargeIds: [], createdAtMs: f.now(), updatedAtMs: f.now(), welcomeSentAtMs: f.now(), welcomeError: null, disputed: false, refunded: false, lastEventType: "invoice.paid", lastEventAtMs: f.now() });
    const row0 = f.hosting.store.reserveInstance({ id: "host_fleetfixture", ownerId: owner, environment: "test", region: "nrt", planId: "vc2-2c-2gb", stripeCustomerId: owner, nowMs: f.now() });
    f.hosting.reconcileOwner(owner, f.now());
    await f.hosting.tick(f.now());
    let row = f.hosting.store.getInstance(row0.id);
    assert.equal(row.stage, "bootstrapping");
    assert.ok(scriptOf(f.provider.createCalls[0].userData).includes(FLEET), "the policy key reached this server's cloud-init");
    assert.deepEqual(row.fleetKeysOffered, [sshPublicKeyFingerprint(FLEET)]);
    const raw = "tok-fleet";
    f.hosting.store.updateInstance(row.id, row.version, (d) => { d.bootstrapTokenHash = hashBootstrapToken(raw); d.bootstrapTokenExpiresAtMs = f.now() + 3_600_000; }, f.now());
    const fp = "SHA256:" + "B".repeat(43);
    const results = ["bybit", "binance", "bitget", "bitunix", "blofin", "weex", "aster"].map((venueId) => ({ venueId, status: 200 }));
    const ready = await jsonReq(`${f.h.origin}/api/hosting/instances/${row.id}/readiness`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: raw, generation: 1, results, sshHostKeys: [{ type: "ED25519", fingerprint: fp }, { type: "bad type", fingerprint: "x" }, { type: "RSA", fingerprint: "SHA256:short" }], fleetKeysPresent: 1 }) });
    assert.equal(ready.status, 200); assert.equal(ready.body.ready, true);
    row = f.hosting.store.getInstance(row.id);
    assert.deepEqual(row.sshHostKeys, [{ type: "ED25519", fingerprint: fp }], "malformed entries are dropped");
    assert.equal(row.fleetKeysConfirmedAtMs, f.now());
    // A later proof with a different host key never overwrites the pin.
    f.hosting.store.updateInstance(row.id, row.version, (d) => { d.stage = "bootstrapping"; }, f.now());
    await jsonReq(`${f.h.origin}/api/hosting/instances/${row.id}/readiness`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: raw, generation: 1, results, sshHostKeys: [{ type: "ED25519", fingerprint: "SHA256:" + "C".repeat(43) }], fleetKeysPresent: 1 }) });
    row = f.hosting.store.getInstance(row.id);
    assert.equal(row.sshHostKeys[0].fingerprint, fp); assert.equal(row.sshHostKeysMismatchAtMs, f.now());
    const list = await f.admin("/admin/api/hosting/instances");
    const listed = list.body.instances.find((r) => r.id === row.id);
    assert.equal(listed.sshHostKeys[0].fingerprint, fp); assert.equal(listed.fleetKeysConfirmedAtMs, f.now());
    assert.equal(listed.customer.email, "fleet@example.test"); assert.equal(listed.customer.name, "Fleet Fixture");
    for (const k of ["bootstrapTokenHash", "managementTokenHash", "checkoutRequestBody", "checkoutIdempotencyKey", "leaseToken"]) assert.ok(!(k in listed), `${k} is not exposed`);
    assert.equal(listed.bootstrapTokenActive, true);
    assert.ok(!JSON.stringify(list.body).includes(hashBootstrapToken(raw)), "no bootstrap hash (the temporary password's source) in the admin list");
  } finally { await f.h.close(); }
});

await test("fleet-key dry run lists live servers without a confirmed key (audited); apply refuses by name (no channel) and changes nothing; both need the CSRF contract", async () => {
  const f = await fixture2();
  try {
    const noCsrf = await jsonReq(`${f.h.origin}/admin/api/hosting/fleet-key/plan`, { method: "POST", headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json" }, body: "{}" });
    assert.equal(noCsrf.status, 403);
    const before = fs.readFileSync(path.join(f.h.dataDir, "hosting-db.v1.json"), "utf8");
    const plan = await f.admin("/admin/api/hosting/fleet-key/plan", { by: "ops" });
    assert.equal(plan.status, 200); assert.equal(plan.body.dryRun, true); assert.equal(plan.body.channel, null);
    assert.deepEqual(plan.body.targets.map((t) => t.instanceId), ["host_old"]);
    assert.deepEqual(plan.body.confirmed.map((t) => t.instanceId), ["host_new"]);
    assert.match(plan.body.targets[0].reason, /before the Hub carried a fleet key/);
    assert.match(plan.body.explanation, /no command channel/);
    const apply = await f.admin("/admin/api/hosting/fleet-key/apply", { by: "ops" });
    assert.equal(apply.status, 409); assert.equal(apply.body.code, "NO_CHANNEL");
    assert.equal(fs.readFileSync(path.join(f.h.dataDir, "hosting-db.v1.json"), "utf8"), before, "nothing changed");
    const events = f.h.hub.billing.events(20).map((e) => e.type);
    assert.ok(events.includes("admin.hosting.fleet-key.plan") && events.includes("admin.hosting.fleet-key.apply-refused"));
  } finally { await f.h.close(); }
});

async function fixture2() {
  const f = await hub();
  await f.admin("/admin/api/hosting/policy", { policy: { fleetAuthorizedKeys: [FLEET] } });
  const mk = (id, over) => {
    const r = f.hosting.store.reserveInstance({ id, ownerId: `cus_${id}`, environment: "test", region: "nrt", planId: "vc2-2c-2gb", stripeCustomerId: `cus_${id}`, nowMs: f.now() });
    f.hosting.store.updateInstance(r.id, r.version, (d) => { d.stage = "ready"; d.providerInstanceId = `prov-${id}`; d.ip = "203.0.113.9"; Object.assign(d, over); }, f.now());
  };
  mk("host_old", {});
  mk("host_new", { fleetKeysOffered: [sshPublicKeyFingerprint(FLEET)], fleetKeysConfirmedAtMs: f.now() });
  mk("host_gone", { stage: "deleted" });
  return f;
}

summary("hosting-fleet-key");
