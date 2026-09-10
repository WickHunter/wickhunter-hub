// tests/customer-sessions.test.mjs — the central customer dashboard (H2):
// identity, magic-link sessions, and the read-mostly dashboard JSON, driven
// over real HTTP on loopback. The email provider is an injected fetch that
// records what it was asked to send (the same recipe tests/billing.test.mjs
// uses for the welcome email) so a suite can pull the raw sign-in link out
// of the "email" without ever leaving 127.0.0.1.
import assert from "node:assert/strict";
import { createHash, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { releaseSigningBytes } from "../dist/src/release-manifest.js";
import { CustomerSessionService, normalizeCustomerEmail } from "../dist/src/customer-sessions.js";

// ── a recording fetch: the sign-in email only ───────────────────────────────
const emailCalls = [];
let emailShouldFail = false;
const fakeFetch = async (url, init) => {
  emailCalls.push({ url, init });
  if (emailShouldFail) return { ok: false, status: 422, text: async () => JSON.stringify({ message: "550 mailbox unavailable" }) };
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: `em_${emailCalls.length}` }) };
};
const lastSigninLink = () => {
  const body = JSON.parse(emailCalls.at(-1).init.body);
  const m = /\/customer\/signin\?token=([A-Za-z0-9_-]+)/.exec(body.text);
  return { to: body.to, token: m[1], url: m[0] };
};

let clock = Math.floor(Date.now() / 1000) * 1000;
const h = await freshHub({}, {
  customerSessionFetch: fakeFetch,
  customerSessionNow: () => clock,
  rateLimitNow: () => clock,
});
const AUTH = { "x-hub-admin": "test-admin-token", "content-type": "application/json" };
const admin = (p, opts = {}) => jsonReq(`${h.origin}${p}`, { ...opts, headers: { ...AUTH, ...(opts.headers ?? {}) } });

// Publish a release so an install command can be minted (same recipe as
// billing.test.mjs / server.test.mjs).
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

// A real email provider on file, so `requestSignin` actually calls `fakeFetch`
// and `lastSigninLink()` has something to read (README/H2: the sandbox
// cannot send for real; this is the "the test asserts the enqueue" half).
await admin("/admin/api/billing/config", {
  method: "POST",
  body: JSON.stringify({ email: { provider: "resend", apiKey: "re_test_1234567890", from: "Wick Hunter <hello@wickhunterunleashed.com>", replyTo: "admin@wickhunterunleashed.com" } }),
}).then((r) => assert.equal(r.status, 200));

// ── helpers ──────────────────────────────────────────────────────────────

/** A licence + a billing CustomerRecord, written directly (this suite is
 *  about identity/sessions, not the Stripe webhook — billing.test.mjs
 *  already drives that path end to end). */
function makeCustomer({ email, name = "Ada Lovelace", livemode = true, days = 30, planKey = "unleashed-monthly", createdAtMs = clock, subscriptionId = null, subscriptionStatus = null }) {
  const issued = h.store.issueUntil(name, clock + days * 86_400_000, livemode ? "unleashed" : "unleashed-test", clock);
  const key = `cus_${issued.payload.id.slice(0, 8)}`;
  h.hub.billing.store.putCustomer({
    key,
    stripeCustomerId: key,
    email: normalizeCustomerEmail(email),
    name,
    livemode,
    licenseId: issued.payload.id,
    planKey,
    subscriptionId,
    subscriptionStatus,
    periodEndMs: null,
    chargeIds: [],
    createdAtMs,
    updatedAtMs: createdAtMs,
    welcomeSentAtMs: null,
    welcomeError: null,
    disputed: false,
    refunded: false,
    lastEventType: null,
    lastEventAtMs: null,
  });
  return { key, licenseId: issued.payload.id };
}

const signinReq = (email, ip = "203.0.113.9") => fetch(`${h.origin}/api/customer/signin`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": ip },
  body: JSON.stringify({ email }),
});

async function signInAndGetCookie(email, ip = "203.0.113.10") {
  emailCalls.length = 0;
  const r = await signinReq(email, ip);
  assert.equal(r.status, 200);
  const { token } = lastSigninLink();
  const ex = await fetch(`${h.origin}/customer/signin?token=${token}`, { redirect: "manual", headers: { "x-forwarded-for": ip } });
  assert.equal(ex.status, 302);
  assert.equal(ex.headers.get("location"), "/customer");
  const setCookie = ex.headers.getSetCookie()[0];
  assert.match(setCookie, /^wh_customer_session=.+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  return setCookie.split(";")[0]; // "wh_customer_session=<raw>"
}

// ── identity: one per case-folded email, never minted from a bare body ─────

await test("no billing customer on file: signin still answers ok:true (no enumeration), but mints nothing", async () => {
  emailCalls.length = 0;
  const r = await signinReq("nobody@example.com", "198.51.100.1");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(emailCalls.length, 0, "no email is sent for an address with no billing customer");
  assert.equal(h.hub.customerSessions.store.getIdentityByEmail("nobody@example.com"), null, "no identity row was created");
});

const adaEmail = "Ada@Example.com";
// Deliberately a SHORT licence (2 days): the "lapsed licence" test below
// advances the clock past its expiry while staying well inside the
// session's own 30-day sliding window, so the two facts (licence lapsed,
// session still live) can be told apart rather than both expiring at once.
const ada = makeCustomer({ email: adaEmail, createdAtMs: clock, days: 2 });

await test("identity is one per case-folded email, whatever case it is signed in with", async () => {
  emailCalls.length = 0;
  await signinReq("Ada@Example.com", "198.51.100.2");
  const first = lastSigninLink();
  emailCalls.length = 0;
  await signinReq("ADA@EXAMPLE.COM", "198.51.100.2");
  const second = lastSigninLink();
  assert.notEqual(first.token, second.token, "each request mints its OWN token");
  const a = h.hub.customerSessions.store.getIdentityByEmail("ada@example.com");
  const b = h.hub.customerSessions.store.getIdentityByEmail("Ada@example.COM");
  assert.ok(a);
  assert.equal(a.id, b.id, "the same identity row, whatever case is used to look it up");
  assert.equal(a.email, "ada@example.com", "stored case-folded");
});

// ── sign-in issuance + rate limit (per email, and per IP) ──────────────────

await test("sign-in: the per-email bucket refuses past its max, with Retry-After, and mints nothing further", async () => {
  const email = "rate-email@example.com";
  makeCustomer({ email, createdAtMs: clock });
  let admitted = 0;
  for (let i = 0; i < 5; i++) {
    const r = await signinReq(email, "198.51.100.3");
    assert.equal(r.status, 200, `attempt ${i}`);
    admitted++;
  }
  assert.equal(admitted, 5);
  const refused = await signinReq(email, "198.51.100.3");
  assert.equal(refused.status, 429);
  const body = await refused.json();
  assert.equal(body.ok, false);
  assert.ok(body.retryAfterSeconds >= 1);
  assert.equal(refused.headers.get("retry-after"), String(body.retryAfterSeconds));
});

await test("sign-in: the per-IP bucket refuses across DIFFERENT emails from the same source", async () => {
  const tight = await freshHub(
    { rateLimits: { checkinLicenseMax: 12, checkinLicenseWindowMs: 60_000, checkinIpMax: 60, checkinIpWindowMs: 60_000, leaseLicenseMax: 6, leaseLicenseWindowMs: 60_000, leaseIpMax: 60, leaseIpWindowMs: 60_000, generalIpMax: 2, generalIpWindowMs: 60_000, webhookIpMax: 600, webhookIpWindowMs: 60_000 } },
    { customerSessionFetch: fakeFetch, customerSessionNow: () => clock, rateLimitNow: () => clock },
  );
  const post = (email) => fetch(`${tight.origin}/api/customer/signin`, {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.4" }, body: JSON.stringify({ email }),
  });
  assert.equal((await post("one@example.com")).status, 200);
  assert.equal((await post("two@example.com")).status, 200);
  const third = await post("three@example.com");
  assert.equal(third.status, 429, "the general per-IP bucket, shared with every other public route, refuses the third distinct email");
  await tight.close();
});

// ── token single-use + expiry ───────────────────────────────────────────

await test("sign-in token: single-use — the second exchange of the same token is refused", async () => {
  emailCalls.length = 0;
  await signinReq(adaEmail, "198.51.100.5");
  const { token } = lastSigninLink();
  const first = await fetch(`${h.origin}/customer/signin?token=${token}`, { redirect: "manual" });
  assert.equal(first.status, 302);
  const second = await fetch(`${h.origin}/customer/signin?token=${token}`, { redirect: "manual" });
  assert.equal(second.status, 403);
  const text = await second.text();
  assert.match(text, /already used/);
});

await test("sign-in token: expires after 15 minutes", async () => {
  emailCalls.length = 0;
  const before = clock;
  await signinReq(adaEmail, "198.51.100.6");
  const { token } = lastSigninLink();
  clock += 15 * 60_000 + 1;
  const r = await fetch(`${h.origin}/customer/signin?token=${token}`, { redirect: "manual" });
  assert.equal(r.status, 403);
  const text = await r.text();
  assert.match(text, /expired/);
  clock = before; // restore for the tests that follow
});

await test("sign-in token: an unknown token is refused, and a missing token is a plain 400", async () => {
  const unknown = await fetch(`${h.origin}/customer/signin?token=not-a-real-token-xxxxxxxxxxxxxxxxxxxx`, { redirect: "manual" });
  assert.equal(unknown.status, 403);
  const missing = await fetch(`${h.origin}/customer/signin`, { redirect: "manual" });
  assert.equal(missing.status, 400);
});

// ── the authenticated dashboard ─────────────────────────────────────────

let adaCookie;
await test("GET /customer always answers 200 — the sign-in/dashboard split is client-side", async () => {
  const r = await fetch(`${h.origin}/customer`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Your Wick Hunter account|Sign in to your account|id="signedOut"/);
});

await test("GET /api/customer/state: 401 with no session, 200 with one; a lapsed licence reads exitOnly, revoked stays false", async () => {
  const noSession = await fetch(`${h.origin}/api/customer/state`);
  assert.equal(noSession.status, 401);

  adaCookie = await signInAndGetCookie(adaEmail);
  const r = await fetch(`${h.origin}/api/customer/state`, { headers: { cookie: adaCookie } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.email, "ada@example.com");
  assert.equal(body.software.length, 1);
  assert.equal(body.software[0].customerKey, ada.key);
  assert.equal(body.software[0].revoked, false);
  assert.equal(body.software[0].exitOnly, false, "the licence is still active");
  // Superseded by H4/H5/H6 (src/hosting/service.ts): `available` now means
  // "the hosting FEATURE exists on this Hub" (always true once
  // HostingService is wired), distinct from `hasInstance` — Ada has never
  // bought hosting, so she has no instance.
  assert.equal(body.hosting.available, true);
  assert.equal(body.hosting.hasInstance, false);
  assert.ok(!JSON.stringify(body).match(/sk_|whsec_|-----BEGIN/), "no secret material is ever on this page");

  // Advance past the licence's own 2-day expiry — but well inside the
  // session's 30-day life — the dashboard must keep working (H2: "must
  // remain usable after ... software expiration").
  const before = clock;
  clock += 3 * 86_400_000;
  const lapsed = await fetch(`${h.origin}/api/customer/state`, { headers: { cookie: adaCookie } });
  assert.equal(lapsed.status, 200, "an expired licence does not lock the customer out of their own account");
  const lapsedBody = await lapsed.json();
  assert.equal(lapsedBody.software[0].revoked, false);
  assert.equal(lapsedBody.software[0].exitOnly, true, "lapsed reads as exit-only, never as revoked");
  clock = before;
});

await test("test/live never mix in one identity's view: two records, two rows, never blended", async () => {
  const email = "both-modes@example.com";
  const live = makeCustomer({ email, livemode: true, planKey: "unleashed-yearly", createdAtMs: clock - 5000 });
  const test_ = makeCustomer({ email, livemode: false, planKey: "unleashed-monthly-test", createdAtMs: clock });
  const cookie = await signInAndGetCookie(email, "198.51.100.7");
  const r = await fetch(`${h.origin}/api/customer/state`, { headers: { cookie } });
  const body = await r.json();
  assert.equal(body.software.length, 2);
  assert.equal(body.software[0].livemode, true, "live sorts first");
  assert.equal(body.software[0].customerKey, live.key);
  assert.equal(body.software[0].plan, "unleashed-yearly");
  assert.equal(body.software[1].livemode, false);
  assert.equal(body.software[1].customerKey, test_.key);
  assert.equal(body.software[1].plan, "unleashed-monthly-test");
  assert.notEqual(body.software[0].licenseId, body.software[1].licenseId, "two distinct licences, never folded into one");
});

// ── ownership: a customerKey is never trusted from the browser alone ───────

await test("install-command / portal are refused for a customerKey that does not belong to the signed-in identity", async () => {
  const stranger = makeCustomer({ email: "stranger@example.com", createdAtMs: clock });
  const install = await fetch(`${h.origin}/api/customer/install-command`, {
    method: "POST", headers: { cookie: adaCookie, "content-type": "application/json" }, body: JSON.stringify({ customerKey: stranger.key }),
  });
  assert.equal(install.status, 404);
  const portal = await fetch(`${h.origin}/api/customer/portal`, {
    method: "POST", headers: { cookie: adaCookie, "content-type": "application/json" }, body: JSON.stringify({ customerKey: stranger.key }),
  });
  assert.equal(portal.status, 404);
});

await test("install-command: mints a fresh one-time command that the existing /install/<token> route accepts", async () => {
  const r = await fetch(`${h.origin}/api/customer/install-command`, {
    method: "POST", headers: { cookie: adaCookie, "content-type": "application/json" }, body: JSON.stringify({ customerKey: ada.key }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.command, /^curl -q -fsSL "https:\/\/hub\.test\/hub\/install\/[A-Za-z0-9_-]+" \| sudo bash$/);
  const token = /install\/([A-Za-z0-9_-]+)"/.exec(body.command)[1];
  const consumed = await fetch(`${h.origin}/install/${token}`);
  assert.equal(consumed.status, 200);
  assert.match(consumed.headers.get("content-type"), /text\/x-shellscript/);
});

await test("portal: opens the record's own mode's static login link when no secret key is configured", async () => {
  await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ stripe: { live: { portalUrl: "https://billing.stripe.com/p/login/live_ada" } } }) });
  const r = await fetch(`${h.origin}/api/customer/portal`, {
    method: "POST", headers: { cookie: adaCookie, "content-type": "application/json" }, body: JSON.stringify({ customerKey: ada.key }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.url, "https://billing.stripe.com/p/login/live_ada");
});

// ── sign-out revokes exactly the presented session ──────────────────────

await test("sign-out revokes the session; the same cookie is refused afterwards", async () => {
  // This suite's clock is deliberately hand-driven rather than the
  // auto-fast-forwarding default `freshHub` gives every other suite (so the
  // 15-minute token and 30-day session edges above are exact) — which means
  // the per-email sign-in bucket would otherwise see every earlier ada@
  // request in this file as still inside its own window. Roll it forward
  // past that window before minting another.
  clock += 16 * 60_000;
  const cookie = await signInAndGetCookie(adaEmail, "198.51.100.8");
  const before = await fetch(`${h.origin}/api/customer/state`, { headers: { cookie } });
  assert.equal(before.status, 200);
  const out = await fetch(`${h.origin}/api/customer/signout`, { method: "POST", headers: { cookie } });
  assert.equal(out.status, 200);
  assert.match(out.headers.getSetCookie()[0], /^wh_customer_session=; Path=\/; Max-Age=0/);
  const after = await fetch(`${h.origin}/api/customer/state`, { headers: { cookie } });
  assert.equal(after.status, 401, "a revoked session is refused, not merely logged out client-side");
  // The ORIGINAL adaCookie (a different session) is untouched — signing out
  // one session must never revoke every session an identity holds.
  const other = await fetch(`${h.origin}/api/customer/state`, { headers: { cookie: adaCookie } });
  assert.equal(other.status, 200);
});

// ── session survives a restart ──────────────────────────────────────────

await test("session survives a restart: a fresh CustomerSessionService on the same data dir still honours it", async () => {
  clock += 16 * 60_000; // see the sign-in-bucket note above
  const cookie = await signInAndGetCookie(adaEmail, "198.51.100.9");
  const raw = cookie.split("=")[1];
  const restarted = new CustomerSessionService(h.dataDir, h.hub.billing, h.store, h.cfg.publicOrigin, { now: () => clock });
  const identity = restarted.authenticate(raw);
  assert.ok(identity, "the session row was read back from disk by a brand-new process");
  assert.equal(identity.email, "ada@example.com");
});

// ── boundary: a customer session cannot reach an admin route ────────────

await test("a customer session cookie grants NOTHING on /admin/api/* — admin auth reads only x-hub-admin", async () => {
  const withCookieNoToken = await fetch(`${h.origin}/admin/api/licenses`, { headers: { cookie: adaCookie } });
  assert.equal(withCookieNoToken.status, 401);
  // Sanity: the SAME route, with the real admin header and NO customer
  // cookie at all, works — proving the 401 above was the cookie changing
  // nothing, not some unrelated breakage.
  const withRealAdmin = await admin("/admin/api/licenses");
  assert.equal(withRealAdmin.status, 200);
  // And the reverse: the admin token in a header grants nothing on the
  // customer dashboard, which reads only the session cookie.
  const adminOnCustomerRoute = await fetch(`${h.origin}/api/customer/state`, { headers: AUTH });
  assert.equal(adminOnCustomerRoute.status, 401);
});

// ── bounced/undeliverable email: the admin-issued link ──────────────────

await test("admin-issued sign-in link: works when the email provider cannot deliver, refuses an unknown email, and requires the admin token", async () => {
  const bob = makeCustomer({ email: "bob@example.com", createdAtMs: clock });
  const noAuth = await fetch(`${h.origin}/admin/api/customers/signin-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bob@example.com" }) });
  assert.equal(noAuth.status, 401);

  const unknown = await admin("/admin/api/customers/signin-link", { method: "POST", body: JSON.stringify({ email: "never-bought-anything@example.com" }) });
  assert.equal(unknown.status, 404);
  assert.equal(h.hub.customerSessions.store.getIdentityByEmail("never-bought-anything@example.com"), null, "still never mints an identity for an unknown email");

  // Fails the customer's OWN sign-in email, proving the admin route neither
  // needs nor is affected by that delivery outcome.
  emailShouldFail = true;
  const ownAttempt = await signinReq("bob@example.com", "198.51.100.11");
  assert.equal(ownAttempt.status, 200, "a failed provider send is never surfaced to the caller");

  const r = await admin("/admin/api/customers/signin-link", { method: "POST", body: JSON.stringify({ email: "Bob@Example.com" }) });
  assert.equal(r.status, 200);
  assert.ok(r.body.url.startsWith(`${h.cfg.publicOrigin}/customer/signin?token=`), "built from the Hub's own public origin, exactly like every other emailed link");
  const token = new URL(r.body.url).searchParams.get("token");
  const ex = await fetch(`${h.origin}/customer/signin?token=${token}`, { redirect: "manual" });
  assert.equal(ex.status, 302, "the admin-issued link works even though the ordinary email path just failed");
  const cookie = ex.headers.getSetCookie()[0].split(";")[0];
  const state = await fetch(`${h.origin}/api/customer/state`, { headers: { cookie } });
  const body = await state.json();
  assert.equal(body.email, "bob@example.com");
  assert.equal(body.software[0].customerKey, bob.key);
  emailShouldFail = false;
});

await h.close();
summary("customer-sessions");
