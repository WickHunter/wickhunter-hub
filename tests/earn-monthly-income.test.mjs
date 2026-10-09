import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {referralMonthlyIncome} from '../dist/src/earn-monthly-income.js';
import {test,summary} from './helpers.mjs';
const now=Date.now(), owner='owner', id=(sub,o=owner)=>createHash('sha256').update(o+':'+sub).digest('hex').slice(0,40);
const fact=(subscriptionId,netMrrMinor=7920,extra={})=>({mode:'live',subscriptionId,status:'active',cancelAtPeriodEnd:false,firstPaymentAtMs:null,currency:'usd',netMrrMinor,linesKnown:true,updatedAtMs:now,...extra});
const scope=(subs,extra={})=>({mode:'live',asOf:now,rows:subs.map(s=>({id:id(s),kind:'subscription',status:'active'})),...extra});
await test('custom50% forecasts discounted software MRR with incomplete and scheduled rows explicit',()=>{
 const facts=Array.from({length:10},(_,i)=>fact('sub_'+i));facts.push(fact('sub_full',8910),fact('sub_future',null,{firstPaymentAtMs:now+86400000,linesKnown:false}));
 const result=referralMonthlyIncome(owner,scope(facts.map(f=>f.subscriptionId)),facts,50,now);
 assert.deepEqual(result.monthlyMinorByCurrency,{usd:44055});assert.equal(result.pricedSubscriptions,11);assert.equal(result.scheduledSubscriptions,1);assert.equal(result.unknownSubscriptions,0);
 assert.equal(JSON.stringify(result).includes('sub_'),false);
});
await test('currency separation, annual-normalized decimals, zero price and duplicate row deduplication',()=>{
 const f=[fact('a',100/12),fact('b',0),fact('c',10000,{currency:'eur'})];
 const r=referralMonthlyIncome(owner,scope(['a','a','b','c']),f,50,now);
 assert.deepEqual(r.monthlyMinorByCurrency,{usd:4,eur:5000});assert.equal(r.pricedSubscriptions,3);
});
await test('unknown, stale, cancelled, past-due, one-time, foreign owner and foreign mode never inflate estimate',()=>{
 const f=[fact('missing',null,{linesKnown:false}),fact('stale',7920,{updatedAtMs:now-900001}),fact('cancel',7920,{cancelAtPeriodEnd:true}),fact('late',7920,{status:'past_due'}),fact('life'),fact('foreign'),fact('test',7920,{mode:'test'})];
 const s=scope(['missing','stale','cancel','late','life','test']);s.rows.find(r=>r.id===id('life')).kind='lifetime';s.rows.push({id:id('foreign','other'),kind:'subscription',status:'active'});
 const r=referralMonthlyIncome(owner,s,f,50,now);assert.deepEqual(r.monthlyMinorByCurrency,{});assert.equal(r.unknownSubscriptions,4);assert.equal(r.excludedSubscriptions,2);assert.equal(r.stale,true);
});
await test('stale identity scope, duplicate facts and invalid rate fail closed',()=>{
 assert.equal(referralMonthlyIncome(owner,scope(['a'],{asOf:now-86400001}),[fact('a')],50,now).stale,true);
 const duplicate=referralMonthlyIncome(owner,scope(['a']),[fact('a'),fact('a')],50,now);assert.equal(duplicate.unknownSubscriptions,1);assert.deepEqual(duplicate.monthlyMinorByCurrency,{});
 assert.deepEqual(referralMonthlyIncome(owner,scope(['a']),[fact('a')],101,now).monthlyMinorByCurrency,{});
});
summary('earn-monthly-income');
