import { referralMonthlyIncome, type ReferralIncomeScope } from '../earn-monthly-income.js';
// Launch-only recurring revenue view. BillingStore remains the authority for
// which software customers/subscriptions are known; Stripe reads are through
// EarnStripeApi and are always read-only. No email, token, webhook secret, or
// provider error body crosses this module's output boundary.
import { launchGrant } from './launch.js';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../jsonfile.js';
import { EarnStripeApi, type StripeObject } from '../earn-stripe-api.js';
import type { BillingConfig, BillingMode } from './config.js';
import type { BillingStore, CustomerRecord } from './store.js';
import { checkoutDiscountPercent, checkoutFacts, invoiceFacts, subscriptionFacts, type StripeEvent } from './stripe.js';
import type { NotificationInput } from '../notifications.js';

const REPORT_FILE = 'launch-billing-report.v1.json';
const MODES: readonly BillingMode[] = ['test', 'live'];
const id = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'object' && v !== null ? String((v as StripeObject).id || '') : '';

interface LineFact { currency: string; amountMinor: number; months: number }
interface SubscriptionFact {
  mode: BillingMode; customerId: string; subscriptionId: string; plan: string; status: string;
  cancelAtPeriodEnd: boolean; currentPeriodEndMs: number | null; firstPaymentAtMs: number | null;
  discountPercent: number | null; currency: string | null; grossMrrMinor: number | null; netMrrMinor: number | null;
  linesKnown: boolean; updatedAtMs: number;
}
interface Persisted {
  schema: 1; facts: SubscriptionFact[]; signupSent: Record<string, string>; lastRefreshAtMs: Partial<Record<BillingMode, number>>;
  lastRefreshError: Partial<Record<BillingMode, string>>;
}
const fresh = (): Persisted => ({ schema: 1, facts: [], signupSent: {}, lastRefreshAtMs: {}, lastRefreshError: {} });

function minorAmount(value: unknown): number | null {
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    const n = Number(value); return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
  }
  return null;
}
function monthSpan(interval: unknown, count: unknown): number | null {
  if (!Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 120) return null;
  if (interval === 'month') return Number(count);
  if (interval === 'year') return 12 * Number(count);
  return null;
}
function discountPercentFromStripe(raw: StripeObject, now: number): number | null {
  // Metadata records the original offer; the live discount may have been
  // removed or changed in Stripe. Revenue must follow current Stripe facts.
  const discounts = Array.isArray(raw.discounts) ? raw.discounts
    : raw.discount === null ? [] : raw.discount ? [raw.discount] : null;
  if (discounts === null) return null;
  let remaining = 1;
  for (const discount of discounts) {
    if (typeof discount !== 'object' || !discount) return null;
    if (Number.isFinite(discount.end) && discount.end * 1000 <= now) continue;
    const source = discount?.source;
    const coupon = discount?.coupon ?? source?.coupon ?? (source?.type === 'coupon' ? source.coupon : null);
    const percent = coupon?.percent_off;
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100 || coupon?.amount_off != null) return null;
    // Fixed/one-invoice discounts and mixed product applicability require a
    // full invoice projection. Expose unknown instead of guessing an MRR.
    if (coupon.duration === 'once') return null;
    if (coupon.applies_to?.products && raw.items?.data?.some((item: StripeObject) => !coupon.applies_to.products.includes(id(item.price?.product)))) return null;
    remaining *= (100 - percent) / 100;
  }
  return (1 - remaining) * 100;
}
function formatMinor(currency: string, minor: number): string {
  try {
    const fraction = new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: fraction })
      .format(minor / 10 ** fraction);
  } catch { return `${minor} minor units ${currency.toUpperCase()}`; }
}
function subscriptionLines(raw: StripeObject): LineFact[] | null {
  const items = raw.items?.data;
  if (!Array.isArray(items) || !items.length || raw.items.has_more) return null;
  const out: LineFact[] = [];
  for (const item of items) {
    const price = item?.price;
    const currency = typeof price?.currency === 'string' && /^[a-z]{3}$/.test(price.currency) ? price.currency : '';
    const unit = minorAmount(price?.unit_amount ?? price?.unit_amount_decimal);
    const quantity = Number.isSafeInteger(item?.quantity) && item.quantity >= 0 ? item.quantity : null;
    const months = monthSpan(price?.recurring?.interval, price?.recurring?.interval_count ?? 1);
    if (!currency || unit === null || months === null || quantity === null || price.recurring?.usage_type === 'metered') return null;
    out.push({ currency, amountMinor: unit * quantity, months });
  }
  return out;
}

export interface ReportingDeps {
  /** The event is already signature-verified and has completed BillingService. */
  enqueue?: (input: NotificationInput) => unknown;
}

export class LaunchBillingReporting {
  private readonly file: string;
  private state: Persisted;
  private tail: Promise<unknown> = Promise.resolve();
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation); this.tail = run.catch(() => {}); return run;
  }
  constructor(private readonly store: BillingStore, private readonly billing: () => BillingConfig,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now, private readonly deps: ReportingDeps = {}) {
    this.file = path.join(store.dataDir, REPORT_FILE);
    const raw = readJson<Persisted>(this.file, fresh());
    if (raw.schema !== 1 || !Array.isArray(raw.facts) || !raw.signupSent || typeof raw.signupSent !== 'object')
      throw new Error('Invalid launch reporting state');
    this.state = raw;
  }
  private save() { writeJsonAtomic(this.file, this.state); }
  private customers(mode: BillingMode): CustomerRecord[] {
    return Object.values(this.store.customers()).filter(c => c.livemode === (mode === 'live') && c.stripeCustomerId.startsWith('cus_'));
  }
  private softwareCustomers(mode: BillingMode): CustomerRecord[] {
    return Object.values(this.store.customers()).filter(c => c.livemode === (mode === 'live'));
  }
  private api(mode: BillingMode) {
    const key = this.billing().stripe[mode].secretKey;
    if (!key || !new RegExp(mode === 'live' ? '^sk_live_[A-Za-z0-9]+$|^rk_live_[A-Za-z0-9]+$' : '^sk_test_[A-Za-z0-9]+$|^rk_test_[A-Za-z0-9]+$').test(key))
      throw new Error('Stripe read credentials are not configured');
    return new EarnStripeApi(key, this.fetcher);
  }
  private putFact(fact: SubscriptionFact | null, mode: BillingMode, subId: string) {
    this.state.facts = this.state.facts.filter(f => !(f.mode === mode && f.subscriptionId === subId));
    if (fact) this.state.facts.push(fact);
    this.save();
    // Checkout cannot know which private code the buyer entered. Keep the
    // app's subscription card aligned with the verified Stripe subscription,
    // including a later removal or change of the discount.
    if (fact?.discountPercent !== null && fact?.discountPercent !== undefined) {
      const current = this.store.findByStripeCustomer(fact.customerId, mode === 'live');
      if (current?.launchManaged && current.subscriptionId === subId && current.discountPercent !== fact.discountPercent) {
        current.discountPercent = fact.discountPercent;
        this.store.putCustomer(current);
      }
    }
  }
  /** Refresh exact subscription facts for known software customers. Individual
   * failures are summarized without provider text; old facts remain marked by
   * their original timestamp and are not silently replaced with guesses. */
  refresh(mode?: BillingMode) { return this.serial(() => this.refreshNow(mode)); }
  private async refreshNow(mode?: BillingMode) {
    const modes = mode ? [mode] : [...MODES];
    for (const m of modes) {
      let failures = 0;
      try {
        const api = this.api(m);
        const known = this.customers(m);
        const knownSubscriptionIds = new Set(known.map(c => c.subscriptionId).filter((x): x is string => !!x));
        this.state.facts = this.state.facts.filter(f => f.mode !== m || knownSubscriptionIds.has(f.subscriptionId));
        for (const customer of known) {
          if (!customer.subscriptionId) continue;
          try {
            const fact = await this.pullWithApi(api, m, customer);
            this.putFact(fact, m, customer.subscriptionId);
          } catch { failures++; }
        }
        this.state.lastRefreshError[m] = failures ? `${failures} known subscription refresh(es) failed` : '';
        this.state.lastRefreshAtMs[m] = this.now(); this.save();
      } catch {
        this.state.lastRefreshError[m] = 'Stripe read credentials are unavailable'; this.save();
      }
    }
    return this.snapshot();
  }
  private async pullWithApi(api: EarnStripeApi, mode: BillingMode, customer: CustomerRecord): Promise<SubscriptionFact | null> {
    const subId = customer.subscriptionId;
    if (!subId || !/^sub_[A-Za-z0-9_]+$/.test(subId)) return null;
    const raw = await api.call('GET', '/v1/subscriptions/' + subId, { 'expand[0]': 'discounts.coupon' });
    return this.factFromStripe(raw, mode, customer, subId);
  }
  private factFromStripe(raw: StripeObject, mode: BillingMode, customer: CustomerRecord, subId: string): SubscriptionFact | null {
    const sf = subscriptionFacts(raw);
    if (sf.subscriptionId !== subId || sf.customerId !== customer.stripeCustomerId || customer.livemode !== (mode === 'live')) throw Error('Subscription identity could not be confirmed');
    // The customer's row is the software role boundary: non-software products
    // live in a separate BillingStore ledger. Launch metadata supplies the
    // fixed promo contract; older known software subscriptions remain in the
    // total only when Stripe exposes enough data to price their discount.
    const plan = sf.metadata.plan || customer.planKey || 'unknown';
    const discountPercent = discountPercentFromStripe(raw, this.now());
    const configuredPlan = this.billing().plans.find(p => p.key === plan);
    let pricedRaw = raw;
    const bound = this.store.getBundleSubscription(subId);
    if (bound?.launchIntentId) {
      const grant = launchGrant(this.store.dataDir, {wh_launch_intent:bound.launchIntentId,plan:bound.planKey}, mode === 'live');
      if (!grant?.hosting || !grant.sessionId || bound.customerId !== customer.stripeCustomerId) throw Error('Mixed subscription lacks durable software proof');
      const items = raw.items;
      if (!items || items.has_more || !Array.isArray(items.data) || items.data.some((item: StripeObject) => ![grant.hosting!.softwarePriceId,grant.hosting!.hostingPriceId].includes(id(item.price)))) throw Error('Mixed subscription items differ from its proof');
      pricedRaw = {...raw,items:{...items,data:items.data.filter((item: StripeObject) => id(item.price) === grant.hosting!.softwarePriceId)}};
    }
    const lines = configuredPlan?.checkout === 'payment-link' ? subscriptionLines(pricedRaw) : null;
    let currency: string | null = null, grossMrrMinor: number | null = null, netMrrMinor: number | null = null;
    if (lines && lines.every(line => line.currency === lines[0].currency) && discountPercent !== null) {
      currency = lines[0].currency;
      grossMrrMinor = lines.reduce((sum, line) => sum + line.amountMinor / line.months, 0);
      netMrrMinor = grossMrrMinor * (100 - discountPercent) / 100;
    }
    const firstRaw = sf.metadata.first_payment_at_ms;
    const firstPaymentAtMs = firstRaw && /^\d{13}$/.test(firstRaw) ? Number(firstRaw) : null;
    return { mode, customerId: customer.stripeCustomerId, subscriptionId: subId, plan, status: sf.status,
      cancelAtPeriodEnd: sf.cancelAtPeriodEnd, currentPeriodEndMs: sf.currentPeriodEndMs,
      firstPaymentAtMs, discountPercent, currency, grossMrrMinor, netMrrMinor,
      linesKnown: !!lines && discountPercent !== null, updatedAtMs: this.now() };
  }
  referralIncome(owner: string, scope: ReferralIncomeScope, rate: number) {
    // Only exact known software subscriptions may contribute. A dispute or
    // refund excludes the subscription even if the provider still says active.
    const customers = this.softwareCustomers(scope.mode).filter(c => !c.disputed && !c.refunded);
    const facts = this.state.facts.filter(f => customers.some(c => c.stripeCustomerId === f.customerId && c.subscriptionId === f.subscriptionId));
    return referralMonthlyIncome(owner, scope, facts, rate, this.now());
  }
  snapshot() {
    const config = this.billing();
    const byMode = Object.fromEntries(MODES.map(mode => {
      const facts = this.state.facts.filter(f => f.mode === mode);
      const missingFacts = this.customers(mode).filter(c => c.subscriptionId && !facts.some(f => f.subscriptionId === c.subscriptionId));
      const active = facts.filter(f => ['active', 'trialing'].includes(f.status) && !(f.firstPaymentAtMs && f.firstPaymentAtMs > this.now()));
      const scheduled = facts.filter(f => ['active', 'trialing'].includes(f.status) && !!f.firstPaymentAtMs && f.firstPaymentAtMs > this.now());
      const mrr: Record<string, number> = {}, scheduledMrr: Record<string, number> = {};
      for (const f of active) if (f.currency && f.netMrrMinor !== null) mrr[f.currency] = (mrr[f.currency] || 0) + f.netMrrMinor;
      for (const f of scheduled) if (f.currency && f.netMrrMinor !== null) scheduledMrr[f.currency] = (scheduledMrr[f.currency] || 0) + f.netMrrMinor;
      const oneTime = this.softwareCustomers(mode).filter(c => !c.subscriptionId && !c.refunded && !c.disputed);
      const counts = { yearly: 0, lifetime: 0 };
      for (const c of oneTime) {
        if (c.planKey === 'lifetime' || config.plans.some(p => p.key === c.planKey && p.lifetime)) counts.lifetime++;
        else if (c.planKey === 'yearly') counts.yearly++;
      }
      const unknownAmount = [...active, ...scheduled].filter(f => !f.linesKnown).length;
      return [mode, {
        activeRecurring: active.length, scheduledPrelaunchStarts: scheduled.length,
        oneTimePurchases: counts, mrrMinorByCurrency: mrr, scheduledMrrMinorByCurrency: scheduledMrr,
        unknownAmountCount: unknownAmount + missingFacts.length,
        unrefreshedSubscriptionCount: missingFacts.length,
        knownRecurringSubscriptions: facts.length + missingFacts.length,
        subscriptions: facts.map(({ customerId, subscriptionId, plan, status, cancelAtPeriodEnd, currentPeriodEndMs, firstPaymentAtMs, discountPercent, currency, netMrrMinor, linesKnown, updatedAtMs }) =>
          ({ customerId, subscriptionId, plan, status, cancelAtPeriodEnd, currentPeriodEndMs, firstPaymentAtMs, discountPercent, currency, netMrrMinor, linesKnown, updatedAtMs })),
        refreshedAtMs: this.state.lastRefreshAtMs[mode] ?? null,
        refreshError: this.state.lastRefreshError[mode] || null,
      }];
    }));
    return { ok: true, activeMode: config.mode, generatedAtMs: this.now(), byMode };
  }
  private knownCustomer(mode: BillingMode, customerId: string, email = ''): CustomerRecord | null {
    if (customerId) return this.customers(mode).find(c => c.stripeCustomerId === customerId) ?? null;
    const byEmail = email ? this.store.findByEmail(email, mode === 'live') : null;
    return byEmail?.livemode === (mode === 'live') ? byEmail : null;
  }
  private enqueueOnce(dedupeKey: string, input: Omit<NotificationInput, 'key'>, notificationKey = dedupeKey) {
    if (!this.deps.enqueue) return false;
    if (this.state.signupSent[dedupeKey]) return false;
    this.deps.enqueue({ ...input, key: notificationKey });
    const prior = { ...this.state.signupSent };
    this.state.signupSent[dedupeKey] = notificationKey;
    const keys = Object.keys(this.state.signupSent);
    if (keys.length > 5_000) for (const old of keys.slice(0, keys.length - 5_000)) delete this.state.signupSent[old];
    try { this.save(); }
    catch (error) { this.state.signupSent = prior; throw error; }
    return true;
  }
  private noticeFields(mode: BillingMode, plan: string, snapshot = this.snapshot(), fact?: SubscriptionFact) {
    const row = (snapshot.byMode as Record<string, any>)[mode];
    return [
      { name: 'Plan', value: plan, inline: true },
      { name: 'Active recurring subscriptions', value: String(row.activeRecurring), inline: true },
      { name: 'Scheduled prelaunch starts', value: String(row.scheduledPrelaunchStarts), inline: true },
      { name: 'Subscriptions with unknown revenue', value: String(row.unknownAmountCount), inline: true },
      { name: 'One-time purchases', value: `${row.oneTimePurchases.yearly} Yearly · ${row.oneTimePurchases.lifetime} Lifetime`, inline: true },
      ...(fact ? [{ name: 'Discount', value: fact.discountPercent === null ? 'Not confirmed' : `${fact.discountPercent}%`, inline: true }] : []),
      ...Object.entries(row.mrrMinorByCurrency as Record<string, number>).map(([currency, amount]) => ({ name: `Expected monthly revenue (${currency.toUpperCase()})`, value: formatMinor(currency, amount), inline: true })),
    ];
  }
  /** Call only after Stripe signature verification and successful BillingService
   * processing. Fetches only the current subscription belonging to a known
   * software customer; event payloads never directly alter aggregate totals. */
  handleVerifiedEvent(event: StripeEvent): Promise<{ refreshed: boolean; notices: number; snapshot: unknown }> {
    return this.serial(() => this.handleEventNow(event));
  }
  private async handleEventNow(event: StripeEvent): Promise<{ refreshed: boolean; notices: number; snapshot: unknown }> {
    const mode: BillingMode = event.livemode ? 'live' : 'test';
    const eventObject = event.object as StripeObject;
    let customerId = '', customerEmail = '', subscriptionId = '', plan = '', sourceId = '', managedBy = '';
    let oneTimeCheckout = false;
    let paidInvoice = false;
    let eventKind: 'signup' | 'renewal' | 'discount' | 'paymentFailed' | null = null;
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const facts = checkoutFacts(eventObject); customerId = facts.customerId; customerEmail = facts.email; subscriptionId = facts.subscriptionId;
      plan = facts.metadata.plan || ''; managedBy = facts.metadata.managed_by || ''; sourceId = facts.sessionId;
      if (facts.mode === 'subscription' && facts.status === 'complete' && ['paid', 'no_payment_required'].includes(facts.paymentStatus)) eventKind = 'signup';
      else if (facts.mode === 'payment' && facts.status === 'complete' && facts.paymentStatus === 'paid') { eventKind = 'signup'; oneTimeCheckout = true; }
    } else if (['customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
      const facts = subscriptionFacts(eventObject); customerId = facts.customerId; subscriptionId = facts.subscriptionId;
      sourceId = event.id;
    } else if (['invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed'].includes(event.type)) {
      const facts = invoiceFacts(eventObject); customerId = facts.customerId; customerEmail = facts.email; subscriptionId = facts.subscriptionId;
      plan = facts.metadata.plan || ''; managedBy = facts.metadata.managed_by || ''; sourceId = facts.invoiceId;
      paidInvoice = event.type !== 'invoice.payment_failed' && facts.paid;
      if (event.type === 'invoice.payment_failed') eventKind = 'paymentFailed';
      else if (facts.billingReason === 'subscription_cycle') eventKind = 'renewal';
      else if (facts.billingReason === 'subscription_create') eventKind = 'signup';
    } else return { refreshed: false, notices: 0, snapshot: this.snapshot() };
    const customer = this.knownCustomer(mode, customerId, customerEmail);
    if (!customer || !sourceId || (customer.subscriptionId && subscriptionId && customer.subscriptionId !== subscriptionId))
      return { refreshed: false, notices: 0, snapshot: this.snapshot() };
    if (oneTimeCheckout && managedBy !== 'wh-launch') return { refreshed: false, notices: 0, snapshot: this.snapshot() };
    if (!oneTimeCheckout && customer.subscriptionId) subscriptionId = customer.subscriptionId;
    let fact: SubscriptionFact | null = null;
    if (subscriptionId && /^sub_[A-Za-z0-9_]+$/.test(subscriptionId)) {
      try { fact = await this.pullWithApi(this.api(mode), mode, customer); this.putFact(fact, mode, subscriptionId); }
      catch { this.state.lastRefreshError[mode] = 'A known subscription could not be refreshed'; this.save(); throw Error('Subscription refresh is pending; retry the committed billing event'); }
    }
    const snapshot = this.snapshot();
    let notices = 0;
    if (eventKind === 'signup' && oneTimeCheckout && (plan === 'yearly' || plan === 'lifetime')) {
      if (customer.planKey === plan) {
        const discount = checkoutDiscountPercent(eventObject);
        notices += this.enqueueOnce(`signup:${mode}:${sourceId}`, {
          kind: 'signup', title: 'New one-time software purchase', fields: [
            ...this.noticeFields(mode, plan, snapshot),
            ...(discount !== null && discount > 0 ? [{ name: 'Discount', value: `${discount}%`, inline: true }] : []),
          ],
        }, `${mode}:${sourceId}:signup`) ? 1 : 0;
        if (discount !== null && discount > 0) notices += this.enqueueOnce(`discount:${mode}:${sourceId}`, {
          kind: 'discount', title: 'One-time software discount applied', fields: [
            ...this.noticeFields(mode, plan, snapshot), { name: 'Discount', value: `${discount}%`, inline: true },
          ],
        }, `${mode}:${sourceId}:discount`) ? 1 : 0;
      }
    } else if (fact) {
      const currentlyBillable = ['active', 'trialing'].includes(fact.status) && !(fact.firstPaymentAtMs && fact.firstPaymentAtMs > this.now());
      // Signup dedupes by subscription even if an invoice-created event races
      // ahead of Checkout completion; renewal/payment-failure dedupe by invoice.
      if (eventKind === 'signup' && ['active', 'trialing'].includes(fact.status)) {
        notices += this.enqueueOnce(`signup:${mode}:${subscriptionId}`, {
          kind: 'signup', title: currentlyBillable ? 'New recurring subscription' : 'New subscription — first payment scheduled', fields: this.noticeFields(mode, fact.plan, snapshot, fact),
        }, `${mode}:${sourceId}:signup`) ? 1 : 0;
      } else if ((eventKind === 'renewal' && currentlyBillable) || eventKind === 'paymentFailed') {
        const notificationKey = `${mode}:${sourceId}:${eventKind}`;
        const dedupeKey = `${eventKind}:${notificationKey}`;
        notices += this.enqueueOnce(dedupeKey, {
          kind: eventKind, title: eventKind === 'renewal' ? 'Subscription renewed' : 'Subscription payment failed',
          fields: this.noticeFields(mode, fact.plan, snapshot, fact),
        }, notificationKey) ? 1 : 0;
      }
      if (paidInvoice && ['signup', 'renewal'].includes(eventKind || '') && currentlyBillable && fact.discountPercent !== null && fact.discountPercent > 0) {
        const notificationKey = `${mode}:${sourceId}:discount`;
        notices += this.enqueueOnce(`discount:${notificationKey}`, {
          kind: 'discount', title: 'Subscription discount applied',
          fields: [...this.noticeFields(mode, fact.plan, snapshot), { name: 'Discount', value: `${fact.discountPercent}%`, inline: true }],
        }, notificationKey) ? 1 : 0;
      }
    }
    return { refreshed: !!fact, notices, snapshot };
  }
}
