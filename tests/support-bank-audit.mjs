// Explicit offline coverage audit: node tests/support-bank-audit.mjs [public-catalog.json]
// Runs every reviewed question through the actual SupportChat prompt builder with a
// local provider stub. It sends no provider request and writes only temp files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {SupportChat} from '../dist/src/support-chat.js';
import {selectSupportAnswers} from '../dist/src/support-context.js';
import {tmpDir} from './helpers.mjs';

const guideFile=fileURLToPath(new URL('../public/support-knowledge.json',import.meta.url));
const bankFile=fileURLToPath(new URL('../public/support-question-bank.json',import.meta.url));
const guide=JSON.parse(fs.readFileSync(guideFile,'utf8'));
const bank=JSON.parse(fs.readFileSync(bankFile,'utf8'));
const rows=bank.questions;
assert.equal(rows.length,1000,'the reviewed bank should contain 1000 questions');
const catalog=process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2],'utf8')) : {mode:'test',plans:[]};
const results={total:rows.length,providerCalls:0,promptBoundFailures:[],actualSourceMatches:0,exactVersionMatches:0,missingActual:[],missingExact:[],version135:0,version155:0,website:0};
let prompt='';
const provider=async (_url,init)=>{
  const payload=JSON.parse(init.body);results.providerCalls++;
  prompt=payload.instructions;
  const bytes=Buffer.byteLength(payload.instructions+JSON.stringify(payload.input));
  if(bytes>24000)results.promptBoundFailures.push({question:payload.input.at(-1).content,bytes});
  return new Response(JSON.stringify({status:'completed',usage:{input_tokens:100,output_tokens:20},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({answer:'Offline provider stub.',human:false})}]}]}));
};
let chat;
for(let i=0;i<rows.length;i++){
  if(i%100===0)chat=new SupportChat(tmpDir('support-bank-audit'),{enabled:true,aiEnabled:true,apiKey:'offline-stub',totalMonthlyMicros:50_000_000,knowledgeFile:guideFile,publicCatalog:()=>catalog},provider);
  const row=rows[i];
  const version=row.audience==='website'?'website':i%2?'0.90.135':'0.90.155';
  if(version==='website')results.website++;else if(version==='0.90.135')results.version135++;else results.version155++;
  const before=results.providerCalls;
  const response=await chat.message({owner:'audit-'+i,name:'Audit',licenseId:'audit-'+i},{text:row.question,requestId:'audit-'+String(i).padStart(6,'0'),version});
  if(results.providerCalls===before){results.missingActual.push({id:row.id,reason:'provider not invoked',status:response.threads[0]?.status});continue;}
  const sourceMatch=row.sourceIds.some(id=>prompt.includes('['+id+']')||prompt.includes('"'+id+'"'));
  if(sourceMatch)results.actualSourceMatches++;else results.missingActual.push({id:row.id,question:row.question,version,sourceIds:row.sourceIds});
  const exactVersion=row.audience==='website'?'website':guide.version;
  const answer=selectSupportAnswers(guideFile,exactVersion,row.question);
  if(row.sourceIds.some(id=>answer.includes('"'+id+'"')))results.exactVersionMatches++;else results.missingExact.push({id:row.id,question:row.question,sourceIds:row.sourceIds});
}
const reportFile='/tmp/wh-support-bank-audit-20261001.json';
fs.writeFileSync(reportFile,JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({total:results.total,providerCalls:results.providerCalls,promptBoundFailures:results.promptBoundFailures.length,actualSourceMatches:results.actualSourceMatches,exactVersionMatches:results.exactVersionMatches,version135:results.version135,version155:results.version155,website:results.website,missingActualSample:results.missingActual.slice(0,12),missingExactSample:results.missingExact.slice(0,12),reportFile},null,2));
assert.equal(results.providerCalls,rows.length,'all questions should reach the offline provider within budget and prompt bounds');
assert.deepEqual(results.promptBoundFailures,[],'no complete prompt may exceed 24k bytes');
