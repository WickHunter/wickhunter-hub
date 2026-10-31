// tests/onboarding-pages.test.mjs — the customer page after checkout and the
// hosted server card's password-reset control, driven in JSDOM with stubbed
// Hub responses (no network).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../public/customer.html", import.meta.url), "utf8");
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await nextTick(); };

function page({ url = "https://hub.example.test/customer", state = null, summary = null, onPost = async () => ({ ok: true }), confirm = true } = {}) {
  const calls = [];
  const dom = new JSDOM(html, {
    url, runScripts: "dangerously",
    beforeParse(window) {
      window.confirm = () => confirm;
      window.setTimeout = ((orig) => (fn, ms) => (ms >= 1000 ? 0 : orig(fn, ms)))(window.setTimeout);
      window.fetch = async (u, init = {}) => {
        const path = String(u);
        calls.push({ path, init });
        if (path.includes("/api/customer/state")) return state ? { status: 200, ok: true, json: async () => ({ ok: true, ...state }) } : { status: 401, ok: false, json: async () => ({ ok: false }) };
        if (path.includes("/api/checkout/summary")) return { status: 200, ok: true, json: async () => summary ?? { ok: true, status: "processing" } };
        const body = await onPost(path, init);
        return { status: body.ok ? 200 : (body.status ?? 409), ok: !!body.ok, json: async () => body };
      };
    },
  });
  return { dom, doc: dom.window.document, calls };
}

const instance = (overrides = {}) => ({
  id: "host_1", stage: "active", region: "nrt", regionLabel: "Tokyo", ip: "203.0.113.5", appUrl: "https://203.0.113.5/",
  monthlyPriceLabel: "$20.00", maximumConnectedAccounts: 5, paidThroughMs: Date.now() + 86400000, managedBackupsIncluded: false,
  failureReason: null, supportReference: null,
  credentialReset: { available: true, unavailableReason: null, status: null, atMs: null, reference: null }, ...overrides,
});
const hostedState = (inst) => ({ email: "buyer@example.com", software: [{ plan: "Monthly", exp: Date.now() + 86400000 * 30, livemode: true, customerKey: "cus_1" }], hosting: { available: true, hasInstance: true, instance: inst } });

test("no checkout parameters: the post-checkout panel stays hidden", async () => {
  const { doc } = page();
  await settle();
  assert.equal(doc.getElementById("checkoutWelcome").hidden, true);
});

test("signed out after a hosted purchase: what was bought, server progress, sign-in, help and support", async () => {
  const { doc, calls } = page({
    url: "https://hub.example.test/customer?checkout=complete&session_id=cs_live_abcdefghij123",
    summary: { ok: true, status: "confirmed", product: "hosted", planName: "Monthly", emailHint: "b•••@e•••.com", welcomeSent: true, server: { stage: "provisioning", ready: false } },
  });
  await settle();
  assert.ok(calls.some((c) => c.path === "/api/checkout/summary?session_id=cs_live_abcdefghij123"));
  const card = doc.getElementById("checkoutWelcome");
  assert.equal(card.hidden, false);
  assert.match(card.querySelector(".v-title").textContent, /setting up your server/);
  assert.match(card.querySelector(".v-lead").textContent, /nothing to install/);
  assert.equal(card.querySelector(".v-product").textContent, "Wick Hunter Unleashed + managed server");
  assert.equal(card.querySelector(".v-plan").textContent, "Monthly");
  assert.equal(card.querySelector(".v-email").textContent, "b•••@e•••.com");
  const steps = [...card.querySelectorAll(".v-steps li")];
  assert.deepEqual(steps.map((li) => li.className), ["done", "now", "", ""]);
  assert.equal(card.querySelector(".v-primary").textContent, "Sign in to follow progress");
  assert.equal(card.querySelector(".v-video").hidden, true, "no self-hosting video for a hosted buyer");
  assert.ok(card.querySelector('a[href="support"]'), "help link");
  assert.match(card.querySelector(".v-support").href, /support#message=/);
  assert.equal(doc.getElementById("signedOut").hidden, false, "the sign-in form is still offered");
});

test("signed out after a self-hosted purchase: install steps, the setup video and the welcome-email pointer", async () => {
  const { doc } = page({
    url: "https://hub.example.test/customer?checkout=complete&session_id=cs_test_selfhosted01",
    summary: { ok: true, status: "confirmed", product: "self-hosted", planName: "Yearly", emailHint: "s•••@e•••.com", welcomeSent: true, server: null },
  });
  await settle();
  const card = doc.getElementById("checkoutWelcome");
  assert.match(card.querySelector(".v-title").textContent, /how to install/);
  assert.match(card.querySelector(".v-lead").textContent, /s•••@e•••\.com/);
  assert.equal(card.querySelectorAll(".v-steps li").length, 4);
  assert.match(card.querySelector(".v-steps").textContent, /Ubuntu 22\.04/);
  assert.equal(card.querySelector(".v-video").hidden, false);
});

test("order still processing: generic thank-you, never a blank page", async () => {
  const { doc } = page({ url: "https://hub.example.test/customer?checkout=complete" });
  await settle();
  const card = doc.getElementById("checkoutWelcome");
  assert.equal(card.hidden, false);
  assert.match(card.querySelector(".v-title").textContent, /payment went through/);
  assert.equal(card.querySelector(".v-bought").hidden, true);
});

test("signed in with a ready server: tracker complete and an Open your dashboard button", async () => {
  const { doc } = page({ url: "https://hub.example.test/customer?hosting=checkout-success#hosting", state: hostedState(instance({ stage: "ready" })) });
  await settle();
  const card = doc.getElementById("checkoutWelcome");
  assert.equal(card.querySelector(".v-title").textContent, "Your server is ready");
  assert.deepEqual([...card.querySelectorAll(".v-steps li")].map((li) => li.className), ["done", "done", "done", "done"]);
  const btn = card.querySelector(".v-primary");
  assert.equal(btn.hidden, false);
  assert.equal(btn.getAttribute("href"), "https://203.0.113.5/");
  assert.equal(card.querySelector(".v-email").textContent, "buyer@example.com");
});

test("hosting card: reset button posts to the owner route and shows the server-side status; no password in the page", async () => {
  const { doc, calls } = page({ state: hostedState(instance()), onPost: async () => ({ ok: true, alreadyPending: false, message: "Your server will apply a new temporary password within about ten minutes, then we email it to you." }) });
  await settle();
  const btn = doc.querySelector("#hostingCard .v-reset-btn");
  assert.equal(doc.querySelector("#hostingCard .v-reset").hidden, false);
  assert.equal(btn.disabled, false);
  btn.click();
  await settle();
  const post = calls.find((c) => c.path === "/api/hosting/host_1/reset-password");
  assert.ok(post);
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.headers["x-wh-customer-action"], "1");
  assert.match(doc.querySelector("#hostingCard .v-reset-status").textContent, /within about ten minutes/);
  assert.equal(btn.disabled, true);
});

test("hosting card: reset statuses, an unavailable agent, and declined confirmation", async () => {
  let r = page({ state: hostedState(instance({ credentialReset: { available: true, status: "failed", atMs: Date.now(), reference: "WH-ABCDEF12", unavailableReason: null } })) });
  await settle();
  assert.match(r.doc.querySelector("#hostingCard .v-reset-status").textContent, /previous password still works.*WH-ABCDEF12/);
  r = page({ state: hostedState(instance({ credentialReset: { available: false, status: null, atMs: null, reference: null, unavailableReason: "This server cannot reset its password automatically. Contact support and we will reset it for you." } })) });
  await settle();
  assert.equal(r.doc.querySelector("#hostingCard .v-reset-btn").disabled, true);
  assert.match(r.doc.querySelector("#hostingCard .v-reset-err").textContent, /Contact support/);
  r = page({ state: hostedState(instance({ stage: "provisioning" })) });
  await settle();
  assert.equal(r.doc.querySelector("#hostingCard .v-reset").hidden, true, "no reset before the server exists");
  r = page({ state: hostedState(instance()), confirm: false });
  await settle();
  r.doc.querySelector("#hostingCard .v-reset-btn").click();
  await settle();
  assert.ok(!r.calls.some((c) => c.path.endsWith("/reset-password")), "declining the confirmation sends nothing");
});

test("hosting card: a failure shows the plain message plus its support reference and a prefilled support link", async () => {
  const { doc } = page({ state: hostedState(instance({ stage: "bootstrapping", failureReason: "We could not finish setting up your server.", supportReference: "WH-0A1B2C3D" })) });
  await settle();
  assert.equal(doc.querySelector("#hostingCard .v-fail-note").textContent, "We could not finish setting up your server.");
  assert.equal(doc.querySelector("#hostingCard .v-fail-ref").hidden, false);
  assert.equal(doc.querySelector("#hostingCard .v-ref").textContent, "WH-0A1B2C3D");
  assert.match(decodeURIComponent(doc.querySelector("#hostingCard .v-ref-link").href), /reference WH-0A1B2C3D/);
});
