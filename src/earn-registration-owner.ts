import { boundOwnerFromBindings, earnOwner, type EarnService, type Member } from './earn.js';
import type { CustomerRecord } from './billing/store.js';
import { normalizeCustomerEmail } from './customer-sessions.js';

/** Resolve a human-confirmed billing email to an existing Earn identity.
 * This is intentionally read-only: unlike customer sign-in, a one-off Stripe
 * registrar must never bind an identity or create an Earn member. */
export function existingEarnMemberForVerifiedEmail(ledger: EarnService, customers: CustomerRecord[], rawEmail: string): {
  owner: string; member: Member; customerCount: number; source: 'billing-binding' | 'legacy-email';
} {
  const email=normalizeCustomerEmail(rawEmail);
  if(!email||email.length>254||!/^\S+@\S+\.\S+$/.test(email))throw new Error('Enter the verified partner email.');
  const matching=customers.filter(row=>row.livemode&&normalizeCustomerEmail(row.email)===email);
  if(!matching.length)throw new Error('No live billing customer matches this verified email.');

  const state=ledger.admin(),members=state.members,bindings=state.ownerBindings??{};
  const resolved=matching.map(record=>boundOwnerFromBindings(bindings,[
    `license:${record.licenseId}`,
    ...(record.stripeCustomerId.startsWith('cus_')?[`stripe:live:${record.stripeCustomerId}`]:[]),
  ]));
  const bound=[...new Set(resolved.filter((owner):owner is string=>owner!==null))];
  if(bound.length>1)throw new Error('Matching billing customers have conflicting immutable Earn owners; review required.');
  if(bound.length){
    if(resolved.some(owner=>owner===null))throw new Error('Some matching billing customers are unbound; verify the existing Earn identity before registering offers.');
    const owner=bound[0]!,member=members.find(row=>row.id===owner);
    if(!member)throw new Error('The immutable billing owner has no existing Earn member; no owner was created.');
    return {owner,member,customerCount:matching.length,source:'billing-binding'};
  }

  // Pre-binding members used the normalized billing email as their stable id.
  // Accept only that already-existing member and only when no binding above
  // conflicts; never call bindOwner() here.
  const owner=earnOwner('email:'+email),member=members.find(row=>row.id===owner);
  if(!member)throw new Error('No existing bound or legacy Earn member matches this verified email; no owner was created.');
  return {owner,member,customerCount:matching.length,source:'legacy-email'};
}
