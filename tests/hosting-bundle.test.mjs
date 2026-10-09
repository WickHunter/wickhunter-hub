import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { parseStripeEvent, signStripePayload } from "../dist/src/billing/stripe.js";
import { createHub } from "../dist/src/server.js";
import { FakeProvider } from "../dist/src/hosting/provider.js";

const WHSEC = "whsec_test_bundle_0123456789";
const RELEASE = "b".repeat(64);

async function setup(overrides = {}) {
  let clock = Math.floor(Date.now() / 1000) * 1000;
  const calls = [];
  const provider = new FakeProvider({ now: () => clock });
  const h = await freshHub({}, {
    billingNow: () => clock, hostingNow: () => clock,
    billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    hostingProvider: provider,
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
  return { h, calls, provider, event, post, advance: (ms) => { clock += ms; }, now: () => clock };
}

// These fixtures preserve already-created v1 obligations. Fresh public
// admissions are covered by billing-six-plan; only the historical service
// creates their durable seed, then lifecycle runs through signed HTTP events.
async function legacyCheckout(c, request) {
  const r = await c.h.hub.hosting.bundleCheckout(request.plan === 'monthly' ? 'month' : 'year', request.checkoutAttemptId);
  return r.ok ? { status: 200, body: {ok:true,...r.value} } : { status:r.code==='HOSTING_ALREADY_EXISTS'?409:503,body:r };
}

await test("bundle checkout is CORS-safe, reserved, idempotent and not reachable through /buy", async () => {
  const c = await setup();
  const options = await fetch(`${c.h.origin}/api/hosting/options`).then((r) => r.json());
  assert.equal(options.bundleEnabled, false);
  const preflight = await fetch(`${c.h.origin}/api/hosting/bundle-checkout`, { method: "OPTIONS", headers: { origin: "https://www.wickhunterunleashed.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(preflight.status, 204);
  const request = { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174000" };
  const first = await legacyCheckout(c, request);
  const second = await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request)});
  assert.equal((await jsonReq(`${c.h.origin}/api/hosting/bundle-checkout`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...request,checkoutAttemptId:"123e4567-e89b-12d3-a456-426614174999"})})).status,503);
  const changedPlan = await legacyCheckout(c, { ...request, plan: "yearly" });
  assert.equal(first.status, 200); assert.deepEqual(first.body.pricing, { amountCents: 11900, currency: "usd", interval: "month", softwareDays: 30, maximumConnectedAccounts: 5 });
  assert.equal(second.body.url, first.body.url);
  assert.equal(changedPlan.status, 409); assert.match(changedPlan.body.error, /different plan/);
  assert.equal(c.calls.filter((x) => x.url.endsWith("/v1/checkout/sessions")).length, 1);
  assert.equal((await fetch(`${c.h.origin}/buy?plan=monthly-hosted`)).status, 400);
  await c.h.close();
});

await test("anonymous bundle reservations are bounded and expired reservations release capacity", async () => {
  const c = await setup();
  const checkout = (suffix) => legacyCheckout(c, { plan: "monthly", checkoutAttemptId: `123e4567-e89b-12d3-a456-42661417${suffix}` });
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
  const r = await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174999" });
  assert.equal(r.status, 503);
  assert.equal(c.h.hub.hosting.store.instances().length, 0);
  assert.equal(c.calls.filter((x) => x.url.endsWith("/v1/checkout/sessions")).length, 0);
  await c.h.close();
});

await test("bundle metadata with a non-configured invoice price grants neither licence nor VPS", async () => {
  const c = await setup();
  await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174998" });
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
  await legacyCheckout(c, { plan: "yearly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174111" });
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

await test("checkout delivered before its older initial paid invoice fills the bootstrap term exactly once", async () => {
  const c = await setup();
  await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174119" });
  const reserved = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const end = Math.floor((c.now() + 30 * 86400000) / 1000);
  const invoice = c.event("evt_initial_older", "invoice.paid", { id: "in_initial_older", paid: true, status: "paid", billing_reason: "subscription_create", customer: "cus_initial_older", customer_email: "initial@example.com", subscription: "sub_initial_older", subscription_details: { metadata }, lines: { data: [{ period: { end }, price: { id: "price_bundle_month" } }] } });
  c.advance(2000);
  const checkout = c.event("evt_checkout_newer", "checkout.session.completed", { id: "cs_initial_older", mode: "subscription", payment_status: "paid", customer: "cus_initial_older", customer_details: { email: "initial@example.com" }, subscription: "sub_initial_older", metadata });
  assert.equal((await c.post(checkout)).body.outcome, "applied");
  const before = c.h.hub.billing.store.getCustomer("cus_initial_older");
  assert.equal(before.periodEndMs, null);
  const renewal = { ...invoice, id: "evt_old_renewal", data: { object: { ...invoice.data.object, billing_reason: "subscription_cycle" } } };
  assert.equal((await c.post(renewal)).body.outcome, "ignored", "old renewal cannot use the initial-term exception");
  assert.equal((await c.post(invoice)).body.outcome, "applied");
  const after = c.h.hub.billing.store.getCustomer("cus_initial_older");
  assert.equal(after.licenseId, before.licenseId);
  assert.equal(after.periodEndMs, end * 1000);
  assert.equal(c.h.hub.store.get(after.licenseId).exp, Math.min(end * 1000 + c.h.hub.billing.config().policy.graceDays * 86400000, before.createdAtMs + c.h.hub.billing.config().policy.testMaxDays * 86400000));
  assert.equal(c.h.hub.billing.store.getRoleSubscription("cus_initial_older", "hosting").periodEndMs, end * 1000);
  assert.equal(c.h.hub.billing.store.getBundleSubscription("sub_initial_older").latestEventCreatedMs, checkout.created * 1000);
  assert.equal((await c.post(invoice)).body.outcome, "duplicate");
  const second = { ...invoice, id: "evt_initial_paid_alias", type: "invoice.payment_succeeded" };
  assert.equal((await c.post(second)).body.outcome, "ignored", "second event does not repeat already-established term");
  await c.h.close();
});

// Recreate the entire service against the same durable files after an injected
// partial application, rather than proving only an in-memory retry.
for (const [failurePoint, fence] of [["hosting-write", null], ["hosting-hook", null], ["completion-write", null], ["hosting-write", "failure"], ["hosting-write", "cancellation"]]) {
  await test(`older initial invoice restart at ${failurePoint}, newer fence=${fence}`, async () => {
    const c = await setup();
    try {
      await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174120" });
      const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: c.h.hub.hosting.store.instances()[0].id };
      const end = Math.floor((c.now() + 30 * 86400000) / 1000);
      const invoice = c.event("evt_retry_initial", "invoice.paid", { id: "in_retry_initial", paid: true, billing_reason: "subscription_create", customer: "cus_retry", customer_email: "retry@example.com", subscription: "sub_retry", subscription_details: { metadata }, lines: { data: [{ period: { end }, price: { id: "price_bundle_month" } }] } });
      c.advance(2000);
      const checkout = c.event("evt_retry_checkout", "checkout.session.completed", { id: "cs_retry", mode: "subscription", payment_status: "paid", customer: "cus_retry", customer_details: { email: "retry@example.com" }, subscription: "sub_retry", metadata });
      assert.equal((await c.post(checkout)).body.outcome, "applied");
      const billing = c.h.hub.billing;
      if (failurePoint === "hosting-write") billing.store.putRoleSubscription = () => { throw Error("injected hosting write refusal"); };
      if (failurePoint === "hosting-hook") billing.onHostingEvent = () => { throw Error("injected hosting hook refusal"); };
      if (failurePoint === "completion-write") {
        const put = billing.store.putBundleSubscription.bind(billing.store);
        billing.store.putBundleSubscription = rec => { if (!rec.initialPaidPending) throw Error("injected completion refusal"); return put(rec); };
      }
      assert.equal((await c.post(invoice)).status, 500);
      const software = billing.store.getCustomer("cus_retry");
      assert.equal(software.periodEndMs, end * 1000);
      assert.ok(billing.store.getBundleSubscription("sub_retry").initialPaidPending);
      assert.equal(billing.store.seenEvent(invoice.id), false);
      const expiry = c.h.hub.store.get(software.licenseId).exp;
      await c.h.close();
      const restarted = createHub(c.h.cfg, { candleSleep: async () => {}, billingNow: c.now, hostingNow: c.now, hostingProvider: c.provider, billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }) });
      c.h.hub = restarted;
      c.h.close = () => restarted.close();
      c.h.origin = `http://127.0.0.1:${await restarted.listen()}`;
      let hookCalls = 0;
      const hook = restarted.billing.onHostingEvent.bind(restarted.billing);
      restarted.billing.onHostingEvent = (...args) => { hookCalls++; return hook(...args); };
      if (fence) {
        c.advance(2000);
        const later = fence === "failure"
          ? c.event("evt_new_failure", "invoice.payment_failed", { ...invoice.data.object, id: "in_failed_renewal", paid: false, billing_reason: "subscription_cycle" })
          : c.event("evt_new_cancellation", "customer.subscription.deleted", { id: "sub_retry", customer: "cus_retry", status: "canceled", metadata, items: { data: [{ price: { id: "price_bundle_month" } }] } });
        assert.equal((await c.post(later)).body.outcome, "applied");
        assert.equal((await c.post(invoice)).body.outcome, "ignored");
        assert.equal(restarted.billing.store.getCustomer("cus_retry").subscriptionStatus, fence === "failure" ? "past_due" : "canceled");
        assert.equal(restarted.billing.store.getRoleSubscription("cus_retry", "hosting").periodEndMs, null);
        return;
      }
      const altered = { ...invoice, data: { object: { ...invoice.data.object, amount_paid: 999999 } } };
      // Distinct event cannot borrow the durable admission.
      altered.id = "evt_unadmitted_alias";
      assert.equal((await c.post(altered)).body.outcome, "ignored");
      assert.equal((await c.post(invoice)).body.outcome, "applied");
      assert.equal(restarted.billing.store.getRoleSubscription("cus_retry", "hosting").periodEndMs, end * 1000);
      assert.equal(restarted.store.get(software.licenseId).exp, expiry);
      assert.equal(hookCalls, 1);
      assert.equal(restarted.billing.store.getBundleSubscription("sub_retry").initialPaidPending, undefined);
      assert.equal(restarted.billing.store.getBundleSubscription("sub_retry").latestEventCreatedMs, checkout.created * 1000);
      assert.equal((await c.post(invoice)).body.outcome, "duplicate");
      assert.equal(hookCalls, 1);
    } finally { await c.h.close(); }
  });
}

// Review additions (2026-10-09). The restart loop above proves one retry per
// interruption point. These pin what surrounds that admission: a protection
// event landing after a partial application, an exact redelivery that was
// applied but never marked seen, a newer renewal superseding the pending
// admission, and repeated refusals with an alias event in between.
async function olderInitialAfterCheckout(c, attemptSuffix, tag) {
  await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: `123e4567-e89b-12d3-a456-4266141741${attemptSuffix}` });
  const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: c.h.hub.hosting.store.instances()[0].id };
  const end = Math.floor((c.now() + 30 * 86400000) / 1000);
  const invoice = c.event(`evt_initial_${tag}`, "invoice.paid", { id: `in_${tag}`, paid: true, billing_reason: "subscription_create", amount_paid: 11900, customer: `cus_${tag}`, customer_email: `${tag}@example.com`, subscription: `sub_${tag}`, subscription_details: { metadata }, charge: `ch_${tag}`, payment_intent: `pi_${tag}`, lines: { data: [{ period: { end }, price: { id: "price_bundle_month" } }] } });
  c.advance(2000);
  const checkout = c.event(`evt_checkout_${tag}`, "checkout.session.completed", { id: `cs_${tag}`, mode: "subscription", payment_status: "paid", customer: `cus_${tag}`, customer_details: { email: `${tag}@example.com` }, subscription: `sub_${tag}`, metadata });
  assert.equal((await c.post(checkout)).body.outcome, "applied");
  return { end, invoice, checkout, key: `cus_${tag}`, sub: `sub_${tag}` };
}
const countHostingHook = (billing) => {
  const hook = billing.onHostingEvent.bind(billing);
  const counter = { calls: 0 };
  billing.onHostingEvent = (...args) => { counter.calls++; return hook(...args); };
  return counter;
};

for (const fence of ["refund", "dispute"]) {
  await test(`a ${fence} landing after a partially applied older initial invoice revokes and fences its retry`, async () => {
    const c = await setup();
    try {
      const { invoice, end, key, sub } = await olderInitialAfterCheckout(c, fence === "refund" ? "30" : "31", fence);
      const billing = c.h.hub.billing;
      const hook = billing.onHostingEvent.bind(billing);
      billing.onHostingEvent = () => { throw Error("injected hosting hook refusal"); };
      assert.equal((await c.post(invoice)).status, 500);
      billing.onHostingEvent = hook;
      const software = billing.store.getCustomer(key);
      assert.equal(software.periodEndMs, end * 1000);
      assert.equal(billing.store.getRoleSubscription(key, "hosting").periodEndMs, end * 1000, "the hosting record was written before its hook refused");
      assert.ok(billing.store.getBundleSubscription(sub).initialPaidPending);
      assert.equal(billing.store.seenEvent(invoice.id), false);
      c.advance(2000);
      const later = fence === "refund"
        ? c.event("evt_refund_after_pending", "charge.refunded", { id: `ch_${fence}`, customer: key, payment_intent: `pi_${fence}`, amount: 11900, amount_refunded: 11900, refunded: true })
        : c.event("evt_dispute_after_pending", "charge.dispute.created", { id: `dp_${fence}`, charge: `ch_${fence}`, payment_intent: `pi_${fence}`, reason: "fraudulent" });
      assert.equal((await c.post(later)).body.outcome, "applied");
      const flag = fence === "refund" ? "refunded" : "disputed";
      assert.equal(billing.store.getCustomer(key)[flag], true);
      assert.equal(billing.store.getRoleSubscription(key, "hosting")[flag], true);
      assert.equal(c.h.hub.store.isRevoked(software.licenseId), true);
      assert.equal(billing.store.getBundleSubscription(sub).initialPaidPending, undefined, "a newer protection event retires the pending admission");
      const counter = countHostingHook(billing);
      assert.equal((await c.post(invoice)).body.outcome, "ignored");
      assert.equal(counter.calls, 0, "the fenced retry never touches hosting");
      assert.equal(c.h.hub.store.isRevoked(software.licenseId), true);
      assert.equal(c.h.hub.store.get(software.licenseId), null, "the retry re-issues nothing");
      assert.equal(billing.store.getCustomer(key).licenseId, software.licenseId);
      assert.equal(billing.store.getCustomer(key)[flag], true);
      assert.equal((await c.post(invoice)).body.outcome, "duplicate");
    } finally { await c.h.close(); }
  });
}

await test("an older initial invoice applied once but never marked seen is inert on its exact redelivery", async () => {
  const c = await setup();
  try {
    const { invoice, end, key, sub, checkout } = await olderInitialAfterCheckout(c, "32", "unseen");
    const billing = c.h.hub.billing;
    const counter = countHostingHook(billing);
    // applyEvent directly: the first application completed every write and
    // the process died before markSeen, so the exact same event is delivered
    // again with no durable dedupe entry to answer it.
    const ev = parseStripeEvent(invoice);
    assert.equal((await billing.applyEvent(ev)).outcome, "applied");
    const software = billing.store.getCustomer(key);
    const exp = c.h.hub.store.get(software.licenseId).exp;
    assert.equal(software.periodEndMs, end * 1000);
    assert.equal(billing.store.getRoleSubscription(key, "hosting").periodEndMs, end * 1000);
    assert.equal(billing.store.getBundleSubscription(sub).initialPaidPending, undefined);
    assert.equal(counter.calls, 1);
    assert.equal(billing.store.seenEvent(invoice.id), false);
    assert.equal((await billing.applyEvent(ev)).outcome, "ignored", "the completed admission is gone; the stale guard refuses the second application");
    assert.equal((await c.post(invoice)).body.outcome, "ignored");
    assert.equal((await c.post(invoice)).body.outcome, "duplicate");
    assert.equal(c.h.hub.store.get(software.licenseId).exp, exp);
    assert.equal(billing.store.getCustomer(key).periodEndMs, end * 1000);
    assert.equal(billing.store.getRoleSubscription(key, "hosting").periodEndMs, end * 1000);
    assert.equal(billing.store.getBundleSubscription(sub).latestEventCreatedMs, checkout.created * 1000);
    assert.equal(counter.calls, 1);
  } finally { await c.h.close(); }
});

await test("a newer renewal supersedes a completion-interrupted older initial invoice; its retry adds nothing", async () => {
  const c = await setup();
  try {
    const { invoice, end, key, sub } = await olderInitialAfterCheckout(c, "33", "superseded");
    const billing = c.h.hub.billing;
    const put = billing.store.putBundleSubscription.bind(billing.store);
    billing.store.putBundleSubscription = rec => { if (!rec.initialPaidPending) throw Error("injected completion refusal"); return put(rec); };
    assert.equal((await c.post(invoice)).status, 500);
    billing.store.putBundleSubscription = put;
    const software = billing.store.getCustomer(key);
    assert.equal(software.periodEndMs, end * 1000);
    assert.equal(billing.store.getRoleSubscription(key, "hosting").periodEndMs, end * 1000);
    assert.ok(billing.store.getBundleSubscription(sub).initialPaidPending);
    const counter = countHostingHook(billing);
    c.advance(2000);
    const renewalEnd = end + 30 * 86400;
    const renewal = c.event("evt_renewal_supersedes", "invoice.paid", { ...invoice.data.object, id: "in_superseded_renewal", billing_reason: "subscription_cycle", charge: "ch_superseded_2", payment_intent: "pi_superseded_2", lines: { data: [{ period: { end: renewalEnd }, price: { id: "price_bundle_month" } }] } });
    assert.equal((await c.post(renewal)).body.outcome, "applied");
    assert.equal(billing.store.getCustomer(key).periodEndMs, renewalEnd * 1000);
    assert.equal(billing.store.getRoleSubscription(key, "hosting").periodEndMs, renewalEnd * 1000);
    assert.equal(billing.store.getBundleSubscription(sub).initialPaidPending, undefined, "the newer applied event retires the pending admission");
    assert.equal(billing.store.getBundleSubscription(sub).latestEventCreatedMs, renewal.created * 1000);
    assert.equal(counter.calls, 1);
    const exp = c.h.hub.store.get(software.licenseId).exp;
    assert.equal((await c.post(invoice)).body.outcome, "ignored");
    assert.equal(billing.store.getCustomer(key).periodEndMs, renewalEnd * 1000);
    assert.equal(billing.store.getRoleSubscription(key, "hosting").periodEndMs, renewalEnd * 1000);
    assert.equal(c.h.hub.store.get(software.licenseId).exp, exp);
    assert.equal(billing.store.getBundleSubscription(sub).latestEventCreatedMs, renewal.created * 1000, "the watermark never moves backwards");
    assert.equal(counter.calls, 1);
    assert.equal((await c.post(invoice)).body.outcome, "duplicate");
  } finally { await c.h.close(); }
});

await test("repeated hosting write refusals keep the exact admission; an alias event cannot borrow it; the next delivery completes once", async () => {
  const c = await setup();
  try {
    const { invoice, end, key, sub, checkout } = await olderInitialAfterCheckout(c, "34", "twice");
    const billing = c.h.hub.billing;
    const put = billing.store.putRoleSubscription.bind(billing.store);
    billing.store.putRoleSubscription = () => { throw Error("injected hosting write refusal"); };
    assert.equal((await c.post(invoice)).status, 500);
    const software = billing.store.getCustomer(key);
    const exp = c.h.hub.store.get(software.licenseId).exp;
    const pending = billing.store.getBundleSubscription(sub).initialPaidPending;
    assert.ok(pending);
    assert.equal((await c.post(invoice)).status, 500, "a second refusal is still a refusal");
    assert.deepEqual(billing.store.getBundleSubscription(sub).initialPaidPending, pending);
    assert.equal(c.h.hub.store.get(software.licenseId).exp, exp);
    assert.equal(billing.store.seenEvent(invoice.id), false);
    const alias = { ...invoice, id: "evt_alias_between_retries", type: "invoice.payment_succeeded" };
    assert.equal((await c.post(alias)).body.outcome, "ignored", "the payment_succeeded alias is a different event and cannot resume the admission");
    assert.deepEqual(billing.store.getBundleSubscription(sub).initialPaidPending, pending);
    assert.equal(billing.store.getRoleSubscription(key, "hosting").periodEndMs, null);
    billing.store.putRoleSubscription = put;
    const counter = countHostingHook(billing);
    assert.equal((await c.post(invoice)).body.outcome, "applied");
    assert.equal(billing.store.getRoleSubscription(key, "hosting").periodEndMs, end * 1000);
    assert.equal(billing.store.getCustomer(key).periodEndMs, end * 1000);
    assert.equal(c.h.hub.store.get(software.licenseId).exp, exp, "the completed retry extends nothing a second time");
    assert.equal(counter.calls, 1);
    assert.equal(billing.store.getBundleSubscription(sub).initialPaidPending, undefined);
    assert.equal(billing.store.getBundleSubscription(sub).latestEventCreatedMs, checkout.created * 1000);
    assert.equal((await c.post(invoice)).body.outcome, "duplicate");
    assert.equal((await c.post(alias)).body.outcome, "duplicate");
    assert.equal(counter.calls, 1);
  } finally { await c.h.close(); }
});

await test("checkout then initial paid invoice before the worker preserves one current provision job and one create", async () => {
  const c = await setup();
  await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174112" });
  const reserved = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const checkout = c.event("evt_order_checkout", "checkout.session.completed", { id: "cs_order", mode: "subscription", payment_status: "paid", customer: "cus_order", customer_details: { email: "order@example.com" }, subscription: "sub_order", metadata });
  assert.equal((await c.post(checkout)).body.outcome, "applied");
  let row = c.h.hub.hosting.store.getInstance(reserved.id);
  let provision = c.h.hub.hosting.store.outboxFor(row.id).filter((job) => job.jobType === "provision" && job.status === "pending");
  assert.equal(provision.length, 1);
  assert.equal(provision[0].lifecycleVersion, row.lifecycleVersion);

  const periodEnd = Math.floor((c.now() + 30 * 86400000) / 1000);
  const invoice = c.event("evt_order_invoice", "invoice.paid", { id: "in_order", paid: true, status: "paid", customer: "cus_order", customer_email: "order@example.com", subscription: "sub_order", subscription_details: { metadata }, lines: { data: [{ period: { end: periodEnd }, price: { id: "price_bundle_month" } }] }, charge: "ch_order" });
  assert.equal((await c.post(invoice)).body.outcome, "applied");
  row = c.h.hub.hosting.store.getInstance(reserved.id);
  assert.equal(row.stage, "ordered");
  assert.equal(row.paidThroughMs, periodEnd * 1000);
  assert.equal(row.suspendAtMs, null); assert.equal(row.deleteAtMs, null);
  provision = c.h.hub.hosting.store.outboxFor(row.id).filter((job) => job.jobType === "provision" && job.status === "pending");
  assert.equal(provision.length, 1, "invoice reconciliation neither obsoletes nor duplicates the current provision job");
  assert.equal(provision[0].lifecycleVersion, row.lifecycleVersion);
  assert.equal((await c.post(checkout)).body.outcome, "duplicate");
  assert.equal((await c.post(invoice)).body.outcome, "duplicate");

  await c.h.hub.hosting.tick(c.now());
  assert.equal(c.provider.createCalls.length, 1);
  row = c.h.hub.hosting.store.getInstance(reserved.id);
  assert.equal(row.stage, "bootstrapping");
  const readiness = c.h.hub.hosting.store.outboxFor(row.id).filter((job) => job.jobType === "readiness_recheck" && job.status === "pending");
  assert.equal(readiness.length, 1);
  const lifecycleAtBootstrap = row.lifecycleVersion;

  c.advance(1000);
  const renewalEnd = periodEnd + 30 * 86400;
  const renewal = c.event("evt_order_renewal", "invoice.paid", { id: "in_order_renewal", paid: true, status: "paid", customer: "cus_order", customer_email: "order@example.com", subscription: "sub_order", subscription_details: { metadata }, lines: { data: [{ period: { end: renewalEnd }, price: { id: "price_bundle_month" } }] }, charge: "ch_order_renewal" });
  assert.equal((await c.post(renewal)).body.outcome, "applied");
  row = c.h.hub.hosting.store.getInstance(reserved.id);
  assert.equal(row.lifecycleVersion, lifecycleAtBootstrap, "paid-through alone does not invalidate bootstrap operations");
  assert.equal(c.h.hub.hosting.store.outboxFor(row.id).filter((job) => job.jobType === "readiness_recheck" && job.status === "pending").length, 1);
  await c.h.hub.hosting.tick(c.now());
  assert.equal(c.provider.createCalls.length, 1, "repeat reconciliation never creates a second VPS");
  await c.h.close();
});

await test("an initial paid invoice during the provider create does not obsolete the in-flight job or create twice", async () => {
  const c = await setup();
  await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174114" });
  const reserved = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "monthly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const checkout = c.event("evt_inflight_checkout", "checkout.session.completed", { id: "cs_inflight", mode: "subscription", payment_status: "paid", customer: "cus_inflight", customer_details: { email: "inflight@example.com" }, subscription: "sub_inflight", metadata });
  assert.equal((await c.post(checkout)).body.outcome, "applied");

  const realCreate = c.provider.createInstance.bind(c.provider);
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  let enteredCreate;
  const entered = new Promise((resolve) => { enteredCreate = resolve; });
  c.provider.createInstance = async (request) => { enteredCreate(); await createGate; return realCreate(request); };
  const tick = c.h.hub.hosting.tick(c.now());
  await entered;
  let row = c.h.hub.hosting.store.getInstance(reserved.id);
  assert.equal(row.stage, "provisioning");
  const lifecycleDuringCreate = row.lifecycleVersion;

  const periodEnd = Math.floor((c.now() + 30 * 86400000) / 1000);
  const invoice = c.event("evt_inflight_invoice", "invoice.paid", { id: "in_inflight", paid: true, status: "paid", customer: "cus_inflight", customer_email: "inflight@example.com", subscription: "sub_inflight", subscription_details: { metadata }, lines: { data: [{ period: { end: periodEnd }, price: { id: "price_bundle_month" } }] }, charge: "ch_inflight" });
  assert.equal((await c.post(invoice)).body.outcome, "applied");
  row = c.h.hub.hosting.store.getInstance(reserved.id);
  assert.equal(row.lifecycleVersion, lifecycleDuringCreate);
  assert.equal(row.paidThroughMs, periodEnd * 1000);

  releaseCreate();
  await tick;
  assert.equal(c.provider.createCalls.length, 1);
  assert.equal(c.h.hub.hosting.store.getInstance(reserved.id).stage, "bootstrapping");
  await c.h.hub.hosting.tick(c.now());
  assert.equal(c.provider.createCalls.length, 1, "a later reconcile finds the durable provider id and never creates again");
  await c.h.close();
});

await test("initial paid invoice before checkout completion converges to one create and later paid-through preserves a ready email", async () => {
  const c = await setup();
  await legacyCheckout(c, { plan: "yearly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174113" });
  const reserved = c.h.hub.hosting.store.instances()[0];
  const metadata = { plan: "yearly-hosted", bundle: "software-hosting-v1", reservation: reserved.id };
  const periodEnd = Math.floor((c.now() + 365 * 86400000) / 1000);
  const invoice = c.event("evt_reverse_invoice", "invoice.paid", { id: "in_reverse", paid: true, status: "paid", customer: "cus_reverse", customer_email: "reverse@example.com", subscription: "sub_reverse", subscription_details: { metadata }, lines: { data: [{ period: { end: periodEnd }, price: { id: "price_bundle_year" } }] }, charge: "ch_reverse" });
  assert.equal((await c.post(invoice)).body.outcome, "applied");
  const checkout = c.event("evt_reverse_checkout", "checkout.session.completed", { id: "cs_reverse", mode: "subscription", payment_status: "paid", customer: "cus_reverse", customer_details: { email: "reverse@example.com" }, subscription: "sub_reverse", metadata });
  assert.equal((await c.post(checkout)).body.outcome, "applied");
  let row = c.h.hub.hosting.store.getInstance(reserved.id);
  assert.equal(row.paidThroughMs, periodEnd * 1000);
  assert.equal(c.h.hub.hosting.store.outboxFor(row.id).filter((job) => job.jobType === "provision" && job.status === "pending" && job.lifecycleVersion === row.lifecycleVersion).length, 1);
  await c.h.hub.hosting.tick(c.now());
  assert.equal(c.provider.createCalls.length, 1);

  row = c.h.hub.hosting.store.getInstance(reserved.id);
  row = c.h.hub.hosting.store.updateInstance(row.id, row.version, (draft) => { draft.stage = "ready"; }, c.now());
  c.h.hub.hosting.store.enqueue({ hostingInstanceId: row.id, lifecycleVersion: row.lifecycleVersion, generation: row.generation, jobType: "email", dedupeKey: `email:installation_ready:test:${row.id}`, availableAtMs: c.now() + 60_000, payload: { template: "installation_ready" } }, c.now());
  const readyLifecycle = row.lifecycleVersion;
  c.advance(1000);
  const renewalEnd = periodEnd + 365 * 86400;
  const renewal = c.event("evt_reverse_renewal", "invoice.paid", { id: "in_reverse_renewal", paid: true, status: "paid", customer: "cus_reverse", customer_email: "reverse@example.com", subscription: "sub_reverse", subscription_details: { metadata }, lines: { data: [{ period: { end: renewalEnd }, price: { id: "price_bundle_year" } }] }, charge: "ch_reverse_renewal" });
  assert.equal((await c.post(renewal)).body.outcome, "applied");
  row = c.h.hub.hosting.store.getInstance(reserved.id);
  assert.equal(row.lifecycleVersion, readyLifecycle);
  assert.equal(c.h.hub.hosting.store.outboxFor(row.id).filter((job) => job.jobType === "email" && job.status === "pending" && job.payload.template === "installation_ready").length, 1, "paid-through alone does not obsolete a ready email");
  assert.equal(c.provider.createCalls.length, 1);
  assert.equal((await c.post(invoice)).body.outcome, "duplicate");
  assert.equal((await c.post(checkout)).body.outcome, "duplicate");
  await c.h.close();
});

await test("a paid bundle invoice arriving before Checkout completion converges without another licence or VPS", async () => {
  const c = await setup();
  await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174222" });
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
  await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174333" });
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
  await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174444" });
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
  await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174555" });
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
  await legacyCheckout(c, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174666" });
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
  await legacyCheckout(activeFirst, { plan: "monthly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174777" });
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
  await legacyCheckout(failedFirst, { plan: "yearly", checkoutAttemptId: "123e4567-e89b-12d3-a456-426614174778" });
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
