// tests/feedback-limits.test.mjs — abuse, durable-capacity and streamed-export
// contracts for the internet-facing tester feedback surface.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freshHub, test, summary } from "./helpers.mjs";
import { createHub } from "../dist/src/server.js";
import {
  appendFeedback,
  deleteFeedback,
  feedbackExport,
  FeedbackRateLimiter,
  listFeedback,
  normalizeFeedbackAttachment,
  setFeedbackStatus,
  FEEDBACK_AUTH_RATE_LICENSE_MAX,
  FEEDBACK_ATTACHMENTS_BYTES_MAX,
  FEEDBACK_ATTACHMENT_BYTES_MAX,
  FEEDBACK_EVIDENCE_SCHEMA,
  FEEDBACK_LICENSE_RECORDS_MAX,
  FEEDBACK_RATE_IP_MAX,
  FEEDBACK_RATE_LICENSE_MAX,
  FEEDBACK_RATE_WINDOW_MS,
  FEEDBACK_RAW_RATE_IP_MAX,
  FEEDBACK_RAW_RATE_WINDOW_MS,
  FEEDBACK_RECORDS_MAX,
  FEEDBACK_TRACKER_BYTES_MAX,
} from "../dist/src/feedback.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PICTURE = normalizeFeedbackAttachment({ name: "evidence.png", mimeType: "image/png", base64: PNG_BASE64 }).attachment;

function wireReport(token, text = "feedback capacity probe", overrides = {}) {
  return {
    license: token,
    kind: "bug",
    text,
    version: "0.89.92",
    installId: "feedback-limits-test",
    ts: 1_800_000_000_000,
    logs: [],
    ...overrides,
  };
}

async function postFeedback(h, token, text, ip = "203.0.113.10", overrides = {}) {
  const response = await fetch(`${h.origin}/api/feedback`, {
    method: "POST",
    headers: { "x-forwarded-for": ip },
    body: JSON.stringify(wireReport(token, text, overrides)),
  });
  const body = await response.json();
  return { response, body };
}

function appendInput(licenseId, text, attachment = null) {
  return {
    ts: 1_800_000_000_000,
    ip: "203.0.113.10",
    licenseId,
    name: "Capacity Tester",
    installId: "feedback-limits-test",
    version: "0.89.92",
    kind: "bug",
    text,
    logs: [],
    logsTruncated: false,
    diagnostics: {},
    attachment,
  };
}

function storedRow(id, licenseId, at, attachment = null) {
  return {
    id,
    at,
    ts: at,
    ip: "203.0.113.10",
    licenseId,
    name: "Stored Tester",
    installId: "stored-test",
    version: "0.89.92",
    kind: "bug",
    text: `stored ${id}`,
    logs: [],
    logsTruncated: false,
    diagnostics: {},
    attachment,
    status: "new",
  };
}

await test("successful reports are bounded per licence with Retry-After and reset at the rolling window", async () => {
  let now = 1_800_000_000_000;
  const h = await freshHub({}, { feedbackNow: () => now });
  try {
    const key = h.store.issue("Rate Licence", 30);
    const malformed = await postFeedback(h, key.token, "bad kind does not spend success", "203.0.113.10", { kind: "rant" });
    assert.equal(malformed.response.status, 400);
    for (let i = 0; i < FEEDBACK_RATE_LICENSE_MAX; i++) {
      const filed = await postFeedback(h, key.token, `licence accepted ${i}`);
      assert.equal(filed.response.status, 200);
      assert.deepEqual(Object.keys(filed.body).sort(), ["evidenceSchema", "id", "ok"]);
      assert.equal(filed.body.evidenceSchema, FEEDBACK_EVIDENCE_SCHEMA);
    }
    const limited = await postFeedback(h, key.token, "licence refused");
    assert.equal(limited.response.status, 429);
    assert.equal(limited.response.headers.get("retry-after"), String(FEEDBACK_RATE_WINDOW_MS / 1_000));
    assert.equal(limited.response.headers.get("cache-control"), "no-store");
    assert.equal(limited.body.retryAfterSeconds, FEEDBACK_RATE_WINDOW_MS / 1_000);
    assert.equal(listFeedback(h.dataDir).length, FEEDBACK_RATE_LICENSE_MAX);

    now += FEEDBACK_RATE_WINDOW_MS;
    const reset = await postFeedback(h, key.token, "licence accepted after reset");
    assert.equal(reset.response.status, 200);
  } finally {
    await h.close();
  }
});

await test("the raw source gate stops floods before auth without consuming accepted allowance", async () => {
  let now = 1_800_100_000_000;
  const h = await freshHub({}, { feedbackNow: () => now });
  try {
    const ip = "198.51.100.30";
    for (let i = 0; i < FEEDBACK_RAW_RATE_IP_MAX; i++) {
      const refused = await postFeedback(h, "LHK1.not-genuine.signature", `garbage ${i}`, ip);
      assert.equal(refused.response.status, 403);
    }
    const flooded = await postFeedback(h, "LHK1.not-genuine.signature", "one too many", ip);
    assert.equal(flooded.response.status, 429);
    assert.equal(flooded.response.headers.get("retry-after"), String(FEEDBACK_RAW_RATE_WINDOW_MS / 1_000));

    now += FEEDBACK_RAW_RATE_WINDOW_MS;
    const key = h.store.issue("After Flood", 30);
    const accepted = await postFeedback(h, key.token, "valid after raw reset", ip);
    assert.equal(accepted.response.status, 200, "failed authentication never spent the accepted bucket");
  } finally {
    await h.close();
  }
});

await test("one authenticated licence cannot spread malformed evidence across source IPs forever", async () => {
  let now = 1_800_150_000_000;
  const h = await freshHub({}, { feedbackNow: () => now });
  try {
    const key = h.store.issue("Malformed Flood", 30);
    const malformed = { attachment: { name: "fake.png", mimeType: "image/png", base64: Buffer.from("not a png").toString("base64") } };
    for (let i = 0; i < FEEDBACK_AUTH_RATE_LICENSE_MAX; i++) {
      const refused = await postFeedback(h, key.token, `malformed ${i}`, `198.51.100.${i + 1}`, malformed);
      assert.equal(refused.response.status, 400);
    }
    const limited = await postFeedback(h, key.token, "malformed over auth limit", "198.51.100.31", malformed);
    assert.equal(limited.response.status, 429);
    assert.equal(limited.response.headers.get("retry-after"), String(FEEDBACK_RATE_WINDOW_MS / 1_000));
    assert.equal(listFeedback(h.dataDir).length, 0);
  } finally {
    await h.close();
  }
});

await test("one authenticated licence cannot repeat expensive quota failures across source IPs", async () => {
  let now = 1_800_175_000_000;
  const h = await freshHub({}, { feedbackNow: () => now });
  try {
    const key = h.store.issue("Quota Flood", 30);
    const tracker = path.join(h.dataDir, "feedback.jsonl");
    const rows = Array.from({ length: FEEDBACK_RECORDS_MAX }, (_, i) => {
      const id = `quota-${String(i).padStart(8, "0")}`;
      return JSON.stringify(storedRow(id, `other-${Math.floor(i / 50)}`, now + i));
    });
    fs.writeFileSync(tracker, `${rows.join("\n")}\n`, { mode: 0o600 });
    const before = fs.readFileSync(tracker);
    for (let i = 0; i < FEEDBACK_AUTH_RATE_LICENSE_MAX; i++) {
      const refused = await postFeedback(h, key.token, `quota failure ${i}`, `203.0.113.${i + 20}`);
      assert.equal(refused.response.status, 507);
    }
    const limited = await postFeedback(h, key.token, "quota failure over auth limit", "203.0.113.50");
    assert.equal(limited.response.status, 429);
    assert.deepEqual(fs.readFileSync(tracker), before);
  } finally {
    await h.close();
  }
});

await test("attacker-controlled rate keys collapse into a bounded shared overflow bucket", () => {
  const limiter = new FeedbackRateLimiter();
  let refused = 0;
  for (let i = 0; i < 5_000; i++) {
    if (!limiter.takeIpAttempt(`2001:db8::${i.toString(16)}`, 1_800_180_000_000).ok) refused++;
  }
  assert.ok(refused > 0, "new source strings stop receiving independent buckets at the key ceiling");
  assert.equal(limiter.takeIpAttempt("a-fresh-source", 1_800_180_000_000 + FEEDBACK_RAW_RATE_WINDOW_MS).ok, true);
});

await test("successfully stored reports are independently bounded per source IP", async () => {
  let now = 1_800_200_000_000;
  const h = await freshHub({}, { feedbackNow: () => now });
  try {
    const keys = Array.from({ length: 7 }, (_, i) => h.store.issue(`NAT Tester ${i}`, 30));
    const sharedIp = "203.0.113.77";
    let accepted = 0;
    for (let batch = 0; batch < 6; batch++) {
      for (let i = 0; i < 10; i++) {
        const filed = await postFeedback(h, keys[batch].token, `shared IP ${accepted}`, sharedIp);
        assert.equal(filed.response.status, 200);
        accepted++;
      }
      now += FEEDBACK_RAW_RATE_WINDOW_MS + 1;
    }
    assert.equal(accepted, FEEDBACK_RATE_IP_MAX);
    const limited = await postFeedback(h, keys[6].token, "shared IP refused", sharedIp);
    assert.equal(limited.response.status, 429);
    assert.ok(Number(limited.response.headers.get("retry-after")) > 0);
    const otherSource = await postFeedback(h, keys[6].token, "other IP accepted", "203.0.113.78");
    assert.equal(otherSource.response.status, 200, "an IP refusal does not spend the unused licence bucket");
  } finally {
    await h.close();
  }
});

await test("the per-licence report quota refuses atomically and an explicit delete frees room", async () => {
  const h = await freshHub();
  let firstClosed = false;
  let restarted = null;
  try {
    const key = h.store.issue("Full Licence", 30);
    for (let i = 0; i < FEEDBACK_LICENSE_RECORDS_MAX; i++) {
      appendFeedback(h.dataDir, appendInput(key.payload.id, `persisted ${i}`), 1_800_300_000_000 + i);
    }
    const tracker = path.join(h.dataDir, "feedback.jsonl");
    const before = fs.readFileSync(tracker);
    const refused = await postFeedback(h, key.token, "must not partially land");
    assert.equal(refused.response.status, 507);
    assert.equal(refused.response.headers.get("cache-control"), "no-store");
    assert.match(refused.body.error, /no report was written/i);
    assert.deepEqual(fs.readFileSync(tracker), before);
    assert.equal(listFeedback(h.dataDir).length, FEEDBACK_LICENSE_RECORDS_MAX);

    await h.close();
    firstClosed = true;
    restarted = createHub(h.cfg, { candleSleep: async () => {} });
    const port = await restarted.listen();
    const restartedHttp = { origin: `http://127.0.0.1:${port}` };
    const stillRefused = await postFeedback(restartedHttp, key.token, "restart cannot reset disk quota", "203.0.113.14");
    assert.equal(stillRefused.response.status, 507);

    assert.equal(deleteFeedback(h.dataDir, [listFeedback(h.dataDir)[0].id]), 1);
    const accepted = await postFeedback(restartedHttp, key.token, "fits after operator cleanup", "203.0.113.14");
    assert.equal(accepted.response.status, 200);
    assert.equal(listFeedback(h.dataDir).length, FEEDBACK_LICENSE_RECORDS_MAX);
  } finally {
    if (restarted) await restarted.close();
    else if (!firstClosed) await h.close();
  }
});

await test("global count and tracker-byte ceilings reject before mutating persistent state", async () => {
  const h = await freshHub();
  try {
    const key = h.store.issue("Global Full", 30);
    const tracker = path.join(h.dataDir, "feedback.jsonl");
    const rows = Array.from({ length: FEEDBACK_RECORDS_MAX }, (_, i) => {
      const id = `global-${String(i).padStart(8, "0")}`;
      return JSON.stringify(storedRow(id, `licence-${Math.floor(i / 50)}`, 1_800_400_000_000 + i));
    });
    fs.writeFileSync(tracker, `${rows.join("\n")}\n`, { mode: 0o600 });
    const countBytes = fs.readFileSync(tracker);
    const countRefusal = await postFeedback(h, key.token, "global count refusal");
    assert.equal(countRefusal.response.status, 507);
    assert.deepEqual(fs.readFileSync(tracker), countBytes);

    fs.truncateSync(tracker, FEEDBACK_TRACKER_BYTES_MAX);
    const byteRefusal = await postFeedback(h, key.token, "tracker byte refusal", "203.0.113.11");
    assert.equal(byteRefusal.response.status, 507);
    assert.equal(fs.statSync(tracker).size, FEEDBACK_TRACKER_BYTES_MAX);

    fs.truncateSync(tracker, 0);
    for (let i = 0; i < FEEDBACK_RATE_LICENSE_MAX; i++) {
      const filed = await postFeedback(h, key.token, `accepted after quota refusal ${i}`, "203.0.113.11");
      assert.equal(filed.response.status, 200);
    }
    const rateRefusal = await postFeedback(h, key.token, "accepted bucket is now full", "203.0.113.11");
    assert.equal(rateRefusal.response.status, 429, "the two 507s did not consume accepted-report allowance");
  } finally {
    await h.close();
  }
});

await test("combined-byte and filesystem-free ceilings are enforced before any write", async () => {
  const cases = [
    {
      name: "Hub combined bytes",
      limits: { storageBytesMax: 1 },
      error: /this Hub \(1 byte combined maximum\)/,
    },
    {
      name: "licence combined bytes",
      limits: { licenseStorageBytesMax: 1 },
      error: /this license \(1 byte combined maximum\)/,
    },
    {
      name: "filesystem reserve",
      limits: { filesystemFreeMin: Number.MAX_SAFE_INTEGER },
      error: /filesystem .*free-space reserve/,
    },
  ];

  for (const probe of cases) {
    const h = await freshHub({}, { feedbackStorageLimits: probe.limits });
    try {
      const key = h.store.issue(probe.name, 30);
      const refused = await postFeedback(h, key.token, `${probe.name} refusal`);
      assert.equal(refused.response.status, 507, probe.name);
      assert.equal(refused.response.headers.get("cache-control"), "no-store");
      assert.match(refused.body.error, probe.error);
      assert.equal(fs.existsSync(path.join(h.dataDir, "feedback.jsonl")), false, `${probe.name} wrote no tracker`);
      assert.equal(fs.existsSync(path.join(h.dataDir, "feedback-attachments")), false, `${probe.name} wrote no attachment directory`);
    } finally {
      await h.close();
    }
  }
});

await test("actual orphan bytes count, exact quota fit is allowed, and overflow never auto-deletes", async () => {
  const h = await freshHub();
  try {
    const key = h.store.issue("Orphan Quota", 30);
    const dir = path.join(h.dataDir, "feedback-attachments");
    const orphan = path.join(dir, "crash-left-image.tmp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(orphan, "");
    fs.truncateSync(orphan, FEEDBACK_ATTACHMENTS_BYTES_MAX - PICTURE.bytes);
    const exactFit = await postFeedback(h, key.token, "picture exactly fits", "203.0.113.12", {
      attachment: { name: "new.png", mimeType: "image/png", base64: PNG_BASE64 },
    });
    assert.equal(exactFit.response.status, 200, "equality is inside the hard ceiling");
    const namesAtLimit = fs.readdirSync(dir).sort();
    const bytesAtLimit = namesAtLimit.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
    assert.equal(bytesAtLimit, FEEDBACK_ATTACHMENTS_BYTES_MAX);

    const refused = await postFeedback(h, key.token, "one picture over the ceiling", "203.0.113.12", {
      attachment: { name: "overflow.png", mimeType: "image/png", base64: PNG_BASE64 },
    });
    assert.equal(refused.response.status, 507);
    assert.deepEqual(fs.readdirSync(dir).sort(), namesAtLimit);
    assert.equal(fs.statSync(orphan).size, FEEDBACK_ATTACHMENTS_BYTES_MAX - PICTURE.bytes);
    assert.equal(listFeedback(h.dataDir).length, 1);
  } finally {
    await h.close();
  }
});

await test("per-licence picture quota charges durable metadata and cleanup frees room", async () => {
  const h = await freshHub();
  try {
    const key = h.store.issue("Picture Full", 30);
    const tracker = path.join(h.dataDir, "feedback.jsonl");
    const rows = Array.from({ length: 16 }, (_, i) => {
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
      const attachment = {
        file: `${id}.png`, name: "historic.png", mimeType: "image/png",
        bytes: FEEDBACK_ATTACHMENT_BYTES_MAX, sha256: "0".repeat(64),
      };
      return storedRow(id, key.payload.id, 1_800_500_000_000 + i, attachment);
    });
    fs.writeFileSync(tracker, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
    const before = fs.readFileSync(tracker);
    const refused = await postFeedback(h, key.token, "licence picture refusal", "203.0.113.13", {
      attachment: { name: "new.png", mimeType: "image/png", base64: PNG_BASE64 },
    });
    assert.equal(refused.response.status, 507);
    assert.deepEqual(fs.readFileSync(tracker), before);
    assert.equal(fs.existsSync(path.join(h.dataDir, "feedback-attachments")), false);

    assert.equal(deleteFeedback(h.dataDir, [rows[0].id]), 1);
    const accepted = await postFeedback(h, key.token, "licence picture after cleanup", "203.0.113.13", {
      attachment: { name: "new.png", mimeType: "image/png", base64: PNG_BASE64 },
    });
    assert.equal(accepted.response.status, 200);
  } finally {
    await h.close();
  }
});

await test("an append failure rolls back the complete image and returns a clear 507", async () => {
  const h = await freshHub();
  const originalAppend = fs.appendFileSync;
  try {
    const key = h.store.issue("Rollback Tester", 30);
    fs.appendFileSync = function (file, ...args) {
      if (path.basename(String(file)) === "feedback.jsonl") {
        const error = new Error("simulated full filesystem");
        error.code = "ENOSPC";
        throw error;
      }
      return originalAppend.call(this, file, ...args);
    };
    const refused = await postFeedback(h, key.token, "image and row are one unit", "203.0.113.90", {
      attachment: { name: "rollback.png", mimeType: "image/png", base64: PNG_BASE64 },
    });
    assert.equal(refused.response.status, 507);
    assert.match(refused.body.error, /no complete report was written/i);
    assert.equal(fs.existsSync(path.join(h.dataDir, "feedback.jsonl")), false);
    const attachmentDir = path.join(h.dataDir, "feedback-attachments");
    assert.deepEqual(fs.existsSync(attachmentDir) ? fs.readdirSync(attachmentDir) : [], []);
  } finally {
    fs.appendFileSync = originalAppend;
    await h.close();
  }
});

await test("export is lazy per attachment, valid newest-first JSON, and has no full-body length", async () => {
  const h = await freshHub();
  try {
    const oversized = appendFeedback(h.dataDir, appendInput("export-licence", "oversized evidence", PICTURE), 1_800_599_999_999);
    const older = appendFeedback(h.dataDir, appendInput("export-licence", "older evidence", PICTURE), 1_800_600_000_000);
    appendFeedback(h.dataDir, appendInput("export-licence", "newer evidence", PICTURE), 1_800_600_000_001);
    const iterator = feedbackExport(h.dataDir);
    const first = iterator.next();
    assert.equal(first.value.text, "newer evidence");
    assert.equal(first.value.attachment.base64, PNG_BASE64);

    const olderFile = path.join(h.dataDir, "feedback-attachments", older.attachment.file);
    fs.unlinkSync(olderFile);
    const second = iterator.next();
    assert.equal(second.value.text, "older evidence");
    assert.equal(second.value.attachment, null, "the older attachment was not hydrated ahead of iteration");
    assert.equal(second.value.attachmentUnavailable, true);
    const oversizedFile = path.join(h.dataDir, "feedback-attachments", oversized.attachment.file);
    fs.truncateSync(oversizedFile, FEEDBACK_ATTACHMENT_BYTES_MAX + 1);
    const third = iterator.next();
    assert.equal(third.value.text, "oversized evidence");
    assert.equal(third.value.attachment, null, "externally enlarged evidence is refused before a large read");
    assert.equal(third.value.attachmentUnavailable, true);
    iterator.return();

    const response = await fetch(`${h.origin}/admin/api/feedback/export`, {
      headers: { "x-hub-admin": h.cfg.adminToken },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), null, "streamed export must not be materialized for a length");
    assert.equal(response.headers.get("x-accel-buffering"), "no", "nginx must preserve end-to-end export backpressure");
    const exported = JSON.parse(await response.text());
    assert.equal(exported.hubVersion, "0.3.17");
    assert.deepEqual(exported.reports.map((row) => row.text), ["newer evidence", "older evidence", "oversized evidence"]);
    assert.equal(exported.reports[1].attachment, null);
    assert.equal(exported.reports[1].attachmentUnavailable, true);
    assert.equal(exported.reports[2].attachment, null);
    assert.equal(exported.reports[2].attachmentUnavailable, true);
  } finally {
    await h.close();
  }
});

await test("legacy dimension-bomb evidence is never decoded into the admin image surface", async () => {
  const h = await freshHub();
  try {
    const dangerous = Buffer.from(PNG_BASE64, "base64");
    dangerous.writeUInt32BE(100_000, 16);
    dangerous.writeUInt32BE(100_000, 20);
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const file = `${id}.png`;
    const dir = path.join(h.dataDir, "feedback-attachments");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), dangerous);
    const attachment = {
      file, name: "legacy-danger.png", mimeType: "image/png", bytes: dangerous.length,
      sha256: createHash("sha256").update(dangerous).digest("hex"),
    };
    fs.writeFileSync(path.join(h.dataDir, "feedback.jsonl"), `${JSON.stringify(storedRow(id, "legacy", 1, attachment))}\n`);
    const response = await fetch(`${h.origin}/admin/api/feedback/export`, { headers: { "x-hub-admin": h.cfg.adminToken } });
    const exported = JSON.parse(await response.text());
    assert.equal(exported.reports[0].attachment, null);
    assert.equal(exported.reports[0].attachmentUnavailable, true);
  } finally {
    await h.close();
  }
});

await test("an export iterator is a stable snapshot across rewrite and later append", async () => {
  const h = await freshHub();
  try {
    const older = appendFeedback(h.dataDir, appendInput("snapshot", "snapshot older"), 10);
    appendFeedback(h.dataDir, appendInput("snapshot", "snapshot newer"), 20);
    const snapshot = feedbackExport(h.dataDir);
    assert.equal(snapshot.next().value.text, "snapshot newer");
    assert.equal(setFeedbackStatus(h.dataDir, older.id, "fixed"), true); // atomic tracker rename
    appendFeedback(h.dataDir, appendInput("snapshot", "appended later"), 30);
    const oldSecond = snapshot.next();
    assert.equal(oldSecond.value.text, "snapshot older");
    assert.equal(oldSecond.value.status, "new", "the open snapshot keeps the pre-rewrite row");
    assert.equal(snapshot.next().done, true, "a later append is outside the starting file size");

    const current = [...feedbackExport(h.dataDir)];
    assert.deepEqual(current.map((row) => row.text), ["appended later", "snapshot newer", "snapshot older"]);
    assert.equal(current[2].status, "fixed", "a new export sees the completed rewrite");
  } finally {
    await h.close();
  }
});

await test("admin export streams to a chosen file and nginx raises only the feedback body limit", async () => {
  const page = fs.readFileSync(path.join(ROOT, "public", "admin.html"), "utf8");
  assert.match(page, /showSaveFilePicker/);
  assert.match(page, /res\.body\.pipeTo\(writable\)/);
  assert.match(page, /buffered in memory/);

  const nginx = fs.readFileSync(path.join(ROOT, "nginx", "hub.locations.conf"), "utf8");
  const exact = nginx.match(/location = \/hub\/api\/feedback \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const generic = nginx.match(/location \/hub\/ \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(exact, /proxy_pass http:\/\/127\.0\.0\.1:8091\/api\/feedback;/);
  assert.match(exact, /client_max_body_size 4m;/);
  assert.match(exact, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(generic, /client_max_body_size 1m;/);
  assert.doesNotMatch(generic, /client_max_body_size 4m;/);
});

summary("feedback limits");
