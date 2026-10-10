import { randomUUID, createHash } from "node:crypto";
import { recoveryPath, recoveryRecords, type InstallRecoveryRecord } from "./install-recovery.js";
import { readFlags } from "../flags.js";
import { writeJsonAtomic, readJson } from "../jsonfile.js";
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
  type StripeModeConfig,
} from "./config.js";
import { provisionPlans, StripeApiError, type ProvisionResult } from "./stripe-provision.js";
import { escapeHtml, safeInstallCommand, reissuedInstallEmail, sendEmail, testEmail, welcomeEmail, type EmailFetch } from "./email.js";
import { BillingStore, INSTALL_TOKEN_TTL_MS, roleSubscriptionKey, type CheckoutSessionRecord, type CustomerRecord, type EventOutcome, type EventRecord, type RoleSubscriptionRecord } from "./store.js";
import { AfterCommitOutbox } from "./after-commit-outbox.js";
import { EarnStripeApi } from "../earn-stripe-api.js";
import { componentPriceId, softwareInvoiceProjection, softwareCheckoutProjection } from "./software-component.js";

import { launchGrant, reconcileLaunchSession, type LaunchIntent } from "./launch.js";
import { loadStarterPack, starterPackEligible, starterPackGrantAt } from "./starter-pack.js";
import { classifyRole, type BillingRole, type ClassifiedRole, type ModeRoleConfig } from "./roles.js";
import { foreignProductFamilyRefusal } from "./foreign-product-family.js";
import {
  chargeFacts,
  checkoutDiscountPercent,
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
export type { BillingRole } from "./roles.js";
export type { BillingMode } from "./config.js";

const DAY_MS = 86_400_000;
const STRIPE_PORTAL_SESSIONS_URL = "https://api.stripe.com/v1/billing_portal/sessions";

/** Every event type this Hub ever acts on, of EITHER role — the set the
 *  webhook subscribes to (README, "Register two webhook endpoints"). An
 *  event outside this set is "ignored — event type not handled" without
 *  ever reaching the role dispatcher: there is nothing here to classify. */
const DISPATCHED_EVENT_TYPES = new Set([
  "checkout.session.expired",
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.succeeded",
  "charge.refunded",
  "charge.dispute.created",
]);
const EARN_HOOK_TYPES = new Set([
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "invoice.payment_failed",
  "invoice.paid", "invoice.payment_succeeded",
  "customer.subscription.updated", "customer.subscription.deleted",
  "charge.refunded", "charge.dispute.created", "charge.dispute.closed",
]);

export type InstallBindingState = "unbound" | "bound" | "recovery-locked" | "unavailable";
export interface InstallRegenerationOptions {
  confirmed: boolean; expectedRevision: string; acknowledgeMachineBinding?: boolean; deviceReplacement?: boolean;
}

export interface DeviceRecoveryOptions {
  operationId: string; expectedLicenseId: string; expectedActivationId: string; expectedActivationRevision: number; expectedAuditRevision: number;
  confirmedDestroyedInstall: boolean; acknowledgeCachedGrace: boolean;
}
export interface DeviceRecoverySnapshot { auditRevision: number; active: { id: string; revision: number; cachedGraceUntilMs: number }[]; locked: boolean; }
export interface BillingServiceDeps {
  deviceRecoverySnapshot?: (licenseId: string) => DeviceRecoverySnapshot;
  checkRecoveryActivation?: (licenseId: string, activationId: string, revision: number, reason: string) => void;
  retireRecoveryActivation?: (licenseId: string, activationId: string, revision: number, reason: string) => void;
  recoveryHostingActive?: (customer: CustomerRecord) => boolean;
  recoveryCheckpoint?: (phase: string) => void;
  installBindingState?: (licenseId: string) => InstallBindingState;
  onVerifiedEvent?: (event: StripeEvent) => Promise<void>;
  now?: () => number;
  /** One injected fetch serves the email provider AND the Stripe portal call. */
  fetchLike?: EmailFetch;
  launchFetch?: typeof fetch;
  randomBytes?: (n: number) => Buffer;
  log?: (line: string) => void;
  /** Fired after a licence is revoked here, so the server can tell the lease
   *  ledger exactly as the admin revoke route does. */
  onRevoke?: (licenseId: string, reason: string) => void;
  /** Fired after a "hosting"-role event has updated its
   *  `RoleSubscriptionRecord` (H4's isolation surface — see
   *  `applyHostingEvent`'s header). Deliberately NOT the raw Stripe event:
   *  src/hosting/service.ts derives every hosting lifecycle transition from
   *  the ALREADY-CLASSIFIED, ALREADY-CORRECT `RoleSubscriptionRecord` this
   *  file maintains, rather than re-parsing Stripe's wire format a second
   *  time in a second module. A hook that throws propagates out of
   *  `applyEvent`/`handleWebhook` exactly like any other failure here (500,
   *  Stripe retries) — hosting's own store is its own idempotency boundary
   *  for what that retry does (src/hosting/store.ts's `reserveInstance`),
   *  so retrying this hook is always safe. */
  onHostingEvent?: (customerKey: string, livemode: boolean) => void;
  /** Atomically adopts the anonymous VPS reservation to the Stripe customer
   * proved by a bundle webhook. Returning false makes Stripe retry. */
  onExpiredCheckout?: (sessionId: string) => Promise<{ released: boolean }>;
  onBundleEvent?: (input: { reservationId: string; customerId: string; subscriptionId: string; planKey: string; livemode: boolean; terminal: boolean }) => boolean;
}

export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
}

export interface ApplyResult {
  outcome: EventOutcome;
  note: string | null;
}

/** Every answer `reconcileSubscriptionFromStripe` can give. The first four
 *  are ordinary outcomes; the "review" set is a refusal that writes nothing
 *  and names why (see `RECONCILE_REVIEW_VERDICTS`); the last three are
 *  request or Stripe-read failures that also write nothing. */
export type ReconcileVerdict =
  | "APPLIED" | "WOULD_APPLY" | "NOTHING_TO_APPLY" | "NO_SUBSCRIPTION"
  | "NO_PAID_INVOICE_YET" | "SUBSCRIPTION_NOT_ACTIVE" | "LICENSE_REVOKED" | "REFUNDED_OR_DISPUTED" | "RECOVERY_PENDING"
  | "LIFETIME_NOT_A_TERM" | "MULTIPLE_ACTIVE_SUBSCRIPTIONS" | "LATEST_INVOICE_UNSETTLED" | "INVOICE_HISTORY_INCOMPLETE"
  | "IDENTITY_MISMATCH" | "INVOICE_LINES_INCOMPLETE" | "PERIOD_MISMATCH" | "CONCURRENT_CHANGE" | "UNKNOWN_SUBSCRIPTION"
  | "INVALID_REQUEST" | "STRIPE_UNAVAILABLE" | "STRIPE_READ_FAILED";
export const RECONCILE_REVIEW_VERDICTS: ReadonlySet<ReconcileVerdict> = new Set<ReconcileVerdict>([
  "NO_PAID_INVOICE_YET", "SUBSCRIPTION_NOT_ACTIVE", "LICENSE_REVOKED", "REFUNDED_OR_DISPUTED", "RECOVERY_PENDING",
  "LIFETIME_NOT_A_TERM", "MULTIPLE_ACTIVE_SUBSCRIPTIONS", "LATEST_INVOICE_UNSETTLED", "INVOICE_HISTORY_INCOMPLETE",
  "IDENTITY_MISMATCH", "INVOICE_LINES_INCOMPLETE", "PERIOD_MISMATCH", "CONCURRENT_CHANGE", "UNKNOWN_SUBSCRIPTION",
]);
const RECONCILE_ERROR_VERDICTS: ReadonlySet<ReconcileVerdict> = new Set<ReconcileVerdict>(["INVALID_REQUEST", "STRIPE_UNAVAILABLE", "STRIPE_READ_FAILED"]);
/** The HTTP status the admin route answers for a verdict. */
export function reconcileHttpStatus(verdict: ReconcileVerdict): number {
  if (verdict === "INVALID_REQUEST") return 400;
  if (verdict === "UNKNOWN_SUBSCRIPTION") return 404;
  if (verdict === "STRIPE_READ_FAILED") return 502;
  if (verdict === "STRIPE_UNAVAILABLE") return 503;
  return RECONCILE_REVIEW_VERDICTS.has(verdict) ? 409 : 200;
}
export const RECONCILE_EVENT_TYPE = "admin.billing.reconcile-subscription";
export interface ReconcileOptions { dryRun?: boolean; by?: unknown; reason?: unknown }
export interface ReconcileFieldChange { before: number | string | null; after: number | string | null; changed: boolean }
export interface SubscriptionReconcileResult {
  verdict: ReconcileVerdict;
  /** A refusal the operator must look at (includes "no paid invoice yet"). */
  needsReview: boolean;
  /** Dry run: this call WOULD write. Apply: this call DID write. */
  changed: boolean;
  wrote: boolean;
  dryRun: boolean;
  note: string;
  customerKey: string | null;
  subscriptionId: string | null;
  licenseId: string | null;
  mode: BillingMode | null;
  /** What Stripe said, read through the Hub's Stripe client (null before or without a read). */
  stripe: null | {
    status: string; cancelAtPeriodEnd: boolean; currentPeriodEndMs: number | null;
    /** Subscriptions on the Stripe customer that have not ended (anything but canceled/incomplete_expired). */
    activeSubscriptionCount: number | null;
    latestInvoice: { id: string; status: string; billingReason: string } | null;
    /** The latest invoice with status `paid` and a positive `amount_paid` — the paid term. */
    paidInvoice: null | { id: string; billingReason: string; amountPaid: number; currency: string; periodStartMs: number | null; periodEndMs: number | null; paidAtMs: number | null };
  };
  /** before → after for every field the paid term sets; present from the point the term is evaluated. */
  changes: null | Record<"periodEndMs" | "paidThroughMs" | "firstActualPaymentAtMs" | "licenseExp" | "subscriptionStatus" | "discountPercent" | "lastEventType", ReconcileFieldChange>;
  /** The hosting role record of a combined subscription — READ ONLY; this tool never changes it. */
  hosting: null | { status: string | null; periodEndMs: number | null };
  auditEventId?: string;
  /** Present on the request/Stripe-read failure verdicts. */
  error?: string;
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
  metadata?: Record<string, string>;
  /** Signed event qualification, applied only with the first customer insert. */
  starterPackCandidateAtMs?: number | null;
}

const realFetch: EmailFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

export class BillingService {
  readonly store: BillingStore;
  private readonly now: () => number;
  private readonly fetchLike: EmailFetch;
  private readonly launchFetch: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly onVerifiedEvent: BillingServiceDeps["onVerifiedEvent"];
  private readonly afterCommitOutbox: AfterCommitOutbox | null;
  private drainingAfterCommit: Promise<{ completed: number; failed: number }> | null = null;
  private readonly onRevoke: (licenseId: string, reason: string) => void;
  private readonly onHostingEvent: (customerKey: string, livemode: boolean) => void;
  private readonly onExpiredCheckout: BillingServiceDeps["onExpiredCheckout"];
  private readonly onBundleEvent: BillingServiceDeps["onBundleEvent"];
  /** Prevent concurrent deliveries of the same event from both entering the
   * licence mutation before the durable seen marker is written. */
  private readonly inFlight = new Set<string>();
  /** Serialize all checkout mutations for one customer. Different Stripe
   * event ids can describe the same paid session, and different paid sessions
   * for one customer must calculate their target from the latest expiry. */
  private readonly checkoutLocks = new Map<string, Promise<void>>();
  private readonly installReissues = new Set<string>();
  private readonly recoveryDeps: BillingServiceDeps;
  private readonly installBindingState: (licenseId: string) => InstallBindingState;
  private readonly bundleLocks = new Map<string, Promise<void>>();

  constructor(
    readonly dataDir: string,
    private readonly licenses: LicenseStore,
    readonly publicOrigin: string,
    private readonly templatesDir: string,
    deps: BillingServiceDeps = {},
  ) {
    this.recoveryDeps = deps;
    this.installBindingState = deps.installBindingState ?? (() => "unavailable");
    this.onVerifiedEvent = deps.onVerifiedEvent;
    this.afterCommitOutbox = deps.onVerifiedEvent ? new AfterCommitOutbox(dataDir) : null;
    this.store = new BillingStore(dataDir, deps.randomBytes);
    this.now = deps.now ?? Date.now;
    this.fetchLike = deps.fetchLike ?? realFetch;
    this.launchFetch = deps.launchFetch ?? fetch;
    this.log = deps.log ?? ((line) => console.log(line));
    this.onRevoke = deps.onRevoke ?? (() => {});
    this.onHostingEvent = deps.onHostingEvent ?? (() => {});
    this.onBundleEvent = deps.onBundleEvent;
    this.onExpiredCheckout = deps.onExpiredCheckout;
  }

  /** Run at startup and on a timer, outside the Stripe request. An Earn
   * failure leaves the row durable for the next pass; the hook's own invoice
   * and event identities make a crash after hook success replay-safe. */
  drainAfterCommit(limit = 25): Promise<{ completed: number; failed: number }> {
    if (!this.afterCommitOutbox || !this.onVerifiedEvent) return Promise.resolve({ completed: 0, failed: 0 });
    if (this.drainingAfterCommit) return this.drainingAfterCommit;
    const run = async () => {
      let completed = 0, failed = 0;
      const ready = this.afterCommitOutbox!.pending().filter((row) =>
        row.committed || this.store.seenEvent(row.event.id));
      for (const row of ready.slice(0, limit)) {
        try {
          if (!row.committed) {
            if (!this.store.seenEvent(row.event.id)) continue;
            this.afterCommitOutbox!.commit(row.event.id);
          }
          await this.onVerifiedEvent!(row.event);
          this.afterCommitOutbox!.complete(row.event.id);
          completed++;
        } catch (error) {
          failed++;
          this.log(`[billing] Earn outbox event ${row.event.id} remains pending: ${(error as Error).message}`);
        }
      }
      return { completed, failed };
    };
    this.drainingAfterCommit = run().finally(() => { this.drainingAfterCommit = null; });
    return this.drainingAfterCommit;
  }

  /** The one write path for a hosting-role record: persists it exactly as
   *  `putRoleSubscription` always did, then fires the hosting hook. Every
   *  `applyHostingEvent` branch calls this instead of `store.putRoleSubscription`
   *  directly, so src/hosting/service.ts is told about EVERY hosting-role
   *  event this file ever records, from one call site. */
  private saveHostingRecord(rec: RoleSubscriptionRecord): void {
    this.store.putRoleSubscription(rec);
    try { this.onHostingEvent(rec.customerKey, rec.livemode); }
    catch (err) { throw new Error(`hosting hook failed for ${rec.customerKey}: ${(err as Error).message}`); }
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
        checkout: p.checkout,
        buyUrl: p.checkout === "payment-link" ? `${this.origin}/buy?plan=${encodeURIComponent(p.key)}` : null,
        available: p.checkout === "payment-link" && !!paymentLinkFor(cfg, cfg.mode, p.key),
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
      const launch = readJson<any>(path.join(this.dataDir, "billing-launch.v1.json"), {});
      result = await provisionPlans({ secretKey: m.secretKey, siteOrigin: cfg.siteOrigin, productName: "Wick Hunter Unleashed", plans: cfg.plans, skipPaymentLinkKeys: launch[mode]?.enabled ? ["monthly", "yearly"] : [] }, this.fetchLike);
    } catch (err) {
      if (err instanceof StripeApiError) {
        const hint = err.status === 401 || err.status === 403
          ? " — the saved key cannot create products; use a secret key (sk_) or a restricted key with Products, Prices and Payment Links set to Write"
          : "";
        return { ok: false, status: 502, error: `Stripe: ${err.message}${hint}` };
      }
      return { ok: false, status: 502, error: `Stripe request failed: ${(err as Error).message}` };
    }
    const links: Record<string, string | null> = {};
    const priceIds: Record<string, string> = {};
    for (const p of result.plans) {
      priceIds[p.key] = p.priceId;
      if (p.paymentLinkUrl) links[p.key] = p.paymentLinkUrl;
      else if (cfg.plans.find(plan => plan.key === p.key)?.checkout === "hosted-bundle") links[p.key] = null;
    }
    const first = cfg.plans[0]?.key;
    this.updateConfig({ stripe: { [mode]: { paymentLinks: links, priceIds, ...(!m.paymentLinkUrl && first && links[first] ? { paymentLinkUrl: links[first] } : {}) } } });
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
    if (this.inFlight.has(ev.id)) {
      return { status: 409, body: { ok: false, error: "event is already being applied; Stripe will retry" } };
    }
    // Stage first, even for a duplicate from an older Hub build. The Earn
    // handler is idempotent, while a missing historical handoff must not be
    // assumed complete. A disk refusal here returns 5xx before core mutation.
    const needsEarn = !!this.afterCommitOutbox && EARN_HOOK_TYPES.has(ev.type);
    if (needsEarn) {
      try { this.afterCommitOutbox!.stage(ev, receivedAtMs); }
      catch (err) {
        this.log(`[billing] could not stage Earn event ${ev.id}: ${(err as Error).message}`);
        return { status: 500, body: { ok: false, error: "event handoff could not be persisted; Stripe will retry" } };
      }
    }
    if (this.store.seenEvent(ev.id)) {
      if (needsEarn) {
        try { this.afterCommitOutbox!.commit(ev.id); }
        catch (err) {
          this.log(`[billing] could not commit Earn duplicate ${ev.id}: ${(err as Error).message}`);
          return { status: 500, body: { ok: false, error: "event handoff could not be persisted; Stripe will retry" } };
        }
      }
      this.store.appendEvent(record("duplicate", null));
      return { status: 200, body: { ok: true, outcome: "duplicate" } };
    }
    this.inFlight.add(ev.id);
    let result: ApplyResult;
    try {
      result = await this.applyEvent(ev, cfg);
    } catch (err) {
      const message = (err as Error).message;
      this.store.appendEvent(record("error", message));
      this.log(`[billing] ${ev.type} ${ev.id} failed: ${message}`);
      this.inFlight.delete(ev.id);
      return { status: 500, body: { ok: false, error: "event could not be applied; Stripe will retry" } };
    }
    this.store.markSeen(ev.id, receivedAtMs);
    if (needsEarn) {
      try { this.afterCommitOutbox!.commit(ev.id); }
      catch (err) {
        this.log(`[billing] Earn handoff for committed event ${ev.id} awaits retry: ${(err as Error).message}`);
        this.inFlight.delete(ev.id);
        return { status: 500, body: { ok: false, error: "event handoff could not be persisted; Stripe will retry" } };
      }
    }
    this.store.appendEvent(record(result.outcome, result.note));
    this.log(`[billing] ${ev.type} ${ev.id} (${ev.livemode ? "live" : "test"}): ${result.outcome}${result.note ? ` — ${result.note}` : ""}`);
    // Stripe may now be acknowledged. Earn runs from the durable outbox on
    // the server timer and cannot hold this HTTP response behind its queue.
    this.inFlight.delete(ev.id);
    return { status: 200, body: { ok: true, outcome: result.outcome } };
  }

  /** Pure-ish: no signature, no dedupe — the suite drives this directly. */
  async applyEvent(ev: StripeEvent, cfg: BillingConfig = this.config()): Promise<ApplyResult> {
    if (!ev.livemode && cfg.mode !== "test") return { outcome: "ignored", note: "test-mode event while the Hub is in LIVE mode" };
    if (!DISPATCHED_EVENT_TYPES.has(ev.type)) return { outcome: "ignored", note: "event type not handled" };

    // ── B15: a foreign product's event must never touch a licence ──────────
    // Runs BEFORE the role dispatcher and before any store write of any
    // kind (including the role index below) — see
    // foreign-product-family.ts's header for why this cannot be left to
    // roles.ts's own defaults. checkout/invoice/subscription events are the
    // only ones that ever carry `metadata` this Hub reads; charge/dispute
    // events carry none of this app's correlation metadata and are
    // unaffected by this check, exactly as the role dispatcher already
    // treats them (they resolve through the role INDEX, populated by the
    // invoice/subscription event that preceded them — which this check will
    // already have refused, so nothing downstream ever indexes a foreign
    // charge either).
    const foreignFamilyNote = this.foreignProductFamilyNote(ev);
    if (foreignFamilyNote) return { outcome: "ignored", note: foreignFamilyNote };

    if (ev.type === "checkout.session.expired") {
      const f = checkoutFacts(ev.object);
      if (f.metadata.bundle !== "software-hosting-v2") return { outcome: "ignored", note: "unowned checkout expiry" };
      if (!this.onExpiredCheckout) throw Error("Hosted expiry reconciler unavailable");
      await this.onExpiredCheckout(f.sessionId);
      return { outcome: "applied", note: "unused expired hosted reservation released" };
    }
    const split = this.splitBundleIdentity(ev);
    if (split.matched && split.identity) return this.withBundleLock(split.identity.launchIntentId, () => this.applyBundleEvent(ev, cfg, this.splitBundleIdentity(ev).identity!));
    const bundle = this.bundleIdentity(ev, cfg);
    if (bundle) return this.applyBundleEvent(ev, cfg, bundle);

    // ── the billing-role dispatcher (H1) ────────────────────────────────────
    // Classify BEFORE touching any state. This is the fix: every handler
    // below this point used to run for EVERY event on EVERY customer,
    // treating "this Stripe customer" and "the software subscription" as one
    // fact — which a second, unrelated subscription (hosting) on the same
    // customer breaks (see roles.ts's header and
    // tests/billing-roles.test.mjs's first section, "the defect this file
    // exists to prevent"). Only a "software" classification reaches the
    // pre-dispatcher switch below, byte-for-byte unchanged in what it does.
    const mode: BillingMode = ev.livemode ? "live" : "test";
    const classified = this.classify(ev, mode, cfg);
    let role: ClassifiedRole = classified.role;
    if (role !== "unknown") {
      const now = this.now();
      for (const id of classified.objectIds) {
        // noteRole refuses (without writing) when this exact object id was
        // already recorded under a DIFFERENT role — an anomaly (a Stripe id
        // does not change what it identifies) this Hub has never observed,
        // but a wrong role applied to live money is worse than an event
        // parked for the operator to look at by hand.
        if (!this.store.noteRole(id, role, now)) { role = "unknown"; break; }
      }
    }
    if (role === "unknown") {
      return { outcome: "unclassified", note: `${ev.type}: could not attribute this event to a product role — recorded for reconciliation, applied to neither software nor hosting` };
    }
    if (role === "hosting") return this.applyHostingEvent(ev);

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

  private async withBundleLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.bundleLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = prior.then(() => new Promise<void>(resolve => { release = resolve; }));
    this.bundleLocks.set(key, turn);
    await prior;
    try { return await fn(); } finally { release(); if (this.bundleLocks.get(key) === turn) this.bundleLocks.delete(key); }
  }

  private splitBundleIdentity(ev: StripeEvent): { matched: boolean; identity: { reservationId: string; customerId: string; subscriptionId: string; planKey: string; priceId: string; launchIntentId: string; hosting: NonNullable<LaunchIntent['hosting']> } | null } {
    let metadata: Record<string,string> = {}, customerId = '', subscriptionId = '', chargeId = '', observed: string[] = [];
    if (ev.type.startsWith('checkout.session.')) { const f = checkoutFacts(ev.object); metadata = f.metadata; customerId = f.customerId; subscriptionId = f.subscriptionId; }
    else if (ev.type.startsWith('invoice.')) { const f = invoiceFacts(ev.object); metadata = f.metadata; customerId = f.customerId; subscriptionId = f.subscriptionId; observed = f.priceIds; }
    else if (ev.type.startsWith('customer.subscription.')) { const f = subscriptionFacts(ev.object); metadata = f.metadata; customerId = f.customerId; subscriptionId = f.subscriptionId; observed = f.priceIds; }
    else if (ev.type === 'charge.dispute.created') { const f = disputeFacts(ev.object); chargeId = f.chargeId || f.paymentIntentId; }
    else if (ev.type.startsWith('charge.')) { const f = chargeFacts(ev.object); customerId = f.customerId; chargeId = f.chargeId || f.paymentIntentId; }
    if (!subscriptionId && chargeId) subscriptionId = this.store.findRoleSubscriptionByCharge('hosting', chargeId)?.subscriptionId ?? '';
    const bound = subscriptionId ? this.store.getBundleSubscription(subscriptionId) : null;
    const candidate = metadata.wh_launch_intent ? launchGrant(this.dataDir, metadata, ev.livemode) : null;
    const marked = metadata.bundle === 'software-hosting-v2' || !!bound?.launchIntentId || !!candidate?.hosting;
    if (!marked) return { matched: false, identity: null };
    const fail = (): never => { throw Error("Mixed checkout identity awaits review or durable reconciliation"); };
    if (bound?.launchIntentId && ((customerId && customerId !== bound.customerId) || (metadata.plan && metadata.plan !== bound.planKey) || (metadata.wh_launch_intent && metadata.wh_launch_intent !== bound.launchIntentId))) return fail();
    const grant = launchGrant(this.dataDir, bound?.launchIntentId ? { wh_launch_intent: bound.launchIntentId, plan: bound.planKey } : metadata, ev.livemode);
    const proof = grant?.hosting;
    if (!grant || !proof || grant.stripeParams['metadata[bundle]'] !== 'software-hosting-v2' || proof.softwarePriceId !== grant.stripeParams['line_items[0][price]'] || proof.hostingPriceId !== grant.stripeParams['line_items[1][price]'] || proof.softwareProductId === proof.hostingProductId || grant.firstPaymentAtMs !== null) return fail();
    if (metadata.bundle && metadata.bundle !== 'software-hosting-v2' || metadata.reservation && metadata.reservation !== proof.reservationId) return fail();
    if (grant.expiredAtMs) throw Error('Expired hosted checkout received a conflicting lifecycle event; review required');
    if (observed.length && (observed.some(p => ![proof.softwarePriceId,proof.hostingPriceId].includes(p)) || !observed.includes(proof.hostingPriceId) || grant.plan !== 'lifetime' && !observed.includes(proof.softwarePriceId))) return fail();
    if (ev.type.startsWith('invoice.') && !grant.sessionId) throw Error('Mixed checkout awaits its durable session reconciliation');
    return { matched: true, identity: { reservationId: proof.reservationId, customerId: customerId || bound?.customerId || '', subscriptionId, planKey: grant.plan, priceId: proof.softwarePriceId, launchIntentId: grant.id, hosting: proof } };
  }

  private bundleIdentity(ev: StripeEvent, cfg: BillingConfig): { reservationId: string; customerId: string; subscriptionId: string; planKey: string; priceId: string } | null {
    let metadata: Record<string, string> = {};
    let customerId = "";
    let subscriptionId = "";
    let chargeId = "";
    let observedPriceIds: string[] = [];
    if (ev.type.startsWith("checkout.session.")) {
      const f = checkoutFacts(ev.object); metadata = f.metadata; customerId = f.customerId; subscriptionId = f.subscriptionId;
    } else if (ev.type.startsWith("invoice.")) {
      const f = invoiceFacts(ev.object); metadata = f.metadata; customerId = f.customerId; subscriptionId = f.subscriptionId; chargeId = f.chargeId || f.paymentIntentId; observedPriceIds = f.priceIds;
    } else if (ev.type.startsWith("customer.subscription.")) {
      const f = subscriptionFacts(ev.object); metadata = f.metadata; customerId = f.customerId; subscriptionId = f.subscriptionId; observedPriceIds = f.priceIds;
    } else if (ev.type === "charge.dispute.created") {
      const f = disputeFacts(ev.object); chargeId = f.chargeId || f.paymentIntentId;
    } else if (ev.type.startsWith("charge.")) {
      const f = chargeFacts(ev.object); customerId = f.customerId; chargeId = f.chargeId || f.paymentIntentId;
    }
    if (subscriptionId) {
      const bound = this.store.getBundleSubscription(subscriptionId);
      if (bound) {
        if (
          (customerId && customerId !== bound.customerId)
          || (observedPriceIds.length > 0 && !observedPriceIds.includes(bound.priceId))
          || (metadata.plan && metadata.plan !== bound.planKey)
          || (metadata.reservation && metadata.reservation !== bound.reservationId)
          || (metadata.bundle && metadata.bundle !== "software-hosting-v1")
        ) return null;
        return { reservationId: bound.reservationId, customerId: customerId || bound.customerId, subscriptionId, planKey: bound.planKey, priceId: bound.priceId };
      }
    }
    const plan = planByKey(cfg, metadata.plan);
    if (metadata.bundle === "software-hosting-v1" && plan?.checkout === "hosted-bundle") {
      const expectedPriceId = cfg.stripe[ev.livemode ? "live" : "test"].priceIds[plan.key];
      if (!expectedPriceId || (observedPriceIds.length > 0 && !observedPriceIds.includes(expectedPriceId))) return null;
      return { reservationId: metadata.reservation ?? "", customerId, subscriptionId, planKey: plan.key, priceId: expectedPriceId };
    }
    if (subscriptionId) {
      const sw = this.store.findBySubscription(subscriptionId);
      const host = this.store.findRoleSubscriptionBySubscription("hosting", subscriptionId);
      if (sw && host && sw.key === host.customerKey) {
        const expectedPriceId = sw.planKey ? cfg.stripe[ev.livemode ? "live" : "test"].priceIds[sw.planKey] : "";
        if (!expectedPriceId || (observedPriceIds.length > 0 && !observedPriceIds.includes(expectedPriceId))) return null;
        return { reservationId: "", customerId: customerId || sw.stripeCustomerId, subscriptionId, planKey: sw.planKey ?? "", priceId: expectedPriceId };
      }
    }
    if (chargeId) {
      const sw = this.store.findByCharge(chargeId);
      const host = this.store.findRoleSubscriptionByCharge("hosting", chargeId);
      if (sw && host && sw.key === host.customerKey) {
        const boundSubscriptionId = sw.subscriptionId ?? host.subscriptionId ?? "";
        const bound = this.store.getBundleSubscription(boundSubscriptionId);
        if (bound) return { reservationId: bound.reservationId, customerId: customerId || bound.customerId, subscriptionId: boundSubscriptionId, planKey: bound.planKey, priceId: bound.priceId };
        return { reservationId: "", customerId: customerId || sw.stripeCustomerId, subscriptionId: boundSubscriptionId, planKey: sw.planKey ?? "", priceId: sw.planKey ? cfg.stripe[ev.livemode ? "live" : "test"].priceIds[sw.planKey] ?? "" : "" };
      }
    }
    return null;
  }

  private async applyBundleEvent(ev: StripeEvent, cfg: BillingConfig, bundle: { reservationId: string; customerId: string; subscriptionId: string; planKey: string; priceId: string; launchIntentId?: string; hosting?: NonNullable<LaunchIntent['hosting']> }): Promise<ApplyResult> {
    if (bundle.launchIntentId && (!bundle.subscriptionId || !bundle.customerId)) throw Error("Mixed checkout awaits complete durable subscription identity");
    if (!bundle.subscriptionId || !bundle.customerId || !bundle.planKey || !bundle.priceId) return { outcome: "unclassified", note: "bundle event did not carry a complete subscription identity" };
    const prior = this.store.getBundleSubscription(bundle.subscriptionId);
    if (prior && (
      prior.customerId !== bundle.customerId
      || prior.planKey !== bundle.planKey
      || prior.priceId !== bundle.priceId
      || (bundle.reservationId && prior.reservationId && prior.reservationId !== bundle.reservationId)
    )) return { outcome: "unclassified", note: "bundle event conflicts with the subscription's durable identity" };
    const lifetimeHosting = !!bundle.hosting && bundle.planKey === "lifetime";
    const lifetimeInitialPaid = lifetimeHosting && (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded" || ["invoice.paid","invoice.payment_succeeded"].includes(ev.type) && invoiceFacts(ev.object).paid && invoiceFacts(ev.object).priceIds.includes(bundle.priceId));
    const terminal = ev.type === "customer.subscription.deleted";
    if (prior?.terminal && !terminal && !lifetimeInitialPaid && !["charge.refunded","charge.dispute.created"].includes(ev.type)) return { outcome: "ignored", note: "bundle subscription already ended; later events cannot reactivate it" };
    const confirmed = ev.type === "checkout.session.async_payment_succeeded"
      || (ev.type === "checkout.session.completed" && checkoutFacts(ev.object).paymentStatus !== "unpaid")
      || ((ev.type === "invoice.paid" || ev.type === "invoice.payment_succeeded") && invoiceFacts(ev.object).paid);
    const knownSoftware = this.store.findBySubscription(bundle.subscriptionId);
    const knownHosting = this.store.findRoleSubscriptionBySubscription("hosting", bundle.subscriptionId);
    const hasEntitlements = !!knownSoftware || !!knownHosting;
    const failed = ev.type === "invoice.payment_failed";
    const statusUpdate = ev.type === "customer.subscription.updated";
    const orderingRelevant = terminal || confirmed || failed || (statusUpdate && hasEntitlements);
    const stale = !terminal && orderingRelevant && prior && ev.createdMs < prior.latestEventCreatedMs;
    // A failed renewal can arrive before the older paid invoice that proves
    // the initial term. Allow that one activation, then restore the newer
    // past-due state; once records exist, stale paid events are inert.
    const activatingBehindFailure = !!(stale && confirmed && !hasEntitlements && prior?.pendingStatus === "past_due");
    // Checkout creates a short bootstrap grant but is often timestamped AFTER
    // its initial paid invoice: Stripe creates the subscription and pays its
    // first invoice before it marks the Checkout Session complete, so the
    // `invoice.paid`/`invoice.payment_succeeded` events carry a `created`
    // (one-second resolution, `createdMs` above) at least one second before
    // the `checkout.session.completed` event's, yet Stripe delivers the
    // checkout first. The watermark the checkout wrote then makes both
    // invoice events `stale` under the strict `<` above (2026-10-09: the
    // bootstrap grant ran out three days later and hosting cancelled the paid
    // subscription). Delivery order must not discard that first paid term.
    // Restrict the exception to checkout-only, active records with no
    // paid-through date; never bypass a failure, refund or terminal fence.
    const initialPaidAfterCheckout = !!(stale && !lifetimeHosting && !prior?.pendingStatus
      && (ev.type === "invoice.paid" || ev.type === "invoice.payment_succeeded")
      && invoiceFacts(ev.object).paid && invoiceFacts(ev.object).billingReason === "subscription_create"
      && invoiceFacts(ev.object).periodEndMs !== null
      && knownSoftware?.lastEventType?.startsWith("checkout.session.")
      && knownSoftware.subscriptionStatus === "active" && knownSoftware.periodEndMs === null
      && !knownSoftware.disputed && !knownSoftware.refunded
      && knownHosting?.lastEventType?.startsWith("checkout.session.")
      && knownHosting.subscriptionStatus === "active" && knownHosting.periodEndMs === null
      && !knownHosting.disputed && !knownHosting.refunded);
    const eventSha256 = createHash("sha256").update(JSON.stringify(ev)).digest("hex");
    const pendingInitial = prior?.initialPaidPending;
    // The admission is durable before either role changes. A retry may finish
    // a partial write/hook, but only for exactly that event and while no newer
    // lifecycle state has superseded the original checkout watermark.
    const resumingInitialPaid = !!(stale && pendingInitial
      && pendingInitial.eventSha256 === eventSha256
      && pendingInitial.checkoutWatermarkMs === prior?.latestEventCreatedMs
      && !prior?.pendingStatus && !prior?.terminal
      && knownSoftware?.subscriptionStatus === "active"
      && knownHosting?.subscriptionStatus === "active"
      && !knownSoftware.refunded && !knownSoftware.disputed
      && !knownHosting.refunded && !knownHosting.disputed
      && [knownSoftware, knownHosting].every(rec =>
        (rec.lastEventType?.startsWith("checkout.session.") && rec.periodEndMs === null)
        || (rec.lastEventType === ev.type && rec.lastEventId === ev.id)));
    if (stale && !activatingBehindFailure && !lifetimeInitialPaid && !initialPaidAfterCheckout && !resumingInitialPaid) return { outcome: "ignored", note: "older bundle lifecycle event ignored" };

    if (initialPaidAfterCheckout) this.store.putBundleSubscription({
      ...prior!, initialPaidPending: { eventSha256, checkoutWatermarkMs: prior!.latestEventCreatedMs },
    });

    let softwareEvent = ev;
    if (bundle.hosting && ev.type.startsWith('invoice.')) softwareEvent = { ...ev, object: softwareInvoiceProjection(ev.object, bundle.hosting) };
    if (bundle.hosting && ev.type.startsWith('checkout.session.') && confirmed) {
      const api = new EarnStripeApi(cfg.stripe[ev.livemode ? 'live' : 'test'].secretKey, this.launchFetch);
      const lines = await api.call('GET', '/v1/checkout/sessions/' + checkoutFacts(ev.object).sessionId + '/line_items', { limit: 3 });
      softwareEvent = { ...ev, object: { ...ev.object, ...softwareCheckoutProjection(lines, bundle.hosting) } };
    }

    const ledger = {
      subscriptionId: bundle.subscriptionId,
      reservationId: prior?.reservationId || bundle.reservationId,
      customerId: bundle.customerId,
      planKey: bundle.planKey,
      priceId: bundle.priceId,
      ...(bundle.launchIntentId ? { launchIntentId: bundle.launchIntentId } : {}),
      latestEventCreatedMs: orderingRelevant ? Math.max(prior?.latestEventCreatedMs ?? 0, ev.createdMs) : (prior?.latestEventCreatedMs ?? 0),
      pendingStatus: failed ? "past_due" as const : (confirmed && !activatingBehindFailure ? null : prior?.pendingStatus ?? null),
      terminal: terminal || prior?.terminal === true,
      updatedAtMs: this.now(),
    };
    // A terminal record is written first and replayed idempotently. This
    // prevents a paid event delivered after deletion (even with a later
    // event id or timestamp) from creating either entitlement.
    if (terminal) this.store.putBundleSubscription(ledger);
    if (bundle.hosting && ev.type.startsWith("checkout.session.") && confirmed) {
      const f = checkoutFacts(ev.object);
      if (f.mode !== "subscription" || f.paymentStatus !== "paid") throw Error("Mixed checkout payment is not confirmed");
      await reconcileLaunchSession(this.dataDir, f.metadata, ev.livemode, f.sessionId, cfg.stripe[ev.livemode ? "live" : "test"].secretKey, this.launchFetch, this.now());
    }
    if (ledger.reservationId && (confirmed || terminal) && !prior?.terminal) {
      if (!this.onBundleEvent?.({ reservationId: ledger.reservationId, customerId: ledger.customerId, subscriptionId: ledger.subscriptionId, planKey: ledger.planKey, livemode: ev.livemode, terminal })) throw new Error("hosted bundle reservation could not be bound to the confirmed Stripe customer");
    }
    if (terminal && !this.store.findBySubscription(bundle.subscriptionId) && !this.store.findRoleSubscriptionBySubscription("hosting", bundle.subscriptionId)) {
      return { outcome: "applied", note: "bundle ended before activation; reservation closed and no entitlement issued" };
    }
    let software: ApplyResult;
    // Lifetime software is a one-time durable purchase on the initial mixed
    // invoice/session. Its hosting-only renewals and cancellation never
    // modify that software entitlement or index their charges as software.
    const lifetimeSoftwarePaid = lifetimeHosting && ['invoice.paid','invoice.payment_succeeded'].includes(ev.type) && invoiceFacts(ev.object).paid && (softwareEvent.object.lines as any)?.data?.length > 0;
    const skipLifetimeSoftware = lifetimeHosting && !ev.type.startsWith('checkout.session.') && !lifetimeSoftwarePaid && !['charge.refunded','charge.dispute.created'].includes(ev.type);
    if (skipLifetimeSoftware) software = { outcome: 'ignored', note: 'Lifetime software remains independent of VPS renewals/cancellation' };
    else switch (ev.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        if (lifetimeHosting) {
          const f = checkoutFacts(softwareEvent.object);
          if (f.paymentStatus === 'unpaid') software = { outcome: 'ignored', note: 'mixed payment is not confirmed' };
          else {
            await reconcileLaunchSession(this.dataDir, f.metadata, ev.livemode, f.sessionId, cfg.stripe[ev.livemode ? 'live' : 'test'].secretKey, this.launchFetch, this.now());
            software = await this.withCheckoutLocks([f.customerId], () => this.onPaymentCheckout(softwareEvent, cfg, { ...f, mode: 'payment', subscriptionId: '' }));
          }
        } else software = await this.onCheckout(softwareEvent, cfg);
        break;
      case "invoice.paid":
      case "invoice.payment_succeeded":
        if (lifetimeSoftwarePaid) {
          const grant = launchGrant(this.dataDir, { wh_launch_intent: bundle.launchIntentId!, plan: bundle.planKey }, ev.livemode)!;
          const f = invoiceFacts(ev.object);
          const synthetic = { ...ev, object: { amount_subtotal: softwareEvent.object.amount_subtotal, total_details: softwareEvent.object.total_details, amount_total: softwareEvent.object.amount_paid, id: grant.sessionId, mode: 'payment', payment_status: 'paid', customer: bundle.customerId, customer_details: { email: f.email, name: f.name }, payment_intent: f.paymentIntentId, metadata: { wh_launch_intent: grant.id, plan: grant.plan, non_renewing: 'true', license_days: String(this.plan('lifetime')?.licenseDays ?? cfg.policy.oneOffDays) } } };
          software = await this.withCheckoutLocks([bundle.customerId], () => this.onPaymentCheckout(synthetic, cfg, checkoutFacts(synthetic.object)));
          const rec = this.store.getCustomer(bundle.customerId); if (rec) { this.noteCharge(rec, f.chargeId); this.noteCharge(rec, f.paymentIntentId); this.store.putCustomer(rec); }
        } else software = await this.onInvoicePaid(softwareEvent, cfg);
        break;
      case "invoice.payment_failed": software = this.onInvoiceFailed(softwareEvent); break;
      case "customer.subscription.updated": software = this.onSubscriptionUpdated(softwareEvent, cfg); break;
      case "customer.subscription.deleted": software = this.onSubscriptionDeleted(ev); break;
      case "charge.succeeded": software = this.onChargeSucceeded(ev); break;
      case "charge.refunded":
      case "charge.dispute.created": {
        const f = ev.type === 'charge.refunded' ? chargeFacts(ev.object) : disputeFacts(ev.object);
        const rec = this.store.getCustomer(bundle.customerId);
        const softwareCharge = !lifetimeHosting || !!rec && [f.chargeId,f.paymentIntentId].some(id => !!id && rec.chargeIds.includes(id));
        software = softwareCharge ? ev.type === 'charge.refunded' ? this.onRefund(ev, cfg) : this.onDispute(ev, cfg) : { outcome: 'ignored', note: 'VPS-only charge does not change Lifetime software' };
        break;
      }
      default: return { outcome: "ignored", note: "bundle event type not handled" };
    }
    if (bundle.hosting && confirmed && (ev.type.startsWith('checkout.session.') || ev.type.startsWith('invoice.'))) {
      const rec = this.store.getCustomer(bundle.customerId), discount = checkoutDiscountPercent(softwareEvent.object);
      if (rec && discount !== null) { rec.discountPercent = discount; this.store.putCustomer(rec); }
    }
    const hosting = prior?.terminal && !["charge.refunded","charge.dispute.created"].includes(ev.type) ? { outcome: "ignored" as const, note: "ended VPS stays ended" } : this.applyHostingEvent(ev);
    if (activatingBehindFailure) {
      const softwareRec = this.store.findBySubscription(bundle.subscriptionId);
      if (softwareRec && !lifetimeHosting) { softwareRec.subscriptionStatus = "past_due"; softwareRec.updatedAtMs = this.now(); this.store.putCustomer(softwareRec); }
      const hostingRec = this.store.findRoleSubscriptionBySubscription("hosting", bundle.subscriptionId);
      if (hostingRec) { hostingRec.subscriptionStatus = "past_due"; hostingRec.updatedAtMs = this.now(); this.saveHostingRecord(hostingRec); }
    }
    if (!terminal) this.store.putBundleSubscription(ledger);
    return {
      outcome: software.outcome === "applied" || hosting.outcome === "applied" ? "applied" : software.outcome,
      note: `bundle software: ${software.note ?? software.outcome}; hosting: ${hosting.note ?? hosting.outcome}`,
    };
  }

  /** Every id the given ids array names, minus blanks — object ids arrive as
   *  `""` from `asId`/`asStr` on an absent field, and an empty string must
   *  never reach `store.noteRole`/`roleFor` (it would let every event with a
   *  blank field collide on one shared "" key). */
  private roleFromIndex(ids: readonly string[]): BillingRole | null {
    for (const id of ids) {
      if (!id) continue;
      const r = this.store.roleFor(id);
      if (r) return r;
    }
    return null;
  }

  /** `metadata.plan` (already read by every checkout handler, v0.4.15) joined
   *  to the Hub's OWN plan catalogue — the "binding aid" the dispatcher may
   *  consult once id matching is inconclusive (roles.ts's rule 4). Not the
   *  sole authority: an id match always wins over this, and this never fires
   *  at all for invoice/subscription events, which carry real price ids. */
  private planRoleOf(metadata: Record<string, string>, cfg: BillingConfig): BillingRole | null {
    const key = this.planKeyOf(metadata, cfg);
    return key ? planByKey(cfg, key)?.role ?? null : null;
  }

  /** B15's gate: the refusal reason for a foreign event's `productFamily`
   *  metadata, or `null` when it carries none (see
   *  foreign-product-family.ts). Reads the exact metadata bag each event
   *  type carries the tag in — a checkout session's own `metadata`, an
   *  invoice's correlating subscription metadata (three documented Stripe
   *  API shapes; see `invoiceFacts`), or a subscription's own top-level
   *  `metadata`. `charge.*`/`dispute.*` events carry none of this app's
   *  correlation metadata (Stripe does not copy an invoice's or a
   *  subscription's metadata onto the charge or the dispute it produces),
   *  so they fall through untouched — the same as every other Hub event. */
  private foreignProductFamilyNote(ev: StripeEvent): string | null {
    switch (ev.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return foreignProductFamilyRefusal({ productFamily: checkoutFacts(ev.object).metadata.productFamily ?? "" });
      case "invoice.paid":
      case "invoice.payment_succeeded":
      case "invoice.payment_failed":
        return foreignProductFamilyRefusal({ productFamily: invoiceFacts(ev.object).metadata.productFamily ?? "" });
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        return foreignProductFamilyRefusal({ productFamily: subscriptionFacts(ev.object).metadata.productFamily ?? "" });
      default:
        return null;
    }
  }

  /** The dispatcher itself: which role this ONE event belongs to, and every
   *  object id it names (so the caller can remember the decision for a later
   *  event — a refund or dispute — that carries no price/product id of its
   *  own and can only identify itself by charge/payment-intent/invoice id).
   *
   *  Ordering, and why: invoice and subscription events carry real,
   *  authoritative price/product ids INLINE in the webhook payload (Stripe
   *  expands `price` on both line items and subscription items by default —
   *  no fetch needed), so those are classified from the ids first and the
   *  role index is consulted only if that comes back "unknown" (an id an
   *  operator has not yet allowlisted on either side, or removed from one).
   *  Charge and dispute events carry NO price/product id at all, so the
   *  index — populated by the invoice/subscription event that always
   *  precedes them chronologically for a real charge — is checked FIRST;
   *  falling through to `classifyRole` with empty facts is still correct
   *  when the index has nothing (the day-1 default, or "unknown"). */
  private classify(ev: StripeEvent, mode: BillingMode, cfg: BillingConfig): { role: ClassifiedRole; objectIds: string[] } {
    const rcfg: ModeRoleConfig = cfg.roles[mode];
    switch (ev.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const f = checkoutFacts(ev.object);
        const objectIds = [f.sessionId, f.subscriptionId, f.paymentIntentId].filter(Boolean);
        const role = classifyRole({ priceIds: [], productIds: [], planRole: this.planRoleOf(f.metadata, cfg) }, rcfg);
        return { role, objectIds };
      }
      case "invoice.paid":
      case "invoice.payment_succeeded":
      case "invoice.payment_failed": {
        const f = invoiceFacts(ev.object);
        const objectIds = [f.subscriptionId, f.invoiceId, f.chargeId, f.paymentIntentId].filter(Boolean);
        const fresh = classifyRole({ priceIds: f.priceIds, productIds: f.productIds, planRole: null }, rcfg);
        const role = fresh !== "unknown" ? fresh : this.roleFromIndex(objectIds) ?? "unknown";
        return { role, objectIds };
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const f = subscriptionFacts(ev.object);
        const objectIds = [f.subscriptionId].filter(Boolean);
        const fresh = classifyRole({ priceIds: f.priceIds, productIds: f.productIds, planRole: null }, rcfg);
        const role = fresh !== "unknown" ? fresh : this.roleFromIndex(objectIds) ?? "unknown";
        return { role, objectIds };
      }
      case "charge.succeeded":
      case "charge.refunded": {
        const f = chargeFacts(ev.object);
        const objectIds = [f.chargeId, f.paymentIntentId, f.invoiceId].filter(Boolean);
        const role = this.roleFromIndex(objectIds) ?? classifyRole({ priceIds: [], productIds: [], planRole: null }, rcfg);
        return { role, objectIds };
      }
      case "charge.dispute.created": {
        const f = disputeFacts(ev.object);
        const objectIds = [f.chargeId, f.paymentIntentId].filter(Boolean);
        const role = this.roleFromIndex(objectIds) ?? classifyRole({ priceIds: [], productIds: [], planRole: null }, rcfg);
        return { role, objectIds };
      }
      default:
        return { role: "unknown", objectIds: [] };
    }
  }

  // ── hosting handlers (role: "hosting") ───────────────────────────────────
  // Deliberately minimal: this is H1's isolation fix, not the hosting
  // lifecycle (H4/H5/H6 — suspension, deletion, notices, a durable
  // transactional store). Every handler here does exactly one thing: record
  // what Stripe proved onto THIS role's OWN record, keyed by (customer,
  // "hosting"), and never read or write a CustomerRecord/licence. That is
  // what makes "hosting purchase, payment failure, cancellation, refund and
  // dispute leave software ID, expiry and status correct" hold.

  private findHostingCustomer(customerId: string, email: string): RoleSubscriptionRecord | null {
    const key = customerId || (email ? `email:${email}` : "");
    return key ? this.store.getRoleSubscription(key, "hosting") : null;
  }

  private ensureHostingCustomer(customerId: string, email: string, livemode: boolean, now: number): RoleSubscriptionRecord {
    const key = customerId || `email:${email}`;
    const existing = this.store.getRoleSubscription(key, "hosting");
    if (existing) return existing;
    return {
      key: roleSubscriptionKey(key, "hosting"),
      customerKey: key,
      role: "hosting",
      livemode,
      subscriptionId: null,
      subscriptionStatus: null,
      periodEndMs: null,
      chargeIds: [],
      disputed: false,
      refunded: false,
      createdAtMs: now,
      updatedAtMs: now,
      lastEventType: null,
      lastEventAtMs: null,
    };
  }

  private touchHosting(rec: RoleSubscriptionRecord, ev: StripeEvent, now: number): void {
    rec.lastEventType = ev.type;
    rec.lastEventId = ev.id;
    rec.lastEventAtMs = now;
    rec.updatedAtMs = now;
  }

  private noteHostingCharge(rec: RoleSubscriptionRecord, id: string): void {
    if (id && !rec.chargeIds.includes(id)) {
      rec.chargeIds.push(id);
      if (rec.chargeIds.length > 50) rec.chargeIds.splice(0, rec.chargeIds.length - 50);
    }
  }

  private applyHostingEvent(ev: StripeEvent): ApplyResult {
    const now = this.now();
    switch (ev.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const f = checkoutFacts(ev.object);
        if (f.mode !== "subscription" && f.mode !== "payment") return { outcome: "ignored", note: `hosting checkout mode ${f.mode || "?"}` };
        if (f.paymentStatus === "unpaid") return { outcome: "ignored", note: "hosting checkout not confirmed yet (async_payment_succeeded will follow)" };
        if (!f.customerId && !f.email) return { outcome: "ignored", note: "hosting checkout carried neither a customer nor an email" };
        const rec = this.ensureHostingCustomer(f.customerId, f.email, ev.livemode, now);
        rec.subscriptionId = f.subscriptionId || rec.subscriptionId;
        rec.subscriptionStatus = rec.subscriptionStatus ?? "active";
        this.touchHosting(rec, ev, now);
        this.saveHostingRecord(rec);
        return { outcome: "applied", note: "hosting checkout recorded; software licence untouched" };
      }
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const f = invoiceFacts(ev.object);
        if (!f.paid) return { outcome: "ignored", note: "hosting invoice not paid" };
        if (!f.customerId && !f.email) return { outcome: "ignored", note: "hosting invoice carried neither a customer nor an email" };
        const rec = this.ensureHostingCustomer(f.customerId, f.email, ev.livemode, now);
        rec.subscriptionId = f.subscriptionId || rec.subscriptionId;
        rec.subscriptionStatus = "active";
        if (f.periodEndMs !== null && (rec.periodEndMs === null || f.periodEndMs > rec.periodEndMs)) rec.periodEndMs = f.periodEndMs;
        this.noteHostingCharge(rec, f.chargeId);
        this.noteHostingCharge(rec, f.paymentIntentId);
        this.touchHosting(rec, ev, now);
        this.saveHostingRecord(rec);
        return { outcome: "applied", note: "hosting invoice recorded; software licence untouched" };
      }
      case "invoice.payment_failed": {
        const f = invoiceFacts(ev.object);
        const rec = this.findHostingCustomer(f.customerId, f.email);
        if (!rec) return { outcome: "ignored", note: "hosting customer not known" };
        rec.subscriptionStatus = "past_due";
        this.touchHosting(rec, ev, now);
        this.saveHostingRecord(rec);
        return { outcome: "applied", note: "hosting marked past due; software licence untouched" };
      }
      case "customer.subscription.updated": {
        const f = subscriptionFacts(ev.object);
        const rec = this.findHostingCustomer(f.customerId, "");
        if (!rec) return { outcome: "ignored", note: "hosting customer not known" };
        rec.subscriptionId = f.subscriptionId || rec.subscriptionId;
        rec.subscriptionStatus = f.cancelAtPeriodEnd && f.status === "active" ? "active (cancels at period end)" : f.status || rec.subscriptionStatus;
        if ((f.status === "active" || f.status === "trialing") && f.currentPeriodEndMs !== null && (rec.periodEndMs === null || f.currentPeriodEndMs > rec.periodEndMs)) rec.periodEndMs = f.currentPeriodEndMs;
        this.touchHosting(rec, ev, now);
        this.saveHostingRecord(rec);
        return { outcome: "applied", note: "hosting status updated; software licence untouched" };
      }
      case "customer.subscription.deleted": {
        const f = subscriptionFacts(ev.object);
        const rec = this.findHostingCustomer(f.customerId, "");
        if (!rec) return { outcome: "ignored", note: "hosting customer not known" };
        rec.subscriptionStatus = "canceled";
        this.touchHosting(rec, ev, now);
        this.saveHostingRecord(rec);
        return { outcome: "applied", note: "hosting subscription ended; software licence untouched" };
      }
      case "charge.succeeded": {
        const f = chargeFacts(ev.object);
        const rec = this.findHostingCustomer(f.customerId, f.email);
        if (!rec) return { outcome: "ignored", note: "hosting customer not known yet (checkout/invoice will attribute later charges)" };
        this.noteHostingCharge(rec, f.chargeId);
        this.noteHostingCharge(rec, f.paymentIntentId);
        this.touchHosting(rec, ev, now);
        this.saveHostingRecord(rec);
        return { outcome: "applied", note: "hosting charge recorded; software licence untouched" };
      }
      case "charge.refunded": {
        const f = chargeFacts(ev.object);
        const rec = this.findHostingCustomer(f.customerId, f.email)
          ?? this.store.findRoleSubscriptionByCharge("hosting", f.chargeId)
          ?? this.store.findRoleSubscriptionByCharge("hosting", f.paymentIntentId);
        if (!rec) return { outcome: "ignored", note: "hosting customer not known — software licence untouched either way" };
        const full = f.refunded || (f.amount !== null && f.amountRefunded !== null && f.amountRefunded >= f.amount);
        if (full) rec.refunded = true;
        this.touchHosting(rec, ev, now);
        this.saveHostingRecord(rec);
        return { outcome: "applied", note: full ? "hosting full refund recorded; software licence untouched" : "hosting partial refund recorded; software licence untouched" };
      }
      case "charge.dispute.created": {
        const f = disputeFacts(ev.object);
        const rec = this.store.findRoleSubscriptionByCharge("hosting", f.chargeId) ?? this.store.findRoleSubscriptionByCharge("hosting", f.paymentIntentId);
        if (!rec) return { outcome: "ignored", note: `hosting dispute on unknown charge ${f.chargeId || f.paymentIntentId || "?"} — software licence untouched either way` };
        rec.disputed = true;
        this.touchHosting(rec, ev, now);
        this.saveHostingRecord(rec);
        return { outcome: "applied", note: `hosting dispute recorded (${f.reason || "no reason"}); software licence untouched` };
      }
      default:
        return { outcome: "ignored", note: "event type not handled" };
    }
  }

  // ── handlers (role: "software" — pre-dispatcher, byte-for-byte unchanged) ─

  private async onCheckout(ev: StripeEvent, cfg: BillingConfig): Promise<ApplyResult> {
    const f = checkoutFacts(ev.object);
    if (f.mode !== "subscription" && f.mode !== "payment") return { outcome: "ignored", note: `checkout mode ${f.mode || "?"}` };
    if (f.paymentStatus === "unpaid") return { outcome: "ignored", note: "payment not confirmed yet (async_payment_succeeded will follow)" };
    let launch = null as ReturnType<typeof launchGrant>;
    if (f.metadata.wh_launch_intent) {
      if (!f.customerId) throw Error('Launch checkout is missing its Stripe customer');
      const mode = ev.livemode ? 'live' : 'test';
      const grant = await reconcileLaunchSession(this.dataDir, f.metadata, ev.livemode, f.sessionId,
        cfg.stripe[mode].secretKey, this.launchFetch, this.now());
      launch = grant;
      if (!grant || f.mode !== grant.stripeParams.mode ||
        (grant.payment === 'crypto' ? f.paymentStatus !== 'paid' : f.mode === 'payment' && f.paymentStatus !== 'paid')) {
        throw Error('Launch checkout payment mode or settlement does not match the purchase');
      }
      if (f.mode === 'subscription' && !f.subscriptionId) throw Error('Launch checkout is missing its Stripe subscription');
    }
    if (!f.customerId && !f.email) return { outcome: "ignored", note: "checkout carried neither a customer nor an email" };
    const known = (launch?.licenseId ? this.store.findByLicense(launch.licenseId) : null)
      ?? this.findCustomer(f.customerId, f.email, ev.livemode, !launch);
    const lockKeys = [...new Set([known?.key, f.customerId, f.email ? `email:${f.email}` : undefined].filter((key): key is string => !!key))];
    return this.withCheckoutLocks(lockKeys, () => f.mode === "payment"
      ? this.onPaymentCheckout(ev, cfg, f)
      : this.onSubscriptionCheckout(ev, cfg, f));
  }

  /** Checkout sessions are durable purchases. The bounded chargeIds list is
   * retained as a fast legacy index, but this marker is the authority for a
   * payment-mode session after that list rotates or the Hub restarts. */
  private async onPaymentCheckout(ev: StripeEvent, cfg: BillingConfig, f: ReturnType<typeof checkoutFacts>): Promise<ApplyResult> {
    if (!f.sessionId) throw new Error("payment checkout is missing its Stripe session id");
    const now = this.now();
    const planKey = this.planKeyOf(f.metadata, cfg);
    const grant = launchGrant(this.dataDir, f.metadata, ev.livemode, f.sessionId);
    const oneOffDays = this.oneOffDaysFor(f.metadata, planByKey(cfg, planKey), cfg);
    const beforeRecovery = (grant?.licenseId ? this.store.findByLicense(grant.licenseId) : null)
      ?? this.findCustomer(f.customerId, f.email, ev.livemode, !grant);
    if(beforeRecovery && this.recoveryPending(beforeRecovery.key))throw Error("Customer recovery must complete before checkout mutation");
    const recoveryKeys = [...new Set([beforeRecovery?.key, f.customerId, f.email ? `email:${f.email}` : undefined].filter((key): key is string => !!key))];
    for (const key of recoveryKeys) await this.recoverPendingCheckout(key, cfg, now, ev);
    const existing = (grant?.licenseId ? this.store.findByLicense(grant.licenseId) : null)
      ?? this.findCustomer(f.customerId, f.email, ev.livemode, !grant);
    // If Stripe adds a customer id to a session that was first observed by
    // email, retain the BillingStore row's canonical key for the marker.
    const customerKey = existing?.key ?? (f.customerId || `email:${f.email}`);
    const newCustomer = existing === null;
    let licenseId: string | null = null;
    let targetExpMs: number;
    if (existing) {
      const current = this.licenses.get(existing.licenseId);
      if (!current) {
        // A refunded purchase can replay after its license is revoked. The
        // applied session remains durable proof that this exact purchase was
        // already handled; acknowledge it without restoring any entitlement.
        const completed = this.store.getCheckoutSession(f.sessionId);
        if (this.licenses.isRevoked(existing.licenseId) && completed?.status === 'applied' &&
            completed.customerKey === customerKey) {
          this.assertAppliedCheckout(completed);
          return { outcome: 'duplicate', note: 'revoked checkout session was already applied' };
        }
        throw new Error(`checkout customer ${customerKey} has no license registry entry`);
      }
      licenseId = existing.licenseId;
      targetExpMs = this.paymentTarget(existing, current.exp, oneOffDays, cfg, now);
      // A legacy marker already proved that this purchase was applied before
      // the durable ledger existed. Preserve it and migrate the fact without
      // touching the expiry again.
      if (existing.chargeIds.includes(`cs:${f.sessionId}`) && !this.store.getCheckoutSession(f.sessionId)) {
        this.store.putCheckoutSession({ sessionId: f.sessionId, customerKey, licenseId, targetExpMs: current.exp, newCustomer: false, status: "applied", createdAtMs: now, updatedAtMs: now });
        return { outcome: "duplicate", note: "checkout session was already applied" };
      }
    } else {
      targetExpMs = this.capExp({ livemode: ev.livemode, createdAtMs: now }, now + oneOffDays * DAY_MS, cfg);
      if (grant?.licenseId) {
        const bound = this.licenses.get(grant.licenseId);
        if (!bound || this.licenses.isRevoked(bound.id)) throw Error('The checkout license is no longer available');
        licenseId = bound.id;
        targetExpMs = Math.min(this.capExp({ livemode: ev.livemode, createdAtMs: now }, Math.max(bound.exp, now) + oneOffDays * DAY_MS, cfg), bound.iat + MAX_LICENSE_DAYS * DAY_MS);
      }
    }
    if (grant?.accessUntilMs) targetExpMs = Math.max(targetExpMs, this.capExp({ livemode: ev.livemode, createdAtMs: now }, grant.accessUntilMs, cfg));
    // The pointer is written before the marker so a crash between these two
    // writes leaves only a harmless stale pointer, which the next checkout
    // clears after observing the missing marker.
    this.store.putPendingCheckout(customerKey, f.sessionId);
    const starterPackGrantAtMs = starterPackGrantAt(grant, ev, newCustomer);
    const claimed = this.store.claimCheckoutSession({ sessionId: f.sessionId, customerKey, licenseId, targetExpMs, newCustomer, createdAtMs: now, now, email: f.email, name: f.name, livemode: ev.livemode, planKey, subscriptionId: f.subscriptionId, paymentIntentId: f.paymentIntentId, ...(f.paymentStatus === 'paid' && Number.isSafeInteger(ev.createdMs) && ev.createdMs > 0 ? { paidAtMs: ev.createdMs } : {}), ...(grant ? { launchIntentId: grant.id, ...(grant.hosting ? { softwarePaid: Number(ev.object.amount_total) > 0 } : {}) } : {}), ...(starterPackGrantAtMs !== null ? { starterPackGrantAtMs } : {}) });
    const marker = claimed.record;
    if (!claimed.created && marker.status === "applied") {
      this.assertAppliedCheckout(marker);
      const starterPackGrant = starterPackGrantAt(grant, ev, marker.newCustomer);
      if (starterPackGrant !== null) {
        const applied = this.store.getCustomer(marker.customerKey);
        if (applied && !applied.starterPackGrantedAtMs) {
          applied.starterPackGrantedAtMs = starterPackGrant;
          this.store.putCustomer(applied);
        }
      }
      if (grant) {
        const verifiedDiscount = checkoutDiscountPercent(ev.object);
        const applied = this.store.getCustomer(marker.customerKey);
        if (applied && verifiedDiscount !== null && applied.discountPercent !== verifiedDiscount) {
          applied.discountPercent = verifiedDiscount;
          this.store.putCustomer(applied);
        }
      }
      const applied = this.store.getCustomer(marker.customerKey);
      if (applied) { this.noteCharge(applied, f.paymentIntentId); this.store.putCustomer(applied); }
      this.store.clearPendingCheckout(customerKey, f.sessionId);
      return { outcome: "duplicate", note: "checkout session was already applied" };
    }
    const { rec, created } = this.ensureCustomer(
      { customerId: f.customerId, email: f.email, name: f.name, subscriptionId: f.subscriptionId, livemode: ev.livemode, planKey, metadata: f.metadata, starterPackCandidateAtMs: marker.starterPackGrantAtMs },
      cfg,
      marker.targetExpMs,
      now,
    );
    if (marker.licenseId && !this.store.customerLicenseMatches(rec, marker.licenseId)) throw new Error(`checkout session ${f.sessionId} changed license`);
    if (!marker.licenseId) {
      marker.licenseId = rec.licenseId;
      marker.updatedAtMs = now;
      this.store.putCheckoutSession(marker);
    }
    const current = this.licenses.get(rec.licenseId);
    if (!current) throw new Error(`checkout session ${f.sessionId} has no license registry entry`);
    if (marker.newCustomer) {
      // The initial issue used marker.targetExpMs. If a crash happened after
      // the issue but before this marker update, replay only repairs a short
      // write; it never adds another one-off term.
      if (current.exp < marker.targetExpMs) this.licenses.setExpiry(rec.licenseId, marker.targetExpMs, now);
    } else {
      // `targetExpMs` was persisted before this mutation. Replaying after a
      // crash therefore writes the same expiry again, never a second term.
      this.extendLicense(rec, marker.targetExpMs, cfg, now);
    }
    const checkoutMarker = `cs:${f.sessionId}`;
    if (marker.starterPackGrantAtMs && !rec.starterPackGrantedAtMs && marker.newCustomer) rec.starterPackGrantedAtMs = marker.starterPackGrantAtMs;
    if (planByKey(cfg, planKey)?.lifetime && ev.livemode && marker.paidAtMs) rec.lifetimeAccess = true;
    if (grant) {
      const verifiedDiscount = checkoutDiscountPercent(ev.object);
      if (verifiedDiscount !== null) rec.discountPercent = verifiedDiscount;
    }
    if (!rec.subscriptionId) rec.periodEndMs = marker.targetExpMs;
    if (marker.paidAtMs && (!grant?.hosting || Number(ev.object.amount_total) > 0)) this.noteFirstActualPayment(rec, marker.paidAtMs);
    this.noteCharge(rec, checkoutMarker);
    this.noteCharge(rec, f.paymentIntentId);
    this.touch(rec, ev, now);
    this.store.putCustomer(rec);
    marker.status = "applied";
    marker.updatedAtMs = now;
    this.store.putCheckoutSession(marker);
    this.store.clearPendingCheckout(customerKey, f.sessionId);
    let note = marker.newCustomer && created ? `licence issued${planKey ? ` (${planKey})` : ""}` : "customer known";
    note += await this.sendWelcomeIfNeeded(rec, cfg, now);
    return { outcome: "applied", note };
  }

  /** Finish a marker left pending by a prior process before calculating a
   * later purchase's target. This ordering preserves every paid term: B must
   * see A's expiry even when A's final write was interrupted. */
  private async recoverPendingCheckout(customerKey: string, cfg: BillingConfig, now: number, ev: StripeEvent): Promise<void> {
    const sessionId = this.store.getPendingCheckout(customerKey);
    if (!sessionId) return;
    const marker = this.store.getCheckoutSession(sessionId);
    if (!marker) { this.store.clearPendingCheckout(customerKey, sessionId); return; }
    if (marker.customerKey !== customerKey) throw new Error(`pending checkout ${sessionId} changed customer`);
    if (marker.status === "applied") { this.store.clearPendingCheckout(customerKey, sessionId); return; }
    const email = marker.email ?? (customerKey.startsWith("email:") ? customerKey.slice("email:".length) : "");
    const { rec } = this.ensureCustomer({
      customerId: customerKey.startsWith("email:") ? "" : customerKey,
      email,
      name: marker.name ?? email,
      subscriptionId: marker.subscriptionId ?? "",
      livemode: marker.livemode ?? ev.livemode,
      planKey: marker.planKey ?? null,
      starterPackCandidateAtMs: marker.starterPackGrantAtMs,
      ...(marker.launchIntentId ? { metadata: { wh_launch_intent: marker.launchIntentId, plan: marker.planKey ?? '' } } : {}),
    }, cfg, marker.targetExpMs, now);
    if (marker.licenseId && !this.store.customerLicenseMatches(rec, marker.licenseId)) throw new Error(`pending checkout ${sessionId} changed license`);
    if (!marker.licenseId) {
      marker.licenseId = rec.licenseId;
      marker.updatedAtMs = now;
      this.store.putCheckoutSession(marker);
    }
    const current = this.licenses.get(rec.licenseId);
    if (!current) throw new Error(`pending checkout ${sessionId} has no license registry entry`);
    if (marker.newCustomer) {
      if (current.exp < marker.targetExpMs) this.licenses.setExpiry(rec.licenseId, marker.targetExpMs, now);
    } else {
      this.extendLicense(rec, marker.targetExpMs, cfg, now);
    }
    this.noteCharge(rec, `cs:${sessionId}`);
    if (marker.paidAtMs && marker.softwarePaid !== false) this.noteFirstActualPayment(rec, marker.paidAtMs);
    if (planByKey(cfg, marker.planKey)?.lifetime && marker.livemode && marker.paidAtMs) rec.lifetimeAccess = true;
    if (!rec.subscriptionId) rec.periodEndMs = marker.targetExpMs;
    this.noteCharge(rec, marker.paymentIntentId ?? "");
    this.touch(rec, ev, now);
    this.store.putCustomer(rec);
    marker.status = "applied";
    marker.updatedAtMs = now;
    this.store.putCheckoutSession(marker);
    this.store.clearPendingCheckout(customerKey, sessionId);
    await this.sendWelcomeIfNeeded(rec, cfg, now);
  }

  private async onSubscriptionCheckout(ev: StripeEvent, cfg: BillingConfig, f: ReturnType<typeof checkoutFacts>): Promise<ApplyResult> {
    const now = this.now();
    const planKey = this.planKeyOf(f.metadata, cfg);
    const grant = launchGrant(this.dataDir, f.metadata, ev.livemode, f.sessionId);
    const bootstrapExp = Math.max(now + cfg.policy.bootstrapDays * DAY_MS, grant?.firstPaymentAtMs ?? 0);
    const { rec, created } = this.ensureCustomer({ customerId: f.customerId, email: f.email, name: f.name, subscriptionId: f.subscriptionId, livemode: ev.livemode, planKey, metadata: f.metadata, starterPackCandidateAtMs: starterPackGrantAt(grant, ev, true) }, cfg, bootstrapExp, now);
    if (grant?.firstPaymentAtMs) this.extendLicense(rec, grant.firstPaymentAtMs, cfg, now);
    let note = created ? `licence issued${planKey ? ` (${planKey})` : ""}` : "customer known";
    rec.subscriptionStatus = grant ? 'active' : rec.subscriptionStatus ?? "active";
    if (grant?.hosting) { const discount = checkoutDiscountPercent(ev.object); if (discount !== null) rec.discountPercent = discount; }
    if (f.paymentStatus === 'paid' && (!grant?.hosting || Number(ev.object.amount_total) > 0)) this.noteFirstActualPayment(rec, ev.createdMs);
    this.noteCharge(rec, f.sessionId ? `cs:${f.sessionId}` : "");
    this.noteCharge(rec, f.paymentIntentId);
    this.touch(rec, ev, now);
    this.store.putCustomer(rec);
    note += await this.sendWelcomeIfNeeded(rec, cfg, now);
    return { outcome: "applied", note };
  }

  private paymentTarget(rec: CustomerRecord, currentExp: number, oneOffDays: number, cfg: BillingConfig, now: number): number {
    const current = this.licenses.get(rec.licenseId);
    if (!current) throw new Error(`customer ${rec.key} has no license registry entry`);
    const raw = Math.max(currentExp, now) + oneOffDays * DAY_MS;
    return Math.min(this.capExp(rec, raw, cfg), current.iat + MAX_LICENSE_DAYS * DAY_MS);
  }

  private assertAppliedCheckout(marker: CheckoutSessionRecord): void {
    if (!marker.licenseId) throw new Error(`applied checkout session ${marker.sessionId} has no license`);
    const rec = this.store.getCustomer(marker.customerKey) ?? this.store.findByLicense(marker.licenseId);
    const issued = this.licenses.get(marker.licenseId) ||
      (this.licenses.isRevoked(marker.licenseId) && this.licenses.isKnown(marker.licenseId));
    if (!rec || rec.key !== marker.customerKey || !this.store.customerLicenseMatches(rec, marker.licenseId) || !issued) {
      throw new Error(`applied checkout session ${marker.sessionId} has inconsistent durable state`);
    }
  }

  private async withCheckoutLocks<T = ApplyResult>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)].sort();
    const turns: Array<{ key: string; turn: Promise<void>; release: () => void; prior: Promise<void> }> = [];
    for (const key of unique) {
      const prior = this.checkoutLocks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const turn = new Promise<void>((resolve) => { release = resolve; });
      this.checkoutLocks.set(key, turn);
      turns.push({ key, turn, release, prior });
    }
    await Promise.all(turns.map((entry) => entry.prior));
    try { return await fn(); }
    finally {
      for (const entry of turns.reverse()) {
        entry.release();
        if (this.checkoutLocks.get(entry.key) === entry.turn) this.checkoutLocks.delete(entry.key);
      }
    }
  }

  private async onInvoicePaid(ev: StripeEvent, cfg: BillingConfig): Promise<ApplyResult> {
    const f = invoiceFacts(ev.object);
    if (!f.paid) return { outcome: "ignored", note: "invoice not paid" };
    if (f.metadata.wh_launch_intent && !f.customerId) throw Error('Launch invoice is missing its Stripe customer');
    if (!f.customerId && !f.email) return { outcome: "ignored", note: "invoice carried neither a customer nor an email" };
    const now = this.now();
    const paidThrough = this.paidThroughOf(f.periodEndMs, cfg);
    const planKey = this.planKeyOf(f.metadata, cfg);
    const launchInvoice = f.metadata.wh_launch_intent ? launchGrant(this.dataDir, f.metadata, ev.livemode) : null;
    if (f.metadata.wh_launch_intent && !launchInvoice?.sessionId) throw Error('Launch checkout awaits session reconciliation');
    const current = this.findCustomer(f.customerId, f.email, ev.livemode, !f.metadata.wh_launch_intent);
    if ((current?.launchManaged || f.metadata.wh_launch_intent) && current?.subscriptionId && f.subscriptionId && current.subscriptionId !== f.subscriptionId) {
      return { outcome: 'unclassified', note: 'Paid invoice belongs to a different subscription on this customer; reconcile both charges in Stripe' };
    }
    const { rec, created } = this.ensureCustomer({ customerId: f.customerId, email: f.email, name: f.name, subscriptionId: f.subscriptionId, livemode: ev.livemode, planKey, metadata: f.metadata, starterPackCandidateAtMs: f.billingReason === 'subscription_create' ? starterPackGrantAt(launchInvoice, ev, true) : null }, cfg, paidThrough ?? now + cfg.policy.bootstrapDays * DAY_MS, now);
    let note = created ? "licence issued" : "customer known";
    const term = this.applyPaidInvoiceTerm(rec, ev.object, cfg, ev.createdMs, !!launchInvoice?.hosting);
    if (term.licenseTargetMs !== null) {
      if (this.extendLicense(rec, term.licenseTargetMs, cfg, now)) note += `; licence extended to ${new Date(this.licenseExp(rec) ?? term.licenseTargetMs).toISOString().slice(0, 10)}`;
    } else {
      note += "; invoice had no period end";
    }
    this.touch(rec, ev, now);
    this.store.putCustomer(rec);
    note += await this.sendWelcomeIfNeeded(rec, cfg, now);
    return { outcome: "applied", note };
  }

  private onInvoiceFailed(ev: StripeEvent): ApplyResult {
    const f = invoiceFacts(ev.object);
    const rec = this.findCustomer(f.customerId, f.email, ev.livemode);
    if (!rec) return { outcome: "ignored", note: "customer not known" };
    if (rec.launchManaged && rec.subscriptionId && f.subscriptionId && rec.subscriptionId !== f.subscriptionId) return { outcome: 'ignored', note: 'failure belongs to an older subscription' };
    rec.subscriptionStatus = "past_due";
    this.touch(rec, ev, this.now());
    this.store.putCustomer(rec);
    return { outcome: "applied", note: "marked past due; the licence keeps its paid-through date plus grace" };
  }

  private onSubscriptionUpdated(ev: StripeEvent, cfg: BillingConfig): ApplyResult {
    const f = subscriptionFacts(ev.object);
    const rec = this.findCustomer(f.customerId, "", ev.livemode);
    if (!rec) return { outcome: "ignored", note: "customer not known" };
    if (rec.launchManaged && rec.subscriptionId && f.subscriptionId && rec.subscriptionId !== f.subscriptionId) return { outcome: 'ignored', note: 'update belongs to an older subscription' };
    const now = this.now();
    rec.subscriptionId = f.subscriptionId || rec.subscriptionId;
    rec.cancelAtPeriodEnd = f.cancelAtPeriodEnd;
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
    const rec = this.findCustomer(f.customerId, "", ev.livemode);
    if (!rec) return { outcome: "ignored", note: "customer not known" };
    if (rec.launchManaged && rec.subscriptionId && f.subscriptionId && rec.subscriptionId !== f.subscriptionId) return { outcome: 'ignored', note: 'cancellation belongs to an older subscription' };
    rec.subscriptionStatus = "canceled";
    this.touch(rec, ev, this.now());
    this.store.putCustomer(rec);
    return { outcome: "applied", note: "subscription ended; licence runs to its paid-through date plus grace, then exit-only" };
  }

  private onChargeSucceeded(ev: StripeEvent): ApplyResult {
    const f = chargeFacts(ev.object);
    const rec = this.findCustomer(f.customerId, f.email, ev.livemode);
    if (!rec) return { outcome: "ignored", note: "customer not known yet (checkout/invoice will attribute later charges)" };
    this.noteCharge(rec, f.chargeId);
    this.noteCharge(rec, f.paymentIntentId);
    this.touch(rec, ev, this.now());
    this.store.putCustomer(rec);
    return { outcome: "applied", note: "charge recorded" };
  }

  private onRefund(ev: StripeEvent, cfg: BillingConfig): ApplyResult {
    const f = chargeFacts(ev.object);
    const rec = this.findCustomer(f.customerId, f.email, ev.livemode) ?? this.store.findByCharge(f.chargeId) ?? this.store.findByCharge(f.paymentIntentId);
    if (!rec || rec.livemode !== ev.livemode) return { outcome: "ignored", note: "customer not known — revoke by hand if needed" };
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
    if (!rec || rec.livemode !== ev.livemode) return { outcome: "ignored", note: `dispute on unknown charge ${f.chargeId || f.paymentIntentId || "?"} — revoke by hand if needed` };
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

  private findCustomer(customerId: string, email: string, livemode: boolean, allowEmail = true): CustomerRecord | null {
    const direct = customerId ? this.store.getCustomer(customerId) ?? this.store.findByStripeCustomer(customerId, livemode) : null;
    if (direct && direct.livemode === livemode) return direct;
    if (!allowEmail || !email) return null;
    const byEmail = this.store.findByEmail(email, livemode);
    // An email entered at Checkout is not proof that two distinct Stripe
    // customers own the same installation. Only adopt a legacy email-keyed
    // row that has not yet acquired a Stripe customer identity.
    return byEmail && (!customerId || !byEmail.stripeCustomerId || byEmail.stripeCustomerId === customerId) ? byEmail : null;
  }

  private noteFirstActualPayment(rec: CustomerRecord, paidAtMs: number): void {
    if (!Number.isSafeInteger(paidAtMs) || paidAtMs <= 0) return;
    if (!rec.firstActualPaymentAtMs || paidAtMs < rec.firstActualPaymentAtMs) rec.firstActualPaymentAtMs = paidAtMs;
  }

  /** Older paid Lifetime checkouts predate the explicit entitlement flag. An
   * applied session marker proves the exact purchase when present. For rows
   * from before that marker existed, the paid Checkout and payment-intent
   * indexes must both survive; a plan label by itself is never a grant. */
  private hasLegacyPaidLifetimeEvidence(rec: CustomerRecord): boolean {
    if (!rec.livemode || rec.planKey !== 'lifetime' || rec.refunded || rec.disputed) return false;
    const sessions = rec.chargeIds.filter(id => /^cs:cs_[A-Za-z0-9_]+$/.test(id));
    let foundDurableMarker = false;
    for (const indexed of sessions) {
      let marker: CheckoutSessionRecord | null;
      try { marker = this.store.getCheckoutSession(indexed.slice(3)); }
      catch { return false; } // corrupt evidence cannot grant or break check-in
      if (!marker) continue;
      foundDurableMarker = true;
      if (marker.status === 'applied' && marker.customerKey === rec.key && this.store.customerLicenseMatches(rec, marker.licenseId) &&
        marker.planKey === 'lifetime' && marker.livemode === true &&
        (Number.isSafeInteger(marker.paidAtMs) && marker.paidAtMs! > 0 || /^pi_[A-Za-z0-9_]+$/.test(marker.paymentIntentId ?? ''))) return true;
    }
    // Old rows can retain a canceled subscription id from a prior Monthly or
    // Yearly plan. A still-active subscription makes the pre-marker indexes
    // ambiguous; only an exact durable Lifetime marker can resolve that case.
    const priorSubscriptionEnded = !rec.subscriptionId || rec.subscriptionStatus === 'canceled';
    return !foundDurableMarker && priorSubscriptionEnded && sessions.length > 0 && rec.chargeIds.some(id => /^pi_[A-Za-z0-9_]+$/.test(id));
  }

  private ensureLifetimeAccess(rec: CustomerRecord, current: ReturnType<LicenseStore['get']>): boolean {
    if (rec.lifetimeAccess === true) return true;
    if (!current || !this.hasLegacyPaidLifetimeEvidence(rec)) return false;
    rec.lifetimeAccess = true;
    this.store.putCustomer(rec);
    return true;
  }

  /** The customer's record, minting a licence if this is the first time the
   *  Hub hears of them. The record is written BEFORE the caller's handler
   *  continues, so a crash later cannot orphan the freshly issued licence. */
  private ensureCustomer(facts: CustomerFacts, cfg: BillingConfig, initialExp: number, now: number): { rec: CustomerRecord; created: boolean } {
    const grant = launchGrant(this.dataDir, facts.metadata ?? {}, facts.livemode);
    const direct = facts.customerId ? this.store.getCustomer(facts.customerId) ?? this.store.findByStripeCustomer(facts.customerId) : null;
    if (grant?.licenseId && direct && !this.store.customerLicenseMatches(direct, grant.licenseId)) throw Error('Stripe customer is already bound to another license');
    const existing = (grant?.licenseId ? this.store.findByLicense(grant.licenseId) : null)
      ?? this.findCustomer(facts.customerId, facts.email, facts.livemode, !grant);
    if (existing) {
      if(this.recoveryPending(existing.key))throw Error("Customer recovery must complete before checkout mutation");
      if (existing.livemode !== facts.livemode) throw Error('Checkout license is already bound in another Stripe mode');
      if (grant?.licenseId && !this.store.customerLicenseMatches(existing, grant.licenseId)) throw Error('Checkout conflicts with an existing billing license');
      if (facts.customerId && existing.stripeCustomerId && existing.stripeCustomerId !== facts.customerId) throw Error('Checkout conflicts with an existing Stripe customer');
      if (facts.email && !existing.email) existing.email = facts.email;
      if (facts.name && (!existing.name || existing.name === existing.email)) existing.name = facts.name;
      if (facts.customerId && !existing.stripeCustomerId) existing.stripeCustomerId = facts.customerId;
      if ((existing.launchManaged || grant) && facts.subscriptionId && existing.subscriptionId && existing.subscriptionId !== facts.subscriptionId && existing.subscriptionStatus !== 'canceled') {
        throw Error('A different active subscription is already bound to this license');
      }
      if (facts.subscriptionId) existing.subscriptionId = facts.subscriptionId;
      if (facts.planKey) existing.planKey = facts.planKey;
      if (grant) { existing.launchManaged = true; existing.firstPaymentAtMs = grant.firstPaymentAtMs; existing.discountPercent = grant.discountPercent; existing.nonRenewing = grant.payment === 'crypto' || grant.plan === 'lifetime'; }
      return { rec: existing, created: false };
    }
    const key = facts.customerId || `email:${facts.email}`;
    if (this.store.getCustomer(key)) throw Error("Customer identity conflicts across Stripe modes");
    const name = facts.name || facts.email || "Customer";
    const plan = [cfg.policy.plan, facts.planKey, facts.livemode ? null : "test"].filter(Boolean).join("-");
    const exp = this.capExp({ livemode: facts.livemode, createdAtMs: now }, initialExp, cfg);
    const bound = grant?.licenseId ? this.licenses.get(grant.licenseId) : null;
    if (grant?.licenseId && (!bound || this.licenses.isRevoked(grant.licenseId) || this.store.findByLicense(grant.licenseId))) throw Error('Checkout license is unavailable or already bound');
    const issuedId = bound?.id ?? this.licenses.issueUntil(name, exp, plan, now).payload.id;
    if (bound && exp > bound.exp) this.licenses.setExpiry(bound.id, Math.min(exp, bound.iat + MAX_LICENSE_DAYS * DAY_MS), now);
    const rec: CustomerRecord = {
      key,
      stripeCustomerId: facts.customerId,
      email: facts.email,
      name,
      livemode: facts.livemode,
      licenseId: issuedId,
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
      ...(grant ? { launchManaged: true, firstPaymentAtMs: grant.firstPaymentAtMs, discountPercent: grant.discountPercent, nonRenewing: grant.payment === 'crypto' || grant.plan === 'lifetime' } : {}),
      ...(grant && facts.starterPackCandidateAtMs ? { starterPackGrantedAtMs: facts.starterPackCandidateAtMs } : {}),
    };
    this.store.putCustomer(rec);
    this.log(`[billing] ${bound ? 'bound' : 'issued'} ${plan} licence ${issuedId} for ${facts.email || key} until ${new Date(exp).toISOString().slice(0, 10)}`);
    return { rec, created: true };
  }

  /** Move the registry expiry FORWARD to `target` (capped for test licences
   *  and by the format's 3650-day bound). Returns whether anything changed.
   *  A revoked licence is never extended. */
  private extendLicense(rec: CustomerRecord, target: number, cfg: BillingConfig, now: number): boolean {
    const next = this.extendedLicenseExp(rec, target, cfg);
    if (next === null) return false;
    this.licenses.setExpiry(rec.licenseId, next, now);
    return true;
  }

  /** The expiry `extendLicense` would write for `target`, or null when it
   *  would write nothing (unknown/revoked licence, or the capped target is
   *  not later than the current expiry). Pure, so a dry run evaluates the
   *  exact forward-only rule without touching the registry. */
  private extendedLicenseExp(rec: CustomerRecord, target: number, cfg: BillingConfig): number | null {
    const current = this.licenses.get(rec.licenseId);
    if (!current) return null;
    const capped = Math.min(this.capExp(rec, target, cfg), current.iat + MAX_LICENSE_DAYS * DAY_MS);
    return capped > current.exp ? capped : null;
  }

  /** A paid period end plus the policy's grace: what the licence is owed. */
  private paidThroughOf(periodEndMs: number | null, cfg: BillingConfig): number | null {
    return periodEndMs !== null ? periodEndMs + cfg.policy.graceDays * DAY_MS : null;
  }

  /** THE paid term one paid invoice proves for the software record — the
   *  single definition shared by the webhook (`onInvoicePaid`, which the
   *  bundle path also reaches with its software projection) and the
   *  operator's `reconcileSubscriptionFromStripe`. It moves `periodEndMs`
   *  forward to the invoice's latest line period end, marks the
   *  subscription active, takes a hosted launch's software discount from the
   *  (projected) invoice, records the first actual payment (the earliest
   *  positive payment's `paid_at`, falling back to `fallbackPaidAtMs`) and
   *  indexes the charge ids. It mutates `rec` only; the licence target
   *  (period end + `graceDays`) is returned for the caller to commit through
   *  the forward-only `extendLicense`, so a dry run can evaluate the very
   *  same rules without writing. `keepCancellationMarker` (operator path
   *  only) leaves an existing "active (cancels at period end)" status as it
   *  is: the reconcile never touches a cancellation. */
  private applyPaidInvoiceTerm(rec: CustomerRecord, invoice: Record<string, unknown>, cfg: BillingConfig, fallbackPaidAtMs: number, hostedLaunch: boolean, keepCancellationMarker = false): { periodEndMs: number | null; licenseTargetMs: number | null } {
    const f = invoiceFacts(invoice);
    const licenseTargetMs = this.paidThroughOf(f.periodEndMs, cfg);
    if (f.periodEndMs !== null && (rec.periodEndMs === null || f.periodEndMs > rec.periodEndMs)) rec.periodEndMs = f.periodEndMs;
    if (!(keepCancellationMarker && rec.subscriptionStatus === "active (cancels at period end)")) rec.subscriptionStatus = "active";
    if (hostedLaunch) { const discount = checkoutDiscountPercent(invoice); if (discount !== null) rec.discountPercent = discount; }
    const amountPaid = invoice.amount_paid;
    if (typeof amountPaid === 'number' && Number.isSafeInteger(amountPaid) && amountPaid > 0) {
      const transitions = invoice.status_transitions as Record<string, unknown> | undefined;
      const paidAt = transitions?.paid_at;
      this.noteFirstActualPayment(rec, typeof paidAt === 'number' && Number.isSafeInteger(paidAt) && paidAt > 0 ? paidAt * 1000 : fallbackPaidAtMs);
    }
    this.noteCharge(rec, f.chargeId);
    this.noteCharge(rec, f.paymentIntentId);
    return { periodEndMs: f.periodEndMs, licenseTargetMs };
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
    rec.lastEventId = ev.id;
    rec.lastEventAtMs = now;
    rec.updatedAtMs = now;
  }

  // ── the welcome email ─────────────────────────────────────────────────────

  /** Send once. Failure is recorded on the customer and never thrown: the
   *  payment already happened, and the admin page can resend. Returns a
   *  fragment for the event note. */
  private async sendWelcomeIfNeeded(rec: CustomerRecord, cfg: BillingConfig, now: number, force = false): Promise<string> {
    this.ensureLifetimeAccess(rec, this.licenses.get(rec.licenseId));
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
      lifetime: rec.lifetimeAccess === true,
      firstPaymentAtMs: rec.firstActualPaymentAtMs ? null : rec.firstPaymentAtMs,
      siteOrigin: cfg.siteOrigin,
      livemode: rec.livemode,
      starterPack: starterPackEligible(rec),
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
    if(this.recoveryPending(customerKey))return {ok:false,status:409,error:"Server recovery needs completion before a new welcome link can be sent"};
    const rec = this.store.getCustomer(customerKey);
    if (!rec) return { ok: false, status: 404, error: "unknown customer" };
    const note = await this.sendWelcomeIfNeeded(rec, this.config(), this.now(), true);
    if (rec.welcomeError) return { ok: false, status: 502, error: rec.welcomeError };
    void note;
    return { ok: true, sentTo: rec.email };
  }

  async recoverDestroyedInstall(customerKey: string, expectedEmail: string, options: DeviceRecoveryOptions): Promise<
    { ok: true; sentTo: string; licenseId: string; previousLicenseId: string; expiresAtMs: number; cachedOldGraceUntilMs: number; alreadyCompleted?: true }
    | { ok: false; status: number; error: string }> {
    if (this.installReissues.has(customerKey)) return {ok:false,status:409,error:"A recovery or reissue is already in progress"};
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(options.operationId) || !options.confirmedDestroyedInstall || !options.acknowledgeCachedGrace)
      return {ok:false,status:400,error:"Explicit destroyed-server authorization and cached offline-grace acknowledgement are required"};
    const rec=this.store.getCustomer(customerKey),now=this.now(),cfg=this.config();
    if(!rec || normalizeInstallEmail(rec.email)!==normalizeInstallEmail(expectedEmail) || !rec.livemode || rec.refunded || rec.disputed)
      return {ok:false,status:409,error:"Confirmed active live billing customer required"};

    const file=recoveryPath(this.dataDir,options.operationId);
    let op: InstallRecoveryRecord | null;
    try { op=recoveryRecords(this.dataDir).find(r=>r.operationId===options.operationId)??null; }
    catch { return {ok:false,status:409,error:"Recovery journal needs support review; no new recovery started"}; }
    if(op && (op.customerKey!==rec.key || op.oldLicense.id!==options.expectedLicenseId || op.activationId!==options.expectedActivationId
      || op.activationRevision!==options.expectedActivationRevision || op.auditRevision!==options.expectedAuditRevision))return {ok:false,status:409,error:"Recovery operation identity changed"};
    if(op?.phase==="sent" && (rec.licenseId!==op.newLicenseId || !this.licenses.isRevoked(op.oldLicense.id) || !this.licenses.get(op.newLicenseId) || this.licenses.get(op.newLicenseId)!.exp<=now))return {ok:false,status:409,error:"Completed recovery identity needs review"};
    if(op?.phase==="sent")return {ok:true,sentTo:rec.email,licenseId:op.newLicenseId,previousLicenseId:op.oldLicense.id,expiresAtMs:op.installExpiresAtMs!,cachedOldGraceUntilMs:op.cachedGraceUntilMs,alreadyCompleted:true};
    if(op && ["email-prepared","email-failed"].includes(op.phase))return {ok:false,status:409,error:"Review the recovery email audit; use same-licence reissue if a replacement email is needed"};
    if(!emailReady(cfg.email))return {ok:false,status:503,error:"Email provider unavailable; recovery not started"};
    this.installReissues.add(customerKey);
    let raw="";
    try {
      if(!op){
        if(this.checkoutLocks.has(rec.key))throw Error("Customer checkout is still in progress");
        const old=this.licenses.get(rec.licenseId),key=old&&this.licenses.tokenFor(old.id);
        if(rec.licenseId!==options.expectedLicenseId || !old || !key || !this.licenses.verify(key,now).ok)throw Error("Current licence identity changed or is inactive");
        if(recoveryRecords(this.dataDir).some(r=>r.customerKey===rec.key && !["committed","email-prepared","email-failed","sent"].includes(r.phase)))throw Error("An earlier recovery needs completion");
        const pending=this.store.getPendingCheckout(rec.key);
        if(pending && this.store.getCheckoutSession(pending)?.status!=="applied")throw Error("Pending checkout must be settled before device recovery");
        if(!this.recoveryDeps.recoveryHostingActive || this.recoveryDeps.recoveryHostingActive(rec))throw Error("Active hosting must be reviewed before device recovery");
        const facts=this.recoveryDeps.deviceRecoverySnapshot?.(old.id);
        if(!facts || facts.locked || facts.auditRevision!==options.expectedAuditRevision || facts.active.length!==1)throw Error("Current single-machine lease audit required");
        const active=facts.active[0];
        if(active.id!==options.expectedActivationId || active.revision!==options.expectedActivationRevision || !Number.isSafeInteger(active.cachedGraceUntilMs))throw Error("Current machine revision and signed grace required");
        // Do not rewrite immutable launch/payment grants. An unsettled launch
        // claim is a separate purchase and must finish before reassociation.
        const claimFile=path.join(this.dataDir,"billing-launch-claims.v1","live",createHash("sha256").update(old.id).digest("hex")+".json");
        const claim=readJson<{id:string}|null>(claimFile,null);
        if(claim){if(!/^[A-Za-z0-9_-]{1,128}$/.test(claim.id))throw Error("Launch claim identity needs review");const intent=readJson<{sessionId?:string;expiredAtMs?:number;reservationReleasedAtMs?:number}|null>(path.join(this.dataDir,"billing-launch-intents.v1",claim.id+".json"),null);
          if(!intent || !(intent.sessionId && rec.chargeIds.includes("cs:"+intent.sessionId)) && !(intent.expiredAtMs!==undefined && intent.reservationReleasedAtMs!==undefined))throw Error("Unsettled launch checkout must be reviewed");}
        this.ensureLifetimeAccess(rec,old);
        op={v:1,operationId:options.operationId,customerKey:rec.key,newLicenseId:randomUUID(),oldCustomer:{...rec},oldLicense:{...old},atMs:now,
          activationId:active.id,activationRevision:active.revision,auditRevision:facts.auditRevision,cachedGraceUntilMs:active.cachedGraceUntilMs,featureOverrides:{...(this.recoveryFlags().byLicense[old.id]??{})},phase:"prepared"};
        writeJsonAtomic(file,op);this.recoveryDeps.recoveryCheckpoint?.("prepared");
      }
      const old=op.oldLicense;
      if(rec.licenseId!==old.id && rec.licenseId!==op.newLicenseId)throw Error("Customer licence moved outside this recovery");
      const expected={...op.oldCustomer,licenseId:rec.licenseId};
      if(JSON.stringify(rec)!==JSON.stringify(expected))throw Error("Customer entitlement changed during interrupted recovery; review before resuming");
      if(!this.licenses.isRevoked(old.id)){
        const currentOld=this.licenses.get(old.id);
        if(!currentOld || JSON.stringify(currentOld)!==JSON.stringify(old))throw Error("Old licence entitlement changed before retirement");
        if(JSON.stringify(this.recoveryFlags().byLicense[old.id]??{})!==JSON.stringify(op.featureOverrides))throw Error("Old feature authorization changed before retirement");
      } else if(["prepared","issued"].includes(op.phase))throw Error("Old licence was retired outside this recovery");
      if(!this.recoveryDeps.checkRecoveryActivation)throw Error("Current machine retirement check unavailable");
      this.recoveryDeps.checkRecoveryActivation(old.id,op.activationId,op.activationRevision,"Destroyed-server recovery "+op.operationId);
      const existing=this.licenses.get(op.newLicenseId);
      if(existing){if(existing.name!==old.name||existing.exp!==old.exp||existing.plan!==old.plan||existing.iat!==op.atMs)throw Error("Reserved replacement licence differs");}
      else this.licenses.issueUntil(old.name,old.exp,old.plan,op.atMs,op.newLicenseId);
      if(op.phase==="prepared"){op.phase="issued";writeJsonAtomic(file,op);this.recoveryDeps.recoveryCheckpoint?.("issued");}
      if(op.phase==="issued"){op.phase="retiring";writeJsonAtomic(file,op);this.recoveryDeps.recoveryCheckpoint?.("retiring");}
      if(!this.licenses.isRevoked(old.id))this.licenses.revoke(old.id,new Date(op.atMs));
      if(!this.recoveryDeps.retireRecoveryActivation)throw Error("Audited machine retirement unavailable");
      this.recoveryDeps.retireRecoveryActivation(old.id,op.activationId,op.activationRevision,"Destroyed-server recovery "+op.operationId);
      if(op.phase==="retiring"){op.phase="retired";writeJsonAtomic(file,op);this.recoveryDeps.recoveryCheckpoint?.("retired");}
      const flags=this.recoveryFlags();flags.byLicense[op.newLicenseId]={...op.featureOverrides};writeJsonAtomic(path.join(this.dataDir,"flags.json"),flags);
      this.store.revokeTokens(rec.key,"all",op.atMs);
      if(rec.licenseId!==op.newLicenseId){rec.licenseId=op.newLicenseId;this.store.putCustomer(rec);this.recoveryDeps.recoveryCheckpoint?.("linked");}
      op.phase="committed";writeJsonAtomic(file,op);this.recoveryDeps.recoveryCheckpoint?.("committed");
      const issuedAt=this.now();
      raw=this.store.mint("install",op.newLicenseId,rec.key,issuedAt,{reusable:true});
      op.installExpiresAtMs=issuedAt+INSTALL_TOKEN_TTL_MS;
      op.phase="email-prepared";writeJsonAtomic(file,op);
      const msg=reissuedInstallEmail(rec.email,{name:rec.name,installUrl:`${this.origin}/install/${raw}`,expiresAtMs:op.installExpiresAtMs,issue:"device-recovery",replacementLicenseToken:this.licenses.tokenFor(op.newLicenseId)!,dashboardUrl:`${this.origin}/customer`});
      const result=await sendEmail(cfg.email,msg,this.fetchLike);
      if(!result.ok){this.store.revokeInstall(raw,this.now());op.phase="email-failed";writeJsonAtomic(file,op);return {ok:false,status:502,error:"Recovery committed, but email failed; new link revoked. Review before a same-licence reissue."};}
      op.providerMessageId=result.id;op.emailSentAtMs=this.now();writeJsonAtomic(file,op);
      this.store.appendEvent({id:"device-recovery:"+op.operationId,type:"admin.install.device-recovery",livemode:true,receivedAtMs:this.now(),outcome:"applied",
        note:JSON.stringify({customerKey:rec.key,previousLicenseId:old.id,licenseId:op.newLicenseId,cachedOldGraceUntilMs:op.cachedGraceUntilMs,oldServerDestroyedConfirmed:true,providerMessageId:result.id,installExpiresAtMs:op.installExpiresAtMs})});
      op.phase="sent";writeJsonAtomic(file,op);
      return {ok:true,sentTo:rec.email,licenseId:op.newLicenseId,previousLicenseId:old.id,expiresAtMs:op.installExpiresAtMs,cachedOldGraceUntilMs:op.cachedGraceUntilMs};
    } catch {return {ok:false,status:409,error:"Device recovery stopped. Inspect the durable recovery journal before resuming; no completion is claimed."};}
    finally{this.installReissues.delete(customerKey);}
  }

  private recoveryFlags(): ReturnType<typeof readFlags> {
    const raw=readJson<unknown>(path.join(this.dataDir,"flags.json"),{default:{},byLicense:{}});
    const object=(v:unknown):v is Record<string,unknown> => !!v && typeof v==="object" && !Array.isArray(v);
    if(!object(raw) || Object.keys(raw).some(k=>k!=="default"&&k!=="byLicense") || !object(raw.default) || !object(raw.byLicense)
      || Object.values(raw.default).some(v=>typeof v!=="boolean") || Object.entries(raw.byLicense).some(([k,v])=>["__proto__","constructor","prototype"].includes(k) || !object(v) || Object.values(v).some(x=>typeof x!=="boolean")))throw Error("Saved feature overrides need review");
    return readFlags(this.dataDir);
  }

  private recoveryPending(customerKey: string): boolean {
    return recoveryRecords(this.dataDir).some(r=>r.customerKey===customerKey && ["prepared","issued","retiring","retired"].includes(r.phase));
  }

  installRecovery(customerKey: string): { revision: string; binding: InstallBindingState } {
    const rec = this.store.getCustomer(customerKey);
    return { revision: this.store.installRevision(customerKey), binding: rec ? this.installBindingState(rec.licenseId) : "unavailable" };
  }

  /** All explicit regeneration uses this synchronous admission and mutation.
   * The email lock remains held across provider awaits, so dashboard clicks
   * cannot revoke a command while its delivery is in flight. */
  regenerateInstall(customerKey: string, expectedEmail: string, options: InstallRegenerationOptions):
    { ok: true; raw: string; command: string; expiresAtMs: number; revoked: number; revision: string; binding: InstallBindingState }
    | { ok: false; status: number; error: string } {
    if (this.installReissues.has(customerKey)) return { ok: false, status: 409, error: "an install reissue is already in progress for this customer" };
    if(recoveryRecords(this.dataDir).some(r=>r.customerKey===customerKey && ["prepared","issued","retiring","retired"].includes(r.phase)))return {ok:false,status:409,error:"Server recovery needs completion before another command can be issued"};
    const rec = this.store.getCustomer(customerKey), now = this.now();
    const lic = rec && this.licenses.get(rec.licenseId), key = lic && this.licenses.tokenFor(lic.id);
    if (!rec || normalizeInstallEmail(rec.email) !== normalizeInstallEmail(expectedEmail)) return { ok: false, status: 404, error: "unknown customer" };
    if (!rec.livemode || rec.refunded || rec.disputed || !lic || lic.exp <= now || !key || !this.licenses.verify(key, now).ok)
      return { ok: false, status: 403, error: "an active live customer licence without a refund or dispute is required" };
    if (options.deviceReplacement) return { ok: false, status: 409, error: "Device replacement requires verified support recovery; regenerating a command does not revoke or transfer an active machine." };
    if (options.confirmed !== true || options.expectedRevision !== this.store.installRevision(rec.key))
      return { ok: false, status: 409, error: "Confirm regeneration from the current dashboard; reload if another command was issued." };
    const binding = this.installBindingState(rec.licenseId);
    if (binding !== "unbound" && options.acknowledgeMachineBinding !== true)
      return { ok: false, status: 409, error: "Confirm that the existing machine binding is preserved. Lost machine keys need support recovery before trading." };
    const { revoked, raw } = this.store.rotateInstall(lic.id, rec.key, options.expectedRevision, now);
    const expiresAtMs = now + INSTALL_TOKEN_TTL_MS;
    this.store.appendEvent({ id: `customer-install-regeneration:${rec.key}:${now}`, type: "customer.install.regenerate", livemode: true,
      receivedAtMs: now, outcome: "applied", note: JSON.stringify({ customerKey: rec.key, licenseId: lic.id, revoked, expiresAtMs, binding, deviceTransferred: false }) });
    return { ok: true, raw, command: safeInstallCommand(`${this.origin}/install/${raw}`), expiresAtMs, revoked,
      revision: this.store.installRevision(rec.key), binding };
  }

  /** Admin-only support action. Never mutates the licence, seat or customer
   * account, and sends only to the stored verified billing email. */
  async reissueInstall(customerKey: string, expectedEmail: string, issue: "bybit-us-ip" | "reinstall" = "bybit-us-ip", options?: InstallRegenerationOptions): Promise<
    { ok: true; sentTo: string; expiresAtMs: number; revoked: { page: number; install: number } }
    | { ok: false; status: number; error: string }
  > {
    if (this.installReissues.has(customerKey)) return { ok: false, status: 409, error: "an install reissue is already in progress for this customer" };
    if(this.recoveryPending(customerKey))return {ok:false,status:409,error:"Server recovery needs completion before another command can be issued"};
    const rec = this.store.getCustomer(customerKey);
    if (!rec) return { ok: false, status: 404, error: "unknown customer" };
    const now = this.now();
    const lic = this.licenses.get(rec.licenseId);
    const key = lic && this.licenses.tokenFor(lic.id);
    if (!rec.livemode || rec.refunded || rec.disputed || !lic || lic.exp <= now || !key || !this.licenses.verify(key, now).ok) {
      return { ok: false, status: 409, error: "an active live customer licence without a refund or dispute is required" };
    }
    if (!rec.email.includes("@") || /[\r\n]/.test(rec.email) || expectedEmail.trim().toLowerCase() !== rec.email.trim().toLowerCase()) {
      return { ok: false, status: 409, error: "the confirmed email must match the stored billing customer" };
    }
    const cfg = this.config();
    if (!emailReady(cfg.email)) return { ok: false, status: 503, error: "email provider is not configured; existing links were not changed" };
    this.installReissues.add(customerKey);
    let raw = "";
    try {
      let revoked: { page: number; install: number };
      if (issue === "reinstall") {
        // Admission/mutation has no await; lock is restored before delivery.
        this.installReissues.delete(customerKey);
        const prepared = this.regenerateInstall(customerKey, expectedEmail, options ?? { confirmed: false, expectedRevision: "" });
        this.installReissues.add(customerKey);
        if (!prepared.ok) return prepared;
        raw = prepared.raw;
        revoked = { page: 0, install: prepared.revoked };
      } else revoked = { page: this.store.revokeTokens(rec.key, "page", now), install: this.store.revokeTokens(rec.key, "install", now) };
      if (!raw) raw = this.store.mint("install", lic.id, rec.key, now, { reusable: true });
      const expiresAtMs = now + INSTALL_TOKEN_TTL_MS;
      const audit = (stage: "prepared" | "sent" | "failed") => this.store.appendEvent({
        id: `admin-install-reissue:${rec.key}:${now}:${stage}`, type: "admin.install.reissue", livemode: true,
        receivedAtMs: this.now(), outcome: stage === "failed" ? "error" : "applied",
        note: JSON.stringify({ actor: "admin", customerKey: rec.key, licenseId: lic.id, stage, revoked, reusable: true, expiresAtMs, issue }),
      });
      audit("prepared");
      const result = await sendEmail(cfg.email, reissuedInstallEmail(rec.email, { name: rec.name, installUrl: `${this.origin}/install/${raw}`, expiresAtMs, issue }), this.fetchLike);
      if (!result.ok) {
        this.store.revokeInstall(raw, this.now());
        audit("failed");
        // Provider bodies can reflect the submitted message. Never return or
        // log that body, which contains the private opaque link.
        return { ok: false, status: 502, error: "install email delivery failed; the newly issued link was revoked" };
      }
      audit("sent");
      return { ok: true, sentTo: rec.email, expiresAtMs, revoked };
    } catch {
      if (raw) this.store.revokeInstall(raw, this.now());
      return { ok: false, status: 500, error: "install reissue failed; review the billing audit before retrying" };
    } finally { this.installReissues.delete(customerKey); }
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
    if(rec && recoveryRecords(this.dataDir).some(r=>r.customerKey===rec.key && ["prepared","issued","retiring","retired"].includes(r.phase)))return {ok:false,status:409,text:"Server recovery is pending; contact support."};
    if (rec) {
      this.ensureLifetimeAccess(rec, this.licenses.get(rec.licenseId));
      this.refreshLifetimeLicense(rec.licenseId);
    }
    const lic = this.licenses.list().find((l) => l.id === t.licenseId);
    if (!rec || !lic) return { ok: false, status: 404, text: "This licence is no longer on file. Please contact support." };
    if (this.installReissues.has(rec.key)) return { ok: false, status: 409, text: "An install command is being emailed. Wait for delivery before requesting another command." };
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
      expiresOn: rec.lifetimeAccess ? 'Lifetime access' : new Date(lic.exp).toISOString().slice(0, 10),
      renewalLine: rec.subscriptionId
        ? (rec.subscriptionStatus?.startsWith("canceled") ? "Subscription cancelled — no further charges" : "Extends automatically when your subscription renews")
        : rec.lifetimeAccess ? "No recurring charge · technical licence renewal is automatic" : "One-time purchase",
      email: rec.email || "—",
      installCommand: canInstall ? `curl -q -fsSL "${this.origin}/install/${installToken}" | sudo bash` : "",
      noticeTitle: notice?.title ?? "",
      noticeText: notice?.text ?? "",
      noticeClass: notice?.cls ?? "",
      portalAction: `${this.origin}/welcome/${rawPageToken}/portal`,
      siteOrigin: cfg.siteOrigin,
      supportEmail,
      recoverySupportUrl: `${this.origin}/support#message=${encodeURIComponent(`I reset or replaced my server and lost its installation key. Email: ${rec.email}. Account: ${rec.key}`)}`,
    };
    const starterPack = starterPackEligible(rec) && !lic.revoked ? loadStarterPack(this.templatesDir) : null;
    if (starterPack) {
      vars.starterPackBundle = starterPack.bundle;
      vars.starterPackLiquidation = starterPack.liquidation;
      vars.starterPackHedge = starterPack.hedge;
      vars.starterPackLiquidationSummary = starterPack.summary.liquidation;
      vars.starterPackHedgeSummary = starterPack.summary.hedge;
    }
    const flags: Record<string, boolean> = {
      canInstall,
      notice: notice !== null,
      portal,
      site: !!cfg.siteOrigin,
      support: !!supportEmail && supportEmail.includes("@"),
      starterPack: starterPack !== null,
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
    if(this.recoveryPending(r.rec.customerKey))return {ok:false,status:409,text:"Server recovery needs completion before installation; contact support"};
    if (r.rec.reusable === true) {
      const customer = this.store.getCustomer(r.rec.customerKey);
      if (!customer || !customer.livemode || customer.refunded || customer.disputed || customer.licenseId !== r.rec.licenseId) {
        return { ok: false, status: 403, text: "this customer install command is no longer authorized — contact support" };
      }
    }
    const lic = this.licenses.get(r.rec.licenseId);
    if (!lic) return { ok: false, status: 403, text: "this licence has been revoked — contact support" };
    if (lic.exp <= this.now()) return { ok: false, status: 403, text: "this licence has lapsed — renew it from your install page first" };
    const token = this.licenses.tokenFor(lic.id);
    if (!token) return { ok: false, status: 403, text: "this licence is not on file — contact support" };
    return { ok: true, licenseToken: token };
  }

  /** The Stripe API call itself, shared by every caller that ends up opening
   *  a Customer Portal session for one customer record: `portalRedirect`
   *  below (a page token, redirected to) and `portalSession` (a token-proved
   *  licence, answered as JSON — v0.4.16). Returns the session url or null —
   *  NEVER throws; a refusal or a network failure is logged and the caller
   *  decides what to fall back to, exactly as this did inline before it had
   *  a second call site.
   *
   *  PORTAL SCOPING (H1, checked, not built): both callers below open a
   *  session with only `customer` set — no `configuration` parameter — which
   *  means Stripe's DEFAULT Customer Portal configuration decides what the
   *  session shows. By default that is EVERY subscription on the customer,
   *  so once a hosting subscription exists on the same Stripe customer as a
   *  software one, a software-context portal session (opened from the
   *  software install page, `rec` here is always a `CustomerRecord` — i.e.
   *  always the software side, since there is no hosting-facing portal entry
   *  point in this Hub yet) would let that customer manage/cancel hosting
   *  from a page whose own copy never mentions it, and vice versa once a
   *  hosting portal entry point is built. Stripe's own fix for this is a
   *  SEPARATE Portal Configuration per product (restricted via its own
   *  `products` list) referenced by a `configuration` id on the session
   *  request — not built here because there is no hosting portal caller yet
   *  to scope (H2, out of scope for H1) and no product's Portal Configuration
   *  to reference until an operator creates one in Stripe. Any future
   *  hosting-facing portal call site MUST pass its own role's Portal
   *  Configuration id rather than reusing this call unscoped. */
  private async stripePortalSessionUrl(rec: CustomerRecord, m: StripeModeConfig, returnUrl: string): Promise<string | null> {
    if (!m.secretKey || !rec.stripeCustomerId) return null;
    try {
      const body = new URLSearchParams({ customer: rec.stripeCustomerId, return_url: returnUrl }).toString();
      const res = await this.fetchLike(STRIPE_PORTAL_SESSIONS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${m.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const text = await res.text();
      if (res.ok) {
        const url = (JSON.parse(text) as { url?: unknown }).url;
        if (typeof url === "string" && url.startsWith("https://")) return url;
      }
      this.log(`[billing] portal session refused (${res.status}): ${text.slice(0, 200)}`);
    } catch (err) {
      this.log(`[billing] portal session failed: ${(err as Error).message}`);
    }
    return null;
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
    const url = await this.stripePortalSessionUrl(rec, m, `${this.origin}/welcome/${rawPageToken}`);
    if (url) return { ok: true, url };
    if (m.portalUrl) return { ok: true, url: m.portalUrl };
    return { ok: false, status: 404, error: "billing management is not configured — email support" };
  }

  /** The customer-session dashboard's counterpart to `portalRedirect` (H2):
   *  the CALLER (`src/customer-sessions.ts`) has already proved ownership —
   *  a signed-in session whose identity email matches the record's email —
   *  so this skips the page-token lookup and opens the session directly off
   *  the customer key. Kept in this class rather than reimplemented there
   *  because the Stripe call itself (`stripePortalSessionUrl`) and its "no
   *  secret key -> static login link -> nothing" fallback order must stay
   *  the ONE place that decides it; see that method's docstring for the
   *  still-unscoped-by-product portal caveat, which applies here exactly as
   *  it does to every other caller. */
  async portalRedirectForCustomer(customerKey: string, returnUrl: string): Promise<PortalResult> {
    const rec = this.store.getCustomer(customerKey);
    if (!rec) return { ok: false, status: 404, error: "unknown customer" };
    const cfg = this.config();
    const m = cfg.stripe[rec.livemode ? "live" : "test"];
    const url = await this.stripePortalSessionUrl(rec, m, returnUrl);
    if (url) return { ok: true, url };
    if (m.portalUrl) return { ok: true, url: m.portalUrl };
    return { ok: false, status: 404, error: "billing management is not configured — email support" };
  }

  /** POST /api/billing/portal-session (v0.4.16) — the token-proved
   *  counterpart to `portalRedirect`'s page-token flow, for a running bot's
   *  own Settings page (liqhunter-private's `POST /api/license/portal`
   *  already calls this exact shape — `{licenseId, token}` — and falls back
   *  to `GET /billing` on a 404 or an unreadable reply; see that repo's
   *  `licensePortalFallback`).
   *
   *  Verified EXACTLY as the check-in handler verifies a licence token
   *  (`decodeGenuine`, the same public-key check, then the registry's own
   *  revocation truth): a bare licence id may NEVER open a portal — the id is
   *  not a secret, the token is (README, "Licence extension at check-in"). A
   *  token that does not verify, or verifies but names a different id, or
   *  names a genuinely revoked licence, is answered 401 in every case — an
   *  unauthenticated caller must never learn WHICH of those it hit, or which
   *  licence ids exist at all.
   *
   *  The token's own EXPIRY is deliberately not checked (same reasoning as
   *  `decodeGenuine`'s docstring): a lapsed subscriber must still be able to
   *  reach the portal to pay again, and only a REVOKED licence — the
   *  enforcement mechanism that acts on a running bot — is refused. */
  async portalSession(licenseId: string, token: string): Promise<PortalResult> {
    const presented = this.licenses.decodeGenuine(token);
    if (!presented || presented.id !== licenseId) {
      return { ok: false, status: 401, error: "this licence token is not valid" };
    }
    if (this.licenses.isRevoked(licenseId) || !this.licenses.isKnown(licenseId)) {
      return { ok: false, status: 401, error: "this licence has been revoked" };
    }
    const rec = this.store.findByLicense(licenseId);
    if (!rec) return { ok: false, status: 404, error: "no billing customer is on file for this licence" };
    const cfg = this.config();
    const m = cfg.stripe[rec.livemode ? "live" : "test"];
    if (!m.secretKey && !m.portalUrl) return { ok: false, status: 503, error: "billing is not configured on this Hub" };
    const returnUrl = cfg.siteOrigin || this.origin;
    const url = await this.stripePortalSessionUrl(rec, m, returnUrl);
    if (url) return { ok: true, url };
    if (m.portalUrl) return { ok: true, url: m.portalUrl };
    return { ok: false, status: 503, error: "billing management is temporarily unavailable — try again shortly" };
  }

  /** The check-in reply's optional `subscription` field (v0.4.16) — read by
   *  liqhunter-private's `recordSubscriptionInfo` / `SubscriptionInfo`
   *  (`src/license.ts`), which is what fixes this shape: `plan`/`status`
   *  strings, `currentPeriodEndMs: number | null`, `portalAvailable: boolean`.
   *  `null` for a licence with no bound Stripe customer — the free-through-
   *  beta case and every pre-Stripe tester — so an app clears a stale
   *  subscription card the moment a licence stops having one (a licence is
   *  revoked, its customer deleted by hand, etc.); an ABSENT `subscription`
   *  key (an older hub) is what leaves the app's cache untouched instead,
   *  exactly as an absent `flags` key does.
   *
   *  Sent for a revoked or otherwise unrecognised licence too, for the same
   *  reason `flags` and `latest` are: this is a truthful answer about what
   *  the Hub knows, not a grant of anything. */
  subscriptionInfoFor(licenseId: string): { plan: string; status: string; currentPeriodEndMs: number | null; portalAvailable: boolean; firstPaymentAtMs: number | null; firstActualPaymentAtMs: number | null; discountPercent: number; nonRenewing: boolean; cancelAtPeriodEnd: boolean } | null {
    const rec = this.store.findByLicense(licenseId);
    if (!rec) return null;
    this.ensureLifetimeAccess(rec, this.licenses.get(licenseId));
    const cfg = this.config();
    const m = cfg.stripe[rec.livemode ? "live" : "test"];
    return {
      plan: rec.planKey ?? cfg.policy.plan,
      status: rec.subscriptionStatus ?? "none",
      currentPeriodEndMs: rec.lifetimeAccess ? null : rec.periodEndMs,
      portalAvailable: Boolean(m.secretKey || m.portalUrl),
      firstPaymentAtMs: rec.firstPaymentAtMs ?? null,
      firstActualPaymentAtMs: rec.firstActualPaymentAtMs ?? null,
      discountPercent: rec.discountPercent ?? 0,
      nonRenewing: rec.nonRenewing ?? (!rec.subscriptionId && rec.planKey === 'lifetime'),
      cancelAtPeriodEnd: rec.cancelAtPeriodEnd ?? false,
    };
  }

  /** Lifetime is a purchase entitlement, not an unbounded token format.
   * Renew only near technical expiry, never for test/refunded/disputed or
   * revoked licenses. Check-in already proves token possession and the seat. */
  refreshLifetimeLicense(licenseId: string): void {
    const rec = this.store.findByLicense(licenseId), current = this.licenses.get(licenseId);
    if(rec && this.recoveryPending(rec.key))return;
    if (!rec || !current || !this.ensureLifetimeAccess(rec, current) || !rec.livemode || rec.refunded || rec.disputed) return;
    if (current.exp - this.now() > 365 * DAY_MS) return;
    this.licenses.renewLifetimeToken(licenseId, this.now());
  }

  // ── operator: reconcile one subscription's paid term from Stripe ──────────
  //
  // 2026-10-10: customers whose initial paid invoice the Hub discarded
  // (0.4.90, "older bundle lifecycle event ignored"; those event ids are
  // seen, so neither a resend nor 0.4.91's admission reaches them) kept a
  // bootstrap-only record — `periodEndMs: null`, `lastEventType`
  // `checkout.session.*` — even where an operator had already repaired the
  // licence expiry by hand. This reads the subscription and its latest paid
  // invoice from Stripe through the same client the rest of billing uses
  // (`EarnStripeApi` over `launchFetch`) and applies that invoice's paid term
  // through `applyPaidInvoiceTerm`, the function the `invoice.paid` webhook
  // uses, with the bundle's software projection exactly as the webhook
  // projects it. It writes the customer record and (forward only) the
  // licence registry, and one `admin.billing.reconcile-subscription` row in
  // the billing audit ledger. It never touches Stripe (read-only GETs), the
  // cancellation flag, the hosting role record or lifecycle, holds, or email.
  // A dry run is the default and writes nothing.

  /** Resolve a customer key to its subscription; a customer without one
   *  (Lifetime, one-time, complimentary) is a clear `NO_SUBSCRIPTION`. */
  async reconcileCustomerFromStripe(customerKey: string, opts: ReconcileOptions = {}): Promise<SubscriptionReconcileResult> {
    const dryRun = opts.dryRun !== false;
    const rec = customerKey ? this.store.getCustomer(customerKey) : null;
    if (!rec) return this.reconcileOutcome({ dryRun, customerKey: customerKey || null }, "UNKNOWN_SUBSCRIPTION", "no billing customer has this key");
    if (!rec.subscriptionId) {
      return this.reconcileOutcome({ dryRun, customerKey: rec.key, licenseId: rec.licenseId, mode: rec.livemode ? "live" : "test" }, "NO_SUBSCRIPTION",
        `no Stripe subscription is bound to this customer (${rec.lifetimeAccess ? "Lifetime" : rec.planKey ?? "unplanned"}); there is no paid term to reconcile — skipped`);
    }
    return this.reconcileSubscriptionFromStripe(rec.subscriptionId, opts);
  }

  async reconcileSubscriptionFromStripe(subscriptionId: string, opts: ReconcileOptions = {}): Promise<SubscriptionReconcileResult> {
    const dryRun = opts.dryRun !== false;
    const by = typeof opts.by === "string" ? opts.by.trim().slice(0, 80) : "";
    const reason = typeof opts.reason === "string" ? opts.reason.trim().slice(0, 500) : "";
    const base = { dryRun, subscriptionId: typeof subscriptionId === "string" && subscriptionId ? subscriptionId : null };
    if (typeof subscriptionId !== "string" || !/^sub_[A-Za-z0-9_]{1,200}$/.test(subscriptionId)) return this.reconcileOutcome(base, "INVALID_REQUEST", "expected a Stripe subscription id (sub_…)");
    if (!dryRun && (!by || !reason)) return this.reconcileOutcome(base, "INVALID_REQUEST", "an apply needs {by, reason}; a dry run (the default) needs neither");
    const rec = this.store.findBySubscription(subscriptionId);
    if (!rec) return this.reconcileOutcome(base, "UNKNOWN_SUBSCRIPTION", "no software customer record carries this subscription");
    const mode: BillingMode = rec.livemode ? "live" : "test";
    const hostingRole = this.store.findRoleSubscriptionBySubscription("hosting", subscriptionId);
    let ctx: Partial<SubscriptionReconcileResult> & { dryRun: boolean } = { ...base, customerKey: rec.key, licenseId: rec.licenseId, mode,
      hosting: hostingRole ? { status: hostingRole.subscriptionStatus, periodEndMs: hostingRole.periodEndMs } : null };
    const cfg = this.config();
    const secretKey = cfg.stripe[mode].secretKey;
    if (!secretKey) return this.reconcileOutcome(ctx, "STRIPE_UNAVAILABLE", `no ${mode} Stripe secret key is saved on this Hub; nothing was read or written`);

    // ── Stripe (read-only) ──
    const api = new EarnStripeApi(secretKey, this.launchFetch);
    let rawSub: Record<string, any>, rawSubs: Record<string, any> | null, rawInvoices: Record<string, any>;
    try {
      rawSub = await api.call("GET", `/v1/subscriptions/${subscriptionId}`);
      rawSubs = rec.stripeCustomerId ? await api.call("GET", "/v1/subscriptions", { customer: rec.stripeCustomerId, status: "all", limit: 20 }) : null;
      rawInvoices = await api.call("GET", "/v1/invoices", { subscription: subscriptionId, limit: 24 });
    } catch (err) {
      return this.reconcileOutcome(ctx, "STRIPE_READ_FAILED", `Stripe read failed (${(err as Error).message}); nothing was written`);
    }
    const sf = subscriptionFacts(rawSub);
    const listed = Array.isArray(rawSubs?.data) ? rawSubs!.data as Record<string, any>[] : null;
    const invoices = Array.isArray(rawInvoices?.data) ? (rawInvoices.data as Record<string, any>[]).slice().sort((a, b) => (Number(b?.created) || 0) - (Number(a?.created) || 0)) : null;
    const latest = invoices?.find((i) => i?.status !== "void" && i?.status !== "deleted") ?? null;
    const paid = invoices?.find((i) => i?.status === "paid" && Number.isSafeInteger(i?.amount_paid) && i.amount_paid > 0) ?? null;
    const paidPeriod = paid ? linePeriod(paid) : null;
    const stripe: NonNullable<SubscriptionReconcileResult["stripe"]> = {
      status: sf.status, cancelAtPeriodEnd: sf.cancelAtPeriodEnd, currentPeriodEndMs: sf.currentPeriodEndMs,
      activeSubscriptionCount: listed ? listed.filter((s) => !["canceled", "incomplete_expired"].includes(String(s?.status))).length : null,
      latestInvoice: latest ? { id: String(latest.id ?? ""), status: String(latest.status ?? ""), billingReason: String(latest.billing_reason ?? "") } : null,
      paidInvoice: paid ? { id: String(paid.id ?? ""), billingReason: String(paid.billing_reason ?? ""), amountPaid: paid.amount_paid, currency: String(paid.currency ?? ""),
        periodStartMs: paidPeriod!.startMs, periodEndMs: paidPeriod!.endMs, paidAtMs: paidAtOf(paid) } : null,
    };
    ctx = { ...ctx, stripe };
    if (sf.subscriptionId !== subscriptionId || !rec.stripeCustomerId || sf.customerId !== rec.stripeCustomerId || (typeof rawSub.livemode === "boolean" && rawSub.livemode !== rec.livemode)) {
      return this.reconcileOutcome(ctx, "IDENTITY_MISMATCH", `Stripe's subscription (customer ${sf.customerId || "?"}) does not match this record (customer ${rec.stripeCustomerId || "?"}, ${mode})`);
    }
    if (!listed || !invoices) return this.reconcileOutcome(ctx, "STRIPE_READ_FAILED", "Stripe's subscription or invoice list was unreadable; nothing was written");

    // ── refusals, each by name; nothing below writes until every one passed ──
    if (sf.status !== "active" && sf.status !== "trialing") return this.reconcileOutcome(ctx, "SUBSCRIPTION_NOT_ACTIVE", `Stripe reports this subscription as ${sf.status || "unknown"}, not active or trialing; no paid term is applied`);
    if (this.licenses.isRevoked(rec.licenseId)) return this.reconcileOutcome(ctx, "LICENSE_REVOKED", `licence ${rec.licenseId} is revoked; a reconcile never restores a revoked licence`);
    if (!this.licenses.get(rec.licenseId)) return this.reconcileOutcome(ctx, "IDENTITY_MISMATCH", `licence ${rec.licenseId} is not in the registry`);
    if (rec.refunded || rec.disputed || hostingRole?.refunded || hostingRole?.disputed) {
      return this.reconcileOutcome(ctx, "REFUNDED_OR_DISPUTED", `a charge on this subscription was ${rec.disputed || hostingRole?.disputed ? "disputed" : "refunded"}; support review first`);
    }
    if (this.recoveryPending(rec.key)) return this.reconcileOutcome(ctx, "RECOVERY_PENDING", "a device recovery for this customer is still in progress");
    const bound = this.store.getBundleSubscription(subscriptionId);
    if (rec.lifetimeAccess || bound?.planKey === "lifetime") return this.reconcileOutcome(ctx, "LIFETIME_NOT_A_TERM", "Lifetime software is a one-time purchase; its subscription bills hosting only and carries no software term");
    if ((stripe.activeSubscriptionCount ?? 0) > 1 || rawSubs!.has_more === true) {
      return this.reconcileOutcome(ctx, "MULTIPLE_ACTIVE_SUBSCRIPTIONS", `Stripe customer ${rec.stripeCustomerId} has ${stripe.activeSubscriptionCount}${rawSubs!.has_more ? "+" : ""} subscriptions that have not ended; reconcile by hand`);
    }
    if (latest && latest.status !== "paid") return this.reconcileOutcome(ctx, "LATEST_INVOICE_UNSETTLED", `the latest invoice ${latest.id} is ${latest.status} (${latest.billing_reason ?? "?"}), not paid`);
    if (!paid) {
      if (rawInvoices.has_more === true) return this.reconcileOutcome(ctx, "INVOICE_HISTORY_INCOMPLETE", "no positive paid invoice among the newest 24; reconcile by hand");
      return this.reconcileOutcome(ctx, "NO_PAID_INVOICE_YET", `no paid invoice yet: Stripe has no invoice with a positive amount paid for this subscription${sf.currentPeriodEndMs !== null ? ` (current period ends ${new Date(sf.currentPeriodEndMs).toISOString()})` : ""}; the first paid invoice applies itself through the webhook`);
    }
    const pf = invoiceFacts(paid);
    if (pf.subscriptionId !== subscriptionId || pf.customerId !== rec.stripeCustomerId) {
      return this.reconcileOutcome(ctx, "IDENTITY_MISMATCH", `invoice ${paid.id} names subscription ${pf.subscriptionId || "?"} / customer ${pf.customerId || "?"}`);
    }
    // The webhook's projection: a v2 mixed subscription's invoice reaches the
    // software term as its software lines only (`applyBundleEvent`).
    let grant: LaunchIntent | null = null;
    let termInvoice: Record<string, unknown> = paid;
    try {
      if (bound?.launchIntentId) {
        grant = launchGrant(this.dataDir, { wh_launch_intent: bound.launchIntentId, plan: bound.planKey }, rec.livemode);
        if (!grant?.hosting || !grant.sessionId || bound.customerId !== rec.stripeCustomerId) throw Error("mixed subscription lacks its durable software/VPS proof");
        const proof = grant.hosting;
        const lines = Array.isArray(paid.lines?.data) ? paid.lines.data as Record<string, any>[] : [];
        if (lines.some((l) => ![proof.softwarePriceId, proof.hostingPriceId].includes(componentPriceId(l)))) throw Error("invoice lines differ from the mixed subscription's approved prices");
      } else if (pf.metadata.wh_launch_intent) {
        grant = launchGrant(this.dataDir, pf.metadata, rec.livemode);
        if (!grant?.sessionId) throw Error("launch checkout awaits session reconciliation");
      }
    } catch (err) {
      return this.reconcileOutcome(ctx, "IDENTITY_MISMATCH", (err as Error).message);
    }
    try {
      if (grant?.hosting) termInvoice = softwareInvoiceProjection(paid, grant.hosting);
    } catch (err) {
      return this.reconcileOutcome(ctx, "INVOICE_LINES_INCOMPLETE", (err as Error).message);
    }
    const term = linePeriod(termInvoice);
    if (term.endMs === null || (grant?.hosting && !(termInvoice.lines as any)?.data?.length)) return this.reconcileOutcome(ctx, "INVOICE_LINES_INCOMPLETE", `invoice ${paid.id} carries no software line with a period end`);
    const cpe = sf.currentPeriodEndMs;
    if (cpe === null || term.startMs === null || !(term.startMs < cpe && cpe <= term.endMs)) {
      return this.reconcileOutcome(ctx, "PERIOD_MISMATCH", `the paid invoice ${paid.id} covers ${iso(term.startMs)} → ${iso(term.endMs)}, which does not contain Stripe's current period end ${iso(cpe)}`);
    }

    // ── the paid term, evaluated by the shared function on a copy ──
    const lic = this.licenses.get(rec.licenseId)!;
    const draft: CustomerRecord = structuredClone(rec);
    const applied = this.applyPaidInvoiceTerm(draft, termInvoice, cfg, paidFallbackMs(paid), !!grant?.hosting, true);
    const nextExp = applied.licenseTargetMs !== null ? this.extendedLicenseExp(rec, applied.licenseTargetMs, cfg) : null;
    const grace = cfg.policy.graceDays * DAY_MS;
    const field = (before: number | string | null | undefined, after: number | string | null | undefined): ReconcileFieldChange =>
      ({ before: before ?? null, after: after ?? null, changed: (before ?? null) !== (after ?? null) });
    const termChanged = rec.periodEndMs === null || (applied.periodEndMs !== null && applied.periodEndMs > rec.periodEndMs);
    const changes = {
      periodEndMs: field(rec.periodEndMs, draft.periodEndMs),
      paidThroughMs: field(rec.periodEndMs !== null ? rec.periodEndMs + grace : null, draft.periodEndMs !== null ? draft.periodEndMs + grace : null),
      firstActualPaymentAtMs: field(rec.firstActualPaymentAtMs, draft.firstActualPaymentAtMs),
      licenseExp: field(lic.exp, nextExp ?? lic.exp),
      subscriptionStatus: field(rec.subscriptionStatus, draft.subscriptionStatus),
      discountPercent: field(rec.discountPercent, draft.discountPercent),
      lastEventType: field(rec.lastEventType, termChanged ? RECONCILE_EVENT_TYPE : rec.lastEventType),
    };
    ctx = { ...ctx, changes };
    // The paid term this invoice proves is already on the record: nothing to
    // apply, and nothing else is "tidied" (a first-payment instant a second
    // earlier, a status spelling) — a record that already carries its term
    // is never rewritten by this tool.
    if (!termChanged) {
      for (const k of Object.keys(changes) as (keyof typeof changes)[]) changes[k] = field(changes[k].before, changes[k].before);
      return this.reconcileOutcome(ctx, "NOTHING_TO_APPLY", `the paid term through ${iso(rec.periodEndMs)} is already recorded; nothing to apply`);
    }
    const summaryNote = `periodEnd ${iso(rec.periodEndMs)} → ${iso(draft.periodEndMs)}; licence exp ${changes.licenseExp.changed ? `${iso(lic.exp)} → ${iso(nextExp)}` : `${iso(lic.exp)} unchanged`}`;
    if (dryRun) return this.reconcileOutcome(ctx, "WOULD_APPLY", `dry run, nothing written: would apply invoice ${paid.id} — ${summaryNote}`, { changed: true });

    // ── apply: under the same locks the webhook's checkout/bundle paths take ──
    const commit = async (): Promise<SubscriptionReconcileResult> => {
      const fresh = this.store.getCustomer(rec.key);
      const freshLic = this.licenses.get(rec.licenseId);
      if (!fresh || JSON.stringify(fresh) !== JSON.stringify(rec) || !freshLic || freshLic.exp !== lic.exp) {
        return this.reconcileOutcome(ctx, "CONCURRENT_CHANGE", "the customer record or licence changed while Stripe was being read; nothing was written — run again");
      }
      const now = this.now();
      const t = this.applyPaidInvoiceTerm(fresh, termInvoice, cfg, paidFallbackMs(paid), !!grant?.hosting, true);
      if (t.licenseTargetMs !== null) this.extendLicense(fresh, t.licenseTargetMs, cfg, now);
      fresh.lastEventType = RECONCILE_EVENT_TYPE;
      fresh.lastEventId = `reconcile:${String(paid.id)}`;
      fresh.lastEventAtMs = now;
      fresh.updatedAtMs = now;
      this.store.putCustomer(fresh);
      const auditEventId = `admin-billing-reconcile:${subscriptionId}:${now}`;
      const before = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.before]));
      const after = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.after]));
      try {
        this.store.appendEvent({ id: auditEventId, type: RECONCILE_EVENT_TYPE, livemode: rec.livemode, receivedAtMs: now, outcome: "applied",
          note: JSON.stringify({ actor: "operator", by, reason, customerKey: rec.key, subscriptionId, licenseId: rec.licenseId,
            invoiceId: paid.id, billingReason: paid.billing_reason ?? null, amountPaid: paid.amount_paid, currency: paid.currency ?? null,
            stripeStatus: sf.status, currentPeriodEndMs: cpe, before, after }) });
      } catch (err) {
        this.log(`[billing] reconcile ${subscriptionId} APPLIED but its audit row could not be written: ${(err as Error).message}`);
        return this.reconcileOutcome(ctx, "APPLIED", `applied invoice ${paid.id} — ${summaryNote}; WARNING: the audit row could not be written`, { changed: true, wrote: true });
      }
      this.log(`[billing] reconcile ${subscriptionId} (${rec.key}) by ${by}: applied invoice ${paid.id} — ${summaryNote}; reason: ${reason}`);
      return this.reconcileOutcome(ctx, "APPLIED", `applied invoice ${paid.id} — ${summaryNote}`, { changed: true, wrote: true, auditEventId });
    };
    const locked = () => this.withCheckoutLocks([rec.key, rec.stripeCustomerId].filter((k): k is string => !!k), commit);
    return bound?.launchIntentId ? this.withBundleLock(bound.launchIntentId, locked) : locked();
  }

  private reconcileOutcome(ctx: Partial<SubscriptionReconcileResult> & { dryRun: boolean }, verdict: ReconcileVerdict, note: string, extra: { changed?: boolean; wrote?: boolean; auditEventId?: string } = {}): SubscriptionReconcileResult {
    return {
      verdict, needsReview: RECONCILE_REVIEW_VERDICTS.has(verdict), changed: extra.changed === true, wrote: extra.wrote === true, dryRun: ctx.dryRun, note,
      customerKey: ctx.customerKey ?? null, subscriptionId: ctx.subscriptionId ?? null, licenseId: ctx.licenseId ?? null, mode: ctx.mode ?? null,
      stripe: ctx.stripe ?? null, changes: ctx.changes ?? null, hosting: ctx.hosting ?? null,
      ...(extra.auditEventId ? { auditEventId: extra.auditEventId } : {}),
      ...(RECONCILE_ERROR_VERDICTS.has(verdict) ? { error: note } : {}),
    };
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
          installRecovery: this.installRecovery(c.key),
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

function normalizeInstallEmail(value: string): string { return value.trim().toLowerCase(); }

// ── reconcile helpers (Stripe invoice reading; pure) ─────────────────────────
const iso = (ms: number | null | undefined): string => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "null");
/** The service period an invoice's own lines cover: the earliest line
 *  `period.start` and the latest `period.end` (the same lines
 *  `invoiceFacts.periodEndMs` reads). Seconds on the wire, ms here. */
function linePeriod(invoice: Record<string, any>): { startMs: number | null; endMs: number | null } {
  let start: number | null = null, end: number | null = null;
  for (const line of Array.isArray(invoice?.lines?.data) ? invoice.lines.data : []) {
    const s = line?.period?.start, e = line?.period?.end;
    if (typeof s === "number" && Number.isFinite(s) && (start === null || s < start)) start = s;
    if (typeof e === "number" && Number.isFinite(e) && (end === null || e > end)) end = e;
  }
  return { startMs: start === null ? null : start * 1000, endMs: end === null ? null : end * 1000 };
}
function paidAtOf(invoice: Record<string, any>): number | null {
  const paidAt = invoice?.status_transitions?.paid_at;
  return typeof paidAt === "number" && Number.isSafeInteger(paidAt) && paidAt > 0 ? paidAt * 1000 : null;
}
/** `applyPaidInvoiceTerm`'s fallback when an invoice has no `paid_at`: the
 *  webhook passes its event's `created`; a read invoice has its own. */
function paidFallbackMs(invoice: Record<string, any>): number {
  const created = invoice?.created;
  return typeof created === "number" && Number.isSafeInteger(created) && created > 0 ? created * 1000 : 0;
}
