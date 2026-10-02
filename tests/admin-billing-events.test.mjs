import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
const dom=new JSDOM('<div id="billingEvents"></div>',{runScripts:'outside-only'});
const w=dom.window;
w.esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
w.fmt=()=> 'now';
w.eval(html.slice(html.indexOf('function billingEventOutcomeClass('),html.indexOf('document.getElementById("billingEventsRefresh").onclick')));
try {
 const root=w.document.getElementById('billingEvents');
 root.innerHTML=w.renderBillingEvents([
  {livemode:true,type:'?',outcome:'signature',note:'signature missing'},
  {livemode:false,type:'invoice.paid',outcome:'ignored'},
  {livemode:true,type:'invoice.paid',outcome:'error',note:'fulfillment failed'},
  {livemode:true,type:'checkout.session.completed',outcome:'applied',note:'<unsafe>'},
 ]);
 const diag=root.querySelector('details');
 assert.equal(diag.open,false);
 assert.match(diag.textContent,/Unverified request.*Rejected.*signature missing/s);
 assert.match(diag.textContent,/TEST.*invoice.paid/s);
 assert.doesNotMatch(diag.textContent,/fulfillment failed|checkout.session.completed/);
 const live=[...root.children].filter(el=>el.tagName!=='DETAILS').map(el=>el.textContent).join(' ');
 assert.match(live,/fulfillment failed/,'actual live customer failures remain visible');
 assert.match(live,/checkout.session.completed.*applied/);
 assert.equal(root.querySelector('unsafe'),null,'event notes stay escaped');
 w.api=async()=>{throw new Error('offline');};
 await w.billingEventsRefresh();
 assert.match(root.textContent,/Could not load recent billing activity/);
} finally {dom.window.close();}
console.log('Billing activity: live failures visible; unverified/test diagnostics collapsed and escaped');
