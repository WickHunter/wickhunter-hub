// 0.4.109 — referral commission is earned on the NET sale: the software basis
// minus its share of the actual Stripe processing fee (balance_transaction.fee).
// An unknown fee records a pending row (no commission yet, never gross or zero)
// that settles on a later read. Legacy gross rows are recalculated only by the
// reviewed operator tool, never when paid out, idempotently and reversibly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EarnService,earnOwner} from '../dist/src/earn.js';
import {EarnStripeService,allocatedFee} from '../dist/src/earn-stripe.js';
import {test,tmpDir,summary} from './helpers.mjs';
const dir=tmpDir('earn-net-fee');let now=Date.parse('2026-11-09T12:00:00Z');
const ledger=new EarnService(dir,()=>now),owner=earnOwner('net-fee-referrer');
const member=ledger.member(owner,'referrer@example.com');ledger.configure({owner,commissionPercent:50});
const cfg={plans:[{key:'monthly',role:'software',checkout:'payment-link',interval:'month',currency:'usd'}],stripe:{live:{secretKey:'sk_live_fixture',priceIds:{monthly:'price_month'}},test:{secretKey:'sk_test_fixture',priceIds:{}}}};
const offer={promotion:'promo_own',code:member.code,percent:10,products:['prod_software'],proof:{promotion:'promo_own',coupon:'coupon_own',percent:10,duration:'forever',products:['prod_software']}};
ledger.transaction(s=>{s.stripe={profiles:{[owner]:{partnerPromotions:[offer]}},invoices:{},jobs:[],seen:{}};});
// Per-invoice fixture facts: amount paid, tax, charge id, Stripe fee (null = no balance transaction yet), fee currency, refund.
const facts={};
const sale=(n,{paid=10000,tax=0,charge='ch_'+n,fee=320,currency='usd',refund=0,itemized=true}={})=>{facts[n]={paid,tax,charge,fee,currency,refund,itemized};return n;};
const byCharge=ch=>Object.entries(facts).find(([,f])=>f.charge===ch);
const calls=[],listed=[];
const fetcher=async(url,init)=>{
 const u=new URL(url),p=u.pathname;calls.push({method:init.method,path:p,query:u.search});assert.equal(init.method,'GET','no Stripe writes');
 const ok=v=>new Response(JSON.stringify(v));
 const inv=/^\/v1\/invoices\/in_(.+)$/.exec(p);
 if(inv){const n=inv[1],f=facts[n];return ok({id:'in_'+n,customer:'cus_'+n,status:'paid',currency:'usd',livemode:true,amount_paid:f.paid,total_excluding_tax:f.paid-f.tax,total_taxes:f.tax?[{amount:f.tax}]:[],parent:{subscription_details:{subscription:'sub_'+n}},lines:{data:[{pricing:{price_details:{price:'price_month'}},period:{end:now/1000+30*86400}}],has_more:false},status_transitions:{paid_at:now/1000}});}
 if(p.startsWith('/v1/subscriptions/sub_')){const n=p.slice('/v1/subscriptions/sub_'.length);return ok({id:'sub_'+n,customer:'cus_'+n,livemode:true,status:'active',metadata:{},discounts:[{promotion_code:'promo_own'}],items:{data:[{price:'price_month'}],has_more:false}});}
 if(p==='/v1/subscriptions')return ok({data:listed.map(n=>({id:'sub_'+n,customer:'cus_'+n,livemode:true,status:'active',metadata:{},discounts:[{promotion_code:'promo_own'}],items:{data:[{price:'price_month'}],has_more:false}})),has_more:false});
 if(p==='/v1/invoices'){const n=u.searchParams.get('subscription').slice(4);return ok({data:[{id:'in_'+n,customer:'cus_'+n,status:'paid',livemode:true,parent:{subscription_details:{subscription:'sub_'+n}}}],has_more:false});}
 if(p.startsWith('/v1/customers/'))return ok({email:'payer@example.com'});
 if(p==='/v1/promotion_codes/promo_own')return ok({id:'promo_own',code:member.code,livemode:true,coupon:'coupon_own',metadata:{managed_by:'wh-earn',wh_earn_owner:owner}});
 if(p==='/v1/coupons/coupon_own')return ok({id:'coupon_own',valid:true,percent_off:10,duration:'forever',metadata:{managed_by:'wh-earn'},applies_to:{products:['prod_software']}});
 if(p==='/v1/invoice_payments'){const n=u.searchParams.get('invoice').slice(3);return ok({data:[{status:'paid',payment:{type:'charge',charge:facts[n].charge}}],has_more:false});}
 if(p.startsWith('/v1/charges/')){
  const ch=p.split('/').at(-1),[,f]=byCharge(ch),expanded=u.searchParams.get('expand[0]')==='balance_transaction';
  const bt=f.fee===null?null:expanded?{id:'txn_'+ch,object:'balance_transaction',fee:f.fee,fee_details:f.itemized?[{amount:f.fee,currency:f.currency,type:'stripe_fee'}]:[],currency:f.currency,source:ch,status:'pending'}:'txn_'+ch;
  return ok({id:ch,livemode:true,currency:'usd',amount:f.paid,amount_refunded:f.refund,disputed:false,balance_transaction:bt});
 }
 throw Error('Unexpected fixture request '+p);
};
const svc=new EarnStripeService(dir,ledger,()=>cfg,'https://fixture.invalid',()=>now,fetcher);svc.configure({enabled:true,mode:'live'});
let serial=0;const paidEvent=n=>({type:'invoice.paid',id:'evt_'+(++serial),object:{id:'in_'+n},livemode:true,createdMs:now});
const refundEvent=ch=>({type:'charge.refunded',id:'evt_'+(++serial),object:{id:ch},livemode:true,createdMs:now});
const rows=()=>ledger.admin().stripe.invoices,balance=()=>ledger.view(owner,'Referrer').balances.referral;
const earning=n=>ledger.admin().entries.filter(e=>e.reference==='stripe:invoice:in_'+n&&e.kind==='earning');
try{
 await test('fee allocation: whole fee when the basis is the charge, proportional when the charge also pays tax or hosting',()=>{
  assert.equal(allocatedFee(10000,320,10000),320);
  assert.equal(allocatedFee(10000,346,10900),317);
  assert.equal(allocatedFee(7920,318,9920),254);
  assert.equal(allocatedFee(0,318,9920),0);
  assert.throws(()=>allocatedFee(100,1,0),/invalid/);assert.throws(()=>allocatedFee(100,NaN,100),/invalid/);
 });
 await test('fee known: commission is the rate on the net sale after the actual Stripe fee',async()=>{
  sale('known');await svc.handleEvent(paidEvent('known'));
  const r=rows().in_known;assert.equal(r.feeStatus,'settled');assert.equal(r.basis,10000);assert.equal(r.feeCents,320);assert.equal(r.feeTotalCents,320);assert.equal(r.feeChargeCents,10000);
  assert.deepEqual(r.feeTransactions,['txn_ch_known']);assert.equal(r.feeSource,'stripe_balance_transaction');assert.equal(r.commission,4840);
  const e=earning('known');assert.equal(e.length,1);assert.equal(e[0].cents,4840);assert.equal(e[0].note,'50% recurring referral commission on the net sale after the $3.20 Stripe processing fee');
  assert.ok(calls.some(c=>c.path==='/v1/charges/ch_known'&&c.query.includes('balance_transaction')),'fee read expands the balance transaction');
  assert.equal(balance(),4840);
 });
 await test('fee known with tax: the fee is shared between the basis and the tax it also collected',async()=>{
  sale('taxed',{paid:10900,tax:900,fee:346});await svc.handleEvent(paidEvent('taxed'));
  const r=rows().in_taxed;assert.equal(r.basis,10000);assert.equal(r.feeCents,317);assert.equal(r.feeTotalCents,346);assert.equal(r.commission,Math.floor(9683/2));
 });
 await test('a Stripe crypto (py_) payment uses its own balance-transaction fee exactly like a card charge',async()=>{
  sale('crypto',{charge:'py_crypto',fee:150});await svc.handleEvent(paidEvent('crypto'));
  const r=rows().in_crypto;assert.deepEqual(r.charges,['py_crypto']);assert.equal(r.feeCents,150);assert.equal(r.commission,4925);
 });
 await test('fee pending: the row is recorded with no commission (not gross, not zero-credited) and settles on a later read',async()=>{
  const before=balance();sale('pending',{fee:null});await svc.handleEvent(paidEvent('pending'));
  const r=rows().in_pending;assert.equal(r.feeStatus,'pending');assert.equal(r.commission,0);assert.equal(r.feeCents,undefined);
  assert.equal(earning('pending').length,0);assert.equal(balance(),before);
  assert.equal(svc.view(owner).sales.find(x=>x.feeStatus==='pending').commissionCents,null,'partner sees pending, not $0');
  await svc.run();assert.equal(rows().in_pending.feeStatus,'pending','still unknown stays pending');
  facts.pending.fee=300;
  const n=calls.length;now+=60_000;await svc.run();assert.equal(calls.slice(n).filter(c=>c.path==='/v1/charges/ch_pending').length,0,'retry waits for its backoff');
  now+=5*60_000;await svc.run();
  const s=rows().in_pending;assert.equal(s.feeStatus,'settled');assert.equal(s.feeCents,300);assert.equal(s.commission,4850);assert.equal(earning('pending').length,1);assert.equal(balance(),before+4850);
  now+=10*60_000;await svc.run();await svc.handleEvent(paidEvent('pending'));assert.equal(earning('pending').length,1,'settlement is idempotent');assert.equal(balance(),before+4850);
 });
 await test('a partial refund recorded while the fee is pending is clawed back from the net commission at settlement',async()=>{
  const before=balance();sale('pendrefund',{fee:null});await svc.handleEvent(paidEvent('pendrefund'));
  facts.pendrefund.refund=5000;await svc.handleEvent(refundEvent('ch_pendrefund'));
  assert.equal(rows().in_pendrefund.refunded,5000);assert.equal(rows().in_pendrefund.feeStatus,'pending');assert.equal(balance(),before);
  facts.pendrefund.fee=320;now+=10*60_000;await svc.run();
  assert.equal(rows().in_pendrefund.commission,4840);assert.equal(balance(),before+2420);
  facts.pendrefund.refund=0;await svc.handleEvent(refundEvent('ch_pendrefund'));assert.equal(balance(),before+4840,'a reversed refund restores the net commission');
 });
 await test('partial refund after a known fee claws back proportionally from the net commission',async()=>{
  const before=balance();facts.known.refund=2500;await svc.handleEvent(refundEvent('ch_known'));
  assert.equal(balance(),before-1210);facts.known.refund=0;await svc.handleEvent(refundEvent('ch_known'));assert.equal(balance(),before);
 });
 await test('fees billed separately: a zero, un-itemized balance-transaction fee is not the charge fee and stays pending',async()=>{
  const before=balance();sale('aggregated',{fee:0,itemized:false});await svc.handleEvent(paidEvent('aggregated'));
  const r=rows().in_aggregated;assert.equal(r.feeStatus,'pending');assert.equal(r.commission,0);assert.equal(earning('aggregated').length,0);assert.equal(balance(),before);
  now+=10*60_000;await svc.run();assert.equal(rows().in_aggregated.feeStatus,'pending');
  assert.match(svc.admin().feeRetry['live:in_aggregated']?.error??'none',/none/);
  // A genuinely itemized zero fee is a known fact.
  sale('zero',{fee:0});await svc.handleEvent(paidEvent('zero'));assert.equal(rows().in_zero.feeStatus,'settled');assert.equal(rows().in_zero.commission,5000);
 });
 await test('missing or malformed fee facts refuse admission for retry instead of fabricating a commission',async()=>{
  const before=JSON.stringify(ledger.admin().entries);
  sale('eur',{currency:'eur'});await assert.rejects(svc.handleEvent(paidEvent('eur')),/not USD/);assert.equal(rows().in_eur,undefined);
  assert.equal(JSON.stringify(ledger.admin().entries),before);
 });
 await test('a reviewed rate correction uses the net basis; a pending row settles at the corrected rate',async()=>{
  sale('ratenet');await svc.handleEvent(paidEvent('ratenet'));sale('ratepending',{fee:null});await svc.handleEvent(paidEvent('ratepending'));
  listed.push('ratenet','ratepending');const before=balance();
  ledger.configure({owner,commissionPercent:40});
  const r=await svc.reconcileReferralInvoices(owner,40,false);assert.equal(r.adjusted,2);assert.equal(r.deltaCents,3872-4840);
  assert.equal(rows().in_ratenet.commission,3872);assert.equal(rows().in_ratepending.rate,40);assert.equal(rows().in_ratepending.feeStatus,'pending');assert.equal(balance(),before-968);
  facts.ratepending.fee=320;now+=10*60_000;await svc.run();assert.equal(rows().in_ratepending.commission,3872);assert.equal(balance(),before-968+3872);
  listed.length=0;ledger.configure({owner,commissionPercent:50});
 });
 // ---- Legacy gross rows and the operator recalculation ----
 const legacy=(n,{basis=10000,paid=10000,commission=5000,refunded=0,charge='ch_'+n,period='2026-10',fee=320,created})=>{
  sale(n,{paid,fee,charge,refund:refunded});
  ledger.transaction(s=>{s.stripe.invoices['in_'+n]={id:'in_'+n,owner,subscription:'sub_'+n,customer:'cus_'+n,paid,basis,commission,rate:50,period,paidThrough:now+86400000,charges:[charge],refunded,disputed:false};
   s.entries.push({id:'legacy-'+n,owner,source:'referral',kind:'earning',cents:commission,currency:'USD',period,reference:'stripe:invoice:in_'+n,note:'50% recurring referral commission',method:'',createdAt:created,actor:'stripe'});
   const claw=Math.min(commission,Math.floor(commission*Math.min(refunded,paid)/paid));
   if(claw)s.entries.push({id:'legacy-claw-'+n,owner,source:'referral',kind:'adjustment',cents:-claw,currency:'USD',period,reference:'stripe:adjust:in_'+n+':x',note:'refund',method:'',createdAt:created,actor:'stripe'});});
 };
 legacy('oldpaid',{created:'2026-09-01T00:00:00.000Z',period:'2026-09'});
 legacy('oldunpaid',{created:'2026-10-02T00:00:00.000Z'});
 legacy('oldrefunded',{created:'2026-10-03T00:00:00.000Z',refunded:5000});
 legacy('oldpending',{created:'2026-10-04T00:00:00.000Z',fee:null});
 ledger.record({owner,source:'referral',kind:'payout',cents:5000,reference:'manual-payout-1',note:'September payout',period:'2026-10',method:'USDT',paidAt:'2026-10-05'});
 const paidRowBefore=JSON.stringify(rows().in_oldpaid);
 let reviewed;
 await test('dry run: reads fees with GETs only, writes nothing, reports per sale and per partner, leaves paid-out rows alone',async()=>{
  const snapshot=JSON.stringify(ledger.admin()),n=calls.length;
  reviewed=await svc.feeRecalculation({dryRun:true});
  assert.equal(JSON.stringify(ledger.admin()),snapshot,'dry run writes nothing');
  assert.ok(calls.slice(n).every(c=>c.method==='GET'));
  assert.ok(!calls.slice(n).some(c=>c.path==='/v1/charges/ch_oldpaid'),'a paid-out row is not even read');
  const by=Object.fromEntries(reviewed.items.map(i=>[i.sale,i]));
  assert.equal(by.in_oldpaid.status,'paid_out');assert.equal(by.in_oldpaid.deltaCents,0);
  assert.equal(by.in_oldunpaid.status,'adjust');assert.equal(by.in_oldunpaid.newCommission,4840);assert.equal(by.in_oldunpaid.deltaCents,-160);assert.equal(by.in_oldunpaid.feeSource,'stripe_balance_transaction');
  assert.equal(by.in_oldrefunded.oldNetCents,2500);assert.equal(by.in_oldrefunded.newNetCents,2420);assert.equal(by.in_oldrefunded.deltaCents,-80);
  assert.equal(by.in_oldpending.status,'fee_pending');assert.equal(by.in_oldpending.deltaCents,0);
  assert.equal(reviewed.legacyRows,4);assert.equal(reviewed.planned,2);assert.match(reviewed.digest,/^[a-f0-9]{64}$/);
  const p=reviewed.partners.find(x=>x.owner===owner);assert.equal(p.paidOut,1);assert.equal(p.feePending,1);assert.equal(p.deltaCents,-240);
  assert.equal(p.oldUnpaidCents,5000+2500+5000);assert.equal(p.newUnpaidCents,4840+2420+5000);assert.equal(p.balanceAfterCents,p.balanceBeforeCents-240);
  assert.deepEqual(reviewed.totals,{oldUnpaidCents:12500,newUnpaidCents:12260,deltaCents:-240,feeCents:640});
 });
 await test('apply refuses without the reviewed digest',async()=>{
  const snapshot=JSON.stringify(ledger.admin());
  await assert.rejects(svc.feeRecalculation({dryRun:false}),/dry run again/);
  await assert.rejects(svc.feeRecalculation({dryRun:false,digest:'0'.repeat(64)}),/dry run again/);
  assert.equal(JSON.stringify(ledger.admin()),snapshot);
 });
 let runId;
 await test('apply: one audited adjustment per changed sale, balances move by the reviewed delta, paid-out row untouched',async()=>{
  const before=balance(),r=await svc.feeRecalculation({dryRun:false,digest:reviewed.digest,actor:'test-operator'});runId=r.runId;
  assert.equal(r.applied,2);assert.match(runId,/^[0-9a-f-]{36}$/);assert.equal(balance(),before-240);
  const adj=ledger.admin().entries.filter(e=>e.reference.startsWith('stripe:fee:'));assert.equal(adj.length,2);
  assert.deepEqual(adj.map(e=>[e.reference,e.cents]).sort(),[['stripe:fee:in_oldrefunded',-80],['stripe:fee:in_oldunpaid',-160]]);
  assert.ok(adj.every(e=>e.kind==='adjustment'&&e.actor==='stripe-fee-recalculation'&&e.source==='referral'));
  const u=rows().in_oldunpaid;assert.equal(u.commission,4840);assert.equal(u.feeStatus,'settled');assert.equal(u.feeRecalc.runId,runId);assert.equal(u.feeRecalc.oldCommission,5000);assert.equal(u.feeRecalc.actor,'test-operator');
  assert.equal(JSON.stringify(rows().in_oldpaid),paidRowBefore,'paid-out commission row is untouched');
  assert.equal(ledger.admin().entries.filter(e=>e.reference==='stripe:invoice:in_oldpaid').length,1);
  assert.equal(rows().in_oldpending.feeStatus,undefined,'a pending-fee legacy row waits for a later run');
  const audit=ledger.admin().stripe.feeRecalculations;assert.equal(audit.length,1);assert.equal(audit[0].digest,reviewed.digest);assert.equal(audit[0].items.length,2);
 });
 await test('apply re-run is idempotent: nothing left to do and no ledger change',async()=>{
  const snapshot=JSON.stringify(ledger.admin().entries),r=await svc.feeRecalculation({dryRun:false,digest:reviewed.digest});
  assert.equal(r.applied,0);assert.equal(JSON.stringify(ledger.admin().entries),snapshot);
  const dry=await svc.feeRecalculation({dryRun:true});assert.equal(dry.planned,0);assert.equal(dry.items.find(i=>i.sale==='in_oldpending').status,'fee_pending');
 });
 await test('a refund after the recalculation claws back from the net commission',async()=>{
  const before=balance();facts.oldunpaid.refund=10000;await svc.handleEvent(refundEvent('ch_oldunpaid'));assert.equal(balance(),before-4840);
  facts.oldunpaid.refund=0;await svc.handleEvent(refundEvent('ch_oldunpaid'));assert.equal(balance(),before);
 });
 await test('a paid-out row stays untouched across runs; a payout that covers more rows protects them too',async()=>{
  // Pay out everything still payable: every remaining legacy row is now paid.
  const payable=balance();ledger.record({owner,source:'referral',kind:'payout',cents:payable,reference:'manual-payout-2',note:'October payout',period:'2026-11',method:'USDT',paidAt:'2026-11-09'});
  facts.oldpending.fee=320;
  const dry=await svc.feeRecalculation({dryRun:true});assert.equal(dry.planned,0);assert.equal(dry.items.find(i=>i.sale==='in_oldpending').status,'paid_out');
  ledger.reverse({id:ledger.admin().entries.find(e=>e.reference==='manual-payout-2').id,note:'test: payout undone'});
 });
 await test('revert restores old commissions with one entry per sale; repeating it is a no-op',async()=>{
  const before=balance(),r=await svc.revertFeeRecalculation(runId,'test-operator');
  assert.equal(r.reverted,2);assert.equal(r.deltaCents,240);assert.equal(balance(),before+240);
  const u=rows().in_oldunpaid;assert.equal(u.commission,5000);assert.equal(u.feeStatus,undefined);assert.equal(u.feeRecalc,undefined);
  assert.equal(ledger.admin().entries.filter(e=>e.reference.startsWith('stripe:fee-revert:')).length,2);
  const again=await svc.revertFeeRecalculation(runId);assert.equal(again.alreadyReverted,true);assert.equal(balance(),before+240);
  await assert.rejects(svc.revertFeeRecalculation('missing'),/not found/);
 });
 await test('partner view shows gross, fee, net and commission per sale without customer or Stripe identifiers',async()=>{
  const sales=svc.view(owner).sales;assert.ok(sales.length>=8);
  const json=JSON.stringify(sales);assert.ok(!/in_|ch_|py_|cus_|txn_/.test(json),'no identifiers');
  const settled=sales.find(x=>x.feeStatus==='settled'&&x.feeCents===320&&!x.refunded);assert.equal(settled.netCents,9680);assert.equal(settled.commissionCents,4840);
  const gross=sales.find(x=>x.feeStatus==='gross');assert.equal(gross.netCents,gross.grossCents);
 });
 await test('the Earn page and admin page name the net-of-fee basis',()=>{
  const page=fs.readFileSync(new URL('../public/earn.html',import.meta.url),'utf8'),admin=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
  assert.match(page,/minus Stripe’s processing fee/);assert.match(page,/% of net sales/);assert.match(page,/Commission by sale/);
  assert.match(admin,/Referral sales \(gross, Stripe fee, net\)/);
 });
}finally{svc.stop();fs.rmSync(dir,{recursive:true,force:true});}
summary('earn-net-of-fee');
