// tests/hosting-complimentary.test.mjs — v0.4.104 operator-granted
// complimentary servers: POST /admin/api/hosting/complimentary and
// /admin/api/hosting/instances/:id/end-complimentary. A grant must take the
// SAME reservation -> provision job -> bootstrap installer -> readiness ->
// emails path a paid server takes, with no Stripe call, no nonpayment or
// dunning derivation, and an explicit end through the ordinary
// suspend/delete schedule. Also: the one-shot migration of the 2026-10-05
// hand-written operator test record, and no effect on paying customers.
// Offline only: FakeProvider, stubbed email/Stripe fetches, a fixture
// release signed by the suite's own key.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, sign } from "node:crypto";
import { freshHub, freshStore, tmpDir, jsonReq, test, summary } from "./helpers.mjs";
import { createHub } from "../dist/src/server.js";
import { FakeProvider, hashBootstrapToken } from "../dist/src/hosting/provider.js";
import { addUtcMonths } from "../dist/src/hosting/service.js";
import { releaseSigningBytes } from "../dist/src/release-manifest.js";
import { signStripePayload } from "../dist/src/billing/stripe.js";
import { COMPLIMENTARY_MIGRATION_MARKER_FILE } from "../dist/src/billing/store.js";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const EMAIL = "Operator.Test@Example.test";
const NORMALIZED = "operator.test@example.test";
const OWNER = `complimentary:${NORMALIZED}`;
const TEST_WHSEC = "whsec_test_complimentary_0123456789";
const VENUES = ["bybit", "binance", "bitget", "bitunix", "blofin", "weex", "aster"];

function publishRelease(h, version = "0.91.32") {
  const artifact = Buffer.from(`fixture beta release ${version}`);
  const unsigned = { schema: "wickhunter.release.v1", product: "wickhunter", channel: "beta", platform: "linux", arch: "x64", version, buildId: `build-${version}`, file: `wickhunter-beta-${version}.tar.gz`,
    sha256: createHash("sha256").update(artifact).digest("hex"), issuedAt: new Date().toISOString(), minUpdateProtocol: 1 };
  const signed = { ...unsigned, signatures: [{ kid: h.releaseSigner.kid, alg: "Ed25519", sig: sign(null, releaseSigningBytes(unsigned), h.releaseSigner.privateKey).toString("base64url") }] };
  fs.writeFileSync(path.join(h.releasesDir, unsigned.file), artifact);
  fs.writeFileSync(path.join(h.releasesDir, "latest.json"), JSON.stringify(signed));
  fs.writeFileSync(path.join(h.releasesDir, `manifest-${unsigned.sha256}.json`), JSON.stringify(signed));
  return unsigned.sha256;
}

async function fixture(opts = {}) {
  let clock = Date.parse("2026-11-04T12:00:00Z");
  const calls = [];
  const record = (source) => async (url, init = {}) => {
    calls.push({ source, url, init, atMs: clock });
    if (url.includes("api.resend.com")) return { ok: true, status: 200, text: async () => JSON.stringify({ id: `mail_${calls.length}` }) };
    if (url.includes("/v1/prices/")) return { ok: true, status: 200, text: async () => JSON.stringify({ id: "price_host1", active: true, unit_amount: 2000, currency: "usd", type: "recurring", recurring: { interval: "month", interval_count: 1 } }) };
    if (url.endsWith("/v1/checkout/sessions")) return { ok: true, status: 200, text: async () => JSON.stringify({ url: "https://checkout.stripe.com/c/pay_test" }) };
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const provider = new FakeProvider({ now: () => clock });
  const h = await freshHub(opts.cfg ?? {}, {
    billingFetch: record("billing"), billingNow: () => clock, hostingNow: () => clock, hostingFetch: record("hosting"),
    hostingPublicHealthFetch: async () => ({ ok: true, status: 200, body: JSON.stringify({ ok: true, version: "0.91.32" }) }),
    hostingProvider: provider,
  });
  const headers = { "x-hub-admin": "test-admin-token", "x-hub-csrf": "marketplace-config-v1", "content-type": "application/json" };
  const admin = (p, body, extra = {}) => jsonReq(`${h.origin}${p}`, body === undefined ? { headers: { ...headers, ...extra } } : { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await admin("/admin/api/billing/config", {
    email: { provider: "resend", apiKey: "re_fixture_private", from: "Wick Hunter <admin@example.test>" },
    stripe: { test: { secretKey: "sk_test_complimentary_0123456789", webhookSecret: TEST_WHSEC, paymentLinks: { "hosting-monthly": "https://buy.stripe.com/test_hosting" } } },
    roles: { test: { hosting: { priceIds: ["price_host1"], productIds: [] } } },
    plans: [
      { key: "monthly", name: "Monthly", amountCents: 9900, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "software" },
      { key: "hosting-monthly", name: "Hosting", amountCents: 2000, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "", role: "hosting" },
    ],
  })).status, 200);
  assert.equal((await admin("/admin/api/hosting/policy", { policy: { provisioningEnabled: true, monthlyPriceCents: 2000, osId: "1743", releaseRef: "b".repeat(64), ...(opts.policy ?? {}) } })).status, 200);
  const releaseSha = opts.noRelease ? null : publishRelease(h);
  const hosting = h.hub.hosting, billing = h.hub.billing;
  hosting.stop();
  const logs = [];
  hosting.log = (line) => logs.push(line);
  const mails = () => calls.filter((c) => c.url.includes("api.resend.com")).map((c) => ({ source: c.source, atMs: c.atMs, ...JSON.parse(c.init.body) }));
  const stripeCalls = () => calls.filter((c) => c.url.includes("api.stripe.com"));
  async function postEvent(type, object) {
    const ev = { id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", type, livemode: false, created: Math.floor(clock / 1000), data: { object } };
    const body = JSON.stringify(ev);
    const res = await fetch(`${h.origin}/api/billing/stripe/test`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, TEST_WHSEC, Math.floor(clock / 1000)) }, body });
    return res.status;
  }
  return { h, hosting, billing, provider, admin, logs, mails, stripeCalls, calls, releaseSha, postEvent,
    now: () => clock, advance: (ms) => { clock += ms; }, tick: async () => hosting.tick(clock) };
}

const grant = (over = {}) => ({ email: EMAIL, reason: "operator requested a Beta server", by: "ops", channel: "beta", idempotencyKey: "comp-fixture-key-0001", ...over });

async function bringReady(f, id) {
  await f.tick(); // provision job -> provider create -> bootstrapping
  let row = f.hosting.store.getInstance(id);
  assert.equal(row.stage, "bootstrapping");
  const raw = "tok-complimentary";
  f.hosting.store.updateInstance(row.id, row.version, (d) => { d.bootstrapTokenHash = hashBootstrapToken(raw); d.bootstrapTokenExpiresAtMs = f.now() + HOUR; }, f.now());
  row = f.hosting.store.getInstance(id);
  const installer = await fetch(`${f.h.origin}/api/hosting/instances/${id}/installer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: raw, generation: row.generation }) });
  assert.equal(installer.status, 200, "the bootstrap fetches the signed installer with the complimentary licence");
  const ready = await jsonReq(`${f.h.origin}/api/hosting/instances/${id}/readiness`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: raw, generation: row.generation, results: VENUES.map((venueId) => ({ venueId, status: 200 })) }) });
  assert.equal(ready.status, 200); assert.equal(ready.body.ready, true);
  await f.tick(); // ready email
  return f.hosting.store.getInstance(id);
}

await test("create: licence bound and eligible, instance ordered with the Beta release pinned, provision job queued, welcome emailed to the given address, audit written, no Stripe call", async () => {
  const f = await fixture();
  try {
    const r = await f.admin("/admin/api/hosting/complimentary", grant());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.created, true);
    assert.equal(r.body.ownerId, OWNER);
    assert.equal(r.body.releaseRef, f.releaseSha);
    assert.equal(r.body.releaseVersion, "0.91.32");
    assert.equal(r.body.welcome.sent, true);
    const row = f.hosting.store.getInstance(r.body.instanceId);
    assert.equal(row.stage, "ordered"); assert.equal(row.complimentary, true); assert.equal(row.releasePin, f.releaseSha);
    assert.equal(row.planId, "vc2-2c-2gb"); assert.equal(row.region, "nrt");
    assert.equal(row.providerPlanMonthlyCostCents, 1500, "the provider quote is captured so the cost projection stays known");
    assert.equal(row.paidThroughMs, null);
    const jobs = f.hosting.store.outboxFor(row.id);
    assert.ok(jobs.some((j) => j.jobType === "provision" && j.status === "pending"));
    assert.ok(f.hosting.softwareEligible(OWNER, f.now()), "the bound licence makes the owner eligible");
    const customer = f.billing.store.getCustomer(OWNER);
    assert.equal(customer.email, NORMALIZED); assert.equal(customer.stripeCustomerId, ""); assert.ok(customer.complimentary);
    assert.equal(customer.licenseId, r.body.licenseId);
    const lic = f.h.store.get(r.body.licenseId);
    assert.ok(lic.exp > f.now() + 3000 * DAY, "an open-ended grant gets a long licence");
    const role = f.billing.store.getRoleSubscription(OWNER, "hosting");
    assert.equal(role.subscriptionId, null); assert.equal(role.complimentary.instanceId, row.id); assert.equal(role.complimentary.by, "ops");
    const welcome = f.mails();
    assert.equal(welcome.length, 1);
    assert.deepEqual(welcome[0].to, [NORMALIZED]);
    assert.equal(welcome[0].from, "Wick Hunter <admin@example.test>");
    assert.match(welcome[0].text, /Complimentary — no payment is taken/);
    assert.ok(f.billing.events(50).some((e) => e.type === "admin.hosting.complimentary.create" && JSON.parse(e.note).instanceId === row.id));
    assert.equal(f.stripeCalls().length, 0);
  } finally { await f.h.close(); }
});

await test("end to end: provider create, installer, readiness, ready email (with the temporary password) to the address, then months of ticks never suspend, dun or call Stripe", async () => {
  const f = await fixture();
  try {
    const r = await f.admin("/admin/api/hosting/complimentary", grant());
    const row = await bringReady(f, r.body.instanceId);
    assert.equal(row.stage, "ready"); assert.equal(row.operationalHealth, "healthy");
    assert.equal(row.releaseRef, f.releaseSha, "the generation pinned the Beta release, not the policy's older ref");
    assert.equal(f.provider.createCalls.length, 1);
    assert.equal(f.provider.createCalls[0].planId, "vc2-2c-2gb");
    const ready = f.mails().filter((m) => /ready/i.test(m.subject));
    assert.equal(ready.length, 1, JSON.stringify(f.mails().map((m) => m.subject)));
    assert.deepEqual(ready[0].to, [NORMALIZED]);
    assert.match(ready[0].text, /complimentary: no hosting payment is taken/);
    const sent = f.hosting.store.outboxFor(row.id).find((j) => j.dedupeKey.startsWith("email:ready:"));
    assert.equal(sent.status, "sent");
    const mailCount = f.mails().length;
    for (let i = 0; i < 90; i++) { f.advance(DAY); await f.tick(); }
    const after = f.hosting.store.getInstance(row.id);
    assert.equal(after.stage, "ready"); assert.equal(after.cancellationReason, null); assert.equal(after.suspendAtMs, null);
    assert.equal(f.mails().length, mailCount, "no overdue/reminder/cancellation email");
    assert.equal(f.stripeCalls().length, 0);
    assert.ok(!f.hosting.store.outboxFor(row.id).some((j) => j.jobType === "billing_reconcile" || j.jobType === "suspend" || j.jobType === "delete"));
    assert.ok(!f.logs.some((l) => /refusing (unreserved|paid hosting)/.test(l)), f.logs.join("\n"));
  } finally { await f.h.close(); }
});

await test("idempotency: the same key answers with the same server; another key while it lives is 409; nothing is duplicated", async () => {
  const f = await fixture();
  try {
    const a = await f.admin("/admin/api/hosting/complimentary", grant());
    const b = await f.admin("/admin/api/hosting/complimentary", grant());
    assert.equal(b.status, 200); assert.equal(b.body.created, false); assert.equal(b.body.instanceId, a.body.instanceId); assert.equal(b.body.licenseId, a.body.licenseId);
    assert.equal(b.body.welcome.alreadySent, true);
    const c = await f.admin("/admin/api/hosting/complimentary", grant({ idempotencyKey: "comp-fixture-key-0002" }));
    assert.equal(c.status, 409); assert.equal(c.body.code, "HOSTING_ALREADY_EXISTS");
    assert.equal(f.hosting.store.instances().filter((r) => r.ownerId === OWNER).length, 1);
    assert.equal(f.mails().length, 1, "one welcome only");
    assert.equal(Object.values(f.h.store.list()).filter((l) => l.name.startsWith("Complimentary")).length, 1, "one licence only");
  } finally { await f.h.close(); }
});

await test("auth and request contract: no token 401, no CSRF header 403, non-JSON 403, wrong channel 400, bad input 400, no verified release 503 — and nothing created", async () => {
  const f = await fixture();
  try {
    const url = `${f.h.origin}/admin/api/hosting/complimentary`;
    assert.equal((await jsonReq(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(grant()) })).status, 401);
    assert.equal((await jsonReq(url, { method: "POST", headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json" }, body: JSON.stringify(grant()) })).status, 403);
    assert.equal((await jsonReq(url, { method: "POST", headers: { "x-hub-admin": "test-admin-token", "x-hub-csrf": "marketplace-config-v1", "content-type": "text/plain" }, body: JSON.stringify(grant()) })).status, 403);
    assert.equal((await f.admin("/admin/api/hosting/complimentary", grant(), { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await f.admin("/admin/api/hosting/complimentary", grant({ channel: "production" }))).status, 400);
    assert.equal((await f.admin("/admin/api/hosting/complimentary", grant({ channel: undefined }))).status, 400);
    assert.equal((await f.admin("/admin/api/hosting/complimentary", grant({ email: "not-an-email" }))).status, 400);
    assert.equal((await f.admin("/admin/api/hosting/complimentary", grant({ reason: "  " }))).status, 400);
    assert.equal((await f.admin("/admin/api/hosting/complimentary", grant({ idempotencyKey: "short" }))).status, 400);
    assert.equal((await f.admin("/admin/api/hosting/complimentary", grant({ months: 0 }))).status, 400);
    assert.equal((await f.admin("/admin/api/hosting/complimentary", grant({ region: "ewr" }))).status, 400);
    assert.equal((await f.admin("/admin/api/hosting/complimentary", grant({ plan: "vc2-99c-1tb" }))).status, 409);
    const end = await jsonReq(`${f.h.origin}/admin/api/hosting/instances/host_x/end-complimentary`, { method: "POST", headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json" }, body: JSON.stringify({ reason: "x" }) });
    assert.equal(end.status, 403);
    assert.equal(f.hosting.store.instances().length, 0);
    assert.equal(f.billing.store.getCustomer(OWNER), null);
    assert.equal(f.mails().length, 0);
  } finally { await f.h.close(); }
  const g = await fixture({ noRelease: true });
  try {
    const r = await g.admin("/admin/api/hosting/complimentary", grant());
    assert.equal(r.status, 503);
    assert.equal(g.hosting.store.instances().length, 0);
  } finally { await g.h.close(); }
  const p = await fixture({ policy: { provisioningEnabled: false } });
  try {
    const r = await p.admin("/admin/api/hosting/complimentary", grant());
    assert.equal(r.status, 409); assert.match(r.body.error, /master switch/);
    assert.equal(p.hosting.store.instances().length, 0);
  } finally { await p.h.close(); }
});

await test("the cost ceiling applies to a grant exactly as at checkout", async () => {
  const f = await fixture({ policy: { maximumProjectedMonthlyProviderCostCents: 1000 } });
  try {
    const r = await f.admin("/admin/api/hosting/complimentary", grant());
    assert.equal(r.status, 409); assert.match(r.body.error, /cost ceiling/);
    assert.equal(f.hosting.store.instances().length, 0);
  } finally { await f.h.close(); }
});

await test("end: the ordinary intentional-cancellation schedule — suspended now, deleted after retention, ordinary notices to the address, no Stripe call; a repeat is inert", async () => {
  const f = await fixture();
  try {
    const r = await f.admin("/admin/api/hosting/complimentary", grant());
    const id = r.body.instanceId;
    await bringReady(f, id);
    const before = f.mails().length;
    const noReason = await f.admin(`/admin/api/hosting/instances/${id}/end-complimentary`, { by: "ops" });
    assert.equal(noReason.status, 400);
    const end = await f.admin(`/admin/api/hosting/instances/${id}/end-complimentary`, { by: "ops", reason: "test finished" });
    assert.equal(end.status, 200, JSON.stringify(end.body));
    assert.equal(end.body.changed, true); assert.equal(end.body.stage, "cancel_scheduled");
    assert.equal(end.body.suspendAtMs, f.now());
    assert.equal(end.body.deleteAtMs, f.now() + 168 * HOUR);
    const again = await f.admin(`/admin/api/hosting/instances/${id}/end-complimentary`, { by: "ops", reason: "again" });
    assert.equal(again.status, 200); assert.equal(again.body.changed, false);
    assert.ok(f.billing.events(50).some((e) => e.type === "admin.hosting.complimentary.end"));
    await f.tick();
    assert.equal(f.hosting.store.getInstance(id).stage, "suspended");
    const powered = await f.provider.getInstance(f.hosting.store.getInstance(id).providerInstanceId);
    assert.notEqual(powered.status, "active");
    for (let i = 0; i < 8; i++) { f.advance(DAY); await f.tick(); }
    await f.tick();
    const gone = f.hosting.store.getInstance(id);
    assert.equal(gone.stage, "deleted");
    const subjects = f.mails().slice(before).map((m) => m.subject);
    assert.ok(f.mails().slice(before).every((m) => m.to[0] === NORMALIZED));
    const endMail = f.mails().slice(before).find((m) => /will end/.test(m.subject));
    assert.match(endMail.subject, /^Your complimentary server will end on /);
    assert.match(endMail.text, /Your complimentary Wick Hunter server \(host_[^)]+\) will end on /);
    for (const word of [/cancel/i, /software licen[cs]e/i, /Manage hosting/i, /subscription/i, /renew/i]) { assert.doesNotMatch(endMail.text, word); assert.doesNotMatch(endMail.html, word); }
    assert.deepEqual(subjects.map((s) => /will end/.test(s) ? "end" : /terminated/.test(s) ? "terminated" : s), ["end", "terminated"],
      "the end notice and the termination notice only — no payment-requesting suspended/countdown notice for a server nobody pays for");
    assert.match(f.mails().at(-1).text, /complimentary server; no hosting payment was taken/);
    assert.equal(f.stripeCalls().length, 0);
    // A fresh grant is possible once the old server is gone; the still-valid
    // licence is reused.
    const next = await f.admin("/admin/api/hosting/complimentary", grant({ idempotencyKey: "comp-fixture-key-0003" }));
    assert.equal(next.status, 200, JSON.stringify(next.body)); assert.equal(next.body.created, true); assert.equal(next.body.reusedLicense, true); assert.equal(next.body.licenseId, r.body.licenseId);
    // The old key still names the old (deleted) server rather than creating a third.
    const replay = await f.admin("/admin/api/hosting/complimentary", grant({ idempotencyKey: "comp-fixture-key-0003" }));
    assert.equal(replay.body.created, false); assert.equal(replay.body.instanceId, next.body.instanceId);
    // end-complimentary refuses a paid-style row
    const notComp = await f.admin(`/admin/api/hosting/instances/host_missing/end-complimentary`, { reason: "x" });
    assert.equal(notComp.status, 404);
  } finally { await f.h.close(); }
});

await test("a fixed term ends itself at its end date through the same schedule; the licence covers exactly the term", async () => {
  const f = await fixture();
  try {
    const r = await f.admin("/admin/api/hosting/complimentary", grant({ months: 1 }));
    const endsAt = addUtcMonths(f.now(), 1);
    assert.equal(r.body.endsAtMs, endsAt);
    assert.equal(f.h.store.get(r.body.licenseId).exp, endsAt);
    const id = r.body.instanceId;
    await bringReady(f, id);
    f.advance(endsAt - f.now() - HOUR); await f.tick();
    assert.equal(f.hosting.store.getInstance(id).stage, "ready");
    f.advance(2 * HOUR); await f.tick();
    const row = f.hosting.store.getInstance(id);
    assert.equal(row.cancellationReason, "intentional_cancellation");
    assert.equal(row.suspendAtMs, endsAt);
    assert.equal(f.stripeCalls().length, 0);
    assert.equal(addUtcMonths(Date.parse("2027-01-31T10:00:00Z"), 1), Date.parse("2027-02-28T10:00:00Z"));
  } finally { await f.h.close(); }
});

await test("customer card: complimentary, no cancel route; the customer cancel API refuses without touching Stripe", async () => {
  const f = await fixture();
  try {
    const r = await f.admin("/admin/api/hosting/complimentary", grant());
    const view = f.hosting.customerView(OWNER, f.now());
    assert.equal(view.instance.complimentary, true);
    const c = await f.hosting.cancel(OWNER, r.body.instanceId, f.now());
    assert.equal(c.ok, false); assert.equal(c.code, "NOT_CANCELLABLE");
    assert.equal(f.stripeCalls().length, 0);
  } finally { await f.h.close(); }
});

await test("paying customers are unaffected: a paid checkout from the SAME email gets its own customer record, and its hosting reconcile is unchanged", async () => {
  const f = await fixture();
  try {
    const comp = await f.admin("/admin/api/hosting/complimentary", grant());
    const compLicense = f.billing.store.getCustomer(OWNER).licenseId;
    assert.equal(await f.postEvent("checkout.session.completed", { id: "cs_sw_paid", mode: "subscription", payment_status: "paid", customer: "cus_paid", customer_details: { email: NORMALIZED }, subscription: "sub_sw_paid", metadata: { plan: "monthly" } }), 200);
    const paid = f.billing.store.getCustomer("cus_paid");
    assert.ok(paid, "the paid checkout created its own record, not an adoption of the complimentary one");
    assert.notEqual(paid.licenseId, compLicense);
    assert.equal(f.billing.store.getCustomer(OWNER).licenseId, compLicense);
    const checkout = await f.hosting.checkoutUrl("cus_paid", NORMALIZED, f.now());
    assert.equal(checkout.ok, true, JSON.stringify(checkout));
    assert.equal(await f.postEvent("checkout.session.completed", { id: "cs_host_paid", mode: "subscription", payment_status: "paid", customer: "cus_paid", customer_details: { email: NORMALIZED }, subscription: "sub_host_paid", metadata: { plan: "hosting-monthly" } }), 200);
    const paidRow = f.hosting.store.instances().find((r) => r.ownerId === "cus_paid");
    assert.ok(paidRow && !paidRow.complimentary);
    assert.equal(f.hosting.store.instances().filter((r) => r.ownerId === OWNER).length, 1);
    // The paid owner's nonpayment still derives the ordinary past_due schedule.
    assert.equal(await f.postEvent("customer.subscription.updated", { id: "sub_host_paid", object: "subscription", customer: "cus_paid", status: "past_due", items: { data: [{ price: { id: "price_host1" } }] }, current_period_end: Math.floor((f.now() + 5 * DAY) / 1000), metadata: { plan: "hosting-monthly" } }), 200);
    f.hosting.reconcileAll(f.now());
    const role = f.billing.store.getRoleSubscription("cus_paid", "hosting");
    assert.equal(role.subscriptionStatus, "past_due");
    assert.equal(f.hosting.store.getInstance(paidRow.id).stage, "past_due", "the ordinary nonpayment schedule still applies to a paying owner");
    assert.equal(f.hosting.store.getInstance(comp.body.instanceId).stage, "ordered", "the grant is untouched by the paid owner's events");
  } finally { await f.h.close(); }
});

await test("S2: only the server a grant created is ever started by it — a legacy record or a grant naming another instance never queues provisioning", async () => {
  const f = await fixture();
  try {
    const legacyOwner = "admin-vps-test:20261005-s2";
    f.billing.store.putRoleSubscription({ key: `${legacyOwner}::hosting`, customerKey: legacyOwner, role: "hosting", livemode: false, subscriptionId: null, subscriptionStatus: "active", periodEndMs: null, chargeIds: [], disputed: false, refunded: false,
      createdAtMs: f.now(), updatedAtMs: f.now(), lastEventType: "admin.complimentary_vps_test", lastEventAtMs: f.now(),
      complimentary: { by: "migration-0.4.104", reason: "legacy", createdAtMs: f.now(), idempotencyKey: null, instanceId: null, endsAtMs: null, endedAtMs: null, endedBy: null, endReason: null, legacy: true } });
    const stray = f.hosting.store.reserveInstance({ id: "host_legacy_stray", ownerId: legacyOwner, environment: "test", region: "nrt", planId: "vc2-2c-2gb", stripeCustomerId: "", nowMs: f.now() });
    // A real grant, then a second ordered row slipped under the same owner.
    const r = await f.admin("/admin/api/hosting/complimentary", grant());
    const granted = f.hosting.store.getInstance(r.body.instanceId);
    for (const job of f.hosting.store.outboxFor(granted.id)) assert.equal(job.jobType, "provision");
    f.hosting.store.updateInstance(granted.id, granted.version, (d) => { d.stage = "deleted"; d.lifecycleVersion += 1; }, f.now());
    const other = f.hosting.store.reserveInstance({ id: "host_not_the_grant", ownerId: OWNER, environment: "test", region: "nrt", planId: "vc2-2c-2gb", stripeCustomerId: "", nowMs: f.now() });
    for (let i = 0; i < 3; i++) { f.hosting.reconcileAll(f.now()); await f.tick(); f.advance(30_000); }
    assert.equal(f.hosting.store.outboxFor(stray.id).length, 0, "the legacy record started nothing");
    assert.equal(f.hosting.store.outboxFor(other.id).length, 0, "a row the grant did not create is never provisioned by it");
    assert.equal(f.hosting.store.getInstance(stray.id).stage, "ordered"); assert.equal(f.hosting.store.getInstance(other.id).stage, "ordered");
    assert.equal(f.provider.createCalls.length, 0);
  } finally { await f.h.close(); }
});

await test("S1: the grant's role record is written only after the reservation exists; a failed write closes the reservation and nothing is provisioned", async () => {
  const f = await fixture();
  try {
    const store = f.billing.store, original = store.putRoleSubscription.bind(store);
    let seenRowAtWrite = null;
    store.putRoleSubscription = (rec) => { if (rec.complimentary) seenRowAtWrite = rec.complimentary.instanceId ? f.hosting.store.getInstance(rec.complimentary.instanceId) : null; return original(rec); };
    const ok = await f.admin("/admin/api/hosting/complimentary", grant());
    assert.equal(ok.status, 200);
    assert.ok(seenRowAtWrite && seenRowAtWrite.id === ok.body.instanceId && seenRowAtWrite.complimentary === true, "the reservation existed (and was marked) before the grant named it");
    await f.admin(`/admin/api/hosting/instances/${ok.body.instanceId}/end-complimentary`, { reason: "next case" });
    f.hosting.store.updateInstance(ok.body.instanceId, f.hosting.store.getInstance(ok.body.instanceId).version, (d) => { d.stage = "deleted"; }, f.now());
    store.putRoleSubscription = (rec) => { if (rec.complimentary && rec.complimentary.idempotencyKey === "comp-fixture-key-fail") throw new Error("disk full (fixture)"); return original(rec); };
    const bad = await f.admin("/admin/api/hosting/complimentary", grant({ idempotencyKey: "comp-fixture-key-fail" }));
    assert.equal(bad.status, 409); assert.match(bad.body.error, /reservation was closed/);
    const rows = f.hosting.store.instances().filter((r) => r.ownerId === OWNER && r.id !== ok.body.instanceId);
    assert.equal(rows.length, 1); assert.equal(rows[0].stage, "deleted");
    assert.equal(f.hosting.store.outboxFor(rows[0].id).length, 0, "no provision job for the closed reservation");
    assert.notEqual(f.billing.store.getRoleSubscription(OWNER, "hosting").complimentary.instanceId, rows[0].id, "no grant names the closed reservation");
    for (let i = 0; i < 3; i++) { await f.tick(); f.advance(30_000); }
    assert.equal(f.provider.createCalls.length, 0);
  } finally { await f.h.close(); }
});

await test("one-shot migration: the hand-written 2026-10-05 test records are marked complimentary (legacy); reconcile is silent and changes nothing; a later paid checkout from that email is not merged into it", async () => {
  const { dataDir } = freshStore();
  const T = Date.parse("2026-10-05T12:00:00Z");
  const owner = "admin-vps-test:20261005-fixture";
  fs.writeFileSync(path.join(dataDir, "billing-role-subscriptions.v1.json"), JSON.stringify({ [`${owner}::hosting`]: { key: `${owner}::hosting`, customerKey: owner, role: "hosting", livemode: true, subscriptionId: null, subscriptionStatus: "active", periodEndMs: null, chargeIds: [], disputed: false, refunded: false, createdAtMs: T, updatedAtMs: T, lastEventType: "admin.complimentary_vps_test", lastEventAtMs: T },
    "cus_other::hosting": { key: "cus_other::hosting", customerKey: "cus_other", role: "hosting", livemode: true, subscriptionId: "sub_other", subscriptionStatus: "active", periodEndMs: T + 30 * DAY, chargeIds: [], disputed: false, refunded: false, createdAtMs: T, updatedAtMs: T, lastEventType: "invoice.paid", lastEventAtMs: T } }));
  fs.writeFileSync(path.join(dataDir, "billing-customers.v1.json"), JSON.stringify({ [owner]: { key: owner, stripeCustomerId: "", email: "ops@example.test", name: "ops", livemode: true, licenseId: "lic_fixture", planKey: null, subscriptionId: null, subscriptionStatus: "active", periodEndMs: null, chargeIds: [], createdAtMs: T, updatedAtMs: T, welcomeSentAtMs: null, welcomeError: null, disputed: false, refunded: false, lastEventType: "admin.complimentary_vps_test", lastEventAtMs: T } }));
  const f = await fixture({ cfg: { dataDir } });
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, COMPLIMENTARY_MIGRATION_MARKER_FILE), "utf8"));
    assert.deepEqual(marker.marked, [owner]);
    const role = f.billing.store.getRoleSubscription(owner, "hosting");
    assert.equal(role.complimentary.legacy, true); assert.equal(role.complimentary.endedAtMs, null);
    assert.equal(role.subscriptionStatus, "active"); assert.equal(role.periodEndMs, null, "no date or status rewritten");
    assert.equal(f.billing.store.getRoleSubscription("cus_other", "hosting").complimentary, undefined, "a paid record is never marked");
    assert.equal(f.billing.store.getCustomer(owner).complimentary.legacy, true);
    assert.equal(f.billing.store.findByEmail("ops@example.test", true), null, "the legacy record is never adopted by email");
    for (let i = 0; i < 3; i++) { await f.tick(); f.advance(30_000); }
    assert.ok(!f.logs.some((l) => l.includes(owner)), f.logs.join("\n"));
    assert.equal(f.hosting.store.instances().filter((r) => r.ownerId === owner).length, 0);
    // Marker-guarded: a second boot over the same data (e.g. after a hand
    // edit) does not re-run.
    const roles = path.join(dataDir, "billing-role-subscriptions.v1.json");
    const all = JSON.parse(fs.readFileSync(roles, "utf8"));
    delete all[`${owner}::hosting`].complimentary;
    fs.writeFileSync(roles, JSON.stringify(all));
    const again = createHub(f.h.cfg, { candleSleep: async () => {} });
    assert.equal(again.billing.store.getRoleSubscription(owner, "hosting").complimentary, undefined);
  } finally { await f.h.close(); }
});

summary("hosting-complimentary");
