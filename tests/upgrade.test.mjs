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

await test("upgrade spawns ONE detached systemd-run pulling the configured srcDir", async () => {
  const r = await jsonReq(`${h.origin}/admin/api/upgrade`, { method: "POST", headers: ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.note, /upgrade started/);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.cmd, "systemd-run");
  assert.ok(c.args.includes("--collect"));
  const script = c.args[c.args.length - 1];
  assert.ok(script.includes(JSON.stringify(srcDir)), "the shell line names the source checkout");
  assert.ok(script.includes("git pull --ff-only"), "fast-forward pull only — never a merge on the box");
  assert.ok(script.includes("install-hub.sh"), "the installer is what applies the upgrade");
  assert.ok(script.includes("upgrade.log"), "output lands in a log the operator can read");
  assert.equal(c.opts.detached, true);
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
  assert.ok(html.includes('class="tbl"'), "tables scroll in their own container on phones");
  assert.ok(html.includes("width=device-width"), "viewport meta present");
  assert.ok(html.includes("font-size: 16px"), "password input holds 16px so iOS does not zoom");
});

await h.close();
summary("upgrade");
