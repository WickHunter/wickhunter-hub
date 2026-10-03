import { setFlag } from "../dist/src/flags.js";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { EarnService, EXCHANGES, tierPercent, csvRows, usdCents } from '../dist/src/earn.js';
import { tmpDir, test, summary, freshHub } from './helpers.mjs';
const dir=tmpDir('earn'), now=()=>Date.parse('2026-09-17T12:00:00Z'), svc=new EarnService(dir,now);
try {
await test('tier boundaries include 20 and 40 in the lower tier',()=>{assert.deepEqual([0,19,20,21,40,41].map(tierPercent),[20,20,20,30,30,40]);});
await test('only four approved exchanges; no Aster',()=>assert.deepEqual(EXCHANGES.map(e=>e.id),['bybit','bitget','bitunix','weex']));
svc.member('alice','Alice');svc.member('bob','Bob');
await test('main UID required; one pending claim per exchange and globally exclusive verification',()=>{
 assert.throws(()=>svc.addUid('alice',{exchange:'bybit',uid:'1001'}),/main account/);
 svc.addUid('alice',{exchange:'bybit',uid:'1001',accountType:'main'});
 assert.equal(svc.view('alice','Alice').member.uids[0].verified,false);
 svc.addUid('bob',{exchange:'bybit',uid:'1001',accountType:'main'});
 assert.equal(svc.view('bob','Bob').member.uids[0].verified,false);
 assert.throws(()=>svc.addUid('alice',{exchange:'bybit',uid:'1002',accountType:'main'}),/already registered/);
 assert.throws(()=>svc.addUid('alice',{exchange:'aster',uid:'1002',accountType:'main'}),/valid exchange/);
});
await test('CSV refuses unverified UID, malformed currency and duplicate source rows',()=>{
 assert.throws(()=>svc.previewCsv({period:'2026-08',csv:'exchange,uid,commission_usd\nbybit,1001,30.00'}),/not verified/);
 svc.configure({owner:'alice',exchange:'bybit',uid:'1001',verified:true});
 assert.throws(()=>svc.configure({owner:'bob',exchange:'bybit',uid:'1001',verified:true}),/already verified/);
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
await test('UID replacement re-verifies future imports without changing finalized earnings',()=>{
 const isolated=tmpDir('earn-uid-replacement');let clock=Date.parse('2026-09-17T12:00:00Z');
 const book=new EarnService(isolated,()=>clock);
 try {
  book.member('owner','Owner');book.member('other','Other');
  book.addUid('owner',{exchange:'bitunix',uid:'1223',accountType:'main'});
  book.configure({owner:'owner',exchange:'bitunix',uid:'1223',verified:true});
  const importMonth=(period,uid,amount)=>{
   const csv=`exchange,uid,commission_usd\nbitunix,${uid},${amount}`;
   const preview=book.previewCsv({period,csv});book.importCsv({period,csv,digest:preview.digest});return preview;
  };
  importMonth('2026-06','1223','100.00');importMonth('2026-07','1223','10.00');
  const before=book.view('owner','Owner');
  assert.deepEqual(before.months.map(m=>[m.period,m.commissionCents,m.rebateCents,m.earnedCents,m.qualified]),[
   ['2026-06',10000,5000,5000,true],['2026-07',1000,500,0,false],
  ]);
  assert.equal(before.balances.exchange,5000);
  const staleCsv='exchange,uid,commission_usd\nbitunix,1223,30.00';
  const stalePreview=book.previewCsv({period:'2026-08',csv:staleCsv});
  clock+=60_000;
  book.addUid('owner',{exchange:'bitunix',uid:'5678',expectedUid:'1223',accountType:'main'});
  const replaced=book.view('owner','Owner');
  assert.deepEqual(replaced.months,before.months);
  assert.equal(replaced.balances.exchange,5000);
  assert.deepEqual(replaced.member.uids.map(u=>[u.exchange,u.uid,u.verified]),[['bitunix','5678',false]]);
  assert.equal(book.admin().audit.at(-1).actor,'member');
  assert.equal(book.admin().audit.at(-1).before.uids[0].uid,'1223');
  assert.equal(book.admin().audit.at(-1).after.uids[0].uid,'5678');
  assert.throws(()=>book.importCsv({period:'2026-08',csv:staleCsv,digest:stalePreview.digest}),/not verified/);
  assert.throws(()=>book.addUid('owner',{exchange:'bitunix',uid:'9999',expectedUid:'1223',accountType:'main'}),/changed since/);
  assert.throws(()=>book.configure({owner:'owner',exchange:'bitunix',uid:'1223',verified:true}),/UID not found/);
  assert.throws(()=>book.previewCsv({period:'2026-08',csv:'exchange,uid,commission_usd\nbitunix,5678,100.00'}),/not verified/);
  const auditCount=book.admin().audit.length;
  book.addUid('owner',{exchange:'bitunix',uid:'5678',expectedUid:'5678',accountType:'main'});
  assert.equal(book.admin().audit.length,auditCount,'same-value retry does not revoke verification or create another audit');
  book.addUid('other',{exchange:'bitunix',uid:'5678',accountType:'main'});
  book.configure({owner:'other',exchange:'bitunix',uid:'5678',verified:true});
  assert.throws(()=>book.configure({owner:'owner',exchange:'bitunix',uid:'5678',verified:true}),/already verified/);
  book.configure({owner:'other',exchange:'bitunix',uid:'5678',verified:false});
  book.configure({owner:'owner',exchange:'bitunix',uid:'5678',verified:true});
  importMonth('2026-08','5678','30.00');
  const after=new EarnService(isolated,()=>clock).view('owner','Owner');
  assert.equal(after.balances.exchange,6500);
  assert.deepEqual(after.months.slice(0,2),before.months);
 } finally {fs.rmSync(isolated,{recursive:true,force:true});}
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
await test('Earn page labels editable main UID and shows credited rather than calculated rebate',()=>{
 const html=fs.readFileSync(new URL('../public/earn.html',import.meta.url),'utf8');
 const dom=new JSDOM(html,{url:'https://example.test/earn',runScripts:'dangerously',beforeParse(window){
  window.WH_EARN_PREVIEW={member:{id:'owner',code:'WHCODE',uids:[{exchange:'bitunix',uid:'1223',verified:false}],rebatePercent:50},
   balances:{referral:0,exchange:5000,marketplace:0},paidCents:0,activeSubscribers:0,commissionPercent:20,
   exchanges:EXCHANGES,bybitHelp:'https://example.test/help',entries:[],months:[
    {period:'2026-06',commissionCents:10000,rebateCents:5000,earnedCents:5000,qualified:true,rate:50},
    {period:'2026-07',commissionCents:1000,rebateCents:500,earnedCents:0,qualified:false,rate:50},
   ]};
 }});
 try {
  const page=dom.window.document;
  const bitunix=[...page.querySelectorAll('.exchange')].find(card=>card.querySelector('h3')?.textContent==='Bitunix');
  assert.ok(bitunix);
  assert.equal(bitunix.querySelector('.uid label').textContent.trim(),'UID (Main account)');
  assert.equal(bitunix.querySelector('.uid input').value,'1223');
  assert.match(bitunix.textContent,/Pending verification/);
  const rows=[...page.querySelectorAll('#months tbody tr')];
  assert.equal(rows.length,2);
  assert.equal(rows[0].children[2].textContent,'$50.00');
  assert.equal(rows[1].children[2].textContent,'$0.00');
  assert.match(rows[1].children[3].textContent,/\$5.00 calculated/);
  const mobile=[...page.querySelectorAll('#months .monthCard')];
  assert.equal(mobile.length,2);
  assert.match(mobile[0].textContent,/WH commission received\$100.00Earned\$50.00Qualified/);
  assert.match(mobile[1].textContent,/WH commission received\$10.00Earned\$0.00Below \$15 combined monthly minimum/);
 } finally {dom.window.close();}
});
const h=await freshHub();try{
 await test('earn routes enforce license/admin and never trust body ownership',async()=>{
 const issued=h.store.issueUntil('Test member',Date.now()+86400000,'unleashed');
 const headers={'x-license':issued.token,'content-type':'application/json','x-wh-earn':'1'};
 assert.equal((await fetch(h.origin+'/api/hub/earn')).status,401);
 assert.equal((await fetch(h.origin+'/api/customer/earn')).status,401);
 const unauthEarn=await fetch(h.origin+'/earn',{redirect:'manual'});assert.equal(unauthEarn.status,302);assert.equal(unauthEarn.headers.get('location'),'/customer');
 assert.equal((await fetch(h.origin+'/api/hub/earn',{headers})).status,404);
 setFlag(h.dataDir,issued.payload.id,'earn',true);
 const r=await fetch(h.origin+'/api/hub/earn',{headers});assert.equal(r.status,200);const member=(await r.json()).member;
 assert.equal((await fetch(h.origin+'/api/hub/earn/uid',{method:'POST',headers,body:JSON.stringify({owner:'someoneelse',exchange:'bybit',uid:'9001',accountType:'main'})})).status,200);
 const own=await (await fetch(h.origin+'/api/hub/earn',{headers})).json();assert.equal(own.member.id,member.id);assert.equal(own.member.uids[0].uid,'9001');
 assert.equal((await fetch(h.origin+'/api/hub/earn/uid',{method:'POST',headers,body:JSON.stringify({owner:'someoneelse',exchange:'bybit',uid:'9002',expectedUid:'9001',accountType:'main'})})).status,200);
 const changed=await (await fetch(h.origin+'/api/hub/earn',{headers})).json();
 assert.equal(changed.member.id,member.id);assert.equal(changed.member.uids[0].uid,'9002');assert.equal(changed.member.uids[0].verified,false);
 const stale=await fetch(h.origin+'/api/hub/earn/uid',{method:'POST',headers,body:JSON.stringify({exchange:'bybit',uid:'9003',expectedUid:'9001',accountType:'main'})});
 assert.equal(stale.status,400);assert.match((await stale.json()).error,/changed since/);
 assert.equal((await fetch(h.origin+'/api/hub/earn/uid',{method:'POST',headers:{'content-type':'application/json','x-wh-earn':'1'},body:JSON.stringify({exchange:'bybit',uid:'9999',expectedUid:'9002',accountType:'main'})})).status,401);
 assert.equal((await fetch(h.origin+'/api/hub/earn',{headers})).status,200);
 assert.equal((await fetch(h.origin+'/api/hub/earn/onboard',{method:'POST',headers,body:JSON.stringify({country:'US',email:'attacker@example.com'})})).status,403);
 assert.equal((await fetch(h.origin+'/admin/api/earn',{headers})).status,401);
 assert.equal((await fetch(h.origin+'/api/hub/earn/uid',{method:'POST',headers:{...headers,'sec-fetch-site':'cross-site'},body:'{}'})).status,403);
 const adminHeaders={'x-hub-admin':'test-admin-token','x-wh-earn':'1','content-type':'application/json'};
 assert.equal((await fetch(h.origin+'/admin/api/earn/stripe-configure',{method:'POST',headers:adminHeaders,body:JSON.stringify({enabled:true})})).status,200);
 assert.equal((await fetch(h.origin+'/admin/api/earn/configure',{method:'POST',headers:adminHeaders,body:JSON.stringify({owner:member.id,discountPercent:0})})).status,200);
 const paused=await (await fetch(h.origin+'/api/hub/earn',{headers})).json();
 assert.equal(paused.stripe.appliedDiscountPercent,0);
 assert.equal(paused.stripe.referralUrl,null);
 });
}finally{await h.close();}
const checkoutHub=await freshHub({}, {rateLimitNow:()=>123456789});
try {
 const referralCodes=[];for(let i=0;i<4;i++)referralCodes.push((await fetch(checkoutHub.origin+'/buy?ref=BAD'+i,{redirect:'manual'})).status);
 assert.deepEqual(referralCodes,[400,400,400,429]);
} finally {await checkoutHub.close();}
summary('earn');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
