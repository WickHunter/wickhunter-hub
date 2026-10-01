import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Notifications, NotificationError, isDiscordWebhookUrl } from '../dist/src/notifications.js';
import { SupportChat } from '../dist/src/support-chat.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-notifications-'));
const webhook = 'https://discord.com/api/webhooks/123456789012345678/' + 'A'.repeat(68);
assert.equal(isDiscordWebhookUrl(webhook), true);
for (const bad of [
  'https://evil.example/api/webhooks/123456789012345678/' + 'A'.repeat(68),
  'https://discord.com.evil.example/api/webhooks/123456789012345678/' + 'A'.repeat(68),
  'http://discord.com/api/webhooks/123456789012345678/' + 'A'.repeat(68),
  webhook + '?redirect=https://evil.example',
  'https://discord.com:443/api/webhooks/123456789012345678/' + 'A'.repeat(68),
]) assert.equal(isDiscordWebhookUrl(bad), false);

let now = 1_800_000_000_000;
const sent = [];
const service = new Notifications(dir, async (url, init) => {
  sent.push({ url, init }); return new Response(null, { status: 204 });
}, () => now);
assert.throws(() => service.configure({ webhookUrl: 'https://evil.example/hook' }), NotificationError);
service.configure({ webhookUrl: webhook, enabledKinds: { signup: true, supportHuman: false } });
assert.equal(service.status().configured, true);
assert.equal(JSON.stringify(service.status()).includes(webhook), false, 'status must never reveal the webhook secret');
assert.equal(service.enqueue({ key: 'customer-1', kind: 'signup', title: 'New signup' }).accepted, true);
assert.equal(service.enqueue({ key: 'customer-1', kind: 'signup', title: 'New signup' }).reason, 'duplicate');
assert.equal(service.enqueue({ key: 'thread-1', kind: 'supportHuman', title: 'Human request' }).reason, 'disabled');
await service.flush();
assert.equal(sent.length, 1);
assert.equal(sent[0].url, webhook + '?wait=true');
assert.deepEqual(JSON.parse(sent[0].init.body).allowed_mentions, { parse: [] });
assert.equal(service.status().counts.delivered, 1);
assert.equal(JSON.stringify(service.status()).includes('/api/webhooks/'), false);

const ambiguous = new Notifications(dir, async () => { throw new Error(`secret ${webhook}`); }, () => now);
ambiguous.enqueue({ key: 'renewal-1', kind: 'renewal', title: 'Renewal received', fields: [{ name: 'MRR', value: '$100' }] });
await ambiguous.flush();
assert.equal(ambiguous.status().counts.ambiguous, 1);
assert.match(JSON.stringify(ambiguous.status()), /delivery outcome unknown/);
assert.equal(JSON.stringify(ambiguous.status()).includes(webhook), false, 'transport errors must not leak webhook URL');

const supportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-notification-support-'));
const events = [];
const chat = new SupportChat(supportDir, { enabled: true, aiEnabled: false, apiKey: '', totalMonthlyMicros: 1_000_000 }, fetch, () => now, e => events.push(e));
const identity = { owner: 'owner-opaque', name: 'Private Customer Name', licenseId: 'license-secret' };
const first = await chat.message(identity, { text: 'private support details', requestId: 'customer_0001', human: true, version: '1.0' });
const id = first.threads[0].id;
assert.deepEqual(events.map(e => e.kind), ['supportNew', 'supportHuman']);
await chat.message(identity, { id, text: 'follow-up private details', requestId: 'customer_0002' });
chat.action({ action: 'reply', id, text: 'staff response', requestId: 'staff_000001' });
chat.action({ action: 'resolve', id });
chat.action({ action: 'resolve', id });
assert.deepEqual(events.map(e => e.kind), ['supportNew', 'supportHuman', 'supportReply', 'supportResolved']);
assert.equal(events.at(-1).openTickets, 0);
assert.equal(events.at(-1).resolvedTickets, 1);
assert.equal(JSON.stringify(events).includes('private'), false, 'ticket notifications expose counts and opaque ids only');
assert.equal(JSON.stringify(events).includes('Private Customer Name'), false);
assert.equal(JSON.stringify(events).includes('license-secret'), false);

const recoverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-support-notify-recovery-'));
const unavailable = new SupportChat(recoverDir, { enabled: true, aiEnabled: false, apiKey: '', totalMonthlyMicros: 1_000_000 }, fetch, () => now, () => { throw Error('notification storage unavailable'); });
await unavailable.message(identity, { text: 'Recover this ticket', requestId: 'recovery_0001', human: true });
assert.equal(unavailable.admin().notificationPending, 2);
const recoveredEvents = [];
const recovered = new SupportChat(recoverDir, { enabled: true, aiEnabled: false, apiKey: '', totalMonthlyMicros: 1_000_000 }, fetch, () => now, e => recoveredEvents.push(e));
recovered.flushNotifications(); recovered.flushNotifications();
assert.deepEqual(recoveredEvents.map(e => e.kind), ['supportNew', 'supportHuman']);
assert.equal(recovered.admin().notificationPending, 0);
assert.equal(new Set(recoveredEvents.map(e => e.key)).size, 2);

console.log('Discord notification validation, durable queue, redaction and support event hooks passed');
