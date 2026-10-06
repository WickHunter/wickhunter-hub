// Real HTTP admission with the same loopback nginx/shared edge-IP shape as
// the website proxy. Stripe is strictly offline; no payments or VPS purchases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { freshHub, jsonReq, test, summary } from './helpers.mjs';

let clock = Date.parse('2026-10-06T12:00:00Z');
const creates = [], sessions = new Map();
const fakeStripe = async (input, init = {}) => {
  const url = new URL(input);
  assert.equal(url.origin, 'https://api.stripe.com');
  if (init.method === 'GET' && url.pathname.startsWith('/v1/prices/')) {
    const plan = url.pathname.slice('/v1/prices/price_'.length);
    assert(['monthly', 'yearly', 'lifetime'].includes(plan));
    return Response.json({ id: `price_${plan}`, active: true, livemode: false,
      type: plan === 'lifetime' ? 'one_time' : 'recurring', currency: 'usd',
      unit_amount: { monthly: 9900, yearly: 69900, lifetime: 99900 }[plan], product: 'prod_software',
      recurring: plan === 'lifetime' ? null : { interval: plan === 'yearly' ? 'year' : 'month', interval_count: 1 } });
  }
  if (init.method === 'GET' && url.pathname === '/v1/account') return Response.json({ capabilities: {} });
  assert.equal(init.method, 'POST');
  assert.equal(url.pathname, '/v1/checkout/sessions');
  const key = init.headers['Idempotency-Key'], params = new URLSearchParams(init.body);
  assert.match(key, /^wh-launch-checkout-[a-f0-9]{64}$/);
  assert.equal(params.get('mode'), 'subscription');
  assert.equal(params.get('line_items[0][price]'), 'price_monthly');
  assert.equal(params.get('line_items[0][quantity]'), '1');
  assert.equal(params.has('line_items[1][price]'), false);
  assert.equal(params.get('allow_promotion_codes'), 'true');
  creates.push({ key, params: params.toString() });
  let session = sessions.get(key);
  if (!session) {
    const id = `cs_proxy_fixture${sessions.size + 1}`;
    session = { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    sessions.set(key, session);
  }
  return Response.json(session);
};
const h = await freshHub({}, { rateLimitNow: () => clock, billingNow: () => clock, launchFetch: fakeStripe });
try {
  // Configure through the actual authenticated route, with the owned test Hub's
  // genuine admin credential. Public checkout itself receives no admin header.
  const configured = await jsonReq(h.origin + '/admin/api/billing/config', {
    method: 'POST', headers: { 'x-hub-admin': 'test-admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'test', stripe: { test: { secretKey: 'sk_test_offline_fixture_only', priceIds: { monthly: 'price_monthly', yearly: 'price_yearly', lifetime: 'price_lifetime' } } } }),
  });
  assert.equal(configured.status, 200);
  for (const body of [{ action: 'prepare' }, { enabled: true, cryptoEnabled: false }]) {
    const result = await jsonReq(h.origin + '/admin/api/billing/launch', {
      method: 'POST', headers: { 'x-hub-admin': 'test-admin-token', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  const sharedIp = '203.0.113.90';
  const buyers = Array.from({ length: 31 }, (_, i) => {
    const issued = h.store.issue(`Proxy checkout buyer ${i + 1}`, 30);
    return { plan: 'monthly', payment: 'card', attemptId: randomUUID(), licenseId: issued.payload.id, token: issued.token };
  });
  const checkout = (body, ip = sharedIp) => fetch(h.origin + '/api/billing/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body),
  });
  const intents = () => fs.readdirSync(path.join(h.dataDir, 'billing-launch-intents.v1'))
    .map(f => JSON.parse(fs.readFileSync(path.join(h.dataDir, 'billing-launch-intents.v1', f), 'utf8')));
  let firstUrl;

  await test('four independent genuine licence holders behind one trusted proxy IP can start Checkout', async () => {
    for (const buyer of buyers.slice(0, 4)) {
      const response = await checkout(buyer), body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
      firstUrl ??= body.url;
    }
    assert.equal(creates.length, 4);
    assert.equal(new Set(intents().map(i => i.licenseId)).size, 4);
  });
  await test('the same proxy admits exactly 30 independent Checkout attempts in one minute', async () => {
    for (const buyer of buyers.slice(4, 30)) {
      const response = await checkout(buyer), body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
    }
    assert.equal(creates.length, 30);
    assert.equal(new Set(intents().map(i => i.licenseId)).size, 30);
    assert.equal(sessions.size, 30);
  });
  await test('attempt 31 is refused with matching Retry-After and no provider call or durable intent', async () => {
    const response = await checkout(buyers[30]), body = await response.json();
    assert.equal(response.status, 429);
    assert.equal(body.retryAfterSeconds, 60);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(creates.length, 30);
    assert.equal(intents().some(i => i.licenseId === buyers[30].licenseId), false);
    assert.equal(h.hub.hosting.store.instances().length, 0);
  });
  await test('direct /buy and canonical retries share the bounded checkout bucket; other source IPs stay independent', async () => {
    const direct = await fetch(h.origin + '/buy?plan=monthly', { headers: { 'x-forwarded-for': sharedIp }, redirect: 'manual' });
    assert.equal(direct.status, 429);
    assert.equal((await checkout(buyers[0])).status, 429);
    assert.equal(creates.length, 30);
    const other = await checkout(buyers[30], '198.51.100.91');
    assert.equal(other.status, 200);
    assert.equal(creates.length, 31);
    assert.equal((await jsonReq(h.origin + '/api/health', { headers: { 'x-forwarded-for': sharedIp } })).status, 200);
    assert.equal((await jsonReq(h.origin + '/api/billing/plans', { headers: { 'x-forwarded-for': sharedIp } })).status, 200);
  });
  await test('a retry after the window returns the original immutable Session without another provider create', async () => {
    clock += 60_001;
    const response = await checkout(buyers[0]), body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.url, firstUrl);
    assert.equal(creates.length, 31);
    assert.equal(intents().length, 31);
    assert.equal((await checkout({ ...buyers[0], plan: 'yearly' })).status, 400);
    assert.equal(creates.length, 31);
  });
} finally {
  await h.close();
}
summary('checkout-rate-limit');
