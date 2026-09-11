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

/** Every state a Hub administrator can be shown for the bridge itself —
 * kept as ONE closed union with ONE distinct sentence per state so a
 * private-service outage is structurally incapable of rendering the same
 * way as an admin-token problem (which never reaches this path at all —
 * that is a 401 on the Hub's OWN admin auth, handled before this module is
 * ever called) or as a rejected bridge credential (`"invalid"`, unchanged).
 * `"incompatible"` is new: the private service answered, authenticated,
 * and returned a well-formed envelope whose `schemaVersion` this Hub does
 * not speak — a PROTOCOL fact, distinct from `"unavailable"` (no usable
 * answer at all) and from `"invalid"` (the bridge credential itself was
 * refused). Conflating any of these back into one bucket is exactly the
 * failure HUB-03 exists to close. */
export type MarketplaceBridgeState = "connected" | "unconfigured" | "invalid" | "incompatible" | "unavailable";

/** HUB-03: "show mismatched app/API/worker protocol versions and guide the
 * operator to update the exact component" — computed ONCE, server-side,
 * from facts the private service already publishes (`build`, `worker`),
 * never re-derived by the browser from raw JSON. `worker.buildState` is the
 * private service's OWN comparison of its worker's build against its API's
 * build (`operator-status.ts`, app repo) — this module never recomputes
 * that judgement, only renders it. The Hub's OWN package version is
 * reported for context but is DELIBERATELY never compared numerically
 * against the API's — the Hub and the private Marketplace API are
 * independently released components in separate repositories with no
 * shared version scheme, and asserting they "should" match would be a
 * guess this module has no standing to make. */
export interface MarketplaceVersionCompatibility {
  readonly state: "aligned" | "mismatched" | "unknown";
  readonly hub: { readonly version: string };
  readonly api: { readonly version: string | null; readonly commit: string | null } | null;
  readonly worker: {
    readonly version: string | null;
    readonly buildCommit: string | null;
    readonly buildState: "matched" | "missing" | "mismatched" | null;
  } | null;
  /** One plain sentence per actionable finding, each naming the EXACT
   * component to update ("the private Marketplace API", "the private
   * Marketplace worker", or "this Hub") — never a bare "mismatch" with
   * nothing to act on. Empty when nothing here is actionable. */
  readonly guidance: readonly string[];
}

export interface MarketplaceStatusBridgeSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAtMs: number;
  readonly bridge: {
    readonly state: MarketplaceBridgeState;
    readonly originConfigured: boolean;
    readonly credentialConfigured: boolean;
    readonly refusal: string | null;
  };
  readonly upstream: Readonly<Record<string, unknown>> | null;
  readonly requiredInputs: readonly MarketplaceRequiredInput[];
  readonly readinessBlockers: readonly string[];
  /** `null` whenever `upstream` is `null` — there is nothing to compare. */
  readonly versionCompatibility: MarketplaceVersionCompatibility | null;
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
  { name: "MARKETPLACE_SUBSCRIPTION_MODE", secret: false, action: "The Hub fixes this to mock while MoonPay is deferred; do not enable a payment mode." },
  { name: "MARKETPLACE_HTTP_HOST", secret: false, action: "Keep the private API on loopback unless an authenticated private network is deliberately configured." },
  { name: "MARKETPLACE_HTTP_PORT", secret: false, action: "Set the private Marketplace API listen port, or use its documented default." },
  { name: "MARKETPLACE_STORE", secret: false, action: "Set to postgres before retaining Demo evidence, followers, or subscription state." },
  { name: "MARKETPLACE_WORKER_INTERVAL_MS", secret: false, action: "Set or accept the documented worker pass cadence." },
  { name: "MARKETPLACE_OUTBOX_BATCH", secret: false, action: "Set or accept the documented maximum outbox rows claimed by one worker pass." },
  { name: "MARKETPLACE_SHUTDOWN_GRACE_MS", secret: false, action: "Set or accept the documented worker shutdown grace period." },
  { name: "MARKETPLACE_DATABASE_URL", secret: true, action: "Set the private PostgreSQL connection string in the Marketplace service environment." },
  { name: "MARKETPLACE_INTENT_KEY_ID", secret: false, action: "Configure the id of the Ed25519 key that signs follower intents." },
  { name: "MARKETPLACE_INTENT_SIGNING_SEED", secret: true, action: "Configure the 32-byte base64url Ed25519 signing seed in the private service only." },
  { name: "MARKETPLACE_OPERATOR_STATUS_CREDENTIAL", secret: true, action: "Set the same dedicated value as HUB_MARKETPLACE_STATUS_CREDENTIAL on the public Hub." },
  { name: "MARKETPLACE_RUNTIME_DIRECTORY", secret: false, action: "Use the shared API/worker StateDirectory created by the Marketplace service units." },
  { name: "MARKETPLACE_BUILD_COMMIT", secret: false, action: "Stamp the exact hexadecimal source commit installed in both the API and worker." },
  { name: "LIQHUNTER_HUB_KEY", secret: true, action: "Configure the private Hub principal used by Marketplace admin routes." },
  { name: "MARKETPLACE_ADMIN_LICENCES", secret: true, action: "Set the approved Marketplace administrator licence principals." },
  { name: "MARKETPLACE_DEMO_MASTER_API_KEY", secret: true, action: "Set the WickHunter-owned Bybit Demo master API key." },
  { name: "MARKETPLACE_DEMO_MASTER_API_SECRET", secret: true, action: "Set the WickHunter-owned Bybit Demo master API secret." },
  { name: "MARKETPLACE_DEMO_VAULT_PATH", secret: false, action: "Set the private encrypted Demo credential vault location." },
  { name: "MARKETPLACE_DEMO_VAULT_KEY", secret: true, action: "Set the canonical base64url 32-byte Demo vault key." },
  { name: "MARKETPLACE_DEMO_WORKER_CREDENTIAL", secret: true, action: "Set the dedicated Demo receipt/worker credential (minimum 32 characters)." },
  { name: "MARKETPLACE_DEMO_EVIDENCE_INTERVAL_MS", secret: false, action: "Set or accept the documented Demo evidence collection cadence." },
  { name: "MARKETPLACE_DEMO_EVIDENCE_MAX_AGE_MS", secret: false, action: "Set the maximum evidence age used by Marketplace sellability gates." },
  { name: "MOONPAY_COMMERCE_ENVIRONMENT", secret: false, action: "Deferred in mock mode; no operator input is accepted or stored." },
  { name: "MOONPAY_COMMERCE_PUBLIC_KEY", secret: true, action: "Deferred in mock mode; no operator input is accepted or stored." },
  { name: "MOONPAY_COMMERCE_SECRET_KEY", secret: true, action: "Deferred in mock mode; no operator input is accepted or stored." },
  { name: "MOONPAY_COMMERCE_WEBHOOK_SHARED_TOKEN", secret: true, action: "Deferred in mock mode; no operator input is accepted or stored." },
  { name: "MOONPAY_COMMERCE_PRICING_CURRENCY_ID", secret: false, action: "Deferred in mock mode; no operator input is accepted or stored." },
  { name: "MOONPAY_COMMERCE_PRICING_ASSET", secret: false, action: "Deferred in mock mode; no operator input is accepted or stored." },
  { name: "MOONPAY_COMMERCE_RECIPIENTS_JSON", secret: true, action: "Deferred in mock mode; a future crypto-only rail must still refuse revenue shares and cards." },
  { name: "MOONPAY_COMMERCE_MONTHLY_INTERVAL", secret: false, action: "Deferred in mock mode; no operator input is accepted or stored." },
  { name: "MOONPAY_COMMERCE_YEARLY_INTERVAL", secret: false, action: "Deferred in mock mode; no operator input is accepted or stored." },
  { name: "LIQHUNTER_MARKETPLACE_URL", secret: false, action: "Set the exact public HTTPS Marketplace origin distributed to every alpha app install." },
  { name: "LIQHUNTER_MARKETPLACE_INTENT_PUBLIC_KEYS", secret: false, action: "Ship the Marketplace intent verification keyring to alpha app installs and verify it matches the live signer before enabling signals." },
  { name: "MARKETPLACE_ALPHA_LICENCE_FEATURE_CONFIRMED", secret: false, action: "Set to 1 only after the Marketplace feature grant is live for the alpha licence cohort." },
  { name: "MARKETPLACE_ALPHA_LICENCES", secret: true, action: "Set the exact server-enforced alpha licence cohort; removing an id becomes exit-only after private-service restart." },
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

/** The exact operator-status wire contract this Hub's bridge speaks — kept
 * as a named constant (rather than the bare literal the schema check used
 * to compare against inline) because HUB-03's version-mismatch sentence
 * needs to quote it and a test needs to drive that comparison. Mirrors the
 * app repo's own `MARKETPLACE_OPERATOR_STATUS_SCHEMA` export
 * (`src/marketplace-hub/operator-status.ts`) — the two are independent
 * repos, so this is a value this Hub commits to on its own, not an import. */
export const MARKETPLACE_STATUS_SCHEMA = "wickhunter-marketplace-operator-status/v1";
const SCHEMA_VERSION_SHAPE = /^wickhunter-marketplace-operator-status\/v\d{1,4}$/;

const UPSTREAM_FIELDS = [
  "schemaVersion", "generatedAtMs", "build", "service", "feature", "api", "alphaClient", "worker",
  "storage", "outbox", "subscriptionBilling", "bybitDemo", "moonPay", "readiness", "latency",
] as const;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function memberOf<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? value as T[number] : undefined;
}

/**
 * Alpha distribution proof is deliberately an exact state-only allowlist.
 * A compromised or newer private service cannot make the public Hub echo its
 * raw origin, verifier keyring, probe error, or credentials through this card.
 */
function sanitizeAlphaClient(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const row = recordOf(value);
  if (row === null) return undefined;
  const state = memberOf(row.state, ["ready", "blocked"] as const);
  const audience = memberOf(row.audience, ["alpha"] as const);
  const origin = recordOf(row.origin);
  const originState = memberOf(origin?.state, ["configured", "missing", "invalid"] as const);
  const reachability = memberOf(origin?.reachability, ["healthy", "blocked", "unknown"] as const);
  const keyDistribution = recordOf(row.intentPublicKeyDistribution);
  const keyState = memberOf(keyDistribution?.state, ["aligned", "missing", "invalid", "mismatched"] as const);
  const licenceFeature = recordOf(row.licenceFeature);
  const licenceState = memberOf(licenceFeature?.state, ["confirmed", "missing", "invalid"] as const);
  if (state === undefined || audience === undefined || originState === undefined || reachability === undefined
    || keyState === undefined || licenceState === undefined) return undefined;
  const factsReady = originState === "configured" && reachability === "healthy"
    && keyState === "aligned" && licenceState === "confirmed";
  if ((state === "ready") !== factsReady) return undefined;
  return {
    state, audience,
    origin: { state: originState, reachability },
    intentPublicKeyDistribution: { state: keyState },
    licenceFeature: { state: licenceState },
  };
}

function sanitizeService(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const row = recordOf(value);
  return row?.name === "wickhunter-marketplace" && row.audience === "alpha"
    && row.enabled === true && row.betaIncluded === false
    ? { name: "wickhunter-marketplace", audience: "alpha", enabled: true, betaIncluded: false }
    : undefined;
}

function sanitizeStorage(value: unknown, explicitSecrets: readonly string[]): unknown {
  const clean = sanitized(value, explicitSecrets, 0, "storage");
  const storage = recordOf(clean);
  const migrations = recordOf(storage?.migrations);
  if (migrations === null) return clean;
  const invalidEntries = migrations.invalidEntries;
  if (!(Number.isSafeInteger(invalidEntries) && Number(invalidEntries) >= 0 && Number(invalidEntries) <= 1_000_000)) {
    delete migrations.invalidEntries;
  }
  return clean;
}

function versionRecordOf(value: unknown): { version: string | null; commit: string | null } | null {
  const row = recordOf(value);
  if (row === null) return null;
  return {
    version: typeof row.version === "string" && row.version.length > 0 && row.version.length <= 64 ? row.version : null,
    commit: typeof row.commit === "string" && /^[a-f0-9]{7,64}$/i.test(row.commit) ? row.commit : null,
  };
}

const WORKER_BUILD_STATES = ["matched", "missing", "mismatched"] as const;

/** Pure (v0.80.6-style — a caller may only call it): HUB-03's exact ask,
 * "show mismatched app/API/worker protocol versions and guide the operator
 * to update the exact component", built from the ALREADY-SANITIZED
 * `upstream.build`/`upstream.worker` so it can never see a secret this
 * module has not already redacted. */
export function marketplaceVersionCompatibility(
  hubVersion: string,
  upstream: Readonly<Record<string, unknown>>,
): MarketplaceVersionCompatibility {
  const api = versionRecordOf(upstream.build);
  const workerRow = recordOf(upstream.worker);
  const buildState = workerRow !== null && typeof workerRow.buildState === "string"
    && (WORKER_BUILD_STATES as readonly string[]).includes(workerRow.buildState)
    ? workerRow.buildState as (typeof WORKER_BUILD_STATES)[number] : null;
  const worker = workerRow === null ? null : {
    version: typeof workerRow.version === "string" && workerRow.version.length > 0 && workerRow.version.length <= 64 ? workerRow.version : null,
    buildCommit: typeof workerRow.buildCommit === "string" && /^[a-f0-9]{7,64}$/i.test(workerRow.buildCommit) ? workerRow.buildCommit : null,
    buildState,
  };
  const guidance: string[] = [];
  if (api === null) {
    guidance.push("The private Marketplace API has not reported a build — update or restart the private Marketplace API service.");
  }
  if (buildState === "mismatched") {
    guidance.push("The private Marketplace worker is running a different build than the private Marketplace API — update the private Marketplace WORKER service to the same commit as the API.");
  } else if (buildState === "missing" || (workerRow !== null && buildState === null)) {
    guidance.push("The private Marketplace worker has not reported a build — update or restart the private Marketplace WORKER service.");
  } else if (workerRow === null) {
    guidance.push("The private Marketplace status did not report a worker — update or restart the private Marketplace WORKER service.");
  }
  const state: MarketplaceVersionCompatibility["state"] =
    api === null || worker === null || buildState === null ? "unknown"
      : buildState === "matched" ? "aligned" : "mismatched";
  return { state, hub: { version: hubVersion }, api, worker, guidance };
}

export async function fetchMarketplaceStatus(
  config: MarketplaceStatusBridgeConfig,
  fetcher: MarketplaceStatusFetch,
  now = Date.now,
  hubVersion = "0.0.0",
): Promise<MarketplaceStatusBridgeSnapshot> {
  const generatedAtMs = now();
  const base = {
    schemaVersion: 1 as const,
    generatedAtMs,
    requiredInputs: staticInputs(config),
  };
  if (config.refusals.length > 0) return {
    ...base, bridge: { state: "invalid", originConfigured: config.origin !== null, credentialConfigured: config.credential !== null, refusal: config.refusals.join(" ") },
    upstream: null, readinessBlockers: config.refusals, versionCompatibility: null,
  };
  if (config.origin === null || config.credential === null) return {
    ...base, bridge: { state: "unconfigured", originConfigured: config.origin !== null, credentialConfigured: config.credential !== null, refusal: "The Marketplace status bridge is not configured." },
    upstream: null, readinessBlockers: ["The private Marketplace service cannot be inspected from this Hub."], versionCompatibility: null,
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
    if (typeof row.schemaVersion !== "string" || !SCHEMA_VERSION_SHAPE.test(row.schemaVersion)) {
      throw new Error("private Marketplace status schema was unreadable");
    }
    if (row.schemaVersion !== MARKETPLACE_STATUS_SCHEMA) {
      // A well-formed, AUTHENTICATED answer whose protocol this Hub does not
      // speak is a fact about the two builds, never about the credential —
      // HUB-03: "never conflate an unavailable service with an invalid
      // credential", extended to a THIRD, equally distinct case. The value
      // reaching the sentence below has already matched SCHEMA_VERSION_SHAPE
      // above, so it is a small fixed-pattern token, never arbitrary text.
      return {
        schemaVersion: 1, generatedAtMs,
        bridge: {
          state: "incompatible", originConfigured: true, credentialConfigured: true,
          refusal: `This Hub speaks Marketplace operator-status protocol ${MARKETPLACE_STATUS_SCHEMA}; the private Marketplace API answered ${row.schemaVersion}. Update whichever of this Hub or the private Marketplace API is on the older protocol so both report the same value.`,
        },
        upstream: null,
        requiredInputs: staticInputs(config),
        readinessBlockers: ["The private Marketplace API's operator-status protocol version does not match this Hub's bridge — no readiness claim can be made until they agree."],
        versionCompatibility: null,
      };
    }
    const explicitSecrets = [config.credential];
    const upstream: Record<string, unknown> = {};
    for (const field of UPSTREAM_FIELDS) {
      const clean = field === "alphaClient" ? sanitizeAlphaClient(row[field])
        : field === "service" ? sanitizeService(row[field])
        : field === "storage" ? sanitizeStorage(row[field], explicitSecrets)
          : sanitized(row[field], explicitSecrets, 0, field);
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
    if (upstream.service === undefined) {
      blockers.push("The private Marketplace status did not prove an alpha-only service with beta excluded.");
    }
    if (upstream.alphaClient === undefined) {
      blockers.push("The private Marketplace status did not provide a valid alpha-client readiness proof.");
    }
    const rawMigrations = recordOf(recordOf(row.storage)?.migrations);
    if (rawMigrations !== null && Object.hasOwn(rawMigrations, "invalidEntries")
      && recordOf(recordOf(upstream.storage)?.migrations)?.invalidEntries === undefined) {
      blockers.push("The private Marketplace status returned an invalid migration-history count.");
    }
    return {
      schemaVersion: 1,
      generatedAtMs,
      bridge: { state: "connected", originConfigured: true, credentialConfigured: true, refusal: null },
      upstream,
      requiredInputs: [...localInputs, ...remoteInputs],
      readinessBlockers: [...new Set(blockers)],
      versionCompatibility: marketplaceVersionCompatibility(hubVersion, upstream),
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
      versionCompatibility: null,
    };
  }
}
