// src/hosting/service.ts
// Unleashed VPS Hosting: the whole lifecycle (H4/H5/H6), built on top of
// - src/hosting/store.ts     the durable transactional store
// - src/hosting/policy.ts    price/region/plan/probe configuration
// - src/hosting/provider.ts  the infrastructure adapter (Vultr / Fake)
// - src/hosting/deadlines.ts the pure suspend/delete-at arithmetic
// - src/hosting/readiness.ts the pure per-venue reachability verdict
// - src/hosting/emails.ts    the nine transactional templates
//
// THE CENTRAL DESIGN DECISION: this class never parses a raw Stripe event.
// src/billing/service.ts's dispatcher (roles.ts, H1) already classifies
// every webhook event and maintains ONE durable, already-correct record per
// (owner, "hosting") — `RoleSubscriptionRecord` in billing/store.ts:
// subscriptionId, subscriptionStatus, periodEndMs, disputed, refunded. That
// record is CORRECT and TESTED (tests/billing-roles.test.mjs) independently
// of anything in this file. So every hosting lifecycle transition here is
// DERIVED from that one record (`reconcileOwner`), never from a second
// reading of Stripe's wire format — which is also what makes "hosting
// refund never touches the software licence" true by construction: this
// class never opens `billing.store.customers()` for anything but a
// read-only eligibility check, and never writes to it.
//
// `BillingServiceDeps.onHostingEvent` fires this reconciliation promptly on
// every webhook; `tick()` (driven by main.ts on an interval, "periodic
// reconciliation independent of webhooks" — H7) walks every owner with a
// hosting relationship anyway, so a missed or out-of-order webhook self-
// heals on the next tick without ever double-creating or double-emailing
// anything (every transition here is idempotent: re-deriving the same
// target state from the same source record is a no-op against a row
// already in that state).
import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { BillingService } from "../billing/service.js";
import type { RoleSubscriptionRecord } from "../billing/store.js";
import type { EmailConfig } from "../billing/config.js";
import { sendEmail, type EmailFetch } from "../billing/email.js";
import type { LicenseStore } from "../license.js";
import { HostingStore, type HostingInstanceRow, type HostingOutboxRow, type HostingStage, type HostingDeletionHold } from "./store.js";
import { readHostingPolicy, readHostingSecrets, type HostingPolicy } from "./policy.js";
import { deadlines, type HostingDeadlines, type HostingEndReason } from "./deadlines.js";
import { readinessVerdict, type ProbeResult, type ReadinessVerdict } from "./readiness.js";
import { bootstrapPasswordFromTokenHash, hostingInstanceLabel, hashBootstrapToken, mintBootstrapToken, FakeProvider, VultrProvider, type HostingProvider } from "./provider.js";
import { buildBootstrapUserData } from "./bootstrap.js";
import * as tmpl from "./emails.js";

const HOUR = 60 * 60 * 1000;
const MAX_PROVISION_ATTEMPTS = 3;
const LEASE_TTL_MS = 2 * 60_000;
const PROVISION_RETRY_BACKOFF_MS = 30_000;

const realFetch: EmailFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

export interface HostingServiceDeps {
  now?: () => number;
  fetchLike?: EmailFetch;
  randomBytes?: (n: number) => Buffer;
  log?: (line: string) => void;
  /** Injectable so the suite never talks to a real provider — production
   *  passes undefined and gets `VultrProvider` once a key is configured, or
   *  a provider that refuses every call until one is. */
  provider?: HostingProvider;
  stripeTimeoutMs?: number;
}

export type HostingActionError =
  | "SOFTWARE_LICENSE_REQUIRED"
  | "HOSTING_ALREADY_EXISTS"
  | "REGION_UNAVAILABLE"
  | "PROVISIONING_DISABLED"
  | "NOT_FOUND"
  | "RESTORATION_UNAVAILABLE"
  | "NOT_CANCELLABLE"
  | "PROVIDER_STATUS_UNKNOWN";

export type HostingActionResult<T> = { ok: true; value: T } | { ok: false; code: HostingActionError; error: string };

/** What deriveStage reads off the billing role record — narrowed to what
 *  matters, so a test can drive it without constructing a full
 *  RoleSubscriptionRecord. */
interface BillingSignal {
  subscriptionStatus: string | null;
  periodEndMs: number | null;
  refunded: boolean;
  disputed: boolean;
}

export class HostingService {
  readonly store: HostingStore;
  private readonly now: () => number;
  private readonly fetchLike: EmailFetch;
  private readonly log: (line: string) => void;
  private readonly randomBytes: (n: number) => Buffer;
  private readonly injectedProvider: HostingProvider | undefined;
  private readonly stripeTimeoutMs: number;

  constructor(
    readonly dataDir: string,
    private readonly billing: BillingService,
    private readonly licenses: LicenseStore,
    readonly publicOrigin: string,
    deps: HostingServiceDeps = {},
  ) {
    this.store = new HostingStore(dataDir, deps.randomBytes);
    this.now = deps.now ?? Date.now;
    this.fetchLike = deps.fetchLike ?? realFetch;
    this.log = deps.log ?? ((line) => console.log(line));
    this.randomBytes = deps.randomBytes ?? nodeRandomBytes;
    this.injectedProvider = deps.provider;
    this.stripeTimeoutMs = deps.stripeTimeoutMs ?? 20_000;
  }

  policy(): HostingPolicy {
    return readHostingPolicy(this.dataDir);
  }

  private get origin(): string {
    return this.publicOrigin.replace(/\/+$/, "");
  }

  /** The real provider once a key is configured, `FakeProvider` when the
   *  injected test provider is supplied, or `null` when neither — the
   *  caller must then refuse any provider-touching action rather than
   *  guess. Re-read every call: an operator can paste a key without a
   *  restart. */
  private provider(): HostingProvider | null {
    if (this.injectedProvider) return this.injectedProvider;
    const secrets = readHostingSecrets(this.dataDir);
    if (!secrets.vultrApiKey) return null;
    return new VultrProvider(secrets.vultrApiKey, this.fetchLike as any);
  }

  // ── eligibility & checkout ───────────────────────────────────────────────

  /** "Requires an eligible Unleashed software license" (handoff §2/§3):
   *  a non-revoked licence, not lapsed, bound to a CustomerRecord under
   *  this exact owner key. Read-only over billing.store — never mutated
   *  from here (see file header). */
  softwareEligible(ownerId: string, nowMs = this.now()): boolean {
    const rec = this.billing.store.getCustomer(ownerId);
    if (!rec) return false;
    const lic = this.licenses.get(rec.licenseId);
    if (!lic || this.licenses.isRevoked(rec.licenseId)) return false;
    return lic.exp === undefined || lic.exp === null || lic.exp > nowMs;
  }

  hostingPlanKeys(): string[] {
    return this.billing.config().plans.filter((p) => p.role === "hosting").map((p) => p.key);
  }

  /** One source of truth for whether the advertised hosting checkout is safe
   * to expose. Price/currency/interval must match the actual Stripe plan, the
   * master switch must be on, and provider plus customer-bound Stripe
   * Checkout prerequisites must exist. */
  hostingOfferIssue(): string | null {
    const policy = this.policy();
    if (!policy.provisioningEnabled) return "managed hosting is not available for purchase yet";
    if (!this.provider()) return "managed hosting provisioning is not configured";
    const plans = this.billing.config().plans.filter((p) => p.role === "hosting");
    if (plans.length !== 1) return "managed hosting requires exactly one configured monthly plan";
    const plan = plans[0]!;
    if (plan.amountCents !== policy.monthlyPriceCents || plan.currency !== policy.currency || plan.interval !== "month" || plan.lifetime) {
      return "managed hosting price configuration does not match checkout";
    }
    const billing = this.billing.config();
    const stripe = billing.stripe[billing.mode];
    const role = billing.roles[billing.mode].hosting;
    if (!stripe.secretKey) return "managed hosting customer-bound checkout is not configured";
    if (!stripe.webhookSecret) return "managed hosting billing intake is not configured";
    if (role.priceIds.length !== 1) return "managed hosting requires exactly one classified Stripe price";
    return null;
  }

  /** Creates a customer-bound Stripe Checkout Session after independently
   * validating the configured Stripe price and the live provider quote. */
  async checkoutUrl(ownerId: string, email: string, nowMs = this.now()): Promise<HostingActionResult<{ url: string }>> {
    const cfg = this.billing.config();
    const mode = cfg.mode;
    const environment = mode;
    const offerIssue = this.hostingOfferIssue();
    if (offerIssue) return { ok: false, code: "PROVISIONING_DISABLED", error: offerIssue };
    if (!this.softwareEligible(ownerId, nowMs)) return { ok: false, code: "SOFTWARE_LICENSE_REQUIRED", error: "an eligible Unleashed software license is required before adding hosting" };
    if (!/^cus_[A-Za-z0-9_]+$/.test(ownerId)) return { ok: false, code: "SOFTWARE_LICENSE_REQUIRED", error: "hosting checkout requires the Stripe customer already bound to your software licence" };
    const stripe = cfg.stripe[mode];
    const existing = this.store.activeInstanceForOwner(ownerId, environment);
    if (existing) {
      if (existing.stage === "ordered" && existing.checkoutExpiresAtMs != null && nowMs < existing.checkoutExpiresAtMs && existing.checkoutIdempotencyKey && existing.checkoutRequestBody) {
        if (existing.checkoutUrl) return { ok: true, value: { url: existing.checkoutUrl } };
        return this.submitStripeCheckout(existing, stripe.secretKey, nowMs);
      }
      return { ok: false, code: "HOSTING_ALREADY_EXISTS", error: "you already have a hosting checkout or instance — manage it from this page" };
    }
    const planKey = this.hostingPlanKeys()[0];
    if (!planKey) return { ok: false, code: "PROVISIONING_DISABLED", error: "hosting is not yet configured for purchase on this Hub" };
    const policy = this.policy();
    const provider = this.provider();
    if (!provider) return { ok: false, code: "PROVISIONING_DISABLED", error: "managed hosting provisioning is not configured" };
    let quote: number;
    try {
      const match = (await provider.listPlans()).find((p) => p.id === policy.planId);
      if (!match) return { ok: false, code: "PROVISIONING_DISABLED", error: "the configured hosting plan is unavailable from the provider" };
      quote = match.monthlyCostCents;
      if (!Number.isSafeInteger(quote) || quote <= 0) return { ok: false, code: "PROVISIONING_DISABLED", error: "the configured hosting plan must have a verified positive provider cost" };
    } catch {
      return { ok: false, code: "PROVIDER_STATUS_UNKNOWN", error: "the provider price could not be verified" };
    }
    if (policy.monthlyPriceCents !== quote * 2) return { ok: false, code: "PROVISIONING_DISABLED", error: "managed hosting price must equal twice the verified provider cost" };
    const ceilingRefusal = this.costCeilingRefusalWithQuote(quote, policy);
    if (ceilingRefusal) return { ok: false, code: "PROVISIONING_DISABLED", error: ceilingRefusal };
    const priceId = cfg.roles[mode].hosting.priceIds[0]!;
    const checked = await this.verifyStripeHostingPrice(stripe.secretKey, priceId, policy);
    if (!checked.ok) return { ok: false, code: "PROVISIONING_DISABLED", error: checked.error };
    const finalCeilingRefusal = this.costCeilingRefusalWithQuote(quote, policy);
    if (finalCeilingRefusal) return { ok: false, code: "PROVISIONING_DISABLED", error: finalCeilingRefusal };
    const reservation = this.store.reserveInstance({
      id: this.store.newId("host"), ownerId, environment, region: policy.regions[0]?.id ?? "nrt",
      planId: policy.planId, stripeCustomerId: ownerId, nowMs,
    });
    if (!reservation) return { ok: false, code: "HOSTING_ALREADY_EXISTS", error: "you already have a hosting checkout or instance" };
    const expiresAtMs = nowMs + 31 * 60_000;
    const idempotencyKey = `wh-hosting-${hashBootstrapToken(`${mode}:${reservation.id}`).slice(0, 40)}`;
    const body = new URLSearchParams({
      mode: "subscription", customer: ownerId, client_reference_id: ownerId,
      "line_items[0][price]": priceId, "line_items[0][quantity]": "1",
      success_url: `${this.origin}/customer?hosting=checkout-success#hosting`,
      cancel_url: `${this.origin}/customer?hosting=checkout-cancelled#hosting`,
      "metadata[plan]": planKey, "metadata[role]": "hosting", "metadata[owner]": ownerId,
      "subscription_data[metadata][plan]": planKey, "subscription_data[metadata][role]": "hosting",
      expires_at: String(Math.floor(expiresAtMs / 1000)),
    }).toString();
    const held = this.store.updateInstance(reservation.id, reservation.version, (d) => {
      d.providerPlanMonthlyCostCents = quote;
      d.checkoutExpiresAtMs = expiresAtMs;
      d.checkoutIdempotencyKey = idempotencyKey;
      d.checkoutRequestBody = body;
    }, nowMs);
    if (!held) return { ok: false, code: "PROVISIONING_DISABLED", error: "checkout reservation could not be saved" };
    return this.submitStripeCheckout(held, stripe.secretKey, nowMs);
  }

  private async submitStripeCheckout(reservation: HostingInstanceRow, secretKey: string, nowMs: number): Promise<HostingActionResult<{ url: string }>> {
    try {
      const response = await this.stripeFetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST", headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": reservation.checkoutIdempotencyKey! }, body: reservation.checkoutRequestBody!,
      });
      const parsed = JSON.parse(await response.text()) as Record<string, unknown>;
      if (!response.ok) {
        if ([400, 401, 403, 404].includes(response.status)) {
          const current = this.store.getInstance(reservation.id);
          if (current?.stage === "ordered" && !current.stripeSubscriptionId) this.store.updateInstance(current.id, current.version, (d) => { d.stage = "deleted"; d.checkoutExpiresAtMs = null; }, nowMs);
          return { ok: false, code: "PROVISIONING_DISABLED", error: `Stripe refused the hosting checkout (HTTP ${response.status})` };
        }
        throw new Error(`Stripe returned uncertain HTTP ${response.status}`);
      }
      if (typeof parsed.url !== "string" || !parsed.url.startsWith("https://checkout.stripe.com/")) throw new Error("Stripe returned no checkout URL");
      const current = this.store.getInstance(reservation.id);
      if (current?.stage === "ordered") this.store.updateInstance(current.id, current.version, (d) => { d.checkoutUrl = parsed.url as string; }, nowMs);
      return { ok: true, value: { url: parsed.url } };
    } catch (err) {
      this.log(`[hosting] customer-bound checkout uncertain for ${reservation.ownerId}: ${(err as Error).message}; reservation retained for idempotent retry`);
      return { ok: false, code: "PROVIDER_STATUS_UNKNOWN", error: "managed hosting checkout is still being confirmed; retry from this dashboard" };
    }
  }

  private async verifyStripeHostingPrice(secretKey: string, priceId: string, policy: HostingPolicy): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const response = await this.stripeFetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, { method: "GET", headers: { authorization: `Bearer ${secretKey}` }, body: undefined });
      const p = JSON.parse(await response.text()) as any;
      if (!response.ok || p.id !== priceId || p.active !== true || p.unit_amount !== policy.monthlyPriceCents || p.currency !== policy.currency || p.type !== "recurring" || p.recurring?.interval !== "month" || p.recurring?.interval_count !== 1) {
        return { ok: false, error: "the classified Stripe hosting price does not match the advertised monthly price" };
      }
      return { ok: true };
    } catch { return { ok: false, error: "the classified Stripe hosting price could not be verified" }; }
  }

  // ── the derive-from-billing-record reconciliation (the whole engine) ────

  /** Walk every owner with a hosting relationship: every
   *  RoleSubscriptionRecord("hosting") AND every existing hosting instance
   *  (so an owner whose role record was somehow lost still gets its
   *  instance's own time-driven jobs drained). Safe to call as often as
   *  wanted; every step is idempotent. */
  reconcileAll(nowMs = this.now()): void {
    for (const row of this.store.instances()) {
      if (row.stage === "ordered" && row.checkoutExpiresAtMs != null && nowMs >= row.checkoutExpiresAtMs && !row.stripeSubscriptionId) {
        this.store.updateInstance(row.id, row.version, (d) => { d.stage = "deleted"; d.checkoutExpiresAtMs = null; }, nowMs);
      }
    }
    const owners = new Set<string>();
    for (const rec of Object.values(this.billing.store.roleSubscriptions())) if (rec.role === "hosting") owners.add(rec.customerKey);
    for (const row of this.store.instances()) owners.add(row.ownerId);
    for (const ownerId of owners) {
      try { this.reconcileOwner(ownerId, nowMs); }
      catch (err) { this.log(`[hosting] reconcile ${ownerId} failed: ${(err as Error).message}`); }
    }
  }

  /** The per-owner reconciliation `saveHostingRecord`'s hook and
   *  `reconcileAll` both call. Reads the billing role record, creates an
   *  instance if this is the first paid evidence this owner has ever
   *  produced, and otherwise derives the target stage/deadlines from the
   *  record and applies the difference (idempotent — applying the same
   *  target twice is a no-op). */
  reconcileOwner(ownerId: string, nowMs = this.now()): void {
    const sub = this.billing.store.getRoleSubscription(ownerId, "hosting");
    if (!sub) return;
    const environment = sub.livemode ? "live" : "test";
    let instance = this.store.activeInstanceForOwner(ownerId, environment);
    if (!instance) {
      if (!paidEvidenceExists(sub)) return; // nothing to provision yet (a checkout not yet confirmed)
      const priorTerminated = this.store.instances().find((r) => r.ownerId === ownerId && r.environment === environment && r.stage === "deleted");
      if (priorTerminated?.stripeSubscriptionId && priorTerminated.stripeSubscriptionId === sub.subscriptionId) {
        if (priorTerminated.failureReason === "unreserved_payment") return;
        this.notifyLatePayment(priorTerminated, nowMs);
        return;
      }
      this.log(`[hosting] refusing unreserved hosting payment for ${ownerId}: no customer-bound Checkout reservation exists`);
      if (sub.subscriptionId) {
        const rejected = this.store.reserveInstance({ id: this.store.newId("host"), ownerId, environment, region: this.policy().regions[0]?.id ?? "nrt", planId: this.policy().planId, stripeCustomerId: ownerId, nowMs });
        if (rejected) {
          const stopped = this.store.updateInstance(rejected.id, rejected.version, (d) => { d.stage = "deleted"; d.stripeSubscriptionId = sub.subscriptionId; d.failureReason = "unreserved_payment"; }, nowMs);
          if (stopped) this.enqueueStripeCancellation(stopped, sub.subscriptionId, "unreserved-payment", nowMs);
        }
      }
      return;
    }
    if (!this.softwareEligible(ownerId, nowMs)) {
      this.log(`[hosting] refusing paid hosting provisioning for ${ownerId}: no eligible software licence is bound to this exact customer`);
      if (sub.subscriptionId) this.enqueueStripeCancellation(instance, sub.subscriptionId, "software-ineligible", nowMs);
      if (instance.stage === "ordered" && !instance.providerInstanceId) this.store.updateInstance(instance.id, instance.version, (d) => { d.stage = "deleted"; d.checkoutExpiresAtMs = null; }, nowMs);
      return;
    }
    this.applyBillingSignal(instance, sub, nowMs);
  }

  private provisionNewInstance(ownerId: string, sub: RoleSubscriptionRecord, nowMs: number): HostingInstanceRow | null {
    const policy = this.policy();
    const id = this.store.newId("host");
    const row = this.store.reserveInstance({
      id, ownerId, environment: sub.livemode ? "live" : "test",
      region: policy.regions[0]?.id ?? "nrt", planId: policy.planId,
      stripeCustomerId: ownerId.startsWith("email:") ? "" : ownerId,
      nowMs,
    });
    if (!row) return null; // reservation refused — an instance already exists for this owner (double-click / race)
    this.log(`[hosting] reserved ${row.id} for ${ownerId} (${row.environment}) — one instance per owner`);
    this.enqueueProvisionJob(row, nowMs);
    return row;
  }

  private enqueueProvisionJob(row: HostingInstanceRow, nowMs: number): void {
    this.store.enqueue({
      hostingInstanceId: row.id, lifecycleVersion: row.lifecycleVersion, generation: row.generation,
      jobType: "provision", dedupeKey: `provision:${row.id}:g${row.generation}`, availableAtMs: nowMs, payload: {},
    }, nowMs);
  }

  /** Compute the target stage from the billing record and move the instance
   *  toward it. Every branch is a no-op if the instance is already there —
   *  the property that makes re-running this on every tick safe. */
  private applyBillingSignal(instance: HostingInstanceRow, sub: RoleSubscriptionRecord, nowMs: number): void {
    const policy = this.policy();
    const signal: BillingSignal = { subscriptionStatus: sub.subscriptionStatus, periodEndMs: sub.periodEndMs, refunded: sub.refunded, disputed: sub.disputed };

    // Keep the row's own copy of the subscription id current — it is what
    // `reconcileOwner` compares a FUTURE terminated instance against to
    // tell a genuinely new purchase from a late payment on the same dead
    // subscription (see that method's own comment).
    if (sub.subscriptionId && sub.subscriptionId !== instance.stripeSubscriptionId) {
      const withId = this.store.updateInstance(instance.id, instance.version, (d) => { d.stripeSubscriptionId = sub.subscriptionId; d.checkoutExpiresAtMs = null; }, nowMs);
      if (withId) {
        instance = withId;
        if (withId.stage === "ordered") this.enqueueProvisionJob(withId, nowMs);
      }
    }

    // A refund/dispute is recorded for the admin page but is deliberately
    // NOT an automatic suspend/delete trigger — a partial refund or a
    // dispute that resolves in the merchant's favor must not have already
    // destroyed the server (H6's whole "never a false restoration promise,
    // never an invented success" caution, applied to the opposite
    // direction: never an invented FAILURE either). The operator acts on
    // it from the admin page's audit list.
    if ((signal.refunded || signal.disputed) && instance.failureReason !== hostingBillingFlagNote(signal)) {
      this.store.updateInstance(instance.id, instance.version, (d) => { d.failureReason = hostingBillingFlagNote(signal); }, nowMs);
    }

    const paidThroughAdvanced = signal.periodEndMs !== null && (instance.paidThroughMs === null || signal.periodEndMs > instance.paidThroughMs);
    const scheduledCancel = signal.subscriptionStatus === "active (cancels at period end)";
    const nonpaying = signal.subscriptionStatus === "past_due";
    const ended = signal.subscriptionStatus === "canceled";
    const recovering = RECOVERABLE_STAGES.has(instance.stage);

    if (paidThroughAdvanced && TERMINAL_ISH.has(instance.stage)) {
      // Money arrived during/after the irreversible delete commit — never
      // restore, never silently absorb it into paidThroughMs. See
      // `notifyLatePayment`'s own docstring.
      this.notifyLatePayment(instance, nowMs);
      return;
    }
    if (paidThroughAdvanced && recovering) {
      this.restore(instance, signal.periodEndMs!, nowMs);
      return;
    }
    if (paidThroughAdvanced) {
      // An ordinary renewal (or the first invoice.paid for a fresh
      // instance): move paid-through forward, clear any stale
      // expiry/cancellation deadlines and their queued notices.
      const fresh = this.store.updateInstance(instance.id, instance.version, (d) => {
        d.paidThroughMs = signal.periodEndMs;
        if (d.cancellationReason !== "intentional_cancellation") { d.suspendAtMs = null; d.deleteAtMs = null; d.cancellationReason = null; }
        d.lifecycleVersion += 1;
      }, nowMs);
      if (fresh) this.store.obsoletePendingJobsOlderThan(instance.id, fresh.lifecycleVersion, fresh.generation, nowMs);
      return;
    }
    if (scheduledCancel && instance.cancellationReason !== "intentional_cancellation" && !TERMINAL_ISH.has(instance.stage)) {
      this.scheduleEnd(instance, "intentional_cancellation", signal.periodEndMs ?? instance.paidThroughMs ?? nowMs, policy, nowMs);
      return;
    }
    if (nonpaying && !TERMINAL_ISH.has(instance.stage) && instance.cancellationReason !== "intentional_cancellation") {
      // Idempotent, matching `scheduledCancel`'s own guard three lines up
      // (and `ended`'s below): a subscription answers "past_due" on EVERY
      // reconcile pass until something else changes it, so without this
      // check `scheduleEnd` re-derived and re-queued a brand new
      // suspend/delete/reminder set from `paidThroughMs` on every single
      // tick — pointless churn on an ordinary install, and it is what
      // would have silently overwritten an admin deletion hold's release
      // (`adminReleaseHold`'s held-time-shifted deadlines) on the very
      // next tick, since this path knows nothing about a hold.
      if (instance.cancellationReason !== "renewal_unpaid") this.scheduleEnd(instance, "renewal_unpaid", instance.paidThroughMs ?? nowMs, policy, nowMs);
      return;
    }
    if (ended && instance.cancellationReason === null && !TERMINAL_ISH.has(instance.stage)) {
      // A hard/immediate cancellation with no prior notice from either
      // branch above — treat it the safe (customer-favoring) way: as
      // nonpayment-shaped grace, never an instant suspend.
      this.scheduleEnd(instance, "renewal_unpaid", instance.paidThroughMs ?? nowMs, policy, nowMs);
    }
  }

  private scheduleEnd(instance: HostingInstanceRow, reason: HostingEndReason, anchor: number, policy: HostingPolicy, nowMs: number): void {
    const d = deadlines(anchor, reason, policy);
    const stage: HostingStage = reason === "intentional_cancellation" ? "cancel_scheduled" : "past_due";
    const fresh = this.store.updateInstance(instance.id, instance.version, (draft) => {
      draft.stage = stage;
      draft.cancellationReason = reason;
      draft.suspendAtMs = d.suspendAt;
      draft.deleteAtMs = d.deleteAt;
      draft.lifecycleVersion += 1;
    }, nowMs);
    if (!fresh) return;
    this.store.obsoletePendingJobsOlderThan(instance.id, fresh.lifecycleVersion, fresh.generation, nowMs);
    this.queueDeadlineJobs(fresh, d, reason, nowMs);
  }

  private queueDeadlineJobs(row: HostingInstanceRow, d: HostingDeadlines, reason: HostingEndReason, nowMs: number): void {
    const base = { hostingInstanceId: row.id, lifecycleVersion: row.lifecycleVersion, generation: row.generation };
    if (reason === "renewal_unpaid") {
      this.store.enqueue({ ...base, jobType: "email", dedupeKey: `email:overdue:${row.id}:v${row.lifecycleVersion}`, availableAtMs: nowMs, payload: { template: "overdue" } }, nowMs);
    } else {
      this.store.enqueue({ ...base, jobType: "email", dedupeKey: `email:cancel_scheduled:${row.id}:v${row.lifecycleVersion}`, availableAtMs: nowMs, payload: { template: "cancellation_scheduled" } }, nowMs);
    }
    this.store.enqueue({ ...base, jobType: "email", dedupeKey: `email:three_days:${row.id}:v${row.lifecycleVersion}`, availableAtMs: d.threeDaysAt, payload: { template: "three_days" } }, nowMs);
    this.store.enqueue({ ...base, jobType: "email", dedupeKey: `email:one_day:${row.id}:v${row.lifecycleVersion}`, availableAtMs: d.oneDayAt, payload: { template: "one_day" } }, nowMs);
    this.store.enqueue({ ...base, jobType: "suspend", dedupeKey: `suspend:${row.id}:v${row.lifecycleVersion}`, availableAtMs: d.suspendAt, payload: {} }, nowMs);
    this.store.enqueue({ ...base, jobType: "delete", dedupeKey: `delete:${row.id}:v${row.lifecycleVersion}`, availableAtMs: d.deleteAt, payload: {} }, nowMs);
  }

  /** A payment observed while the instance is past_due/cancel_scheduled/
   *  suspended/restoring: invalidate the expiry pipeline and move toward
   *  `restoring`. NEVER jumps straight to `ready`/`active`; the retained
   *  instance must submit a fresh authenticated app/credential/venue proof.
   *  Irreversible deletion is a hard wall: once `stage === "deleting"`
   *  or `"deleted"`, this method refuses and reports late-payment instead
   *  (handled by the caller checking stage first — see `applyBillingSignal`,
   *  which routes here only from `RECOVERABLE_STAGES`, and `drainDelete`,
   *  which checks the SAME payment signal before committing). */
  private restore(instance: HostingInstanceRow, periodEndMs: number, nowMs: number): void {
    const fresh = this.store.updateInstance(instance.id, instance.version, (d) => {
      d.paidThroughMs = periodEndMs;
      d.cancellationReason = null;
      d.suspendAtMs = null;
      d.deleteAtMs = null;
      d.stage = "restoring";
      d.failureReason = null;
      d.pendingRestore = true;
      d.lifecycleVersion += 1;
    }, nowMs);
    if (!fresh) return;
    this.store.obsoletePendingJobsOlderThan(instance.id, fresh.lifecycleVersion, fresh.generation, nowMs);
    this.store.enqueue({ hostingInstanceId: fresh.id, lifecycleVersion: fresh.lifecycleVersion, generation: fresh.generation, jobType: "provision", dedupeKey: `restore:${fresh.id}:v${fresh.lifecycleVersion}`, availableAtMs: nowMs, payload: { restore: true } }, nowMs);
  }

  // ── customer actions ─────────────────────────────────────────────────────

  /** POST /api/hosting/:id/cancel. Schedules the SAME deadlines a Stripe
   *  `cancel_at_period_end` webhook would eventually derive — computed here
   *  immediately so the customer sees exact dates without waiting for a
   *  webhook round trip — and best-effort tells Stripe to actually cancel
   *  at period end (never blocks the local schedule on that call
   *  succeeding; a failure is logged and the LOCAL lifecycle is still
   *  authoritative for suspend/delete timing, matching this Hub's own
   *  Stripe-webhook-is-truth design elsewhere). */
  async cancel(ownerId: string, instanceId: string, nowMs = this.now()): Promise<HostingActionResult<{ suspendAt: number; deleteAt: number }>> {
    const row = this.owned(ownerId, instanceId);
    if (!row) return { ok: false, code: "NOT_FOUND", error: "unknown hosting instance" };
    if (TERMINAL_ISH.has(row.stage)) return { ok: false, code: "NOT_CANCELLABLE", error: "this hosting instance cannot be cancelled from its current state" };
    const sub = this.billing.store.getRoleSubscription(ownerId, "hosting");
    if (!sub?.subscriptionId || !(await this.setStripeCancellation(sub.subscriptionId, true))) {
      return { ok: false, code: "PROVIDER_STATUS_UNKNOWN", error: "Stripe did not confirm the cancellation; no local hosting deadline was changed" };
    }
    const policy = this.policy();
    const anchor = row.paidThroughMs ?? nowMs;
    this.scheduleEnd(row, "intentional_cancellation", anchor, policy, nowMs);
    const d = deadlines(anchor, "intentional_cancellation", policy);
    return { ok: true, value: { suspendAt: d.suspendAt, deleteAt: d.deleteAt } };
  }

  /** POST /api/hosting/:id/resume-renewal. Only reversible before the
   *  suspend deadline — the handoff's own boundary ("still reversible"). */
  async resumeRenewal(ownerId: string, instanceId: string, nowMs = this.now()): Promise<HostingActionResult<{ stage: HostingStage }>> {
    const row = this.owned(ownerId, instanceId);
    if (!row) return { ok: false, code: "NOT_FOUND", error: "unknown hosting instance" };
    if (row.stage !== "cancel_scheduled" || (row.suspendAtMs !== null && nowMs >= row.suspendAtMs)) {
      return { ok: false, code: "RESTORATION_UNAVAILABLE", error: "this cancellation can no longer be reversed from here — the hosting window has passed" };
    }
    const sub = this.billing.store.getRoleSubscription(ownerId, "hosting");
    if (!sub?.subscriptionId || !(await this.setStripeCancellation(sub.subscriptionId, false))) {
      return { ok: false, code: "PROVIDER_STATUS_UNKNOWN", error: "Stripe did not confirm renewal; the existing cancellation schedule remains unchanged" };
    }
    const fresh = this.store.updateInstance(row.id, row.version, (d) => {
      d.cancellationReason = null; d.suspendAtMs = null; d.deleteAtMs = null; d.stage = "ready"; d.lifecycleVersion += 1;
    }, nowMs);
    if (!fresh) return { ok: false, code: "NOT_FOUND", error: "this hosting instance changed underneath the request — reload and try again" };
    this.store.obsoletePendingJobsOlderThan(fresh.id, fresh.lifecycleVersion, fresh.generation, nowMs);
    return { ok: true, value: { stage: fresh.stage } };
  }

  private owned(ownerId: string, instanceId: string): HostingInstanceRow | null {
    const row = this.store.getInstance(instanceId);
    return row && row.ownerId === ownerId ? row : null;
  }

  // ── readiness callback ───────────────────────────────────────────────────

  /** Authenticate a fresh instance before the Hub gives it the customer's
   *  signed-release installer. The provider never receives a GitHub token or
   *  a release-signing secret. */
  bootstrapLicenseToken(instanceId: string, presentedToken: string, generation: number, nowMs = this.now()): HostingActionResult<{ licenseToken: string; releaseRef: string }> {
    const authenticated = this.authenticatedBootstrapOwner(instanceId, presentedToken, generation, nowMs);
    if (!authenticated.ok) return authenticated;
    if (!this.softwareEligible(authenticated.value.ownerId, nowMs)) {
      return { ok: false, code: "SOFTWARE_LICENSE_REQUIRED", error: "the software licence is not active" };
    }
    const customer = this.billing.store.getCustomer(authenticated.value.ownerId);
    const licenseToken = customer ? this.licenses.tokenFor(customer.licenseId) : null;
    if (!licenseToken) return { ok: false, code: "SOFTWARE_LICENSE_REQUIRED", error: "the software licence is not available" };
    const row = this.store.getInstance(instanceId);
    if (!row?.releaseRef) return { ok: false, code: "NOT_FOUND", error: "this instance has no pinned customer release" };
    return { ok: true, value: { licenseToken, releaseRef: row.releaseRef } };
  }

  private authenticatedBootstrapOwner(instanceId: string, presentedToken: string, generation: number, nowMs: number): HostingActionResult<{ ownerId: string }> {
    const row = this.store.getInstance(instanceId);
    if (!row) return { ok: false, code: "NOT_FOUND", error: "unknown instance" };
    if (row.stage !== "provisioning" && row.stage !== "bootstrapping") return { ok: false, code: "NOT_FOUND", error: "bootstrap is no longer active for this instance" };
    if (row.generation !== generation) return { ok: false, code: "NOT_FOUND", error: "stale generation — this callback belongs to a replaced instance" };
    if (!row.bootstrapTokenHash || row.bootstrapTokenExpiresAtMs === null || row.bootstrapTokenExpiresAtMs < nowMs || hashBootstrapToken(presentedToken) !== row.bootstrapTokenHash) {
      return { ok: false, code: "NOT_FOUND", error: "invalid or expired bootstrap token" };
    }
    return { ok: true, value: { ownerId: row.ownerId } };
  }

  /** POST /api/hosting/instances/:id/readiness. Verifies the presented
   *  bootstrap token against the STORED hash (never accepted in plaintext
   *  anywhere else — the token itself never appears in a log line here).
   *  A late callback from a torn-down/replaced generation is refused by
   *  comparing the presented generation against the row's CURRENT one
   *  (H6: "late callbacks from a failed/replaced instance must not mark
   *  the replacement ready"). */
  reportReadiness(instanceId: string, presentedToken: string, generation: number, results: readonly ProbeResult[], nowMs = this.now(), managementCounter?: number): HostingActionResult<{ ready: boolean }> {
    let row = this.store.getInstance(instanceId);
    if (!row) return { ok: false, code: "NOT_FOUND", error: "unknown instance" };
    if (managementCounter !== undefined) {
      if (row.stage !== "restoring" || row.generation !== generation || !Number.isSafeInteger(managementCounter) || managementCounter <= row.managementCounter || !row.managementTokenHash || hashBootstrapToken(presentedToken) !== row.managementTokenHash) {
        return { ok: false, code: "NOT_FOUND", error: "invalid or replayed management readiness proof" };
      }
      const counted = this.store.updateInstance(row.id, row.version, (d) => { d.managementCounter = managementCounter; }, nowMs);
      if (!counted) return { ok: false, code: "NOT_FOUND", error: "changed underneath the management readiness proof" };
      row = counted;
    } else {
      const authenticated = this.authenticatedBootstrapOwner(instanceId, presentedToken, generation, nowMs);
      if (!authenticated.ok) return authenticated;
    }
    const policy = this.policy();
    const verdict = readinessVerdict(policy.probeVenues, results);
    const fresh = this.store.updateInstance(row.id, row.version, (d) => {
      d.readiness = { checkedAtMs: nowMs, ready: verdict.ready, refusals: verdict.refusals, regionTried: d.region };
      d.lastProviderCheckAtMs = nowMs;
    }, nowMs);
    if (!fresh) return { ok: false, code: "NOT_FOUND", error: "changed underneath the request" };
    if (verdict.ready) {
      this.markReady(fresh, nowMs);
    } else if (managementCounter !== undefined) {
      this.store.updateInstance(fresh.id, fresh.version, (d) => {
        d.operationalHealth = "unhealthy";
        d.failureReason = `Paid recovery is waiting for server readiness — ${verdict.refusals.join("; ")}`;
      }, nowMs);
    } else {
      this.handleReadinessRefusal(fresh, verdict, policy, nowMs);
    }
    return { ok: true, value: { ready: verdict.ready } };
  }

  private markReady(row: HostingInstanceRow, nowMs: number): void {
    const fresh = this.store.updateInstance(row.id, row.version, (d) => {
      d.stage = "ready";
      d.operationalHealth = "healthy";
      d.failureReason = null;
      d.pendingRestore = false;
    }, nowMs);
    if (!fresh) return;
    // `pendingRestore` distinguishes a retained paid recovery from the
    // initial empty-server bootstrap for customer messaging.
    if (row.pendingRestore) {
      this.store.enqueue({ hostingInstanceId: fresh.id, lifecycleVersion: fresh.lifecycleVersion, generation: fresh.generation, jobType: "email", dedupeKey: `email:restored:${fresh.id}:g${fresh.generation}`, availableAtMs: nowMs, payload: { template: "restored" } }, nowMs);
    } else {
      this.store.enqueue({ hostingInstanceId: fresh.id, lifecycleVersion: fresh.lifecycleVersion, generation: fresh.generation, jobType: "email", dedupeKey: `email:ready:${fresh.id}:g${fresh.generation}`, availableAtMs: nowMs, payload: { template: "installation_ready" } }, nowMs);
    }
  }

  /** H6 "fallback region once": try the NEXT configured region exactly one
   *  time, only if this generation has not already tried it, before
   *  refusing readiness for good and marking the instance unhealthy. */
  private handleReadinessRefusal(row: HostingInstanceRow, verdict: ReadinessVerdict, policy: HostingPolicy, nowMs: number): void {
    // The CURRENT region counts as "tried" even though `regionAttempts`
    // (the history of PAST regions this generation moved on from) does not
    // include it yet — omitting it here would let the very first refusal
    // "fall back" to the region it just failed in.
    const triedSet = new Set([...row.regionAttempts, row.region]);
    const nextRegion = policy.regions.find((r) => !triedSet.has(r.id));
    if (nextRegion) {
      const fresh = this.store.updateInstance(row.id, row.version, (d) => {
        d.operationalHealth = "unhealthy";
        d.failureReason = `readiness refused in ${row.region}: ${verdict.refusals.join("; ")} — replacing it once in ${nextRegion.label}`;
      }, nowMs);
      if (fresh) {
        this.log(`[hosting] ${row.id}: readiness refused in ${row.region}, retrying once in ${nextRegion.id}`);
        this.store.enqueue({
          hostingInstanceId: fresh.id, lifecycleVersion: fresh.lifecycleVersion, generation: fresh.generation,
          jobType: "readiness_recheck", dedupeKey: `region-replace:${fresh.id}:g${fresh.generation}:${nextRegion.id}`,
          availableAtMs: nowMs, payload: { kind: "replace-region", nextRegionId: nextRegion.id, refusals: [...verdict.refusals] },
        }, nowMs);
      }
      return;
    }
    this.store.enqueue({
      hostingInstanceId: row.id, lifecycleVersion: row.lifecycleVersion, generation: row.generation,
      jobType: "readiness_recheck", dedupeKey: `region-terminal:${row.id}:g${row.generation}`,
      availableAtMs: nowMs, payload: { kind: "replace-region", nextRegionId: null, refusals: [...verdict.refusals] },
    }, nowMs);
    this.log(`[hosting] ${row.id}: readiness refused in every configured region — ${verdict.refusals.join("; ")}`);
  }

  // ── outbox draining (the durable job worker) ────────────────────────────

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Owns its own periodic reconciliation (candles/liq's own `start`/`stop`
   *  shape — src/server.ts's `listen`/`close`), so every hub that
   *  constructs a HostingService gets the "periodic reconciliation
   *  independent of webhooks" H7 asks for without main.ts having to know
   *  hosting's internals. A test hub that never calls `start()` still
   *  drives `tick()` directly, deterministically, with its own clock. */
  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((err) => this.log(`[hosting] tick failed: ${(err as Error).message}`)); }, intervalMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Drains due jobs up to `limit`, each claimed under its own short lease
   *  so a crash mid-job leaves it reclaimable rather than lost. Also the
   *  entry point for the periodic (webhook-independent) reconciliation pass
   *  — see the file header. */
  async tick(nowMs = this.now(), limit = 25): Promise<void> {
    this.reconcileAll(nowMs);
    const due = this.store.duePending(nowMs, limit);
    for (const job of due) {
      const claimed = this.store.claimOutboxJob(job.id, LEASE_TTL_MS, nowMs);
      if (!claimed) continue;
      try {
        await this.runJob(claimed, nowMs);
        this.store.completeOutboxJob(claimed.id, "sent", this.now());
      } catch (err) {
        const msg = (err as Error).message;
        this.log(`[hosting] job ${claimed.jobType} ${claimed.id} failed: ${msg}`);
        this.store.releaseOutboxJob(claimed.id, this.now() + PROVISION_RETRY_BACKOFF_MS, this.now(), msg);
      }
    }
  }

  private async runJob(job: HostingOutboxRow, nowMs: number): Promise<void> {
    const row = this.store.getInstance(job.hostingInstanceId);
    if (!row || row.lifecycleVersion !== job.lifecycleVersion || row.generation !== job.generation) return; // superseded — nothing to do, "sent" (obsolete-in-effect)
    switch (job.jobType) {
      case "provision": return this.drainProvision(row, nowMs);
      case "readiness_recheck": return this.drainReadinessRecheck(row, job, nowMs);
      case "suspend": return this.drainSuspend(row, nowMs);
      case "delete": return this.drainDelete(row, nowMs);
      case "billing_reconcile": {
        const subscriptionId = String(job.payload.subscriptionId ?? "");
        if (!subscriptionId || !(await this.setStripeCancellation(subscriptionId, true))) throw new Error("Stripe did not confirm the durable cancellation request");
        return;
      }
      case "email": {
        const template = String((job.payload as any).template ?? "");
        // "Reminders about deletion are suppressed while held" (the
        // deletion hold's own contract): a countdown email is dishonest
        // while the countdown itself is paused. The other templates
        // (overdue/cancellation_scheduled/suspended/etc.) are unrelated to
        // an impending delete and still send normally. Nothing is lost —
        // `adminReleaseHold` re-derives and re-queues fresh reminder jobs
        // against the recomputed deadlines once released.
        if (row.deletionHold && (template === "three_days" || template === "one_day")) {
          this.log(`[hosting] ${row.id}: "${template}" deletion reminder suppressed — on an admin deletion hold (by ${row.deletionHold.by})`);
          return;
        }
        return this.drainEmail(row, template, nowMs);
      }
      default: return;
    }
  }

  // ── provisioning ─────────────────────────────────────────────────────────

  private async drainProvision(row: HostingInstanceRow, nowMs: number): Promise<void> {
    const policy = this.policy();
    if (!policy.provisioningEnabled) throw new Error("provisioning master switch is off — the durable job will retry without creating a server");
    const provider = this.provider();
    if (!provider) throw new Error("no provider API key is configured — provisioning will retry without creating a server");
    if (row.stage === "restoring") {
      if (!row.providerInstanceId) throw new Error("cannot restore a server whose provider instance id is missing");
      const existing = await provider.getInstance(row.providerInstanceId);
      if (!existing) throw new Error("cannot restore because the provider no longer has this server");
      if (existing.status !== "active") await provider.power(row.providerInstanceId, "on");
      const current = this.store.getInstance(row.id);
      if (current?.stage === "restoring") this.store.updateInstance(current.id, current.version, (d) => {
        d.lastProviderCheckAtMs = nowMs;
        d.failureReason = "Server power-on requested; waiting for its authenticated boot readiness proof.";
      }, nowMs);
      return;
    }
    if (row.provisionAttempts >= MAX_PROVISION_ATTEMPTS) { this.failProvisioning(row, `setup failed after ${row.provisionAttempts} attempts`, nowMs); return; }
    await this.captureProviderPlanQuote(row, provider, nowMs);
    // Quote capture updates this same row. Refresh before the stage/attempt
    // CAS or the stale version would make that mutation a silent no-op.
    row = this.store.getInstance(row.id) ?? row;
    if (row.providerPlanMonthlyCostCents === null || !Number.isSafeInteger(row.providerPlanMonthlyCostCents) || row.providerPlanMonthlyCostCents <= 0) throw new Error("provider price could not be verified — provisioning remains blocked");
    if (policy.monthlyPriceCents !== row.providerPlanMonthlyCostCents * 2) {
      this.failProvisioning(row, "advertised hosting price no longer equals twice the verified provider cost", nowMs);
      return;
    }
    const projected = this.projectedMonthlyProviderCostCents();
    if (policy.maximumProjectedMonthlyProviderCostCents > 0 && (!projected.known || projected.cents > policy.maximumProjectedMonthlyProviderCostCents)) {
      this.failProvisioning(row, "the provider cost ceiling changed or was reached before server creation", nowMs);
      return;
    }

    const label = hostingInstanceLabel(row.id, row.generation);
    this.store.updateInstance(row.id, row.version, (d) => { d.stage = "provisioning"; d.label = label; d.provisionAttempts += 1; }, nowMs);
    let created = row.providerInstanceId ? await provider.getInstance(row.providerInstanceId) : null;
    if (!created) {
      // Crash-recovery: an earlier attempt may have created the resource
      // and never persisted the id (H4/H6's central acceptance case). ALWAYS
      // check findByLabel BEFORE calling createInstance again.
      created = await provider.findByLabel(label);
    }
    if (!created) {
      const rawToken = mintBootstrapToken(this.randomBytes);
      const rawManagementToken = mintBootstrapToken(this.randomBytes);
      // Persist the verifier BEFORE the provider call. A create timeout may
      // mean the instance already exists and cloud-init is already calling
      // home; writing this afterward creates a race where a legitimate
      // installer request is refused, and a process crash would lose the one
      // verifier that can authenticate the orphaned instance.
      const tokenRow = this.store.getInstance(row.id);
      if (!tokenRow) return;
      this.store.updateInstance(row.id, tokenRow.version, (d) => {
        d.bootstrapTokenHash = hashBootstrapToken(rawToken);
        d.bootstrapTokenExpiresAtMs = nowMs + policy.bootstrapTokenTtlMinutes * 60_000;
        d.managementTokenHash = hashBootstrapToken(rawManagementToken);
        d.managementCounter = 0;
        d.releaseRef = policy.releaseRef;
      }, nowMs);
      const userData = buildBootstrapUserData({
        instanceId: row.id, generation: row.generation, bootstrapToken: rawToken,
        managementToken: rawManagementToken,
        hubOrigin: this.origin,
        maxAccounts: policy.maximumConnectedAccounts,
        probeVenues: policy.probeVenues,
      });
      try {
        created = await provider.createInstance({ label, regionId: row.region, planId: row.planId, osId: policy.osId, userData, tags: [`wh-owner:${sha1short(row.ownerId)}`] });
      } catch (err) {
        // A create that timed out or errored may still have REALLY happened
        // on the provider's side (H6: "an API timeout may occur after a
        // server was created"). Rethrow so tick()'s catch releases this
        // job with a backoff rather than marking it done — the NEXT
        // attempt's `findByLabel` above is what discovers the orphan and
        // stops a second `createInstance` from ever being called for the
        // same instance/generation.
        throw new Error(`createInstance failed/uncertain: ${(err as Error).message} — will re-check findByLabel next attempt`);
      }
    }
    if (!this.store.resourcesFor(row.id).some((r) => r.providerResourceId === created!.providerInstanceId)) {
      // Recorded whether `created` came from a fresh `createInstance` or
      // from crash-recovery `findByLabel` — the resource inventory must be
      // accurate either way, and the `some(...)` guard above keeps a
      // rediscovered resource from being recorded twice on a later retry.
      this.store.recordResource({ hostingInstanceId: row.id, generation: row.generation, providerAccountRef: policy.providerAccountRef, resourceType: "instance", providerResourceId: created.providerInstanceId, exclusivelyOwned: true, cleanupState: "present", createdAtMs: nowMs, removedAtMs: null });
    }
    const current = this.store.getInstance(row.id);
    if (!current) return;
    this.store.updateInstance(current.id, current.version, (d) => {
      d.providerInstanceId = created!.providerInstanceId;
      d.ip = created!.mainIp ?? d.ip;
      d.appUrl = created!.mainIp ? `https://${created!.mainIp}/` : d.appUrl;
      d.stage = "bootstrapping";
    }, nowMs);
    // Nothing further here — the instance now waits for the bootstrap
    // script's own readiness callback (reportReadiness). Re-enqueue a
    // bounded number of follow-up provision checks so an instance that
    // never calls back (bootstrap script crashed, no egress at all) is
    // eventually retried rather than stuck silently forever.
    const after = this.store.getInstance(current.id);
    if (after) this.store.enqueue({
      hostingInstanceId: after.id, lifecycleVersion: after.lifecycleVersion, generation: after.generation,
      jobType: "readiness_recheck", dedupeKey: `bootstrap-timeout:${after.id}:g${after.generation}:a${after.provisionAttempts}`,
      availableAtMs: after.bootstrapTokenExpiresAtMs ?? nowMs + policy.bootstrapTokenTtlMinutes * 60_000,
      payload: { kind: "bootstrap-timeout" },
    }, nowMs);
  }

  /** Finish a timed-out or venue-refused generation without leaking its VPS.
   * The old resource is deleted first; only then is a new generation queued
   * in the one remaining configured region. An uncertain delete keeps this
   * durable job pending and can never create the replacement concurrently. */
  private async drainReadinessRecheck(row: HostingInstanceRow, job: HostingOutboxRow, nowMs: number): Promise<void> {
    if (row.stage !== "bootstrapping") return;
    const kind = String(job.payload.kind ?? "");
    if (kind === "bootstrap-timeout") {
      if (row.bootstrapTokenExpiresAtMs !== null && nowMs < row.bootstrapTokenExpiresAtMs) {
        throw new Error("bootstrap timeout check ran before the credential expiry");
      }
      const verdict = readinessVerdict(this.policy().probeVenues, []);
      this.handleReadinessRefusal(row, verdict, this.policy(), nowMs);
      return;
    }
    if (kind !== "replace-region") return;
    const nextRegionId = typeof job.payload.nextRegionId === "string" ? job.payload.nextRegionId : null;
    const refusals = Array.isArray(job.payload.refusals) ? job.payload.refusals.map(String) : ["bootstrap did not report readiness"];
    const provider = this.provider();
    if (!provider) throw new Error("provider API key is unavailable during failed-instance cleanup");
    if (row.providerInstanceId) {
      await provider.deleteInstance(row.providerInstanceId);
      if (await provider.getInstance(row.providerInstanceId)) {
        throw new Error("provider deletion is still in progress — replacement remains blocked");
      }
    }
    for (const resource of this.store.resourcesFor(row.id)) {
      if (resource.generation === row.generation && resource.cleanupState === "present") this.store.markResourceRemoved(resource.id, nowMs);
    }
    const current = this.store.getInstance(row.id);
    if (!current) return;
    if (!nextRegionId) {
      this.store.updateInstance(current.id, current.version, (d) => {
        d.providerInstanceId = null; d.ip = null; d.appUrl = null;
        d.bootstrapTokenHash = null; d.bootstrapTokenExpiresAtMs = null;
      }, nowMs);
      const cleaned = this.store.getInstance(current.id);
      if (cleaned) this.failProvisioning(cleaned, `Hosting is not available in an exchange-approved region right now — ${refusals.join("; ")}`, nowMs);
      return;
    }
    const fresh = this.store.updateInstance(current.id, current.version, (d) => {
      d.regionAttempts = [...d.regionAttempts, d.region];
      d.region = nextRegionId;
      d.generation += 1;
      d.provisionAttempts = 0;
      d.providerInstanceId = null; d.ip = null; d.appUrl = null; d.label = "";
      d.bootstrapTokenHash = null; d.bootstrapTokenExpiresAtMs = null; d.releaseRef = null;
      d.managementTokenHash = null; d.managementCounter = 0;
      d.stage = "provisioning";
    }, nowMs);
    if (fresh) this.enqueueProvisionJob(fresh, nowMs);
  }

  /** Records `providerPlanMonthlyCostCents` on the row from
   *  `provider.listPlans()` the first time this instance is provisioned —
   *  best-effort: a failed or empty read leaves it `null` (unknown), which
   *  keeps `projectedMonthlyProviderCostCents()` honest (unknown, not 0)
   *  rather than blocking provisioning itself over a cost-accounting read.
   *  No-op once a quote is already recorded — this is a one-time capture,
   *  not a live re-price on every provision attempt. */
  private async captureProviderPlanQuote(row: HostingInstanceRow, provider: HostingProvider, nowMs: number): Promise<void> {
    if (row.providerPlanMonthlyCostCents !== null) return;
    try {
      const plans = await provider.listPlans();
      const match = plans.find((p) => p.id === row.planId);
      if (!match) { this.log(`[hosting] ${row.id}: provider does not list plan "${row.planId}" — cost ceiling projection stays unknown for this instance`); return; }
      if (!Number.isSafeInteger(match.monthlyCostCents) || match.monthlyCostCents <= 0) { this.log(`[hosting] ${row.id}: selected provider plan has no verified positive cost`); return; }
      const current = this.store.getInstance(row.id);
      if (current && current.providerPlanMonthlyCostCents === null) {
        this.store.updateInstance(current.id, current.version, (d) => { d.providerPlanMonthlyCostCents = match.monthlyCostCents; }, nowMs);
      }
    } catch (err) {
      this.log(`[hosting] ${row.id}: could not read the provider's plan quote (${(err as Error).message}) — cost ceiling projection stays unknown for this instance`);
    }
  }

  /** Sum of `providerPlanMonthlyCostCents` across every non-deleted
   *  instance — suspended/past_due/cancel_scheduled/restoring rows count
   *  too (they either still hold a provider resource or will create one
   *  again on restore; only `deleted` truly has none). ANY non-deleted
   *  instance whose quote was never captured makes the WHOLE projection
   *  unknown — never silently 0, which would understate spend and let the
   *  ceiling check pass when it should refuse. */
  projectedMonthlyProviderCostCents(): { known: true; cents: number } | { known: false } {
    let total = 0;
    for (const row of this.store.instances()) {
      if (row.stage === "deleted") continue;
      if (row.providerPlanMonthlyCostCents === null) return { known: false };
      total += row.providerPlanMonthlyCostCents;
    }
    return { known: true, cents: total };
  }

  /** The most recently captured provider quote for `planId`, from ANY
   *  instance that has ever recorded one (deleted included — the figure is
   *  a fact about the PLAN, not about that particular instance's
   *  lifecycle). Used to estimate what a not-yet-created instance of the
   *  SAME plan would cost, without a live provider call — see
   *  `costCeilingRefusal`. `null` = this plan has never been quoted on this
   *  Hub. */
  private lastKnownPlanQuoteCents(planId: string): number | null {
    let best: { updatedAtMs: number; cents: number } | null = null;
    for (const row of this.store.instances()) {
      if (row.planId !== planId || row.providerPlanMonthlyCostCents === null) continue;
      if (!best || row.updatedAtMs > best.updatedAtMs) best = { updatedAtMs: row.updatedAtMs, cents: row.providerPlanMonthlyCostCents };
    }
    return best?.cents ?? null;
  }

  /** Refuses (by name) admitting one more instance of `planId` when a
   *  non-zero cost ceiling is configured and doing so would push the
   *  projected monthly provider spend over it — checked with NO provider
   *  call (that is the whole point: `checkoutUrl` must never hand a
   *  customer a payment link that provisioning would go on to refuse).
   *  0 = no ceiling (existing semantics). An UNKNOWN current projection or
   *  an UNKNOWN plan quote both refuse too — never guessed as 0 cost,
   *  which would silently let real spend past the ceiling; the customer
   *  sees an honest "not available right now" rather than a payment prompt
   *  that cannot be fulfilled. */
  private costCeilingRefusal(planId: string, policy: HostingPolicy): string | null {
    if (policy.maximumProjectedMonthlyProviderCostCents <= 0) return null; // 0 = no ceiling configured
    const current = this.projectedMonthlyProviderCostCents();
    if (!current.known) return "hosting is at its provider cost ceiling — the current projected provider spend could not be verified";
    const quote = this.lastKnownPlanQuoteCents(planId);
    if (quote === null) return "hosting is at its provider cost ceiling — this plan's provider cost has not yet been recorded";
    if (current.cents + quote > policy.maximumProjectedMonthlyProviderCostCents) return "hosting is at its provider cost ceiling";
    return null;
  }

  private costCeilingRefusalWithQuote(quote: number, policy: HostingPolicy): string | null {
    if (policy.maximumProjectedMonthlyProviderCostCents <= 0) return null;
    const current = this.projectedMonthlyProviderCostCents();
    if (!current.known) return "hosting is at its provider cost ceiling — the current projected provider spend could not be verified";
    if (current.cents + quote > policy.maximumProjectedMonthlyProviderCostCents) return "hosting is at its provider cost ceiling";
    return null;
  }

  private failProvisioning(row: HostingInstanceRow, reason: string, nowMs: number): void {
    this.store.updateInstance(row.id, row.version, (d) => { d.operationalHealth = "unhealthy"; d.failureReason = reason; }, nowMs);
    this.store.enqueue({ hostingInstanceId: row.id, lifecycleVersion: row.lifecycleVersion, generation: row.generation, jobType: "email", dedupeKey: `email:setup_failure:${row.id}:g${row.generation}`, availableAtMs: nowMs, payload: { template: "setup_failure" } }, nowMs);
    const sub = this.billing.store.getRoleSubscription(row.ownerId, "hosting");
    if (sub?.subscriptionId) this.enqueueStripeCancellation(row, sub.subscriptionId, "setup-failure", nowMs);
    this.log(`[hosting] ${row.id}: provisioning permanently failed — ${reason}. Recommended policy: refund the initial hosting payment (idempotent, operator-verified — see report).`);
  }

  // ── suspend / delete ─────────────────────────────────────────────────────

  private async drainSuspend(row: HostingInstanceRow, nowMs: number): Promise<void> {
    if (row.stage === "deleting" || row.stage === "deleted") return;
    if (row.suspendAtMs === null || nowMs < row.suspendAtMs) return; // paid recovery already obsoleted this job; defensive re-check
    const provider = this.provider();
    if (provider && row.providerInstanceId) {
      try { await provider.power(row.providerInstanceId, "off"); }
      catch (err) { throw new Error(`suspend power-off failed: ${(err as Error).message}`); }
    }
    const fresh = this.store.updateInstance(row.id, row.version, (d) => { d.stage = "suspended"; d.operationalHealth = "unhealthy"; }, nowMs);
    if (fresh) this.store.enqueue({ hostingInstanceId: fresh.id, lifecycleVersion: fresh.lifecycleVersion, generation: fresh.generation, jobType: "email", dedupeKey: `email:suspended:${fresh.id}:v${fresh.lifecycleVersion}`, availableAtMs: nowMs, payload: { template: "suspended" } }, nowMs);
  }

  /** The delete pipeline (H6's "delete transaction and late payments").
   *  Lease-guarded so a crash between commit and confirm is safely
   *  resumable, and re-checks the billing signal immediately before
   *  committing the irreversible step. */
  private async drainDelete(row: HostingInstanceRow, nowMs: number): Promise<void> {
    if (row.stage === "deleted") return;
    if (row.deleteAtMs === null || nowMs < row.deleteAtMs) return;
    const claim = this.store.claimLease(row.id, LEASE_TTL_MS, nowMs);
    if (!claim) return; // already being worked (or a restore/migration holds it) — try again next tick
    try {
      // Re-fetch: a payment could have arrived between this job becoming
      // due and this claim landing. `reconcileOwner` would have obsoleted
      // this exact job on a lifecycleVersion bump, so a row still carrying
      // this generation/version combo genuinely has no fresher evidence.
      const current = this.store.getInstance(row.id);
      if (!current || current.stage === "deleted" || (current.deleteAtMs !== null && nowMs < current.deleteAtMs)) { this.store.releaseLease(row.id, claim.token, nowMs); return; }
      if (current.deletionHold) {
        // An admin deletion hold refuses this transition outright, however
        // overdue `deleteAtMs` is — "tick() never transitions a held
        // instance to deleting/deleted". Nothing is lost: releasing the
        // hold (adminReleaseHold) re-derives fresh deadlines from the
        // ORIGINAL anchor and re-queues a delete job of its own, so this
        // attempt simply has nothing to do while held.
        this.log(`[hosting] ${current.id}: delete deadline reached but the instance is on an admin deletion hold (by ${current.deletionHold.by}) — not deleting; release the hold to resume`);
        this.store.releaseLease(row.id, claim.token, nowMs);
        return;
      }
      if (current.stage === "restoring" || current.cancellationReason === null && current.stage !== "suspended" && current.stage !== "past_due" && current.stage !== "cancel_scheduled") {
        this.store.releaseLease(row.id, claim.token, nowMs); return;
      }
      const committed = this.store.updateInstance(current.id, current.version, (d) => {
        d.stage = "deleting";
        d.irreversibleDeleteCommittedAtMs = nowMs;
      }, nowMs);
      if (!committed) { this.store.releaseLease(row.id, claim.token, nowMs); return; }
      this.store.obsoletePendingJobsOlderThan(committed.id, committed.lifecycleVersion, committed.generation, nowMs);

      const provider = this.provider();
      let absent = !committed.providerInstanceId;
      if (provider && committed.providerInstanceId) {
        const found = await provider.getInstance(committed.providerInstanceId);
        if (found) { await provider.deleteInstance(committed.providerInstanceId); absent = false; /* confirm on the NEXT pass, real providers delete asynchronously */ }
        else absent = true;
      }
      if (absent) {
        for (const res of this.store.resourcesFor(committed.id)) if (res.cleanupState === "present") this.store.markResourceRemoved(res.id, nowMs);
        const done = this.store.updateInstance(committed.id, committed.version, (d) => {
          d.stage = "deleted"; d.providerDeletedAtMs = nowMs; d.terminatedAtMs = nowMs;
          d.bootstrapTokenHash = null; d.bootstrapTokenExpiresAtMs = null;
          d.managementTokenHash = null; d.managementCounter = 0;
        }, nowMs);
        if (done) {
          this.store.enqueue({ hostingInstanceId: done.id, lifecycleVersion: done.lifecycleVersion, generation: done.generation, jobType: "email", dedupeKey: `email:terminated:${done.id}:g${done.generation}`, availableAtMs: nowMs, payload: { template: "terminated" } }, nowMs);
          const sub = this.billing.store.getRoleSubscription(done.ownerId, "hosting");
          if (sub?.subscriptionId) this.enqueueStripeCancellation(done, sub.subscriptionId, "terminated", nowMs);
        }
      } else {
        // Deletion requested but not yet confirmed absent — reschedule a
        // confirmation pass shortly; `stage` stays "deleting" so the
        // customer never sees a false "renew and restore" promise (H8).
        this.store.enqueue({ hostingInstanceId: committed.id, lifecycleVersion: committed.lifecycleVersion, generation: committed.generation, jobType: "delete", dedupeKey: `delete-confirm:${committed.id}:v${committed.lifecycleVersion}:${nowMs}`, availableAtMs: nowMs + 60_000, payload: {} }, nowMs);
      }
      this.store.releaseLease(committed.id, claim.token, nowMs);
    } catch (err) {
      this.store.releaseLease(row.id, claim.token, this.now());
      throw err;
    }
  }

  // ── late payment (during/after an irreversible delete) ──────────────────

  /** Called from `reconcileOwner`'s normal path when paid evidence arrives
   *  for an instance already `deleting`/`deleted` — `RECOVERABLE_STAGES`
   *  excludes those stages on purpose, so `restore()` is never reached for
   *  them; this is the alternate branch that IS reached. Never restores,
   *  never re-creates; records the fact and emails the exception template.
   *  Refund resolution remains explicitly pending operator confirmation;
   *  neither state nor customer copy claims money moved before it did. */
  private notifyLatePayment(row: HostingInstanceRow, nowMs: number): void {
    const marker = "late_payment_resolution_required";
    // Deduped on the marker itself, not on `nowMs` — `paidThroughMs` is
    // deliberately left untouched on a deleted/deleting instance (moving it
    // would make this instance look like it has fresh paid entitlement), so
    // WITHOUT this guard `applyBillingSignal` would re-derive
    // `paidThroughAdvanced` as true and re-notify on every single tick.
    if (row.failureReason === marker) return;
    this.store.updateInstance(row.id, row.version, (d) => { d.failureReason = marker; }, nowMs);
    this.store.enqueue({ hostingInstanceId: row.id, lifecycleVersion: row.lifecycleVersion, generation: row.generation, jobType: "email", dedupeKey: `email:late_payment:${row.id}:g${row.generation}`, availableAtMs: nowMs, payload: { template: "late_payment" } }, nowMs);
    this.log(`[hosting] ${row.id}: LATE PAYMENT after deletion — operator payment resolution is required; tell the customer to buy a fresh VPS only after it is confirmed. Never mark this instance ready.`);
  }

  // ── emails ────────────────────────────────────────────────────────────────

  private async drainEmail(row: HostingInstanceRow, template: string, nowMs: number): Promise<void> {
    const cfg = this.billing.config().email;
    const email = this.emailFor(row.ownerId);
    if (!email) { this.log(`[hosting] ${row.id}: no email on file for ${row.ownerId} — cannot send "${template}"`); return; }
    const msg = this.buildEmail(row, template, cfg, nowMs);
    if (!msg) return;
    const r = await sendEmail(cfg, { ...msg, to: email }, this.fetchLike);
    if (!r.ok) throw new Error(`send failed: ${r.error}`);
    if (template === "installation_ready") {
      const current = this.store.getInstance(row.id);
      if (current) this.store.updateInstance(current.id, current.version, (d) => {
        d.bootstrapTokenHash = null;
        d.bootstrapTokenExpiresAtMs = null;
      }, nowMs);
    }
  }

  private emailFor(ownerId: string): string {
    const rec = this.billing.store.getCustomer(ownerId);
    if (rec?.email) return rec.email;
    return ownerId.startsWith("email:") ? ownerId.slice("email:".length) : "";
  }

  private buildEmail(row: HostingInstanceRow, template: string, cfg: EmailConfig, nowMs: number) {
    const policy = this.policy();
    const ref = row.id;
    const manageUrl = `${this.origin}/customer#hosting`;
    const priceLabel = `$${(policy.monthlyPriceCents / 100).toFixed(2)}`;
    const [cpu = policy.planLabel, ram = "see plan", storage = "see plan"] = policy.planLabel.split(/\s*\/\s*/);
    switch (template) {
      case "installation_ready":
        return tmpl.installationReadyEmail("", "", {
          instanceReference: ref, appUrl: row.appUrl ?? "", region: policy.regions.find((r) => r.id === row.region)?.label ?? row.region,
          cpu, ram, storage, os: "Ubuntu 24.04 LTS x64", ip: row.ip ?? "",
          appUsername: "admin", sshUsername: "root", sshPort: 22, accessUrl: manageUrl,
          temporaryPassword: row.bootstrapTokenHash ? bootstrapPasswordFromTokenHash(row.bootstrapTokenHash) : "",
          maximumConnectedAccounts: policy.maximumConnectedAccounts,
          monthlyPriceLabel: priceLabel, renewalAt: row.paidThroughMs, backupScopeSentence: policy.managedBackupsIncluded ? "Backups are included." : "No managed backups are included at this time — export your settings while the server is active.",
        });
      case "cancellation_scheduled":
        return tmpl.cancellationScheduledEmail("", ref, row.suspendAtMs ?? nowMs, row.deleteAtMs ?? nowMs, manageUrl);
      case "overdue":
        return tmpl.overdueEmail("", ref, row.suspendAtMs ?? nowMs, row.deleteAtMs ?? nowMs, manageUrl, "");
      case "suspended":
        return tmpl.suspendedEmail("", ref, row.deleteAtMs ?? nowMs, manageUrl);
      case "three_days":
        return tmpl.threeDayReminderEmail("", ref, row.deleteAtMs ?? nowMs, manageUrl, policy.managedBackupsIncluded ? "" : "No managed backups are included — this data cannot be recovered afterward.");
      case "one_day":
        return tmpl.oneDayReminderEmail("", ref, row.deleteAtMs ?? nowMs, manageUrl);
      case "restored":
        return tmpl.restoredEmail("", ref, row.appUrl ?? "", row.paidThroughMs, "Bots saved as enabled may resume through their normal readiness, admission, and protection gates; bots saved as paused remain paused.");
      case "terminated":
        return tmpl.terminatedEmail("", ref, row.terminatedAtMs ?? nowMs, "Hosting billing has been stopped for this server.", manageUrl);
      case "setup_failure":
        return tmpl.exceptionEmail("", "setup_failure", ref, row.failureReason ?? "Setup did not complete.", manageUrl);
      case "late_payment":
        return tmpl.exceptionEmail("", "late_payment_after_deletion", ref, "This server was already permanently deleted and its data cannot be recovered. Support must confirm the hosting payment resolution before any refund is considered complete.", manageUrl);
      default:
        return null;
    }
  }

  // ── best-effort Stripe subscription control (never exercised in tests) ──

  private async bestEffortCancelStripeSubscription(subscriptionId: string, nowMs: number): Promise<void> {
    const cfg = this.billing.config();
    const mode = cfg.mode;
    const key = cfg.stripe[mode].secretKey;
    if (!key) return;
    try {
      const response = await this.stripeFetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body: "cancel_at_period_end=true",
      });
      if (!response.ok) throw new Error(`Stripe returned HTTP ${response.status}`);
    } catch (err) { this.log(`[hosting] could not schedule Stripe cancellation for ${subscriptionId}: ${(err as Error).message}`); }
    void nowMs;
  }
  private async bestEffortResumeStripeSubscription(subscriptionId: string, nowMs: number): Promise<void> {
    const cfg = this.billing.config();
    const mode = cfg.mode;
    const key = cfg.stripe[mode].secretKey;
    if (!key) return;
    try {
      const response = await this.stripeFetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body: "cancel_at_period_end=false",
      });
      if (!response.ok) throw new Error(`Stripe returned HTTP ${response.status}`);
    } catch (err) { this.log(`[hosting] could not un-cancel Stripe subscription ${subscriptionId}: ${(err as Error).message}`); }
    void nowMs;
  }

  private async setStripeCancellation(subscriptionId: string, cancelAtPeriodEnd: boolean): Promise<boolean> {
    const cfg = this.billing.config();
    const key = cfg.stripe[cfg.mode].secretKey;
    if (!key) return false;
    try {
      const response = await this.stripeFetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body: `cancel_at_period_end=${cancelAtPeriodEnd ? "true" : "false"}`,
      });
      return response.ok;
    } catch { return false; }
  }

  private enqueueStripeCancellation(row: HostingInstanceRow, subscriptionId: string, reason: string, nowMs: number): void {
    this.store.enqueue({
      hostingInstanceId: row.id, lifecycleVersion: row.lifecycleVersion, generation: row.generation,
      jobType: "billing_reconcile", dedupeKey: `stripe-cancel:${row.id}:${subscriptionId}:${reason}`,
      availableAtMs: nowMs, payload: { subscriptionId, action: "cancel", reason },
    }, nowMs);
  }

  private async stripeFetch(url: string, init: Parameters<EmailFetch>[1]): Promise<Awaited<ReturnType<EmailFetch>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.stripeTimeoutMs);
    try {
      return await this.fetchLike(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Stripe request timed out after ${this.stripeTimeoutMs}ms`);
      throw err;
    } finally { clearTimeout(timer); }
  }

  // ── admin actions ────────────────────────────────────────────────────────
  // Every admin route reads/writes through these, never touching the store
  // directly — the reason is `drainDelete`'s own gate (it refuses to
  // commit an irreversible delete on a row with no cancellation reason and
  // no expiry stage, exactly so a stray/late delete job can never fire on a
  // perfectly healthy paid instance): forcing a delete on an admin's say-so
  // has to go through the SAME shape a real expiry does, or the pipeline's
  // safety check would silently no-op the very action the operator asked
  // for.

  adminRetryProvisioning(instanceId: string, nowMs = this.now()): HostingActionResult<null> {
    const row = this.store.getInstance(instanceId);
    if (!row) return { ok: false, code: "NOT_FOUND", error: "unknown hosting instance" };
    const fresh = this.store.updateInstance(instanceId, row.version, (d) => { d.provisionAttempts = 0; d.failureReason = null; }, nowMs);
    if (!fresh) return { ok: false, code: "NOT_FOUND", error: "changed underneath the request" };
    this.enqueueProvisionJob(fresh, nowMs);
    return { ok: true, value: null };
  }

  adminForceSuspend(instanceId: string, reason: string, nowMs = this.now()): HostingActionResult<null> {
    const row = this.store.getInstance(instanceId);
    if (!row) return { ok: false, code: "NOT_FOUND", error: "unknown hosting instance" };
    if (TERMINAL_ISH.has(row.stage)) return { ok: false, code: "NOT_CANCELLABLE", error: "this instance is already deleting or deleted" };
    const fresh = this.store.updateInstance(instanceId, row.version, (d) => { d.suspendAtMs = nowMs; d.failureReason = reason || "suspended by an operator"; d.lifecycleVersion += 1; }, nowMs);
    if (!fresh) return { ok: false, code: "NOT_FOUND", error: "changed underneath the request" };
    this.store.enqueue({ hostingInstanceId: fresh.id, lifecycleVersion: fresh.lifecycleVersion, generation: fresh.generation, jobType: "suspend", dedupeKey: `admin-suspend:${fresh.id}:v${fresh.lifecycleVersion}`, availableAtMs: nowMs, payload: {} }, nowMs);
    return { ok: true, value: null };
  }

  /** Forces the SAME irreversible pipeline a real expiry uses
   *  (`drainDelete`), with `cancellationReason` set so its safety gate
   *  admits the row whatever stage it was in — a healthy `ready` instance
   *  included. `deleteAtMs` is set to `nowMs` so the job is immediately
   *  due; `suspendAtMs` is backfilled only if the row never had one, so a
   *  row already mid-expiry keeps its real suspend instant in the audit
   *  trail. */
  adminForceDelete(instanceId: string, reason: string, nowMs = this.now()): HostingActionResult<null> {
    const row = this.store.getInstance(instanceId);
    if (!row) return { ok: false, code: "NOT_FOUND", error: "unknown hosting instance" };
    if (row.stage === "deleted") return { ok: false, code: "NOT_CANCELLABLE", error: "already deleted" };
    // `drainDelete` would refuse this transition anyway while held — refuse
    // it HERE too, by name, so an admin gets an immediate answer rather
    // than a delete request that silently goes nowhere once it reaches the
    // outbox (see drainDelete's own `deletionHold` guard).
    if (row.deletionHold) return { ok: false, code: "NOT_CANCELLABLE", error: "this instance is on an admin deletion hold — release the hold before forcing deletion" };
    const fresh = this.store.updateInstance(instanceId, row.version, (d) => {
      d.cancellationReason = d.cancellationReason ?? "intentional_cancellation";
      d.suspendAtMs = d.suspendAtMs ?? nowMs;
      d.deleteAtMs = nowMs;
      d.failureReason = reason || "deletion forced by an operator";
      d.lifecycleVersion += 1;
    }, nowMs);
    if (!fresh) return { ok: false, code: "NOT_FOUND", error: "changed underneath the request" };
    this.store.enqueue({ hostingInstanceId: fresh.id, lifecycleVersion: fresh.lifecycleVersion, generation: fresh.generation, jobType: "delete", dedupeKey: `admin-delete:${fresh.id}:v${fresh.lifecycleVersion}`, availableAtMs: nowMs, payload: {} }, nowMs);
    return { ok: true, value: null };
  }

  /** POST /admin/api/hosting/instances/:id/hold. Places (or refreshes) a
   *  deletion hold — see `HostingDeletionHold` and `drainDelete`'s guard.
   *  Idempotent and safe to call on an already-held instance: `by`/`reason`
   *  are updated but `atMs` (the instant `adminReleaseHold` measures
   *  elapsed-held-time from) is NEVER moved forward by a repeat call, or a
   *  string of "still reviewing" hold refreshes would quietly reset the
   *  clock `deadlines()`'s `heldForMs` depends on. */
  adminHoldDeletion(instanceId: string, by: string, reason: string, nowMs = this.now()): HostingActionResult<null> {
    const row = this.store.getInstance(instanceId);
    if (!row) return { ok: false, code: "NOT_FOUND", error: "unknown hosting instance" };
    if (row.stage === "deleted") return { ok: false, code: "NOT_CANCELLABLE", error: "already deleted — nothing to hold" };
    const fresh = this.store.updateInstance(instanceId, row.version, (d) => {
      const hold: HostingDeletionHold = { by: by || "support", atMs: d.deletionHold?.atMs ?? nowMs, reason: reason || "on hold by support" };
      d.deletionHold = hold;
    }, nowMs);
    if (!fresh) return { ok: false, code: "NOT_FOUND", error: "changed underneath the request" };
    this.log(`[hosting] ${fresh.id}: deletion hold placed by ${fresh.deletionHold!.by} — ${fresh.deletionHold!.reason}`);
    return { ok: true, value: null };
  }

  /** POST /admin/api/hosting/instances/:id/release-hold. Clears the hold
   *  and — when the row is mid an expiry pipeline (`cancellationReason` +
   *  `suspendAtMs` set) — re-derives suspend/delete/reminder deadlines from
   *  the ORIGINAL nonpayment/cancel anchor (never from `nowMs`), shifted
   *  forward by exactly how long the hold was in effect
   *  (`deadlines()`'s `heldForMs`). The anchor is recovered from the row's
   *  OWN already-stored `suspendAtMs` (inverting `deadlines()`'s own
   *  arithmetic) rather than re-reading `paidThroughMs`, so this is exact
   *  even if something unrelated moved `paidThroughMs` afterward.
   *
   *  If the recomputed delete deadline is already in the past — the hold
   *  was placed at or after the original deadline had effectively arrived
   *  — deletion proceeds on the very next tick, with the ordinary single
   *  "terminated" email `drainDelete` sends on completion: pausing a clock
   *  that had already run out does not un-run it, and re-sending a "3 days
   *  left"/"1 day left" reminder for a deadline that is already gone would
   *  be dishonest. */
  adminReleaseHold(instanceId: string, nowMs = this.now()): HostingActionResult<null> {
    const row = this.store.getInstance(instanceId);
    if (!row) return { ok: false, code: "NOT_FOUND", error: "unknown hosting instance" };
    if (!row.deletionHold) return { ok: false, code: "NOT_CANCELLABLE", error: "this instance is not on hold" };
    const heldForMs = Math.max(0, nowMs - row.deletionHold.atMs);
    if (row.cancellationReason && row.suspendAtMs !== null) {
      const policy = this.policy();
      const anchor = row.cancellationReason === "renewal_unpaid" ? row.suspendAtMs - policy.renewalGraceHours * HOUR : row.suspendAtMs;
      const d = deadlines(anchor, row.cancellationReason, policy, heldForMs);
      const fresh = this.store.updateInstance(instanceId, row.version, (draft) => {
        draft.deletionHold = null;
        draft.suspendAtMs = d.suspendAt;
        draft.deleteAtMs = d.deleteAt;
        draft.lifecycleVersion += 1;
      }, nowMs);
      if (!fresh) return { ok: false, code: "NOT_FOUND", error: "changed underneath the request" };
      this.store.obsoletePendingJobsOlderThan(fresh.id, fresh.lifecycleVersion, fresh.generation, nowMs);
      this.requeueDeadlineJobsAfterHold(fresh, d, nowMs);
      this.log(`[hosting] ${fresh.id}: deletion hold released after ${(heldForMs / HOUR).toFixed(1)}h held — delete deadline now ${new Date(d.deleteAt).toISOString()}`);
      return { ok: true, value: null };
    }
    // No expiry pipeline on record (a hold placed pre-emptively, or on an
    // instance whose deadlines were never set) — just clear the hold; there
    // is nothing to re-arm.
    const fresh = this.store.updateInstance(instanceId, row.version, (draft) => { draft.deletionHold = null; }, nowMs);
    if (!fresh) return { ok: false, code: "NOT_FOUND", error: "changed underneath the request" };
    return { ok: true, value: null };
  }

  /** The reminder/suspend/delete jobs a released hold re-arms. Deliberately
   *  NOT `queueDeadlineJobs` (which also fires the immediate "overdue"/
   *  "cancellation_scheduled" notice — appropriate when an expiry pipeline
   *  FIRST begins, not on every hold release): the suspend/reminder jobs
   *  are skipped entirely once the recomputed delete deadline has already
   *  elapsed (see `adminReleaseHold`'s docstring) so the customer gets the
   *  one honest "terminated" email instead of a burst of stale reminders;
   *  the delete job is always (re)queued, whatever its `availableAtMs`. */
  private requeueDeadlineJobsAfterHold(row: HostingInstanceRow, d: HostingDeadlines, nowMs: number): void {
    const base = { hostingInstanceId: row.id, lifecycleVersion: row.lifecycleVersion, generation: row.generation };
    if (d.deleteAt > nowMs) {
      this.store.enqueue({ ...base, jobType: "email", dedupeKey: `email:three_days:${row.id}:v${row.lifecycleVersion}`, availableAtMs: d.threeDaysAt, payload: { template: "three_days" } }, nowMs);
      this.store.enqueue({ ...base, jobType: "email", dedupeKey: `email:one_day:${row.id}:v${row.lifecycleVersion}`, availableAtMs: d.oneDayAt, payload: { template: "one_day" } }, nowMs);
      this.store.enqueue({ ...base, jobType: "suspend", dedupeKey: `suspend:${row.id}:v${row.lifecycleVersion}`, availableAtMs: d.suspendAt, payload: {} }, nowMs);
    }
    this.store.enqueue({ ...base, jobType: "delete", dedupeKey: `delete:${row.id}:v${row.lifecycleVersion}`, availableAtMs: d.deleteAt, payload: {} }, nowMs);
  }

  // ── views ────────────────────────────────────────────────────────────────

  customerView(ownerId: string, nowMs = this.now()): HostingCustomerView {
    const environment = this.billing.config().mode;
    const row = this.store.activeInstanceForOwner(ownerId, environment) ?? this.store.activeInstanceForOwner(ownerId, environment === "live" ? "test" : "live");
    const policy = this.policy();
    if (!row) {
      const issue = this.hostingOfferIssue();
      return { available: issue === null, hasInstance: false, note: issue, plans: this.hostingPlanKeys(), monthlyPriceLabel: `$${(policy.monthlyPriceCents / 100).toFixed(2)}`, maximumConnectedAccounts: policy.maximumConnectedAccounts, instance: null };
    }
    return {
      available: true, hasInstance: true, note: null, plans: this.hostingPlanKeys(), monthlyPriceLabel: `$${(policy.monthlyPriceCents / 100).toFixed(2)}`, maximumConnectedAccounts: policy.maximumConnectedAccounts,
      instance: instanceView(row, policy, nowMs),
    };
  }
}

export interface HostingInstanceView {
  id: string;
  stage: HostingStage;
  operationalHealth: string;
  region: string;
  regionLabel: string;
  ip: string | null;
  appUrl: string | null;
  planLabel: string;
  paidThroughMs: number | null;
  suspendAtMs: number | null;
  deleteAtMs: number | null;
  cancellationReason: string | null;
  failureReason: string | null;
  /** True while an admin deletion hold is in effect on this instance. When
   *  true, `suspendAtMs`/`deleteAtMs` are masked to `null` (no dates) and
   *  `failureReason` carries the one customer-safe sentence — see
   *  `instanceView`. */
  onHold: boolean;
  monthlyPriceLabel: string;
  managedBackupsIncluded: boolean;
  maximumConnectedAccounts: number;
}
export interface HostingCustomerView {
  available: boolean;
  hasInstance: boolean;
  note: string | null;
  plans: string[];
  monthlyPriceLabel: string;
  maximumConnectedAccounts: number;
  instance: HostingInstanceView | null;
}

function instanceView(row: HostingInstanceRow, policy: HostingPolicy, _nowMs: number): HostingInstanceView {
  // On hold: no dates ("Scheduled for permanent deletion at …" would be a
  // lie — the pipeline is paused), and the one customer-safe sentence in
  // place of any real failureReason (an operational failure note is not
  // what is going on here, and stacking both would read as two problems).
  const onHold = row.deletionHold !== null;
  return {
    id: row.id, stage: row.stage, operationalHealth: row.operationalHealth,
    region: row.region, regionLabel: policy.regions.find((r) => r.id === row.region)?.label ?? row.region,
    ip: row.ip, appUrl: row.appUrl, planLabel: policy.planLabel,
    paidThroughMs: row.paidThroughMs,
    suspendAtMs: onHold ? null : row.suspendAtMs,
    deleteAtMs: onHold ? null : row.deleteAtMs,
    cancellationReason: row.cancellationReason,
    failureReason: onHold ? "This server is on hold by support." : row.failureReason,
    onHold,
    monthlyPriceLabel: `$${(policy.monthlyPriceCents / 100).toFixed(2)}`, managedBackupsIncluded: policy.managedBackupsIncluded,
    maximumConnectedAccounts: policy.maximumConnectedAccounts,
  };
}

const RECOVERABLE_STAGES = new Set<HostingStage>(["past_due", "cancel_scheduled", "suspended", "restoring"]);
const TERMINAL_ISH = new Set<HostingStage>(["deleting", "deleted"]);

function paidEvidenceExists(sub: RoleSubscriptionRecord): boolean {
  return sub.subscriptionStatus === "active" || sub.subscriptionStatus === "active (cancels at period end)" || sub.subscriptionStatus === "trialing" || (sub.periodEndMs !== null && sub.periodEndMs > 0);
}
function hostingBillingFlagNote(signal: BillingSignal): string {
  const parts: string[] = [];
  if (signal.disputed) parts.push("a charge on this hosting subscription is under dispute");
  if (signal.refunded) parts.push("a hosting charge was fully refunded");
  return parts.join("; ");
}
function sha1short(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (Math.imul(h, 31) + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
