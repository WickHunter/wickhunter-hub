// src/hosting/provider.ts
// The infrastructure-provider seam. `HostingProvider` is the whole contract
// src/hosting/service.ts is written against; `FakeProvider` is the only
// implementation any test ever exercises (deterministic, in-memory, no
// network); `VultrProvider` is the real HTTP client and is NEVER constructed
// or called by the test suite — nothing here makes a live Vultr call unless
// an operator supplies a real API key at runtime.
//
// DETERMINISTIC LABELLING IS THE CRASH-RECOVERY MECHANISM (H4/H6's "crash
// between persist and provider create -> reconciled by findByLabel, never a
// second create"). `hostingInstanceLabel(id, generation)` is the ONE place
// that decides what a provider resource is tagged with, and it is a pure
// function of facts already durable in the row BEFORE any provider call is
// made (src/hosting/store.ts persists the row first) — so after a crash the
// recovery path can always recompute the exact label it would have used and
// ask the provider "does a resource with this label already exist" before
// ever calling createInstance again.
import { createHash } from "node:crypto";

/** Deterministic per-(instance, generation) label. A fresh replacement
 *  instance gets a new generation (H6: "preserve provider, DNS, installation
 *  identity and generation throughout replacement"), so a stale label from a
 *  torn-down previous attempt can never collide with — or be mistaken for —
 *  the current one. Kept short and provider-safe (Vultr labels/tags accept
 *  ASCII; this is lowercase alnum/dash only). */
export function hostingInstanceLabel(instanceId: string, generation: number): string {
  return `wh-hosting-${instanceId}-g${generation}`;
}

/** An opaque, unguessable per-instance-generation bootstrap token. The
 *  cloud-init script carries only this (plus the label), never a
 *  company-wide provider/Stripe/email credential (H6 §6). Hashed at rest by
 *  the store; this module only mints the raw value. */
export function mintBootstrapToken(randomBytes: (n: number) => Buffer): string {
  return randomBytes(24).toString("base64url");
}

export function hashBootstrapToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface ProviderPlan {
  id: string;
  vcpus: number;
  ramMb: number;
  diskGb: number;
  monthlyCostCents: number;
}
export interface ProviderRegion {
  id: string;
  label: string;
}

export interface CreateInstanceRequest {
  /** `hostingInstanceLabel(...)` — the provider's own label/tag field. */
  label: string;
  regionId: string;
  planId: string;
  osId: string;
  /** Cloud-init user-data, plaintext (base64 is the WIRE encoding the
   *  provider API wants, never a secrecy boundary — H6 §6). Built by
   *  src/hosting/bootstrap.ts. */
  userData: string;
  /** Provider-side tag(s) beside the label, for admin-page cross-reference. */
  tags?: readonly string[];
}

export interface ProviderInstance {
  providerInstanceId: string;
  label: string;
  regionId: string;
  planId: string;
  status: "pending" | "active" | "stopped" | "unknown";
  /** null until the provider has assigned one. */
  mainIp: string | null;
  createdAtMs: number;
}

export type PowerState = "on" | "off";

/** The whole adapter surface src/hosting/service.ts needs. Every method
 *  that reaches the network is async and may throw; the lifecycle treats a
 *  thrown error as "uncertain", never as "definitely failed" or "definitely
 *  succeeded" (H6's delete-transaction section, and the same rule applied to
 *  create: an API timeout after a real create is `findByLabel`'s job to
 *  discover, not a reason to assume failure and retry blindly). */
export interface HostingProvider {
  listRegions(): Promise<ProviderRegion[]>;
  listPlans(): Promise<ProviderPlan[]>;
  /** Create a new instance. The caller (service.ts) has ALREADY persisted
   *  the durable row and its label before calling this — this method must
   *  never be the first place an instance's existence is recorded. */
  createInstance(req: CreateInstanceRequest): Promise<ProviderInstance>;
  getInstance(providerInstanceId: string): Promise<ProviderInstance | null>;
  /** The crash-recovery read: does a resource with this exact label already
   *  exist. Used BEFORE retrying createInstance after an uncertain outcome
   *  (timeout, 5xx, connection reset) — never used to decide anything about
   *  an instance whose id is already known. */
  findByLabel(label: string): Promise<ProviderInstance | null>;
  power(providerInstanceId: string, state: PowerState): Promise<void>;
  /** Best-effort, MUST be idempotent: deleting an already-gone instance is a
   *  success, never a throw (the delete pipeline's own confirm step reads
   *  provider state independently — see service.ts's `confirmDeleted`). */
  deleteInstance(providerInstanceId: string): Promise<void>;
}

// ── FakeProvider — the only implementation the test suite ever exercises ───

interface FakeRow extends ProviderInstance {}

export interface FakeProviderOptions {
  now?: () => number;
  /** Simulate an uncertain create: the provider actually creates the
   *  resource but the response never reaches the caller (a timeout). The
   *  NEXT createInstance call with a NEW label still succeeds normally;
   *  what matters for the crash-recovery test is that `findByLabel` can see
   *  the orphaned resource from the FIRST attempt. */
  createTimesOutOnce?: boolean;
}

/** Deterministic, synchronous-fast, in-memory. Every method still returns a
 *  Promise (the interface is async) but never actually waits on anything —
 *  a suite drives thousands of lifecycle ticks in milliseconds. */
export class FakeProvider implements HostingProvider {
  private readonly rows = new Map<string, FakeRow>();
  private seq = 0;
  private readonly now: () => number;
  private timeoutArmed: boolean;
  readonly regions: ProviderRegion[] = [{ id: "nrt", label: "Tokyo" }, { id: "itm", label: "Osaka" }];
  readonly plans: ProviderPlan[] = [{ id: "vc2-1c-2gb", vcpus: 1, ramMb: 2048, diskGb: 55, monthlyCostCents: 1000 }];
  /** Calls made, for a test to assert exactly-once creation across a crash
   *  simulation. */
  createCalls: CreateInstanceRequest[] = [];

  constructor(opts: FakeProviderOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.timeoutArmed = !!opts.createTimesOutOnce;
  }

  async listRegions(): Promise<ProviderRegion[]> { return this.regions.map((r) => ({ ...r })); }
  async listPlans(): Promise<ProviderPlan[]> { return this.plans.map((p) => ({ ...p })); }

  async createInstance(req: CreateInstanceRequest): Promise<ProviderInstance> {
    this.createCalls.push(req);
    // A resource with this exact label already exists — a caller that
    // retries after an uncertain outcome without checking findByLabel first
    // would otherwise get a SECOND resource for one order, which is exactly
    // the defect H4/H6 exist to prevent. FakeProvider enforces it as a
    // thrown error so a lifecycle bug surfaces in the test that exercises
    // this path, rather than silently minting a duplicate.
    for (const row of this.rows.values()) if (row.label === req.label) throw new Error(`fake provider: label ${req.label} already exists (would be a duplicate create)`);
    const id = `fake-${++this.seq}`;
    const row: FakeRow = { providerInstanceId: id, label: req.label, regionId: req.regionId, planId: req.planId, status: "active", mainIp: `203.0.113.${this.seq}`, createdAtMs: this.now() };
    if (this.timeoutArmed) {
      // The resource IS created (it is in `this.rows` after this branch
      // too), but the caller never learns its id — modelling an API
      // timeout/connection-reset AFTER the provider actually acted.
      this.timeoutArmed = false;
      this.rows.set(id, row);
      throw new Error("fake provider: simulated timeout (resource was created; caller did not see the id)");
    }
    this.rows.set(id, row);
    return { ...row };
  }

  async getInstance(providerInstanceId: string): Promise<ProviderInstance | null> {
    const row = this.rows.get(providerInstanceId);
    return row ? { ...row } : null;
  }

  async findByLabel(label: string): Promise<ProviderInstance | null> {
    for (const row of this.rows.values()) if (row.label === label) return { ...row };
    return null;
  }

  async power(providerInstanceId: string, state: PowerState): Promise<void> {
    const row = this.rows.get(providerInstanceId);
    if (!row) throw new Error(`fake provider: no such instance ${providerInstanceId}`);
    row.status = state === "on" ? "active" : "stopped";
  }

  async deleteInstance(providerInstanceId: string): Promise<void> {
    this.rows.delete(providerInstanceId); // idempotent: deleting an absent id is a no-op success
  }
}

// ── VultrProvider — real HTTP, never called by the test suite ──────────────

export type HttpLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

const VULTR_API_BASE = "https://api.vultr.com/v2";

/** The real adapter. Constructed only when an operator has supplied a Vultr
 *  API key (src/hosting/service.ts); `createHub`'s test wiring never passes
 *  one, so this class is dead code from the suite's point of view — verified
 *  by `tests/hosting-provider.test.mjs`'s source-shape check (no `fetch(` or
 *  `VultrProvider` construction anywhere outside this file and its own
 *  narrow test). The exact endpoint shapes (fields, status codes) are
 *  DOC-READ, not field-verified against a live Vultr account — see the
 *  handoff §6/§12 and this file's own report note. Recheck the SDK/API
 *  version before the first real provisioning run. */
export class VultrProvider implements HostingProvider {
  constructor(private readonly apiKey: string, private readonly http: HttpLike = realFetch) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await this.http(`${VULTR_API_BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  }

  async listRegions(): Promise<ProviderRegion[]> {
    const r = await this.call("GET", "/regions");
    const rows = Array.isArray(r.json?.regions) ? r.json.regions : [];
    return rows.map((x: any) => ({ id: String(x.id), label: String(x.city ?? x.id) }));
  }

  async listPlans(): Promise<ProviderPlan[]> {
    const r = await this.call("GET", "/plans");
    const rows = Array.isArray(r.json?.plans) ? r.json.plans : [];
    return rows.map((x: any) => ({ id: String(x.id), vcpus: Number(x.vcpu_count) || 0, ramMb: Number(x.ram) || 0, diskGb: Number(x.disk) || 0, monthlyCostCents: Math.round((Number(x.monthly_cost) || 0) * 100) }));
  }

  async createInstance(req: CreateInstanceRequest): Promise<ProviderInstance> {
    const r = await this.call("POST", "/instances", {
      region: req.regionId,
      plan: req.planId,
      os_id: Number(req.osId) || req.osId,
      label: req.label,
      tag: req.label,
      tags: req.tags ? [...req.tags] : undefined,
      user_data: Buffer.from(req.userData, "utf8").toString("base64"),
      backups: "disabled",
      enable_ipv6: false,
      activation_email: false,
    });
    if (r.status >= 300 || !r.json?.instance) throw new Error(`vultr createInstance: HTTP ${r.status} ${JSON.stringify(r.json)}`);
    return mapVultrInstance(r.json.instance);
  }

  async getInstance(providerInstanceId: string): Promise<ProviderInstance | null> {
    const r = await this.call("GET", `/instances/${encodeURIComponent(providerInstanceId)}`);
    if (r.status === 404) return null;
    if (r.status >= 300 || !r.json?.instance) throw new Error(`vultr getInstance: HTTP ${r.status}`);
    return mapVultrInstance(r.json.instance);
  }

  async findByLabel(label: string): Promise<ProviderInstance | null> {
    const r = await this.call("GET", `/instances?label=${encodeURIComponent(label)}`);
    if (r.status >= 300) throw new Error(`vultr findByLabel: HTTP ${r.status}`);
    const rows = Array.isArray(r.json?.instances) ? r.json.instances : [];
    const hit = rows.find((x: any) => x.label === label);
    return hit ? mapVultrInstance(hit) : null;
  }

  async power(providerInstanceId: string, state: PowerState): Promise<void> {
    const r = await this.call("POST", `/instances/${encodeURIComponent(providerInstanceId)}/${state === "on" ? "start" : "halt"}`);
    if (r.status >= 300) throw new Error(`vultr power(${state}): HTTP ${r.status}`);
  }

  async deleteInstance(providerInstanceId: string): Promise<void> {
    const r = await this.call("DELETE", `/instances/${encodeURIComponent(providerInstanceId)}`);
    if (r.status >= 300 && r.status !== 404) throw new Error(`vultr deleteInstance: HTTP ${r.status}`); // 404 = already gone = idempotent success
  }
}

function mapVultrInstance(x: any): ProviderInstance {
  const status = x.power_status === "running" ? "active" : x.power_status === "stopped" ? "stopped" : x.status === "pending" ? "pending" : "unknown";
  return {
    providerInstanceId: String(x.id),
    label: String(x.label ?? ""),
    regionId: String(x.region ?? ""),
    planId: String(x.plan ?? ""),
    status,
    mainIp: x.main_ip && x.main_ip !== "0.0.0.0" ? String(x.main_ip) : null,
    createdAtMs: x.date_created ? Date.parse(x.date_created) || Date.now() : Date.now(),
  };
}

const realFetch: HttpLike = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, ok: res.ok, text: () => res.text() };
};
