// tests/hosting-guardrails.test.mjs — narrow production guardrails around
// provider cost accounting and billing failure copy/transport handling.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, summary } from "./helpers.mjs";
import { exceptionEmail } from "../dist/src/hosting/emails.js";
import { VultrProvider } from "../dist/src/hosting/provider.js";
import { HostingService } from "../dist/src/hosting/service.js";

await test("Vultr plan quotes preserve a real positive monthly cost", async () => {
  const provider = new VultrProvider("test-key", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ plans: [{ id: "vc2-1c-2gb", vcpu_count: 1, ram: 2048, disk: 55, monthly_cost: "10.00" }] }),
  }));
  assert.deepEqual(await provider.listPlans(), [{ id: "vc2-1c-2gb", vcpus: 1, ramMb: 2048, diskGb: 55, monthlyCostCents: 1000 }]);
});

await test("Vultr plan quotes reject missing, malformed, and zero costs", async () => {
  for (const monthly_cost of [undefined, "not-a-price", 0]) {
    const provider = new VultrProvider("test-key", async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ plans: [{ id: "vc2-1c-2gb", monthly_cost }] }),
    }));
    await assert.rejects(() => provider.listPlans(), /invalid monthly_cost/);
  }
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

await test("setup failure email never claims a refund that the lifecycle did not verify", () => {
  const message = exceptionEmail("customer@example.com", "setup_failure", "host_123", "Setup timed out.", "https://hub.example.com/customer#hosting");
  assert.doesNotMatch(message.text, /has been refunded/i);
  assert.match(message.text, /confirm the status of your initial hosting payment separately/i);
  assert.doesNotMatch(message.html, /has been refunded/i);
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

summary("hosting-guardrails");
