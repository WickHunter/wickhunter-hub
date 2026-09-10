// src/billing/store.ts
// Durable billing state beside the licence registry:
//   data/billing-customers.v1.json          one row per Stripe customer -> SOFTWARE licence
//   data/billing-role-subscriptions.v1.json one row per (customer, role) for every NON-software
//                                            product — see roles.ts; software stays in the file
//                                            above, byte-for-byte as it always was
//   data/billing-role-index.v1.json         object id (subscription/invoice/payment-intent) ->
//                                            the role it was classified as, so a later refund or
//                                            dispute on the SAME object resolves its role without
//                                            re-deciding anything or calling Stripe
//   data/billing-role-migration.v1.json     one-shot marker: has the pre-dispatcher customer file
//                                            been folded into the role index yet
//   data/billing-tokens.v1.json      install-page and one-time install tokens (HASHED)
//   data/billing-events.v1.jsonl     every webhook event received, with its outcome
//   data/billing-events-seen.v1.json bounded set of event ids, for idempotent replay
//
// Tokens are stored as SHA-256 hashes: a copy of data/ must not be a pile of
// working install links. The raw token exists only in the email / on the page.
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendJsonl, readJson, writeJsonAtomic } from "../jsonfile.js";
import type { BillingRole } from "./roles.js";

export const CUSTOMERS_FILE = "billing-customers.v1.json";
export const TOKENS_FILE = "billing-tokens.v1.json";
export const EVENTS_FILE = "billing-events.v1.jsonl";
export const EVENTS_SEEN_FILE = "billing-events-seen.v1.json";
export const ROLE_SUBSCRIPTIONS_FILE = "billing-role-subscriptions.v1.json";
export const ROLE_INDEX_FILE = "billing-role-index.v1.json";
export const ROLE_MIGRATION_MARKER_FILE = "billing-role-migration.v1.json";

/** How many event ids we remember. Stripe retries for up to three days; this
 *  is years of a small shop's events, and the ledger keeps the full history. */
const MAX_SEEN_EVENTS = 5000;
const EVENTS_TAIL_BYTES = 2 * 1024 * 1024;
export const INSTALL_TOKEN_TTL_MS = 24 * 60 * 60_000;
/** Unused install tokens a customer may hold at once (each page view mints one). */
const MAX_OPEN_INSTALL_TOKENS = 20;

export interface CustomerRecord {
  /** `cus_…`, or `email:<address>` when a one-time checkout created no customer. */
  key: string;
  stripeCustomerId: string;
  email: string;
  name: string;
  livemode: boolean;
  licenseId: string;
  /** Which plan was bought (`metadata.plan` on the Payment Link); null for
   *  a purchase made before plans existed or through an untagged link. */
  planKey: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  /** What the customer has paid THROUGH (Stripe's period end), before grace. */
  periodEndMs: number | null;
  /** Charge / payment-intent ids seen for this customer, so a dispute (which
   *  names only the charge) can be attributed without calling Stripe. */
  chargeIds: string[];
  createdAtMs: number;
  updatedAtMs: number;
  welcomeSentAtMs: number | null;
  welcomeError: string | null;
  disputed: boolean;
  refunded: boolean;
  lastEventType: string | null;
  lastEventAtMs: number | null;
}

export type TokenKind = "page" | "install";

export interface TokenRecord {
  kind: TokenKind;
  licenseId: string;
  customerKey: string;
  createdAtMs: number;
  /** null = until rotated (page tokens); install tokens expire. */
  expiresAtMs: number | null;
  usedAtMs: number | null;
  revokedAtMs: number | null;
}

// "unclassified" is its OWN outcome, distinct from "ignored": an ignored
// event was understood and correctly has nothing to do (a partial refund, an
// unhandled type); an unclassified one could not be matched to EITHER
// product role at all and is recorded for the operator to reconcile by hand
// (roles.ts's "unknown" — see its header for exactly when that fires).
export type EventOutcome = "applied" | "ignored" | "duplicate" | "error" | "signature" | "unclassified";

export interface EventRecord {
  id: string;
  type: string;
  livemode: boolean;
  receivedAtMs: number;
  outcome: EventOutcome;
  note: string | null;
}

export type ConsumeResult =
  | { ok: true; rec: TokenRecord }
  | { ok: false; reason: "unknown" | "used" | "expired" | "revoked" };

/** One (customer, role) subscription record for every role OTHER than
 *  "software" — software keeps living on CustomerRecord exactly as before
 *  (H1's "byte-for-byte unchanged"). A hosting record never implies a
 *  software one exists, and never touches one. */
export interface RoleSubscriptionRecord {
  key: string; // `${customerKey}::${role}`
  customerKey: string;
  role: BillingRole;
  livemode: boolean;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  /** What the customer has paid THROUGH for this role — this role's OWN
   *  figure, never blended with any other role's. */
  periodEndMs: number | null;
  chargeIds: string[];
  disputed: boolean;
  refunded: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  lastEventType: string | null;
  lastEventAtMs: number | null;
}

export const roleSubscriptionKey = (customerKey: string, role: BillingRole): string => `${customerKey}::${role}`;

const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex");

/** Plain-object maps with no prototype: keys arrive from Stripe and from the
 *  wire, and `__proto__` as a key must be an entry, not a prototype swap. */
function bare<T>(from: Record<string, T> = {}): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, from);
}

export class BillingStore {
  private readonly customersFile: string;
  private readonly tokensFile: string;
  private readonly eventsFile: string;
  private readonly seenFile: string;
  private readonly roleSubscriptionsFile: string;
  private readonly roleIndexFile: string;
  private readonly roleMigrationFile: string;

  constructor(readonly dataDir: string, private readonly randomBytes: (n: number) => Buffer = nodeRandomBytes) {
    this.customersFile = path.join(dataDir, CUSTOMERS_FILE);
    this.tokensFile = path.join(dataDir, TOKENS_FILE);
    this.eventsFile = path.join(dataDir, EVENTS_FILE);
    this.seenFile = path.join(dataDir, EVENTS_SEEN_FILE);
    this.roleSubscriptionsFile = path.join(dataDir, ROLE_SUBSCRIPTIONS_FILE);
    this.roleIndexFile = path.join(dataDir, ROLE_INDEX_FILE);
    this.roleMigrationFile = path.join(dataDir, ROLE_MIGRATION_MARKER_FILE);
    this.migrateLegacySoftwareRoles();
  }

  // ── customers ─────────────────────────────────────────────────────────────

  customers(): Record<string, CustomerRecord> {
    return bare(readJson<Record<string, CustomerRecord>>(this.customersFile, {}));
  }

  getCustomer(key: string): CustomerRecord | null {
    return this.customers()[key] ?? null;
  }

  putCustomer(rec: CustomerRecord): void {
    const all = this.customers();
    all[rec.key] = rec;
    writeJsonAtomic(this.customersFile, all);
  }

  findByLicense(licenseId: string): CustomerRecord | null {
    for (const rec of Object.values(this.customers())) if (rec.licenseId === licenseId) return rec;
    return null;
  }

  findByCharge(id: string): CustomerRecord | null {
    if (!id) return null;
    for (const rec of Object.values(this.customers())) if (rec.chargeIds.includes(id)) return rec;
    return null;
  }

  findByEmail(email: string): CustomerRecord | null {
    const e = email.trim().toLowerCase();
    if (!e) return null;
    for (const rec of Object.values(this.customers())) if (rec.email === e) return rec;
    return null;
  }

  // ── role subscriptions (every role other than "software") ──────────────────
  // Software stays on `customers()` above, byte-for-byte as it always was —
  // these exist so a hosting (or any future non-software) subscription has
  // somewhere to live that a software handler never reads or writes.

  roleSubscriptions(): Record<string, RoleSubscriptionRecord> {
    return bare(readJson<Record<string, RoleSubscriptionRecord>>(this.roleSubscriptionsFile, {}));
  }

  getRoleSubscription(customerKey: string, role: BillingRole): RoleSubscriptionRecord | null {
    return this.roleSubscriptions()[roleSubscriptionKey(customerKey, role)] ?? null;
  }

  putRoleSubscription(rec: RoleSubscriptionRecord): void {
    const all = this.roleSubscriptions();
    all[rec.key] = rec;
    writeJsonAtomic(this.roleSubscriptionsFile, all);
  }

  findRoleSubscriptionByCharge(role: BillingRole, id: string): RoleSubscriptionRecord | null {
    if (!id) return null;
    for (const rec of Object.values(this.roleSubscriptions())) if (rec.role === role && rec.chargeIds.includes(id)) return rec;
    return null;
  }

  // ── role index ───────────────────────────────────────────────────────────
  // object id (a Stripe subscription/invoice/payment-intent/checkout-session
  // id) -> the role it was classified as. Populated the moment ANY event
  // carrying that id is classified, so a LATER event naming only that id (a
  // refund knows only the charge/payment-intent, a dispute only the charge)
  // resolves its role from what was already decided — never re-classifying,
  // never guessing, never calling Stripe. Bounded exactly like `seenFile`:
  // years of a small shop's objects fit inside the cap, and role churn on one
  // object is rare enough that eviction losing the oldest entries is fine —
  // the WORST case on eviction is falling back to `classifyRole`'s own
  // documented default (software while hosting is unconfigured; "unknown"
  // once it is), never a wrong answer standing in for a right one.
  private readonly MAX_ROLE_INDEX_ENTRIES = 5000;

  private roleIndex(): Record<string, { role: BillingRole; atMs: number }> {
    return bare(readJson<Record<string, { role: BillingRole; atMs: number }>>(this.roleIndexFile, {}));
  }

  roleFor(objectId: string): BillingRole | null {
    if (!objectId) return null;
    return this.roleIndex()[objectId]?.role ?? null;
  }

  /** Record (or confirm) an object's role. A SECOND role for an id already
   *  indexed under a DIFFERENT role is refused — silently overwriting it
   *  would let one misclassified event quietly relabel every later refund or
   *  dispute on the same object. The caller decides what a refusal means
   *  (service.ts treats it as "unknown" and records it for reconciliation,
   *  the same as any other classification conflict). */
  noteRole(objectId: string, role: BillingRole, now = Date.now()): boolean {
    if (!objectId) return true;
    const all = this.roleIndex();
    const existing = all[objectId];
    if (existing && existing.role !== role) return false;
    if (existing) return true; // already recorded, agrees — nothing to write
    all[objectId] = { role, atMs: now };
    const ids = Object.keys(all);
    if (ids.length > this.MAX_ROLE_INDEX_ENTRIES) {
      ids.sort((a, b) => all[a]!.atMs - all[b]!.atMs);
      for (const old of ids.slice(0, ids.length - this.MAX_ROLE_INDEX_ENTRIES)) delete all[old];
    }
    writeJsonAtomic(this.roleIndexFile, all);
    return true;
  }

  /** One-shot, marker-guarded: fold every pre-dispatcher `CustomerRecord`'s
   *  known object ids (its subscription and every charge it has seen) into
   *  the role index as "software" — the "explicit legacy software mappings
   *  handle older customers" the dispatcher relies on (roles.ts), so an
   *  existing customer's refund or dispute keeps resolving to software from
   *  the role index even after an operator configures a hosting allowlist
   *  and the Hub-wide "no hosting configured -> default software" safety net
   *  (also in roles.ts) stops applying. Runs once per process at
   *  construction — cheap (one JSON read/write for the whole file) and
   *  correct to re-run if the marker is ever lost: it can only ever ADD
   *  "software" entries for ids no role has been recorded for yet, via the
   *  same conflict-refusing `noteRole` every live event goes through, so a
   *  re-run can never silently overwrite a role an operator's later
   *  configuration has already assigned. */
  private migrateLegacySoftwareRoles(): void {
    if (fs.existsSync(this.roleMigrationFile)) return;
    const now = Date.now();
    for (const rec of Object.values(this.customers())) {
      if (rec.subscriptionId) this.noteRole(rec.subscriptionId, "software", rec.createdAtMs);
      for (const chargeId of rec.chargeIds) this.noteRole(chargeId, "software", rec.createdAtMs);
    }
    writeJsonAtomic(this.roleMigrationFile, { migratedAtMs: now });
  }

  // ── events ────────────────────────────────────────────────────────────────

  seenEvent(id: string): boolean {
    return Object.hasOwn(readJson<Record<string, number>>(this.seenFile, {}), id);
  }

  /** Remember an id; the oldest are dropped past the cap. */
  markSeen(id: string, now = Date.now()): void {
    const seen = bare(readJson<Record<string, number>>(this.seenFile, {}));
    seen[id] = now;
    const ids = Object.keys(seen);
    if (ids.length > MAX_SEEN_EVENTS) {
      ids.sort((a, b) => seen[a]! - seen[b]!);
      for (const old of ids.slice(0, ids.length - MAX_SEEN_EVENTS)) delete seen[old];
    }
    writeJsonAtomic(this.seenFile, seen);
  }

  appendEvent(rec: EventRecord): void {
    appendJsonl(this.eventsFile, rec);
  }

  /** Newest first, bounded — a tail read so the ledger can grow for years. */
  recentEvents(limit = 100): EventRecord[] {
    let text = "";
    try {
      const fd = fs.openSync(this.eventsFile, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - EVENTS_TAIL_BYTES);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString("utf8");
        if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      } finally { fs.closeSync(fd); }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: EventRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line) as EventRecord); } catch { /* torn final line */ }
    }
    return out.reverse().slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  // ── tokens ────────────────────────────────────────────────────────────────

  private tokens(): Record<string, TokenRecord> {
    return bare(readJson<Record<string, TokenRecord>>(this.tokensFile, {}));
  }

  /** Mint a token; returns the RAW value (shown once) and stores its hash. */
  mint(kind: TokenKind, licenseId: string, customerKey: string, now = Date.now()): string {
    const raw = this.randomBytes(32).toString("base64url");
    const all = this.tokens();
    if (kind === "install") {
      // Prune what can no longer be used, then bound how many open commands
      // one customer holds — a page reloaded in a loop must not grow the file.
      const open: string[] = [];
      for (const [h, t] of Object.entries(all)) {
        const dead = t.revokedAtMs !== null || t.usedAtMs !== null || (t.expiresAtMs !== null && t.expiresAtMs <= now);
        if (dead && t.kind === "install" && (t.usedAtMs === null || now - t.usedAtMs > 30 * 86_400_000)) delete all[h];
        else if (t.kind === "install" && t.customerKey === customerKey && !dead) open.push(h);
      }
      if (open.length >= MAX_OPEN_INSTALL_TOKENS) {
        open.sort((a, b) => all[a]!.createdAtMs - all[b]!.createdAtMs);
        for (const h of open.slice(0, open.length - MAX_OPEN_INSTALL_TOKENS + 1)) all[h]!.revokedAtMs = now;
      }
    }
    all[hashToken(raw)] = {
      kind,
      licenseId,
      customerKey,
      createdAtMs: now,
      expiresAtMs: kind === "install" ? now + INSTALL_TOKEN_TTL_MS : null,
      usedAtMs: null,
      revokedAtMs: null,
    };
    writeJsonAtomic(this.tokensFile, all);
    return raw;
  }

  /** A live page token's record, or null. Page tokens never expire; they are
   *  rotated (revoked) when a welcome email is re-sent. */
  lookupPage(raw: string): TokenRecord | null {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(raw)) return null;
    const t = this.tokens()[hashToken(raw)];
    return t && t.kind === "page" && t.revokedAtMs === null ? t : null;
  }

  /** Burn an install token. Exactly one caller ever gets `ok:true` for a
   *  given token; the second sees `used`. */
  consumeInstall(raw: string, now = Date.now()): ConsumeResult {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(raw)) return { ok: false, reason: "unknown" };
    const all = this.tokens();
    const h = hashToken(raw);
    const t = all[h];
    if (!t || t.kind !== "install") return { ok: false, reason: "unknown" };
    if (t.revokedAtMs !== null) return { ok: false, reason: "revoked" };
    if (t.usedAtMs !== null) return { ok: false, reason: "used" };
    if (t.expiresAtMs !== null && t.expiresAtMs <= now) return { ok: false, reason: "expired" };
    const used: TokenRecord = { ...t, usedAtMs: now };
    all[h] = used;
    writeJsonAtomic(this.tokensFile, all);
    return { ok: true, rec: used };
  }

  /** Revoke every token of one kind for a customer (page rotation, or a
   *  revoked licence's outstanding install commands). */
  revokeTokens(customerKey: string, kind: TokenKind | "all", now = Date.now()): number {
    const all = this.tokens();
    let n = 0;
    for (const t of Object.values(all)) {
      if (t.customerKey !== customerKey || t.revokedAtMs !== null) continue;
      if (kind !== "all" && t.kind !== kind) continue;
      t.revokedAtMs = now;
      n++;
    }
    if (n) writeJsonAtomic(this.tokensFile, all);
    return n;
  }
}
