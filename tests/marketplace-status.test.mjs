import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import {
  fetchMarketplaceStatus,
  marketplaceStatusBridgeFromEnv,
} from "../dist/src/marketplace-status.js";

const bridgeSecret = "status-bridge-secret-value-1234567890";
const databaseSecret = "postgres://operator:supersecret@127.0.0.1/marketplace";
const apiSecret = "moonpay-secret-value-that-must-never-render";
const webhookSecret = "webhook-token-that-must-never-render-anywhere";
const config = marketplaceStatusBridgeFromEnv({
  HUB_MARKETPLACE_STATUS_ORIGIN: "http://127.0.0.1:8099",
  HUB_MARKETPLACE_STATUS_CREDENTIAL: bridgeSecret,
});

const privateEnvelope = {
  ok: true,
  status: {
    schemaVersion: "wickhunter-marketplace-operator-status/v1",
    generatedAtMs: 1_700_000_000_000,
    build: { version: "0.3.3", commit: "a".repeat(40) },
    service: { name: "wickhunter-marketplace", audience: "alpha", enabled: true, betaIncluded: false },
    api: { state: "running", bind: "127.0.0.1", port: 8099 },
    worker: { state: "running", passes: [] },
    storage: { state: "blocked", databaseUrl: databaseSecret,
      migrations: { expectedLatest: "0014_billing_reconciliation_resolution", state: "current" } },
    bybitDemo: { state: "blocked", targetInitialEquityUsdt: "10000", apiSecret },
    moonPay: { state: "blocked", mode: "crypto-only", cardsEnabled: false,
      revenueShareEnabled: false, webhook: { state: "missing", token: webhookSecret } },
    requiredInputs: [
      { name: "MARKETPLACE_DATABASE_URL", state: "configured", secret: true,
        detail: `database is ${databaseSecret}`, action: `DATABASE_URL=${databaseSecret}`, safeValue: databaseSecret },
      { name: "MOONPAY_COMMERCE_SECRET_KEY", state: "invalid", secret: true,
        detail: `Authorization: Bearer ${apiSecret}`, action: `MOONPAY_COMMERCE_SECRET_KEY=${apiSecret}` },
      { name: "MOONPAY_COMMERCE_ENVIRONMENT", state: "configured", secret: false,
        detail: "Development rail selected.", action: "Change only after end-to-end production validation.", safeValue: "development" },
    ],
    readiness: {
      state: "blocked",
      blockers: [`database ${databaseSecret}`, `Authorization: Bearer ${bridgeSecret}`],
      warnings: [`MOONPAY_COMMERCE_WEBHOOK_SHARED_TOKEN=${webhookSecret}`],
    },
  },
};

await test("bridge is atomic, loopback-only, and refuses invalid or half configuration", () => {
  assert.deepEqual(config.refusals, []);
  for (const env of [
    { HUB_MARKETPLACE_STATUS_ORIGIN: "https://marketplace.example" },
    { HUB_MARKETPLACE_STATUS_ORIGIN: "http://127.0.0.1:8099/path", HUB_MARKETPLACE_STATUS_CREDENTIAL: bridgeSecret },
    { HUB_MARKETPLACE_STATUS_CREDENTIAL: bridgeSecret },
  ]) {
    assert.ok(marketplaceStatusBridgeFromEnv(env).refusals.length > 0);
  }
});

await test("server-only bearer reaches the fixed status path and every secret-shaped response value is redacted", async () => {
  let call = null;
  const result = await fetchMarketplaceStatus(config, async (url, init) => {
    call = { url, init };
    return { ok: true, status: 200, text: async () => JSON.stringify(privateEnvelope) };
  }, () => 1_700_000_000_100);
  assert.equal(call.url, "http://127.0.0.1:8099/api/marketplace/operator/status");
  assert.equal(call.init.headers.authorization, `Bearer ${bridgeSecret}`);
  assert.equal(call.init.redirect, "error", "a private response cannot redirect the server credential off-loopback");
  assert.equal(result.bridge.state, "connected");
  assert.equal(result.upstream.service.audience, "alpha");
  assert.equal(result.upstream.service.betaIncluded, false);
  assert.equal(result.upstream.bybitDemo.targetInitialEquityUsdt, "10000");
  assert.equal(result.upstream.moonPay.revenueShareEnabled, false);
  assert.equal(result.requiredInputs.find((v) => v.name === "MOONPAY_COMMERCE_ENVIRONMENT").safeValue, "development");
  assert.equal(result.requiredInputs.find((v) => v.name === "MARKETPLACE_DATABASE_URL").safeValue, undefined);
  const serialized = JSON.stringify(result);
  for (const secret of [bridgeSecret, databaseSecret, "supersecret", apiSecret, webhookSecret]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(serialized, /redacted/);
});

await test("admin endpoint is gated, returns sanitized alpha status, and never exposes its bearer to the browser", async () => {
  const calls = [];
  const h = await freshHub({ marketplaceStatus: config }, {
    marketplaceStatusFetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(privateEnvelope) };
    },
  });
  try {
    assert.equal((await jsonReq(`${h.origin}/admin/api/marketplace-status`)).status, 401);
    const rawStatus = await fetch(`${h.origin}/admin/api/marketplace-status`, {
      headers: { "x-hub-admin": h.cfg.adminToken },
    });
    assert.equal(rawStatus.headers.get("cache-control"), "no-store");
    const status = { status: rawStatus.status, body: await rawStatus.json() };
    assert.equal(status.status, 200);
    assert.equal(status.body.marketplace.bridge.state, "connected");
    const serialized = JSON.stringify(status.body);
    for (const secret of [bridgeSecret, databaseSecret, apiSecret, webhookSecret]) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.equal(calls.length, 1);
    const html = await (await fetch(`${h.origin}/admin`)).text();
    assert.match(html, /Marketplace operations/);
    assert.match(html, /alpha only/);
    assert.match(html, /\/admin\/api\/marketplace-status/);
    assert.match(html, /id="mktInputs"/);
    assert.equal(html.includes(bridgeSecret), false);
  } finally { await h.close(); }
});

await test("an absent private service yields an exact static operator checklist without claiming readiness", async () => {
  const absent = await fetchMarketplaceStatus(marketplaceStatusBridgeFromEnv({}), async () => {
    throw new Error("must not fetch while unconfigured");
  });
  assert.equal(absent.bridge.state, "unconfigured");
  assert.equal(absent.upstream, null);
  const names = absent.requiredInputs.map((v) => v.name);
  for (const required of [
    "HUB_MARKETPLACE_STATUS_ORIGIN", "HUB_MARKETPLACE_STATUS_CREDENTIAL",
    "MARKETPLACE_DATABASE_URL", "MARKETPLACE_DEMO_VAULT_KEY",
    "MARKETPLACE_DEMO_WORKER_CREDENTIAL", "MOONPAY_COMMERCE_SECRET_KEY",
    "MOONPAY_COMMERCE_WEBHOOK_SHARED_TOKEN", "LIQHUNTER_MARKETPLACE_URL",
  ]) assert.ok(names.includes(required), required);
  assert.ok(absent.readinessBlockers.length > 0);
});

await test("a private credential refusal is distinguished from a network outage without echoing vendor text", async () => {
  const refused = await fetchMarketplaceStatus(config, async () => ({
    ok: false, status: 401, text: async () => JSON.stringify({ error: `wrong ${bridgeSecret} ${databaseSecret}` }),
  }));
  assert.equal(refused.bridge.state, "invalid");
  assert.equal(refused.requiredInputs.find((v) => v.name === "HUB_MARKETPLACE_STATUS_CREDENTIAL").state, "invalid");
  assert.equal(JSON.stringify(refused).includes(bridgeSecret), false);
  assert.equal(JSON.stringify(refused).includes(databaseSecret), false);
});

summary("marketplace-status");
