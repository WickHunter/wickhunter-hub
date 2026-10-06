import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../public/customer.html", import.meta.url), "utf8");
const makePage = stage => new JSDOM(html, {
  url: "https://hub.example.test/customer",
  runScripts: "dangerously",
  beforeParse(window) {
    window.fetch = async () => ({ status: 200, ok: true, json: async () => ({
      ok: true, email: "member@example.com", software: [],
      hosting: { available: true, hasInstance: true, instance: {
        id: "hosted-1", stage, region: "jp", regionLabel: "Japan", ip: "203.0.113.5",
        appUrl: "https://dashboard.example.test", monthlyPriceLabel: "$20.00",
        maximumConnectedAccounts: 5, paidThroughMs: Date.now() + 86400000,
        managedBackupsIncluded: false,
      } },
    }) });
  },
});
const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

test("hosted customers are reminded to check email after credentials are sent, not during provisioning", async () => {
  for (const [stage, visible] of [["ordered", false], ["provisioning", false], ["bootstrapping", false], ["ready", true], ["active", true]]) {
    const dom = makePage(stage);
    try {
      await nextTick();
      const notice = dom.window.document.querySelector("#hostingCard .v-ready-access-note");
      assert.ok(notice, "notice belongs to the rendered hosted-instance card");
      assert.equal(notice.hidden, !visible, `notice visibility for ${stage}`);
      if (visible) {
        assert.match(notice.textContent, /email address used for this hosting purchase/);
        assert.match(notice.textContent, /IP address and temporary Unleashed password/);
        assert.equal(dom.window.document.querySelector("#hostingCard .v-ip").textContent, "203.0.113.5");
      }
    } finally { dom.window.close(); }
  }
});
