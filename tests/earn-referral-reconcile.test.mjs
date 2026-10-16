import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EarnService,earnOwner} from '../dist/src/earn.js';
import {EarnStripeService} from '../dist/src/earn-stripe.js';
import {test,tmpDir,summary} from './helpers.mjs';
const dir=tmpDir('referral-reconcile'),now=Date.parse('2026-10-16T15:00:00Z');
const ledger=new EarnService(dir,()=>now),owner=earnOwner('referrer-fixture');
const member=ledger.member(owner,'referrer@example.com');ledger.configure({owner,commissionPercent:20});
const cfg={plans:[{key:'monthly',role:'software',checkout:'payment-link',interval:'month',currency:'usd'}],stripe:{live:{secretKey:'sk_live_fixture',priceIds:{monthly:'price_month'}}}};
const offer={promotion:'promo_own',code:member.code,percent:10,products:['prod_software'],proof:{promotion:'promo_own',coupon:'coupon_own',percent:10,duration:'forever',products:['prod_software']}};
ledger.transaction(s=>{s.stripe={profiles:{[owner]:{partnerPromotions:[offer]}},invoices:{},jobs:[],seen:{}};});
let failPage=false,foreignInvoice=false,refund=1000,disputed=true;const calls=[];
const sub=n=>({id:'sub_'+n,customer:'cus_'+n,livemode:true,status:'active',metadata:n==='life'?{bundle:'software-hosting-v2',plan:'lifetime'}:{},discounts:[{promotion_code:'promo_own'}],items:{data:[{price:'price_month'}]}});
const invoice=n=>({id:'in_'+n,customer:'cus_'+n,status:'paid',currency:'usd',livemode:true,amount_paid:10000,total_excluding_tax:10000,total_taxes:[],parent:{subscription_details:{subscription:'sub_'+n}},lines:{data:[{pricing:{price_details:{price:'price_month'}},period:{end:now/1000+86400}}]},status_transitions:{paid_at:now/1000}});
const fetcher=async(url,init)=>{
 const u=new URL(url),p=u.pathname;calls.push({method:init.method,path:p});assert.equal(init.method,'GET');
 const result=v=>new Response(JSON.stringify(v));
 if(p==='/v1/subscriptions')return result({data:u.searchParams.has('starting_after')?[sub('b'),sub('life')]:[sub('a'),sub('c')],has_more:failPage?undefined:!u.searchParams.has('starting_after')});
 if(p==='/v1/invoices'){const n=u.searchParams.get('subscription').slice(4);return result({data:[foreignInvoice?{...invoice(n),customer:'cus_wrong'}:invoice(n)],has_more:false});}
 if(p.startsWith('/v1/invoices/'))return result(invoice(p.split('_').at(-1)));
 if(p.startsWith('/v1/subscriptions/'))return result(sub(p.split('_').at(-1)));
 if(p.startsWith('/v1/customers/'))return result({email:'payer@example.com'});
 if(p==='/v1/promotion_codes/promo_own')return result({id:'promo_own',code:member.code,livemode:true,coupon:'coupon_own',metadata:{managed_by:'wh-earn',wh_earn_owner:owner}});
 if(p==='/v1/coupons/coupon_own')return result({id:'coupon_own',valid:true,percent_off:10,duration:'forever',metadata:{managed_by:'wh-earn'},applies_to:{products:['prod_software']}});
 if(p==='/v1/invoice_payments')return result({data:[{status:'paid',payment:{type:'charge',charge:'ch_'+u.searchParams.get('invoice')}}],has_more:false});
 if(p.startsWith('/v1/charges/'))return result({livemode:true,amount_refunded:p.endsWith('_a')?refund:0,disputed:p.endsWith('_c')&&disputed});
 if(p==='/v1/disputes')return result({data:[{status:disputed?'needs_response':'won'}]});
 throw Error('Unexpected fixture request '+p);
};
const svc=new EarnStripeService(dir,ledger,()=>cfg,'https://fixture.invalid',()=>now,fetcher);svc.configure({enabled:true,mode:'live'});
const evt=n=>({type:'invoice.paid',id:'evt_'+n,object:{id:'in_'+n},livemode:true,createdMs:now});
try{
 await svc.handleEvent(evt('a'));await svc.handleEvent(evt('c'));
 ledger.configure({owner,commissionPercent:50});
 await test('dry run completes all pages without changing ledger or making Stripe writes',async()=>{
  const before=JSON.stringify(ledger.admin()),r=await svc.reconcileReferralInvoices(owner,50,true);
  assert.equal(r.subscriptions,4);assert.equal(r.invoices.length,4);assert.equal(r.alreadyRecorded,2);assert.equal(JSON.stringify(ledger.admin()),before);
 });
 await test('incomplete or wrong-owner provider evidence never commits partial money',async()=>{
  const before=JSON.stringify(ledger.admin());failPage=true;await assert.rejects(svc.reconcileReferralInvoices(owner,50,false),/Incomplete/);failPage=false;
  foreignInvoice=true;await assert.rejects(svc.reconcileReferralInvoices(owner,50,false),/identity/);foreignInvoice=false;assert.equal(JSON.stringify(ledger.admin()),before);
  await assert.rejects(svc.reconcileReferralInvoices(owner,40,false),/rate changed/);
 });
 await test('backfill and rate correction preserve refunds, disputes and Lifetime exclusion',async()=>{
  const before=ledger.view(owner,'Referrer').balances.referral,r=await svc.reconcileReferralInvoices(owner,50,false),s=ledger.admin();
  assert.equal(r.admitted,3);assert.equal(r.skipped,1);assert.equal(r.adjusted,2);assert.equal(r.deltaCents,2700);
  assert.equal(ledger.view(owner,'Referrer').balances.referral-before,7700);
  for(const n of ['a','b','c']){assert.equal(s.stripe.invoices['in_'+n].rate,50);assert.equal(s.stripe.invoices['in_'+n].commission,5000);}
  assert.equal(s.stripe.invoices.in_life,undefined);assert.equal(s.entries.filter(e=>e.reference==='stripe:invoice:in_a').length,1);
 });
 await test('repeat reconciliation is idempotent and a later refund uses corrected commission',async()=>{
  const before=ledger.view(owner,'Referrer').balances.referral,r=await svc.reconcileReferralInvoices(owner,50,false);
  assert.equal(r.adjusted,0);assert.equal(r.deltaCents,0);assert.equal(ledger.view(owner,'Referrer').balances.referral,before);
  refund=5000;await svc.handleEvent({...evt('a'),id:'evt_refund_after_rate',type:'charge.refunded',object:{id:'ch_in_a'}});
  assert.equal(ledger.view(owner,'Referrer').balances.referral,before-2000);
  disputed=false;await svc.handleEvent({...evt('c'),id:'evt_dispute_won_after_rate',type:'charge.dispute.closed',object:{charge:'ch_in_c'}});
  assert.equal(ledger.view(owner,'Referrer').balances.referral,before+3000);
 });
}finally{svc.stop();fs.rmSync(dir,{recursive:true,force:true});}
summary('earn-referral-reconcile');
