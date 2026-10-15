import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { rmSync } from 'node:fs';
import { freshStore } from './helpers.mjs';
import { BillingService } from '../dist/src/billing/service.js';
const DAY=86400000, anchor=Date.parse('2026-10-15T04:00:00Z');
function setup(){
 const {store,dataDir}=freshStore();let clock=anchor+3600000;
 const service=new BillingService(dataDir,store,'https://hub.test','./templates',{now:()=>clock,log:()=>{}});
 const {payload}=store.issueUntil('Offline fixture',anchor+34*DAY,'unleashed-monthly',anchor-14*DAY);
 service.store.putCustomer({key:'cus_fixture',stripeCustomerId:'cus_fixture',email:'fixture@example.test',name:'Offline fixture',livemode:true,licenseId:payload.id,planKey:'monthly',subscriptionId:'sub_fixture',subscriptionStatus:'active',periodEndMs:anchor+31*DAY,firstPaymentAtMs:anchor,chargeIds:[],createdAtMs:anchor-14*DAY,updatedAtMs:anchor,welcomeSentAtMs:anchor,welcomeError:null,disputed:false,refunded:false,lastEventType:null,lastEventAtMs:null});
 const ev=(type,object)=>({id:'evt_fixture',type,livemode:true,createdMs:clock,object});
 const invoice=(start,end,paid=false)=>({id:'in_fixture',customer:'cus_fixture',subscription:'sub_fixture',paid,status:paid?'paid':'open',amount_paid:paid?5940:0,lines:{data:[{period:{start:start/1000,end:end/1000}}]}});
 const cap=()=>JSON.parse(Buffer.from(service.signedBillingAccessFor(payload.id).split('.')[1],'base64url'));
 return {store,dataDir,service,payload,ev,invoice,cap,setClock:v=>clock=v};
}
test('active/trial status cannot grant an unpaid period; failures get one day from the due boundary',()=>{
 const f=setup();try{
  for(const status of ['active','trialing'])f.service.onSubscriptionUpdated(f.ev('customer.subscription.updated',{id:'sub_fixture',customer:'cus_fixture',status,current_period_end:(anchor+62*DAY)/1000}),f.service.config());
  assert.equal(f.store.get(f.payload.id).exp,f.payload.exp);
  f.service.onInvoiceFailed(f.ev('invoice.payment_failed',f.invoice(anchor,anchor+31*DAY)),f.service.config());
  assert.equal(f.cap().expiresAtMs,anchor+DAY);
  f.setClock(anchor+2*DAY);
  f.service.onInvoiceFailed(f.ev('invoice.payment_failed',f.invoice(anchor,anchor+31*DAY)),f.service.config());
  assert.equal(f.cap().expiresAtMs,anchor+DAY,'a retry never restarts grace');
  f.service.onSubscriptionUpdated(f.ev('customer.subscription.updated',{id:'sub_fixture',customer:'cus_fixture',status:'active',current_period_end:(anchor+62*DAY)/1000}),f.service.config());
  assert.equal(f.cap().expiresAtMs,anchor+DAY);
 }finally{rmSync(f.dataDir,{recursive:true,force:true});}
});
test('legacy period is untrusted until verified evidence establishes a signed ceiling',()=>{
 const f=setup();try{
  const r=f.service.store.getCustomer('cus_fixture');r.subscriptionStatus='past_due';f.service.store.putCustomer(r);
  assert.equal(f.service.signedBillingAccessFor(f.payload.id),null,'legacy metadata alone cannot shorten access');
  r.accessEndsAtMs=anchor+DAY;f.service.store.putCustomer(r);
  const token=f.service.signedBillingAccessFor(f.payload.id),[_,body,sig]=token.split('.');
  const pub=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),Buffer.from(f.store.publicKeyRawB64u(),"base64url")]),format:"der",type:"spki"});
  assert.equal(verify(null,Buffer.from(body,'base64url'),pub,Buffer.from(sig,'base64url')),true);
  assert.equal(f.cap().expiresAtMs,anchor+DAY);
 }finally{rmSync(f.dataDir,{recursive:true,force:true});}
});
test('settlement restores the paid term; a late failed event cannot undo it',()=>{
 const f=setup();try{
  f.service.onInvoiceFailed(f.ev('invoice.payment_failed',f.invoice(anchor,anchor+31*DAY)),f.service.config());
  const rec=f.service.store.getCustomer('cus_fixture');
  f.service.applyPaidInvoiceTerm(rec,f.invoice(anchor,anchor+31*DAY,true),f.service.config(),anchor+2*DAY,false);
  f.service.store.putCustomer(rec);
  assert.equal(f.cap().expiresAtMs,anchor+32*DAY);
  f.service.onInvoiceFailed(f.ev('invoice.payment_failed',f.invoice(anchor,anchor+31*DAY)),f.service.config());
  assert.equal(f.cap().expiresAtMs,anchor+32*DAY);
  assert.equal(f.service.store.getCustomer('cus_fixture').subscriptionStatus,'active');
 }finally{rmSync(f.dataDir,{recursive:true,force:true});}
});
test('existing unpaid repair uses complete Stripe history, is dry by default, then corrects registry and signed ceiling',async()=>{
 const f=setup();try{
  f.service.updateConfig({stripe:{live:{secretKey:'sk_live_offline_fixture'}}});
  const invoice={...f.invoice(anchor-14*DAY,anchor,true),livemode:true,amount_paid:0,lines:{has_more:false,data:[{period:{start:(anchor-14*DAY)/1000,end:anchor/1000}}]}};
  const calls=[];
  f.service.launchFetch=async(input,init)=>{calls.push({url:String(input),method:init.method});const u=new URL(input);return new Response(JSON.stringify(u.pathname.includes('/subscriptions/')?{id:'sub_fixture',customer:'cus_fixture',status:'past_due',livemode:true}:{data:[invoice],has_more:false}));};
  const before=JSON.stringify(f.service.store.getCustomer('cus_fixture'));
  const preview=await f.service.repairUnpaidGrace('sub_fixture');
  assert.equal(preview.expiresAtMs,anchor+DAY);assert.equal(preview.wrote,false);
  assert.equal(JSON.stringify(f.service.store.getCustomer('cus_fixture')),before);
  const applied=await f.service.repairUnpaidGrace('sub_fixture',{dryRun:false,by:'offline test',reason:'correct unpaid renewal'});
  assert.equal(applied.wrote,true);assert.equal(f.store.get(f.payload.id).exp,anchor+DAY);assert.equal(f.cap().expiresAtMs,anchor+DAY);
  assert.ok(calls.every(c=>c.method==='GET'),'Stripe is read-only');
  f.service.launchFetch=async(input)=>new Response(JSON.stringify(new URL(input).pathname.includes('/subscriptions/')?{id:'sub_fixture',customer:'cus_fixture',status:'past_due',livemode:true}:{data:[invoice],has_more:true}));
  await assert.rejects(()=>f.service.repairUnpaidGrace('sub_fixture',{dryRun:false,by:'test',reason:'test'}),/bounded reader/);
  assert.equal(f.store.get(f.payload.id).exp,anchor+DAY);
 }finally{rmSync(f.dataDir,{recursive:true,force:true});}
});
