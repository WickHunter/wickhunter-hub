// src/billing/store.ts
// Durable billing state beside the licence registry:
//   data/billing-customers.v1.json   one row per Stripe customer -> licence
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

export const CUSTOMERS_FILE = "billing-customers.v1.json";
export const TOKENS_FILE = "billing-tokens.v1.json";
export const EVENTS_FILE = "billing-events.v1.jsonl";
export const EVENTS_SEEN_FILE = "billing-events-seen.v1.json";

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

export type EventOutcome = "applied" | "ignored" | "duplicate" | "error" | "signature";

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

  constructor(readonly dataDir: string, private readonly randomBytes: (n: number) => Buffer = nodeRandomBytes) {
    this.customersFile = path.join(dataDir, CUSTOMERS_FILE);
    this.tokensFile = path.join(dataDir, TOKENS_FILE);
    this.eventsFile = path.join(dataDir, EVENTS_FILE);
    this.seenFile = path.join(dataDir, EVENTS_SEEN_FILE);
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
