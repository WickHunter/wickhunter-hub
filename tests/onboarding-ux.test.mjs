// tests/onboarding-ux.test.mjs — the new-customer journey on the Hub side:
// hosted vs self-hosted welcome email, the audited temporary-password reset
// (customer, operator and management-agent halves), plain-language failure
// messages with support references, the post-checkout summary, and the
// install command surfacing the Hub's own refusal text. Every Stripe event is
// synthetic and signed with a test secret; every email/provider call is a
// stub; nothing leaves loopback.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { freshHub, jsonReq, test, summary, tmpDir } from "./helpers.mjs";
import { signStripePayload } from "../dist/src/billing/stripe.js";
import { FakeProvider, credentialResetPassword, hashBootstrapToken } from "../dist/src/hosting/provider.js";
import { CREDENTIAL_RESET_BLOCK } from "../dist/src/hosting/bootstrap.js";
import { customerFailureMessage, supportReference } from "../dist/src/hosting/customer-messages.js";
import { hostedWelcomeEmail, safeInstallCommand, welcomeEmail } from "../dist/src/billing/email.js";
import { credentialResetEmail, exceptionEmail, installationReadyEmail, overdueEmail, suspendedEmail } from "../dist/src/hosting/emails.js";

const WHSEC = "whsec_test_onboarding_0123456789";
const MGMT_TOKEN = "management-token-raw-0123456789abcdef";
const sha = (s) => createHash("sha256").update(s).digest("hex");

async function setup() {
  let clock = Math.floor(Date.now() / 1000) * 1000;
  const billingEmails = [];
  const hostingEmails = [];
  const signinEmails = [];
  const logs = [];
  const capture = (sink) => async (url, init) => {
    if (url === "https://api.resend.com/emails") { sink.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => JSON.stringify({ id: "em_" + sink.length }) }; }
    if (url.includes("/v1/prices/")) return { ok: true, status: 200, text: async () => JSON.stringify({ id: "price_host1", active: true, unit_amount: 2000, currency: "usd", type: "recurring", recurring: { interval: "month", interval_count: 1 } }) };
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const provider = new FakeProvider({ now: () => clock });
  const h = await freshHub({}, {
    billingFetch: capture(billingEmails), hostingFetch: capture(hostingEmails), customerSessionFetch: capture(signinEmails),
    billingNow: () => clock, hostingNow: () => clock, customerSessionNow: () => clock,
    hostingProvider: provider,
    hostingPublicHealthFetch: async () => ({ ok: true, status: 200, body: JSON.stringify({ ok: true, version: "0.90.93" }) }),
  });
  const admin = (p, opts = {}) => jsonReq(`${h.origin}${p}`, { ...opts, headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json", ...(opts.headers ?? {}) } });
  const cfg = await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({
    stripe: { test: { secretKey: "sk_test_onboarding_0123456789", webhookSecret: WHSEC } },
    email: { provider: "resend", apiKey: "re_onboarding_123", from: "Wick Hunter Unleashed <admin@wickhunterunleashed.com>", replyTo: "admin@wickhunterunleashed.com" },
    siteOrigin: "https://www.wickhunterunleashed.com",
  }) });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
  let n = 0;
  async function checkout(customer, email, sessionId) {
    const ev = { id: `evt_${++n}`, object: "event", type: "checkout.session.completed", livemode: false, created: Math.floor(clock / 1000),
      data: { object: { id: sessionId, mode: "subscription", payment_status: "paid", customer, customer_details: { email, name: "Ada Lovelace" }, subscription: `sub_${customer}`, metadata: { plan: "monthly" } } } };
    const body = JSON.stringify(ev);
    const res = await fetch(`${h.origin}/api/billing/stripe/test`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, WHSEC, Math.floor(clock / 1000)) }, body });
    assert.equal(res.status, 200, await res.text());
  }
  /** A managed server already bound to the owner (what a paid bundle
   *  checkout has done by the time its software welcome is sent). */
  function server(ownerId, stage, extra = {}) {
    const store = h.hub.hosting.store;
    let row = store.reserveInstance({ id: `host_${ownerId.replace(/\W/g, "")}`, ownerId, environment: "test", region: "nrt", planId: "vc2-1c-2gb", stripeCustomerId: ownerId, nowMs: clock });
    row = store.updateInstance(row.id, row.version, (d) => {
      d.stage = stage; d.stripeSubscriptionId = `sub_host_${ownerId}`; d.generation = 1;
      d.ip = "203.0.113.7"; d.appUrl = "https://203.0.113.7/"; d.providerInstanceId = "fake-1";
      d.managementTokenHash = hashBootstrapToken(MGMT_TOKEN);
      Object.assign(d, extra);
    }, clock);
    return row;
  }
  async function signIn(email) {
    signinEmails.length = 0;
    const r = await fetch(`${h.origin}/api/customer/signin`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" }, body: JSON.stringify({ email }) });
    assert.equal(r.status, 200);
    const token = /token=([A-Za-z0-9_-]+)/.exec(signinEmails.at(-1).text)[1];
    const ex = await fetch(`${h.origin}/customer/signin?token=${token}`, { redirect: "manual", headers: { "x-forwarded-for": "203.0.113.50" } });
    return ex.headers.getSetCookie()[0].split(";")[0];
  }
  const agent = (id, body, suffix = "") => jsonReq(`${h.origin}/api/hosting/instances/${id}/credential-reset${suffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const origLog = console.log, origWarn = console.warn;
  console.log = (...a) => { logs.push(a.join(" ")); origLog(...a); };
  console.warn = (...a) => { logs.push(a.join(" ")); origWarn(...a); };
  return { h, admin, checkout, server, signIn, agent, billingEmails, hostingEmails, logs, advance: (ms) => { clock += ms; }, now: () => clock,
    close: async () => { console.log = origLog; console.warn = origWarn; await h.close(); } };
}

// ── 1. hosted buyers get a hosted welcome; self-hosted keep the SSH one ────

await test("a self-hosted buyer still receives the install-page welcome email", async () => {
  const c = await setup();
  await c.checkout("cus_self", "self@example.com", "cs_test_selfhosted01");
  assert.equal(c.billingEmails.length, 1);
  const msg = c.billingEmails[0];
  assert.equal(msg.from, "Wick Hunter Unleashed <admin@wickhunterunleashed.com>");
  assert.match(msg.subject, /licence and install link/);
  assert.match(msg.text, /\/welcome\//);
  assert.match(msg.text, /SSH session as root/);
  assert.equal(c.h.hub.billing.store.getCustomer("cus_self").welcomeKind, "self-hosted");
  await c.close();
});

await test("a hosted-server buyer receives the hosted welcome: no install link, no SSH, account + support links", async () => {
  const c = await setup();
  c.server("cus_host", "ordered");
  await c.checkout("cus_host", "host@example.com", "cs_test_hostedbuy001");
  assert.equal(c.billingEmails.length, 1);
  const msg = c.billingEmails[0];
  assert.equal(msg.from, "Wick Hunter Unleashed <admin@wickhunterunleashed.com>");
  assert.match(msg.subject, /your server is being set up/);
  for (const body of [msg.text, msg.html]) {
    assert.doesNotMatch(body, /\/welcome\//, "no self-hosted install page link");
    assert.doesNotMatch(body, /SSH session|one-line command|Get a server/i, "no self-hosting steps");
    assert.match(body, /hub\.test\/hub\/customer#hosting/);
    assert.match(body, /Your Unleashed VPS is ready/);
    assert.match(body, /admin@wickhunterunleashed\.com/);
    assert.match(body, /hub\.test\/hub\/support/);
  }
  assert.match(msg.html, /name="viewport"/);
  assert.match(msg.html, /max-width:600px/);
  assert.equal(c.h.hub.billing.store.getCustomer("cus_host").welcomeKind, "hosted");
  await c.close();
});

await test("an unpaid add-on reservation does not turn a software buyer's welcome into the hosted one", async () => {
  const c = await setup();
  c.server("cus_cart", "ordered", { stripeSubscriptionId: null });
  await c.checkout("cus_cart", "cart@example.com", "cs_test_cartonly0001");
  assert.match(c.billingEmails[0].subject, /licence and install link/);
  await c.close();
});

await test("hosted welcome names the dashboard when the server is already ready", () => {
  const msg = hostedWelcomeEmail("a@example.com", { name: "Ada", expiresAtMs: Date.UTC(2026, 11, 1), subscription: true, siteOrigin: "https://www.wickhunterunleashed.com", hubOrigin: "https://hub.example", livemode: true, dashboardUrl: "https://203.0.113.9/" });
  assert.match(msg.text, /Your server is ready\. Your dashboard address is https:\/\/203\.0\.113\.9\//);
  assert.match(msg.html, /Open your dashboard/);
  assert.doesNotMatch(msg.subject, /TEST/);
});

// ── 2. temporary password reset ────────────────────────────────────────────

await test("reset: customer request, agent poll, server confirmation, email with the derived password, nonce forgotten", async () => {
  const c = await setup();
  await c.checkout("cus_r", "reset@example.com", "cs_test_resetflow001");
  const row = c.server("cus_r", "active");
  const view0 = c.h.hub.hosting.customerView("cus_r").instance.credentialReset;
  assert.equal(view0.available, false, "no reset-capable agent has polled yet");
  assert.match(view0.unavailableReason, /Contact support/);
  const early = await c.h.hub.hosting.requestCredentialReset(row.id, { kind: "customer", by: "reset@example.com" });
  assert.equal(early.code, "RESET_UNAVAILABLE");

  assert.equal((await c.agent(row.id, { managementToken: "wrong", generation: 1 })).status, 404, "a wrong management token learns nothing");
  assert.equal((await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 2 })).status, 404, "a stale generation learns nothing");
  const idle = await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1 });
  assert.deepEqual(idle.body, { ok: true, reset: null });

  // Through the signed-in customer route (cookie + CSRF header).
  const route = `${c.h.origin}/api/hosting/${row.id}/reset-password`;
  assert.equal((await fetch(route, { method: "POST", headers: { "x-wh-customer-action": "1" } })).status, 401);
  assert.equal((await fetch(route, { method: "POST" })).status, 403, "the customer-action header is required");
  const cookie = await c.signIn("reset@example.com");
  const asked = await jsonReq(route, { method: "POST", headers: { cookie, "x-wh-customer-action": "1", "content-type": "application/json" }, body: "{}" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.ok, true);
  assert.ok(!JSON.stringify(asked.body).match(/[0-9a-f]{24}/), "the response never carries a password");
  assert.equal(c.h.hub.hosting.customerView("cus_r").instance.credentialReset.status, "pending");

  const poll = await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1 });
  assert.match(poll.body.reset.id, /^cred_/);
  assert.match(poll.body.reset.nonce, /^[A-Za-z0-9_-]{16,64}$/);
  const expected = createHash("sha256").update(`${sha(MGMT_TOKEN)}:reset:${poll.body.reset.nonce}`).digest("hex").slice(0, 24);
  assert.equal(credentialResetPassword(hashBootstrapToken(MGMT_TOKEN), poll.body.reset.nonce), expected, "the agent's shell derivation and the Hub's agree");
  const adminList = await c.admin("/admin/api/hosting/instances");
  const listed = adminList.body.instances.find((i) => i.id === row.id);
  assert.equal(listed.credentialReset.nonce, "(set)", "the admin list never shows derivation input");
  assert.equal(listed.managementTokenHash, "(set)");

  assert.equal((await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1, resetId: "cred_other", outcome: "applied" }, "/confirm")).status, 404);
  const ok = await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1, resetId: poll.body.reset.id, outcome: "applied" }, "/confirm");
  assert.equal(ok.status, 200);
  assert.equal(c.h.hub.hosting.customerView("cus_r").instance.credentialReset.status, "emailing");
  await c.h.hub.hosting.tick(c.now());
  const sent = c.hostingEmails.filter((m) => m.subject === "Your new temporary Unleashed password");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to[0], "reset@example.com");
  assert.ok(sent[0].text.includes(expected) && sent[0].html.includes(expected));
  assert.match(sent[0].text, /As you requested/);
  const after = c.h.hub.hosting.store.getInstance(row.id);
  assert.equal(after.credentialReset, null, "the nonce is erased once the email is sent");
  assert.deepEqual(after.credentialResetLog.map((e) => e.event), ["requested", "applied", "emailed"]);
  assert.equal(after.credentialResetLog[0].by, "customer:reset@example.com");
  assert.equal(c.h.hub.hosting.customerView("cus_r").instance.credentialReset.status, "emailed");
  assert.ok(!c.logs.some((l) => l.includes(expected) || l.includes(poll.body.reset.nonce)), "neither the password nor its nonce reaches a log line");
  assert.ok(c.logs.some((l) => /temporary app password reset cred_\S+ requested by customer:reset@example\.com/.test(l)), "the request is audited");
  await c.close();
});

await test("reset: failed application, expiry, the daily customer cap, stage gating and the operator path", async () => {
  const c = await setup();
  await c.checkout("cus_f", "fail@example.com", "cs_test_resetfail001");
  const row = c.server("cus_f", "active");
  await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1 });
  const svc = c.h.hub.hosting;

  // failed on the server → previous password still valid, reference shown
  let r = await svc.requestCredentialReset(row.id, { kind: "customer", by: "fail@example.com" });
  assert.equal(r.ok, true);
  const again = await svc.requestCredentialReset(row.id, { kind: "customer", by: "fail@example.com" });
  assert.equal(again.value.alreadyPending, true, "a double click is one request");
  let poll = await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1 });
  await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1, resetId: poll.body.reset.id, outcome: "failed" }, "/confirm");
  let view = svc.customerView("cus_f").instance.credentialReset;
  assert.equal(view.status, "failed");
  assert.match(view.reference, /^WH-[0-9A-F]{8}$/);
  await svc.tick(c.now());
  assert.equal(c.hostingEmails.filter((m) => /temporary Unleashed password/.test(m.subject)).length, 0, "nothing is emailed for a reset the server did not apply");

  // expiry: the agent never picks it up within two hours
  r = await svc.requestCredentialReset(row.id, { kind: "customer", by: "fail@example.com" });
  assert.equal(r.ok, true);
  c.advance(2 * 60 * 60 * 1000 + 1);
  poll = await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1 });
  assert.equal(poll.body.reset, null);
  assert.equal(svc.customerView("cus_f").instance.credentialReset.status, "expired");

  // the third customer request inside 24h is allowed, the fourth is not
  r = await svc.requestCredentialReset(row.id, { kind: "customer", by: "fail@example.com" });
  assert.equal(r.ok, true);
  poll = await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1 });
  await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1, resetId: poll.body.reset.id, outcome: "failed" }, "/confirm");
  r = await svc.requestCredentialReset(row.id, { kind: "customer", by: "fail@example.com" });
  assert.equal(r.code, "RATE_LIMITED");

  // operator: no daily cap, audited, owner gets the email
  const op = await c.admin(`/admin/api/hosting/instances/${row.id}/reset-password`, { method: "POST", body: JSON.stringify({ by: "zl" }) });
  assert.equal(op.status, 200, JSON.stringify(op.body));
  poll = await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1 });
  await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1, resetId: poll.body.reset.id, outcome: "applied" }, "/confirm");
  await svc.tick(c.now());
  const sent = c.hostingEmails.filter((m) => /temporary Unleashed password/.test(m.subject));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Our support team reset/);
  assert.equal(svc.store.getInstance(row.id).credentialResetLog.filter((e) => e.event === "requested").at(-1).by, "operator:zl");

  // a suspended server cannot be reset by anyone
  const s = svc.store.getInstance(row.id);
  svc.store.updateInstance(s.id, s.version, (d) => { d.stage = "suspended"; }, c.now());
  assert.equal((await svc.requestCredentialReset(row.id, { kind: "customer", by: "x" })).code, "RESET_UNAVAILABLE");
  assert.equal((await c.admin(`/admin/api/hosting/instances/${row.id}/reset-password`, { method: "POST", body: "{}" })).status, 409);
  await c.close();
});

await test("reset: a stranger's signed-in session cannot reset someone else's server", async () => {
  const c = await setup();
  await c.checkout("cus_owner", "owner@example.com", "cs_test_ownerowner01");
  await c.checkout("cus_other", "other@example.com", "cs_test_otherother01");
  const row = c.server("cus_owner", "active");
  await c.agent(row.id, { managementToken: MGMT_TOKEN, generation: 1 });
  const cookie = await c.signIn("other@example.com");
  const r = await jsonReq(`${c.h.origin}/api/hosting/${row.id}/reset-password`, { method: "POST", headers: { cookie, "x-wh-customer-action": "1" }, body: "{}" });
  assert.equal(r.status, 404);
  assert.equal(c.h.hub.hosting.store.getInstance(row.id).credentialReset ?? null, null);
  await c.close();
});

// ── the management agent's shell block, run for real against stubs ────────

function runAgentBlock({ seeds }) {
  const dir = tmpDir("agent");
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  const app = path.join(dir, "app"); fs.mkdirSync(path.join(app, "data"), { recursive: true });
  const state = path.join(dir, "state"); fs.mkdirSync(state);
  const envFile = path.join(dir, "env");
  fs.writeFileSync(envFile, 'LIQHUNTER_SECRET="keep-me"\n', { mode: 0o600 });
  const oldRecord = JSON.stringify({ createdFrom: "user", mustChange: false, hash: "scrypt$old" });
  fs.writeFileSync(path.join(app, "data", "app-credential.json"), oldRecord);
  const nonce = "Nonce_abcdefghijklmnop";
  const exe = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  // curl: Hub poll / confirm and the local health check.
  exe("curl", `url="\${@: -1}"; body=$(cat 2>/dev/null || true)
case "$url" in
  */credential-reset) printf '%s' '{"ok":true,"reset":{"id":"cred_abcdefgh12","nonce":"${nonce}"}}' ;;
  */credential-reset/confirm) printf '%s\\n' "$body" >> "${dir}/confirms" ;;
  */api/health) printf '{"ok":true,"version":"1.2.3"}' ;;
esac`);
  // systemctl: emulate the app's first-boot contract on restart.
  exe("systemctl", `echo "$*" >> "${dir}/systemctl"
inv=$(cat "${dir}/inv" 2>/dev/null || echo 0)
case "$1" in
  show) echo "inv-$inv"; exit 0 ;;
  is-active) exit 0 ;;
esac
[ "$1 $2" = "--no-block restart" ] || exit 0
echo $((inv + 1)) > "${dir}/inv"
if [ "${seeds ? 1 : 0}" = 1 ] && [ ! -s "${app}/data/app-credential.json" ]; then
  pw=$(sed -n 's/^LIQHUNTER_BOOTSTRAP_PASSWORD=//p' "${envFile}")
  [ -n "$pw" ] && printf '{"createdFrom":"bootstrap","mustChange":true,"hash":"seeded:%s"}' "$(printf '%s' "$pw" | sha256sum | cut -c1-16)" > "${app}/data/app-credential.json"
fi
exit 0`);
  exe("sleep", "exit 0");
  const block = CREDENTIAL_RESET_BLOCK
    .replace("CRED_APP_DIR=/opt/wickhunter", `CRED_APP_DIR=${app}`)
    .replace("CRED_ENV_FILE=/etc/wickhunter/env", `CRED_ENV_FILE=${envFile}`)
    .replace("CRED_STATE_DIR=/etc/wickhunter-hosting", `CRED_STATE_DIR=${state}`);
  const script = `set -euo pipefail\nHUB=https://hub.test\nINSTANCE=host_1\nGENERATION=1\nTOKEN='${MGMT_TOKEN}'\nAPP_VERSION=1.2.3\n${block}\nif credential_reset; then echo RESULT=applied; else echo RESULT=failed; fi\n`;
  const r = spawnSync("bash", ["-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
  const pw = credentialResetPassword(hashBootstrapToken(MGMT_TOKEN), nonce);
  return { r, dir, app, envFile, state, oldRecord, pw,
    record: () => fs.readFileSync(path.join(app, "data", "app-credential.json"), "utf8"),
    confirms: () => fs.existsSync(path.join(dir, "confirms")) ? fs.readFileSync(path.join(dir, "confirms"), "utf8") : "",
    restarts: () => fs.readFileSync(path.join(dir, "systemctl"), "utf8").split("\n").filter((l) => l.startsWith("--no-block restart")).length };
}

await test("agent block: seeds the Hub-derived password through the app's bootstrap contract, strips it, confirms", () => {
  const a = runAgentBlock({ seeds: true });
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.match(a.r.stdout, /RESULT=applied/);
  const rec = JSON.parse(a.record());
  assert.equal(rec.createdFrom, "bootstrap");
  assert.equal(rec.hash, `seeded:${sha(a.pw).slice(0, 16)}`, "the app was seeded with exactly the password the Hub emails");
  const env = fs.readFileSync(a.envFile, "utf8");
  assert.doesNotMatch(env, /LIQHUNTER_BOOTSTRAP_PASSWORD/, "the plaintext never outlives the seeding restart");
  assert.match(env, /LIQHUNTER_SECRET="keep-me"/, "other configuration is preserved");
  assert.equal((fs.statSync(a.envFile).mode & 0o777), 0o600);
  assert.equal(a.restarts(), 2);
  assert.match(a.confirms(), /"resetId":"cred_abcdefgh12","outcome":"applied"/);
  assert.equal(fs.readdirSync(a.state).length, 0, "the backup is removed");
  assert.ok(!a.r.stdout.includes(a.pw) && !a.r.stderr.includes(a.pw));
});

await test("agent block: an app that does not seed keeps its previous credential and the Hub hears 'failed'", () => {
  const a = runAgentBlock({ seeds: false });
  assert.match(a.r.stdout, /RESULT=failed/);
  assert.equal(a.record(), a.oldRecord, "the previous credential record is restored byte for byte");
  assert.doesNotMatch(fs.readFileSync(a.envFile, "utf8"), /LIQHUNTER_BOOTSTRAP_PASSWORD/);
  assert.match(a.confirms(), /"outcome":"failed"/);
});

// ── 3. plain-language failure messages with support references ─────────────

await test("raw failure reasons never reach the customer page or setup-failure email; admin keeps them with the same reference", async () => {
  const c = await setup();
  await c.checkout("cus_fail", "broken@example.com", "cs_test_brokenbuy001");
  const row = c.server("cus_fail", "bootstrapping");
  const raw = "advertised hosting price no longer covers the verified provider cost plus the minimum margin";
  const s = c.h.hub.hosting.store.getInstance(row.id);
  c.h.hub.hosting.store.updateInstance(s.id, s.version, (d) => { d.failureReason = raw; }, c.now());
  const inst = c.h.hub.hosting.customerView("cus_fail").instance;
  assert.doesNotMatch(inst.failureReason, /margin|provider cost|advertised/);
  assert.match(inst.failureReason, /could not finish setting up your server/);
  assert.equal(inst.supportReference, supportReference(row.id, raw));
  const adminRow = (await c.admin("/admin/api/hosting/instances")).body.instances.find((i) => i.id === row.id);
  assert.equal(adminRow.failureReason, raw, "the operator still sees the raw reason");
  assert.equal(adminRow.supportReference, inst.supportReference);
  const fresh = c.h.hub.hosting.store.getInstance(row.id);
  c.h.hub.hosting.store.enqueue({ hostingInstanceId: fresh.id, lifecycleVersion: fresh.lifecycleVersion, generation: fresh.generation, jobType: "email", dedupeKey: "email:setup_failure:test", availableAtMs: c.now(), payload: { template: "setup_failure" } }, c.now());
  await c.h.hub.hosting.tick(c.now());
  const mail = c.hostingEmails.find((m) => /could not finish setting up/.test(m.subject));
  assert.ok(mail);
  assert.ok(mail.text.includes(inst.supportReference));
  assert.doesNotMatch(mail.text + mail.html, /minimum margin|provider cost/);
  await c.close();
});

await test("failure message mapping covers every internal marker without echoing it", () => {
  for (const raw of ["checkout_expired", "bundle_subscription_ended_before_activation", "unreserved_payment", "late_payment_resolution_required",
    "a charge on this hosting subscription is under dispute", "Paid recovery is waiting for server readiness — bybit: blocked",
    "readiness refused in nrt: bybit 403 — replacing it once in Singapore", "setup failed after 3 attempts",
    "the provider cost ceiling changed or was reached before server creation", "suspended by an operator", "some free-text operator note"]) {
    const m = customerFailureMessage("host_x", raw);
    assert.ok(!m.message.includes(raw), raw);
    assert.doesNotMatch(m.message, /_|nrt|403|ceiling|operator note/);
    assert.match(m.reference, /^WH-[0-9A-F]{8}$/);
  }
  assert.equal(customerFailureMessage("a", "x").reference, customerFailureMessage("a", "x").reference);
  assert.notEqual(customerFailureMessage("a", "x").reference, customerFailureMessage("b", "x").reference);
});

await test("a refused hosting checkout shows the customer a plain sentence, the log keeps the cause", async () => {
  const c = await setup();
  await c.checkout("cus_ck", "ck@example.com", "cs_test_checkout0001");
  const cookie = await c.signIn("ck@example.com");
  const r = await jsonReq(`${c.h.origin}/api/hosting/checkout`, { method: "POST", headers: { cookie, "x-wh-customer-action": "1" }, body: "{}" });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "New servers are not available to order right now. Please try again later or contact support.");
  assert.ok(c.logs.some((l) => /\[hosting\] checkout refused for cus_ck: PROVISIONING_DISABLED: /.test(l)));
  await c.close();
});

// ── 4. post-checkout summary ───────────────────────────────────────────────

await test("checkout summary: bad ids refused, unknown ids 'processing', known ids a minimal masked summary", async () => {
  const c = await setup();
  const get = (id) => jsonReq(`${c.h.origin}/api/checkout/summary?session_id=${encodeURIComponent(id)}`);
  assert.equal((await get("nope")).status, 400);
  assert.deepEqual((await get("cs_test_doesnotexist1")).body, { ok: true, status: "processing" });
  await c.checkout("cus_sum", "summary.person@example.com", "cs_test_summaryself01");
  const self = (await get("cs_test_summaryself01")).body;
  assert.equal(self.status, "confirmed");
  assert.equal(self.product, "self-hosted");
  assert.equal(self.planName, "Monthly");
  assert.equal(self.welcomeSent, true);
  assert.equal(self.server, null);
  assert.ok(!JSON.stringify(self).includes("summary.person@example.com"), "the full email is never returned");
  assert.match(self.emailHint, /^s•+@e•+\.com$/);
  c.server("cus_sumh", "provisioning");
  await c.checkout("cus_sumh", "h@example.com", "cs_test_summaryhost01");
  const hosted = (await get("cs_test_summaryhost01")).body;
  assert.equal(hosted.product, "hosted");
  assert.deepEqual(hosted.server, { stage: "provisioning", ready: false });
  for (const key of Object.keys(hosted)) assert.ok(["ok", "status", "product", "planName", "lifetime", "livemode", "emailHint", "welcomeSent", "server"].includes(key), key);
  await c.close();
});

// ── 5. install commands surface the Hub's reason ───────────────────────────

await test("install routes answer with one plain 'Wick Hunter:' line and every customer command keeps the body", async () => {
  const c = await setup();
  const bad = await fetch(`${c.h.origin}/install/not-a-real-token`);
  const text = await bad.text();
  assert.match(text, /^Wick Hunter: /);
  assert.equal(text.trim().split("\n").length, 1);
  assert.doesNotMatch(text, /at \w+ \(|Error:|stack/i, "no stack trace");
  const key = await fetch(`${c.h.origin}/install.sh?key=garbage`);
  assert.equal(key.status, 403);
  assert.match(await key.text(), /^Wick Hunter: this licence key is not valid/);
  await c.close();
});

function runInstallCommand(body, status = 22) {
  const dir = tmpDir("cmd");
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, "body"), body);
  fs.writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env bash\nout=""; while [ "$#" -gt 0 ]; do case "$1" in -o) shift; out=$1;; esac; shift; done\ncat ${dir}/body > "$out"\nexit ${status}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sudo"), `#!/usr/bin/env bash\necho SUDO-RAN\n`, { mode: 0o755 });
  return spawnSync("bash", ["-c", safeInstallCommand("https://hub.test/install/tok")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
}

await test("the one-line install command prints the Hub's reason, hides proxy HTML, and never runs a refused body", () => {
  let r = runInstallCommand("Wick Hunter: install stopped — this licence has lapsed — renew it from your install page first.\n");
  assert.equal(r.status, 22);
  assert.match(r.stderr, /this licence has lapsed/);
  assert.doesNotMatch(r.stdout, /SUDO-RAN/);
  r = runInstallCommand("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>");
  assert.match(r.stderr, /could not be reached/);
  assert.doesNotMatch(r.stderr, /html|Bad Gateway/i);
  r = runInstallCommand("", 6);
  assert.match(r.stderr, /could not be reached/);
});

await test("install.sh's refusal path shows the Hub's reason (plain text or JSON error), never HTML", () => {
  const template = fs.readFileSync(new URL("../templates/install.sh", import.meta.url), "utf8");
  const from = template.indexOf("hub_reason() {");
  const to = template.indexOf("\nHUB_REASON\n}", from) + "\nHUB_REASON\n}".length;
  const fn = template.slice(from, to);
  for (const [body, expected] of [
    ["Wick Hunter: this licence has lapsed. Renew it from your account page, then run the install command again. (licence expired)\n", "this licence has lapsed. Renew it from your account page, then run the install command again. (licence expired)"],
    ['{"ok":false,"error":"no verified customer release is published"}', "no verified customer release is published"],
    ["<html><body>oops</body></html>", ""],
    ["line one\u0007\nline two", "line one"],
  ]) {
    const dir = tmpDir("reason");
    fs.writeFileSync(path.join(dir, "body"), body);
    fs.writeFileSync(path.join(dir, "curl"), `#!/usr/bin/env bash\ncat ${dir}/body\n`, { mode: 0o755 });
    const r = spawnSync("bash", ["-c", `set -Eeuo pipefail\nwork=${dir}\nCHANNEL_AWARE=0\n${fn}\nprintf '[%s]' "$(hub_reason https://hub.test/api/latest)"`], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
    assert.equal(r.stdout, `[${expected}]`, r.stderr);
  }
});

// ── 6. template review: every customer email shares the mobile layout ──────

await test("every hosting email uses the branded mobile layout, names support, and escapes its fields", () => {
  const facts = { instanceReference: "host_<x>", appUrl: "https://203.0.113.1/", region: "Tokyo", cpu: "1 vCPU", ram: "2 GB", storage: "55 GB", os: "Ubuntu 24.04 LTS x64", ip: "203.0.113.1", appUsername: "admin", sshUsername: "root", sshPort: 22, accessUrl: "https://hub.example/customer#hosting", temporaryPassword: "0123456789abcdef01234567", maximumConnectedAccounts: 5, billingSummary: "Hosting is $20.00 per month.", renewalAt: null, backupScopeSentence: "No managed backups." };
  const messages = [
    installationReadyEmail("a@example.com", "Ada", facts),
    credentialResetEmail("a@example.com", { instanceReference: "host_<x>", appUrl: "https://203.0.113.1/", appUsername: "admin", accountUrl: "https://hub.example/customer#hosting", temporaryPassword: "fedcba", requestedBy: "customer" }),
    overdueEmail("a@example.com", "host_<x>", Date.now(), Date.now() + 1, "https://hub.example/customer#hosting", ""),
    suspendedEmail("a@example.com", "host_<x>", Date.now(), "https://hub.example/customer#hosting"),
    exceptionEmail("a@example.com", "setup_failure", "host_<x>", "Support reference: WH-12345678.", "https://hub.example/customer#hosting"),
  ];
  for (const m of messages) {
    assert.match(m.html, /name="viewport"/, m.subject);
    assert.match(m.html, /max-width:600px/, m.subject);
    assert.match(m.html, /@media only screen and \(max-width:620px\)/, m.subject);
    assert.match(m.text + m.html, /admin@wickhunterunleashed\.com/, m.subject);
    assert.ok(!m.html.includes("host_<x>"), `${m.subject}: unescaped field`);
  }
  const ready = messages[0];
  assert.match(ready.text, /Request a new temporary password|request a new temporary password/);
  assert.match(ready.html, /Open your dashboard/);
  // The self-hosted welcome is unchanged in substance.
  const self = welcomeEmail("b@example.com", { name: "Bo", pageUrl: "https://hub.example/welcome/t", expiresAtMs: Date.now(), subscription: true, siteOrigin: "", livemode: true });
  assert.match(self.text, /OPEN YOUR INSTALL PAGE/);
});

summary("onboarding-ux");
