import assert from 'node:assert/strict';
import { BrevoMarketing } from '../dist/src/marketing-brevo.js';

let apiKey=null;
let consentRecords=[];
let webhookSecret='w'.repeat(48);
let requests=[];
let responses=[];
const service=new BrevoMarketing({
 readApiKey:()=>apiKey,
 writeApiKey:value=>{apiKey=value;},
 allowedListIds:new Set([17,29]),
 recordConsent:record=>{consentRecords.push(record);},
 webhookBearerSecret:()=>webhookSecret,
 now:()=>new Date('2026-09-30T12:00:00.000Z'),
 fetch:async(url,init)=>{requests.push({url,init});const next=responses.shift();if(!next)throw new Error('unexpected provider request');return next;},
});
const ok=(body={})=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
const noContent=()=>new Response(null,{status:204});
const notFound=()=>new Response('{}',{status:404});
const valid={email:' New.Customer@Example.com ',consent:{granted:true,source:'signup-form',noticeVersion:'marketing-v1',consentedAt:'2026-09-30T11:00:00Z'}};

assert.deepEqual(await service.status(),{configured:false,lastTestAt:null,lastTestOk:null,lastTestMessage:null});
assert.equal((await service.testConnection()).lastTestOk,false);
assert.equal(requests.length,0,'no provider call without an API key');
await assert.rejects(service.importContact(valid,17),/API key is not configured/);
assert.equal(requests.length,0);
await assert.rejects(service.setApiKey('short'),/valid Brevo API key/);
assert.equal(await service.setApiKey('  xkeysib-test-secret-value-123456  ').then(s=>s.configured),true);
assert.equal(JSON.stringify(await service.status()).includes('xkeysib'),false,'status is write-only');
responses.push(ok({companyName:'private account detail'}));
const connected=await service.testConnection();
assert.equal(connected.lastTestOk,true);assert.equal(connected.lastTestMessage,'Brevo connection verified.');
assert.equal(requests.at(-1).url,'https://api.brevo.com/v3/account');
assert.equal(requests.at(-1).init.headers['api-key'],apiKey);
assert.equal(JSON.stringify(connected).includes(apiKey),false);

const beforeInvalid=requests.length;
await assert.rejects(service.importContact({...valid,consent:{...valid.consent,granted:false}},17),/Explicit marketing consent/);
await assert.rejects(service.importContact(valid,999),/list is not configured/);
assert.equal(requests.length,beforeInvalid,'invalid consent and unapproved list never call Brevo');

responses.push(notFound(),ok({id:701}));
assert.deepEqual(await service.importContact(valid,17),{status:'created',listId:17});
assert.equal(consentRecords.length,1);
assert.deepEqual(consentRecords[0],{email:'new.customer@example.com',listId:17,granted:true,source:'signup-form',noticeVersion:'marketing-v1',consentedAt:'2026-09-30T11:00:00.000Z'});
const created=JSON.parse(requests.at(-1).init.body);
assert.deepEqual(created,{email:'new.customer@example.com',listIds:[17],emailBlacklisted:false});

responses.push(ok({emailBlacklisted:true,listIds:[]}));
assert.deepEqual(await service.importContact({email:'blocked@example.com',consent:valid.consent},17),{status:'suppressed',listId:17});
assert.equal(requests.at(-1).init.method,'GET','a globally suppressed contact is not updated or subscribed');
const recordsBefore=consentRecords.length;
responses.push(ok({emailBlacklisted:false,listIds:[17]}));
assert.deepEqual(await service.importContact({email:'already@example.com',consent:valid.consent},17),{status:'already_in_list',listId:17});
assert.equal(consentRecords.length,recordsBefore,'reimporting an existing list member is deduplicated');

responses.push(ok({emailBlacklisted:false,listIds:[29]}),noContent());
assert.deepEqual(await service.importContact({email:'append@example.com',consent:valid.consent},17),{status:'added_to_list',listId:17});
const update=JSON.parse(requests.at(-1).init.body);
assert.deepEqual(update,{listIds:[17]});
assert.equal(Object.hasOwn(update,'email'),false);
assert.equal(Object.hasOwn(update,'emailBlacklisted'),false,'existing blacklist state is never cleared during import');

responses.push(notFound(),ok({id:702}));
const batch=await service.importContacts([
 {email:'dup@example.com',consent:valid.consent},
 {email:' DUP@example.com ',consent:valid.consent},
],29);
assert.deepEqual(batch.map(r=>r.status),['created','duplicate_in_batch']);
assert.equal(requests.slice(-2).length,2,'case/whitespace duplicate is looked up and imported once');

const beforeUnauthorized=requests.length;
await assert.rejects(service.handleOptOutWebhook('Bearer wrong', {event:'unsubscribed',email:'x@example.com'}),/Unauthorized/);
assert.equal(requests.length,beforeUnauthorized);
responses.push(noContent());
assert.equal(await service.handleOptOutWebhook(`Bearer ${webhookSecret}`,{event:'unsubscribed',email:'New.Customer@example.com'}),'suppressed');
assert.deepEqual(JSON.parse(requests.at(-1).init.body),{emailBlacklisted:true});
responses.push(noContent());
assert.equal(await service.handleOptOutWebhook(`Bearer ${webhookSecret}`,{event:'spam',email:'new.customer@example.com'}),'suppressed');
assert.equal(JSON.parse(requests.at(-1).init.body).emailBlacklisted,true);
assert.equal(await service.handleOptOutWebhook(`Bearer ${webhookSecret}`,{event:'delivered',email:'new.customer@example.com'}),'ignored');
assert.equal(requests.length,beforeUnauthorized+2,'irrelevant authenticated webhook is ignored');

responses.push(notFound(),ok({id:703}),ok({emailBlacklisted:false,listIds:[17]}));
const concurrent=[
 service.importContact({email:'race@example.com',consent:valid.consent},17),
 service.importContact({email:' RACE@example.com ',consent:valid.consent},17),
];
assert.deepEqual((await Promise.all(concurrent)).map(r=>r.status),['created','already_in_list']);
assert.deepEqual(requests.slice(-3).map(r=>r.init.method),['GET','POST','GET'],'concurrent imports serialize and do not create duplicate contacts');

await service.clearApiKey();
assert.equal((await service.status()).configured,false);
assert.equal(JSON.stringify(await service.status()).includes('xkeysib'),false);
console.log('Brevo marketing integration: write-only key status, connection test, consent-gated deduplicated imports, blacklist preservation, and authenticated opt-out passed');
