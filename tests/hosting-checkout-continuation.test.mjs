import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { freshHub, test, summary } from './helpers.mjs';
import { FakeProvider } from '../dist/src/hosting/provider.js';
import { signStripePayload } from '../dist/src/billing/stripe.js';

const clock = Date.parse('2026-10-04T12:00:00Z');
const secret = 'whsec_offline_continuation_test';
const sessions = new Map();
const hostingRequests = [];
let priceMismatch = false;
const fixture = await freshHub({ publicOrigin: 'https://hub.example.test' }, {
  billingNow: () => clock, hostingNow: () => clock,
  billingFetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  launchFetch: async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname.startsWith('/v1/prices/')) {
      const key = pathname.split('price_')[1];
      return new Response(JSON.stringify({ id: `price_${key}`, active: true, unit_amount: { monthly: 9900, yearly: 69900, lifetime: 99900 }[key], currency: 'usd', product: 'prod_software', recurring: key === 'lifetime' ? null : { interval: key === 'yearly' ? 'year' : 'month', interval_count: 1 } }));
    }
    if (pathname === '/v1/account') return new Response(JSON.stringify({ capabilities: { crypto_payments: 'active' } }));
    if (pathname === '/v1/checkout/sessions') {
      const params = new URLSearchParams(init.body);
      const id = `cs_test_${sessions.size + 1}`;
      const metadata = Object.fromEntries([...params].filter(([k]) => k.startsWith('metadata[')).map(([k,v]) => [k.slice(9,-1),v]));
      const session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get('mode'), livemode: false, metadata, client_reference_id: params.get('client_reference_id'), status: 'open', payment_status: 'unpaid' };
      sessions.set(id, { session, params });
      return new Response(JSON.stringify(session));
    }
    const stored = sessions.get(pathname.split('/').at(-1));
    assert(stored, `Unexpected Stripe request ${pathname}`);
    return new Response(JSON.stringify(stored.session));
  },
  hostingProvider: new FakeProvider({ now: () => clock }),
  hostingFetch: async (url, init) => {
    if (url.includes('/v1/prices/')) return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'price_hosting', active: true, unit_amount: priceMismatch ? 1500 : 2000, currency: 'usd', type: 'recurring', recurring: { interval: 'month', interval_count: 1 } }) };
    assert(url.endsWith('/v1/checkout/sessions'));
    hostingRequests.push(new URLSearchParams(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/hosting_20_monthly' }) };
  }
});
const post = async (path, body, admin = false) => {
  const response = await fetch(fixture.origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(admin ? { 'x-hub-admin': 'test-admin-token' } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
try {
  fixture.hub.billing.updateConfig({ stripe: { test: { secretKey: 'sk_test_offline_fixture', webhookSecret: secret, priceIds: { monthly: 'price_monthly', yearly: 'price_yearly', lifetime: 'price_lifetime' } } }, roles: { test: { hosting: { priceIds: ['price_hosting'] } } } });
  fixture.hub.billing.updateConfig({ plans: [...fixture.hub.billing.config().plans, { key: 'hosting-monthly', name: 'VPS hosting', amountCents: 2000, currency: 'usd', interval: 'month', licenseDays: null, lifetime: false, role: 'hosting', checkout: 'payment-link', description: '' }] });
  await post('/admin/api/hosting/policy', { policy: { provisioningEnabled: true, monthlyPriceCents: 2000, osId: '1743', releaseRef: 'a'.repeat(64) } }, true);
  assert.equal((await post('/admin/api/billing/launch', { action: 'prepare' }, true)).status, 200);
  assert.equal((await post('/admin/api/billing/launch', { enabled: true, cryptoEnabled: true }, true)).status, 200);

  await test('the HTTP checkout handoff waits for settlement and a signed webhook, then creates one monthly $20 hosting checkout', async () => {
    for (const plan of ['monthly', 'yearly', 'lifetime']) {
      const result = await post('/api/billing/checkout', { plan, payment: 'card', hosting: true, attemptId: randomUUID() });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      const { session, params } = [...sessions.values()].at(-1);
      const body = Object.fromEntries(new URLSearchParams(new URL(params.get('success_url')).hash.slice(1)));
      assert.equal((await post('/api/billing/hosting-continuation', body)).status, 202);
      const n = hostingRequests.length;
      Object.assign(session, { status: 'complete', payment_status: plan === 'lifetime' ? 'paid' : 'no_payment_required', customer: `cus_${plan}`, customer_details: { email: `${plan}@example.test` }, subscription: plan === 'lifetime' ? null : `sub_${plan}` });
      assert.equal((await post('/api/billing/hosting-continuation', body)).status, 202);
      assert.equal(hostingRequests.length, n);
      const event = JSON.stringify({ id: `evt_${plan}`, object: 'event', type: 'checkout.session.completed', livemode: false, created: clock / 1000, data: { object: session } });
      const webhook = await fetch(fixture.origin + '/api/billing/stripe/test', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(event, secret, clock / 1000) }, body: event });
      assert.equal(webhook.status, 200, await webhook.text());
      if (plan === 'yearly') {
        priceMismatch = true;
        assert.equal((await post('/api/billing/hosting-continuation', body)).status, 409);
        assert.equal(hostingRequests.length, n, 'incorrect Stripe price cannot create a checkout');
        priceMismatch = false;
      }
      const next = await post('/api/billing/hosting-continuation', body);
      assert.equal(next.status, 200, JSON.stringify(next.data));
      assert.equal(next.data.url, 'https://checkout.stripe.com/c/pay/hosting_20_monthly');
      const hosting = hostingRequests.at(-1);
      assert.equal(hosting.get('customer'), session.customer);
      assert.equal(hosting.get('mode'), 'subscription');
      assert.equal(hosting.get('line_items[0][price]'), 'price_hosting');
      assert.equal(hosting.get('subscription_data[billing_cycle_anchor]'), null);
      assert.equal(hosting.get('subscription_data[trial_end]'), null);
      assert.equal((await post('/api/billing/hosting-continuation', body)).data.url, next.data.url);
      assert.equal(hostingRequests.length, n + 1, 'retries reuse the reserved Stripe session');
      assert.equal((await post('/api/billing/hosting-continuation', { ...body, token: 'b'.repeat(64) })).status, 400);
      assert.equal(fixture.hub.hosting.store.instances().filter(i => i.ownerId === session.customer).length, 1);
    }
  });

  await test('the return page opens the verified Stripe URL and exposes retry after an error', async () => {
    const response = await fetch(fixture.origin + '/checkout/hosting');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const html = await response.text();
    const dom = new JSDOM(html, { url: `${fixture.origin}/checkout/hosting#intent=${'a'.repeat(64)}&token=${'b'.repeat(64)}`, runScripts: 'outside-only' });
    const navigations = [];
    let fail = true;
    dom.window.fetch = async () => new Response(JSON.stringify(fail ? { ok: false, error: 'Retry after temporary provider error' } : { ok: true, url: 'https://checkout.stripe.com/c/pay/hosting' }), { status: fail ? 409 : 200 });
    dom.window.HTMLAnchorElement.prototype.click = function () { navigations.push(this.href); };
    dom.window.eval(dom.window.document.querySelector('script').textContent);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dom.window.document.querySelector('#retry').hidden, false);
    assert.match(dom.window.document.querySelector('#status').textContent, /temporary provider/);
    fail = false;
    dom.window.document.querySelector('#retry').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(navigations, ['https://checkout.stripe.com/c/pay/hosting']);
    dom.window.close();
  });
} finally { await fixture.close(); }
summary('Hosting checkout continuation');
