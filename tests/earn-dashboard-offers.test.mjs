import assert from 'node:assert/strict';
import {EarnService,earnOwner} from '../dist/src/earn.js';
import {EarnStripeService} from '../dist/src/earn-stripe.js';
import {OSKARAS_EXISTING_OFFERS,OSKARAS_EXISTING_PRODUCT} from '../dist/src/earn-oskaras-offers.js';
import {setFlag} from '../dist/src/flags.js';
import {freshHub,tmpDir,test,summary} from './helpers.mjs';
const owner=earnOwner('stripe:live:cus_oskaras');
const cfg={plans:[{key:'lifetime',role:'software',interval:null,checkout:'payment-link',lifetime:true},{key:'oneoff',role:'software',interval:null,checkout:'payment-link',lifetime:false}],stripe:{live:{secretKey:'sk_live_fixture',priceIds:{lifetime:'price_lifetime',oneoff:'price_oneoff'}},test:{secretKey:'sk_test_fixture',priceIds:{}}}};
function fixture(){
 const ledger=new EarnService(tmpDir('exact-offers'));ledger.member(owner,'Owner');
 const objects=new Map(),calls=[];let subscriptions=[],sessions=[],checkoutPages=null,failPath='';
 for(const s of OSKARAS_EXISTING_OFFERS){
  objects.set('/v1/promotion_codes/'+s.promotion,{id:s.promotion,code:s.code,coupon:s.coupon,active:true,livemode:true,metadata:{},expires_at:null,max_redemptions:null,customer:null,restrictions:{first_time_transaction:false}});
  objects.set('/v1/coupons/'+s.coupon,{id:s.coupon,livemode:true,valid:true,percent_off:s.percent,duration:'forever',applies_to:{products:[OSKARAS_EXISTING_PRODUCT]},metadata:{managed_by:'wickhunter-hub'},amount_off:null,max_redemptions:null,redeem_by:null});
 }
 const fake=async(url,init)=>{const u=new URL(url),body=Object.fromEntries(new URLSearchParams(init.body));calls.push({method:init.method,path:u.pathname,body});
  if(u.pathname==='/v1/subscriptions')return Response.json({data:subscriptions,has_more:false});
  if(u.pathname==='/v1/checkout/sessions')return Response.json(checkoutPages?.[u.searchParams.get('starting_after')||'']||{data:sessions,has_more:false});
  const obj=objects.get(u.pathname);if(!obj)throw Error('Unexpected external request '+u.pathname);
  if(init.method==='POST'&&u.pathname===failPath){failPath='';return Response.json({error:{code:'fixture_failure'}},{status:500});}
  if(init.method==='POST'){assert.deepEqual(Object.keys(body).sort(),['metadata[wh_earn_code]','metadata[wh_earn_owner]']);obj.metadata={...obj.metadata,wh_earn_owner:body['metadata[wh_earn_owner]'],wh_earn_code:body['metadata[wh_earn_code]']};}
  return Response.json(obj);
 };
 const service=new EarnStripeService(tmpDir('stripe-settings'),ledger,()=>cfg,'https://hub.test',()=>Date.now(),fake);service.configure({enabled:true,mode:'live'});
 return {ledger,service,objects,calls,setSubscriptions:v=>subscriptions=v,setSessions:v=>sessions=v,setCheckoutPages:v=>checkoutPages=v,failOnce:p=>failPath=p};
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
function purchase(f,suffix,{kind='lifetime',mode='payment',customer='cus_friend'}={}){
 const sid='cs_'+suffix,payment='pi_'+suffix,promo=OSKARAS_EXISTING_OFFERS[0].promotion;
 const session={id:sid,livemode:true,status:'complete',payment_status:'paid',mode,customer,amount_total:900,currency:'usd',payment_intent:mode==='payment'?payment:null,invoice:mode==='subscription'?'in_'+suffix:null,subscription:mode==='subscription'?'sub_'+suffix:null,total_details:{breakdown:{discounts:[{discount:{promotion_code:promo}}]}}};
 const item={price:{id:'price_'+kind,product:OSKARAS_EXISTING_PRODUCT,type:'one_time',recurring:null},quantity:1,amount_subtotal:1000,amount_discount:100};
 f.objects.set('/v1/checkout/sessions/'+sid+'/line_items',{data:[item],has_more:false});
 const charge={id:'ch_'+suffix,livemode:true,paid:true,customer,payment_intent:payment,currency:'usd',amount:900,amount_refunded:0,disputed:false};
 const pi={id:payment,livemode:true,status:'succeeded',customer,currency:'usd',amount_received:900,latest_charge:charge};
 f.objects.set('/v1/payment_intents/'+payment,pi);
 if(mode==='subscription'){
  f.objects.set('/v1/invoices/in_'+suffix,{id:'in_'+suffix,livemode:true,status:'paid',customer,parent:{subscription_details:{subscription:'sub_'+suffix}}});
  f.objects.set('/v1/invoice_payments',{data:[{invoice:'in_'+suffix,livemode:true,status:'paid',payment:{type:'payment_intent',payment_intent:payment}}],has_more:false});
 }
 return {session,item,pi,charge};
}
await test('all supported purchase kinds use applied owner code and settled payment facts, never fake subscription state',async()=>{
 const f=fixture();await f.service.adoptExistingOskarasOffers(owner);
 const a=purchase(f,'life'),b=purchase(f,'one',{kind:'oneoff',customer:null}),c=purchase(f,'mixed',{mode:'subscription'});
 b.charge.amount_refunded=50;c.charge.disputed=true;
 f.setSessions([a.session,b.session,c.session,{id:'cs_unrelated',discounts:[{promotion_code:'promo_foreign'}]}]);
 const financial=structuredClone(f.ledger.admin().entries);await f.service.refreshReferralStatus(owner);
 const rows=f.service.referralActivity(owner).rows;assert.equal(rows.length,3);
 assert.deepEqual(rows.map(r=>[r.kind,r.status]).sort(),[['lifetime','disputed'],['lifetime','paid'],['one_time','partially_refunded']].sort());
 assert.ok(rows.every(r=>r.paidThrough===null&&!r.label.includes('cus_')));assert.deepEqual(f.ledger.admin().entries,financial);
 a.charge.amount_refunded=900;await f.service.refreshReferralStatus(owner);assert.ok(f.service.referralActivity(owner).rows.some(r=>r.status==='refunded'));
 c.charge.disputed=false;c.charge.amount_refunded=50;await f.service.refreshReferralStatus(owner);assert.ok(f.service.referralActivity(owner).rows.some(r=>r.status==='refund_allocation_unknown'),'mixed partial refund does not invent software refund allocation');
 assert.equal(f.calls.filter(x=>x.method==='POST').length,6,'status scans never write provider or replay commission');
});
await test('Checkout pages complete before publication; canceled scope, wrong owner/product/payment and partial pages retain complete prior rows',async()=>{
 for(const corrupt of [x=>x.item.price.product='prod_other',x=>x.session.livemode=false,x=>x.session.total_details.breakdown.discounts[0].discount.coupon='coupon_wrong',x=>x.item.amount_discount=0,x=>x.pi.customer='cus_other',x=>delete x.pi.amount_received,x=>x.charge.livemode=false,x=>x.charge.payment_intent='pi_other',x=>x.charge.amount_refunded=901]){
  const f=fixture();await f.service.adoptExistingOskarasOffers(owner);const a=purchase(f,'complete');f.setSessions([a.session]);await f.service.refreshReferralStatus(owner);const before=f.service.referralActivity(owner);corrupt(a);await assert.rejects(f.service.refreshReferralStatus(owner));assert.deepEqual(f.service.referralActivity(owner),before);
 }
 const f=fixture();await f.service.adoptExistingOskarasOffers(owner);const a=purchase(f,'first'),b=purchase(f,'second');
 f.setCheckoutPages({'':{data:[a.session],has_more:true},cs_first:{data:[b.session],has_more:false}});await f.service.refreshReferralStatus(owner);assert.equal(f.service.referralActivity(owner).rows.length,2);
 const before=f.service.referralActivity(owner);f.setCheckoutPages({'':{data:[a.session],has_more:true},cs_first:{data:[],has_more:true}});await assert.rejects(f.service.refreshReferralStatus(owner));assert.deepEqual(f.service.referralActivity(owner),before);
 f.setCheckoutPages(null);a.session.payment_status='unpaid';f.setSessions([a.session]);await f.service.refreshReferralStatus(owner);assert.equal(f.service.referralActivity(owner).rows.length,0,'unpaid attempts are not paid code redemptions');
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
