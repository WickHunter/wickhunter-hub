import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {test,summary} from './helpers.mjs';
const html=readFileSync(new URL('../public/earn.html',import.meta.url),'utf8');
const state={capabilities:{readOnly:true},stripe:{offers:[{code:'<img src=x onerror=alert(1)>',percent:10,url:'https://hub.test/buy?ref=exact'}]},member:{code:'own',uids:[]},exchanges:[],months:[],entries:[],balances:{},paidCents:0,activeSubscribers:0,commissionPercent:20,referralActivity:{asOf:Date.now()-172800000,stale:true,rows:[{label:'Customer a',code:'OskarasTrading10K7',status:'past_due',paidThrough:null}],next:'a'.repeat(40)}};
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('UI did not settle');}
await test('actual portal renders exact offers and honest status, escapes text, pages GET only and denies delegated mutations',async()=>{
 const calls=[],errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(String(e)));
 const dom=new JSDOM(html,{url:'https://hub.test/earn',runScripts:'dangerously',virtualConsole:vc,beforeParse(w){w.fetch=async(url,init)=>{calls.push({url,init});return {ok:true,json:async()=>calls.length===1?structuredClone(state):{referralActivity:{...state.referralActivity,next:null,rows:[{label:'Customer b',code:'OskarasTrading20M4',status:'canceled',paidThrough:null}]}}};};}});
 try{const d=dom.window.document;await until(()=>!d.getElementById('content').hidden);
 assert.match(d.getElementById('partnerOffers').textContent,/<img/);assert.equal(d.querySelector('#partnerOffers img'),null);assert.match(d.getElementById('referralRows').textContent,/past_due/);assert.match(d.getElementById('referralAsOf').textContent,/stale/);assert.equal(d.getElementById('readOnlyNotice').hidden,false);assert.equal(d.getElementById('savePayoutPreference').disabled,true);assert.equal(d.getElementById('activateReferral').hidden,true);
 d.getElementById('moreReferrals').click();await until(()=>calls.length===2&&d.getElementById('moreReferrals').hidden);assert.match(calls[1].url,/referralsAfter=a{40}$/);assert.match(d.getElementById('referralRows').textContent,/Customer a/);assert.match(d.getElementById('referralRows').textContent,/Customer b/);assert.equal(calls.some(c=>c.init?.method==='POST'),false);assert.deepEqual(errors,[]);
 }finally{dom.window.close();}
});
summary('earn-dashboard-ui');
