import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EarnService} from '../dist/src/earn.js';
import {EarnStripeService} from '../dist/src/earn-stripe.js';
import {test,tmpDir,summary} from './helpers.mjs';

const dir=tmpDir('payout-reconcile-cost');
let now=Date.parse('2026-09-17T12:00:00Z'),providerStatus='posted',reads=0,onRead=null;
const ledger=new EarnService(dir,()=>now);
const cfg={plans:[],stripe:{test:{secretKey:'sk_test_fixture',priceIds:{}},live:{secretKey:'sk_live_fixture',priceIds:{}}}};
const fetcher=async(url)=>{
 const route=new URL(url).pathname;
 if(!route.startsWith('/v2/money_management/outbound_payments/'))throw Error('Unexpected request '+route);
 reads++;onRead?.(route);
 return new Response(JSON.stringify({id:route.split('/').at(-1),amount:{value:100,currency:'usd'},to:{recipient:'acct_test'},livemode:true,status:providerStatus}));
};
const job=(n,status='posted')=>({id:'job-'+n,owner:'owner',cycle:'2026-08',recipient:'acct_test',financialAccount:'fa_test',amount:100,
 allocations:[{source:'referral',cents:100}],status,created:now-86400_000,stripeId:'obp_'+n,checked:status==='posted'?now:undefined,
 paid:status==='posted',released:status==='posted'});
const payout=(n)=>({id:'entry-'+n,owner:'owner',source:'referral',kind:'payout',cents:-100,currency:'USD',period:'2026-08',
 reference:'stripe:payout:job-'+n+':referral',note:'Stripe payout',method:'Stripe Global Payouts',createdAt:new Date(now).toISOString(),actor:'stripe',paidAt:'2026-09-17'});
try{
 ledger.transaction(s=>{
  s.stripe={profiles:{},invoices:{},seen:{},jobs:Array.from({length:120},(_,i)=>job(i))};
  s.entries.push(...Array.from({length:120},(_,i)=>payout(i)));
  for(let i=0;i<2_000;i++)s.entries.push({...payout('history-'+i),id:'history-'+i,reference:'history-'+i});
 });
 const bytes=fs.statSync(dir+'/earn.v1.json').size;
 let adminReads=0,batches=0;
 const admin=ledger.admin.bind(ledger),transactionIfChanged=ledger.transactionIfChanged.bind(ledger);
 ledger.admin=()=>{adminReads++;return admin();};
 ledger.transactionIfChanged=(fn)=>{batches++;return transactionIfChanged(fn);};
 let svc=new EarnStripeService(dir,ledger,()=>cfg,'https://hub.example',()=>now,fetcher);
 svc.configure({mode:'live',payoutKey:'rk_live_fixture'});
 await test('posted-only book skips full ledger parse/sort on 60 idle ticks',async()=>{
  await svc.run();for(let i=0;i<60;i++){now+=60_000;await svc.run();}
  assert.ok(bytes>400_000,'fixture retains a representative ledger, '+bytes+' bytes');
  assert.equal(adminReads,1);assert.equal(reads,0);assert.equal(batches,0);
 });
 await test('100 due posted checks use one durable batch and cap; restart keeps late-return recovery',async()=>{
  now+=5*60*60_000;assert.equal(now-ledger.admin().stripe.jobs[0].checked,6*60*60_000);await svc.run();assert.equal(reads,100);assert.equal(batches,1);
  assert.equal(ledger.admin().stripe.jobs.filter(j=>j.checked===now).length,100);
  await svc.run();assert.equal(reads,120);assert.equal(batches,2);
  svc.stop();svc=new EarnStripeService(dir,ledger,()=>cfg,'https://hub.example',()=>now,fetcher);
  await svc.run();assert.equal(reads,120,'restart scans but does not poll before six-hour deadline');
  providerStatus='returned';now+=6*60*60_000;await svc.run();await svc.run();
  assert.equal(reads,240);assert.equal(ledger.admin().entries.filter(e=>e.kind==='reversal').length,120);
  await svc.run();assert.equal(ledger.admin().entries.filter(e=>e.kind==='reversal').length,120,'terminal returns do not duplicate money');
 });
 await test('unchanged processing result at the same instant does not rewrite money ledger',async()=>{
 ledger.transaction(s=>{s.stripe.jobs.push(job('processing','processing'));});
  providerStatus='processing';await svc.run();const version=ledger.fileVersion();
  await svc.run();assert.equal(ledger.fileVersion(),version);
 });
 await test('a changed durable payout identity cannot take a stale provider result',async()=>{
  now+=60_000;providerStatus='posted';onRead=(route)=>{if(route.endsWith('/obp_processing')){onRead=null;ledger.transaction(s=>{
   s.stripe.jobs.find(j=>j.id==='job-processing').amount=200;
  });}};
  await svc.run();
  assert.match(ledger.admin().stripe.jobs.find(j=>j.id==='job-processing').error,/identity changed/);
  assert.equal(ledger.admin().entries.some(e=>e.reference==='stripe:payout:job-processing:referral'),false);
 });
}finally{fs.rmSync(dir,{recursive:true,force:true});}
summary('earn-payout-reconcile-cost');
