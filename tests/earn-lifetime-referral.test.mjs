// Lifetime software referral commission: the one-time software line of a
// hosted Lifetime bundle's initial invoice, and a self-hosted one-time
// Lifetime Checkout purchase. Recurring VPS-only invoices never earn.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EarnService,earnOwner} from '../dist/src/earn.js';
import {EarnStripeService} from '../dist/src/earn-stripe.js';
import {BillingStore} from '../dist/src/billing/store.js';
import {test,tmpDir,summary} from './helpers.mjs';
const dir=tmpDir('earn-lifetime'),now=Date.parse('2026-11-05T12:00:00Z');
const ledger=new EarnService(dir,()=>now),owner=earnOwner('email:referrer@example.com');
const member=ledger.member(owner,'Referrer');ledger.configure({owner,commissionPercent:50});
const cfg={plans:[{key:'monthly',role:'software',checkout:'payment-link',interval:'month',currency:'usd',lifetime:false},{key:'lifetime',role:'software',checkout:'payment-link',interval:null,currency:'usd',lifetime:true,amountCents:99900}],
 stripe:{live:{secretKey:'sk_live_fixture',priceIds:{monthly:'price_month',lifetime:'price_lifetime'}},test:{secretKey:'sk_test_fixture',priceIds:{}}}};
const offer={promotion:'promo_p',code:'PARTNER20',percent:20,products:['prod_wh'],proof:{promotion:'promo_p',code:'PARTNER20',coupon:'coupon_p',percent:20,duration:'forever',products:['prod_wh'],verifiedAt:1}};
ledger.transaction(s=>{s.stripe={profiles:{[owner]:{partnerPromotions:[offer]}},invoices:{},jobs:[],seen:{}};});

// Durable hosted Lifetime checkout binding (launch intent + bundle record).
const intentDir=path.join(dir,'billing-launch-intents.v1');fs.mkdirSync(intentDir,{recursive:true});
const bundleIntent='c'.repeat(64),selfIntent='d'.repeat(64),reservationId='res_life';
fs.writeFileSync(path.join(intentDir,bundleIntent+'.json'),JSON.stringify({id:bundleIntent,mode:'live',plan:'lifetime',payment:'card',licenseId:null,requestHash:'fixture',createdAtMs:now,firstPaymentAtMs:null,accessUntilMs:null,discountPercent:20,sessionId:'cs_life_bundle',
 hosting:{softwarePriceId:'price_lifetime',softwareProductId:'prod_wh',softwareAmountCents:99900,hostingPriceId:'price_hosting',hostingProductId:'prod_hosting',hostingAmountCents:2000,hostingInterval:'month',reservationId,expiresAtMs:now+60000},
 stripeParams:{'metadata[bundle]':'software-hosting-v2','metadata[reservation]':reservationId,'line_items[0][price]':'price_lifetime','line_items[1][price]':'price_hosting'}}));
fs.writeFileSync(path.join(intentDir,selfIntent+'.json'),JSON.stringify({id:selfIntent,mode:'live',plan:'lifetime',payment:'card',licenseId:null,requestHash:'fixture',createdAtMs:now,firstPaymentAtMs:null,accessUntilMs:null,discountPercent:20,sessionId:'cs_self',
 stripeParams:{'line_items[0][price]':'price_lifetime'}}));
new BillingStore(dir).putBundleSubscription({subscriptionId:'sub_life',reservationId,customerId:'cus_buyer',planKey:'lifetime',priceId:'price_lifetime',launchIntentId:bundleIntent,latestEventCreatedMs:now,pendingStatus:null,terminal:false,updatedAtMs:now});

const lifeMeta={bundle:'software-hosting-v2',plan:'lifetime',license_days:'3650',non_renewing:'true',reservation:reservationId,wh_launch_intent:bundleIntent};
const subs={
 sub_life:{id:'sub_life',customer:'cus_buyer',livemode:true,status:'active',metadata:lifeMeta,discounts:[{promotion_code:'promo_p'}],items:{data:[{price:'price_hosting',quantity:1}],has_more:false}},
 sub_unbound:{id:'sub_unbound',customer:'cus_buyer',livemode:true,status:'active',metadata:lifeMeta,discounts:[{promotion_code:'promo_p'}],items:{data:[{price:'price_hosting',quantity:1}],has_more:false}},
};
const softwareLine=()=>({pricing:{price_details:{price:'price_lifetime',product:'prod_wh'}},quantity:1,amount:99900,amount_excluding_tax:99900,pretax_credit_amounts:[{amount:19980,type:'discount',discount:'di_partner'}],taxes:[],description:'Wick Hunter Unleashed',period:{end:now/1000}});
const hostingLine=()=>({pricing:{price_details:{price:'price_hosting',product:'prod_hosting'}},quantity:1,amount:2000,amount_excluding_tax:2000,pretax_credit_amounts:[],taxes:[],description:'1 × Wick Hunter Managed VPS (at $20.00 / month)',period:{end:now/1000+30*86400}});
const inv=(id,sub,lines,amount_paid,billing_reason)=>({id,customer:'cus_buyer',status:'paid',currency:'usd',livemode:true,amount_paid,total_taxes:[],billing_reason,parent:{subscription_details:{subscription:sub}},lines:{data:lines,has_more:false},status_transitions:{paid_at:now/1000}});
const invoices={};
const put=v=>{invoices[v.id]=v;return v.id;};

const sessionBase=(id,customer,extra={})=>({id,object:'checkout.session',livemode:true,mode:'payment',status:'complete',payment_status:'paid',currency:'usd',amount_total:79920,customer,payment_intent:'pi_'+id.slice(3),created:now/1000,
 total_details:{amount_discount:19980,amount_tax:0,breakdown:{discounts:[{amount:19980,discount:{promotion_code:'promo_p',source:{coupon:'coupon_p'}}}]}},metadata:{plan:'lifetime',managed_by:'wh-launch',non_renewing:'true',license_days:'3650'},...extra});
const sessions={
 cs_self:sessionBase('cs_self','cus_self',{metadata:{plan:'lifetime',managed_by:'wh-launch',wh_launch_intent:selfIntent,non_renewing:'true',license_days:'3650'}}),
 cs_missed:sessionBase('cs_missed','cus_missed'),
 cs_selfref:sessionBase('cs_selfref','cus_referrer'),
 cs_wrongproduct:sessionBase('cs_wrongproduct','cus_other'),
 cs_subscription:{...sessionBase('cs_subscription','cus_buyer'),mode:'subscription',subscription:'sub_life'},
 cs_foreign:{...sessionBase('cs_foreign','cus_other'),total_details:{amount_discount:500,amount_tax:0,breakdown:{discounts:[{amount:500,discount:{promotion_code:'promo_foreign'}}]}}},
};
const refunds={},calls=[];
const fetcher=async(url,init)=>{
 const u=new URL(url),p=u.pathname;calls.push(p);assert.equal(init.method,'GET','no Stripe writes');
 const ok=v=>new Response(JSON.stringify(v)),missing=()=>new Response(JSON.stringify({error:{code:'resource_missing'}}),{status:404});
 if(p==='/v1/promotion_codes/promo_p')return ok({id:'promo_p',code:'PARTNER20',livemode:true,coupon:'coupon_p',metadata:{managed_by:'wh-earn',wh_earn_owner:owner}});
 if(p==='/v1/promotion_codes/promo_foreign')return missing();
 if(p==='/v1/coupons/coupon_p')return ok({id:'coupon_p',valid:true,percent_off:20,duration:'forever',metadata:{managed_by:'wh-earn'},applies_to:{products:['prod_wh']}});
 if(p==='/v1/subscriptions')return ok({data:[subs.sub_life],has_more:false});
 if(p==='/v1/invoices')return ok({data:Object.values(invoices).filter(v=>v.parent.subscription_details.subscription===u.searchParams.get('subscription')),has_more:false});
 if(p.startsWith('/v1/invoices/'))return invoices[p.split('/').at(-1)]?ok(invoices[p.split('/').at(-1)]):missing();
 if(p.startsWith('/v1/subscriptions/'))return subs[p.split('/').at(-1)]?ok(subs[p.split('/').at(-1)]):missing();
 if(p==='/v1/customers/cus_referrer')return ok({email:'referrer@example.com'});
 if(p.startsWith('/v1/customers/'))return ok({email:'buyer@example.com'});
 if(p==='/v1/invoice_payments')return ok({data:[{status:'paid',payment:{type:'charge',charge:'ch_'+u.searchParams.get('invoice')}}],has_more:false});
 if(p.startsWith('/v1/charges/')){const ch=p.split('/').at(-1);return ok({id:ch,livemode:true,amount_refunded:refunds[ch]||0,disputed:false});}
 if(p==='/v1/checkout/sessions')return ok({data:Object.values(sessions),has_more:false});
 const line=/^\/v1\/checkout\/sessions\/(cs_[a-z_]+)\/line_items$/.exec(p);
 if(line){const s=sessions[line[1]];return ok({data:[{price:{id:'price_lifetime',type:'one_time',recurring:null,product:line[1]==='cs_wrongproduct'?'prod_other':'prod_wh'},quantity:1,amount_subtotal:99900,amount_discount:19980,amount_tax:0,amount_total:s.amount_total}],has_more:false});}
 if(p.startsWith('/v1/checkout/sessions/'))return sessions[p.split('/').at(-1)]?ok(sessions[p.split('/').at(-1)]):missing();
 if(p.startsWith('/v1/payment_intents/pi_')){const n=p.split('pi_').at(-1),s=sessions['cs_'+n];return ok({id:'pi_'+n,livemode:true,status:'succeeded',customer:s.customer,amount_received:s.amount_total,currency:'usd',latest_charge:{id:'ch_'+n,livemode:true,payment_intent:'pi_'+n,paid:true,currency:'usd',amount:s.amount_total,created:now/1000}});}
 throw Error('Unexpected fixture request '+p);
};
const svc=new EarnStripeService(dir,ledger,()=>cfg,'https://fixture.invalid',()=>now,fetcher);svc.configure({enabled:true,mode:'live'});
let serial=0;const ev=(type,object)=>({type,id:'evt_'+(++serial),object,livemode:true,createdMs:now});
const rows=()=>ledger.admin().stripe.invoices,balance=()=>ledger.view(owner,'Referrer').balances.referral;
try{
 await test('hosted Lifetime: a discounted VPS line refuses and records nothing',async()=>{
  const vps={...hostingLine(),pretax_credit_amounts:[{amount:400,type:'discount',discount:'di_partner'}]};
  const id=put(inv('in_vps_discounted','sub_life',[softwareLine(),vps],81520,'subscription_create'));
  await assert.rejects(svc.handleEvent(ev('invoice.paid',{id})),/VPS invoice line/);assert.equal(rows()[id],undefined);
 });
 await test('hosted Lifetime: a subscription without its durable bundle binding refuses like monthly',async()=>{
  const id=put(inv('in_unbound','sub_unbound',[softwareLine(),hostingLine()],81920,'subscription_create'));
  await assert.rejects(svc.handleEvent(ev('invoice.paid',{id})),/durable checkout binding/);assert.equal(rows()[id],undefined);
 });
 await test('hosted Lifetime: the initial invoice credits 50% of software net, excluding the VPS',async()=>{
  const id=put(inv('in_first','sub_life',[softwareLine(),hostingLine()],81920,'subscription_create'));
  await svc.handleEvent(ev('invoice.paid',{id}));
  const row=rows()[id];assert.ok(row);assert.equal(row.basis,79920);assert.equal(row.commission,39960);assert.equal(row.rate,50);assert.equal(row.kind,'lifetime');assert.equal(row.paid,81920);
  const entries=ledger.admin().entries.filter(e=>e.reference==='stripe:invoice:in_first');assert.equal(entries.length,1);assert.equal(entries[0].cents,39960);assert.equal(entries[0].note,'50% referral commission (lifetime)');
  assert.equal(balance(),39960);
 });
 await test('hosted Lifetime: replay of the paid invoice is idempotent',async()=>{
  await svc.handleEvent(ev('invoice.payment_succeeded',{id:'in_first'}));await svc.handleEvent(ev('invoice.paid',{id:'in_first'}));
  assert.equal(ledger.admin().entries.filter(e=>e.reference==='stripe:invoice:in_first').length,1);assert.equal(balance(),39960);
 });
 await test('hosted Lifetime: VPS-only renewals never earn and make no attribution read',async()=>{
  const id=put(inv('in_renewal','sub_life',[hostingLine()],2000,'subscription_cycle'));
  const before=calls.length;await svc.handleEvent(ev('invoice.paid',{id}));
  assert.equal(rows()[id],undefined);assert.equal(balance(),39960);
  assert.ok(!calls.slice(before).some(p=>p.startsWith('/v1/promotion_codes/')||p.startsWith('/v1/customers/')),'renewal stops before attribution');
 });
 await test('hosted Lifetime: a second software-line invoice on the same subscription needs review',async()=>{
  const id=put(inv('in_second_software','sub_life',[softwareLine(),hostingLine()],81920,'manual'));
  await assert.rejects(svc.handleEvent(ev('invoice.paid',{id})),/already recorded/);assert.equal(rows()[id],undefined);assert.equal(balance(),39960);
 });
 await test('hosted Lifetime: the subscription backfill reaches the initial invoice and skips renewals',async()=>{
  const r=await svc.reconcileReferralInvoices(owner,50,true);assert.equal(r.dryRun,true);
  assert.ok(r.invoices.includes('in_first'));
 });
 await test('self-hosted Lifetime: a paid one-time Checkout credits 50% of software net once',async()=>{
  const before=balance();await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_self}));
  const row=rows().cs_self;assert.ok(row);assert.equal(row.basis,79920);assert.equal(row.commission,39960);assert.equal(row.subscription,'');assert.equal(row.kind,'lifetime');assert.deepEqual(row.charges,['ch_self']);
  const entries=ledger.admin().entries.filter(e=>e.reference==='stripe:checkout:cs_self');assert.equal(entries.length,1);assert.equal(entries[0].note,'50% referral commission (lifetime)');
  assert.equal(balance()-before,39960);
  await svc.handleEvent(ev('checkout.session.async_payment_succeeded',{...sessions.cs_self}));
  assert.equal(ledger.admin().entries.filter(e=>e.reference==='stripe:checkout:cs_self').length,1);assert.equal(balance()-before,39960);
 });
 await test('self-hosted Lifetime: self-referral, foreign promotions and subscription Checkouts never earn',async()=>{
  const before=balance(),n=calls.length;
  await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_selfref}));assert.equal(rows().cs_selfref,undefined);
  await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_foreign}));assert.equal(rows().cs_foreign,undefined);
  const m=calls.length;await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_subscription}));assert.equal(calls.length,m,'subscription-mode Checkout makes no Stripe read');
  await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_self,id:'cs_unpaid',payment_status:'unpaid'}));assert.equal(rows().cs_unpaid,undefined);
  assert.equal(balance(),before);assert.ok(calls.length>n);
 });
 await test('self-hosted Lifetime: a line outside the coupon product scope refuses',async()=>{
  await assert.rejects(svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_wrongproduct})),/price, product or applied discount/);assert.equal(rows().cs_wrongproduct,undefined);
 });
 await test('self-hosted Lifetime: a refund claws back without reading a subscription',async()=>{
  const before=balance(),n=calls.length;refunds.ch_self=79920;
  await svc.handleEvent(ev('charge.refunded',{id:'ch_self'}));
  assert.equal(balance(),before-39960);assert.ok(!calls.slice(n).some(p=>p.startsWith('/v1/subscriptions/')));
  refunds.ch_self=0;await svc.handleEvent(ev('charge.refunded',{id:'ch_self'}));assert.equal(balance(),before);
 });
 await test('self-hosted Lifetime: operator purchase backfill dry-runs with per-session eligibility, admits missed sessions once, continues past refusals, and is idempotent',async()=>{
  const snapshot=JSON.stringify(ledger.admin());
  const dry=await svc.reconcileReferralPurchases(owner,50,true);assert.equal(JSON.stringify(ledger.admin()),snapshot,'dry run writes nothing');
  assert.deepEqual([...dry.purchases].sort(),['cs_missed','cs_self']);assert.equal(dry.alreadyRecorded,1);
  const why=Object.fromEntries(dry.sessions.map(o=>[o.session,o]));
  assert.equal(why.cs_selfref.eligible,false);assert.equal(why.cs_selfref.reason,'self-referral');
  assert.equal(why.cs_wrongproduct.eligible,false);assert.match(why.cs_wrongproduct.reason,/price, product or applied discount/);
  assert.equal(why.cs_self.reason,'already recorded');assert.equal(why.cs_missed.reason,'eligible');
  await assert.rejects(svc.reconcileReferralPurchases(owner,40,false),/rate changed/);
  const before=balance(),r=await svc.reconcileReferralPurchases(owner,50,false);
  assert.equal(r.purchases,2);assert.equal(r.refused,2);assert.equal(r.admitted,2);assert.equal(r.skipped,0);assert.equal(r.adjusted,0);
  const out=Object.fromEntries(r.sessions.map(o=>[o.session,o]));
  assert.equal(out.cs_missed.reason,'admitted');assert.equal(out.cs_self.reason,'already recorded');
  assert.equal(out.cs_selfref.eligible,false);assert.match(out.cs_wrongproduct.reason,/price, product or applied discount/);
  assert.equal(rows().cs_missed.commission,39960);assert.equal(rows().cs_selfref,undefined);assert.equal(rows().cs_wrongproduct,undefined);assert.equal(balance()-before,39960);
  const again=await svc.reconcileReferralPurchases(owner,50,false);assert.equal(again.adjusted,0);assert.equal(balance()-before,39960);
  assert.equal(ledger.admin().entries.filter(e=>e.reference==='stripe:checkout:cs_missed').length,1);
 });
}finally{svc.stop();fs.rmSync(dir,{recursive:true,force:true});}
summary('earn-lifetime-referral');
