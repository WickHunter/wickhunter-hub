import { timingSafeEqual } from "node:crypto";

export interface MarketingConsent {
  granted: true;
  source: string;
  noticeVersion: string;
  consentedAt: string;
}
export interface MarketingContactInput {
  email: string;
  consent: MarketingConsent;
}
export interface BrevoConsentRecord extends MarketingConsent {
  email: string;
  listId: number;
}
export interface BrevoMarketingConfig {
  /** Wire these to protected server-side settings. There is deliberately no key getter in the admin-facing API. */
  readApiKey: () => string | null | Promise<string | null>;
  writeApiKey: (apiKey: string | null) => void | Promise<void>;
  allowedListIds: ReadonlySet<number>;
  /** Persist an auditable, idempotent consent record before adding a contact to a marketing list. */
  recordConsent: (record: BrevoConsentRecord) => void | Promise<void>;
  webhookBearerSecret: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => Date;
}
export interface BrevoMarketingStatus {
  configured: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}
export interface BrevoImportResult {
  status: "created" | "added_to_list" | "already_in_list" | "suppressed" | "duplicate_in_batch";
  listId: number;
}

const API = "https://api.brevo.com/v3";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const normalizedEmail = (value: string) => value.trim().toLowerCase();

export class BrevoMarketing {
  private readonly request: typeof fetch;
  private readonly clock: () => Date;
  private readonly importLocks = new Map<string, Promise<void>>();
  private lastTestAt: string | null = null;
  private lastTestOk: boolean | null = null;
  private lastTestMessage: string | null = null;

  constructor(private readonly config: BrevoMarketingConfig) {
    this.request = config.fetch ?? fetch;
    this.clock = config.now ?? (() => new Date());
  }

  async setApiKey(value: string): Promise<BrevoMarketingStatus> {
    const key = value.trim();
    if (key.length < 20 || key.length > 512 || /[\r\n\0\s]/.test(key)) {
      throw new Error("Enter a valid Brevo API key.");
    }
    await this.config.writeApiKey(key);
    this.lastTestAt = null;
    this.lastTestOk = null;
    this.lastTestMessage = null;
    return this.status();
  }

  async clearApiKey(): Promise<BrevoMarketingStatus> {
    await this.config.writeApiKey(null);
    this.lastTestAt = null;
    this.lastTestOk = null;
    this.lastTestMessage = null;
    return this.status();
  }

  async status(): Promise<BrevoMarketingStatus> {
    return {
      configured: Boolean((await this.config.readApiKey())?.trim()),
      lastTestAt: this.lastTestAt,
      lastTestOk: this.lastTestOk,
      lastTestMessage: this.lastTestMessage,
    };
  }

  async testConnection(): Promise<BrevoMarketingStatus> {
    this.lastTestAt = this.clock().toISOString();
    let key: string;
    try {
      key = await this.apiKey();
    } catch {
      this.lastTestOk = false;
      this.lastTestMessage = "Brevo API key is not configured.";
      return this.status();
    }
    try {
      const response = await this.request(`${API}/account`, {
        method: "GET",
        headers: { accept: "application/json", "api-key": key },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.lastTestOk = false;
        this.lastTestMessage = response.status === 401 || response.status === 403
          ? "Brevo rejected the API key."
          : `Brevo connection failed (HTTP ${response.status}).`;
      } else {
        this.lastTestOk = true;
        this.lastTestMessage = "Brevo connection verified.";
      }
    } catch {
      this.lastTestOk = false;
      this.lastTestMessage = "Brevo could not be reached.";
    }
    return this.status();
  }

  async importContact(input: MarketingContactInput, listId: number): Promise<BrevoImportResult> {
    const email = normalizedEmail(input.email);
    const prior = this.importLocks.get(email) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    this.importLocks.set(email, queued);
    await prior;
    try {
      return await this.importContactOnce(input, listId, email);
    } finally {
      release();
      if (this.importLocks.get(email) === queued) this.importLocks.delete(email);
    }
  }

  private async importContactOnce(input: MarketingContactInput, listId: number, email: string): Promise<BrevoImportResult> {
    const key = await this.apiKey();
    this.assertAllowedList(listId);
    if (!EMAIL.test(email) || email.length > 320) throw new Error("Enter a valid email address.");
    const consent = this.validConsent(input.consent);
    const url = `${API}/contacts/${encodeURIComponent(email)}`;
    const existing = await this.request(url, {
      method: "GET", headers: { accept: "application/json", "api-key": key }, signal: AbortSignal.timeout(10_000),
    });

    if (existing.ok) {
      const contact = await existing.json() as { emailBlacklisted?: unknown; listIds?: unknown };
      // Never resubscribe a suppressed contact. In particular, do not send an email address
      // or emailBlacklisted:false in the update request: Brevo documents that changing the
      // email address of a blocklisted contact can remove its blocklisting.
      if (contact.emailBlacklisted === true) return { status: "suppressed", listId };
      if (contact.emailBlacklisted !== false || !Array.isArray(contact.listIds)) {
        throw new Error("Brevo returned an incomplete contact record; no import was made.");
      }
      if (contact.listIds.some((id) => id === listId)) return { status: "already_in_list", listId };
      await this.config.recordConsent({ email, listId, ...consent });
      const response = await this.request(url, {
        method: "PUT",
        headers: { accept: "application/json", "content-type": "application/json", "api-key": key },
        body: JSON.stringify({ listIds: [listId] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Brevo could not add the contact (HTTP ${response.status}).`);
      return { status: "added_to_list", listId };
    }
    if (existing.status !== 404) throw new Error(`Brevo contact lookup failed (HTTP ${existing.status}).`);

    await this.config.recordConsent({ email, listId, ...consent });
    const response = await this.request(`${API}/contacts`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "api-key": key },
      // Only a newly created contact with recorded explicit consent is opted in. Existing
      // records are handled above without touching global emailBlacklisted state.
      body: JSON.stringify({ email, listIds: [listId], emailBlacklisted: false }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Brevo could not create the contact (HTTP ${response.status}).`);
    return { status: "created", listId };
  }

  async importContacts(inputs: readonly MarketingContactInput[], listId: number): Promise<BrevoImportResult[]> {
    this.assertAllowedList(listId);
    const seen = new Set<string>();
    const results: BrevoImportResult[] = [];
    for (const input of inputs) {
      const email = normalizedEmail(input.email);
      if (seen.has(email)) results.push({ status: "duplicate_in_batch", listId });
      else {
        seen.add(email);
        results.push(await this.importContact(input, listId));
      }
    }
    return results;
  }

  /** Verify the Bearer token configured on a Brevo webhook; Brevo documents bearer-token
   * and custom-header webhook authentication, not an HMAC signature header. */
  async handleOptOutWebhook(authorization: string | undefined, event: unknown): Promise<"suppressed" | "ignored"> {
    const secret = (await this.config.webhookBearerSecret())?.trim() ?? "";
    if (secret.length < 32 || !authorization?.startsWith("Bearer ") || !safeEqual(authorization.slice(7), secret)) {
      throw new Error("Unauthorized Brevo webhook.");
    }
    if (!event || typeof event !== "object") throw new Error("Invalid Brevo webhook event.");
    const payload = event as { event?: unknown; email?: unknown };
    const kind = typeof payload.event === "string" ? payload.event : "";
    if (!["unsubscribed", "spam", "hardBounce", "invalid"].includes(kind)) return "ignored";
    const email = typeof payload.email === "string" ? normalizedEmail(payload.email) : "";
    if (!EMAIL.test(email) || email.length > 320) throw new Error("Invalid Brevo webhook contact.");
    const key = await this.apiKey();
    const response = await this.request(`${API}/contacts/${encodeURIComponent(email)}`, {
      method: "PUT",
      headers: { accept: "application/json", "content-type": "application/json", "api-key": key },
      body: JSON.stringify({ emailBlacklisted: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Brevo could not record the opt-out (HTTP ${response.status}).`);
    return "suppressed";
  }

  private async apiKey(): Promise<string> {
    const key = (await this.config.readApiKey())?.trim() ?? "";
    if (!key) throw new Error("Brevo API key is not configured.");
    return key;
  }

  private assertAllowedList(listId: number): void {
    if (!Number.isSafeInteger(listId) || !this.config.allowedListIds.has(listId)) {
      throw new Error("The requested Brevo list is not configured for marketing imports.");
    }
  }

  private validConsent(value: MarketingConsent): MarketingConsent {
    if (!value || value.granted !== true) throw new Error("Explicit marketing consent is required.");
    const source = typeof value.source === "string" ? value.source.trim() : "";
    const noticeVersion = typeof value.noticeVersion === "string" ? value.noticeVersion.trim() : "";
    const consentedAt = typeof value.consentedAt === "string" ? value.consentedAt : "";
    const parsed = new Date(consentedAt);
    if (!source || source.length > 120 || !noticeVersion || noticeVersion.length > 80
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(consentedAt)
      || !Number.isFinite(parsed.getTime()) || parsed.getTime() > this.clock().getTime() + 60_000) {
      throw new Error("Marketing consent needs a valid source, notice version, and timestamp.");
    }
    return { granted: true, source, noticeVersion, consentedAt: parsed.toISOString() };
  }
}
