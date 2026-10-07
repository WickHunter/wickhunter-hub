import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {setFlag} from '../dist/src/flags.js';
import {JSDOM,VirtualConsole} from 'jsdom';
import {test,summary,freshHub,tmpDir} from './helpers.mjs';

const html=readFileSync(new URL('../public/earn.html',import.meta.url),'utf8');
const link='https://hub.example.test/buy?ref=FIXTURE_COPY';
const data=rate=>({stripe:{enabled:true,mode:'live',referralUrl:link,appliedDiscountPercent:10,appliedDiscountDuration:'forever'},member:{code:'FIXTURE_COPY',rebatePercent:rate,uids:[]},exchanges:[{id:'bitunix',name:'Fixture exchange',url:'https://exchange.example.test',whPercent:50}],months:[],entries:[],balances:{referral:0,exchange:0},paidCents:0,activeSubscribers:0,commissionPercent:20,bybitHelp:'https://example.test/help'});
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}throw Error('Earn page did not settle');}
async function scenario({secure,modern,legacy,rate=35,verified=true,pending=false,lateReject=false}){
 const requests=[],writes=[],commands=[],errors=[],toastTimers=[],copyTimers=[],clearedTimers=[];let resolveWrite,rejectWrite;const vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(String(error)));
 const dom=new JSDOM(html,{url:(secure?'https://hub.example.test':'http://192.0.2.25:8090')+'/hub/earn',runScripts:'dangerously',virtualConsole:vc,beforeParse(w){
  Object.defineProperty(w,'isSecureContext',{value:secure});
  const timeout=w.setTimeout.bind(w);w.setTimeout=(callback,ms,...args)=>{if(ms===4000){toastTimers.push(callback);return 1;}if(ms===2000){const id=1000+copyTimers.length;copyTimers.push({id,callback});return id;}return timeout(callback,ms,...args);};
  const clear=w.clearTimeout.bind(w);w.clearTimeout=id=>{clearedTimers.push(id);clear(id);};
  w.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
  if(modern!=='missing')Object.defineProperty(w.navigator,'clipboard',{value:{writeText(value){writes.push(value);if(pending&&writes.length===1)return new Promise((resolve,reject)=>{resolveWrite=resolve;rejectWrite=reject;});return modern==='denied'?Promise.reject(new Error('Denied')):Promise.resolve();}}});
  w.document.execCommand=command=>{const input=w.document.getElementById('refLink');commands.push({command,value:input.value,selected:input.selectionStart===0&&input.selectionEnd===input.value.length,focused:w.document.activeElement===input});if(legacy==='throw')throw Error('Denied');return legacy===true;};
  w.fetch=async(url,init)=>{requests.push({url:String(url),init});const d=data(rate);if(!verified)d.stripe.appliedDiscountDuration=null;return{ok:true,json:async()=>d};};
 }});
 try{
  const page=dom.window.document;await until(()=>!page.getElementById('content').hidden);
  assert.equal(dom.window.WH_EARN_APP,false);assert.equal(requests.length,1);assert.equal(requests[0].url,'/hub/api/customer/earn');assert.equal(requests[0].init.method,'GET');assert.equal(requests[0].init.headers['x-wh-earn'],'1');assert.equal(requests[0].init.headers['x-liqhunter-csrf'],undefined);
  assert.equal(page.querySelector('.exchange .tag').textContent,rate+'% of trading fees earned by WH');assert.doesNotMatch(page.querySelector('.exchange').textContent,/WH earns 50%|17\.5%/);
  const button=page.getElementById('copyLink'),input=page.getElementById('refLink'),status=page.getElementById('refCopyStatus');button.click();
  if(!verified){assert.equal(button.disabled,true);assert.equal(input.value,'');assert.equal(writes.length,0);assert.equal(commands.length,0);return;}
  if(pending){assert.equal(button.disabled,true);button.click();assert.equal(writes.length,1);assert.equal(copyTimers.length,1,'pending clipboard arms the actual two-second bound');copyTimers[0].callback();}
  await until(()=>!button.disabled&&!status.hidden);
  const usesModern=secure&&modern!=='missing',copied=usesModern&&modern!=='denied'&&!pending||legacy===true;
  assert.deepEqual(writes,usesModern?[link]:[]);assert.equal(commands.length,usesModern&&modern!=='denied'&&!pending?0:1);
  for(const command of commands)assert.deepEqual(command,{command:'copy',value:link,selected:true,focused:true});
  if(copied)assert.equal(status.textContent,'Referral link copied.');
  else{assert.doesNotMatch(status.textContent,/link copied/);assert.match(status.textContent,/Ctrl\+C or Command\+C/);assert.match(status.textContent,/touch and hold/);assert.equal(page.activeElement,input);assert.equal(input.selectionStart,0);assert.equal(input.selectionEnd,link.length);toastTimers.forEach(callback=>callback());assert.equal(status.hidden,false);assert.equal(page.getElementById('toast').hidden,true);}
  if(usesModern&&copyTimers.length)assert.ok(clearedTimers.includes(copyTimers[0].id),'copy timer cleared after actual success/rejection/timeout');
  if(pending){const previous=status.textContent,commandCount=commands.length;if(lateReject)rejectWrite(new Error('Late clipboard rejection'));else resolveWrite();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(status.textContent,previous);assert.equal(commands.length,commandCount);assert.equal(button.disabled,false);button.click();await until(()=>writes.length===2&&!button.disabled&&status.textContent==='Referral link copied.');assert.equal(copyTimers.length,2);assert.ok(clearedTimers.includes(copyTimers[1].id));}
  assert.equal(requests.length,1,'copy never requests a financial or customer mutation');assert.deepEqual(errors,[]);
 }finally{dom.window.close();}
}
await test('Hub secure copy acknowledges exact referral text',()=>scenario({secure:true,modern:'allowed',legacy:false}));
await test('Hub HTTP missing Clipboard API uses actual compatibility copy',()=>scenario({secure:false,modern:'missing',legacy:true}));
await test('Hub denied Clipboard API falls back to compatibility acknowledgement',()=>scenario({secure:true,modern:'denied',legacy:true}));
await test('Hub fully refused copy keeps persistent selected-link instructions',()=>scenario({secure:true,modern:'denied',legacy:false}));
await test('Hub throwing compatibility copy leaves truthful manual instructions',()=>scenario({secure:false,modern:'missing',legacy:'throw'}));
await test('Hub saved rebate override is displayed without the removed fee explanation',()=>scenario({secure:true,modern:'allowed',legacy:false,rate:40}));
await test('Hub unverified referral cannot copy or claim an offer',()=>scenario({secure:true,modern:'allowed',legacy:true,verified:false}));
await test('Hub pending Clipboard API unlocks with truthful persistent manual fallback and retry',()=>scenario({secure:true,modern:'allowed',legacy:false,pending:true}));
await test('Hub late clipboard rejection cannot overwrite fallback or block a new copy',()=>scenario({secure:true,modern:'allowed',legacy:false,pending:true,lateReject:true}));
await test('Hub timed-out clipboard uses only actual successful compatibility acknowledgement',()=>scenario({secure:true,modern:'allowed',legacy:true,pending:true}));
await test('authenticated Hub Earn GET rereads exact asset without caching or changing API access',async()=>{
 const publicDir=tmpDir('earn-copy-public');writeFileSync(join(publicDir,'earn.html'),html);
 const h=await freshHub({publicDir});try{
  const issued=h.store.issueUntil('Offline Earn copy fixture',Date.now()+86400000,'unleashed');setFlag(h.dataDir,issued.payload.id,'earn',true);
  const headers={'x-license':issued.token};const first=await fetch(h.origin+'/earn',{headers});assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');assert.equal(await first.text(),html);
  const revised=html+'\n<!-- isolated reread proof -->';writeFileSync(join(publicDir,'earn.html'),revised);
  const second=await fetch(h.origin+'/earn',{headers:{...headers,'if-none-match':'fixture-old'}});assert.equal(second.status,200);assert.equal(second.headers.get('cache-control'),'no-store');assert.equal(await second.text(),revised);
  assert.equal((await fetch(h.origin+'/earn',{redirect:'manual'})).status,302);assert.equal((await fetch(h.origin+'/api/customer/earn')).status,401);
 }finally{await h.close();for(const p of [publicDir,h.dataDir,h.releasesDir])rmSync(p,{recursive:true,force:true});}
});
summary('earn-copy-ui');
