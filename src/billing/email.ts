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

// Light-theme tokens lifted from the app itself. Dark email bodies get
// inverted or mangled by Gmail's dark-mode rewriter, so this commits to light
// regardless of the recipient's client theme.
const BG = "#f2f3f8";
const CARD = "#ffffff";
const BORDER = "#d4d9e6";
const BORDER_SOFT = "#e2e5ef";
const INSET = "#e9ebf2";
const INK = "#1b2233";
const MUTED = "#57617b";
const DIM = "#8a92a8";
const ACCENT = "#584fe6";
const ACCENT_DIM = "rgba(88,79,230,.10)";
const WARN = "#a8720f";
const WARN_DIM = "rgba(168,114,15,.12)";
const FONT = "-apple-system,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

const SETUP_STEPS: ReadonlyArray<readonly [string, string]> = [
  ["Get a server", "A fresh Ubuntu 22.04 or newer VPS with 1 GB RAM and root access — Vultr, Hetzner and DigitalOcean all work. One server per licence."],
  ["Run the one-line command", "Open your install page, press Copy, and paste the command into an SSH session as root. It installs Node, the signed Unleashed release and HTTPS, then prints your dashboard address and asks you to choose a password. About three minutes."],
  ["Connect your exchange", "Sign in to the dashboard and add an API key with trade permission only — withdrawals off, IP allowlist on. Supported: Bybit, Bitget, Bitunix, Binance, Aster. Bybit and Bitget offer demo accounts; start there if you can."],
  ["Start small", "Let the guided setup create your first bot, run it in demo or with small sizes, and grow from there."],
];

const GOOD_TO_KNOW: readonly string[] = [
  "Updates are signed and applied from inside the app; you never re-run the installer.",
  "Your bot checks in with our Hub every few minutes; renewals reach it automatically.",
  "One server per licence: a second server using the same licence is put into exit-only mode.",
  "Moving servers? Stop the old one first; the new one takes over about 30 minutes later.",
  "If your subscription lapses, the bot keeps closing and protecting positions but opens nothing new until it is renewed.",
];

/** The one email a buyer receives: where their install page is. The licence
 *  key itself is never in an email — the page mints a one-time install
 *  command, so a forwarded or leaked message is a link that can be rotated,
 *  not a credential that cannot. */
export function welcomeEmail(to: string, input: WelcomeEmailInput): EmailMessage {
  const first = input.name.trim().split(/\s+/)[0] || "there";
  const until = dateOf(input.expiresAtMs);
  const planValue = input.livemode ? "Unleashed" : "Unleashed (test)";
  const renewalValue = input.subscription
    ? "Extends automatically each time your subscription renews"
    : "One-time purchase";
  const origin = input.siteOrigin.replace(/\/+$/, "");
  const billingUrl = origin ? `${origin}/billing` : "";
  const subject = `${input.livemode ? "" : "[TEST] "}Your Wick Hunter Unleashed licence and install link`;

  // ── plain text ───────────────────────────────────────────────────────────
  const text = [
    `Wick Hunter — Unleashed`,
    ``,
    `Hi ${first},`,
    ``,
    `Thanks for buying Wick Hunter Unleashed. Your licence is active until ${until}.`,
    ``,
    `YOUR LICENCE`,
    `  Plan: ${planValue}`,
    `  Valid until: ${until}`,
    `  Renewal: ${renewalValue}`,
    `  Email: ${to}`,
    ``,
    input.livemode ? null : `This is a TEST-MODE purchase. No real payment was taken.`,
    input.livemode ? null : ``,
    `OPEN YOUR INSTALL PAGE`,
    `  ${input.pageUrl}`,
    ``,
    `Your page issues a fresh one-time install command each time you open it. Keep the link private — anyone who has it can install with your licence.`,
    ``,
    `SET-UP IN FOUR STEPS`,
    ...SETUP_STEPS.map(([title, desc], i) => `${i + 1}. ${title} — ${desc}`),
    ``,
    `GOOD TO KNOW`,
    ...GOOD_TO_KNOW.map((line) => `- ${line}`),
    ``,
    `BILLING AND HELP`,
    billingUrl ? `Manage billing: ${billingUrl}` : null,
    `Cancel any time; your licence stays active to the end of the paid period.`,
    `Questions? Just reply to this email.`,
    ``,
    `If the button does not work, copy this link:`,
    `  ${input.pageUrl}`,
    ``,
    `— Wick Hunter Software LLC`,
    origin || null,
  ].filter((line): line is string => line !== null).join("\n").replace(/\n{3,}/g, "\n\n");

  // ── html ─────────────────────────────────────────────────────────────────
  const logoCell = origin
    ? `<td width="44" style="width:44px;padding-right:12px;vertical-align:middle"><img src="${escapeHtml(origin)}/assets/icon-192.png" width="44" height="44" alt="Wick Hunter" style="display:block;border:0;border-radius:10px"></td>`
    : "";
  const wordmark = `<td style="vertical-align:middle">
    <div style="font-family:${FONT};font-size:18px;font-weight:700;color:${INK};line-height:1.2">Wick<span style="color:${ACCENT}">Hunter</span></div>
    <div style="font-family:${FONT};font-size:9px;font-weight:600;letter-spacing:2.6px;text-transform:uppercase;color:${DIM};margin-top:3px">UNLEASHED</div>
  </td>`;

  const licenceRows = ([
    ["Plan", escapeHtml(planValue)],
    ["Valid until", escapeHtml(until)],
    ["Renewal", escapeHtml(renewalValue)],
    ["Email", escapeHtml(to)],
  ] as const).map(([label, value], i) => `
    <tr>
      <td style="padding:${i === 0 ? "0" : "8px"} 0 0;font-family:${FONT};font-size:13px;color:${DIM};white-space:nowrap;vertical-align:top">${label}</td>
      <td style="padding:${i === 0 ? "0" : "8px"} 0 0 16px;font-family:${FONT};font-size:13px;color:${INK};font-weight:600;text-align:right;width:100%">${value}</td>
    </tr>`).join("");

  const noticeHtml = input.livemode ? "" : `
    <tr><td style="padding:0 0 20px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${WARN_DIM};border:1px solid rgba(168,114,15,.35);border-radius:10px">
        <tr><td style="padding:12px 14px;font-family:${FONT};font-size:13px;color:${WARN};line-height:1.5">This is a <strong>test-mode</strong> purchase. No real payment was taken.</td></tr>
      </table>
    </td></tr>`;

  const stepsHtml = SETUP_STEPS.map(([title, desc], i) => `
    <tr>
      <td width="30" style="width:30px;padding:${i === 0 ? "0" : "16px"} 0 0;vertical-align:top">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="24" height="24" align="center" style="width:24px;height:24px;background-color:${ACCENT_DIM};border-radius:12px;font-family:${FONT};font-size:12px;font-weight:700;color:${ACCENT};text-align:center;line-height:24px">${i + 1}</td></tr></table>
      </td>
      <td style="padding:${i === 0 ? "0" : "16px"} 0 0 12px;vertical-align:top">
        <div style="font-family:${FONT};font-size:14px;font-weight:700;color:${INK}">${escapeHtml(title)}</div>
        <div style="font-family:${FONT};font-size:13px;color:${MUTED};line-height:1.5;margin-top:2px">${escapeHtml(desc)}</div>
      </td>
    </tr>`).join("");

  const goodToKnowHtml = GOOD_TO_KNOW.map((line, i) => `
    <tr><td style="padding:${i === 0 ? "0" : "8px"} 0 0;font-family:${FONT};font-size:13px;color:${MUTED};line-height:1.5">
      <span style="color:${ACCENT}">&bull;</span>&nbsp; ${escapeHtml(line)}
    </td></tr>`).join("");

  const manageBillingBtn = billingUrl
    ? `<a href="${escapeHtml(billingUrl)}" style="display:inline-block;font-family:${FONT};font-size:13px;font-weight:600;color:${ACCENT};background-color:${CARD};border:1px solid ${BORDER};text-decoration:none;padding:10px 18px;border-radius:10px">Manage billing</a>`
    : "";

  const footerOrigin = origin
    ? `<a href="${escapeHtml(origin)}" style="color:${DIM};text-decoration:underline">${escapeHtml(origin.replace(/^https?:\/\//, ""))}</a>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Wick Hunter Unleashed</title>
<style>
  @media only screen and (max-width:620px) {
    .wh-container { width:100% !important; }
    .wh-px { padding-left:20px !important; padding-right:20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${BG}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BG};margin:0;padding:0;width:100%">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="wh-container" style="width:600px;max-width:600px">

<tr><td class="wh-px" style="padding:0 4px 20px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${logoCell}${wordmark}</tr></table>
</td></tr>

<tr><td class="wh-px" style="background-color:${CARD};border:1px solid ${BORDER};border-radius:14px;padding:32px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

    <tr><td style="font-family:${FONT};font-size:16px;color:${INK};padding:0 0 8px">Hi ${escapeHtml(first)},</td></tr>
    <tr><td style="font-family:${FONT};font-size:14px;color:${MUTED};line-height:1.6;padding:0 0 22px">Thanks for buying Wick Hunter Unleashed. Your licence is active until <strong style="color:${INK}">${escapeHtml(until)}</strong>.</td></tr>

    <tr><td style="padding:0 0 20px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${INSET};border:1px solid ${BORDER_SOFT};border-radius:10px">
        <tr><td style="padding:16px 18px">
          <div style="font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${DIM};padding-bottom:10px">Your licence</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${licenceRows}</table>
        </td></tr>
      </table>
    </td></tr>
${noticeHtml}
    <tr><td style="padding:0 0 8px">
      <a href="${escapeHtml(input.pageUrl)}" style="display:inline-block;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;background-color:${ACCENT};text-decoration:none;padding:13px 22px;border-radius:10px">Open your install page</a>
    </td></tr>
    <tr><td style="font-family:${FONT};font-size:12.5px;color:${DIM};line-height:1.5;padding:0 0 28px">Your page issues a fresh one-time install command each time you open it. Keep the link private — anyone who has it can install with your licence.</td></tr>

    <tr><td style="font-family:${FONT};font-size:13px;font-weight:700;color:${INK};padding:24px 0 12px;border-top:1px solid ${BORDER_SOFT}">Set-up in four steps</td></tr>
    <tr><td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${stepsHtml}</table>
    </td></tr>

    <tr><td style="font-family:${FONT};font-size:13px;font-weight:700;color:${INK};padding:24px 0 12px;border-top:1px solid ${BORDER_SOFT}">Good to know</td></tr>
    <tr><td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${goodToKnowHtml}</table>
    </td></tr>

    <tr><td style="font-family:${FONT};font-size:13px;font-weight:700;color:${INK};padding:24px 0 12px;border-top:1px solid ${BORDER_SOFT}">Billing and help</td></tr>
    ${manageBillingBtn ? `<tr><td style="padding:0 0 14px">${manageBillingBtn}</td></tr>` : ""}
    <tr><td style="font-family:${FONT};font-size:13px;color:${MUTED};line-height:1.6;padding:0 0 4px">Cancel any time; your licence stays active to the end of the paid period.</td></tr>
    <tr><td style="font-family:${FONT};font-size:13px;color:${MUTED};line-height:1.6">Questions? Just reply to this email.</td></tr>

  </table>
</td></tr>

<tr><td class="wh-px" style="padding:22px 4px 0">
  <p style="margin:0 0 6px;font-family:${FONT};font-size:12px;color:${DIM};line-height:1.6">If the button does not work, copy this link:<br><span style="word-break:break-all;font-family:${MONO}">${escapeHtml(input.pageUrl)}</span></p>
  <p style="margin:0;font-family:${FONT};font-size:12px;color:${DIM}">Wick Hunter Software LLC${footerOrigin ? ` &middot; ${footerOrigin}` : ""}</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

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
