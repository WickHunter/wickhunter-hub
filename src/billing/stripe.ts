// src/billing/stripe.ts
// The Stripe wire, read with node builtins only: webhook signature
// verification (HMAC-SHA256 over `t.body`, as Stripe documents it) and small,
// tolerant readers for the handful of event objects the Hub acts on. Nothing
// here calls Stripe — the webhook path is pure so it can be replayed in tests
// byte-for-byte, and so a Stripe outage can never stall event intake.
import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_SIGNATURE_HEADER = "stripe-signature";
export const STRIPE_SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export type StripeSignatureResult =
  | { ok: true; timestampMs: number }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

/** Verify `Stripe-Signature` over the EXACT raw body bytes. Any `v1` entry may
 *  match (Stripe sends several during a secret rotation); the timestamp must
 *  be within tolerance of our clock in either direction. */
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | string[] | undefined,
  secret: string,
  nowMs = Date.now(),
  toleranceMs = STRIPE_SIGNATURE_TOLERANCE_MS,
): StripeSignatureResult {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h || !secret) return { ok: false, reason: "missing" };
  let timestamp = "";
  const v1: string[] = [];
  for (const part of h.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") v1.push(v);
  }
  if (!/^\d{1,13}$/.test(timestamp) || !v1.length) return { ok: false, reason: "malformed" };
  const timestampMs = Number(timestamp) * 1000;
  if (Math.abs(nowMs - timestampMs) > toleranceMs) return { ok: false, reason: "expired" };
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  for (const sig of v1) {
    if (!/^[0-9a-f]{64}$/i.test(sig)) continue;
    const given = Buffer.from(sig, "hex");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, timestampMs };
  }
  return { ok: false, reason: "mismatch" };
}

/** Build a header Stripe would send — for the test suite and the admin
 *  "replay" tools, never for anything the Hub serves. */
export function signStripePayload(rawBody: Buffer | string, secret: string, timestampSec: number): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const sig = createHmac("sha256", secret).update(`${timestampSec}.`).update(body).digest("hex");
  return `t=${timestampSec},v1=${sig}`;
}

// ── event readers ───────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Stripe expands references inline or leaves an id string; accept both. */
const asId = (v: unknown): string => (typeof v === "string" ? v : asStr(asObj(v).id));

export interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  createdMs: number;
  object: Obj;
}

/** The envelope, or null when it is not an event at all. */
export function parseStripeEvent(raw: unknown): StripeEvent | null {
  const e = asObj(raw);
  const id = asStr(e.id);
  const type = asStr(e.type);
  if (!id.startsWith("evt_") || !type || e.object !== "event") return null;
  const data = asObj(e.data);
  const object = asObj(data.object);
  return {
    id,
    type,
    livemode: e.livemode === true,
    createdMs: (asNum(e.created) ?? 0) * 1000,
    object,
  };
}

export interface CheckoutFacts {
  sessionId: string;
  mode: string; // "subscription" | "payment" | "setup"
  status: string; // "complete" | "open" | "expired"
  paymentStatus: string; // "paid" | "unpaid" | "no_payment_required"
  customerId: string;
  email: string;
  name: string;
  subscriptionId: string;
  paymentIntentId: string;
  metadata: Record<string, string>;
}

export function checkoutFacts(o: Obj): CheckoutFacts {
  const details = asObj(o.customer_details);
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(asObj(o.metadata))) if (typeof v === "string") meta[k] = v;
  return {
    sessionId: asStr(o.id),
    mode: asStr(o.mode),
    status: asStr(o.status),
    paymentStatus: asStr(o.payment_status),
    customerId: asId(o.customer),
    email: (asStr(details.email) || asStr(o.customer_email)).trim().toLowerCase(),
    name: asStr(details.name).trim(),
    subscriptionId: asId(o.subscription),
    paymentIntentId: asId(o.payment_intent),
    metadata: meta,
  };
}

export interface InvoiceFacts {
  invoiceId: string;
  customerId: string;
  email: string;
  name: string;
  subscriptionId: string;
  chargeId: string;
  paymentIntentId: string;
  billingReason: string;
  paid: boolean;
  /** The latest `period.end` across the invoice's lines — what the customer
   *  has paid THROUGH. Stable across Stripe API versions, unlike the
   *  subscription's own `current_period_end`, which moved in 2025. */
  periodEndMs: number | null;
}

export function invoiceFacts(o: Obj): InvoiceFacts {
  let periodEnd: number | null = null;
  const lines = asObj(o.lines);
  const data = Array.isArray(lines.data) ? lines.data : [];
  for (const line of data) {
    const end = asNum(asObj(asObj(line).period).end);
    if (end !== null && (periodEnd === null || end > periodEnd)) periodEnd = end;
  }
  // 2025-03-31.basil moved `invoice.subscription` under `parent`; read both.
  const parent = asObj(o.parent);
  const subscriptionId = asId(o.subscription) || asId(asObj(parent.subscription_details).subscription);
  return {
    invoiceId: asStr(o.id),
    customerId: asId(o.customer),
    email: asStr(o.customer_email).trim().toLowerCase(),
    name: asStr(o.customer_name).trim(),
    subscriptionId,
    chargeId: asId(o.charge),
    paymentIntentId: asId(o.payment_intent),
    billingReason: asStr(o.billing_reason),
    paid: o.paid === true || asStr(o.status) === "paid",
    periodEndMs: periodEnd === null ? null : periodEnd * 1000,
  };
}

export interface SubscriptionFacts {
  subscriptionId: string;
  customerId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  /** Present on older API versions at the top level, on newer ones per item. */
  currentPeriodEndMs: number | null;
  endedAtMs: number | null;
}

export function subscriptionFacts(o: Obj): SubscriptionFacts {
  let periodEnd = asNum(o.current_period_end);
  if (periodEnd === null) {
    const items = asObj(o.items);
    for (const item of Array.isArray(items.data) ? items.data : []) {
      const end = asNum(asObj(item).current_period_end);
      if (end !== null && (periodEnd === null || end > periodEnd)) periodEnd = end;
    }
  }
  const ended = asNum(o.ended_at);
  return {
    subscriptionId: asStr(o.id),
    customerId: asId(o.customer),
    status: asStr(o.status),
    cancelAtPeriodEnd: o.cancel_at_period_end === true,
    currentPeriodEndMs: periodEnd === null ? null : periodEnd * 1000,
    endedAtMs: ended === null ? null : ended * 1000,
  };
}

export interface ChargeFacts {
  chargeId: string;
  customerId: string;
  paymentIntentId: string;
  email: string;
  amount: number | null;
  amountRefunded: number | null;
  refunded: boolean;
}

export function chargeFacts(o: Obj): ChargeFacts {
  const billing = asObj(o.billing_details);
  return {
    chargeId: asStr(o.id),
    customerId: asId(o.customer),
    paymentIntentId: asId(o.payment_intent),
    email: (asStr(billing.email) || asStr(o.receipt_email)).trim().toLowerCase(),
    amount: asNum(o.amount),
    amountRefunded: asNum(o.amount_refunded),
    refunded: o.refunded === true,
  };
}

export interface DisputeFacts {
  disputeId: string;
  chargeId: string;
  paymentIntentId: string;
  reason: string;
  status: string;
}

export function disputeFacts(o: Obj): DisputeFacts {
  return {
    disputeId: asStr(o.id),
    chargeId: asId(o.charge),
    paymentIntentId: asId(o.payment_intent),
    reason: asStr(o.reason),
    status: asStr(o.status),
  };
}
