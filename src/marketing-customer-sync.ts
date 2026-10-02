import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './jsonfile.js';
import type { CustomerRecord } from './billing/store.js';
import { starterPackEligible } from './billing/starter-pack.js';

const API = 'https://api.brevo.com/v3';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ATTRIBUTES = {
  WH_CUSTOMER: 'boolean',
  WH_PLAN: 'text',
  WH_SUBSCRIPTION_STATUS: 'text',
  WH_STARTER_PACK: 'boolean',
} as const;
const SUCCESS_RECHECK_MS = 24 * 60 * 60_000;
const MISSING_RECHECK_MS = 6 * 60 * 60_000;
const FAILURE_RETRY_MS = 5 * 60_000;

interface Checkpoint {
  version: 1;
  keyHash: string;
  digest: string | null;
  nextCheckAtMs: number;
}
interface Candidate {
  email: string;
  hash: string;
  keyHash: string;
  desired: Record<keyof typeof ATTRIBUTES, boolean | string>;
  digest: string;
  checkpoint: Checkpoint;
  dueAtMs: number;
}
export interface MarketingCustomerSyncConfig {
  dataDir: string;
  /** The protected, current key; never expose it through a status response. */
  readApiKey: () => string | null | Promise<string | null>;
  /** Only existing contacts in a configured marketing audience can be updated. */
  readAllowedListIds: () => readonly number[] | Promise<readonly number[]>;
  /** A fresh BillingStore.customers() snapshot on each pass. */
  listCustomers: () => Record<string, CustomerRecord> | readonly CustomerRecord[] | Promise<Record<string, CustomerRecord> | readonly CustomerRecord[]>;
  fetch?: typeof fetch;
  now?: () => number;
  /** A pass never visits more than 20 customer emails. */
  maxPerPass?: number;
}
export interface MarketingCustomerSyncResult {
  configured: boolean;
  eligible: number;
  visited: number;
  updated: number;
  unchanged: number;
  missing: number;
  skipped: number;
  failed: number;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const normalizedEmail = (value: string) => value.trim().toLowerCase();
const emptyResult = (configured: boolean): MarketingCustomerSyncResult =>
  ({ configured, eligible: 0, visited: 0, updated: 0, unchanged: 0, missing: 0, skipped: 0, failed: 0 });
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 && value.length <= 80 && /^[a-zA-Z0-9_-]+$/.test(value) ? value : fallback;
const subscriptionStatus = (rec: CustomerRecord): string => {
  if (rec.disputed) return 'disputed';
  if (rec.refunded) return 'refunded';
  if (rec.subscriptionStatus === 'active (cancels at period end)' ||
      (rec.subscriptionStatus === 'active' && rec.cancelAtPeriodEnd)) return 'active_canceling';
  if (rec.subscriptionStatus !== null) return safeText(rec.subscriptionStatus, 'unknown');
  if (rec.lifetimeAccess) return 'lifetime';
  if (rec.nonRenewing) return 'non_renewing';
  return 'none';
};

/** Syncs billing-owned flags to contacts already in Brevo. It never creates a
 * contact, adds a list, changes an email address, or changes opt-out state. */
export class MarketingCustomerSync {
  private readonly request: typeof fetch;
  private readonly clock: () => number;
  private readonly limit: number;
  private readonly checkpointDir: string;
  private running: Promise<MarketingCustomerSyncResult> | null = null;
  private controller: AbortController | null = null;
  private closed = false;
  private attributesReadyForKey: string | null = null;

  constructor(private readonly config: MarketingCustomerSyncConfig) {
    this.request = config.fetch ?? fetch;
    this.clock = config.now ?? Date.now;
    this.limit = Math.min(20, Math.max(1, Math.trunc(config.maxPerPass ?? 20)));
    this.checkpointDir = path.join(config.dataDir, 'marketing-customer-sync.v1');
  }

  runOnce(): Promise<MarketingCustomerSyncResult> {
    if (this.closed) return Promise.resolve(emptyResult(false));
    if (this.running) return this.running;
    const controller = new AbortController();
    this.controller = controller;
    // Do not leak a provider response, URL, or billing source detail through a
    // scheduler rejection. An unacknowledged item is eligible on a later pass.
    const running = this.perform(controller.signal)
      .catch(() => ({ ...emptyResult(false), failed: 1 }))
      .finally(() => {
        if (this.running === running) this.running = null;
        if (this.controller === controller) this.controller = null;
      });
    this.running = running;
    return running;
  }

  /** Call when stopping the server; in-flight work finishes before shutdown. */
  async stop(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    await this.running;
  }

  private assertOpen(signal?: AbortSignal): void {
    if (this.closed || signal?.aborted) throw new Error('Marketing customer sync stopped.');
  }

  /** Abort makes shutdown bounded even if an injected fetch ignores its signal. */
  private async call(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    this.assertOpen(signal);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    let rejectAbort!: (reason: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new Error('Marketing customer sync stopped.'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([this.request(url, { ...init, signal: combined }), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private quarantine(file: string): void {
    // A malformed checkpoint contains only digests and timestamps. Preserve it
    // under a hashed name for repair, then safely re-read Brevo for this email.
    fs.renameSync(file, `${file}.corrupt.${randomUUID()}`);
  }

  private checkpoint(hashValue: string): Checkpoint | null {
    const file = path.join(this.checkpointDir, `${hashValue}.json`);
    let raw: unknown;
    try { raw = readJson<unknown>(file, null); }
    catch { this.quarantine(file); return null; }
    if (raw === null) return null;
    if (!isObject(raw) || raw.version !== 1 ||
        typeof raw.keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.keyHash) ||
        !(raw.digest === null || (typeof raw.digest === 'string' && /^[a-f0-9]{64}$/.test(raw.digest))) ||
        !Number.isSafeInteger(raw.nextCheckAtMs) || Number(raw.nextCheckAtMs) < 0) {
      this.quarantine(file);
      return null;
    }
    return raw as unknown as Checkpoint;
  }

  private save(candidate: Candidate, digest: string | null, nextCheckAtMs: number): void {
    this.assertOpen();
    writeJsonAtomic(path.join(this.checkpointDir, `${candidate.hash}.json`),
      { version: 1, keyHash: candidate.keyHash, digest, nextCheckAtMs } satisfies Checkpoint);
  }

  private candidates(records: Record<string, CustomerRecord> | readonly CustomerRecord[], now: number, keyHash: string, allowedListIds: ReadonlySet<number>): { due: Candidate[]; failed: number } {
    const selected = new Map<string, CustomerRecord>();
    const values = Array.isArray(records) ? records : Object.values(records);
    for (const rec of values) {
      if (!rec || rec.livemode !== true || typeof rec.key !== 'string' ||
          typeof rec.licenseId !== 'string' || !rec.licenseId ||
          typeof rec.email !== 'string') continue;
      const email = normalizedEmail(rec.email);
      if (!EMAIL.test(email) || email.length > 320 || !Number.isSafeInteger(rec.updatedAtMs)) continue;
      const prior = selected.get(email);
      if (!prior || rec.updatedAtMs > prior.updatedAtMs ||
          (rec.updatedAtMs === prior.updatedAtMs && rec.key.localeCompare(prior.key) > 0)) selected.set(email, rec);
    }
    const output: Candidate[] = [];
    let failed = 0;
    for (const [email, rec] of selected) {
      const desired = {
        WH_CUSTOMER: true,
        WH_PLAN: safeText(rec.planKey, 'unknown'),
        WH_SUBSCRIPTION_STATUS: subscriptionStatus(rec),
        WH_STARTER_PACK: starterPackEligible(rec),
      };
      const digest = hash(JSON.stringify({ desired, allowedListIds: [...allowedListIds].sort((a, b) => a - b) }));
      const hashValue = hash(email);
      let checkpoint: Checkpoint | null;
      try { checkpoint = this.checkpoint(hashValue); }
      catch { failed++; continue; }
      const dueAtMs = checkpoint?.keyHash === keyHash && (checkpoint.digest === null || checkpoint.digest === digest)
        ? checkpoint.nextCheckAtMs : 0;
      if (dueAtMs <= now) output.push({ email, hash: hashValue, keyHash, desired, digest,
        checkpoint: checkpoint ?? { version: 1, keyHash, digest: null, nextCheckAtMs: 0 }, dueAtMs });
    }
    output.sort((a, b) => a.dueAtMs - b.dueAtMs || a.hash.localeCompare(b.hash));
    return { due: output, failed };
  }

  private async perform(signal: AbortSignal): Promise<MarketingCustomerSyncResult> {
    const key = (await this.config.readApiKey())?.trim() ?? '';
    this.assertOpen(signal);
    if (!key) return emptyResult(false);
    const result = emptyResult(true);
    const rawListIds = await this.config.readAllowedListIds();
    this.assertOpen(signal);
    if (!Array.isArray(rawListIds) || rawListIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid marketing audience lists.');
    const allowedListIds = new Set<number>(rawListIds);
    if (!allowedListIds.size) return result;
    const now = this.clock();
    const records = await this.config.listCustomers();
    this.assertOpen(signal);
    const keyHash = hash(key);
    const selected = this.candidates(records, now, keyHash, allowedListIds);
    const due = selected.due;
    result.failed = selected.failed;
    result.eligible = due.length;
    if (!due.length) return result;
    try {
      await this.ensureAttributes(key, keyHash, signal);
    } catch {
      if (!this.closed) result.failed++;
      return result;
    }
    for (const candidate of due.slice(0, this.limit)) {
      if (this.closed || signal.aborted) break;
      result.visited++;
      try {
        const outcome = await this.syncOne(candidate, key, now, allowedListIds, signal);
        result[outcome]++;
      } catch {
        if (this.closed || signal.aborted) break;
        result.failed++;
        // A failed lookup or update is not acknowledged. Back off this email
        // so one bad contact cannot starve every other due customer.
        this.save(candidate, null, now + FAILURE_RETRY_MS);
      }
    }
    return result;
  }

  private async ensureAttributes(key: string, keyHash: string, signal: AbortSignal): Promise<void> {
    if (this.attributesReadyForKey === keyHash) return;
    const list = await this.call(`${API}/contacts/attributes`, {
      method: 'GET', headers: { accept: 'application/json', 'api-key': key },
    }, signal);
    if (!list.ok) throw new Error('Brevo attribute lookup failed.');
    const body: unknown = await list.json();
    this.assertOpen(signal);
    if (!isObject(body) || !Array.isArray(body.attributes)) throw new Error('Brevo attribute lookup was incomplete.');
    const existing = new Map<string, string>();
    for (const item of body.attributes) {
      if (!isObject(item)) continue;
      if (item.category === 'normal' && typeof item.name === 'string' && typeof item.type === 'string') {
        existing.set(item.name.toUpperCase(), item.type);
      }
    }
    for (const [name, type] of Object.entries(ATTRIBUTES)) {
      this.assertOpen(signal);
      const found = existing.get(name);
      if (found && found !== type) throw new Error('Brevo customer attribute has the wrong type.');
      if (found) continue;
      const created = await this.call(`${API}/contacts/attributes/normal/${name}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': key },
        body: JSON.stringify({ type }),
      }, signal);
      if (created.status !== 201) throw new Error('Brevo customer attribute creation failed.');
    }
    this.assertOpen(signal);
    this.attributesReadyForKey = keyHash;
  }

  private async syncOne(candidate: Candidate, key: string, now: number, allowedListIds: ReadonlySet<number>, signal: AbortSignal): Promise<'updated' | 'unchanged' | 'missing' | 'skipped'> {
    const url = `${API}/contacts/${encodeURIComponent(candidate.email)}`;
    const existing = await this.call(url, {
      method: 'GET', headers: { accept: 'application/json', 'api-key': key },
    }, signal);
    this.assertOpen(signal);
    if (existing.status === 404) {
      this.save(candidate, null, now + MISSING_RECHECK_MS);
      return 'missing';
    }
    if (!existing.ok) throw new Error('Brevo contact lookup failed.');
    const contact: unknown = await existing.json();
    this.assertOpen(signal);
    if (!isObject(contact) || typeof contact.email !== 'string' ||
        normalizedEmail(contact.email) !== candidate.email ||
        !Number.isSafeInteger(contact.id) || Number(contact.id) <= 0 ||
        !Array.isArray(contact.listIds) || contact.listIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        !isObject(contact.attributes)) throw new Error('Brevo contact lookup was incomplete.');
    if (!contact.listIds.some(id => allowedListIds.has(id))) {
      this.save(candidate, null, now + MISSING_RECHECK_MS);
      return 'skipped';
    }
    const attrs = contact.attributes;
    const unchanged = Object.entries(candidate.desired).every(([name, value]) => attrs[name] === value);
    if (!unchanged) {
      const response = await this.call(url, {
        method: 'PUT',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': key },
        body: JSON.stringify({ attributes: candidate.desired }),
      }, signal);
      this.assertOpen(signal);
      if (response.status !== 204) throw new Error('Brevo contact attribute update failed.');
    }
    this.save(candidate, candidate.digest, now + SUCCESS_RECHECK_MS);
    return unchanged ? 'unchanged' : 'updated';
  }
}
