// tests/billing.test.mjs — Stripe -> licence -> install page, end to end over
// real HTTP on loopback. Stripe is replaced by signed JSON we post ourselves;
// the email provider and the Customer Portal call are an injected fetch that
// records what it was asked to send. Nothing leaves 127.0.0.1.
import assert from "node:assert/strict";
import { createHash, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { releaseSigningBytes } from "../dist/src/release-manifest.js";
import { signStripePayload, verifyStripeSignature, invoiceFacts } from "../dist/src/billing/stripe.js";
import { applyBillingPatch, defaultBillingConfig, BillingConfigError } from "../dist/src/billing/config.js";
import { renderTemplate } from "../dist/src/billing/service.js";

const DAY = 86_400_000;
const TEST_WHSEC = "whsec_test_0123456789abcdef";
const LIVE_WHSEC = "whsec_live_fedcba9876543210";

// ── a recording fetch: email provider + Stripe portal ───────────────────────
const calls = [];
let emailFail = false;
const fakeFetch = async (url, init) => {
  calls.push({ url, init });
  if (url.startsWith("https://api.stripe.com/v1/billing_portal/sessions")) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ url: "https://billing.stripe.com/p/session/test_abc" }) };
  }
  if (emailFail) return { ok: false, status: 422, text: async () => JSON.stringify({ message: "domain is not verified" }) };
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: `em_${calls.length}` }) };
};
const emailCalls = () => calls.filter((c) => c.url.includes("resend.com") || c.url.includes("postmarkapp.com"));
const lastEmail = () => JSON.parse(emailCalls().at(-1).init.body);

// Whole seconds: Stripe timestamps are seconds, and a sub-second clock would
// make "period end + grace" differ from `clock + N days` by the remainder.
let clock = Math.floor(Date.now() / 1000) * 1000;
const h = await freshHub({}, { billingFetch: fakeFetch, billingNow: () => clock });
const AUTH = { "x-hub-admin": "test-admin-token", "content-type": "application/json" };
const admin = (p, opts = {}) => jsonReq(`${h.origin}${p}`, { ...opts, headers: { ...AUTH, ...(opts.headers ?? {}) } });

// Publish a release so the installer can be served (same recipe as server.test.mjs).
const tarball = Buffer.from("not really gzip but the hub does not care\n");
const relName = "wickhunter-beta-0.90.0.tar.gz";
fs.writeFileSync(path.join(h.releasesDir, relName), tarball);
const unsignedRelease = {
  schema: "wickhunter.release.v1", product: "wickhunter", channel: "beta", platform: "linux", arch: "x64",
  version: "0.90.0", buildId: "test-build-009000", file: relName,
  sha256: createHash("sha256").update(tarball).digest("hex"), issuedAt: new Date().toISOString(), minUpdateProtocol: 1,
};
fs.writeFileSync(path.join(h.releasesDir, "latest.json"), JSON.stringify({
  ...unsignedRelease,
  signatures: [{ kid: h.releaseSigner.kid, alg: "Ed25519", sig: edSign(null, releaseSigningBytes(unsignedRelease), h.releaseSigner.privateKey).toString("base64url") }],
}));

// ── Stripe event factories ──────────────────────────────────────────────────
let evSeq = 0;
const sec = () => Math.floor(clock / 1000);
const event = (type, object, livemode = false, id = `evt_${++evSeq}`) => ({ id, object: "event", type, livemode, created: sec(), data: { object } });
const checkoutSession = (over = {}) => ({
  id: "cs_1", object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
  customer: "cus_A", customer_details: { email: "ada@example.com", name: "Ada Lovelace" }, subscription: "sub_A",
  payment_intent: null, metadata: {}, ...over,
});
const invoice = (over = {}) => ({
  id: "in_1", object: "invoice", customer: "cus_A", customer_email: "ada@example.com", customer_name: "Ada Lovelace",
  subscription: "sub_A", charge: "ch_A1", payment_intent: "pi_A1", paid: true, status: "paid", billing_reason: "subscription_create",
  lines: { data: [{ period: { start: sec(), end: sec() + 30 * 86_400 } }] }, ...over,
});
async function postEvent(mode, ev, secret = mode === "live" ? LIVE_WHSEC : TEST_WHSEC, ts = sec()) {
  const body = JSON.stringify(ev);
  const res = await fetch(`${h.origin}/api/billing/stripe/${mode}`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, secret, ts) },
    body,
  });
  return { status: res.status, body: await res.json() };
}
const licenses = () => h.store.list();
const pageTokenFromEmail = () => /\/welcome\/([A-Za-z0-9_-]+)/.exec(lastEmail().text)[1];

// ── pure pieces ─────────────────────────────────────────────────────────────

await test("signature: exact bytes, any v1 entry, bounded clock skew", () => {
  const body = Buffer.from('{"id":"evt_x","object":"event"}');
  const ts = 1_700_000_000;
  const header = signStripePayload(body, "whsec_k", ts);
  assert.equal(verifyStripeSignature(body, header, "whsec_k", ts * 1000 + 10_000).ok, true);
  assert.deepEqual(verifyStripeSignature(body, header, "whsec_other", ts * 1000), { ok: false, reason: "mismatch" });
  assert.deepEqual(verifyStripeSignature(Buffer.from(body.toString() + " "), header, "whsec_k", ts * 1000), { ok: false, reason: "mismatch" });
  assert.deepEqual(verifyStripeSignature(body, header, "whsec_k", ts * 1000 + 6 * 60_000), { ok: false, reason: "expired" });
  assert.deepEqual(verifyStripeSignature(body, undefined, "whsec_k", ts * 1000), { ok: false, reason: "missing" });
  assert.deepEqual(verifyStripeSignature(body, "t=abc,v1=zz", "whsec_k", ts * 1000), { ok: false, reason: "malformed" });
  // A rotation header carries two v1 entries; the second may be the good one.
  const rotated = `t=${ts},v1=${"0".repeat(64)},${header.split(",")[1]}`;
  assert.equal(verifyStripeSignature(body, rotated, "whsec_k", ts * 1000).ok, true);
});

await test("config patch: prefixes are checked per mode, secrets are write-only, '' keeps and null clears", () => {
  const base = defaultBillingConfig();
  assert.throws(() => applyBillingPatch(base, { stripe: { test: { secretKey: "sk_live_nope" } } }), BillingConfigError);
  assert.throws(() => applyBillingPatch(base, { stripe: { live: { publishableKey: "pk_test_nope" } } }), BillingConfigError);
  assert.throws(() => applyBillingPatch(base, { mode: "prod" }), BillingConfigError);
  assert.throws(() => applyBillingPatch(base, { policy: { graceDays: 500 } }), BillingConfigError);
  assert.throws(() => applyBillingPatch(base, { siteOrigin: "http://insecure.example" }), BillingConfigError);
  const a = applyBillingPatch(base, { stripe: { test: { secretKey: "sk_test_abc123", webhookSecret: "whsec_x" } } }, 5);
  assert.equal(a.stripe.test.secretKey, "sk_test_abc123");
  assert.equal(a.updatedAtMs, 5);
  const b = applyBillingPatch(a, { stripe: { test: { secretKey: "", paymentLinkUrl: "https://buy.stripe.com/test_1" } } });
  assert.equal(b.stripe.test.secretKey, "sk_test_abc123", "empty string leaves a secret unchanged");
  assert.equal(b.stripe.test.paymentLinkUrl, "https://buy.stripe.com/test_1");
  const c = applyBillingPatch(b, { stripe: { test: { secretKey: null } } });
  assert.equal(c.stripe.test.secretKey, "", "null clears");
  assert.equal(c.stripe.test.webhookSecret, "whsec_x", "untouched fields survive");
});

await test("invoice facts: paid-through is the latest line period end; subscription id is read from both API shapes", () => {
  const old = invoiceFacts({ id: "in_x", customer: "cus_x", subscription: "sub_old", paid: true, lines: { data: [{ period: { end: 100 } }, { period: { end: 250 } }] } });
  assert.equal(old.periodEndMs, 250_000);
  assert.equal(old.subscriptionId, "sub_old");
  const basil = invoiceFacts({ id: "in_y", customer: { id: "cus_y" }, parent: { subscription_details: { subscription: "sub_new" } }, status: "paid", lines: { data: [] } });
  assert.equal(basil.customerId, "cus_y");
  assert.equal(basil.subscriptionId, "sub_new");
  assert.equal(basil.periodEndMs, null);
  assert.equal(basil.paid, true);
});

await test("template: values are escaped, blocks toggle", () => {
  const out = renderTemplate("<b>{{name}}</b>{{#if on}} yes{{/if}}{{#if off}} no{{/if}}", { name: "<Ada & co>" }, { on: true, off: false });
  assert.equal(out, "<b>&lt;Ada &amp; co&gt;</b> yes");
});

// ── admin configuration ─────────────────────────────────────────────────────

await test("admin billing config needs the admin header and starts unconfigured in TEST mode", async () => {
  assert.equal((await jsonReq(`${h.origin}/admin/api/billing/config`)).status, 401);
  const r = await admin("/admin/api/billing/config");
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "test");
  assert.deepEqual(r.body.ready, { stripeTest: false, stripeLive: false, email: false, release: true });
  assert.equal(r.body.endpoints.webhookTest, "https://hub.test/hub/api/billing/stripe/test");
  assert.equal(r.body.endpoints.buy, "https://hub.test/hub/buy");
  assert.deepEqual(r.body.stripe.test.secretKey, { configured: false, last4: null });
});

await test("/buy answers 503 until a Payment Link exists, then 302s to the ACTIVE mode's link", async () => {
  const before = await fetch(`${h.origin}/buy`, { redirect: "manual" });
  assert.equal(before.status, 503);
  const r = await admin("/admin/api/billing/config", {
    method: "POST",
    body: JSON.stringify({
      stripe: { test: { publishableKey: "pk_test_pub111", secretKey: "sk_test_sec222", webhookSecret: TEST_WHSEC, paymentLinkUrl: "https://buy.stripe.com/test_link", portalUrl: "https://billing.stripe.com/p/login/test_login" } },
      email: { provider: "resend", apiKey: "re_1234567890", from: "Wick Hunter <hello@wickhunterunleashed.com>", replyTo: "admin@wickhunterunleashed.com" },
      siteOrigin: "https://wickhunterunleashed.com",
    }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.stripe.test.publishableKey, "pk_test_pub111", "the publishable key is public and echoed");
  assert.deepEqual(r.body.stripe.test.secretKey, { configured: true, last4: "c222" });
  assert.deepEqual(r.body.stripe.test.webhookSecret, { configured: true, last4: TEST_WHSEC.slice(-4) });
  assert.deepEqual(r.body.email.apiKey, { configured: true, last4: "7890" });
  assert.ok(!JSON.stringify(r.body).includes("sk_test_sec222"), "the secret never comes back");
  assert.deepEqual(r.body.ready, { stripeTest: true, stripeLive: false, email: true, release: true });
  const after = await fetch(`${h.origin}/buy`, { redirect: "manual" });
  assert.equal(after.status, 302);
  assert.equal(after.headers.get("location"), "https://buy.stripe.com/test_link");
  const billing = await fetch(`${h.origin}/billing`, { redirect: "manual" });
  assert.equal(billing.headers.get("location"), "https://billing.stripe.com/p/login/test_login");
  const bad = await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ stripe: { test: { webhookSecret: "nope" } } }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /whsec_/);
});

// ── the webhook, test mode ──────────────────────────────────────────────────

let licenseA, tokenA_v1, pageTokenA, acceptedCheckout;

await test("webhook: unsigned and wrongly signed events are refused and recorded", async () => {
  const bare = await fetch(`${h.origin}/api/billing/stripe/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event("checkout.session.completed", checkoutSession())) });
  assert.equal(bare.status, 400);
  const wrong = await postEvent("test", event("checkout.session.completed", checkoutSession()), "whsec_wrong");
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /mismatch/);
  assert.equal(licenses().length, 0, "nothing was minted");
  const live = await postEvent("live", event("checkout.session.completed", checkoutSession(), true));
  assert.equal(live.status, 503, "the live endpoint has no secret yet");
});

await test("checkout.session.completed (test) mints a bootstrap licence and emails the install page", async () => {
  acceptedCheckout = event("checkout.session.completed", checkoutSession());
  const r = await postEvent("test", acceptedCheckout);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, "applied");
  const all = licenses();
  assert.equal(all.length, 1);
  licenseA = all[0];
  assert.equal(licenseA.name, "Ada Lovelace");
  assert.equal(licenseA.plan, "unleashed-test");
  assert.equal(licenseA.exp, clock + 3 * DAY, "bootstrap expiry until invoice.paid arrives");
  assert.equal(emailCalls().length, 1);
  const mail = lastEmail();
  assert.deepEqual(mail.to, ["ada@example.com"]);
  assert.equal(mail.from, "Wick Hunter <hello@wickhunterunleashed.com>");
  assert.equal(mail.reply_to, "admin@wickhunterunleashed.com");
  assert.match(mail.subject, /^\[TEST\] /);
  assert.match(mail.text, /https:\/\/hub\.test\/hub\/welcome\/[A-Za-z0-9_-]{40,}/);
  assert.ok(!mail.text.includes("LHK1."), "the licence key itself is never emailed");
  pageTokenA = pageTokenFromEmail();
  tokenA_v1 = h.store.tokenFor(licenseA.id);
});

await test("the same event id again is a duplicate and mints nothing", async () => {
  const r = await postEvent("test", acceptedCheckout);
  assert.equal(r.body.outcome, "duplicate");
  assert.equal(licenses().length, 1);
  assert.equal(emailCalls().length, 1);
});

await test("invoice.paid extends the licence to period end + grace, capped for a TEST licence", async () => {
  const r = await postEvent("test", event("invoice.paid", invoice()));
  assert.equal(r.body.outcome, "applied");
  const lic = licenses().find((l) => l.id === licenseA.id);
  // 30 days + 7 grace would be 37; test licences are capped at 14 from creation.
  assert.equal(lic.exp, clock + 14 * DAY);
  assert.equal(emailCalls().length, 1, "the welcome is sent once, not per event");
});

await test("a running bot presenting its OLD key gets the extended one at check-in (v0.3.19 path)", async () => {
  const r = await jsonReq(`${h.origin}/api/license/checkin`, {
    method: "POST",
    body: JSON.stringify({ licenseId: licenseA.id, installId: "inst-A", version: "0.90.6", ts: Date.now(), token: tokenA_v1 }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.revoked, undefined);
  assert.ok(r.body.token, "a re-minted key rides the reply");
  assert.equal(r.body.exp, clock + 14 * DAY);
  const v = h.store.verify(r.body.token);
  assert.equal(v.ok, true);
  assert.equal(v.payload.id, licenseA.id);
});

let installTokenA;
await test("the welcome page shows the licence and mints a one-time install command", async () => {
  const bad = await fetch(`${h.origin}/welcome/not-a-real-token-at-all-0000000000`);
  assert.equal(bad.status, 404);
  const res = await fetch(`${h.origin}/welcome/${pageTokenA}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  const html = await res.text();
  assert.match(html, /Hi Ada, here is your install/);
  assert.match(html, /Active/);
  assert.match(html, /unleashed-test/);
  const m = /curl -q -fsSL &quot;https:\/\/hub\.test\/hub\/install\/([A-Za-z0-9_-]+)&quot; \| sudo bash/.exec(html);
  assert.ok(m, "the page carries the one-line install command");
  installTokenA = m[1];
  assert.ok(!html.includes("LHK1."), "the page never shows the licence key");
  assert.match(html, /action="https:\/\/hub\.test\/hub\/welcome\/[A-Za-z0-9_-]+\/portal"/, "Manage billing is offered");
});

await test("/install/<token> serves the personalised installer ONCE, with the current licence key baked in", async () => {
  const res = await fetch(`${h.origin}/install/${installTokenA}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /x-shellscript/);
  const script = await res.text();
  assert.match(script, /^HUB="https:\/\/hub\.test\/hub"$/m);
  const key = /^KEY="(LHK1\.[^"]+)"$/m.exec(script);
  assert.ok(key, "the installer carries a licence key");
  assert.equal(key[1], h.store.tokenFor(licenseA.id), "it is the EXTENDED key, not the bootstrap one");
  const again = await fetch(`${h.origin}/install/${installTokenA}`);
  assert.equal(again.status, 403);
  assert.match(await again.text(), /already used/);
  const bogus = await fetch(`${h.origin}/install/definitely-not-a-token-000000000000`);
  assert.equal(bogus.status, 403);
});

await test("an expired install token is refused; a reloaded page mints a fresh one", async () => {
  const page = await (await fetch(`${h.origin}/welcome/${pageTokenA}`)).text();
  const tok = /\/install\/([A-Za-z0-9_-]+)&quot;/.exec(page)[1];
  const saved = clock;
  clock += 25 * 3_600_000; // past the 24h token life
  const res = await fetch(`${h.origin}/install/${tok}`);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /expired/);
  clock = saved;
});

await test("Manage billing opens a Customer Portal session through the secret key", async () => {
  const res = await fetch(`${h.origin}/welcome/${pageTokenA}/portal`, { method: "POST", redirect: "manual" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://billing.stripe.com/p/session/test_abc");
  const call = calls.find((c) => c.url.startsWith("https://api.stripe.com/v1/billing_portal/sessions"));
  assert.ok(call);
  assert.equal(call.init.headers.authorization, "Bearer sk_test_sec222");
  assert.match(call.init.body, /customer=cus_A/);
  assert.match(call.init.body, /return_url=https%3A%2F%2Fhub\.test%2Fhub%2Fwelcome%2F/);
});

// ── live mode ───────────────────────────────────────────────────────────────

let licenseB, pageTokenB, licenseC;

await test("switching to LIVE: test events are ignored, live events are honoured with real plan and full grace", async () => {
  const r = await admin("/admin/api/billing/config", {
    method: "POST",
    body: JSON.stringify({ mode: "live", stripe: { live: { publishableKey: "pk_live_pub", secretKey: "sk_live_sec", webhookSecret: LIVE_WHSEC, paymentLinkUrl: "https://buy.stripe.com/live_link" } } }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, "live");
  assert.equal((await fetch(`${h.origin}/buy`, { redirect: "manual" })).headers.get("location"), "https://buy.stripe.com/live_link");
  // A TEST event now: signature is fine, but it must not mint.
  const t = await postEvent("test", event("checkout.session.completed", checkoutSession({ id: "cs_t2", customer: "cus_T2", customer_details: { email: "t2@example.com", name: "Tester Two" } })));
  assert.equal(t.status, 200);
  assert.equal(t.body.outcome, "ignored");
  assert.equal(licenses().length, 1);
  // A LIVE event: invoice first this time (order independence), then checkout.
  const inv = await postEvent("live", event("invoice.paid", invoice({ id: "in_B1", customer: "cus_B", customer_email: "bob@example.com", customer_name: "Bob Builder", subscription: "sub_B", charge: "ch_B1", payment_intent: "pi_B1" }), true));
  assert.equal(inv.body.outcome, "applied", JSON.stringify(inv.body));
  licenseB = licenses().find((l) => l.name === "Bob Builder");
  assert.ok(licenseB);
  assert.equal(licenseB.plan, "unleashed");
  assert.equal(licenseB.exp, clock + 37 * DAY, "30-day period + 7 grace, no test cap");
  assert.equal(emailCalls().length, 2, "the welcome went out on the first event that created the licence");
  assert.doesNotMatch(lastEmail().subject, /TEST/);
  pageTokenB = pageTokenFromEmail();
  const co = await postEvent("live", event("checkout.session.completed", checkoutSession({ id: "cs_B", customer: "cus_B", customer_details: { email: "bob@example.com", name: "Bob Builder" }, subscription: "sub_B" }), true));
  assert.equal(co.body.outcome, "applied");
  assert.equal(licenses().length, 2, "checkout after invoice does not mint a second licence");
  assert.equal(emailCalls().length, 2, "and does not email twice");
});

await test("a one-time purchase with no Stripe customer is keyed by email and gets the metadata's licence length", async () => {
  const r = await postEvent("live", event("checkout.session.completed", checkoutSession({
    id: "cs_C", mode: "payment", customer: null, subscription: null, payment_intent: "pi_C1",
    customer_details: { email: "Cara@Example.com", name: "Cara Once" }, metadata: { license_days: "30" },
  }), true));
  assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
  licenseC = licenses().find((l) => l.name === "Cara Once");
  assert.equal(licenseC.exp, clock + 30 * DAY);
  const customers = (await admin("/admin/api/billing/customers")).body.customers;
  const c = customers.find((x) => x.licenseId === licenseC.id);
  assert.equal(c.customerId, "email:cara@example.com");
  assert.equal(c.email, "cara@example.com");
  assert.equal(c.subscriptionId, null);
  assert.match(lastEmail().text, /Your licence is active until/);
  assert.doesNotMatch(lastEmail().text, /extends automatically/);
});

await test("a chargeback revokes the licence, the install page says so, and outstanding commands die", async () => {
  // Stripe names only the charge on a dispute; the Hub learned it from the invoice.
  const page = await (await fetch(`${h.origin}/welcome/${pageTokenB}`)).text();
  const openTok = /\/install\/([A-Za-z0-9_-]+)&quot;/.exec(page)[1];
  const r = await postEvent("live", event("charge.dispute.created", { id: "dp_1", object: "dispute", charge: "ch_B1", payment_intent: "pi_B1", reason: "fraudulent", status: "needs_response" }, true));
  assert.equal(r.body.outcome, "applied");
  assert.equal(licenses().find((l) => l.id === licenseB.id).revoked, true);
  const checkin = await jsonReq(`${h.origin}/api/license/checkin`, { method: "POST", body: JSON.stringify({ licenseId: licenseB.id, installId: "inst-B", version: "0.90.6", ts: Date.now() }) });
  assert.equal(checkin.body.revoked, true, "the bot learns at its next check-in");
  const after = await (await fetch(`${h.origin}/welcome/${pageTokenB}`)).text();
  assert.match(after, /Revoked/);
  assert.ok(!after.includes("/install/"), "no install command on a revoked licence");
  const dead = await fetch(`${h.origin}/install/${openTok}`);
  assert.equal(dead.status, 403);
  const row = (await admin("/admin/api/billing/customers")).body.customers.find((x) => x.licenseId === licenseB.id);
  assert.equal(row.disputed, true);
  assert.equal(row.revoked, true);
  assert.equal(row.lastEventType, "charge.dispute.created");
});

await test("a FULL refund revokes; a partial one only records", async () => {
  const partial = await postEvent("live", event("charge.refunded", { id: "ch_C1", object: "charge", customer: null, payment_intent: "pi_C1", billing_details: { email: "cara@example.com" }, amount: 9900, amount_refunded: 1000, refunded: false }, true));
  assert.equal(partial.body.outcome, "applied");
  assert.match(partial.body.outcome, /applied/);
  assert.equal(licenses().find((l) => l.id === licenseC.id).revoked, false);
  const full = await postEvent("live", event("charge.refunded", { id: "ch_C1", object: "charge", customer: null, payment_intent: "pi_C1", billing_details: { email: "cara@example.com" }, amount: 9900, amount_refunded: 9900, refunded: true }, true));
  assert.equal(full.body.outcome, "applied");
  assert.equal(licenses().find((l) => l.id === licenseC.id).revoked, true);
});

await test("subscription lifecycle events update status without touching the expiry", async () => {
  const before = licenses().find((l) => l.id === licenseA.id).exp;
  // Back to test mode so the test customer's events count again.
  await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ mode: "test" }) });
  const upd = await postEvent("test", event("customer.subscription.updated", { id: "sub_A", object: "subscription", customer: "cus_A", status: "active", cancel_at_period_end: true, items: { data: [{ current_period_end: sec() + 30 * 86_400 }] } }));
  assert.equal(upd.body.outcome, "applied");
  const del = await postEvent("test", event("customer.subscription.deleted", { id: "sub_A", object: "subscription", customer: "cus_A", status: "canceled", ended_at: sec() }));
  assert.equal(del.body.outcome, "applied");
  const row = (await admin("/admin/api/billing/customers")).body.customers.find((x) => x.licenseId === licenseA.id);
  assert.equal(row.subscriptionStatus, "canceled");
  assert.equal(licenses().find((l) => l.id === licenseA.id).exp, before, "nothing is ever shortened; it lapses on its own");
  assert.equal(licenses().find((l) => l.id === licenseA.id).revoked, false);
  const failed = await postEvent("test", event("invoice.payment_failed", invoice({ id: "in_A9", paid: false, status: "open" })));
  assert.equal(failed.body.outcome, "applied");
  const unknown = await postEvent("test", event("customer.created", { id: "cus_Z", object: "customer" }));
  assert.equal(unknown.body.outcome, "ignored");
});

// ── admin tools ─────────────────────────────────────────────────────────────

await test("resend welcome rotates the page link; the old one stops working", async () => {
  const n = emailCalls().length;
  const r = await admin("/admin/api/billing/resend-welcome", { method: "POST", body: JSON.stringify({ customerId: "cus_A" }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sentTo, "ada@example.com");
  assert.equal(emailCalls().length, n + 1);
  const fresh = pageTokenFromEmail();
  assert.notEqual(fresh, pageTokenA);
  assert.equal((await fetch(`${h.origin}/welcome/${pageTokenA}`)).status, 404);
  assert.equal((await fetch(`${h.origin}/welcome/${fresh}`)).status, 200);
  const missing = await admin("/admin/api/billing/resend-welcome", { method: "POST", body: JSON.stringify({ customerId: "cus_nobody" }) });
  assert.equal(missing.status, 404);
});

await test("a failed email is recorded on the customer, never fails the webhook, and resend surfaces the provider's reason", async () => {
  emailFail = true;
  const r = await postEvent("test", event("checkout.session.completed", checkoutSession({ id: "cs_D", customer: "cus_D", customer_details: { email: "dee@example.com", name: "Dee" }, subscription: "sub_D" })));
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "applied");
  const row = (await admin("/admin/api/billing/customers")).body.customers.find((x) => x.customerId === "cus_D");
  assert.equal(row.welcomeSentAtMs, null);
  assert.match(row.welcomeError, /422/);
  const again = await admin("/admin/api/billing/resend-welcome", { method: "POST", body: JSON.stringify({ customerId: "cus_D" }) });
  assert.equal(again.status, 502);
  assert.match(again.body.error, /domain is not verified/);
  const t = await admin("/admin/api/billing/test-email", { method: "POST", body: JSON.stringify({ to: "me@example.com" }) });
  assert.equal(t.status, 502);
  emailFail = false;
  const ok = await admin("/admin/api/billing/test-email", { method: "POST", body: JSON.stringify({ to: "me@example.com" }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(lastEmail().to, ["me@example.com"]);
});

await test("the events ledger names every outcome, newest first", async () => {
  const r = await admin("/admin/api/billing/events?limit=50");
  assert.equal(r.status, 200);
  const outcomes = new Set(r.body.events.map((e) => e.outcome));
  for (const o of ["applied", "duplicate", "ignored", "signature"]) assert.ok(outcomes.has(o), `saw ${o}`);
  assert.ok(r.body.events[0].receivedAtMs >= r.body.events.at(-1).receivedAtMs);
  const e = r.body.events.find((x) => x.type === "charge.dispute.created");
  assert.match(e.note, /revoked/);
});

await test("licence keys and tokens are not stored in the clear", () => {
  const tokens = fs.readFileSync(path.join(h.dataDir, "billing-tokens.v1.json"), "utf8");
  assert.ok(!tokens.includes(pageTokenA), "page tokens are hashed at rest");
  assert.ok(!tokens.includes(installTokenA), "install tokens are hashed at rest");
  const cfg = fs.readFileSync(path.join(h.dataDir, "billing-config.v1.json"), "utf8");
  assert.ok(cfg.includes("sk_test_sec222"), "the config file holds the real secret (mode 0600)");
  assert.equal((fs.statSync(path.join(h.dataDir, "billing-config.v1.json")).mode & 0o777), 0o600);
});

await h.close();
summary("billing");
