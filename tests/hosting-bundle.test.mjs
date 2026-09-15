import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { signStripePayload } from "../dist/src/billing/stripe.js";
import { FakeProvider } from "../dist/src/hosting/provider.js";

const WHSEC = "whsec_test_bundle_0123456789";
const RELEASE = "b".repeat(64);

async function setup(overrides = {}) {
  let clock = Math.floor(Date.now() / 1000) * 1000;
  const calls = [];
  const h = await freshHub({}, {
    billingNow: () => clock, hostingNow: () => clock,
    billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    hostingProvider: new FakeProvider({ now: () => clock }),
    hostingFetch: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/v1/prices/")) {
        const id = url.split("/").pop();
        const annual = id === "price_bundle_year";
        return { ok: true, status: 200, text: async () => JSON.stringify({ id, active: true, unit_amount: id === "price_bundle_month" && overrides.staleMonthlyPrice ? 11800 : annual ? 93900 : id === "price_bundle_month" ? 11900 : 2000, currency: "usd", type: "recurring", recurring: { interval: annual ? "year" : "month", interval_count: 1 } }) };
      }
      if (url.endsWith("/v1/checkout/sessions")) return { ok: true, status: 200, text: async () => JSON.stringify({ url: "https://checkout.stripe.com/c/pay_bundle" }) };
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  const admin = (p, body) => jsonReq(`${h.origin}${p}`, { method: "POST", headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  await admin("/admin/api/billing/config", {
    stripe: { test: { secretKey: "sk_test_bundle_0123456789", webhookSecret: WHSEC, priceIds: { "monthly-hosted": "price_bundle_month", "yearly-hosted": "price_bundle_year" } } },
    roles: { test: { hosting: { priceIds: ["price_host1"] } } },
    plans: [
      { key: "monthly", name: "Monthly", amountCents: 9900, currency: "usd", interval: "month", role: "software" },
      { key: "yearly", name: "Yearly", amountCents: 69900, currency: "usd", interval: "year", role: "software" },
      { key: "lifetime", name: "Lifetime", amountCents: 99900, currency: "usd", interval: null, licenseDays: 3650, lifetime: true, role: "software" },
      { key: "hosting-monthly", name: "Hosting", amountCents: 2000, currency: "usd", interval: "month", role: "hosting" },
      { key: "monthly-hosted", name: "Monthly + VPS", amountCents: 11900, currency: "usd", interval: "month", role: "software", checkout: "hosted-bundle" },
      { key: "yearly-hosted", name: "Yearly + VPS", amountCents: 93900, currency: "usd", interval: "year", role: "software", checkout: "hosted-bundle" },
    ],
  });
  await admin("/admin/api/hosting/policy", { policy: { provisioningEnabled: true, monthlyPriceCents: 2000, osId: "2284", releaseRef: RELEASE, maximumProjectedMonthlyProviderCostCents: 10000 } });
  const event = (id, type, object) => ({ id, object: "event", type, livemode: false, created: Math.floor(clock / 1000), data: { object } });
  async function post(ev) {
    const body = JSON.stringify(ev);
    const res = await fetch(`${h.origin}/api/billing/stripe/test`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, WHSEC, Math.floor(clock / 1000)) }, body });
    return { status: res.status, body: await res.json() };
  }
  return { h, calls, event, post, advance: (ms) => { clock += ms; }, now: () => clock };
}

await test("bundle checkout is CORS-safe, reserved, idempotent and not reachable through /buy", async () => {
  const c = await setup();
  const options = await fetch(`${c.h.origin}/api/hosting/options`).then((r) => r.json());
  assert.equal(options.bundleEnabled, true);
  const preflight = await fetch(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "OPTIONS", headers: { origin: "https://www.wickhunterunleashed.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(preflight.status, 204);
  const request = { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174000" };
  const first = await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  const second = await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  const changedPlan = await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, plan: "yearly" }) });
  assert.equal(first.status, 200); assert.deepEqual(first.body.pricing, { amountCents: 11900, currency: "usd", interval: "month", softwareDays: 30, maximumConnectedAccounts: 5 });
  assert.equal(second.body.url, first.body.url);
  assert.equal(changedPlan.status, 409); assert.match(changedPlan.body.error, /different plan/);
  assert.equal(c.calls.filter((x) => x.url.endsWith("/v1/checkout/sessions")).length, 1);
  assert.equal((await fetch(`${c.h.origin}/buy?plan=monthly-hosted`)).status, 403);
  await c.h.close();
});

await test("anonymous bundle reservations are bounded and expired reservations release capacity", async () => {
  const c = await setup();
  const checkout = (suffix) => jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", checkoutAttemptId: `123e4567-e89b-12d3-a456-42661417${suffix}` }) });
  assert.equal((await checkout("4101")).status, 200);
  assert.equal((await checkout("4102")).status, 200);
  assert.equal((await checkout("4103")).status, 200);
  assert.equal((await checkout("4104")).status, 503);
  c.advance(31 * 60_000);
  assert.equal((await checkout("4104")).status, 200);
  assert.equal(c.h.hub.hosting.store.instances().filter((x) => x.ownerId.startsWith("bundle:") && x.stage === "ordered").length, 1);
  await c.h.close();
});

await test("bundle checkout fails closed before reservation when Stripe price is stale", async () => {
  const c = await setup({ staleMonthlyPrice: true });
  const r = await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174999" }) });
  assert.equal(r.status, 503);
  assert.equal(c.h.hub.hosting.store.instances().length, 0);
  assert.equal(c.calls.filter((x) => x.url.endsWith("/v1/checkout/sessions")).length, 0);
  await c.h.close();
});

await test("bundle metadata with a non-configured invoice price grants neither licence nor VPS", async () => {
  const c = await setup();
  await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174998" }) });
  const row = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: row.id };
  const bad = c.event("evt_wrong_bundle_price", "invoice.paid", { id: "in_wrong", paid: true, customer: "cus_wrong", customer_email: "wrong@example.com", subscription: "sub_wrong", subscription_details: { metadata }, lines: { data: [{ period: { end: Math.floor((c.now() + 30 * 86400000) / 1000) }, price: { id: "price_unclassified" } }] } });
  assert.equal((await c.post(bad)).body.outcome, "unclassified");
  assert.equal(Object.keys(c.h.hub.billing.store.customers()).length, 0);
  assert.ok(c.h.hub.hosting.store.instances()[0].ownerId.startsWith("bundle:"));
  await c.h.close();
});

await test("bundle webhooks atomically bind one VPS and renew/cancel software and hosting together", async () => {
  const c = await setup();
  await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "yearly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174111" }) });
  const reserved = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "yearly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const checkout = c.event("evt_bundle_checkout", "checkout.session.completed", { id: "cs_bundle", mode: "subscription", payment_status: "paid", customer: "cus_bundle", customer_details: { email: "bundle@example.com" }, subscription: "sub_bundle", metadata });
  assert.equal((await c.post(checkout)).body.outcome, "applied");
  assert.equal((await c.post(checkout)).body.outcome, "duplicate");
  const adopted = c.h.hub.hosting.store.getInstance(reserved.id);
  assert.equal(adopted.ownerId, "cus_bundle");
  const periodEnd = Math.floor((c.now() + 365 * 86400000) / 1000);
  const invoice = c.event("evt_bundle_invoice", "invoice.paid", { id: "in_bundle", paid: true, status: "paid", customer: "cus_bundle", customer_email: "bundle@example.com", subscription: "sub_bundle", subscription_details: { metadata }, lines: { data: [{ period: { end: periodEnd }, price: { id: "price_bundle_year", product: "prod_bundle" } }] }, charge: "ch_bundle", payment_intent: "pi_bundle" });
  assert.equal((await c.post(invoice)).body.outcome, "applied");
  const sw = c.h.hub.billing.store.getCustomer("cus_bundle");
  const host = c.h.hub.billing.store.getRoleSubscription("cus_bundle", "hosting");
  assert.equal(sw.subscriptionId, "sub_bundle"); assert.equal(host.subscriptionId, "sub_bundle"); assert.equal(host.periodEndMs, periodEnd * 1000);
  const firstExp = c.h.hub.store.get(sw.licenseId).exp;
  const renewalEnd = periodEnd + 365 * 86400;
  const renewal = c.event("evt_bundle_renewal", "invoice.paid", { id: "in_bundle_2", paid: true, customer: "cus_bundle", customer_email: "bundle@example.com", subscription: "sub_bundle", subscription_details: { metadata }, lines: { data: [{ period: { end: renewalEnd }, price: { id: "price_bundle_year", product: "prod_bundle" } }] }, charge: "ch_bundle_2" });
  assert.equal((await c.post(renewal)).body.outcome, "applied");
  assert.equal(c.h.hub.billing.store.getCustomer("cus_bundle").periodEndMs, renewalEnd * 1000, "software paid-through advances on the same renewal");
  assert.ok(c.h.hub.store.get(sw.licenseId).exp >= firstExp, "the test-mode safety cap may bound the key, but renewal never shortens it");
  assert.equal(c.h.hub.billing.store.getRoleSubscription("cus_bundle", "hosting").periodEndMs, renewalEnd * 1000);
  const exp = c.h.hub.store.get(sw.licenseId).exp;
  const deleted = c.event("evt_bundle_deleted", "customer.subscription.deleted", { id: "sub_bundle", customer: "cus_bundle", status: "canceled", ended_at: Math.floor(c.now() / 1000), metadata, items: { data: [{ price: { id: "price_bundle_year" } }] } });
  assert.equal((await c.post(deleted)).body.outcome, "applied");
  assert.equal(c.h.hub.billing.store.getCustomer("cus_bundle").subscriptionStatus, "canceled");
  assert.equal(c.h.hub.billing.store.getRoleSubscription("cus_bundle", "hosting").subscriptionStatus, "canceled");
  assert.equal(c.h.hub.store.get(sw.licenseId).exp, exp, "cancel never shortens the already-paid software term");
  await c.h.close();
});

await test("a paid bundle invoice arriving before Checkout completion converges without another licence or VPS", async () => {
  const c = await setup();
  await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174222" }) });
  const reserved = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const end = Math.floor((c.now() + 30 * 86400000) / 1000);
  const invoice = c.event("evt_early_invoice", "invoice.paid", { id: "in_early", paid: true, customer: "cus_early", customer_email: "early@example.com", subscription: "sub_early", subscription_details: { metadata }, lines: { data: [{ period: { end }, price: { id: "price_bundle_month" } }] }, charge: "ch_early" });
  assert.equal((await c.post(invoice)).body.outcome, "applied");
  const checkout = c.event("evt_late_checkout", "checkout.session.completed", { id: "cs_late", mode: "subscription", payment_status: "paid", customer: "cus_early", customer_details: { email: "early@example.com" }, subscription: "sub_early", metadata });
  assert.equal((await c.post(checkout)).body.outcome, "applied");
  assert.equal(Object.keys(c.h.hub.billing.store.customers()).length, 1);
  assert.equal(c.h.hub.hosting.store.instances().filter((x) => x.stage !== "deleted").length, 1);
  assert.equal(c.h.hub.hosting.store.instances()[0].ownerId, "cus_early");
  await c.h.close();
});

await test("a deletion delivered before payment permanently closes that subscription without granting either entitlement", async () => {
  const c = await setup();
  await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174333" }) });
  const reserved = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const deleted = c.event("evt_deleted_first", "customer.subscription.deleted", { id: "sub_deleted_first", customer: "cus_deleted_first", status: "canceled", metadata, items: { data: [{ price: { id: "price_bundle_month" } }] } });
  assert.equal((await c.post(deleted)).body.outcome, "applied");
  assert.equal(c.h.hub.hosting.store.getInstance(reserved.id).stage, "deleted");
  assert.equal(Object.keys(c.h.hub.billing.store.customers()).length, 0);
  c.advance(1000);
  const end = Math.floor((c.now() + 30 * 86400000) / 1000);
  const paid = c.event("evt_paid_after_deleted", "invoice.paid", { id: "in_after_deleted", paid: true, customer: "cus_deleted_first", customer_email: "late@example.com", subscription: "sub_deleted_first", subscription_details: { metadata }, lines: { data: [{ period: { end }, price: { id: "price_bundle_month" } }] } });
  assert.equal((await c.post(paid)).body.outcome, "ignored");
  assert.equal(Object.keys(c.h.hub.billing.store.customers()).length, 0);
  assert.equal((await c.post(deleted)).body.outcome, "duplicate");
  await c.h.close();
});

await test("a terminal bundle event beats older and equal-second paid events and preserves paid-through", async () => {
  const c = await setup();
  await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174444" }) });
  const reserved = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const end = Math.floor((c.now() + 30 * 86400000) / 1000);
  const initial = c.event("evt_initial_paid", "invoice.paid", { id: "in_initial", paid: true, customer: "cus_ordered", customer_email: "ordered@example.com", subscription: "sub_ordered", subscription_details: { metadata }, lines: { data: [{ period: { end }, price: { id: "price_bundle_month" } }] } });
  assert.equal((await c.post(initial)).body.outcome, "applied");
  const stale = c.event("evt_stale_paid", "invoice.paid", { id: "in_stale", paid: true, customer: "cus_ordered", customer_email: "ordered@example.com", subscription: "sub_ordered", subscription_details: { metadata }, lines: { data: [{ period: { end: end + 30 * 86400 }, price: { id: "price_bundle_month" } }] } });
  c.advance(1000);
  const deleted = c.event("evt_ordered_deleted", "customer.subscription.deleted", { id: "sub_ordered", customer: "cus_ordered", status: "canceled", metadata, items: { data: [{ price: { id: "price_bundle_month" } }] } });
  assert.equal((await c.post(deleted)).body.outcome, "applied");
  const paidThrough = c.h.hub.billing.store.getCustomer("cus_ordered").periodEndMs;
  assert.equal((await c.post(stale)).body.outcome, "ignored");
  const equalSecond = { ...stale, id: "evt_equal_second_paid", created: deleted.created };
  assert.equal((await c.post(equalSecond)).body.outcome, "ignored");
  assert.equal(c.h.hub.billing.store.getCustomer("cus_ordered").subscriptionStatus, "canceled");
  assert.equal(c.h.hub.billing.store.getCustomer("cus_ordered").periodEndMs, paidThrough);
  assert.equal(c.h.hub.billing.store.getRoleSubscription("cus_ordered", "hosting").subscriptionStatus, "canceled");
  await c.h.close();
});

await test("a bound bundle subscription cannot renew through a different price", async () => {
  const c = await setup();
  await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174555" }) });
  const reserved = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const end = Math.floor((c.now() + 30 * 86400000) / 1000);
  const initial = c.event("evt_price_initial", "invoice.paid", { id: "in_price_initial", paid: true, customer: "cus_price", customer_email: "price@example.com", subscription: "sub_price", subscription_details: { metadata }, lines: { data: [{ period: { end }, price: { id: "price_bundle_month" } }] } });
  assert.equal((await c.post(initial)).body.outcome, "applied");
  const before = c.h.hub.billing.store.getCustomer("cus_price").periodEndMs;
  c.advance(1000);
  const changed = c.event("evt_changed_price", "invoice.paid", { id: "in_changed_price", paid: true, customer: "cus_price", customer_email: "price@example.com", subscription: "sub_price", subscription_details: { metadata: {} }, lines: { data: [{ period: { end: end + 30 * 86400 }, price: { id: "price_not_bundle" } }] } });
  assert.equal((await c.post(changed)).body.outcome, "unclassified");
  assert.equal(c.h.hub.billing.store.getCustomer("cus_price").periodEndMs, before);
  assert.equal(c.h.hub.billing.store.getRoleSubscription("cus_price", "hosting").periodEndMs, before);
  const wrongPlan = c.event("evt_changed_plan", "invoice.paid", { id: "in_changed_plan", paid: true, customer: "cus_price", customer_email: "price@example.com", subscription: "sub_price", subscription_details: { metadata: { ...metadata, plan: "yearly-hosted" } }, lines: { data: [{ period: { end: end + 30 * 86400 }, price: { id: "price_bundle_month" } }] } });
  assert.equal((await c.post(wrongPlan)).body.outcome, "unclassified");
  assert.equal(c.h.hub.billing.store.getCustomer("cus_price").planKey, "monthly-hosted");
  await c.h.close();
});

await test("an older paid event cannot undo a newer failed-payment state", async () => {
  const c = await setup();
  await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174666" }) });
  const reserved = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const end = Math.floor((c.now() + 30 * 86400000) / 1000);
  const initial = c.event("evt_failed_initial", "invoice.paid", { id: "in_failed_initial", paid: true, customer: "cus_failed_order", customer_email: "failed@example.com", subscription: "sub_failed_order", subscription_details: { metadata }, lines: { data: [{ period: { end }, price: { id: "price_bundle_month" } }] } });
  assert.equal((await c.post(initial)).body.outcome, "applied");
  const stalePaid = c.event("evt_paid_before_failure", "invoice.paid", { id: "in_before_failure", paid: true, customer: "cus_failed_order", customer_email: "failed@example.com", subscription: "sub_failed_order", subscription_details: { metadata }, lines: { data: [{ period: { end: end + 30 * 86400 }, price: { id: "price_bundle_month" } }] } });
  c.advance(1000);
  const failed = c.event("evt_newer_failure", "invoice.payment_failed", { id: "in_newer_failure", paid: false, customer: "cus_failed_order", customer_email: "failed@example.com", subscription: "sub_failed_order", subscription_details: { metadata }, lines: { data: [{ period: { end: end + 30 * 86400 }, price: { id: "price_bundle_month" } }] } });
  assert.equal((await c.post(failed)).body.outcome, "applied");
  assert.equal((await c.post(stalePaid)).body.outcome, "ignored");
  assert.equal(c.h.hub.billing.store.getCustomer("cus_failed_order").subscriptionStatus, "past_due");
  assert.equal(c.h.hub.billing.store.getRoleSubscription("cus_failed_order", "hosting").subscriptionStatus, "past_due");
  assert.equal(c.h.hub.billing.store.getCustomer("cus_failed_order").periodEndMs, end * 1000);
  await c.h.close();
});

await test("pre-activation status events cannot strand a paid customer, and a newer failure remains authoritative", async () => {
  const activeFirst = await setup();
  await jsonReq(`${activeFirst.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174777" }) });
  let reserved = activeFirst.h.hub.hosting.store.instances()[0];
  let metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const oldEnd = Math.floor((activeFirst.now() + 30 * 86400000) / 1000);
  const olderPaid = activeFirst.event("evt_older_initial_paid", "invoice.paid", { id: "in_older_initial", paid: true, customer: "cus_active_first", customer_email: "active-first@example.com", subscription: "sub_active_first", subscription_details: { metadata }, lines: { data: [{ period: { end: oldEnd }, price: { id: "price_bundle_month" } }] } });
  activeFirst.advance(1000);
  const active = activeFirst.event("evt_active_first", "customer.subscription.updated", { id: "sub_active_first", customer: "cus_active_first", status: "active", metadata, items: { data: [{ price: { id: "price_bundle_month" } }] } });
  assert.equal((await activeFirst.post(active)).body.outcome, "ignored");
  assert.equal((await activeFirst.post(olderPaid)).body.outcome, "applied");
  assert.equal(activeFirst.h.hub.billing.store.getCustomer("cus_active_first").periodEndMs, oldEnd * 1000);
  await activeFirst.h.close();

  const failedFirst = await setup();
  await jsonReq(`${failedFirst.h.origin}/api/hosting/bundle-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "yearly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174778" }) });
  reserved = failedFirst.h.hub.hosting.store.instances()[0];
  metadata = { plan: "yearly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const yearEnd = Math.floor((failedFirst.now() + 365 * 86400000) / 1000);
  const initialPaid = failedFirst.event("evt_initial_behind_failure", "invoice.paid", { id: "in_initial_behind_failure", paid: true, customer: "cus_failed_first", customer_email: "failed-first@example.com", subscription: "sub_failed_first", subscription_details: { metadata }, lines: { data: [{ period: { end: yearEnd }, price: { id: "price_bundle_year" } }] } });
  failedFirst.advance(1000);
  const newerFailure = failedFirst.event("evt_failure_before_initial", "invoice.payment_failed", { id: "in_failure_before_initial", paid: false, customer: "cus_failed_first", customer_email: "failed-first@example.com", subscription: "sub_failed_first", subscription_details: { metadata }, lines: { data: [{ period: { end: yearEnd + 365 * 86400 }, price: { id: "price_bundle_year" } }] } });
  assert.equal((await failedFirst.post(newerFailure)).body.outcome, "ignored");
  assert.equal((await failedFirst.post(initialPaid)).body.outcome, "applied");
  assert.equal(failedFirst.h.hub.billing.store.getCustomer("cus_failed_first").periodEndMs, yearEnd * 1000);
  assert.equal(failedFirst.h.hub.billing.store.getCustomer("cus_failed_first").subscriptionStatus, "past_due");
  assert.equal(failedFirst.h.hub.billing.store.getRoleSubscription("cus_failed_first", "hosting").subscriptionStatus, "past_due");
  await failedFirst.h.close();
});

await summary();
