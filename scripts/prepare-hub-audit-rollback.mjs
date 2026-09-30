#!/usr/bin/env node
// Run only after stopping the Hub writer. Export the *current* signed lease
// history in the single-file layout understood by the previous Hub runtime.
// This never replaces live data or discards a billing-to-Earn handoff.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';

const LEDGER = 'license-lease-audit.v1.jsonl';
const HEAD = 'license-lease-audit-head.v1.json';
const KEYRING = 'license-lease-public-keys.v1.json';
const OUTBOX = 'billing-earn-outbox.v1';
// The previous runtime refuses lease writes once its single ledger reaches
// this ceiling. An export larger than that could boot yet strand renewals.
const OLD_LEDGER_MAX_BYTES = 128 * 1024 * 1024;
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const fail = (message) => { throw new Error(message); };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const regular = (file) => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) fail(`refusing non-regular or linked input: ${path.basename(file)}`);
  return stat;
};
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const publicKey = (raw) => {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) fail('invalid lease public key');
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== raw) fail('invalid lease public key');
  return createPublicKey({ key: Buffer.concat([SPKI, bytes]), format: 'der', type: 'spki' });
};
const signature = (raw) => {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw)) fail('invalid lease signature');
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== raw) fail('invalid lease signature');
  return bytes;
};
const signed = (domain, fields, sig, key) =>
  verify(null, Buffer.from(domain + JSON.stringify(fields), 'utf8'), key, signature(sig));
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}

function argumentsOf(argv) {
  if (argv.length !== 6 || argv[0] !== '--data-dir' || argv[2] !== '--output'
    || argv[4] !== '--stopped-pid') {
    fail('usage: node prepare-hub-audit-rollback.mjs --data-dir DIR --output NEW_FILE --stopped-pid FORMER_HUB_PID');
  }
  const pid = Number(argv[5]);
  if (!Number.isSafeInteger(pid) || pid < 2) fail('invalid former Hub pid');
  try { process.kill(pid, 0); fail('former Hub pid is still running; stop the writer first'); }
  catch (err) { if (err?.code !== 'ESRCH') throw err; }
  return { dir: path.resolve(argv[1]), output: path.resolve(argv[3]) };
}

function run() {
  const { dir, output } = argumentsOf(process.argv.slice(2));
  if (!fs.statSync(dir).isDirectory()) fail('data-dir is not a directory');
  if (output === path.join(dir, LEDGER) || fs.existsSync(output) || fs.existsSync(`${output}.tmp.${process.pid}`)) {
    fail('output already exists or names the live lease ledger');
  }
  for (const lock of ['license-lease-write.v1.lock', 'license-lease-keyring.v1.lock']) {
    if (fs.existsSync(path.join(dir, lock))) fail(`${lock} is present; refuse while a writer may exist`);
  }
  const outbox = path.join(dir, OUTBOX);
  const outboxExists = fs.existsSync(outbox);
  if (outboxExists) {
    if (!fs.lstatSync(outbox).isDirectory()) fail('Earn outbox is not a directory');
    const pending = fs.readdirSync(outbox).filter((name) => name.endsWith('.json'));
    if (pending.length) fail(`Earn outbox has ${pending.length} pending row(s); drain under the current Hub before rollback`);
  }
  const names = fs.readdirSync(dir).filter((name) => name.startsWith(`${LEDGER}.segment.`)).sort();
  names.forEach((name, index) => {
    if (name !== `${LEDGER}.segment.${String(index + 1).padStart(8, '0')}`) fail('lease archive sequence is incomplete');
  });
  const active = path.join(dir, LEDGER);
  if (!fs.existsSync(active)) fail('active lease ledger is absent; let current Hub recover before rollback');
  const files = [...names.map((name) => path.join(dir, name)), active];
  const heads = files.map(regular);
  if (heads.reduce((total, stat) => total + stat.size, 0) >= OLD_LEDGER_MAX_BYTES) {
    fail('current lease history exceeds the previous runtime single-ledger ceiling; keep the current Hub runtime');
  }
  const keyFile = path.join(dir, KEYRING);
  const headFile = path.join(dir, HEAD);
  const keyBefore = regular(keyFile);
  const headBefore = regular(headFile);
  const keyring = readJson(keyFile);
  const head = readJson(headFile);
  if (keyring?.v !== 1 || !keyring.keys || typeof keyring.keys !== 'object'
    || head?.v !== 1 || !Number.isSafeInteger(head.eventCount) || head.eventCount < 1
    || typeof head.lastHash !== 'string' || !/^[a-f0-9]{64}$/.test(head.lastHash)
    || !Number.isSafeInteger(head.updatedAtMs)) fail('invalid lease keyring or checkpoint');
  const keyFor = (kid) => {
    const entry = keyring.keys[kid];
    if (!entry) fail('lease signature uses an unknown key');
    return publicKey(entry.publicKey);
  };
  const headFields = { v: 1, kid: head.kid, eventCount: head.eventCount,
    lastHash: head.lastHash, updatedAtMs: head.updatedAtMs };
  if (!signed('wickhunter.license.lease-head.v1\n', headFields, head.sig, keyFor(head.kid))) {
    fail('lease checkpoint signature is invalid');
  }
  const temp = `${output}.tmp.${process.pid}`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    const digest = createHash('sha256');
    let previousHash = null;
    let count = 0;
    let bytes = 0;
    for (const [index, file] of files.entries()) {
      const source = fs.readFileSync(file);
      if (source.length && source.at(-1) !== 0x0a) fail(`lease segment ${index + 1} has an incomplete final line`);
      if (index < files.length - 1 && !source.length) fail('lease archive is empty');
      for (const raw of source.toString('utf8').split('\n')) {
        if (!raw) continue;
        const line = JSON.parse(raw);
        if (line?.v !== 1 || !Object.hasOwn(line, 'previousHash') || line.previousHash !== previousHash
          || typeof line.kid !== 'string' || !line.event || typeof line.event !== 'object') {
          fail(`lease line ${count + 1} breaks the signed chain`);
        }
        const fields = { v: 1, kid: line.kid, previousHash: line.previousHash, event: line.event };
        if (!signed('wickhunter.license.lease-ledger.v1\n', fields, line.sig, keyFor(line.kid))) {
          fail(`lease line ${count + 1} signature is invalid`);
        }
        previousHash = sha(Buffer.from(JSON.stringify(line), 'utf8'));
        count++;
      }
      writeAll(fd, source);
      digest.update(source);
      bytes += source.length;
      if (!same(heads[index], regular(file))) fail('lease segment changed while exporting');
    }
    if (count !== head.eventCount || previousHash !== head.lastHash) {
      fail('current lease history does not match its signed checkpoint');
    }
    if (outboxExists !== fs.existsSync(outbox)
      || (outboxExists && fs.readdirSync(outbox).some((name) => name.endsWith('.json')))) {
      fail('Earn outbox changed while exporting');
    }
    if (!same(headBefore, regular(headFile)) || !same(keyBefore, regular(keyFile))) {
      fail('lease checkpoint or keyring changed while exporting');
    }
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.linkSync(temp, output); // no replacement of a pre-existing rollback export
    fs.unlinkSync(temp);
    const dirFd = fs.openSync(path.dirname(output), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    process.stdout.write(JSON.stringify({ ok: true, output, sha256: digest.digest('hex'),
      bytes, events: count, archives: names.length, headHash: head.lastHash }) + '\n');
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* temp may not exist */ }
    throw err;
  }
}

try { run(); } catch (err) { process.stderr.write(`rollback export refused: ${err.message}\n`); process.exitCode = 1; }
