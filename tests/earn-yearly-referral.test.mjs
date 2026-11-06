// One-time crypto Yearly referral commission: a self-hosted, payment-mode
// Yearly Checkout sold by the launch crypto checkout (inline price_data for
// the configured Yearly product). Card Yearly and hosted Yearly bundles are
// subscriptions credited through their invoices and never enter this path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EarnService,earnOwner} from '../dist/src/earn.js';
import {EarnStripeService} from '../dist/src/earn-stripe.js';
import {test,tmpDir,summary} from './helpers.mjs';
const dir=tmpDir('earn-yearly'),now=Date.parse('2026-11-05T12:00:00Z');
const ledger=new EarnService(dir,()=>now),owner=earnOwner('email:referrer@example.com');
ledger.member(owner,'Referrer');ledger.configure({owner,commissionPercent:50});
const cfg={plans:[{key:'monthly',role:'software',checkout:'payment-link',interval:'month',currency:'usd',lifetime:false},{key:'yearly',role:'software',checkout:'payment-link',interval:'year',currency:'usd',lifetime:false,amountCents:69900},{key:'lifetime',role:'software',checkout:'payment-link',interval:null,currency:'usd',lifetime:true,amountCents:99900}],
 stripe:{live:{secretKey:'sk_live_fixture',priceIds:{monthly:'price_month',yearly:'price_year',lifetime:'price_lifetime'}},test:{secretKey:'sk_test_fixture',priceIds:{}}}};
const offer={promotion:'promo_p',code:'PARTNER20',percent:20,products:['prod_wh'],proof:{promotion:'promo_p',code:'PARTNER20',coupon:'coupon_p',percent:20,duration:'forever',products:['prod_wh'],verifiedAt:1}};
ledger.transaction(s=>{s.stripe={profiles:{[owner]:{partnerPromotions:[offer]}},invoices:{},jobs:[],seen:{}};});

// Persisted launch crypto Yearly purchases (one per Session).
const intentDir=path.join(dir,'billing-launch-intents.v1');fs.mkdirSync(intentDir,{recursive:true});
let n=0;const intents={};
const intent=(sessionId,extra={},params={})=>{const id=(++n).toString(16).padStart(64,'0');intents[sessionId]=id;
 fs.writeFileSync(path.join(intentDir,id+'.json'),JSON.stringify({id,mode:'live',plan:'yearly',payment:'crypto',licenseId:null,requestHash:'fixture',createdAtMs:now,firstPaymentAtMs:null,accessUntilMs:null,discountPercent:20,hostingRequested:false,sessionId,
  stripeParams:{mode:'payment','payment_method_types[0]':'crypto','line_items[0][quantity]':1,'line_items[0][price_data][product]':'prod_wh','line_items[0][price_data][unit_amount]':69900,'line_items[0][price_data][currency]':'usd',...params},...extra}));return id;};
const meta=sessionId=>({plan:'yearly',managed_by:'wh-launch',wh_launch_intent:intents[sessionId],non_renewing:'true',license_days:'365'});
const session=(id,customer,extra={})=>({id,object:'checkout.session',livemode:true,mode:'payment',status:'complete',payment_status:'paid',currency:'usd',amount_total:55920,customer,payment_intent:'pi_'+id.slice(3),created:now/1000,
 total_details:{amount_discount:13980,amount_tax:0,breakdown:{discounts:[{amount:13980,discount:{promotion_code:'promo_p',source:{coupon:'coupon_p'}}}]}},metadata:meta(id),...extra});
for(const s of ['cs_year','cs_year_missed','cs_year_selfref','cs_year_wrongproduct','cs_year_unpaid','cs_year_expired'])intent(s);
intent('cs_year_wrongprice',{}, {'line_items[0][price_data][unit_amount]':59900});
intent('cs_year_card',{payment:'card'});
const sessions={
 cs_year:session('cs_year','cus_buyer',{payment_status:'unpaid'}), // crypto settles asynchronously
 cs_year_missed:session('cs_year_missed','cus_missed'),
 cs_year_selfref:session('cs_year_selfref','cus_referrer'),
 cs_year_wrongproduct:session('cs_year_wrongproduct','cus_other'),
 cs_year_wrongprice:session('cs_year_wrongprice','cus_other'),
 cs_year_card:session('cs_year_card','cus_other'),
 cs_year_nointent:session('cs_year_nointent','cus_other',{metadata:{plan:'yearly',managed_by:'wh-launch',non_renewing:'true',license_days:'365'}}),
 cs_year_unpaid:session('cs_year_unpaid','cus_other',{payment_status:'unpaid'}),
 cs_year_expired:session('cs_year_expired','cus_other',{status:'expired',payment_status:'unpaid'}),
 cs_year_badmode:session('cs_year_badmode','cus_other',{livemode:false}),
 // Card Yearly and a hosted Yearly bundle are subscriptions (credited by invoice()).
 cs_year_sub:session('cs_year_sub','cus_buyer',{mode:'subscription',subscription:'sub_year',payment_intent:null}),
 cs_year_hosted:session('cs_year_hosted','cus_buyer',{mode:'subscription',subscription:'sub_hosted_year',payment_intent:null,metadata:{plan:'yearly',bundle:'software-hosting-v2',reservation:'res_y',wh_launch_intent:'f'.repeat(64)}}),
};
const refunds={},calls=[];let throttled='';
const fetcher=async(url,init)=>{
 const u=new URL(url),p=u.pathname;calls.push(p);assert.equal(init.method,'GET','no Stripe writes');
 if(throttled&&p==='/v1/checkout/sessions/'+throttled)return new Response(JSON.stringify({error:{code:'rate_limit'}}),{status:429});
 const ok=v=>new Response(JSON.stringify(v)),missing=()=>new Response(JSON.stringify({error:{code:'resource_missing'}}),{status:404});
 if(p==='/v1/promotion_codes/promo_p')return ok({id:'promo_p',code:'PARTNER20',livemode:true,coupon:'coupon_p',metadata:{managed_by:'wh-earn',wh_earn_owner:owner}});
 if(p==='/v1/coupons/coupon_p')return ok({id:'coupon_p',valid:true,percent_off:20,duration:'forever',metadata:{managed_by:'wh-earn'},applies_to:{products:['prod_wh']}});
 if(p==='/v1/customers/cus_referrer')return ok({email:'referrer@example.com'});
 if(p.startsWith('/v1/customers/'))return ok({email:'buyer@example.com'});
 if(p.startsWith('/v1/charges/')){const ch=p.split('/').at(-1);return ok({id:ch,livemode:true,amount_refunded:refunds[ch]||0,disputed:false});}
 if(p==='/v1/checkout/sessions')return ok({data:Object.values(sessions).filter(s=>s.status==='complete'),has_more:false});
 const line=/^\/v1\/checkout\/sessions\/(cs_[a-z_]+)\/line_items$/.exec(p);
 if(line){const s=sessions[line[1]],product=line[1]==='cs_year_wrongproduct'?'prod_other':'prod_wh';
  return ok({data:[{price:{id:'price_1Dyn'+line[1].length,type:'one_time',recurring:null,product,unit_amount:69900,currency:'usd'},quantity:1,amount_subtotal:69900,amount_discount:13980,amount_tax:0,amount_total:s.amount_total}],has_more:false});}
 if(p.startsWith('/v1/checkout/sessions/'))return sessions[p.split('/').at(-1)]?ok(sessions[p.split('/').at(-1)]):missing();
 if(p.startsWith('/v1/payment_intents/pi_')){const k=p.split('pi_').at(-1),s=sessions['cs_'+k];return ok({id:'pi_'+k,livemode:true,status:'succeeded',customer:s.customer,amount_received:s.amount_total,currency:'usd',latest_charge:{id:'py_'+k,livemode:true,payment_intent:'pi_'+k,paid:true,currency:'usd',amount:s.amount_total,created:now/1000}});}
 throw Error('Unexpected fixture request '+p);
};
const svc=new EarnStripeService(dir,ledger,()=>cfg,'https://fixture.invalid',()=>now,fetcher);svc.configure({enabled:true,mode:'live'});
let serial=0;const ev=(type,object)=>({type,id:'evt_'+(++serial),object,livemode:true,createdMs:now});
const rows=()=>ledger.admin().stripe.invoices,balance=()=>ledger.view(owner,'Referrer').balances.referral;
try{
 await test('one-time Yearly: a pending crypto Checkout pays nothing; the async success credits 50% of software net once',async()=>{
  await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_year}));assert.equal(rows().cs_year,undefined);assert.equal(balance(),0);
  sessions.cs_year.payment_status='paid';
  await svc.handleEvent(ev('checkout.session.async_payment_succeeded',{...sessions.cs_year}));
  const row=rows().cs_year;assert.ok(row);assert.equal(row.kind,'yearly');assert.equal(row.basis,55920);assert.equal(row.commission,27960);assert.equal(row.rate,50);assert.equal(row.subscription,'');assert.deepEqual(row.charges,['py_year']);assert.equal(row.paidThrough,0);
  const entries=ledger.admin().entries.filter(e=>e.reference==='stripe:checkout:cs_year');assert.equal(entries.length,1);assert.equal(entries[0].note,'50% referral commission (yearly)');assert.equal(entries[0].cents,27960);
  assert.equal(balance(),27960);
  await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_year}));await svc.handleEvent(ev('checkout.session.async_payment_succeeded',{...sessions.cs_year}));
  assert.equal(ledger.admin().entries.filter(e=>e.reference==='stripe:checkout:cs_year').length,1);assert.equal(balance(),27960);
  assert.equal(ledger.admin().referrals.length,0,'a one-time purchase adds no tier referral row');
 });
 await test('one-time Yearly: unpaid, expired and self-referred Checkouts pay nothing',async()=>{
  const before=balance();
  await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_year_unpaid}));
  await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_year_expired}));
  await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_year_selfref}));
  for(const k of ['cs_year_unpaid','cs_year_expired','cs_year_selfref'])assert.equal(rows()[k],undefined);
  assert.equal(balance(),before);
 });
 await test('one-time Yearly: wrong product, wrong amount, card intent or no launch purchase refuses',async()=>{
  await assert.rejects(svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_year_wrongproduct})),/Yearly price, product or applied discount/);
  await assert.rejects(svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_year_wrongprice})),/differs from its persisted launch purchase/);
  await assert.rejects(svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_year_card})),/differs from its persisted launch purchase/);
  await assert.rejects(svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_year_nointent})),/no persisted launch purchase/);
  for(const k of ['cs_year_wrongproduct','cs_year_wrongprice','cs_year_card','cs_year_nointent'])assert.equal(rows()[k],undefined);
 });
 await test('one-time Yearly: a subscription-mode Yearly (card or hosted bundle) never enters the one-time path',async()=>{
  const before=balance(),m=calls.length;
  await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_year_sub}));
  await svc.handleEvent(ev('checkout.session.completed',{...sessions.cs_year_hosted}));
  assert.equal(calls.length,m,'subscription-mode Checkout makes no Stripe read');
  // Even if called directly (e.g. a forged event object), the fresh Session read refuses.
  const direct=await svc.checkoutPurchase('live','cs_year_hosted');assert.equal(direct.recorded,false);assert.equal(direct.reason,'not a one-time payment Checkout');
  const card=await svc.checkoutPurchase('live','cs_year_sub');assert.equal(card.recorded,false);
  assert.equal(rows().cs_year_hosted,undefined);assert.equal(rows().cs_year_sub,undefined);assert.equal(balance(),before);
 });
 await test('one-time Yearly: a refund claws back without reading a subscription',async()=>{
  const before=balance(),m=calls.length;refunds.py_year=55920;
  await svc.handleEvent(ev('charge.refunded',{id:'py_year'}));
  assert.equal(balance(),before-27960);assert.ok(!calls.slice(m).some(p=>p.startsWith('/v1/subscriptions/')));
  refunds.py_year=0;await svc.handleEvent(ev('charge.refunded',{id:'py_year'}));assert.equal(balance(),before);
 });
 await test('one-time Yearly: backfill dry run reports per-session eligibility; the real run continues past refusals',async()=>{
  const snapshot=JSON.stringify(ledger.admin());
  const dry=await svc.reconcileReferralPurchases(owner,50,true);assert.equal(JSON.stringify(ledger.admin()),snapshot,'dry run writes nothing');
  assert.deepEqual([...dry.purchases].sort(),['cs_year','cs_year_missed']);assert.equal(dry.alreadyRecorded,1);
  const why=Object.fromEntries(dry.sessions.map(o=>[o.session,o]));
  assert.equal(why.cs_year_selfref.reason,'self-referral');assert.equal(why.cs_year_missed.reason,'eligible');
  assert.match(why.cs_year_wrongproduct.reason,/price, product or applied discount/);assert.match(why.cs_year_wrongprice.reason,/persisted launch purchase/);
  assert.match(why.cs_year_card.reason,/persisted launch purchase/);assert.match(why.cs_year_nointent.reason,/no persisted launch purchase/);
  assert.match(why.cs_year_badmode.reason,/identity or mode/);
  for(const k of ['cs_year_sub','cs_year_hosted','cs_year_expired','cs_year_unpaid'])assert.equal(why[k],undefined,k+' is not a one-time candidate');
  for(const o of dry.sessions)if(o.session!=='cs_year'&&o.session!=='cs_year_missed')assert.equal(o.eligible,false,o.session);
  const before=balance(),r=await svc.reconcileReferralPurchases(owner,50,false);
  assert.equal(r.purchases,2);assert.equal(r.refused,dry.sessions.length-2);assert.equal(r.admitted,2);assert.equal(r.adjusted,0);
  assert.equal(Object.fromEntries(r.sessions.map(o=>[o.session,o.reason])).cs_year_missed,'admitted');
  assert.equal(rows().cs_year_missed.kind,'yearly');assert.equal(rows().cs_year_missed.commission,27960);assert.equal(balance()-before,27960);
  for(const k of ['cs_year_selfref','cs_year_wrongproduct','cs_year_wrongprice','cs_year_card','cs_year_nointent','cs_year_badmode'])assert.equal(rows()[k],undefined);
  const again=await svc.reconcileReferralPurchases(owner,50,false);assert.equal(again.adjusted,0);assert.equal(balance()-before,27960);
  assert.equal(ledger.admin().entries.filter(e=>e.reference==='stripe:checkout:cs_year_missed').length,1);
 });
 await test('0.4.108: a Stripe rate limit during backfill is reported as an error, not a refusal',async()=>{
  throttled='cs_year_wrongprice';
  try{
   const dry=await svc.reconcileReferralPurchases(owner,50,true);const why=Object.fromEntries(dry.sessions.map(o=>[o.session,o]));
   assert.equal(why.cs_year_wrongprice.error,true);assert.match(why.cs_year_wrongprice.reason,/429/);assert.equal(dry.errored,1);
   assert.equal(why.cs_year_wrongproduct.error,undefined,'a proof refusal is not an error');
   const r=await svc.reconcileReferralPurchases(owner,50,false);assert.equal(r.errored,1);assert.equal(r.refused+r.errored+r.purchases,r.sessions.length);
  }finally{throttled='';}
 });
 await test('one-time Yearly: a reviewed-rate change corrects with a yearly note',async()=>{
  ledger.configure({owner,commissionPercent:40});
  const r=await svc.reconcileReferralPurchases(owner,40,false);assert.equal(r.adjusted,2);
  const notes=ledger.admin().entries.filter(e=>e.kind==='adjustment'&&e.note.includes('yearly referral commission correction'));assert.equal(notes.length,2);
  assert.equal(rows().cs_year.commission,22368);
 });
}finally{svc.stop();fs.rmSync(dir,{recursive:true,force:true});}
summary('earn-yearly-referral');
