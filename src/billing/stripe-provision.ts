// src/billing/stripe-provision.ts
// "Create in Stripe": the plans configured on the Hub become a product, one
// price per plan and one Payment Link per plan in a Stripe account, through
// the REST API with node builtins only. IDEMPOTENT by construction — every
// object the Hub makes is tagged, and a second run finds and reuses them:
//
//   product        metadata.wickhunter = "unleashed"
//   price          lookup_key = "unleashed-<plan key>"   (Stripe prices are
//                  immutable, so a changed amount means a NEW price that takes
//                  the lookup key over, and the old one is archived)
//   payment link   metadata.plan = <key>, metadata.price = <price id>; a link
//                  whose price no longer matches is deactivated and replaced
//
// So "change the price on the Hub, press Create in Stripe" is the whole
// procedure, and the webhook keeps working because it reads `metadata.plan`
// off the checkout session, which Stripe copies from the link.
import type { EmailFetch } from "./email.js";
import type { Plan } from "./config.js";

const API = "https://api.stripe.com/v1";
const MANAGED_BY = "wickhunter-hub";
const PRODUCT_TAG = "unleashed";

export class StripeApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "StripeApiError";
  }
}

export interface ProvisionInput {
  secretKey: string;
  siteOrigin: string;
  productName: string;
  plans: Plan[];
}

export interface ProvisionPlanResult {
  key: string;
  priceId: string;
  priceCreated: boolean;
  paymentLinkUrl: string;
  linkCreated: boolean;
  /** What was retired to make room, for the admin's eyes. */
  note: string | null;
}

export interface ProvisionResult {
  product: { id: string; name: string; created: boolean };
  plans: ProvisionPlanResult[];
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asList = (v: unknown): Obj[] => (Array.isArray(asObj(v).data) ? (asObj(v).data as unknown[]).map(asObj) : []);

type Params = Record<string, string | number | boolean | undefined>;

function encode(params: Params): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) out.append(k, String(v));
  return out.toString();
}

async function call(fetchLike: EmailFetch, secretKey: string, method: "GET" | "POST", path: string, params: Params = {}): Promise<Obj> {
  const query = method === "GET" && Object.keys(params).length ? `?${encode(params)}` : "";
  const res = await fetchLike(`${API}${path}${query}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: method === "POST" ? encode(params) : "",
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok) {
    const message = asStr(asObj(asObj(parsed).error).message) || `Stripe answered ${res.status}`;
    throw new StripeApiError(res.status, message);
  }
  return asObj(parsed);
}

export const lookupKeyFor = (planKey: string): string => `unleashed-${planKey}`;

function priceMatches(price: Obj, plan: Plan, productId: string): boolean {
  const recurring = asObj(price.recurring);
  const interval = asStr(recurring.interval);
  const count = typeof recurring.interval_count === "number" ? recurring.interval_count : interval ? 1 : 0;
  return price.active === true
    && asStr(price.product) === productId
    && price.unit_amount === plan.amountCents
    && asStr(price.currency) === plan.currency
    && (plan.interval ? interval === plan.interval && count === 1 : !interval);
}

export async function provisionPlans(input: ProvisionInput, fetchLike: EmailFetch): Promise<ProvisionResult> {
  const key = input.secretKey;
  const get = (path: string, params?: Params) => call(fetchLike, key, "GET", path, params);
  const post = (path: string, params?: Params) => call(fetchLike, key, "POST", path, params);

  // ── product ──────────────────────────────────────────────────────────────
  // A LIST, not the search API: search is eventually consistent, and a re-run
  // a few seconds after the first would not see the product it just made.
  const products = asList(await get("/products", { active: true, limit: 100 }));
  let product = products.find((p) => asStr(asObj(p.metadata).wickhunter) === PRODUCT_TAG) ?? null;
  let productCreated = false;
  if (!product) {
    product = await post("/products", { name: input.productName, "metadata[wickhunter]": PRODUCT_TAG, "metadata[managed_by]": MANAGED_BY });
    productCreated = true;
  }
  const productId = asStr(product.id);
  if (!productId) throw new StripeApiError(502, "Stripe returned a product without an id");

  const links = asList(await get("/payment_links", { active: true, limit: 100 }));
  const results: ProvisionPlanResult[] = [];

  for (const plan of input.plans) {
    const notes: string[] = [];
    // ── price ────────────────────────────────────────────────────────────
    const found = asList(await get("/prices", { "lookup_keys[0]": lookupKeyFor(plan.key), limit: 10 }));
    let price = found.find((p) => priceMatches(p, plan, productId)) ?? null;
    let priceCreated = false;
    if (!price) {
      const stale = found.filter((p) => p.active === true);
      price = await post("/prices", {
        product: productId,
        currency: plan.currency,
        unit_amount: plan.amountCents,
        nickname: plan.name,
        lookup_key: lookupKeyFor(plan.key),
        transfer_lookup_key: true,
        "metadata[plan]": plan.key,
        "metadata[managed_by]": MANAGED_BY,
        ...(plan.interval ? { "recurring[interval]": plan.interval, "recurring[interval_count]": 1 } : {}),
      });
      priceCreated = true;
      for (const old of stale) {
        await post(`/prices/${asStr(old.id)}`, { active: false });
        notes.push(`archived price ${asStr(old.id)}`);
      }
    }
    const priceId = asStr(price.id);
    if (!priceId) throw new StripeApiError(502, `Stripe returned no price id for ${plan.key}`);

    // ── payment link ─────────────────────────────────────────────────────
    const mine = links.filter((l) => asStr(asObj(l.metadata).plan) === plan.key);
    let link = mine.find((l) => asStr(asObj(l.metadata).price) === priceId) ?? null;
    let linkCreated = false;
    if (!link) {
      for (const old of mine) {
        await post(`/payment_links/${asStr(old.id)}`, { active: false });
        notes.push(`deactivated link ${asStr(old.id)}`);
      }
      const redirect = input.siteOrigin ? `${input.siteOrigin.replace(/\/+$/, "")}/thanks/` : "";
      link = await post("/payment_links", {
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": 1,
        "metadata[plan]": plan.key,
        "metadata[price]": priceId,
        "metadata[managed_by]": MANAGED_BY,
        ...(plan.interval ? { "subscription_data[metadata][plan]": plan.key } : { "metadata[license_days]": String(plan.licenseDays ?? ""), customer_creation: "always" }),
        billing_address_collection: "required",
        ...(redirect
          ? { "after_completion[type]": "redirect", "after_completion[redirect][url]": redirect }
          : { "after_completion[type]": "hosted_confirmation" }),
      });
      linkCreated = true;
    }
    const url = asStr(link.url);
    if (!url.startsWith("https://")) throw new StripeApiError(502, `Stripe returned no URL for the ${plan.key} Payment Link`);
    results.push({ key: plan.key, priceId, priceCreated, paymentLinkUrl: url, linkCreated, note: notes.length ? notes.join("; ") : null });
  }

  return { product: { id: productId, name: asStr(product.name) || input.productName, created: productCreated }, plans: results };
}
