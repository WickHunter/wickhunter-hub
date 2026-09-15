// tests/hosting-guardrails.test.mjs — narrow production guardrails around
// provider cost accounting and billing failure copy/transport handling.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { freshHub, test, summary } from "./helpers.mjs";
import { exceptionEmail } from "../dist/src/hosting/emails.js";
import { VultrProvider } from "../dist/src/hosting/provider.js";
import { HostingService } from "../dist/src/hosting/service.js";

await test("personalized installer generates credentials without a controlling terminal", () => {
  const installer = fs.readFileSync(new URL("../templates/install.sh", import.meta.url), "utf8");
  const start = installer.indexOf("ask() {");
  const end = installer.indexOf("\n}\n", start) + 3;
  assert.ok(start >= 0 && end > start);
  const script = "set -Eeuo pipefail\n" + installer.slice(start, end) + `
SECRET=before
ask SECRET "Secret: " --secret
[ -z "$SECRET" ]
[ -n "$SECRET" ] || SECRET=$(openssl rand -hex 32)
[ "\${#SECRET}" -eq 64 ]
LOGIN_PW=before
ask LOGIN_PW "Password: "
[ -z "$LOGIN_PW" ]
printf 'unattended-credential-fallback-ok'
`;
  // detached starts a new session: /dev/tty can exist and be readable, but
  // opening it must fail just as it does under real cloud-init.
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", detached: true, timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "unattended-credential-fallback-ok");
  assert.equal(result.stderr, "");
});

await test("installer refuses completion until trusted HTTPS serves the signed version", () => {
  const installer = fs.readFileSync(new URL("../templates/install.sh", import.meta.url), "utf8");
  const start = installer.indexOf("verify_public_https() {");
  const end = installer.indexOf("\n}\n", start) + 3;
  assert.ok(start >= 0 && end > start);
  assert.match(installer, /LIQHUNTER_REQUIRE_HTTPS=1/);
  assert.ok(installer.indexOf('verify_public_https "$PUBLIC_IP"') < installer.indexOf('ok "URL:'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-installer-https-"));
  try {
    for (const [body, transportOk, accepted] of [
      [{ ok: true, version: "0.90.93" }, true, true],
      [{ ok: true, version: "0.90.92" }, true, false],
      [{ ok: false, version: "0.90.93" }, true, false],
      ["invalid-json", true, false],
      [{ ok: true, version: "0.90.93" }, false, false],
    ]) {
      const script = 'set -Eeuo pipefail\nREL_VERSION=0.90.93\n'
        + 'fetch_bounded() { [ "$MOCK_TRANSPORT" = true ] || return 1; printf "%s" "$MOCK_BODY" > "$2"; }\n'
        + installer.slice(start, end) + '\nverify_public_https 192.0.2.10 "$MOCK_FILE"';
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5_000,
        env: { ...process.env, MOCK_TRANSPORT: String(transportOk), MOCK_BODY: typeof body === "string" ? body : JSON.stringify(body), MOCK_FILE: path.join(dir, "health.json") } });
      assert.equal(result.status === 0, accepted, result.stderr);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test("Vultr plan quotes preserve a real positive monthly cost", async () => {
  const provider = new VultrProvider("test-key", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ plans: [{ id: "vc2-1c-2gb", vcpu_count: 1, ram: 2048, disk: 55, monthly_cost: "10.00" }] }),
  }));
  assert.deepEqual(await provider.listPlans(), [{ id: "vc2-1c-2gb", vcpus: 1, ramMb: 2048, diskGb: 55, monthlyCostCents: 1000 }]);
});

await test("Vultr plan quotes reject missing, malformed, negative, and unsafe costs", async () => {
  for (const monthly_cost of [undefined, null, "", " ", false, [], {}, -1, "-1", "not-a-price", 1e20]) {
    const provider = new VultrProvider("test-key", async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ plans: [{ id: "vc2-1c-2gb", monthly_cost }] }),
    }));
    await assert.rejects(() => provider.listPlans(), /invalid monthly_cost/);
  }
});

await test("Vultr free plan inventory does not block a paid plan quote", async () => {
  const provider = new VultrProvider("test-key", async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ plans: [
      { id: "vc2-1c-0.5gb-free", monthly_cost: 0 },
      { id: "vc2-1c-2gb", monthly_cost: "10.00" },
    ] }),
  }));
  const plans = await provider.listPlans();
  assert.equal(plans[0].monthlyCostCents, 0);
  assert.equal(plans.find(p => p.id === "vc2-1c-2gb").monthlyCostCents, 1000);
});

await test("Vultr plan lookup rejects an unsuccessful or malformed response", async () => {
  for (const response of [
    { ok: false, status: 503, text: async () => JSON.stringify({ error: "unavailable" }) },
    { ok: true, status: 200, text: async () => JSON.stringify({ plans: null }) },
  ]) {
    const provider = new VultrProvider("test-key", async () => response);
    await assert.rejects(() => provider.listPlans(), /returned no plan list/);
  }
});

await test("Vultr calls time out across both response headers and response body", async () => {
  for (const http of [
    async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    async () => ({ ok: true, status: 200, text: async () => new Promise(() => {}) }),
  ]) {
    const provider = new VultrProvider("test-key", http, 20);
    const started = Date.now();
    await assert.rejects(() => provider.listPlans(), /request timed out after 20ms/);
    assert.ok(Date.now() - started < 1_000, "a hung provider call cannot retain the lifecycle worker");
  }
});

await test("setup failure email never claims a refund that the lifecycle did not verify", () => {
  const message = exceptionEmail("customer@example.com", "setup_failure", "host_123", "Setup timed out.", "https://hub.example.com/customer#hosting");
  assert.doesNotMatch(message.text, /has been refunded/i);
  assert.doesNotMatch(message.text, /Renewal for this server has been stopped/i);
  assert.match(message.text, /request to stop renewal/i);
  assert.match(message.text, /confirm both the renewal status and the status of your initial hosting payment separately/i);
  assert.doesNotMatch(message.html, /has been refunded/i);
});

await test("late-payment recovery copy does not promise an unconfirmed refund", () => {
  const source = fs.readFileSync(new URL("../src/hosting/service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /The payment will be refunded/i);
  assert.match(source, /Support must confirm the hosting payment resolution/);
});

await test("Stripe cancellation and resume log non-2xx responses as failures", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-hosting-guardrails-"));
  const lines = [];
  const billing = {
    config: () => ({ mode: "live", stripe: { live: { secretKey: "sk_live_test" } } }),
  };
  const service = new HostingService(dataDir, billing, {}, "https://hub.example.com", {
    fetchLike: async () => ({ ok: false, status: 401, text: async () => "unauthorized" }),
    log: (line) => lines.push(line),
  });
  await service.bestEffortCancelStripeSubscription("sub_test", 0);
  await service.bestEffortResumeStripeSubscription("sub_test", 0);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /could not schedule Stripe cancellation.*HTTP 401/);
  assert.match(lines[1], /could not un-cancel Stripe subscription.*HTTP 401/);
});

await test("public hosting options are CORS-readable and fail closed while the master switch is off", async () => {
  const h = await freshHub();
  try {
    const response = await fetch(`${h.origin}/api/hosting/options`, { headers: { origin: "https://www.wickhunterunleashed.com" } });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(body.purchasable, false);
    assert.equal(body.priceIsProposed, true);
  } finally {
    await h.close();
  }
});

summary("hosting-guardrails");
