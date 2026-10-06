import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { freshHub, jsonReq, test, summary } from './helpers.mjs';
import { FakeProvider } from '../dist/src/hosting/provider.js';
import { signStripePayload } from '../dist/src/billing/stripe.js';
import { BillingService } from '../dist/src/billing/service.js';
import { LaunchBilling } from '../dist/src/billing/launch.js';
import { invoiceLineNet, softwareInvoiceProjection } from '../dist/src/billing/software-component.js';
const secret = 'whsec_six_plan_offline_fixture';
const hash = value => createHash('sha256').update(value).digest('hex');
async function setup(over = {}) {
  let clock = Date.parse('2026-10-06T12:00:00Z'), n = 0;
  const calls = [], sessions = new Map(), provider = new FakeProvider({now:()=>clock});
  let h;
  const fake = async (input, init = {}) => {
    const url = new URL(input), p = url.pathname, params = new URLSearchParams(init.body ?? '');
    calls.push({p,method:init.method,params,key:init.headers?.['Idempotency-Key']});
    let out;
    if (p.startsWith('/v1/prices/')) {
      const id=p.split('/').at(-1), annual=id==='price_yearly'||id==='price_hostyear', life=id==='price_lifetime', host=id.startsWith('price_host');
      out={id,active:true,livemode:true,type:life?'one_time':'recurring',currency:'usd',unit_amount:host?annual?24000:2000:life?99900:annual?69900:9900,product:host?'prod_vps':'prod_software',recurring:life?null:{interval:annual?'year':'month',interval_count:1}};
      if (over.sharedProduct && host) out.product='prod_software';
      if (over.wrongMode && host || over.wrongSoftwareMode && !host) out.livemode=false;
      if (over.priceHook) await over.priceHook(h,p);
    } else if (p==='/v1/account') out={capabilities:{crypto_payments:'active'}};
    else if (p==='/v1/checkout/sessions' && init.method==='POST') {
      const key=init.headers['Idempotency-Key'];out=sessions.get(key);
      if(!out){ const id=`cs_six${++n}`,meta=Object.fromEntries([...params].filter(([k])=>/^metadata\[/.test(k)).map(([k,v])=>[k.slice(9,-1),v]));
        const lines=[0,1].map(i=>params.get(`line_items[${i}][price]`)).filter(Boolean).map(id=>{
          const host=id.startsWith('price_host'),annual=id==='price_yearly'||id==='price_hostyear',life=id==='price_lifetime',amount=host?annual?24000:2000:life?99900:annual?69900:9900;
          return {quantity:1,price:{id,product:host?'prod_vps':'prod_software'},amount_subtotal:amount,amount_discount:host?0:params.has('discounts[0][promotion_code]')?amount/10:0};
        });
        out={id,url:`https://checkout.stripe.com/c/pay/${id}`,mode:params.get('mode'),metadata:meta,client_reference_id:params.get('client_reference_id'),livemode:true,status:'open',payment_status:'unpaid',subscription:null,payment_intent:null,lines};sessions.set(key,out);
      }
      if(over.loseResponse){over.loseResponse=false;throw Error('lost create response');}
    } else if(p.startsWith('/v1/checkout/sessions/') && init.method==='GET') {
      const parts=p.split('/'), session=[...sessions.values()].find(s=>s.id===parts[4]);assert(session,'known fixture session');
      if(parts[5]==='line_items' && over.lineHook) await over.lineHook();
      out=parts[5]==='line_items'?{data:session.lines,has_more:false}:session;
    } else throw Error('Unexpected outbound fixture request '+p);
    return {ok:true,status:200,json:async()=>out,text:async()=>JSON.stringify(out)};
  };
  h=await freshHub({}, {billingNow:()=>clock,hostingNow:()=>clock,launchFetch:fake,hostingFetch:fake,billingFetch:async()=>({ok:true,status:200,text:async()=>JSON.stringify({id:'mail_fixture'})}),hostingProvider:provider});
  const admin=(p,body)=>jsonReq(h.origin+p,{method:'POST',headers:{'x-hub-admin':'test-admin-token','content-type':'application/json'},body:JSON.stringify(body)});
  await admin('/admin/api/billing/config',{mode:'live',plans:[...h.hub.billing.config().plans,{key:'hosting-monthly',name:'Hosting',amountCents:2000,currency:'usd',interval:'month',role:'hosting'},{key:'monthly-hosted',name:'LegacyMonthly',amountCents:11900,currency:'usd',interval:'month',role:'software',checkout:'hosted-bundle'},{key:'yearly-hosted',name:'LegacyYearly',amountCents:93900,currency:'usd',interval:'year',role:'software',checkout:'hosted-bundle'}],stripe:{live:{secretKey:'sk_live_offline_only',webhookSecret:secret,priceIds:{monthly:'price_monthly',yearly:'price_yearly',lifetime:'price_lifetime','hosting-monthly':'price_hostold','monthly-hosted':'price_legacy119','yearly-hosted':'price_legacy939'}}},roles:{live:{hosting:{priceIds:['price_hostold']},software:{priceIds:['price_monthly','price_yearly','price_lifetime'],productIds:['prod_software']}}}});
  await admin('/admin/api/hosting/policy',{policy:{provisioningEnabled:true,monthlyPriceCents:2000,osId:'2284',releaseRef:'b'.repeat(64),maximumProjectedMonthlyProviderCostCents:over.costCeiling ?? 10000}});
  const prepared=await admin('/admin/api/billing/hosted-offer',{monthlyPriceId:'price_hostmonth',yearlyPriceId:'price_hostyear'});
  if(!over.sharedProduct&&!over.wrongMode&&!over.priceHook)assert.equal(prepared.status,200,JSON.stringify(prepared.body));
  const launchPrepare=await admin('/admin/api/billing/launch',{action:'prepare'});assert.equal(launchPrepare.status,200);
  await admin('/admin/api/billing/launch',{enabled:true,cryptoEnabled:true});
  const checkout=(plan='monthly',hosting=true,extra={})=>jsonReq(h.origin+'/api/billing/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({plan,payment:'card',hosting,attemptId:randomUUID(),...extra})});
  const last=()=>[...sessions.values()].at(-1);
  const paid=(s,over={})=>({id:s.id,mode:s.mode,payment_status:'paid',customer:'cus_'+s.id,customer_details:{email:s.id+'@example.test'},subscription:'sub_'+s.id,metadata:s.metadata,amount_subtotal:s.lines.reduce((sum,l)=>sum+l.amount_subtotal,0),total_details:{amount_discount:s.lines.reduce((sum,l)=>sum+l.amount_discount,0)},...over});
  const invoice=(s,over={})=>({id:'in_'+s.id,paid:true,status:'paid',amount_paid:s.lines.reduce((sum,l)=>sum+l.amount_subtotal-l.amount_discount,0),customer:'cus_'+s.id,customer_email:s.id+'@example.test',subscription:'sub_'+s.id,subscription_details:{metadata:s.metadata},billing_reason:'subscription_create',lines:{data:s.lines.map(l=>({price:l.price,amount:l.amount_subtotal,discount_amounts:[{amount:l.amount_discount}],taxes:[],quantity:1,period:{end:Math.floor(clock/1000)+30*86400}})),has_more:false},charge:'ch_'+s.id,payment_intent:'pi_'+s.id,...over});
  const post=async(type,object,created=clock)=>{const body=JSON.stringify({id:'evt_'+randomUUID(),object:'event',type,livemode:true,created:Math.floor(created/1000),data:{object}});return jsonReq(h.origin+'/api/billing/stripe/live',{method:'POST',headers:{'content-type':'application/json','stripe-signature':signStripePayload(body,secret,Math.floor(clock/1000))},body});};
  return {h,admin,checkout,prepared,calls,sessions,last,paid,invoice,post,provider,fake,advance:ms=>clock+=ms,now:()=>clock};
}
await test('all six card choices have exact independent software/VPS economics and immutable retries',async()=>{
  const c=await setup();
  for(const plan of ['monthly','yearly','lifetime'])for(const hosting of [false,true]){
    const attemptId=randomUUID(),r=await c.checkout(plan,hosting,{attemptId});assert.equal(r.status,200,JSON.stringify(r.body));
    const s=c.last(),call=c.calls.filter(x=>x.p==='/v1/checkout/sessions').at(-1);
    assert.equal(s.lines.length,hosting?2:1);assert.equal(s.mode,hosting||plan!=='lifetime'?'subscription':'payment');
    assert.equal(call.params.has('subscription_data[billing_cycle_anchor]'),!hosting&&plan!=='lifetime');
    assert.equal(call.params.get('allow_promotion_codes'),'true');
    assert.equal((await c.checkout(plan,hosting,{attemptId})).body.url,r.body.url);
    assert.equal((await c.checkout(plan,!hosting,{attemptId})).status,400);
  }
  assert.equal(c.provider.createCalls.length,0);await c.h.close();
});
await test('prepared combined readiness survives launch disabled and after offer end; generic card links also work',async()=>{
  const c=await setup();await c.admin('/admin/api/billing/launch',{enabled:false,cryptoEnabled:false});
  const plans=await jsonReq(c.h.origin+'/api/billing/plans'),options=await jsonReq(c.h.origin+'/api/hosting/options');
  assert.equal(plans.body.launch.active,false);assert.equal(plans.body.launch.hostingCheckoutEnabled,true);assert.equal(options.body.combinedCheckoutEnabled,true);
  assert.equal((await c.checkout('yearly',true)).status,200);assert.equal((await c.checkout('yearly',false)).status,200);
  assert.equal(c.calls.filter(x=>x.p==='/v1/checkout/sessions').at(-1).params.has('subscription_data[billing_cycle_anchor]'),false);
  c.advance(20*86400000);assert.equal((await c.checkout('lifetime',true)).status,200);await c.h.close();
});
await test('wrongmode or shared product never enables mixed Checkout',async()=>{
  for(const over of [{sharedProduct:true},{wrongMode:true}]){const c=await setup(over);assert.equal(c.prepared.status,400);assert.equal((await c.checkout()).status,400);assert.equal(c.h.hub.hosting.store.instances().length,0);await c.h.close();}
});
await test('invalid referral and hosted crypto reserve no slot; Lifetime referral applies software discount',async()=>{
  const c=await setup();assert.equal((await c.checkout('monthly',true,{referral:'invalid-code'})).status,400);assert.equal((await c.checkout('lifetime',true,{payment:'crypto'})).status,400);assert.equal(c.h.hub.hosting.store.instances().length,0);
  const launch=new LaunchBilling(c.h.dataDir,c.h.hub.billing,c.h.store,'https://hub.test',async()=>{throw Error('unexpected')},c.now,()=>({code:'VALID',promotionId:'promo_verified',discountPercent:10}),{ready:()=>true,prepare:async()=>({softwarePriceId:'price_lifetime',softwareProductId:'prod_software',softwareAmountCents:99900,hostingPriceId:'price_hostmonth',hostingProductId:'prod_vps',hostingAmountCents:2000,hostingInterval:'month',reservationId:'host_test',expiresAtMs:c.now()+31*60000}),bind:()=>{}});
  await assert.rejects(launch.checkout({plan:'lifetime',payment:'card',hosting:true,attemptId:randomUUID(),referral:'VALID'}),/unexpected/);
  const dir=path.join(c.h.dataDir,'billing-launch-intents.v1'),intents=fs.readdirSync(dir).map(f=>JSON.parse(fs.readFileSync(path.join(dir,f))));
  const i=intents.find(x=>x.plan==='lifetime');assert.equal(i.stripeParams['discounts[0][promotion_code]'],'promo_verified');assert.equal(i.discountPercent,10);assert.equal(i.stripeParams['metadata[wh_earn_code]'],undefined);await c.h.close();
});
await test('old ignored hosting retry identity remains exactly software-only without second Session',async()=>{
  const c=await setup(),attemptId=randomUUID();await c.checkout('monthly',false,{attemptId});const s=c.last(),f=path.join(c.h.dataDir,'billing-launch-intents.v1',hash('live:'+attemptId)+'.json');const i=JSON.parse(fs.readFileSync(f));delete i.hostingRequested;fs.writeFileSync(f,JSON.stringify(i));
  assert.equal((await c.checkout('monthly',true,{attemptId})).body.url,s.url);assert.equal((await c.checkout('monthly',false,{attemptId})).body.url,s.url);assert.equal(c.sessions.size,1);assert.equal(c.h.hub.hosting.store.instances().length,0);await c.h.close();
});
await test('monthly/yearly mixed webhook discounts display software10%, renew both, and zero software does not start payment clock',async()=>{
  for(const plan of ['monthly','yearly']){
    const c=await setup();await c.checkout(plan,true);const s=c.last();s.lines[0].amount_discount=s.lines[0].amount_subtotal/10;
    assert.equal((await c.post('checkout.session.completed',c.paid(s))).status,200);const rec=c.h.hub.billing.store.getCustomer('cus_'+s.id);assert.equal(rec.discountPercent,10);
    assert.equal((await c.post('invoice.paid',c.invoice(s))).status,200);assert.equal(c.h.hub.billing.store.getRoleSubscription(rec.key,'hosting').subscriptionId,'sub_'+s.id);assert.equal(c.h.hub.hosting.customerView(rec.key).instance.billingPriceLabel,plan==='monthly'?'$109.10':'$869.10');
    assert.equal(c.h.hub.hosting.store.instances()[0].ownerId,rec.key);await c.h.close();
  }
  const c=await setup();await c.checkout();const s=c.last();s.lines[0].amount_discount=s.lines[0].amount_subtotal;assert.equal((await c.post('checkout.session.completed',c.paid(s))).status,200);assert.equal((await c.post('invoice.paid',c.invoice(s))).status,200);assert.equal(c.h.hub.billing.store.getCustomer('cus_'+s.id).firstActualPaymentAtMs??null,null);await c.h.close();
});
await test('Lifetime invoice-first and replay indexes software charge; hosting-only renewal/failure/deletion preserve Lifetime',async()=>{
  const c=await setup();await c.checkout('lifetime',true);const s=c.last();s.lines[0].amount_discount=9990;
  assert.equal((await c.post('invoice.paid',c.invoice(s))).status,200);const rec=c.h.hub.billing.store.getCustomer('cus_'+s.id);assert.equal(rec.lifetimeAccess,true);assert.equal(rec.discountPercent,10);assert.equal(c.h.hub.hosting.customerView(rec.key).instance.softwareLifetime,true);assert.equal(c.h.hub.hosting.customerView(rec.key).instance.billingPriceLabel,'$20.00');assert(rec.chargeIds.includes('ch_'+s.id));const exp=c.h.store.get(rec.licenseId).exp;
  assert.equal((await c.post('checkout.session.completed',c.paid(s))).status,200);assert.equal(c.h.store.get(rec.licenseId).exp,exp);
  const renew=c.invoice(s,{id:'in_renew',charge:'ch_renew',payment_intent:'pi_renew',lines:{data:[{amount:2000,discount_amounts:[],price:s.lines[1].price,period:{end:Math.floor(c.now()/1000)+60*86400}}],has_more:false}});
  assert.equal((await c.post('invoice.paid',renew)).status,200);assert(!c.h.hub.billing.store.getCustomer(rec.key).chargeIds.includes('ch_renew'));
  assert.equal((await c.post('invoice.payment_failed',c.invoice(s,{paid:false,status:'open'}))).status,200);assert.equal(c.h.hub.billing.store.getCustomer(rec.key).subscriptionStatus,rec.subscriptionStatus);
  assert.equal((await c.post('customer.subscription.deleted',{id:'sub_'+s.id,customer:rec.key,status:'canceled',metadata:s.metadata,items:{data:[{price:s.lines[1].price}]}})).status,200);
  assert.equal(c.h.hub.billing.store.getCustomer(rec.key).lifetimeAccess,true);assert.equal(c.h.store.get(rec.licenseId).exp,exp);
  assert.equal((await c.post('charge.refunded',{id:'ch_renew',customer:rec.key,payment_intent:'pi_renew',amount:2000,amount_refunded:2000,refunded:true})).status,200);assert.equal(c.h.hub.billing.store.getCustomer(rec.key).refunded,false);await c.h.close();
});
await test('Lifetime paid software delivered behind hosting deletion still grants once without reviving VPS',async()=>{
  const c=await setup();await c.checkout('lifetime',true);const s=c.last();assert.equal((await c.post('customer.subscription.deleted',{id:'sub_'+s.id,customer:'cus_'+s.id,status:'canceled',metadata:s.metadata,items:{data:[{price:s.lines[1].price}]}})).status,200);
  assert.equal((await c.post('invoice.paid',c.invoice(s),c.now()-1000)).status,200);const rec=c.h.hub.billing.store.getCustomer('cus_'+s.id);assert.equal(rec.lifetimeAccess,true);assert.equal(c.h.hub.hosting.store.instances()[0].stage,'deleted');assert.equal(c.h.hub.hosting.store.outboxFor(c.h.hub.hosting.store.instances()[0].id).filter(j=>j.jobType==='provision').length,0);await c.h.close();
});
await test('canonical expiry frees exact unused reservation and late paid conflict cannot adopt it',async()=>{
  const c=await setup();await c.checkout();const s=c.last(),row=c.h.hub.hosting.store.instances()[0];
  assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,409);
  s.status='expired';assert.equal((await c.post('checkout.session.expired',{id:s.id,metadata:s.metadata})).status,200);assert.equal(c.h.hub.hosting.store.getInstance(row.id).stage,'deleted');
  assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,200);assert.equal((await c.post('checkout.session.completed',c.paid(s))).status,500);assert.equal(c.h.hub.billing.store.getCustomer('cus_'+s.id),null);
  assert.equal((await c.checkout('yearly',true)).status,200);await c.h.close();
});
await test('natural clock expiry keeps possible settled late webhook fulfillable, explicit paid Session never releases',async()=>{
  const c=await setup();await c.checkout();const s=c.last();c.advance(32*60000);assert.equal((await c.checkout('yearly',true)).status,200);assert.equal((await c.post('invoice.paid',c.invoice(s))).status,200);s.status='complete';s.payment_status='paid';s.subscription='sub_'+s.id;
  assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,409);await c.h.close();
});
await test('owned proof mismatches return retry instead of permanently discarding fulfillment',async()=>{
  const c=await setup();await c.checkout();const s=c.last(),bad=c.invoice(s);bad.subscription_details.metadata={...s.metadata,reservation:'host_other'};
  assert.equal((await c.post('invoice.paid',bad)).status,500);assert.equal(c.h.hub.billing.store.getCustomer('cus_'+s.id),null);assert.equal((await c.post('invoice.paid',c.invoice(s))).status,200);await c.h.close();
});
await test('software invoice net handles Basil credit/tax exactly once and excludes inclusive tax',()=>{
  assert.equal(invoiceLineNet({amount:9900,discount_amounts:[{amount:990}],pretax_credit_amounts:[{amount:990}],taxes:[]}),8910);
  assert.equal(invoiceLineNet({amount:9900,discount_amounts:[{amount:0}],taxes:[{amount:900,tax_behavior:'inclusive'}]}),9000);
  assert.throws(()=>invoiceLineNet({amount:9900,discount_amounts:[{amount:10000}]}),/credits exceed/);
});
await test('Basil invoice-first discount display and hosting credits fail closed without double discount subtraction',async()=>{
  const c=await setup();await c.checkout('lifetime',true);const s=c.last(),invoice=c.invoice(s);
  invoice.lines.data[0].discount_amounts=[];invoice.lines.data[0].pretax_credit_amounts=[{amount:9990,type:'discount',discount:'di_verified'}];
  invoice.lines.data[1].pretax_credit_amounts=[];invoice.amount_paid-=9990;
  assert.equal((await c.post('invoice.paid',invoice)).status,200);assert.equal(c.h.hub.billing.store.getCustomer('cus_'+s.id).discountPercent,10);
  const second=await c.checkout('monthly',true);assert.equal(second.status,200);const s2=c.last(),bad=c.invoice(s2);bad.lines.data[1].pretax_credit_amounts=[{amount:200,type:'credit_balance_transaction'}];bad.lines.data[1].discount_amounts=[];
  assert.equal((await c.post('invoice.paid',bad)).status,500);assert.equal(c.h.hub.billing.store.getCustomer('cus_'+s2.id),null);await c.h.close();
});
await test('generic card checkout rejects a canonical price from the wrong mode',async()=>{
  const over={},c=await setup(over);await c.admin('/admin/api/billing/launch',{enabled:false,cryptoEnabled:false});over.wrongSoftwareMode=true;
  assert.equal((await c.checkout('monthly',false)).status,400);assert.equal(c.sessions.size,0);await c.h.close();
});
await test('legacy shared product classification survives reprepare and concurrent manual roles are retained',async()=>{
  const over={},c=await setup(over);c.h.hub.billing.updateConfig({roles:{live:{software:{productIds:[]},hosting:{productIds:['prod_software','prod_vps']}}}});
  assert.equal((await c.admin('/admin/api/billing/launch',{action:'prepare'})).status,200);
  let changed=false;over.priceHook=async(h)=>{if(!changed){changed=true;h.hub.billing.updateConfig({roles:{live:{hosting:{priceIds:[...h.hub.billing.config().roles.live.hosting.priceIds,'price_manual']}}}});}};
  assert.equal((await c.admin('/admin/api/billing/hosted-offer',{monthlyPriceId:'price_hostmonth',yearlyPriceId:'price_hostyear'})).status,200);assert(c.h.hub.billing.config().roles.live.hosting.priceIds.includes('price_manual'));
  over.priceHook=async(h)=>{h.hub.billing.updateConfig({mode:'test'});};assert.equal((await c.admin('/admin/api/billing/hosted-offer',{monthlyPriceId:'price_hostmonth',yearlyPriceId:'price_hostyear'})).status,400);await c.h.close();
});
await test('concurrent mixed-plan hosted admission permits 30 buyers, refuses31, preserves retries and exact expiry',async()=>{
  const c=await setup({costCeiling:100000});
  // All callers pass the initial cap check before the quote resolves, proving
  // the second check prevents concurrent admission beyond the configured cap.
  const listPlans=c.provider.listPlans.bind(c.provider);let entered=0,release;
  const barrier=new Promise(resolve=>release=resolve);
  c.provider.listPlans=async()=>{const plans=await listPlans();if(++entered===31)release();await barrier;return plans;};
  const buyers=Array.from({length:31},(_,i)=>({plan:['monthly','yearly','lifetime'][i%3],attemptId:randomUUID()}));
  const results=await Promise.all(buyers.map(b=>c.checkout(b.plan,true,{attemptId:b.attemptId})));
  assert.equal(results.filter(r=>r.status===200).length,30);assert.equal(results.filter(r=>r.status===503).length,1);
  const refused=results.find(r=>r.status===503);assert.equal(refused.body.code,'HOSTED_CHECKOUT_CAPACITY');assert.equal(refused.body.retryAfterSeconds,60);assert.match(refused.body.error,/temporarily at capacity/);
  assert.equal(c.sessions.size,30);assert.equal(c.h.hub.hosting.store.instances().length,30);assert.deepEqual(c.h.hub.hosting.projectedMonthlyProviderCostCents(),{known:true,cents:30000});
  const acceptedIndex=results.findIndex(r=>r.status===200),buyer=buyers[acceptedIndex];
  assert.equal((await c.checkout(buyer.plan,true,{attemptId:buyer.attemptId})).body.url,results[acceptedIndex].body.url);assert.equal(c.sessions.size,30);
  const direct=await fetch(c.h.origin+'/buy?plan=lifetime&hosting=true',{redirect:'manual'});assert.equal(direct.status,503);assert.equal(direct.headers.get('retry-after'),'60');assert.equal(direct.headers.get('cache-control'),'no-store');assert.equal((await direct.json()).code,'HOSTED_CHECKOUT_CAPACITY');
  const first=[...c.sessions.values()][0];first.status='expired';assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:first.id})).status,200);
  const deniedBuyer=buyers[results.findIndex(r=>r.status===503)];assert.equal((await c.checkout(deniedBuyer.plan,true,{attemptId:deniedBuyer.attemptId})).status,200);
  assert.equal(c.h.hub.hosting.store.instances().filter(r=>r.stage==='ordered').length,30);assert.equal(c.provider.createCalls.length,0);await c.h.close();
});
await test('provider cost ceiling refuses hosted admission before30 without changing or charging existing reservations',async()=>{
  const c=await setup({costCeiling:5000}),attemptId=randomUUID();let first;
  for(let i=0;i<5;i++){const r=await c.checkout(['monthly','yearly','lifetime'][i%3],true,i===0?{attemptId}:{});assert.equal(r.status,200);first??=r.body.url;}
  assert.deepEqual(c.h.hub.hosting.projectedMonthlyProviderCostCents(),{known:true,cents:5000});
  const before=c.h.hub.hosting.store.instances();const refused=await c.checkout('lifetime',true);
  assert.equal(refused.status,503);assert.equal(refused.body.code,'HOSTED_CHECKOUT_CAPACITY');assert.equal(refused.body.retryAfterSeconds,60);
  assert.deepEqual(c.h.hub.hosting.store.instances(),before);assert.equal(c.sessions.size,5);
  assert.equal((await c.checkout('monthly',true,{attemptId})).body.url,first);assert.equal(c.sessions.size,5);assert.equal(c.provider.createCalls.length,0);await c.h.close();
});
await test('hosted /buy inactive referral fallback retains stable capacity503 and Retry-After',async()=>{
  const c=await setup({costCeiling:1000});assert.equal((await c.checkout()).status,200);
  const configured=await jsonReq(c.h.origin+'/admin/api/earn/stripe-configure',{method:'POST',headers:{'x-hub-admin':'test-admin-token','x-wh-earn':'1','content-type':'application/json'},body:JSON.stringify({enabled:true,mode:'live'})});assert.equal(configured.status,200);
  const response=await fetch(c.h.origin+'/buy?plan=lifetime&hosting=true&ref=INACTIVE_OFFER',{redirect:'manual'}),body=await response.json();
  assert.equal(response.status,503);assert.equal(body.code,'HOSTED_CHECKOUT_CAPACITY');assert.equal(body.retryAfterSeconds,60);
  assert.equal(response.headers.get('retry-after'),'60');assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(c.sessions.size,1);assert.equal(c.h.hub.hosting.store.instances().length,1);assert.equal(c.provider.createCalls.length,0);await c.h.close();
});
await test('hosted retries distinguish local expiry pending from exact canonical unpaid expiry',async()=>{
  const c=await setup(),attemptId=randomUUID();assert.equal((await c.checkout('lifetime',true,{attemptId})).status,200);
  const s=c.last(),file=path.join(c.h.dataDir,'billing-launch-intents.v1',s.metadata.wh_launch_intent+'.json'),before=JSON.parse(fs.readFileSync(file));
  c.advance(30*60000);assert.equal((await c.checkout('lifetime',true,{attemptId})).body.url,s.url);
  c.advance(60000);const pending=await c.checkout('lifetime',true,{attemptId});assert.equal(pending.status,409);assert.equal(pending.body.code,'HOSTED_CHECKOUT_EXPIRY_PENDING');
  assert.equal(JSON.parse(fs.readFileSync(file)).expiredAtMs,undefined);assert.equal(c.sessions.size,1);
  assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,409,'an open Session cannot authorize rotation');
  s.status='expired';s.payment_status='paid';assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,409,'a paid Session cannot authorize rotation');
  s.payment_status='unpaid';const price=s.lines[1].price.id;s.lines[1].price.id='price_wrong';assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,409);s.lines[1].price.id=price;
  assert.equal(JSON.parse(fs.readFileSync(file)).expiredAtMs,undefined);
  assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,200);
  const response=await fetch(c.h.origin+'/api/billing/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({plan:'lifetime',payment:'card',hosting:true,attemptId})});
  assert.equal(response.status,410);assert.equal((await response.json()).code,'HOSTED_CHECKOUT_EXPIRED');assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await c.checkout('lifetime',true)).status,200);assert.equal((await c.checkout('lifetime',true,{attemptId})).status,410);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).stripeParams,before.stripeParams);assert.equal(c.sessions.size,2);assert.equal(c.provider.createCalls.length,0);await c.h.close();
});
await test('authenticated hosted claim retains its identity on local expiry and rebinds only after canonical expiry',async()=>{
  const c=await setup(),issued=c.h.store.issue('Authenticated hosted expiry',30),auth={licenseId:issued.payload.id,token:issued.token},attemptId=randomUUID();
  assert.equal((await c.checkout('monthly',true,{...auth,attemptId})).status,200);const s=c.last();
  const claim=path.join(c.h.dataDir,'billing-launch-claims.v1','live',hash(issued.payload.id)+'.json'),original=fs.readFileSync(claim,'utf8');
  assert.equal((await c.checkout('monthly',true,auth)).body.url,s.url,'a new browser id before expiry still reuses the owned pending Session');
  c.advance(25*3600000);const pending=await c.checkout('monthly',true,auth);assert.equal(pending.status,409);assert.equal(pending.body.code,'HOSTED_CHECKOUT_EXPIRY_PENDING');assert.equal(fs.readFileSync(claim,'utf8'),original);assert.equal(c.sessions.size,1);
  assert.equal(c.calls.filter(x=>x.p==='/v1/checkout/sessions/'+s.id).length,0,'local time must not clear the hosted claim using the weaker legacy status-only shortcut');
  s.status='expired';assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,200);assert.equal(fs.existsSync(claim),false);
  assert.equal((await c.checkout('monthly',true,{...auth,attemptId})).status,410);assert.equal(fs.existsSync(claim),false,'old attempt must not recreate its cleared claim');
  // Reproduce a crash after canonical proof was saved but before claim cleanup.
  fs.writeFileSync(claim,original);const next=await c.checkout('monthly',true,auth);assert.equal(next.status,200);assert.notEqual(next.body.url,s.url);
  assert.equal(JSON.parse(fs.readFileSync(claim)).id,c.last().metadata.wh_launch_intent);assert.equal(c.sessions.size,2);assert.equal(c.provider.createCalls.length,0);await c.h.close();
});
for (const historicalFlag of [false,true]) await test(`reservation release refusal cannot authorize expiry rotation (${historicalFlag?'historical expiry flag':'new intent'})`,async()=>{
  const c=await setup(),issued=c.h.store.issue('Release refusal',30),auth={licenseId:issued.payload.id,token:issued.token},attemptId=randomUUID();
  assert.equal((await c.checkout('monthly',true,{...auth,attemptId})).status,200);const s=c.last();
  const file=path.join(c.h.dataDir,'billing-launch-intents.v1',s.metadata.wh_launch_intent+'.json');
  const claim=path.join(c.h.dataDir,'billing-launch-claims.v1','live',hash(issued.payload.id)+'.json'),claimBefore=fs.readFileSync(claim,'utf8');
  if(historicalFlag){const old=JSON.parse(fs.readFileSync(file));old.expiredAtMs=c.now();fs.writeFileSync(file,JSON.stringify(old));}
  c.advance(31*60000);s.status='expired';
  const original=c.h.hub.hosting.releaseSplitReservation.bind(c.h.hub.hosting);
  c.h.hub.hosting.releaseSplitReservation=()=>false;
  assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,409);
  const persisted=JSON.parse(fs.readFileSync(file));assert.equal(persisted.reservationReleasedAtMs,undefined);assert.equal(persisted.expiredAtMs!==undefined,historicalFlag);
  for(const extra of [{...auth,attemptId},auth]){const pending=await c.checkout('monthly',true,extra);assert.equal(pending.status,409);assert.equal(pending.body.code,'HOSTED_CHECKOUT_EXPIRY_PENDING');}
  assert.equal(fs.readFileSync(claim,'utf8'),claimBefore);assert.equal(c.sessions.size,1);assert.equal(c.h.hub.hosting.store.getInstance(s.metadata.reservation).stage,'ordered');
  c.h.hub.hosting.releaseSplitReservation=original;
  // A legacy flag cannot bypass a fresh canonical paid/open/price check.
  s.payment_status='paid';assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,409);
  assert.equal((await c.checkout('monthly',true,auth)).status,409);s.payment_status='unpaid';
  if(historicalFlag)assert.equal((await c.checkout('monthly',true,{...auth,attemptId})).status,410,'owned historical retry lazily reproves and seals release');
  else assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,200);
  assert.equal(typeof JSON.parse(fs.readFileSync(file)).reservationReleasedAtMs,'number');
  assert.equal((await c.checkout('monthly',true,{...auth,attemptId})).status,410);assert.equal((await c.checkout('monthly',true,auth)).status,200);
  assert.equal(c.sessions.size,2);assert.equal(c.provider.createCalls.length,0);await c.h.close();
});
await test('a new authenticated attempt lazily reconciles an owned historical claim before rebinding',async()=>{
  const c=await setup(),issued=c.h.store.issue('Historical claim',30),auth={licenseId:issued.payload.id,token:issued.token},attemptId=randomUUID();
  assert.equal((await c.checkout('lifetime',true,{...auth,attemptId})).status,200);const s=c.last();
  const file=path.join(c.h.dataDir,'billing-launch-intents.v1',s.metadata.wh_launch_intent+'.json'),old=JSON.parse(fs.readFileSync(file));
  old.expiredAtMs=c.now();fs.writeFileSync(file,JSON.stringify(old));s.status='expired';
  const result=await c.checkout('lifetime',true,auth);assert.equal(result.status,200);assert.notEqual(result.body.url,s.url);
  assert.equal(c.h.hub.hosting.store.getInstance(s.metadata.reservation).stage,'deleted');assert.equal(typeof JSON.parse(fs.readFileSync(file)).reservationReleasedAtMs,'number');
  const claim=path.join(c.h.dataDir,'billing-launch-claims.v1','live',hash(issued.payload.id)+'.json');assert.equal(JSON.parse(fs.readFileSync(claim)).id,c.last().metadata.wh_launch_intent);
  assert.equal((await c.checkout('lifetime',true,{...auth,attemptId})).status,410);assert.equal(c.sessions.size,2);assert.equal(c.provider.createCalls.length,0);await c.h.close();
});
await test('a crash after exact reservation release keeps rotation blocked until canonical idempotent replay seals release',async()=>{
  const c=await setup(),issued=c.h.store.issue('Release crash',30),auth={licenseId:issued.payload.id,token:issued.token},attemptId=randomUUID();
  assert.equal((await c.checkout('yearly',true,{...auth,attemptId})).status,200);const s=c.last();
  const file=path.join(c.h.dataDir,'billing-launch-intents.v1',s.metadata.wh_launch_intent+'.json');
  const claim=path.join(c.h.dataDir,'billing-launch-claims.v1','live',hash(issued.payload.id)+'.json'),before=fs.readFileSync(claim,'utf8');
  c.advance(31*60000);s.status='expired';
  const original=c.h.hub.hosting.releaseSplitReservation.bind(c.h.hub.hosting);
  c.h.hub.hosting.releaseSplitReservation=(...args)=>{assert.equal(original(...args),true);throw Error('fixture crash after release before durable seal');};
  assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,409);
  assert.equal(c.h.hub.hosting.store.getInstance(s.metadata.reservation).stage,'deleted');
  let intent=JSON.parse(fs.readFileSync(file));assert.equal(intent.expiredAtMs,undefined);assert.equal(intent.reservationReleasedAtMs,undefined);
  assert.equal((await c.checkout('yearly',true,{...auth,attemptId})).status,409);assert.equal((await c.checkout('yearly',true,auth)).status,409);
  assert.equal(fs.readFileSync(claim,'utf8'),before);assert.equal(c.sessions.size,1);
  c.h.hub.hosting.releaseSplitReservation=original;
  assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,200);
  intent=JSON.parse(fs.readFileSync(file));assert.equal(typeof intent.expiredAtMs,'number');assert.equal(typeof intent.reservationReleasedAtMs,'number');assert.equal(fs.existsSync(claim),false);
  assert.equal((await c.checkout('yearly',true,{...auth,attemptId})).status,410);assert.equal((await c.checkout('yearly',true,auth)).status,200);
  assert.equal(c.sessions.size,2);assert.equal(c.provider.createCalls.length,0);await c.h.close();
});
await test('lost hosted create response retains retry identity until canonical expiry proof',async()=>{
  const c=await setup({loseResponse:true}),attemptId=randomUUID();assert.equal((await c.checkout('yearly',true,{attemptId})).status,400);const s=c.last();
  c.advance(31*60000);const pending=await c.checkout('yearly',true,{attemptId});assert.equal(pending.status,409);assert.equal(pending.body.code,'HOSTED_CHECKOUT_EXPIRY_PENDING');assert.equal(c.sessions.size,1);
  assert.equal(c.calls.filter(x=>x.p==='/v1/checkout/sessions'&&x.method==='POST').length,1);
  s.status='expired';assert.equal((await c.admin('/admin/api/billing/hosted-checkout/reconcile-expired',{sessionId:s.id})).status,200);
  assert.equal((await c.checkout('yearly',true,{attemptId})).status,410);assert.equal((await c.checkout('yearly',true)).status,200);assert.equal(c.sessions.size,2);await c.h.close();
});
await test('owned /buy links and old hosted aliases all use reserved v2 checkout with launch disabled',async()=>{
  const c=await setup();await c.admin('/admin/api/billing/launch',{enabled:false,cryptoEnabled:false});
  for(const suffix of ['?plan=monthly&hosting=true','?plan=hosted-yearly','?plan=lifetime-hosted']) {const r=await fetch(c.h.origin+'/buy'+suffix,{redirect:'manual'});assert.equal(r.status,302);assert.equal(c.last().metadata.bundle,'software-hosting-v2');}
  assert.equal((await fetch(c.h.origin+'/buy?plan=monthly',{redirect:'manual'})).status,302);assert.equal(c.last().lines.length,1);await c.h.close();
});
await test('lost create response invoice retries until checkout recovers immutable session, then grants once',async()=>{
  const over={loseResponse:true},c=await setup(over);assert.equal((await c.checkout('lifetime',true)).status,400);const s=c.last();assert.equal((await c.post('invoice.paid',c.invoice(s))).status,500);
  assert.equal((await c.post('checkout.session.completed',c.paid(s))).status,200);const rec=c.h.hub.billing.store.getCustomer('cus_'+s.id),exp=c.h.store.get(rec.licenseId).exp;
  assert.equal((await c.post('invoice.paid',c.invoice(s))).status,200);assert.equal(c.h.store.get(rec.licenseId).exp,exp);assert.equal(c.sessions.size,1);await c.h.close();
});
await test('Lifetime durable marker recovers customer-write crash across BillingService restart',async()=>{
  const c=await setup();await c.checkout('lifetime',true);const s=c.last(),store=c.h.hub.billing.store,original=store.putCustomer.bind(store);let crash=true;
  store.putCustomer=rec=>{original(rec);if(crash){crash=false;throw Error('fixture process crash after customer write');}};
  assert.equal((await c.post('invoice.paid',c.invoice(s))).status,500);const before=store.getCustomer('cus_'+s.id),exp=c.h.store.get(before.licenseId).exp;
  const restarted=new BillingService(c.h.dataDir,c.h.store,'https://hub.test',path.resolve('templates'),{now:c.now,log:()=>{},launchFetch:c.fake,onBundleEvent:i=>c.h.hub.hosting.acceptBundleReservation(i.reservationId,i.customerId,i.subscriptionId,i.planKey,i.livemode,i.terminal)});
  assert.equal((await restarted.applyEvent({id:'evt_restart',type:'invoice.paid',livemode:true,createdMs:c.now(),object:c.invoice(s)})).outcome,'applied');assert.equal(c.h.store.get(before.licenseId).exp,exp);assert.equal(restarted.store.getCustomer(before.key).lifetimeAccess,true);assert(restarted.store.getCustomer(before.key).chargeIds.includes('ch_'+s.id));await c.h.close();
});
await test('software initial refund after hosting cancellation remains attributable, VPS-only renewal refund never revokes Lifetime',async()=>{
  const c=await setup();await c.checkout('lifetime',true);const s=c.last();await c.post('invoice.paid',c.invoice(s));const rec=c.h.hub.billing.store.getCustomer('cus_'+s.id);
  await c.post('customer.subscription.deleted',{id:'sub_'+s.id,customer:rec.key,status:'canceled',metadata:s.metadata,items:{data:[{price:s.lines[1].price}]}});
  assert.equal((await c.post('charge.refunded',{id:'ch_'+s.id,customer:rec.key,payment_intent:'pi_'+s.id,amount:101900,amount_refunded:101900,refunded:true})).status,200);assert.equal(c.h.hub.billing.store.getCustomer(rec.key).refunded,true);await c.h.close();
});
await test('a deletion racing a held checkout read remains terminal after serialized settlement',async()=>{
  const over={},c=await setup(over);await c.checkout();const s=c.last();let release,entered;
  const held=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>entered=resolve);over.lineHook=async()=>{entered();await held;};
  const paid=c.post('checkout.session.completed',c.paid(s));await seen;
  const deleted=c.post('customer.subscription.deleted',{id:'sub_'+s.id,customer:'cus_'+s.id,status:'canceled',metadata:s.metadata,items:{data:s.lines.map(l=>({price:l.price}))}});release();
  assert.equal((await paid).status,200);assert.equal((await deleted).status,200);assert.equal(c.h.hub.billing.store.getBundleSubscription('sub_'+s.id).terminal,true);assert.equal(c.h.hub.billing.store.getCustomer('cus_'+s.id).subscriptionStatus,'canceled');await c.h.close();
});
summary('Six-plan billing');
