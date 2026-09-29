import assert from 'node:assert/strict';
import {test,summary} from './helpers.mjs';
import {SupportSessionLimiter} from '../dist/src/support-session-limiter.js';
const key=Buffer.alloc(32,7);
await test('more than 4095 distinct visitors retain individual admission',()=>{
 const lim=new SupportSessionLimiter(86400000,3,65536,key),now=1e9,bytes=lim.bytes;
 for(let i=0;i<12000;i++)assert(lim.take(`ip:${i}`,now).ok,`first question visitor ${i}`);
 assert.equal(lim.bytes,bytes);assert.equal(bytes,6*1024*1024);
 assert(lim.take('ip:11999',now).ok);assert(lim.take('ip:11999',now).ok);
 assert.equal(lim.take('ip:11999',now).ok,false);
 assert(lim.take('ip:new-after-cap',now).ok);
});
await test('rolling boundary and denied calls do not replenish or extend allowance',()=>{
 const lim=new SupportSessionLimiter(10000,3,65536,key);
 for(const t of [0,1000,2000])assert(lim.take('a',t).ok);
 assert.equal(lim.take('a',9999).ok,false);
 assert(lim.take('a',10000).ok);
 assert.equal(lim.take('a',10001).ok,false);
 assert(lim.take('a',11000).ok);
});
await test('forced collisions are conservative, and never evict another address allowance',()=>{
 const lim=new SupportSessionLimiter(10000,3,1,key);
 assert(lim.take('a',0).ok);assert(lim.take('b',1).ok);assert(lim.take('a',2).ok);
 assert.equal(lim.take('a',3).ok,false);assert.equal(lim.take('new',4).ok,false);
 assert.equal(lim.take('a',-100).ok,false);
 assert(lim.take('new',10000).ok);assert.equal(lim.take('a',10000).ok,false);
});
await test('cardinality churn cannot reset a known address budget',()=>{
 const lim=new SupportSessionLimiter(10000,3,32,key),used=new Map();
 for(let t=0;t<3000;t++){
  const id=`ip:${t%400}`;const result=lim.take(id,t);
  if(result.ok){used.set(id,(used.get(id)||0)+1);assert(used.get(id)<=3);}
 }
 assert(lim.take('reset-after-window',13000).ok);
 assert.equal(lim.take('a',NaN).ok,false);
});
summary();
