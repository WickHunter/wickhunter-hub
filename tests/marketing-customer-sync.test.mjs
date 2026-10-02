import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MarketingCustomerSync } from '../dist/src/marketing-customer-sync.js';

const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const absent = () => new Response('{}', { status: 404 });
const updated = () => new Response(null, { status: 204 });
const failed = () => new Response('{}', { status: 500 });
const attrs = () => ok({ attributes: [
  { category: 'normal', name: 'WH_CUSTOMER', type: 'boolean' },
  { category: 'normal', name: 'WH_PLAN', type: 'text' },
  { category: 'normal', name: 'WH_SUBSCRIPTION_STATUS', type: 'text' },
  { category: 'normal', name: 'WH_STARTER_PACK', type: 'boolean' },
] });
const contact = (email, attributes = {}, extra = {}) => ok({ id: 4, email, attributes, emailBlacklisted: true,
  listIds: [5], listUnsubscribed: [5], ...extra });
const record = (email, extra = {}) => ({ key: 'cus_1', stripeCustomerId: 'cus_1', email, name: 'Customer',
  livemode: true, licenseId: 'lic_1', planKey: 'monthly', subscriptionId: 'sub_1', subscriptionStatus: 'active',
  periodEndMs: null, chargeIds: [], createdAtMs: 1, updatedAtMs: 1, welcomeSentAtMs: null,
  welcomeError: null, disputed: false, refunded: false, lastEventType: null, lastEventAtMs: null, ...extra });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-customer-sync-'));
let key = null;
let allowedListIds = [];
let now = 1_000_000;
let records = [record(' Test@Example.com '), record('test@example.com', { key: 'cus_test', livemode: false, updatedAtMs: 5 })];
const requests = [];
const responses = [];
const fetcher = async (url, init) => {
  requests.push({ url, init });
  const response = responses.shift();
  if (!response) throw new Error('Unexpected request');
  return typeof response === 'function' ? response() : response;
};
const sync = new MarketingCustomerSync({ dataDir: dir, readApiKey: () => key, listCustomers: () => records,
  readAllowedListIds: () => allowedListIds, now: () => now, fetch: fetcher });

assert.equal((await sync.runOnce()).configured, false);
assert.equal(requests.length, 0, 'missing key makes no external calls');
key = 'private-provider-key';
assert.equal((await sync.runOnce()).visited, 0, 'a key without a configured audience does not access contacts');
assert.equal(requests.length, 0);
allowedListIds = [5];
responses.push(attrs(), absent());
assert.deepEqual(await sync.runOnce(), { configured: true, eligible: 1, visited: 1, updated: 0,
  unchanged: 0, missing: 1, skipped: 0, failed: 0 });
assert.equal(requests.length, 2, '404 never creates contact');
assert.equal(requests.at(-1).init.method, 'GET');
assert.equal((await sync.runOnce()).visited, 0, 'missing contact is rechecked after a bounded delay');

records = [record('preview-only@example.com')];
responses.push(contact('preview-only@example.com', {}, { listIds: [99] }));
assert.equal((await sync.runOnce()).skipped, 1, 'an existing contact outside the configured audience is excluded');
assert.equal(requests.at(-1).init.method, 'GET', 'an out-of-audience contact receives no attribute PUT');
records = [record('test@example.com')];

now += 6 * 60 * 60_000;
responses.push(contact('Test@Example.com'), updated());
assert.equal((await sync.runOnce()).updated, 1, 'later import receives attributes');
const put = requests.at(-1);
assert.equal(put.init.method, 'PUT');
assert.deepEqual(JSON.parse(put.init.body), { attributes: {
  WH_CUSTOMER: true, WH_PLAN: 'monthly', WH_SUBSCRIPTION_STATUS: 'active', WH_STARTER_PACK: false,
} });
assert.equal(JSON.stringify(put.init.body).includes('Blacklisted'), false);
assert.equal(JSON.stringify(put.init.body).includes('listIds'), false);
assert.equal(JSON.stringify(put.init.body).includes('email'), false);
assert.equal(requests.some(r => r.init.method === 'POST'), false, 'no contact or list creation');
assert.equal((await sync.runOnce()).visited, 0, 'durable digest avoids duplicate updates');

// A source change wins over an existing checkpoint and uses a new snapshot.
records = [record('test@example.com', { updatedAtMs: 10, planKey: 'yearly', launchManaged: true,
  starterPackGrantedAtMs: Date.parse('2026-10-05T12:00:00-04:00') })];
responses.push(contact('test@example.com', { WH_CUSTOMER: true, WH_PLAN: 'monthly',
  WH_SUBSCRIPTION_STATUS: 'active', WH_STARTER_PACK: false }), updated());
assert.equal((await sync.runOnce()).updated, 1);
assert.equal(JSON.parse(requests.at(-1).init.body).attributes.WH_PLAN, 'yearly');
assert.equal(JSON.parse(requests.at(-1).init.body).attributes.WH_STARTER_PACK, true);

// Provider failures retain work and back off; no raw provider error is exposed.
records = [record('test@example.com', { updatedAtMs: 11, subscriptionStatus: 'past_due' })];
responses.push(failed());
assert.equal((await sync.runOnce()).failed, 1);
assert.equal((await sync.runOnce()).visited, 0);
now += 5 * 60_000;
responses.push(contact('test@example.com'), updated());
assert.equal((await sync.runOnce()).updated, 1);
assert.equal(JSON.parse(requests.at(-1).init.body).attributes.WH_SUBSCRIPTION_STATUS, 'past_due');

// A malformed 200 response fails closed, without a PUT.
records = [record('test@example.com', { updatedAtMs: 12, subscriptionStatus: 'canceled' })];
responses.push(ok({}));
const beforeMalformed = requests.length;
assert.equal((await sync.runOnce()).failed, 1);
assert.equal(requests.length, beforeMalformed + 1);
assert.equal(requests.at(-1).init.method, 'GET');

// A fresh worker reads the successful checkpoint and still refreshes Brevo daily.
const restart = new MarketingCustomerSync({ dataDir: dir, readApiKey: () => key,
  readAllowedListIds: () => allowedListIds,
  listCustomers: () => [record('test@example.com', { updatedAtMs: 11, subscriptionStatus: 'past_due' })],
  now: () => now, fetch: fetcher });
assert.equal((await restart.runOnce()).visited, 0);

// A new provider key invalidates the old account checkpoint and rechecks.
key = 'different-private-provider-key';
responses.push(attrs(), contact('test@example.com', { WH_CUSTOMER: true, WH_PLAN: 'monthly',
  WH_SUBSCRIPTION_STATUS: 'past_due', WH_STARTER_PACK: false }));
assert.equal((await restart.runOnce()).unchanged, 1);

// Schema setup creates only the four normal contact attributes; the pass is capped at 20.
const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-customer-sync-bulk-'));
const bulkRequests = [];
const bulk = new MarketingCustomerSync({ dataDir: bulkDir, readApiKey: () => key, maxPerPass: 999,
  readAllowedListIds: () => allowedListIds,
  listCustomers: () => Array.from({ length: 30 }, (_, i) => record(`bulk${i}@example.com`, { key: `cus_${i}` })),
  now: () => now, fetch: async (url, init) => {
    bulkRequests.push({ url, init });
    if (url.endsWith('/attributes')) return ok({ attributes: [] });
    if (init.method === 'POST') return new Response('{}', { status: 201 });
    return absent();
  } });
assert.equal((await bulk.runOnce()).visited, 20);
assert.deepEqual(bulkRequests.filter(r => r.init.method === 'POST').map(r => JSON.parse(r.init.body).type).sort(),
  ['boolean', 'boolean', 'text', 'text']);
assert.equal(bulkRequests.filter(r => r.init.method === 'GET' && r.url.includes('/contacts/bulk')).length, 20);
assert.equal((await bulk.runOnce()).visited, 10, 'remaining due records are not starved by missing contacts');
fs.rmSync(bulkDir, { recursive: true, force: true });

const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-customer-sync-corrupt-'));
const corruptHash = createHash('sha256').update('corrupt@example.com').digest('hex');
fs.mkdirSync(path.join(corruptDir, 'marketing-customer-sync.v1'));
fs.writeFileSync(path.join(corruptDir, 'marketing-customer-sync.v1', `${corruptHash}.json`), '{}');
let corruptCalls = 0;
const corrupt = new MarketingCustomerSync({ dataDir: corruptDir, readApiKey: () => key,
  readAllowedListIds: () => allowedListIds,
  listCustomers: () => [record('corrupt@example.com'), record('good@example.com', { key: 'cus_good' })], now: () => now,
  fetch: async url => { corruptCalls++; return url.endsWith('/attributes') ? attrs() : absent(); } });
assert.equal((await corrupt.runOnce()).missing, 2);
assert.equal(corruptCalls, 3, 'corrupt email is retried without blocking other customers');
assert.equal(fs.readdirSync(path.join(corruptDir, 'marketing-customer-sync.v1'))
  .some(name => name.startsWith(`${corruptHash}.json.corrupt.`)), true, 'old state is preserved for repair');
fs.rmSync(corruptDir, { recursive: true, force: true });

// These are actual BillingService states, including its human-readable cancel status.
const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-customer-sync-status-'));
const statusRequests = [];
const statusSync = new MarketingCustomerSync({ dataDir: statusDir, readApiKey: () => key, now: () => now,
  readAllowedListIds: () => allowedListIds,
  listCustomers: () => [
    record('cancel@example.com', { key: 'cus_cancel', subscriptionStatus: 'active (cancels at period end)' }),
    record('refund@example.com', { key: 'cus_refund', subscriptionStatus: 'active', refunded: true }),
    record('dispute@example.com', { key: 'cus_dispute', subscriptionStatus: 'active', disputed: true }),
  ], fetch: async (url, init) => {
    statusRequests.push({ url, init });
    if (url.endsWith('/attributes')) return attrs();
    if (init.method === 'PUT') return updated();
    return contact(decodeURIComponent(url.split('/').at(-1)));
  } });
assert.equal((await statusSync.runOnce()).updated, 3);
const statuses = Object.fromEntries(statusRequests.filter(r => r.init.method === 'PUT').map(r => [
  decodeURIComponent(r.url.split('/').at(-1)), JSON.parse(r.init.body).attributes.WH_SUBSCRIPTION_STATUS,
]));
assert.deepEqual(statuses, { 'cancel@example.com': 'active_canceling', 'refund@example.com': 'refunded',
  'dispute@example.com': 'disputed' });
fs.rmSync(statusDir, { recursive: true, force: true });

// Shutdown aborts a pending provider request, even if a fetch stub ignores the signal.
const stopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-customer-sync-stop-'));
const stopRequests = [];
let releaseHeldFetch;
const stopSync = new MarketingCustomerSync({ dataDir: stopDir, readApiKey: () => key,
  readAllowedListIds: () => allowedListIds,
  listCustomers: () => [record('stop@example.com')], now: () => now,
  fetch: async (url, init) => {
    stopRequests.push({ url, init });
    if (url.endsWith('/attributes')) return attrs();
    return new Promise(resolve => { releaseHeldFetch = () => resolve(contact('stop@example.com')); });
  } });
const stoppedPass = stopSync.runOnce();
while (!releaseHeldFetch) await new Promise(resolve => setImmediate(resolve));
await stopSync.stop();
assert.equal(stopRequests.at(-1).init.signal.aborted, true);
releaseHeldFetch();
await stoppedPass;
assert.equal(stopRequests.length, 2, 'no PUT or next contact after stop');
assert.equal(fs.existsSync(path.join(stopDir, 'marketing-customer-sync.v1')), false, 'no checkpoint write after stop');
fs.rmSync(stopDir, { recursive: true, force: true });

// In-flight source change is picked up on the next pass; concurrent calls share one pass.
const raceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-customer-sync-race-'));
let raceRec = record('race@example.com');
let release;
const gate = new Promise(resolve => { release = resolve; });
const raceRequests = [];
let waits = true;
const raceSync = new MarketingCustomerSync({ dataDir: raceDir, readApiKey: () => key,
  readAllowedListIds: () => allowedListIds,
  listCustomers: () => [raceRec], now: () => now, fetch: async (url, init) => {
    raceRequests.push({ url, init });
    if (url.endsWith('/attributes')) return attrs();
    if (init.method === 'GET') return contact('race@example.com');
    if (waits) { waits = false; await gate; }
    return updated();
  } });
const first = raceSync.runOnce();
const simultaneous = raceSync.runOnce();
assert.equal(first, simultaneous);
while (!raceRequests.some(r => r.init.method === 'PUT')) await new Promise(resolve => setImmediate(resolve));
raceRec = record('race@example.com', { updatedAtMs: 2, planKey: 'yearly' });
release();
assert.equal((await first).updated, 1);
assert.equal((await raceSync.runOnce()).updated, 1);
assert.equal(JSON.parse(raceRequests.at(-1).init.body).attributes.WH_PLAN, 'yearly');
await raceSync.stop();
assert.equal((await raceSync.runOnce()).configured, false);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(raceDir, { recursive: true, force: true });
console.log('Marketing customer sync: existing contacts only, durable rechecks/retries, suppression preservation, live-only snapshots, and overlap passed');
