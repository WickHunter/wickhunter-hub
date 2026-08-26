// Hostile coverage for the Hub-admin Marketplace configuration plane. The
// public Hub persists validated inputs but owns no trading/payment behavior.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { freshHub, jsonReq, test, summary, tmpDir } from "./helpers.mjs";
import {
  applyMarketplaceInputUpdate,
  decidePrivilegedMarketplaceProvider,
  listPrivilegedMarketplaceProviders,
  MARKETPLACE_INPUT_DEFINITIONS,
  MARKETPLACE_RESTART_UNITS,
  MarketplaceInputError,
  marketplaceInputSnapshot,
  readMarketplaceInputSnapshot,
} from "../dist/src/marketplace-inputs.js";

function fakeSpawner(outcomes = [0]) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    const code = outcomes.length ? outcomes.shift() : 0;
    queueMicrotask(() => child.emit("exit", code));
    return child;
  };
  return { calls, spawn };
}

function config(prefix = "marketplace-inputs") {
  const dir = tmpDir(prefix);
  return {
    dir,
    cfg: {
      envFile: path.join(dir, "marketplace.env"),
      hubBridgeEnvFile: path.join(dir, "hub-marketplace.env"),
    },
  };
}

const secretStatus = "status-secret-that-is-long-enough-123456789";
const vendorSecret = "bybit-vendor-secret-that-must-never-return";

await test("schema exposes every API/config input, separates public alpha material, and marks vendor values non-generated", () => {
  const byName = new Map(MARKETPLACE_INPUT_DEFINITIONS.map((field) => [field.name, field]));
  for (const name of [
    "HUB_MARKETPLACE_STATUS_ORIGIN", "HUB_MARKETPLACE_STATUS_CREDENTIAL",
    "MARKETPLACE_DATABASE_URL", "MARKETPLACE_INTENT_KEY_ID", "MARKETPLACE_INTENT_SIGNING_SEED",
    "MARKETPLACE_ALPHA_LICENCES", "MARKETPLACE_ALPHA_LICENCE_FEATURE_CONFIRMED",
    "MARKETPLACE_DEMO_MASTER_API_KEY", "MARKETPLACE_DEMO_MASTER_API_SECRET",
    "MARKETPLACE_DEMO_VAULT_KEY", "MARKETPLACE_DEMO_WORKER_CREDENTIAL",
    "MOONPAY_COMMERCE_PUBLIC_KEY", "MOONPAY_COMMERCE_SECRET_KEY",
    "MOONPAY_COMMERCE_RECIPIENTS_JSON", "MOONPAY_COMMERCE_MONTHLY_INTERVAL",
  ]) assert.ok(byName.has(name), name);
  assert.equal(byName.get("LIQHUNTER_MARKETPLACE_URL").secret, false);
  assert.equal(byName.get("LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS").secret, false);
  assert.equal(byName.get("MARKETPLACE_ALPHA_LICENCES").secret, true);
  assert.equal(byName.get("MARKETPLACE_DEMO_VAULT_KEY").generated, "vault");
  assert.equal(byName.get("MARKETPLACE_DEMO_WORKER_CREDENTIAL").generated, "worker");
  assert.equal(byName.get("MARKETPLACE_DEMO_MASTER_API_KEY").generated, undefined);
  assert.equal(byName.get("MOONPAY_COMMERCE_SECRET_KEY").generated, undefined);
  assert.deepEqual(
    MARKETPLACE_INPUT_DEFINITIONS.filter((field) => field.setup === "operator").map((field) => field.name),
    [
      "MARKETPLACE_DEMO_MASTER_API_KEY", "MARKETPLACE_DEMO_MASTER_API_SECRET",
      "MOONPAY_COMMERCE_PUBLIC_KEY", "MOONPAY_COMMERCE_SECRET_KEY",
      "MOONPAY_COMMERCE_WEBHOOK_SHARED_TOKEN", "MOONPAY_COMMERCE_PRICING_CURRENCY_ID",
      "MOONPAY_COMMERCE_RECIPIENTS_JSON",
    ],
    "the normal Hub form must contain only Bybit and MoonPay facts the operator has to supply",
  );
});

await test("automatic setup fills defaults, derives the public signer, mirrors the explicit alpha flags and preserves vendor inputs", async () => {
  const { cfg } = config("marketplace-automatic");
  cfg.publicMarketplaceOrigin = "https://alpha.wickhunter.example";
  let alphaLicences = ["lic_z", "lic_a", "lic_z"];
  cfg.alphaLicences = () => alphaLicences;
  const fake = fakeSpawner();
  const vendorKey = "bybit-key-from-the-operator";
  const vendorSecret = "bybit-secret-from-the-operator";
  const snapshot = await applyMarketplaceInputUpdate(cfg, {
    automatic: true,
    changes: {
      MARKETPLACE_DEMO_MASTER_API_KEY: vendorKey,
      MARKETPLACE_DEMO_MASTER_API_SECRET: vendorSecret,
    },
  }, fake.spawn);
  assert.equal(snapshot.operatorMissing.includes("MARKETPLACE_DEMO_MASTER_API_KEY"), false);
  assert.deepEqual([...snapshot.deploymentMissing].sort(), ["LIQHUNTER_HUB_KEY", "MARKETPLACE_BUILD_COMMIT", "MARKETPLACE_DATABASE_URL"].sort());
  const bytes = fs.readFileSync(cfg.envFile, "utf8");
  for (const expected of [
    'HUB_MARKETPLACE_STATUS_ORIGIN="http://127.0.0.1:8099"',
    'MARKETPLACE_ENABLED="1"', 'MARKETPLACE_HTTP_HOST="127.0.0.1"',
    'MARKETPLACE_HTTP_PORT="8099"', 'MARKETPLACE_STORE="postgres"',
    'MARKETPLACE_RUNTIME_DIRECTORY="/run/liqhunter-marketplace"',
    'LIQHUNTER_MARKETPLACE_URL="https://alpha.wickhunter.example"',
    'MARKETPLACE_ALPHA_LICENCES="lic_a,lic_z"',
    'MARKETPLACE_ADMIN_LICENCES="lic_a,lic_z"',
    'MARKETPLACE_ALPHA_LICENCE_FEATURE_CONFIRMED="1"',
    `MARKETPLACE_DEMO_MASTER_API_KEY="${vendorKey}"`,
  ]) assert.ok(bytes.includes(expected), expected);
  const seed = JSON.parse(bytes.match(/^MARKETPLACE_INTENT_SIGNING_SEED=(.*)$/m)[1]);
  const ring = JSON.parse(JSON.parse(bytes.match(/^LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS=(.*)$/m)[1]));
  assert.equal(Buffer.from(seed, "base64url").length, 32);
  assert.equal(Buffer.from(ring["marketplace-1"], "base64url").length, 32);
  assert.equal(JSON.stringify(snapshot).includes(seed), false, "the generated signing seed crossed the masked response");
  const bridge = fs.readFileSync(cfg.hubBridgeEnvFile, "utf8");
  assert.match(bridge, /HUB_MARKETPLACE_STATUS_CREDENTIAL=/);
  assert.doesNotMatch(bridge, /MARKETPLACE_INTENT|BYBIT|MOONPAY|DATABASE/);

  alphaLicences = [];
  const removed = await applyMarketplaceInputUpdate(cfg, { automatic: true }, fake.spawn);
  assert.ok(removed.automaticMissing.includes("MARKETPLACE_ALPHA_LICENCES"));
  const afterRemoval = fs.readFileSync(cfg.envFile, "utf8");
  assert.doesNotMatch(afterRemoval, /MARKETPLACE_(?:ALPHA|ADMIN)_LICENCES=/);
  assert.ok(afterRemoval.includes(`MARKETPLACE_DEMO_MASTER_API_KEY="${vendorKey}"`), "vendor input was not preserved during alpha sync");
});

await test("automatic setup keeps the optional Bybit Demo group wholly absent until both operator keys arrive", async () => {
  const { cfg } = config("marketplace-automatic-without-bybit");
  cfg.publicMarketplaceOrigin = "https://alpha.wickhunter.example";
  const fake = fakeSpawner();
  await applyMarketplaceInputUpdate(cfg, { automatic: true }, fake.spawn);
  const bytes = fs.readFileSync(cfg.envFile, "utf8");
  assert.doesNotMatch(bytes, /^MARKETPLACE_DEMO_(?:MASTER|VAULT|WORKER)_/m);
  assert.doesNotMatch(bytes, /^MOONPAY_COMMERCE_/m, "mock subscription mode keeps the optional MoonPay group wholly absent");
  await assert.rejects(
    () => applyMarketplaceInputUpdate(cfg, {
      automatic: true,
      changes: { MARKETPLACE_DEMO_MASTER_API_KEY: "only-one-half" },
    }, fake.spawn),
    /both Bybit Demo master credentials must be saved together/,
  );
});

await test("a successful update is atomic, 0600, masked, and restarts only the exact hardcoded private units", async () => {
  const { cfg } = config("marketplace-success");
  const fake = fakeSpawner();
  const snapshot = await applyMarketplaceInputUpdate(cfg, {
    changes: {
      HUB_MARKETPLACE_STATUS_ORIGIN: "http://127.0.0.1:8099",
      MARKETPLACE_ENABLED: "1",
      MARKETPLACE_STORE: "postgres",
      MARKETPLACE_DEMO_MASTER_API_SECRET: vendorSecret,
      LIQHUNTER_MARKETPLACE_URL: "https://alpha-marketplace.example.com",
      LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS: JSON.stringify({ "marketplace-1": Buffer.alloc(32, 7).toString("base64url") }),
      MARKETPLACE_ALPHA_LICENCES: "alpha-one,alpha-two",
      MARKETPLACE_ALPHA_LICENCE_FEATURE_CONFIRMED: "1",
    },
    generate: [
      "HUB_MARKETPLACE_STATUS_CREDENTIAL", "MARKETPLACE_OPERATOR_STATUS_CREDENTIAL",
      "MARKETPLACE_DEMO_VAULT_KEY", "MARKETPLACE_DEMO_WORKER_CREDENTIAL",
    ],
  }, fake.spawn);
  assert.equal(fs.statSync(cfg.envFile).mode & 0o777, 0o600);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].command, "systemctl");
  assert.deepEqual(fake.calls[0].args, ["restart", ...MARKETPLACE_RESTART_UNITS]);
  assert.equal(fake.calls[0].options.shell, false);
  const argv = JSON.stringify(fake.calls);
  assert.equal(argv.includes(vendorSecret), false, "a secret reached argv/options");
  const bytes = fs.readFileSync(cfg.envFile, "utf8");
  assert.ok(bytes.includes(vendorSecret), "the validated secret was not persisted");
  assert.match(bytes, /HUB_MARKETPLACE_STATUS_CREDENTIAL="([^"]+)"/);
  const hubStatus = bytes.match(/HUB_MARKETPLACE_STATUS_CREDENTIAL="([^"]+)"/)[1];
  const privateStatus = bytes.match(/MARKETPLACE_OPERATOR_STATUS_CREDENTIAL="([^"]+)"/)[1];
  assert.equal(hubStatus, privateStatus, "status pair drifted");
  const bridgeBytes = fs.readFileSync(cfg.hubBridgeEnvFile, "utf8");
  assert.ok(bridgeBytes.includes(hubStatus), "the bridge credential was not persisted for the Hub");
  for (const forbidden of [vendorSecret, "MARKETPLACE_DATABASE_URL", "MARKETPLACE_INTENT_SIGNING_SEED", "MOONPAY_COMMERCE_SECRET_KEY"]) {
    assert.equal(bridgeBytes.includes(forbidden), false, `private material crossed into the Hub bridge file: ${forbidden}`);
  }
  const serialized = JSON.stringify(snapshot);
  for (const secret of [vendorSecret, hubStatus]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(snapshot.fields.find((field) => field.name === "MARKETPLACE_DEMO_MASTER_API_SECRET").state, "configured");
  assert.equal(snapshot.fields.find((field) => field.name === "MARKETPLACE_DEMO_MASTER_API_SECRET").safeValue, undefined);
  assert.equal(snapshot.fields.find((field) => field.name === "LIQHUNTER_MARKETPLACE_URL").safeValue, "https://alpha-marketplace.example.com");
});

await test("unknown keys, short secrets, newline injection and vendor-key generation fail before write/restart without echo", async () => {
  for (const [changes, generate, forbidden, updateOverride] of [
    [{ NOT_A_MARKETPLACE_KEY: "hidden-unknown-value" }, [], "hidden-unknown-value"],
    [{ MARKETPLACE_DEMO_MASTER_API_SECRET: "short" }, [], "short"],
    [{ MOONPAY_COMMERCE_WEBHOOK_SHARED_TOKEN: "tiny" }, [], "tiny"],
    [{ MARKETPLACE_DATABASE_URL: "postgres://u:secret@db/name\nSYSTEMD_UNIT=evil" }, [], "SYSTEMD_UNIT=evil"],
    [{}, ["MARKETPLACE_DEMO_MASTER_API_KEY"], "MARKETPLACE_DEMO_MASTER_API_KEY"],
    [{}, ["MOONPAY_COMMERCE_SECRET_KEY"], "MOONPAY_COMMERCE_SECRET_KEY"],
    [{}, [], "ignored", { ignored: "silent-typo" }],
  ]) {
    const { cfg } = config("marketplace-refuse");
    const fake = fakeSpawner();
    let thrown;
    try { await applyMarketplaceInputUpdate(cfg, updateOverride || { changes, generate }, fake.spawn); }
    catch (error) { thrown = error; }
    assert.ok(thrown instanceof MarketplaceInputError);
    assert.equal(fs.existsSync(cfg.envFile), false);
    assert.equal(fs.existsSync(cfg.hubBridgeEnvFile), false);
    assert.equal(fake.calls.length, 0);
    assert.equal(thrown.message.includes(forbidden), false, `error echoed ${forbidden}`);
  }
});

await test("symlink, symlink-directory and nonregular destinations are refused", () => {
  const real = config("marketplace-path-real");
  fs.writeFileSync(real.cfg.envFile, "", { mode: 0o600 });
  const linked = config("marketplace-path-link");
  const linkFile = path.join(linked.dir, "linked.env");
  fs.symlinkSync(real.cfg.envFile, linkFile);
  assert.throws(() => marketplaceInputSnapshot({ envFile: linkFile }), /regular file.*symlink/);

  const linkParentRoot = tmpDir("marketplace-parent-link");
  const linkParent = path.join(linkParentRoot, "linked-parent");
  fs.symlinkSync(real.dir, linkParent);
  assert.throws(() => marketplaceInputSnapshot({ envFile: path.join(linkParent, "marketplace.env") }), /real directory/);

  const odd = config("marketplace-path-odd");
  fs.mkdirSync(odd.cfg.envFile);
  assert.throws(() => marketplaceInputSnapshot(odd.cfg), /regular file/);
});

await test("existing malformed values are invalid and never echoed as configured", () => {
  const { cfg } = config("marketplace-existing-invalid");
  fs.writeFileSync(cfg.envFile, 'MARKETPLACE_HTTP_PORT="not-a-port"\nMOONPAY_COMMERCE_SECRET_KEY="tiny"\n', { mode: 0o600 });
  const snapshot = marketplaceInputSnapshot(cfg);
  assert.equal(snapshot.fields.find((field) => field.name === "MARKETPLACE_HTTP_PORT").state, "invalid");
  assert.equal(snapshot.fields.find((field) => field.name === "MOONPAY_COMMERCE_SECRET_KEY").state, "invalid");
  assert.equal(JSON.stringify(snapshot).includes("not-a-port"), false);
  assert.equal(JSON.stringify(snapshot).includes("tiny"), false);
});

await test("the unprivileged client sends bounded stdin to one fixed helper and validates masked replies", async () => {
  const direct = config("marketplace-helper-snapshot");
  const snapshot = marketplaceInputSnapshot(direct.cfg);
  const calls = [];
  const responses = [
    { ok: true, config: snapshot },
    { ok: true, config: snapshot },
    { ok: true, providers: [{ id: "prov_1", displayName: "Provider One", status: "submitted", createdAtMs: 1, updatedAtMs: 2 }] },
    { ok: true, provider: { id: "prov_1", displayName: "Provider One", status: "approved", createdAtMs: 1, updatedAtMs: 3 } },
  ];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    const chunks = [];
    child.stdin = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    child.stdin.on("finish", () => {
      calls.push({ command, args, options, request: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      child.stdout.end(JSON.stringify(responses.shift()));
      queueMicrotask(() => child.emit("exit", 0));
    });
    return child;
  };
  const helperCfg = { ...direct.cfg, rootHelper: "/usr/local/libexec/wickhunter-hub-root-helper" };
  await readMarketplaceInputSnapshot(helperCfg, spawn);
  await applyMarketplaceInputUpdate(helperCfg, { automatic: true }, spawn);
  const providers = await listPrivilegedMarketplaceProviders(helperCfg, spawn);
  const decided = await decidePrivilegedMarketplaceProvider(helperCfg, {
    providerId: "prov_1", to: "approved", reason: "manual review passed", idempotencyKey: "provider-decision-1",
  }, spawn);
  assert.equal(providers[0].status, "submitted");
  assert.equal(decided.status, "approved");
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.command, "sudo");
    assert.deepEqual(call.args, ["-n", "/usr/local/libexec/wickhunter-hub-root-helper"]);
    assert.deepEqual(call.options.stdio, ["pipe", "pipe", "ignore"]);
    assert.equal(call.options.shell, false);
    assert.equal(JSON.stringify(call.args).includes("prov_1"), false, "request data crossed into argv");
  }
  assert.deepEqual(calls.map((call) => call.request.action), ["snapshot", "apply", "provider-list", "provider-decision"]);
});

await test("restart failure restores exact prior bytes and recovery uses the same unit allowlist", async () => {
  const { cfg } = config("marketplace-rollback");
  await applyMarketplaceInputUpdate(cfg, {
    changes: {
      HUB_MARKETPLACE_STATUS_ORIGIN: "http://127.0.0.1:8099",
      HUB_MARKETPLACE_STATUS_CREDENTIAL: secretStatus,
      MARKETPLACE_OPERATOR_STATUS_CREDENTIAL: secretStatus,
      MARKETPLACE_ENABLED: "1",
    },
  }, fakeSpawner().spawn);
  const before = fs.readFileSync(cfg.envFile);
  const beforeBridge = fs.readFileSync(cfg.hubBridgeEnvFile);
  const fake = fakeSpawner([1, 0]);
  await assert.rejects(
    applyMarketplaceInputUpdate(cfg, { changes: { MARKETPLACE_HTTP_PORT: "8100" } }, fake.spawn),
    /previous root-only environment file was restored/,
  );
  assert.deepEqual(fs.readFileSync(cfg.envFile), before);
  assert.deepEqual(fs.readFileSync(cfg.hubBridgeEnvFile), beforeBridge);
  assert.equal(fs.statSync(cfg.envFile).mode & 0o777, 0o600);
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) assert.deepEqual(call.args, ["restart", ...MARKETPLACE_RESTART_UNITS]);
});

await test("admin config endpoint enforces auth plus JSON/CSRF and returns only masked state", async () => {
  const { cfg } = config("marketplace-http");
  const fake = fakeSpawner();
  const h = await freshHub({ marketplaceInputs: cfg }, { spawn: fake.spawn });
  try {
    assert.equal((await jsonReq(`${h.origin}/admin/api/marketplace-config`)).status, 401);
    const auth = { "x-hub-admin": h.cfg.adminToken };
    const get = await jsonReq(`${h.origin}/admin/api/marketplace-config`, { headers: auth });
    assert.equal(get.status, 200);
    assert.equal(get.body.config.fields.some((field) => field.name === "MARKETPLACE_ALPHA_LICENCES"), true);
    const noCsrf = await jsonReq(`${h.origin}/admin/api/marketplace-config`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ generate: ["MARKETPLACE_DEMO_VAULT_KEY"] }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(fake.calls.length, 0);
    const crossSite = await jsonReq(`${h.origin}/admin/api/marketplace-config`, {
      method: "POST", headers: { ...auth, "x-hub-csrf": "marketplace-config-v1", "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ generate: ["MARKETPLACE_DEMO_VAULT_KEY"] }),
    });
    assert.equal(crossSite.status, 403);
    const secret = "worker-credential-that-stays-server-side-123";
    const saved = await jsonReq(`${h.origin}/admin/api/marketplace-config`, {
      method: "POST", headers: { ...auth, "x-hub-csrf": "marketplace-config-v1", "content-type": "application/json" },
      body: JSON.stringify({ changes: { MARKETPLACE_DEMO_WORKER_CREDENTIAL: secret } }),
    });
    assert.equal(saved.status, 200);
    assert.equal(JSON.stringify(saved.body).includes(secret), false);
    assert.equal(saved.body.config.fields.find((field) => field.name === "MARKETPLACE_DEMO_WORKER_CREDENTIAL").state, "configured");
    assert.equal(fake.calls.length, 1);
  } finally { await h.close(); }
});

await test("Hub provider approval UI routes only through the fixed helper with written-reason CSRF", async () => {
  const direct = config("marketplace-provider-http");
  const requests = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    const chunks = [];
    child.stdin = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    child.stdin.on("finish", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ command, args, options, request });
      const provider = {
        id: "prov_waiting", displayName: "Waiting Provider",
        status: request.action === "provider-decision" ? "approved" : "submitted",
        createdAtMs: 10, updatedAtMs: 20,
      };
      child.stdout.end(JSON.stringify(request.action === "provider-list"
        ? { ok: true, providers: [provider] }
        : { ok: true, provider }));
      queueMicrotask(() => child.emit("exit", 0));
    });
    return child;
  };
  const h = await freshHub({ marketplaceInputs: {
    ...direct.cfg, rootHelper: "/usr/local/libexec/wickhunter-hub-root-helper",
  } }, { spawn });
  const auth = { "x-hub-admin": h.cfg.adminToken };
  try {
    assert.equal((await jsonReq(`${h.origin}/admin/api/marketplace-providers`)).status, 401);
    const listed = await jsonReq(`${h.origin}/admin/api/marketplace-providers`, { headers: auth });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.providers[0].status, "submitted");
    const noCsrf = await jsonReq(`${h.origin}/admin/api/marketplace-providers/prov_waiting/decision`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: "approved", reason: "manual review passed", idempotencyKey: "provider-decision-1" }),
    });
    assert.equal(noCsrf.status, 403);
    const decided = await jsonReq(`${h.origin}/admin/api/marketplace-providers/prov_waiting/decision`, {
      method: "POST", headers: { ...auth, "x-hub-csrf": "marketplace-config-v1", "content-type": "application/json" },
      body: JSON.stringify({ to: "approved", reason: "manual review passed", idempotencyKey: "provider-decision-1" }),
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.provider.status, "approved");
    assert.deepEqual(requests.map((row) => row.request.action), ["provider-list", "provider-decision"]);
    assert.equal(requests.every((row) => row.command === "sudo" && row.args.length === 2), true);
  } finally { await h.close(); }
});

await test("desktop/mobile admin workflow shows only vendor inputs and keeps technical facts collapsed", () => {
  const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /id="mktConfigForm"/);
  assert.match(html, /\/admin\/api\/marketplace-config/);
  assert.match(html, /Save setup and configure everything else/);
  assert.match(html, /Advanced technical diagnostics/);
  assert.match(html, /field\.setup === "operator"/);
  assert.match(html, /Bybit Demo account creation/);
  assert.match(html, /MoonPay crypto payments \(optional — mocked for now\)/);
  assert.match(html, /data-moonpay-recipient-part/);
  assert.match(html, /Enable Marketplace for this licence only/);
  assert.match(html, /Provider approvals/);
  assert.match(html, /\/admin\/api\/marketplace-providers/);
  assert.match(html, /Required audit reason/);
  assert.match(html, /flag: "marketplace"/);
  assert.match(html, /data-hub-page="licenses"/);
  assert.match(html, /data-hub-page="market-data"/);
  assert.match(html, /data-hub-page="marketplace"/);
  assert.match(html, /data-hub-page="system"/);
  assert.match(html, /function showHubPage/);
  assert.match(html, /Licenses &amp; installs/);
  assert.match(html, /System &amp; feedback/);
  assert.doesNotMatch(html, /Generate shared status credential/);
  assert.doesNotMatch(html, /Generate Demo vault key/);
  assert.doesNotMatch(html, /Generate Demo worker credential/);
  assert.match(html, /\.configfields \{ grid-template-columns:1fr; \}/);
  assert.match(html, /field\.state !== "missing"/);
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(html));
});

await test("the public Hub is unprivileged and can invoke only the fixed root helper", () => {
  const installer = fs.readFileSync(new URL("../install-hub.sh", import.meta.url), "utf8");
  const unit = installer.slice(installer.indexOf('say "Installing the unprivileged systemd service'));
  assert.match(unit, /EnvironmentFile=-\$MARKETPLACE_BRIDGE_ENV_FILE/);
  assert.doesNotMatch(unit, /EnvironmentFile=-?\$MARKETPLACE_STATE_ENV_FILE/);
  assert.match(unit, /User=\$SERVICE_USER/);
  assert.match(unit, /Group=\$SERVICE_USER/);
  assert.match(installer, /NOPASSWD: %s/);
  assert.match(installer, /dist\/bin\/root-helper\.js/);
  assert.match(installer, /for private_file in "\$MARKETPLACE_STATE_ENV_FILE" "\$MARKETPLACE_BRIDGE_ENV_FILE"/);
  assert.match(installer, /chmod 600 "\$private_file"/);
  const helper = fs.readFileSync(new URL("../bin/root-helper.ts", import.meta.url), "utf8");
  assert.match(helper, /demo-vault-import-cli\.js/);
  assert.match(helper, /input: Buffer\.from\(JSON\.stringify\(\{ apiKey, apiSecret \}\)/);
  assert.doesNotMatch(helper, /args.*apiKey|args.*apiSecret/);
  assert.match(helper, /provider-decision/);
  assert.match(helper, /written reason|row\.reason\.length < 8/);
});

summary("marketplace-inputs");
