// src/billing/roles.ts
// Which PRODUCT a Stripe event is about, decided BEFORE any money or licence
// state is touched. This exists because src/billing/service.ts's handlers
// were written for exactly one product (the software subscription) and treat
// "this customer" and "the software subscription" as the same fact — true
// until a second, unrelated Stripe subscription (hosting) exists on the same
// Stripe customer. `customer.subscription.updated`/`invoice.paid` events for
// that second subscription would silently overwrite the software customer's
// subscription id/expiry, and a refund or dispute on the second product's
// charge would revoke the still-paid software licence (see
// tests/billing-roles.test.mjs, "the defect this file exists to prevent",
// reproduced against the pre-dispatcher handlers before this file existed).
//
// THE RULE: a role is granted only by an explicit, server-side allowlist of
// Stripe price/product ids, kept SEPARATELY per Stripe mode (test/live IDs
// are different objects in different Stripe accounts and must never cross).
// Product/plan METADATA (Stripe's `metadata.plan`, matched against the Hub's
// own plan catalogue) is a BINDING AID ONLY, consulted when the ids
// themselves are silent — never a grant on its own, and never used at all
// once an id match exists.
//
// BACKWARD COMPATIBILITY, DELIBERATELY NARROW: every event on this Hub today
// IS a software event — hosting does not exist yet. So while the hosting
// allowlist is completely empty (nothing configured for it, in EITHER mode),
// classification defaults to "software" exactly as every handler already
// assumed, and today's installs see no behaviour change. The moment an
// operator configures even one hosting price or product id, that Hub-wide
// safety net is gone and every event must resolve through the allowlists (or
// the plan-catalogue binding aid) or it is "unknown" — never guessed.

export type BillingRole = "software" | "hosting";
export type ClassifiedRole = BillingRole | "unknown";

export interface RoleAllowlist {
  readonly priceIds: readonly string[];
  readonly productIds: readonly string[];
}

export interface ModeRoleConfig {
  readonly software: RoleAllowlist;
  readonly hosting: RoleAllowlist;
}

export const EMPTY_ROLE_ALLOWLIST: RoleAllowlist = Object.freeze({ priceIds: Object.freeze([]), productIds: Object.freeze([]) });
export const EMPTY_MODE_ROLE_CONFIG: ModeRoleConfig = Object.freeze({ software: EMPTY_ROLE_ALLOWLIST, hosting: EMPTY_ROLE_ALLOWLIST });

export interface RoleClassificationFacts {
  /** Every price id the event's own payload names (invoice lines,
   *  subscription items). Empty when the event type carries none inline
   *  (a checkout session does not) — never guessed by fetching one. */
  readonly priceIds: readonly string[];
  readonly productIds: readonly string[];
  /** The role of the Hub's OWN plan this event's `metadata.plan` names, if
   *  any — the binding aid. `null` when the event carries no recognisable
   *  plan metadata, or the caller has none to offer (invoice/subscription
   *  events, which have real price ids and need no aid). */
  readonly planRole: BillingRole | null;
}

function isEmptyAllowlist(a: RoleAllowlist): boolean {
  return a.priceIds.length === 0 && a.productIds.length === 0;
}

function matchesAllowlist(facts: { priceIds: readonly string[]; productIds: readonly string[] }, a: RoleAllowlist): boolean {
  if (a.priceIds.length && facts.priceIds.some((id) => a.priceIds.includes(id))) return true;
  if (a.productIds.length && facts.productIds.some((id) => a.productIds.includes(id))) return true;
  return false;
}

/** Pure. See the file header for the whole rule; this is its exact shape:
 *   1. Explicit id membership decides, if unambiguous.
 *   2. Ids claiming BOTH roles at once is a misconfiguration, not a role —
 *      "unknown" (never silently pick one over the other with live money
 *      involved).
 *   3. No id match at all, and hosting has never been configured on this
 *      Hub: the pre-dispatcher default, "software" — the whole installed
 *      base keeps working unchanged the day this ships.
 *   4. No id match, hosting IS configured (so this Hub genuinely sells more
 *      than one product now): fall back to the plan-catalogue binding aid.
 *   5. Still nothing: "unknown" — recorded for reconciliation, applied to
 *      neither role. This is the fail-closed branch H1 asks for; do not
 *      change it to default to software once hosting exists. */
export function classifyRole(facts: RoleClassificationFacts, cfg: ModeRoleConfig): ClassifiedRole {
  const inSoftware = matchesAllowlist(facts, cfg.software);
  const inHosting = matchesAllowlist(facts, cfg.hosting);
  if (inSoftware && inHosting) return "unknown";
  if (inHosting) return "hosting";
  if (inSoftware) return "software";
  if (isEmptyAllowlist(cfg.hosting)) return "software";
  if (facts.planRole) return facts.planRole;
  return "unknown";
}

// ── config validation helpers (used by billing/config.ts) ──────────────────

// Lenient by design, matching this file's neighbour (config.ts's
// `keyWithPrefix`, used for every other Stripe id/key/secret the admin page
// accepts): Stripe does not publish a strict character set for these ids,
// so the check is "the right prefix, no whitespace, a sane length" rather
// than a guessed exact alphabet that could reject a real id pasted from the
// Stripe dashboard.
const STRIPE_PRICE_ID_RE = /^price_\S{1,255}$/;
const STRIPE_PRODUCT_ID_RE = /^prod_\S{1,255}$/;

export function isStripePriceId(v: unknown): v is string {
  return typeof v === "string" && STRIPE_PRICE_ID_RE.test(v);
}
export function isStripeProductId(v: unknown): v is string {
  return typeof v === "string" && STRIPE_PRODUCT_ID_RE.test(v);
}
