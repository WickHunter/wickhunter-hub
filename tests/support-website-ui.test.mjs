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
