import assert from 'node:assert/strict';
import {EarnService,earnOwner} from '../dist/src/earn.js';
import {EarnStripeService} from '../dist/src/earn-stripe.js';
import {OSKARAS_EXISTING_OFFERS,OSKARAS_EXISTING_PRODUCT} from '../dist/src/earn-oskaras-offers.js';
import {setFlag} from '../dist/src/flags.js';
import {freshHub,tmpDir,test,summary} from './helpers.mjs';
const owner=earnOwner('stripe:live:cus_oskaras');
const cfg={plans:[],stripe:{live:{secretKey:'sk_live_fixture',priceIds:{}},test:{secretKey:'sk_test_fixture',priceIds:{}}}};
function fixture(){
 const ledger=new EarnService(tmpDir('exact-offers'));ledger.member(owner,'Owner');
 const objects=new Map(),calls=[];let subscriptions=[],failPath='';
 for(const s of OSKARAS_EXISTING_OFFERS){
  objects.set('/v1/promotion_codes/'+s.promotion,{id:s.promotion,code:s.code,coupon:s.coupon,active:true,livemode:true,metadata:{},expires_at:null,max_redemptions:null,customer:null,restrictions:{first_time_transaction:false}});
  objects.set('/v1/coupons/'+s.coupon,{id:s.coupon,livemode:true,valid:true,percent_off:s.percent,duration:'forever',applies_to:{products:[OSKARAS_EXISTING_PRODUCT]},metadata:{managed_by:'wickhunter-hub'},amount_off:null,max_redemptions:null,redeem_by:null});
 }
 const fake=async(url,init)=>{const u=new URL(url),body=Object.fromEntries(new URLSearchParams(init.body));calls.push({method:init.method,path:u.pathname,body});
  if(u.pathname==='/v1/subscriptions')return Response.json({data:subscriptions,has_more:false});
  const obj=objects.get(u.pathname);if(!obj)throw Error('Unexpected external request '+u.pathname);
  if(init.method==='POST'&&u.pathname===failPath){failPath='';return Response.json({error:{code:'fixture_failure'}},{status:500});}
  if(init.method==='POST'){assert.deepEqual(Object.keys(body).sort(),['metadata[wh_earn_code]','metadata[wh_earn_owner]']);obj.metadata={...obj.metadata,wh_earn_owner:body['metadata[wh_earn_owner]'],wh_earn_code:body['metadata[wh_earn_code]']};}
  return Response.json(obj);
 };
 const service=new EarnStripeService(tmpDir('stripe-settings'),ledger,()=>cfg,'https://hub.test',()=>Date.now(),fake);service.configure({enabled:true,mode:'live'});
 return {ledger,service,objects,calls,setSubscriptions:v=>subscriptions=v,failOnce:p=>failPath=p};
}
await test('all six exact live objects preflight before metadata-only adoption; terms unchanged and retry safe',async()=>{
 const f=fixture(),before=structuredClone([...f.objects]);await f.service.adoptExistingOskarasOffers(owner);
 assert.equal(f.calls.findIndex(x=>x.method==='POST'),6);assert.equal(f.calls.filter(x=>x.method==='POST').length,6);
 for(const [key,old] of before){const current=f.objects.get(key);assert.deepEqual({...current,metadata:old.metadata},old);assert.equal(current.metadata.wh_earn_owner,owner);}
 assert.equal(f.service.view(owner).offers.length,3);assert.equal(f.ledger.admin().entries.length,0);assert.equal(f.ledger.admin().members[0].payoutPreference,null);
 await f.service.adoptExistingOskarasOffers(owner);assert.equal(f.service.view(owner).offers.length,3);
 for(const s of OSKARAS_EXISTING_OFFERS)assert.equal(f.service.launchReferral(s.code,'live').promotionId,s.promotion);
});
await test('conflicting last object or changed scoped terms refuse before ANY POST or ledger change',async()=>{
 for(const mutate of [c=>c.metadata.wh_earn_owner=earnOwner('other'),c=>c.applies_to={products:['prod_unreviewed']},c=>delete c.applies_to,c=>c.percent_off=99,c=>c.livemode=false]){
  const f=fixture(),last=OSKARAS_EXISTING_OFFERS.at(-1);mutate(f.objects.get('/v1/coupons/'+last.coupon));const before=f.ledger.fileVersion();
  await assert.rejects(f.service.adoptExistingOskarasOffers(owner));assert.equal(f.calls.some(x=>x.method==='POST'),false);assert.equal(f.ledger.fileVersion(),before);
 }
});
await test('partial metadata failure remains incomplete and exact retry creates no duplicate object or financial row',async()=>{
 const f=fixture();f.failOnce('/v1/coupons/'+OSKARAS_EXISTING_OFFERS[1].coupon);
 await assert.rejects(f.service.adoptExistingOskarasOffers(owner));assert.equal(f.service.view(owner).offers.length,0);assert.equal(f.objects.size,6);
 await f.service.adoptExistingOskarasOffers(owner);assert.equal(f.service.view(owner).offers.length,3);assert.equal(f.objects.size,6);assert.equal(f.ledger.admin().entries.length,0);
});
await test('status pagination filters owner before projection and never leaks injected foreign rows',()=>{
 const f=fixture();f.ledger.transaction(s=>{s.stripe={profiles:{[owner]:{referralStatusAt:Date.now(),referralStatus:[...Array.from({length:51},(_,i)=>({owner,id:i.toString(16).padStart(40,'0'),label:'Customer '+i,code:'own',status:'active'})),{owner:earnOwner('other'),id:'f'.repeat(40),label:'FOREIGN',status:'active'}]}},invoices:{},jobs:[],seen:{}};});
 const first=f.service.referralActivity(owner);assert.equal(first.rows.length,50);assert.ok(first.next);const last=f.service.referralActivity(owner,first.next);assert.equal(last.rows.length,1);assert.equal(last.next,null);assert.ok(!JSON.stringify([first,last]).includes('FOREIGN'));
});
await test('status reconciliation verifies actual applied exact promo and isolates owners without financial replay',async()=>{
 const f=fixture();await f.service.adoptExistingOskarasOffers(owner);
 f.setSubscriptions([{id:'sub_own',livemode:true,customer:'cus_friend',status:'trialing',discounts:[{promotion_code:OSKARAS_EXISTING_OFFERS[0].promotion}]},{id:'sub_other',customer:'cus_unrelated',status:'active',discounts:[{promotion_code:'promo_other'}]}]);
 const beforeEntries=structuredClone(f.ledger.admin().entries);await f.service.refreshReferralStatus(owner);
 const view=f.service.referralActivity(owner);assert.equal(view.rows.length,1);assert.equal(view.rows[0].status,'trialing');assert.equal(view.rows[0].paidThrough,null);assert.equal(view.stale,false);assert.ok(!JSON.stringify(view).includes('cus_friend'));assert.equal(f.service.referralActivity(earnOwner('other')).rows.length,0);assert.deepEqual(f.ledger.admin().entries,beforeEntries);
 f.objects.get('/v1/promotion_codes/'+OSKARAS_EXISTING_OFFERS[0].promotion).metadata.wh_earn_owner=earnOwner('other');
 await assert.rejects(f.service.refreshReferralStatus(owner));assert.deepEqual(f.service.referralActivity(owner),view,'failed scan retains prior complete status');
});
await test('view grants never bind billing identity and cannot mutate any Earn endpoint',async()=>{
 const h=await freshHub();try{
  const e=new EarnService(h.dataDir);e.member(owner,'Verified owner');e.transaction(s=>{s.members[0].uids=[{exchange:'weex',uid:'PRIVATE_UID',verified:true,submittedAt:new Date().toISOString()}];s.members[0].payoutPreference={method:'paypal',address:'private@example.test',revision:'fixture'};});const token=h.store.issueUntil('Different billing license',Date.now()+86400000,'unleashed');
  e.grantDashboard(token.payload.id,owner,'reviewed fixture');assert.equal(e.boundOwner(['license:'+token.payload.id]),null);assert.throws(()=>e.grantDashboard(token.payload.id,earnOwner('other'),'fixture'));
  const headers={'x-license':token.token,'x-wh-earn':'1','content-type':'application/json'};
  assert.equal((await fetch(h.origin+'/api/hub/earn',{headers})).status,404);
  setFlag(h.dataDir,token.payload.id,'earn',true);
  const got=await(await fetch(h.origin+'/api/hub/earn',{headers})).json();assert.equal(got.member.id,owner);assert.equal(got.capabilities.readOnly,true);assert.deepEqual(got.member.uids,[]);assert.equal(got.member.payoutPreference,null);
  const before=e.fileVersion();for(const route of ['activate','refresh','onboard','payout-preference','uid'])assert.equal((await fetch(h.origin+'/api/hub/earn/'+route,{method:'POST',headers,body:'{}'})).status,403);
  assert.equal(e.fileVersion(),before);assert.equal(e.boundOwner(['license:'+token.payload.id]),null);
  const outsider=h.store.issueUntil('Unrelated',Date.now()+86400000,'unleashed');setFlag(h.dataDir,outsider.payload.id,'earn',true);
  const other=await(await fetch(h.origin+'/api/hub/earn',{headers:{'x-license':outsider.token}})).json();assert.notEqual(other.member.id,owner);
 }finally{await h.close();}
});
summary('earn-dashboard-offers');
