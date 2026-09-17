import { setFlag } from "../dist/src/flags.js";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EarnService, EXCHANGES, tierPercent, csvRows, usdCents } from '../dist/src/earn.js';
import { tmpDir, test, summary, freshHub } from './helpers.mjs';
const dir=tmpDir('earn'), now=()=>Date.parse('2026-09-17T12:00:00Z'), svc=new EarnService(dir,now);
try {
await test('tier boundaries include 20 and 40 in the lower tier',()=>{assert.deepEqual([0,19,20,21,40,41].map(tierPercent),[20,20,20,30,30,40]);});
await test('only four approved exchanges; no Aster',()=>assert.deepEqual(EXCHANGES.map(e=>e.id),['bybit','bitget','bitunix','weex']));
svc.member('alice','Alice');svc.member('bob','Bob');
await test('main UID required; one per exchange; globally unique; verification pending',()=>{
 assert.throws(()=>svc.addUid('alice',{exchange:'bybit',uid:'1001'}),/main account/);
 svc.addUid('alice',{exchange:'bybit',uid:'1001',accountType:'main'});
 assert.equal(svc.view('alice','Alice').member.uids[0].verified,false);
 assert.throws(()=>svc.addUid('bob',{exchange:'bybit',uid:'1001',accountType:'main'}),/already registered/);
 assert.throws(()=>svc.addUid('alice',{exchange:'bybit',uid:'1002',accountType:'main'}),/already registered/);
 assert.throws(()=>svc.addUid('alice',{exchange:'aster',uid:'1002',accountType:'main'}),/valid exchange/);
});
await test('CSV refuses unverified UID, malformed currency and duplicate source rows',()=>{
 assert.throws(()=>svc.previewCsv({period:'2026-08',csv:'exchange,uid,commission_usd\nbybit,1001,30.00'}),/not verified/);
 svc.configure({owner:'alice',exchange:'bybit',uid:'1001',verified:true});
 assert.throws(()=>usdCents('1e4'));
 assert.throws(()=>usdCents('-5'));
 assert.deepEqual(csvRows('a,b\r\n"x,y","z"\r\n'),[['a','b'],['x,y','z']]);
 assert.throws(()=>svc.previewCsv({period:'2026-08',csv:'exchange,uid,commission_usd\nbybit,1001,30.00\nbybit,1001,30.00'}),/Duplicate/);
});
const csv='exchange,uid,commission_usd\nbybit,1001,30.00';
await test('$15 qualifies exactly, import idempotent, reload durable',()=>{
 const p=svc.previewCsv({period:'2026-08',csv});assert.equal(p.rows[0].rebateCents,1500);assert.equal(p.rows[0].qualified,true);
 assert.throws(()=>svc.importCsv({period:'2026-08',csv,digest:'wrong'}),/Preview changed/);
 svc.importCsv({period:'2026-08',csv,digest:p.digest});
 assert.equal(svc.importCsv({period:'2026-08',csv,digest:p.digest}).duplicate,true);
 assert.equal(new EarnService(dir,now).view('alice','Alice').balances.exchange,1500);
 assert.equal(svc.view('bob','Bob').entries.length,0);
});
await test('monthly minimum aggregates exchanges but does not roll forward',()=>{
 svc.addUid('alice',{exchange:'bitget',uid:'2001',accountType:'main'});svc.configure({owner:'alice',exchange:'bitget',uid:'2001',verified:true});
 for(const [period,csv,expected]of [['2026-06','exchange,uid,commission_usd\nbybit,1001,20.00',false],['2026-07','exchange,uid,commission_usd\nbybit,1001,20.00\nbitget,2001,10.00',true]]){
 const p=svc.previewCsv({period,csv});assert.equal(p.rows[0].qualified,expected);svc.importCsv({period,csv,digest:p.digest});}
 assert.equal(svc.view('alice','Alice').balances.exchange,3000);
 assert.throws(()=>svc.previewCsv({period:'2026-09',csv}),/completed months/);
});
await test('custom rates snapshot; changed preview rejected',()=>{
 const p=svc.previewCsv({period:'2026-05',csv});svc.configure({owner:'alice',rebatePercent:60,discountPercent:15,commissionPercent:35});
 assert.throws(()=>svc.importCsv({period:'2026-05',csv,digest:p.digest}),/Preview changed/);
 assert.equal(svc.view('alice','Alice').commissionPercent,35);assert.equal(svc.admin().audit.at(-1).before.rebatePercent,50);
});
const payout={owner:'alice',source:'exchange',kind:'payout',cents:2000,period:'2026-08',reference:'bank-001',note:'Sent to saved bank',method:'Bank',paidAt:'2026-09-01'};
await test('manual payout debits once, bounds balance and references, reversal preserves original',()=>{
 const e=svc.record(payout);assert.equal(svc.view('alice','Alice').balances.exchange,1000);assert.equal(svc.record(payout).id,e.id);
 assert.throws(()=>svc.record({...payout,cents:2500}),/Reference/);
 assert.throws(()=>svc.record({...payout,reference:'bank-002'}),/exceeds/);
 svc.reverse({id:e.id,note:'Bank transfer returned'});assert.equal(svc.view('alice','Alice').balances.exchange,3000);assert.equal(svc.view('alice','Alice').paidCents,0);
 assert.throws(()=>svc.reverse({id:e.id,note:'again'}),/already reversed/);
});
await test('provider earnings are separate; malformed amounts and dates rejected',()=>{
 svc.record({owner:'alice',source:'marketplace',kind:'earning',cents:5000,period:'2026-08',reference:'provider-1',note:'Confirmed provider settlement'});
 assert.equal(svc.view('alice','Alice').balances.marketplace,5000);
 assert.throws(()=>svc.record({...payout,reference:'bad',paidAt:'2026-02-30'}),/payout date/);
 assert.throws(()=>svc.record({...payout,reference:'bad',cents:0.1}),/integer/);
});
await test('customer and admin browser scripts parse',()=>{for(const file of ['earn.html','admin.html','customer.html']){const html=fs.readFileSync(new URL('../public/'+file,import.meta.url),'utf8');for(const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);}});
const h=await freshHub();try{
 await test('earn routes enforce license/admin and never trust body ownership',async()=>{
 const issued=h.store.issueUntil('Test member',Date.now()+86400000,'unleashed');
 const headers={'x-license':issued.token,'content-type':'application/json','x-wh-earn':'1'};
 assert.equal((await fetch(h.origin+'/api/hub/earn')).status,401);
 assert.equal((await fetch(h.origin+'/api/customer/earn')).status,401);
 assert.equal((await fetch(h.origin+'/api/hub/earn',{headers})).status,404);
 setFlag(h.dataDir,issued.payload.id,'earn',true);
 const r=await fetch(h.origin+'/api/hub/earn',{headers});assert.equal(r.status,200);const member=(await r.json()).member;
 assert.equal((await fetch(h.origin+'/api/hub/earn/uid',{method:'POST',headers,body:JSON.stringify({owner:'someoneelse',exchange:'bybit',uid:'9001',accountType:'main'})})).status,200);
 const own=await (await fetch(h.origin+'/api/hub/earn',{headers})).json();assert.equal(own.member.id,member.id);assert.equal(own.member.uids[0].uid,'9001');
 assert.equal((await fetch(h.origin+'/admin/api/earn',{headers})).status,401);
 assert.equal((await fetch(h.origin+'/api/hub/earn/uid',{method:'POST',headers:{...headers,'sec-fetch-site':'cross-site'},body:'{}'})).status,403);
 });
}finally{await h.close();}
summary('earn');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
