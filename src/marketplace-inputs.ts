// The public Hub's Marketplace CONFIGURATION PLANE. This module knows only
// environment-variable names, validation rules and the two private service
// units that consume them. It contains no Marketplace execution, exchange,
// order, subscription, payment or persistence logic.
//
// Secrets cross the authenticated request body once, are written to one
// root-only EnvironmentFile, and are never returned. The browser receives
// configured/missing state only. Applying a file and restarting both private
// services is one transaction: a failed restart restores the previous bytes.
import fs from "node:fs";
import path from "node:path";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { TextDecoder } from "node:util";

export const MARKETPLACE_CSRF_HEADER = "x-hub-csrf";
export const MARKETPLACE_CSRF_VALUE = "marketplace-config-v1";

/** Never accept unit names from an environment variable or request body. */
export const MARKETPLACE_RESTART_UNITS = Object.freeze([
  "liqhunter-marketplace-api.service",
  "liqhunter-marketplace-worker.service",
] as const);

export type MarketplaceInputGroup = "bridge" | "service" | "alpha" | "bybit-demo" | "moonpay";
export type MarketplaceInputKind = "text" | "password" | "number" | "select" | "textarea";
export type MarketplaceInputSetup = "operator" | "automatic" | "deployment";

export interface MarketplaceInputDefinition {
  readonly name: string;
  readonly label: string;
  readonly group: MarketplaceInputGroup;
  readonly secret: boolean;
  readonly required: boolean;
  readonly kind: MarketplaceInputKind;
  /** `operator` is shown in the normal form. `automatic` is owned by the Hub.
   * `deployment` is installed from the private service/runtime, never typed
   * into a browser. All three remain in the masked diagnostic snapshot. */
  readonly setup: MarketplaceInputSetup;
  readonly help: string;
  readonly placeholder?: string;
  readonly options?: readonly string[];
  readonly generated?: "status" | "vault" | "worker";
}

type Validator = (value: string) => string;
type InternalDefinition = MarketplaceInputDefinition & { readonly validate: Validator };

function refusal(name: string, message: string): never {
  throw new MarketplaceInputError(name, message);
}

function exact(value: string, name: string, accepted: readonly string[]): string {
  if (!accepted.includes(value)) refusal(name, `must be one of: ${accepted.join(", ")}`);
  return value;
}

function integer(name: string, min: number, max: number): Validator {
  return (value) => {
    if (!/^\d+$/.test(value)) refusal(name, `must contain digits only (${min} through ${max})`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) refusal(name, `must be from ${min} through ${max}`);
    return String(n);
  };
}

function opaque(name: string, min: number, label = "secret"): Validator {
  return (value) => {
    if (value.length < min) refusal(name, `${label} must contain at least ${min} characters`);
    if (value.length > 8_192) refusal(name, `${label} is longer than 8192 characters`);
    return value;
  };
}

function canonicalKey32(name: string): Validator {
  return (value) => {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
      refusal(name, "must be a canonical base64url-encoded 32-byte key; the submitted value is not repeated");
    }
    return value;
  };
}

function identifier(name: string, max = 128): Validator {
  return (value) => {
    if (!new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${max - 1}}$`).test(value)) {
      refusal(name, `must be 1 through ${max} characters using letters, digits, dot, underscore, colon or hyphen`);
    }
    return value;
  };
}

function exactOrigin(name: string, loopback: boolean): Validator {
  return (value) => {
    let url: URL;
    try { url = new URL(value); } catch { refusal(name, "must be an exact URL origin"); }
    const host = url.hostname.toLowerCase();
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      refusal(name, "must not contain credentials, a path, query or fragment");
    }
    if (loopback) {
      if (!isLoopback || (url.protocol !== "http:" && url.protocol !== "https:")) {
        refusal(name, "must be an exact HTTP(S) loopback origin");
      }
    } else if (url.protocol !== "https:" || isLoopback) {
      refusal(name, "must be an exact public HTTPS origin");
    }
    return url.origin;
  };
}

function roster(name: string): Validator {
  return (value) => {
    const parts = value.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 1 || parts.length > 1_000) refusal(name, "must contain 1 through 1000 exact licence ids");
    const seen = new Set<string>();
    for (const item of parts) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item)) {
        refusal(name, "contains an invalid licence id; values are not repeated in this response");
      }
      if (seen.has(item)) refusal(name, "contains a duplicate licence id");
      seen.add(item);
    }
    return parts.join(",");
  };
}

const publicKeyring: Validator = (value) => {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { refusal("LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", "must be a JSON object of key id to canonical base64url 32-byte public key"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    refusal("LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", "must be a JSON object of key id to canonical base64url 32-byte public key");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 16) refusal("LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", "must contain 1 through 16 public keys");
  const out: Record<string, string> = {};
  for (const [kid, key] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(kid) || typeof key !== "string") {
      refusal("LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", "contains an invalid key id or public key");
    }
    const bytes = Buffer.from(key, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== key) {
      refusal("LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", "contains a public key that is not canonical base64url 32-byte material");
    }
    out[kid] = key;
  }
  return JSON.stringify(out);
};

const oneCryptoRecipient: Validator = (value) => {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { refusal("MOONPAY_COMMERCE_RECIPIENTS_JSON", "must be a JSON array containing exactly one crypto recipient"); }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    refusal("MOONPAY_COMMERCE_RECIPIENTS_JSON", "must contain exactly one crypto recipient; cards and revenue shares are unsupported");
  }
  const row = parsed[0];
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    refusal("MOONPAY_COMMERCE_RECIPIENTS_JSON", "must contain exactly one crypto recipient object");
  }
  const r = row as Record<string, unknown>;
  const names = Object.keys(r).sort();
  const allowed = ["currencyId", "sourceBlockchainEngine", "walletId"].sort();
  if (names.length !== allowed.length || names.some((name, i) => name !== allowed[i])) {
    refusal("MOONPAY_COMMERCE_RECIPIENTS_JSON", "accepts only currencyId, walletId and sourceBlockchainEngine; card and revenue-share fields are refused");
  }
  for (const name of allowed) {
    const item = r[name];
    if (typeof item !== "string" || item.trim() !== item || item.length < 1 || item.length > 256) {
      refusal("MOONPAY_COMMERCE_RECIPIENTS_JSON", `${name} must be non-empty text no longer than 256 characters`);
    }
  }
  return JSON.stringify([{ currencyId: r.currencyId, walletId: r.walletId, sourceBlockchainEngine: r.sourceBlockchainEngine }]);
};

function d(definition: MarketplaceInputDefinition, validate: Validator): InternalDefinition {
  return Object.freeze({ ...definition, validate });
}

const DEFINITIONS: readonly InternalDefinition[] = Object.freeze([
  d({ name: "HUB_MARKETPLACE_STATUS_ORIGIN", label: "Private status origin", group: "bridge", setup: "automatic", secret: false, required: true, kind: "text", placeholder: "http://127.0.0.1:8099", help: "Set automatically to the private loopback service." }, exactOrigin("HUB_MARKETPLACE_STATUS_ORIGIN", true)),
  d({ name: "HUB_MARKETPLACE_STATUS_CREDENTIAL", label: "Shared status credential", group: "bridge", setup: "automatic", secret: true, required: true, kind: "password", generated: "status", help: "Generated automatically and mirrored to the private status service." }, opaque("HUB_MARKETPLACE_STATUS_CREDENTIAL", 32, "status credential")),
  d({ name: "MARKETPLACE_OPERATOR_STATUS_CREDENTIAL", label: "Private status credential mirror", group: "bridge", setup: "automatic", secret: true, required: true, kind: "password", generated: "status", help: "Generated automatically with the identical Hub status credential." }, opaque("MARKETPLACE_OPERATOR_STATUS_CREDENTIAL", 32, "status credential")),
  d({ name: "HUB_MARKETPLACE_STATUS_TIMEOUT_MS", label: "Status timeout (ms)", group: "bridge", setup: "automatic", secret: false, required: false, kind: "number", placeholder: "3000", help: "Managed automatically." }, integer("HUB_MARKETPLACE_STATUS_TIMEOUT_MS", 250, 15_000)),

  d({ name: "MARKETPLACE_ENABLED", label: "Marketplace enabled", group: "service", setup: "automatic", secret: false, required: true, kind: "select", options: ["1"], help: "Enabled automatically for the private alpha service only." }, (v) => exact(v, "MARKETPLACE_ENABLED", ["1"])),
  d({ name: "MARKETPLACE_HTTP_HOST", label: "Private API host", group: "service", setup: "automatic", secret: false, required: false, kind: "select", options: ["127.0.0.1", "::1"], placeholder: "127.0.0.1", help: "Fixed automatically to loopback." }, (v) => exact(v, "MARKETPLACE_HTTP_HOST", ["127.0.0.1", "::1"])),
  d({ name: "MARKETPLACE_HTTP_PORT", label: "Private API port", group: "service", setup: "automatic", secret: false, required: false, kind: "number", placeholder: "8099", help: "Managed automatically." }, integer("MARKETPLACE_HTTP_PORT", 1, 65_535)),
  d({ name: "MARKETPLACE_STORE", label: "System of record", group: "service", setup: "automatic", secret: false, required: true, kind: "select", options: ["postgres"], help: "Fixed automatically to durable PostgreSQL." }, (v) => exact(v, "MARKETPLACE_STORE", ["postgres"])),
  d({ name: "MARKETPLACE_DATABASE_URL", label: "PostgreSQL URL", group: "service", setup: "deployment", secret: true, required: true, kind: "password", help: "Provisioned automatically when the private Marketplace services are installed." }, (v) => {
    if (v.length < 16 || !/^postgres(?:ql)?:\/\//i.test(v)) refusal("MARKETPLACE_DATABASE_URL", "must be a PostgreSQL URL; the submitted value is not repeated");
    try { new URL(v); } catch { refusal("MARKETPLACE_DATABASE_URL", "must be a valid PostgreSQL URL; the submitted value is not repeated"); }
    return v;
  }),
  d({ name: "MARKETPLACE_INTENT_KEY_ID", label: "Intent signing key id", group: "service", setup: "automatic", secret: false, required: true, kind: "text", help: "Generated automatically with the private signer." }, identifier("MARKETPLACE_INTENT_KEY_ID", 64)),
  d({ name: "MARKETPLACE_INTENT_SIGNING_SEED", label: "Intent signing seed", group: "service", setup: "automatic", secret: true, required: true, kind: "password", help: "Generated automatically and never exposed to the browser." }, canonicalKey32("MARKETPLACE_INTENT_SIGNING_SEED")),
  d({ name: "MARKETPLACE_RUNTIME_DIRECTORY", label: "Runtime directory", group: "service", setup: "automatic", secret: false, required: false, kind: "text", placeholder: "/var/lib/liqhunter/marketplace", help: "Fixed automatically to the private StateDirectory." }, (v) => exact(v, "MARKETPLACE_RUNTIME_DIRECTORY", ["/var/lib/liqhunter/marketplace"])),
  d({ name: "MARKETPLACE_BUILD_COMMIT", label: "Installed build commit", group: "service", setup: "deployment", secret: false, required: true, kind: "text", help: "Stamped automatically by the private service installer." }, (v) => {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(v)) refusal("MARKETPLACE_BUILD_COMMIT", "must be a full 40- or 64-character hexadecimal source revision");
    return v.toLowerCase();
  }),
  d({ name: "MARKETPLACE_WORKER_INTERVAL_MS", label: "Worker interval (ms)", group: "service", setup: "automatic", secret: false, required: false, kind: "number", placeholder: "1000", help: "Managed automatically." }, integer("MARKETPLACE_WORKER_INTERVAL_MS", 50, 3_600_000)),
  d({ name: "MARKETPLACE_OUTBOX_BATCH", label: "Outbox batch", group: "service", setup: "automatic", secret: false, required: false, kind: "number", placeholder: "50", help: "Managed automatically." }, integer("MARKETPLACE_OUTBOX_BATCH", 1, 10_000)),
  d({ name: "MARKETPLACE_SHUTDOWN_GRACE_MS", label: "Shutdown grace (ms)", group: "service", setup: "automatic", secret: false, required: false, kind: "number", placeholder: "10000", help: "Managed automatically." }, integer("MARKETPLACE_SHUTDOWN_GRACE_MS", 0, 600_000)),
  d({ name: "LIQHUNTER_HUB_KEY", label: "Private Hub identity", group: "service", setup: "deployment", secret: true, required: true, kind: "password", help: "Provisioned automatically from the existing central Hub identity." }, opaque("LIQHUNTER_HUB_KEY", 32, "Hub credential")),
  d({ name: "MARKETPLACE_ADMIN_LICENCES", label: "Marketplace admin licences", group: "service", setup: "automatic", secret: true, required: true, kind: "textarea", help: "Mirrored automatically from the alpha licence list unless deployment supplies a narrower roster." }, roster("MARKETPLACE_ADMIN_LICENCES")),

  d({ name: "LIQHUNTER_MARKETPLACE_URL", label: "Alpha Marketplace origin", group: "alpha", setup: "automatic", secret: false, required: true, kind: "text", placeholder: "https://marketplace.example.com", help: "Derived automatically from this Hub's public HTTPS origin." }, exactOrigin("LIQHUNTER_MARKETPLACE_URL", false)),
  d({ name: "LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", label: "Alpha intent public keyring", group: "alpha", setup: "automatic", secret: false, required: true, kind: "textarea", placeholder: "{\"marketplace-1\":\"<base64url public key>\"}", help: "Derived automatically from the generated signing key." }, publicKeyring),
  d({ name: "MARKETPLACE_ALPHA_LICENCES", label: "Marketplace alpha licences", group: "alpha", setup: "automatic", secret: true, required: true, kind: "textarea", help: "Built automatically from licences whose Marketplace alpha switch is enabled. Beta remains excluded." }, roster("MARKETPLACE_ALPHA_LICENCES")),
  d({ name: "MARKETPLACE_ALPHA_LICENCE_FEATURE_CONFIRMED", label: "Alpha feature grant confirmed", group: "alpha", setup: "automatic", secret: false, required: true, kind: "select", options: ["1"], help: "Recorded automatically when an alpha roster is saved." }, (v) => exact(v, "MARKETPLACE_ALPHA_LICENCE_FEATURE_CONFIRMED", ["1"])),

  d({ name: "MARKETPLACE_DEMO_MASTER_API_KEY", label: "Bybit Demo master API key", group: "bybit-demo", setup: "operator", secret: true, required: true, kind: "password", help: "Paste the WickHunter-owned Bybit API key used to create and control Demo accounts." }, opaque("MARKETPLACE_DEMO_MASTER_API_KEY", 8, "Bybit API key")),
  d({ name: "MARKETPLACE_DEMO_MASTER_API_SECRET", label: "Bybit Demo master API secret", group: "bybit-demo", setup: "operator", secret: true, required: true, kind: "password", help: "Paste the matching Bybit API secret." }, opaque("MARKETPLACE_DEMO_MASTER_API_SECRET", 16, "Bybit API secret")),
  d({ name: "MARKETPLACE_DEMO_VAULT_PATH", label: "Demo credential vault path", group: "bybit-demo", setup: "automatic", secret: false, required: true, kind: "text", placeholder: "/var/lib/liqhunter/marketplace/demo-credentials.vault", help: "Fixed automatically inside the private StateDirectory." }, (v) => exact(v, "MARKETPLACE_DEMO_VAULT_PATH", ["/var/lib/liqhunter/marketplace/demo-credentials.vault"])),
  d({ name: "MARKETPLACE_DEMO_VAULT_KEY", label: "Demo vault key", group: "bybit-demo", setup: "automatic", secret: true, required: true, kind: "password", generated: "vault", help: "Generated automatically and kept server-side." }, canonicalKey32("MARKETPLACE_DEMO_VAULT_KEY")),
  d({ name: "MARKETPLACE_DEMO_WORKER_CREDENTIAL", label: "Demo worker credential", group: "bybit-demo", setup: "automatic", secret: true, required: true, kind: "password", generated: "worker", help: "Generated automatically and kept server-side." }, opaque("MARKETPLACE_DEMO_WORKER_CREDENTIAL", 32, "worker credential")),
  d({ name: "MARKETPLACE_DEMO_EVIDENCE_INTERVAL_MS", label: "Demo evidence interval (ms)", group: "bybit-demo", setup: "automatic", secret: false, required: false, kind: "number", placeholder: "60000", help: "Managed automatically." }, integer("MARKETPLACE_DEMO_EVIDENCE_INTERVAL_MS", 5_000, 3_600_000)),
  d({ name: "MARKETPLACE_DEMO_EVIDENCE_MAX_AGE_MS", label: "Demo evidence max age (ms)", group: "bybit-demo", setup: "automatic", secret: false, required: false, kind: "number", placeholder: "180000", help: "Managed automatically." }, integer("MARKETPLACE_DEMO_EVIDENCE_MAX_AGE_MS", 10_000, 3_600_000)),

  d({ name: "MOONPAY_COMMERCE_ENVIRONMENT", label: "MoonPay environment", group: "moonpay", setup: "automatic", secret: false, required: false, kind: "select", options: ["production", "development"], placeholder: "production", help: "Defaults automatically to production." }, (v) => exact(v, "MOONPAY_COMMERCE_ENVIRONMENT", ["production", "development"])),
  d({ name: "MOONPAY_COMMERCE_PUBLIC_KEY", label: "MoonPay public bearer key", group: "moonpay", setup: "operator", secret: true, required: true, kind: "password", help: "Paste the public/bearer key supplied by MoonPay Commerce." }, opaque("MOONPAY_COMMERCE_PUBLIC_KEY", 16, "MoonPay bearer key")),
  d({ name: "MOONPAY_COMMERCE_SECRET_KEY", label: "MoonPay secret key", group: "moonpay", setup: "operator", secret: true, required: true, kind: "password", help: "Paste the matching MoonPay Commerce secret key." }, opaque("MOONPAY_COMMERCE_SECRET_KEY", 16, "MoonPay secret")),
  d({ name: "MOONPAY_COMMERCE_WEBHOOK_SHARED_TOKEN", label: "MoonPay webhook token", group: "moonpay", setup: "operator", secret: true, required: true, kind: "password", help: "Paste the webhook authentication token configured in MoonPay." }, opaque("MOONPAY_COMMERCE_WEBHOOK_SHARED_TOKEN", 32, "webhook token")),
  d({ name: "MOONPAY_COMMERCE_PRICING_CURRENCY_ID", label: "MoonPay USDT currency ID", group: "moonpay", setup: "operator", secret: false, required: true, kind: "text", help: "Paste MoonPay's currency identifier for the USDT settlement currency." }, identifier("MOONPAY_COMMERCE_PRICING_CURRENCY_ID", 128)),
  d({ name: "MOONPAY_COMMERCE_PRICING_ASSET", label: "Crypto pricing asset", group: "moonpay", setup: "automatic", secret: false, required: true, kind: "text", placeholder: "USDT", help: "Fixed automatically to USDT." }, (v) => {
    if (!/^[A-Z0-9][A-Z0-9._-]{1,15}$/.test(v)) refusal("MOONPAY_COMMERCE_PRICING_ASSET", "must be a 2 through 16 character uppercase crypto asset id");
    return v;
  }),
  d({ name: "MOONPAY_COMMERCE_RECIPIENTS_JSON", label: "MoonPay payout wallet", group: "moonpay", setup: "operator", secret: true, required: true, kind: "textarea", placeholder: "[{\"currencyId\":\"...\",\"walletId\":\"...\",\"sourceBlockchainEngine\":\"...\"}]", help: "Paste the single MoonPay crypto recipient definition (currency ID, wallet ID and blockchain). No card or revenue-share fields are accepted." }, oneCryptoRecipient),
  d({ name: "MOONPAY_COMMERCE_MONTHLY_INTERVAL", label: "Monthly interval word", group: "moonpay", setup: "automatic", secret: false, required: true, kind: "text", help: "Fixed automatically to MONTH." }, identifier("MOONPAY_COMMERCE_MONTHLY_INTERVAL", 64)),
  d({ name: "MOONPAY_COMMERCE_YEARLY_INTERVAL", label: "Yearly interval word", group: "moonpay", setup: "automatic", secret: false, required: true, kind: "text", help: "Fixed automatically to YEAR." }, identifier("MOONPAY_COMMERCE_YEARLY_INTERVAL", 64)),
]);

const BY_NAME = new Map(DEFINITIONS.map((definition) => [definition.name, definition]));

export const MARKETPLACE_INPUT_DEFINITIONS: readonly MarketplaceInputDefinition[] = Object.freeze(
  DEFINITIONS.map(({ validate: _validate, ...definition }) => Object.freeze(definition)),
);

export interface MarketplaceInputRow extends MarketplaceInputDefinition {
  readonly state: "configured" | "missing" | "invalid";
  readonly safeValue?: string;
}

export interface MarketplaceInputSnapshot {
  readonly schemaVersion: 1;
  readonly fields: readonly MarketplaceInputRow[];
  readonly configuredCount: number;
  readonly requiredMissing: readonly string[];
  readonly operatorMissing: readonly string[];
  readonly automaticMissing: readonly string[];
  readonly deploymentMissing: readonly string[];
  readonly restartUnits: readonly string[];
}

export interface MarketplaceInputUpdate {
  readonly changes?: Readonly<Record<string, string | null>>;
  readonly generate?: readonly string[];
  /** Fill every missing server-owned value. Existing values and external
   * vendor/operator facts are never replaced. */
  readonly automatic?: boolean;
}

export interface MarketplaceInputsConfig {
  /** Root-only EnvironmentFile consumed by the private API and worker. */
  readonly envFile: string;
  /** Separate root-only EnvironmentFile consumed by the public Hub. It may
   * contain only the three status-bridge variables, never private service
   * credentials. */
  readonly hubBridgeEnvFile: string;
  /** Public origin used by alpha clients. It is derived by the Hub from its
   * own configured public origin and never needs a browser input. */
  readonly publicMarketplaceOrigin?: string;
  /** Exact explicit per-licence alpha cohort from the Hub flag store. A global
   * default is intentionally never accepted for this alpha-only product. */
  readonly alphaLicences?: () => readonly string[];
}

export class MarketplaceInputError extends Error {
  constructor(readonly field: string | null, message: string) {
    super(message);
    this.name = "MarketplaceInputError";
  }
}

function safePath(filename: string): string {
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) {
    throw new MarketplaceInputError(null, "Marketplace environment path must be absolute and normalized");
  }
  return filename;
}

function assertParentDirectory(filename: string): void {
  const parent = path.dirname(filename);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(parent); } catch {
    throw new MarketplaceInputError(null, "Marketplace environment directory does not exist; install the private service units first");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new MarketplaceInputError(null, "Marketplace environment directory must be a real directory, not a symlink or special file");
  }
}

function existingFile(filename: string): Buffer | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(filename); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new MarketplaceInputError(null, "Marketplace environment file could not be inspected");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new MarketplaceInputError(null, "Marketplace environment file must be a regular file and must not be a symlink");
  }
  if (stat.size > 1_000_000) throw new MarketplaceInputError(null, "Marketplace environment file is unexpectedly large");
  let fd: number | null = null;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new MarketplaceInputError(null, "Marketplace environment file changed type while it was opened");
    return fs.readFileSync(fd);
  } catch (err) {
    if (err instanceof MarketplaceInputError) throw err;
    throw new MarketplaceInputError(null, "Marketplace environment file could not be read safely");
  } finally { if (fd !== null) fs.closeSync(fd); }
}

function unquote(name: string, raw: string): string {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) throw new MarketplaceInputError(name, "has invalid EnvironmentFile quoting");
    let out = "";
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c !== "\\") { out += c; continue; }
      i++;
      if (i >= raw.length - 1 || !['"', "\\"].includes(raw[i] ?? "")) {
        throw new MarketplaceInputError(name, "has an unsupported EnvironmentFile escape");
      }
      out += raw[i];
    }
    return out;
  }
  if (/\s|["'\\]/.test(raw)) throw new MarketplaceInputError(name, "must use the Hub's canonical EnvironmentFile quoting");
  return raw;
}

function parseEnvironment(bytes: Buffer | null): Map<string, string> {
  const result = new Map<string, string>();
  if (bytes === null) return result;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new MarketplaceInputError(null, "Marketplace environment file is not plain UTF-8 text"); }
  if (text.includes("\0")) {
    throw new MarketplaceInputError(null, "Marketplace environment file is not plain UTF-8 text");
  }
  for (const line of text.split("\n")) {
    if (line === "" || /^\s*#/.test(line)) continue;
    if (line.endsWith("\r")) throw new MarketplaceInputError(null, "Marketplace environment file contains carriage returns");
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new MarketplaceInputError(null, "Marketplace environment file contains a non-assignment line");
    const [, name, raw] = match;
    if (!BY_NAME.has(name)) throw new MarketplaceInputError(name, "is not in the exact Marketplace configuration allowlist");
    if (result.has(name)) throw new MarketplaceInputError(name, "appears more than once in the Marketplace environment file");
    result.set(name, unquote(name, raw));
  }
  return result;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serialize(values: ReadonlyMap<string, string>): Buffer {
  const lines = [
    "# Managed by WickHunter Hub Marketplace admin. Root-only; never commit or print this file.",
    "# The public Hub contains no trading or payment logic; private services consume these inputs.",
  ];
  for (const definition of DEFINITIONS) {
    const value = values.get(definition.name);
    if (value !== undefined) lines.push(`${definition.name}=${quote(value)}`);
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

const HUB_BRIDGE_NAMES = Object.freeze([
  "HUB_MARKETPLACE_STATUS_ORIGIN",
  "HUB_MARKETPLACE_STATUS_CREDENTIAL",
  "HUB_MARKETPLACE_STATUS_TIMEOUT_MS",
] as const);

function serializeHubBridge(values: ReadonlyMap<string, string>): Buffer {
  const lines = [
    "# Managed by WickHunter Hub Marketplace admin. Root-only status bridge values only.",
    "# Private Marketplace, database, signer, vendor and vault credentials are forbidden here.",
  ];
  for (const name of HUB_BRIDGE_NAMES) {
    const value = values.get(name);
    if (value !== undefined) lines.push(`${name}=${quote(value)}`);
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function atomicWrite(filename: string, bytes: Buffer): void {
  assertParentDirectory(filename);
  // Re-check the destination immediately before rename so a configured symlink
  // or FIFO is refused explicitly rather than merely overwritten.
  existingFile(filename);
  const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, filename);
    fs.chmodSync(filename, 0o600);
    const dirFd = fs.openSync(path.dirname(filename), fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (err) {
    try { if (fd !== null) fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    if (err instanceof MarketplaceInputError) throw err;
    throw new MarketplaceInputError(null, "Marketplace environment file could not be written atomically");
  }
}

function restore(filename: string, previous: Buffer | null): void {
  if (previous !== null) return atomicWrite(filename, previous);
  const current = existingFile(filename);
  if (current !== null) {
    try { fs.unlinkSync(filename); } catch { throw new MarketplaceInputError(null, "Marketplace restart failed and the new environment file could not be removed"); }
  }
}

function valuesFrom(config: MarketplaceInputsConfig): { readonly filename: string; readonly bytes: Buffer | null; readonly values: Map<string, string> } {
  const filename = safePath(config.envFile);
  assertParentDirectory(filename);
  const bytes = existingFile(filename);
  return { filename, bytes, values: parseEnvironment(bytes) };
}

export function marketplaceInputSnapshot(config: MarketplaceInputsConfig): MarketplaceInputSnapshot {
  const { values } = valuesFrom(config);
  const fields = MARKETPLACE_INPUT_DEFINITIONS.map((definition): MarketplaceInputRow => {
    const value = values.get(definition.name);
    let validValue: string | undefined;
    if (value !== undefined) {
      try { validValue = cleanSubmittedValue(definition.name, value); }
      catch { validValue = undefined; }
    }
    return Object.freeze({
      ...definition,
      state: value === undefined ? "missing" : validValue === undefined ? "invalid" : "configured",
      ...(!definition.secret && validValue !== undefined ? { safeValue: validValue } : {}),
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    fields: Object.freeze(fields),
    configuredCount: fields.filter((field) => field.state === "configured").length,
    requiredMissing: Object.freeze(fields.filter((field) => field.required && field.state !== "configured").map((field) => field.name)),
    operatorMissing: Object.freeze(fields.filter((field) => field.required && field.setup === "operator" && field.state !== "configured").map((field) => field.name)),
    automaticMissing: Object.freeze(fields.filter((field) => field.required && field.setup === "automatic" && field.state !== "configured").map((field) => field.name)),
    deploymentMissing: Object.freeze(fields.filter((field) => field.required && field.setup === "deployment" && field.state !== "configured").map((field) => field.name)),
    restartUnits: MARKETPLACE_RESTART_UNITS,
  });
}

function cleanSubmittedValue(name: string, value: string): string {
  if (value.length < 1 || value.length > 16_384) refusal(name, "must contain 1 through 16384 characters");
  if (value.trim() !== value) refusal(name, "must not contain leading or trailing whitespace");
  if (/[\0\r\n\u0001-\u001f\u007f]/.test(value)) refusal(name, "must not contain newlines or control characters");
  return BY_NAME.get(name)!.validate(value);
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function intentPublicKey(seedB64u: string): string {
  const seed = Buffer.from(seedB64u, "base64url");
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  if (der.length < 32) throw new MarketplaceInputError("MARKETPLACE_INTENT_SIGNING_SEED", "could not derive the Marketplace public signing key");
  return der.subarray(-32).toString("base64url");
}

function applyAutomaticSetup(next: Map<string, string>, config: MarketplaceInputsConfig): void {
  const put = (name: string, value: string | undefined): void => {
    if (value !== undefined && !next.has(name)) next.set(name, cleanSubmittedValue(name, value));
  };
  for (const [name, value] of Object.entries({
    HUB_MARKETPLACE_STATUS_ORIGIN: "http://127.0.0.1:8099",
    HUB_MARKETPLACE_STATUS_TIMEOUT_MS: "3000",
    MARKETPLACE_ENABLED: "1",
    MARKETPLACE_HTTP_HOST: "127.0.0.1",
    MARKETPLACE_HTTP_PORT: "8099",
    MARKETPLACE_STORE: "postgres",
    MARKETPLACE_RUNTIME_DIRECTORY: "/var/lib/liqhunter/marketplace",
    MARKETPLACE_WORKER_INTERVAL_MS: "1000",
    MARKETPLACE_OUTBOX_BATCH: "50",
    MARKETPLACE_SHUTDOWN_GRACE_MS: "10000",
    MARKETPLACE_DEMO_VAULT_PATH: "/var/lib/liqhunter/marketplace/demo-credentials.vault",
    MARKETPLACE_DEMO_EVIDENCE_INTERVAL_MS: "60000",
    MARKETPLACE_DEMO_EVIDENCE_MAX_AGE_MS: "180000",
    MOONPAY_COMMERCE_ENVIRONMENT: "production",
    MOONPAY_COMMERCE_PRICING_ASSET: "USDT",
    MOONPAY_COMMERCE_MONTHLY_INTERVAL: "MONTH",
    MOONPAY_COMMERCE_YEARLY_INTERVAL: "YEAR",
  })) put(name, value);

  put("LIQHUNTER_MARKETPLACE_URL", config.publicMarketplaceOrigin);

  const statusA = next.get("HUB_MARKETPLACE_STATUS_CREDENTIAL");
  const statusB = next.get("MARKETPLACE_OPERATOR_STATUS_CREDENTIAL");
  if (statusA === undefined && statusB === undefined) {
    const generated = randomBytes(32).toString("base64url");
    next.set("HUB_MARKETPLACE_STATUS_CREDENTIAL", generated);
    next.set("MARKETPLACE_OPERATOR_STATUS_CREDENTIAL", generated);
  } else if (statusA !== undefined && statusB === undefined) {
    next.set("MARKETPLACE_OPERATOR_STATUS_CREDENTIAL", statusA);
  } else if (statusA === undefined && statusB !== undefined) {
    next.set("HUB_MARKETPLACE_STATUS_CREDENTIAL", statusB);
  }

  put("MARKETPLACE_DEMO_VAULT_KEY", randomBytes(32).toString("base64url"));
  put("MARKETPLACE_DEMO_WORKER_CREDENTIAL", randomBytes(32).toString("base64url"));

  const intentId = next.get("MARKETPLACE_INTENT_KEY_ID");
  const intentSeed = next.get("MARKETPLACE_INTENT_SIGNING_SEED");
  if (intentId === undefined && intentSeed === undefined) {
    next.set("MARKETPLACE_INTENT_KEY_ID", "marketplace-1");
    next.set("MARKETPLACE_INTENT_SIGNING_SEED", randomBytes(32).toString("base64url"));
  } else if ((intentId === undefined) !== (intentSeed === undefined)) {
    throw new MarketplaceInputError("MARKETPLACE_INTENT_KEY_ID", "the existing signing identity is incomplete; automatic setup refuses to rotate only one half");
  }
  const keyId = next.get("MARKETPLACE_INTENT_KEY_ID");
  const seed = next.get("MARKETPLACE_INTENT_SIGNING_SEED");
  if (keyId !== undefined && seed !== undefined) {
    cleanSubmittedValue("MARKETPLACE_INTENT_KEY_ID", keyId);
    cleanSubmittedValue("MARKETPLACE_INTENT_SIGNING_SEED", seed);
    const existing = next.get("LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS");
    let ring: Record<string, string> = {};
    if (existing !== undefined) ring = JSON.parse(cleanSubmittedValue("LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", existing)) as Record<string, string>;
    if (ring[keyId] === undefined) {
      ring[keyId] = intentPublicKey(seed);
      next.set("LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", cleanSubmittedValue("LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", JSON.stringify(ring)));
    } else if (ring[keyId] !== intentPublicKey(seed)) {
      throw new MarketplaceInputError("LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", "the existing public keyring does not match the private signing key; automatic setup refuses to replace a distributed key id");
    }
  }

  if (config.alphaLicences !== undefined) {
    const alphaFromFlags = [...new Set(config.alphaLicences()
      .map((id) => id.trim()).filter(Boolean))].sort();
    if (alphaFromFlags.length) {
      const alpha = cleanSubmittedValue("MARKETPLACE_ALPHA_LICENCES", alphaFromFlags.join(","));
      next.set("MARKETPLACE_ALPHA_LICENCES", alpha);
      next.set("MARKETPLACE_ADMIN_LICENCES", alpha);
      next.set("MARKETPLACE_ALPHA_LICENCE_FEATURE_CONFIRMED", "1");
    } else {
      next.delete("MARKETPLACE_ALPHA_LICENCES");
      next.delete("MARKETPLACE_ADMIN_LICENCES");
      next.delete("MARKETPLACE_ALPHA_LICENCE_FEATURE_CONFIRMED");
    }
  }
}

function applyUpdate(current: ReadonlyMap<string, string>, update: MarketplaceInputUpdate, config: MarketplaceInputsConfig): Map<string, string> {
  if (update === null || typeof update !== "object" || Array.isArray(update)) {
    throw new MarketplaceInputError(null, "expected a Marketplace configuration update object");
  }
  for (const name of Object.keys(update)) {
    if (name !== "changes" && name !== "generate" && name !== "automatic") {
      throw new MarketplaceInputError(null, "Marketplace configuration update contains an unsupported top-level field");
    }
  }
  if (update.automatic !== undefined && typeof update.automatic !== "boolean") {
    throw new MarketplaceInputError(null, "automatic must be true or false");
  }
  const changes = update.changes ?? {};
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
    throw new MarketplaceInputError(null, "changes must be an object");
  }
  const generate = update.generate ?? [];
  if (!Array.isArray(generate) || generate.some((name) => typeof name !== "string")) {
    throw new MarketplaceInputError(null, "generate must be a list of approved internal credential names");
  }
  const next = new Map(current);
  for (const [name, raw] of Object.entries(changes)) {
    if (!BY_NAME.has(name)) throw new MarketplaceInputError(name, "is not in the exact Marketplace configuration allowlist");
    if (!(typeof raw === "string" || raw === null)) throw new MarketplaceInputError(name, "must be text or null to clear");
    if (raw === null) next.delete(name);
    else next.set(name, cleanSubmittedValue(name, raw));
  }
  const generated = new Set(generate);
  const allowedGenerated = new Set([
    "HUB_MARKETPLACE_STATUS_CREDENTIAL",
    "MARKETPLACE_OPERATOR_STATUS_CREDENTIAL",
    "MARKETPLACE_DEMO_VAULT_KEY",
    "MARKETPLACE_DEMO_WORKER_CREDENTIAL",
  ]);
  for (const name of generated) {
    if (!allowedGenerated.has(name)) {
      throw new MarketplaceInputError(name, "cannot be generated by the Hub; vendor and identity keys must be supplied by the operator");
    }
  }
  if (generated.has("HUB_MARKETPLACE_STATUS_CREDENTIAL") || generated.has("MARKETPLACE_OPERATOR_STATUS_CREDENTIAL")) {
    const value = randomBytes(32).toString("base64url");
    next.set("HUB_MARKETPLACE_STATUS_CREDENTIAL", value);
    next.set("MARKETPLACE_OPERATOR_STATUS_CREDENTIAL", value);
  }
  if (generated.has("MARKETPLACE_DEMO_VAULT_KEY")) next.set("MARKETPLACE_DEMO_VAULT_KEY", randomBytes(32).toString("base64url"));
  if (generated.has("MARKETPLACE_DEMO_WORKER_CREDENTIAL")) next.set("MARKETPLACE_DEMO_WORKER_CREDENTIAL", randomBytes(32).toString("base64url"));

  if (update.automatic === true) applyAutomaticSetup(next, config);

  const hubStatus = next.get("HUB_MARKETPLACE_STATUS_CREDENTIAL");
  const privateStatus = next.get("MARKETPLACE_OPERATOR_STATUS_CREDENTIAL");
  if ((hubStatus === undefined) !== (privateStatus === undefined) || hubStatus !== privateStatus) {
    throw new MarketplaceInputError("HUB_MARKETPLACE_STATUS_CREDENTIAL", "must be configured atomically with the identical private Marketplace status credential");
  }
  return next;
}

type Spawn = typeof nodeSpawn;

async function restart(spawn: Spawn): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const child = spawn("systemctl", ["restart", ...MARKETPLACE_RESTART_UNITS], {
        stdio: "ignore",
        shell: false,
      });
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
    } catch { finish(false); }
  });
}

export async function applyMarketplaceInputUpdate(
  config: MarketplaceInputsConfig,
  update: MarketplaceInputUpdate,
  spawn: Spawn = nodeSpawn,
): Promise<MarketplaceInputSnapshot> {
  const { filename, bytes: previous, values } = valuesFrom(config);
  const bridgeFilename = safePath(config.hubBridgeEnvFile);
  assertParentDirectory(bridgeFilename);
  const previousBridge = existingFile(bridgeFilename);
  const next = applyUpdate(values, update, config);
  try {
    atomicWrite(filename, serialize(next));
    atomicWrite(bridgeFilename, serializeHubBridge(next));
  } catch (err) {
    try { restore(filename, previous); } catch { /* preserve the original refusal */ }
    try { restore(bridgeFilename, previousBridge); } catch { /* preserve the original refusal */ }
    throw err;
  }
  if (!await restart(spawn)) {
    restore(filename, previous);
    restore(bridgeFilename, previousBridge);
    // Best-effort recovery restart uses the same hardcoded unit allowlist. Its
    // outcome cannot make the restored bytes less true, and no vendor output
    // or submitted value is exposed through this generic failure.
    await restart(spawn);
    throw new MarketplaceInputError(null, "Private Marketplace services rejected the update; the previous root-only environment file was restored");
  }
  return marketplaceInputSnapshot(config);
}

/** Read only the local bridge pair after a successful transaction. */
export function marketplaceBridgeEnvironment(config: MarketplaceInputsConfig): NodeJS.ProcessEnv {
  const { values } = valuesFrom(config);
  return {
    HUB_MARKETPLACE_STATUS_ORIGIN: values.get("HUB_MARKETPLACE_STATUS_ORIGIN"),
    HUB_MARKETPLACE_STATUS_CREDENTIAL: values.get("HUB_MARKETPLACE_STATUS_CREDENTIAL"),
    HUB_MARKETPLACE_STATUS_TIMEOUT_MS: values.get("HUB_MARKETPLACE_STATUS_TIMEOUT_MS"),
  };
}
