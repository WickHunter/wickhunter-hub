// src/hosting/emails.ts
// The hosting transactional templates (handoff §9). Reuses
// src/billing/email.ts's transport (`sendEmail`/`EmailConfig`/`EmailFetch`)
// and its `escapeHtml` — one email pipeline for the whole Hub, never a
// second one for hosting. Every template escapes every interpolated field
// and sends both text and HTML, matching `welcomeEmail`'s shape exactly.
//
// SENDER/REPLY-TO are the operator's own configured `EmailConfig.from`/
// `replyTo` (billing/config.ts) — the handoff's "Wick Hunter Unleashed" /
// "admin@wickhunterunleashed.com" are operator copy to type into that same
// field, not a second sender identity this file invents.
//
// Every template names the reason and the exact dates it is given — never
// "3 days" when the real remaining time differs (§9: "do not send stale '3
// days' copy... send the correct remaining time"). The CALLER
// (src/hosting/service.ts) is responsible for computing an accurate label
// from the current clock and the stored deadline; these functions format
// whatever they are handed.
import { emailButton, emailCode, emailFacts, emailHeading, emailLayout, emailParagraph, emailSteps, escapeHtml, SUPPORT_EMAIL, type EmailMessage } from "../billing/email.js";

export function fmtDate(ms: number, tz = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(ms)) + ` ${tz}`;
  } catch {
    return new Date(ms).toISOString();
  }
}

export interface InstanceEmailFacts {
  instanceReference: string;
  appUrl: string;
  region: string;
  cpu: string;
  ram: string;
  storage: string;
  os: string;
  ip: string;
  appUsername: string;
  sshUsername: string;
  sshPort: number;
  accessUrl: string;
  temporaryPassword: string;
  maximumConnectedAccounts: number;
  billingSummary: string;
  renewalAt: number | null;
  backupScopeSentence: string;
}

const SUPPORT_LINE = `Questions? Reply to this email or write to ${SUPPORT_EMAIL}.`;

/** Paragraph HTML (already escaped, "\n\n"-separated) in the shared branded
 *  layout, so every hosting email reads like the welcome email and reflows
 *  to one column on a phone. */
function layoutHtml(bodyHtml: string, preheader?: string): string {
  const rows = bodyHtml.split("\n\n").map((p) => p.trim()).filter(Boolean)
    .map((p) => p.startsWith("<tr>") ? p : emailParagraph(p))
    .join("\n");
  return emailLayout({ preheader, rows: rows + "\n" + emailParagraph(escapeHtml(SUPPORT_LINE).replace(escapeHtml(SUPPORT_EMAIL), `<a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>`), { muted: true, size: 13, pad: 0 }) });
}

function wrap(subject: string, bodyText: string, bodyHtml: string, preheader?: string): EmailMessage {
  return {
    to: "",
    subject,
    text: `${bodyText}\n\n${SUPPORT_LINE}`,
    html: layoutHtml(bodyHtml, preheader),
  };
}
function withTo(msg: EmailMessage, to: string): EmailMessage {
  return { ...msg, to };
}
/** Escaped plain text with its bare https links made clickable. */
function linkify(escaped: string): string {
  return escaped.replace(/https:\/\/[^\s<]+[^\s<.,;:)]/g, (url) => `<a href="${url}">${url}</a>`);
}

export function installationReadyEmail(to: string, firstName: string, f: InstanceEmailFacts): EmailMessage {
  const first = firstName || "there";
  const renewal = f.renewalAt !== null ? fmtDate(f.renewalAt) : "not yet scheduled";
  const steps: ReadonlyArray<readonly [string, string]> = [
    ["Open your dashboard", `Go to ${f.appUrl} and sign in as ${f.appUsername} with the temporary password above.`],
    ["Choose your own password", "The dashboard asks for a new password before anything else. Everything happens in your browser."],
    ["Connect your exchange", "Add an API key with trade permission only — withdrawals off."],
    ["Review and start your bots", "Your bots stay paused until you review their settings and start them."],
  ];
  const text = [
    `Hi ${first},`,
    `Your Unleashed server is ready. Sign in at the address below to finish setup. Your bots stay paused until you connect your exchange, review your settings, and start them.`,
    `SIGN IN\nDashboard: ${f.appUrl}\nUsername: ${f.appUsername}\nTemporary password: ${f.temporaryPassword}`,
    `Keep this password private. You will choose your own password when you first sign in. If you lose this email before then, request a new temporary password from your account page: ${f.accessUrl}`,
    `NEXT STEPS\n${steps.map(([t, d], i) => `${i + 1}. ${t} — ${d}`).join("\n")}`,
    `Moving from another installation? Follow the migration steps before starting hosted bots so both installations never manage the same positions.`,
    `YOUR SERVER\nServer: ${f.instanceReference}\nLocation: ${f.region}\nCPU / RAM / storage: ${f.cpu} / ${f.ram} / ${f.storage}\nOperating system: ${f.os}\nIP address: ${f.ip}\nSSH (optional, administrators only): ${f.sshUsername} on port ${f.sshPort}, with separate credentials`,
    `This server supports up to ${f.maximumConnectedAccounts} connected exchange accounts. ${f.billingSummary} Next renewal: ${renewal}. ${f.backupScopeSentence}`,
  ].join("\n\n");
  const html = [
    emailParagraph(`Hi ${escapeHtml(first)},`, { size: 16, pad: 8 }),
    emailParagraph("Your Unleashed server is ready. Sign in at the address below to finish setup. Your bots stay paused until you connect your exchange, review your settings, and start them.", { muted: true, pad: 20 }),
    emailFacts("Sign in", [["Dashboard", `<a href="${escapeHtml(f.appUrl)}">${escapeHtml(f.appUrl)}</a>`], ["Username", escapeHtml(f.appUsername)]]),
    emailParagraph("Temporary password", { size: 12, pad: 6, muted: true }),
    emailCode(f.temporaryPassword),
    emailButton(f.appUrl, "Open your dashboard"),
    emailParagraph(`Keep this password private. You will choose your own password when you first sign in. Lost this email before then? <a href="${escapeHtml(f.accessUrl)}">Request a new temporary password</a> from your account page.`, { muted: true, size: 13, pad: 4 }),
    emailHeading("Next steps"),
    emailSteps(steps),
    emailParagraph("Moving from another installation? Follow the migration steps before starting hosted bots so both installations never manage the same positions.", { muted: true, size: 13 }),
    emailHeading("Your server"),
    emailFacts("Details", [["Server", escapeHtml(f.instanceReference)], ["Location", escapeHtml(f.region)], ["CPU / RAM / storage", `${escapeHtml(f.cpu)} / ${escapeHtml(f.ram)} / ${escapeHtml(f.storage)}`], ["Operating system", escapeHtml(f.os)], ["IP address", escapeHtml(f.ip)], ["SSH (optional)", `${escapeHtml(f.sshUsername)} · port ${f.sshPort} · separate credentials`]]),
    emailParagraph(`This server supports up to ${f.maximumConnectedAccounts} connected exchange accounts. ${escapeHtml(f.billingSummary)} Next renewal: ${escapeHtml(renewal)}. ${escapeHtml(f.backupScopeSentence)}`, { muted: true, size: 13 }),
  ].join("\n\n");
  return withTo(wrap("Your Unleashed VPS is ready", text, html, "Your dashboard address and temporary password are inside."), to);
}

export interface CredentialResetEmailFacts {
  instanceReference: string;
  appUrl: string;
  appUsername: string;
  accountUrl: string;
  temporaryPassword: string;
  requestedBy: "customer" | "operator";
}

/** The replacement temporary password, sent only after the server itself
 *  confirmed it now accepts it. */
export function credentialResetEmail(to: string, f: CredentialResetEmailFacts): EmailMessage {
  const who = f.requestedBy === "operator" ? "Our support team reset" : "As you requested, we reset";
  const text = [
    `${who} the dashboard password on your Unleashed server (${f.instanceReference}). Your previous password no longer works.`,
    `SIGN IN\nDashboard: ${f.appUrl}\nUsername: ${f.appUsername}\nTemporary password: ${f.temporaryPassword}`,
    `You will be asked to choose a new password when you sign in. Your bots, exchange connections and settings were not changed; the dashboard restarted briefly to apply the new password.`,
    `If you did not ask for this, sign in and choose a new password now, then contact support. Manage your server: ${f.accountUrl}`,
  ].join("\n\n");
  const html = [
    emailParagraph(`${escapeHtml(who)} the dashboard password on your Unleashed server (${escapeHtml(f.instanceReference)}). Your previous password no longer works.`, { pad: 20 }),
    emailFacts("Sign in", [["Dashboard", `<a href="${escapeHtml(f.appUrl)}">${escapeHtml(f.appUrl)}</a>`], ["Username", escapeHtml(f.appUsername)]]),
    emailParagraph("Temporary password", { size: 12, pad: 6, muted: true }),
    emailCode(f.temporaryPassword),
    emailButton(f.appUrl, "Open your dashboard"),
    emailParagraph("You will be asked to choose a new password when you sign in. Your bots, exchange connections and settings were not changed; the dashboard restarted briefly to apply the new password.", { muted: true, size: 13 }),
    emailParagraph(`If you did not ask for this, sign in and choose a new password now, then contact support. <a href="${escapeHtml(f.accountUrl)}">Manage your server</a>.`, { muted: true, size: 13 }),
  ].join("\n\n");
  return withTo(wrap("Your new temporary Unleashed password", text, html, "Sign in and choose a new password."), to);
}

export function cancellationScheduledEmail(to: string, instanceReference: string, suspendAt: number, deleteAt: number, manageUrl: string, bundled = false): EmailMessage {
  const hostingEndDate = fmtDate(suspendAt).split(",")[0];
  const text = [
    `Your hosting cancellation is scheduled. Your VPS remains available through ${fmtDate(suspendAt)}. It will then be suspended and is scheduled for permanent deletion at ${fmtDate(deleteAt)}.`,
    bundled ? `This cancels renewal of your combined software and hosting subscription. Your already-paid software access remains valid through its current paid term. Export any settings you need before suspension.` : `Export any settings you need before suspension. Hosting cancellation does not cancel your separate software license. Stopping the VPS stops bot management; it does not itself close exchange positions or cancel exchange orders.`,
    `Manage hosting: ${manageUrl}`,
  ].join("\n\n");
  const html = [
    `Your hosting cancellation is scheduled. Your VPS remains available through <b>${escapeHtml(fmtDate(suspendAt))}</b>. It will then be suspended and is scheduled for permanent deletion at <b>${escapeHtml(fmtDate(deleteAt))}</b>.`,
    bundled ? `This cancels renewal of your combined software and hosting subscription. Your already-paid software access remains valid through its current paid term. Export any settings you need before suspension.` : `Export any settings you need before suspension. Hosting cancellation does not cancel your separate software license. Stopping the VPS stops bot management; it does not itself close exchange positions or cancel exchange orders.`,
    `<a href="${escapeHtml(manageUrl)}">Manage hosting</a>`,
  ].join("\n\n");
  return withTo(wrap(`Your VPS hosting will end on ${hostingEndDate}`, text, html), to);
}

export function overdueEmail(to: string, instanceReference: string, suspendAt: number, deleteAt: number, payUrl: string, softwareNotice: string): EmailMessage {
  const text = [
    `We have not received the hosting renewal payment for ${instanceReference}. Update your payment details or complete payment to keep hosting active.`,
    `Scheduled suspension: ${fmtDate(suspendAt)}\nScheduled permanent deletion: ${fmtDate(deleteAt)}`,
    `Pay hosting invoice: ${payUrl}`,
    `Bot management stops when the VPS is suspended. Positions and resting orders may remain on the exchange; manage them directly or migrate before suspension. ${softwareNotice}`.trim(),
  ].join("\n\n");
  const html = [
    `We have not received the hosting renewal payment for ${escapeHtml(instanceReference)}. Update your payment details or complete payment to keep hosting active.`,
    `Scheduled suspension: <b>${escapeHtml(fmtDate(suspendAt))}</b><br>Scheduled permanent deletion: <b>${escapeHtml(fmtDate(deleteAt))}</b>`,
    `<a href="${escapeHtml(payUrl)}">Pay hosting invoice</a>`,
    `Bot management stops when the VPS is suspended. Positions and resting orders may remain on the exchange; manage them directly or migrate before suspension. ${escapeHtml(softwareNotice)}`.trim(),
  ].join("\n\n");
  return withTo(wrap("Action needed: your VPS hosting payment is overdue", text, html), to);
}

export function suspendedEmail(to: string, instanceReference: string, deleteAt: number, manageUrl: string): EmailMessage {
  const text = [
    `Hosting for ${instanceReference} has ended and the VPS is now suspended. Bot management on this VPS has stopped. Positions and orders may still exist on your exchange.`,
    `The server is scheduled for permanent deletion at ${fmtDate(deleteAt)}. Complete the required hosting payment before deletion begins to request recovery of this server. Any required software renewal is shown in your account. Bots saved as enabled may resume through their normal safety gates after authenticated server readiness; paused bots remain paused.`,
    `Review hosting and payment: ${manageUrl}`,
  ].join("\n\n");
  const html = [
    `Hosting for ${escapeHtml(instanceReference)} has ended and the VPS is now suspended. Bot management on this VPS has stopped. Positions and orders may still exist on your exchange.`,
    `The server is scheduled for permanent deletion at <b>${escapeHtml(fmtDate(deleteAt))}</b>. Complete the required hosting payment before deletion begins to request recovery of this server. Any required software renewal is shown in your account. Bots saved as enabled may resume through their normal safety gates after authenticated server readiness; paused bots remain paused.`,
    `<a href="${escapeHtml(manageUrl)}">Review hosting and payment</a>`,
  ].join("\n\n");
  return withTo(wrap("Your Unleashed VPS has been suspended", text, html), to);
}

function reminderEmail(to: string, instanceReference: string, deleteAt: number, hoursRemaining: number, manageUrl: string, backupScopeSentence: string): EmailMessage {
  const isFinal = hoursRemaining <= 24;
  const subject = isFinal ? "Final reminder: your Unleashed VPS will be deleted in 24 hours" : "Your Unleashed VPS will be permanently deleted in 3 days";
  const text = isFinal
    ? [
        `Your suspended VPS, ${instanceReference}, is scheduled for permanent deletion at ${fmtDate(deleteAt)}. Hosting remains unpaid or canceled.`,
        `To keep this server, renew hosting before deletion begins. Once deletion starts, recovery of the server and its data is no longer guaranteed.`,
        `Renew VPS hosting: ${manageUrl}`,
      ].join("\n\n")
    : [
        `Hosting for ${instanceReference} has not been renewed. Your suspended VPS and its server data are scheduled for permanent deletion at ${fmtDate(deleteAt)}.`,
        `Complete the required payment before deletion begins if you want to keep this server. After deletion, its data cannot be recovered under this hosting plan. ${backupScopeSentence}`.trim(),
        `Renew VPS hosting: ${manageUrl}`,
      ].join("\n\n");
  return withTo({ to, subject, text: `${text}\n\n${SUPPORT_LINE}`, html: layoutHtml(text.split("\n\n").map((p) => linkify(escapeHtml(p))).join("\n\n")) }, to);
}
export function threeDayReminderEmail(to: string, instanceReference: string, deleteAt: number, manageUrl: string, backupScopeSentence: string): EmailMessage {
  return reminderEmail(to, instanceReference, deleteAt, 72, manageUrl, backupScopeSentence);
}
export function oneDayReminderEmail(to: string, instanceReference: string, deleteAt: number, manageUrl: string): EmailMessage {
  return reminderEmail(to, instanceReference, deleteAt, 24, manageUrl, "");
}

export function restoredEmail(to: string, instanceReference: string, appUrl: string, renewalAt: number | null, botResumeStatus: string): EmailMessage {
  const renewal = renewalAt !== null ? fmtDate(renewalAt) : "not yet scheduled";
  const text = [
    `Your hosting payment has been applied and ${instanceReference} is available again at ${appUrl}.`,
    `${botResumeStatus} Review your exchange positions, orders, and bot settings before starting paused bots. The previously scheduled deletion has been canceled.`,
    `Next hosting renewal: ${renewal}.`,
  ].join("\n\n");
  const html = [
    `Your hosting payment has been applied and ${escapeHtml(instanceReference)} is available again at <a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a>.`,
    `${escapeHtml(botResumeStatus)} Review your exchange positions, orders, and bot settings before starting paused bots. The previously scheduled deletion has been canceled.`,
    `Next hosting renewal: ${escapeHtml(renewal)}.`,
  ].join("\n\n");
  return withTo(wrap("Your Unleashed VPS is available again", text, html), to);
}

export function terminatedEmail(to: string, instanceReference: string, terminatedAt: number, billingStatusSentence: string, hostingUrl: string): EmailMessage {
  const text = [
    `Your VPS, ${instanceReference}, was permanently deleted at ${fmtDate(terminatedAt)} following hosting expiration. Its server data has been deleted and is not recoverable under this plan.`,
    `${billingStatusSentence} Your central Unleashed account and any separately valid software license are unaffected by this hosting termination. This action did not close positions or cancel orders on your exchange.`,
    `You can purchase a new VPS from your account. A new VPS will not contain the deleted server's data.`,
    `View hosting: ${hostingUrl}`,
  ].join("\n\n");
  const html = [
    `Your VPS, ${escapeHtml(instanceReference)}, was permanently deleted at <b>${escapeHtml(fmtDate(terminatedAt))}</b> following hosting expiration. Its server data has been deleted and is not recoverable under this plan.`,
    `${escapeHtml(billingStatusSentence)} Your central Unleashed account and any separately valid software license are unaffected by this hosting termination. This action did not close positions or cancel orders on your exchange.`,
    `You can purchase a new VPS from your account. A new VPS will not contain the deleted server's data.`,
    `<a href="${escapeHtml(hostingUrl)}">View hosting</a>`,
  ].join("\n\n");
  return withTo(wrap("Your Unleashed VPS has been terminated", text, html), to);
}

/** "Setup failure or late payment" (§9's ninth row) — one function covering
 *  both exception workflows the row names, distinguished by `kind` so the
 *  wording never claims the wrong cause (§9: "for voluntary cancellation do
 *  not claim a charge failed; for incomplete cleanup do not use the final
 *  template early"). */
export function exceptionEmail(to: string, kind: "setup_failure" | "late_payment_after_deletion", instanceReference: string, detail: string, hostingUrl: string): EmailMessage {
  if (kind === "setup_failure") {
    const text = [
      `We were not able to finish setting up ${instanceReference}. ${detail}`,
      `A request to stop renewal for this server has been sent. We will confirm both the renewal status and the status of your initial hosting payment separately; contact support if you do not receive that confirmation.`,
      `View hosting: ${hostingUrl}`,
    ].join("\n\n");
    return withTo({ to, subject: "We could not finish setting up your Unleashed VPS", text: `${text}\n\n${SUPPORT_LINE}`, html: layoutHtml(text.split("\n\n").map((p) => linkify(escapeHtml(p))).join("\n\n")) }, to);
  }
  const text = [
    `We received a hosting payment for ${instanceReference} after that server was already permanently deleted. ${detail}`,
    `View hosting: ${hostingUrl}`,
  ].join("\n\n");
  return withTo({ to, subject: "About your recent Unleashed VPS hosting payment", text: `${text}\n\n${SUPPORT_LINE}`, html: layoutHtml(text.split("\n\n").map((p) => linkify(escapeHtml(p))).join("\n\n")) }, to);
}
