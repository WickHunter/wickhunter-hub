import assert from 'node:assert/strict';
import {EarnStripeApi, EarnStripeError} from '../dist/src/earn-stripe-api.js';
import {test,summary} from './helpers.mjs';
const ok=()=>new Response(JSON.stringify({data:[{id:'sub_fixture'}],has_more:false}));
await test('one timed-out GET retries exactly the same read with a fresh bounded signal',async()=>{
 const calls=[];const api=new EarnStripeApi('sk_live_fixture',async(url,init)=>{calls.push({url,init});if(calls.length===1)throw new DOMException('fixture timeout','TimeoutError');return ok();});
 const data=await api.call('GET','/v1/subscriptions',{limit:100},{context:'acct_fixture'});
 assert.equal(calls.length,2);assert.equal(data.has_more,false);assert.equal(calls[0].url,calls[1].url);
 assert.equal(calls[1].init.redirect,'error');assert.equal(calls[1].init.headers['Stripe-Context'],'acct_fixture');
 assert.notEqual(calls[0].init.signal,calls[1].init.signal);assert.equal(calls[1].init.signal.aborted,false);
});
await test('known connection resets and body timeouts retry once; a second failure remains an error',async()=>{
 for(const code of ['ECONNRESET','UND_ERR_BODY_TIMEOUT']){
  let calls=0;const e=Object.assign(new TypeError('fetch failed'),{cause:{code}});
  const api=new EarnStripeApi('sk_live_fixture',async()=>{calls++;throw e;});
  await assert.rejects(api.call('GET','/v1/invoices'),err=>err===e);assert.equal(calls,2);
 }
 let calls=0;const api=new EarnStripeApi('sk_live_fixture',async()=>{calls++;if(calls===1)return{ok:true,json:async()=>{throw new DOMException('body timeout','TimeoutError');}};return ok();});
 assert.equal((await api.call('GET','/v1/invoices')).data.length,1);assert.equal(calls,2);
});
await test('POST never retries even with an idempotency key and a transport timeout',async()=>{
 let calls=0;const api=new EarnStripeApi('sk_live_fixture',async()=>{calls++;throw new DOMException('timeout','TimeoutError');});
 await assert.rejects(api.call('POST','/v1/transfers',{amount:100},{key:'fixture-key'}),{name:'TimeoutError'});assert.equal(calls,1);
});
await test('HTTP errors, invalid JSON, redirects and unknown transport errors never retry',async()=>{
 for(const fetcher of [async()=>new Response(JSON.stringify({error:{code:'rate_limit'}}),{status:429}),async()=>new Response('{'),async()=>{throw new TypeError('unexpected redirect');},async()=>{throw new Error('unknown');}]){
  let calls=0;const api=new EarnStripeApi('sk_live_fixture',async(...args)=>{calls++;return fetcher(...args);});
  await assert.rejects(api.call('GET','/v1/invoices'));assert.equal(calls,1);
 }
 let calls=0;const api=new EarnStripeApi('sk_live_fixture',async()=>{calls++;return new Response(JSON.stringify({error:{code:'bad secret?!'}}),{status:400});});
 await assert.rejects(api.call('GET','/v1/invoices'),err=>err instanceof EarnStripeError && err.code==='badsecret' && !err.message.includes('sk_live'));assert.equal(calls,1);
});
summary('earn-stripe-api');
