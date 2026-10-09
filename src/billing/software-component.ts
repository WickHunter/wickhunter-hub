import type { StripeObject } from '../earn-stripe-api.js';
import type { HostedPriceProof } from './hosted-offer.js';

export const componentPriceId = (line: StripeObject): string => typeof line.price === 'string' ? line.price : line.price?.id || line.pricing?.price_details?.price || '';
const cents = (n: unknown): number => { if (!Number.isSafeInteger(n) || Number(n) < 0) throw Error('Mixed invoice monetary proof is incomplete'); return Number(n); };
const amounts = (rows: unknown): number => {
  if (rows === undefined || rows === null) return 0;
  if (!Array.isArray(rows)) throw Error('Mixed invoice adjustment proof is incomplete');
  return rows.reduce((sum, row) => cents(sum + cents(row?.amount)), 0);
};
export function invoiceLineDiscount(line: StripeObject): number {
  // Basil credits can represent either a discount or a credit grant. Only
  // discount entries describe a coupon rate; grants still reduce paid basis.
  if (line.pretax_credit_amounts !== undefined && line.pretax_credit_amounts !== null) {
    if (!Array.isArray(line.pretax_credit_amounts)) throw Error('Mixed invoice credit proof is incomplete');
    return amounts(line.pretax_credit_amounts.filter((credit: StripeObject) => credit.type === 'discount' || credit.discount));
  }
  return amounts(line.discount_amounts);
}
/** Basil uses taxes and pretax_credit_amounts; older signed invoice objects
 * use tax_amounts and discount_amounts. Credits already include discounts,
 * so never subtract both lists. Excludes tax from the software revenue basis. */
export function invoiceLineNet(line: StripeObject): number {
  const amount = cents(line.amount);
  const credits = amounts(line.pretax_credit_amounts ?? line.discount_amounts);
  let inclusiveTax = 0;
  const taxes = line.taxes ?? line.tax_amounts;
  if (taxes !== undefined && taxes !== null) {
    if (!Array.isArray(taxes)) throw Error('Mixed invoice tax proof is incomplete');
    for (const tax of taxes) {
      const inclusive = tax.tax_behavior === 'inclusive' || tax.inclusive === true;
      if (inclusive) inclusiveTax = cents(inclusiveTax + cents(tax.amount));
    }
  }
  const beforeTax = line.amount_excluding_tax ?? line.subtotal_excluding_tax;
  const basis = beforeTax === undefined || beforeTax === null ? amount - inclusiveTax : cents(beforeTax);
  if (basis < credits) throw Error('Mixed invoice credits exceed the software amount');
  return cents(basis - credits);
}
export function softwareInvoiceProjection(object: StripeObject, proof: HostedPriceProof): StripeObject {
  const raw = object.lines;
  if (!raw || raw.has_more || !Array.isArray(raw.data)) throw Error('Mixed invoice line history is incomplete');
  if (raw.data.filter((line: StripeObject) => componentPriceId(line) === proof.hostingPriceId).some((line: StripeObject) => amounts(line.pretax_credit_amounts ?? line.discount_amounts) > 0)) throw Error("VPS invoice unexpectedly discounted; operator review required");
  const software = raw.data.filter((line: StripeObject) => componentPriceId(line) === proof.softwarePriceId);
  const net = software.reduce((sum: number, line: StripeObject) => cents(sum + invoiceLineNet(line)), 0);
  // The first paid software clock cannot be triggered solely by the VPS.
  const paid = object.amount_paid === undefined ? 0 : cents(object.amount_paid);
  const subtotal = software.reduce((sum: number, line: StripeObject) => cents(sum + cents(line.amount)), 0);
  const discount = software.reduce((sum: number, line: StripeObject) => cents(sum + invoiceLineDiscount(line)), 0);
  return { ...object, lines: { ...raw, data: software }, amount_paid: Math.min(paid, net), amount_subtotal: subtotal, total_details: { amount_discount: discount } };
}
export function softwareCheckoutProjection(lines: StripeObject, proof: HostedPriceProof): StripeObject {
  if (lines.has_more || !Array.isArray(lines.data) || lines.data.length !== 2) throw Error('Mixed checkout line history is incomplete');
  const sw = lines.data.find((line: StripeObject) => componentPriceId(line) === proof.softwarePriceId);
  const host = lines.data.find((line: StripeObject) => componentPriceId(line) === proof.hostingPriceId);
  if (!sw || !host || sw.quantity !== 1 || host.quantity !== 1 || sw.price?.product !== proof.softwareProductId || host.price?.product !== proof.hostingProductId || cents(sw.amount_subtotal) !== proof.softwareAmountCents || cents(host.amount_subtotal) !== proof.hostingAmountCents || cents(host.amount_discount) !== 0) throw Error('Mixed checkout differs from its approved software/VPS proof');
  const discount = cents(sw.amount_discount);
  if (discount > proof.softwareAmountCents) throw Error('Software discount exceeds its price');
  return { amount_subtotal: proof.softwareAmountCents, total_details: { amount_discount: discount }, amount_total: proof.softwareAmountCents - discount };
}
