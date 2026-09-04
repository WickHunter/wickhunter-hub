// src/billing/email.ts
// Transactional email with no SDK: Resend and Postmark are each one JSON POST
// with a bearer/server token, which is all this Hub needs to hand a buyer the
// link to their install page. SES is deliberately not here — it needs SigV4
// request signing, and that is a dependency for one message type.
//
// The fetch is injected so the suite never leaves loopback, and every failure
// is returned as a string rather than thrown: an email that could not be sent
// is recorded against the customer and re-sent from the admin page; it never
// fails the Stripe webhook that carried the payment.
import type { EmailConfig } from "./config.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}
export interface EmailFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type EmailFetch = (url: string, init: EmailFetchInit) => Promise<EmailFetchResponse>;

export type SendEmailResult = { ok: true; id: string | null } | { ok: false; error: string };

const RESEND_URL = "https://api.resend.com/emails";
const POSTMARK_URL = "https://api.postmarkapp.com/email";

export async function sendEmail(cfg: EmailConfig, msg: EmailMessage, fetchLike: EmailFetch): Promise<SendEmailResult> {
  if (cfg.provider === "none") return { ok: false, error: "no email provider is configured" };
  if (!cfg.apiKey) return { ok: false, error: `the ${cfg.provider} API key is not configured` };
  if (!cfg.from) return { ok: false, error: "the From address is not configured" };
  if (!msg.to || !msg.to.includes("@")) return { ok: false, error: "the recipient address is missing" };
  let url: string;
  let init: EmailFetchInit;
  if (cfg.provider === "resend") {
    url = RESEND_URL;
    init = {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: cfg.from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
      }),
    };
  } else {
    url = POSTMARK_URL;
    init = {
      method: "POST",
      headers: { "x-postmark-server-token": cfg.apiKey, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        From: cfg.from,
        To: msg.to,
        Subject: msg.subject,
        TextBody: msg.text,
        HtmlBody: msg.html,
        MessageStream: "outbound",
        ...(cfg.replyTo ? { ReplyTo: cfg.replyTo } : {}),
      }),
    };
  }
  let res: EmailFetchResponse;
  try {
    res = await fetchLike(url, init);
  } catch (err) {
    return { ok: false, error: `${cfg.provider}: ${(err as Error).message}` };
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    // Provider errors are short JSON; keep enough to diagnose, never the key.
    return { ok: false, error: `${cfg.provider} answered ${res.status}: ${body.slice(0, 300)}` };
  }
  let id: string | null = null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    id = typeof parsed.id === "string" ? parsed.id : typeof parsed.MessageID === "string" ? parsed.MessageID : null;
  } catch { /* an unparseable 2xx is still a send */ }
  return { ok: true, id };
}

// ── messages ────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface WelcomeEmailInput {
  name: string;
  pageUrl: string;
  expiresAtMs: number;
  subscription: boolean;
  siteOrigin: string;
  livemode: boolean;
}

/** The one email a buyer receives: where their install page is. The licence
 *  key itself is never in an email — the page mints a one-time install
 *  command, so a forwarded or leaked message is a link that can be rotated,
 *  not a credential that cannot. */
export function welcomeEmail(to: string, input: WelcomeEmailInput): EmailMessage {
  const first = input.name.trim().split(/\s+/)[0] || "there";
  const until = dateOf(input.expiresAtMs);
  const renewLine = input.subscription
    ? `Your licence is active until ${until} and extends automatically each time your subscription renews.`
    : `Your licence is active until ${until}.`;
  const billing = input.siteOrigin ? `${input.siteOrigin.replace(/\/+$/, "")}/billing` : "";
  const testNote = input.livemode ? "" : "\n(This is a TEST-MODE purchase. No real payment was taken.)\n";
  const subject = `${input.livemode ? "" : "[TEST] "}Your Wick Hunter Unleashed licence and install link`;
  const text = [
    `Hi ${first},`,
    ``,
    `Thanks for buying Wick Hunter Unleashed. ${renewLine}`,
    testNote.trim(),
    `Your personal install page:`,
    `  ${input.pageUrl}`,
    ``,
    `It gives you a one-line command to run on a fresh Ubuntu 22.04+ server (1 GB RAM is plenty). The command installs Node, the signed Unleashed release and HTTPS, then prints your dashboard address — about three minutes. Come back to the same page any time you need to reinstall; it issues a fresh command each visit.`,
    ``,
    `Keep the link private: anyone who has it can install with your licence.`,
    ``,
    billing ? `Manage your subscription, card or invoices: ${billing}` : ``,
    `Questions? Just reply to this email.`,
    ``,
    `— Wick Hunter Software`,
  ].filter((line) => line !== null).join("\n").replace(/\n{3,}/g, "\n\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f3f8;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1b2233">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #d4d9e6;border-radius:14px;padding:28px">
  <p style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8a92a8;margin:0 0 14px">Wick Hunter <span style="color:#584fe6">Unleashed</span></p>
  <p style="font-size:16px;margin:0 0 14px">Hi ${escapeHtml(first)},</p>
  <p style="margin:0 0 14px">Thanks for buying Wick Hunter Unleashed. ${escapeHtml(renewLine)}</p>
  ${input.livemode ? "" : `<p style="margin:0 0 14px;padding:10px 12px;background:#fff4e0;border:1px solid #f2a93b;border-radius:8px;font-size:13px">This is a <b>test-mode</b> purchase. No real payment was taken.</p>`}
  <p style="margin:0 0 18px"><a href="${escapeHtml(input.pageUrl)}" style="display:inline-block;background:#584fe6;color:#fff;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:10px">Open your install page</a></p>
  <p style="margin:0 0 14px;font-size:14px;color:#57617b">It gives you a one-line command to run on a fresh Ubuntu 22.04+ server (1&nbsp;GB RAM is plenty). The command installs Node, the signed Unleashed release and HTTPS, then prints your dashboard address — about three minutes. Come back to the same page any time you need to reinstall; it issues a fresh command each visit.</p>
  <p style="margin:0 0 14px;font-size:14px;color:#57617b">Keep the link private: anyone who has it can install with your licence.</p>
  ${billing ? `<p style="margin:0 0 14px;font-size:14px"><a href="${escapeHtml(billing)}" style="color:#4b41d6">Manage your subscription, card or invoices</a></p>` : ""}
  <p style="margin:0;font-size:14px;color:#57617b">Questions? Just reply to this email.</p>
  <p style="margin:18px 0 0;font-size:13px;color:#8a92a8">If the button does not work, copy this link: <br><span style="word-break:break-all">${escapeHtml(input.pageUrl)}</span></p>
</div></body></html>`;
  return { to, subject, text, html };
}

export function testEmail(to: string, hubOrigin: string): EmailMessage {
  return {
    to,
    subject: "Wick Hunter Hub — email test",
    text: `This is a test message from the Wick Hunter Hub at ${hubOrigin}. If you can read this, the email provider is configured correctly.`,
    html: `<p>This is a test message from the Wick Hunter Hub at <code>${escapeHtml(hubOrigin)}</code>.</p><p>If you can read this, the email provider is configured correctly.</p>`,
  };
}
