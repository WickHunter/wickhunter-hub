// tests/plans.test.mjs — plans on the Hub: /buy?plan=, the public price feed,
// "Create in Stripe" against a fake Stripe API (idempotent, and a price change
// rolls a new price + link), plan labels on licences, and a lifetime licence
// a ten-year lifetime key.
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { signStripePayload } from "../dist/src/billing/stripe.js";
import { validatePlans, paymentLinkFor, defaultBillingConfig, DEFAULT_PLANS, BillingConfigError } from "../dist/src/billing/config.js";

const DAY = 86_400_000;
const LIVE_WHSEC = "whsec_live_plans_0123456789";
const TEST_WHSEC = "whsec_test_plans_0123456789";

// ── a fake Stripe API with just enough state to be idempotent against ───────
const stripe = { products: [], prices: [], links: [], calls: [] };
let seq = 0;
const nextId = (prefix) => `${prefix}_${++seq}`;
const parseForm = (body) => Object.fromEntries(new URLSearchParams(body));
const fakeFetch = async (url, init) => {
  stripe.calls.push({ method: init.method, url, body: init.body });
  const u = new URL(url);
  const json = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
  if (u.hostname !== "api.stripe.com") return json({ id: "em_1" }); // the email provider
  if (init.headers.authorization !== "Bearer sk_test_fake" && init.headers.authorization !== "Bearer sk_live_fake") {
    return json({ error: { message: "Invalid API Key provided" } }, 401);
  }
  const path = u.pathname.replace(/^\/v1/, "");
  const params = init.method === "POST" ? parseForm(init.body) : Object.fromEntries(u.searchParams);
  let m;
  if (init.method === "GET" && path === "/products") return json({ object: "list", data: stripe.products.filter((p) => p.active) });
  if (init.method === "POST" && path === "/products") {
    const p = { id: nextId("prod"), name: params.name, active: true, metadata: { wickhunter: params["metadata[wickhunter]"], managed_by: params["metadata[managed_by]"] } };
    stripe.products.push(p);
    return json(p);
  }
  if (init.method === "GET" && path === "/prices") {
    return json({ object: "list", data: stripe.prices.filter((p) => p.lookup_key === params["lookup_keys[0]"]) });
  }
  if (init.method === "POST" && path === "/prices") {
    const taken = stripe.prices.find((p) => p.lookup_key === params.lookup_key);
    if (taken && params.transfer_lookup_key !== "true") return json({ error: { message: "lookup_key already in use" } }, 400);
    if (taken) taken.lookup_key = null;
    const p = {
      id: nextId("price"), product: params.product, currency: params.currency, unit_amount: Number(params.unit_amount), active: true,
      lookup_key: params.lookup_key, nickname: params.nickname, metadata: { plan: params["metadata[plan]"] },
      recurring: params["recurring[interval]"] ? { interval: params["recurring[interval]"], interval_count: Number(params["recurring[interval_count]"] ?? 1) } : null,
    };
    stripe.prices.push(p);
    return json(p);
  }
  if (init.method === "POST" && (m = /^\/prices\/(price_\d+)$/.exec(path))) {
    const p = stripe.prices.find((x) => x.id === m[1]);
    if (params.active === "false") p.active = false;
    return json(p);
  }
  if (init.method === "GET" && path === "/payment_links") return json({ object: "list", data: stripe.links.filter((l) => l.active) });
  if (init.method === "POST" && path === "/payment_links") {
    const l = {
      id: nextId("plink"), url: `https://buy.stripe.com/test_link${seq}`, active: true,
      metadata: { plan: params["metadata[plan]"], price: params["metadata[price]"], license_days: params["metadata[license_days]"] },
      after_completion: { type: params["after_completion[type]"], redirect: { url: params["after_completion[redirect][url]"] } },
      line_items: [{ price: params["line_items[0][price]"] }],
      billing_address_collection: params.billing_address_collection,
      customer_creation: params.customer_creation,
      subscription_plan: params["subscription_data[metadata][plan]"],
    };
    stripe.links.push(l);
    return json(l);
  }
  if (init.method === "POST" && (m = /^\/payment_links\/(plink_\d+)$/.exec(path))) {
    const l = stripe.links.find((x) => x.id === m[1]);
    if (params.active === "false") l.active = false;
    return json(l);
  }
  return json({ error: { message: `unhandled ${init.method} ${path}` } }, 404);
};
const creates = (path) => stripe.calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === `/v1${path}`).length;

let clock = Math.floor(Date.now() / 1000) * 1000;
const h = await freshHub({}, { billingFetch: fakeFetch, billingNow: () => clock, seatNow: () => clock });
const AUTH = { "x-hub-admin": "test-admin-token", "content-type": "application/json" };
const admin = (p, opts = {}) => jsonReq(`${h.origin}${p}`, { ...opts, headers: { ...AUTH, ...(opts.headers ?? {}) } });
const sec = () => Math.floor(clock / 1000);
let evSeq = 0;
const event = (type, object, livemode) => ({ id: `evt_p${++evSeq}`, object: "event", type, livemode, created: sec(), data: { object } });
async function postEvent(mode, ev) {
  const body = JSON.stringify(ev);
  const res = await fetch(`${h.origin}/api/billing/stripe/${mode}`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, mode === "live" ? LIVE_WHSEC : TEST_WHSEC, sec()) },
    body,
  });
  return { status: res.status, body: await res.json() };
}

// ── config units ────────────────────────────────────────────────────────────

await test("plans validate: keys, amounts, intervals, one-time needs a length, lifetime implies one-time", () => {
  assert.equal(validatePlans(DEFAULT_PLANS).length, 3);
  assert.throws(() => validatePlans([{ key: "Bad Key", name: "x", amountCents: 100 }]), BillingConfigError);
  assert.throws(() => validatePlans([{ key: "a", name: "x", amountCents: 50 }]), BillingConfigError);
  assert.throws(() => validatePlans([{ key: "a", name: "x", amountCents: 100, interval: "week" }]), BillingConfigError);
  assert.throws(() => validatePlans([{ key: "a", name: "x", amountCents: 100, interval: null }]), BillingConfigError, "one-time without licenseDays");
  assert.throws(() => validatePlans([{ key: "a", name: "x", amountCents: 100, interval: "month", lifetime: true }]), BillingConfigError);
  assert.throws(() => validatePlans([{ key: "a", name: "x", amountCents: 100, interval: "month" }, { key: "a", name: "y", amountCents: 200, interval: "year" }]), BillingConfigError, "duplicate key");
  const ok = validatePlans([{ key: "Pro", name: " Pro ", amountCents: "1999", interval: "month" }, { key: "life", name: "Life", amountCents: 100000, interval: null, lifetime: true }]);
  assert.equal(ok[0].key, "pro");
  assert.equal(ok[0].amountCents, 1999);
  assert.equal(ok[1].licenseDays, 3650, "lifetime pins the maximum length");
});

await test("paymentLinkFor: per-plan map first, legacy single field only for the first plan", () => {
  const cfg = defaultBillingConfig();
  cfg.stripe.test.paymentLinkUrl = "https://buy.stripe.com/test_legacy";
  assert.equal(paymentLinkFor(cfg, "test", null), "https://buy.stripe.com/test_legacy");
  assert.equal(paymentLinkFor(cfg, "test", "monthly"), "https://buy.stripe.com/test_legacy");
  assert.equal(paymentLinkFor(cfg, "test", "yearly"), "");
  assert.equal(paymentLinkFor(cfg, "test", "nope"), "");
  cfg.stripe.test.paymentLinks.yearly = "https://buy.stripe.com/test_y";
  assert.equal(paymentLinkFor(cfg, "test", "yearly"), "https://buy.stripe.com/test_y");
});

// ── the public feed and /buy?plan= ──────────────────────────────────────────

await test("GET /api/billing/plans is public, CORS-open and names the three defaults", async () => {
  const res = await fetch(`${h.origin}/api/billing/plans`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const body = await res.json();
  assert.equal(body.mode, "test");
  assert.deepEqual(body.plans.map((p) => [p.key, p.amountCents, p.interval, p.lifetime, p.available]), [
    ["monthly", 9900, "month", false, false],
    ["yearly", 69900, "year", false, false],
    ["lifetime", 99900, null, true, false],
  ]);
  assert.equal(body.plans[1].buyUrl, "https://hub.test/hub/buy?plan=yearly");
});

await test("/buy?plan= routes per plan: unknown 404, unconfigured 503, configured 302, no plan = first plan", async () => {
  assert.equal((await fetch(`${h.origin}/buy?plan=bogus`, { redirect: "manual" })).status, 404);
  assert.equal((await fetch(`${h.origin}/buy?plan=yearly`, { redirect: "manual" })).status, 503);
  const r = await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ stripe: { test: { paymentLinkUrl: "https://buy.stripe.com/test_m", paymentLinks: { yearly: "https://buy.stripe.com/test_y" } } } }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.stripe.test.paymentLinks, { yearly: "https://buy.stripe.com/test_y" });
  assert.equal(r.body.endpoints.buyPlans.lifetime, "https://hub.test/hub/buy?plan=lifetime");
  assert.equal((await fetch(`${h.origin}/buy?plan=yearly`, { redirect: "manual" })).headers.get("location"), "https://buy.stripe.com/test_y");
  assert.equal((await fetch(`${h.origin}/buy`, { redirect: "manual" })).headers.get("location"), "https://buy.stripe.com/test_m");
  assert.equal((await fetch(`${h.origin}/buy?plan=monthly`, { redirect: "manual" })).headers.get("location"), "https://buy.stripe.com/test_m");
  const clear = await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ stripe: { test: { paymentLinks: { yearly: null } } } }) });
  assert.deepEqual(clear.body.stripe.test.paymentLinks, {});
  const plans = await (await fetch(`${h.origin}/api/billing/plans`)).json();
  assert.equal(plans.plans[0].available, true, "monthly is available through the legacy field");
});

await test("prices are edited on the Hub: POST plans replaces the list, bad input is refused", async () => {
  const plans = DEFAULT_PLANS.map((p) => ({ ...p }));
  plans[0].amountCents = 7900;
  const r = await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ plans }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.plans[0].amountCents, 7900);
  const feed = await (await fetch(`${h.origin}/api/billing/plans`)).json();
  assert.equal(feed.plans[0].amountCents, 7900, "the website feed follows the Hub");
  const bad = await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ plans: [{ key: "x", name: "X", amountCents: 1 }] }) });
  assert.equal(bad.status, 400);
  await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ plans: DEFAULT_PLANS }) });
});

// ── Create in Stripe ────────────────────────────────────────────────────────

await test("provisioning needs a saved secret key, and a refused key is explained", async () => {
  const none = await admin("/admin/api/billing/plans/provision", { method: "POST", body: JSON.stringify({ mode: "test" }) });
  assert.equal(none.status, 400);
  await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ stripe: { test: { secretKey: "sk_test_wrong" } }, siteOrigin: "https://wickhunterunleashed.com" }) });
  const bad = await admin("/admin/api/billing/plans/provision", { method: "POST", body: JSON.stringify({ mode: "test" }) });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /Invalid API Key/);
  assert.match(bad.body.error, /Products, Prices and Payment Links/);
});

await test("Create in Stripe makes the product, three prices and three links, and saves the links", async () => {
  await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ stripe: { test: { secretKey: "sk_test_fake" } } }) });
  const r = await admin("/admin/api/billing/plans/provision", { method: "POST", body: JSON.stringify({ mode: "test" }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.product.created, true);
  assert.equal(r.body.plans.length, 3);
  assert.ok(r.body.plans.every((p) => p.priceCreated && p.linkCreated));
  assert.equal(stripe.products.length, 1);
  assert.equal(stripe.prices.length, 3);
  assert.equal(stripe.links.length, 3);
  const monthly = stripe.prices.find((p) => p.lookup_key === "unleashed-monthly");
  assert.deepEqual([monthly.unit_amount, monthly.currency, monthly.recurring.interval], [9900, "usd", "month"]);
  const life = stripe.links.find((l) => l.metadata.plan === "lifetime");
  assert.equal(life.metadata.license_days, "3650");
  assert.equal(life.customer_creation, "always");
  assert.equal(life.after_completion.redirect.url, "https://wickhunterunleashed.com/thanks/");
  assert.equal(life.billing_address_collection, "required");
  const yearlyLink = stripe.links.find((l) => l.metadata.plan === "yearly");
  assert.equal(yearlyLink.subscription_plan, "yearly", "subscriptions carry the plan in subscription metadata too");
  const cfg = await admin("/admin/api/billing/config");
  assert.deepEqual(Object.keys(cfg.body.stripe.test.paymentLinks).sort(), ["lifetime", "monthly", "yearly"]);
  assert.equal(cfg.body.stripe.test.paymentLinkUrl, "https://buy.stripe.com/test_m", "an already-set legacy field is left alone");
  assert.equal((await fetch(`${h.origin}/buy?plan=monthly`, { redirect: "manual" })).headers.get("location"), cfg.body.stripe.test.paymentLinks.monthly, "the per-plan link wins over the legacy field");
  assert.equal((await fetch(`${h.origin}/buy?plan=lifetime`, { redirect: "manual" })).headers.get("location"), life.url);
});

await test("a second run reuses everything", async () => {
  const before = { p: creates("/products"), pr: creates("/prices"), l: creates("/payment_links") };
  const r = await admin("/admin/api/billing/plans/provision", { method: "POST", body: JSON.stringify({ mode: "test" }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.product.created, false);
  assert.ok(r.body.plans.every((p) => !p.priceCreated && !p.linkCreated));
  assert.deepEqual({ p: creates("/products"), pr: creates("/prices"), l: creates("/payment_links") }, before);
});

await test("a price change rolls a new price and link and retires the old ones", async () => {
  const plans = DEFAULT_PLANS.map((p) => ({ ...p }));
  plans[0].amountCents = 8900;
  await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ plans }) });
  const oldPrice = stripe.prices.find((p) => p.lookup_key === "unleashed-monthly");
  const oldLink = stripe.links.find((l) => l.metadata.plan === "monthly");
  const r = await admin("/admin/api/billing/plans/provision", { method: "POST", body: JSON.stringify({ mode: "test" }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const monthly = r.body.plans.find((p) => p.key === "monthly");
  assert.equal(monthly.priceCreated, true);
  assert.equal(monthly.linkCreated, true);
  assert.match(monthly.note, /archived price/);
  assert.match(monthly.note, /deactivated link/);
  assert.equal(oldPrice.active, false);
  assert.equal(oldPrice.lookup_key, null, "the lookup key moved to the new price");
  assert.equal(oldLink.active, false);
  const fresh = stripe.prices.find((p) => p.lookup_key === "unleashed-monthly");
  assert.equal(fresh.unit_amount, 8900);
  assert.ok(r.body.plans.filter((p) => p.key !== "monthly").every((p) => !p.priceCreated && !p.linkCreated), "the other plans are untouched");
  const cfg = await admin("/admin/api/billing/config");
  assert.equal(cfg.body.stripe.test.paymentLinks.monthly, monthly.paymentLinkUrl);
  await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ plans: DEFAULT_PLANS }) });
});

// ── plan labels and lifetime ────────────────────────────────────────────────

let lifetimeId;
await test("a lifetime purchase (live) issues a ten-year key labelled with the plan", async () => {
  await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ mode: "live", stripe: { live: { webhookSecret: LIVE_WHSEC, secretKey: "sk_live_fake", paymentLinkUrl: "https://buy.stripe.com/live_m" } }, email: { provider: "resend", apiKey: "re_12345678", from: "Wick Hunter <hello@wickhunterunleashed.com>" } }) });
  const r = await postEvent("live", event("checkout.session.completed", {
    id: "cs_life", mode: "payment", status: "complete", payment_status: "paid", customer: "cus_L", subscription: null, payment_intent: "pi_L",
    customer_details: { email: "life@example.com", name: "Lif E. Time" }, metadata: { plan: "lifetime" },
  }, true));
  assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
  const lic = h.store.list().find((l) => l.name === "Lif E. Time");
  lifetimeId = lic.id;
  assert.equal(lic.plan, "unleashed-lifetime");
  assert.equal(lic.exp, clock + 3650 * DAY);
  const row = (await admin("/admin/api/billing/customers")).body.customers.find((c) => c.licenseId === lic.id);
  assert.equal(row.planKey, "lifetime");
});

await test("a subscription plan labels the licence and a renewal is capped at the ten-year window", async () => {
  const r = await postEvent("live", event("checkout.session.completed", {
    id: "cs_year", mode: "subscription", status: "complete", payment_status: "paid", customer: "cus_Y", subscription: "sub_Y",
    customer_details: { email: "year@example.com", name: "Yearly Yolanda" }, metadata: { plan: "yearly" },
  }, true));
  assert.equal(r.body.outcome, "applied");
  const lic = h.store.list().find((l) => l.name === "Yearly Yolanda");
  assert.equal(lic.plan, "unleashed-yearly");
  const inv = await postEvent("live", event("invoice.paid", {
    id: "in_Y11", customer: "cus_Y", customer_email: "year@example.com", customer_name: "Yearly Yolanda", subscription: "sub_Y", paid: true, status: "paid",
    lines: { data: [{ period: { start: sec(), end: sec() + 11 * 365 * 86_400 } }] },
  }, true));
  assert.equal(inv.body.outcome, "applied", JSON.stringify(inv.body));
  const after = h.store.list().find((l) => l.id === lic.id);
  assert.equal(after.exp, after.iat + 3650 * DAY, "capped at the format bound, measured from issue");
});

await test("a test-mode purchase keeps the -test suffix after the plan", async () => {
  await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ mode: "test", stripe: { test: { webhookSecret: TEST_WHSEC } } }) });
  const r = await postEvent("test", event("checkout.session.completed", {
    id: "cs_tm", mode: "subscription", status: "complete", payment_status: "paid", customer: "cus_TM", subscription: "sub_TM",
    customer_details: { email: "tm@example.com", name: "Test Monthly" }, metadata: { plan: "monthly" },
  }, false));
  assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
  assert.equal(h.store.list().find((l) => l.name === "Test Monthly").plan, "unleashed-monthly-test");
  const unknownPlan = await postEvent("test", event("checkout.session.completed", {
    id: "cs_up", mode: "subscription", status: "complete", payment_status: "paid", customer: "cus_UP", subscription: "sub_UP",
    customer_details: { email: "up@example.com", name: "Untagged" }, metadata: { plan: "gold" },
  }, false));
  assert.equal(unknownPlan.body.outcome, "applied");
  assert.equal(h.store.list().find((l) => l.name === "Untagged").plan, "unleashed-test", "an unknown plan tag is ignored, not trusted");
});

await h.close();
summary("plans");
