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

  await test('61 readiness reads behind the shared proxy leave the independent creation budget available', async () => {
    for (let i = 0; i < 61; i++) {
      const route = i % 2 ? '/api/hosting/options' : '/api/billing/plans';
      const response = await fetch(h.origin + route, { headers: { 'x-forwarded-for': sharedIp } });
      assert.equal(response.status, 200, `readiness read ${i + 1}`);
      await response.text();
    }
    assert.equal(creates.length, 0);
  });

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
  await test('the four checkout entry routes share exactly 300 requests and refuse before provider or intent work', async () => {
    const ip = '203.0.113.92', headers = { 'x-forwarded-for': ip };
    for (let i = 0; i < 298; i++) {
      const response = await fetch(h.origin + (i % 2 ? '/api/hosting/options' : '/api/billing/plans'), { headers });
      assert.equal(response.status, 200, `entry request ${i + 1}`);
      await response.text();
    }
    // An invalid /buy and an immutable Checkout replay spend the same entry
    // allowance without creating another Session or changing purchase inputs.
    assert.notEqual((await fetch(h.origin + '/buy?plan=invalid', { headers, redirect: 'manual' })).status, 429);
    assert.equal((await checkout(buyers[0], ip)).status, 200);
    for (const route of ['/api/billing/plans', '/api/hosting/options', '/buy?plan=monthly']) {
      const response = await fetch(h.origin + route, { headers, redirect: 'manual' });
      const body = await response.json();
      assert.equal(response.status, 429);
      assert.equal(body.retryAfterSeconds, 60);
      assert.equal(response.headers.get('retry-after'), '60');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const over = await checkout(buyers[30], ip);
    assert.equal(over.status, 429);
    assert.equal(over.headers.get('retry-after'), '60');
    assert.equal(creates.length, 31);
    assert.equal(intents().length, 31);
    assert.equal(h.hub.hosting.store.instances().length, 0);
  });
  await test('checkout entry exhaustion leaves the general 60-request bucket and sign-in guard unchanged', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.92' };
    for (let i = 0; i < 60; i++) {
      const response = await fetch(h.origin + '/customer', { headers });
      assert.equal(response.status, 200, `general request ${i + 1}`);
      await response.text();
    }
    const refused = await fetch(h.origin + '/customer', { headers });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '60');
    const signin = await fetch(h.origin + '/api/customer/signin', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'offline@example.com' }),
    });
    assert.equal(signin.status, 429, 'sign-in remains in the exhausted general bucket');
    assert.equal(signin.headers.get('retry-after'), '60');
    assert.equal((await fetch(h.origin + '/api/health', { headers })).status, 200);
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
