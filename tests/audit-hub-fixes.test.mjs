import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { normalizeFeedbackAttachment, normalizeFeedbackDiagnostics, FEEDBACK_DIAGNOSTICS_BYTES_MAX } from "../dist/src/feedback.js";
import { SupportChat, SupportError } from "../dist/src/support-chat.js";
import { BillingService } from "../dist/src/billing/service.js";
import { defaultBillingConfig } from "../dist/src/billing/config.js";
import { LicenseStore, generateSigningKey } from "../dist/src/license.js";
import { tmpDir, test, summary } from "./helpers.mjs";

const html = fs.readFileSync(path.join(process.cwd(), "public/admin.html"), "utf8");
const escSource = html.match(/function esc\(s\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(escSource, "admin esc helper is present");
const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
dom.window.eval(escSource);
const supportFormatSource = html.match(/function supportFormat\(text, trusted\)\{[\s\S]*?\n\}\n\nfunction renderSupportInbox/)?.[0]?.replace(/\n\nfunction renderSupportInbox$/, "");
assert.ok(supportFormatSource, "admin support formatter is present");
dom.window.eval(supportFormatSource);

await test("admin feedback attributes escape quotes and backticks", () => {
  const payload = 'a" onmouseover="window.pwned=1`';
  const cell = dom.window.document.createElement("div");
  cell.innerHTML = '<span title="' + dom.window.esc(payload) + '">picture</span>';
  const span = cell.firstElementChild;
  assert.equal(span.attributes.length, 1);
  assert.equal(span.getAttribute("title"), payload);
  assert.equal(span.getAttribute("onmouseover"), null);
});

await test("admin support links show the destination host for untrusted messages", () => {
  const untrusted = dom.window.supportFormat("[Stripe dashboard](https://evil.example/stripe-login)", false);
  assert.match(untrusted, /Stripe dashboard \(evil\.example\)/);
  const trusted = dom.window.supportFormat("[Team runbook](https://evil.example/runbook)", true);
  assert.equal(trusted, '<p><a href="https://evil.example/runbook" target="_blank" rel="noopener noreferrer">Team runbook</a></p>');
  const lookalike = dom.window.supportFormat("[WH login](https://wickhunter.example/login)", false);
  assert.match(lookalike, /WH login \(wickhunter\.example\)/);
  assert.match(untrusted, /target="_blank" rel="noopener noreferrer"/);
});

await test("customer dashboard shows eligible Earn link on signed-in surface", async () => {
  const customerHtml = fs.readFileSync(path.join(process.cwd(), "public/customer.html"), "utf8");
  const customerDom = new JSDOM(customerHtml, {
    url: "https://hub.test/customer",
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = async () => ({ status: 200, ok: true, json: async () => ({ ok: true, email: "member@example.com", software: [], hosting: { available: false }, earnAvailable: true }) });
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(customerDom.window.document.getElementById("signedOut").hidden, true);
    assert.equal(customerDom.window.document.getElementById("signedIn").hidden, false);
    assert.equal(customerDom.window.document.getElementById("earnLink").hidden, false);
    assert.equal(customerDom.window.document.getElementById("earnLink").getAttribute("href"), "earn");
  } finally {
    customerDom.window.close();
  }
});

await test("feedback attachment names reject attribute syntax", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const result = normalizeFeedbackAttachment({ name: 'a"b.png', mimeType: "image/png", base64: png });
  assert.equal(result.ok, true);
  assert.equal(result.attachment.name, "screenshot.png");
});

function hostile(groups) {
  const key = (i) => ("k" + i).padEnd(80, "x");
  const out = {};
  for (let g = 0; g < groups; g++) {
    const group = {};
    for (let i = 0; i < 80; i++) {
      const row = {};
      for (let j = 0; j < 80; j++) row[key(j)] = 1;
      group[key(i)] = row;
    }
    out["g" + g] = group;
  }
  return out;
}

await test("diagnostic byte clamp avoids one whole stringify per removed leaf", () => {
  const real = JSON.stringify;
  let large = 0;
  JSON.stringify = function (...args) {
    const text = real.apply(this, args);
    if (text.length > 64 * 1024) large++;
    return text;
  };
  let out;
  try { out = normalizeFeedbackDiagnostics(hostile(2)); } finally { JSON.stringify = real; }
  const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");
  assert.ok(bytes <= FEEDBACK_DIAGNOSTICS_BYTES_MAX);
  assert.equal(out.diagnosticsTruncated, true);
  assert.ok(large <= 5, `large serializations: ${large}`);
});

await test("oversized support data leaves the Hub support surface read-only", () => {
  const dir = tmpDir("support-oversize");
  fs.writeFileSync(path.join(dir, "support-chat.v1.json"), "x".repeat(16 * 1024 * 1024 + 1));
  const chat = new SupportChat(dir, { enabled: true, aiEnabled: false, apiKey: "", totalMonthlyMicros: 1_000_000 });
  assert.match(chat.admin().message, /read-only/);
  assert.throws(() => chat.action({ action: "budget", monthlyLimitUsd: 1 }), (e) => e instanceof SupportError && e.status === 503);
  assert.equal(fs.statSync(path.join(dir, "support-chat.v1.json")).size, 16 * 1024 * 1024 + 1);
});

await test("approving knowledge does not reorder an old support thread", async () => {
  let now = 100;
  const chat = new SupportChat(tmpDir("support-knowledge-order"), { enabled: true, aiEnabled: false, apiKey: "", totalMonthlyMicros: 1_000_000 }, fetch, () => now);
  const identity = { owner: "licensed-owner", name: "Customer", licenseId: "lic" };
  const created = await chat.message(identity, { text: "Question", requestId: "knowledge-request", version: "0.90.1" });
  const id = created.threads[0].id;
  const before = chat.admin().items.find((item) => item.id === id).updatedAt;
  now = 500;
  chat.action({ id, action: "knowledge", question: "Question", answer: "Approved answer" });
  assert.equal(chat.admin().items.find((item) => item.id === id).updatedAt, before);
});

await test("resolved support history does not exhaust new conversations", async () => {
  const chat = new SupportChat(tmpDir("support-thread-cap"), { enabled: true, aiEnabled: false, apiKey: "", totalMonthlyMicros: 1_000_000 });
  const identity = { owner: "licensed-thread-cap", name: "Customer", licenseId: "lic" };
  for (let i = 0; i < 20; i++) {
    const created = await chat.message(identity, { text: `Question ${i}`, requestId: `thread-request-${String(i).padStart(2, "0")}` });
    chat.action({ id: created.threads[0].id, action: "resolve" });
  }
  const next = await chat.message(identity, { text: "A new question", requestId: "thread-request-new" });
  assert.equal(next.ok, true);
  assert.equal(next.threads[0].status, "human");
  assert.equal(next.threads.filter((thread) => thread.status !== "resolved").length, 1);
});

await test("one checkout session cannot extend twice when a delivery is replayed", async () => {
  const dir = tmpDir("billing-replay");
  const licenses = new LicenseStore(dir);
  licenses.writeKey(generateSigningKey().privatePem);
  const now = 1_800_000_000_000;
  const billing = new BillingService(dir, licenses, "https://hub.test", path.join(process.cwd(), "templates"), { now: () => now, log: () => {} });
  const cfg = defaultBillingConfig();
  cfg.mode = "live";
  const checkout = (eventId, sessionId) => ({
    id: eventId, type: "checkout.session.completed", livemode: true, createdMs: now,
    object: { id: sessionId, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", customer: "cus_replay", customer_details: { email: "replay@example.com", name: "Replay" }, payment_intent: "pi_" + sessionId, metadata: { license_days: "30" } },
  });
  await billing.applyEvent(checkout("evt_1", "cs_same"), cfg);
  const first = licenses.list()[0].exp;
  await billing.applyEvent(checkout("evt_2", "cs_same"), cfg);
  assert.equal(licenses.list()[0].exp, first);
  await billing.applyEvent(checkout("evt_3", "cs_other"), cfg);
  assert.equal(licenses.list()[0].exp, first + 30 * 86_400_000);
});

summary("audit-hub-fixes");
