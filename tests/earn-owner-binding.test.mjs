import assert from 'node:assert/strict';
import { EarnService, earnOwner } from '../dist/src/earn.js';
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
    const portalAfter=await (await fetch(h.origin+'/api/customer/earn',{headers:{cookie:`wh_customer_session=${newSession}`}})).json();
    assert.equal(portalAfter.member.id,before.member.id);
    assert.equal(portalAfter.balances.marketplace,1200);
  });
} finally { await h.close(); }

summary('earn-owner-binding');
