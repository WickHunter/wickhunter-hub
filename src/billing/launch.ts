import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../jsonfile.js';
import { EarnStripeApi, type StripeObject } from '../earn-stripe-api.js';
import type { LicenseStore } from '../license.js';
import type { BillingService } from './service.js';
import { paymentLinkFor, type BillingMode, type Plan } from './config.js';
import type { HostedPriceProof } from './hosted-offer.js';

export const LAUNCH_FIRST_PAYMENT_MS = Date.parse('2026-10-15T00:00:00-04:00');
export const LAUNCH_REDEEM_UNTIL_MS = Date.parse('2026-10-16T00:00:00-04:00');
export const LAUNCH_YEARLY_END_MS = Date.parse('2027-10-15T00:00:00-04:00');
const BASE_PLANS = ['monthly', 'yearly', 'lifetime'];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
interface LaunchMode {
  enabled: boolean;
  cryptoEnabled: boolean;
  cryptoCapable: boolean;
  promotionId: string;
  prices: Record<string, { id: string; product: string; amount: number; currency: string; interval: string | null }>;
}
export interface LaunchIntent {
  id: string;
  mode: BillingMode;
  plan: string;
  payment: 'card' | 'crypto';
  licenseId: string | null;
  requestHash: string;
  createdAtMs: number;
  firstPaymentAtMs: number | null;
  accessUntilMs: number | null;
  discountPercent: number;
  hostingRequested?: boolean;
  hosting?: HostedPriceProof & { reservationId: string; expiresAtMs: number };
  stripeParams: StripeObject;
  sessionId?: string;
  url?: string;
  expiredAtMs?: number;
}
const blankMode = (): LaunchMode => ({ enabled: false, cryptoEnabled: false, cryptoCapable: false, promotionId: '', prices: {} });
const configPath = (dir: string) => path.join(dir, 'billing-launch.v1.json');
const intentPath = (dir: string, id: string) => path.join(dir, 'billing-launch-intents.v1', `${id}.json`);
const claimPath = (dir: string, mode: BillingMode, licenseId: string) => path.join(dir, 'billing-launch-claims.v1', mode, `${sha(licenseId)}.json`);

/** The signed Stripe event supplies an opaque intent ID, never a customer
 * chosen license ID or access date. Only a locally persisted checkout can
 * grant the launch terms or attach payment to an existing installation. */
export function launchGrant(dir: string, metadata: Record<string, string>, live: boolean, sessionId?: string): LaunchIntent | null {
  const id = metadata.wh_launch_intent;
  if (!id) return null;
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error('Invalid launch purchase identity');
  const intent = readJson<LaunchIntent | null>(intentPath(dir, id), null);
  if (!intent || intent.id !== id || intent.mode !== (live ? 'live' : 'test') || intent.plan !== metadata.plan) {
    throw Error('Launch purchase does not match a persisted checkout');
  }
  if (sessionId && intent.sessionId !== sessionId) throw Error('Launch checkout session does not match its persisted purchase');
  return intent;
}

/** A lost create response can be recovered with the same persisted request and
 * Stripe idempotency key. After that key's safe window, only a Session with
 * the Hub's client reference and exact line item can recover the purchase. */
export async function reconcileLaunchSession(dir: string, metadata: Record<string, string>, live: boolean,
  sessionId: string, secretKey: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<LaunchIntent | null> {
  const intent = launchGrant(dir, metadata, live);
  if (!intent) return null;
  if (intent.sessionId) return launchGrant(dir, metadata, live, sessionId);
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId) || !secretKey) throw Error('Launch checkout needs Stripe reconciliation');
  const api = new EarnStripeApi(secretKey, fetcher);
  let recovered: StripeObject;
  if (now - intent.createdAtMs < 23 * 3600_000) {
    recovered = await api.call('POST', '/v1/checkout/sessions', intent.stripeParams, { key: `wh-launch-checkout-${intent.id}` });
    if (recovered.id !== sessionId) throw Error('Launch checkout session differs from Stripe idempotency result');
  } else {
    recovered = await api.call('GET', `/v1/checkout/sessions/${sessionId}`);
    if (recovered.client_reference_id !== intent.id) throw Error('Launch checkout lacks its durable Stripe reference');
    const lines = await api.call('GET', `/v1/checkout/sessions/${sessionId}/line_items`, { limit: intent.hosting ? 3 : 2 });
    const price = intent.stripeParams['line_items[0][price]'];
    const dynamic = intent.stripeParams['line_items[0][price_data][product]'];
    const line = lines.data?.[0];
    if (intent.hosting) {
      const expected = new Set([intent.hosting.softwarePriceId, intent.hosting.hostingPriceId]);
      if (lines.has_more || lines.data?.length !== 2 || lines.data.some((l: StripeObject) => l.quantity !== 1 || !expected.delete(l.price?.id)) || expected.size) throw Error('Hosted checkout line items differ from the persisted purchase');
    } else if (lines.has_more || lines.data?.length !== 1 || line?.quantity !== 1 ||
      (price ? line.price?.id !== price : line.price?.product !== dynamic || line.price?.unit_amount !== intent.stripeParams['line_items[0][price_data][unit_amount]'])) {
      throw Error('Launch checkout line items differ from the persisted purchase');
    }
  }
  if (recovered.id !== sessionId || recovered.mode !== intent.stripeParams.mode ||
    recovered.metadata?.wh_launch_intent !== intent.id || recovered.metadata?.plan !== intent.plan ||
    (typeof recovered.livemode === 'boolean' && recovered.livemode !== live)) {
    throw Error('Launch checkout differs from the persisted purchase');
  }
  intent.sessionId = sessionId;
  writeJsonAtomic(intentPath(dir, intent.id), intent);
  return intent;
}

export class LaunchBilling {
  private flights = new Map<string, { requestHash: string; promise: Promise<{ ok: true; url: string }> }>();
  constructor(private dataDir: string, private billing: BillingService, private licenses: LicenseStore,
    private origin: string, private fetcher: typeof fetch = fetch, private now: () => number = Date.now,
    private resolveReferral?: (code: string, mode: BillingMode) => { code: string; promotionId: string; discountPercent: number },
    private hosted?: { ready: () => boolean; prepare: (plan: string, id: string, customerId?: string) => Promise<NonNullable<LaunchIntent['hosting']>>; bind: (hosting: NonNullable<LaunchIntent['hosting']>, params: StripeObject) => void; release?: (hosting: NonNullable<LaunchIntent['hosting']>, id: string) => boolean }) {}

  /** Read-only Stripe verification followed by release of the exact unused
   * local reservation. A completed/paid/customer subscription never qualifies. */
  async expireSession(sessionId: string): Promise<{ released: boolean }> {
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw Error('Invalid checkout session identity');
    const c = this.billing.config(), mode = c.mode;
    const api = new EarnStripeApi(c.stripe[mode].secretKey, this.fetcher);
    const remote = await api.call('GET', '/v1/checkout/sessions/' + sessionId);
    if (remote.id !== sessionId || remote.livemode !== (mode === 'live') || remote.status !== 'expired' || remote.payment_status !== 'unpaid' || remote.subscription || remote.payment_intent) throw Error('Only an expired unpaid checkout without a subscription can release a reservation');
    const intent = launchGrant(this.dataDir, remote.metadata ?? {}, mode === 'live');
    if (!intent?.hosting || remote.metadata?.bundle !== 'software-hosting-v2' || remote.metadata?.reservation !== intent.hosting.reservationId || remote.client_reference_id !== intent.id || remote.mode !== intent.stripeParams.mode || intent.sessionId && intent.sessionId !== sessionId) throw Error('Expired checkout does not match its durable hosted intent');
    const lines = await api.call('GET', '/v1/checkout/sessions/' + sessionId + '/line_items', { limit: 3 });
    const expected = new Set([intent.hosting.softwarePriceId, intent.hosting.hostingPriceId]);
    if (lines.has_more || lines.data?.length !== 2 || lines.data.some((l: StripeObject) => l.quantity !== 1 || !expected.delete(l.price?.id)) || expected.size) throw Error('Expired checkout prices differ from its durable proof');
    if (this.billing.config().mode !== mode) throw Error('Billing mode changed during expiry reconciliation');
    intent.sessionId = sessionId; intent.expiredAtMs ??= this.now(); writeJsonAtomic(intentPath(this.dataDir, intent.id), intent);
    if (!this.hosted?.release?.(intent.hosting, intent.id)) throw Error('Expired reservation has changed; review required');
    if (intent.licenseId) {
      const claim = claimPath(this.dataDir, mode, intent.licenseId), current = readJson<{id:string}|null>(claim, null);
      if (current?.id === intent.id) fs.rmSync(claim);
    }
    return { released: true };
  }


  private allModes(): Record<BillingMode, LaunchMode> {
    return readJson(configPath(this.dataDir), { test: blankMode(), live: blankMode() });
  }
  private modeConfig(mode = this.billing.config().mode): LaunchMode {
    const stored = this.allModes()[mode] ?? blankMode();
    return { ...stored, cryptoCapable: stored.cryptoCapable ?? stored.cryptoEnabled };
  }
  private saveMode(mode: BillingMode, config: LaunchMode): void {
    const all = this.allModes(); all[mode] = config; writeJsonAtomic(configPath(this.dataDir), all);
  }
  private api(mode: BillingMode): EarnStripeApi {
    const key = this.billing.config().stripe[mode].secretKey;
    if (!key) throw Error('Stripe is not configured for this mode');
    return new EarnStripeApi(key, this.fetcher);
  }
  status(): Record<string, unknown> {
    const cfg = this.billing.config(), mode = this.modeConfig(cfg.mode);
    return { ...this.offer(), mode: cfg.mode, enabled: mode.enabled, cryptoEnabled: mode.cryptoEnabled,
      cryptoCapable: mode.cryptoCapable, prepared: BASE_PLANS.every(k => !!mode.prices[k]) };
  }
  offer(): Record<string, unknown> {
    const mode = this.modeConfig();
    return { active: mode.enabled && this.now() < LAUNCH_REDEEM_UNTIL_MS,
      firstPaymentAtMs: LAUNCH_FIRST_PAYMENT_MS,
      redeemUntilMs: LAUNCH_REDEEM_UNTIL_MS, cryptoEnabled: mode.enabled && mode.cryptoEnabled,
      hostingCheckoutEnabled: this.hosted?.ready() === true };
  }
  publicPlans(): Record<string, unknown> {
    const result = this.billing.publicPlans(), mode = this.modeConfig();
    return { ...result, launch: this.offer(), plans: (result.plans as Record<string, unknown>[]).map(plan => {
      const base = BASE_PLANS.includes(String(plan.key));
      return { ...plan, available: plan.available === true || base && !!this.billing.config().stripe[this.billing.config().mode].priceIds[String(plan.key)], cryptoAvailable: base && plan.key !== 'monthly' && mode.enabled && mode.cryptoEnabled };
    }) };
  }
  setEnabled(enabled: boolean, cryptoEnabled: boolean): void {
    const mode = this.billing.config().mode, cfg = this.modeConfig(mode);
    if (enabled && !BASE_PLANS.every(k => cfg.prices[k])) throw Error('Prepare the launch checkout prices first');
    if (cryptoEnabled && !cfg.cryptoCapable) throw Error('Verify Stripe crypto capability before enabling crypto');
    this.saveMode(mode, { ...cfg, enabled, cryptoEnabled });
  }

  /** Reuse and validate existing prices; never silently change the amount
   * on a live offer. Private promotion codes are managed separately in Stripe. */
  async prepare(): Promise<Record<string, unknown>> {
    const cfg = this.billing.config(), mode = cfg.mode, api = this.api(mode), old = this.modeConfig(mode);
    const prices: LaunchMode['prices'] = {};
    let links: StripeObject[] | null = null;
    for (const key of BASE_PLANS) {
      const plan = cfg.plans.find(p => p.key === key && p.role === 'software' && p.checkout === 'payment-link');
      if (!plan) throw Error(`Software plan ${key} is missing`);
      let price: StripeObject | null = null;
      const priceId = cfg.stripe[mode].priceIds[key];
      if (priceId) price = await api.call('GET', `/v1/prices/${priceId}`);
      if (!price) {
        if (!links) {
          links = []; let after = '';
          for (let page = 0; page < 20; page++) {
            const list = await api.call('GET', '/v1/payment_links', { active: true, limit: 100, ...(after ? { starting_after: after } : {}) });
            links.push(...list.data); if (!list.has_more) break;
            after = list.data.at(-1)?.id; if (!after || page === 19) throw Error('Payment link list is incomplete');
          }
        }
        const link = links.find(l => l.url === paymentLinkFor(cfg, mode, key));
        if (!link) throw Error(`No matching Stripe payment link for ${key}`);
        const lines = await api.call('GET', `/v1/payment_links/${link.id}/line_items`, { limit: 2 });
        if (lines.has_more || lines.data?.length !== 1 || lines.data[0].quantity !== 1) throw Error(`Plan ${key} has unexpected line items`);
        price = lines.data[0].price;
      }
      if (!price || !price.active || price.unit_amount !== plan.amountCents || price.currency !== plan.currency ||
        (price.recurring?.interval ?? null) !== plan.interval || (price.recurring && price.recurring.interval_count !== 1)) {
        throw Error(`Stripe ${key} price differs from the Hub catalogue`);
      }
      const product = typeof price.product === 'string' ? price.product : price.product?.id;
      if (!/^prod_[A-Za-z0-9]+$/.test(product)) throw Error('Invalid software product');
      // Legacy hosting prices shared this software product. Preserve their
      // classification; HostedOffer proves NEW VPS products are disjoint.
      prices[key] = { id: price.id, product, amount: price.unit_amount, currency: price.currency, interval: plan.interval };
    }
    const products = [...new Set(Object.values(prices).map(p => p.product))].sort();
    const account = await api.call('GET', '/v1/account');
    const cryptoEnabled = account.capabilities?.crypto_payments === 'active';
    const fresh = this.billing.config();
    if (JSON.stringify([fresh.mode,fresh.plans,fresh.stripe[mode].priceIds,fresh.stripe[mode].secretKey]) !== JSON.stringify([cfg.mode,cfg.plans,cfg.stripe[mode].priceIds,cfg.stripe[mode].secretKey])) throw Error('Billing configuration changed during preparation; prepare again');
    const currentOffer = this.modeConfig(mode);
    this.saveMode(mode, { ...currentOffer, prices, cryptoCapable: cryptoEnabled, cryptoEnabled: currentOffer.cryptoEnabled && cryptoEnabled });
    this.billing.updateConfig({ stripe: { [mode]: { priceIds: { ...cfg.stripe[mode].priceIds, ...Object.fromEntries(Object.entries(prices).map(([k,p]) => [k,p.id])) } } },
      roles: { [mode]: { software: { priceIds: [...new Set([...fresh.roles[mode].software.priceIds, ...Object.values(prices).map(p => p.id)])],
        productIds: [...new Set([...fresh.roles[mode].software.productIds, ...products.filter(product => !fresh.roles[mode].hosting.productIds.includes(product))])] } } } });
    return this.status();
  }

  checkout(input: { plan?: unknown; payment?: unknown; attemptId?: unknown; licenseId?: unknown; token?: unknown; referral?: unknown; hosting?: unknown }): Promise<{ ok: true; url: string }> {
    if (typeof input.attemptId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.attemptId)) return Promise.reject(Error('A checkout attempt ID is required'));
    if (input.hosting !== undefined && typeof input.hosting !== 'boolean') return Promise.reject(Error('Invalid hosting choice'));
    const mode = this.billing.config().mode, id = sha(`${mode}:${input.attemptId}`);
    // Requests sharing a network retry identity must also share all inputs.
    const identity = [input.plan, input.payment, input.licenseId ?? null, input.token ? sha(String(input.token)) : null, input.referral ?? null];
    const legacyRequestHash = sha(JSON.stringify(identity));
    if (input.hosting === true) identity.push('hosting-v2');
    const prior = readJson<LaunchIntent | null>(intentPath(this.dataDir,id), null);
    const requestHash = prior && prior.hostingRequested === undefined && prior.requestHash === legacyRequestHash ? legacyRequestHash : sha(JSON.stringify(identity));
    if (prior && prior.requestHash !== requestHash) return Promise.reject(Error('Checkout attempt already belongs to another request'));
    const flight = this.flights.get(id);
    if (flight) return flight.requestHash === requestHash ? flight.promise : Promise.reject(Error('Checkout attempt already belongs to another request'));
    const run = this.createCheckout(input, id, requestHash, legacyRequestHash).finally(() => this.flights.delete(id));
    this.flights.set(id, { requestHash, promise: run }); return run;
  }

  private async createCheckout(input: { plan?: unknown; payment?: unknown; licenseId?: unknown; token?: unknown; referral?: unknown; hosting?: unknown }, id: string, requestHash: string, legacyRequestHash: string): Promise<{ ok: true; url: string }> {
    const cfg = this.billing.config(), mode = cfg.mode, launch = this.modeConfig(mode), now = this.now();
    let intent = readJson<LaunchIntent | null>(intentPath(this.dataDir, id), null);
    const withHosting = intent ? !!intent.hosting : input.hosting === true;

    const plan = cfg.plans.find(p => p.key === input.plan && BASE_PLANS.includes(p.key) && p.role === 'software') as Plan | undefined;
    if (!plan || (input.payment !== 'card' && input.payment !== 'crypto')) throw Error('Choose a software plan and payment method');
    const crypto = input.payment === 'crypto';
    if (withHosting && crypto) throw Error('Managed VPS plans require card checkout');
    if (crypto && (plan.key === 'monthly' || !launch.enabled || !launch.cryptoEnabled)) throw Error('Crypto is available for Yearly and Lifetime only');
    let price = launch.prices[plan.key];
    if (!intent && !withHosting && !launch.enabled) {
      const priceId = cfg.stripe[mode].priceIds[plan.key];
      if (!priceId) throw Error('Software price is not configured');
      const actual = await new EarnStripeApi(cfg.stripe[mode].secretKey, this.fetcher).call('GET', '/v1/prices/' + priceId);
      if (actual.id !== priceId || actual.livemode !== (mode === 'live') || actual.type !== (plan.interval ? 'recurring' : 'one_time') || !/^prod_[A-Za-z0-9]+$/.test(typeof actual.product === 'string' ? actual.product : actual.product?.id) || actual.active !== true || actual.currency !== plan.currency || actual.unit_amount !== plan.amountCents || (actual.recurring?.interval ?? null) !== plan.interval || actual.recurring && actual.recurring.interval_count !== 1) throw Error('Software price differs from the approved catalogue');
      price = { id: priceId, product: typeof actual.product === 'string' ? actual.product : actual.product?.id, amount: plan.amountCents, currency: plan.currency, interval: plan.interval };
      if (this.billing.config().mode !== mode || this.billing.config().stripe[mode].priceIds[plan.key] !== priceId) throw Error('Billing prices changed during checkout verification');
    }
    if (!withHosting && (!price || price.amount !== plan.amountCents || price.currency !== plan.currency)) throw Error('Plan changed; prepare the checkout prices again');
    let selectedReferral: { code: string; promotionId: string; discountPercent: number } | null = null;
    if (!intent && input.referral) {
      if (typeof input.referral !== 'string' || input.referral.length > 128 || !this.resolveReferral) throw Error('Invalid referral code');
      selectedReferral = this.resolveReferral(input.referral, mode);
    }
    let licenseId: string | null = null;
    if (input.licenseId || input.token) {
      const payload = this.licenses.decodeGenuine(typeof input.token === 'string' ? input.token : '');
      if (!payload || payload.id !== input.licenseId || !this.licenses.get(payload.id) || this.licenses.isRevoked(payload.id)) throw Error('Invalid license authentication');
      licenseId = payload.id;
      const customer = this.billing.store.findByLicense(licenseId);
      if (customer && customer.livemode !== (mode === 'live')) throw Error('This license is already bound in another Stripe mode');
      if (!intent && customer?.subscriptionId && customer.subscriptionStatus !== 'canceled') throw Error('Use Manage subscription for your existing subscription');
      if (!intent && customer?.lifetimeAccess) throw Error('This license already has Lifetime access');
      const file = claimPath(this.dataDir, mode, licenseId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let claim = readJson<{ id: string; createdAtMs: number } | null>(file, null);
      if (claim && claim.id !== id) {
        const old = readJson<LaunchIntent | null>(intentPath(this.dataDir, claim.id), null);
        if (old?.sessionId && customer?.chargeIds.includes(`cs:${old.sessionId}`)) {
          fs.unlinkSync(file);
          claim = null;
        } else if (old?.url && (old.requestHash === requestHash || old.hostingRequested === undefined && old.requestHash === legacyRequestHash) && old.mode === mode && old.licenseId === licenseId && old.plan === plan.key && old.payment === input.payment &&
          now - old.createdAtMs < 23 * 3600_000) return { ok: true, url: old.url };
        else if (old?.sessionId && now - old.createdAtMs >= 24 * 3600_000) {
          const priorSession = await this.api(mode).call('GET', `/v1/checkout/sessions/${old.sessionId}`);
          if (priorSession.id === old.sessionId && priorSession.status === 'expired') {
            fs.unlinkSync(file);
            claim = null;
          }
        }
      }
      if (!claim) {
        try { fs.writeFileSync(file, JSON.stringify({ id, createdAtMs: now }), { flag: 'wx', mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        claim = readJson<{ id: string; createdAtMs: number } | null>(file, null);
      }
      if (!claim || claim.id !== id) throw Error('A checkout is already pending for this license; continue that checkout or contact support');
    }
    if (intent?.url) {
      if (intent.expiredAtMs) throw Error('This hosted checkout expired; start a new attempt');
      if (intent.hosting && now >= intent.hosting.expiresAtMs) throw Error('This hosted checkout expired; start a new attempt');
      if (now - intent.createdAtMs >= 23 * 3600_000) throw Error('This checkout expired; start a new attempt');
      return { ok: true, url: intent.url };
    }
    if (intent && now - intent.createdAtMs >= 23 * 3600_000) throw Error('Checkout requires reconciliation before retrying');
    if (!intent) {
      let hosting: LaunchIntent['hosting'];
      if (withHosting) {
        if (!this.hosted?.ready()) throw Error('Managed VPS checkout is not available yet');
        const customer = licenseId ? this.billing.store.findByLicense(licenseId) : null;
        hosting = await this.hosted.prepare(plan.key, id, customer?.stripeCustomerId);
        price = { id: hosting.softwarePriceId, product: hosting.softwareProductId, amount: hosting.softwareAmountCents, currency: 'usd', interval: plan.interval };
      }
      const softwareSubscription = !crypto && !!plan.interval;
      const subscription = withHosting || softwareSubscription;
      const firstPayment = !withHosting && launch.enabled && softwareSubscription && now < LAUNCH_FIRST_PAYMENT_MS ? LAUNCH_FIRST_PAYMENT_MS : null;
      let discount = 0;
      let promotionId = '';
      let referral: { code: string; promotionId: string; discountPercent: number } | null = null;
      if (selectedReferral) {
        referral = selectedReferral;
        // Referral coupons cover recurring software. An applied referral
        // occupies Stripe's single promotion slot for this checkout.
        discount = referral.discountPercent; promotionId = referral.promotionId;
      }
      const metadata: Record<string,string> = { managed_by: 'wh-launch', plan: plan.key, wh_launch_intent: id,
        ...(promotionId ? { launch_discount_percent: String(discount) } : {}), ...(referral && softwareSubscription ? { wh_earn_code: referral.code } : {}), ...(firstPayment ? { first_payment_at_ms: String(firstPayment) } : {}),
        ...(hosting ? { bundle: 'software-hosting-v2', reservation: hosting.reservationId } : {}),
        ...(!softwareSubscription ? { non_renewing: 'true', license_days: String(plan.key === 'yearly' ? 365 : plan.licenseDays) } : {}) };
      const params: StripeObject = { mode: subscription ? 'subscription' : 'payment',
        client_reference_id: id,
        success_url: `${this.origin}/customer?checkout=complete`, cancel_url: 'https://www.wickhunterunleashed.com/unleashed/#pricing',
        'payment_method_types[0]': crypto ? 'crypto' : 'card', 'line_items[0][quantity]': 1,
        'consent_collection[terms_of_service]': 'required' };
      const cutoff = firstPayment ?? LAUNCH_REDEEM_UNTIL_MS;
      if (cutoff - now >= 30 * 60_000 && cutoff - now <= 24 * 3600_000) params.expires_at = cutoff / 1000;
      const customer = licenseId ? this.billing.store.findByLicense(licenseId) : null;
      if (customer?.stripeCustomerId?.startsWith('cus_') && customer.livemode === (mode === 'live')) params.customer = customer.stripeCustomerId;
      if (crypto && plan.interval) {
        params['line_items[0][price_data][product]'] = price.product;
        params['line_items[0][price_data][unit_amount]'] = price.amount;
        params['line_items[0][price_data][currency]'] = price.currency;
      } else params['line_items[0][price]'] = price.id;
      if (hosting) { params['line_items[1][price]'] = hosting.hostingPriceId; params['line_items[1][quantity]'] = 1; params.expires_at = hosting.expiresAtMs / 1000; }
      if (subscription) {
        params.payment_method_collection = 'always';
        if (firstPayment) { params['subscription_data[billing_cycle_anchor]'] = firstPayment / 1000; params['subscription_data[proration_behavior]'] = 'none'; }
      } else if (!params.customer) params.customer_creation = 'always';
      if (promotionId) params['discounts[0][promotion_code]'] = promotionId;
      else params.allow_promotion_codes = true;
      for (const [key,value] of Object.entries(metadata)) {
        params[`metadata[${key}]`] = value;
        if (subscription) params[`subscription_data[metadata][${key}]`] = value;
      }
      params['custom_text[submit][message]'] = subscription ? `${firstPayment ? 'Free until October 15, 2026 (Eastern Time). First charge then. ' : ''}${discount ? `${discount}% off the base subscription price on every renewal while this subscription remains active. ` : ''}Automatically renews ${plan.interval === 'year' ? 'yearly' : 'monthly'} until canceled. Cancel in Manage subscription.` : `One payment. No automatic renewal.${crypto && plan.key === 'yearly' && now < LAUNCH_FIRST_PAYMENT_MS ? ' Access through October 15, 2027.' : ''}`;
      if (hosting) params['custom_text[submit][message]'] = plan.key === 'lifetime'
        ? 'Lifetime software is one payment. VPS is charged today and renews at $20/month until canceled. Software promotion codes exclude VPS. VPS plans bill immediately due to VPS provider fees. Canceling VPS does not end paid Lifetime software access.'
        : `Software and VPS bill today and renew together ${plan.interval === 'year' ? 'yearly' : 'monthly'} until canceled. VPS is ${plan.interval === 'year' ? '$240/year' : '$20/month'}; software promotion codes exclude VPS. VPS plans bill immediately due to VPS provider fees. Cancel in Manage subscription.`;
      intent = { id, mode, plan: plan.key, payment: input.payment as 'card'|'crypto', licenseId, requestHash, createdAtMs: now,
        firstPaymentAtMs: firstPayment, accessUntilMs: crypto && plan.key === 'yearly' && now < LAUNCH_FIRST_PAYMENT_MS ? LAUNCH_YEARLY_END_MS : null,
        discountPercent: discount, hostingRequested: withHosting, ...(hosting ? { hosting } : {}), stripeParams: params };
      writeJsonAtomic(intentPath(this.dataDir,id), intent);
    }
    if (intent.hosting) this.hosted!.bind(intent.hosting, intent.stripeParams);
    const session = await this.api(mode).call('POST', '/v1/checkout/sessions', intent.stripeParams, { key: `wh-launch-checkout-${id}` });
    let url: URL; try { url = new URL(session.url); } catch { throw Error('Stripe returned an invalid checkout URL'); }
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password || !/^cs_/.test(session.id)) throw Error('Stripe returned an invalid checkout session');
    intent.sessionId = session.id; intent.url = url.href; writeJsonAtomic(intentPath(this.dataDir,id), intent);
    return { ok: true, url: url.href };
  }
}
