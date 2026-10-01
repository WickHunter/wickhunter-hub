import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshHub, test, summary } from './helpers.mjs';
const outbound = [];
const hub = await freshHub({}, { marketingFetch: async (url, init) => {
  outbound.push({ url, init });
  if (url === 'https://api.brevo.com/v3/account') return new Response('{}');
  if (init.method === 'GET') return new Response(JSON.stringify({ emailBlacklisted: true, listIds: [15] }));
  throw Error('No contact or message writes are expected');
} });
const headers = { 'x-hub-admin': 'test-admin-token', 'content-type': 'application/json' };
const endpoint = '/admin/api/marketing/brevo';
try {
  await test('launch management and marketing require Hub authentication', async () => {
    for (const p of [endpoint, '/admin/api/billing/launch', '/admin/api/billing/report', '/admin/api/notifications', '/admin/api/releases/status']) {
      const response = await fetch(hub.origin + p); assert.equal(response.status, 401);
      const good = await fetch(hub.origin + p, { headers }); assert.equal(good.status, 200);
    }
  });
  await test('release overview keeps private Alpha and Production promotion disabled without changing release state', async () => {
    const response = await fetch(hub.origin + '/admin/api/releases/status', { headers });
    const status = await response.json();
    assert.equal(status.alpha.private, true);
    assert.equal(status.beta.manualPublish, true);
    assert.equal(status.production.automaticPromotionEnabled, false);
    assert.equal(status.production.version, null);
    assert.equal(status.production.publicationPending, false);
    assert.equal(status.production.recovery, 'not-needed');
    assert.equal(status.production.checks.length, 4);
    const write = await fetch(hub.origin + '/admin/api/releases/status', { method: 'POST', headers, body: '{}' });
    assert.notEqual(write.status, 200);
  });
  await test('release overview hides staged Production head and flags pending recovery', async () => {
    const stateFile = hub.releasesDir + '/.release-control.v1.json';
    fs.writeFileSync(stateFile, JSON.stringify({
      schema: 'wickhunter.release-control.v1', beta: null,
      production: { buildId: 'staged', file: 'staged.tgz', publishedAt: new Date().toISOString(), sha256: 'a'.repeat(64), version: '9.9.9' },
      productionHold: null,
    }));
    fs.writeFileSync(stateFile + '.pending.v1.json', '{"schema":"pending"}');
    const response = await fetch(hub.origin + '/admin/api/releases/status', { headers });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.production.version, null);
    assert.equal(status.production.publicationPending, true);
    assert.equal(status.production.recovery, 'required');
  });
  await test('marketing credentials are write-only; connection check cannot send emails', async () => {
    const secret = 'fixture-brevo-secret-key-only';
    const save = await fetch(hub.origin + endpoint, { method: 'POST', headers, body: JSON.stringify({ apiKey: secret, listIds: [15], webhookBearerSecret: 'X'.repeat(40) }) });
    assert.equal(save.status, 200);
    const text = await save.text(); assert(!text.includes(secret)); assert(!text.includes('X'.repeat(40)));
    assert.equal(outbound.length, 0);
    const check = await fetch(hub.origin + endpoint + '/test', { method: 'POST', headers, body: '{}' });
    assert.equal((await check.json()).lastTestOk, true);
    assert.equal(outbound.length, 1); assert.equal(outbound[0].init.method, 'GET');
  });
  await test('consented import still skips blocked contacts and leaves opt-out intact', async () => {
    const response = await fetch(hub.origin + endpoint + '/import', { method: 'POST', headers, body: JSON.stringify({ listId: 15, contacts: [{ email: 'buyer@example.test', consent: { granted: true, source: 'Prior explicit signup', noticeVersion: '2026-09', consentedAt: '2026-09-01T00:00:00Z' } }] }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results[0].status, 'suppressed');
    assert(outbound.every(c => c.init.method === 'GET'));
  });
  await test('unsigned opt-out webhook cannot mutate Brevo', async () => {
    const n = outbound.length;
    const response = await fetch(hub.origin + '/api/marketing/brevo/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'unsubscribed', email: 'buyer@example.test' }) });
    assert.equal(response.status, 401); assert.equal(outbound.length, n);
  });
} finally { await hub.close(); }
summary();
