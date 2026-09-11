// src/hosting/store.ts
// The durable, transactional hosting store (H4). File-backed, following this
// Hub's existing pattern (src/jsonfile.ts: write tmp-then-rename, so a crash
// mid-write can never leave a torn file) rather than introducing node:sqlite
// — every other store in this repo is zero-runtime-dependency JSON, and
// "keep the established software files readable while introducing the new
// hosting store" (H4) reads as "match the pattern", not "match the file
// count".
//
// WHY ONE FILE FOR FOUR "TABLES": the handoff's own words are "outbox
// insertion and lifecycle changes must be in the same database transaction"
// and "do not claim cross-file atomicity". This process is single-threaded
// and every mutation below runs inside `mutate()`, whose callback is
// SYNCHRONOUS BY TYPE (no `await` can appear inside it — TypeScript enforces
// this: an async callback cannot satisfy `(db: HostingDb) => T`). Node never
// interleaves two synchronous callbacks, so read-whole-file -> mutate ->
// write-whole-file is a real transaction: either every change `mutate` made
// (an instance's stage AND its outbox job together) is durable, or the
// original file is untouched (mutate threw -> nothing is written) and the
// crash-recovery path re-derives the same decision on the next attempt.
// hosting_billing_inbox lives in the SAME file for the same reason: a paid
// invoice recorded but not yet reflected in the instance row is exactly the
// half-applied state H4 warns about.
//
// CAS + LEASES live on the row itself (`version`, `leaseToken`/
// `leaseUntilMs`) rather than as a separate table — there is only ever one
// writer process, so a lease exists to bound a CRASHED operation's hold
// across process restarts (an operation that dies mid-await, e.g. a Vultr
// call that never returns), not to arbitrate concurrent writers within one
// process (the synchronous `mutate` already does that).
import path from "node:path";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { readJson, writeJsonAtomic } from "../jsonfile.js";

export const HOSTING_DB_FILE = "hosting-db.v1.json";

export type HostingEnvironment = "test" | "live";

export type HostingStage =
  | "ordered"
  | "provisioning"
  | "bootstrapping"
  | "ready"
  | "active"
  | "past_due"
  | "cancel_scheduled"
  | "suspended"
  | "restoring"
  | "deleting"
  | "deleted";

export const TERMINAL_STAGES: readonly HostingStage[] = ["deleted"];

export interface ReadinessRecord {
  checkedAtMs: number;
  ready: boolean;
  refusals: readonly string[];
  regionTried: string;
}

/** An admin's durable claim that this instance must never move toward
 *  `deleting`/`deleted` — see `HostingService.adminHoldDeletion`/
 *  `adminReleaseHold` (src/hosting/service.ts). `atMs` is the instant the
 *  hold was FIRST placed and never moves on a repeated hold call (it is
 *  what a release measures elapsed-held-time against — never "by" alone,
 *  since "who" is for the admin panel/audit trail and carries no policy
 *  meaning). `reason` is customer-safe text ("on hold by support" is the
 *  default the customer card shows; the admin panel may show more). */
export interface HostingDeletionHold {
  by: string;
  atMs: number;
  reason: string;
}

export interface HostingInstanceRow {
  id: string;
  /** Billing customer key — the SAME key space as
   *  `billing/store.ts`'s `RoleSubscriptionRecord.customerKey`
   *  (`cus_...` or `email:...`), so "one instance per owner" and "one
   *  hosting RoleSubscriptionRecord per owner" are the same identity. */
  ownerId: string;
  environment: HostingEnvironment;
  region: string;
  planId: string;
  stage: HostingStage;
  operationalHealth: "unknown" | "healthy" | "unhealthy";
  /** Bumped on every entitlement/deadline-affecting change (a paid
   *  renewal, an admin reschedule, a cancellation). Notices carry the
   *  version they were queued under; a stale version means "obsolete". */
  lifecycleVersion: number;
  /** Bumped only when a REPLACEMENT provider resource is created for this
   *  instance (a failed provision retried from scratch, an admin-forced
   *  rebuild) — never on an ordinary billing/stage change. */
  generation: number;
  providerAccountRef: string;
  providerInstanceId: string | null;
  /** The provider's own monthly cost for `planId`, in cents — captured
   *  once from `provider.listPlans()` the first time this instance is
   *  provisioned (`HostingService.drainProvision`), never guessed and
   *  never defaulted to 0. `null` until captured; `HostingService.
   *  projectedMonthlyProviderCostCents()` treats any non-deleted instance
   *  with a `null` here as making the WHOLE projection unknown, since
   *  silently treating an unread cost as free would understate spend. */
  providerPlanMonthlyCostCents: number | null;
  label: string;
  ip: string | null;
  appUrl: string | null;
  bootstrapTokenHash: string | null;
  bootstrapTokenExpiresAtMs: number | null;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  paidThroughMs: number | null;
  cancellationReason: "renewal_unpaid" | "intentional_cancellation" | null;
  suspendAtMs: number | null;
  deleteAtMs: number | null;
  /** Non-null while an admin deletion hold is in effect — see
   *  `HostingDeletionHold`. `HostingService.tick()`'s delete pipeline
   *  (`drainDelete`) refuses to transition this row toward
   *  `deleting`/`deleted` while this is set, whatever `deleteAtMs` says. */
  deletionHold: HostingDeletionHold | null;
  irreversibleDeleteCommittedAtMs: number | null;
  providerDeletedAtMs: number | null;
  terminatedAtMs: number | null;
  lastBillingCheckAtMs: number | null;
  lastProviderCheckAtMs: number | null;
  readiness: ReadinessRecord | null;
  /** Regions already attempted THIS generation — the "fallback region once"
   *  rule (H6) reads this to refuse a second fallback. Reset to [] on a new
   *  generation. */
  regionAttempts: string[];
  /** Set by `restore()`, left untouched by an ordinary provisioning pass
   *  (`drainProvision` always transitions through the SAME
   *  provisioning/bootstrapping stages whether this is a fresh install or a
   *  restore, so the STAGE alone cannot tell `markReady` which email to
   *  send once readiness confirms) — cleared the moment `markReady` acts on
   *  it, whichever way readiness comes back. */
  pendingRestore: boolean;
  /** The last operator/system-facing reason a provisioning or delete attempt
   *  did not complete — cleared on the next successful transition. */
  failureReason: string | null;
  provisionAttempts: number;
  /** The current in-flight destructive-operation claim, if any (H6's
   *  delete-transaction lock/lease). Bounded: an operation must renew or
   *  release it, and a stale lease (past `leaseUntilMs`) may be reclaimed. */
  leaseToken: string | null;
  leaseUntilMs: number | null;
  /** Optimistic-concurrency version. Every `updateInstance` bumps it. */
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface HostingResourceRow {
  id: string;
  hostingInstanceId: string;
  generation: number;
  providerAccountRef: string;
  resourceType: string;
  providerResourceId: string;
  exclusivelyOwned: boolean;
  cleanupState: "present" | "removed";
  createdAtMs: number;
  removedAtMs: number | null;
}

export interface HostingInboxRow {
  environment: HostingEnvironment;
  eventId: string;
  eventType: string;
  objectId: string;
  status: "received" | "processed";
  receivedAtMs: number;
  processedAtMs: number | null;
}

export type HostingJobType =
  | "email"
  | "provision"
  | "readiness_probe"
  | "readiness_recheck"
  | "billing_reconcile"
  | "suspend"
  | "delete"
  | "notice_recompute";

export interface HostingOutboxRow {
  id: string;
  hostingInstanceId: string;
  lifecycleVersion: number;
  generation: number;
  jobType: HostingJobType;
  /** Unique across the whole outbox — the de-dup key H4/§9 both call for
   *  (instance id + generation + lifecycle version + job/notice type). */
  dedupeKey: string;
  availableAtMs: number;
  payload: Record<string, unknown>;
  status: "pending" | "sent" | "obsolete" | "failed";
  attemptCount: number;
  leaseUntilMs: number | null;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

interface HostingDb {
  v: 1;
  instances: Record<string, HostingInstanceRow>;
  resources: Record<string, HostingResourceRow>;
  inbox: Record<string, HostingInboxRow>;
  outbox: Record<string, HostingOutboxRow>;
}

function emptyDb(): HostingDb {
  return { v: 1, instances: bare(), resources: bare(), inbox: bare(), outbox: bare() };
}

/** Plain-object maps with no prototype: keys can be Stripe customer ids,
 *  emails, or Vultr-provided strings — none of them trusted, so `__proto__`
 *  must be an ordinary entry, matching billing/store.ts's `bare()`. */
function bare<T>(from: Record<string, T> = {}): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, from);
}

const inboxKey = (env: HostingEnvironment, eventId: string): string => `${env}:${eventId}`;

export class HostingStore {
  private readonly dbFile: string;

  constructor(readonly dataDir: string, private readonly randomBytes: (n: number) => Buffer = nodeRandomBytes) {
    this.dbFile = path.join(dataDir, HOSTING_DB_FILE);
  }

  private readDb(): HostingDb {
    const raw = readJson<Partial<HostingDb>>(this.dbFile, emptyDb());
    return {
      v: 1,
      instances: bare(raw.instances ?? {}),
      resources: bare(raw.resources ?? {}),
      inbox: bare(raw.inbox ?? {}),
      outbox: bare(raw.outbox ?? {}),
    };
  }

  /** THE transaction primitive. `fn` must be synchronous (enforced by the
   *  type: an async function does not satisfy `(db: HostingDb) => T`) — see
   *  the file header for why that is what makes this a real transaction on
   *  a single-threaded process. `fn` may freely mutate the maps it is
   *  handed; the whole db is written back atomically iff `fn` returns
   *  without throwing. */
  private mutate<T>(fn: (db: HostingDb) => T): T {
    const db = this.readDb();
    const result = fn(db);
    writeJsonAtomic(this.dbFile, db);
    return result;
  }

  newId(prefix: string): string {
    return `${prefix}_${this.randomBytes(12).toString("base64url")}`;
  }

  // ── instances ─────────────────────────────────────────────────────────

  instances(): HostingInstanceRow[] {
    return Object.values(this.readDb().instances);
  }

  getInstance(id: string): HostingInstanceRow | null {
    return this.readDb().instances[id] ?? null;
  }

  /** The "one active hosting instance per owner" reservation (H6). Active =
   *  not `deleted` — a terminated instance frees the owner's slot for a
   *  brand-new purchase (spec §17: "a returning customer receives a new
   *  instance only through an explicit new purchase"). */
  activeInstanceForOwner(ownerId: string, environment: HostingEnvironment): HostingInstanceRow | null {
    for (const row of Object.values(this.readDb().instances)) {
      if (row.ownerId === ownerId && row.environment === environment && row.stage !== "deleted") return row;
    }
    return null;
  }

  findByProviderInstanceId(providerInstanceId: string): HostingInstanceRow | null {
    if (!providerInstanceId) return null;
    for (const row of Object.values(this.readDb().instances)) if (row.providerInstanceId === providerInstanceId) return row;
    return null;
  }

  /** Reserve a brand-new instance row for an owner, refusing (returning
   *  `null`) if one already exists — the reservation IS the uniqueness
   *  check, made inside the same synchronous transaction as the write, so
   *  two concurrent "Add Hosting" requests (H6 acceptance case: "double-
   *  click checkout") can never both see "none exists" and both insert. */
  reserveInstance(input: {
    id: string;
    ownerId: string;
    environment: HostingEnvironment;
    region: string;
    planId: string;
    stripeCustomerId: string;
    nowMs: number;
  }): HostingInstanceRow | null {
    return this.mutate((db) => {
      for (const row of Object.values(db.instances)) {
        if (row.ownerId === input.ownerId && row.environment === input.environment && row.stage !== "deleted") return null;
      }
      const row: HostingInstanceRow = {
        id: input.id,
        ownerId: input.ownerId,
        environment: input.environment,
        region: input.region,
        planId: input.planId,
        stage: "ordered",
        operationalHealth: "unknown",
        lifecycleVersion: 1,
        generation: 1,
        providerAccountRef: "",
        providerInstanceId: null,
        providerPlanMonthlyCostCents: null,
        label: "",
        ip: null,
        appUrl: null,
        bootstrapTokenHash: null,
        bootstrapTokenExpiresAtMs: null,
        stripeCustomerId: input.stripeCustomerId,
        stripeSubscriptionId: null,
        paidThroughMs: null,
        cancellationReason: null,
        suspendAtMs: null,
        deleteAtMs: null,
        deletionHold: null,
        irreversibleDeleteCommittedAtMs: null,
        providerDeletedAtMs: null,
        terminatedAtMs: null,
        lastBillingCheckAtMs: null,
        lastProviderCheckAtMs: null,
        readiness: null,
        regionAttempts: [],
        pendingRestore: false,
        failureReason: null,
        provisionAttempts: 0,
        leaseToken: null,
        leaseUntilMs: null,
        version: 1,
        createdAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
      };
      db.instances[row.id] = row;
      return row;
    });
  }

  /** Compare-and-swap update. `mutator` receives a DRAFT the caller may
   *  freely mutate; returns the new row, or `null` if `expectedVersion`
   *  did not match the row currently on disk (a concurrent change since the
   *  caller last read it) or the row does not exist. `version` is bumped
   *  automatically — a mutator never sets it itself. */
  updateInstance(id: string, expectedVersion: number, mutator: (draft: HostingInstanceRow) => void, nowMs: number): HostingInstanceRow | null {
    return this.mutate((db) => {
      const current = db.instances[id];
      if (!current || current.version !== expectedVersion) return null;
      const draft: HostingInstanceRow = { ...current };
      mutator(draft);
      draft.version = current.version + 1;
      draft.updatedAtMs = nowMs;
      db.instances[id] = draft;
      return draft;
    });
  }

  /** Blind write for the reconciliation/admin paths that already hold the
   *  authoritative row and are not racing anything (e.g. seeding a fresh
   *  reservation, restoring from an export). Prefer `updateInstance`
   *  everywhere else. */
  putInstance(row: HostingInstanceRow): void {
    this.mutate((db) => { db.instances[row.id] = row; });
  }

  // ── leases (crash-safe claim over a destructive/long-running op) ───────

  /** Claim the deletion (or any other exclusive) operation lease on an
   *  instance. Refuses if a live lease is already held (`leaseUntilMs` in
   *  the future) — a stale lease (crashed worker) is reclaimable. Returns
   *  the token the caller must present to `releaseLease`/`updateInstance`
   *  calls made under this claim, and the row as claimed. */
  claimLease(id: string, ttlMs: number, nowMs: number): { token: string; row: HostingInstanceRow } | null {
    return this.mutate((db) => {
      const current = db.instances[id];
      if (!current) return null;
      if (current.leaseToken && current.leaseUntilMs !== null && current.leaseUntilMs > nowMs) return null;
      const token = this.randomBytes(16).toString("base64url");
      const draft: HostingInstanceRow = { ...current, leaseToken: token, leaseUntilMs: nowMs + ttlMs, version: current.version + 1, updatedAtMs: nowMs };
      db.instances[id] = draft;
      return { token, row: draft };
    });
  }

  /** Renew (extend) a lease this caller already holds — proves possession by
   *  token, not by version, so a long-running operation can keep its claim
   *  alive across several awaits without racing its own version bumps. */
  renewLease(id: string, token: string, ttlMs: number, nowMs: number): boolean {
    return this.mutate((db) => {
      const current = db.instances[id];
      if (!current || current.leaseToken !== token) return false;
      db.instances[id] = { ...current, leaseUntilMs: nowMs + ttlMs, updatedAtMs: nowMs };
      return true;
    });
  }

  releaseLease(id: string, token: string, nowMs: number): boolean {
    return this.mutate((db) => {
      const current = db.instances[id];
      if (!current || current.leaseToken !== token) return false;
      db.instances[id] = { ...current, leaseToken: null, leaseUntilMs: null, version: current.version + 1, updatedAtMs: nowMs };
      return true;
    });
  }

  // ── provider resources ──────────────────────────────────────────────────

  resourcesFor(hostingInstanceId: string): HostingResourceRow[] {
    return Object.values(this.readDb().resources).filter((r) => r.hostingInstanceId === hostingInstanceId);
  }

  recordResource(row: Omit<HostingResourceRow, "id">): HostingResourceRow {
    return this.mutate((db) => {
      const id = this.newId("res");
      const full: HostingResourceRow = { ...row, id };
      db.resources[id] = full;
      return full;
    });
  }

  markResourceRemoved(id: string, nowMs: number): void {
    this.mutate((db) => {
      const r = db.resources[id];
      if (r) db.resources[id] = { ...r, cleanupState: "removed", removedAtMs: nowMs };
    });
  }

  // ── billing inbox (idempotent by Stripe event id) ───────────────────────

  /** True the FIRST time this (environment, eventId) is seen; false on any
   *  replay — the caller's whole handling of the event should be gated on
   *  this the same way billing/service.ts's `handleWebhook` gates on
   *  `seenEvent`/`markSeen`, but scoped to hosting's OWN idempotency so it
   *  never depends on cross-file atomicity with the software billing
   *  store. */
  recordInboxIfNew(environment: HostingEnvironment, eventId: string, eventType: string, objectId: string, nowMs: number): boolean {
    return this.mutate((db) => {
      const key = inboxKey(environment, eventId);
      if (db.inbox[key]) return false;
      db.inbox[key] = { environment, eventId, eventType, objectId, status: "received", receivedAtMs: nowMs, processedAtMs: null };
      return true;
    });
  }

  markInboxProcessed(environment: HostingEnvironment, eventId: string, nowMs: number): void {
    this.mutate((db) => {
      const key = inboxKey(environment, eventId);
      const row = db.inbox[key];
      if (row) db.inbox[key] = { ...row, status: "processed", processedAtMs: nowMs };
    });
  }

  // ── outbox (emails + lifecycle jobs, always written with the instance) ──

  /** Enqueue a job, deduped on `dedupeKey`. Intended to be called from
   *  INSIDE the same `updateInstance`-adjacent call as the state change it
   *  reports on — src/hosting/service.ts always calls this in the same
   *  synchronous function body as the instance mutation, so both land in
   *  one `mutate()` at the store layer OR (when the instance write already
   *  happened via `updateInstance`) in the very next synchronous call —
   *  never after an `await`. Returns false (no-op) if the key already
   *  exists — the outbox's own idempotency, independent of the billing
   *  inbox's. */
  enqueue(job: Omit<HostingOutboxRow, "id" | "status" | "attemptCount" | "leaseUntilMs" | "providerMessageId" | "lastErrorCode" | "createdAtMs" | "updatedAtMs">, nowMs: number): boolean {
    return this.mutate((db) => {
      for (const row of Object.values(db.outbox)) if (row.dedupeKey === job.dedupeKey) return false;
      const id = this.newId("job");
      db.outbox[id] = { ...job, id, status: "pending", attemptCount: 0, leaseUntilMs: null, providerMessageId: null, lastErrorCode: null, createdAtMs: nowMs, updatedAtMs: nowMs };
      return true;
    });
  }

  duePending(nowMs: number, limit = 100): HostingOutboxRow[] {
    return Object.values(this.readDb().outbox)
      .filter((r) => r.status === "pending" && r.availableAtMs <= nowMs && (r.leaseUntilMs === null || r.leaseUntilMs < nowMs))
      .sort((a, b) => a.availableAtMs - b.availableAtMs)
      .slice(0, limit);
  }

  outboxFor(hostingInstanceId: string): HostingOutboxRow[] {
    return Object.values(this.readDb().outbox).filter((r) => r.hostingInstanceId === hostingInstanceId);
  }

  claimOutboxJob(id: string, ttlMs: number, nowMs: number): HostingOutboxRow | null {
    return this.mutate((db) => {
      const row = db.outbox[id];
      if (!row || row.status !== "pending" || (row.leaseUntilMs !== null && row.leaseUntilMs >= nowMs)) return null;
      const next: HostingOutboxRow = { ...row, leaseUntilMs: nowMs + ttlMs, attemptCount: row.attemptCount + 1, updatedAtMs: nowMs };
      db.outbox[id] = next;
      return next;
    });
  }

  completeOutboxJob(id: string, outcome: "sent" | "obsolete" | "failed", nowMs: number, patch: { providerMessageId?: string; lastErrorCode?: string } = {}): void {
    this.mutate((db) => {
      const row = db.outbox[id];
      if (!row) return;
      db.outbox[id] = { ...row, status: outcome, leaseUntilMs: null, providerMessageId: patch.providerMessageId ?? row.providerMessageId, lastErrorCode: patch.lastErrorCode ?? row.lastErrorCode, updatedAtMs: nowMs };
    });
  }

  /** Retry: releases the lease and leaves status `pending` so `duePending`
   *  picks it up again (after `availableAtMs`, bumped by the caller if a
   *  backoff is wanted). */
  releaseOutboxJob(id: string, availableAtMs: number, nowMs: number, lastErrorCode?: string): void {
    this.mutate((db) => {
      const row = db.outbox[id];
      if (!row) return;
      db.outbox[id] = { ...row, status: "pending", leaseUntilMs: null, availableAtMs, lastErrorCode: lastErrorCode ?? row.lastErrorCode, updatedAtMs: nowMs };
    });
  }

  /** Mark every still-pending job for an instance whose lifecycleVersion or
   *  generation is OLDER than the given values `obsolete` — "a new expiry
   *  period gets a new lifecycle version" / "paid recovery or a deadline
   *  change invalidates pending notices" (§9). */
  obsoletePendingJobsOlderThan(hostingInstanceId: string, lifecycleVersion: number, generation: number, nowMs: number): number {
    return this.mutate((db) => {
      let n = 0;
      for (const [id, row] of Object.entries(db.outbox)) {
        if (row.hostingInstanceId !== hostingInstanceId || row.status !== "pending") continue;
        if (row.generation < generation || (row.generation === generation && row.lifecycleVersion < lifecycleVersion)) {
          db.outbox[id] = { ...row, status: "obsolete", updatedAtMs: nowMs };
          n++;
        }
      }
      return n;
    });
  }
}
