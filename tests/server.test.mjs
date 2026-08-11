// tests/server.test.mjs — the tester-facing surface over real HTTP on a
// loopback ephemeral port: health, check-ins, keyed downloads, install.sh.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { readRoster } from "../dist/src/checkins.js";

const h = await freshHub();
const { token } = h.store.issue("Valid Tester", 30);

// Publish a fake release into the temp releases dir.
const tarball = Buffer.from("not really gzip but the hub does not care\n");
const relName = "wickhunter-beta-0.9.0.tar.gz";
fs.writeFileSync(path.join(h.releasesDir, relName), tarball);
fs.writeFileSync(
  path.join(h.releasesDir, "latest.json"),
  JSON.stringify({ version: "0.9.0", file: relName, sha256: createHash("sha256").update(tarball).digest("hex") }),
);

await test("HUB_VERSION, package.json and the changelog agree — nothing drifts on a comment", async () => {
  // v0.2.7 — this is the test that did not exist. `src/version.ts` said 0.2.1
  // while package.json said 0.2.6: five releases reported themselves as a build
  // that had not run for hours, on the admin page and on /api/health alike.
  const { HUB_VERSION } = await import("../dist/src/version.js");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(HUB_VERSION, pkg.version, "src/version.ts must match package.json");
  // And the changelog's newest entry, so a release cannot ship undocumented.
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const newest = /^- v(\d+\.\d+\.\d+)/m.exec(readme.slice(readme.indexOf("## Changelog")));
  assert.ok(newest, "the changelog has a versioned newest entry");
  assert.equal(newest[1], pkg.version, "the newest changelog entry must name this version");
});

await test("health reports ok + version", async () => {
  const r = await jsonReq(`${h.origin}/api/health`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.version, /^\d+\.\d+\.\d+$/);
});

await test("checkin records to jsonl + roster and answers ok", async () => {
  const lic = h.store.issue("Checkin Tester", 30).payload;
  const r = await jsonReq(`${h.origin}/api/license/checkin`, {
    method: "POST",
    body: JSON.stringify({ licenseId: lic.id, installId: "inst-1", version: "0.9.0", ts: 1723000000000 }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, latest: "0.9.0" }); // no revoked flag; latest rides along for the bot's update banner
  const lines = fs.readFileSync(path.join(h.dataDir, "checkins.jsonl"), "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.licenseId, lic.id);
  assert.equal(last.installId, "inst-1");
  assert.equal(typeof last.ip, "string");
  const roster = readRoster(h.dataDir);
  assert.equal(roster[lic.id].version, "0.9.0");
  assert.equal(roster[lic.id].checkins, 1);
});

await test("checkin for a revoked license answers revoked:true (and still records)", async () => {
  const lic = h.store.issue("Revoked Tester", 30).payload;
  h.store.revoke(lic.id);
  const r = await jsonReq(`${h.origin}/api/license/checkin`, {
    method: "POST",
    body: JSON.stringify({ licenseId: lic.id, installId: "inst-2", version: "0.9.0", ts: Date.now() }),
  });
  assert.deepEqual(r.body, { ok: true, revoked: true, latest: "0.9.0" });
  assert.equal(readRoster(h.dataDir)[lic.id].installId, "inst-2");
});

await test("checkin for an id this hub never issued answers revoked:true", async () => {
  const r = await jsonReq(`${h.origin}/api/license/checkin`, {
    method: "POST",
    body: JSON.stringify({ licenseId: "not-ours", installId: "inst-3", version: "0.9.0", ts: Date.now() }),
  });
  assert.deepEqual(r.body, { ok: true, revoked: true, latest: "0.9.0" });
});

await test("malformed checkin body is a 400", async () => {
  for (const body of ["not json", "[]", JSON.stringify({ licenseId: "x" })]) {
    const r = await jsonReq(`${h.origin}/api/license/checkin`, { method: "POST", body });
    assert.equal(r.status, 400, `body: ${body}`);
  }
});

await test("download with a valid key serves the exact bytes", async () => {
  const res = await fetch(`${h.origin}/download/${relName}?key=${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/gzip");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), tarball);
});

await test("download/latest resolves through latest.json", async () => {
  const res = await fetch(`${h.origin}/download/latest?key=${token}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), tarball);
  assert.match(res.headers.get("content-disposition"), new RegExp(relName));
});

await test("api/latest returns the release metadata", async () => {
  const r = await jsonReq(`${h.origin}/api/latest?key=${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.version, "0.9.0");
  assert.equal(r.body.file, relName);
  assert.match(r.body.sha256, /^[0-9a-f]{64}$/);
});

await test("download without / with a bad key is 403", async () => {
  for (const qs of ["", "?key=", "?key=LHK1.garbage.garbage"]) {
    const res = await fetch(`${h.origin}/download/${relName}${qs}`);
    assert.equal(res.status, 403, `qs: ${qs}`);
  }
});

await test("download with an EXPIRED key is 403", async () => {
  // A validly signed token whose exp is already in the past: issue a 1-day
  // license with a clock backdated 3 days.
  const expired = h.store.issue("Expired Tester", 1, Date.now() - 3 * 86_400_000);
  const res = await fetch(`${h.origin}/download/${relName}?key=${expired.token}`);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /expired/);
});

await test("download with a REVOKED key is 403", async () => {
  const rev = h.store.issue("Revoked DL", 30);
  h.store.revoke(rev.payload.id);
  const res = await fetch(`${h.origin}/download/${relName}?key=${rev.token}`);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /revoked/);
});

await test("path traversal and unlisted files are 404", async () => {
  for (const name of ["..%2F..%2Fetc%2Fpasswd", "..", ".hidden", "nope.tar.gz"]) {
    const res = await fetch(`${h.origin}/download/${name}?key=${token}`);
    assert.equal(res.status, 404, `name: ${name}`);
  }
});

await test("install.sh is templated with the hub origin and the key", async () => {
  const res = await fetch(`${h.origin}/install.sh?key=${token}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /shellscript/);
  const script = await res.text();
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.ok(script.includes(`HUB="${h.cfg.publicOrigin}"`), "origin substituted");
  assert.ok(script.includes(`KEY="${token}"`), "key substituted");
  assert.ok(!script.includes("__HUB_ORIGIN__") && !script.includes("__LICENSE_KEY__"), "no placeholders left");
});

await test("install.sh with a bad key is 403", async () => {
  const res = await fetch(`${h.origin}/install.sh?key=nope`);
  assert.equal(res.status, 403);
});

await test("unknown routes are 404", async () => {
  const r = await jsonReq(`${h.origin}/api/nope`);
  assert.equal(r.status, 404);
});

await h.close();
summary("server");
