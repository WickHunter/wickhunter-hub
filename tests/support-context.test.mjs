import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selectSupportAnswers, selectSupportGuide, supportHostingFacts, supportPricingFacts } from '../dist/src/support-context.js';
import { SupportChat } from '../dist/src/support-chat.js';
import { tmpDir } from './helpers.mjs';

const guide=fileURLToPath(new URL('../public/support-knowledge.json',import.meta.url));
const install=selectSupportGuide(guide,'website','How do I install Wick Hunter?');
assert.match(install,/Installation and hosting/);
assert.doesNotMatch(install,/hedge ladder/i);
const definition=selectSupportGuide(guide,'0.91.000','What is a DCA bot?');
assert.match(definition,/DCA is an averaging ladder/);
assert.doesNotMatch(definition,/\[gd-liq-dca\]/);
assert.match(selectSupportGuide(guide,'0.90.155','Which bots have DCA?'),/DCA is an averaging ladder/);
const followup=selectSupportGuide(guide,'website','And how do I install it?','How much is a plan?');
assert.match(followup,/Installation and hosting/);
const stale=selectSupportGuide(guide,'0.91.000','How does the Optimized Liquidation Bot set its leverage?');
assert.doesNotMatch(stale,/\[gd-liq-leverage\]/);
assert.doesNotMatch(selectSupportGuide(guide,'../../private','How does the Optimized Liquidation Bot set its leverage?'),/\[gd-liq-leverage\]/);
assert.match(selectSupportGuide(guide,'0.90.155','How does the Optimized Liquidation Bot set its leverage?'),/\[gd-liq-leverage\]/);
assert.match(selectSupportGuide(guide,'0.90.154','How does the Optimized Liquidation Bot set its leverage?'),/\[gd-liq-leverage\]/);
assert.match(selectSupportGuide(guide,'0.90.135','How does the Optimized Liquidation Bot set its leverage?'),/\[gd-liq-leverage\]/);
assert.match(selectSupportGuide(guide,'0.90.155','Can I enter 1,5 instead of 1.5?'),/\[gd-number-input\]/);
const hedgeFresh=selectSupportGuide(guide,'0.90.155','Does a new Hedge Bot start with blank fields?');
assert.match(hedgeFresh,/\[support-new-bot-forms\]/);
assert.match(hedgeFresh,/name and numeric fields start blank/);
assert.doesNotMatch(hedgeFresh,/brand-new install already sits on Moderate/);
assert.match(selectSupportGuide(guide,'0.90.155','What default numbers appear when I create a new bot?'),/\[support-new-bot-forms\]/);
assert.match(selectSupportAnswers(guide,'0.90.155','Why is a new bot form completely blank?'),/"sourceIds":\["support-new-bot-forms"\]/);
assert.match(selectSupportAnswers(guide,'0.90.155','Does a new Hedge Bot start with blank fields like the other bots?'),/new Hedge Bot starts with its numeric and name fields blank/);
assert.doesNotMatch(selectSupportAnswers(guide,'0.90.135','Does a new Hedge Bot start with blank fields like the other bots?'),/whq-8cb5901d64df/,'Alpha-only form behavior must not be asserted for Beta135');
assert.match(selectSupportAnswers(guide,'0.90.155','Does the safe-zone setting count as a hedge stop?'),/anti-churn pause/);
assert.match(selectSupportAnswers(guide,'0.90.155','Can I reinstall and expect old local history to reappear automatically?'),/"resolutionType":"direct"/);
for(const version of ['0.90.135','0.90.154','0.90.155']){
 const replay=selectSupportGuide(guide,version,'Can I use Deal Replay on a closed trade?');
 assert.match(replay,/\[support-feature-availability\]/);
 assert.doesNotMatch(replay,/\[gd-replay\]/);
 assert.match(replay,/unavailable in this released app build/);
}
const live={mode:'live',plans:[{key:'monthly',name:'Monthly',amountCents:9900,currency:'usd',interval:'month',available:true,buyUrl:'https://hub.test/buy?plan=monthly'},{key:'lifetime',name:'Lifetime',amountCents:99900,currency:'usd',interval:null,lifetime:true,licenseDays:3650,available:true}],launch:{active:true,code:'UNLEASHED25',discountPercent:25,firstPaymentAtMs:1792036800000,redeemUntilMs:Date.now()+1e7}};
const facts=supportPricingFacts(live,'How much is a plan?');
assert.match(facts,/9900/);assert.match(facts,/UNLEASHED25/);assert.doesNotMatch(facts,/secretKey/);
assert.doesNotMatch(facts,/licenseDays|3650/);
assert.match(supportPricingFacts(live,'When will my card first be charged?'),/firstPaymentEastern/);
assert.match(supportPricingFacts(live,'When does free access end?'),/firstPaymentEastern/);
assert.match(supportPricingFacts(live,'How much is it?'),/9900/);
assert.match(supportPricingFacts(live,'Does an offer code have to be typed manually?'),/UNLEASHED25/);
assert.equal(supportPricingFacts(live,'How do trading fees work?'),'');
assert.equal(supportPricingFacts(live,'How much DCA should I use?'),'');
assert.equal(supportPricingFacts(live,'Can I buy an exchange order?'),'');
assert.match(supportPricingFacts({...live,mode:'test'},'How much is a plan?'),/could not be verified/);
assert.equal(supportPricingFacts(live,'What is DCA?'),'');
const hosting={monthlyPriceLabel:'$20.00',priceIsProposed:false,regions:[{id:'nrt',label:'Tokyo'}],planLabel:'1 vCPU / 2 GB',maximumConnectedAccounts:5,managedBackupsIncluded:false,purchasable:true,bundleEnabled:true,bundles:[{key:'monthly-hosted',interval:'month',amountCents:11900,currency:'usd'}]};
assert.match(supportHostingFacts(hosting,'Can I buy managed hosting?'),/"purchasable":true/);
assert.match(supportHostingFacts(hosting,'How much is the hosted bundle?'),/11900/);
assert.match(supportHostingFacts(hosting,'Which hosting region can I choose?'),/Tokyo/);
assert.doesNotMatch(supportHostingFacts(hosting,'Which hosting region can I choose?'),/"nrt"/);
const prompts=[];
const provider=async (_url,init)=>{
  const input=JSON.parse(init.body);prompts.push(input.instructions);
  return new Response(JSON.stringify({status:'completed',usage:{input_tokens:150,output_tokens:40},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer:'Current public facts are available.',human:false})}]}]}));
};
const chat=new SupportChat(tmpDir('support-context'),{enabled:true,aiEnabled:true,apiKey:'fake',totalMonthlyMicros:50_000_000,knowledgeFile:guide,publicCatalog:()=>live,publicHostingOptions:()=>hosting},provider);
const customer={owner:'guest:context',name:'Guest',licenseId:''};
let r=await chat.message(customer,{text:'How much is a plan?',requestId:'price-question-001',version:'website'});
assert.equal(r.threads[0].status,'assistant');
assert.match(prompts[0],/Current public billing facts:.*9900/);
assert.match(prompts[0],/Give direct numbered steps for installation or purchase/);
r=await chat.message(customer,{id:r.threads[0].id,text:'And how do I install it?',requestId:'install-question-001'});
assert.equal(r.threads[0].status,'assistant');
assert.match(prompts[1],/Installation and hosting/);
assert.ok(Buffer.byteLength(prompts[1])<24000);
r=await chat.message(customer,{id:r.threads[0].id,text:'Is managed hosting available and how much?',requestId:'hosting-question-001'});
assert.equal(r.threads[0].status,'assistant');
assert.match(prompts[2],/"purchasable":true/);
assert.match(prompts[2],/11900/);
const switchResult=await chat.message({...customer,owner:'guest:switch-plan'},{text:'Can I switch from Monthly to Yearly today?',requestId:'billing-switch-001',version:'website'});
assert.equal(switchResult.threads[0].status,'human');
assert.match(switchResult.threads[0].messages.at(-1).text,/Open the billing portal to see the options/);
assert.doesNotMatch(switchResult.threads[0].messages.at(-1).text,/^Yes\b/);
const historyResult=await chat.message({...customer,owner:'guest:history'},{text:'Can I reinstall and expect old local history to reappear automatically?',requestId:'history-reinstall-001',version:'0.90.155'});
assert.equal(historyResult.threads[0].status,'assistant','optional recovery help alone must not force a handoff');
assert.match(prompts.at(-1),/optional staff help in an otherwise complete answer is not a handoff/);
console.log('Support context: pricing, install, DCA, follow-up and stale version guard passed');

const bankDir=tmpDir('support-bank');
const bankGuide=bankDir+'/support-knowledge.json';
fs.writeFileSync(bankGuide,JSON.stringify({version:'1.0.0',sections:[{id:'approved-install',title:'Installation',text:'Use your own server.',versionIndependent:true},{id:'approved-billing',title:'Billing',text:'See live catalog.',audience:'website'},{id:'old-control',title:'Leverage',text:'Old control details.'}]}));
fs.writeFileSync(bankDir+'/support-knowledge-2.0.0.json',JSON.stringify({version:'2.0.0',sections:[{id:'approved-install',title:'Installation',text:'Use your own server.'},{id:'old-control',title:'Leverage',text:'New control details.'}]}));
fs.writeFileSync(bankDir+'/support-question-bank.json',JSON.stringify({version:'1.0.0',questions:[
  {id:'install',topic:'installation',question:'How do I install the app?',answer:'Open your installation page.',sourceIds:['approved-install'],audience:'both',versionIndependent:true,resolutionType:'direct'},
  {id:'same-source',topic:'server',question:'Which server do I use?',answer:'Use your own server.',sourceIds:['approved-install'],audience:'app',versionIndependent:false,resolutionType:'direct'},
  {id:'server-similar',topic:'server',question:'Which server is best?',answer:'A different server answer.',sourceIds:['approved-install'],audience:'app',versionIndependent:false,resolutionType:'direct'},
  {id:'stale',topic:'leverage',question:'How is leverage set?',answer:'Old leverage answer.',sourceIds:['old-control'],audience:'app',versionIndependent:true,resolutionType:'direct'},
  {id:'unsourced',topic:'installation',question:'How do I install?',answer:'Unverified instructions.',sourceIds:['missing'],audience:'both',versionIndependent:true,resolutionType:'direct'},
  {id:'refund',topic:'refund',question:'Can I get a refund?',answer:'Please ask our team to review your case.',sourceIds:['approved-billing'],audience:'website',versionIndependent:true,dynamicFacts:['refund_policy_current'],resolutionType:'clarify_human'},
  {id:'account-dca',topic:'dca',question:'Why did the DCA order fail on my account?',answer:'Please ask our team to review your account.',sourceIds:['approved-install'],audience:'both',versionIndependent:true,resolutionType:'clarify_human'}
]}));
assert.match(selectSupportAnswers(bankGuide,'2.0.0','How do I install?'),/Open your installation page/);
assert.match(selectSupportAnswers(bankGuide,'2.0.0','Which server do I use?'),/Use your own server/);
assert.equal(JSON.parse(selectSupportAnswers(bankGuide,'2.0.0','Which server do I use?').split('\n')[0]).id,'same-source');
assert.doesNotMatch(selectSupportAnswers(bankGuide,'2.0.0','How do I install?'),/Unverified instructions/);
assert.equal(selectSupportAnswers(bankGuide,'2.0.0','How is leverage set?'),'');
assert.match(selectSupportAnswers(bankGuide,'website','Can I get a refund?'),/clarify_human/);
assert.equal(selectSupportAnswers(bankGuide,'website','What is DCA?'),'');
const bankPrompts=[];
const bankProvider=async (_url,init)=>{bankPrompts.push(JSON.parse(init.body).instructions);return new Response(JSON.stringify({status:'completed',usage:{input_tokens:100,output_tokens:20},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer:'DCA is a ladder.',human:false})}]}]}));};
const bankChat=new SupportChat(tmpDir('support-bank-chat'),{enabled:true,aiEnabled:true,apiKey:'fake',totalMonthlyMicros:50_000_000,knowledgeFile:bankGuide},bankProvider);
const generic=await bankChat.message(customer,{text:'What is DCA?',requestId:'bank-generic-dca-001',version:'website'});
assert.equal(generic.threads[0].status,'assistant');
assert.doesNotMatch(bankPrompts[0],/Why did the DCA order fail on my account/);
const policy=await bankChat.message({...customer,owner:'guest:refund'}, {text:'Can I get a refund?',requestId:'bank-refund-001',version:'website'});
assert.equal(policy.threads[0].status,'human');
assert.equal(policy.threads[0].messages.at(-1).text,'Please ask our team to review your case.');
const revisionDir=tmpDir('support-bank-revision');
fs.writeFileSync(revisionDir+'/support-knowledge.json',JSON.stringify({version:'1.0.0',sections:[{id:'same-id',title:'Control',text:'Old behavior.'},{id:'primary-only',title:'Missing in bank snapshot',text:'Old unreviewed answer.'}]}));
fs.writeFileSync(revisionDir+'/support-knowledge-2.0.0.json',JSON.stringify({version:'2.0.0',sections:[{id:'same-id',title:'Control',text:'New behavior.'}]}));
fs.writeFileSync(revisionDir+'/support-knowledge-3.0.0.json',JSON.stringify({version:'3.0.0',sections:[{id:'same-id',title:'Control',text:'Old behavior.'}]}));
fs.writeFileSync(revisionDir+'/support-question-bank.json',JSON.stringify({version:'2.0.0',questions:[
  {id:'revised',topic:'control',question:'How does the control work?',answer:'It now uses the new behavior.',sourceIds:['same-id'],audience:'app',versionIndependent:true,resolutionType:'direct'},
  {id:'primary-only',topic:'missing',question:'What is the primary-only answer?',answer:'The old answer.',sourceIds:['primary-only'],audience:'app',versionIndependent:false,resolutionType:'direct'}
]}));
assert.match(selectSupportAnswers(revisionDir+'/support-knowledge.json','2.0.0','How does the control work?'),/new behavior/);
assert.equal(selectSupportAnswers(revisionDir+'/support-knowledge.json','3.0.0','How does the control work?'),'','old primary guide matching sibling must not admit a bank answer reviewed against a changed source');
assert.equal(selectSupportAnswers(revisionDir+'/support-knowledge.json','2.0.0','What is the primary-only answer?'),'','an old primary source absent from the bank snapshot must not approve a new bank answer');
const recoveryPrompts=[];
const recoveryProvider=async (_url,init)=>{
  const input=JSON.parse(init.body);recoveryPrompts.push(input.input.at(-1).content);
  const escalate=recoveryPrompts.length===1;
  return new Response(JSON.stringify({status:'completed',usage:{input_tokens:100,output_tokens:40},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer:escalate?'I need a team member for that account.':'Use the installation guide.',human:escalate})}]}]}));
};
const recoveryDir=tmpDir('support-recovery');
const recoveryCfg={enabled:true,aiEnabled:true,apiKey:'fake',totalMonthlyMicros:50_000_000,knowledgeFile:guide};
const recovery=new SupportChat(recoveryDir,recoveryCfg,recoveryProvider);
let recovered=await recovery.message(customer,{text:'Please inspect my payment',requestId:'escalate-first-001',version:'website'});
assert.equal(recovered.threads[0].status,'human');
assert.equal(recovered.threads[0].handoffReason,'ai');
assert.equal(recovered.threads[0].canAutoReply,true);
assert.equal(new SupportChat(recoveryDir,recoveryCfg,recoveryProvider).customer(customer).threads[0].canAutoReply,true);
recovered=await recovery.message(customer,{id:recovered.threads[0].id,text:'How do I install?',requestId:'recovered-install-001'});
assert.equal(recoveryPrompts.length,2);
assert.equal(recovered.threads[0].status,'assistant');
assert.equal(recovered.threads[0].waitingForHuman,true);
assert.equal(recovered.threads[0].messages.find(m=>m.text==='How do I install?').clientRequestId,'recovered-install-001');
assert.equal(recovery.admin().questionGaps.reduce((n,g)=>n+g.count,0),2,'an AI answer to a follow-up must retain the earlier unresolved gap');
recovery.action({id:recovered.threads[0].id,action:'takeover'});
await recovery.message(customer,{id:recovered.threads[0].id,text:'Another question',requestId:'staff-owned-001'});
assert.equal(recoveryPrompts.length,2);
assert.equal(recovery.customer(customer).threads[0].canAutoReply,false);
assert.equal(recovery.admin().questionGaps.some(g=>g.count>0),true);
let releaseLate;
let raceCalls=0;
const raceProvider=async()=>{raceCalls++;if(raceCalls===2)return new Promise(resolve=>{releaseLate=()=>resolve(new Response(JSON.stringify({status:'completed',usage:{input_tokens:100,output_tokens:20},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer:'Late assistant reply',human:false})}]}]})));});return new Response(JSON.stringify({status:'completed',usage:{input_tokens:100,output_tokens:20},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer:'A person should review that.',human:true})}]}]}));};
const race=new SupportChat(tmpDir('support-recovery-race'),recoveryCfg,raceProvider);
const raceFirst=await race.message(customer,{text:'Inspect my account',requestId:'race-first-001',version:'website'});
const raceId=raceFirst.threads[0].id;
const pendingAnswer=race.message(customer,{id:raceId,text:'How do I install?',requestId:'race-second-001'});
race.action({id:raceId,action:'takeover'});releaseLate();await pendingAnswer;
assert.equal(race.customer(customer,raceId).threads[0].status,'human');
assert.equal(race.customer(customer,raceId).threads[0].messages.some(m=>m.text==='Late assistant reply'),false);
