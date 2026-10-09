import assert from 'node:assert/strict';
import { EarnService, earnOwner } from '../dist/src/earn.js';
import { existingEarnMemberForVerifiedEmail } from '../dist/src/earn-registration-owner.js';
import { setFlag } from '../dist/src/flags.js';
import { freshHub, tmpDir, test, summary } from './helpers.mjs';

await test('a legacy balance stays with a billing identity after its email changes', () => {
  const dir=tmpDir('owner-binding'),earn=new EarnService(dir);
  const legacy=earnOwner('email:old@example.com');
  earn.member(legacy,'Old name');
  earn.record({owner:legacy,source:'marketplace',kind:'earning',cents:2300,period:'2026-08',reference:'legacy-settlement',note:'Settled'});
  const keys=['stripe:live:cus_legacy','license:lic_legacy'];
  assert.equal(earn.bindOwner(keys,[legacy],earnOwner(keys[0])),legacy);
  const reopened=new EarnService(dir);
  // The binding is persisted on disk, not cached in one EarnService instance.
  assert.equal(reopened.boundOwner(keys),legacy);
  assert.equal(reopened.bindOwner(keys,[earnOwner('email:new@example.com')],earnOwner(keys[0])),legacy);
  assert.equal(reopened.view(legacy,'New name').balances.marketplace,2300);
});

await test('conflicting historical owners are held instead of merged', () => {
  const earn=new EarnService(tmpDir('owner-conflict'));
  const first=earnOwner('email:first@example.com'),second=earnOwner('license:lic_second');
  earn.member(first,'First');earn.member(second,'Second');
  assert.throws(()=>earn.bindOwner(['stripe:live:cus_conflict','license:lic_second'],[first,second],first),/Conflicting historical/);
  assert.equal(earn.boundOwner(['stripe:live:cus_conflict']),null);
});

await test('the partner registrar resolves only existing live bound or legacy email owners without binding', () => {
  const dir=tmpDir('registration-owner'),earn=new EarnService(dir),owner=earnOwner('stripe:live:cus_partner');
  earn.member(owner,'Verified partner');
  const customer=(key,stripeCustomerId,licenseId,email='partner@example.com')=>({key,stripeCustomerId,licenseId,email,name:'Partner',livemode:true});
  const records=[customer('cus_partner','cus_partner','lic_partner'),customer('cus_partner_2','cus_partner_2','lic_partner_2')];
  earn.bindOwner(['stripe:live:cus_partner','license:lic_partner','stripe:live:cus_partner_2','license:lic_partner_2'],[],owner);
  const before=earn.fileVersion();
  const bound=existingEarnMemberForVerifiedEmail(earn,records,' Partner@Example.com ');
  assert.equal(bound.owner,owner);assert.equal(bound.member.name,'Verified partner');assert.equal(bound.customerCount,2);assert.equal(bound.source,'billing-binding');
  assert.equal(earn.fileVersion(),before,'registrar resolution is read-only');

  const legacy=earnOwner('email:legacy@example.com');earn.member(legacy,'Legacy verified member');
  const legacyBefore=earn.fileVersion();
  const resolved=existingEarnMemberForVerifiedEmail(earn,[customer('email:legacy@example.com','email:legacy@example.com','lic_legacy','legacy@example.com')],'legacy@example.com');
  assert.equal(resolved.owner,legacy);assert.equal(resolved.source,'legacy-email');assert.equal(earn.fileVersion(),legacyBefore);

  const unbound=customer('cus_unbound','cus_unbound','lic_unbound');
  const noOwnerBefore=earn.fileVersion();
  assert.throws(()=>existingEarnMemberForVerifiedEmail(earn,[unbound],'partner@example.com'),/No existing bound or legacy Earn member/);
  assert.equal(earn.fileVersion(),noOwnerBefore,'no new member or owner binding is created');
  earn.member(earnOwner('email:partner@example.com'),'Legacy partner');
  assert.throws(()=>existingEarnMemberForVerifiedEmail(earn,[records[0],unbound],'partner@example.com'),/Some matching billing customers are unbound/);

  const other=earnOwner('email:other@example.com');earn.member(other,'Other');
  earn.bindOwner(['stripe:live:cus_other','license:lic_other'],[],other);
  assert.throws(()=>existingEarnMemberForVerifiedEmail(earn,[records[0],customer('cus_other','cus_other','lic_other')],'partner@example.com'),/conflicting immutable Earn owners/);
  assert.throws(()=>existingEarnMemberForVerifiedEmail(earn,[],'test@example.com'),/No live billing customer/);
});

const h=await freshHub();
try {
  await test('a verified app license keeps one Earn member and balance through customer email change',async()=>{
    const issued=h.store.issueUntil('Bound member',Date.now()+86_400_000,'unleashed');
    const record={key:'cus_owner_binding',stripeCustomerId:'cus_owner_binding',email:'first@example.com',name:'Bound member',
      livemode:true,licenseId:issued.payload.id,planKey:null,subscriptionId:null,subscriptionStatus:'active',
      periodEndMs:null,chargeIds:[],createdAtMs:Date.now(),updatedAtMs:Date.now(),welcomeSentAtMs:null,
      welcomeError:null,disputed:false,refunded:false,lastEventType:null,lastEventAtMs:null};
    h.hub.billing.store.putCustomer(record);
    setFlag(h.dataDir,issued.payload.id,'earn',true);
    const headers={'x-license':issued.token};
    const before=await (await fetch(h.origin+'/api/hub/earn',{headers})).json();
    assert.equal(before.member.id,earnOwner('stripe:live:cus_owner_binding'));
    const oldIdentity=h.hub.customerSessions.store.ensureIdentity('first@example.com');
    const oldSession=h.hub.customerSessions.store.createSession(oldIdentity.id,'127.0.0.1');
    const portalBefore=await (await fetch(h.origin+'/api/customer/earn',{headers:{cookie:`wh_customer_session=${oldSession}`}})).json();
    assert.equal(portalBefore.member.id,before.member.id);
    new EarnService(h.dataDir).record({owner:before.member.id,source:'marketplace',kind:'earning',cents:1200,
      period:'2026-08',reference:'owner-binding-settlement',note:'Settled'});
    h.hub.billing.store.putCustomer({...record,email:'changed@example.com',updatedAtMs:Date.now()});
    const after=await (await fetch(h.origin+'/api/hub/earn',{headers})).json();
    assert.equal(after.member.id,before.member.id);
    assert.equal(after.balances.marketplace,1200);
    const newIdentity=h.hub.customerSessions.store.ensureIdentity('changed@example.com');
    const newSession=h.hub.customerSessions.store.createSession(newIdentity.id,'127.0.0.1');
    const portalHeaders={cookie:`wh_customer_session=${newSession}`};
    const portalAfter=await (await fetch(h.origin+'/api/customer/earn',{headers:portalHeaders})).json();
    assert.equal(portalAfter.member.id,before.member.id);
    assert.equal(portalAfter.balances.marketplace,1200);
    const preferenceResponse=await fetch(h.origin+'/api/customer/earn/payout-preference',{method:'POST',
      headers:{...portalHeaders,'content-type':'application/json','x-wh-earn':'1'},
      body:JSON.stringify({owner:'untrusted-body-owner',method:'paypal',address:'Jane.Payee+Wh@example.com',expectedRevision:null})});
    assert.equal(preferenceResponse.status,200);
    const saved=(await preferenceResponse.json()).payoutPreference;
    assert.deepEqual(saved,{method:'paypal',address:'Jane.Payee+Wh@example.com',revision:saved.revision});
    const sessionView=await (await fetch(h.origin+'/api/customer/earn',{headers:portalHeaders})).json();
    assert.equal(sessionView.member.id,before.member.id,'owner comes from the authenticated stable billing identity');
    assert.deepEqual(sessionView.member.payoutPreference,saved);
    assert.equal(new EarnService(h.dataDir).admin().members.length,1,'request body cannot create a second owner');
  });
} finally { await h.close(); }

const payer={email:'j.a.n.e.d.o.e+own@googlemail.com'};
let ownerCoupon=null,ownerPromo=null;
const stripeFetch=async(url,init)=>{
  const u=new URL(url),ep=u.pathname;
  const ok=(body,status=200)=>new Response(JSON.stringify(body),{status});
  if(ep==='/v1/prices/price_month')return ok({id:'price_month',active:true,recurring:{interval:'month'},currency:'usd',product:'prod_wh'});
  if(ep.startsWith('/v1/coupons/')&&init.method==='GET'){if(!ownerCoupon)return ok({error:{code:'resource_missing'}},404);return ok(u.searchParams.get('expand[0]')==='applies_to'?ownerCoupon:Object.fromEntries(Object.entries(ownerCoupon).filter(([k])=>k!=='applies_to')));}
  if(ep==='/v1/coupons'){
    if(init.method==='GET')return ok({data:[]});
    const body=Object.fromEntries(new URLSearchParams(init.body));
    ownerCoupon={id:body.id,percent_off:Number(body.percent_off),duration:'forever',valid:true,applies_to:{products:Object.entries(body).filter(([k])=>k.startsWith('applies_to[products][' )).map(([,v])=>v)},metadata:{managed_by:'wh-earn'}};
    return ok(body['expand[0]']==='applies_to'?ownerCoupon:Object.fromEntries(Object.entries(ownerCoupon).filter(([k])=>k!=='applies_to')));
  }
  if(ep==='/v1/promotion_codes'){
    if(init.method==='GET')return ok({data:[]});
    const body=Object.fromEntries(new URLSearchParams(init.body));
    ownerPromo={id:'promo_bound',code:body.code,coupon:ownerCoupon.id,active:true,livemode:true,expires_at:null,max_redemptions:null,metadata:{managed_by:body['metadata[managed_by]'],wh_earn_owner:body['metadata[wh_earn_owner]']}};
    return ok(ownerPromo);
  }
  if(ep==='/v1/promotion_codes/promo_bound')return ownerPromo?ok(ownerPromo):ok({error:{code:'resource_missing'}},404);
  if(ep.startsWith('/v1/invoices/')){
    const id=ep.split('/').at(-1);
    return ok({id,customer:'cus_payer',status:'paid',currency:'usd',livemode:true,amount_paid:9900,total_excluding_tax:9000,
      total_taxes:[{amount:900}],parent:{subscription_details:{subscription:'sub_'+id}},
      lines:{data:[{pricing:{price_details:{price:'price_month'}},period:{end:1790000000}}]},
      status_transitions:{paid_at:1780000000}});
  }
  if(ep.startsWith('/v1/subscriptions/sub_'))return ok({id:ep.split('/').at(-1),status:'active',metadata:{wh_earn_code:refMember.code},discounts:ownerPromo?[{promotion_code:ownerPromo.id}]:[],items:{data:[{price:'price_month'}]}});
  if(ep==='/v1/customers/cus_payer')return ok({email:payer.email});
  if(ep==='/v1/invoice_payments')return ok({data:[{status:'paid',payment:{type:'charge',charge:'ch_'+u.searchParams.get('invoice')}}]});
  if(ep.startsWith('/v1/charges/ch_'))return ok({amount_refunded:0,disputed:false,livemode:true});
  throw new Error('Unexpected fake Stripe request '+init.method+' '+ep);
};
const boundHub=await freshHub({}, {earnFetch:stripeFetch});
const refEarn=new EarnService(boundHub.dataDir),refOwner=earnOwner('email:jane.doe@gmail.com');
const refMember=refEarn.member(refOwner,'Jane Doe');
const refRecord={key:'cus_ref',stripeCustomerId:'cus_ref',email:'jane.doe@gmail.com',name:'Jane Doe',livemode:true,
  licenseId:'lic_ref',planKey:null,subscriptionId:null,subscriptionStatus:'active',periodEndMs:null,chargeIds:[],
  createdAtMs:Date.now(),updatedAtMs:Date.now(),welcomeSentAtMs:null,welcomeError:null,disputed:false,refunded:false,
  lastEventType:null,lastEventAtMs:null};
try {
  await test('the server-bound referrer mailbox suppresses only its own Gmail alias payer',async()=>{
    boundHub.hub.billing.updateConfig({stripe:{live:{secretKey:'sk_live_fixture',priceIds:{monthly:'price_month'}}}});
    boundHub.hub.billing.store.putCustomer(refRecord);
    refEarn.bindOwner(['stripe:live:cus_ref'],[refOwner],refOwner);
    boundHub.hub.earnStripe.configure({mode:'live',enabled:true});
    await boundHub.hub.earnStripe.activate(refOwner);
    const invoice=async(id)=>boundHub.hub.earnStripe.handleEvent({id:'evt_'+id,type:'invoice.paid',object:{id},livemode:true,createdMs:Date.now()});
    await invoice('in_alias');
    assert.equal(refEarn.admin().stripe.invoices.in_alias,undefined);
    assert.equal(refEarn.view(refOwner,'Jane Doe').balances.referral,0);

    payer.email='different@gmail.com';
    await invoice('in_other_mailbox');
    assert.ok(refEarn.admin().stripe.invoices.in_other_mailbox);
    assert.equal(refEarn.view(refOwner,'Jane Doe').balances.referral,1800);

    // A customer row with the same email but no exact owner binding is not
    // authority to identify that payer as the referrer.
    boundHub.hub.billing.store.putCustomer({...refRecord,email:'elsewhere@gmail.com'});
    boundHub.hub.billing.store.putCustomer({...refRecord,key:'cus_unbound',stripeCustomerId:'cus_unbound',email:'jane.doe@gmail.com',licenseId:'lic_unbound'});
    payer.email='jane.doe+tag@gmail.com';
    await invoice('in_unbound_mailbox');
    assert.ok(refEarn.admin().stripe.invoices.in_unbound_mailbox);
    assert.equal(refEarn.view(refOwner,'Jane Doe').balances.referral,3600);
  });
} finally { await boundHub.close(); }

summary('earn-owner-binding');
