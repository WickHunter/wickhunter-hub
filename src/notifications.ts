// Durable, bounded Discord notification outbox. The webhook is write-only at
// the HTTP boundary: status() never returns it, and transport failures are
// stored as fixed labels rather than provider response text.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeTextAtomic } from './jsonfile.js';

export const NOTIFICATION_KINDS = [
  'signup', 'renewal', 'discount', 'paymentFailed',
  'supportNew', 'supportHuman', 'supportReply', 'supportResolved',
] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export interface NotificationInput {
  key: string;
  kind: NotificationKind;
  title: string;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  url?: string;
}
type DeliveryState = 'queued' | 'sending' | 'delivered' | 'failed' | 'ambiguous';
interface Row extends NotificationInput {
  id: string; state: DeliveryState; createdAt: number; updatedAt: number;
  attempts: number; nextAttemptAt: number; error: string;
}
interface State {
  schema: 1; webhookUrl: string; enabledKinds: Partial<Record<NotificationKind, boolean>>;
  rows: Row[];
}
const MAX_ROWS = 500;
const MAX_QUEUE = 200;
const MAX_BODY = 8_000;
const clean = (value: unknown, limit: number) => (typeof value === 'string' ? value : '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, limit);
const empty = (): State => ({ schema: 1, webhookUrl: '', enabledKinds: {}, rows: [] });

/** Accept only canonical Discord webhook URLs. No arbitrary hosts, query,
 * fragment, credentials, ports, alternate API paths, or IP literals. */
export function isDiscordWebhookUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'discord.com' && !u.port &&
      !u.username && !u.password && !u.search && !u.hash &&
      /^\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9._-]{50,}$/.test(u.pathname) &&
      u.href === value;
  } catch { return false; }
}

export class NotificationError extends Error {}
export class Notifications {
  private state: State;
  private readonly file: string;
  private flushing = false;
  constructor(dataDir: string, private readonly request: typeof fetch = fetch, private readonly now = Date.now) {
    this.file = path.join(dataDir, 'notifications.v1.json');
    const loaded = readJson<State>(this.file, empty());
    if (loaded.schema !== 1 || typeof loaded.webhookUrl !== 'string' || !loaded.enabledKinds || !Array.isArray(loaded.rows))
      throw new Error('Invalid notification state');
    this.state = loaded;
    // A process restart after POST began cannot prove whether Discord accepted
    // it. Keep that visible as ambiguous and schedule a bounded retry.
    let changed = false;
    for (const row of this.state.rows) if (row.state === 'sending') {
      row.state = 'ambiguous'; row.error = 'delivery outcome unknown';
      row.nextAttemptAt = this.now(); row.updatedAt = this.now(); changed = true;
    }
    if (changed) this.persist();
  }
  private persist() { writeTextAtomic(this.file, JSON.stringify(this.state) + '\n'); }
  configure(input: { webhookUrl?: unknown; enabledKinds?: unknown }) {
    const next = structuredClone(this.state);
    if (input.webhookUrl !== undefined) {
      const value = clean(input.webhookUrl, 300);
      if (value && !isDiscordWebhookUrl(value)) throw new NotificationError('Enter a valid Discord webhook URL.');
      next.webhookUrl = value;
    }
    if (input.enabledKinds !== undefined) {
      if (!input.enabledKinds || typeof input.enabledKinds !== 'object' || Array.isArray(input.enabledKinds))
        throw new NotificationError('Notification categories are invalid.');
      const toggles: Partial<Record<NotificationKind, boolean>> = {};
      for (const kind of NOTIFICATION_KINDS) {
        const value = (input.enabledKinds as Record<string, unknown>)[kind];
        if (value !== undefined && typeof value !== 'boolean') throw new NotificationError('Notification categories are invalid.');
        if (value !== undefined) toggles[kind] = value;
      }
      next.enabledKinds = { ...next.enabledKinds, ...toggles };
    }
    this.state = next; this.persist();
    return this.status();
  }
  status() {
    const rows = this.state.rows;
    return {
      configured: !!this.state.webhookUrl,
      enabledKinds: Object.fromEntries(NOTIFICATION_KINDS.map(k => [k, this.state.enabledKinds[k] !== false])),
      counts: Object.fromEntries((['queued', 'sending', 'delivered', 'failed', 'ambiguous'] as const).map(s => [s, rows.filter(r => r.state === s).length])),
      recent: rows.slice(-30).reverse().map(({ id, key, kind, title, state, createdAt, updatedAt, attempts, error }) =>
        ({ id, key, kind, title, state, createdAt, updatedAt, attempts, error })),
    };
  }
  enqueue(input: NotificationInput): { accepted: boolean; id?: string; reason?: 'disabled' | 'duplicate' } {
    if (!NOTIFICATION_KINDS.includes(input.kind)) throw new NotificationError('Unknown notification category.');
    const key = clean(input.key, 240), title = clean(input.title, 256);
    if (!key || !title) throw new NotificationError('A notification key and title are required.');
    if (this.state.enabledKinds[input.kind] === false || !this.state.webhookUrl) return { accepted: false, reason: 'disabled' };
    const id = createHash('sha256').update(`${input.kind}\0${key}`).digest('hex').slice(0, 32);
    if (this.state.rows.some(row => row.id === id)) return { accepted: false, id, reason: 'duplicate' };
    if (this.state.rows.filter(r => r.state === 'queued' || r.state === 'ambiguous' || r.state === 'sending').length >= MAX_QUEUE)
      throw new NotificationError('Notification queue is full.');
    const description = clean(input.description, 2_048);
    const fields = Array.isArray(input.fields) ? input.fields.slice(0, 10).map(f => ({
      name: clean(f?.name, 256) || 'Details', value: clean(f?.value, 1_024) || '—', inline: f?.inline === true,
    })) : [];
    const url = input.url ? clean(input.url, 2_000) : undefined;
    if (url && !/^https:\/\//i.test(url)) throw new NotificationError('Notification link must use HTTPS.');
    const now = this.now();
    const row: Row = { ...input, key, title, description, fields, ...(url ? { url } : {}), id,
      state: 'queued', createdAt: now, updatedAt: now, attempts: 0, nextAttemptAt: now, error: '' };
    this.state.rows.push(row); this.trim(); this.persist();
    return { accepted: true, id };
  }
  private trim() {
    while (this.state.rows.length > MAX_ROWS) {
      const index = this.state.rows.findIndex(r => r.state === 'delivered' || r.state === 'failed');
      if (index < 0) break;
      this.state.rows.splice(index, 1);
    }
  }
  async flush(): Promise<void> {
    if (this.flushing || !this.state.webhookUrl) return;
    this.flushing = true;
    try {
      // Drain a bounded batch per call so a large backlog cannot monopolize
      // the server loop. FIFO order gives every event category equal service.
      for (let sent = 0; sent < 10; sent++) {
        const row = this.state.rows.find(r => (r.state === 'queued' || r.state === 'ambiguous') && r.nextAttemptAt <= this.now());
        if (!row) break;
        row.state = 'sending'; row.attempts++; row.updatedAt = this.now(); this.persist();
        try {
          const response = await this.request(this.state.webhookUrl + '?wait=true', {
            method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ allowed_mentions: { parse: [] }, embeds: [{
              title: row.title, description: row.description || undefined, fields: row.fields,
              url: row.url, timestamp: new Date(row.createdAt).toISOString(), color: 0x4f8cff,
            }] }), signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) { row.state = 'delivered'; row.error = ''; }
          else if (response.status === 429 || response.status >= 500) {
            this.retry(row, response.status === 429 ? 'rate limited' : 'Discord unavailable');
          } else { row.state = 'failed'; row.error = `Discord rejected notification (${response.status})`; }
        } catch {
          // Network failure after request dispatch can mean the message was
          // accepted. Keep this distinct from a definite HTTP rejection.
          this.retry(row, 'delivery outcome unknown', true);
        }
        row.updatedAt = this.now(); this.trim(); this.persist();
      }
    } finally { this.flushing = false; }
  }
  private retry(row: Row, reason: string, ambiguous = false) {
    row.state = ambiguous ? 'ambiguous' : 'queued'; row.error = reason;
    if (row.attempts >= 8) { row.state = 'failed'; row.error = ambiguous ? 'delivery outcome unknown after retries' : reason; return; }
    row.nextAttemptAt = this.now() + Math.min(60 * 60_000, 5_000 * 2 ** Math.min(row.attempts - 1, 9));
  }
}
