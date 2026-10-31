// src/hosting/customer-messages.ts
// Plain-language customer copy for hosting failure reasons. The raw
// `failureReason` on a hosting row is operator text: it names provider cost
// ceilings, margin checks, venue probe refusals and internal markers such as
// `checkout_expired`. That detail stays in the admin instance list and the
// Hub log; the customer page and customer emails show the sentence below
// plus a short support reference that support can match back to the raw
// reason (`supportReference` is a pure function of instance id + raw text,
// and the admin instance list carries the same value beside each row).
import { createHash } from "node:crypto";

export interface CustomerFailureMessage {
  /** One or two plain sentences. Never contains the raw reason. */
  message: string;
  /** `WH-XXXXXXXX`; the same raw reason on the same instance always maps to
   *  the same reference, so a customer quoting it twice is one case. */
  reference: string;
}

export function supportReference(scope: string, raw: string): string {
  return "WH-" + createHash("sha256").update(`${scope}\n${raw}`).digest("hex").slice(0, 8).toUpperCase();
}

const CONTACT = "If you have questions, contact support and quote the reference below.";

function messageFor(raw: string): string {
  const r = raw.trim();
  if (r === "checkout_expired") return "Your checkout expired before payment was completed, so no server was created and you were not charged for it. You can start a new checkout from this page.";
  if (r === "bundle_subscription_ended_before_activation") return "This subscription ended before your server was set up, so no server was created.";
  if (r === "unreserved_payment") return `We received a hosting payment that we could not match to an order. Support will review it and contact you. ${CONTACT}`;
  if (r === "late_payment_resolution_required") return `We received a hosting payment after this server had already been deleted. Support will contact you about that payment. ${CONTACT}`;
  if (/under dispute|fully refunded/.test(r)) return `There is a billing issue on this hosting subscription. ${CONTACT}`;
  if (r.startsWith("Paid recovery is waiting for server readiness")) return "Your payment was received and your server is starting up again. This page updates when it is back online.";
  if (r.startsWith("Server power-on requested")) return "Your server is starting up. This page updates when it is back online.";
  if (r.startsWith("readiness refused in ") && r.includes(" — replacing it once in ")) return "Your server could not reach every supported exchange from its first location, so we are setting it up again in another region. No action is needed; we will email you when it is ready.";
  if (r === "suspended by an operator") return `Support has paused this server. ${CONTACT}`;
  if (r === "deletion forced by an operator") return `Support has scheduled this server for removal. ${CONTACT}`;
  if (/^setup failed after|price no longer covers|cost ceiling|readiness refused|could not be created|provisioning/i.test(r)) {
    return `We could not finish setting up your server. Renewal has been stopped so you are not charged again, and support will contact you about your first payment. ${CONTACT}`;
  }
  return `Something on this server needs attention from support. ${CONTACT}`;
}

/** Customer-safe replacement for a raw hosting `failureReason`. */
export function customerFailureMessage(instanceId: string, raw: string): CustomerFailureMessage {
  return { message: messageFor(raw), reference: supportReference(instanceId, raw) };
}

/** Customer-safe text for a refused hosting checkout. The raw refusal (which
 *  may name provider cost, margin or Stripe configuration) is for the log. */
export function customerCheckoutMessage(code: string): string {
  switch (code) {
    case "SOFTWARE_LICENSE_REQUIRED": return "Hosting needs an active Wick Hunter Unleashed licence on this account first.";
    case "HOSTING_ALREADY_EXISTS": return "You already have a server or a checkout in progress. It is shown on this page.";
    case "PROVIDER_STATUS_UNKNOWN": return "We could not confirm server availability just now. Please try again in a few minutes.";
    default: return "New servers are not available to order right now. Please try again later or contact support.";
  }
}
