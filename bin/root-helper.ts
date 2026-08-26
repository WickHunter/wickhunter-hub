#!/usr/bin/env node
/** Fixed privileged boundary for Hub administration.
 *
 * The public HTTP process runs as `wickhunter-hub` and may execute exactly one
 * sudo command with no arguments. Requests arrive as bounded JSON on stdin.
 * This helper alone reads/writes split Marketplace role files, imports the
 * Bybit master directly into the encrypted worker vault, and restarts the
 * exact service allowlist. No secret is returned, logged, or placed in argv.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  applyMarketplaceInputUpdate,
  marketplaceInputSnapshot,
  MARKETPLACE_INPUT_DEFINITIONS,
  MARKETPLACE_RESTART_UNITS,
  type MarketplaceInputUpdate,
  type MarketplaceInputsConfig,
} from "../src/marketplace-inputs.js";
import { readFlags } from "../src/flags.js";

const HUB_DIR = "/opt/wickhunter-hub";
const APP_DIR = "/opt/liqhunter";
const HUB_ENV = "/etc/wickhunter-hub/env";
const STATE_ENV = "/etc/wickhunter-hub/marketplace-state.env";
const BRIDGE_ENV = "/etc/wickhunter-hub/marketplace.env";
const COMMON_ENV = "/etc/liqhunter/marketplace-common.env";
const API_ENV = "/etc/liqhunter/marketplace-api.env";
const WORKER_ENV = "/etc/liqhunter/marketplace-worker.env";
const MIGRATE_ENV = "/etc/liqhunter/marketplace-migrate.env";
const DATA_DIR = `${HUB_DIR}/data`;
const MAX_STDIN = 128 * 1024;
const MASTER_KEY_MARKER = "encrypted-in-worker-vault";
const MASTER_SECRET_MARKER = "encrypted-in-worker-vault-secret";

const COMMON = new Set([
  "MARKETPLACE_ENABLED", "MARKETPLACE_HTTP_HOST", "MARKETPLACE_HTTP_PORT", "MARKETPLACE_STORE",
  "MARKETPLACE_WORKER_INTERVAL_MS", "MARKETPLACE_OUTBOX_BATCH", "MARKETPLACE_SHUTDOWN_GRACE_MS",
  "MARKETPLACE_DATABASE_URL", "MARKETPLACE_INTENT_KEY_ID", "MARKETPLACE_RUNTIME_DIRECTORY",
  "MARKETPLACE_BUILD_COMMIT", "MARKETPLACE_ALPHA_LICENCES", "MARKETPLACE_DEMO_EVIDENCE_INTERVAL_MS",
  "MARKETPLACE_DEMO_EVIDENCE_MAX_AGE_MS", "LIQHUNTER_MARKETPLACE_URL",
  "LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", "MARKETPLACE_ALPHA_LICENCE_FEATURE_CONFIRMED",
  "LIQHUNTER_HUB_KEY", "MARKETPLACE_ADMIN_LICENCES",
]);
const API = new Set([
  "MARKETPLACE_OPERATOR_STATUS_CREDENTIAL", "MOONPAY_COMMERCE_ENVIRONMENT",
  "MOONPAY_COMMERCE_PUBLIC_KEY", "MOONPAY_COMMERCE_SECRET_KEY",
  "MOONPAY_COMMERCE_WEBHOOK_SHARED_TOKEN", "MOONPAY_COMMERCE_PRICING_CURRENCY_ID",
  "MOONPAY_COMMERCE_PRICING_ASSET", "MOONPAY_COMMERCE_RECIPIENTS_JSON",
  "MOONPAY_COMMERCE_MONTHLY_INTERVAL", "MOONPAY_COMMERCE_YEARLY_INTERVAL",
]);
const WORKER = new Set([
  "MARKETPLACE_INTENT_SIGNING_SEED", "MARKETPLACE_DEMO_VAULT_PATH",
  "MARKETPLACE_DEMO_VAULT_KEY", "MARKETPLACE_DEMO_WORKER_CREDENTIAL",
]);
const BRIDGE = new Set([
  "HUB_MARKETPLACE_STATUS_ORIGIN", "HUB_MARKETPLACE_STATUS_CREDENTIAL",
  "HUB_MARKETPLACE_STATUS_TIMEOUT_MS",
]);
const KNOWN = new Set(MARKETPLACE_INPUT_DEFINITIONS.map((field) => field.name));

function refuse(): never { throw new Error("privileged Marketplace request refused"); }

function readBoundedStdin(): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(8192);
    const read = fs.readSync(0, chunk, 0, chunk.length, null);
    if (read === 0) break;
    total += read;
    if (total > MAX_STDIN) refuse();
    chunks.push(chunk.subarray(0, read));
  }
  return Buffer.concat(chunks);
}

function safeFile(filename: string): Buffer | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(filename); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    refuse();
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) refuse();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}

function decodeEnv(bytes: Buffer | null): Map<string, string> {
  const out = new Map<string, string>();
  if (bytes === null) return out;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/\0|\r/.test(text)) refuse();
  for (const line of text.split("\n")) {
    if (line === "" || /^\s*#/.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null || out.has(match[1])) refuse();
    const raw = match[2];
    let value = raw;
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw); } catch { refuse(); }
    } else if (raw.startsWith("'") && raw.endsWith("'")) value = raw.slice(1, -1);
    if (typeof value !== "string" || value.length < 1 || /[\0\r\n]/.test(value)) refuse();
    out.set(match[1], value);
  }
  return out;
}

/** Read one Hub-owned value without treating a duplicate unrelated systemd
 * assignment as a Marketplace configuration failure. The requested value
 * itself must still be unique and every active line must remain an assignment. */
function oneEnvValue(bytes: Buffer | null, wanted: string): string | undefined {
  if (bytes === null) return undefined;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/\0|\r/.test(text)) refuse();
  let found: string | undefined;
  for (const line of text.split("\n")) {
    if (line === "" || /^\s*#/.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null) refuse();
    if (match[1] !== wanted) continue;
    if (found !== undefined) refuse();
    const raw = match[2];
    let value = raw;
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw); } catch { refuse(); }
    } else if (raw.startsWith("'") && raw.endsWith("'")) value = raw.slice(1, -1);
    if (typeof value !== "string" || value.length < 1 || /[\0\r\n]/.test(value)) refuse();
    found = value;
  }
  return found;
}

function quote(value: string): string { return JSON.stringify(value); }

function serialized(values: ReadonlyMap<string, string>, names?: ReadonlySet<string>): Buffer {
  const lines = ["# Managed by the fixed WickHunter Hub root helper. Never edit while services run."];
  for (const field of MARKETPLACE_INPUT_DEFINITIONS) {
    if (names !== undefined && !names.has(field.name)) continue;
    const value = values.get(field.name);
    if (value !== undefined) lines.push(`${field.name}=${quote(value)}`);
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function atomic(filename: string, bytes: Buffer, group: string | null, mode: number): void {
  const parent = path.dirname(filename);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) refuse();
  safeFile(filename);
  const temp = path.join(parent, `.${path.basename(filename)}.${process.pid}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, filename);
  if (group !== null) {
    const owned = spawnSync("chown", [`root:${group}`, filename], { stdio: "ignore", shell: false });
    if (owned.status !== 0) refuse();
  }
  fs.chmodSync(filename, mode);
  const dirFd = fs.openSync(parent, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

function publicOrigin(): string | undefined {
  const raw = oneEnvValue(safeFile(HUB_ENV), "HUB_PUBLIC_ORIGIN");
  if (raw === undefined) return undefined;
  try {
    const value = new URL(raw);
    return value.protocol === "https:" ? value.origin : undefined;
  } catch { return undefined; }
}

function directConfig(): MarketplaceInputsConfig {
  return {
    envFile: STATE_ENV,
    hubBridgeEnvFile: BRIDGE_ENV,
    helperOwnsRestart: true,
    publicMarketplaceOrigin: publicOrigin(),
    alphaLicences: () => Object.entries(readFlags(DATA_DIR).byLicense)
      .filter(([, flags]) => flags.marketplace === true)
      .map(([licenseId]) => licenseId),
  };
}

function seedState(): void {
  const stateBytes = safeFile(STATE_ENV);
  const values = decodeEnv(stateBytes);
  const deployment = new Set(MARKETPLACE_INPUT_DEFINITIONS
    .filter((field) => field.setup === "deployment").map((field) => field.name));
  for (const filename of [COMMON_ENV, API_ENV, WORKER_ENV, BRIDGE_ENV]) {
    for (const [name, value] of decodeEnv(safeFile(filename))) {
      if (KNOWN.has(name) && (!values.has(name) || deployment.has(name))) values.set(name, value);
    }
  }
  const vault = values.get("MARKETPLACE_DEMO_VAULT_PATH");
  if (vault !== undefined && safeFile(vault) !== null) {
    values.set("MARKETPLACE_DEMO_MASTER_API_KEY", MASTER_KEY_MARKER);
    values.set("MARKETPLACE_DEMO_MASTER_API_SECRET", MASTER_SECRET_MARKER);
  }
  const next = serialized(values);
  if (stateBytes === null || !stateBytes.equals(next)) atomic(STATE_ENV, next, null, 0o600);
}

function publicKey(seedB64u: string): string {
  const seed = Buffer.from(seedB64u, "base64url");
  if (seed.length !== 32 || seed.toString("base64url") !== seedB64u) refuse();
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const der = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }))
    .export({ format: "der", type: "spki" }) as Buffer;
  return der.subarray(-32).toString("base64url");
}

function distribute(): void {
  const values = decodeEnv(safeFile(STATE_ENV));
  const common = new Map([...values].filter(([name]) => COMMON.has(name)));
  const api = new Map([...values].filter(([name]) => API.has(name)));
  const worker = new Map([...values].filter(([name]) => WORKER.has(name)));
  const seed = worker.get("MARKETPLACE_INTENT_SIGNING_SEED");
  if (seed !== undefined) common.set("MARKETPLACE_INTENT_PUBLIC_KEY", publicKey(seed));
  const workerCredential = worker.get("MARKETPLACE_DEMO_WORKER_CREDENTIAL");
  if (workerCredential !== undefined) {
    api.set("MARKETPLACE_DEMO_WORKER_CREDENTIAL_SHA256", createHash("sha256").update(workerCredential).digest("hex"));
  }
  const commonNames = new Set([...COMMON, "MARKETPLACE_INTENT_PUBLIC_KEY"]);
  const apiNames = new Set([...API, "MARKETPLACE_DEMO_WORKER_CREDENTIAL_SHA256"]);
  // Derived names are intentionally serialized after the public schema order.
  let commonBytes = serialized(common, commonNames);
  if (common.has("MARKETPLACE_INTENT_PUBLIC_KEY")) {
    commonBytes = Buffer.concat([commonBytes, Buffer.from(`MARKETPLACE_INTENT_PUBLIC_KEY=${quote(common.get("MARKETPLACE_INTENT_PUBLIC_KEY")!)}\n`)]);
  }
  let apiBytes = serialized(api, apiNames);
  if (api.has("MARKETPLACE_DEMO_WORKER_CREDENTIAL_SHA256")) {
    apiBytes = Buffer.concat([apiBytes, Buffer.from(`MARKETPLACE_DEMO_WORKER_CREDENTIAL_SHA256=${quote(api.get("MARKETPLACE_DEMO_WORKER_CREDENTIAL_SHA256")!)}\n`)]);
  }
  atomic(COMMON_ENV, commonBytes, "liqhunter-marketplace-common", 0o640);
  atomic(API_ENV, apiBytes, "liqhunter-marketplace-api", 0o640);
  atomic(WORKER_ENV, serialized(worker, WORKER), "liqhunter-marketplace-worker", 0o640);
  atomic(MIGRATE_ENV, Buffer.from("# Reserved for the dedicated migrator role.\n"), "liqhunter-marketplace-migrate", 0o640);
}

function serviceRestart(): void {
  const result = spawnSync("systemctl", ["restart", ...MARKETPLACE_RESTART_UNITS], { stdio: "ignore", shell: false });
  if (result.status !== 0) refuse();
  for (const unit of MARKETPLACE_RESTART_UNITS) {
    const active = spawnSync("systemctl", ["is-active", "--quiet", unit], { stdio: "ignore", shell: false });
    if (active.status !== 0) refuse();
  }
}

function scheduleHubReload(): void {
  spawnSync("systemd-run", [
    "--unit", `wickhunter-hub-config-reload-${Date.now()}`, "--collect", "--on-active=2s",
    "systemctl", "restart", "wickhunter-hub.service",
  ], { stdio: "ignore", shell: false });
}

function importMaster(apiKey: string, apiSecret: string): void {
  const result = spawnSync("runuser", [
    "-u", "liqhunter-marketplace-worker", "--", "env",
    `MARKETPLACE_WORKER_ENV_FILE=${WORKER_ENV}`,
    "node", `${APP_DIR}/dist/marketplace-hub/demo-vault-import-cli.js`,
  ], {
    input: Buffer.from(JSON.stringify({ apiKey, apiSecret }), "utf8"),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdio: ["pipe", "ignore", "ignore"],
    maxBuffer: 128 * 1024,
    shell: false,
  });
  if (result.status !== 0) refuse();
}

function sanitizedProvider(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse();
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.id)
    || typeof row.displayName !== "string" || row.displayName.length < 1 || row.displayName.length > 256
    || typeof row.status !== "string" || !["submitted", "approved", "rejected", "suspended"].includes(row.status)
    || typeof row.createdAtMs !== "number" || !Number.isSafeInteger(row.createdAtMs)
    || typeof row.updatedAtMs !== "number" || !Number.isSafeInteger(row.updatedAtMs)) refuse();
  return {
    id: row.id, displayName: row.displayName, status: row.status,
    createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs,
  };
}

async function privateAdmin(pathname: string, method: "GET" | "POST", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const hubKey = decodeEnv(safeFile(COMMON_ENV)).get("LIQHUNTER_HUB_KEY");
  if (hubKey === undefined || hubKey.length < 32) refuse();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:8099${pathname}`, {
      method,
      headers: {
        "x-hub-key": hubKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch { refuse(); }
  finally { clearTimeout(timeout); }
  const text = await response.text();
  if (!response.ok || text.length > 1024 * 1024) refuse();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { refuse(); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed as Record<string, unknown>).ok !== true) refuse();
  return parsed as Record<string, unknown>;
}

function restoreFiles(previous: ReadonlyMap<string, Buffer | null>): void {
  for (const [filename, bytes] of previous) {
    if (bytes === null) { try { fs.unlinkSync(filename); } catch { /* absent or fail-closed */ } }
    else {
      const role = filename === COMMON_ENV ? ["liqhunter-marketplace-common", 0o640] as const
        : filename === API_ENV ? ["liqhunter-marketplace-api", 0o640] as const
          : filename === WORKER_ENV ? ["liqhunter-marketplace-worker", 0o640] as const
            : filename === MIGRATE_ENV ? ["liqhunter-marketplace-migrate", 0o640] as const
              : [null, 0o600] as const;
      atomic(filename, bytes, role[0], role[1]);
    }
  }
}

async function main(): Promise<void> {
  if (process.getuid?.() !== 0) refuse();
  const raw = readBoundedStdin();
  let request: unknown;
  try { request = JSON.parse(raw.toString("utf8")); } catch { refuse(); }
  if (request === null || typeof request !== "object" || Array.isArray(request)) refuse();
  const row = request as Record<string, unknown>;
  if (!["snapshot", "apply", "upgrade", "provider-list", "provider-decision"].includes(String(row.action))) refuse();
  if (row.action === "upgrade") {
    if (Object.keys(row).some((name) => name !== "action")) refuse();
    const source = decodeEnv(safeFile(HUB_ENV)).get("HUB_SRC_DIR") ?? "/root/dev/wickhunter-hub";
    if (!path.isAbsolute(source) || path.normalize(source) !== source) refuse();
    const launched = spawnSync("systemd-run", [
      "--unit", `wickhunter-hub-upgrade-${Date.now()}`, "--collect", process.execPath,
      `${HUB_DIR}/dist/bin/upgrade-runner.js`, "--source", source, "--data", DATA_DIR,
    ], { stdio: "ignore", shell: false });
    if (launched.status !== 0) refuse();
    process.stdout.write(JSON.stringify({ ok: true, queued: true }));
    return;
  }
  if (row.action === "provider-list") {
    if (Object.keys(row).some((name) => name !== "action")) refuse();
    const result = await privateAdmin("/api/marketplace/admin/providers", "GET");
    if (!Array.isArray(result.providers) || result.providers.length > 10_000) refuse();
    process.stdout.write(JSON.stringify({ ok: true, providers: result.providers.map(sanitizedProvider) }));
    return;
  }
  if (row.action === "provider-decision") {
    if (Object.keys(row).some((name) => !["action", "providerId", "to", "reason", "idempotencyKey"].includes(name))
      || typeof row.providerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.providerId)
      || typeof row.to !== "string" || !["approved", "rejected", "suspended"].includes(row.to)
      || typeof row.reason !== "string" || row.reason.trim() !== row.reason || row.reason.length < 8 || row.reason.length > 1_000
      || typeof row.idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(row.idempotencyKey)) refuse();
    const result = await privateAdmin(`/api/marketplace/admin/providers/${encodeURIComponent(row.providerId)}/decision`, "POST", {
      to: row.to, reason: row.reason, idempotencyKey: row.idempotencyKey,
    });
    process.stdout.write(JSON.stringify({ ok: true, provider: sanitizedProvider(result.provider) }));
    return;
  }
  seedState();
  const cfg = directConfig();
  if (row.action === "snapshot") {
    if (Object.keys(row).some((name) => name !== "action")) refuse();
    process.stdout.write(JSON.stringify({ ok: true, config: marketplaceInputSnapshot(cfg) }));
    return;
  }
  if (Object.keys(row).some((name) => name !== "action" && name !== "update")
    || row.update === null || typeof row.update !== "object" || Array.isArray(row.update)) refuse();
  const update = structuredClone(row.update) as MarketplaceInputUpdate;
  const updateRow = update as unknown as Record<string, unknown>;
  if (Object.keys(updateRow).some((name) => name !== "changes" && name !== "automatic")
    || update.automatic !== true || update.generate !== undefined
    || update.changes === null || typeof update.changes !== "object" || Array.isArray(update.changes)) refuse();
  const operatorNames = new Set(MARKETPLACE_INPUT_DEFINITIONS
    .filter((field) => field.setup === "operator").map((field) => field.name));
  if (Object.keys(update.changes ?? {}).some((name) => !operatorNames.has(name))) refuse();
  const changes = { ...(update.changes ?? {}) };
  const rawKey = changes.MARKETPLACE_DEMO_MASTER_API_KEY;
  const rawSecret = changes.MARKETPLACE_DEMO_MASTER_API_SECRET;
  let master: { apiKey: string; apiSecret: string } | null = null;
  if (rawKey !== undefined || rawSecret !== undefined) {
    if (typeof rawKey !== "string" || rawKey.trim() !== rawKey || rawKey.length < 8 || /[\0\r\n]/.test(rawKey)
      || typeof rawSecret !== "string" || rawSecret.trim() !== rawSecret || rawSecret.length < 16 || /[\0\r\n]/.test(rawSecret)) refuse();
    master = { apiKey: rawKey, apiSecret: rawSecret };
    changes.MARKETPLACE_DEMO_MASTER_API_KEY = MASTER_KEY_MARKER;
    changes.MARKETPLACE_DEMO_MASTER_API_SECRET = MASTER_SECRET_MARKER;
  }
  const transformed: MarketplaceInputUpdate = { ...update, changes };
  const tracked = [STATE_ENV, BRIDGE_ENV, COMMON_ENV, API_ENV, WORKER_ENV, MIGRATE_ENV];
  const previous = new Map(tracked.map((filename) => [filename, safeFile(filename)]));
  try {
    await applyMarketplaceInputUpdate(cfg, transformed);
    distribute();
    if (master !== null) importMaster(master.apiKey, master.apiSecret);
    serviceRestart();
  } catch {
    restoreFiles(previous);
    try { serviceRestart(); } catch { /* restored bytes remain the source of truth */ }
    refuse();
  }
  const snapshot = marketplaceInputSnapshot(cfg);
  process.stdout.write(JSON.stringify({ ok: true, config: snapshot }));
  scheduleHubReload();
}

try { await main(); }
catch {
  process.stdout.write(JSON.stringify({ ok: false, error: "privileged Marketplace request refused" }));
  process.exitCode = 1;
}
