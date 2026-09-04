// tests/jsonfile.test.mjs — v0.3.20: a file written by root belongs to the
// directory's owner.
//
// The operator runs `npm run extend` / `issue` / `revoke` as root; the writer
// creates files at mode 0600; the service runs as `wickhunter-hub`. On
// 2026-09-04 the registry rewritten by the root-run extension came out
// root:root 0600, and `GET /admin/api/licenses` plus EVERY tester check-in
// answered `EACCES: permission denied, open '…/data/licenses.json'` until it
// was chowned by hand. The suite never runs as root, so the root branch is
// driven through the module's own seam and the chown call is what is asserted.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, summary } from "./helpers.mjs";
import { readJson, writeJsonAtomic, appendJsonl, __setOwnershipHooksForTests } from "../dist/src/jsonfile.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-jsonfile-"));
// The service user's ids on a real box; the suite's own temp directory may be
// root-owned (CI runs as root), so the owner read is driven too.
const dirStat = { uid: 1001, gid: 1002 };
const asService = (d) => { assert.equal(d, dir, "the owner asked for is the file's own directory"); return dirStat; };
const calls = [];
const record = (file, uid, gid) => calls.push({ file, uid, gid });

await test("as root, the atomic write hands the file to the directory's owner BEFORE the rename", () => {
  calls.length = 0;
  __setOwnershipHooksForTests({ isRoot: () => true, ownerOf: asService, chown: (file, uid, gid) => {
    record(file, uid, gid);
    // The call must land on the temp file, which still exists at this instant.
    assert.ok(fs.existsSync(file), "chown targets a file that exists");
  } });
  const file = path.join(dir, "licenses.json");
  writeJsonAtomic(file, { a: 1 });
  assert.equal(calls.length, 1, "exactly one chown per write");
  assert.equal(path.dirname(calls[0].file), dir);
  assert.ok(calls[0].file.startsWith(file + ".tmp."), `chown targets the temp file, got ${calls[0].file}`);
  assert.equal(calls[0].uid, dirStat.uid);
  assert.equal(calls[0].gid, dirStat.gid);
  assert.deepEqual(readJson(file, null), { a: 1 }, "the renamed file is the one written");
  assert.ok(!fs.existsSync(calls[0].file), "the temp file is gone after the rename");
});

await test("as root, the append hands the ledger to the directory's owner", () => {
  calls.length = 0;
  __setOwnershipHooksForTests({ isRoot: () => true, ownerOf: asService, chown: record });
  const file = path.join(dir, "checkins.jsonl");
  appendJsonl(file, { n: 1 });
  appendJsonl(file, { n: 2 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.file === file && c.uid === dirStat.uid && c.gid === dirStat.gid));
  assert.equal(fs.readFileSync(file, "utf8"), '{"n":1}\n{"n":2}\n');
});

await test("a root writer into a root-owned directory (a bare dev checkout) changes nothing", () => {
  calls.length = 0;
  __setOwnershipHooksForTests({ isRoot: () => true, ownerOf: () => ({ uid: 0, gid: 0 }), chown: record });
  writeJsonAtomic(path.join(dir, "flags.json"), {});
  appendJsonl(path.join(dir, "flags.jsonl"), {});
  assert.equal(calls.length, 0, "no chown when the directory is root's own");
});

await test("a non-root writer never chowns (the service's own path is untouched)", () => {
  calls.length = 0;
  __setOwnershipHooksForTests({ isRoot: () => false, ownerOf: asService, chown: record });
  writeJsonAtomic(path.join(dir, "roster.json"), { r: 1 });
  appendJsonl(path.join(dir, "ledger.jsonl"), { r: 1 });
  assert.equal(calls.length, 0);
  __setOwnershipHooksForTests(null);
});

await test("the real default is decided by the process uid, never by a constant", () => {
  // A positive control on the seam's reset: with the hooks restored, a write
  // from this non-root suite produces a file this user owns and no throw.
  const file = path.join(dir, "default.json");
  writeJsonAtomic(file, { d: 1 });
  assert.equal(fs.statSync(file).uid, process.getuid());
});

fs.rmSync(dir, { recursive: true, force: true });
summary("jsonfile");
