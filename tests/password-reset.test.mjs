// tests/password-reset.test.mjs — dashboard password reset by emailed code
// (src/password-reset.ts), over real HTTP on loopback. The email provider is
// an injected fetch that records what it was asked to send; nothing ever
// leaves 127.0.0.1 and no real email is sent.
import assert from "node:assert/strict";
import { createPublicKey, verify as edVerify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import {
  approximateIp, cleanLabel, maskEmail, resetCodeEmail,
  RESET_APPROVAL_SCHEMA, RESET_AUDIT_FILE, RESET_CODES_FILE, RESET_CODE_TTL_MS,
} from "../dist/src/password-reset.js";

const emails = [];
const fakeFetch = async (url, init) => {
  emails.push({ url, init, body: JSON.parse(init.body) });
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: `em_${emails.length}` }) };
};
let clock = Math.floor(Date.now() / 1000) * 1000;
let rlClock = clock;
let nextCodes = [];
const h = await freshHub({}, {
  passwordResetFetch: fakeFetch,
  passwordResetNow: () => clock,
  passwordResetNewCode: () => nextCodes.shift() ?? "00000000",
  // A hand-advanced limiter clock: the default helper clock jumps ten
  // minutes per call, which would hide the per-licence window.
  rateLimitNow: () => rlClock,
});
const AUTH = { "x-hub-admin": "test-admin-token", "content-type": "application/json" };
const admin = (p, opts = {}) => jsonReq(`${h.origin}${p}`, { ...opts, headers: { ...AUTH, ...(opts.headers ?? {}) } });
await admin("/admin/api/billing/config", {
  method: "POST",
  body: JSON.stringify({ email: { provider: "resend", apiKey: "re_test_1234567890", from: "Wick Hunter <admin@wickhunterunleashed.com>", replyTo: "admin@wickhunterunleashed.com" } }),
}).then((r) => assert.equal(r.status, 200));

function customer(email, name = "Ada Lovelace") {
  const issued = h.store.issueUntil(name, clock + 30 * 86_400_000, "unleashed", clock);
  const key = `cus_${issued.payload.id.slice(0, 8)}`;
  h.hub.billing.store.putCustomer({
    key, stripeCustomerId: key, email, name, livemode: true, licenseId: issued.payload.id, planKey: "unleashed-monthly",
    subscriptionId: null, subscriptionStatus: null, periodEndMs: null, chargeIds: [], createdAtMs: clock, updatedAtMs: clock,
    welcomeSentAtMs: null, welcomeError: null, disputed: false, refunded: false, lastEventType: null,
  });
  return issued;
}
const post = (op, body) => jsonReq(`${h.origin}/api/license/password-reset/${op}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const NONCE = "n".repeat(20) + "abcdefgh";
const pubKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(h.store.publicKeyRawB64u(), "base64url")]), format: "der", type: "spki" });
function openApproval(approval) {
  const [prefix, p, sig] = approval.split(".");
  assert.equal(prefix, "WHPR1");
  const bytes = Buffer.from(p, "base64url");
  assert.ok(edVerify(null, bytes, pubKey, Buffer.from(sig, "base64url")), "approval verifies with the pinned licence key");
  return JSON.parse(bytes.toString("utf8"));
}
const rowsOnDisk = () => fs.readFileSync(path.join(h.dataDir, RESET_CODES_FILE), "utf8");
const auditOnDisk = () => fs.readFileSync(path.join(h.dataDir, RESET_AUDIT_FILE), "utf8");

const ada = customer("ada@example.com");
const adaBody = { licenseId: ada.payload.id, installId: "install-ada-1", token: ada.token };
const tester = h.store.issue("Tester With No Billing", 30, clock); // admin-issued: no email on file
const usedCodes = [];

await test("pure helpers: IPs are approximated, labels and addresses are cleaned", () => {
  assert.equal(approximateIp("203.0.113.57"), "203.0.113.0");
  assert.equal(approximateIp("::ffff:198.51.100.9"), "198.51.100.0");
  assert.equal(approximateIp("2001:db8:abcd:12::1"), "2001:db8:abcd::/48");
  assert.equal(approximateIp("<script>"), "unknown");
  assert.equal(cleanLabel("<b>My\nVPS</b>"), "b My VPS /b");
  assert.equal(cleanLabel(""), "your Unleashed install");
  assert.equal(cleanLabel("x".repeat(200)).length, 64);
  assert.equal(maskEmail("ada@example.com"), "a***@example.com");
});

await test("the email names who asked, the expiry and 'ignore if not you', and escapes everything", () => {
  const m = resetCodeEmail("ada@example.com", { code: "12345678", label: "<i>VPS</i>", requesterIpApprox: "203.0.113.0", expiresAtMs: Date.UTC(2026, 10, 1, 12, 15) });
  assert.match(m.subject, /password reset code/);
  for (const part of [m.text, m.html]) {
    assert.ok(part.includes("12345678"));
    assert.ok(part.includes("203.0.113.0"));
    assert.ok(part.includes("15 minutes"));
    assert.ok(part.includes("2026-11-01 12:15 UTC"));
    assert.match(part, /did not ask for this, ignore this email/);
  }
  assert.ok(m.html.includes("&lt;i&gt;VPS&lt;/i&gt;") && !m.html.includes("<i>VPS</i>"));
});

await test("request: a missing, foreign or forged licence token is refused", async () => {
  assert.equal((await post("request", { ...adaBody, token: "" })).status, 401);
  assert.equal((await post("request", { ...adaBody, token: tester.token })).status, 401);
  assert.equal((await post("request", { ...adaBody, token: ada.token.slice(0, -4) + "AAAA" })).status, 401);
  assert.equal((await post("request", { ...adaBody, installId: "bad id with spaces" })).status, 400);
  assert.equal(emails.length, 0);
});

let first;
await test("request: a genuine licence gets a code emailed to the billing owner, stored only as a hash", async () => {
  nextCodes = ["40417251"];
  const r = await post("request", { ...adaBody, label: "Ada's VPS", requesterIp: "203.0.113.57" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.requestId, /^pr_[a-f0-9]{32}$/);
  assert.equal(r.body.expiresAtMs, clock + RESET_CODE_TTL_MS);
  assert.equal(Object.keys(r.body).sort().join(","), "expiresAtMs,ok,requestId", "nothing about the email or account rides back");
  first = r.body.requestId;
  assert.equal(emails.length, 1);
  const sent = emails[0].body;
  assert.deepEqual(sent.to, ["ada@example.com"]);
  assert.equal(sent.from, "Wick Hunter <admin@wickhunterunleashed.com>");
  assert.ok(sent.text.includes("40417251") && sent.html.includes("40417251"));
  assert.ok(sent.text.includes("Ada's VPS") && sent.text.includes("203.0.113.0") && !sent.text.includes("203.0.113.57"));
  assert.ok(!rowsOnDisk().includes("40417251"), "the code itself is never stored");
  assert.match(rowsOnDisk(), /"codeHash": "[a-f0-9]{64}"/);
  assert.ok(!auditOnDisk().includes("40417251") && !auditOnDisk().includes("ada@example.com"), "audit holds no code and no full address");
  assert.ok(auditOnDisk().includes('"kind":"emailed"') && auditOnDisk().includes("a***@example.com"));
});

await test("request: a licence with no email on file gets the identical answer and nothing is sent", async () => {
  const before = emails.length;
  const r = await post("request", { licenseId: tester.payload.id, installId: "install-t-1", token: tester.token });
  assert.equal(r.status, 200);
  assert.equal(Object.keys(r.body).sort().join(","), "expiresAtMs,ok,requestId");
  assert.equal(emails.length, before);
  assert.ok(auditOnDisk().includes('"kind":"no_email_on_file"'));
});

await test("verify: a wrong code is a generic refusal; the right code returns a signed one-time approval", async () => {
  const wrong = await post("verify", { ...adaBody, requestId: first, code: "11111111", nonce: NONCE });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "the code is wrong or has expired — request a new one");
  const otherInstall = await post("verify", { ...adaBody, installId: "install-other", requestId: first, code: "40417251", nonce: NONCE });
  assert.equal(otherInstall.status, 400, "a code is bound to the install that asked");
  const ok = await post("verify", { ...adaBody, requestId: first, code: "4041 7251", nonce: NONCE });
  assert.equal(ok.status, 200);
  const p = openApproval(ok.body.approval);
  assert.equal(p.schema, RESET_APPROVAL_SCHEMA);
  assert.equal(p.licenseId, ada.payload.id);
  assert.equal(p.installId, "install-ada-1");
  assert.equal(p.requestId, first);
  assert.equal(p.nonce, NONCE);
  assert.equal(p.expiresAtMs - p.issuedAtMs, 2 * 60_000);
  usedCodes.push("40417251");
  const again = await post("verify", { ...adaBody, requestId: first, code: "40417251", nonce: NONCE });
  assert.equal(again.status, 400, "single use");
  assert.ok(!("approval" in again.body));
});

await test("verify: five wrong codes lock the request, after which even the right code fails", async () => {
  nextCodes = ["55501234"];
  const r = await post("request", adaBody);
  for (let i = 0; i < 4; i++) {
    const w = await post("verify", { ...adaBody, requestId: r.body.requestId, code: `9999999${i}`, nonce: NONCE });
    assert.equal(w.status, 400); assert.ok(!w.body.locked);
  }
  const fifth = await post("verify", { ...adaBody, requestId: r.body.requestId, code: "99999995", nonce: NONCE });
  assert.equal(fifth.body.locked, true);
  const right = await post("verify", { ...adaBody, requestId: r.body.requestId, code: "55501234", nonce: NONCE });
  assert.equal(right.status, 400); assert.equal(right.body.locked, true);
});

await test("verify: a code expires after 15 minutes", async () => {
  rlClock += 60 * 60_000;
  nextCodes = ["66601234"];
  const r = await post("request", adaBody);
  clock += RESET_CODE_TTL_MS;
  const late = await post("verify", { ...adaBody, requestId: r.body.requestId, code: "66601234", nonce: NONCE });
  assert.equal(late.status, 400);
  clock += 1_000;
});

await test("request: a new request supersedes the open one", async () => {
  nextCodes = ["77701234", "88801234"];
  const a = await post("request", adaBody);
  const b = await post("request", adaBody);
  assert.equal((await post("verify", { ...adaBody, requestId: a.body.requestId, code: "77701234", nonce: NONCE })).status, 400);
  assert.equal((await post("verify", { ...adaBody, requestId: b.body.requestId, code: "88801234", nonce: NONCE })).status, 200);
});

await test("request: three codes per licence per 15 minutes, then 429", async () => {
  rlClock += 60 * 60_000;
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await post("request", adaBody)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  rlClock += 15 * 60_000 + 1;
  assert.equal((await post("request", adaBody)).status, 200);
});

await test("verify: a revoked licence can no longer reset", async () => {
  const bob = customer("bob@example.com", "Bob");
  nextCodes = ["12121212"];
  const body = { licenseId: bob.payload.id, installId: "install-bob", token: bob.token };
  const r = await post("request", body);
  h.store.revoke(bob.payload.id);
  assert.equal((await post("verify", { ...body, requestId: r.body.requestId, code: "12121212", nonce: NONCE })).status, 403);
  assert.equal((await post("request", body)).status, 403);
});

await test("admin view: token required; shows outcomes with masked recipients and never a code", async () => {
  const anon = await jsonReq(`${h.origin}/admin/api/password-resets`);
  assert.equal(anon.status, 401);
  const r = await admin("/admin/api/password-resets");
  assert.equal(r.status, 200);
  const kinds = new Set(r.body.entries.map((e) => e.kind));
  for (const k of ["requested", "emailed", "no_email_on_file", "verified", "wrong_code", "locked", "expired"]) assert.ok(kinds.has(k), `has ${k}`);
  const text = JSON.stringify(r.body);
  for (const c of usedCodes.concat(["55501234", "66601234", "88801234"])) assert.ok(!text.includes(c));
  assert.ok(!text.includes("ada@example.com") && text.includes("a***@example.com"));
  assert.ok(r.body.entries[0].at >= r.body.entries.at(-1).at, "newest first");
  const page = fs.readFileSync(path.join(h.cfg.publicDir, "admin.html"), "utf8");
  assert.ok(page.includes('id="passwordResetRows"') && page.includes("/admin/api/password-resets"));
});

await h.close();
summary("password-reset");
