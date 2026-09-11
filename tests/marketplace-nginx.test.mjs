// tests/marketplace-nginx.test.mjs — HUB-02: the private Marketplace API's
// reverse-proxy config actually ships the properties the spec names —
// WebSocket upgrade with no response buffering, sane (not absent, not
// unboundedly long) idle timeouts well above the server's own heartbeat
// cadence, no access logging, and the loopback-only status-bridge route
// refused at the public edge. Text-assertion against the real shipped
// files (this box has no nginx binary to run `nginx -t` against — the same
// constraint `deploy/nginx-hub-site.conf` and `nginx/hub.locations.conf`
// already live under, with no test of their own beyond a human reading
// them; this at least pins the properties a human reviewer would check).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, summary } from "./helpers.mjs";

const STREAM_HEARTBEAT_MS = 3_000; // app repo's stream-server.ts, mirrored here as a comment target, not imported (separate repo)

const site = readFileSync(new URL("../deploy/nginx-marketplace-site.conf", import.meta.url), "utf8");
const locations = readFileSync(new URL("../nginx/marketplace-api.locations.conf", import.meta.url), "utf8");

function balanced(text, label) {
  const open = (text.match(/\{/g) || []).length;
  const close = (text.match(/\}/g) || []).length;
  assert.equal(open, close, `${label}: ${open} "{" vs ${close} "}"`);
}

function streamLocationBody(text) {
  const m = text.match(/location\s*=\s*\/api\/marketplace\/stream\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "an EXACT-match /api/marketplace/stream location block");
  return m[1];
}

for (const [label, text] of [["deploy/nginx-marketplace-site.conf", site], ["nginx/marketplace-api.locations.conf", locations]]) {
  await test(`${label} is syntactically balanced and reverse-proxies the stream endpoint with a real WebSocket upgrade`, () => {
    balanced(text, label);
    const stream = streamLocationBody(text);
    assert.match(stream, /proxy_http_version\s+1\.1;/);
    assert.match(stream, /proxy_set_header\s+Upgrade\s+\$http_upgrade;/);
    assert.match(stream, /proxy_set_header\s+Connection\s+"upgrade";/);
    assert.match(stream, /proxy_pass\s+http:\/\/127\.0\.0\.1:8099;/, "the private API's documented default port (MARKETPLACE_HTTP_PORT)");
  });

  await test(`${label} disables response buffering on the stream location so a frame is never queued`, () => {
    const stream = streamLocationBody(text);
    assert.match(stream, /proxy_buffering\s+off;/);
  });

  await test(`${label} sets an idle timeout on the stream location well above the server's own ${STREAM_HEARTBEAT_MS}ms heartbeat, and it is finite`, () => {
    const stream = streamLocationBody(text);
    const read = stream.match(/proxy_read_timeout\s+(\d+)s;/);
    const send = stream.match(/proxy_send_timeout\s+(\d+)s;/);
    assert.ok(read, "proxy_read_timeout is set");
    assert.ok(send, "proxy_send_timeout is set");
    const readSeconds = Number(read[1]);
    // "Sane", not absent (nginx's own default of 60s would already clear a
    // 3s heartbeat, so the bar here is that this is a DELIBERATE, bounded
    // value rather than nginx's unexamined default) and not an effectively
    // unbounded value that would hide a genuinely stuck backend for hours.
    assert.ok(readSeconds * 1000 > STREAM_HEARTBEAT_MS * 10, "generous enough that a healthy heartbeat is never cut");
    assert.ok(readSeconds <= 600, "bounded — a stalled connection is still reclaimed, not held forever");
  });

  await test(`${label} never logs this origin's requests (stream tickets and licence tokens must never land in an access log)`, () => {
    assert.match(text, /access_log\s+off;/);
  });

  await test(`${label} refuses the loopback-only status-bridge route at the public edge with an EXACT-match location`, () => {
    // `location =` is matched before any prefix `location`, whatever order
    // they appear in the file (nginx's own documented precedence) — so this
    // is a "does the exact refusal exist" check, not a text-ordering one.
    assert.match(text, /location\s*=\s*\/api\/marketplace\/operator\/status\s*\{\s*return\s+404;\s*\}/);
  });
}

function withoutComments(text) {
  return text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
}

await test("the standalone site is a complete TLS-terminating server, and the locations file is include-only (no server{} of its own)", () => {
  assert.match(site, /listen 443 ssl/);
  assert.match(site, /ssl_certificate\s/);
  assert.match(site, /server_name/);
  const locationsCode = withoutComments(locations);
  assert.doesNotMatch(locationsCode, /listen\s/, "an include snippet must never declare its own listener — that belongs to the server block it is included into");
  assert.doesNotMatch(locationsCode, /server_name/);
});

summary("marketplace-nginx");
