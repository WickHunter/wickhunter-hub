import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { freshHub } from './helpers.mjs';

const h = await freshHub();
const now = Date.now();
function customer(email, {livemode = true, days = 30, refunded = false, disputed = false} = {}) {
  const issued = h.store.issueUntil(email, now + days * 86400000, 'unleashed', days < 0 ? now - 3 * 86400000 : now);
  const key = 'cus_' + issued.payload.id;
  h.hub.billing.store.putCustomer({key,stripeCustomerId:key,email,name:email,livemode,licenseId:issued.payload.id,planKey:'monthly',subscriptionId:null,subscriptionStatus:null,periodEndMs:null,chargeIds:[],createdAtMs:now,updatedAtMs:now,welcomeSentAtMs:null,welcomeError:null,refunded,disputed,lastEventType:null,lastEventAtMs:null});
  return {key,...issued};
}
function session(email) {
  const identity=h.hub.customerSessions.store.ensureIdentity(email,now);
  return 'wh_customer_session='+h.hub.customerSessions.store.createSession(identity.id,'127.0.0.1',now);
}
const ada=customer('ada@example.com');
const bob=customer('bob@example.com');
const cookie=session('ADA@EXAMPLE.COM');
const action={cookie,'content-type':'application/json','x-wh-customer-action':'1',origin:new URL(h.cfg.publicOrigin).origin,'sec-fetch-site':'same-origin'};
async function reveal(key,headers=action){return fetch(h.origin+'/api/customer/license-key',{method:'POST',headers,body:JSON.stringify({customerKey:key})});}
try {
 await test('owner can reveal the exact current key without rotating or issuing a licence',async()=>{
   const before=JSON.stringify(h.hub.billing.store.getCustomer(ada.key));
   const r=await reveal(ada.key); assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('access-control-allow-origin'),null);
   const body=await r.json();assert.equal(body.licenseKey,ada.token);assert.equal(h.store.verify(body.licenseKey).ok,true);
   assert.equal(JSON.stringify(h.hub.billing.store.getCustomer(ada.key)),before);
   const state=await fetch(h.origin+'/api/customer/state',{headers:{cookie}}).then(r=>r.json());assert.ok(!JSON.stringify(state).includes(ada.token),'ordinary dashboard JSON never includes the secret');
 });
 await test('another customer, missing session, cross-origin requests and missing action header cannot obtain keys',async()=>{
   assert.equal((await reveal(bob.key)).status,403);
   assert.equal((await reveal('unknown')).status,403);
   assert.equal((await reveal(ada.key,{...action,cookie:''})).status,401);
   assert.equal((await reveal(ada.key,{...action,origin:'https://www.wickhunterunleashed.com'})).status,403);
   assert.equal((await reveal(ada.key,{...action,'sec-fetch-site':'same-site'})).status,403);
   const {['x-wh-customer-action']:_,...missing}=action;assert.equal((await reveal(ada.key,missing)).status,403);
 });
 await test('revoked, refunded, disputed, expired and test-mode licences cannot be revealed',async()=>{
   for(const opts of [{refunded:true},{disputed:true},{days:-1},{livemode:false}]) {
     const c=customer('ada@example.com',opts);assert.equal((await reveal(c.key)).status,403);
   }
   const c=customer('ada@example.com');h.store.revoke(c.payload.id);assert.equal((await reveal(c.key)).status,403);
 });
 await test('dashboard reveal, copy and hide use the authenticated endpoint and clear the key',async()=>{
   const html=readFileSync(new URL('../public/customer.html',import.meta.url),'utf8');
   const dom=new JSDOM(html,{url:'https://hub.wickhunterunleashed.com/customer',runScripts:'outside-only'});
   const calls=[],copies=[];
   dom.window.fetch=async(path,init={})=>{calls.push({path,init});return {status:200,ok:true,json:async()=>path==='/api/customer/state'?{ok:true,email:'ada@example.com',software:[{customerKey:ada.key,livemode:true,plan:'monthly',exp:now+86400000,revoked:false,exitOnly:false,portalAvailable:false}],hosting:{available:false}}:{ok:true,licenseKey:ada.token}};};
   Object.defineProperty(dom.window.navigator,'clipboard',{value:{writeText:async value=>copies.push(value)}});
   try {
     dom.window.eval([...dom.window.document.scripts].map(s=>s.textContent).join('\n'));
     await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
     const btn=dom.window.document.querySelector('.v-license-key');assert.ok(btn);btn.click();await new Promise(r=>setImmediate(r));
     const box=dom.window.document.querySelector('.v-license-value');assert.equal(box.hidden,false);assert.ok(box.textContent.includes(ada.token));
     const request=calls.find(c=>c.path==='/api/customer/license-key');assert.equal(request.init.credentials,'same-origin');assert.equal(request.init.headers['x-wh-customer-action'],'1');assert.equal(JSON.parse(request.init.body).customerKey,ada.key);
     box.querySelector('button').click();await new Promise(r=>setImmediate(r));assert.deepEqual(copies,[ada.token]);
     btn.click();assert.equal(box.hidden,true);assert.equal(box.textContent,'');
   } finally {dom.window.close();}
 });
} finally { await h.close(); }
