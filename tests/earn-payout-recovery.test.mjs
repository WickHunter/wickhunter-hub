import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {EarnService,earnOwner} from '../dist/src/earn.js';
import {EarnStripeService} from '../dist/src/earn-stripe.js';
import {test,tmpDir,summary} from './helpers.mjs';

function fixture(){
 const dir=tmpDir('payout-recovery'),start=Date.parse('2026-11-01T00:05:00Z');let now=start,failAfterAccept=false,onGet=null,onPost=null,onAdmission=null;
 const live=new EarnService(dir,()=>now),cfg={plans:[],stripe:{test:{secretKey:'sk_test_fixture',priceIds:{}},live:{secretKey:'sk_live_fixture',priceIds:{}}}};
 const calls=[],payments=new Map(),accepted=new Map();
 const fetcher=async(url,init)=>{
  const endpoint=new URL(url).pathname,mode=init.headers.authorization.includes('live')?'live':'test';
  calls.push({endpoint,mode,method:init.method,key:init.headers['Idempotency-Key'],body:init.body?JSON.parse(init.body):null});
  if(endpoint.startsWith('/v2/money_management/financial_accounts/')){await onAdmission?.('financialAccount');return new Response(JSON.stringify({status:'open',livemode:mode==='live'}));}
  if(endpoint.startsWith('/v2/core/accounts/')){await onAdmission?.('recipient');return new Response(JSON.stringify({id:endpoint.split('/').at(-1),defaults:{payout_methods:{usd:'ba_fixture'}},configuration:{recipient:{capabilities:{bank_accounts:{local:{status:'active'}}}}}}));}
  if(endpoint==='/v2/money_management/outbound_payments'&&init.method==='POST'){
   const body=JSON.parse(init.body),key=mode+':'+init.headers['Idempotency-Key'];
   let result=accepted.get(key);
   if(result)assert.deepEqual(result.body,body,'every recovery repeats the exact immutable Stripe body');
   else {const payment={id:'obp_'+mode+'_'+payments.size,amount:body.amount,to:body.to,livemode:mode==='live',status:'processing'};payments.set(payment.id,payment);result={body,payment};accepted.set(key,result);}
   onPost?.(mode,body,result.payment);
   if(failAfterAccept)throw Error('connection lost after original payment accepted');
   return new Response(JSON.stringify(result.payment));
  }
  if(endpoint.startsWith('/v2/money_management/outbound_payments/')){
   const payment=payments.get(endpoint.split('/').at(-1));assert.ok(payment,'known payout ID');onGet?.(mode,payment);
   return new Response(JSON.stringify(payment));
  }
  throw Error('Unexpected request during recovery: '+endpoint);
 };
 let svc=new EarnStripeService(dir,live,()=>cfg,'https://hub.test',()=>now,fetcher);
 svc.configure({mode:'live',payoutKey:'rk_live_fixture'});svc.configure({mode:'test',enabled:false,automatic:false});
 const ledger=mode=>svc.ledger(mode);
 const row=(owner,kind,cents,reference,period)=>({id:randomUUID(),owner,source:'referral',kind,cents,currency:'USD',period,reference,note:'fixture',method:'',createdAt:new Date(now).toISOString(),actor:'stripe'});
 const seed=(mode,id,patch={},manual=true)=>{
  const owner=earnOwner('fixture:'+mode+':'+id),book=ledger(mode);book.member(owner,id);
  if(manual)book.savePayoutPreference(owner,{method:'paypal',address:'member@example.test',expectedRevision:null});
  const job={id,owner,cycle:'2026-10',recipient:'acct_original_'+mode,financialAccount:'fa_original_'+mode,amount:1200,allocations:[{source:'referral',cents:1200}],status:'submitting',created:now-10*60000,...patch};
  book.transaction(s=>{s.stripe??={profiles:{},invoices:{},seen:{},jobs:[]};s.stripe.jobs.push(job);s.entries.push(row(owner,'earning',job.amount,'stripe:invoice:'+id,'2026-09'),row(owner,'hold',-job.amount,'stripe:hold:'+id+':referral','2026-10'));});
  if(job.stripeId)payments.set(job.stripeId,{id:job.stripeId,amount:{value:job.amount,currency:'usd'},to:{recipient:job.recipient},livemode:mode==='live',status:'posted'});
  return job;
 };
 return {dir,live,ledger,seed,calls,payments,accepted,start,
  run:()=>svc.run(),job:(mode,id)=>ledger(mode).admin().stripe.jobs.find(j=>j.id===id),
  advance:ms=>{now+=ms;},fail:()=>{failAfterAccept=true;},recover:()=>{failAfterAccept=false;},
  onGet:fn=>{onGet=fn;},onPost:fn=>{onPost=fn;},onAdmission:fn=>{onAdmission=fn;},configure:input=>svc.configure(input),
  restart:()=>{svc.stop();svc=new EarnStripeService(dir,live,()=>cfg,'https://hub.test',()=>now,fetcher);},
  close:()=>{svc.stop();fs.rmSync(dir,{recursive:true,force:true});},
 };
}

await test('month-boundary unknown submissions recover in both modes while admission is disabled and destination changed',async()=>{
 const f=fixture();try{
  const jobs=['test','live'].map(mode=>f.seed(mode,'boundary-'+mode));
  const original=jobs.map(job=>({from:{financial_account:job.financialAccount,currency:'usd'},to:{recipient:job.recipient},amount:{value:job.amount,currency:'usd'},description:'Wick Hunter earnings 2026-10',metadata:{wh_payout_id:job.id}}));
  await f.run();const posts=f.calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);
  for(let i=0;i<2;i++){assert.deepEqual(posts[i].body,original[i]);assert.equal(posts[i].key,'wh_payout_'+jobs[i].id);assert.equal(f.job(posts[i].mode,jobs[i].id).status,'processing');assert.ok(f.job(posts[i].mode,jobs[i].id).stripeId);}
  // No new recipient/catalogue/account query or new job was admitted.
  assert.ok(f.calls.every(c=>c.endpoint.includes('/outbound_payments')));
  for(const mode of ['test','live'])assert.equal(f.ledger(mode).admin().stripe.jobs.length,1);
 }finally{f.close();}
});

await test('accepted unknown outcome retries original key after restart without another payment or released hold',async()=>{
 const f=fixture();try{
  const job=f.seed('live','unknown-after-restart');const before=f.ledger('live').admin().entries;
  f.fail();await f.run();assert.equal(f.job('live',job.id).stripeId,undefined);assert.equal(f.payments.size,1);assert.deepEqual(f.ledger('live').admin().entries,before);
  f.advance(60000);f.restart();f.recover();await f.run();
  const posts=f.calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].key,posts[1].key);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(f.payments.size,1);
  assert.equal(f.job('live',job.id).status,'processing');assert.deepEqual(f.ledger('live').admin().entries,before);
  const payment=f.payments.get(f.job('live',job.id).stripeId);payment.status='posted';await f.run();
  const paid=f.ledger('live').view(job.owner,'Member').paidCents;assert.equal(paid,1200);await f.run();assert.equal(f.ledger('live').view(job.owner,'Member').paidCents,paid);
  payment.status='returned';f.advance(6*3600000);await f.run();assert.equal(f.ledger('live').view(job.owner,'Member').balances.referral,1200);assert.equal(f.ledger('live').view(job.owner,'Member').paidCents,0);
 }finally{f.close();}
});

await test('failure to persist an accepted Stripe ID keeps the original key recoverable and the reservation intact',async()=>{
 const f=fixture();try{
  const job=f.seed('live','accepted-id-write-failed'),before=f.ledger('live').admin().entries,ledger=f.ledger('live');
  f.onPost(()=>{const original=ledger.transaction.bind(ledger);ledger.transaction=()=>{ledger.transaction=original;throw Error('disk write failed');};f.onPost(null);});
  await f.run();assert.equal(f.job('live',job.id).stripeId,undefined);assert.equal(f.job('live',job.id).identityConflict,undefined);assert.equal(f.job('live',job.id).status,'submitting');assert.deepEqual(ledger.admin().entries,before);
  await f.run();assert.equal(f.payments.size,1);assert.equal(f.job('live',job.id).status,'processing');assert.deepEqual(ledger.admin().entries,before);
  const posts=f.calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].key,posts[1].key);assert.deepEqual(posts[0].body,posts[1].body);
 }finally{f.close();}
});

await test('expired or invalid submission timestamps become review-only with their original reservation intact',async()=>{
 const f=fixture();try{
  const jobs=[f.seed('test','expired',{created:f.start-23*3600000-1}),f.seed('live','future',{created:f.start+1}),f.seed('live','malformed',{created:null})];
  const before={test:f.ledger('test').admin().entries,live:f.ledger('live').admin().entries};
  await f.run();assert.equal(f.calls.length,0);
  for(const job of jobs){const mode=job.id==='expired'?'test':'live';assert.equal(f.job(mode,job.id).status,'needs_review');assert.equal(f.job(mode,job.id).stripeId,undefined);}
  for(const mode of ['test','live'])assert.deepEqual(f.ledger(mode).admin().entries,before[mode]);
  await f.run();assert.equal(f.calls.length,0,'review-only jobs never acquire a new idempotency key');
 }finally{f.close();}
});

await test('the original idempotent submission is still recoverable at exactly the 23-hour cutoff',async()=>{
 const f=fixture();try{const job=f.seed('live','exact-cutoff',{created:f.start-23*3600000});await f.run();assert.equal(f.calls.filter(c=>c.method==='POST').length,1);assert.equal(f.job('live',job.id).status,'processing');assert.ok(f.job('live',job.id).stripeId);}finally{f.close();}
});

await test('known payout IDs keep polling and settle once while new automatic admission remains paused',async()=>{
 const f=fixture();try{
  const job=f.seed('live','already-known',{stripeId:'obp_known'});await f.run();assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(f.job('live',job.id).status,'posted');
  const before=f.ledger('live').admin().entries;await f.run();assert.deepEqual(f.ledger('live').admin().entries,before);assert.equal(f.ledger('live').view(job.owner,'Member').paidCents,1200);
 }finally{f.close();}
});

await test('recovery batches are bounded per mode and rotate to the next unresolved obligation',async()=>{
 const f=fixture();try{
  for(const mode of ['test','live'])for(let i=0;i<26;i++)f.seed(mode,'batch-'+i);
  f.fail();await f.run();assert.equal(f.calls.filter(c=>c.method==='POST').length,50);assert.equal(f.payments.size,50);
  f.advance(60000);await f.run();assert.equal(f.calls.filter(c=>c.method==='POST').length,100);assert.equal(f.payments.size,52,'the 26th obligation on each mode gets a turn');
  for(const mode of ['test','live'])assert.equal(f.ledger(mode).admin().stripe.jobs.length,26,'recovery never admits an additional job');
 }finally{f.close();}
});

await test('an identity change while another payout is read prevents stale recovery and preserves held funds',async()=>{
 const f=fixture();try{
  const pending=f.seed('live','changing-before-recovery');f.seed('live','known-before-recovery',{stripeId:'obp_known'});
  const originalHold=f.ledger('live').admin().entries.find(e=>e.reference==='stripe:hold:'+pending.id+':referral');
  f.onGet(()=>{f.ledger('live').transaction(s=>{s.stripe.jobs.find(j=>j.id===pending.id).recipient='acct_changed';});f.onGet(null);});
  await f.run();assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal(f.job('live',pending.id).identityConflict,true);assert.equal(f.job('live',pending.id).status,'needs_review');
  assert.deepEqual(f.ledger('live').admin().entries.find(e=>e.id===originalHold.id),originalHold);
 }finally{f.close();}
});

await test('an identity change during accepted submission keeps payment evidence and blocks automatic settlement',async()=>{
 const f=fixture();try{
  const pending=f.seed('live','changing-after-submit');const before=f.ledger('live').admin().entries;
  f.onPost(()=>{f.ledger('live').transaction(s=>{s.stripe.jobs.find(j=>j.id===pending.id).allocations=[{source:'exchange',cents:1200}];});});
  await f.run();const job=f.job('live',pending.id);assert.equal(job.identityConflict,true);assert.equal(job.status,'needs_review');assert.ok(job.stripeId);assert.equal(f.payments.size,1);assert.deepEqual(f.ledger('live').admin().entries,before);
  f.payments.get(job.stripeId).status='posted';const count=f.calls.length;await f.run();assert.equal(f.calls.length,count);assert.deepEqual(f.ledger('live').admin().entries,before);
 }finally{f.close();}
});

await test('an allocation change during payout status reads remains review-only after both success and read failure',async()=>{
 for(const known of [false,true])for(const failRead of [false,true]){
  const f=fixture();try{
   const pending=f.seed('live','changing-during-read',known?{stripeId:'obp_known'}:{}),before=f.ledger('live').admin().entries;
   f.onGet(()=>{f.ledger('live').transaction(s=>{s.stripe.jobs.find(j=>j.id===pending.id).allocations=[{source:'marketplace',cents:1200}];});if(failRead)throw Error('read failed after allocation change');});
   await f.run();const job=f.job('live',pending.id);assert.equal(job.identityConflict,true);assert.equal(job.status,'needs_review');assert.ok(job.stripeId);assert.deepEqual(f.ledger('live').admin().entries,before);
   f.onGet(null);const count=f.calls.length;await f.run();assert.equal(f.calls.length,count);assert.deepEqual(f.ledger('live').admin().entries,before);
  }finally{f.close();}
 }
});

await test('configuration changed during provider awaits blocks fresh automatic reservation without blocking committed recovery',async()=>{
 const changes=[{automatic:false},{automatic:false,enabled:false},{automatic:false,mode:'live'},{automatic:false,financialAccount:'fa_test_other'},{payoutDay:28}];
 for(const stage of ['financialAccount','recipient'])for(const change of changes){
  const f=fixture();try{
   const existing=f.seed('test','prior-obligation'),fresh=f.seed('test','fresh-admission',{},false),ledger=f.ledger('test');
   ledger.transaction(s=>{s.stripe.jobs=s.stripe.jobs.filter(j=>j.id!==fresh.id);s.entries=s.entries.filter(e=>!e.reference.startsWith('stripe:hold:'+fresh.id+':'));s.stripe.profiles[fresh.owner]={recipient:'acct_new'};});
   f.configure({mode:'test',enabled:true,automatic:true,financialAccount:'fa_test_fixture'});
   let reached,release;const waiting=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;});
   f.onAdmission(async current=>{if(current===stage){reached();await gate;}});
   const running=f.run();await waiting;f.configure(change);release();await running;
   const state=ledger.admin();assert.ok(f.job('test',existing.id).stripeId,'committed recovery completes before admission pause');assert.equal(state.stripe.jobs.some(j=>j.owner===fresh.owner),false);assert.equal(state.entries.some(e=>e.owner===fresh.owner&&e.kind==='hold'),false);assert.equal(f.calls.filter(c=>c.method==='POST').length,1,'only the original commitment is submitted');
  }finally{f.close();}
 }
});

await test('recipient replaced during verification cannot reserve a fresh job against the stale destination',async()=>{
 const f=fixture();try{
  const fresh=f.seed('test','recipient-change',{},false),ledger=f.ledger('test');
  ledger.transaction(s=>{s.stripe.jobs=[];s.entries=s.entries.filter(e=>e.kind!=='hold');s.stripe.profiles[fresh.owner]={recipient:'acct_original'};});
  f.configure({mode:'test',enabled:true,automatic:true,financialAccount:'fa_test_fixture'});
  f.onAdmission(async stage=>{if(stage==='recipient')ledger.transaction(s=>{s.stripe.profiles[fresh.owner].recipient='acct_changed';});});
  await f.run();assert.equal(ledger.admin().stripe.jobs.length,0);assert.equal(ledger.admin().entries.some(e=>e.kind==='hold'),false);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
 }finally{f.close();}
});

summary('earn-payout-recovery');
