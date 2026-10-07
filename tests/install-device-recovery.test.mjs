import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { JSDOM } from "jsdom";
import { spawnSync } from "node:child_process";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { createHub } from "../dist/src/server.js";
import { BillingStore, INSTALL_TOKEN_TTL_MS, TOKENS_FILE } from "../dist/src/billing/store.js";
import { reissuedInstallEmail } from "../dist/src/billing/email.js";
import { releaseSigningBytes } from "../dist/src/release-manifest.js";

const auth = { "x-hub-admin": "test-admin-token", "content-type": "application/json" };
import { recoveryPath, recoveryRecords } from "../dist/src/billing/install-recovery.js";
import { verifyLicenseLease } from "../dist/src/license-leases.js";
import { EarnService, earnOwner } from "../dist/src/earn.js";
import { writeJsonAtomic } from "../dist/src/jsonfile.js";
async function fixture(checkpoint = () => {}) {
  let now = Date.now(), mailFailure = false, paused = null;
  const mails = [];
  const fetchMail = async (_url, init) => {
    mails.push(JSON.parse(init.body));
    if (paused) await paused;
    return mailFailure ? { ok: false, status: 422, text: async () => init.body } : { ok: true, status: 200, text: async () => '{"id":"fixture-mail"}' };
  };
  const h = await freshHub({}, { billingFetch: fetchMail, billingNow: () => now, licenseLeaseNow: () => now, billingRecoveryCheckpoint: checkpoint });
  let running = h.hub, origin = h.origin;
  const store = new BillingStore(h.dataDir);
  const issued = h.store.issueUntil("Henrique Fixture", now + 30 * 86400000, "unleashed", now);
  const customer = { key: "cus_fixture", stripeCustomerId: "cus_fixture", email: "henrique@example.test", name: "Henrique Fixture", livemode: true,
    licenseId: issued.payload.id, planKey: "monthly", subscriptionId: "sub_fixture", subscriptionStatus: "active", periodEndMs: issued.payload.exp,
    chargeIds: ["ch_fixture"], createdAtMs: now, updatedAtMs: now, welcomeSentAtMs: now, welcomeError: null,
    disputed: false, refunded: false, lastEventType: "invoice.paid", lastEventAtMs: now };
  store.putCustomer(customer);
  const oldPage = store.mint("page", issued.payload.id, customer.key, now);
  const oldInstall = store.mint("install", issued.payload.id, customer.key, now);
  const otherPage = store.mint("page", issued.payload.id, "cus_other", now);
  const artifact = Buffer.from("fixture authenticated release");
  const unsigned = { schema: "wickhunter.release.v1", product: "wickhunter", channel: "beta", platform: "linux", arch: "x64", version: "0.90.135", buildId: "fixture-build", file: "fixture.tar.gz",
    sha256: createHash("sha256").update(artifact).digest("hex"), issuedAt: new Date(now).toISOString(), minUpdateProtocol: 1 };
  fs.writeFileSync(path.join(h.releasesDir, unsigned.file), artifact);
  fs.writeFileSync(path.join(h.releasesDir, "latest.json"), JSON.stringify({ ...unsigned, signatures: [{ kid: h.releaseSigner.kid, alg: "Ed25519", sig: sign(null, releaseSigningBytes(unsigned), h.releaseSigner.privateKey).toString("base64url") }] }));
  const admin = (route, body) => jsonReq(`${origin}${route}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  await admin("/admin/api/billing/config", { email: { provider: "resend", apiKey: "re_fixture_private", from: "Wick Hunter <support@example.test>" } });
  return { h, get hub() {return running;}, get now(){return now;}, store, customer, issued, oldPage, oldInstall, otherPage, mails, admin,
    reissue: (over = {}) => admin("/admin/api/billing/reissue-install", { customerId: customer.key, email: customer.email, issue: "bybit-us-ip", ...over }),
    url: (suffix) => `${origin}${suffix}`,
    advance: (ms) => { now += ms; }, failMail: () => { mailFailure = true; }, pause: (promise) => { paused = promise; },
    restart: async () => { await running.close(); running = createHub(h.cfg, { billingFetch: fetchMail, billingNow: () => now, licenseLeaseNow: () => now, billingRecoveryCheckpoint: checkpoint, candleSleep: async () => {} }); const port = await running.listen(); origin = `http://127.0.0.1:${port}`; },
    close: async () => { await running.close(); fs.rmSync(h.dataDir, { recursive: true, force: true }); fs.rmSync(h.releasesDir, { recursive: true, force: true }); },
  };
}
const rawFromMail = (mail) => /\/install\/([A-Za-z0-9_-]+)/.exec(mail.text)[1];


function machine(id) {
  const keys=generateKeyPairSync("ed25519");
  return {id,keys,pub:keys.publicKey.export({type:"spki",format:"der"}).subarray(-32).toString("base64url")};
}
async function activate(f,issued,m) {
  const headers={"content-type":"application/json","x-license":issued.token};
  const challenge=await jsonReq(f.url("/api/license/lease/challenge"),{method:"POST",headers,body:JSON.stringify({purpose:"activate",installId:m.id,installPublicKey:m.pub})});
  if(challenge.status!==200)return challenge;
  return jsonReq(f.url("/api/license/lease/activate"),{method:"POST",headers,body:JSON.stringify({nonce:challenge.body.challenge.nonce,signature:sign(null,Buffer.from(challenge.body.challenge.proofBytesB64u,"base64url"),m.keys.privateKey).toString("base64url")})});
}
async function prepare(f, operationId="recovery-operation-fixture") {
  const old=await activate(f,f.issued,machine("destroyed-server"));assert.equal(old.status,200,JSON.stringify(old.body));
  const state=f.hub.licenseLeases.adminSnapshot(f.issued.payload.id);
  return {old,request:{customerId:f.customer.key,email:f.customer.email,operationId,expectedLicenseId:f.issued.payload.id,expectedActivationId:old.body.activation.id,expectedActivationRevision:old.body.activation.revision,expectedAuditRevision:state.auditRevision,confirmedDestroyedInstall:true,acknowledgeCachedGrace:true}};
}
const recover=(f,request)=>f.admin("/admin/api/billing/recover-install",request);
await test("linked reset recovery retires only old authority, preserves payment/Earn lineage, and the replacement actually activates",async()=>{
  const f=await fixture();try{
    const {old,request}=await prepare(f);
    f.store.putCheckoutSession({sessionId:"cs_paid",customerKey:f.customer.key,licenseId:f.issued.payload.id,targetExpMs:f.issued.payload.exp,newCustomer:true,status:"applied",createdAtMs:f.now,updatedAtMs:f.now});
    fs.writeFileSync(path.join(f.h.dataDir,"flags.json"),JSON.stringify({default:{marketplace:true},byLicense:{[f.issued.payload.id]:{marketplace:false,earlyAccess:true},unrelated:{unchanged:false}}}));
    const originalCustomer=f.store.getCustomer(f.customer.key), originalMarker=fs.readFileSync(path.join(f.h.dataDir,"billing-checkout-sessions.v1",createHash("sha256").update("cs_paid").digest("hex")+".json"));
    const otherToken=f.store.lookupPage(f.otherPage), beforeLicenceCount=f.h.store.list().length;
    const result=await recover(f,request);assert.equal(result.status,200,JSON.stringify(result.body));
    const next=result.body.licenseId;assert.notEqual(next,f.issued.payload.id);assert.equal(f.h.store.list().length,beforeLicenceCount+1);
    assert.equal(f.h.store.isRevoked(f.issued.payload.id),true);assert.equal(f.store.getCustomer(f.customer.key).licenseId,next);
    assert.deepEqual({...f.store.getCustomer(f.customer.key),licenseId:f.issued.payload.id},originalCustomer);
    assert.deepEqual(f.store.historicalLicenseIds(f.store.getCustomer(f.customer.key)),[f.issued.payload.id]);
    assert.equal(f.store.findByLicense(f.issued.payload.id).key,f.customer.key);
    f.hub.billing.assertAppliedCheckout(f.store.getCheckoutSession("cs_paid"));
    assert.deepEqual(fs.readFileSync(path.join(f.h.dataDir,"billing-checkout-sessions.v1",createHash("sha256").update("cs_paid").digest("hex")+".json")),originalMarker);
    const flags=JSON.parse(fs.readFileSync(path.join(f.h.dataDir,"flags.json")));assert.deepEqual(flags.byLicense[next],{marketplace:false,earlyAccess:true});assert.deepEqual(flags.byLicense.unrelated,{unchanged:false});
    assert.deepEqual(f.store.lookupPage(f.otherPage),otherToken);assert.equal(f.store.lookupPage(f.oldPage),null);
    assert.equal((await fetch(f.url(`/install/${f.oldInstall}`))).status,403);
    assert.equal(f.mails.length,1);assert.match(f.mails[0].text,/same plan and expiry/);assert.match(f.mails[0].text,/Settings → License/);assert.ok(f.mails[0].text.includes(f.h.store.tokenFor(next)));assert.ok(!f.mails[0].text.includes(f.issued.token));assert.doesNotMatch(f.mails[0].text,/US IP|Go|offline|licence remain unchanged|existing licence/);
    const raw=rawFromMail(f.mails[0]);assert.equal((await fetch(f.url(`/install/${raw}`))).status,200);assert.equal((await fetch(f.url(`/install/${raw}`))).status,200);
    const payload=f.h.store.get(next);assert.deepEqual({name:payload.name,exp:payload.exp,plan:payload.plan},{name:f.issued.payload.name,exp:f.issued.payload.exp,plan:f.issued.payload.plan});
    const signed=f.h.store.tokenFor(next);assert.equal((await activate(f,{token:signed},machine("replacement-server"))).status,200);
    const oldState=f.hub.licenseLeases.adminSnapshot(f.issued.payload.id);assert.ok(oldState.recoveryLockedLicenses.includes(f.issued.payload.id));assert.ok(oldState.activations.every(a=>a.status==="deactivated"));
    assert.equal((await activate(f,f.issued,machine("old-other"))).status,403);
    assert.equal(verifyLicenseLease(old.body.lease.token,oldState.publicKeys).ok,true,"previous offline signature remains factual");assert.equal(result.body.cachedOldGraceUntilMs,old.body.lease.payload.policy.cachedGraceUntilMs);
    const done=await recover(f,request);assert.equal(done.status,200);assert.equal(done.body.alreadyCompleted,true);assert.equal(done.body.expiresAtMs,result.body.expiresAtMs);assert.equal(f.mails.length,1);
    const audit=f.store.recentEvents().filter(e=>e.type==="admin.install.device-recovery");assert.equal(audit.length,1);assert.match(audit[0].note,/providerMessageId/);assert.ok(!audit[0].note.includes(raw));
    f.h.store.revoke(next);assert.equal((await recover(f,request)).status,409,"later refund/revocation cannot report a working completed command");
  }finally{await f.close();}
});
await test("exact customer, machine and audit confirmations refuse before any recovery write",async()=>{
  const f=await fixture();try{
    const {request}=await prepare(f),before=fs.readFileSync(path.join(f.h.dataDir,"licenses.json"));
    for(const patch of [{email:"foreign@example.test"},{expectedLicenseId:"foreign"},{expectedActivationId:"foreign"},{expectedActivationRevision:999},{expectedAuditRevision:999},{confirmedDestroyedInstall:false},{acknowledgeCachedGrace:false}])assert.ok((await recover(f,{...request,...patch})).status>=400);
    assert.deepEqual(fs.readFileSync(path.join(f.h.dataDir,"licenses.json")),before);assert.deepEqual(recoveryRecords(f.h.dataDir),[]);assert.equal(f.mails.length,0);
    f.store.putPendingCheckout(f.customer.key,"cs_pending");assert.equal((await recover(f,request)).status,409);assert.equal(f.h.store.isRevoked(f.issued.payload.id),false);
  }finally{await f.close();}
});
await test("every interrupted recovery resumes the SAME reserved ID after real Hub restart and durable pending admission",async()=>{
  for(const cut of ["prepared","issued","retiring","retired","linked","committed"]){
    let stopped=false;const f=await fixture(phase=>{if(phase===cut&&!stopped){stopped=true;throw Error("fixture interruption");}});try{
      const {request}=await prepare(f,"restart-recovery-"+cut);assert.equal((await recover(f,request)).status,409);
      const row=recoveryRecords(f.h.dataDir)[0],reserved=row.newLicenseId;assert.equal(f.mails.length,0);
      await f.restart();f.advance(5000);
      if(["prepared","issued","retiring","retired","linked"].includes(cut)){
        const reissue=await f.reissue({issue:"reinstall",confirmed:true,expectedRevision:f.store.installRevision(f.customer.key),acknowledgeMachineBinding:true});assert.equal(reissue.status,409,cut+" durable ordinary reissue refusal");
        assert.equal(f.hub.billing.regenerateInstall(f.customer.key,f.customer.email,{confirmed:true,expectedRevision:f.store.installRevision(f.customer.key),acknowledgeMachineBinding:true}).ok,false);
      }
      const result=await recover(f,request);assert.equal(result.status,200,cut+JSON.stringify(result.body));assert.equal(result.body.licenseId,reserved);assert.equal(f.mails.length,1);
      assert.equal(f.h.store.list().filter(r=>r.id===reserved).length,1);assert.equal(recoveryRecords(f.h.dataDir)[0].installExpiresAtMs,result.body.expiresAtMs);assert.ok(result.body.expiresAtMs>row.atMs+INSTALL_TOKEN_TTL_MS);
      const repeat=await recover(f,request);assert.equal(repeat.status,200);assert.equal(repeat.body.expiresAtMs,result.body.expiresAtMs);assert.equal(f.mails.length,1);
    }finally{await f.close();}
  }
});
await test("corrupt/unfamiliar durable recovery records never reserve another ID or expose new authority",async()=>{
  for(const bad of ['{"truncated":',JSON.stringify({v:1,operationId:"bad-operation-fixture"})]){
    const f=await fixture();try{
      const {request}=await prepare(f);fs.mkdirSync(path.dirname(recoveryPath(f.h.dataDir,request.operationId)),{recursive:true});fs.writeFileSync(recoveryPath(f.h.dataDir,request.operationId),bad);
      const count=f.h.store.list().length;assert.equal((await recover(f,request)).status,409);assert.equal(f.h.store.list().length,count);assert.equal(f.h.store.isRevoked(f.issued.payload.id),false);assert.equal(f.mails.length,0);
    }finally{await f.close();}
  }
});
await test("retirement audit failure exposes no replacement command and email failure cannot be blindly resent",async()=>{
  let stopped=false;const f=await fixture(p=>{if(p==="issued"&&!stopped){stopped=true;throw Error("stop before retirement");}});try{
    const {request}=await prepare(f);assert.equal((await recover(f,request)).status,409);
    const ledger=path.join(f.h.dataDir,"license-lease-audit.v1.jsonl"),bytes=fs.readFileSync(ledger);fs.appendFileSync(ledger,'{"broken":true}\n');
    assert.equal((await recover(f,request)).status,409);assert.equal(f.mails.length,0);assert.equal(recoveryRecords(f.h.dataDir)[0].phase,"issued");
    fs.writeFileSync(ledger,bytes);f.failMail();assert.equal((await recover(f,request)).status,502);const row=recoveryRecords(f.h.dataDir)[0];assert.equal(row.phase,"email-failed");
    assert.equal((await fetch(f.url(`/install/${rawFromMail(f.mails[0])}`))).status,403);assert.equal((await recover(f,request)).status,409);assert.equal(f.mails.length,1);
    assert.equal(f.store.getCustomer(f.customer.key).licenseId,row.newLicenseId);assert.equal(f.h.store.isRevoked(f.issued.payload.id),true);
  }finally{await f.close();}
});

await test("committed lineage replays a real paid checkout without extension; renewals/refunds affect only current replacement",async()=>{
 const f=await fixture();try{
  const customer=f.store.getCustomer(f.customer.key),billing=f.hub.billing;
  const event=(type,object,id)=>({id,type,livemode:true,createdMs:f.now,object});
  const checkout={id:"cs_original_real",mode:"payment",payment_status:"paid",status:"complete",customer:customer.stripeCustomerId,customer_details:{email:customer.email,name:customer.name},payment_intent:"pi_original",metadata:{plan:"monthly"}};
  assert.equal((await billing.applyEvent(event("checkout.session.completed",checkout,"evt_first"))).outcome,"applied");
  const before=f.h.store.get(customer.licenseId).exp,markerBytes=fs.readFileSync(path.join(f.h.dataDir,"billing-checkout-sessions.v1",createHash("sha256").update(checkout.id).digest("hex")+".json"));
  const {request}=await prepare(f,"payment-recovery-operation");assert.equal((await recover(f,request)).status,200);
  const next=f.store.getCustomer(customer.key).licenseId;assert.equal(f.h.store.get(next).exp,before);
  await f.restart();const replay=await f.hub.billing.applyEvent(event("checkout.session.completed",checkout,"evt_replayed_paid"));assert.equal(replay.outcome,"duplicate");assert.equal(f.h.store.get(next).exp,before);
  assert.deepEqual(fs.readFileSync(path.join(f.h.dataDir,"billing-checkout-sessions.v1",createHash("sha256").update(checkout.id).digest("hex")+".json")),markerBytes);
  const paidUntil=Math.floor((before+30*86400000)/1000);
  assert.equal((await f.hub.billing.applyEvent(event("invoice.paid",{id:"in_next",customer:customer.stripeCustomerId,customer_email:customer.email,customer_name:customer.name,subscription:customer.subscriptionId,charge:"ch_next",payment_intent:"pi_next",paid:true,status:"paid",billing_reason:"subscription_cycle",lines:{data:[{period:{start:Math.floor(f.now/1000),end:paidUntil}}]}},"evt_invoice"))).outcome,"applied");
  assert.ok(f.h.store.get(next).exp>before);assert.equal(f.h.store.isRevoked(customer.licenseId),true);
  assert.equal((await f.hub.billing.applyEvent(event("charge.refunded",{id:"ch_next",customer:customer.stripeCustomerId,payment_intent:"pi_next",amount:10000,amount_refunded:10000,refunded:true},"evt_refund"))).outcome,"applied");
  assert.equal(f.h.store.isRevoked(next),true);assert.equal(f.h.store.isRevoked(customer.licenseId),true);assert.equal(f.store.getCustomer(customer.key).refunded,true);
 }finally{await f.close();}
});
await test("dashboard links keep the existing verified account and immutable Earn owner after recovery",async()=>{
 const f=await fixture();try{
  fs.writeFileSync(path.join(f.h.dataDir,"flags.json"),JSON.stringify({default:{earn:true},byLicense:{}}));const earn=new EarnService(f.h.dataDir);const oldOwner=earnOwner("license:"+f.issued.payload.id);earn.member(oldOwner,"Existing earned owner");
  const identity=f.hub.customerSessions.store.ensureIdentity(f.customer.email),session=f.hub.customerSessions.store.createSession(identity.id,"127.0.0.1");
  const cookie=`wh_customer_session=${session}`;
  const before=await jsonReq(f.url("/api/customer/earn"),{headers:{cookie}});assert.equal(before.status,200);assert.equal(before.body.member.id,oldOwner);
  const memberBefore=JSON.stringify(earn.read().members),entriesBefore=JSON.stringify(earn.read().entries);
  const {request}=await prepare(f,"dashboard-recovery-operation");assert.equal((await recover(f,request)).status,200);
  const after=await jsonReq(f.url("/api/customer/earn"),{headers:{cookie}});assert.equal(after.status,200);assert.equal(after.body.member.id,oldOwner);
  assert.equal(JSON.stringify(earn.read().members),memberBefore);assert.equal(JSON.stringify(earn.read().entries),entriesBefore);
  const dashboard=await jsonReq(f.url("/api/customer/state"),{headers:{cookie}});assert.equal(dashboard.status,200);assert.equal(dashboard.body.software.length,1);assert.equal(dashboard.body.software[0].licenseId,f.store.getCustomer(f.customer.key).licenseId);
  const html=fs.readFileSync(new URL("../public/customer.html",import.meta.url),"utf8"),errors=[];
  const dom=new JSDOM(html,{url:f.url("/customer"),runScripts:"dangerously",beforeParse(w){w.fetch=async(route)=>new Response(JSON.stringify(route==="/api/customer/replacement-license-key"?{ok:true,licenseKey:f.h.store.tokenFor(f.store.getCustomer(f.customer.key).licenseId)}:dashboard.body),{status:200,headers:{"content-type":"application/json"}});w.addEventListener("error",e=>errors.push(e.error));}});
  await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(errors,[]);
  const link=dom.window.document.querySelector(".v-recovery");assert.ok(link);const url=new URL(link.href);assert.equal(url.pathname,"/support");const message=new URLSearchParams(url.hash.slice(1)).get("message");assert.match(message,/reset or replaced/);assert.ok(message.includes(f.customer.email));assert.ok(message.includes(f.customer.key));assert.doesNotMatch(url.href,/LHK1|WHL1|install\//);
  const key=await jsonReq(f.url("/api/customer/replacement-license-key"),{method:"POST",headers:{cookie,"content-type":"application/json","x-wh-customer-action":"1"},body:JSON.stringify({customerKey:f.customer.key})});assert.equal(key.status,200);assert.equal(key.body.licenseKey,f.h.store.tokenFor(f.store.getCustomer(f.customer.key).licenseId));
  assert.equal((await jsonReq(f.url("/api/customer/replacement-license-key"),{method:"POST",headers:{"content-type":"application/json","x-wh-customer-action":"1"},body:JSON.stringify({customerKey:f.customer.key})})).status,401);
  assert.equal((await jsonReq(f.url("/api/customer/replacement-license-key"),{method:"POST",headers:{cookie,"content-type":"application/json","x-wh-customer-action":"1"},body:JSON.stringify({customerKey:"foreign"})})).status,403);
  const keyBtn=dom.window.document.querySelector(".v-replacement-key");assert.equal(keyBtn.hidden,false);keyBtn.click();await new Promise(resolve=>setTimeout(resolve,20));
  const keyBox=dom.window.document.querySelector(".v-key");assert.equal(keyBox.hidden,false);assert.ok(keyBox.textContent.includes(key.body.licenseKey));keyBox.querySelector("button").click();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(keyBox.querySelector("button").textContent,"Select and copy manually");assert.equal(dom.window.getSelection().toString(),key.body.licenseKey);
  dom.window.close();
 }finally{await f.close();}
});

await test("interrupted recovery cannot retire a machine or entitlement that changed after preparation",async()=>{
 for(const cut of ["issued","retiring"])for(const change of ["machine","entitlement","flags"]){
  let halted=false;const f=await fixture(phase=>{if(phase===cut&&!halted){halted=true;throw Error("pause issued");}});try{
   const {request}=await prepare(f,"stale-recovery-"+cut+change);assert.equal((await recover(f,request)).status,409);await f.restart();
   if(change==="machine")f.hub.licenseLeases.adminDeactivate(f.issued.payload.id,request.expectedActivationId,request.expectedActivationRevision,"another authorized operation");
   else if(change==="flags")fs.writeFileSync(path.join(f.h.dataDir,"flags.json"),JSON.stringify({default:{},byLicense:{[f.issued.payload.id]:{earn:false}}}));
   else f.h.store.setExpiry(f.issued.payload.id,f.issued.payload.exp+86400000,f.now);
   assert.equal((await recover(f,request)).status,409);assert.equal(f.h.store.isRevoked(f.issued.payload.id),false);assert.equal(f.mails.length,0);assert.equal(recoveryRecords(f.h.dataDir)[0].phase,cut);
  }finally{await f.close();}
 }
});
summary("install-device-recovery");
