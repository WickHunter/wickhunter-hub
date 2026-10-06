import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../public/customer.html", import.meta.url), "utf8");
const makePage = (stage, overrides = {}, onAction = async () => ({ ok: true }), confirmResult = false) => new JSDOM(html, {
  url: "https://hub.example.test/customer",
  runScripts: "dangerously",
  beforeParse(window) {
    window.confirm = () => confirmResult;
    window.fetch = async (url) => {
      if (String(url).includes("/api/customer/state")) return {
        status: 200, ok: true, json: async () => ({
          ok: true, email: "member@example.com", software: [],
          hosting: { available: true, hasInstance: true, instance: {
            id: "hosted-1", stage, region: "jp", regionLabel: "Japan", ip: "203.0.113.5",
            appUrl: "https://dashboard.example.test", monthlyPriceLabel: "$20.00",
            maximumConnectedAccounts: 5, paidThroughMs: Date.now() + 86400000,
            managedBackupsIncluded: false, ...overrides,
          } },
        }),
      };
      return { status: 200, ok: true, json: async () => onAction(String(url)) };
    };
  },
});
const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

 test("hosted dashboard gives a truthful preparation status then points to the credential email", async () => {
  for (const [stage, preparing, emailNotice] of [
    ["ordered", true, false], ["provisioning", true, false], ["bootstrapping", true, false],
    ["ready", false, true], ["active", false, true], ["suspended", false, false], ["deleting", false, false],
  ]) {
    const dom = makePage(stage);
    try {
      await nextTick();
      const preparingNote = dom.window.document.querySelector("#hostingCard .v-preparing-access-note");
      const emailNote = dom.window.document.querySelector("#hostingCard .v-ready-access-note");
      assert.equal(preparingNote.hidden, !preparing, `preparation notice visibility for ${stage}`);
      assert.equal(emailNote.hidden, !emailNotice, `credential-email notice visibility for ${stage}`);
      if (preparing) assert.match(preparingNote.textContent, /being prepared.*email your IP address and temporary Unleashed password when it's ready/i);
      if (emailNotice) {
        assert.match(emailNote.textContent, /email address used for this hosting purchase/);
        assert.match(emailNote.textContent, /IP address and temporary Unleashed password/);
        assert.equal(dom.window.document.querySelector("#hostingCard .v-ip").textContent, "203.0.113.5");
      }
    } finally { dom.window.close(); }
  }
});

test("Lifetime plus VPS dashboard identifies and cancels only VPS renewal", async () => {
  const actions = [];
  const dom = makePage("ready", {
    bundleSubscription: true, softwareLifetime: true,
    billingPriceLabel: "$1,019.00", billingInterval: "month", monthlyPriceLabel: "$20.00",
  }, async url => {
    actions.push(url);
    return url.endsWith("/cancel")
      ? { ok: true, affectsSoftwareRenewal: false, suspendAt: Date.now() + 86400000, deleteAt: Date.now() + 30 * 86400000 }
      : { ok: true };
  });
  try {
    await nextTick();
    const host = dom.window.document.querySelector("#hostingCard");
    assert.match(host.querySelector(".v-price-line").textContent, /\$20\.00\/month hosting/);
    assert.match(host.querySelector(".v-bundle-note").textContent, /Lifetime software licence is a one-time purchase.*canceling hosting does not cancel your software licence/i);
    assert.equal(host.querySelector(".v-cancel").textContent, "Cancel VPS renewal");
    host.querySelector(".v-cancel").click();
    await nextTick();
    assert.match(host.querySelector(".v-action-ok").textContent, /VPS cancellation scheduled\. Your Lifetime software licence is unchanged/);
    assert.deepEqual(actions, ["/api/hosting/hosted-1/cancel"]);
  } finally { dom.window.close(); }

  const resumeDom = makePage("cancel_scheduled", {
    bundleSubscription: true, softwareLifetime: true, monthlyPriceLabel: "$20.00",
  }, async url => { actions.push(url); return { ok: true }; });
  try {
    await nextTick();
    const host = resumeDom.window.document.querySelector("#hostingCard");
    assert.equal(host.querySelector(".v-resume").textContent, "Resume VPS renewal");
    host.querySelector(".v-resume").click();
    await nextTick();
    assert.match(host.querySelector(".v-action-ok").textContent, /VPS renewal resumed\. Your Lifetime software licence is unchanged/);
    assert.equal(actions.at(-1), "/api/hosting/hosted-1/resume-renewal");
  } finally { resumeDom.window.close(); }
});

test("legacy bundle subscriptions keep the combined software-and-hosting cancellation confirmation", async () => {
  let confirmation = "";
  const dom = makePage("ready", {
    bundleSubscription: true, billingPriceLabel: "$119.00", billingInterval: "month",
    monthlyPriceLabel: "$20.00",
  }, async () => ({ ok: true, affectsSoftwareRenewal: true }), true);
  dom.window.confirm = message => { confirmation = message; return true; };
  try {
    await nextTick();
    const host = dom.window.document.querySelector("#hostingCard");
    assert.equal(host.querySelector(".v-cancel").textContent, "Cancel software + hosting renewal");
    host.querySelector(".v-cancel").click();
    await nextTick();
    assert.match(confirmation, /both your Wick Hunter software and managed VPS/);
    assert.match(host.querySelector(".v-action-ok").textContent, /Combined software \+ hosting renewal canceled/);
  } finally { dom.window.close(); }
});
