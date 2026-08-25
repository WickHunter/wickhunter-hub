import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import {
  fetchMarketplaceStatus,
  marketplaceStatusBridgeFromEnv,
} from "../dist/src/marketplace-status.js";

const bridgeSecret = "status-bridge-secret-value-1234567890";
const databaseSecret = "postgres://operator:supersecret@127.0.0.1/marketplace";
const apiSecret = "moonpay-secret-value-that-must-never-render";
const webhookSecret = "webhook-token-that-must-never-render-anywhere";
const alphaOrigin = "https://alpha-marketplace.example.com";
const alphaPublicKeyring = JSON.stringify({ "marketplace-1": "q".repeat(43) });
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

const modernPrivateEnvelope = {
  ok: true,
  status: {
    ...privateEnvelope.status,
    alphaClient: {
      state: "ready", audience: "alpha",
      origin: { state: "configured", reachability: "healthy", rawUrl: alphaOrigin },
      intentPublicKeyDistribution: { state: "aligned", publicKey: alphaPublicKeyring },
      licenceFeature: { state: "confirmed", credential: bridgeSecret },
      probeError: `Authorization: Bearer ${apiSecret}`,
    },
    storage: {
      ...privateEnvelope.status.storage,
      migrations: {
        ...privateEnvelope.status.storage.migrations,
        invalidEntries: 2,
        state: "blocked",
      },
    },
    requiredInputs: [
      ...privateEnvelope.status.requiredInputs,
      { name: "LIQHUNTER_MARKETPLACE_URL", state: "configured", secret: false,
        detail: "The exact public alpha origin is configured and reachable.", action: "Keep it aligned on every alpha client.", safeValue: "sha256:123456789abc" },
      { name: "LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", state: "configured", secret: false,
        detail: "The distributed verifier matches the live signer.", action: "Ship it before enabling signals.", safeValue: "sha256:abcdef123456" },
      { name: "MARKETPLACE_ALPHA_LICENCE_FEATURE_CONFIRMED", state: "configured", secret: false,
        detail: "The alpha licence cohort feature grant is confirmed.", action: "Keep beta excluded.", safeValue: "confirmed" },
    ],
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
    return { ok: true, status: 200, text: async () => JSON.stringify(modernPrivateEnvelope) };
  }, () => 1_700_000_000_100);
  assert.equal(call.url, "http://127.0.0.1:8099/api/marketplace/operator/status");
  assert.equal(call.init.headers.authorization, `Bearer ${bridgeSecret}`);
  assert.equal(call.init.redirect, "error", "a private response cannot redirect the server credential off-loopback");
  assert.equal(result.bridge.state, "connected");
  assert.equal(result.upstream.service.audience, "alpha");
  assert.equal(result.upstream.service.betaIncluded, false);
  assert.deepEqual(result.upstream.alphaClient, {
    state: "ready", audience: "alpha",
    origin: { state: "configured", reachability: "healthy" },
    intentPublicKeyDistribution: { state: "aligned" },
    licenceFeature: { state: "confirmed" },
  });
  assert.equal(result.upstream.storage.migrations.invalidEntries, 2);
  assert.equal(result.upstream.bybitDemo.targetInitialEquityUsdt, "10000");
  assert.equal(result.upstream.moonPay.revenueShareEnabled, false);
  assert.equal(result.requiredInputs.find((v) => v.name === "MOONPAY_COMMERCE_ENVIRONMENT").safeValue, "development");
  assert.equal(result.requiredInputs.find((v) => v.name === "MARKETPLACE_DATABASE_URL").safeValue, undefined);
  const serialized = JSON.stringify(result);
  for (const secret of [bridgeSecret, databaseSecret, "supersecret", apiSecret, webhookSecret, alphaOrigin, alphaPublicKeyring]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(serialized, /redacted/);
});

await test("admin endpoint is gated, returns sanitized alpha status, and never exposes its bearer to the browser", async () => {
  const calls = [];
  const h = await freshHub({ marketplaceStatus: config }, {
    marketplaceStatusFetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(modernPrivateEnvelope) };
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
    assert.equal(status.body.marketplace.upstream.alphaClient.state, "ready");
    assert.equal(status.body.marketplace.upstream.storage.migrations.invalidEntries, 2);
    const serialized = JSON.stringify(status.body);
    for (const secret of [bridgeSecret, databaseSecret, apiSecret, webhookSecret, alphaOrigin, alphaPublicKeyring]) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.equal(calls.length, 1);
    const html = await (await fetch(`${h.origin}/admin`)).text();
    assert.match(html, /Marketplace operations/);
    assert.match(html, /alpha only/);
    assert.match(html, /\/admin\/api\/marketplace-status/);
    assert.match(html, /id="mktInputs"/);
    assert.match(html, /"alphaClient"/);
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
  const privateNames = [
    "MARKETPLACE_ENABLED", "MARKETPLACE_HTTP_HOST", "MARKETPLACE_HTTP_PORT", "MARKETPLACE_STORE",
    "MARKETPLACE_WORKER_INTERVAL_MS", "MARKETPLACE_OUTBOX_BATCH", "MARKETPLACE_SHUTDOWN_GRACE_MS",
    "MARKETPLACE_DATABASE_URL", "MARKETPLACE_INTENT_KEY_ID", "MARKETPLACE_INTENT_SIGNING_SEED",
    "MARKETPLACE_OPERATOR_STATUS_CREDENTIAL", "MARKETPLACE_RUNTIME_DIRECTORY", "MARKETPLACE_BUILD_COMMIT",
    "LIQHUNTER_HUB_KEY", "MARKETPLACE_ADMIN_LICENCES", "MARKETPLACE_DEMO_MASTER_API_KEY",
    "MARKETPLACE_DEMO_MASTER_API_SECRET", "MARKETPLACE_DEMO_VAULT_PATH", "MARKETPLACE_DEMO_VAULT_KEY",
    "MARKETPLACE_DEMO_WORKER_CREDENTIAL", "MARKETPLACE_DEMO_EVIDENCE_INTERVAL_MS",
    "MARKETPLACE_DEMO_EVIDENCE_MAX_AGE_MS", "MOONPAY_COMMERCE_ENVIRONMENT", "MOONPAY_COMMERCE_PUBLIC_KEY",
    "MOONPAY_COMMERCE_SECRET_KEY", "MOONPAY_COMMERCE_WEBHOOK_SHARED_TOKEN",
    "MOONPAY_COMMERCE_PRICING_CURRENCY_ID", "MOONPAY_COMMERCE_PRICING_ASSET",
    "MOONPAY_COMMERCE_RECIPIENTS_JSON", "MOONPAY_COMMERCE_MONTHLY_INTERVAL",
    "MOONPAY_COMMERCE_YEARLY_INTERVAL", "LIQHUNTER_MARKETPLACE_URL",
    "LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", "MARKETPLACE_ALPHA_LICENCE_FEATURE_CONFIRMED",
    "MARKETPLACE_ALPHA_LICENCES",
  ];
  for (const required of ["HUB_MARKETPLACE_STATUS_ORIGIN", "HUB_MARKETPLACE_STATUS_CREDENTIAL", ...privateNames]) {
    assert.ok(names.includes(required), required);
    const row = absent.requiredInputs.find((value) => value.name === required);
    assert.ok(row.action.length > 0, `${required} action`);
  }
  assert.equal(new Set(names).size, names.length, "the checklist has no duplicate variable rows");
  assert.equal(absent.requiredInputs.find((value) => value.name === "MARKETPLACE_ADMIN_LICENCES").secret, true);
  assert.equal(absent.requiredInputs.find((value) => value.name === "MARKETPLACE_ALPHA_LICENCES").secret, true);
  assert.equal(absent.requiredInputs.find((value) => value.name === "MOONPAY_COMMERCE_PUBLIC_KEY").secret, true);
  assert.ok(absent.readinessBlockers.length > 0);
});

await test("the additive alpha fields remain compatible with an older private status response", async () => {
  const legacy = await fetchMarketplaceStatus(config, async () => ({
    ok: true, status: 200, text: async () => JSON.stringify(privateEnvelope),
  }));
  assert.equal(legacy.bridge.state, "connected");
  assert.equal(legacy.upstream.alphaClient, undefined);
  assert.equal(legacy.upstream.storage.migrations.invalidEntries, undefined);
  assert.equal(legacy.upstream.service.betaIncluded, false);
  assert.ok(legacy.readinessBlockers.some((value) => value.includes("alpha-client readiness proof")));
});

await test("malformed additive counts and alpha proof fields fail closed without echoing hostile values", async () => {
  const hostile = structuredClone(modernPrivateEnvelope);
  hostile.status.alphaClient.state = "ready";
  hostile.status.alphaClient.origin.state = "configured";
  hostile.status.alphaClient.origin.reachability = "healthy";
  hostile.status.alphaClient.intentPublicKeyDistribution.state = "aligned";
  hostile.status.alphaClient.licenceFeature.state = "confirmed";
  hostile.status.alphaClient.audience = "beta";
  hostile.status.alphaClient.rawCredential = bridgeSecret;
  hostile.status.storage.migrations.invalidEntries = -1;
  const result = await fetchMarketplaceStatus(config, async () => ({
    ok: true, status: 200, text: async () => JSON.stringify(hostile),
  }));
  assert.equal(result.upstream.storage.migrations.invalidEntries, undefined);
  assert.equal(result.upstream.alphaClient, undefined, "non-alpha proof must not be rendered");
  assert.ok(result.readinessBlockers.some((value) => value.includes("alpha-client readiness proof")));
  assert.ok(result.readinessBlockers.some((value) => value.includes("migration-history count")));
  const serialized = JSON.stringify(result);
  for (const forbidden of [bridgeSecret, alphaOrigin, alphaPublicKeyring, apiSecret]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const inconsistent = structuredClone(modernPrivateEnvelope);
  inconsistent.status.alphaClient.intentPublicKeyDistribution.state = "mismatched";
  const contradiction = await fetchMarketplaceStatus(config, async () => ({
    ok: true, status: 200, text: async () => JSON.stringify(inconsistent),
  }));
  assert.equal(contradiction.upstream.alphaClient, undefined, "a ready label cannot override mismatched proof facts");
});

await test("mobile checklist keeps state, detail and operator action visible without horizontal discovery", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /#mktInputs td\[data-label\]::before/);
  assert.match(html, /data-label="Required input"/);
  assert.match(html, /data-label="State"/);
  assert.match(html, /data-label="Safe value or detail"/);
  assert.match(html, /data-label="Operator action"/);
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
