import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selectSupportAnswers, selectSupportGuide, supportPricingFacts } from '../dist/src/support-context.js';
import { SupportChat } from '../dist/src/support-chat.js';
import { tmpDir } from './helpers.mjs';

const guide=fileURLToPath(new URL('../public/support-knowledge.json',import.meta.url));
const install=selectSupportGuide(guide,'website','How do I install Wick Hunter?');
assert.match(install,/Installation and hosting/);
assert.doesNotMatch(install,/hedge ladder/i);
const definition=selectSupportGuide(guide,'0.91.000','What is a DCA bot?');
assert.match(definition,/DCA is an averaging ladder/);
assert.doesNotMatch(definition,/\[gd-liq-dca\]/);
const followup=selectSupportGuide(guide,'website','And how do I install it?','How much is a plan?');
assert.match(followup,/Installation and hosting/);
const stale=selectSupportGuide(guide,'0.91.000','How does the Optimized Liquidation Bot set its leverage?');
assert.doesNotMatch(stale,/\[gd-liq-leverage\]/);
const live={mode:'live',plans:[{key:'monthly',name:'Monthly',amountCents:9900,currency:'usd',interval:'month',available:true,buyUrl:'https://hub.test/buy?plan=monthly'}],launch:{active:true,code:'UNLEASHED25',discountPercent:25,redeemUntilMs:Date.now()+1e7}};
const facts=supportPricingFacts(live,'How much is a plan?');
assert.match(facts,/9900/);assert.match(facts,/UNLEASHED25/);assert.doesNotMatch(facts,/secretKey/);
assert.match(supportPricingFacts({...live,mode:'test'},'How much is a plan?'),/could not be verified/);
assert.equal(supportPricingFacts(live,'What is DCA?'),'');
const prompts=[];
const provider=async (_url,init)=>{
  const input=JSON.parse(init.body);prompts.push(input.instructions);
  return new Response(JSON.stringify({status:'completed',usage:{input_tokens:150,output_tokens:40},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer:'Current public facts are available.',human:false})}]}]}));
};
const chat=new SupportChat(tmpDir('support-context'),{enabled:true,aiEnabled:true,apiKey:'fake',totalMonthlyMicros:50_000_000,knowledgeFile:guide,publicCatalog:()=>live},provider);
const customer={owner:'guest:context',name:'Guest',licenseId:''};
let r=await chat.message(customer,{text:'How much is a plan?',requestId:'price-question-001',version:'website'});
assert.equal(r.threads[0].status,'assistant');
assert.match(prompts[0],/Current public billing facts:.*9900/);
assert.match(prompts[0],/Give direct steps for installation or purchase/);
r=await chat.message(customer,{id:r.threads[0].id,text:'And how do I install it?',requestId:'install-question-001'});
assert.equal(r.threads[0].status,'assistant');
assert.match(prompts[1],/Installation and hosting/);
assert.ok(Buffer.byteLength(prompts[1])<24000);
console.log('Support context: pricing, install, DCA, follow-up and stale version guard passed');

const bankDir=tmpDir('support-bank');
const bankGuide=bankDir+'/support-knowledge.json';
fs.writeFileSync(bankGuide,JSON.stringify({version:'1.0',sections:[{id:'approved-install',title:'Installation',text:'Use your own server.'},{id:'approved-billing',title:'Billing',text:'See live catalog.',audience:'website'}]}));
fs.writeFileSync(bankDir+'/support-question-bank.json',JSON.stringify({version:'1.0',questions:[
  {id:'install',topic:'installation',question:'How do I install the app?',answer:'Open your installation page.',sourceIds:['approved-install'],audience:'both',versionIndependent:true,resolutionType:'direct'},
  {id:'stale',topic:'leverage',question:'How is leverage set?',answer:'Old leverage answer.',sourceIds:['approved-install'],audience:'app',versionIndependent:false,resolutionType:'direct'},
  {id:'unsourced',topic:'installation',question:'How do I install?',answer:'Unverified instructions.',sourceIds:['missing'],audience:'both',versionIndependent:true,resolutionType:'direct'},
  {id:'refund',topic:'refund',question:'Can I get a refund?',answer:'Unverified refund policy.',sourceIds:['approved-billing'],audience:'website',versionIndependent:true,dynamicFacts:['refund_policy_current'],resolutionType:'dynamic'}
]}));
assert.match(selectSupportAnswers(bankGuide,'2.0','How do I install?'),/Open your installation page/);
assert.doesNotMatch(selectSupportAnswers(bankGuide,'2.0','How do I install?'),/Unverified instructions/);
assert.equal(selectSupportAnswers(bankGuide,'2.0','How is leverage set?'),'');
assert.equal(selectSupportAnswers(bankGuide,'website','Can I get a refund?'),'');
const recoveryPrompts=[];
const recoveryProvider=async (_url,init)=>{
  const input=JSON.parse(init.body);recoveryPrompts.push(input.input.at(-1).content);
  const escalate=recoveryPrompts.length===1;
  return new Response(JSON.stringify({status:'completed',usage:{input_tokens:100,output_tokens:40},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer:escalate?'I need a team member for that account.':'Use the installation guide.',human:escalate})}]}]}));
};
const recovery=new SupportChat(tmpDir('support-recovery'),{enabled:true,aiEnabled:true,apiKey:'fake',totalMonthlyMicros:50_000_000,knowledgeFile:guide},recoveryProvider);
let recovered=await recovery.message(customer,{text:'Please inspect my payment',requestId:'escalate-first-001',version:'website'});
assert.equal(recovered.threads[0].status,'human');
assert.equal(recovered.threads[0].handoffReason,'ai');
assert.equal(recovered.threads[0].canAutoReply,true);
recovered=await recovery.message(customer,{id:recovered.threads[0].id,text:'How do I install?',requestId:'recovered-install-001'});
assert.equal(recoveryPrompts.length,2);
assert.equal(recovered.threads[0].status,'assistant');
assert.equal(recovered.threads[0].waitingForHuman,true);
assert.equal(recovered.threads[0].messages.find(m=>m.text==='How do I install?').clientRequestId,'recovered-install-001');
recovery.action({id:recovered.threads[0].id,action:'takeover'});
await recovery.message(customer,{id:recovered.threads[0].id,text:'Another question',requestId:'staff-owned-001'});
assert.equal(recoveryPrompts.length,2);
assert.equal(recovery.customer(customer).threads[0].canAutoReply,false);
assert.equal(recovery.admin().questionGaps.some(g=>g.count>0),true);
