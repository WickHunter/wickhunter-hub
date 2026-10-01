import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJsonAtomic } from '../jsonfile.js';
import { EarnStripeApi } from '../earn-stripe-api.js';
import { escapeHtml, sendEmail, type EmailFetch, type EmailMessage } from './email.js';
import type { BillingService } from './service.js';
import type { EmailConfig } from './config.js';

interface Reminder {
  key: string; subscriptionId: string; firstPaymentAtMs: number;
  state: 'pending' | 'sent' | 'canceled' | 'needs_attention';
  attemptedAtMs: number | null; sentAtMs: number | null; error: string;
  message?: EmailMessage;
  delivery?: Pick<EmailConfig, 'provider' | 'from' | 'replyTo'>;
  checkedAtMs?: number;
}
/** Transactional first-charge reminders. A fixed billing-cycle anchor is not
 * a Stripe trial, so trial_will_end cannot supply this notification. */
export class FirstPaymentReminders {
  private file: string;
  private running = false;
  constructor(private billing: BillingService, private enabled: () => boolean,
    private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {
    this.file = path.join(billing.dataDir, 'billing-first-payment-reminders.v1.json');
  }
  private read(): Record<string, Reminder> { return readJson(this.file, {}); }
  private put(row: Reminder): void { const rows = this.read(); rows[row.key] = row; writeJsonAtomic(this.file, rows); }
  status() {
    const rows = Object.values(this.read());
    return { running: this.running, counts: Object.fromEntries(['pending','sent','canceled','needs_attention'].map(state => [state, rows.filter(r => r.state === state).length])),
      needsAttention: rows.filter(r => r.state === 'needs_attention').map(r => ({ subscriptionId: r.subscriptionId, firstPaymentAtMs: r.firstPaymentAtMs, error: r.error })) };
  }
  async tick(): Promise<void> {
    if (this.running || !this.enabled()) return;
    this.running = true;
    try {
      const cfg = this.billing.config(), clock = this.now();
      const saved = this.read();
      const candidates = Object.values(this.billing.store.customers()).sort((a, b) => {
        const checked = (c: typeof a) => saved[createHash('sha256').update(`${c.livemode ? 'live' : 'test'}:${c.subscriptionId}:${c.firstPaymentAtMs}`).digest('hex')]?.checkedAtMs ?? 0;
        return checked(a) - checked(b);
      });
      let checked = 0;
      const startedAt = Date.now();
      for (const customer of candidates) {
        if (Date.now() - startedAt > 20_000) break;
        const first = customer.firstPaymentAtMs, subscriptionId = customer.subscriptionId;
        if (!first || !Number.isFinite(first) || !subscriptionId || customer.nonRenewing || customer.refunded || customer.disputed) continue;
        if (clock < first - 3 * 86400000) continue;
        const mode = customer.livemode ? 'live' : 'test';
        if (mode === 'test' && cfg.mode !== 'test') continue;
        const key = createHash('sha256').update(`${mode}:${subscriptionId}:${first}`).digest('hex');
        let row = this.read()[key] ?? { key, subscriptionId, firstPaymentAtMs: first, state: 'pending', attemptedAtMs: null, sentAtMs: null, error: '' } as Reminder;
        if (row.state !== 'pending') continue;
        if (row.checkedAtMs && clock - row.checkedAtMs < 30_000) continue;
        if (++checked > 40) break; // bounded, oldest checked first so retries cannot starve new signups
        row.checkedAtMs = clock;
        this.put(row);
        try {
          const api = new EarnStripeApi(cfg.stripe[mode].secretKey, this.fetcher);
          const sub = await api.call('GET', `/v1/subscriptions/${subscriptionId}`);
          const stripeCustomer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
          if (sub.id !== subscriptionId || stripeCustomer !== customer.stripeCustomerId) throw Error('identity');
          if (!['active', 'trialing'].includes(sub.status) || sub.cancel_at_period_end || (sub.cancel_at && sub.cancel_at * 1000 <= first)) {
            row.state = 'canceled'; row.error = ''; this.put(row); continue;
          }
          if (!Number.isSafeInteger(sub.billing_cycle_anchor) || sub.billing_cycle_anchor * 1000 !== first) {
            row.state = 'needs_attention'; row.error = 'Stripe billing date differs from the scheduled first charge; reconcile before sending'; this.put(row); continue;
          }
          if (clock >= first) { row.state = 'needs_attention'; row.error = 'First-payment reminder was not confirmed before the billing date'; this.put(row); continue; }
          if (cfg.email.provider === 'none' || !cfg.email.apiKey || !cfg.email.from || !customer.email?.includes('@')) {
            row.error = 'Configure transactional email and a valid customer email before billing'; this.put(row); continue;
          }
          if (row.attemptedAtMs && row.delivery?.provider !== cfg.email.provider) {
            row.state = 'needs_attention'; row.error = 'Email provider changed after a delivery attempt; reconcile delivery first'; this.put(row); continue;
          }
          if (row.attemptedAtMs && (cfg.email.provider !== 'resend' || clock - row.attemptedAtMs >= 23 * 3600000)) {
            row.state = 'needs_attention'; row.error = 'Email delivery needs reconciliation before retrying'; this.put(row); continue;
          }
          if (!row.message) {
            const preview = await api.call('POST', '/v1/invoices/create_preview', { subscription: subscriptionId });
            const previewCustomer = typeof preview.customer === 'string' ? preview.customer : preview.customer?.id;
            if (previewCustomer !== customer.stripeCustomerId || !Number.isSafeInteger(preview.amount_due) || preview.amount_due < 0 || !/^[a-z]{3}$/.test(preview.currency)) throw Error('preview');
            const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: preview.currency.toUpperCase() });
            const amount = formatter.format(preview.amount_due / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
            const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'America/New_York' }).format(first);
            const portal = `${this.billing.publicOrigin.replace(/\/+$/, '')}/billing`;
            const text = `Your Wick Hunter Unleashed subscription starts billing on ${date} (Eastern Time). Your upcoming invoice is currently estimated at ${amount}. The final invoice reflects any account or tax changes.\n\nYour subscription renews automatically until canceled. To review your subscription, payment method, or cancel before the first charge, open Manage subscription in the app or visit ${portal}.\n\nWick Hunter Software, LLC\n131 Continental Dr Suite 305, Newark, DE 19713, US`;
            row.message = { to: customer.email, subject: `Reminder: your Wick Hunter subscription starts billing ${date}`, text,
              html: `<p>${escapeHtml(text).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`, idempotencyKey: `wh-first-payment-${key}` };
            row.delivery = { provider: cfg.email.provider, from: cfg.email.from, replyTo: cfg.email.replyTo };
            this.put(row);
          }
          row.attemptedAtMs ??= clock;
          this.put(row); // exact body and delivery identity survive uncertain responses
          const emailFetch: EmailFetch = async (url, init) => {
            const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
            return { ok: response.ok, status: response.status, text: () => response.text() };
          };
          const result = await sendEmail({ ...cfg.email, ...row.delivery }, row.message, emailFetch);
          if (result.ok) { row.state = 'sent'; row.sentAtMs = this.now(); row.error = ''; }
          else row.error = 'Email delivery is awaiting confirmation';
          this.put(row);
        } catch {
          row.error = 'Reminder is pending a verified subscription, invoice preview, or email delivery'; this.put(row);
        }
      }
    } finally { this.running = false; }
  }
}
