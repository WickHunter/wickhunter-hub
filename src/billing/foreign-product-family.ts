// src/billing/foreign-product-family.ts
//
// B15 (the app repo's acceptance matrix, tests/marketplace-acceptance-matrix
// .test.mjs): "a marketplace invoice can never reach the licence billing
// endpoint." The app's own Stripe rail (src/marketplace-hub/rail-stripe.ts,
// STRIPE_COMMERCE_PRODUCT_FAMILY) bills marketplace-strategy subscriptions
// on the APP's OWN Stripe account/webhook secret and tags EVERY checkout
// session and subscription it creates with `metadata.productFamily =
// "marketplace_strategy"` — for exactly this reason (that file's own
// BILL-04 comment: "a marketplace-shaped correlation payload whose
// productFamily is absent or wrong is refused before its ids are ever
// trusted"). A misconfigured webhook URL, or the two products sharing one
// Stripe account, can still deliver that event HERE — to this Hub's licence
// endpoint (`POST /api/billing/stripe/{test,live}`, `BillingService
// .handleWebhook`) — where it must mint NO licence, extend NO expiry, and
// revoke nothing, ever.
//
// THIS HUB NEVER TAGS ITS OWN METADATA WITH `productFamily` AT ALL. Its own
// licence product is tagged `metadata.wickhunter = "unleashed"` on the
// PRODUCT (stripe-provision.ts) and `metadata.plan`/`metadata.price`/
// `metadata.managed_by` on the Payment Link/checkout/subscription — never
// `productFamily`. So ANY non-empty `productFamily` value found on an
// event's metadata is, by construction, not this Hub's own checkout flow:
// it is refused whether it says "marketplace_strategy" (today's known
// case) or names some other product this Hub has never heard of (a future
// one) — "other than the licence family" is simplest expressed as "present
// at all", because the licence family never sets the key.
//
// DELIBERATELY NARROWER THAN roles.ts's id-allowlist dispatcher: that module
// decides WHICH of THIS Hub's own roles (software/hosting) an event
// belongs to; it does not know about, and must not be taught about, a
// product this Hub does not sell. This module decides only whether the
// event belongs to THIS HUB AT ALL, and runs BEFORE roles.ts's dispatcher —
// which matters because roles.ts's own rule 3 ("no id match at all, and
// hosting has never been configured: default to software", the day-1
// backward-compatibility default every install already relies on) would
// otherwise wave a marketplace event straight through to the software
// mint/extend handlers: it carries no price/product id at all (a marketplace
// checkout is priced with Stripe's inline `price_data`, never one of this
// Hub's own catalogued prices) and no `metadata.plan` this Hub's plan
// catalogue recognises, so nothing in roles.ts would ever classify it
// "unknown" on its own. This check closes exactly that gap, without
// touching roles.ts's carefully-reasoned defaults.
//
// PURE, and the only thing the route (BillingService.applyEvent) may do
// with it is call it — v0.80.6 in the app repo, the shape this Hub's own
// roles.ts already follows.

/** Must equal the app repo's `STRIPE_COMMERCE_PRODUCT_FAMILY`
 *  (src/marketplace-hub/rail-stripe.ts) — the two repos are not built
 *  together, so this is a literal, not an import; a change to one side
 *  needs a matching change here. Named for the reason string only; the
 *  refusal below fires on ANY non-empty `productFamily`, not just this one. */
export const KNOWN_FOREIGN_PRODUCT_FAMILY_MARKETPLACE = "marketplace_strategy";

export interface ForeignProductFamilyFacts {
  /** `""` for an absent/non-string/blank metadata value — never a foreign
   *  tag. Every caller reads this the same way `CheckoutFacts.metadata` and
   *  its siblings already do (stripe.ts: `typeof v === "string" ? v : ""`). */
  readonly productFamily: string;
}

/** Returns a stable refusal reason naming the foreign family, or `null` when
 *  the event carries no `productFamily` tag at all (every ordinary licence
 *  or hosting event, today and going forward — untouched by this check). */
export function foreignProductFamilyRefusal(facts: ForeignProductFamilyFacts): string | null {
  const family = facts.productFamily.trim();
  if (!family) return null;
  const known = family === KNOWN_FOREIGN_PRODUCT_FAMILY_MARKETPLACE
    ? " (the app's own marketplace-subscription billing)"
    : "";
  return `event carries productFamily "${family}"${known} — not this Hub's own licence billing; refused before any licence was touched`;
}
