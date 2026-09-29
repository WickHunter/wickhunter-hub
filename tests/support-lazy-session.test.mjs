import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
const html=fs.readFileSync('public/support.html','utf8');
const calls=[],errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
let session=false,poll;
const dom=new JSDOM(html,{url:'https://hub.test/support',pretendToBeVisual:true,runScripts:'dangerously',virtualConsole:vc,beforeParse(w){
 w.setInterval=fn=>{poll=fn;return 0;};
 w.fetch=async(url,opts)=>{
  calls.push({url,method:opts?.method,body:opts?.body});
  if(url.endsWith('/session')){session=true;return{status:200,json:async()=>({ok:true})};}
  if(!session)return{status:401,json:async()=>({ok:false,error:'Start a support session first'})};
  return{status:200,json:async()=>({ok:true,aiEnabled:true,threads:[{id:'thread',status:'human',messages:[{id:'question',role:'customer',text:'Setup question'}]}]})};
 };
}});
const wait=()=>new Promise(resolve=>setTimeout(resolve,20));
try{
 await wait();const d=dom.window.document;
 assert.deepEqual(calls.map(x=>[x.url,x.method]),[['/support/chat','GET']]);
 assert.match(d.querySelector('#messages').textContent,/How can we help/);
 assert.equal(d.querySelector('#status').textContent,'');
 poll();await wait();assert.equal(calls.length,1,'idle anonymous pages do not create sessions or poll');
 d.querySelector('#question').value='Setup question';d.querySelector('#chat').requestSubmit();await wait();
 assert.deepEqual(calls.slice(1).map(x=>[x.url,x.method]),[['/support/session','POST'],['/support/chat','POST']]);
 assert.equal(JSON.parse(calls[2].body).text,'Setup question');
 poll();await wait();assert.equal(calls.at(-1).method,'GET','existing conversation polls for human replies');
 d.querySelector('#question').value='A follow-up';d.querySelector('#chat').requestSubmit();await wait();
 assert.equal(calls.filter(x=>x.url.endsWith('/session')).length,1,'follow-up reuses the session');
 assert.deepEqual(errors,[]);
 console.log('Support session is created only by the first submitted question; existing chats still load and poll.');
}finally{dom.window.close();}
