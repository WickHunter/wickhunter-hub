import assert from 'node:assert/strict';
import path from 'node:path';
import { loadStarterPack, starterPackEligible, starterPackGrantAt, STARTER_PACK_END_MS } from '../dist/src/billing/starter-pack.js';
import { welcomeEmail } from '../dist/src/billing/email.js';

const pack = loadStarterPack(path.resolve('templates'));
const bundle = JSON.parse(pack.bundle), liquidation = JSON.parse(pack.liquidation), hedge = JSON.parse(pack.hedge);
assert.equal(bundle.kind, 'liqhunter-config'); assert.equal(bundle.v, 1);
assert.deepEqual(bundle.bots, [liquidation.bots[0], hedge.bots[0]], 'the bundle preserves both source configurations exactly');
assert.deepEqual(bundle.bots.map(b => b.type), ['bot1', 'bot3']);
assert.equal(liquidation.bots[0].config.entry.entrySizeUsd, 1);
assert.equal(liquidation.bots[0].config.strategy.firstDcaUsd, 1);
assert.deepEqual(liquidation.bots[0].config.strategy.dcaRungs.map(r => r.size), [1, 2.5, 6, 12.5]);
assert.equal(liquidation.bots[0].config.strategy.dcaSizeType, 'percent');
assert.equal(hedge.bots[0].config.attach.autoAttach, true);
assert.equal(hedge.bots[0].config.attach.pairMode, 'all');
assert.equal(hedge.bots[0].config.attach.minimumDcaToHedge.enabled, false);
assert.match(pack.summary.liquidation, /1% of balance entry/);
assert.match(pack.summary.liquidation, /1, 2.5, 6, 12.5% of balance/);
assert.match(pack.summary.hedge, /choose pairs and review before enabling/);

const intent = { mode: 'live', createdAtMs: Date.parse('2026-10-15T23:59:58-04:00') };
const event = { createdMs: Date.parse('2026-10-15T23:59:59-04:00'), livemode: true };
assert.equal(starterPackGrantAt(intent, event, true), event.createdMs);
assert.equal(starterPackGrantAt(intent, { ...event, createdMs: STARTER_PACK_END_MS }, true), null, 'completion after the deadline is ineligible');
assert.equal(starterPackGrantAt({ ...intent, createdAtMs: STARTER_PACK_END_MS }, event, true), null, 'starting after the deadline is ineligible');
assert.equal(starterPackGrantAt(intent, { ...event, livemode: false }, true), null, 'test-mode checkout is ineligible');
assert.equal(starterPackGrantAt(intent, event, false), null, 'returning purchases do not grant a new signup pack');
assert.equal(starterPackEligible({ livemode: true, launchManaged: true, refunded: false, disputed: false, starterPackGrantedAtMs: event.createdMs }), true);
assert.equal(starterPackEligible({ livemode: true, launchManaged: true, refunded: true, disputed: false, starterPackGrantedAtMs: event.createdMs }), false);
const email = welcomeEmail('buyer@example.test', { name: 'Buyer', pageUrl: 'https://hub.example.test/welcome/private-token', expiresAtMs: STARTER_PACK_END_MS,
  subscription: true, siteOrigin: 'https://example.test', livemode: true, starterPack: true });
assert.match(email.text, /STARTER PACK: open the same private page at https:\/\/hub\.example\.test\/welcome\/private-token/);
assert.match(email.html, /Open your install and starter pack/);
console.log('Starter pack: source fidelity, import format, and signed signup deadline passed');
