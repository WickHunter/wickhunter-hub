// tests/hosting-bootstrap.test.mjs — the cloud-init script every instance
// boots with. The customer application artifact ships no reachability-probe
// module of its own (nothing server-side imports it, so the customer-build
// allowlist refuses it — liqhunter-private), so this script must gather
// venue statuses with plain curl, never assume python3/jq on a minimal
// image, and never leak the bootstrap token into a trace or an argv other
// processes on the box can read via /proc.
import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import { buildBootstrapUserData } from "../dist/src/hosting/bootstrap.js";
import { DEFAULT_PROBE_VENUES } from "../dist/src/hosting/policy.js";

const input = {
  instanceId: "host_abc123",
  generation: 2,
  bootstrapToken: "super-secret-token-value",
  hubOrigin: "https://hub.example.com",
  releaseRef: "v1.2.3",
  probeVenues: DEFAULT_PROBE_VENUES,
};

await test("no python3/jq dependency — plain curl only", () => {
  const script = buildBootstrapUserData(input);
  assert.doesNotMatch(script, /python3/);
  assert.doesNotMatch(script, /\bjq\b/);
  // The whole script body is itself wrapped in single quotes for
  // cloud-init's `bash -c '...'`, so every literal `'` inside it is
  // shell-escaped to `'\''` — that escaping is exactly what the "hostile
  // URL" test below proves is safe, so match the ESCAPED form here rather
  // than assuming the pre-wrap text survives unchanged.
  assert.match(script, /curl -s -o \/dev\/null -w '\\''%\{http_code\}'\\''/);
});

await test("every probe uses a 5s timeout and exactly one retry", () => {
  const script = buildBootstrapUserData(input);
  assert.match(script, /--max-time 5 --retry 1/);
});

await test("the token is exported into the environment, never interpolated into a curl argv, and is unset at the end", () => {
  const script = buildBootstrapUserData(input);
  assert.match(script, /export WH_BOOTSTRAP_TOKEN=/);
  assert.match(script, /unset WH_BOOTSTRAP_TOKEN/);
  // No curl call anywhere embeds the raw token as a bare command-line arg
  // (it may only appear inside the POST body's -d payload, built from the
  // env var, never a second literal copy).
  const curlLines = script.split("\n").filter((l) => l.includes("curl"));
  for (const line of curlLines) if (line.includes("super-secret-token-value")) assert.fail("token literal leaked into a curl invocation: " + line);
  assert.doesNotMatch(script, /set -x/);
});

await test("no company-wide provider/Stripe/email credential and no exchange secret appears anywhere in the script", () => {
  const script = buildBootstrapUserData(input);
  assert.doesNotMatch(script, /sk_(live|test)_/);
  assert.doesNotMatch(script, /whsec_/);
  assert.doesNotMatch(script, /vultr/i);
});

await test("the release ref is pinned, never 'latest'", () => {
  const script = buildBootstrapUserData(input);
  assert.match(script, /WH_RELEASE_REF='\\''v1\.2\.3'\\''/);
  assert.doesNotMatch(script, /latest/);
});

await test("posts back to THIS hub origin (via its own shell variable), naming the exact instance id and generation", () => {
  const script = buildBootstrapUserData(input);
  // WH_HUB_ORIGIN is a shell variable resolved at boot time on the real
  // instance, set from `hubOrigin` a few lines above — the literal URL is
  // never repeated a second time in the script.
  assert.match(script, /WH_HUB_ORIGIN='\\''https:\/\/hub\.example\.com'\\''/);
  assert.match(script, /"\$WH_HUB_ORIGIN\/api\/hosting\/instances\/\$WH_INSTANCE_ID\/readiness"/);
  assert.match(script, /WH_GENERATION=2/);
});

await test("every configured probe venue gets its own probe call, by id and by its exact URL", () => {
  const script = buildBootstrapUserData(input);
  // Plain substring checks, not a regex — the whole script is wrapped in a
  // single-quoted shell literal, so every `'` in it is escaped to the
  // 4-character sequence quote-backslash-quote-quote; building THAT as a
  // regex source correctly is error-prone (a backslash inside a regex
  // string is an escape introducer), where a literal `.includes()` is not.
  const q = "'\\''"; // the escaped single quote as it actually appears
  for (const v of DEFAULT_PROBE_VENUES) {
    assert.ok(script.includes(`probe ${q}${v.id}${q} ${q}${v.url}${q}`), `missing probe call for ${v.id}`);
  }
});

await test("a venue url containing a single quote cannot break out of the shell quoting (defence in depth for a future policy edit)", () => {
  const hostile = [{ id: "x", label: "X", method: "GET", url: "https://example.com/'; rm -rf / #", expectStatus: 200 }];
  const script = buildBootstrapUserData({ ...input, probeVenues: hostile });
  // The dangerous substring must be neutralised by shell single-quote
  // escaping (`'\''`), never left as a bare unescaped quote.
  assert.doesNotMatch(script, /example\.com\/'; rm -rf/);
});

summary("hosting-bootstrap");
