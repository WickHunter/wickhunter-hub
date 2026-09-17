import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
const helper=html.slice(html.indexOf('function protectApiField('),html.indexOf('function billingSecretField('));
const save=html.slice(html.indexOf('async function billingSaveStripe('),html.indexOf('document.querySelectorAll(".billingcards .save")'));
let payload;
const fields=[];
const context=vm.createContext({
 document:{createElement(){return {setAttribute(){}};},getElementById(){return {querySelectorAll(){return fields;}};},querySelector(){return {}; }},
 api:async(_path,opts)=>{payload=JSON.parse(opts.body);return {};},billingRenderAll(){},billingConfig:null,
});
vm.runInContext(helper+'\n'+save,context);
function field(type='password',value=''){
 const input={type,value,dataset:{field:type==='password'?'secretKey':'publishableKey'},setAttribute(){},addEventListener(type,fn){this[type+"Handler"]=fn;},focus(){}};
 const buttons=[];context.protectApiField(input,{appendChild(b){buttons.push(b);}});return {input,edit:buttons[0]};
}
const secret=field();fields.push(secret.input);
secret.input.value='unwanted-password-manager-value';
secret.input.inputHandler();assert.equal(secret.input.value,'');
secret.input.value='unwanted-password-manager-value';
await context.billingSaveStripe('test');assert.equal(payload.stripe.test.secretKey,undefined);
secret.edit.onclick();assert.equal(secret.input.value,'');assert.equal(secret.input.readOnly,false);
secret.input.value='sk_test_intentional';await context.billingSaveStripe('test');assert.equal(payload.stripe.test.secretKey,'sk_test_intentional');
secret.edit.onclick();assert.equal(secret.input.value,'');assert.equal(secret.input.readOnly,true);
secret.input.dataset.clear='1';await context.billingSaveStripe('test');assert.equal(payload.stripe.test.secretKey,null);
const pub=field('text','pk_test_saved');fields.push(pub.input);pub.input.value='wrong-autofill';
await context.billingSaveStripe('test');assert.equal(payload.stripe.test.publishableKey,undefined);
pub.edit.onclick();pub.input.value='pk_test_new';await context.billingSaveStripe('test');assert.equal(payload.stripe.test.publishableKey,'pk_test_new');
pub.edit.onclick();assert.equal(pub.input.value,'pk_test_saved');
console.log('PASS: locked autofill omitted, explicit edit saved, cancel restored, explicit clear preserved');
