import path from 'node:path';
import { readJson, writeJsonAtomic } from '../jsonfile.js';
import { EarnStripeApi } from '../earn-stripe-api.js';
import type { BillingService } from './service.js';
import type { BillingMode } from './config.js';

export interface HostedPriceProof {
  softwarePriceId: string;
  softwareProductId: string;
  softwareAmountCents: number;
  hostingPriceId: string;
  hostingProductId: string;
  hostingAmountCents: number;
  hostingInterval: 'month' | 'year';
}
interface PreparedHostedOffer { monthlyPriceId: string; yearlyPriceId: string; productId: string }
const file = (dir: string) => path.join(dir, 'billing-hosted-offer.v2.json');

/** Price creation is an operator-reviewed action. This verifier only reads
 * Stripe and saves an exact existing product/price pair for new checkouts.
 * Historical prices remain classified and historical requests immutable. */
export class HostedOffer {
  constructor(private dir: string, private billing: BillingService, private fetcher: typeof fetch = fetch) {}
  private prepared(mode: BillingMode): PreparedHostedOffer | null {
    return readJson<Partial<Record<BillingMode,PreparedHostedOffer>>>(file(this.dir), {})[mode] ?? null;
  }
  ready(): boolean {
    const c = this.billing.config(), p = this.prepared(c.mode);
    return !!p && c.roles[c.mode].hosting.priceIds.includes(p.monthlyPriceId) && c.roles[c.mode].hosting.priceIds.includes(p.yearlyPriceId)
      && c.roles[c.mode].hosting.productIds.includes(p.productId);
  }
  status() { return { prepared: this.ready(), mode: this.billing.config().mode, configured: this.prepared(this.billing.config().mode) }; }
  async verify(input: { monthlyPriceId?: unknown; yearlyPriceId?: unknown }): Promise<ReturnType<HostedOffer['status']>> {
    const c = this.billing.config(), mode = c.mode;
    if (typeof input.monthlyPriceId !== 'string' || typeof input.yearlyPriceId !== 'string' || !/^price_[A-Za-z0-9]+$/.test(input.monthlyPriceId) || !/^price_[A-Za-z0-9]+$/.test(input.yearlyPriceId)) throw Error('Provide the verified monthly and yearly VPS price IDs');
    const prepared = { monthlyPriceId: input.monthlyPriceId, yearlyPriceId: input.yearlyPriceId, productId: '' };
    const month = await this.prove('monthly', prepared), year = await this.prove('yearly', prepared);
    if (month.hostingProductId !== year.hostingProductId) throw Error('VPS prices must use one separate hosting product');
    await this.prove('lifetime', prepared);
    prepared.productId = month.hostingProductId;
    const fresh = this.billing.config();
    const identity = (cfg: typeof c) => JSON.stringify([cfg.mode, cfg.plans.filter(p => ['monthly','yearly','lifetime'].includes(p.key)), cfg.stripe[mode].priceIds, cfg.stripe[mode].secretKey]);
    if (identity(fresh) !== identity(c)) throw Error('Billing prices or mode changed during verification; verify again');
    // Do not delete old classified prices: legacy renewals remain valid.
    this.billing.updateConfig({ roles: { [mode]: { hosting: {
      priceIds: [...new Set([...fresh.roles[mode].hosting.priceIds, prepared.monthlyPriceId, prepared.yearlyPriceId])],
      productIds: [...new Set([...fresh.roles[mode].hosting.productIds, prepared.productId])],
    } } } });
    const all = readJson<Partial<Record<BillingMode,PreparedHostedOffer>>>(file(this.dir), {}); all[mode] = prepared; writeJsonAtomic(file(this.dir), all);
    return this.status();
  }
  async prove(planKey: string, prepared = this.prepared(this.billing.config().mode)): Promise<HostedPriceProof> {
    if (!prepared) throw Error('Verify the separate VPS prices before enabling combined checkout');
    const c = this.billing.config(), mode = c.mode;
    const plan = c.plans.find(p => p.key === planKey && p.role === 'software' && p.checkout === 'payment-link');
    if (!plan || !['monthly','yearly','lifetime'].includes(planKey)) throw Error('Choose a software plan');
    const softwarePriceId = c.stripe[mode].priceIds[planKey];
    if (!softwarePriceId) throw Error('Software price is not configured');
    const hostingInterval = planKey === 'yearly' ? 'year' : 'month';
    const hostingPriceId = hostingInterval === 'year' ? prepared.yearlyPriceId : prepared.monthlyPriceId;
    const api = new EarnStripeApi(c.stripe[mode].secretKey, this.fetcher);
    const sw = await api.call('GET', '/v1/prices/' + softwarePriceId), host = await api.call('GET', '/v1/prices/' + hostingPriceId);
    const product = (p: any) => typeof p.product === 'string' ? p.product : p.product?.id;
    const hostingAmountCents = hostingInterval === 'year' ? 24000 : 2000;
    if (sw.id !== softwarePriceId || sw.livemode !== (mode === 'live') || sw.active !== true || sw.type !== (plan.interval ? 'recurring' : 'one_time') || sw.unit_amount !== plan.amountCents || sw.currency !== 'usd' || (sw.recurring?.interval ?? null) !== plan.interval || sw.recurring && sw.recurring.interval_count !== 1) throw Error('Software price differs from the approved catalogue');
    if (host.id !== hostingPriceId || host.livemode !== (mode === 'live') || host.active !== true || host.type !== 'recurring' || host.unit_amount !== hostingAmountCents || host.currency !== 'usd' || host.recurring?.interval !== hostingInterval || host.recurring?.interval_count !== 1) throw Error('VPS price differs from the approved monthly/yearly offer');
    const softwareProductId = product(sw), hostingProductId = product(host);
    if (!/^prod_[A-Za-z0-9]+$/.test(softwareProductId) || !/^prod_[A-Za-z0-9]+$/.test(hostingProductId) || softwareProductId === hostingProductId || c.roles[mode].software.productIds.includes(hostingProductId)) throw Error('Software and VPS must use separate Stripe products');
    // A stale prepared product cannot silently move the VPS into coupon scope.
    if (prepared.productId && prepared.productId !== hostingProductId) throw Error('The prepared VPS product changed');
    const fresh = this.billing.config();
    if (JSON.stringify([fresh.mode,fresh.plans,fresh.stripe[mode].priceIds,fresh.stripe[mode].secretKey]) !== JSON.stringify([c.mode,c.plans,c.stripe[mode].priceIds,c.stripe[mode].secretKey])) throw Error("Billing prices changed during checkout verification; retry");
    return { softwarePriceId, softwareProductId, softwareAmountCents: plan.amountCents, hostingPriceId, hostingProductId, hostingAmountCents, hostingInterval };
  }
}
