// tests/feedback.test.mjs — the tester feedback loop, hub side.
// Intake auth is the license token itself: genuine-but-EXPIRED may file
// (a lapsed tester reporting a bug is who we want to hear from), revoked and
// unknown may not. Admin gets list (sans logs), status moves, and the export
// download — the file the operator hands to their assistant for triage.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { clampLogs, listFeedback, FEEDBACK_LOG_LINES_MAX, FEEDBACK_LOGS_BYTES_MAX } from "../dist/src/feedback.js";

const h = await freshHub();
const good = h.store.issue("Reporter", 30);
const ADMIN = { "x-hub-admin": h.cfg.adminToken };

function report(overrides = {}) {
  return {
    license: good.token,
    kind: "bug",
    text: "DCA rested twice on ONUSDT",
    version: "0.74.27",
    installId: "inst-fb-1",
    ts: 1723000000000,
    logs: ["12:00 line one", "12:01 line two"],
    ...overrides,
  };
}

await test("a genuine license files a report; the record carries the verified name, never a claimed one", async () => {
  const r = await jsonReq(`${h.origin}/api/feedback`, { method: "POST", body: JSON.stringify({ ...report(), name: "Impostor" }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.id);
  const all = listFeedback(h.dataDir);
  assert.equal(all.length, 1);
  assert.equal(all[0].name, "Reporter"); // from the token payload
  assert.equal(all[0].licenseId, good.payload.id);
  assert.equal(all[0].kind, "bug");
  assert.deepEqual(all[0].logs, ["12:00 line one", "12:01 line two"]);
  assert.equal(all[0].status, "new");
});

await test("an EXPIRED-but-genuine license may still file", async () => {
  const lapsed = h.store.issue("Lapsed", 1, Date.now() - 2 * 86_400_000); // issued 2 days ago, 1-day term = expired yesterday
  assert.equal(h.store.verify(lapsed.token).ok, false); // precondition: really expired
  const r = await jsonReq(`${h.origin}/api/feedback`, {
    method: "POST",
    body: JSON.stringify(report({ license: lapsed.token, text: "expired but heard" })),
  });
  assert.equal(r.status, 200);
  assert.ok(listFeedback(h.dataDir).some((x) => x.text === "expired but heard" && x.name === "Lapsed"));
});

await test("a REVOKED license is refused; so is garbage and a foreign-key token", async () => {
  const revoked = h.store.issue("Banned", 30);
  h.store.revoke(revoked.payload.id);
  const r1 = await jsonReq(`${h.origin}/api/feedback`, { method: "POST", body: JSON.stringify(report({ license: revoked.token })) });
  assert.equal(r1.status, 403);
  const r2 = await jsonReq(`${h.origin}/api/feedback`, { method: "POST", body: JSON.stringify(report({ license: "LHK1.garbage.sig" })) });
  assert.equal(r2.status, 403);
  const r3 = await jsonReq(`${h.origin}/api/feedback`, { method: "POST", body: JSON.stringify(report({ license: "" })) });
  assert.equal(r3.status, 403);
  assert.equal(listFeedback(h.dataDir).filter((x) => x.name === "Banned").length, 0);
});

await test("bad kind and empty text are 400s, not silent drops", async () => {
  const r1 = await jsonReq(`${h.origin}/api/feedback`, { method: "POST", body: JSON.stringify(report({ kind: "rant" })) });
  assert.equal(r1.status, 400);
  const r2 = await jsonReq(`${h.origin}/api/feedback`, { method: "POST", body: JSON.stringify(report({ text: "   " })) });
  assert.equal(r2.status, 400);
});

await test("clampLogs: row cap, line cap, byte cap — oldest dropped, truncation flagged", async () => {
  const many = Array.from({ length: FEEDBACK_LOG_LINES_MAX + 50 }, (_, i) => `line ${i}`);
  const capped = clampLogs(many);
  assert.equal(capped.logs.length, FEEDBACK_LOG_LINES_MAX);
  assert.equal(capped.logs[0], "line 50"); // oldest 50 dropped
  assert.equal(capped.truncated, true);

  const fat = Array.from({ length: 200 }, (_, i) => `${i}:${"x".repeat(1_900)}`);
  const bytes = clampLogs(fat);
  const total = bytes.logs.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  assert.ok(total <= FEEDBACK_LOGS_BYTES_MAX);
  assert.equal(bytes.truncated, true);
  assert.ok(bytes.logs[bytes.logs.length - 1].startsWith("199:")); // newest kept

  assert.deepEqual(clampLogs("not an array"), { logs: [], truncated: false });
  const mixed = clampLogs(["ok", 42, "also ok"]);
  assert.deepEqual(mixed.logs, ["ok", "also ok"]);
  assert.equal(mixed.truncated, true); // the non-string was dropped, say so
});

await test("admin list is auth-gated, newest-first, and carries counts instead of logs", async () => {
  const anon = await jsonReq(`${h.origin}/admin/api/feedback`);
  assert.equal(anon.status, 401);
  const r = await jsonReq(`${h.origin}/admin/api/feedback`, { headers: ADMIN });
  assert.equal(r.status, 200);
  assert.ok(r.body.reports.length >= 2);
  assert.ok(r.body.reports.every((x) => x.logs === undefined && typeof x.logLines === "number"));
  for (let i = 1; i < r.body.reports.length; i++) assert.ok(r.body.reports[i - 1].at >= r.body.reports[i].at);
});

await test("status moves new → discussing → fixed; junk status and unknown id are refused", async () => {
  const id = listFeedback(h.dataDir)[0].id;
  for (const status of ["discussing", "fixed"]) {
    const r = await jsonReq(`${h.origin}/admin/api/feedback/status`, { method: "POST", headers: ADMIN, body: JSON.stringify({ id, status }) });
    assert.equal(r.status, 200);
    assert.equal(listFeedback(h.dataDir).find((x) => x.id === id).status, status);
  }
  const bad = await jsonReq(`${h.origin}/admin/api/feedback/status`, { method: "POST", headers: ADMIN, body: JSON.stringify({ id, status: "wontfix" }) });
  assert.equal(bad.status, 400);
  const missing = await jsonReq(`${h.origin}/admin/api/feedback/status`, { method: "POST", headers: ADMIN, body: JSON.stringify({ id: "nope", status: "fixed" }) });
  assert.equal(missing.status, 404);
});

await test("export downloads the WHOLE set, logs included, as a named attachment", async () => {
  const res = await fetch(`${h.origin}/admin/api/feedback/export`, { headers: ADMIN });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="wickhunter-feedback-\d{4}-\d{2}-\d{2}\.json"/);
  const body = JSON.parse(await res.text());
  assert.ok(body.exportedAt > 0);
  assert.ok(Array.isArray(body.reports) && body.reports.length >= 2);
  assert.ok(body.reports.some((x) => Array.isArray(x.logs) && x.logs.length > 0)); // logs ride the export
  const anon = await fetch(`${h.origin}/admin/api/feedback/export`);
  assert.equal(anon.status, 401);
});

await test("a torn tail line in feedback.jsonl is skipped, never fatal", async () => {
  fs.appendFileSync(path.join(h.dataDir, "feedback.jsonl"), '{"half a rec');
  const before = listFeedback(h.dataDir).length;
  assert.ok(before >= 2); // intact records still read
  const r = await jsonReq(`${h.origin}/admin/api/feedback`, { headers: ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.body.reports.length, before);
});

await h.close();
summary("feedback");
