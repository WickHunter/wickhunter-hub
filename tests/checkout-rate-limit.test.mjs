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
  const checkout = (body, ip = sharedIp, extraHeaders = {}) => fetch(h.origin + '/api/billing/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...extraHeaders }, body: JSON.stringify(body),
  });
  const intents = () => {
    const dir = path.join(h.dataDir, 'billing-launch-intents.v1');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
    .map(f => JSON.parse(fs.readFileSync(path.join(h.dataDir, 'billing-launch-intents.v1', f), 'utf8')));
  };
  const corsBuyers = Array.from({ length: 6 }, (_, i) => {
    const issued = h.store.issue(`Checkout CORS buyer ${i + 1}`, 30);
    return { plan: 'monthly', payment: 'card', attemptId: randomUUID(), licenseId: issued.payload.id, token: issued.token };
  });
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
  await test('checkout CORS is exact-origin, credential-free, and preflight does not spend a checkout slot', async () => {
    const origin = 'https://www.wickhunterunleashed.com', ip = '203.0.113.101';
    const preflight = await fetch(h.origin + '/api/billing/checkout', { method: 'OPTIONS', headers: {
      origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type',
      'x-forwarded-for': ip,
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type');
    assert.equal(preflight.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.equal(preflight.headers.get('vary'), 'Origin');
    assert.equal(preflight.headers.get('cache-control'), 'no-store');
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);

    const beforeCreates = creates.length, beforeIntents = intents().length;
    const rejectedPreflights = [
      { name: 'foreign origin', headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }, allowedOrigin: null },
      { name: 'missing origin', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }, allowedOrigin: null },
      { name: 'unsupported method', headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' }, allowedOrigin: origin },
      { name: 'credential header', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization' }, allowedOrigin: origin },
    ];
    for (const rejected of rejectedPreflights) {
      const response = await fetch(h.origin + '/api/billing/checkout', { method: 'OPTIONS', headers: rejected.headers });
      assert.equal(response.status, 403, rejected.name);
      assert.equal(response.headers.get('access-control-allow-origin'), rejected.allowedOrigin, rejected.name);
      assert.equal(response.headers.get('access-control-allow-credentials'), null, rejected.name);
      assert.equal(response.headers.get('cache-control'), 'no-store', rejected.name);
      await response.arrayBuffer();
    }
    assert.equal(creates.length, beforeCreates);
    assert.equal(intents().length, beforeIntents);

    const foreign = await checkout(corsBuyers[0], ip, { origin: 'https://attacker.example' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    assert.equal(foreign.headers.get('vary'), 'Origin');
    assert.equal(creates.length, beforeCreates);
    assert.equal(intents().length, beforeIntents);

    const accepted = await checkout(corsBuyers[0], ip, { origin, cookie: 'wh_customer=ignored-fixture' });
    const body = await accepted.json();
    assert.equal(accepted.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(accepted.headers.get('access-control-allow-origin'), origin);
    assert.equal(accepted.headers.get('access-control-allow-credentials'), null);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    assert.equal(creates.length, beforeCreates + 1);
  });

  await test('the other canonical site origin and non-browser checkout remain supported', async () => {
    const origin = 'https://wickhunterunleashed.com';
    const site = await checkout(corsBuyers[1], '203.0.113.102', { origin });
    assert.equal(site.status, 200);
    assert.equal(site.headers.get('access-control-allow-origin'), origin);
    assert.equal(site.headers.get('access-control-allow-credentials'), null);
    const nonBrowser = await checkout(corsBuyers[2], '203.0.113.103');
    assert.equal(nonBrowser.status, 200);
    assert.equal(nonBrowser.headers.get('access-control-allow-origin'), null);
    const sameOrigin = new URL(h.cfg.publicOrigin).origin;
    const sameSite = await checkout(corsBuyers[3], '203.0.113.108', { origin: sameOrigin });
    assert.equal(sameSite.status, 200);
    assert.equal(sameSite.headers.get('access-control-allow-origin'), sameOrigin);
  });

  await test('checkout CORS headers survive malformed-body, 30-attempt, and 300-entry early refusals', async () => {
    const origin = 'https://www.wickhunterunleashed.com';
    const malformed = await fetch(h.origin + '/api/billing/checkout', { method: 'POST', headers: {
      origin, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.104',
    }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get('access-control-allow-origin'), origin);
    assert.equal(malformed.headers.get('cache-control'), 'no-store');

    const ip30 = '203.0.113.105', before30 = creates.length;
    for (let i = 0; i < 30; i++) {
      const response = await checkout(corsBuyers[4], ip30, { origin });
      assert.equal(response.status, 200, `checkout ${i + 1}`);
      await response.arrayBuffer();
    }
    const refused30 = await checkout(corsBuyers[4], ip30, { origin });
    const body30 = await refused30.json();
    assert.equal(refused30.status, 429);
    assert.equal(body30.retryAfterSeconds, 60);
    assert.equal(refused30.headers.get('retry-after'), '60');
    assert.equal(refused30.headers.get('access-control-allow-origin'), origin);
    assert.equal(refused30.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.equal(refused30.headers.get('cache-control'), 'no-store');
    assert.equal(creates.length, before30 + 1);

    const ip300 = '203.0.113.106';
    for (let i = 0; i < 270; i++) {
      const response = await fetch(h.origin + '/api/billing/plans', { headers: { 'x-forwarded-for': ip300 } });
      assert.equal(response.status, 200, `entry request ${i + 1}`);
      await response.arrayBuffer();
    }
    for (let i = 0; i < 30; i++) {
      const response = await checkout(corsBuyers[5], ip300, { origin });
      assert.equal(response.status, 200, `checkout after readiness read ${i + 1}`);
      await response.arrayBuffer();
    }
    const refused300 = await checkout(corsBuyers[5], ip300, { origin });
    const body300 = await refused300.json();
    assert.equal(refused300.status, 429);
    assert.equal(body300.retryAfterSeconds, 60);
    assert.equal(refused300.headers.get('retry-after'), '60');
    assert.equal(refused300.headers.get('access-control-allow-origin'), origin);
    assert.equal(refused300.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.equal(refused300.headers.get('cache-control'), 'no-store');
  });

  await test('checkout-only CORS does not authorize cookie-authenticated customer actions', async () => {
    const response = await fetch(h.origin + '/api/customer/portal', { method: 'POST', headers: {
      origin: 'https://www.wickhunterunleashed.com', 'content-type': 'application/json',
      cookie: 'wh_customer=ignored-fixture', 'x-forwarded-for': '203.0.113.107',
    }, body: '{}' });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const body = await response.json();
    assert.match(body.error, /Hub origin/);
  });

} finally {
  await h.close();
}
summary('checkout-rate-limit');
