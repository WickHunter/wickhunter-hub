import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const dom = new JSDOM(`<p id="marketingBrevoStatus"></p><form id="marketingBrevoForm">
  <input id="marketingBrevoKey"><input id="marketingBrevoLists"><input id="marketingBrevoWebhookSecret">
  <input type="checkbox" id="marketingBrevoClearKey"><input type="checkbox" id="marketingBrevoClearLists"><input type="checkbox" id="marketingBrevoClearWebhook">
  <button type="submit">Save</button><button type="button" id="marketingBrevoTest">Check</button>
  <span id="marketingBrevoNote"></span></form>`, { runScripts:'outside-only' });
const w = dom.window;
const el = id => w.document.getElementById(id);
const state = {ok:true, configured:true, webhookConfigured:true, listIds:[15], lastTestOk:true, lastTestMessage:'Brevo connection verified.'};
const calls = [];
let reply = async () => ({...state});
w.api = async (path, opts) => { calls.push({path, ...opts}); return reply(); };
w.eval(html.slice(html.indexOf('let brevoFormDirty ='), html.indexOf('function billingRenderAll(')));
const fill = (id, value) => { el(id).value=value; el(id).dispatchEvent(new w.Event('input', {bubbles:true})); };
const save = () => el('marketingBrevoForm').onsubmit({preventDefault(){}, target:el('marketingBrevoForm')});
try {
  w.renderBrevoSettings(state);
  assert.match(el('marketingBrevoStatus').textContent, /Connected to Brevo/);
  fill('marketingBrevoKey', 'replacement-key-kept-private');
  fill('marketingBrevoLists', '17');
  await w.marketingBrevoRefresh();
  assert.equal(el('marketingBrevoKey').value, 'replacement-key-kept-private', 'refresh cannot erase a pasted key');
  assert.equal(el('marketingBrevoLists').value, '17', 'refresh cannot overwrite unsaved audience changes');
  let before = calls.length;
  await el('marketingBrevoTest').onclick();
  assert.equal(calls.length, before, 'checking an unsaved key must not misleadingly test the old key');
  assert.match(el('marketingBrevoNote').textContent, /Save your changes/);
  await save();
  assert.deepEqual(JSON.parse(calls.at(-1).body), {apiKey:'replacement-key-kept-private',listIds:[17]});
  assert.equal(el('marketingBrevoKey').value, '', 'a successful save clears only the submitted secret');
  reply = async () => ({...state, lastTestOk:false, lastTestMessage:'Brevo rejected the API key.'});
  await el('marketingBrevoTest').onclick();
  assert.match(el('marketingBrevoNote').textContent, /rejected the API key/);
  assert.doesNotMatch(el('marketingBrevoNote').textContent, /Connected/);
  assert.equal(el('marketingBrevoKey').disabled, false, 'connection failures keep the form editable');

  // Editing while a save is in flight must not have the newer edit cleared by the old response.
  fill('marketingBrevoKey', 'first-submission-private-key');
  let finishSave;
  reply = () => new Promise(resolve => { finishSave=resolve; });
  const pending = save();
  fill('marketingBrevoKey', 'newer-unsaved-private-key');
  finishSave({...state});
  await pending;
  assert.equal(el('marketingBrevoKey').value, 'newer-unsaved-private-key');
  reply = async () => ({...state});
  await save();
  assert.equal(el('marketingBrevoKey').value, '');
  fill('marketingBrevoLists', '');
  before = calls.length;
  await save();
  assert.equal(calls.length, before, 'an empty form cannot claim to have saved a missing key');
  assert.match(el('marketingBrevoNote').textContent, /Enter a key or change a setting/);
} finally { dom.window.close(); }
console.log('Brevo form: truthful connection feedback, dirty-refresh protection and in-flight edit preservation passed');
