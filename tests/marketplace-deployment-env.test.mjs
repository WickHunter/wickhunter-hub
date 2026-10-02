import assert from 'node:assert/strict';
import {MARKETPLACE_DEPLOYMENT_FIELDS, preservedDeploymentEnv} from '../dist/src/marketplace-deployment-env.js';
import {MARKETPLACE_INPUT_DEFINITIONS} from '../dist/src/marketplace-inputs.js';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const values=new Map([
 ['STRIPE_COMMERCE_SECRET_KEY','sk_private_"quoted"'],
 ['STRIPE_COMMERCE_WEBHOOK_SECRET','whsec_private'],
 ['STRIPE_COMMERCE_CURRENCY','usd'],
 ['STRIPE_COMMERCE_SUCCESS_URL','https://example.com/success'],
 ['STRIPE_COMMERCE_CANCEL_URL','https://example.com/cancel'],
 ['UNRELATED_PRIVATE_KEY','must-not-be-copied'],
]);
const common=preservedDeploymentEnv('common',values).toString();
const roundtrip=new Map(common.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),JSON.parse(line.slice(at+1))];}));
for(const k of MARKETPLACE_DEPLOYMENT_FIELDS.common)assert.equal(roundtrip.get(k),values.get(k));
assert.equal(roundtrip.has('UNRELATED_PRIVATE_KEY'),false);
const api=preservedDeploymentEnv('api',values).toString();
assert.equal(api,'STRIPE_COMMERCE_WEBHOOK_SECRET="whsec_private"\n','API preserves only its own webhook field, never the commerce API secret');
assert.equal(preservedDeploymentEnv('common',new Map()).length,0);
assert.throws(()=>preservedDeploymentEnv('common',new Map([['STRIPE_COMMERCE_SECRET_KEY','bad\nOTHER=value']])));
for(const name of MARKETPLACE_DEPLOYMENT_FIELDS.common) assert.equal(MARKETPLACE_INPUT_DEFINITIONS.some(f=>f.name===name),false,'deployment secrets must stay outside editable/masked operator inputs');
const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
const dom=new JSDOM('<form id="mktConfigForm"><div id="mktConfigFields"></div><button type="submit">Save</button><p id="mktConfigNote"></p></form>',{runScripts:'outside-only'});
const w=dom.window;
w.mktRenderConfig=()=>{};
w.api=async()=>{throw new Error('helper refused');};
w.confirm=()=>{throw new Error('must not offer save confirmation before config loads');};
w.eval(html.slice(html.indexOf('let mktConfigLoaded ='),html.indexOf('document.getElementById("mktRefresh").onclick')));
try{
 await w.mktConfigRefresh();
 assert.equal(w.document.querySelector('button').disabled,true);
 await w.document.querySelector('form').onsubmit({preventDefault(){}});
 assert.match(w.document.getElementById('mktConfigNote').textContent,/Load Marketplace settings/);
 w.api=async()=>({config:{}});
 await w.mktConfigRefresh();
 assert.equal(w.document.querySelector('button').disabled,false,'successful refresh recovers Save');
}finally{w.close();}
console.log('Marketplace deployment fields: private role preservation and failed-config save guard passed');
