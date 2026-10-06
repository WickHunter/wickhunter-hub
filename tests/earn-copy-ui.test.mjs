import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {test,summary} from './helpers.mjs';

const html=readFileSync(new URL('../public/earn.html',import.meta.url),'utf8');
const link='https://hub.example.test/buy?ref=FIXTURE_COPY';
const data=rate=>({stripe:{enabled:true,mode:'live',referralUrl:link,appliedDiscountPercent:10,appliedDiscountDuration:'forever'},member:{code:'FIXTURE_COPY',rebatePercent:rate,uids:[]},exchanges:[{id:'bitunix',name:'Fixture exchange',url:'https://exchange.example.test',whPercent:50}],months:[],entries:[],balances:{referral:0,exchange:0},paidCents:0,activeSubscribers:0,commissionPercent:20,bybitHelp:'https://example.test/help'});
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}throw Error('Earn page did not settle');}
async function scenario({secure,modern,legacy,rate=35,verified=true}){
 const requests=[],writes=[],commands=[],errors=[],toastTimers=[];const vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(String(error)));
 const dom=new JSDOM(html,{url:(secure?'https://hub.example.test':'http://192.0.2.25:8090')+'/hub/earn',runScripts:'dangerously',virtualConsole:vc,beforeParse(w){
  Object.defineProperty(w,'isSecureContext',{value:secure});
  const timeout=w.setTimeout.bind(w);w.setTimeout=(callback,ms,...args)=>{if(ms===4000){toastTimers.push(callback);return 1;}return timeout(callback,ms,...args);};
  if(modern!=='missing')Object.defineProperty(w.navigator,'clipboard',{value:{writeText(value){writes.push(value);return modern==='denied'?Promise.reject(new Error('Denied')):Promise.resolve();}}});
  w.document.execCommand=command=>{const input=w.document.getElementById('refLink');commands.push({command,value:input.value,selected:input.selectionStart===0&&input.selectionEnd===input.value.length,focused:w.document.activeElement===input});if(legacy==='throw')throw Error('Denied');return legacy===true;};
  w.fetch=async(url,init)=>{requests.push({url:String(url),init});const d=data(rate);if(!verified)d.stripe.appliedDiscountDuration=null;return{ok:true,json:async()=>d};};
 }});
 try{
  const page=dom.window.document;await until(()=>!page.getElementById('content').hidden);
  assert.equal(dom.window.WH_EARN_APP,false);assert.equal(requests.length,1);assert.equal(requests[0].url,'/hub/api/customer/earn');assert.equal(requests[0].init.method,'GET');assert.equal(requests[0].init.headers['x-wh-earn'],'1');assert.equal(requests[0].init.headers['x-liqhunter-csrf'],undefined);
  assert.equal(page.querySelector('.exchange .tag').textContent,rate+'% of trading fees earned by WH');assert.doesNotMatch(page.querySelector('.exchange').textContent,/WH earns 50%|17\.5%/);
  const button=page.getElementById('copyLink'),input=page.getElementById('refLink'),status=page.getElementById('refCopyStatus');button.click();
  if(!verified){assert.equal(button.disabled,true);assert.equal(input.value,'');assert.equal(writes.length,0);assert.equal(commands.length,0);return;}
  await until(()=>!button.disabled&&!status.hidden);
  const usesModern=secure&&modern!=='missing',copied=usesModern&&modern!=='denied'||legacy===true;
  assert.deepEqual(writes,usesModern?[link]:[]);assert.equal(commands.length,usesModern&&modern!=='denied'?0:1);
  for(const command of commands)assert.deepEqual(command,{command:'copy',value:link,selected:true,focused:true});
  if(copied)assert.equal(status.textContent,'Referral link copied.');
  else{assert.doesNotMatch(status.textContent,/link copied/);assert.match(status.textContent,/Ctrl\+C or Command\+C/);assert.match(status.textContent,/touch and hold/);assert.equal(page.activeElement,input);assert.equal(input.selectionStart,0);assert.equal(input.selectionEnd,link.length);toastTimers.forEach(callback=>callback());assert.equal(status.hidden,false);assert.equal(page.getElementById('toast').hidden,true);}
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
summary('earn-copy-ui');
