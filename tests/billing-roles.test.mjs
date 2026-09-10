// tests/billing-roles.test.mjs — H1: billing-role isolation before a second
// (hosting) Stripe subscription exists. See src/billing/roles.ts's header for
// the whole design and src/billing/service.ts's dispatcher for the wiring.
//
// Section 1 is the DRIVEN REPRODUCTION of the pre-dispatcher defect, run
// against the CURRENT (fixed) code so it stands as a permanent regression
// pin: with no hosting allowlist configured, every event is still classified
// "software" (day-1 backward compatibility — this Hub has never sold a
// second product, so nothing changes for an install that has not configured
// one). Section 2 configures a hosting allowlist — the operator's actual
// deployment step once hosting exists — and re-runs the IDENTICAL scenario
// to prove the isolation now holds. Every later section drives one of the
// H1 acceptance cases named in the handoff.
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { signStripePayload } from "../dist/src/billing/stripe.js";
import { classifyRole } from "../dist/src/billing/roles.js";
import { applyBillingPatch, defaultBillingConfig, BillingConfigError } from "../dist/src/billing/config.js";

const DAY = 86_400_000;
const TEST_WHSEC = "whsec_test_roles_0123456789";
const LIVE_WHSEC = "whsec_live_roles_fedcba9876";

let clock = Math.floor(Date.now() / 1000) * 1000;
const h = await freshHub({}, { billingFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }), billingNow: () => clock });
const admin = (p, opts = {}) => jsonReq(`${h.origin}${p}`, { ...opts, headers: { "x-hub-admin": "test-admin-token", "content-type": "application/json", ...(opts.headers ?? {}) } });

await admin("/admin/api/billing/config", {
  method: "POST",
  body: JSON.stringify({ stripe: { test: { webhookSecret: TEST_WHSEC }, live: { webhookSecret: LIVE_WHSEC } } }),
});

let evSeq = 0;
const sec = () => Math.floor(clock / 1000);
const event = (type, object, livemode = false, id = `evt_${++evSeq}`) => ({ id, object: "event", type, livemode, created: sec(), data: { object } });
async function postEvent(mode, ev, secret = mode === "live" ? LIVE_WHSEC : TEST_WHSEC) {
  const body = JSON.stringify(ev);
  const res = await fetch(`${h.origin}/api/billing/stripe/${mode}`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signStripePayload(body, secret, sec()) },
    body,
  });
  return { status: res.status, body: await res.json() };
}
const licenses = () => h.store.list();
const swRec = (key) => h.hub.billing.store.getCustomer(key);
const hostRec = (key) => h.hub.billing.store.getRoleSubscription(key, "hosting");

// ── pure: classifyRole ───────────────────────────────────────────────────────

await test("classifyRole: id membership, ambiguity, the empty-hosting default, and the plan-catalogue binding aid", () => {
  const cfg = {
    software: { priceIds: ["price_sw1"], productIds: ["prod_sw1"] },
    hosting: { priceIds: ["price_host1"], productIds: [] },
  };
  assert.equal(classifyRole({ priceIds: ["price_sw1"], productIds: [], planRole: null }, cfg), "software");
  assert.equal(classifyRole({ priceIds: [], productIds: ["prod_sw1"], planRole: null }, cfg), "software");
  assert.equal(classifyRole({ priceIds: ["price_host1"], productIds: [], planRole: null }, cfg), "hosting");
  // an id on both lists at once is a misconfiguration, never a guess:
  assert.equal(classifyRole({ priceIds: ["price_sw1", "price_host1"], productIds: [], planRole: null }, cfg), "unknown");
  // no match, hosting IS configured, no binding aid -> unknown, never software:
  assert.equal(classifyRole({ priceIds: ["price_other"], productIds: [], planRole: null }, cfg), "unknown");
  // no match, hosting IS configured, the binding aid resolves it:
  assert.equal(classifyRole({ priceIds: [], productIds: [], planRole: "hosting" }, cfg), "hosting");
  // an id match always outranks the binding aid, even a contradicting one:
  assert.equal(classifyRole({ priceIds: ["price_sw1"], productIds: [], planRole: "hosting" }, cfg), "software");
  const emptyHosting = { software: { priceIds: [], productIds: [] }, hosting: { priceIds: [], productIds: [] } };
  // hosting has NEVER been configured on this Hub: the pre-dispatcher default.
  assert.equal(classifyRole({ priceIds: ["price_anything"], productIds: [], planRole: null }, emptyHosting), "software");
  assert.equal(classifyRole({ priceIds: [], productIds: [], planRole: null }, emptyHosting), "software");
});

// ── config: role allowlists are validated and kept apart per mode ──────────

await test("config: role ids are validated, an id on both lists is refused, test/live never merge", () => {
  const base = defaultBillingConfig();
  assert.deepEqual(base.roles.test, { software: { priceIds: [], productIds: [] }, hosting: { priceIds: [], productIds: [] } });
  assert.throws(() => applyBillingPatch(base, { roles: { test: { hosting: { priceIds: ["not-a-price-id"] } } } }), BillingConfigError);
  assert.throws(
    () => applyBillingPatch(base, { roles: { test: { software: { priceIds: ["price_x1"] }, hosting: { priceIds: ["price_x1"] } } } }),
    /both software and hosting/,
  );
  const patched = applyBillingPatch(base, {
    roles: {
      test: { software: { priceIds: ["price_sw_test1"] }, hosting: { priceIds: ["price_host_test1"], productIds: ["prod_host_test1"] } },
      live: { hosting: { priceIds: ["price_host_live1"] } },
    },
  });
  assert.deepEqual(patched.roles.test.software.priceIds, ["price_sw_test1"]);
  assert.deepEqual(patched.roles.test.hosting.priceIds, ["price_host_test1"]);
  assert.deepEqual(patched.roles.live.hosting.priceIds, ["price_host_live1"]);
  assert.deepEqual(patched.roles.live.software, { priceIds: [], productIds: [] }, "a test-mode id must never leak into the live allowlist");
});

// ── the driven reproduction, and its inversion ──────────────────────────────

const SW_PRICE = "price_software_monthly";
const SW_PRODUCT = "prod_software";
const HOST_PRICE = "price_hosting_monthly";
const HOST_PRODUCT = "prod_hosting";

await test("setup: a software subscription is bought and paid", async () => {
  await postEvent("test", event("checkout.session.completed", {
    id: "cs_sw", object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
    customer: "cus_shared", customer_details: { email: "zack@example.com", name: "Zack" }, subscription: "sub_software",
    payment_intent: null, metadata: { plan: "monthly" },
  }));
  await postEvent("test", event("invoice.paid", {
    id: "in_sw_1", object: "invoice", customer: "cus_shared", customer_email: "zack@example.com", customer_name: "Zack",
    subscription: "sub_software", charge: "ch_sw_1", payment_intent: "pi_sw_1", paid: true, status: "paid",
    billing_reason: "subscription_create", lines: { data: [{ period: { start: sec(), end: sec() + 30 * 86_400 }, price: { id: SW_PRICE, product: SW_PRODUCT } }] },
  }));
  const rec = swRec("cus_shared");
  assert.equal(rec.subscriptionId, "sub_software");
  assert.equal(rec.subscriptionStatus, "active");
  assert.equal(rec.periodEndMs, sec() * 1000 + 30 * DAY);
});

await test("SECTION 1 (day-1 default, no hosting allowlist configured yet): a second subscription on the same customer is STILL classified software — this Hub has never sold anything else, and the pin proves nothing regresses for an install that never configures hosting", async () => {
  clock += 7 * DAY;
  const before = swRec("cus_shared");
  await postEvent("test", event("customer.subscription.updated", {
    id: "sub_hosting", object: "subscription", customer: "cus_shared", status: "active", cancel_at_period_end: false,
    items: { data: [{ current_period_end: sec() + 30 * 86_400 }] }, // no `price` — an id-less object, as some really are
  }));
  const after = swRec("cus_shared");
  assert.equal(after.subscriptionId, "sub_hosting", "documented day-1 behaviour: unmatched ids default to software while hosting is unconfigured");
  assert.notEqual(after.subscriptionId, before.subscriptionId);
});

await test("the operator configures the hosting allowlist AND registers a hosting plan (the real deployment step once hosting exists)", async () => {
  // The price/product allowlist is authoritative for invoice/subscription
  // events (they carry ids inline). checkout.session.completed carries NO
  // price/product id in its webhook payload at all — Stripe never sends
  // line items on that event — so its ONLY signal is \`metadata.plan\`,
  // joined against the Hub's OWN plan catalogue (the "binding aid",
  // roles.ts). That means checkout-time attribution for a product this Hub
  // did not mint itself (through \`plans\` + \`provisionPlans\`, exactly as
  // software already works) resolves to "unknown", fail-closed, until it
  // is registered here too — reusing the Hub's existing plan machinery
  // rather than inventing a second one is the whole reason \`Plan.role\`
  // exists. A future increment that fetches the checkout's line items (or
  // subscription) via the Stripe API for authoritative checkout-time
  // classification is a known gap, noted in the report, not built here.
  const before = (await admin("/admin/api/billing/config")).body;
  const plans = [...before.plans, { key: "hosting", name: "Hosting", amountCents: 1500, currency: "usd", interval: "month", licenseDays: null, lifetime: false, description: "VPS hosting.", role: "hosting" }];
  const r = await admin("/admin/api/billing/config", {
    method: "POST",
    body: JSON.stringify({
      plans,
      roles: { test: {
        software: { priceIds: [SW_PRICE], productIds: [SW_PRODUCT] },
        hosting: { priceIds: [HOST_PRICE], productIds: [HOST_PRODUCT] },
      } },
    }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.roles.test.hosting.priceIds, [HOST_PRICE]);
  assert.equal(r.body.plans.find((p) => p.key === "hosting")?.role, "hosting");
});

await test("re-establish a clean software baseline now that hosting is configured", async () => {
  // The previous section's mis-set subscriptionId (day-1 default) is exactly
  // what an operator's real `customer.subscription.updated` for the ACTUAL
  // software subscription would correct on its own next delivery — proven
  // here with a software-priced update, so the rest of this suite starts
  // from a known-good software record.
  await postEvent("test", event("customer.subscription.updated", {
    id: "sub_software", object: "subscription", customer: "cus_shared", status: "active", cancel_at_period_end: false,
    items: { data: [{ current_period_end: sec() + 30 * 86_400, price: { id: SW_PRICE, product: SW_PRODUCT } }] },
  }));
  assert.equal(swRec("cus_shared").subscriptionId, "sub_software");
});

let hostingSubscriptionId = "sub_hosting_2";
await test("SECTION 2 (FIXED), part A — no duplicate software subscription: a hosting checkout on an already-licensed customer mints no second licence and leaves the software record untouched", async () => {
  const beforeLicenses = licenses().length;
  const before = { ...swRec("cus_shared") };
  const r = await postEvent("test", event("checkout.session.completed", {
    id: "cs_host", object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
    customer: "cus_shared", customer_details: { email: "zack@example.com", name: "Zack" }, subscription: hostingSubscriptionId,
    payment_intent: null, metadata: { plan: "hosting" },
  }));
  assert.equal(r.body.outcome, "applied", JSON.stringify(r.body));
  assert.equal(licenses().length, beforeLicenses, "ensureCustomer (the software minting path) was never called for the hosting checkout");
  assert.deepEqual(swRec("cus_shared"), before, "THE FIX: a hosting checkout leaves the software CustomerRecord byte-for-byte unchanged");
  const hosting = hostRec("cus_shared");
  assert.ok(hosting, "a hosting record now exists, coexisting with the software one");
  assert.equal(hosting.subscriptionId, hostingSubscriptionId);
});

await test("SECTION 2 (FIXED), part B: a hosting subscription.updated event leaves the software record untouched", async () => {
  const before = { ...swRec("cus_shared") };
  const r = await postEvent("test", event("customer.subscription.updated", {
    id: hostingSubscriptionId, object: "subscription", customer: "cus_shared", status: "active", cancel_at_period_end: false,
    items: { data: [{ current_period_end: sec() + 30 * 86_400, price: { id: HOST_PRICE, product: HOST_PRODUCT } }] },
  }));
  assert.equal(r.body.outcome, "applied");
  const after = swRec("cus_shared");
  assert.deepEqual(after, before, "THE FIX: a hosting subscription event leaves the software CustomerRecord byte-for-byte unchanged");
  assert.equal(hostRec("cus_shared").subscriptionStatus, "active");
});

await test("cross-product invoice isolation: an invoice priced ENTIRELY in hosting lines never moves the software paid-through date", async () => {
  const swBefore = swRec("cus_shared").periodEndMs;
  const r = await postEvent("test", event("invoice.paid", {
    id: "in_host_1", object: "invoice", customer: "cus_shared", customer_email: "zack@example.com", customer_name: "Zack",
    subscription: hostingSubscriptionId, charge: "ch_host_1", payment_intent: "pi_host_1", paid: true, status: "paid",
    billing_reason: "subscription_cycle", lines: { data: [{ period: { start: sec(), end: sec() + 30 * 86_400 }, price: { id: HOST_PRICE, product: HOST_PRODUCT } }] },
  }));
  assert.equal(r.body.outcome, "applied");
  assert.equal(swRec("cus_shared").periodEndMs, swBefore, "the software paid-through date is untouched by a hosting-only invoice");
  const hosting = hostRec("cus_shared");
  assert.equal(hosting.periodEndMs, sec() * 1000 + 30 * DAY);
  assert.ok(hosting.chargeIds.includes("ch_host_1"));
});

await test("REPRODUCED DEFECT, NOW FIXED: a payment failure on hosting never marks the software subscription past_due", async () => {
  await postEvent("test", event("invoice.payment_failed", {
    id: "in_host_2", object: "invoice", customer: "cus_shared", customer_email: "zack@example.com", customer_name: "Zack",
    subscription: hostingSubscriptionId, charge: "", payment_intent: "", paid: false, status: "open",
    billing_reason: "subscription_cycle", lines: { data: [{ period: { start: sec(), end: sec() + 30 * 86_400 }, price: { id: HOST_PRICE, product: HOST_PRODUCT } }] },
  }));
  assert.equal(swRec("cus_shared").subscriptionStatus, "active", "software status is untouched by a hosting payment failure");
  assert.equal(hostRec("cus_shared").subscriptionStatus, "past_due");
});

await test("REPRODUCED DEFECT, NOW FIXED: a full refund on the hosting charge never revokes the software licence", async () => {
  const licenseId = swRec("cus_shared").licenseId;
  const licenseRow = () => licenses().find((l) => l.id === licenseId);
  assert.equal(licenseRow().revoked, false, "software licence is still valid before the hosting refund");
  const r = await postEvent("test", event("charge.refunded", {
    id: "ch_host_1", object: "charge", customer: "cus_shared", payment_intent: "pi_host_1",
    billing_details: { email: "zack@example.com" }, amount: 1500, amount_refunded: 1500, refunded: true,
  }));
  assert.equal(r.body.outcome, "applied");
  assert.equal(licenseRow().revoked, false, "THE FIX: the hosting refund does not touch the software licence");
  assert.equal(hostRec("cus_shared").refunded, true, "the hosting record itself DOES see the refund");
});

await test("REPRODUCED DEFECT, NOW FIXED: a hosting dispute never revokes the software licence", async () => {
  const licenseId = swRec("cus_shared").licenseId;
  const licenseRow = () => licenses().find((l) => l.id === licenseId);
  const r = await postEvent("test", event("charge.dispute.created", {
    id: "dp_host_1", object: "dispute", charge: "ch_host_1", payment_intent: "pi_host_1", reason: "fraudulent", status: "needs_response",
  }));
  assert.equal(r.body.outcome, "applied");
  assert.equal(licenseRow().revoked, false, "the software licence survives a hosting dispute");
  assert.equal(hostRec("cus_shared").disputed, true);
});

await test("a SOFTWARE charge's refund still revokes the software licence exactly as before (the isolation cuts both ways, it does not disable revocation)", async () => {
  const licenseId = swRec("cus_shared").licenseId;
  const licenseRow = () => licenses().find((l) => l.id === licenseId);
  assert.equal(licenseRow().revoked, false);
  const r = await postEvent("test", event("charge.refunded", {
    id: "ch_sw_1", object: "charge", customer: "cus_shared", payment_intent: "pi_sw_1",
    billing_details: { email: "zack@example.com" }, amount: 9900, amount_refunded: 9900, refunded: true,
  }));
  assert.equal(r.body.outcome, "applied");
  assert.equal(licenseRow().revoked, true, "a full refund on the SOFTWARE charge still revokes, unchanged");
});

// ── the "unknown" branch: an unrecognised product on a configured Hub ──────

await test("unclassified: an id matching neither allowlist is recorded and applied to NEITHER role, once hosting is configured", async () => {
  const r = await postEvent("test", event("invoice.paid", {
    id: "in_third_1", object: "invoice", customer: "cus_third", customer_email: "third@example.com", customer_name: "Third Party",
    subscription: "sub_third", charge: "ch_third_1", payment_intent: "pi_third_1", paid: true, status: "paid",
    billing_reason: "subscription_create", lines: { data: [{ period: { start: sec(), end: sec() + 30 * 86_400 }, price: { id: "price_unrelated_thing", product: "prod_unrelated_thing" } }] },
  }));
  assert.equal(r.body.outcome, "unclassified");
  assert.equal(swRec("cus_third"), null, "no software licence was minted for the unclassified event");
  assert.equal(hostRec("cus_third"), null, "no hosting record was created either");
  const ev = (await admin("/admin/api/billing/events?limit=1")).body.events[0];
  assert.equal(ev.outcome, "unclassified");
});

await test("test/live isolation: a live-mode event naming an id configured only for TEST's hosting allowlist gets no hosting credit for it", async () => {
  await admin("/admin/api/billing/config", { method: "POST", body: JSON.stringify({ stripe: { live: { webhookSecret: LIVE_WHSEC } } }) });
  const r = await postEvent("live", event("customer.subscription.updated", {
    id: "sub_live_x", object: "subscription", customer: "cus_live_x", status: "active", cancel_at_period_end: false,
    items: { data: [{ current_period_end: sec() + 30 * 86_400, price: { id: HOST_PRICE, product: HOST_PRODUCT } }] }, // the TEST hosting price id
  }, true));
  // LIVE mode has its own (still-empty) hosting allowlist, so the LIVE
  // day-1 default still applies here: the event is classified SOFTWARE (not
  // hosting, despite naming the TEST-mode hosting price id) and then
  // "ignored" by the ordinary software handler for the same reason it always
  // has been — a subscription.updated for a customer nobody has seen yet.
  assert.equal(r.body.outcome, "ignored", JSON.stringify(r.body));
  assert.equal(hostRec("cus_live_x"), null, "the TEST-mode hosting price id did not grant hosting in LIVE mode");
  assert.equal(swRec("cus_live_x"), null, "and nothing was minted for it as software either — subscription.updated never creates a customer");
});

// ── the role index: object ids resolve without a fetch, and disagreement is refused ──

await test("crash-recovery idempotency: the SAME event id re-delivered is a duplicate, never re-applied", async () => {
  const first = await postEvent("test", event("invoice.paid", {
    id: "in_dup_1", object: "invoice", customer: "cus_dup", customer_email: "dup@example.com", customer_name: "Dup",
    subscription: "sub_dup", charge: "ch_dup_1", payment_intent: "pi_dup_1", paid: true, status: "paid",
    billing_reason: "subscription_create", lines: { data: [{ period: { start: sec(), end: sec() + 30 * 86_400 }, price: { id: HOST_PRICE, product: HOST_PRODUCT } }] },
  }, false, "evt_fixed_dup"));
  assert.equal(first.body.outcome, "applied");
  const before = { ...hostRec("cus_dup") };
  const again = await fetch(`${h.origin}/api/billing/stripe/test`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signStripePayload(JSON.stringify(event("invoice.paid", {
      id: "in_dup_1", object: "invoice", customer: "cus_dup", customer_email: "dup@example.com", customer_name: "Dup",
      subscription: "sub_dup", charge: "ch_dup_1", payment_intent: "pi_dup_1", paid: true, status: "paid",
      billing_reason: "subscription_create", lines: { data: [{ period: { start: sec(), end: sec() + 30 * 86_400 }, price: { id: HOST_PRICE, product: HOST_PRODUCT } }] },
    }, false, "evt_fixed_dup")), TEST_WHSEC, sec()) },
    body: JSON.stringify(event("invoice.paid", {
      id: "in_dup_1", object: "invoice", customer: "cus_dup", customer_email: "dup@example.com", customer_name: "Dup",
      subscription: "sub_dup", charge: "ch_dup_1", payment_intent: "pi_dup_1", paid: true, status: "paid",
      billing_reason: "subscription_create", lines: { data: [{ period: { start: sec(), end: sec() + 30 * 86_400 }, price: { id: HOST_PRICE, product: HOST_PRODUCT } }] },
    }, false, "evt_fixed_dup")),
  });
  assert.equal((await again.json()).outcome, "duplicate");
  assert.deepEqual(hostRec("cus_dup"), before, "a re-delivered event id changes nothing the second time");
});

await test("a role-index conflict downgrades the event to unclassified, touches neither role, and is still marked seen (a definitive verdict, not a transient failure Stripe should retry)", async () => {
  // Manufacture a disagreement: one object id is already indexed "software"
  // (from an earlier legitimate event); a LATER event whose ids happen to
  // include that same id but classifies fresh as "hosting" must refuse
  // rather than silently relabel it.
  const store = h.hub.billing.store;
  assert.equal(store.noteRole("sub_conflict", "software", clock), true);
  const evId = "evt_conflict_1";
  const r = await postEvent("test", event("customer.subscription.updated", {
    id: "sub_conflict", object: "subscription", customer: "cus_conflict", status: "active", cancel_at_period_end: false,
    items: { data: [{ current_period_end: sec() + 30 * 86_400, price: { id: HOST_PRICE, product: HOST_PRODUCT } }] },
  }, false, evId));
  assert.equal(r.body.outcome, "unclassified", "an id disagreeing with its own recorded role is never silently relabelled");
  assert.equal(hostRec("cus_conflict"), null, "nothing was written for the conflicting event");
  assert.equal(swRec("cus_conflict"), null, "and nothing was written to software either");
  assert.equal(store.seenEvent(evId), true, "unclassified is a decided verdict — re-delivery of the SAME event id is a plain duplicate, exactly like an applied or ignored one");
});

// ── migration: a pre-dispatcher customer file is folded into the role index ─

await test("migration: an existing (pre-dispatcher) customer's subscription and charges are indexed as software, one-shot and marker-guarded", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { LicenseStore, generateSigningKey } = await import("../dist/src/license.js");
  const os = await import("node:os");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wickhub-legacy-"));
  const lic = new LicenseStore(dataDir);
  lic.writeKey(generateSigningKey().privatePem);
  const issued = lic.issueUntil("Legacy Customer", Date.now() + 30 * DAY, "unleashed", Date.now());
  fs.writeFileSync(path.join(dataDir, "billing-customers.v1.json"), JSON.stringify({
    cus_legacy: {
      key: "cus_legacy", stripeCustomerId: "cus_legacy", email: "legacy@example.com", name: "Legacy Customer",
      livemode: true, licenseId: issued.payload.id, planKey: "monthly", subscriptionId: "sub_legacy",
      subscriptionStatus: "active", periodEndMs: Date.now() + 30 * DAY, chargeIds: ["ch_legacy_1", "ch_legacy_2"],
      createdAtMs: Date.now(), updatedAtMs: Date.now(), welcomeSentAtMs: null, welcomeError: null,
      disputed: false, refunded: false, lastEventType: null, lastEventAtMs: null,
    },
  }, null, 2));
  const { BillingService } = await import("../dist/src/billing/service.js");
  const svc = new BillingService(dataDir, lic, "https://hub.test", h.cfg.templatesDir, { now: () => clock });
  assert.equal(svc.store.roleFor("sub_legacy"), "software");
  assert.equal(svc.store.roleFor("ch_legacy_1"), "software");
  assert.equal(svc.store.roleFor("ch_legacy_2"), "software");
  assert.ok(fs.existsSync(path.join(dataDir, "billing-role-migration.v1.json")), "the marker is written so this never re-scans on every boot");
  // one-shot: manually poison the index the migration WOULD have written,
  // then re-construct — with the marker present, migration must not re-run
  // and clobber a role an operator has since reassigned.
  fs.rmSync(path.join(dataDir, "billing-role-index.v1.json"));
  fs.writeFileSync(path.join(dataDir, "billing-role-index.v1.json"), JSON.stringify({ sub_legacy: { role: "hosting", atMs: Date.now() } }));
  const svc2 = new BillingService(dataDir, lic, "https://hub.test", h.cfg.templatesDir, { now: () => clock });
  assert.equal(svc2.store.roleFor("sub_legacy"), "hosting", "the marker prevented a second migration pass from overwriting the reassigned role");
});

await h.close();
summary("billing-roles");
