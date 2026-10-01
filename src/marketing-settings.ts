import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJsonAtomic } from './jsonfile.js';
import { BrevoMarketing, type MarketingContactInput } from './marketing-brevo.js';

interface Settings { apiKey: string | null; listIds: number[]; webhookBearerSecret: string | null }
/** Private configuration and durable consent evidence. No campaign send operation. */
export class MarketingSettings {
  readonly brevo: BrevoMarketing;
  private readonly file: string;
  private lists = new Set<number>();
  private config: Settings;
  constructor(private readonly dataDir: string, fetcher?: typeof fetch) {
    this.file = path.join(dataDir, 'marketing-brevo.v1.json');
    this.config = readJson<Settings>(this.file, { apiKey: null, listIds: [], webhookBearerSecret: null });
    this.validate(this.config);
    this.config.listIds.forEach(id => this.lists.add(id));
    this.brevo = new BrevoMarketing({
      allowedListIds: this.lists, fetch: fetcher,
      readApiKey: () => this.config.apiKey,
      writeApiKey: key => { this.save({ ...this.config, apiKey: key }); },
      webhookBearerSecret: () => this.config.webhookBearerSecret,
      recordConsent: record => {
        const digest = createHash('sha256').update(JSON.stringify(record)).digest('hex');
        writeJsonAtomic(path.join(dataDir, 'marketing-consent', `${digest}.json`), record);
      },
    });
  }
  private validate(value: Settings): void {
    if (value.apiKey !== null && (typeof value.apiKey !== 'string' || value.apiKey.length < 20 || value.apiKey.length > 512 || /\s|\0/.test(value.apiKey))) throw Error('Enter a valid Brevo API key');
    if (!Array.isArray(value.listIds) || value.listIds.length > 20 || value.listIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw Error('Enter up to 20 positive Brevo list IDs');
    if (value.webhookBearerSecret !== null && (typeof value.webhookBearerSecret !== 'string' || value.webhookBearerSecret.length < 32 || value.webhookBearerSecret.length > 256 || /\s|\0/.test(value.webhookBearerSecret))) throw Error('Webhook secret must contain 32–256 non-space characters');
  }
  private save(next: Settings): void {
    this.validate(next); writeJsonAtomic(this.file, next); this.config = next;
    this.lists.clear(); next.listIds.forEach(id => this.lists.add(id));
  }
  async status() { return { ...await this.brevo.status(), listIds: [...this.config.listIds], webhookConfigured: Boolean(this.config.webhookBearerSecret) }; }
  async configure(input: Record<string, unknown>) {
    const next = { ...this.config };
    for (const name of ['apiKey', 'webhookBearerSecret'] as const) {
      if (input[name] === undefined || input[name] === '') continue;
      if (input[name] !== null && typeof input[name] !== 'string') throw Error('Invalid marketing settings');
      next[name] = input[name] as string | null;
    }
    if (input.listIds !== undefined) next.listIds = [...new Set(input.listIds as number[])];
    this.save(next);
    return this.status();
  }
  async import(input: Record<string, unknown>) {
    if (!Array.isArray(input.contacts) || !input.contacts.length || input.contacts.length > 50 || !input.contacts.every(c => c && typeof c === 'object' && typeof c.email === 'string')) throw Error('Import 1–50 contacts with consent evidence per request');
    return this.brevo.importContacts(input.contacts as MarketingContactInput[], input.listId as number);
  }
}
