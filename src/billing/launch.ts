import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../jsonfile.js';
import { EarnStripeApi, type StripeObject } from '../earn-stripe-api.js';
import type { LicenseStore } from '../license.js';
import type { BillingService } from './service.js';
import { paymentLinkFor, type BillingMode, type Plan } from './config.js';

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
  stripeParams: StripeObject;
  sessionId?: string;
  url?: string;
  hostingTokenHash?: string;
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
    const lines = await api.call('GET', `/v1/checkout/sessions/${sessionId}/line_items`, { limit: 2 });
    const price = intent.stripeParams['line_items[0][price]'];
    const dynamic = intent.stripeParams['line_items[0][price_data][product]'];
    const line = lines.data?.[0];
    if (lines.has_more || lines.data?.length !== 1 || line?.quantity !== 1 ||
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
    private resolveReferral?: (code: string, mode: BillingMode) => { code: string; promotionId: string; discountPercent: number }) {}

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
      hostingCheckoutEnabled: mode.enabled };
  }
  publicPlans(): Record<string, unknown> {
    const result = this.billing.publicPlans(), mode = this.modeConfig();
    return { ...result, launch: this.offer(), plans: (result.plans as Record<string, unknown>[]).map(plan => {
      const base = BASE_PLANS.includes(String(plan.key));
      return { ...plan, cryptoAvailable: base && plan.key !== 'monthly' && mode.enabled && mode.cryptoEnabled };
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
      if (cfg.roles[mode].hosting.productIds.includes(product)) throw Error('Software and hosting must use separate Stripe products');
      prices[key] = { id: price.id, product, amount: price.unit_amount, currency: price.currency, interval: plan.interval };
    }
    const products = [...new Set(Object.values(prices).map(p => p.product))].sort();
    const account = await api.call('GET', '/v1/account');
    const cryptoEnabled = account.capabilities?.crypto_payments === 'active';
    this.saveMode(mode, { ...old, prices, cryptoCapable: cryptoEnabled, cryptoEnabled: old.cryptoEnabled && cryptoEnabled });
    this.billing.updateConfig({ stripe: { [mode]: { priceIds: { ...cfg.stripe[mode].priceIds, ...Object.fromEntries(Object.entries(prices).map(([k,p]) => [k,p.id])) } } },
      roles: { [mode]: { software: { priceIds: [...new Set([...cfg.roles[mode].software.priceIds, ...Object.values(prices).map(p => p.id)])],
        productIds: [...new Set([...cfg.roles[mode].software.productIds, ...products])] } } } });
    return this.status();
  }

  checkout(input: { plan?: unknown; payment?: unknown; attemptId?: unknown; licenseId?: unknown; token?: unknown; referral?: unknown; hosting?: unknown }): Promise<{ ok: true; url: string }> {
    if (input.hosting !== undefined && typeof input.hosting !== 'boolean') return Promise.reject(Error('Invalid hosting selection'));
    if (typeof input.attemptId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.attemptId)) return Promise.reject(Error('A checkout attempt ID is required'));
    const mode = this.billing.config().mode, id = sha(`${mode}:${input.attemptId}`);
    // Requests sharing a network retry identity must also share all inputs.
    const identity = [input.plan, input.payment, input.licenseId ?? null, input.token ? sha(String(input.token)) : null, input.referral ?? null];
    if (input.hosting === true) identity.push('hosting-monthly');
    const requestHash = sha(JSON.stringify(identity));
    const prior = readJson<LaunchIntent | null>(intentPath(this.dataDir,id), null);
    if (prior && prior.requestHash !== requestHash) return Promise.reject(Error('Checkout attempt already belongs to another request'));
    const flight = this.flights.get(id);
    if (flight) return flight.requestHash === requestHash ? flight.promise : Promise.reject(Error('Checkout attempt already belongs to another request'));
    const run = this.createCheckout(input, id, requestHash).finally(() => this.flights.delete(id));
    this.flights.set(id, { requestHash, promise: run }); return run;
  }

  private async createCheckout(input: { plan?: unknown; payment?: unknown; licenseId?: unknown; token?: unknown; referral?: unknown; hosting?: unknown }, id: string, requestHash: string): Promise<{ ok: true; url: string }> {
    const cfg = this.billing.config(), mode = cfg.mode, launch = this.modeConfig(mode), now = this.now();
    if (!launch.enabled) throw Error('Launch checkout is not enabled yet');
    const plan = cfg.plans.find(p => p.key === input.plan && BASE_PLANS.includes(p.key) && p.role === 'software') as Plan | undefined;
    if (!plan || (input.payment !== 'card' && input.payment !== 'crypto')) throw Error('Choose a software plan and payment method');
    const crypto = input.payment === 'crypto';
    if (crypto && (plan.key === 'monthly' || !launch.cryptoEnabled)) throw Error('Crypto is available for Yearly and Lifetime only');
    const price = launch.prices[plan.key];
    if (!price || price.amount !== plan.amountCents || price.currency !== plan.currency) throw Error('Plan changed; prepare the checkout prices again');
    let intent = readJson<LaunchIntent | null>(intentPath(this.dataDir, id), null);
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
        } else if (old?.url && old.mode === mode && old.licenseId === licenseId && old.plan === plan.key && old.payment === input.payment &&
          !!old.hostingTokenHash === (input.hosting === true) &&
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
      if (now - intent.createdAtMs >= 23 * 3600_000) throw Error('This checkout expired; start a new attempt');
      return { ok: true, url: intent.url };
    }
    if (intent && now - intent.createdAtMs >= 23 * 3600_000) throw Error('Checkout requires reconciliation before retrying');
    if (!intent) {
      const subscription = !crypto && !!plan.interval;
      const firstPayment = subscription && now < LAUNCH_FIRST_PAYMENT_MS ? LAUNCH_FIRST_PAYMENT_MS : null;
      let discount = 0;
      let promotionId = '';
      let referral: { code: string; promotionId: string; discountPercent: number } | null = null;
      if (input.referral) {
        if (typeof input.referral !== 'string' || input.referral.length > 128 || !this.resolveReferral) throw Error('Invalid referral code');
        referral = this.resolveReferral(input.referral, mode);
        // Referral coupons cover recurring software. An applied referral
        // occupies Stripe's single promotion slot for this checkout.
        if (subscription) { discount = referral.discountPercent; promotionId = referral.promotionId; }
      }
      const metadata: Record<string,string> = { managed_by: 'wh-launch', plan: plan.key, wh_launch_intent: id,
        ...(promotionId ? { launch_discount_percent: String(discount) } : {}), ...(referral && subscription ? { wh_earn_code: referral.code } : {}), ...(firstPayment ? { first_payment_at_ms: String(firstPayment) } : {}),
        ...(!subscription ? { non_renewing: 'true', license_days: String(plan.key === 'yearly' ? 365 : plan.licenseDays) } : {}) };
      const params: StripeObject = { mode: subscription ? 'subscription' : 'payment',
        client_reference_id: id,
        success_url: `${this.origin}/customer?checkout=complete`, cancel_url: 'https://www.wickhunterunleashed.com/unleashed/#pricing',
        'payment_method_types[0]': crypto ? 'crypto' : 'card', 'line_items[0][quantity]': 1,
        'consent_collection[terms_of_service]': 'required' };
      const hostingToken = input.hosting === true ? randomBytes(32).toString('hex') : null;
      if (hostingToken) params.success_url = `${this.origin}/checkout/hosting#intent=${id}&token=${hostingToken}`;
      const cutoff = firstPayment ?? LAUNCH_REDEEM_UNTIL_MS;
      if (cutoff - now >= 30 * 60_000 && cutoff - now <= 24 * 3600_000) params.expires_at = cutoff / 1000;
      const customer = licenseId ? this.billing.store.findByLicense(licenseId) : null;
      if (customer?.stripeCustomerId?.startsWith('cus_') && customer.livemode === (mode === 'live')) params.customer = customer.stripeCustomerId;
      if (crypto && plan.interval) {
        params['line_items[0][price_data][product]'] = price.product;
        params['line_items[0][price_data][unit_amount]'] = price.amount;
        params['line_items[0][price_data][currency]'] = price.currency;
      } else params['line_items[0][price]'] = price.id;
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
      if (hostingToken) params['custom_text[submit][message]'] += ' Next: confirm VPS hosting in a separate card checkout. Hosting starts billing immediately and renews monthly.';
      intent = { id, mode, plan: plan.key, payment: input.payment as 'card'|'crypto', licenseId, requestHash, createdAtMs: now,
        firstPaymentAtMs: firstPayment, accessUntilMs: crypto && plan.key === 'yearly' && now < LAUNCH_FIRST_PAYMENT_MS ? LAUNCH_YEARLY_END_MS : null,
        discountPercent: discount, stripeParams: params, ...(hostingToken ? { hostingTokenHash: sha(hostingToken) } : {}) };
      writeJsonAtomic(intentPath(this.dataDir,id), intent);
    }
    const session = await this.api(mode).call('POST', '/v1/checkout/sessions', intent.stripeParams, { key: `wh-launch-checkout-${id}` });
    let url: URL; try { url = new URL(session.url); } catch { throw Error('Stripe returned an invalid checkout URL'); }
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password || !/^cs_/.test(session.id)) throw Error('Stripe returned an invalid checkout session');
    intent.sessionId = session.id; intent.url = url.href; writeJsonAtomic(intentPath(this.dataDir,id), intent);
    return { ok: true, url: url.href };
  }

  /** The return link authorizes only the selected hosting checkout. Stripe
   * verifies payment; the normal webhook must grant software before hosting. */
  async hostingCustomer(input: { intent?: unknown; token?: unknown }): Promise<{ ownerId: string; email: string } | null> {
    if (typeof input.intent !== 'string' || !/^[a-f0-9]{64}$/.test(input.intent)
      || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token)) throw Error('Invalid hosting checkout link');
    const intent = readJson<LaunchIntent | null>(intentPath(this.dataDir, input.intent), null);
    if (!intent?.hostingTokenHash || intent.hostingTokenHash !== sha(input.token)
      || intent.mode !== this.billing.config().mode) throw Error('Invalid hosting checkout link');
    if (this.now() - intent.createdAtMs > 48 * 3600_000) throw Error('This checkout link expired. Add hosting from your customer dashboard.');
    if (!intent.sessionId) return null;
    const session = await this.api(intent.mode).call('GET', `/v1/checkout/sessions/${intent.sessionId}`);
    if (session.id !== intent.sessionId || session.client_reference_id !== intent.id
      || session.metadata?.wh_launch_intent !== intent.id || session.metadata?.plan !== intent.plan
      || session.livemode !== (intent.mode === 'live') || session.mode !== intent.stripeParams.mode) throw Error('Software checkout could not be verified');
    if (session.status === 'expired') throw Error('Software checkout expired. Start again from the plans page.');
    if (session.status !== 'complete' || !['paid', 'no_payment_required'].includes(session.payment_status)
      || (session.mode === 'payment' && session.payment_status !== 'paid')) return null;
    if (typeof session.customer !== 'string' || !/^cus_[A-Za-z0-9_]+$/.test(session.customer)) throw Error('Software checkout has no customer');
    const customer = this.billing.store.findByStripeCustomer(session.customer);
    if (!customer || customer.livemode !== (intent.mode === 'live')) return null;
    const fulfilled = session.mode === 'payment'
      ? this.billing.store.getCheckoutSession(intent.sessionId)?.status === 'applied'
      : customer.subscriptionId === session.subscription && customer.chargeIds.includes(`cs:${intent.sessionId}`);
    if (!fulfilled) return null;
    return { ownerId: session.customer, email: customer.email };
  }
}
