import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
const html=fs.readFileSync('public/support.html','utf8');
const thread={id:'fixture-thread',status:'assistant',messages:[{id:'fixture-q',role:'customer',text:'Setup help'},{id:'fixture-a',role:'assistant',text:'Connect: 1. Open **Settings**. 2. Create `API`.\n\n[Guide](https://example.com/help)'}]};
let last,empty=false;
const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
const dom=new JSDOM(html,{url:'https://hub.test/support',runScripts:'dangerously',virtualConsole:vc,beforeParse(w){w.setInterval=()=>0;w.fetch=async(url,opts)=>{if(opts?.body&&JSON.parse(opts.body).action){last=JSON.parse(opts.body);thread.status=last.action==='resolve'?'resolved':'human';thread.messages.at(-1).feedback=last.action==='resolve'?'helpful':'needs_help';}return{json:async()=>({ok:true,aiEnabled:true,threads:empty?[]:[thread]})};};}});
const wait=()=>new Promise(r=>setTimeout(r,20));
try{
 await wait();const d=dom.window.document;
 assert.equal(d.querySelector('#threads'),null);assert.equal(d.querySelector('#human'),null);assert.equal(d.querySelectorAll('#messages ol li').length,2);assert.equal(d.querySelector('#messages strong').textContent,'Settings');assert.equal(d.querySelector('#feedback').parentElement.id,'messages');assert.equal(d.querySelector('#feedback').hidden,false);assert.ok(!/AI support|AI replies/.test(d.body.textContent));
 d.querySelector('#more').click();await wait();assert.equal(last.action,'human');assert.equal(d.querySelector('#feedback').hidden,true);
 thread.messages.push({id:'human-reply',role:'human',text:'Answer from the team'});thread.status='resolved';await dom.window.eval('load()');
 assert.ok(d.querySelector('#messages').textContent.includes('Answer from the team'));assert.equal(d.querySelector('#feedback').hidden,false);
 d.querySelector('#resolved').click();await wait();assert.equal(last.action,'resolve');assert.ok(!d.querySelector('#messages').textContent.includes('Answer from the team'));assert.equal(d.querySelector('#feedback').hidden,true);
 thread.status='human';await dom.window.eval('load()');empty=true;await dom.window.eval('load()');assert.equal(d.querySelector('#messages').textContent.includes('How can we help?'),true);
 assert.deepEqual(errors,[]);console.log('Website support: formatted answers, compact feedback, human handoff, resolution and deleted-thread reset passed');
}finally{dom.window.close();}

const pause=()=>new Promise(r=>setTimeout(r,20));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const response=(data,status=200)=>({status,json:async()=>data});
const session=deferred(),eligibility=deferred(),firstSend=deferred();
let sessionLive=false,sessionPosts=0,postQueue=[firstSend],getQueue=[eligibility],latest={ok:true,aiEnabled:true,canAutoReply:true,threads:[]};
const sent=[];
const guest=new JSDOM(html,{url:'https://hub.test/support',runScripts:'dangerously',beforeParse(w){
 w.setInterval=()=>0;let id=0;w.crypto.randomUUID=()=>`guest-request-${++id}`;
 w.fetch=(url,opts)=>{
  if(url.endsWith('/session')){sessionPosts++;return session.promise;}
  if(opts?.method==='POST'){sent.push(JSON.parse(opts.body));return postQueue.shift().promise;}
  if(!sessionLive)return Promise.resolve(response({ok:false,error:'Session required'},401));
  return getQueue.length?getQueue.shift().promise:Promise.resolve(response(latest));
 };
}});
try{
 const d=guest.window.document,question=d.querySelector('#question'),messages=d.querySelector('#messages');
 await pause();assert.equal(sessionPosts,0,'opening support does not provision a guest session');
 assert.equal(d.querySelector('h1').textContent,'Wick Hunter Support');
 question.value='Help with installation';d.querySelector('#send').click();
 assert.equal(sessionPosts,1);assert.equal(question.value,'','composer clears on send before session creation completes');
 assert.match(messages.textContent,/Help with installation/);assert.doesNotMatch(messages.textContent,/Support is writing…/,'reply eligibility is unknown until session chat loads');
 question.value='A draft while waiting';sessionLive=true;session.resolve(response({ok:true}));await pause();
 eligibility.resolve(response(latest));await pause();
 assert.match(messages.textContent,/Support is writing…/,'eligible automated reply shows a compact indicator');
 assert.equal(sent.length,1);assert.equal(sent[0].text,'Help with installation');
 const answered={ok:true,aiEnabled:true,canAutoReply:true,threads:[{id:'guest-thread',status:'assistant',canAutoReply:true,messages:[{id:'guest-question',role:'customer',text:'Help with installation',clientRequestId:sent[0].requestId},{id:'guest-answer',role:'assistant',text:'Installation guide'}]}]};
 latest=answered;firstSend.resolve(response(answered));await pause();
 assert.equal(messages.textContent.match(/Help with installation/g)?.length,1);
 assert.equal(question.value,'A draft while waiting');assert.doesNotMatch(messages.textContent,/Support is writing…/);

 const staleGet=deferred(),failed=deferred(),retry=deferred();getQueue.push(staleGet);postQueue.push(failed,retry);
 guest.window.load();question.value='Second question';d.querySelector('#send').click();question.value='New draft';
 staleGet.resolve(response(answered));await pause();
 assert.match(messages.textContent,/Second question/,'late GET cannot erase the optimistic bubble');assert.equal(question.value,'New draft');
 failed.reject(new Error('Connection dropped'));await pause();
 assert.match(messages.textContent,/Could not confirm delivery/);assert.ok(messages.querySelector('[data-action="retry"]'));
 messages.querySelector('[data-action="retry"]').click();
 assert.equal(sent.length,3);assert.equal(sent[1].requestId,sent[2].requestId,'retry reuses the original request ID');
 const retried={...answered,threads:[{...answered.threads[0],messages:[...answered.threads[0].messages,{id:'second-question',role:'customer',text:'Second question',clientRequestId:sent[1].requestId},{id:'second-answer',role:'assistant',text:'Second answer'}]}]};
 latest=retried;retry.resolve(response(retried));await pause();
 assert.equal(messages.textContent.match(/Second question/g)?.length,1);assert.equal(question.value,'New draft');

 const uncertain=deferred();postQueue.push(uncertain);
 question.value='Third question';d.querySelector('#send').click();const thirdId=sent.at(-1).requestId;
 uncertain.reject(new Error('Response lost'));await pause();
 latest={...retried,threads:[{...retried.threads[0],messages:[...retried.threads[0].messages,{id:'other-third',role:'customer',text:'Third question',clientRequestId:'someone-else'}]}]};
 await guest.window.load();assert.ok(messages.querySelector('[data-action="retry"]'),'different request ID cannot confirm delivery');
 latest={...retried,threads:[{...retried.threads[0],messages:[...retried.threads[0].messages,{id:'third-question',role:'customer',text:'Third question',clientRequestId:thirdId}]}]};
 await guest.window.load();assert.equal(messages.querySelector('[data-action="retry"]'),null,'matching request ID confirms delivery');
 assert.equal(messages.textContent.match(/Third question/g)?.length,1);

 const human={ok:true,aiEnabled:true,threads:[{id:'human-thread',status:'human',canAutoReply:false,messages:[{id:'human-question',role:'customer',text:'Waiting for team'}]}]};
 guest.window.render(human);const humanSend=deferred();postQueue.push(humanSend);
 question.value='Following up';d.querySelector('#send').click();
 assert.doesNotMatch(messages.textContent,/Support is writing…/,'human-only thread never claims support is writing');
 humanSend.resolve(response({...human,threads:[{...human.threads[0],messages:[...human.threads[0].messages,{id:'human-follow-up',role:'customer',text:'Following up'}]}]}));await pause();
 const autoHandoff={...human,threads:[{...human.threads[0],canAutoReply:true}]};guest.window.render(autoHandoff);
 assert.doesNotMatch(messages.textContent,/Support is writing…/,'eligibility for a new question does not mean an old handoff is typing');
 const automated=deferred();postQueue.push(automated);question.value='New AI-eligible question';d.querySelector('#send').click();
 assert.match(messages.textContent,/Support is writing…/,'AI-eligible handoff shows the indicator even with human status');
 automated.resolve(response({...autoHandoff,threads:[{...autoHandoff.threads[0],messages:[...autoHandoff.threads[0].messages,{id:'new-q',role:'customer',text:'New AI-eligible question'},{id:'new-a',role:'assistant',text:'Automated answer'}]}]}));await pause();
 const quota={ok:true,aiEnabled:true,canAutoReply:false,autoReplyUnavailableReason:'guest_daily_limit',autoReplyNotice:'Today’s automatic reply limit has been reached.',threads:[{id:'quota-thread',status:'human',canAutoReply:false,replyInProgress:false,autoReplyUnavailableReason:'guest_daily_limit',autoReplyNotice:'Today’s automatic reply limit has been reached. Our team can review your message.',messages:[{id:'quota-q',role:'customer',text:'Waiting after limit'}]}]};
 guest.window.render(quota);assert.equal(d.querySelector('#status').textContent,quota.threads[0].autoReplyNotice);assert.doesNotMatch(messages.textContent,/Support is writing…/);
 guest.window.render({...quota,threads:[{...quota.threads[0],autoReplyNotice:null}]});assert.match(d.querySelector('#status').textContent,/Today’s automatic reply limit/,'reason fallback explains a paused older response');
 const provider={...quota,threads:[{...quota.threads[0],autoReplyUnavailableReason:'provider_error',autoReplyNotice:'Automatic replies are temporarily unavailable. Our team can review your message.'}]};
 guest.window.render(provider);assert.equal(d.querySelector('#status').textContent,provider.threads[0].autoReplyNotice);
 const recovered={...quota,canAutoReply:true,autoReplyUnavailableReason:null,autoReplyNotice:null,threads:[{...quota.threads[0],canAutoReply:true,autoReplyUnavailableReason:null,autoReplyNotice:'Automatic replies are available again. Ask another question to continue.'}]};
 guest.window.render(recovered);assert.equal(d.querySelector('#status').textContent,recovered.threads[0].autoReplyNotice);assert.doesNotMatch(messages.textContent,/Support is writing…/,'recovered handoff waits for a new customer question');
 guest.window.render({...recovered,threads:[{...recovered.threads[0],replyInProgress:true}]});assert.match(messages.textContent,/Support is writing…/,'server explicitly reports active generation');
 const requested={...quota,threads:[{...quota.threads[0],autoReplyUnavailableReason:'human_requested',autoReplyNotice:'With the support team.'}]};
 guest.window.render(requested);assert.equal(d.querySelector('#status').textContent,'With the support team.');assert.doesNotMatch(messages.textContent,/Support is writing…/);
 guest.window.render({ok:true,aiEnabled:false,canAutoReply:false,autoReplyUnavailableReason:'provider_unconfigured',autoReplyNotice:'Automatic replies are unavailable. Our team can review your message.',threads:[]});assert.equal(d.querySelector('#status').textContent,'Automatic replies are unavailable. Our team can review your message.');
 console.log('Website support: guest send, optimistic bubble, retry, draft, polling race, and reply eligibility passed');
}finally{guest.window.close();}
