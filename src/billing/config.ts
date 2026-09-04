// src/billing/config.ts
// Billing configuration — Stripe keys for BOTH modes, the test/live switch, the
// transactional-email provider and the licence policy. One JSON file under
// data/ (mode 0600, written only through the admin API), so the operator has
// a single place to paste keys and one switch to flip when the shop goes live.
//
// SECRETS ARE WRITE-ONLY OVER THE WIRE. The admin page receives `configured`
// plus the last four characters, never the value; an update carries a new
// value to set, `null` to clear, or nothing to leave a secret exactly as it
// is. The publishable key is public by definition and is echoed in full.
//
// WHY TWO MODES SIDE BY SIDE rather than one set of keys swapped by hand: the
// operator tests with Stripe's test cards first and goes live later. Both
// webhook endpoints stay registered, both secrets stay stored, and `mode`
// decides which Payment Link `/buy` sends a visitor to and whether a TEST
// event is allowed to mint a licence (see service.ts). A live event is always
// honoured — real money is never ignored because a switch was left on test.
import path from "node:path";
import { readJson, writeJsonAtomic } from "../jsonfile.js";

export const BILLING_CONFIG_FILE = "billing-config.v1.json";

export type BillingMode = "test" | "live";
export const BILLING_MODES: readonly BillingMode[] = ["test", "live"];
export type EmailProvider = "none" | "resend" | "postmark";
export const EMAIL_PROVIDERS: readonly EmailProvider[] = ["none", "resend", "postmark"];

export interface StripeModeConfig {
  /** pk_test_… / pk_live_… — public; stored so the operator has one place for it. */
  publishableKey: string;
  /** sk_… or a restricted rk_… key. Used ONLY to open Customer Portal sessions. */
  secretKey: string;
  /** whsec_… — the signing secret of this mode's webhook endpoint. */
  webhookSecret: string;
  /** The Stripe Payment Link `/buy` redirects to while this mode is active. */
  paymentLinkUrl: string;
  /** Stripe's no-code Customer Portal login link, the `/billing` fallback. */
  portalUrl: string;
}

export interface EmailConfig {
  provider: EmailProvider;
  apiKey: string;
  /** e.g. `Wick Hunter <hello@wickhunterunleashed.com>` */
  from: string;
  replyTo: string;
}

export interface BillingPolicy {
  /** Days added after a paid period ends before the licence lapses (covers
   *  Stripe's payment retries; a lapsed licence is exit-only, never a kill). */
  graceDays: number;
  /** Days a NEW subscription licence is valid before the first `invoice.paid`
   *  arrives — the two events race, and the licence must exist for either. */
  bootstrapDays: number;
  /** Licence length for a one-time (non-subscription) purchase. */
  oneOffDays: number;
  /** Hard cap on any licence minted from a TEST-mode checkout. A leaked test
   *  Payment Link mints working licences with a 4242 card; this bounds it. */
  testMaxDays: number;
  /** The `plan` string written into live licences; test ones get `-test`. */
  plan: string;
  revokeOnDispute: boolean;
  revokeOnRefund: boolean;
}

export interface BillingConfig {
  v: 1;
  mode: BillingMode;
  stripe: Record<BillingMode, StripeModeConfig>;
  email: EmailConfig;
  policy: BillingPolicy;
  /** The public website, for links in emails and on the welcome page. */
  siteOrigin: string;
  updatedAtMs: number | null;
}

const EMPTY_MODE: StripeModeConfig = { publishableKey: "", secretKey: "", webhookSecret: "", paymentLinkUrl: "", portalUrl: "" };

export const DEFAULT_BILLING_POLICY: BillingPolicy = {
  graceDays: 7,
  bootstrapDays: 3,
  oneOffDays: 365,
  testMaxDays: 14,
  plan: "unleashed",
  revokeOnDispute: true,
  revokeOnRefund: true,
};

export function defaultBillingConfig(): BillingConfig {
  return {
    v: 1,
    mode: "test",
    stripe: { test: { ...EMPTY_MODE }, live: { ...EMPTY_MODE } },
    email: { provider: "none", apiKey: "", from: "", replyTo: "" },
    policy: { ...DEFAULT_BILLING_POLICY },
    siteOrigin: "",
    updatedAtMs: null,
  };
}

export class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingConfigError";
  }
}

// ── load / save ─────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function modeFrom(raw: unknown): StripeModeConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    publishableKey: str(o.publishableKey),
    secretKey: str(o.secretKey),
    webhookSecret: str(o.webhookSecret),
    paymentLinkUrl: str(o.paymentLinkUrl),
    portalUrl: str(o.portalUrl),
  };
}

/** Read the file, tolerating any missing field (a hub upgraded from a version
 *  that wrote fewer keys must not lose the ones it has). */
export function readBillingConfig(dataDir: string): BillingConfig {
  const raw = readJson<Record<string, unknown>>(path.join(dataDir, BILLING_CONFIG_FILE), {});
  const d = defaultBillingConfig();
  const stripe = (raw.stripe && typeof raw.stripe === "object" ? raw.stripe : {}) as Record<string, unknown>;
  const email = (raw.email && typeof raw.email === "object" ? raw.email : {}) as Record<string, unknown>;
  const policy = (raw.policy && typeof raw.policy === "object" ? raw.policy : {}) as Record<string, unknown>;
  const provider = str(email.provider);
  return {
    v: 1,
    mode: raw.mode === "live" ? "live" : "test",
    stripe: { test: modeFrom(stripe.test), live: modeFrom(stripe.live) },
    email: {
      provider: (EMAIL_PROVIDERS as readonly string[]).includes(provider) ? (provider as EmailProvider) : "none",
      apiKey: str(email.apiKey),
      from: str(email.from),
      replyTo: str(email.replyTo),
    },
    policy: {
      graceDays: num(policy.graceDays, d.policy.graceDays),
      bootstrapDays: num(policy.bootstrapDays, d.policy.bootstrapDays),
      oneOffDays: num(policy.oneOffDays, d.policy.oneOffDays),
      testMaxDays: num(policy.testMaxDays, d.policy.testMaxDays),
      plan: str(policy.plan) || d.policy.plan,
      revokeOnDispute: bool(policy.revokeOnDispute, d.policy.revokeOnDispute),
      revokeOnRefund: bool(policy.revokeOnRefund, d.policy.revokeOnRefund),
    },
    siteOrigin: str(raw.siteOrigin),
    updatedAtMs: typeof raw.updatedAtMs === "number" ? raw.updatedAtMs : null,
  };
}

export function writeBillingConfig(dataDir: string, cfg: BillingConfig): void {
  writeJsonAtomic(path.join(dataDir, BILLING_CONFIG_FILE), cfg);
}

// ── validated partial update ────────────────────────────────────────────────

const PLAN_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function httpsUrl(value: string, label: string, originOnly = false): string {
  const v = value.trim();
  if (!v) return "";
  let url: URL;
  try { url = new URL(v); } catch { throw new BillingConfigError(`${label} must be an https URL`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new BillingConfigError(`${label} must be an https URL without credentials`);
  if (originOnly && (url.pathname !== "/" || url.search || url.hash)) throw new BillingConfigError(`${label} must be an origin only, e.g. https://example.com`);
  return originOnly ? url.origin : url.toString();
}

function keyWithPrefix(value: string, prefixes: readonly string[], label: string): string {
  const v = value.trim();
  if (!v) return "";
  if (!prefixes.some((p) => v.startsWith(p))) throw new BillingConfigError(`${label} should start with ${prefixes.join(" or ")}`);
  if (/\s/.test(v) || v.length > 512) throw new BillingConfigError(`${label} looks malformed`);
  return v;
}

/** A secret field's wire semantics: absent or "" = unchanged, null = clear,
 *  string = set (validated by `check`). */
function secretUpdate(current: string, incoming: unknown, check: (v: string) => string): string {
  if (incoming === undefined || incoming === "") return current;
  if (incoming === null) return "";
  if (typeof incoming !== "string") throw new BillingConfigError("a secret must be a string, null to clear, or omitted");
  return check(incoming);
}

function intIn(value: unknown, min: number, max: number, label: string, current: number): number {
  if (value === undefined) return current;
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new BillingConfigError(`${label} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function applyModePatch(mode: BillingMode, current: StripeModeConfig, patch: unknown): StripeModeConfig {
  if (patch === undefined) return current;
  if (!patch || typeof patch !== "object") throw new BillingConfigError(`stripe.${mode} must be an object`);
  const p = patch as Record<string, unknown>;
  const label = mode === "test" ? "Test" : "Live";
  const next: StripeModeConfig = { ...current };
  if (p.publishableKey !== undefined) {
    if (typeof p.publishableKey !== "string") throw new BillingConfigError(`${label} publishable key must be a string`);
    next.publishableKey = keyWithPrefix(p.publishableKey, [`pk_${mode}_`], `${label} publishable key`);
  }
  next.secretKey = secretUpdate(current.secretKey, p.secretKey, (v) => keyWithPrefix(v, [`sk_${mode}_`, `rk_${mode}_`], `${label} secret key`));
  next.webhookSecret = secretUpdate(current.webhookSecret, p.webhookSecret, (v) => keyWithPrefix(v, ["whsec_"], `${label} webhook signing secret`));
  if (p.paymentLinkUrl !== undefined) {
    if (typeof p.paymentLinkUrl !== "string") throw new BillingConfigError(`${label} Payment Link must be a string`);
    next.paymentLinkUrl = httpsUrl(p.paymentLinkUrl, `${label} Payment Link URL`);
  }
  if (p.portalUrl !== undefined) {
    if (typeof p.portalUrl !== "string") throw new BillingConfigError(`${label} Customer Portal URL must be a string`);
    next.portalUrl = httpsUrl(p.portalUrl, `${label} Customer Portal URL`);
  }
  return next;
}

/** Apply an admin patch to a config. Throws BillingConfigError with a message
 *  safe to show the operator; on success returns the NEW config (unsaved). */
export function applyBillingPatch(current: BillingConfig, patch: Record<string, unknown>, now = Date.now()): BillingConfig {
  const next: BillingConfig = {
    ...current,
    stripe: { test: { ...current.stripe.test }, live: { ...current.stripe.live } },
    email: { ...current.email },
    policy: { ...current.policy },
  };
  if (patch.mode !== undefined) {
    if (patch.mode !== "test" && patch.mode !== "live") throw new BillingConfigError('mode must be "test" or "live"');
    next.mode = patch.mode;
  }
  if (patch.stripe !== undefined) {
    if (!patch.stripe || typeof patch.stripe !== "object") throw new BillingConfigError("stripe must be an object");
    const s = patch.stripe as Record<string, unknown>;
    next.stripe.test = applyModePatch("test", next.stripe.test, s.test);
    next.stripe.live = applyModePatch("live", next.stripe.live, s.live);
  }
  if (patch.email !== undefined) {
    if (!patch.email || typeof patch.email !== "object") throw new BillingConfigError("email must be an object");
    const e = patch.email as Record<string, unknown>;
    if (e.provider !== undefined) {
      if (!(EMAIL_PROVIDERS as readonly unknown[]).includes(e.provider)) throw new BillingConfigError(`email provider must be one of ${EMAIL_PROVIDERS.join(", ")}`);
      next.email.provider = e.provider as EmailProvider;
    }
    next.email.apiKey = secretUpdate(next.email.apiKey, e.apiKey, (v) => {
      const t = v.trim();
      if (t.length < 8 || t.length > 512 || /\s/.test(t)) throw new BillingConfigError("email API key looks malformed");
      return t;
    });
    for (const field of ["from", "replyTo"] as const) {
      if (e[field] === undefined) continue;
      if (typeof e[field] !== "string") throw new BillingConfigError(`email ${field} must be a string`);
      const v = (e[field] as string).trim();
      if (v && (!v.includes("@") || v.length > 200 || /[\r\n]/.test(v))) throw new BillingConfigError(`email ${field} must be an address like "Name <user@domain>"`);
      next.email[field] = v;
    }
  }
  if (patch.policy !== undefined) {
    if (!patch.policy || typeof patch.policy !== "object") throw new BillingConfigError("policy must be an object");
    const p = patch.policy as Record<string, unknown>;
    next.policy.graceDays = intIn(p.graceDays, 0, 90, "graceDays", next.policy.graceDays);
    next.policy.bootstrapDays = intIn(p.bootstrapDays, 1, 30, "bootstrapDays", next.policy.bootstrapDays);
    next.policy.oneOffDays = intIn(p.oneOffDays, 1, 3650, "oneOffDays", next.policy.oneOffDays);
    next.policy.testMaxDays = intIn(p.testMaxDays, 1, 365, "testMaxDays", next.policy.testMaxDays);
    if (p.plan !== undefined) {
      if (typeof p.plan !== "string" || !PLAN_RE.test(p.plan)) throw new BillingConfigError("plan must be lowercase letters, digits and dashes, up to 32 characters");
      next.policy.plan = p.plan;
    }
    for (const field of ["revokeOnDispute", "revokeOnRefund"] as const) {
      if (p[field] === undefined) continue;
      if (typeof p[field] !== "boolean") throw new BillingConfigError(`${field} must be true or false`);
      next.policy[field] = p[field] as boolean;
    }
  }
  if (patch.siteOrigin !== undefined) {
    if (typeof patch.siteOrigin !== "string") throw new BillingConfigError("siteOrigin must be a string");
    next.siteOrigin = httpsUrl(patch.siteOrigin, "siteOrigin", true);
  }
  next.updatedAtMs = now;
  return next;
}

// ── the masked view the admin page receives ─────────────────────────────────

export interface MaskedSecret { configured: boolean; last4: string | null }
export const maskSecret = (v: string): MaskedSecret => ({ configured: !!v, last4: v ? v.slice(-4) : null });

export interface BillingReadiness { stripeTest: boolean; stripeLive: boolean; email: boolean; release: boolean }

export function stripeModeReady(m: StripeModeConfig): boolean {
  return !!m.webhookSecret && !!m.paymentLinkUrl;
}

export function emailReady(e: EmailConfig): boolean {
  return e.provider !== "none" && !!e.apiKey && !!e.from;
}

export function maskedBillingConfig(cfg: BillingConfig, publicOrigin: string, releaseReady: boolean): Record<string, unknown> {
  const origin = publicOrigin.replace(/\/+$/, "");
  const maskMode = (m: StripeModeConfig): Record<string, unknown> => ({
    publishableKey: m.publishableKey,
    secretKey: maskSecret(m.secretKey),
    webhookSecret: maskSecret(m.webhookSecret),
    paymentLinkUrl: m.paymentLinkUrl,
    portalUrl: m.portalUrl,
  });
  const ready: BillingReadiness = {
    stripeTest: stripeModeReady(cfg.stripe.test),
    stripeLive: stripeModeReady(cfg.stripe.live),
    email: emailReady(cfg.email),
    release: releaseReady,
  };
  return {
    mode: cfg.mode,
    publicOrigin: origin,
    endpoints: {
      buy: `${origin}/buy`,
      billing: `${origin}/billing`,
      webhookTest: `${origin}/api/billing/stripe/test`,
      webhookLive: `${origin}/api/billing/stripe/live`,
    },
    stripe: { test: maskMode(cfg.stripe.test), live: maskMode(cfg.stripe.live) },
    email: { provider: cfg.email.provider, apiKey: maskSecret(cfg.email.apiKey), from: cfg.email.from, replyTo: cfg.email.replyTo },
    policy: { ...cfg.policy },
    siteOrigin: cfg.siteOrigin,
    ready,
    updatedAtMs: cfg.updatedAtMs,
  };
}
