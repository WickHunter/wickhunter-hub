import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const script = new URL('../scripts/prepare-hub-audit-rollback.mjs', import.meta.url);
const ledger = 'license-lease-audit.v1.jsonl';
const sha = (value) => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rollback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  fs.writeFileSync(path.join(dir, 'license-lease-public-keys.v1.json'), JSON.stringify({
    v: 1, keys: { 'lease-1': { publicKey: der.subarray(-32).toString('base64url'), createdAtMs: 1 } },
  }));
  const mkLine = (previousHash, event) => {
    const fields = { v: 1, kid: 'lease-1', previousHash, event };
    const sig = sign(null, Buffer.from('wickhunter.license.lease-ledger.v1\n' + JSON.stringify(fields)), privateKey).toString('base64url');
    return { ...fields, sig };
  };
  const first = mkLine(null, { schemaVersion: 1, eventId: 'first', kind: 'ledger_initialized', atMs: 1 });
  const second = mkLine(sha(JSON.stringify(first)), { schemaVersion: 1, eventId: 'second',
    kind: 'license_revocation_observed', atMs: 2, actor: 'admin', licenseId: 'license-1', reason: 'test' });
  fs.writeFileSync(path.join(dir, `${ledger}.segment.00000001`), JSON.stringify(first) + '\n');
  fs.writeFileSync(path.join(dir, ledger), JSON.stringify(second) + '\n');
  const headFields = { v: 1, kid: 'lease-1', eventCount: 2,
    lastHash: sha(JSON.stringify(second)), updatedAtMs: 1 };
  fs.writeFileSync(path.join(dir, 'license-lease-audit-head.v1.json'), JSON.stringify({
    ...headFields, sig: sign(null, Buffer.from('wickhunter.license.lease-head.v1\n' + JSON.stringify(headFields)), privateKey).toString('base64url'),
  }));
  const output = path.join(dir, 'rollback-ledger.jsonl');
  const run = (pid = '99999999') => spawnSync(process.execPath,
    [script.pathname, '--data-dir', dir, '--output', output, '--stopped-pid', pid], { encoding: 'utf8' });
  return { dir, output, run, first, second };
}

test('exports current signed archive and active history without modifying source', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.dir, ledger));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(f.output, 'utf8').trim().split('\n').map(JSON.parse), [f.first, f.second]);
  assert.equal(fs.statSync(f.output).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, ledger)), before);
  assert.equal(JSON.parse(result.stdout).archives, 1);
});

test('refuses pending billing handoff and leaves no export', (t) => {
  const f = fixture(t);
  const outbox = path.join(f.dir, 'billing-earn-outbox.v1');
  fs.mkdirSync(outbox);
  fs.writeFileSync(path.join(outbox, 'pending.json'), '{}');
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Earn outbox has 1 pending/);
  assert.equal(fs.existsSync(f.output), false);
});

test('refuses live writer, signed-chain corruption and missing archive', (t) => {
  const f = fixture(t);
  assert.match(f.run(String(process.pid)).stderr, /still running/);
  const archive = path.join(f.dir, `${ledger}.segment.00000001`);
  const original = fs.readFileSync(archive);
  fs.writeFileSync(archive, original.toString().replace('first', 'forst'));
  assert.match(f.run().stderr, /signature is invalid/);
  assert.equal(fs.existsSync(f.output), false);
  fs.rmSync(archive);
  assert.match(f.run().stderr, /signed chain/);
  assert.equal(fs.existsSync(f.output), false);
});

test('refuses an export too large for the previous Hub lease writer', (t) => {
  const f = fixture(t);
  fs.truncateSync(path.join(f.dir, `${ledger}.segment.00000001`), 128 * 1024 * 1024);
  assert.match(f.run().stderr, /single-ledger ceiling/);
  assert.equal(fs.existsSync(f.output), false);
});
