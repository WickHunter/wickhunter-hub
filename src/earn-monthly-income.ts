import { createHash } from 'node:crypto';

export interface ReferralIncomeScope {
  mode: 'live' | 'test'; asOf: number | null;
  rows: { id: string; kind: string; status: string }[];
}
export interface RecurringIncomeFact {
  mode: string; subscriptionId: string; status: string; cancelAtPeriodEnd: boolean;
  firstPaymentAtMs: number | null; currency: string | null; netMrrMinor: number | null;
  linesKnown: boolean; updatedAtMs: number;
}
/** A read-only forecast. It neither creates commission entries nor promises a payout. */
export function referralMonthlyIncome(owner: string, scope: ReferralIncomeScope, facts: RecurringIncomeFact[], rate: number, now: number) {
  const result = { mode: scope.mode, rate, asOf: scope.asOf, stale: false, pricedSubscriptions: 0,
    unknownSubscriptions: 0, scheduledSubscriptions: 0, excludedSubscriptions: 0,
    monthlyMinorByCurrency: {} as Record<string, number> };
  const rows = [...new Map(scope.rows.filter(r => r.kind === 'subscription').map(r => [r.id, r])).values()];
  if (!Number.isFinite(rate) || rate < 0 || rate > 100 || !scope.asOf || scope.asOf > now || now - scope.asOf > 86400000) {
    result.stale = true; result.unknownSubscriptions = rows.length; return result;
  }
  const byId = new Map<string, RecurringIncomeFact[]>();
  for (const f of facts.filter(f => f.mode === scope.mode)) {
    const id = createHash('sha256').update(owner + ':' + f.subscriptionId).digest('hex').slice(0, 40);
    byId.set(id, [...(byId.get(id) ?? []), f]);
  }
  const bases: Record<string, number> = {};
  for (const r of rows) {
    const matches = byId.get(r.id) ?? [], f = matches.length === 1 ? matches[0] : null;
    if (!f || !Number.isFinite(f.updatedAtMs) || f.updatedAtMs > now || now - f.updatedAtMs > 900000) {
      result.unknownSubscriptions++; result.stale ||= !!f; continue;
    }
    result.asOf = Math.min(result.asOf!, f.updatedAtMs);
    if (f.firstPaymentAtMs !== null && f.firstPaymentAtMs > now && ['active', 'trialing'].includes(f.status)) {
      result.scheduledSubscriptions++; continue;
    }
    if (r.status !== 'active' || f.status !== 'active' || f.cancelAtPeriodEnd) { result.excludedSubscriptions++; continue; }
    if (!f.linesKnown || !f.currency || !/^[a-z]{3}$/.test(f.currency) || f.netMrrMinor === null || !Number.isFinite(f.netMrrMinor) || f.netMrrMinor < 0 || f.netMrrMinor > Number.MAX_SAFE_INTEGER / Math.max(1, rows.length)) {
      result.unknownSubscriptions++; continue;
    }
    bases[f.currency] = (bases[f.currency] ?? 0) + f.netMrrMinor;
    result.pricedSubscriptions++;
  }
  for (const [currency, amount] of Object.entries(bases)) result.monthlyMinorByCurrency[currency] = Math.round(amount * rate / 100);
  return result;
}
