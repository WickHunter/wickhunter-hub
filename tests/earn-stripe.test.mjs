import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EarnService,earnOwner} from '../dist/src/earn.js';
import {EarnStripeService} from '../dist/src/earn-stripe.js';
import {BillingService} from '../dist/src/billing/service.js';
import {BillingStore} from '../dist/src/billing/store.js';
import {AfterCommitOutbox} from '../dist/src/billing/after-commit-outbox.js';
import {test,tmpDir,summary} from './helpers.mjs';
const dir=tmpDir('earn-stripe');let now=Date.parse('2026-09-17T12:00:00Z');
const templates=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../templates');
const ledger=new EarnService(dir,()=>now),owner=earnOwner('email:referrer@example.com');const member=ledger.member(owner,'Referrer');
const cfg={plans:[{key:'monthly',role:'software',checkout:'payment-link',interval:'month',currency:'usd'}],stripe:{test:{secretKey:'sk_test_fixture',priceIds:{monthly:'price_month'}},live:{secretKey:'sk_live_fixture',priceIds:{monthly:'price_month'}}}};
let calls=[],refund=0,dispute=false,disputeStatus='needs_response',subStatus='active',failSubmit=false,postReadFailure=false;
let invoiceId='in_1',email='friend@example.com',priceId='price_month',subscriptionPriceId='price_month',currency='usd',paid=9900,total=9000,subscriptionCode=member.code,cancelAtPeriodEnd=false,refundChargeId='ch_in_1',invoiceOverride=null,subscriptionOverride=null;
let failingEndpoint='',failingCount=0,failingStatus=500,omitExpandedCouponOnce=0,omitExpandedCouponCreateOnce=0;
const coupons=new Map(),promos=new Map(),subscriptionPromos={test:null,live:null};let promoSerial=0;
const payouts=new Map(),idempotency=new Map();let sends=0;
const fake=async (url,init)=>{
 const u=new URL(url),endpoint=u.pathname,mode=init.headers.authorization.includes('live')?'live':'test',live=mode==='live';const body=init.method==='POST'?(endpoint.startsWith('/v2')?JSON.parse(init.body):Object.fromEntries(new URLSearchParams(init.body))):{};
 calls.push({endpoint,body,query:Object.fromEntries(u.searchParams),headers:init.headers,method:init.method});const ok=(v,status=200)=>new Response(JSON.stringify(v),{status});
 if(endpoint===failingEndpoint&&failingCount>0){failingCount--;return ok({error:{code:'api_error'}},failingStatus);}
 if(endpoint==='/v1/prices/price_month')return ok({id:'price_month',active:true,currency:'usd',recurring:{interval:'month'},product:'prod_wh'});
 if(endpoint==='/v1/prices/price_legacy')return ok({id:'price_legacy',active:false,currency:'usd',recurring:{interval:'month'},product:'prod_wh'});
 if(endpoint==='/v1/prices/price_hosting')return ok({id:'price_hosting',active:true,currency:'usd',recurring:{interval:'month'},product:'prod_hosting'});
 if(endpoint.startsWith('/v1/coupons/')){const c=coupons.get(mode+':'+endpoint.split('/').at(-1));if(!c)return ok({error:{code:'resource_missing'}},404);const expanded=u.searchParams.get('expand[0]')==='applies_to';let result=expanded?c:Object.fromEntries(Object.entries(c).filter(([k])=>k!=='applies_to'));if(expanded&&omitExpandedCouponOnce>0){omitExpandedCouponOnce--;result=Object.fromEntries(Object.entries(c).filter(([k])=>k!=='applies_to'));}return ok(result);}if(endpoint==='/v1/coupons'){const applies=Object.entries(body).filter(([k])=>k.startsWith('applies_to[products][' )).map(([,v])=>v);const c={id:body.id,percent_off:Number(body.percent_off),duration:body.duration,valid:true,applies_to:{products:applies},metadata:{managed_by:body['metadata[managed_by]'],...(body['metadata[wh_earn_owner]']?{wh_earn_owner:body['metadata[wh_earn_owner]']}:{})}};coupons.set(mode+':'+c.id,c);const expanded=body['expand[0]']==='applies_to';if(expanded&&omitExpandedCouponCreateOnce>0){omitExpandedCouponCreateOnce--;return ok(Object.fromEntries(Object.entries(c).filter(([k])=>k!=='applies_to')));}return ok(expanded?c:Object.fromEntries(Object.entries(c).filter(([k])=>k!=='applies_to')));}
 if(endpoint==='/v1/promotion_codes'){
  if(init.method==='GET'){const p=[...promos.values()].find(x=>x.mode===mode&&x.code===u.searchParams.get('code')&&x.active);return ok({data:p?[p]:[]});}
  const promo={id:'promo_'+mode+'_'+(++promoSerial),mode,code:body.code,coupon:body.coupon,active:true,livemode:live,expires_at:null,max_redemptions:null,metadata:{managed_by:'wh-earn',wh_earn_owner:body['metadata[wh_earn_owner]']}};promos.set(promo.id,promo);return ok(promo);
 }
 if(endpoint.startsWith('/v1/promotion_codes/')){const p=promos.get(endpoint.split('/').at(-1));if(init.method==='POST'&&p)p.active=body.active!=='false';return p?ok(p):ok({error:{code:'resource_missing'}},404);}
 if(endpoint==='/v1/checkout/sessions'){subscriptionPromos[mode]=body['discounts[0][promotion_code]'];return ok({url:'https://checkout.stripe.com/test-session'});}
 if(endpoint.startsWith('/v1/invoices/'))return ok(invoiceOverride||{id:endpoint.split('/').at(-1),customer:'cus_friend',status:'paid',currency,livemode:live,amount_paid:paid,total_excluding_tax:total,total_taxes:[{amount:900}],parent:{subscription_details:{subscription:'sub_friend'}},lines:{data:[{pricing:{price_details:{price:priceId}},period:{end:now/1000+86400}}]},status_transitions:{paid_at:Date.parse('2026-08-15T00:00:00Z')/1000}});
 if(endpoint==='/v1/subscriptions/sub_friend')return ok(subscriptionOverride||{id:'sub_friend',status:subStatus,cancel_at_period_end:cancelAtPeriodEnd,metadata:subscriptionCode?{wh_earn_code:subscriptionCode}:{},discounts:subscriptionPromos[mode]?[{promotion_code:subscriptionPromos[mode]}]:[],items:{data:[{price:subscriptionPriceId}]}});
 if(endpoint==='/v1/customers/cus_friend')return ok({email});
 if(endpoint==='/v1/invoice_payments')return ok({data:[{status:'paid',payment:{type:'payment_intent',payment_intent:{latest_charge:'ch_'+u.searchParams.get('invoice')}}}]});
 if(endpoint.startsWith('/v1/charges/'))return ok({amount_refunded:endpoint.endsWith('/'+refundChargeId)?refund:0,disputed:endpoint.endsWith('/'+refundChargeId)&&dispute,livemode:live});
 if(endpoint==='/v1/disputes')return ok({data:[{status:disputeStatus}]});
 if(endpoint==='/v2/core/accounts'&&init.method==='POST')return ok({id:'acct_'+mode});
 if(endpoint.startsWith('/v2/core/accounts/'))return ok({id:'acct_'+mode,defaults:{payout_methods:{usd:'usba_test_fixture'}},configuration:{recipient:{capabilities:{bank_accounts:{local:{status:'active'}}}}}});
 if(endpoint==='/v2/core/account_links')return ok({url:'https://accounts.stripe.com/setup/test'});
 if(endpoint.startsWith('/v2/money_management/financial_accounts/'))return ok({status:'open',livemode:live});
 if(endpoint==='/v2/money_management/financial_accounts')return ok({data:[]});
 if(endpoint==='/v2/money_management/outbound_payments'&&init.method==='POST'){
  const key=init.headers['Idempotency-Key'];if(idempotency.has(key))return ok(payouts.get(idempotency.get(key)));
  const p={id:'obp_'+(++sends),amount:body.amount,to:body.to,livemode:live,status:'processing'};payouts.set(p.id,p);idempotency.set(key,p.id);if(failSubmit)throw Error('connection lost after Stripe accepted');return ok(p);
 }
 if(endpoint.startsWith('/v2/money_management/outbound_payments/')){if(postReadFailure)return ok({error:{code:'temporary_read_failure'}},400);return ok(payouts.get(endpoint.split('/').at(-1)));}
 throw Error('Unexpected request '+endpoint);
};
let svc=new EarnStripeService(dir,ledger,()=>cfg,'https://hub.example',()=>now,fake);
const event=(type,id,object)=>({type,id,object,livemode:true,createdMs:now});
try{
await test('disabled by default; explicit mode and automatic prerequisites',async()=>{const before=calls.length;await svc.handleEvent(event('invoice.paid','evt_unconfigured',{id:'in_unconfigured'}));assert.equal(calls.length,before);await assert.rejects(svc.activate(owner),/not enabled/);assert.throws(()=>svc.configure({automatic:true}),/select/);svc.configure({enabled:true});});
await test('forever software-only coupon; custom referrer code and safe Checkout',async()=>{
 await svc.activate(owner);const coupon=calls.find(c=>c.endpoint==='/v1/coupons');assert.equal(coupon.body.duration,'forever');assert.equal(coupon.body.percent_off,'10');assert.equal(coupon.body['applies_to[products][0]'],'prod_wh');
 assert.equal(coupon.body['expand[0]'],'applies_to');
 assert.equal(svc.view(owner).appliedDiscountPercent,10);assert.equal(svc.view(owner).appliedDiscountDuration,'forever');assert.equal(svc.view(owner).activationRequired,false);
 svc.ledger('test').transaction(s=>{s.stripe??={profiles:{}};s.stripe.profiles[owner].verifiedPromotion=null;s.stripe.profiles[owner].appliedDiscountPercent=77;});assert.equal(svc.view(owner).referralUrl,null);assert.equal(svc.view(owner).appliedDiscountPercent,null);assert.equal(svc.view(owner).activationRequired,true);
 const proofReads=calls.length;await svc.activate(owner);const currentPromo=svc.admin().profiles[owner].promotion;assert.ok(calls.slice(proofReads).some(c=>c.endpoint==='/v1/promotion_codes/'+currentPromo));assert.ok(calls.slice(proofReads).some(c=>c.endpoint.startsWith('/v1/coupons/')));assert.equal(svc.view(owner).appliedDiscountPercent,10);
 assert.ok(calls.slice(proofReads).filter(c=>c.endpoint.startsWith('/v1/coupons/')).every(c=>c.query['expand[0]']==='applies_to'));
 const couponId=promos.get(currentPromo).coupon,savedPercent=coupons.get('test:'+couponId).percent_off;coupons.get('test:'+couponId).percent_off=12;
 await assert.rejects(svc.activate(owner),/coupon does not match/);assert.equal(svc.view(owner).referralUrl,null);coupons.get('test:'+couponId).percent_off=savedPercent;await svc.activate(owner);
 await svc.checkout(member.code,'monthly');const co=calls.find(c=>c.endpoint==='/v1/checkout/sessions');assert.equal(co.body['subscription_data[metadata][wh_earn_code]'],member.code);assert.equal(co.body['discounts[0][promotion_code]'],subscriptionPromos.test);assert.equal(co.headers['Stripe-Version'],'2025-03-31.basil');await assert.rejects(svc.checkout(member.code,'hosting'),/unavailable/);
 assert.equal(svc.launchReferral(member.code,'test').code,member.code);
 assert.throws(()=>svc.launchReferral(member.code,'live'),/payment mode/);
});
await test('Oskaras one-time setup registers only the three reviewed reusable forever offers',async()=>{
 const result=await svc.registerOskarasOffers(owner);assert.deepEqual(result.offers.map(o=>[o.code,o.percent,o.duration]),[['OskarasTrading10K7',10,'forever'],['OskarasTrading20M4',20,'forever'],['OskarasTrading25R8',25,'forever']]);
 for(const offer of result.offers){const promo=promos.get(offer.promotion),coupon=coupons.get('test:'+promo.coupon);assert.equal(promo.active,true);assert.equal(promo.max_redemptions,null);assert.equal(promo.expires_at,null);assert.equal(coupon.duration,'forever');assert.equal(coupon.percent_off,offer.percent);assert.deepEqual(coupon.applies_to.products,['prod_wh']);assert.equal(svc.launchReferral(offer.code,'test').discountPercent,offer.percent);assert.equal(svc.launchReferral(offer.code,'test').code,member.code);}
 await svc.checkout('OskarasTrading20M4','monthly');const checkout=calls.filter(c=>c.endpoint==='/v1/checkout/sessions').at(-1);assert.equal(checkout.body['discounts[0][promotion_code]'],result.offers[1].promotion);assert.equal(checkout.body['subscription_data[metadata][wh_earn_code]'],member.code);
});
await test('hosted monthly and yearly invoices earn on net software and refund against the full bundle payment',async()=>{
 const offers=structuredClone(svc.admin().profiles[owner].partnerPromotions),offer=offers.find(x=>x.code==='OskarasTrading10K7');assert.ok(offer);
 const previous={invoiceId,subscriptionCode,email,priceId,subscriptionPriceId,currency,paid,total,refund,refundChargeId,subStatus,promo:subscriptionPromos.test,invoiceOverride,subscriptionOverride};
 try {
  for(const plan of ['monthly','yearly']){
   const isolated=path.join(dir,'hosted-'+plan),localLedger=new EarnService(isolated,()=>now);localLedger.copyMember(member);
   const only=new EarnStripeService(isolated,localLedger,()=>cfg,'https://hub.example',()=>now,fake);only.configure({enabled:true});
   only.ledger('test').transaction(s=>{s.stripe??={profiles:{},invoices:{},jobs:[],seen:{}};s.stripe.profiles[owner]={partnerPromotions:offers};});
   const softwarePriceId=plan==='yearly'?'price_yearly':'price_month',softwareAmountCents=plan==='yearly'?69900:9900;
   const hostingPriceId=plan==='yearly'?'price_hosting_year':'price_hosting',hostingAmountCents=plan==='yearly'?24000:2000,hostingInterval=plan==='yearly'?'year':'month';
   const intentId=(plan==='yearly'?'b':'a').repeat(64),reservationId='res_'+plan;
   const intent={id:intentId,mode:'test',plan,payment:'card',licenseId:null,requestHash:'fixture',createdAtMs:now,firstPaymentAtMs:null,accessUntilMs:null,discountPercent:10,sessionId:'cs_'+plan,
    hosting:{softwarePriceId,softwareProductId:'prod_wh',softwareAmountCents,hostingPriceId,hostingProductId:'prod_hosting',hostingAmountCents,hostingInterval,reservationId,expiresAtMs:now+60000},
    stripeParams:{'metadata[bundle]':'software-hosting-v2','metadata[reservation]':reservationId,'line_items[0][price]':softwarePriceId,'line_items[1][price]':hostingPriceId}};
   const intentDir=path.join(isolated,'billing-launch-intents.v1');fs.mkdirSync(intentDir,{recursive:true});fs.writeFileSync(path.join(intentDir,intentId+'.json'),JSON.stringify(intent));
   new BillingStore(isolated).putBundleSubscription({subscriptionId:'sub_friend',reservationId,customerId:'cus_friend',planKey:plan,priceId:softwarePriceId,launchIntentId:intentId,latestEventCreatedMs:now,pendingStatus:null,terminal:false,updatedAtMs:now});
   const discount=Math.round(softwareAmountCents*.1),softwareLine={pricing:{price_details:{price:softwarePriceId,product:'prod_wh'}},quantity:1,amount:softwareAmountCents,amount_excluding_tax:softwareAmountCents,pretax_credit_amounts:[{amount:discount}],taxes:[],period:{end:now/1000+86400}};
   const hostingLine={pricing:{price_details:{price:hostingPriceId,product:'prod_hosting'}},quantity:1,amount:hostingAmountCents,amount_excluding_tax:hostingAmountCents,pretax_credit_amounts:[],taxes:[],period:{end:now/1000+86400}};
   invoiceId='in_hosted_'+plan;refundChargeId='ch_'+invoiceId;refund=0;email='friend@example.com';currency='usd';subStatus='active';subscriptionCode=member.code;paid=plan==='yearly'?90000:12001;total=paid;
   invoiceOverride={id:invoiceId,customer:'cus_friend',status:'paid',currency:'usd',livemode:false,amount_paid:paid,total_excluding_tax:paid,parent:{subscription_details:{subscription:'sub_friend'}},lines:{data:[softwareLine,hostingLine]},status_transitions:{paid_at:Date.parse('2026-08-15T00:00:00Z')/1000}};
   subscriptionOverride={id:'sub_friend',customer:'cus_friend',livemode:false,status:'active',metadata:{bundle:'software-hosting-v2',reservation:reservationId,wh_launch_intent:intentId,plan,wh_earn_code:member.code},discounts:[{promotion_code:offer.promotion}],items:{data:[{price:softwarePriceId,quantity:1},{price:hostingPriceId,quantity:1}]}};subscriptionPromos.test=offer.promotion;
   await only.handleEvent({...event('invoice.paid','evt_hosted_'+plan,{id:invoiceId}),livemode:false});
   const record=only.ledger('test').admin().stripe.invoices[invoiceId];assert.ok(record);assert.equal(record.basis,softwareAmountCents-discount,'Earn basis includes only discounted software revenue');assert.equal(record.paid,paid,'refund denominator preserves complete software, hosting, and tax collection');assert.equal(record.commission,Math.floor(record.basis*20/100));
   if(plan==='monthly'){
    const validInvoice=structuredClone(invoiceOverride),validSubscription=structuredClone(subscriptionOverride);
    const invalidCases=[
     ['reservation',sub=>{sub.metadata.reservation='res_wrong';},null],
     ['subscription customer',sub=>{sub.customer='cus_wrong';},null],
     ['invoice customer',null,inv=>{inv.customer='cus_wrong';}],
     ['subscription mode',sub=>{sub.livemode=true;},null],
     ['invoice software price',null,inv=>{inv.lines.data[0].pricing.price_details.price='price_other';}],
     ['discounted VPS',null,inv=>{inv.lines.data[1].pretax_credit_amounts=[{amount:100,type:'discount',discount:'di_fixture'}];}],
    ];
    for(const [label,changeSubscription,changeInvoice] of invalidCases){
     invoiceId='in_hosted_invalid_'+label.replaceAll(' ','_');refundChargeId='ch_'+invoiceId;subscriptionOverride=structuredClone(validSubscription);invoiceOverride={...structuredClone(validInvoice),id:invoiceId};
     if(changeSubscription)changeSubscription(subscriptionOverride);if(changeInvoice)changeInvoice(invoiceOverride);
     await assert.rejects(only.handleEvent({...event('invoice.paid','evt_'+invoiceId,{id:invoiceId}),livemode:false}),undefined,label+' must fail closed');
     assert.equal(only.ledger('test').admin().stripe.invoices[invoiceId],undefined,label+' cannot create payable attribution');
    }
    invoiceOverride=validInvoice;subscriptionOverride=validSubscription;invoiceId=record.id;refundChargeId='ch_'+record.id;
    refund=6000;await only.handleEvent({...event('charge.refunded','evt_hosted_partial',{id:refundChargeId}),livemode:false});
    assert.equal(only.ledger('test').view(owner,'Referrer').balances.referral,record.commission-Math.floor(record.commission*refund/paid),'partial clawback uses the aggregate collected bundle amount');
    invoiceId='in_hosted_customer_credit';refundChargeId='ch_'+invoiceId;refund=0;paid=6000;invoiceOverride={...invoiceOverride,id:invoiceId,amount_paid:paid,total_taxes:[{amount:1000}]};
    await only.handleEvent({...event('invoice.paid','evt_hosted_customer_credit',{id:invoiceId}),livemode:false});
    const credited=only.ledger('test').admin().stripe.invoices[invoiceId];assert.equal(credited.basis,3000,'cash basis is capped after tax and the full VPS charge when customer credit reduces collection');assert.equal(credited.paid,6000);assert.equal(credited.commission,600);
   }
  }
 } finally {invoiceId=previous.invoiceId;subscriptionCode=previous.subscriptionCode;email=previous.email;priceId=previous.priceId;subscriptionPriceId=previous.subscriptionPriceId;currency=previous.currency;paid=previous.paid;total=previous.total;refund=previous.refund;refundChargeId=previous.refundChargeId;subStatus=previous.subStatus;subscriptionPromos.test=previous.promo;invoiceOverride=previous.invoiceOverride;subscriptionOverride=previous.subscriptionOverride;}
});
await test('Lifetime hosted invoices never create recurring software referral earnings',async()=>{
 const previous={invoiceId,invoiceOverride,subscriptionOverride,refundChargeId,promo:subscriptionPromos.test};
 try {
  invoiceId='in_hosted_lifetime';refundChargeId='ch_'+invoiceId;subscriptionPromos.test=null;
  invoiceOverride={id:invoiceId,customer:'cus_friend',status:'paid',currency:'usd',livemode:false,amount_paid:2000,parent:{subscription_details:{subscription:'sub_friend'}},lines:{data:[{pricing:{price_details:{price:'price_hosting',product:'prod_hosting'}},quantity:1,amount:2000,amount_excluding_tax:2000,period:{end:now/1000+86400}}]},status_transitions:{paid_at:now/1000}};
  subscriptionOverride={id:'sub_friend',status:'active',metadata:{bundle:'software-hosting-v2',plan:'lifetime'},discounts:[],items:{data:[{price:'price_hosting',quantity:1}]}};
  const before=Object.keys(svc.ledger('test').admin().stripe.invoices).length;await svc.handleEvent({...event('invoice.paid','evt_hosted_lifetime',{id:invoiceId}),livemode:false});
  assert.equal(svc.ledger('test').admin().stripe.invoices[invoiceId],undefined);assert.equal(Object.keys(svc.ledger('test').admin().stripe.invoices).length,before);
 } finally {invoiceId=previous.invoiceId;invoiceOverride=previous.invoiceOverride;subscriptionOverride=previous.subscriptionOverride;refundChargeId=previous.refundChargeId;subscriptionPromos.test=previous.promo;}
});
await test('missing expanded coupon scope aborts before creating an active referral promotion',async()=>{
 const isolated=path.join(dir,'missing-create-scope'),localLedger=new EarnService(isolated,()=>now),localOwner=earnOwner('email:scope-review@example.com');localLedger.member(localOwner,'Scope review');
 const local=new EarnStripeService(isolated,localLedger,()=>cfg,'https://hub.example',()=>now,fake);local.configure({enabled:true});
 const before=promos.size;omitExpandedCouponCreateOnce=1;await assert.rejects(local.activate(localOwner),/expanded coupon product scope/);
 assert.equal(promos.size,before,'an unproved canonical coupon response cannot create a public active promotion');
 await local.activate(localOwner);assert.equal(promos.size,before+1,'activation can proceed after Stripe returns the expanded scope');
});
await test('partner-only offers admit first invoice, retry transient proof reads, renew and reconcile refunds',async()=>{
 const isolated=path.join(dir,'partner-only'),partnerLedger=new EarnService(isolated,()=>now);partnerLedger.copyMember(member);
 const offers=structuredClone(svc.admin().profiles[owner].partnerPromotions);assert.ok(offers.length);
 const only=new EarnStripeService(isolated,partnerLedger,()=>cfg,'https://hub.example',()=>now,fake);only.configure({enabled:true});
 only.ledger('test').transaction(s=>{s.stripe??={profiles:{},invoices:{},jobs:[],seen:{}};s.stripe.profiles[owner]={partnerPromotions:offers};});
 assert.equal(only.admin().profiles[owner].promotion,undefined,'the isolated profile contains no standard promotion');
 const outbox=new AfterCommitOutbox(isolated),billing=new BillingService(isolated,new BillingStore(isolated),'https://hub.example',templates,{now:()=>now,onVerifiedEvent:ev=>only.handleEvent(ev),log:()=>{}});
 const throughOutbox=async ev=>{outbox.stage(ev,now);outbox.commit(ev.id);return billing.drainAfterCommit();};
 const offer=offers.find(x=>x.code==='OskarasTrading10K7');assert.ok(offer);
 const previous={invoiceId,subscriptionCode,email,priceId,subscriptionPriceId,currency,paid,total,refund,refundChargeId,subStatus,promo:subscriptionPromos.test};
 try {
  subscriptionPromos.test=offer.promotion;subscriptionCode=member.code;email='friend@example.com';priceId='price_month';currency='usd';paid=9900;total=9000;subStatus='active';refund=0;
  const first={...event('invoice.paid','evt_partner_first',{id:'in_partner_first'}),livemode:false};invoiceId='in_partner_first';refundChargeId='ch_in_partner_first';
  failingEndpoint='/v1/promotion_codes/'+offer.promotion;failingCount=1;
  assert.deepEqual(await throughOutbox(first),{completed:0,failed:1});assert.equal(outbox.pending().length,1);
  assert.equal(only.ledger('test').admin().stripe.invoices.in_partner_first,undefined);
  const ignoredFile=path.join(isolated,'earn-stripe-ignored-test.v1.json');assert.ok(!fs.existsSync(ignoredFile)||!fs.readFileSync(ignoredFile,'utf8').includes(first.id),'transient promotion lookup was not permanently sidecar-acknowledged');
  failingEndpoint='';omitExpandedCouponOnce=1;assert.deepEqual(await throughOutbox(first),{completed:0,failed:1});assert.equal(outbox.pending().length,1,'missing expanded coupon scope remains retryable');
  assert.equal(only.ledger('test').admin().stripe.invoices.in_partner_first,undefined);
  assert.ok(!fs.existsSync(ignoredFile)||!fs.readFileSync(ignoredFile,'utf8').includes(first.id),'missing expanded coupon scope was not permanently sidecar-acknowledged');
  assert.deepEqual(await throughOutbox(first),{completed:1,failed:0});assert.equal(outbox.pending().length,0);
  assert.equal(only.ledger('test').view(owner,'Referrer').balances.referral,1800,'the recovered original event credits exactly once');
  const renewal={...event('invoice.paid','evt_partner_renewal',{id:'in_partner_renewal'}),livemode:false};invoiceId='in_partner_renewal';refundChargeId='ch_in_partner_renewal';
  failingEndpoint='/v1/coupons/'+offer.proof.coupon;failingCount=1;
  assert.deepEqual(await throughOutbox(renewal),{completed:0,failed:1});assert.equal(outbox.pending().length,1);
  assert.equal(only.ledger('test').admin().stripe.invoices.in_partner_renewal,undefined);
  assert.ok(!fs.existsSync(ignoredFile)||!fs.readFileSync(ignoredFile,'utf8').includes(renewal.id),'transient coupon lookup was not permanently sidecar-acknowledged');
  failingEndpoint='';refund=0;assert.deepEqual(await throughOutbox(renewal),{completed:1,failed:0});assert.equal(outbox.pending().length,0);
  assert.equal(only.ledger('test').view(owner,'Referrer').balances.referral,3600);
  refund=4950;refundChargeId='ch_in_partner_first';
  await only.handleEvent({...event('charge.refunded','evt_partner_refund',{id:refundChargeId}),livemode:false});
  assert.equal(only.ledger('test').view(owner,'Referrer').balances.referral,2700,'partial refund reduces only its invoice commission');
  await only.handleEvent({...event('charge.refunded','evt_partner_refund_again',{id:refundChargeId}),livemode:false});
  assert.equal(only.ledger('test').view(owner,'Referrer').balances.referral,2700,'refund webhook replay does not duplicate the clawback');
  assert.equal(Object.keys(only.ledger('test').admin().stripe.invoices).length,2);
  for(const call of calls.filter(c=>c.endpoint.startsWith('/v1/coupons/')))assert.equal(call.query['expand[0]'],'applies_to','all canonical coupon reads explicitly expand product scope');
 } finally {invoiceId=previous.invoiceId;subscriptionCode=previous.subscriptionCode;email=previous.email;priceId=previous.priceId;subscriptionPriceId=previous.subscriptionPriceId;currency=previous.currency;paid=previous.paid;total=previous.total;refund=previous.refund;refundChargeId=previous.refundChargeId;subStatus=previous.subStatus;subscriptionPromos.test=previous.promo;failingEndpoint='';failingCount=0;omitExpandedCouponOnce=0;}
});
await test('retired verified offer history admits the first invoice and old price; expired coupon still credits applied renewal',async()=>{
 const isolated=path.join(dir,'history-only'),historyLedger=new EarnService(isolated,()=>now);historyLedger.copyMember(member);
 const offer=structuredClone(svc.admin().profiles[owner].partnerPromotions.find(x=>x.code==='OskarasTrading10K7'));
 const historyOnly=new EarnStripeService(isolated,historyLedger,()=>cfg,'https://hub.example',()=>now,fake);historyOnly.configure({enabled:true});
 historyOnly.ledger('test').transaction(s=>{s.stripe??={profiles:{},invoices:{},jobs:[],seen:{}};s.stripe.profiles[owner]={promotionHistory:[{...offer,proof:offer.proof}]};});
 const previous={invoiceId,subscriptionCode,email,priceId,subscriptionPriceId,currency,paid,total,refund,refundChargeId,subStatus,promo:subscriptionPromos.test};
 try {
  invoiceId='in_history_first';subscriptionCode=member.code;email='friend@example.com';priceId='price_legacy';subscriptionPriceId='price_legacy';currency='usd';paid=9900;total=9000;refund=0;refundChargeId='ch_history';subStatus='active';subscriptionPromos.test=offer.promotion;
  coupons.get('test:'+offer.proof.coupon).valid=false;
  await historyOnly.handleEvent({...event('invoice.paid','evt_history_first',{id:invoiceId}),livemode:false});
  assert.equal(historyOnly.ledger('test').view(owner,'Referrer').balances.referral,1800,'retired-offer history admits the event and a legacy price under its verified product scope');
  assert.ok(historyOnly.admin().profiles[owner].promotionHistory[0].proof,'successful proof is retained for subsequent renewals after coupon redemption validity expires');
  await historyOnly.handleEvent({...event('invoice.paid','evt_history_replay',{id:invoiceId}),livemode:false});
  assert.equal(historyOnly.ledger('test').view(owner,'Referrer').balances.referral,1800,'invoice replay is idempotent');
  coupons.get('test:'+offer.proof.coupon).valid=true;
 } finally {invoiceId=previous.invoiceId;subscriptionCode=previous.subscriptionCode;email=previous.email;priceId=previous.priceId;subscriptionPriceId=previous.subscriptionPriceId;currency=previous.currency;paid=previous.paid;total=previous.total;refund=previous.refund;refundChargeId=previous.refundChargeId;subStatus=previous.subStatus;subscriptionPromos.test=previous.promo;coupons.get('test:'+offer.proof.coupon).valid=true;}
});
await test('canonical historical proof can preserve an already-applied coupon after redemption validity ends',async()=>{
 const historical=svc.admin().profiles[owner],promotion=historical.promotion,couponId=promos.get(promotion).coupon;
 assert.ok(promotion&&couponId);const isolated=path.join(dir,'legacy-expired'),legacyLedger=new EarnService(isolated,()=>now);legacyLedger.copyMember(member);legacyLedger.configure({owner,discountPercent:0});
 const legacy=new EarnStripeService(isolated,legacyLedger,()=>cfg,'https://hub.example',()=>now,fake);legacy.configure({enabled:true});
 legacy.ledger('test').transaction(s=>{s.stripe??={profiles:{},invoices:{},jobs:[],seen:{}};s.stripe.profiles[owner]={promotion,code:historical.code,products:historical.products,appliedDiscountPercent:10,verifiedPromotion:null};});
 const previous={invoiceId,subscriptionCode,email,priceId,subscriptionPriceId,currency,paid,total,refund,refundChargeId,subStatus,promo:subscriptionPromos.test};
 try {
  coupons.get('test:'+couponId).valid=false;invoiceId='in_legacy_expired';subscriptionCode=member.code;email='friend@example.com';priceId='price_month';subscriptionPriceId='price_month';currency='usd';paid=9900;total=9000;refund=0;refundChargeId='ch_legacy_expired';subStatus='active';subscriptionPromos.test=promotion;
  await legacy.activate(owner);
  assert.equal(legacy.admin().profiles[owner].promotionHistory[0].coupon,couponId,'historical canonical coupon facts are retained even though new redemptions are closed');
  await legacy.handleEvent({...event('invoice.paid','evt_legacy_expired',{id:invoiceId}),livemode:false});
  assert.equal(legacy.ledger('test').view(owner,'Referrer').balances.referral,1800,'verified existing subscription renewal remains eligible');
 } finally {invoiceId=previous.invoiceId;subscriptionCode=previous.subscriptionCode;email=previous.email;priceId=previous.priceId;subscriptionPriceId=previous.subscriptionPriceId;currency=previous.currency;paid=previous.paid;total=previous.total;refund=previous.refund;refundChargeId=previous.refundChargeId;subStatus=previous.subStatus;subscriptionPromos.test=previous.promo;coupons.get('test:'+couponId).valid=true;}
});
await test('test recipient and referral money stay out of real earnings',async()=>{
 await svc.onboard(owner,{country:'US',email:'referrer@example.com'});await svc.handleEvent({...event('invoice.paid','evt_test',{id:'in_test'}),livemode:false});assert.equal(ledger.view(owner,'Referrer').balances.referral,0);assert.equal(svc.ledger('test').view(owner,'Referrer').balances.referral,1800);
});
await test('older shared referral codes resolve to the current promotion after discount rotation',async()=>{
 ledger.configure({owner,discountPercent:15});await svc.activate(owner);
 const firstRotated=svc.view(owner).referralUrl.split('ref=')[1];
 ledger.configure({owner,discountPercent:20});await svc.activate(owner);
 assert.notEqual(firstRotated,svc.view(owner).referralUrl.split('ref=')[1]);
 const count=calls.filter(c=>c.endpoint==='/v1/checkout/sessions').length;
 await svc.checkout(member.code,'monthly');await svc.checkout(firstRotated,'monthly');
 assert.equal(calls.filter(c=>c.endpoint==='/v1/checkout/sessions').length,count+2);
});
svc.configure({mode:'live'});assert.throws(()=>svc.configure({payoutKey:'sk_live_fixture'}),/restricted/);svc.configure({payoutKey:'rk_live_fixture'});assert.ok(!JSON.stringify(svc.admin()).includes('rk_live_fixture'));await svc.activate(owner);await svc.registerOskarasOffers(owner);await svc.checkout('OskarasTrading10K7','monthly');
await test('manual payout destination blocks new Stripe admission but preserves existing job reconciliation',async()=>{
 const isolated=tmpDir('earn-manual-destination'),at=Date.parse('2026-10-17T12:00:00Z');
 try {
  const localLedger=new EarnService(isolated,()=>at),manual=earnOwner('email:manual-destination@example.com'),automatic=earnOwner('email:auto-destination@example.com'),racing=earnOwner('email:race-destination@example.com');
  localLedger.member(manual,'Manual destination');localLedger.member(automatic,'Automatic destination');localLedger.member(racing,'Race destination');
  localLedger.savePayoutPreference(manual,{method:'usdt-polygon',address:'0x1234567890abcdef1234567890abcdef12345678',expectedRevision:null});
  const posts=[],accepted=new Map([['wh_payout_job_current','obp_previously_accepted']]),outcomes=new Map([
   ['obp_historic',{id:'obp_historic',amount:{value:100,currency:'usd'},to:{recipient:'acct_manual'},livemode:false,status:'posted'}],
   ['obp_previously_accepted',{id:'obp_previously_accepted',amount:{value:200,currency:'usd'},to:{recipient:'acct_manual'},livemode:false,status:'processing'}]
  ]);
  const localFetch=async(url,init)=>{
   const endpoint=new URL(url).pathname,ok=(body,status=200)=>new Response(JSON.stringify(body),{status});
   if(endpoint.startsWith('/v2/money_management/financial_accounts/fa_'))return ok({status:'open',livemode:false});
   if(endpoint.startsWith('/v2/core/accounts/')){
    if(endpoint.endsWith('/acct_race'))payoutLedger.savePayoutPreference(racing,{method:'paypal',address:'race@example.com',expectedRevision:null});
    return ok({id:endpoint.split('/').at(-1),defaults:{payout_methods:{usd:'ba_test'}},configuration:{recipient:{capabilities:{bank_accounts:{local:{status:'active'}}}}}});
   }
   if(endpoint==='/v2/money_management/outbound_payments'&&init.method==='POST'){
    const body=JSON.parse(init.body),key=init.headers['Idempotency-Key'];posts.push({body,key});
    if(accepted.has(key))return ok(outcomes.get(accepted.get(key)));
    const created={id:'obp_new',amount:body.amount,to:body.to,livemode:false,status:'processing'};accepted.set(key,created.id);outcomes.set(created.id,created);return ok(created);
   }
   if(endpoint.startsWith('/v2/money_management/outbound_payments/'))return ok(outcomes.get(endpoint.split('/').at(-1)));
   throw Error('Unexpected fake request '+endpoint);
  };
  const local=new EarnStripeService(isolated,localLedger,()=>cfg,'https://hub.example',()=>at,localFetch);
  const payoutLedger=local.ledger('test');
  payoutLedger.copyMember(localLedger.admin().members.find(m=>m.id===manual));
  payoutLedger.copyMember(localLedger.admin().members.find(m=>m.id===automatic));
  payoutLedger.copyMember(localLedger.admin().members.find(m=>m.id===racing));
  for(const [who,reference] of [[manual,'manual-earned'],[automatic,'automatic-earned'],[racing,'racing-earned']])payoutLedger.record({owner:who,source:'referral',kind:'earning',cents:5000,period:'2026-09',reference,note:'Completed earning'});
  const historic={id:'job_historic',owner:manual,cycle:'2026-09',recipient:'acct_manual',financialAccount:'fa_test_fixture',amount:100,
    allocations:[{source:'referral',cents:100}],status:'processing',created:at-7_200_000,stripeId:'obp_historic'};
  const unresolved={id:'job_current',owner:manual,cycle:'2026-10',recipient:'acct_manual',financialAccount:'fa_test_fixture',amount:200,
    allocations:[{source:'referral',cents:200}],status:'submitting',created:at-60_000};
  payoutLedger.transaction(s=>{s.stripe={profiles:{[manual]:{recipient:'acct_manual'},[automatic]:{recipient:'acct_automatic'},[racing]:{recipient:'acct_race'}},invoices:{},jobs:[historic,unresolved],seen:{}};});
  try{
   local.configure({enabled:true,automatic:true,financialAccount:'fa_test_fixture'});await local.run();
   const state=payoutLedger.admin(),jobs=state.stripe.jobs;
   assert.equal(posts.length,2,'new automatic job plus recovery of the already accepted ambiguous job');
   assert.equal(posts.find(p=>p.key==='wh_payout_job_current').body.to.recipient,'acct_manual');
   const recovered=jobs.find(j=>j.id==='job_current');
   assert.equal(recovered.stripeId,'obp_previously_accepted');assert.equal(recovered.status,'processing');
   for(const key of ['owner','cycle','recipient','financialAccount','amount','allocations','created'])assert.deepEqual(recovered[key],unresolved[key],'recovery preserves the original reservation');
   assert.equal(outcomes.size,3,'recovery creates no duplicate provider payment');
   assert.equal(posts.find(p=>p.key!=='wh_payout_job_current').body.to.recipient,'acct_automatic');
   assert.equal(jobs.find(j=>j.id==='job_historic').status,'posted','saved destination does not block reconciliation of an existing accepted Stripe payout');
   assert.equal(jobs.filter(j=>j.owner===automatic&&j.cycle==='2026-10').length,1);
   assert.equal(jobs.some(j=>j.owner===racing&&j.cycle==='2026-10'),false,'preference saved while recipient lookup was in flight blocks atomic payout admission');
   assert.equal(payoutLedger.view(racing,'Race destination').member.payoutPreference.address,'race@example.com');
   assert.equal(state.entries.filter(e=>e.reference==='stripe:payout:job_historic:referral').length,1);
   assert.equal(state.entries.filter(e=>e.kind==='hold'&&e.owner===manual).length,0,'choosing a destination does not reserve new earnings');
  }finally{local.stop();}
 }finally{fs.rmSync(isolated,{recursive:true,force:true});}
});
await test('renewals credit once per invoice, even with two event types and restarts',async()=>{
 await svc.handleEvent(event('invoice.paid','evt_paid',{id:'in_1'}));await svc.handleEvent(event('invoice.payment_succeeded','evt_other',{id:'in_1'}));
 svc=new EarnStripeService(dir,ledger,()=>cfg,'https://hub.example',()=>now,fake);await svc.handleEvent(event('invoice.paid','evt_retry',{id:'in_1'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,1800);
 await svc.handleEvent(event('invoice.paid','evt_renewal',{id:'in_2'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,3600);assert.equal(ledger.view(owner,'Referrer').activeSubscribers,1);
 subscriptionCode='';const before=ledger.view(owner,'Referrer').balances.referral;await svc.handleEvent(event('invoice.paid','evt_typed_code',{id:'in_typed_code'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,before+1800,'actual registered Stripe promotion attributes a typed code without trusting subscription metadata');assert.equal(ledger.admin().stripe.invoices.in_typed_code.owner,owner);
 const afterTyped=ledger.view(owner,'Referrer').balances.referral,active=promos.get(subscriptionPromos.live);active.metadata.wh_earn_owner='forged-owner';await assert.rejects(svc.handleEvent(event('invoice.paid','evt_forged_code_owner',{id:'in_forged_code_owner'})),/durable offer/);assert.equal(ledger.view(owner,'Referrer').balances.referral,afterTyped,'a member-code metadata value cannot override mismatched Stripe promotion ownership');assert.equal(ledger.admin().stripe.invoices.in_forged_code_owner,undefined);active.metadata.wh_earn_owner=owner;subscriptionCode=member.code;
});
await test('paused enrollment still reconciles refunds and disputes without double debit',async()=>{
 svc.configure({enabled:false});refund=4950;await svc.handleEvent(event('charge.refunded','evt_refund',{id:'ch_in_1'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,4500);
 dispute=true;await svc.handleEvent(event('charge.dispute.created','evt_dispute',{charge:'ch_in_1'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,3600);
 disputeStatus='won';await svc.handleEvent(event('charge.dispute.closed','evt_won',{charge:'ch_in_1'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,4500);
 const adjustmentsBefore=ledger.admin().entries.filter(e=>e.kind==='adjustment'&&e.reference.startsWith('stripe:adjust:')).length;
 await svc.handleEvent(event('charge.dispute.created','evt_dispute_repeat',{charge:'ch_in_1'}));await svc.handleEvent(event('charge.dispute.closed','evt_won_repeat',{charge:'ch_in_1'}));await svc.handleEvent(event('charge.refunded','evt_refund_again',{id:'ch_in_1'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,4500);assert.equal(ledger.admin().entries.filter(e=>e.kind==='adjustment'&&e.reference.startsWith('stripe:adjust:')).length,adjustmentsBefore,'repeat webhook deliveries do not add duplicate clawbacks');assert.equal(ledger.view(owner,'Referrer').activeSubscribers,1);refund=0;dispute=false;svc.configure({enabled:true});
});
await test('self referrals, foreign prices and non-USD invoices do not earn',async()=>{
 const before=ledger.view(owner,'Referrer').balances.referral,version=ledger.fileVersion();email='referrer@example.com';await svc.handleEvent(event('invoice.paid','evt_self',{id:'in_self'}));email='friend@example.com';priceId='price_hosting';await svc.handleEvent(event('invoice.paid','evt_foreign',{id:'in_foreign'}));priceId='price_month';currency='eur';await svc.handleEvent(event('invoice.paid','evt_eur',{id:'in_eur'}));currency='usd';assert.equal(ledger.view(owner,'Referrer').balances.referral,before);
 assert.equal(ledger.fileVersion(),version,'proved unrelated events do not rewrite the financial ledger');
 const callsBefore=calls.length;await svc.handleEvent(event('invoice.paid','evt_foreign',{id:'in_foreign'}));assert.equal(calls.length,callsBefore,'bounded sidecar dedupes foreign event replay');
});
await test('scheduled cancellation remains active until Stripe ends the period',async()=>{subStatus='active';cancelAtPeriodEnd=true;await svc.handleEvent(event('customer.subscription.updated','evt_cancel_scheduled',{id:'sub_friend'}));assert.equal(ledger.view(owner,'Referrer').activeSubscribers,1);cancelAtPeriodEnd=false;subStatus='canceled';await svc.handleEvent(event('customer.subscription.deleted','evt_cancel',{id:'sub_friend'}));assert.equal(ledger.view(owner,'Referrer').activeSubscribers,0);});
await svc.onboard(owner,{country:'US',email:'referrer@example.com'});svc.configure({financialAccount:'fa_test_fixture',automatic:true});
await test('reserve before sending; unknown network outcome retries same key after restart',async()=>{
 failSubmit=true;await svc.run();assert.equal(sends,1);const after=ledger.view(owner,'Referrer');assert.equal(after.balances.referral,0);assert.equal(after.paidCents,0);
 assert.throws(()=>ledger.record({owner,source:'referral',kind:'payout',cents:100,period:'2026-08',reference:'manual',note:'manual',method:'bank',paidAt:'2026-09-17'}),/exceeds/);
 svc=new EarnStripeService(dir,ledger,()=>cfg,'https://hub.example',()=>now,fake);failSubmit=false;await svc.run();assert.equal(sends,1);assert.equal(svc.admin().jobs[0].status,'processing');
});
await test('posted settles once; returned funds restore owed earnings and paid total',async()=>{
 payouts.get('obp_1').status='posted';await svc.run();const postedReads=calls.filter(c=>c.endpoint==='/v2/money_management/outbound_payments/obp_1').length;
 await svc.run();assert.equal(calls.filter(c=>c.endpoint==='/v2/money_management/outbound_payments/obp_1').length,postedReads);
 assert.equal(ledger.view(owner,'Referrer').paidCents,4500);assert.equal(ledger.view(owner,'Referrer').balances.referral,0);
 payouts.get('obp_1').status='returned';now+=6*60*60_000;await svc.run();await svc.run();assert.equal(ledger.view(owner,'Referrer').paidCents,0);assert.equal(ledger.view(owner,'Referrer').balances.referral,4500);assert.equal(sends,1);
});
await test('accepted payout plus failed status read never releases money',async()=>{
 now=Date.parse('2026-10-17T12:00:00Z');postReadFailure=true;await svc.run();assert.equal(sends,2);assert.equal(ledger.view(owner,'Referrer').balances.referral,0);assert.equal(svc.admin().jobs[1].status,'submitting');postReadFailure=false;payouts.get('obp_2').status='failed';await svc.run();assert.equal(ledger.view(owner,'Referrer').balances.referral,4500);
});
await test('Stripe-managed entries cannot be manually reversed',()=>{const e=ledger.admin().entries.find(e=>e.actor==='stripe');assert.throws(()=>ledger.reverse({id:e.id,note:'double credit attempt'}),/not found/);});
await test('future-month earnings are never auto-paid',async()=>{
 now=Date.parse('2026-11-17T12:00:00Z');ledger.record({owner,source:'exchange',kind:'earning',cents:5000,reference:'future',note:'future',period:'2026-12'});await svc.run();assert.equal(payouts.get('obp_3').amount.value,4500);assert.equal(ledger.view(owner,'Referrer').balances.exchange,5000);
});
await test('refund after paid commission creates debt that offsets the next payout once',async()=>{
 payouts.get('obp_3').status='posted';await svc.run();assert.equal(ledger.view(owner,'Referrer').balances.referral,0);
 refund=9900;await svc.handleEvent(event('charge.refunded','evt_refund_after_paid',{id:'ch_in_1'}));
 assert.equal(ledger.view(owner,'Referrer').balances.referral,-900,'the already-paid commission reversal remains a durable negative balance');
 ledger.record({owner,source:'referral',kind:'earning',cents:2000,reference:'future-referral',note:'verified future referral earnings',period:'2026-11'});
 now=Date.parse('2026-12-17T12:00:00Z');await svc.run();assert.equal(payouts.get('obp_4').amount.value,1100,'the $900 refund debt offsets $2,000 of eligible later earnings');
});
await test('definite recipient validation refusal permits corrected facts with a new key; ambiguous submit retains exact attempt',async()=>{
 const isolated=tmpDir('recipient-retry');
 try {
  const localLedger=new EarnService(isolated,()=>now),localOwner=earnOwner('email:recipient@example.com');
  localLedger.member(localOwner,'Recipient');
  let outcome='refuse';const posts=[];
  const localFetch=async(url,init)=>{
   const endpoint=new URL(url).pathname;
   if(endpoint==='/v2/core/accounts'){
    posts.push({body:JSON.parse(init.body),key:init.headers['Idempotency-Key']});
    if(outcome==='refuse')return new Response(JSON.stringify({error:{code:'parameter_invalid'}}),{status:400});
    if(outcome==='ambiguous')throw Error('connection lost');
    return new Response(JSON.stringify({id:'acct_test_corrected'}));
   }
   if(endpoint==='/v2/core/account_links')return new Response(JSON.stringify({url:'https://accounts.stripe.com/setup/test'}));
   throw Error('Unexpected request '+endpoint);
  };
  const local=new EarnStripeService(isolated,localLedger,()=>cfg,'https://hub.example',()=>now,localFetch);local.configure({enabled:true});
  await assert.rejects(local.onboard(localOwner,{country:'US',email:'wrong@example.com'}),/400/);
  assert.equal(local.admin().profiles[localOwner].request,null);
  outcome='ambiguous';await assert.rejects(local.onboard(localOwner,{country:'CA',email:'correct@example.com'}),/connection lost/);
  outcome='accept';await local.onboard(localOwner,{country:'GB',email:'ignored@example.com'});
  assert.equal(posts[0].body.contact_email,'wrong@example.com');
  assert.equal(posts[1].body.contact_email,'correct@example.com');
  assert.equal(posts[2].body.contact_email,'correct@example.com');
  assert.notEqual(posts[0].key,posts[1].key);
  assert.equal(posts[1].key,posts[2].key);
  local.stop();
 } finally {fs.rmSync(isolated,{recursive:true,force:true});}
});
await test('a grandfathered inactive price on the proved software product still earns',async()=>{
 const before=ledger.view(owner,'Referrer').balances.referral;
 priceId='price_legacy';await svc.handleEvent(event('invoice.paid','evt_grandfathered',{id:'in_grandfathered'}));priceId='price_month';
 assert.equal(ledger.view(owner,'Referrer').balances.referral,before+1800);
});
await test('zero discount retires the Stripe promotion and refuses referral checkout',async()=>{
 ledger.configure({owner,discountPercent:0});
 const before=calls.length;await svc.activate(owner);
 assert.ok(calls.slice(before).some(c=>c.endpoint.startsWith('/v1/promotion_codes/')&&c.body.active==='false'));
 assert.equal(svc.view(owner).referralUrl,null);
 assert.equal(svc.view(owner).appliedDiscountPercent,0);
 await assert.rejects(svc.checkout(member.code,'monthly'),/discount is not active/);
 const beforeBalance=ledger.view(owner,'Referrer').balances.referral;
 await svc.handleEvent(event('invoice.paid','evt_existing_after_pause',{id:'in_existing_after_pause'}));
 assert.equal(ledger.view(owner,'Referrer').balances.referral,beforeBalance+1800,'an existing referred subscription still earns after enrollment pauses');
});
await test('Earn event dedupe stays bounded while financial invoice records remain durable',async()=>{
 ledger.transaction(s=>{for(let i=0;i<10_001;i++)s.stripe.seen['old-event-'+i]=now-10_000-i;});
 await svc.handleEvent(event('customer.subscription.updated','new-untracked-event',{id:'sub_untracked'}));
 const saved=ledger.admin().stripe;
 assert.ok(Object.keys(saved.seen).length<=10_000);
 assert.ok(saved.seen['new-untracked-event']);
 assert.ok(saved.invoices['in_1']);
});
await test('consumer Gmail dot and plus aliases cannot earn a self-referral commission',async()=>{
 const boundEmails=['jane.doe@gmail.com'];
 svc=new EarnStripeService(dir,ledger,()=>cfg,'https://hub.example',()=>now,fake,
  (_mode,candidate)=>candidate===owner?boundEmails:[]);
 const before=ledger.view(owner,'Referrer').balances.referral;
 email='j.a.n.e.d.o.e+own@gmail.com';
 await svc.handleEvent(event('invoice.paid','evt_gmail_alias',{id:'in_gmail_alias'}));
 assert.equal(ledger.view(owner,'Referrer').balances.referral,before);
 assert.equal(ledger.admin().stripe.invoices['in_gmail_alias'],undefined);
 email='janedoe+other@googlemail.com';
 await svc.handleEvent(event('invoice.paid','evt_googlemail_alias',{id:'in_googlemail_alias'}));
 assert.equal(ledger.view(owner,'Referrer').balances.referral,before);
 assert.equal(ledger.admin().stripe.invoices['in_googlemail_alias'],undefined);
 // Gmail's consumer dot rule does not apply to Workspace or arbitrary domains.
 boundEmails[0]='jane.doe@business.example';email='janedoe@business.example';
 await svc.handleEvent(event('invoice.paid','evt_workspace_distinct',{id:'in_workspace_distinct'}));
 assert.equal(ledger.view(owner,'Referrer').balances.referral,before+1800);
 assert.ok(ledger.admin().stripe.invoices['in_workspace_distinct']);
 boundEmails[0]='jane.doe@gmail.com';email='other@gmail.com';
 await svc.handleEvent(event('invoice.paid','evt_different_gmail',{id:'in_different_gmail'}));
 assert.equal(ledger.view(owner,'Referrer').balances.referral,before+3600);
});
await test('a bound Stripe customer remains a self referral after its email changes',async()=>{
 ledger.bindOwner(['stripe:live:cus_friend'],[owner],owner);
 const before=ledger.view(owner,'Referrer').balances.referral;
 email='changed-referrer@example.com';
 await svc.handleEvent(event('invoice.paid','evt_self_after_email_change',{id:'in_self_after_email_change'}));
 assert.equal(ledger.view(owner,'Referrer').balances.referral,before);
 assert.equal(ledger.admin().stripe.invoices['in_self_after_email_change'],undefined);
});
}finally{svc.stop();fs.rmSync(dir,{recursive:true,force:true});}
summary('earn-stripe');
