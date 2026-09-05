// src/billing/service.ts
// Stripe -> licence. One class owns the whole chain: a verified webhook event
// becomes (or extends, or revokes) an LHK1 licence, the buyer is emailed a
// link to a private install page, that page mints one-time install commands,
// and the bot already running on the customer's box learns about extensions
// at its next check-in (v0.3.19) and about revocation the same way. No bot
// code changes; exit-only on a lapsed licence is the existing enforcement.
//
// ORDER-INDEPENDENT ON PURPOSE. Stripe does not promise event order, and for
// a new subscription `invoice.paid` and `checkout.session.completed` race.
// Every handler therefore starts from "make sure this customer has a licence"
// and then moves its expiry FORWARD to what the event proves was paid for.
// Nothing here ever moves an expiry back: the bot only accepts a LATER key at
// check-in, so a shortened registry date would change nothing on the box.
// Cutting a customer off early is revocation, and only a dispute or a full
// refund does that automatically.
//
// TEST MODE IS A SANDBOX WITH TEETH. A test-mode event mints a working
// licence (the operator must be able to install for real from a 4242 card),
// but only while the Hub's mode is `test`, only with a `-test` plan label, and
// never for longer than `policy.testMaxDays`. A live event is honoured in
// either mode — real money is never ignored because a switch was left on test.
import fs from "node:fs";
import path from "node:path";
import type { LicenseStore } from "../license.js";
import type { RosterEntry } from "../checkins.js";
import {
  applyBillingPatch,
  emailReady,
  maskedBillingConfig,
  paymentLinkFor,
  planByKey,
  readBillingConfig,
  writeBillingConfig,
  MAX_LICENSE_DAYS,
  PLAN_KEY_RE,
  type BillingConfig,
  type BillingMode,
  type Plan,
} from "./config.js";
import { provisionPlans, StripeApiError, type ProvisionResult } from "./stripe-provision.js";
import { escapeHtml, sendEmail, testEmail, welcomeEmail, type EmailFetch } from "./email.js";
import { BillingStore, type CustomerRecord, type EventOutcome, type EventRecord } from "./store.js";
import {
  chargeFacts,
  checkoutFacts,
  disputeFacts,
  invoiceFacts,
  parseStripeEvent,
  subscriptionFacts,
  verifyStripeSignature,
  STRIPE_SIGNATURE_HEADER,
  type StripeEvent,
} from "./stripe.js";

export { BillingConfigError } from "./config.js";
export type { BillingMode } from "./config.js";

const DAY_MS = 86_400_000;
const STRIPE_PORTAL_SESSIONS_URL = "https://api.stripe.com/v1/billing_portal/sessions";

export interface BillingServiceDeps {
  now?: () => number;
  /** One injected fetch serves the email provider AND the Stripe portal call. */
  fetchLike?: EmailFetch;
  randomBytes?: (n: number) => Buffer;
  log?: (line: string) => void;
  /** Fired after a licence is revoked here, so the server can tell the lease
   *  ledger exactly as the admin revoke route does. */
  onRevoke?: (licenseId: string, reason: string) => void;
}

export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
}

export interface ApplyResult {
  outcome: EventOutcome;
  note: string | null;
}

export type WelcomePageResult = { ok: true; html: string } | { ok: false; status: number; text: string };
export type InstallTokenResult = { ok: true; licenseToken: string } | { ok: false; status: number; text: string };
export type PortalResult = { ok: true; url: string } | { ok: false; status: number; error: string };

interface CustomerFacts {
  customerId: string;
  email: string;
  name: string;
  subscriptionId: string;
  livemode: boolean;
  planKey: string | null;
}

const realFetch: EmailFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

export class BillingService {
  readonly store: BillingStore;
  private readonly now: () => number;
  private readonly fetchLike: EmailFetch;
  private readonly log: (line: string) => void;
  private readonly onRevoke: (licenseId: string, reason: string) => void;

  constructor(
    readonly dataDir: string,
    private readonly licenses: LicenseStore,
    readonly publicOrigin: string,
    private readonly templatesDir: string,
    deps: BillingServiceDeps = {},
  ) {
    this.store = new BillingStore(dataDir, deps.randomBytes);
    this.now = deps.now ?? Date.now;
    this.fetchLike = deps.fetchLike ?? realFetch;
    this.log = deps.log ?? ((line) => console.log(line));
    this.onRevoke = deps.onRevoke ?? (() => {});
  }

  private get origin(): string {
    return this.publicOrigin.replace(/\/+$/, "");
  }

  // ── configuration ─────────────────────────────────────────────────────────

  config(): BillingConfig {
    return readBillingConfig(this.dataDir);
  }

  /** Validate + persist an admin patch; throws BillingConfigError. */
  updateConfig(patch: Record<string, unknown>): BillingConfig {
    const next = applyBillingPatch(this.config(), patch, this.now());
    writeBillingConfig(this.dataDir, next);
    return next;
  }

  adminConfigView(releaseReady: boolean): Record<string, unknown> {
    return maskedBillingConfig(this.config(), this.origin, releaseReady);
  }

  /** Where `/buy?plan=key` sends a visitor: the ACTIVE mode's Payment Link
   *  for that plan (the first plan when none is named). "" = not configured. */
  buyUrl(planKey?: string | null): string {
    const cfg = this.config();
    return paymentLinkFor(cfg, cfg.mode, planKey);
  }

  plan(key: string): Plan | null {
    return planByKey(this.config(), key);
  }

  /** Where `/billing` sends a customer: the active mode's portal login link. */
  billingUrl(): string {
    const cfg = this.config();
    return cfg.stripe[cfg.mode].portalUrl;
  }

  /** What the website shows: every plan with its price and whether the active
   *  mode has a link for it. Public, no secrets, cacheable. */
  publicPlans(): Record<string, unknown> {
    const cfg = this.config();
    return {
      mode: cfg.mode,
      plans: cfg.plans.map((p) => ({
        key: p.key,
        name: p.name,
        amountCents: p.amountCents,
        currency: p.currency,
        interval: p.interval,
        licenseDays: p.licenseDays,
        lifetime: p.lifetime,
        description: p.description,
        buyUrl: `${this.origin}/buy?plan=${encodeURIComponent(p.key)}`,
        available: !!paymentLinkFor(cfg, cfg.mode, p.key),
      })),
    };
  }

  /** "Create in Stripe": product, prices and Payment Links for the plans, in
   *  one mode, with that mode's saved secret key; the resulting links are
   *  saved into the config so `/buy?plan=` works immediately. */
  async provisionPlans(mode: BillingMode): Promise<{ ok: true; result: ProvisionResult } | { ok: false; status: number; error: string }> {
    const cfg = this.config();
    const m = cfg.stripe[mode];
    if (!m.secretKey) return { ok: false, status: 400, error: `no ${mode} secret key is saved — paste one in the Stripe · ${mode} card first` };
    let result: ProvisionResult;
    try {
      result = await provisionPlans({ secretKey: m.secretKey, siteOrigin: cfg.siteOrigin, productName: "Wick Hunter Unleashed", plans: cfg.plans }, this.fetchLike);
    } catch (err) {
      if (err instanceof StripeApiError) {
        const hint = err.status === 401 || err.status === 403
          ? " — the saved key cannot create products; use a secret key (sk_) or a restricted key with Products, Prices and Payment Links set to Write"
          : "";
        return { ok: false, status: 502, error: `Stripe: ${err.message}${hint}` };
      }
      return { ok: false, status: 502, error: `Stripe request failed: ${(err as Error).message}` };
    }
    const links: Record<string, string> = {};
    for (const p of result.plans) links[p.key] = p.paymentLinkUrl;
    const first = cfg.plans[0]?.key;
    this.updateConfig({ stripe: { [mode]: { paymentLinks: links, ...(!m.paymentLinkUrl && first && links[first] ? { paymentLinkUrl: links[first] } : {}) } } });
    this.log(`[billing] provisioned ${result.plans.length} plan(s) in Stripe ${mode}: ${result.plans.map((p) => `${p.key} ${p.linkCreated ? "created" : "reused"}`).join(", ")}`);
    return { ok: true, result };
  }

  // ── the webhook ───────────────────────────────────────────────────────────

  /** Verify, de-duplicate, apply, record. The reply's status is what Stripe
   *  sees: 2xx = done (never resend), 4xx = rejected (never resend), 5xx =
   *  try again later. An event that raised is NOT marked seen, so the retry
   *  gets a second chance. */
  async handleWebhook(mode: BillingMode, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookReply> {
    const cfg = this.config();
    const secret = cfg.stripe[mode].webhookSecret;
    const receivedAtMs = this.now();
    if (!secret) return { status: 503, body: { ok: false, error: `the ${mode} webhook signing secret is not configured on this Hub` } };
    const sig = verifyStripeSignature(rawBody, headers[STRIPE_SIGNATURE_HEADER], secret, receivedAtMs);
    if (!sig.ok) {
      this.store.appendEvent({ id: "unsigned", type: "?", livemode: mode === "live", receivedAtMs, outcome: "signature", note: `signature ${sig.reason}` });
      return { status: 400, body: { ok: false, error: `signature ${sig.reason}` } };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody.toString("utf8")); } catch { return { status: 400, body: { ok: false, error: "body is not JSON" } }; }
    const ev = parseStripeEvent(parsed);
    if (!ev) return { status: 400, body: { ok: false, error: "not a Stripe event" } };
    const record = (outcome: EventOutcome, note: string | null): EventRecord => ({ id: ev.id, type: ev.type, livemode: ev.livemode, receivedAtMs, outcome, note });
    if (ev.livemode !== (mode === "live")) {
      // Cannot normally happen — the two endpoints have different secrets —
      // but a copied secret must not let a test event through the live door.
      this.store.appendEvent(record("ignored", `a ${ev.livemode ? "live" : "test"} event arrived at the ${mode} endpoint`));
      return { status: 200, body: { ok: true, outcome: "ignored" } };
    }
    if (this.store.seenEvent(ev.id)) {
      this.store.appendEvent(record("duplicate", null));
      return { status: 200, body: { ok: true, outcome: "duplicate" } };
    }
    let result: ApplyResult;
    try {
      result = await this.applyEvent(ev, cfg);
    } catch (err) {
      const message = (err as Error).message;
      this.store.appendEvent(record("error", message));
      this.log(`[billing] ${ev.type} ${ev.id} failed: ${message}`);
      return { status: 500, body: { ok: false, error: "event could not be applied; Stripe will retry" } };
    }
    this.store.markSeen(ev.id, receivedAtMs);
    this.store.appendEvent(record(result.outcome, result.note));
    this.log(`[billing] ${ev.type} ${ev.id} (${ev.livemode ? "live" : "test"}): ${result.outcome}${result.note ? ` — ${result.note}` : ""}`);
    return { status: 200, body: { ok: true, outcome: result.outcome } };
  }

  /** Pure-ish: no signature, no dedupe — the suite drives this directly. */
  async applyEvent(ev: StripeEvent, cfg: BillingConfig = this.config()): Promise<ApplyResult> {
    if (!ev.livemode && cfg.mode !== "test") return { outcome: "ignored", note: "test-mode event while the Hub is in LIVE mode" };
    switch (ev.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return this.onCheckout(ev, cfg);
      case "invoice.paid":
      case "invoice.payment_succeeded":
        return this.onInvoicePaid(ev, cfg);
      case "invoice.payment_failed":
        return this.onInvoiceFailed(ev);
      case "customer.subscription.updated":
        return this.onSubscriptionUpdated(ev, cfg);
      case "customer.subscription.deleted":
        return this.onSubscriptionDeleted(ev);
      case "charge.succeeded":
        return this.onChargeSucceeded(ev);
      case "charge.refunded":
        return this.onRefund(ev, cfg);
      case "charge.dispute.created":
        return this.onDispute(ev, cfg);
      default:
        return { outcome: "ignored", note: "event type not handled" };
    }
  }

  // ── handlers ──────────────────────────────────────────────────────────────

  private async onCheckout(ev: StripeEvent, cfg: BillingConfig): Promise<ApplyResult> {
    const f = checkoutFacts(ev.object);
    if (f.mode !== "subscription" && f.mode !== "payment") return { outcome: "ignored", note: `checkout mode ${f.mode || "?"}` };
    if (f.paymentStatus === "unpaid") return { outcome: "ignored", note: "payment not confirmed yet (async_payment_succeeded will follow)" };
    if (!f.customerId && !f.email) return { outcome: "ignored", note: "checkout carried neither a customer nor an email" };
    const now = this.now();
    const planKey = this.planKeyOf(f.metadata, cfg);
    const oneOffDays = this.oneOffDaysFor(f.metadata, planByKey(cfg, planKey), cfg);
    const bootstrapExp = f.mode === "payment" ? now + oneOffDays * DAY_MS : now + cfg.policy.bootstrapDays * DAY_MS;
    const { rec, created } = this.ensureCustomer({ customerId: f.customerId, email: f.email, name: f.name, subscriptionId: f.subscriptionId, livemode: ev.livemode, planKey }, cfg, bootstrapExp, now);
    let note = created ? `licence issued${planKey ? ` (${planKey})` : ""}` : "customer known";
    if (f.mode === "payment" && !created) {
      // A repeat one-time purchase stacks on whatever is left.
      const current = this.licenses.get(rec.licenseId);
      const base = current ? Math.max(current.exp, now) : now;
      note += this.extendLicense(rec, base + oneOffDays * DAY_MS, cfg, now) ? "; licence extended" : "";
    }
    if (f.mode === "subscription") rec.subscriptionStatus = rec.subscriptionStatus ?? "active";
    this.noteCharge(rec, f.paymentIntentId);
    this.touch(rec, ev, now);
    this.store.putCustomer(rec);
    note += await this.sendWelcomeIfNeeded(rec, cfg, now);
    return { outcome: "applied", note };
  }

  private async onInvoicePaid(ev: StripeEvent, cfg: BillingConfig): Promise<ApplyResult> {
    const f = invoiceFacts(ev.object);
    if (!f.paid) return { outcome: "ignored", note: "invoice not paid" };
    if (!f.customerId && !f.email) return { outcome: "ignored", note: "invoice carried neither a customer nor an email" };
    const now = this.now();
    const paidThrough = f.periodEndMs !== null ? f.periodEndMs + cfg.policy.graceDays * DAY_MS : null;
    const { rec, created } = this.ensureCustomer({ customerId: f.customerId, email: f.email, name: f.name, subscriptionId: f.subscriptionId, livemode: ev.livemode, planKey: null }, cfg, paidThrough ?? now + cfg.policy.bootstrapDays * DAY_MS, now);
    let note = created ? "licence issued" : "customer known";
    if (paidThrough !== null) {
      if (this.extendLicense(rec, paidThrough, cfg, now)) note += `; licence extended to ${new Date(this.licenseExp(rec) ?? paidThrough).toISOString().slice(0, 10)}`;
      if (rec.periodEndMs === null || f.periodEndMs! > rec.periodEndMs) rec.periodEndMs = f.periodEndMs;
    } else {
      note += "; invoice had no period end";
    }
    rec.subscriptionStatus = "active";
    this.noteCharge(rec, f.chargeId);
    this.noteCharge(rec, f.paymentIntentId);
    this.touch(rec, ev, now);
    this.store.putCustomer(rec);
    note += await this.sendWelcomeIfNeeded(rec, cfg, now);
    return { outcome: "applied", note };
  }

  private onInvoiceFailed(ev: StripeEvent): ApplyResult {
    const f = invoiceFacts(ev.object);
    const rec = this.findCustomer(f.customerId, f.email);
    if (!rec) return { outcome: "ignored", note: "customer not known" };
    rec.subscriptionStatus = "past_due";
    this.touch(rec, ev, this.now());
    this.store.putCustomer(rec);
    return { outcome: "applied", note: "marked past due; the licence keeps its paid-through date plus grace" };
  }

  private onSubscriptionUpdated(ev: StripeEvent, cfg: BillingConfig): ApplyResult {
    const f = subscriptionFacts(ev.object);
    const rec = this.findCustomer(f.customerId, "");
    if (!rec) return { outcome: "ignored", note: "customer not known" };
    const now = this.now();
    rec.subscriptionId = f.subscriptionId || rec.subscriptionId;
    rec.subscriptionStatus = f.cancelAtPeriodEnd && f.status === "active" ? "active (cancels at period end)" : f.status || rec.subscriptionStatus;
    let note = `status ${rec.subscriptionStatus}`;
    if ((f.status === "active" || f.status === "trialing") && f.currentPeriodEndMs !== null) {
      if (this.extendLicense(rec, f.currentPeriodEndMs + cfg.policy.graceDays * DAY_MS, cfg, now)) note += "; licence extended";
      if (rec.periodEndMs === null || f.currentPeriodEndMs > rec.periodEndMs) rec.periodEndMs = f.currentPeriodEndMs;
    }
    this.touch(rec, ev, now);
    this.store.putCustomer(rec);
    return { outcome: "applied", note };
  }

  private onSubscriptionDeleted(ev: StripeEvent): ApplyResult {
    const f = subscriptionFacts(ev.object);
    const rec = this.findCustomer(f.customerId, "");
    if (!rec) return { outcome: "ignored", note: "customer not known" };
    rec.subscriptionStatus = "canceled";
    this.touch(rec, ev, this.now());
    this.store.putCustomer(rec);
    return { outcome: "applied", note: "subscription ended; licence runs to its paid-through date plus grace, then exit-only" };
  }

  private onChargeSucceeded(ev: StripeEvent): ApplyResult {
    const f = chargeFacts(ev.object);
    const rec = this.findCustomer(f.customerId, f.email);
    if (!rec) return { outcome: "ignored", note: "customer not known yet (checkout/invoice will attribute later charges)" };
    this.noteCharge(rec, f.chargeId);
    this.noteCharge(rec, f.paymentIntentId);
    this.touch(rec, ev, this.now());
    this.store.putCustomer(rec);
    return { outcome: "applied", note: "charge recorded" };
  }

  private onRefund(ev: StripeEvent, cfg: BillingConfig): ApplyResult {
    const f = chargeFacts(ev.object);
    const rec = this.findCustomer(f.customerId, f.email) ?? this.store.findByCharge(f.chargeId) ?? this.store.findByCharge(f.paymentIntentId);
    if (!rec) return { outcome: "ignored", note: "customer not known — revoke by hand if needed" };
    const now = this.now();
    const full = f.refunded || (f.amount !== null && f.amountRefunded !== null && f.amountRefunded >= f.amount);
    let note: string;
    if (full) {
      rec.refunded = true;
      note = cfg.policy.revokeOnRefund ? `full refund: ${this.revoke(rec, "full refund", now)}` : "full refund recorded; revokeOnRefund is off";
    } else {
      note = "partial refund recorded; licence untouched";
    }
    this.touch(rec, ev, now);
    this.store.putCustomer(rec);
    return { outcome: "applied", note };
  }

  private onDispute(ev: StripeEvent, cfg: BillingConfig): ApplyResult {
    const f = disputeFacts(ev.object);
    const rec = this.store.findByCharge(f.chargeId) ?? this.store.findByCharge(f.paymentIntentId);
    if (!rec) return { outcome: "ignored", note: `dispute on unknown charge ${f.chargeId || f.paymentIntentId || "?"} — revoke by hand if needed` };
    const now = this.now();
    rec.disputed = true;
    const note = cfg.policy.revokeOnDispute ? `dispute (${f.reason || "no reason"}): ${this.revoke(rec, "chargeback", now)}` : `dispute recorded (${f.reason || "no reason"}); revokeOnDispute is off`;
    this.touch(rec, ev, now);
    this.store.putCustomer(rec);
    return { outcome: "applied", note };
  }

  // ── the licence side ──────────────────────────────────────────────────────

  /** `metadata.plan` on the checkout session (Stripe copies it from the
   *  Payment Link) when it names a plan this Hub knows; else null. */
  private planKeyOf(metadata: Record<string, string>, cfg: BillingConfig): string | null {
    const raw = (metadata.plan ?? "").trim().toLowerCase();
    return PLAN_KEY_RE.test(raw) && planByKey(cfg, raw) ? raw : null;
  }

  /** Explicit `license_days` on the link wins, then the plan's own length,
   *  then the policy default. */
  private oneOffDaysFor(metadata: Record<string, string>, plan: Plan | null, cfg: BillingConfig): number {
    const raw = metadata.license_days ?? metadata.licence_days ?? "";
    const n = Number(raw);
    if (/^\d+$/.test(raw) && n >= 1 && n <= MAX_LICENSE_DAYS) return n;
    if (plan && plan.interval === null && plan.licenseDays) return plan.licenseDays;
    return cfg.policy.oneOffDays;
  }

  private licenseExp(rec: CustomerRecord): number | null {
    return this.licenses.list().find((l) => l.id === rec.licenseId)?.exp ?? null;
  }

  /** The cap a TEST licence can never exceed; live licences have none. */
  private capExp(rec: { livemode: boolean; createdAtMs: number }, exp: number, cfg: BillingConfig): number {
    return rec.livemode ? exp : Math.min(exp, rec.createdAtMs + cfg.policy.testMaxDays * DAY_MS);
  }

  private findCustomer(customerId: string, email: string): CustomerRecord | null {
    return (customerId ? this.store.getCustomer(customerId) : null)
      ?? (email ? this.store.findByEmail(email) : null);
  }

  /** The customer's record, minting a licence if this is the first time the
   *  Hub hears of them. The record is written BEFORE the caller's handler
   *  continues, so a crash later cannot orphan the freshly issued licence. */
  private ensureCustomer(facts: CustomerFacts, cfg: BillingConfig, initialExp: number, now: number): { rec: CustomerRecord; created: boolean } {
    const existing = this.findCustomer(facts.customerId, facts.email);
    if (existing) {
      if (facts.email && !existing.email) existing.email = facts.email;
      if (facts.name && (!existing.name || existing.name === existing.email)) existing.name = facts.name;
      if (facts.customerId && !existing.stripeCustomerId) existing.stripeCustomerId = facts.customerId;
      if (facts.subscriptionId) existing.subscriptionId = facts.subscriptionId;
      if (facts.planKey) existing.planKey = facts.planKey;
      return { rec: existing, created: false };
    }
    const key = facts.customerId || `email:${facts.email}`;
    const name = facts.name || facts.email || "Customer";
    const plan = [cfg.policy.plan, facts.planKey, facts.livemode ? null : "test"].filter(Boolean).join("-");
    const exp = this.capExp({ livemode: facts.livemode, createdAtMs: now }, initialExp, cfg);
    const issued = this.licenses.issueUntil(name, exp, plan, now);
    const rec: CustomerRecord = {
      key,
      stripeCustomerId: facts.customerId,
      email: facts.email,
      name,
      livemode: facts.livemode,
      licenseId: issued.payload.id,
      planKey: facts.planKey,
      subscriptionId: facts.subscriptionId || null,
      subscriptionStatus: null,
      periodEndMs: null,
      chargeIds: [],
      createdAtMs: now,
      updatedAtMs: now,
      welcomeSentAtMs: null,
      welcomeError: null,
      disputed: false,
      refunded: false,
      lastEventType: null,
      lastEventAtMs: null,
    };
    this.store.putCustomer(rec);
    this.log(`[billing] issued ${plan} licence ${issued.payload.id} for ${facts.email || key} until ${new Date(exp).toISOString().slice(0, 10)}`);
    return { rec, created: true };
  }

  /** Move the registry expiry FORWARD to `target` (capped for test licences
   *  and by the format's 3650-day bound). Returns whether anything changed.
   *  A revoked licence is never extended. */
  private extendLicense(rec: CustomerRecord, target: number, cfg: BillingConfig, now: number): boolean {
    const current = this.licenses.get(rec.licenseId);
    if (!current) return false;
    const capped = Math.min(this.capExp(rec, target, cfg), current.iat + MAX_LICENSE_DAYS * DAY_MS);
    if (capped <= current.exp) return false;
    this.licenses.setExpiry(rec.licenseId, capped, now);
    return true;
  }

  private revoke(rec: CustomerRecord, reason: string, now: number): string {
    const done = this.licenses.revoke(rec.licenseId, new Date(now));
    this.store.revokeTokens(rec.key, "install", now);
    if (done) {
      try { this.onRevoke(rec.licenseId, reason); } catch (err) { this.log(`[billing] revoke hook failed: ${(err as Error).message}`); }
      return `licence ${rec.licenseId} revoked`;
    }
    return `licence ${rec.licenseId} was not in the registry`;
  }

  private noteCharge(rec: CustomerRecord, id: string): void {
    if (id && !rec.chargeIds.includes(id)) {
      rec.chargeIds.push(id);
      if (rec.chargeIds.length > 50) rec.chargeIds.splice(0, rec.chargeIds.length - 50);
    }
  }

  private touch(rec: CustomerRecord, ev: StripeEvent, now: number): void {
    rec.lastEventType = ev.type;
    rec.lastEventAtMs = now;
    rec.updatedAtMs = now;
  }

  // ── the welcome email ─────────────────────────────────────────────────────

  /** Send once. Failure is recorded on the customer and never thrown: the
   *  payment already happened, and the admin page can resend. Returns a
   *  fragment for the event note. */
  private async sendWelcomeIfNeeded(rec: CustomerRecord, cfg: BillingConfig, now: number, force = false): Promise<string> {
    if (rec.welcomeSentAtMs !== null && !force) return "";
    if (!rec.email) {
      rec.welcomeError = "no email address on the Stripe customer";
      this.store.putCustomer(rec);
      return "; welcome NOT sent (no email)";
    }
    if (!emailReady(cfg.email)) {
      rec.welcomeError = "email provider is not configured — configure it and use Resend welcome";
      this.store.putCustomer(rec);
      return "; welcome NOT sent (email not configured)";
    }
    // A fresh page link every time we send; older links stop working.
    this.store.revokeTokens(rec.key, "page", now);
    const pageToken = this.store.mint("page", rec.licenseId, rec.key, now);
    const exp = this.licenseExp(rec) ?? now;
    const msg = welcomeEmail(rec.email, {
      name: rec.name,
      pageUrl: `${this.origin}/welcome/${pageToken}`,
      expiresAtMs: exp,
      subscription: !!rec.subscriptionId,
      siteOrigin: cfg.siteOrigin,
      livemode: rec.livemode,
    });
    const result = await sendEmail(cfg.email, msg, this.fetchLike);
    if (result.ok) {
      rec.welcomeSentAtMs = this.now();
      rec.welcomeError = null;
      this.store.putCustomer(rec);
      return `; welcome emailed to ${rec.email}`;
    }
    rec.welcomeError = result.error;
    this.store.putCustomer(rec);
    this.log(`[billing] welcome email to ${rec.email} failed: ${result.error}`);
    return `; welcome email FAILED (${result.error})`;
  }

  async resendWelcome(customerKey: string): Promise<{ ok: true; sentTo: string } | { ok: false; status: number; error: string }> {
    const rec = this.store.getCustomer(customerKey);
    if (!rec) return { ok: false, status: 404, error: "unknown customer" };
    const note = await this.sendWelcomeIfNeeded(rec, this.config(), this.now(), true);
    if (rec.welcomeError) return { ok: false, status: 502, error: rec.welcomeError };
    void note;
    return { ok: true, sentTo: rec.email };
  }

  async sendTestEmail(to: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const address = to.trim();
    if (!address.includes("@") || /[\r\n]/.test(address)) return { ok: false, error: "enter an email address" };
    const r = await sendEmail(this.config().email, testEmail(address, this.origin), this.fetchLike);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  // ── the customer's page and the one-time installer ────────────────────────

  welcomePage(rawPageToken: string, releaseReady: boolean): WelcomePageResult {
    const t = this.store.lookupPage(rawPageToken);
    if (!t) return { ok: false, status: 404, text: "This link is not valid any more. If you were sent a newer email, use that one; otherwise contact support." };
    const rec = this.store.getCustomer(t.customerKey) ?? this.store.findByLicense(t.licenseId);
    const lic = this.licenses.list().find((l) => l.id === t.licenseId);
    if (!rec || !lic) return { ok: false, status: 404, text: "This licence is no longer on file. Please contact support." };
    const now = this.now();
    const cfg = this.config();
    const expired = lic.exp <= now;
    const valid = !lic.revoked && !expired;
    let statusClass = "live";
    let statusLabel = "Active";
    let notice: { title: string; text: string; cls: string } | null = null;
    if (lic.revoked) {
      statusClass = "bad"; statusLabel = "Revoked";
      notice = { title: "This licence has been revoked", text: "Usually because a payment was disputed or refunded. If you think this is a mistake, email support and we will sort it out.", cls: "bad" };
    } else if (expired) {
      statusClass = "obs"; statusLabel = "Lapsed";
      notice = { title: "This licence has lapsed", text: "Renew it from the billing page below. A running bot stays in exit-only mode until the renewal reaches it (within a few minutes of payment).", cls: "warn" };
    } else if (!releaseReady) {
      notice = { title: "The installer is not ready yet", text: "No release is published on the Hub right now. Check back shortly — your licence is active and this page will offer the command as soon as a release is available.", cls: "warn" };
    }
    const canInstall = valid && releaseReady;
    const installToken = canInstall ? this.store.mint("install", rec.licenseId, rec.key, now) : "";
    const mode: BillingMode = rec.livemode ? "live" : "test";
    const portal = !!(cfg.stripe[mode].portalUrl || (cfg.stripe[mode].secretKey && rec.stripeCustomerId));
    const supportEmail = cfg.email.replyTo || cfg.email.from.replace(/^.*<([^>]+)>.*$/, "$1");
    const vars: Record<string, string> = {
      firstName: rec.name.trim().split(/\s+/)[0] || "there",
      statusClass,
      statusLabel,
      plan: lic.plan,
      expiresOn: new Date(lic.exp).toISOString().slice(0, 10),
      renewalLine: rec.subscriptionId
        ? (rec.subscriptionStatus?.startsWith("canceled") ? "Subscription cancelled — no further charges" : "Extends automatically when your subscription renews")
        : "One-time purchase",
      email: rec.email || "—",
      installCommand: canInstall ? `curl -q -fsSL "${this.origin}/install/${installToken}" | sudo bash` : "",
      noticeTitle: notice?.title ?? "",
      noticeText: notice?.text ?? "",
      noticeClass: notice?.cls ?? "",
      portalAction: `${this.origin}/welcome/${rawPageToken}/portal`,
      siteOrigin: cfg.siteOrigin,
      supportEmail,
    };
    const flags: Record<string, boolean> = {
      canInstall,
      notice: notice !== null,
      portal,
      site: !!cfg.siteOrigin,
      support: !!supportEmail && supportEmail.includes("@"),
    };
    return { ok: true, html: renderTemplate(fs.readFileSync(path.join(this.templatesDir, "welcome.html"), "utf8"), vars, flags) };
  }

  /** Burn the one-time token; hand back the licence token the installer
   *  needs. Reasons are spelled out — the caller already holds the link. */
  installByToken(rawInstallToken: string): InstallTokenResult {
    const r = this.store.consumeInstall(rawInstallToken, this.now());
    if (!r.ok) {
      const text = {
        unknown: "this install link is not valid — open your install page and copy the command again",
        used: "this install command was already used — reload your install page for a fresh one",
        expired: "this install command has expired (they last 24 hours) — reload your install page for a fresh one",
        revoked: "this install command is no longer valid — reload your install page for a fresh one",
      }[r.reason];
      return { ok: false, status: 403, text };
    }
    const lic = this.licenses.get(r.rec.licenseId);
    if (!lic) return { ok: false, status: 403, text: "this licence has been revoked — contact support" };
    if (lic.exp <= this.now()) return { ok: false, status: 403, text: "this licence has lapsed — renew it from your install page first" };
    const token = this.licenses.tokenFor(lic.id);
    if (!token) return { ok: false, status: 403, text: "this licence is not on file — contact support" };
    return { ok: true, licenseToken: token };
  }

  /** Where "Manage billing" goes: a fresh Customer Portal session when the
   *  secret key is on file (no login step for the customer), else the static
   *  portal login link, else nothing. */
  async portalRedirect(rawPageToken: string): Promise<PortalResult> {
    const t = this.store.lookupPage(rawPageToken);
    if (!t) return { ok: false, status: 404, error: "this link is not valid" };
    const rec = this.store.getCustomer(t.customerKey) ?? this.store.findByLicense(t.licenseId);
    if (!rec) return { ok: false, status: 404, error: "unknown customer" };
    const cfg = this.config();
    const m = cfg.stripe[rec.livemode ? "live" : "test"];
    if (m.secretKey && rec.stripeCustomerId) {
      try {
        const body = new URLSearchParams({ customer: rec.stripeCustomerId, return_url: `${this.origin}/welcome/${rawPageToken}` }).toString();
        const res = await this.fetchLike(STRIPE_PORTAL_SESSIONS_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${m.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        const text = await res.text();
        if (res.ok) {
          const url = (JSON.parse(text) as { url?: unknown }).url;
          if (typeof url === "string" && url.startsWith("https://")) return { ok: true, url };
        }
        this.log(`[billing] portal session refused (${res.status}): ${text.slice(0, 200)}`);
      } catch (err) {
        this.log(`[billing] portal session failed: ${(err as Error).message}`);
      }
    }
    if (m.portalUrl) return { ok: true, url: m.portalUrl };
    return { ok: false, status: 404, error: "billing management is not configured — email support" };
  }

  // ── admin views ───────────────────────────────────────────────────────────

  customersView(roster: Record<string, RosterEntry>): Record<string, unknown>[] {
    const licenses = new Map(this.licenses.list().map((l) => [l.id, l]));
    return Object.values(this.store.customers())
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((c) => {
        const lic = licenses.get(c.licenseId);
        const seen = roster[c.licenseId];
        return {
          customerId: c.key,
          stripeCustomerId: c.stripeCustomerId,
          email: c.email,
          name: c.name,
          livemode: c.livemode,
          licenseId: c.licenseId,
          planKey: c.planKey ?? null,
          licenseName: lic?.name ?? null,
          plan: lic?.plan ?? null,
          exp: lic?.exp ?? null,
          revoked: lic?.revoked ?? false,
          subscriptionId: c.subscriptionId,
          subscriptionStatus: c.subscriptionStatus,
          periodEndMs: c.periodEndMs,
          createdAtMs: c.createdAtMs,
          updatedAtMs: c.updatedAtMs,
          welcomeSentAtMs: c.welcomeSentAtMs,
          welcomeError: c.welcomeError,
          disputed: c.disputed,
          refunded: c.refunded,
          lastEventType: c.lastEventType,
          lastEventAtMs: c.lastEventAtMs,
          lastSeen: seen ? { version: seen.version, lastSeen: seen.lastSeen } : null,
        };
      });
  }

  events(limit: number): EventRecord[] {
    return this.store.recentEvents(limit);
  }
}

// ── the tiny template engine ────────────────────────────────────────────────
// `{{name}}` is HTML-escaped; `{{#if flag}}…{{/if}}` keeps or drops a block.
// Blocks do not nest. Small on purpose: one page, a dozen variables.
export function renderTemplate(template: string, vars: Record<string, string>, flags: Record<string, boolean>): string {
  const withBlocks = template.replace(/\{\{#if ([A-Za-z0-9_]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, flag: string, body: string) => (flags[flag] ? body : ""));
  return withBlocks.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_m, name: string) => escapeHtml(vars[name] ?? ""));
}
