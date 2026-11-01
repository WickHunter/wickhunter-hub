// src/password-reset.ts
//
// Dashboard password reset by emailed code (operator decision 2026-11-01:
// "Email code via Hub"). A customer who has forgotten the password of their
// OWN Unleashed install asks that install for a reset; the install (not the
// browser) asks this Hub to email a one-time code to the licence owner's
// billing email; the customer types the code into the install; the install
// asks this Hub to check it and receives a SIGNED, single-use approval bound
// to the exact licence, install, request and the install's own nonce. Only
// that approval lets the install replace its local credential.
//
// AUTHENTICATION is the licence check-in's: the install presents its LHK1
// token in the body and the Hub verifies the signature and that the token's id
// is the claimed licence. A genuine but EXPIRED licence may still reset (the
// same hearing check-in gives a lapsed customer, so they can reach exit-only);
// a revoked or deleted licence may not.
//
// WHAT IS STORED: never the code. Each request row keeps a random salt and
// sha256(salt ‖ code); a check compares in constant time. The audit log
// (data/password-reset-audit.v1.jsonl) records what happened and to which
// licence/install, never the code, the email body, or the full address.
//
// LIMITS: a code lives 15 minutes, works once, and a request locks after five
// wrong codes. A new request supersedes every open one for the same licence +
// install. Request and verify are each rate-limited per licence here; the
// caller adds per-IP limits and the install adds per-browser-IP limits.
//
// THE APPROVAL reuses the WHBA1 recipe (src/billing/service.ts): the payload
// bytes are signed by the licence key whose public half every app already
// pins, under its own schema so it cannot be mistaken for a licence or a
// billing-access token:
//   WHPR1.<base64url(payload)>.<base64url(Ed25519(payload))>
//   payload = {schema:"wickhunter.password-reset-approval.v1", licenseId,
//              installId, requestId, nonce, issuedAtMs, expiresAtMs}
import { createHash, randomBytes as nodeRandomBytes, randomInt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { appendJsonl, readJson, writeJsonAtomic } from "./jsonfile.js";
import type { LicenseStore } from "./license.js";
import { escapeHtml, sendEmail, type EmailFetch, type EmailMessage } from "./billing/email.js";
import type { EmailConfig } from "./billing/config.js";
import { emailReady } from "./billing/config.js";

export const RESET_CODES_FILE = "password-reset-codes.v1.json";
export const RESET_AUDIT_FILE = "password-reset-audit.v1.jsonl";
export const RESET_APPROVAL_PREFIX = "WHPR1";
export const RESET_APPROVAL_SCHEMA = "wickhunter.password-reset-approval.v1";
export const RESET_CODE_DIGITS = 8;
export const RESET_CODE_TTL_MS = 15 * 60_000;
export const RESET_APPROVAL_TTL_MS = 2 * 60_000;
export const RESET_MAX_WRONG_CODES = 5;
/** Rows (open, used, expired) older than this are dropped on the next write. */
const ROW_RETENTION_MS = 24 * 60 * 60_000;
const MAX_ROWS = 5_000;
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE_SHAPE = /^[A-Za-z0-9_-]{22,64}$/;
const REQUEST_ID_SHAPE = /^pr_[a-f0-9]{32}$/;

export interface ResetRow {
  requestId: string;
  licenseId: string;
  installId: string;
  salt: string;
  codeHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  wrongAttempts: number;
  usedAtMs: number | null;
  lockedAtMs: number | null;
  supersededAtMs: number | null;
  label: string;
  ipApprox: string;
}

export type ResetAuditKind =
  | "requested" | "emailed" | "email_failed" | "no_email_on_file" | "email_not_configured"
  | "verified" | "wrong_code" | "locked" | "expired" | "used" | "unknown_request";

export interface ResetAuditEntry {
  at: number;
  kind: ResetAuditKind;
  licenseId: string;
  installId: string;
  requestId: string | null;
  /** The Hub-side caller (the install's server), approximated. */
  callerIpApprox: string;
  /** What the install said about the browser that asked, approximated. */
  requesterIpApprox: string;
  /** Masked recipient (a***@example.com), only for email outcomes. */
  to?: string;
  detail?: string;
}

/** Approximate an address for display: IPv4 last octet zeroed, IPv6 to /48.
 *  Anything that is not an IP becomes "unknown" — this text reaches an
 *  email, so it is never passed through unvalidated. */
export function approximateIp(raw: unknown): string {
  const s = String(raw ?? "").trim().replace(/^::ffff:/, "");
  const kind = isIP(s);
  if (kind === 4) return s.split(".").slice(0, 3).concat("0").join(".");
  if (kind === 6) {
    const head = s.split("::")[0]!.split(":").filter(Boolean).slice(0, 3);
    while (head.length < 3) head.push("0");
    return `${head.join(":")}::/48`;
  }
  return "unknown";
}

/** An install's self-chosen label is untrusted display text. */
export function cleanLabel(raw: unknown): string {
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 64) || "your Unleashed install";
}

export function maskEmail(email: string): string {
  const [user, domain] = String(email).split("@");
  if (!user || !domain) return "unknown";
  return `${user[0]}***@${domain}`;
}

const hashCode = (salt: string, code: string): string =>
  createHash("sha256").update(`${salt}\n${code}`).digest("hex");

export type RequestResetResult =
  | { ok: true; requestId: string; expiresAtMs: number }
  | { ok: false; status: number; error: string };

export type VerifyResetResult =
  | { ok: true; approval: string; expiresAtMs: number }
  | { ok: false; status: number; error: string; locked?: boolean };

export interface PasswordResetDeps {
  now?: () => number;
  randomBytes?: (n: number) => Buffer;
  /** Code generator — injectable so a suite can know the code without
   *  reading an email. Production is a uniform `crypto.randomInt`. */
  newCode?: () => string;
  fetchLike?: EmailFetch;
  log?: (line: string) => void;
}

export interface ResetEmailFacts {
  code: string;
  label: string;
  requesterIpApprox: string;
  expiresAtMs: number;
}

/** Plain text + light HTML, the same palette and tone as the other Hub mails.
 *  Every interpolated field is escaped; the code is digits only by
 *  construction. */
export function resetCodeEmail(to: string, f: ResetEmailFacts): EmailMessage {
  const minutes = Math.round(RESET_CODE_TTL_MS / 60_000);
  const expires = new Date(f.expiresAtMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const who = f.requesterIpApprox === "unknown"
    ? `Requested from ${f.label}.`
    : `Requested from ${f.label}, by a browser at approximately ${f.requesterIpApprox}.`;
  const subject = "Your Wick Hunter dashboard password reset code";
  const text = [
    `Your password reset code is:`,
    ``,
    `    ${f.code}`,
    ``,
    who,
    `Enter it on your dashboard's sign-in page within ${minutes} minutes (it expires at ${expires}). It works once.`,
    ``,
    `If you did not ask for this, ignore this email. Your password stays the same unless this code is entered on your dashboard.`,
    ``,
    `Questions? admin@wickhunterunleashed.com`,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f2f3f8;padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1b2233">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #d4d9e6;border-radius:14px;padding:28px 26px">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:#57617b;font-weight:700">Wick Hunter Unleashed</p>
<h1 style="margin:0 0 16px;font-size:20px">Your password reset code</h1>
<p style="margin:0 0 18px;font-size:30px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;background:#e9ebf2;border-radius:10px;padding:14px 16px;text-align:center">${escapeHtml(f.code)}</p>
<p style="margin:0 0 10px;font-size:14px;line-height:1.5">${escapeHtml(who)}</p>
<p style="margin:0 0 10px;font-size:14px;line-height:1.5">Enter it on your dashboard's sign-in page within <b>${minutes} minutes</b> (it expires at ${escapeHtml(expires)}). It works once.</p>
<p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#57617b">If you did not ask for this, ignore this email. Your password stays the same unless this code is entered on your dashboard.</p>
<p style="margin:18px 0 0;font-size:12px;color:#8a92a8">Questions? admin@wickhunterunleashed.com</p>
</div></body></html>`;
  return { to, subject, text, html };
}

export class PasswordResetService {
  private readonly rowsFile: string;
  private readonly auditFile: string;
  private readonly now: () => number;
  private readonly randomBytes: (n: number) => Buffer;
  private readonly newCode: () => string;
  private readonly fetchLike: EmailFetch;
  private readonly log: (line: string) => void;

  constructor(
    readonly dataDir: string,
    private readonly licenses: LicenseStore,
    /** The licence owner's email, or null when none is on file (an
     *  admin-issued tester licence has no billing customer). */
    private readonly emailFor: (licenseId: string) => string | null,
    private readonly emailConfig: () => EmailConfig,
    deps: PasswordResetDeps = {},
  ) {
    this.rowsFile = path.join(dataDir, RESET_CODES_FILE);
    this.auditFile = path.join(dataDir, RESET_AUDIT_FILE);
    this.now = deps.now ?? Date.now;
    this.randomBytes = deps.randomBytes ?? nodeRandomBytes;
    this.newCode = deps.newCode ?? (() => String(randomInt(0, 10 ** RESET_CODE_DIGITS)).padStart(RESET_CODE_DIGITS, "0"));
    this.fetchLike = deps.fetchLike ?? (async (url, init) => {
      const r = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) });
      return { ok: r.ok, status: r.status, text: () => r.text() };
    });
    this.log = deps.log ?? ((line) => console.log(line));
  }

  private rows(): Record<string, ResetRow> {
    return Object.assign(Object.create(null) as Record<string, ResetRow>, readJson<Record<string, ResetRow>>(this.rowsFile, {}));
  }

  private saveRows(rows: Record<string, ResetRow>, now: number): void {
    const keep = Object.values(rows)
      .filter((r) => now - r.createdAtMs < ROW_RETENTION_MS)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, MAX_ROWS);
    const out: Record<string, ResetRow> = Object.create(null);
    for (const r of keep) out[r.requestId] = r;
    writeJsonAtomic(this.rowsFile, out);
  }

  private audit(entry: ResetAuditEntry): void {
    try { appendJsonl(this.auditFile, entry); }
    catch (e) { this.log(`[password-reset] audit write failed: ${(e as Error).message}`); }
  }

  /** The licence-authentication step both routes share. */
  authenticate(body: Record<string, unknown>): { ok: true; licenseId: string; installId: string } | { ok: false; status: number; error: string } {
    const licenseId = typeof body.licenseId === "string" ? body.licenseId : "";
    const installId = typeof body.installId === "string" ? body.installId : "";
    if (!ID_SHAPE.test(licenseId) || !ID_SHAPE.test(installId)) return { ok: false, status: 400, error: "bad password reset body" };
    const presented = typeof body.token === "string" && body.token.length <= 4096 ? this.licenses.decodeGenuine(body.token) : null;
    if (!presented || presented.id !== licenseId) return { ok: false, status: 401, error: "signed licence token required" };
    if (!this.licenses.isKnown(licenseId) || this.licenses.isRevoked(licenseId)) {
      return { ok: false, status: 403, error: "this licence cannot reset a password" };
    }
    return { ok: true, licenseId, installId };
  }

  /** Mint, store (hashed) and email a code. The answer is the same whether
   *  or not an email is on file or the send succeeded: the install's user
   *  learns nothing about the account from it. */
  async request(licenseId: string, installId: string, label: unknown, requesterIp: unknown, callerIp: string): Promise<RequestResetResult> {
    const now = this.now();
    const rows = this.rows();
    for (const r of Object.values(rows)) {
      if (r.licenseId === licenseId && r.installId === installId && r.usedAtMs === null && r.supersededAtMs === null) {
        r.supersededAtMs = now;
      }
    }
    const code = this.newCode();
    if (!new RegExp(`^[0-9]{${RESET_CODE_DIGITS}}$`).test(code)) throw new Error("password reset code generator returned a malformed code");
    const salt = this.randomBytes(16).toString("hex");
    const row: ResetRow = {
      requestId: `pr_${this.randomBytes(16).toString("hex")}`,
      licenseId, installId, salt, codeHash: hashCode(salt, code),
      createdAtMs: now, expiresAtMs: now + RESET_CODE_TTL_MS,
      wrongAttempts: 0, usedAtMs: null, lockedAtMs: null, supersededAtMs: null,
      label: cleanLabel(label), ipApprox: approximateIp(requesterIp),
    };
    rows[row.requestId] = row;
    this.saveRows(rows, now);
    const base = { licenseId, installId, requestId: row.requestId, callerIpApprox: approximateIp(callerIp), requesterIpApprox: row.ipApprox };
    this.audit({ at: now, kind: "requested", ...base });

    const to = this.emailFor(licenseId);
    if (!to || !to.includes("@")) {
      this.audit({ at: now, kind: "no_email_on_file", ...base });
    } else if (!emailReady(this.emailConfig())) {
      this.audit({ at: now, kind: "email_not_configured", ...base, to: maskEmail(to) });
    } else {
      const sent = await sendEmail(this.emailConfig(), resetCodeEmail(to, { code, label: row.label, requesterIpApprox: row.ipApprox, expiresAtMs: row.expiresAtMs }), this.fetchLike);
      if (sent.ok) this.audit({ at: this.now(), kind: "emailed", ...base, to: maskEmail(to) });
      else this.audit({ at: this.now(), kind: "email_failed", ...base, to: maskEmail(to), detail: sent.error.replace(/[0-9]{6,}/g, "#").slice(0, 200) });
    }
    return { ok: true, requestId: row.requestId, expiresAtMs: row.expiresAtMs };
  }

  /** Check a code. A right code consumes the request (durably, BEFORE the
   *  approval is signed) and returns the signed approval; every wrong
   *  answer is the same generic refusal. */
  verify(licenseId: string, installId: string, requestId: unknown, code: unknown, nonce: unknown, callerIp: string): VerifyResetResult {
    const now = this.now();
    const generic = { ok: false as const, status: 400, error: "the code is wrong or has expired — request a new one" };
    if (typeof requestId !== "string" || !REQUEST_ID_SHAPE.test(requestId)) return generic;
    if (typeof nonce !== "string" || !NONCE_SHAPE.test(nonce)) return { ok: false, status: 400, error: "bad password reset body" };
    const cleanCode = typeof code === "string" ? code.replace(/\s+/g, "") : "";
    const rows = this.rows();
    const row = rows[requestId];
    const base = { licenseId, installId, requestId, callerIpApprox: approximateIp(callerIp), requesterIpApprox: row?.ipApprox ?? "unknown" };
    if (!row || row.licenseId !== licenseId || row.installId !== installId) {
      this.audit({ at: now, kind: "unknown_request", ...base });
      return generic;
    }
    if (row.usedAtMs !== null || row.supersededAtMs !== null) { this.audit({ at: now, kind: "used", ...base }); return generic; }
    if (row.lockedAtMs !== null) { this.audit({ at: now, kind: "locked", ...base }); return { ...generic, locked: true }; }
    if (now >= row.expiresAtMs) { this.audit({ at: now, kind: "expired", ...base }); return generic; }

    const got = Buffer.from(hashCode(row.salt, /^[0-9]{6,8}$/.test(cleanCode) ? cleanCode : "-"), "hex");
    const want = Buffer.from(row.codeHash, "hex");
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      row.wrongAttempts += 1;
      const locked = row.wrongAttempts >= RESET_MAX_WRONG_CODES;
      if (locked) row.lockedAtMs = now;
      this.saveRows(rows, now);
      this.audit({ at: now, kind: locked ? "locked" : "wrong_code", ...base, detail: `wrong attempts ${row.wrongAttempts}` });
      return locked ? { ...generic, locked: true } : generic;
    }

    row.usedAtMs = now;
    this.saveRows(rows, now); // durable single use BEFORE anything is signed
    const expiresAtMs = now + RESET_APPROVAL_TTL_MS;
    const payload = Buffer.from(JSON.stringify({
      schema: RESET_APPROVAL_SCHEMA, licenseId, installId, requestId, nonce, issuedAtMs: now, expiresAtMs,
    }));
    const approval = `${RESET_APPROVAL_PREFIX}.${payload.toString("base64url")}.${this.licenses.sign(payload).toString("base64url")}`;
    this.audit({ at: now, kind: "verified", ...base });
    return { ok: true, approval, expiresAtMs };
  }

  /** The admin view: newest first, never a code or a full address. */
  recentAudit(limit = 200): ResetAuditEntry[] {
    let text = "";
    try { text = fs.readFileSync(this.auditFile, "utf8"); } catch { return []; }
    const out: ResetAuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as ResetAuditEntry); } catch { /* a torn final line */ }
    }
    return out.slice(-Math.max(1, Math.min(1000, limit))).reverse();
  }
}
