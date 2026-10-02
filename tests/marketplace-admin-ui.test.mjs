import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const scriptErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => scriptErrors.push(error.message));
const providers = ["submitted", "approved", "suspended", "rejected"].map((status) => ({
  id: `prov_${status}`, displayName: `Provider ${status}`, status, createdAtMs: 1, updatedAtMs: 2,
}));
const requests = [];
let alphaEnabled = false;
let configFails = true;
const license = () => ({
  id: "lic_alpha", name: "Alpha Tester", exp: Date.now() + 86_400_000,
  revoked: false, marketplaceAlpha: alphaEnabled, earlyAccessEligible: false,
  lastSeen: null, seat: null, sharing: null,
});
const dom = new JSDOM(html, {
  url: "https://hub.test/hub/admin", runScripts: "dangerously", virtualConsole,
  beforeParse(window) {
    window.fetch = async (url, options = {}) => {
      const pathname = new URL(url, "https://hub.test").pathname;
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ pathname, body });
      let response = { ok: true };
      if (pathname.endsWith("/admin/api/marketplace-status")) response = {
        ok: true,
        marketplace: {
          generatedAtMs: Date.now(), bridge: { state: "connected", refusal: null },
          requiredInputs: [], readinessBlockers: [], versionCompatibility: null,
          upstream: {
            outbox: { state: "degraded", pending: 50, due: 50, exitBearing: 12, oldestPendingAtMs: 1_789_495_166_339 },
            bybitDemo: { state: "degraded", links: { total: 6, ready: 5, halted: 1, provisioning: 0 } },
            readiness: { state: "degraded", blockers: [], warnings: ["50 due outbox item(s)"] },
          },
        },
      };
      if (pathname.endsWith("/admin/api/marketplace-providers")) response = { ok: true, providers };
      if (pathname.includes("/admin/api/marketplace-providers/") && pathname.endsWith("/decision")) {
        const id = pathname.split("/").at(-2);
        const provider = providers.find((row) => row.id === id);
        provider.status = body.to;
        response = { ok: true, provider };
      }
      if (pathname.endsWith("/admin/api/licenses")) response = { ok: true, licenses: [license()] };
      if (pathname.endsWith("/admin/api/flags") && body?.flag === "marketplace") alphaEnabled = body.state;
      if (pathname.endsWith("/admin/api/marketplace-config") && configFails) {
        response = { ok: false, error: "private sync failed" };
      }
      return { status: response.ok ? 200 : 503, json: async () => response };
    };
    window.HTMLElement.prototype.scrollIntoView = () => {};
  },
});

try {
  const { window } = dom;
  const document = window.document;
  window.eval('token = "test"');
  await window.eval("mktRefresh()");
  const operational = document.getElementById("mktSummary").textContent;
  assert.match(operational, /Outbox delivery needs review/);
  assert.match(operational, /12 marked as exit-bearing/);
  assert.match(operational, /A healthy Hub worker does not confirm follower delivery/);
  assert.match(operational, /Demo provisioning halted/);
  await window.eval("mktProvidersRefresh()");
  const rows = [...document.querySelectorAll("#mktProviderRows tr")];
  assert.deepEqual(rows.map((row) => [...row.querySelectorAll("td:last-child button")].map((button) => button.textContent)), [
    ["Approve", "Reject"], ["Suspend"], ["Approve"], [],
  ]);
  assert.match(rows[3].textContent, /No further decisions/);
  const reason = rows[0].querySelector("input");
  reason.value = "Reviewed application";
  await rows[0].querySelector("button").onclick();
  assert.equal(providers[0].status, "approved");
  assert.match(document.getElementById("mktProvidersNote").textContent, /moved to approved/);
  assert.equal(requests.filter((request) => request.pathname.endsWith("/decision")).length, 1);

  await window.eval("refresh()");
  await document.querySelector("#rows .alphacell button").onclick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(alphaEnabled, false, "failed private sync restores the prior alpha grant");
  assert.deepEqual(requests.filter((request) => request.pathname.endsWith("/admin/api/flags") && request.body?.flag === "marketplace")
    .map((request) => request.body.state), [true, false]);
  assert.match(document.getElementById("note").textContent, /was not changed/);
  assert.equal(scriptErrors.length, 0, scriptErrors.join("\n"));
} finally {
  dom.window.close();
}

console.log("Marketplace admin UI: provider decisions and alpha sync rollback passed");
