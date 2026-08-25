// Sanitized server-to-server bridge to the private Marketplace operations
// service. The public Hub contains no trading, payment, Demo, or Marketplace
// persistence code; it only renders the private service's redacted readiness
// contract to an authenticated Hub administrator.
export interface MarketplaceStatusBridgeConfig {
  readonly origin: string | null;
  readonly credential: string | null;
  readonly timeoutMs: number;
  readonly refusals: readonly string[];
}

export type MarketplaceInputState = "configured" | "missing" | "invalid" | "defaulted" | "unverified";

export interface MarketplaceRequiredInput {
  readonly name: string;
  readonly state: MarketplaceInputState;
  readonly secret: boolean;
  readonly detail: string;
  readonly action: string;
  readonly safeValue?: string;
}

export interface MarketplaceStatusBridgeSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAtMs: number;
  readonly bridge: {
    readonly state: "connected" | "unconfigured" | "invalid" | "unavailable";
    readonly originConfigured: boolean;
    readonly credentialConfigured: boolean;
    readonly refusal: string | null;
  };
  readonly upstream: Readonly<Record<string, unknown>> | null;
  readonly requiredInputs: readonly MarketplaceRequiredInput[];
  readonly readinessBlockers: readonly string[];
}

export interface MarketplaceStatusFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type MarketplaceStatusFetch = (
  url: string,
  init: {
    readonly method: "GET";
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly redirect: "error";
  },
) => Promise<MarketplaceStatusFetchResponse>;

const PRIVATE_REQUIRED: readonly { readonly name: string; readonly secret: boolean; readonly action: string }[] = Object.freeze([
  { name: "MARKETPLACE_ENABLED", secret: false, action: "Set to 1 only on the dedicated private Marketplace API and worker services." },
  { name: "MARKETPLACE_HTTP_HOST", secret: false, action: "Keep the private API on loopback unless an authenticated private network is deliberately configured." },
  { name: "MARKETPLACE_HTTP_PORT", secret: false, action: "Set the private Marketplace API listen port, or use its documented default." },
  { name: "MARKETPLACE_STORE", secret: false, action: "Set to postgres before retaining Demo evidence, followers, or subscription state." },
  { name: "MARKETPLACE_WORKER_INTERVAL_MS", secret: false, action: "Set or accept the documented worker pass cadence." },
  { name: "MARKETPLACE_OUTBOX_BATCH", secret: false, action: "Set or accept the documented maximum outbox rows claimed by one worker pass." },
  { name: "MARKETPLACE_SHUTDOWN_GRACE_MS", secret: false, action: "Set or accept the documented worker shutdown grace period." },
  { name: "MARKETPLACE_DATABASE_URL", secret: true, action: "Set the private PostgreSQL connection string in the Marketplace service environment." },
  { name: "MARKETPLACE_INTENT_KEY_ID", secret: false, action: "Configure the id of the Ed25519 key that signs follower intents." },
  { name: "MARKETPLACE_INTENT_SIGNING_SEED", secret: true, action: "Configure the 32-byte base64url Ed25519 signing seed in the private service only." },
  { name: "LIQHUNTER_HUB_KEY", secret: true, action: "Configure the private Hub principal used by Marketplace admin routes." },
  { name: "MARKETPLACE_ADMIN_LICENCES", secret: false, action: "Optionally list additional alpha operator licence ids; the Hub principal remains administrator." },
  { name: "MARKETPLACE_DEMO_MASTER_API_KEY", secret: true, action: "Set the WickHunter-owned Bybit Demo master API key." },
  { name: "MARKETPLACE_DEMO_MASTER_API_SECRET", secret: true, action: "Set the WickHunter-owned Bybit Demo master API secret." },
  { name: "MARKETPLACE_DEMO_VAULT_PATH", secret: false, action: "Set the private encrypted Demo credential vault location." },
  { name: "MARKETPLACE_DEMO_VAULT_KEY", secret: true, action: "Set the canonical base64url 32-byte Demo vault key." },
  { name: "MARKETPLACE_DEMO_WORKER_CREDENTIAL", secret: true, action: "Set the dedicated Demo receipt/worker credential (minimum 32 characters)." },
  { name: "MARKETPLACE_DEMO_EVIDENCE_INTERVAL_MS", secret: false, action: "Set or accept the documented Demo evidence collection cadence." },
  { name: "MARKETPLACE_DEMO_EVIDENCE_MAX_AGE_MS", secret: false, action: "Set the maximum evidence age used by Marketplace sellability gates." },
  { name: "MOONPAY_COMMERCE_ENVIRONMENT", secret: false, action: "Choose development or production explicitly for the crypto-only rail." },
  { name: "MOONPAY_COMMERCE_PUBLIC_KEY", secret: false, action: "Set the MoonPay Commerce public API key." },
  { name: "MOONPAY_COMMERCE_SECRET_KEY", secret: true, action: "Set the MoonPay Commerce server secret in the private service only." },
  { name: "MOONPAY_COMMERCE_WEBHOOK_SHARED_TOKEN", secret: true, action: "Set the dedicated raw-webhook authentication token." },
  { name: "MOONPAY_COMMERCE_PRICING_CURRENCY_ID", secret: false, action: "Set the vendor currency id used for subscription pricing." },
  { name: "MOONPAY_COMMERCE_PRICING_ASSET", secret: false, action: "Set the one crypto pricing asset accepted by published strategies." },
  { name: "MOONPAY_COMMERCE_RECIPIENTS_JSON", secret: true, action: "Set exactly one crypto recipient; revenue splits and card payments are unsupported." },
  { name: "MOONPAY_COMMERCE_MONTHLY_INTERVAL", secret: false, action: "Set the vendor's exact monthly subscription interval word." },
  { name: "MOONPAY_COMMERCE_YEARLY_INTERVAL", secret: false, action: "Set the vendor's exact yearly subscription interval word." },
  { name: "LIQHUNTER_MARKETPLACE_URL", secret: false, action: "Point each alpha app install's server-side proxy at the private Marketplace origin." },
  { name: "LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", secret: false, action: "Ship the Marketplace intent verification keyring to alpha app installs before enabling signals." },
]);

function parseTimeout(raw: string | undefined): { value: number; refusal: string | null } {
  if (raw === undefined) return { value: 3_000, refusal: null };
  if (!/^\d+$/.test(raw)) return { value: 3_000, refusal: "HUB_MARKETPLACE_STATUS_TIMEOUT_MS must be digits only." };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 250 || value > 15_000) {
    return { value: 3_000, refusal: "HUB_MARKETPLACE_STATUS_TIMEOUT_MS must be from 250 through 15000." };
  }
  return { value, refusal: null };
}

function loopbackOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    if (!loopback || !(u.protocol === "http:" || u.protocol === "https:") || u.username || u.password
      || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
    return u.origin;
  } catch { return null; }
}

export function marketplaceStatusBridgeFromEnv(env: NodeJS.ProcessEnv): MarketplaceStatusBridgeConfig {
  const refusals: string[] = [];
  const rawOrigin = env.HUB_MARKETPLACE_STATUS_ORIGIN?.trim() ?? "";
  const rawCredential = env.HUB_MARKETPLACE_STATUS_CREDENTIAL?.trim() ?? "";
  const origin = rawOrigin ? loopbackOrigin(rawOrigin) : null;
  if (rawOrigin && origin === null) {
    refusals.push("HUB_MARKETPLACE_STATUS_ORIGIN must be an exact http(s) loopback origin with no credentials, path, query, or fragment.");
  }
  const credential = rawCredential.length >= 32 ? rawCredential : null;
  if (rawCredential && credential === null) {
    refusals.push("HUB_MARKETPLACE_STATUS_CREDENTIAL must contain at least 32 characters.");
  }
  if ((rawOrigin === "") !== (rawCredential === "")) {
    // The individual missing name below is the actionable part; keep both
    // halves atomic so a half-configured bridge never sends a bearer nowhere.
    refusals.push(`${origin === null ? "HUB_MARKETPLACE_STATUS_ORIGIN" : "HUB_MARKETPLACE_STATUS_CREDENTIAL"} is required when the other Marketplace status bridge value is configured.`);
  }
  const timeout = parseTimeout(env.HUB_MARKETPLACE_STATUS_TIMEOUT_MS);
  if (timeout.refusal) refusals.push(timeout.refusal);
  return { origin, credential, timeoutMs: timeout.value, refusals };
}

function staticInputs(config: MarketplaceStatusBridgeConfig): MarketplaceRequiredInput[] {
  const local: MarketplaceRequiredInput[] = [
    {
      name: "HUB_MARKETPLACE_STATUS_ORIGIN",
      state: config.origin ? "configured" : config.refusals.some((r) => r.includes("HUB_MARKETPLACE_STATUS_ORIGIN")) ? "invalid" : "missing",
      secret: false,
      detail: config.origin ? "A loopback Marketplace status origin is configured." : "The public Hub has no private Marketplace status origin.",
      action: "Set this to the private Marketplace API's exact loopback origin, for example http://127.0.0.1:8099.",
      ...(config.origin ? { safeValue: config.origin } : {}),
    },
    {
      name: "HUB_MARKETPLACE_STATUS_CREDENTIAL",
      state: config.credential ? "configured" : config.refusals.some((r) => r.includes("HUB_MARKETPLACE_STATUS_CREDENTIAL")) ? "invalid" : "missing",
      secret: true,
      detail: config.credential ? "A dedicated server-side status credential is configured; its value is never returned." : "The public Hub cannot authenticate to the private status route.",
      action: "Set the same dedicated value in HUB_MARKETPLACE_STATUS_CREDENTIAL on both services; do not reuse HUB_ADMIN_TOKEN or LIQHUNTER_HUB_KEY.",
    },
  ];
  return local.concat(PRIVATE_REQUIRED.map((row) => ({
    ...row,
    state: "unverified" as const,
    detail: "The private Marketplace service is unavailable, so this input cannot be verified from the public Hub.",
  })));
}

const SECRET_FIELD = /(?:secret|token|credential|password|private|database.?url|connection|string|vault.?key|api.?key|authorization|raw.?url|path|wallet|recipients?|address)$/i;
const PROSE_FIELD = /(?:detail|action|message|error|refusal|blocker|warning)s?$/i;

function redactText(value: string, explicitSecrets: readonly string[], prose: boolean): string {
  let text = value;
  for (const secret of explicitSecrets) {
    if (secret.length >= 8) text = text.split(secret).join("[redacted]");
  }
  text = text
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi, "[redacted-database-url]")
    .replace(/\b(Authorization\s*:\s*Bearer|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|CREDENTIAL|PASSWORD|DATABASE_URL|VAULT_KEY|API_KEY)[A-Z0-9_]*)\s*=\s*[^\s,;]+/g,
      "$1=[redacted]");
  // Detail/action/blocker prose has no legitimate opaque credential value.
  // Do not apply this to structured build commits, public key ids, or counts.
  if (prose) text = text.replace(/\b[A-Za-z0-9_+\/.=-]{40,}\b/g, "[redacted-opaque-value]");
  return text.slice(0, 1_000);
}

function sanitized(value: unknown, explicitSecrets: readonly string[], depth = 0, key = ""): unknown {
  if (SECRET_FIELD.test(key) && key !== "publicKey") return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactText(value, explicitSecrets, PROSE_FIELD.test(key));
  if (depth >= 5) return undefined;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitized(item, explicitSecrets, depth + 1, key)).filter((item) => item !== undefined);
  if (typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)) continue;
    const clean = sanitized(item, explicitSecrets, depth + 1, name);
    if (clean !== undefined) out[name] = clean;
  }
  return out;
}

function inputOf(value: unknown, explicitSecrets: readonly string[]): MarketplaceRequiredInput | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const states: readonly MarketplaceInputState[] = ["configured", "missing", "invalid", "defaulted"];
  if (typeof r.name !== "string" || !/^[A-Z][A-Z0-9_]{1,95}$/.test(r.name)
    || !states.includes(r.state as MarketplaceInputState) || typeof r.secret !== "boolean"
    || typeof r.detail !== "string" || typeof r.action !== "string") return null;
  const safeValue = r.secret === false && typeof r.safeValue === "string"
    ? redactText(r.safeValue, explicitSecrets, true).slice(0, 300) : undefined;
  return {
    name: r.name, state: r.state as MarketplaceInputState, secret: r.secret,
    detail: redactText(r.detail, explicitSecrets, true), action: redactText(r.action, explicitSecrets, true),
    ...(safeValue === undefined ? {} : { safeValue }),
  };
}

const UPSTREAM_FIELDS = [
  "schemaVersion", "generatedAtMs", "build", "service", "feature", "api", "worker",
  "storage", "outbox", "bybitDemo", "moonPay", "readiness",
] as const;

export async function fetchMarketplaceStatus(
  config: MarketplaceStatusBridgeConfig,
  fetcher: MarketplaceStatusFetch,
  now = Date.now,
): Promise<MarketplaceStatusBridgeSnapshot> {
  const generatedAtMs = now();
  const base = {
    schemaVersion: 1 as const,
    generatedAtMs,
    requiredInputs: staticInputs(config),
  };
  if (config.refusals.length > 0) return {
    ...base, bridge: { state: "invalid", originConfigured: config.origin !== null, credentialConfigured: config.credential !== null, refusal: config.refusals.join(" ") },
    upstream: null, readinessBlockers: config.refusals,
  };
  if (config.origin === null || config.credential === null) return {
    ...base, bridge: { state: "unconfigured", originConfigured: config.origin !== null, credentialConfigured: config.credential !== null, refusal: "The Marketplace status bridge is not configured." },
    upstream: null, readinessBlockers: ["The private Marketplace service cannot be inspected from this Hub."],
  };
  let upstreamStatus: number | null = null;
  try {
    const response = await fetcher(`${config.origin}/api/marketplace/operator/status`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${config.credential}` },
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
    });
    upstreamStatus = response.status;
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error("status response exceeded 1 MB");
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new Error("status response was not JSON"); }
    if (!response.ok || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`private Marketplace status answered HTTP ${response.status}`);
    }
    const envelope = raw as Record<string, unknown>;
    if (envelope.ok !== true || envelope.status === null || typeof envelope.status !== "object"
      || Array.isArray(envelope.status)) throw new Error("private Marketplace status envelope was invalid");
    const row = envelope.status as Record<string, unknown>;
    if (row.schemaVersion !== "wickhunter-marketplace-operator-status/v1") {
      throw new Error("private Marketplace status schema was unsupported");
    }
    const explicitSecrets = [config.credential];
    const upstream: Record<string, unknown> = {};
    for (const field of UPSTREAM_FIELDS) {
      const clean = sanitized(row[field], explicitSecrets, 0, field);
      if (clean !== undefined) upstream[field] = clean;
    }
    const remoteInputs = Array.isArray(row.requiredInputs)
      ? row.requiredInputs.map((value) => inputOf(value, explicitSecrets)).filter((v): v is MarketplaceRequiredInput => v !== null) : [];
    const localInputs = staticInputs(config).slice(0, 2);
    const readiness = row.readiness !== null && typeof row.readiness === "object" && !Array.isArray(row.readiness)
      ? row.readiness as Record<string, unknown> : {};
    const blockers = Array.isArray(readiness.blockers)
      ? readiness.blockers.filter((v): v is string => typeof v === "string").slice(0, 100)
        .map((v) => redactText(v, explicitSecrets, true))
      : [];
    return {
      schemaVersion: 1,
      generatedAtMs,
      bridge: { state: "connected", originConfigured: true, credentialConfigured: true, refusal: null },
      upstream,
      requiredInputs: [...localInputs, ...remoteInputs],
      readinessBlockers: blockers,
    };
  } catch {
    const credentialRefused = upstreamStatus === 401 || upstreamStatus === 403 || upstreamStatus === 503;
    const inputs = staticInputs(config);
    if (credentialRefused && inputs[1]) inputs[1] = {
      ...inputs[1], state: "invalid",
      detail: "The public Hub has a status credential, but the private Marketplace service refused or has not configured it.",
      action: "Set the same dedicated HUB_MARKETPLACE_STATUS_CREDENTIAL value on both services, then restart the private service and this Hub.",
    };
    return {
      ...base, requiredInputs: inputs,
      bridge: {
        state: credentialRefused ? "invalid" : "unavailable", originConfigured: true, credentialConfigured: true,
        refusal: credentialRefused
          ? "The private Marketplace status endpoint refused or has not configured the dedicated status credential."
          : "The private Marketplace status service did not return a usable authenticated response.",
      },
      upstream: null,
      readinessBlockers: [credentialRefused
        ? "The Marketplace status credential is not accepted on both services; no readiness claim can be made."
        : "The private Marketplace API/worker status is unavailable; no readiness claim can be made."],
    };
  }
}
