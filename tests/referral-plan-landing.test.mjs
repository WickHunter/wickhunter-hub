import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {freshHub,jsonReq,test,summary} from './helpers.mjs';

let outboundCalls=0;
const blockedFetch=async()=>{outboundCalls++;throw Error('Unexpected outbound work from plan landing');};
const h=await freshHub({}, {billingFetch:blockedFetch,earnFetch:blockedFetch});
const configure=body=>jsonReq(h.origin+'/admin/api/billing/config',{method:'POST',headers:{'x-hub-admin':'test-admin-token','content-type':'application/json'},body:JSON.stringify(body)});
const get=query=>fetch(h.origin+'/buy'+query,{redirect:'manual'});
function dataSnapshot(dir){
 const files={};
 function walk(root){for(const entry of fs.readdirSync(root,{withFileTypes:true})){const file=path.join(root,entry.name);if(entry.isDirectory())walk(file);else if(entry.isFile())files[path.relative(dir,file)]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');}}
 walk(dir);return files;
}
try{
 await test('missing chooser configuration fails closed without a checkout',async()=>{
  for(const query of ['','?ref=FIXTURE_REF','?plan=&ref=FIXTURE_REF&hosting=true']){
   const response=await get(query);assert.equal(response.status,503);assert.equal(response.headers.get('location'),null);assert.match(await response.text(),/plan chooser is not configured/);
  }
  assert.equal(outboundCalls,0);
 });
 const configured=await configure({siteOrigin:'https://site.example.test',stripe:{test:{paymentLinks:{monthly:'https://buy.stripe.com/test_monthly',yearly:'https://buy.stripe.com/test_yearly',lifetime:'https://buy.stripe.com/test_lifetime'}}}});
 assert.equal(configured.status,200);
 await test('absent and blank plans choose all plans before any checkout or reservation',async()=>{
  const before=dataSnapshot(h.dataDir);
  for(const query of ['','?plan=','?plan=%20%20','?hosting=true','?payment=crypto&hosting=true']){
   const response=await get(query);assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://site.example.test/unleashed/#pricing');assert.equal(response.headers.get('cache-control'),'no-store');
  }
  assert.deepEqual(dataSnapshot(h.dataDir),before);assert.equal(outboundCalls,0);
 });
 await test('referral landing preserves the exact code for the existing software and VPS chooser',async()=>{
  const before=dataSnapshot(h.dataDir),referral='FIXTURE&second=value#fragment+space ';
  for(const extra of ['', '&plan=', '&plan=%20', '&hosting=true&payment=crypto']){
   const response=await get('?ref='+encodeURIComponent(referral)+extra);assert.equal(response.status,302);
   const location=new URL(response.headers.get('location'));assert.equal(location.origin,'https://site.example.test');assert.equal(location.pathname,'/unleashed/');assert.equal(location.hash,'#pricing');assert.deepEqual([...location.searchParams],[['ref',referral]]);
  }
  assert.deepEqual(dataSnapshot(h.dataDir),before);assert.equal(outboundCalls,0);
 });
 await test('empty referrals do not add an empty attribution or accept a caller redirect',async()=>{
  const response=await get('?ref=&returnTo=https%3A%2F%2Fother.example.test');assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://site.example.test/unleashed/#pricing');
 });
 await test('explicit legacy software choices keep their configured checkout and unknown choices refuse',async()=>{
  for(const plan of ['monthly','yearly','lifetime']){const response=await get('?plan='+plan);assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://buy.stripe.com/test_'+plan);}
  assert.equal((await get('?plan=unknown&ref=FIXTURE_REF')).status,404);assert.equal(outboundCalls,0);
 });
 await test('explicit referral and hosted choices retain admission rather than returning the chooser',async()=>{
  for(const query of ['?plan=monthly&ref=FIXTURE_REF','?plan=yearly&ref=FIXTURE_REF','?plan=lifetime&ref=FIXTURE_REF','?plan=monthly-hosted','?plan=hosted-yearly','?plan=lifetime&hosting=true']){
   const response=await get(query);assert.equal(response.status,400);assert.equal(response.headers.get('location'),null);
  }
  assert.equal(outboundCalls,0,'unconfigured/invalid explicit requests refuse before Stripe');
 });
 await test('corrupt stored chooser origins refuse rather than redirecting externally',async()=>{
  const configFile=path.join(h.dataDir,'billing-config.v1.json'), original=fs.readFileSync(configFile,'utf8');
  try{
   for(const siteOrigin of ['http://site.example.test','https://user@site.example.test','https://site.example.test/?returnTo=other','not-a-url']){
    fs.writeFileSync(configFile,JSON.stringify({...JSON.parse(original),siteOrigin}));const response=await get('?ref=FIXTURE_REF');assert.equal(response.status,503);assert.equal(response.headers.get('location'),null);
   }
   assert.equal(outboundCalls,0);
  }finally{fs.writeFileSync(configFile,original);}
 });
}finally{await h.close();}
summary('referral-plan-landing');
