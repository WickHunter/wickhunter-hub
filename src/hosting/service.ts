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
import { HostingStore, type HostingInstanceRow, type HostingOutboxRow, type HostingStage } from "./store.js";
import { readHostingPolicy, readHostingSecrets, type HostingPolicy } from "./policy.js";
import { deadlines, type HostingDeadlines, type HostingEndReason } from "./deadlines.js";
import { readinessVerdict, type ProbeResult, type ReadinessVerdict } from "./readiness.js";
import { hostingInstanceLabel, hashBootstrapToken, mintBootstrapToken, FakeProvider, VultrProvider, type HostingProvider } from "./provider.js";
import { buildBootstrapUserData } from "./bootstrap.js";
import * as tmpl from "./emails.js";

const HOUR = 60 * 60 * 1000;
const MAX_PROVISION_ATTEMPTS = 3;
const LEASE_TTL_MS = 2 * 60_000;
const PROVISION_RETRY_BACKOFF_MS = 30_000;

const realFetch: EmailFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
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

  /** POST /api/hosting/checkout — returns the URL to redirect to (the
   *  EXISTING `/buy?plan=` rail, §3/H4 acceptance case: "through the
   *  existing rail"). Stripe Payment Links have no server-side
   *  "attach to this exact customer" parameter, so the email is passed as
   *  `prefilled_email` — Stripe matches an existing customer by email on
   *  its own when one exists for that email in this mode; this is a real
   *  gap against "the SAME Stripe customer ID" and is called out in the
   *  delivery report. */
  checkoutUrl(ownerId: string, email: string, nowMs = this.now()): HostingActionResult<{ url: string }> {
    const cfg = this.billing.config();
    const mode = cfg.mode;
    const environment = mode; // "test"|"live" lines up 1:1 with billing's own mode
    if (!this.softwareEligible(ownerId, nowMs)) return { ok: false, code: "SOFTWARE_LICENSE_REQUIRED", error: "an eligible Unleashed software license is required before adding hosting" };
    if (this.store.activeInstanceForOwner(ownerId, environment)) return { ok: false, code: "HOSTING_ALREADY_EXISTS", error: "you already have a hosting instance — manage it from this page" };
    const planKey = this.hostingPlanKeys()[0];
    if (!planKey) return { ok: false, code: "PROVISIONING_DISABLED", error: "hosting is not yet configured for purchase on this Hub" };
    const url = `${this.origin}/buy?plan=${encodeURIComponent(planKey)}${email ? `&prefilled_email=${encodeURIComponent(email)}` : ""}`;
    return { ok: true, value: { url } };
  }

  // ── the derive-from-billing-record reconciliation (the whole engine) ────

  /** Walk every owner with a hosting relationship: every
   *  RoleSubscriptionRecord("hosting") AND every existing hosting instance
   *  (so an owner whose role record was somehow lost still gets its
   *  instance's own time-driven jobs drained). Safe to call as often as
   *  wanted; every step is idempotent. */
  reconcileAll(nowMs = this.now()): void {
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
      // A DELETED instance frees the owner's reservation slot (H6 §17: "a
      // returning customer receives a new instance only through an
      // EXPLICIT new purchase") — but recurring billing evidence for the
      // SAME subscription that instance was terminated for is exactly the
      // late-payment case (§8/§11 case 15), not a new purchase. Only a
      // DIFFERENT subscription id (a genuinely new Stripe Checkout) may
      // provision here; the same id routes to `notifyLatePayment` instead
      // via the terminated instance it names — never silently reused, and
      // never silently ignored.
      const priorTerminated = this.store.instances().find((r) => r.ownerId === ownerId && r.environment === environment && r.stage === "deleted");
      if (priorTerminated && priorTerminated.stripeSubscriptionId && priorTerminated.stripeSubscriptionId === sub.subscriptionId) {
        this.notifyLatePayment(priorTerminated, nowMs);
        return;
      }
      instance = this.provisionNewInstance(ownerId, sub, nowMs);
      if (!instance) return; // lost the reservation race to a concurrent call — the winner already reconciled
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
      const withId = this.store.updateInstance(instance.id, instance.version, (d) => { d.stripeSubscriptionId = sub.subscriptionId; }, nowMs);
      if (withId) instance = withId;
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
      this.scheduleEnd(instance, "renewal_unpaid", instance.paidThroughMs ?? nowMs, policy, nowMs);
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
   *  `restoring`. NEVER jumps straight to `ready`/`active` — "restore
   *  always boots paused" is enforced by `drainRestore` requiring a fresh
   *  provider health read before advancing past this stage (H6/§11 case
   *  11). Irreversible deletion is a hard wall: once `stage === "deleting"`
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
    const policy = this.policy();
    const anchor = row.paidThroughMs ?? nowMs;
    this.scheduleEnd(row, "intentional_cancellation", anchor, policy, nowMs);
    const sub = this.billing.store.getRoleSubscription(ownerId, "hosting");
    if (sub?.subscriptionId) this.bestEffortCancelStripeSubscription(sub.subscriptionId, nowMs);
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
    const fresh = this.store.updateInstance(row.id, row.version, (d) => {
      d.cancellationReason = null; d.suspendAtMs = null; d.deleteAtMs = null; d.stage = "ready"; d.lifecycleVersion += 1;
    }, nowMs);
    if (!fresh) return { ok: false, code: "NOT_FOUND", error: "this hosting instance changed underneath the request — reload and try again" };
    this.store.obsoletePendingJobsOlderThan(fresh.id, fresh.lifecycleVersion, fresh.generation, nowMs);
    const sub = this.billing.store.getRoleSubscription(ownerId, "hosting");
    if (sub?.subscriptionId) this.bestEffortResumeStripeSubscription(sub.subscriptionId, nowMs);
    return { ok: true, value: { stage: fresh.stage } };
  }

  private owned(ownerId: string, instanceId: string): HostingInstanceRow | null {
    const row = this.store.getInstance(instanceId);
    return row && row.ownerId === ownerId ? row : null;
  }

  // ── readiness callback ───────────────────────────────────────────────────

  /** POST /api/hosting/instances/:id/readiness. Verifies the presented
   *  bootstrap token against the STORED hash (never accepted in plaintext
   *  anywhere else — the token itself never appears in a log line here).
   *  A late callback from a torn-down/replaced generation is refused by
   *  comparing the presented generation against the row's CURRENT one
   *  (H6: "late callbacks from a failed/replaced instance must not mark
   *  the replacement ready"). */
  reportReadiness(instanceId: string, presentedToken: string, generation: number, results: readonly ProbeResult[], nowMs = this.now()): HostingActionResult<{ ready: boolean }> {
    const row = this.store.getInstance(instanceId);
    if (!row) return { ok: false, code: "NOT_FOUND", error: "unknown instance" };
    if (row.generation !== generation) return { ok: false, code: "NOT_FOUND", error: "stale generation — this callback belongs to a replaced instance" };
    if (!row.bootstrapTokenHash || row.bootstrapTokenExpiresAtMs === null || row.bootstrapTokenExpiresAtMs < nowMs || hashBootstrapToken(presentedToken) !== row.bootstrapTokenHash) {
      return { ok: false, code: "NOT_FOUND", error: "invalid or expired bootstrap token" };
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
    } else {
      this.handleReadinessRefusal(fresh, verdict, policy, nowMs);
    }
    return { ok: true, value: { ready: verdict.ready } };
  }

  private markReady(row: HostingInstanceRow, nowMs: number): void {
    // Both entrances (fresh provisioning and a restore) land here, and both
    // land on the SAME stage — "ready", never "active" — because neither a
    // fresh install nor a restore is evidence bots are safe to resume; see
    // the docstring on `restore()` ("restore always boots paused").
    const fresh = this.store.updateInstance(row.id, row.version, (d) => {
      d.stage = "ready";
      d.operationalHealth = "healthy";
      d.failureReason = null;
      d.pendingRestore = false;
    }, nowMs);
    if (!fresh) return;
    // `row.stage` (the STAGE at the moment readiness confirmed) is
    // "bootstrapping" whether this was a fresh install or a restore —
    // `drainProvision` runs the identical stage sequence for both, on
    // purpose (a restore re-earns readiness through the same gate a fresh
    // install does). `pendingRestore` is what survives across that job to
    // tell the two apart here.
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
        d.region = nextRegion.id;
        d.regionAttempts = [...d.regionAttempts, row.region];
        d.stage = "provisioning";
        d.operationalHealth = "unhealthy";
        d.failureReason = `readiness refused in ${row.region}: ${verdict.refusals.join("; ")} — retrying once in ${nextRegion.label}`;
      }, nowMs);
      if (fresh) {
        this.log(`[hosting] ${row.id}: readiness refused in ${row.region}, retrying once in ${nextRegion.id}`);
        this.enqueueProvisionJob(fresh, nowMs);
      }
      return;
    }
    this.store.updateInstance(row.id, row.version, (d) => {
      d.operationalHealth = "unhealthy";
      d.failureReason = `Hosting is not available in an exchange-approved region right now — ${verdict.refusals.join("; ")}`;
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
      case "suspend": return this.drainSuspend(row, nowMs);
      case "delete": return this.drainDelete(row, nowMs);
      case "email": return this.drainEmail(row, String((job.payload as any).template ?? ""), nowMs);
      default: return;
    }
  }

  // ── provisioning ─────────────────────────────────────────────────────────

  private async drainProvision(row: HostingInstanceRow, nowMs: number): Promise<void> {
    const policy = this.policy();
    if (!policy.provisioningEnabled) { this.log(`[hosting] ${row.id}: provisioning is disabled on this Hub (policy.provisioningEnabled=false) — leaving ${row.stage}`); return; }
    const provider = this.provider();
    if (!provider) { this.log(`[hosting] ${row.id}: no provider configured — cannot provision`); return; }
    if (row.provisionAttempts >= MAX_PROVISION_ATTEMPTS) { this.failProvisioning(row, `setup failed after ${row.provisionAttempts} attempts`, nowMs); return; }

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
      const userData = buildBootstrapUserData({
        instanceId: row.id, generation: row.generation, bootstrapToken: rawToken,
        hubOrigin: this.origin, releaseRef: policy.releaseRef,
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
      const current = this.store.getInstance(row.id);
      if (current) this.store.updateInstance(row.id, current.version, (d) => {
        d.bootstrapTokenHash = hashBootstrapToken(rawToken);
        d.bootstrapTokenExpiresAtMs = nowMs + policy.bootstrapTokenTtlMinutes * 60_000;
      }, nowMs);
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
      availableAtMs: nowMs + 15 * 60_000, payload: { kind: "bootstrap-timeout" },
    }, nowMs);
  }

  private failProvisioning(row: HostingInstanceRow, reason: string, nowMs: number): void {
    this.store.updateInstance(row.id, row.version, (d) => { d.operationalHealth = "unhealthy"; d.failureReason = reason; }, nowMs);
    this.store.enqueue({ hostingInstanceId: row.id, lifecycleVersion: row.lifecycleVersion, generation: row.generation, jobType: "email", dedupeKey: `email:setup_failure:${row.id}:g${row.generation}`, availableAtMs: nowMs, payload: { template: "setup_failure" } }, nowMs);
    const sub = this.billing.store.getRoleSubscription(row.ownerId, "hosting");
    if (sub?.subscriptionId) this.bestEffortCancelStripeSubscription(sub.subscriptionId, nowMs);
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
        const done = this.store.updateInstance(committed.id, committed.version, (d) => { d.stage = "deleted"; d.providerDeletedAtMs = nowMs; d.terminatedAtMs = nowMs; }, nowMs);
        if (done) {
          this.store.enqueue({ hostingInstanceId: done.id, lifecycleVersion: done.lifecycleVersion, generation: done.generation, jobType: "email", dedupeKey: `email:terminated:${done.id}:g${done.generation}`, availableAtMs: nowMs, payload: { template: "terminated" } }, nowMs);
          const sub = this.billing.store.getRoleSubscription(done.ownerId, "hosting");
          if (sub?.subscriptionId) this.bestEffortCancelStripeSubscription(sub.subscriptionId, nowMs);
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
   *  The actual refund is a REAL Stripe call, best-effort, logged on
   *  failure for operator follow-up — this repo makes no live call in
   *  tests (see the provider/Stripe fetch seam). */
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
    this.log(`[hosting] ${row.id}: LATE PAYMENT after deletion — refund the hosting payment (idempotent) and tell the customer to buy a fresh VPS. Never mark this instance ready.`);
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
    switch (template) {
      case "installation_ready":
        return tmpl.installationReadyEmail("", "", {
          instanceReference: ref, appUrl: row.appUrl ?? "", region: policy.regions.find((r) => r.id === row.region)?.label ?? row.region,
          cpu: "1 vCPU", ram: "2 GB", storage: "55 GB SSD", os: "Ubuntu (pinned)", ip: row.ip ?? "",
          appUsername: "admin", sshUsername: "root", sshPort: 22, accessUrl: manageUrl,
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
        return tmpl.restoredEmail("", ref, row.appUrl ?? "", row.paidThroughMs, "Your bots are paused and were not automatically resumed.");
      case "terminated":
        return tmpl.terminatedEmail("", ref, row.terminatedAtMs ?? nowMs, "Hosting billing has been stopped for this server.", manageUrl);
      case "setup_failure":
        return tmpl.exceptionEmail("", "setup_failure_refunded", ref, row.failureReason ?? "Setup did not complete.", manageUrl);
      case "late_payment":
        return tmpl.exceptionEmail("", "late_payment_after_deletion", ref, "This server was already permanently deleted and its data cannot be recovered. The payment will be refunded.", manageUrl);
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
      await this.fetchLike(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body: "cancel_at_period_end=true",
      });
    } catch (err) { this.log(`[hosting] could not schedule Stripe cancellation for ${subscriptionId}: ${(err as Error).message}`); }
    void nowMs;
  }
  private async bestEffortResumeStripeSubscription(subscriptionId: string, nowMs: number): Promise<void> {
    const cfg = this.billing.config();
    const mode = cfg.mode;
    const key = cfg.stripe[mode].secretKey;
    if (!key) return;
    try {
      await this.fetchLike(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body: "cancel_at_period_end=false",
      });
    } catch (err) { this.log(`[hosting] could not un-cancel Stripe subscription ${subscriptionId}: ${(err as Error).message}`); }
    void nowMs;
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

  // ── views ────────────────────────────────────────────────────────────────

  customerView(ownerId: string, nowMs = this.now()): HostingCustomerView {
    const environment = this.billing.config().mode;
    const row = this.store.activeInstanceForOwner(ownerId, environment) ?? this.store.activeInstanceForOwner(ownerId, environment === "live" ? "test" : "live");
    const policy = this.policy();
    if (!row) {
      return { available: true, hasInstance: false, note: null, plans: this.hostingPlanKeys(), monthlyPriceLabel: `$${(policy.monthlyPriceCents / 100).toFixed(2)}`, instance: null };
    }
    return {
      available: true, hasInstance: true, note: null, plans: this.hostingPlanKeys(), monthlyPriceLabel: `$${(policy.monthlyPriceCents / 100).toFixed(2)}`,
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
  monthlyPriceLabel: string;
  managedBackupsIncluded: boolean;
}
export interface HostingCustomerView {
  available: boolean;
  hasInstance: boolean;
  note: string | null;
  plans: string[];
  monthlyPriceLabel: string;
  instance: HostingInstanceView | null;
}

function instanceView(row: HostingInstanceRow, policy: HostingPolicy, _nowMs: number): HostingInstanceView {
  return {
    id: row.id, stage: row.stage, operationalHealth: row.operationalHealth,
    region: row.region, regionLabel: policy.regions.find((r) => r.id === row.region)?.label ?? row.region,
    ip: row.ip, appUrl: row.appUrl, planLabel: policy.planLabel,
    paidThroughMs: row.paidThroughMs, suspendAtMs: row.suspendAtMs, deleteAtMs: row.deleteAtMs,
    cancellationReason: row.cancellationReason, failureReason: row.failureReason,
    monthlyPriceLabel: `$${(policy.monthlyPriceCents / 100).toFixed(2)}`, managedBackupsIncluded: policy.managedBackupsIncluded,
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
