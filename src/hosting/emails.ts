// src/hosting/emails.ts
// The nine hosting transactional templates (handoff §9). Reuses
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
import { escapeHtml, type EmailMessage } from "../billing/email.js";

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
  monthlyPriceLabel: string;
  renewalAt: number | null;
  backupScopeSentence: string;
}

const SUPPORT_LINE = "Questions? admin@wickhunterunleashed.com";

function wrap(subject: string, bodyText: string, bodyHtml: string): EmailMessage {
  return {
    to: "",
    subject,
    text: `${bodyText}\n\n${SUPPORT_LINE}`,
    html: `<p>${bodyHtml.split("\n\n").map((p) => p.trim()).filter(Boolean).join("</p><p>")}</p><p>${escapeHtml(SUPPORT_LINE)}</p>`,
  };
}
function withTo(msg: EmailMessage, to: string): EmailMessage {
  return { ...msg, to };
}

export function installationReadyEmail(to: string, firstName: string, f: InstanceEmailFacts): EmailMessage {
  const name = escapeHtml(firstName || "there");
  const renewal = f.renewalAt !== null ? fmtDate(f.renewalAt) : "not yet scheduled";
  const text = [
    `Hi ${firstName || "there"},`,
    `Your VPS is ready with Unleashed installed. Open ${f.appUrl} to finish setup. Your bots are paused until you connect your exchange, review your settings, and start them.`,
    `Server: ${f.instanceReference}\nLocation: ${f.region}\nCPU / RAM / storage: ${f.cpu} / ${f.ram} / ${f.storage}\nOperating system: ${f.os}\nIP address: ${f.ip}\nApplication username: ${f.appUsername}\nSSH username / port: ${f.sshUsername} / ${f.sshPort}`,
    `View access details: ${f.accessUrl}`,
    `Use your temporary Unleashed password to sign in. The application will require you to choose a new password before you can access your dashboard or configure bots; everything happens in the browser. Server administrator access uses separate credentials. If moving from another installation, use the migration steps before starting hosted bots so both installations do not manage the same workload.`,
    `Hosting is ${f.monthlyPriceLabel} per month in addition to your software license. Next hosting renewal: ${renewal}. ${f.backupScopeSentence}`,
  ].join("\n\n");
  const html = [
    `Hi ${name},`,
    `Your VPS is ready with Unleashed installed. Open <a href="${escapeHtml(f.appUrl)}">${escapeHtml(f.appUrl)}</a> to finish setup. Your bots are paused until you connect your exchange, review your settings, and start them.`,
    `Server: ${escapeHtml(f.instanceReference)}<br>Location: ${escapeHtml(f.region)}<br>CPU / RAM / storage: ${escapeHtml(f.cpu)} / ${escapeHtml(f.ram)} / ${escapeHtml(f.storage)}<br>Operating system: ${escapeHtml(f.os)}<br>IP address: ${escapeHtml(f.ip)}<br>Application username: ${escapeHtml(f.appUsername)}<br>SSH username / port: ${escapeHtml(f.sshUsername)} / ${f.sshPort}`,
    `<a href="${escapeHtml(f.accessUrl)}">View access details</a>`,
    `Use your temporary Unleashed password to sign in. The application will require you to choose a new password before you can access your dashboard or configure bots; everything happens in the browser. Server administrator access uses separate credentials. If moving from another installation, use the migration steps before starting hosted bots so both installations do not manage the same workload.`,
    `Hosting is ${escapeHtml(f.monthlyPriceLabel)} per month in addition to your software license. Next hosting renewal: ${escapeHtml(renewal)}. ${escapeHtml(f.backupScopeSentence)}`,
  ].join("\n\n");
  return withTo(wrap("Your Unleashed VPS is ready", text, html), to);
}

export function cancellationScheduledEmail(to: string, instanceReference: string, suspendAt: number, deleteAt: number, manageUrl: string): EmailMessage {
  const hostingEndDate = fmtDate(suspendAt).split(",")[0];
  const text = [
    `Your hosting cancellation is scheduled. Your VPS remains available through ${fmtDate(suspendAt)}. It will then be suspended and is scheduled for permanent deletion at ${fmtDate(deleteAt)}.`,
    `Export any settings you need before suspension. Hosting cancellation does not cancel your separate software license. Stopping the VPS stops bot management; it does not itself close exchange positions or cancel exchange orders.`,
    `Manage hosting: ${manageUrl}`,
  ].join("\n\n");
  const html = [
    `Your hosting cancellation is scheduled. Your VPS remains available through <b>${escapeHtml(fmtDate(suspendAt))}</b>. It will then be suspended and is scheduled for permanent deletion at <b>${escapeHtml(fmtDate(deleteAt))}</b>.`,
    `Export any settings you need before suspension. Hosting cancellation does not cancel your separate software license. Stopping the VPS stops bot management; it does not itself close exchange positions or cancel exchange orders.`,
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
    `The server is scheduled for permanent deletion at ${fmtDate(deleteAt)}. Complete the required hosting payment before deletion begins to request recovery of this server. Any required software renewal is shown in your account. Bots will need review before they resume.`,
    `Review hosting and payment: ${manageUrl}`,
  ].join("\n\n");
  const html = [
    `Hosting for ${escapeHtml(instanceReference)} has ended and the VPS is now suspended. Bot management on this VPS has stopped. Positions and orders may still exist on your exchange.`,
    `The server is scheduled for permanent deletion at <b>${escapeHtml(fmtDate(deleteAt))}</b>. Complete the required hosting payment before deletion begins to request recovery of this server. Any required software renewal is shown in your account. Bots will need review before they resume.`,
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
  const html = text.split("\n\n").map((p) => escapeHtml(p)).join("</p><p>");
  return withTo({ to, subject, text: `${text}\n\n${SUPPORT_LINE}`, html: `<p>${html}</p><p>${escapeHtml(SUPPORT_LINE)}</p>` }, to);
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
export function exceptionEmail(to: string, kind: "setup_failure_refunded" | "late_payment_after_deletion", instanceReference: string, detail: string, hostingUrl: string): EmailMessage {
  if (kind === "setup_failure_refunded") {
    const text = [
      `We were not able to finish setting up ${instanceReference}. ${detail}`,
      `Your hosting payment for this server has been refunded. You can start a new order from your account when you are ready to try again.`,
      `View hosting: ${hostingUrl}`,
    ].join("\n\n");
    const html = text.split("\n\n").map((p) => escapeHtml(p)).join("</p><p>");
    return withTo({ to, subject: "We could not finish setting up your Unleashed VPS", text: `${text}\n\n${SUPPORT_LINE}`, html: `<p>${html}</p><p>${escapeHtml(SUPPORT_LINE)}</p>` }, to);
  }
  const text = [
    `We received a hosting payment for ${instanceReference} after that server was already permanently deleted. ${detail}`,
    `View hosting: ${hostingUrl}`,
  ].join("\n\n");
  const html = text.split("\n\n").map((p) => escapeHtml(p)).join("</p><p>");
  return withTo({ to, subject: "About your recent Unleashed VPS hosting payment", text: `${text}\n\n${SUPPORT_LINE}`, html: `<p>${html}</p><p>${escapeHtml(SUPPORT_LINE)}</p>` }, to);
}
