import assert from 'node:assert/strict';
import fs from 'node:fs';
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
assert.equal(restarted.customer(guest(1)).threads[0].status,'human','an orphaned provider reply enters the human queue after restart');
assert.equal(restarted.customer(guest(1)).threads[0].waitingForHuman,true);
assert.equal(restarted.customer(guest(1)).threads[0].replyInProgress,false);
assert.equal(restarted.admin().items.find(t=>t.id===restarted.customer(guest(1)).threads[0].id)?.waitingForHuman,true);

pending.splice(0).forEach(resolve=>resolve(answer()));
await Promise.all([first,member]);
assert.equal(chat.admin().budget.usedMicros,40,'two completed GPT-6 Luna replies each cost 100×0.1 + 20×0.5 = 20 micros');
assert.equal(chat.admin().budget.guests.usedMicros,20);
chat.action({action:'budget',monthlyLimitUsd:50,guestMonthlyLimitUsd:5});
assert.equal(chat.admin().budget.guests.limitMicros,5_000_000);
assert.equal(chat.admin().budget.guests.usedMicros,20,'editing limits does not reset usage');
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

// Guest conversations remain automatic after the old five-reply cutoff.
let clarifiedCalls=0;
const clarification=new SupportChat(tmpDir('support-guest-clarification'),{...cfg,totalMonthlyMicros:50_000_000,guestMonthlyMicros:5_000_000},async()=>{clarifiedCalls++;return answer();});
let clarificationId;
for(let i=0;i<5;i++)clarificationId=(await clarification.message(guest('clarify'),{id:clarificationId,text:'How do I install?',requestId:'guest-clarify-'+i,version:'website'})).threads[0].id;
const sixth=await clarification.message(guest('clarify'),{id:clarificationId,text:'Vultr and im on a mac',requestId:'guest-clarify-5'});
assert.equal(clarifiedCalls,6);
assert.equal(sixth.threads[0].status,'assistant');
assert.equal(sixth.threads[0].canAutoReply,true);
assert.equal(sixth.allowance.dailyRemaining,94);

// Count caps are independent from the monetary reservations and apply to both
// guest and licensed customers. A prior quota handoff can resume after reset.
const countDir=tmpDir('support-count-limits'),month='2026-10',today='2026-10-15';
const usage=[
 ...Array.from({length:1000},(_,i)=>({id:'guest-month-'+i,owner:'guest:month',month,day:'2026-10-01',micros:20,pending:false})),
 ...Array.from({length:1000},(_,i)=>({id:'member-month-'+i,owner:'paid:month',month,day:'2026-10-01',micros:20,pending:false})),
 ...Array.from({length:100},(_,i)=>({id:'guest-day-'+i,owner:'guest:day',month,day:today,micros:20,pending:false})),
 ...Array.from({length:100},(_,i)=>({id:'member-day-'+i,owner:'paid:day',month,day:today,micros:20,pending:false})),
];
fs.writeFileSync(countDir+'/support-chat.v1.json',JSON.stringify({schema:1,threads:[],usage,knowledge:[]}));
let currentMs=Date.UTC(2026,9,15,12),resumedCalls=0;
const limits=new SupportChat(countDir,{...cfg,totalMonthlyMicros:50_000_000,guestMonthlyMicros:5_000_000},async()=>{resumedCalls++;return answer();},()=>currentMs);
assert.equal(limits.allowance('guest:month').monthlyRemaining,0);
assert.equal(limits.allowance('paid:month').monthlyRemaining,0);
assert.equal(limits.allowance('guest:day').dailyRemaining,0);
assert.equal(limits.allowance('paid:day').dailyRemaining,0);
assert.equal(limits.allowance('guest:day').monthlyRemaining,900);
const dailyGuest=await limits.message(guest('day'),{text:'How do I install?',requestId:'guest-daily-blocked',version:'website'});
const dailyMember=await limits.message(paid('day'),{text:'How do I install?',requestId:'member-daily-blocked',version:'0.90.156'});
assert.equal(dailyGuest.threads[0].autoReplyUnavailableReason,'guest_daily_limit');
assert.equal(dailyMember.threads[0].autoReplyUnavailableReason,'member_daily_limit');
assert.equal(resumedCalls,0);
const quota=await limits.message(guest('month'),{text:'How do I install?',requestId:'guest-quota-first',version:'website'});
const quotaId=quota.threads[0].id;
assert.equal(quota.threads[0].status,'human');
assert.equal(quota.threads[0].handoffReason,'quota');
assert.equal(quota.threads[0].autoReplyUnavailableReason,'guest_monthly_limit');
assert.match(quota.threads[0].autoReplyNotice,/guest monthly chat limit/);
assert.equal(resumedCalls,0);
currentMs=Date.UTC(2026,10,1,12);
const ready=limits.customer(guest('month'),quotaId).threads[0];
assert.equal(ready.status,'human');
assert.equal(ready.canAutoReply,true);
assert.equal(ready.replyInProgress,false);
assert.match(ready.autoReplyNotice,/You can keep asking questions/);
const resumed=await limits.message(guest('month'),{id:quotaId,text:'Vultr and im on a mac',requestId:'guest-quota-second'});
assert.equal(resumedCalls,1);
assert.equal(resumed.threads[0].status,'assistant');
assert.equal(resumed.threads[0].waitingForHuman,true);
limits.action({id:quotaId,action:'takeover'});
await limits.message(guest('month'),{id:quotaId,text:'One more question',requestId:'guest-staff-third'});
assert.equal(resumedCalls,1,'staff takeover must remain paused');
assert.equal(limits.customer(guest('month'),quotaId).threads[0].autoReplyUnavailableReason,'staff_takeover');

const requested=new SupportChat(tmpDir('support-requested-budget'),{...cfg,totalMonthlyMicros:0},async()=>{throw Error('must not call provider');});
let human=await requested.message(guest('requested'),{text:'Please get a person',requestId:'guest-requested-1',human:true});
human=await requested.message(guest('requested'),{id:human.threads[0].id,text:'Still need a person',requestId:'guest-requested-2'});
assert.equal(human.threads[0].handoffReason,'requested','a budget blocker must not overwrite an explicit human request');
assert.equal(human.threads[0].autoReplyUnavailableReason,'human_requested');

let failCalls=0;
const recovering=new SupportChat(tmpDir('support-provider-retry'),{...cfg,totalMonthlyMicros:50_000_000,guestMonthlyMicros:5_000_000},async()=>{failCalls++;if(failCalls===1)throw Error('provider down');return answer();});
const failed=await recovering.message(guest('error'),{text:'How do I install?',requestId:'provider-error-1',version:'website'});
assert.equal(failed.threads[0].handoffReason,'error');
assert.equal(failed.threads[0].autoReplyUnavailableReason,'provider_error');
assert.equal(failed.threads[0].canAutoReply,true);
assert.equal(failed.threads[0].replyInProgress,false);
const retried=await recovering.message(guest('error'),{id:failed.threads[0].id,text:'Can you help me?',requestId:'provider-error-2'});
assert.equal(failCalls,2);
assert.equal(retried.threads[0].status,'assistant');
assert.equal(retried.threads[0].waitingForHuman,true);

let configuredCalls=0;
const configDir=tmpDir('support-config-retry');
const mutableConfig={...cfg,aiEnabled:false,totalMonthlyMicros:50_000_000,guestMonthlyMicros:5_000_000};
const configured=new SupportChat(configDir,mutableConfig,async()=>{configuredCalls++;return answer();});
const off=await configured.message(guest('config'),{text:'Can you help?',requestId:'config-off'});
assert.equal(off.threads[0].handoffReason,'config');
assert.equal(off.threads[0].autoReplyUnavailableReason,'ai_disabled');
mutableConfig.aiEnabled=true;
assert.equal(configured.customer(guest('config'),off.threads[0].id).threads[0].canAutoReply,true);
const on=await configured.message(guest('config'),{id:off.threads[0].id,text:'How do I install?',requestId:'config-on'});
assert.equal(configuredCalls,1);
assert.equal(on.threads[0].status,'assistant');

// Old quota/error records may actually be explicit requests, because an old
// handoff overwrote the reason after storing a needs_help feedback action.
const legacyDir=tmpDir('support-legacy-requested');
const legacyId='legacy-requested-1';
const legacyThread={id:legacyId,owner:'guest:legacy',name:'Visitor',licenseId:'website',version:'website',ts:1,updatedAt:1,status:'human',waitingForHuman:true,handoffReason:'quota',messages:[{id:'old-question',role:'customer',text:'Help',at:1},{id:'old-reply',role:'assistant',text:'Ask our team',at:2,feedback:'needs_help'}]};
fs.writeFileSync(legacyDir+'/support-chat.v1.json',JSON.stringify({schema:1,threads:[legacyThread],usage:[],knowledge:[]}));
const legacy=new SupportChat(legacyDir,{...cfg,totalMonthlyMicros:50_000_000,guestMonthlyMicros:5_000_000},async()=>{throw Error('explicit handoff must not call provider');});
assert.equal(legacy.customer(guest('legacy'),legacyId).threads[0].autoReplyUnavailableReason,'human_requested');
const stillRequested=await legacy.message(guest('legacy'),{id:legacyId,text:'Can you help?',requestId:'legacy-followup'});
assert.equal(stillRequested.threads[0].handoffReason,'requested');
assert.equal(stillRequested.threads[0].canAutoReply,false);
legacy.action({id:legacyId,action:'takeover'});
assert.equal(legacy.customer(guest('legacy'),legacyId).threads[0].autoReplyUnavailableReason,'staff_takeover','staff takeover remains authoritative even when needs_help feedback exists');

const disabled=new SupportChat(tmpDir('support-chat-disabled'),{...cfg,enabled:false});
assert.equal(disabled.customer(guest('disabled')).autoReplyUnavailableReason,'chat_disabled');
assert.match(disabled.customer(guest('disabled')).autoReplyNotice,/Support chat is unavailable/);
await assert.rejects(disabled.message(guest('disabled'),msg('disabled')),e=>e.status===503);

const orphanDir=tmpDir('support-restart-orphan');
let finishOrphan;
const orphanProvider=()=>new Promise(resolve=>{finishOrphan=resolve;});
const orphanConfig={...cfg,totalMonthlyMicros:50_000_000,guestMonthlyMicros:5_000_000};
const beforeRestart=new SupportChat(orphanDir,orphanConfig,orphanProvider);
const unfinished=beforeRestart.message(guest('orphan'),{text:'Please explain installation',requestId:'orphan-request',version:'website'});
const orphanId=beforeRestart.customer(guest('orphan')).threads[0].id;
assert.equal(beforeRestart.customer(guest('orphan'),orphanId).threads[0].replyInProgress,true);
const afterRestart=new SupportChat(orphanDir,orphanConfig,orphanProvider);
const recovered=afterRestart.customer(guest('orphan'),orphanId).threads[0];
assert.equal(recovered.status,'human');
assert.equal(recovered.waitingForHuman,true);
assert.equal(recovered.replyInProgress,false);
assert.equal(recovered.autoReplyUnavailableReason,'provider_error');
assert.match(recovered.autoReplyNotice,/earlier question/);
assert.equal(afterRestart.admin().items.find(t=>t.id===orphanId)?.waitingForHuman,true);
assert.equal(afterRestart.admin().budget.reservedMicros,8000,'restart retains the full uncertain-cost reservation');
finishOrphan(answer());
await unfinished;

const oldPendingDir=tmpDir('support-old-pending');
fs.writeFileSync(oldPendingDir+'/support-chat.v1.json',JSON.stringify({schema:1,threads:[{id:'old-pending',owner:'guest:old-pending',name:'Visitor',licenseId:'website',version:'website',ts:1,updatedAt:1,status:'assistant',messages:[{id:'old-pending-message',role:'customer',text:'Install help',at:1}]}],usage:[{id:'old-reservation',owner:'guest:old-pending',month:'2026-10',day:'2026-10-01',micros:8000,pending:true}],knowledge:[]}));
const recoveredLegacy=new SupportChat(oldPendingDir,orphanConfig,fetch,()=>Date.UTC(2026,9,1,12));
assert.equal(recoveredLegacy.customer(guest('old-pending'),'old-pending').threads[0].waitingForHuman,true,'legacy reservations without thread IDs recover by owner');
assert.equal(recoveredLegacy.admin().budget.reservedMicros,8000);

const noOrphanDir=tmpDir('support-no-orphan');
const noOrphanFile=noOrphanDir+'/support-chat.v1.json';
const noOrphanText=JSON.stringify({schema:1,threads:[],usage:[{id:'old-cost',owner:'guest:nobody',month:'2026-10',day:'2026-10-01',micros:8000,pending:true}],knowledge:[]},null,2);
fs.writeFileSync(noOrphanFile,noOrphanText);
new SupportChat(noOrphanDir,orphanConfig);
assert.equal(fs.readFileSync(noOrphanFile,'utf8'),noOrphanText,'pending costs without an orphan do not rewrite storage on every boot');

const failedRecoveryDir=tmpDir('support-recovery-write-failure');
const failedRecoveryFile=failedRecoveryDir+'/support-chat.v1.json';
const largeState={schema:1,threads:[{id:'large-orphan',owner:'guest:large',name:'Visitor',licenseId:'website',version:'website',ts:1,updatedAt:1,status:'assistant',messages:[{id:'large-message',role:'customer',text:'',at:1}]}],usage:[{id:'large-reservation',owner:'guest:large',month:'2026-10',day:'2026-10-01',micros:8000,pending:true,threadId:'large-orphan'}],knowledge:[]};
const maxBytes=16*1024*1024;
largeState.threads[0].messages[0].text='x'.repeat(maxBytes-16-Buffer.byteLength(JSON.stringify(largeState)));
const largeText=JSON.stringify(largeState);
assert.ok(Buffer.byteLength(largeText)<maxBytes);
fs.writeFileSync(failedRecoveryFile,largeText);
const failedRecovery=new SupportChat(failedRecoveryDir,orphanConfig);
assert.match(failedRecovery.unavailable,/recovery could not be saved/);
assert.equal(failedRecovery.customer(guest('large')).autoReplyUnavailableReason,'support_unavailable');
assert.equal(fs.statSync(failedRecoveryFile).size,Buffer.byteLength(largeText),'failed recovery preserves the original file');
assert.throws(()=>failedRecovery.action({action:'budget',monthlyLimitUsd:1}),e=>e.status===503);
console.log('support guest budget: pending, restart, distinct visitors, paid allowance, total cap, human fallback and edits passed');
