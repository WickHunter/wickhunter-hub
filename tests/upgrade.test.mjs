// tests/upgrade.test.mjs — the hub's self-upgrade trigger.
// The route may only START the detached work (systemd-run so it survives the
// hub restarting itself); everything observable is the spawn call. Injected
// spawn — nothing real runs here.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { freshHub, jsonReq, test, summary, tmpDir } from "./helpers.mjs";

const calls = [];
function fakeSpawn(cmd, args, opts) {
  calls.push({ cmd, args, opts });
  const child = new EventEmitter();
  child.unref = () => { child.unrefd = true; };
  return child;
}

const srcDir = tmpDir("src");
const h = await freshHub({ srcDir }, { spawn: fakeSpawn });
const ADMIN = { "x-hub-admin": h.cfg.adminToken };

await test("upgrade is admin-gated", async () => {
  const anon = await jsonReq(`${h.origin}/admin/api/upgrade`, { method: "POST" });
  assert.equal(anon.status, 401);
  assert.equal(calls.length, 0);
});

await test("upgrade spawns ONE detached exact-origin/main runner for the configured srcDir", async () => {
  const r = await jsonReq(`${h.origin}/admin/api/upgrade`, { method: "POST", headers: ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.note, /upgrade queued/);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.cmd, "systemd-run");
  assert.ok(c.args.includes("--collect"));
  assert.ok(c.args.some((v) => /upgrade-runner\.js$/.test(v)), "the typed verifier/installer runner is used");
  assert.equal(c.args[c.args.indexOf("--source") + 1], srcDir);
  assert.equal(c.args[c.args.indexOf("--data") + 1], h.dataDir);
  assert.ok(!c.args.some((v) => /[;&|`] |\$\(/.test(v)), "no shell command is constructed from paths");
  assert.equal(c.opts.detached, true);
  const ops = await jsonReq(`${h.origin}/admin/api/operations`, { headers: ADMIN });
  assert.equal(ops.body.upgrade.state, "queued");
  assert.equal(ops.body.upgrade.fromCommit, null);
});

await test("a second upgrade while one is in flight is refused, and spawns nothing", async () => {
  const r = await jsonReq(`${h.origin}/admin/api/upgrade`, { method: "POST", headers: ADMIN });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already running/);
  assert.equal(calls.length, 1);
});

await test("the admin page carries the sign-in form, upgrade button and mobile plumbing", async () => {
  const res = await fetch(`${h.origin}/admin`);
  const html = await res.text();
  assert.ok(html.includes('autocomplete="current-password"'), "a REAL password field, so managers can autofill");
  assert.ok(html.includes('autocomplete="username"'), "hidden username anchors the saved credential");
  assert.ok(!html.includes("window.prompt"), "the prompt() sign-in is gone — it could never autofill");
  assert.ok(html.includes('id="upgradeHub"'), "the upgrade button exists");
  assert.ok(html.includes("/admin/api/upgrade"), "…and calls the upgrade API");
  assert.ok(html.includes("/admin/api/operations"), "exact build/source/runtime/upgrade facts are rendered");
  assert.ok(html.includes("Upgrade log tail"), "operator-visible upgrade failure evidence is rendered");
  assert.ok(html.includes('class="tbl"'), "tables scroll in their own container on phones");
  assert.ok(html.includes("width=device-width"), "viewport meta present");
  assert.ok(html.includes("font-size: 16px"), "password input holds 16px so iOS does not zoom");
});

await test("upgrade implementation verifies origin/main and records identity only after the new runtime answers", () => {
  const runner = fs.readFileSync(new URL("../bin/upgrade-runner.ts", import.meta.url), "utf8");
  assert.match(runner, /git[\s\S]*fetch[\s\S]*origin[\s\S]*main/);
  assert.match(runner, /merge[\s\S]*--ff-only[\s\S]*origin\/main/);
  assert.match(runner, /head !== originMain/);
  assert.match(runner, /HUB_EXPECTED_SOURCE_COMMIT/);
  assert.ok(!runner.includes('"/bin/bash"'), "the runner never constructs a command shell");

  const installer = fs.readFileSync(new URL("../install-hub.sh", import.meta.url), "utf8");
  const firstHealth = installer.indexOf('hub is up but on the wrong version');
  const record = installer.indexOf('node dist/bin/buildinfo.js');
  assert.ok(firstHealth >= 0 && record > firstHealth,
    "an attempted source is not recorded as the runtime until the restarted package version answers");
  assert.match(installer, /rotated machine-lease kid .* is not pre-provisioned/);
  assert.match(installer, /continuing the core Hub upgrade with lease issuance disabled/);
});

await h.close();
summary("upgrade");
