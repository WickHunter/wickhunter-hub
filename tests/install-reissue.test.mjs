import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { createHub } from "../dist/src/server.js";
import { BillingStore, INSTALL_TOKEN_TTL_MS, TOKENS_FILE } from "../dist/src/billing/store.js";
import { reissuedInstallEmail } from "../dist/src/billing/email.js";
import { releaseSigningBytes } from "../dist/src/release-manifest.js";

const auth = { "x-hub-admin": "test-admin-token", "content-type": "application/json" };
async function fixture() {
  let now = Date.now(), mailFailure = false, paused = null;
  const mails = [];
  const fetchMail = async (_url, init) => {
    mails.push(JSON.parse(init.body));
    if (paused) await paused;
    return mailFailure ? { ok: false, status: 422, text: async () => init.body } : { ok: true, status: 200, text: async () => '{"id":"fixture-mail"}' };
  };
  const h = await freshHub({}, { billingFetch: fetchMail, billingNow: () => now });
  let running = h.hub, origin = h.origin;
  const store = new BillingStore(h.dataDir);
  const issued = h.store.issueUntil("Henrique Fixture", now + 30 * 86400000, "unleashed", now);
  const customer = { key: "cus_fixture", stripeCustomerId: "cus_fixture", email: "henrique@example.test", name: "Henrique Fixture", livemode: true,
    licenseId: issued.payload.id, planKey: "monthly", subscriptionId: "sub_fixture", subscriptionStatus: "active", periodEndMs: issued.payload.exp,
    chargeIds: ["ch_fixture"], createdAtMs: now, updatedAtMs: now, welcomeSentAtMs: now, welcomeError: null,
    disputed: false, refunded: false, lastEventType: "invoice.paid", lastEventAtMs: now };
  store.putCustomer(customer);
  const oldPage = store.mint("page", issued.payload.id, customer.key, now);
  const oldInstall = store.mint("install", issued.payload.id, customer.key, now);
  const otherPage = store.mint("page", issued.payload.id, "cus_other", now);
  const artifact = Buffer.from("fixture authenticated release");
  const unsigned = { schema: "wickhunter.release.v1", product: "wickhunter", channel: "beta", platform: "linux", arch: "x64", version: "0.90.135", buildId: "fixture-build", file: "fixture.tar.gz",
    sha256: createHash("sha256").update(artifact).digest("hex"), issuedAt: new Date(now).toISOString(), minUpdateProtocol: 1 };
  fs.writeFileSync(path.join(h.releasesDir, unsigned.file), artifact);
  fs.writeFileSync(path.join(h.releasesDir, "latest.json"), JSON.stringify({ ...unsigned, signatures: [{ kid: h.releaseSigner.kid, alg: "Ed25519", sig: sign(null, releaseSigningBytes(unsigned), h.releaseSigner.privateKey).toString("base64url") }] }));
  const admin = (route, body) => jsonReq(`${origin}${route}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  await admin("/admin/api/billing/config", { email: { provider: "resend", apiKey: "re_fixture_private", from: "Wick Hunter <support@example.test>" } });
  return { h, store, customer, issued, oldPage, oldInstall, otherPage, mails, admin,
    reissue: (over = {}) => admin("/admin/api/billing/reissue-install", { customerId: customer.key, email: customer.email, issue: "bybit-us-ip", ...over }),
    url: (suffix) => `${origin}${suffix}`,
    advance: (ms) => { now += ms; }, failMail: () => { mailFailure = true; }, pause: (promise) => { paused = promise; },
    restart: async () => { await running.close(); running = createHub(h.cfg, { billingFetch: fetchMail, billingNow: () => now, candleSleep: async () => {} }); const port = await running.listen(); origin = `http://127.0.0.1:${port}`; },
    close: async () => { await running.close(); fs.rmSync(h.dataDir, { recursive: true, force: true }); fs.rmSync(h.releasesDir, { recursive: true, force: true }); },
  };
}
const rawFromMail = (mail) => /\/install\/([A-Za-z0-9_-]+)/.exec(mail.text)[1];

await test("verified admin reissue invalidates only old customer links and preserves license/seat/account data", async () => {
  const f = await fixture();
  try {
    for (const file of ["roster.json", "customer-account-sentinel.json", "license-lease-state-sentinel.json"]) fs.writeFileSync(path.join(f.h.dataDir, file), '{"preserved":"fixture"}');
    const preserved = Object.fromEntries(fs.readdirSync(f.h.dataDir).filter((n) => !n.startsWith("billing-")).map((n) => [n, fs.readFileSync(path.join(f.h.dataDir, n))]));
    const customerBefore = JSON.stringify(f.store.getCustomer(f.customer.key));
    const result = await f.reissue();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.revoked, { page: 1, install: 1 }); assert.equal(result.body.sentTo, f.customer.email);
    const raw = rawFromMail(f.mails[0]);
    assert.doesNotMatch(JSON.stringify(result.body), /LHK1|re_fixture_private/); assert.ok(!JSON.stringify(result.body).includes(raw));
    assert.ok(!f.mails[0].text.includes("LHK1.")); assert.match(f.mails[0].text, /US IP address/); assert.match(f.mails[0].text, /does not.*fix that runtime startup behavior/);
    assert.equal(await (await fetch(f.url(`/welcome/${f.oldPage}`))).text().then((s) => s.includes("Hi Henrique")), false);
    assert.equal((await fetch(f.url(`/install/${f.oldInstall}`))).status, 403);
    assert.equal(f.store.lookupPage(f.otherPage)?.customerKey, "cus_other");
    const [first, second] = await Promise.all([fetch(f.url(`/install/${raw}`)), fetch(f.url(`/install/${raw}`))]);
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.ok((await first.text()).includes(`KEY="${f.issued.token}"`));
    assert.equal(JSON.stringify(f.store.getCustomer(f.customer.key)), customerBefore);
    for (const [file, bytes] of Object.entries(preserved)) assert.deepEqual(fs.readFileSync(path.join(f.h.dataDir, file)), bytes, file);
    const audit = f.store.recentEvents().filter((r) => r.type === "admin.install.reissue");
    assert.equal(audit.length, 2); assert.deepEqual(JSON.parse(audit[0].note).revoked, result.body.revoked);
    assert.ok(!JSON.stringify(audit).includes(raw)); assert.doesNotMatch(JSON.stringify(audit), /LHK1|re_fixture_private/);
    assert.ok(!fs.readFileSync(path.join(f.h.dataDir, TOKENS_FILE), "utf8").includes(raw), "token remains hashed at rest");
    await f.restart();
    assert.equal((await fetch(f.url(`/install/${raw}`))).status, 200, "reusable flag survives real Hub reconstruction");
    f.advance(INSTALL_TOKEN_TTL_MS);
    const expired = await fetch(f.url(`/install/${raw}`)); assert.equal(expired.status, 403); assert.match(await expired.text(), /expired/);
  } finally { await f.close(); }
});

await test("authentication, email identity, release, provider and active customer checks precede link mutation", async () => {
  const f = await fixture();
  try {
    const tokensBefore = fs.readFileSync(path.join(f.h.dataDir, TOKENS_FILE));
    assert.equal((await jsonReq(f.url("/admin/api/billing/reissue-install"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: f.customer.key, email: f.customer.email, issue: "bybit-us-ip" }) })).status, 401);
    assert.equal((await f.reissue({ email: "wrong@example.test" })).status, 409);
    assert.equal((await f.reissue({ issue: "other" })).status, 400);
    for (const patch of [{ livemode: false }, { refunded: true }, { disputed: true }]) {
      f.store.putCustomer({ ...f.customer, ...patch }); assert.equal((await f.reissue()).status, 409);
    }
    f.store.putCustomer(f.customer);
    fs.renameSync(path.join(f.h.releasesDir, "latest.json"), path.join(f.h.releasesDir, "saved.json"));
    assert.equal((await f.reissue()).status, 503);
    fs.renameSync(path.join(f.h.releasesDir, "saved.json"), path.join(f.h.releasesDir, "latest.json"));
    await f.admin("/admin/api/billing/config", { email: { provider: "none" } });
    assert.equal((await f.reissue()).status, 503); assert.equal(f.mails.length, 0);
    assert.deepEqual(fs.readFileSync(path.join(f.h.dataDir, TOKENS_FILE)), tokensBefore);
  } finally { await f.close(); }
});

await test("revoked licenses and explicit reusable-token revocation refuse every retry", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.reissue()).status, 200); const raw = rawFromMail(f.mails[0]);
    assert.equal((await fetch(f.url(`/install/${raw}`))).status, 200);
    f.store.revokeInstall(raw); assert.equal((await fetch(f.url(`/install/${raw}`))).status, 403);
    await f.reissue(); const next = rawFromMail(f.mails[1]);
    f.h.store.revoke(f.issued.payload.id);
    assert.equal((await fetch(f.url(`/install/${next}`))).status, 403); assert.equal((await f.reissue()).status, 409);
  } finally { await f.close(); }
});

await test("provider failure leaks no reflected command, invalidates new link and audits safe counts", async () => {
  const f = await fixture();
  try {
    f.failMail(); const result = await f.reissue(); const raw = rawFromMail(f.mails[0]);
    assert.equal(result.status, 502); assert.ok(!JSON.stringify(result.body).includes(raw)); assert.doesNotMatch(JSON.stringify(result.body), /LHK1|re_fixture_private/);
    assert.equal((await fetch(f.url(`/install/${raw}`))).status, 403);
    assert.equal(f.store.lookupPage(f.oldPage), null); assert.equal((await fetch(f.url(`/install/${f.oldInstall}`))).status, 403);
    assert.equal(JSON.parse(f.store.recentEvents()[0].note).stage, "failed");
    assert.ok(!JSON.stringify(f.store.recentEvents()).includes(raw));
  } finally { await f.close(); }
});

await test("overlapping reissue cannot send a second email or revoke an in-flight new link", async () => {
  const f = await fixture(); let release;
  try {
    f.pause(new Promise((resolve) => { release = resolve; }));
    const pending = f.reissue();
    while (!f.mails.length) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await f.reissue()).status, 409); assert.equal(f.mails.length, 1);
    release(); assert.equal((await pending).status, 200);
    assert.equal((await fetch(f.url(`/install/${rawFromMail(f.mails[0])}`))).status, 200);
  } finally { release?.(); await f.close(); }
});

await test("historical tokens remain single-use while first-used reusable records stay valid and bounded", async () => {
  const f = await fixture();
  try {
    assert.equal(f.store.consumeInstall(f.oldInstall).ok, true); assert.deepEqual(f.store.consumeInstall(f.oldInstall), { ok: false, reason: "used" });
    const raw = f.store.mint("install", f.issued.payload.id, f.customer.key, Date.now(), { reusable: true });
    assert.equal(f.store.consumeInstall(raw).ok, true);
    f.store.mint("install", f.issued.payload.id, f.customer.key); assert.equal(new BillingStore(f.h.dataDir).consumeInstall(raw).ok, true);
    f.store.revokeTokens(f.customer.key, "all"); assert.deepEqual(f.store.consumeInstall(raw), { ok: false, reason: "revoked" });
  } finally { await f.close(); }
});

await test("emailed command executes only a successful download and cleans up after either result", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-reissue-command-"));
  try {
    fs.mkdirSync(path.join(dir, "tmp"));
    const writeExecutable = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bash\nset -eu\n${body}`, { mode: 0o755 });
    writeExecutable("curl", 'out=""; found=0\nwhile [ "$#" -gt 0 ]; do case "$1" in --fail-with-body) found=1;; -o) shift; out=$1;; esac; shift; done\n[ "$found" = 1 ]\nif [ "$FAIL_HTTP" = 1 ]; then printf "forbidden: link revoked\\n" > "$out"; exit 22; fi\nprintf \'printf executed > "$INSTALL_MARKER"\\n\' > "$out"\n');
    writeExecutable("sudo", '"$@"\n');
    const msg = reissuedInstallEmail("fixture@example.test", { name: "Fixture", installUrl: "https://hub.test/install/opaque-fixture-token", expiresAtMs: Date.now() + INSTALL_TOKEN_TTL_MS });
    const command = msg.text.split("\n\n").find((s) => s.startsWith("(wh_installer_tmp="));
    for (const fail of [true, false]) {
      const marker = path.join(dir, "executed"); fs.rmSync(marker, { force: true });
      const result = spawnSync("bash", ["-c", command], { encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, TMPDIR: path.join(dir, "tmp"), FAIL_HTTP: fail ? "1" : "0", INSTALL_MARKER: marker } });
      assert.equal(result.status, fail ? 22 : 0, result.stderr); assert.equal(fs.existsSync(marker), !fail);
      if (fail) assert.match(result.stderr, /forbidden: link revoked/);
      assert.deepEqual(fs.readdirSync(path.join(dir, "tmp")), []);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

summary("install-reissue");
