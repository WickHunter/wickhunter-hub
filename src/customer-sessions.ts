// src/customer-sessions.ts
//
// The central authenticated customer dashboard (H2 of the hosting
// implementation export): one sign-in that works regardless of which
// licence, Stripe customer, or (later) hosting subscription belongs to a
// buyer's email — even when every one of those is inactive (a lapsed
// licence, a revoked customer portal, a VPS that is powered off). Scope is
// deliberately narrow: identity, a magic-link session, and a read-mostly
// dashboard. No provisioning, no hosting checkout, no emails beyond the
// sign-in link.
//
// DELIBERATELY SEPARATE FROM TWO THINGS THAT ALREADY EXIST:
//   - Admin auth (src/server.ts's `adminAuthorized`): a bearer header
//     compared constant-time. No cookies, no sessions, ever. A customer
//     session cookie is never even READ by an admin route, so the boundary
//     between the two is structural rather than a check this file has to
//     get right — see tests/customer-sessions.test.mjs, "a customer session
//     cannot reach an admin route".
//   - BillingStore's CustomerRecord (src/billing/store.ts), which stays
//     exactly what it always was: keyed per Stripe customer, per MODE. This
//     file's identity is keyed by CASE-FOLDED EMAIL and can point at more
//     than one CustomerRecord — a test-mode purchase and a live-mode one
//     under the same address — and `dashboardState` lists every matching
//     record separately, labelled by its own mode, never blending a figure
//     across two of them (the H2 review's "test/live never mix in one
//     identity's view").
//
// AN IDENTITY IS NEVER MINTED FROM A BARE REQUEST BODY. `requestSignin`
// looks the email up against BillingStore FIRST; an email with no matching
// CustomerRecord gets the same generic "check your email" reply as anyone
// else (never revealing whether an account exists), but no identity row is
// created and no token is minted. This is the whole meaning of "created/
// linked from the existing billing flow" in the H2 brief — identity here is
// downstream of a real, already-verified Stripe purchase, never of a string
// typed into a box.
//
// data/customer-identities.v1.json     case-folded email -> {id, email, createdAtMs}
// data/customer-signin-tokens.v1.json  single-use, 15-minute sign-in tokens, HASHED
// data/customer-sessions.v1.json       30-day sliding sessions, HASHED
//
// Every token/session table follows BillingStore's own shape: the raw value
// exists only in the email (or the admin's one-time reveal, for a bounced
// address) and on the wire for the one exchange that consumes it — the store
// only ever holds its SHA-256.
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./jsonfile.js";
import type { LicenseStore } from "./license.js";
import type { BillingService } from "./billing/service.js";
import type { CustomerRecord } from "./billing/store.js";
import { emailReady } from "./billing/config.js";
import { escapeHtml, sendEmail, type EmailFetch, type EmailMessage } from "./billing/email.js";

export const IDENTITIES_FILE = "customer-identities.v1.json";
export const SIGNIN_TOKENS_FILE = "customer-signin-tokens.v1.json";
export const SESSIONS_FILE = "customer-sessions.v1.json";

export const SIGNIN_TOKEN_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** A session's expiry is extended on use, but not on EVERY use — a
 *  dashboard tab left open and polling every few seconds must not rewrite
 *  this file that often. Sliding by up to an hour of staleness is invisible
 *  to a human and bounds the write rate to the same order as every other
 *  durable table in this Hub. */
export const SESSION_TOUCH_MIN_INTERVAL_MS = 60 * 60_000;
export const SESSION_COOKIE_NAME = "wh_customer_session";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex");

/** The one place an email is case-folded for identity purposes — the
 *  identity table's key, the rate-limit key, and every lookup against it
 *  all go through this so "Foo@Example.com" and "foo@example.com" are
 *  provably the same address everywhere, not just in the places someone
 *  remembered to lowercase. */
export const normalizeCustomerEmail = (raw: string): string => raw.trim().toLowerCase();

function bare<T>(from: Record<string, T> = {}): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, from);
}

export interface CustomerIdentity {
  /** Durable owner id — never a Stripe id, so it outlives any one Stripe
   *  customer or mode. `cust_<32 hex>`. */
  id: string;
  /** Case-folded (trim + lowercase); also the identity table's own key. */
  email: string;
  createdAtMs: number;
}

interface SigninTokenRow {
  identityId: string;
  createdAtMs: number;
  expiresAtMs: number;
  usedAtMs: number | null;
}

interface SessionRow {
  identityId: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  /** Audit trail only — an IP is never consulted for authorization. */
  createdIp: string;
}

export type ConsumeSigninResult =
  | { ok: true; identityId: string }
  | { ok: false; reason: "unknown" | "used" | "expired" };

/** Durable identity/token/session state, file-backed exactly like
 *  BillingStore (tmp-then-rename writes via jsonfile.ts, plain objects with
 *  no prototype so a Stripe- or attacker-controlled string key can never
 *  reach `Object.prototype`). */
export class CustomerSessionStore {
  private readonly identitiesFile: string;
  private readonly tokensFile: string;
  private readonly sessionsFile: string;

  constructor(readonly dataDir: string, private readonly randomBytes: (n: number) => Buffer = nodeRandomBytes) {
    this.identitiesFile = path.join(dataDir, IDENTITIES_FILE);
    this.tokensFile = path.join(dataDir, SIGNIN_TOKENS_FILE);
    this.sessionsFile = path.join(dataDir, SESSIONS_FILE);
  }

  // ── identities ────────────────────────────────────────────────────────

  private identities(): Record<string, CustomerIdentity> {
    return bare(readJson<Record<string, CustomerIdentity>>(this.identitiesFile, {}));
  }

  getIdentityByEmail(email: string): CustomerIdentity | null {
    return this.identities()[normalizeCustomerEmail(email)] ?? null;
  }

  getIdentity(id: string): CustomerIdentity | null {
    for (const rec of Object.values(this.identities())) if (rec.id === id) return rec;
    return null;
  }

  /** Get-or-create, keyed on the case-folded email — ONE identity per
   *  address, whatever case it was typed in, on every call site: signing
   *  in, an admin issuing a bounced-email link, or a later hosting-purchase
   *  flow that has not been built yet. */
  ensureIdentity(email: string, now = Date.now()): CustomerIdentity {
    const key = normalizeCustomerEmail(email);
    const all = this.identities();
    const existing = all[key];
    if (existing) return existing;
    const rec: CustomerIdentity = { id: `cust_${this.randomBytes(16).toString("hex")}`, email: key, createdAtMs: now };
    all[key] = rec;
    writeJsonAtomic(this.identitiesFile, all);
    return rec;
  }

  // ── sign-in tokens ────────────────────────────────────────────────────

  private tokens(): Record<string, SigninTokenRow> {
    return bare(readJson<Record<string, SigninTokenRow>>(this.tokensFile, {}));
  }

  /** Mint a raw token (returned once — the caller emails it or, for the
   *  admin fallback, hands it back directly); only its hash is written.
   *  Dead rows (used, or expired more than a day) are pruned on the way in
   *  so a customer who keeps asking for a link cannot grow this file
   *  without bound — the same shape `BillingStore.mint` uses for install
   *  tokens. */
  mintSigninToken(identityId: string, now = Date.now()): string {
    const raw = this.randomBytes(32).toString("base64url");
    const all = this.tokens();
    for (const [h, t] of Object.entries(all)) {
      if (t.usedAtMs !== null || t.expiresAtMs <= now - 86_400_000) delete all[h];
    }
    all[hashToken(raw)] = { identityId, createdAtMs: now, expiresAtMs: now + SIGNIN_TOKEN_TTL_MS, usedAtMs: null };
    writeJsonAtomic(this.tokensFile, all);
    return raw;
  }

  /** Burn a sign-in token. Exactly one caller ever gets `ok:true` for a
   *  given raw value; every later attempt (a mail scanner's prefetch, a
   *  double click, a reused old email) sees `used`. */
  consumeSigninToken(raw: string, now = Date.now()): ConsumeSigninResult {
    if (!TOKEN_SHAPE.test(raw)) return { ok: false, reason: "unknown" };
    const all = this.tokens();
    const h = hashToken(raw);
    const t = all[h];
    if (!t) return { ok: false, reason: "unknown" };
    if (t.usedAtMs !== null) return { ok: false, reason: "used" };
    if (t.expiresAtMs <= now) return { ok: false, reason: "expired" };
    all[h] = { ...t, usedAtMs: now };
    writeJsonAtomic(this.tokensFile, all);
    return { ok: true, identityId: t.identityId };
  }

  // ── sessions ──────────────────────────────────────────────────────────

  private sessions(): Record<string, SessionRow> {
    return bare(readJson<Record<string, SessionRow>>(this.sessionsFile, {}));
  }

  /** New session, 30-day sliding expiry from `now`. Returns the RAW cookie
   *  value — only its hash is ever written to disk, so a copy of `data/`
   *  is not a pile of working sign-in cookies any more than it is a pile of
   *  working install links. */
  createSession(identityId: string, createdIp: string, now = Date.now()): string {
    const raw = this.randomBytes(32).toString("base64url");
    const all = this.sessions();
    for (const [h, s] of Object.entries(all)) {
      if (s.revokedAtMs !== null || s.expiresAtMs <= now) delete all[h];
    }
    all[hashToken(raw)] = {
      identityId, createdAtMs: now, lastSeenAtMs: now, expiresAtMs: now + SESSION_TTL_MS, revokedAtMs: null, createdIp,
    };
    writeJsonAtomic(this.sessionsFile, all);
    return raw;
  }

  /** A live session's identity id, or null — revoked, expired, unknown and
   *  malformed are all indistinguishable to the caller (an invalid cookie
   *  is an invalid cookie; which of those it was is not information a
   *  client gets). Slides the expiry forward once the last touch is more
   *  than `SESSION_TOUCH_MIN_INTERVAL_MS` old. */
  validateSession(raw: string, now = Date.now()): { identityId: string } | null {
    if (!TOKEN_SHAPE.test(raw)) return null;
    const all = this.sessions();
    const h = hashToken(raw);
    const s = all[h];
    if (!s || s.revokedAtMs !== null || s.expiresAtMs <= now) return null;
    if (now - s.lastSeenAtMs > SESSION_TOUCH_MIN_INTERVAL_MS) {
      all[h] = { ...s, lastSeenAtMs: now, expiresAtMs: now + SESSION_TTL_MS };
      writeJsonAtomic(this.sessionsFile, all);
    }
    return { identityId: s.identityId };
  }

  /** Explicit sign-out: revoke exactly the presented session, never every
   *  session an identity holds — a phone signed in elsewhere must not be
   *  logged out by a laptop's sign-out button. */
  revokeSession(raw: string, now = Date.now()): void {
    if (!TOKEN_SHAPE.test(raw)) return;
    const all = this.sessions();
    const h = hashToken(raw);
    const row = all[h];
    if (row && row.revokedAtMs === null) {
      all[h] = { ...row, revokedAtMs: now };
      writeJsonAtomic(this.sessionsFile, all);
    }
  }
}

// ── cookie plumbing ──────────────────────────────────────────────────────

/** Pulls exactly the session cookie's value out of a raw `Cookie` header,
 *  never anything else the browser sent alongside it (a `Cookie` header can
 *  legitimately carry several cookies from several origins under nginx). */
export function sessionCookieFrom(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join("; ") : header ?? "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

/** `Path=/` — the cookie has to reach both `/customer` (the page) and
 *  `/api/customer/*` (a sibling tree, not a child of `/customer`). Secure
 *  is set unconditionally: production always sits behind the nginx TLS
 *  termination this Hub is deployed with (README), so this is never a
 *  legitimate plain-HTTP deployment losing the cookie — it is a test
 *  fetching over loopback HTTP and reading the header text directly,
 *  exactly as it already does for every other cookie-free route here. */
export function buildSessionCookie(raw: string): string {
  return `${SESSION_COOKIE_NAME}=${raw}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// ── the sign-in email ────────────────────────────────────────────────────

function signinEmail(to: string, linkUrl: string): EmailMessage {
  const minutes = Math.round(SIGNIN_TOKEN_TTL_MS / 60_000);
  const subject = "Sign in to your Wick Hunter account";
  const text = [
    `Sign in to Wick Hunter`,
    ``,
    `Use this link to sign in — it works once and expires in ${minutes} minutes:`,
    `  ${linkUrl}`,
    ``,
    `If you did not request this, you can ignore this email; nothing happens until the link is opened.`,
  ].join("\n");
  const html = `<p>Use this link to sign in to your Wick Hunter account — it works once and expires in ${minutes} minutes:</p>
<p><a href="${escapeHtml(linkUrl)}">${escapeHtml(linkUrl)}</a></p>
<p style="color:#8a92a8;font-size:12px">If you did not request this, you can ignore this email; nothing happens until the link is opened.</p>`;
  return { to, subject, text, html };
}

/** No SDK, same shape as billing/service.ts's own default: production talks
 *  to the real network, a suite always injects its own `fetchLike`. */
const realFetch: EmailFetch = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

// ── the service ───────────────────────────────────────────────────────────

export interface CustomerSessionServiceDeps {
  now?: () => number;
  fetchLike?: EmailFetch;
  randomBytes?: (n: number) => Buffer;
  log?: (line: string) => void;
}

export interface SoftwareView {
  customerKey: string;
  livemode: boolean;
  licenseId: string;
  licenseName: string | null;
  plan: string | null;
  exp: number | null;
  revoked: boolean;
  /** `exp !== null && exp <= now && !revoked` — a lapsed licence the bot
   *  keeps running in exit-only mode, never a kill (README). */
  exitOnly: boolean;
  subscriptionStatus: string | null;
  currentPeriodEndMs: number | null;
  portalAvailable: boolean;
}

export interface CustomerStateView {
  email: string;
  software: SoftwareView[];
  hosting: { available: false; note: string };
}

export type PortalOutcome = { ok: true; url: string } | { ok: false; status: number; error: string };
export type InstallCommandOutcome = { ok: true; command: string } | { ok: false; status: number; error: string };

/** Every `CustomerRecord` whose email matches (case-folded) — deliberately
 *  a filter over the WHOLE table rather than `BillingStore.findByEmail`
 *  (which returns only the first match), because the exact case this file
 *  exists to handle is more than one record sharing an email: a test-mode
 *  purchase and a live-mode one. */
function matchingCustomerRecords(billing: BillingService, email: string): CustomerRecord[] {
  const e = normalizeCustomerEmail(email);
  return Object.values(billing.store.customers()).filter((rec) => rec.email === e);
}

export class CustomerSessionService {
  readonly store: CustomerSessionStore;
  private readonly now: () => number;
  private readonly fetchLike: EmailFetch;
  private readonly log: (line: string) => void;

  constructor(
    dataDir: string,
    private readonly billing: BillingService,
    private readonly licenses: LicenseStore,
    private readonly publicOrigin: string,
    deps: CustomerSessionServiceDeps = {},
  ) {
    this.store = new CustomerSessionStore(dataDir, deps.randomBytes);
    this.now = deps.now ?? Date.now;
    this.fetchLike = deps.fetchLike ?? realFetch;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** Exposed so the HTTP layer never reads its own clock for a session
   *  decision — one clock for issuance, validation and the dashboard's
   *  "lapsed as of now" reading, all driven by the same injected `now` in
   *  tests. */
  nowMs(): number {
    return this.now();
  }

  private get origin(): string {
    return this.publicOrigin.replace(/\/+$/, "");
  }

  // ── sign-in ───────────────────────────────────────────────────────────

  /** POST /api/customer/signin. NEVER throws and never tells the caller
   *  whether the address matched anything — that answer is only ever
   *  visible in this process's log (for the operator) and through the
   *  admin-issued-link route below (for a caller already holding the admin
   *  token). An email with no matching billing customer gets exactly the
   *  same treatment as one that just got a link sent. */
  async requestSignin(rawEmail: string): Promise<void> {
    const email = normalizeCustomerEmail(rawEmail);
    const matches = matchingCustomerRecords(this.billing, email);
    if (!matches.length) {
      this.log(`[customer] sign-in requested for ${email} — no billing customer on file, nothing sent`);
      return;
    }
    const now = this.now();
    const identity = this.store.ensureIdentity(email, now);
    const raw = this.store.mintSigninToken(identity.id, now);
    const cfg = this.billing.config();
    if (!emailReady(cfg.email)) {
      this.log(`[customer] sign-in link minted for ${email} but NOT emailed — no email provider is configured; the admin can issue the link from the admin panel`);
      return;
    }
    const msg = signinEmail(email, `${this.origin}/customer/signin?token=${raw}`);
    const r = await sendEmail(cfg.email, msg, this.fetchLike);
    if (!r.ok) this.log(`[customer] sign-in email to ${email} failed: ${r.error} — the admin can issue a link from the admin panel`);
  }

  /** POST /admin/api/customers/signin-link — the bounced/undeliverable-mail
   *  fallback the H2 brief calls for: mints the same kind of token
   *  `requestSignin` would, but hands the RAW LINK back to an
   *  already-authenticated admin instead of emailing it. Still refuses to
   *  mint anything for an address with no matching billing customer — an
   *  identity is never created from a bare email, admin-typed or not. */
  adminIssueLink(rawEmail: string): { ok: true; url: string } | { ok: false; error: string } {
    const email = normalizeCustomerEmail(rawEmail);
    const matches = matchingCustomerRecords(this.billing, email);
    if (!matches.length) return { ok: false, error: "no billing customer is on file for this email" };
    const now = this.now();
    const identity = this.store.ensureIdentity(email, now);
    const raw = this.store.mintSigninToken(identity.id, now);
    return { ok: true, url: `${this.origin}/customer/signin?token=${raw}` };
  }

  /** GET /customer/signin?token=. Burns the token and mints a session; the
   *  route wraps this into a Set-Cookie + redirect. */
  exchangeToken(raw: string, ip: string): { ok: true; cookie: string } | { ok: false; status: number; text: string } {
    const now = this.now();
    const r = this.store.consumeSigninToken(raw, now);
    if (!r.ok) {
      const text = {
        unknown: "this sign-in link is not valid — request a new one from the sign-in page",
        used: "this sign-in link was already used — request a new one from the sign-in page",
        expired: "this sign-in link has expired (they last 15 minutes) — request a new one from the sign-in page",
      }[r.reason];
      return { ok: false, status: 403, text };
    }
    const session = this.store.createSession(r.identityId, ip, now);
    return { ok: true, cookie: buildSessionCookie(session) };
  }

  // ── the authenticated dashboard ──────────────────────────────────────

  /** The session cookie's identity, or null. Revoked/expired/unknown are
   *  indistinguishable on purpose (see `CustomerSessionStore.validateSession`). */
  authenticate(rawCookie: string | null): CustomerIdentity | null {
    if (!rawCookie) return null;
    const sess = this.store.validateSession(rawCookie, this.now());
    if (!sess) return null;
    return this.store.getIdentity(sess.identityId);
  }

  /** GET /api/customer/state. Reads only durable Hub state — the licence
   *  registry and BillingStore — so this renders identically whether the
   *  customer's VPS is on, off, or was never installed, and whether their
   *  licence is active or lapsed (H2: "must remain usable after the VPS is
   *  powered off and after software expiration"). */
  dashboardState(identity: CustomerIdentity): CustomerStateView {
    const now = this.now();
    const software: SoftwareView[] = matchingCustomerRecords(this.billing, identity.email)
      // Live before test, then newest first — an operator's own test
      // purchase never buries their real subscription.
      .sort((a, b) => (a.livemode !== b.livemode ? (a.livemode ? -1 : 1) : b.createdAtMs - a.createdAtMs))
      .map((rec) => {
        const payload = this.licenses.get(rec.licenseId);
        const revoked = this.licenses.isRevoked(rec.licenseId);
        const exp = payload?.exp ?? null;
        const info = this.billing.subscriptionInfoFor(rec.licenseId);
        return {
          customerKey: rec.key,
          livemode: rec.livemode,
          licenseId: rec.licenseId,
          licenseName: payload?.name ?? null,
          plan: info?.plan ?? rec.planKey,
          exp,
          revoked,
          exitOnly: exp !== null && !revoked && exp <= now,
          subscriptionStatus: info?.status ?? rec.subscriptionStatus,
          currentPeriodEndMs: info?.currentPeriodEndMs ?? rec.periodEndMs,
          portalAvailable: info?.portalAvailable ?? false,
        };
      });
    return {
      email: identity.email,
      software,
      hosting: { available: false, note: "Unleashed VPS Hosting is not available yet." },
    };
  }

  /** Ownership check shared by both mutating actions below: the caller must
   *  hold a session for the SAME email the customer record belongs to. A
   *  session identity and a `customerKey` are unrelated strings, so this is
   *  the one place that ties a click on the dashboard back to "this is
   *  really that customer's own record" — never trust a `customerKey` sent
   *  from the browser on its own. */
  private ownedCustomer(identity: CustomerIdentity, customerKey: string): CustomerRecord | null {
    const rec = this.billing.store.getCustomer(customerKey);
    return rec && rec.email === identity.email ? rec : null;
  }

  /** POST /api/customer/install-command. Mints a fresh one-time install
   *  token exactly the way the `/welcome/<page-token>` page does (reuses
   *  `BillingStore.mint`, the SAME `/install/<token>` route consumes it) —
   *  never inline on a page load, so a dashboard left open does not mint a
   *  fresh install command on every poll. */
  installCommand(identity: CustomerIdentity, customerKey: string, releaseReady: boolean): InstallCommandOutcome {
    const rec = this.ownedCustomer(identity, customerKey);
    if (!rec) return { ok: false, status: 404, error: "unknown customer" };
    const lic = this.licenses.get(rec.licenseId);
    if (!lic || this.licenses.isRevoked(rec.licenseId)) return { ok: false, status: 403, error: "this licence has been revoked — contact support" };
    if (lic.exp <= this.now()) return { ok: false, status: 403, error: "this licence has lapsed — renew it first (see Manage billing)" };
    if (!releaseReady) return { ok: false, status: 503, error: "no release is published on the Hub right now — check back shortly" };
    const raw = this.billing.store.mint("install", rec.licenseId, rec.key, this.now());
    return { ok: true, command: `curl -q -fsSL "${this.origin}/install/${raw}" | sudo bash` };
  }

  /** POST /api/customer/portal. Ownership-checked, then the exact Stripe
   *  call `portalRedirect`/`portalSession` already make. */
  async portalUrlFor(identity: CustomerIdentity, customerKey: string): Promise<PortalOutcome> {
    const rec = this.ownedCustomer(identity, customerKey);
    if (!rec) return { ok: false, status: 404, error: "unknown customer" };
    return this.billing.portalRedirectForCustomer(customerKey, `${this.origin}/customer`);
  }
}
