// tests/feedback.test.mjs — the tester feedback loop, hub side.
// Intake auth is the license token itself: genuine-but-EXPIRED may file
// (a lapsed tester reporting a bug is who we want to hear from), revoked and
// unknown may not. Admin gets list (sans logs), status moves, and the export
// download — the file the operator hands to their assistant for triage.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import {
  clampLogs,
  listFeedback,
  normalizeFeedbackAttachment,
  normalizeFeedbackDiagnostics,
  FEEDBACK_ATTACHMENT_BYTES_MAX,
  FEEDBACK_DIAGNOSTICS_BYTES_MAX,
  FEEDBACK_EVIDENCE_SCHEMA,
  FEEDBACK_LOG_LINES_MAX,
  FEEDBACK_LOGS_BYTES_MAX,
} from "../dist/src/feedback.js";

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
  assert.equal(r.body.evidenceSchema, FEEDBACK_EVIDENCE_SCHEMA, "intake explicitly acknowledges v2 evidence support");
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
  const r3 = await jsonReq(`${h.origin}/api/feedback`, { method: "POST", body: JSON.stringify(report({ text: "x".repeat(8_001) })) });
  assert.equal(r3.status, 400, "over-limit report text is refused rather than silently truncated");
});

await test("accidentally pasted credentials are redacted while report wording survives", async () => {
  const r = await jsonReq(`${h.origin}/api/feedback`, {
    method: "POST",
    body: JSON.stringify(report({
      text: 'Exchange error {"apiKey":"do-not-store","apiSecret":"also-private","authorization":"Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=="} while opening SOLUSDT',
    })),
  });
  assert.equal(r.status, 200);
  const saved = listFeedback(h.dataDir).find((x) => x.id === r.body.id);
  assert.match(saved.text, /Exchange error/);
  assert.match(saved.text, /SOLUSDT/);
  assert.match(saved.text, /\[redacted\]/);
  assert.ok(!saved.text.includes("do-not-store"));
  assert.ok(!saved.text.includes("also-private"));
  assert.ok(!saved.text.includes("QWxhZGRpbjpvcGVuIHNlc2FtZQ"));
  assert.match(saved.text, /while opening SOLUSDT/);
});

await test("single-quoted fields and unquoted authorization schemes are redacted without swallowing context", async () => {
  const r = await jsonReq(`${h.origin}/api/feedback`, {
    method: "POST",
    body: JSON.stringify(report({
      text: "Retry {'clientSecret':'CLIENTSECRET123456'} failed; Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ== while placing TP",
      logs: ['venue {"apiSecret":"LOGSECRET123456"} retry scheduled'],
    })),
  });
  assert.equal(r.status, 200);
  const saved = listFeedback(h.dataDir).find((x) => x.id === r.body.id);
  assert.match(saved.text, /^Retry /);
  assert.match(saved.text, /while placing TP$/);
  assert.ok(!JSON.stringify(saved).includes("CLIENTSECRET123456"));
  assert.ok(!JSON.stringify(saved).includes("QWxhZGRpbjpvcGVuIHNlc2FtZQ"));
  assert.ok(!JSON.stringify(saved).includes("LOGSECRET123456"));
  assert.match(saved.logs[0], /retry scheduled/);
});

await test("vendor authentication headers and multi-value Cookie headers are redacted", async () => {
  const r = await jsonReq(`${h.origin}/api/feedback`, {
    method: "POST",
    body: JSON.stringify(report({
      text: '{"x-api-key":"XHEADERSECRET123456","X-BAPI-API-KEY":"BYBITKEYSECRET123456","X-BAPI-SIGN":"BYBITSIGNATURE123456"}',
      logs: ["Cookie: session=COOKIESECRET123456; csrf=CSRFSECRET123456"],
    })),
  });
  assert.equal(r.status, 200);
  const saved = listFeedback(h.dataDir).find((x) => x.id === r.body.id);
  const serialized = JSON.stringify(saved);
  for (const secret of ["XHEADERSECRET123456", "BYBITKEYSECRET123456", "BYBITSIGNATURE123456", "COOKIESECRET123456", "CSRFSECRET123456"]) {
    assert.ok(!serialized.includes(secret));
  }
  assert.equal((saved.text.match(/\[redacted\]/g) || []).length, 3);
  assert.match(saved.logs[0], /Cookie=\[redacted\]/i);
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

await test("diagnostics are bounded and secret-shaped values are redacted at the hub boundary", async () => {
  const diagnostics = normalizeFeedbackDiagnostics({
    schemaVersion: 2,
    page: "terminal",
    context: "bybit-main:futures",
    logWindow: { included: 2, oldestAt: 1, newestAt: 2 },
    apiKey: "must-never-land",
    nested: { authorization: "Bearer must-never-land", note: "token=also-secret" },
  });
  assert.equal(diagnostics.page, "terminal");
  assert.equal(diagnostics.context, "bybit-main:futures");
  assert.equal(diagnostics.apiKey, "[redacted]");
  assert.equal(diagnostics.nested.authorization, "[redacted]");
  assert.ok(!JSON.stringify(diagnostics).includes("must-never-land"));
  assert.ok(!JSON.stringify(diagnostics).includes("also-secret"));

  // Numeric values did not spend the old string-only budget, while long keys
  // and JSON punctuation still occupy the tracker. Pin the actual UTF-8 JSON
  // contract rather than an estimate of selected value bytes.
  const pathological = { page: "terminal" };
  for (let group = 0; group < 20; group++) {
    const groupPrefix = `group_${String(group).padStart(2, "0")}_`;
    const values = {};
    for (let item = 0; item < 80; item++) {
      const prefix = `numeric_${String(group).padStart(2, "0")}_${String(item).padStart(2, "0")}_`;
      values[prefix + "x".repeat(80 - prefix.length)] = Number.MAX_VALUE;
    }
    pathological[groupPrefix + "g".repeat(80 - groupPrefix.length)] = values;
  }
  const exact = normalizeFeedbackDiagnostics(pathological);
  const exactBytes = Buffer.byteLength(JSON.stringify(exact), "utf8");
  assert.ok(exactBytes <= FEEDBACK_DIAGNOSTICS_BYTES_MAX, `${exactBytes} <= exact serialized cap`);
  assert.ok(exactBytes > FEEDBACK_DIAGNOSTICS_BYTES_MAX * 0.8, "the cap preserves useful early facts rather than dropping the snapshot");
  assert.equal(exact.page, "terminal");
  assert.ok(Object.keys(exact).length < Object.keys(pathological).length, "the pathological tail was pruned");
});

await test("picture validation accepts a real bounded raster and rejects spoofed or oversized data", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const ok = normalizeFeedbackAttachment({ name: "screen.png", mimeType: "image/png", base64: png });
  assert.equal(ok.ok, true);
  assert.equal(ok.attachment.mimeType, "image/png");
  assert.ok(ok.attachment.bytes > 0);
  assert.match(ok.attachment.sha256, /^[a-f0-9]{64}$/);
  assert.equal(normalizeFeedbackAttachment(null).attachment, null);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
  assert.equal(normalizeFeedbackAttachment({ name: "screen.jpg", mimeType: "image/jpeg", base64: jpeg.toString("base64") }).ok, true);
  const hugeJpeg = Buffer.from(jpeg);
  hugeJpeg.writeUInt16BE(10_000, 7); hugeJpeg.writeUInt16BE(10_000, 9);
  assert.equal(normalizeFeedbackAttachment({ name: "huge.jpg", mimeType: "image/jpeg", base64: hugeJpeg.toString("base64") }).ok, false);
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii"); webp.writeUInt32LE(22, 4); webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii"); webp.writeUInt32LE(10, 16); // zero width/height-minus-one = 1x1
  assert.equal(normalizeFeedbackAttachment({ name: "screen.webp", mimeType: "image/webp", base64: webp.toString("base64") }).ok, true);
  const hugeWebp = Buffer.from(webp);
  hugeWebp.writeUIntLE(9_999, 24, 3); hugeWebp.writeUIntLE(9_999, 27, 3);
  assert.equal(normalizeFeedbackAttachment({ name: "huge.webp", mimeType: "image/webp", base64: hugeWebp.toString("base64") }).ok, false);
  assert.equal(normalizeFeedbackAttachment({ name: "bad.svg", mimeType: "image/svg+xml", base64: Buffer.from("<svg/>").toString("base64") }).ok, false);
  assert.equal(normalizeFeedbackAttachment({ name: "fake.png", mimeType: "image/png", base64: Buffer.from("not a png").toString("base64") }).ok, false);
  const hugeCanvas = Buffer.from(png, "base64");
  hugeCanvas.writeUInt32BE(100_000, 16);
  hugeCanvas.writeUInt32BE(100_000, 20);
  const dimensions = normalizeFeedbackAttachment({ name: "huge-canvas.png", mimeType: "image/png", base64: hugeCanvas.toString("base64") });
  assert.equal(dimensions.ok, false);
  assert.match(dimensions.error, /dimensions must be at most/);
  const tooManyPixels = Buffer.from(png, "base64");
  tooManyPixels.writeUInt32BE(8_000, 16); tooManyPixels.writeUInt32BE(5_000, 20);
  assert.equal(normalizeFeedbackAttachment({ name: "too-many-pixels.png", mimeType: "image/png", base64: tooManyPixels.toString("base64") }).ok, false);
  assert.equal(normalizeFeedbackAttachment({
    name: "huge.png", mimeType: "image/png", base64: Buffer.alloc(FEEDBACK_ATTACHMENT_BYTES_MAX + 1).toString("base64"),
  }).ok, false);
});

await test("intake persists diagnostics + picture; list stays light and detail exposes debugging evidence", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const filed = await jsonReq(`${h.origin}/api/feedback`, {
    method: "POST",
    body: JSON.stringify(report({
      text: "chart blank while the hedge is open",
      diagnostics: {
        schemaVersion: 2,
        page: "hedge-bot",
        context: "bybit-main:futures",
        ui: { viewport: "1440x900", online: true, positionRows: 2, managedPositionRows: 1, hedgeOnlyPositionRows: 1 },
        managedPositions: [{ symbol: "BTCUSDT", positionKind: "managed" }],
        hedgeOnlyPositions: [{ symbol: "PYTHUSDT", positionKind: "hedge_only", readOnly: true }],
        password: "do-not-store-this",
      },
      attachment: { name: "hedge chart.png", mimeType: "image/png", base64: png },
    })),
  });
  assert.equal(filed.status, 200);

  const records = listFeedback(h.dataDir);
  const persisted = records.find((x) => x.id === filed.body.id);
  assert.ok(persisted.attachment.file);
  assert.equal(persisted.attachment.base64, undefined, "large bytes stay outside the JSONL tracker");
  assert.ok(!fs.readFileSync(path.join(h.dataDir, "feedback.jsonl"), "utf8").includes(png));
  assert.ok(fs.existsSync(path.join(h.dataDir, "feedback-attachments", persisted.attachment.file)));

  const list = await jsonReq(`${h.origin}/admin/api/feedback`, { headers: ADMIN });
  const summary = list.body.reports.find((x) => x.id === filed.body.id);
  assert.ok(summary);
  assert.equal(summary.logLines, 2);
  assert.equal(summary.hasAttachment, true);
  assert.equal(summary.attachmentBytes > 0, true);
  assert.equal(summary.page, "hedge-bot");
  assert.equal(summary.context, "bybit-main:futures");
  assert.equal(summary.positionRows, 2);
  assert.equal(summary.managedPositionRows, 1);
  assert.equal(summary.hedgeOnlyPositionRows, 1);
  assert.equal(summary.logs, undefined);
  assert.equal(summary.attachment, undefined, "base64 does not bloat the list response");

  const anon = await jsonReq(`${h.origin}/admin/api/feedback/detail?id=${encodeURIComponent(filed.body.id)}`);
  assert.equal(anon.status, 401);
  const detail = await jsonReq(`${h.origin}/admin/api/feedback/detail?id=${encodeURIComponent(filed.body.id)}`, { headers: ADMIN });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.report.diagnostics.page, "hedge-bot");
  assert.equal(detail.body.report.diagnostics.password, "[redacted]");
  assert.equal(detail.body.report.diagnostics.hedgeOnlyPositions[0].symbol, "PYTHUSDT");
  assert.equal(detail.body.report.attachment.base64, png);
  assert.deepEqual(detail.body.report.logs, ["12:00 line one", "12:01 line two"]);
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
  const pictured = body.reports.find((x) => x.text === "chart blank while the hedge is open");
  assert.ok(pictured && pictured.attachment.base64, "picture bytes ride the operator's export");
  const anon = await fetch(`${h.origin}/admin/api/feedback/export`);
  assert.equal(anon.status, 401);
});

await test("deleting a pictured report removes its separately stored evidence too", async () => {
  const rec = listFeedback(h.dataDir).find((x) => x.text === "chart blank while the hedge is open");
  const file = path.join(h.dataDir, "feedback-attachments", rec.attachment.file);
  assert.ok(fs.existsSync(file));
  const removed = await jsonReq(`${h.origin}/admin/api/feedback/delete`, {
    method: "POST", headers: ADMIN, body: JSON.stringify({ id: rec.id }),
  });
  assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(file), false);
});

// ── DELETE ──────────────────────────────────────────────────────────────────
// A real delete, not a fourth status: the export is the artifact handed over
// for triage, so a report the operator has finished with has to leave that too.
// It is therefore irreversible, and these pin that it removes exactly what was
// asked for and nothing else.

await test("delete removes ONE report and leaves the rest untouched", async () => {
  await jsonReq(`${h.origin}/api/feedback`, { method: "POST", body: JSON.stringify(report({ text: "delete me" })) });
  await jsonReq(`${h.origin}/api/feedback`, { method: "POST", body: JSON.stringify(report({ text: "keep me" })) });
  const before = listFeedback(h.dataDir);
  const doomed = before.find((r) => r.text === "delete me");
  const spared = before.find((r) => r.text === "keep me");

  const r = await jsonReq(`${h.origin}/admin/api/feedback/delete`, { method: "POST", headers: ADMIN, body: JSON.stringify({ id: doomed.id }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, 1, "it says how many it removed");

  const after = listFeedback(h.dataDir);
  assert.equal(after.length, before.length - 1, "exactly one fewer");
  assert.equal(after.find((x) => x.id === doomed.id), undefined, "the named one is gone");
  assert.ok(after.find((x) => x.id === spared.id), "its neighbour is not");
});

await test("a deleted report leaves the EXPORT too — the export is the copy of record", async () => {
  const rec = listFeedback(h.dataDir).find((r) => r.text === "keep me");
  await jsonReq(`${h.origin}/admin/api/feedback/delete`, { method: "POST", headers: ADMIN, body: JSON.stringify({ id: rec.id }) });
  const body = JSON.parse(await (await fetch(`${h.origin}/admin/api/feedback/export`, { headers: ADMIN })).text());
  assert.ok(!body.reports.some((x) => x.id === rec.id), "a deleted report is not still sitting in the triage file");
});

await test("many ids go in one call — clearing the fixed pile is not N requests", async () => {
  const ids = [];
  for (const text of ["batch a", "batch b", "batch c"]) {
    await jsonReq(`${h.origin}/api/feedback`, { method: "POST", body: JSON.stringify(report({ text })) });
    ids.push(listFeedback(h.dataDir).find((r) => r.text === text).id);
  }
  const before = listFeedback(h.dataDir).length;
  const r = await jsonReq(`${h.origin}/admin/api/feedback/delete`, { method: "POST", headers: ADMIN, body: JSON.stringify({ ids }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, 3);
  assert.equal(listFeedback(h.dataDir).length, before - 3);
});

await test("an id that matched nothing is a 404, never a quiet success", async () => {
  // The admin page drops the row on a 200. Reporting success for an id that is
  // still on disk under a different spelling would make the table lie.
  const before = listFeedback(h.dataDir).length;
  const r = await jsonReq(`${h.origin}/admin/api/feedback/delete`, { method: "POST", headers: ADMIN, body: JSON.stringify({ id: "no-such-id" }) });
  assert.equal(r.status, 404);
  assert.equal(listFeedback(h.dataDir).length, before, "and nothing was touched");
});

await test("delete is admin-gated and refuses a body with no id", async () => {
  const rec = listFeedback(h.dataDir)[0];
  const anon = await jsonReq(`${h.origin}/admin/api/feedback/delete`, { method: "POST", body: JSON.stringify({ id: rec.id }) });
  assert.equal(anon.status, 401, "no admin token, no delete");
  assert.ok(listFeedback(h.dataDir).some((x) => x.id === rec.id), "and the report survives the attempt");

  for (const body of [{}, { ids: [] }, { id: "" }, { ids: ["", null] }]) {
    const r = await jsonReq(`${h.origin}/admin/api/feedback/delete`, { method: "POST", headers: ADMIN, body: JSON.stringify(body) });
    assert.equal(r.status, 400, `refused: ${JSON.stringify(body)}`);
  }
});

await test("deleting the LAST report leaves a readable empty store, not a broken one", async () => {
  const solo = await freshHub();
  const key = solo.store.issue("Solo", 30);
  await jsonReq(`${solo.origin}/api/feedback`, { method: "POST", body: JSON.stringify({ ...report(), license: key.token, text: "only one" }) });
  const id = listFeedback(solo.dataDir)[0].id;
  const r = await jsonReq(`${solo.origin}/admin/api/feedback/delete`, {
    method: "POST", headers: { "x-hub-admin": solo.cfg.adminToken }, body: JSON.stringify({ id }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(listFeedback(solo.dataDir), [], "reads as empty rather than throwing");
  // And the store still accepts a new report afterwards — an emptied file must
  // not leave a stray blank line that the next append turns into a torn record.
  await jsonReq(`${solo.origin}/api/feedback`, { method: "POST", body: JSON.stringify({ ...report(), license: key.token, text: "after the purge" }) });
  const back = listFeedback(solo.dataDir);
  assert.equal(back.length, 1, "one report, cleanly parsed");
  assert.equal(back[0].text, "after the purge");
  await solo.close();
});

await test("a torn tail line in feedback.jsonl is skipped, never fatal", async () => {
  fs.appendFileSync(path.join(h.dataDir, "feedback.jsonl"), '{"half a rec');
  const before = listFeedback(h.dataDir).length;
  assert.ok(before >= 2); // intact records still read
  const r = await jsonReq(`${h.origin}/admin/api/feedback`, { headers: ADMIN });
  assert.equal(r.status, 200);
  assert.equal(r.body.reports.length, before);
});

await test("the admin page offers per-row Delete and a Delete-all-fixed, both confirmed first", async () => {
  const page = await (await fetch(`${h.origin}/admin`)).text();
  assert.ok(page.includes("/admin/api/feedback/delete"), "the page is wired to the delete endpoint");
  assert.ok(page.includes('id="fbClearFixed"'), "a bulk control for the fixed pile");
  // Deletion is irreversible and the export is the only copy, so neither path
  // may fire straight off a click.
  const deleteCalls = page.split("/admin/api/feedback/delete").length - 1;
  assert.equal(deleteCalls, 2, "exactly two callers: one row, one bulk");
  assert.ok((page.match(/confirm\(/g) ?? []).length >= 2, "both ask before deleting");
  assert.match(page, /cannot be undone/, "and the row prompt says so in words");
  assert.match(page, /Export first/, "the bulk prompt points at the export as the backup");
  assert.ok(page.includes("/admin/api/feedback/detail"), "report evidence is loaded on demand");
  assert.match(page, /Recent activity/, "the detail panel names the log evidence");
  assert.match(page, /Debug snapshot/, "the detail panel exposes structured diagnostics");
});

await h.close();
summary("feedback");
