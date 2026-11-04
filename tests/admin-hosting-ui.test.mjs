// tests/admin-hosting-ui.test.mjs — v0.4.104 admin Hosting page: summary
// chips, deleted hidden by default, stage filter + search, customer names
// instead of raw owner ids, short copyable ids, the "…" action menu and the
// details drawer. Every action must still call the SAME admin endpoint it
// called before the redesign. jsdom with a stubbed fetch; no network.
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { test, summary } from "./helpers.mjs";

const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const NOW = Date.now(), DAY = 86_400_000;

function fixtures() {
  const base = { environment: "live", region: "nrt", planId: "vc2-2c-2gb", operationalHealth: "healthy", lifecycleVersion: 1, generation: 1, providerPlanMonthlyCostCents: 1500,
    paidThroughMs: null, suspendAtMs: null, deleteAtMs: null, cancellationReason: null, deletionHold: null, failureReason: null, readiness: null, terminatedAtMs: null,
    stripeSubscriptionId: null, label: "", releaseRef: "a".repeat(64), createdAtMs: NOW - 20 * DAY, updatedAtMs: NOW - DAY, version: 3 };
  return [
    { ...base, id: "host_READYaaaa1111", ownerId: "cus_VReady0001", stage: "ready", ip: "203.0.113.10", providerInstanceId: "8f0e5a3c-1111-2222-3333-444455556666", paidThroughMs: NOW + 12 * DAY, stripeSubscriptionId: "sub_ready",
      customer: { key: "cus_VReady0001", name: "Ada Ready", email: "ada@example.test", licenseId: "lic-ada-0001", complimentary: false }, app: { version: "0.91.32", lastSeenMs: NOW - 5 * 60_000, ip: "203.0.113.10", onThisServer: true },
      readiness: { checkedAtMs: NOW - 10 * DAY, ready: true, refusals: [], regionTried: "nrt" }, sshHostKeys: [{ type: "ED25519", fingerprint: "SHA256:" + "A".repeat(43) }], sshHostKeysAtMs: NOW - 10 * DAY },
    { ...base, id: "host_COMPbbbb2222", ownerId: "complimentary:ops@example.test", stage: "bootstrapping", ip: "203.0.113.11", providerInstanceId: "9a9a9a9a-0000-0000-0000-000000000000", complimentary: true,
      customer: { key: "complimentary:ops@example.test", name: "Complimentary", email: "ops@example.test", licenseId: "lic-comp", complimentary: true }, app: null },
    { ...base, id: "host_CANCcccc3333", ownerId: "cus_VCancel002", stage: "cancel_scheduled", ip: "203.0.113.12", providerInstanceId: "7b7b7b7b-0000-0000-0000-000000000000", cancellationReason: "intentional_cancellation",
      suspendAtMs: NOW + 3 * DAY, deleteAtMs: NOW + 10 * DAY, customer: { key: "cus_VCancel002", name: "Cora Cancel", email: "cora@example.test", licenseId: "lic-cora", complimentary: false }, app: { version: "0.91.9", lastSeenMs: NOW - 2 * DAY, ip: "198.51.100.7", onThisServer: false } },
    { ...base, id: "host_DELdddd4444", ownerId: "bundle:" + "f".repeat(48), stage: "deleted", ip: null, providerInstanceId: null, terminatedAtMs: NOW - 30 * DAY, failureReason: "checkout_expired", customer: null, app: null },
    { ...base, id: "host_PASTeeee5555", ownerId: "cus_VPast00003", stage: "past_due", ip: "203.0.113.14", providerInstanceId: "6c6c6c6c-0000-0000-0000-000000000000", cancellationReason: "renewal_unpaid",
      suspendAtMs: NOW + DAY, deleteAtMs: NOW + 8 * DAY, deletionHold: { by: "support", atMs: NOW - DAY, reason: "ticket 42" }, customer: { key: "cus_VPast00003", name: "Pat Past", email: "pat@example.test", licenseId: "lic-pat", complimentary: false }, app: null },
  ];
}

const opened = [];
async function page() {
  const requests = [], errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(e.message));
  const rows = fixtures();
  const dom = new JSDOM(html, {
    url: "https://hub.test/hub/admin", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.fetch = async (url, options = {}) => {
        const pathname = new URL(url, "https://hub.test").pathname;
        requests.push({ pathname, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null, headers: options.headers });
        let response = { ok: true };
        if (pathname.endsWith("/admin/api/hosting/policy")) response = { ok: true, policy: { maximumProjectedMonthlyProviderCostCents: 25000, regions: [{ id: "nrt", label: "Tokyo" }], probeVenues: [], fleetAuthorizedKeys: [] }, secrets: { vultrApiKey: { configured: true, last4: "abcd" } }, projectedMonthlyProviderCostCents: { known: true, cents: 6000 } };
        else if (pathname.endsWith("/admin/api/hosting/instances")) response = { ok: true, instances: rows };
        else if (pathname.endsWith("/outbox")) response = { ok: true, jobs: [
          { id: "j1", jobType: "provision", status: "sent", dedupeKey: "provision:x", availableAtMs: NOW - 19 * DAY, createdAtMs: NOW - 20 * DAY, updatedAtMs: NOW - 19 * DAY, attemptCount: 1, payload: {} },
          { id: "j2", jobType: "email", status: "sent", dedupeKey: "email:ready:x:g1", availableAtMs: NOW - 18 * DAY, createdAtMs: NOW - 18 * DAY, updatedAtMs: NOW - 18 * DAY, attemptCount: 1, payload: { template: "installation_ready" } }] };
        else if (pathname.endsWith("/admin/api/hosting/fleet-key/plan")) response = { ok: true, dryRun: true, configuredKeys: ["SHA256:x"], channel: null, targets: [{ instanceId: "host_READYaaaa1111", ip: "203.0.113.10", stage: "ready", reason: "bootstrapped before the Hub carried a fleet key" }], confirmed: [], explanation: "no channel" };
        else if (pathname.includes("/admin/api/hosting/instances/") && pathname.endsWith("/resume-renewal")) response = { ok: true, note: "ok" };
        else if (pathname.includes("/end-complimentary")) response = { ok: true, changed: true, suspendAtMs: NOW, deleteAtMs: NOW + 7 * DAY };
        return { status: response.ok ? 200 : 503, json: async () => response };
      };
      window.confirm = () => true;
      window.prompt = () => "fixture reason";
      window.alert = () => {};
      window.open = (u) => { requests.push({ pathname: "window.open", url: u }); };
      window.HTMLElement.prototype.scrollIntoView = () => {};
      Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t) => { requests.push({ pathname: "clipboard", text: t }); } }, configurable: true });
    },
  });
  const { window } = dom;
  opened.push(window);
  window.eval('token = "test"');
  await window.eval("hostingRefresh()");
  return { window, document: window.document, requests, errors };
}
const visibleRows = (d) => [...d.querySelectorAll("#hostingInstanceRows tr[data-id]")].map((tr) => tr.dataset.id);
const menuButton = (d, id, label) => [...d.querySelectorAll(`#hostingInstanceRows tr[data-id="${id}"] .host-menu-list button`)].find((b) => b.textContent === label);
const settle = () => new Promise((r) => setTimeout(r, 0));

await test("summary chips count every stage; deleted rows are hidden by default and shown by the toggle; the cost bar reads projected vs ceiling", async () => {
  const p = await page();
  const chips = Object.fromEntries([...p.document.querySelectorAll(".host-chip")].map((c) => [c.dataset.stage, Number(c.querySelector("b").textContent)]));
  assert.deepEqual(chips, { ready: 1, provisioning: 1, past_due: 1, cancel_scheduled: 1, suspended: 0, deleted: 1 });
  assert.deepEqual(visibleRows(p.document), ["host_READYaaaa1111", "host_COMPbbbb2222", "host_CANCcccc3333", "host_PASTeeee5555"]);
  p.document.getElementById("hostShowDeleted").checked = true;
  p.document.getElementById("hostShowDeleted").dispatchEvent(new p.window.Event("change"));
  assert.ok(visibleRows(p.document).includes("host_DELdddd4444"));
  assert.match(p.document.getElementById("hostingCostMeta").textContent, /\$60\.00 of \$250\.00\/mo \(24%\)/);
  assert.equal(p.document.getElementById("hostCostFill").style.width, "24%");
  assert.match(p.document.getElementById("hostingMeta").textContent, /4 live · 5 total/);
  assert.deepEqual(p.errors, []);
});

await test("stage filter (select and chip) and search by email, name, IP and instance id", async () => {
  const p = await page();
  const sel = p.document.getElementById("hostStage"), search = p.document.getElementById("hostSearch");
  sel.value = "deleted"; sel.dispatchEvent(new p.window.Event("change"));
  assert.deepEqual(visibleRows(p.document), ["host_DELdddd4444"], "the deleted filter shows deleted rows without the toggle");
  sel.value = ""; sel.dispatchEvent(new p.window.Event("change"));
  p.document.querySelector('.host-chip[data-stage="past_due"]').click();
  assert.equal(sel.value, "past_due"); assert.deepEqual(visibleRows(p.document), ["host_PASTeeee5555"]);
  p.document.querySelector('.host-chip[data-stage="past_due"]').click();
  assert.equal(sel.value, "", "clicking the active chip clears the filter");
  for (const [q, want] of [["ada@example", ["host_READYaaaa1111"]], ["cora cancel", ["host_CANCcccc3333"]], ["203.0.113.11", ["host_COMPbbbb2222"]], ["host_pasteeee", ["host_PASTeeee5555"]], ["nobody", []]]) {
    search.value = q; search.dispatchEvent(new p.window.Event("input"));
    assert.deepEqual(visibleRows(p.document), want, q);
  }
});

await test("rows show the customer (not raw ids), complimentary badge, IP link, short copyable ids, app version + check-in age, and the end/renewal date", async () => {
  const p = await page();
  const ready = p.document.querySelector('tr[data-id="host_READYaaaa1111"]');
  assert.match(ready.textContent, /Ada Ready/); assert.match(ready.textContent, /ada@example\.test/);
  assert.ok(!ready.textContent.includes("cus_VReady0001"), "the raw owner id is not printed; it is a short copy chip");
  assert.equal(ready.querySelector('a[href="https://203.0.113.10/"]').textContent, "203.0.113.10");
  assert.match(ready.textContent, /0\.91\.32/); assert.match(ready.textContent, /seen 5m ago/);
  assert.match(ready.textContent, /Renews in 12d/);
  const chip = ready.querySelector('.host-id[data-copy="8f0e5a3c-1111-2222-3333-444455556666"]');
  assert.equal(chip.textContent, "8f0e5a3c"); assert.ok(!ready.textContent.includes("444455556666"), "full provider UUIDs stay in the drawer");
  chip.click(); await settle();
  assert.ok(p.requests.some((r) => r.pathname === "clipboard" && r.text === "8f0e5a3c-1111-2222-3333-444455556666"));
  assert.ok(p.document.getElementById("hostDrawer").hidden, "copying does not open the drawer");
  const comp = p.document.querySelector('tr[data-id="host_COMPbbbb2222"]');
  assert.match(comp.textContent, /complimentary/); assert.match(comp.textContent, /Complimentary/);
  const cancel = p.document.querySelector('tr[data-id="host_CANCcccc3333"]');
  assert.match(cancel.textContent, /Suspends in 3d/); assert.match(cancel.textContent, /other install/);
  const sel = p.document.getElementById("hostStage"); sel.value = "deleted"; sel.dispatchEvent(new p.window.Event("change"));
  assert.match(p.document.querySelector('tr[data-id="host_DELdddd4444"]').textContent, /Unpaid checkout/);
  for (const td of ready.querySelectorAll("td")) assert.ok(td.dataset.label || td.classList.contains("host-act"), "every cell is labelled for the phone card layout");
});

await test("every action in the … menu calls the same admin endpoint as before the redesign", async () => {
  const p = await page();
  const posts = () => p.requests.filter((r) => r.method === "POST").map((r) => r.pathname.replace("/hub", ""));
  menuButton(p.document, "host_READYaaaa1111", "Retry provisioning").click(); await settle();
  menuButton(p.document, "host_READYaaaa1111", "Force suspend").click(); await settle();
  menuButton(p.document, "host_READYaaaa1111", "Force delete").click(); await settle();
  menuButton(p.document, "host_READYaaaa1111", "Hold deletion").click(); await settle();
  menuButton(p.document, "host_PASTeeee5555", "Release hold").click(); await settle();
  menuButton(p.document, "host_CANCcccc3333", "Resume renewal").click(); await settle();
  menuButton(p.document, "host_COMPbbbb2222", "End complimentary").click(); await settle();
  assert.deepEqual(posts(), [
    "/admin/api/hosting/instances/host_READYaaaa1111/retry", "/admin/api/hosting/instances/host_READYaaaa1111/force-suspend", "/admin/api/hosting/instances/host_READYaaaa1111/force-delete",
    "/admin/api/hosting/instances/host_READYaaaa1111/hold", "/admin/api/hosting/instances/host_PASTeeee5555/release-hold", "/admin/api/hosting/instances/host_CANCcccc3333/resume-renewal",
    "/admin/api/hosting/instances/host_COMPbbbb2222/end-complimentary"]);
  for (const r of p.requests.filter((x) => x.method === "POST")) assert.equal(r.headers["x-hub-csrf"], "marketplace-config-v1");
  assert.equal(menuButton(p.document, "host_COMPbbbb2222", "Resume renewal"), undefined, "no renewal to resume on a complimentary server");
  assert.equal(menuButton(p.document, "host_READYaaaa1111", "End complimentary"), undefined);
  assert.equal(menuButton(p.document, "host_READYaaaa1111", "Resume renewal"), undefined, "resume renewal only on cancel_scheduled rows");
  menuButton(p.document, "host_READYaaaa1111", "Open app").click();
  assert.ok(p.requests.some((r) => r.pathname === "window.open" && r.url === "https://203.0.113.10/"));
});

await test("a row click opens the drawer with full ids, host keys, timeline and the instance's jobs; its actions are the same; Escape closes it", async () => {
  const p = await page();
  p.document.querySelector('tr[data-id="host_READYaaaa1111"] td').click();
  await settle(); await settle();
  const drawer = p.document.getElementById("hostDrawer");
  assert.equal(drawer.hidden, false);
  const text = drawer.textContent;
  for (const s of ["host_READYaaaa1111", "cus_VReady0001", "8f0e5a3c-1111-2222-3333-444455556666", "lic-ada-0001", "sub_ready", "SHA256:" + "A".repeat(43)]) assert.ok(text.includes(s), s);
  assert.match(text, /Server created/); assert.match(text, /Ready/); assert.match(text, /installation_ready/);
  assert.ok(p.requests.some((r) => r.pathname.endsWith("/admin/api/hosting/instances/host_READYaaaa1111/outbox")));
  const retry = [...drawer.querySelectorAll("#hostDrawerActions button")].find((b) => b.textContent === "Retry provisioning");
  retry.click(); await settle();
  assert.ok(p.requests.some((r) => r.method === "POST" && r.pathname.endsWith("/host_READYaaaa1111/retry")));
  p.document.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(drawer.hidden, true);
});

await test("the fleet-key dry run lists targets and says there is no channel", async () => {
  const p = await page();
  p.document.getElementById("hostFleetPlan").click(); await settle(); await settle();
  assert.ok(p.requests.some((r) => r.method === "POST" && r.pathname.endsWith("/admin/api/hosting/fleet-key/plan")));
  assert.match(p.document.getElementById("hostFleetNote").textContent, /1 live server\(s\) without a confirmed key/);
  assert.match(p.document.getElementById("hostFleetOut").textContent, /203\.0\.113\.10/);
  assert.ok(!p.requests.some((r) => r.pathname.endsWith("/fleet-key/apply")), "the page never calls apply");
});

for (const w of opened) w.close();
summary("admin-hosting-ui");
