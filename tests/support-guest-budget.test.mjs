import assert from 'node:assert/strict';
import { SupportChat } from '../dist/src/support-chat.js';
import { tmpDir } from './helpers.mjs';

const cfg={enabled:true,aiEnabled:true,apiKey:'fixture-only',totalMonthlyMicros:20_000,guestMonthlyMicros:10_000};
const dir=tmpDir('support-guest-budget');
const pending=[];
let calls=0;
const provider=()=>{calls++;return new Promise(resolve=>pending.push(resolve));};
const chat=new SupportChat(dir,cfg,provider);
const guest=n=>({owner:'guest:'+n,licenseId:'website',name:'Visitor'});
const paid=n=>({owner:'paid:'+n,licenseId:'lic-'+n,name:'Member'});
const msg=n=>({text:'Help with setup',requestId:'request-'+n});
const answer=()=>new Response(JSON.stringify({status:'completed',usage:{input_tokens:100,output_tokens:20},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer:'Open the guide.',human:false})}]}]}));

const first=chat.message(guest(1),msg('guest-1'));
assert.equal(calls,1);
assert.equal(chat.admin().budget.guests.usedMicros,8000);
assert.equal(chat.allowance(guest(1).owner).guestRemainingMicros,2000);
const second=await chat.message(guest(2),msg('guest-2'));
assert.equal(calls,1,'a different visitor cannot bypass the shared guest reservation');
assert.equal(second.threads[0].status,'human');
assert.equal(second.threads[0].waitingForHuman,true);
assert.equal(second.threads[0].messages[0].text,'Help with setup','human fallback retains the message');

const member=chat.message(paid(1),msg('paid-1'));
assert.equal(calls,2,'licensed members can use the remaining total budget');
assert.equal(chat.admin().budget.usedMicros,16000);
const totalCapped=await chat.message(paid(2),msg('paid-2'));
assert.equal(calls,2,'the guest cap never creates extra total allowance');
assert.equal(totalCapped.threads[0].status,'human');
const restarted=new SupportChat(dir,cfg,provider);
assert.equal(restarted.admin().budget.guests.usedMicros,8000,'restart retains uncertain guest spend');
assert.equal(restarted.allowance(guest(3).owner).guestRemainingMicros,2000);

pending.splice(0).forEach(resolve=>resolve(answer()));
await Promise.all([first,member]);
assert.equal(chat.admin().budget.usedMicros,88);
assert.equal(chat.admin().budget.guests.usedMicros,44);
chat.action({action:'budget',monthlyLimitUsd:50,guestMonthlyLimitUsd:5});
assert.equal(chat.admin().budget.guests.limitMicros,5_000_000);
assert.equal(chat.admin().budget.guests.usedMicros,44,'editing limits does not reset usage');
assert.equal(new SupportChat(dir,cfg).admin().budget.guests.configuredLimitMicros,5_000_000);
chat.action({action:'budget',monthlyLimitUsd:1});
assert.equal(chat.admin().budget.guests.configuredLimitMicros,5_000_000,'older clients preserve guest configuration');
assert.equal(chat.admin().budget.guests.limitMicros,1_000_000,'effective guest budget is capped by total');
chat.action({action:'budget',monthlyLimitUsd:0});
assert.equal(chat.admin().budget.guests.limitMicros,0);
assert.equal(chat.allowance(guest(3).owner).guestRemainingMicros,0);
for(const value of [-1,NaN,Infinity,'5',0.001,10001])assert.throws(()=>chat.action({action:'budget',monthlyLimitUsd:50,guestMonthlyLimitUsd:value}),e=>e.status===400);
assert.equal(chat.admin().budget.limitMicros,0,'invalid combined edit is atomic');

const defaults=new SupportChat(tmpDir('support-guest-default'),{...cfg,totalMonthlyMicros:50_000_000,guestMonthlyMicros:undefined});
assert.equal(defaults.admin().budget.guests.limitMicros,5_000_000);
console.log('support guest budget: pending, restart, distinct visitors, paid allowance, total cap, human fallback and edits passed');
