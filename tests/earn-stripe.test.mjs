import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EarnService,earnOwner} from '../dist/src/earn.js';
import {EarnStripeService} from '../dist/src/earn-stripe.js';
import {test,tmpDir,summary} from './helpers.mjs';
const dir=tmpDir('earn-stripe');let now=Date.parse('2026-09-17T12:00:00Z');
const ledger=new EarnService(dir,()=>now),owner=earnOwner('email:referrer@example.com');const member=ledger.member(owner,'Referrer');
const cfg={plans:[{key:'monthly',role:'software',checkout:'payment-link',interval:'month',currency:'usd'}],stripe:{test:{secretKey:'sk_test_fixture',priceIds:{monthly:'price_month'}},live:{secretKey:'sk_live_fixture',priceIds:{monthly:'price_month'}}}};
let calls=[],refund=0,dispute=false,disputeStatus='needs_response',subStatus='active',failSubmit=false,postReadFailure=false;
let invoiceId='in_1',email='friend@example.com',priceId='price_month',currency='usd',paid=9900,total=9000;
const payouts=new Map(),idempotency=new Map();let sends=0;
const fake=async (url,init)=>{
 const u=new URL(url),endpoint=u.pathname,mode=init.headers.authorization.includes('live')?'live':'test',live=mode==='live';const body=init.method==='POST'?(endpoint.startsWith('/v2')?JSON.parse(init.body):Object.fromEntries(new URLSearchParams(init.body))):{};
 calls.push({endpoint,body,headers:init.headers,method:init.method});const ok=(v,status=200)=>new Response(JSON.stringify(v),{status});
 if(endpoint==='/v1/prices/price_month')return ok({id:'price_month',active:true,currency:'usd',recurring:{interval:'month'},product:'prod_wh'});
 if(endpoint.startsWith('/v1/coupons/'))return ok({error:{code:'resource_missing'}},404);if(endpoint==='/v1/coupons')return ok({id:body.id,percent_off:Number(body.percent_off),duration:body.duration,metadata:{managed_by:'wh-earn'}});if(endpoint==='/v1/promotion_codes')return init.method==='GET'?ok({data:[]}):ok({id:'promo_'+mode});if(endpoint.startsWith('/v1/promotion_codes/'))return ok({});
 if(endpoint==='/v1/checkout/sessions')return ok({url:'https://checkout.stripe.com/test-session'});
 if(endpoint.startsWith('/v1/invoices/'))return ok({id:endpoint.split('/').at(-1),customer:'cus_friend',status:'paid',currency,livemode:live,amount_paid:paid,total_excluding_tax:total,total_taxes:[{amount:900}],parent:{subscription_details:{subscription:'sub_friend'}},lines:{data:[{pricing:{price_details:{price:priceId}},period:{end:now/1000+86400}}]},status_transitions:{paid_at:Date.parse('2026-08-15T00:00:00Z')/1000}});
 if(endpoint==='/v1/subscriptions/sub_friend')return ok({id:'sub_friend',status:subStatus,metadata:{wh_earn_code:member.code},items:{data:[{price:'price_month'}]}});
 if(endpoint==='/v1/customers/cus_friend')return ok({email});
 if(endpoint==='/v1/invoice_payments')return ok({data:[{status:'paid',payment:{type:'payment_intent',payment_intent:{latest_charge:'ch_'+u.searchParams.get('invoice')}}}]});
 if(endpoint.startsWith('/v1/charges/'))return ok({amount_refunded:refund,disputed:dispute,livemode:live});
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
 await svc.checkout(member.code,'monthly');const co=calls.find(c=>c.endpoint==='/v1/checkout/sessions');assert.equal(co.body['subscription_data[metadata][wh_earn_code]'],member.code);assert.equal(co.body['discounts[0][promotion_code]'],'promo_test');assert.equal(co.headers['Stripe-Version'],'2025-03-31.basil');await assert.rejects(svc.checkout(member.code,'hosting'),/unavailable/);
});
await test('test recipient and referral money stay out of real earnings',async()=>{
 await svc.onboard(owner,{country:'US',email:'referrer@example.com'});await svc.handleEvent({...event('invoice.paid','evt_test',{id:'in_test'}),livemode:false});assert.equal(ledger.view(owner,'Referrer').balances.referral,0);assert.equal(svc.ledger('test').view(owner,'Referrer').balances.referral,1800);
});
svc.configure({mode:'live'});assert.throws(()=>svc.configure({payoutKey:'sk_live_fixture'}),/restricted/);svc.configure({payoutKey:'rk_live_fixture'});assert.ok(!JSON.stringify(svc.admin()).includes('rk_live_fixture'));await svc.activate(owner);
await test('renewals credit once per invoice, even with two event types and restarts',async()=>{
 await svc.handleEvent(event('invoice.paid','evt_paid',{id:'in_1'}));await svc.handleEvent(event('invoice.payment_succeeded','evt_other',{id:'in_1'}));
 svc=new EarnStripeService(dir,ledger,()=>cfg,'https://hub.example',()=>now,fake);await svc.handleEvent(event('invoice.paid','evt_retry',{id:'in_1'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,1800);
 await svc.handleEvent(event('invoice.paid','evt_renewal',{id:'in_2'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,3600);assert.equal(ledger.view(owner,'Referrer').activeSubscribers,1);
});
await test('paused enrollment still reconciles refunds and disputes without double debit',async()=>{
 svc.configure({enabled:false});refund=4950;await svc.handleEvent(event('charge.refunded','evt_refund',{id:'ch_in_1'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,2700);
 dispute=true;await svc.handleEvent(event('charge.dispute.created','evt_dispute',{charge:'ch_in_1'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,1800);
 disputeStatus='won';await svc.handleEvent(event('charge.dispute.closed','evt_won',{charge:'ch_in_1'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,2700);
 await svc.handleEvent(event('charge.refunded','evt_refund_again',{id:'ch_in_1'}));assert.equal(ledger.view(owner,'Referrer').balances.referral,2700);assert.equal(ledger.view(owner,'Referrer').activeSubscribers,1);refund=0;dispute=false;svc.configure({enabled:true});
});
await test('self referrals, foreign prices and non-USD invoices do not earn',async()=>{
 const before=ledger.view(owner,'Referrer').balances.referral;email='referrer@example.com';await svc.handleEvent(event('invoice.paid','evt_self',{id:'in_self'}));email='friend@example.com';priceId='price_hosting';await svc.handleEvent(event('invoice.paid','evt_foreign',{id:'in_foreign'}));priceId='price_month';currency='eur';await svc.handleEvent(event('invoice.paid','evt_eur',{id:'in_eur'}));currency='usd';assert.equal(ledger.view(owner,'Referrer').balances.referral,before);
});
await test('subscription cancellation removes active count',async()=>{subStatus='canceled';await svc.handleEvent(event('customer.subscription.deleted','evt_cancel',{id:'sub_friend'}));assert.equal(ledger.view(owner,'Referrer').activeSubscribers,0);});
await svc.onboard(owner,{country:'US',email:'referrer@example.com'});svc.configure({financialAccount:'fa_test_fixture',automatic:true});
await test('reserve before sending; unknown network outcome retries same key after restart',async()=>{
 failSubmit=true;await svc.run();assert.equal(sends,1);const after=ledger.view(owner,'Referrer');assert.equal(after.balances.referral,0);assert.equal(after.paidCents,0);
 assert.throws(()=>ledger.record({owner,source:'referral',kind:'payout',cents:100,period:'2026-08',reference:'manual',note:'manual',method:'bank',paidAt:'2026-09-17'}),/exceeds/);
 svc=new EarnStripeService(dir,ledger,()=>cfg,'https://hub.example',()=>now,fake);failSubmit=false;await svc.run();assert.equal(sends,1);assert.equal(svc.admin().jobs[0].status,'processing');
});
await test('posted settles once; returned funds restore owed earnings and paid total',async()=>{
 payouts.get('obp_1').status='posted';await svc.run();await svc.run();assert.equal(ledger.view(owner,'Referrer').paidCents,2700);assert.equal(ledger.view(owner,'Referrer').balances.referral,0);
 payouts.get('obp_1').status='returned';await svc.run();await svc.run();assert.equal(ledger.view(owner,'Referrer').paidCents,0);assert.equal(ledger.view(owner,'Referrer').balances.referral,2700);assert.equal(sends,1);
});
await test('accepted payout plus failed status read never releases money',async()=>{
 now=Date.parse('2026-10-17T12:00:00Z');postReadFailure=true;await svc.run();assert.equal(sends,2);assert.equal(ledger.view(owner,'Referrer').balances.referral,0);assert.equal(svc.admin().jobs[1].status,'submitting');postReadFailure=false;payouts.get('obp_2').status='failed';await svc.run();assert.equal(ledger.view(owner,'Referrer').balances.referral,2700);
});
await test('Stripe-managed entries cannot be manually reversed',()=>{const e=ledger.admin().entries.find(e=>e.actor==='stripe');assert.throws(()=>ledger.reverse({id:e.id,note:'double credit attempt'}),/not found/);});
await test('future-month earnings are never auto-paid',async()=>{
 now=Date.parse('2026-11-17T12:00:00Z');ledger.record({owner,source:'exchange',kind:'earning',cents:5000,reference:'future',note:'future',period:'2026-12'});await svc.run();assert.equal(payouts.get('obp_3').amount.value,2700);assert.equal(ledger.view(owner,'Referrer').balances.exchange,5000);
});
}finally{svc.stop();fs.rmSync(dir,{recursive:true,force:true});}
summary('earn-stripe');
