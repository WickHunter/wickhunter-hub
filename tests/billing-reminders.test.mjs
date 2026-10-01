import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, test, summary } from './helpers.mjs';
import { FirstPaymentReminders } from '../dist/src/billing/reminders.js';

function fixture(options = {}) {
  let now = Date.parse('2026-10-13T12:00:00Z');
  const first = Date.parse('2026-10-15T04:00:00Z');
  const dataDir = tmpDir('reminders');
  const cfg = { mode: 'live', stripe: { live: { secretKey: 'sk_live_fixture' }, test: { secretKey: 'sk_test_fixture' } },
    email: { provider: 'resend', apiKey: 're_fixture', from: 'WH <billing@example.test>', replyTo: 'support@example.test' } };
  const customer = { email: 'buyer@example.test', stripeCustomerId: 'cus_fixture', subscriptionId: 'sub_fixture', livemode: true, firstPaymentAtMs: first };
  const calls = [];
  const sub = { id: 'sub_fixture', customer: 'cus_fixture', status: 'active', billing_cycle_anchor: first / 1000 };
  const preview = { customer: 'cus_fixture', currency: 'usd', amount_due: 7425 };
  let failures = options.failures ?? 0;
  const request = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith('/sub_fixture')) return new Response(JSON.stringify(sub));
    if (String(url).endsWith('/create_preview')) return new Response(JSON.stringify(preview));
    if (url === 'https://api.resend.com/emails') {
      if (failures-- > 0) throw Error('lost response');
      return new Response(JSON.stringify({ id: 'email_fixture' }));
    }
    throw Error('Unexpected outbound request');
  };
  const billing = { dataDir, publicOrigin: 'https://hub.example.test', config: () => cfg, store: { customers: () => ({ customer }) } };
  const make = () => new FirstPaymentReminders(billing, () => options.enabled !== false, request, () => now);
  return { cfg, customer, sub, preview, calls, make, first, advance: ms => { now += ms; }, setNow: ms => { now = ms; },
    emails: () => calls.filter(c => c.url === 'https://api.resend.com/emails'),
    rows: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'billing-first-payment-reminders.v1.json'), 'utf8')) };
}
await test('reminder quotes verified next invoice and sends once across restart', async () => {
  const f = fixture(); await f.make().tick(); await f.make().tick();
  assert.equal(f.emails().length, 1);
  const message = JSON.parse(f.emails()[0].init.body);
  assert.match(message.text, /\$74\.25/); assert.match(message.text, /October 15, 2026/);
  assert.match(message.text, /renews automatically until canceled/);
  assert.equal(f.make().status().counts.sent, 1);
});
await test('retry preserves complete email payload and delivery key after settings change', async () => {
  const f = fixture({ failures: 1 }); await f.make().tick();
  f.cfg.email.from = 'New sender <new@example.test>'; f.cfg.email.replyTo = 'other@example.test';
  f.preview.amount_due = 9900; f.customer.email = 'changed@example.test'; f.advance(60_000); await f.make().tick();
  assert.equal(f.emails().length, 2);
  assert.equal(f.emails()[0].init.body, f.emails()[1].init.body);
  assert.equal(f.emails()[0].init.headers['Idempotency-Key'], f.emails()[1].init.headers['Idempotency-Key']);
});
await test('ambiguous response is not duplicated after provider deduplication expires', async () => {
  const f = fixture({ failures: 1 }); await f.make().tick(); f.advance(24 * 3600_000); await f.make().tick();
  assert.equal(f.emails().length, 1); assert.equal(f.make().status().counts.needs_attention, 1);
});
await test('canceled subscription suppresses a queued reminder even after due date', async () => {
  const f = fixture(); f.sub.cancel_at_period_end = true; f.setNow(f.first + 60_000); await f.make().tick();
  assert.equal(f.emails().length, 0); assert.equal(f.make().status().counts.canceled, 1);
});
await test('wrong subscription or invoice customer cannot receive a reminder', async () => {
  for (const kind of ['sub', 'preview']) {
    const f = fixture(); f[kind].customer = 'cus_someone_else'; await f.make().tick();
    assert.equal(f.emails().length, 0); assert.equal(f.make().status().counts.pending, 1);
  }
});
await test('a Stripe-side first-charge date change stops an inaccurate reminder for operator reconciliation', async () => {
  const f = fixture(); f.sub.billing_cycle_anchor += 86400; await f.make().tick();
  assert.equal(f.emails().length, 0);
  assert.equal(f.make().status().counts.needs_attention, 1);
  assert.match(Object.values(f.rows())[0].error, /billing date differs/);
});
await test('missing email configuration does not consume the delivery retry window', async () => {
  const f = fixture(); f.cfg.email.apiKey = ''; await f.make().tick();
  assert.equal(Object.values(f.rows())[0].attemptedAtMs, null);
  f.cfg.email.apiKey = 're_ready'; f.advance(60_000); await f.make().tick(); assert.equal(f.emails().length, 1);
});
await test('late signup receives reminder immediately; no send after first charge deadline', async () => {
  const f = fixture(); f.setNow(f.first - 30_000); await f.make().tick(); assert.equal(f.emails().length, 1);
  const late = fixture(); late.setNow(late.first); await late.make().tick();
  assert.equal(late.emails().length, 0); assert.equal(late.make().status().counts.needs_attention, 1);
});
await test('disabled launch, one-off, test-mode and early customers produce no email', async () => {
  for (const mode of ['disabled', 'oneoff', 'test', 'early']) {
    const f = fixture({ enabled: mode !== 'disabled' });
    if (mode === 'oneoff') f.customer.nonRenewing = true;
    if (mode === 'test') f.customer.livemode = false;
    if (mode === 'early') f.setNow(f.first - 4 * 86400_000);
    await f.make().tick(); assert.equal(f.calls.length, 0);
  }
});
summary();
