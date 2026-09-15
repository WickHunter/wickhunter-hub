// tests/hosting-bootstrap.test.mjs — the cloud-init script every instance
// boots with. The customer application artifact ships no reachability-probe
// module of its own (nothing server-side imports it, so the customer-build
// allowlist refuses it — liqhunter-private), so this script must gather
// venue statuses with plain curl, never assume python3/jq on a minimal
// image, and never leak the bootstrap token into a trace or an argv other
// processes on the box can read via /proc.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test, summary } from "./helpers.mjs";
import { buildBootstrapUserData } from "../dist/src/hosting/bootstrap.js";
import { DEFAULT_PROBE_VENUES } from "../dist/src/hosting/policy.js";

const input = {
  instanceId: "host_abc123",
  generation: 2,
  bootstrapToken: "super-secret-token-value",
  hubOrigin: "https://hub.example.com",
  maxAccounts: 5,
  probeVenues: DEFAULT_PROBE_VENUES,
};

function commandOf(userData) {
  const document = JSON.parse(userData.replace(/^#cloud-config\n/, ""));
  assert.deepEqual(document.runcmd[0].slice(0, 2), ["bash", "-c"]);
  return document.runcmd[0][2];
}

await test("cloud-init is a real JSON/YAML document carrying one bash command", () => {
  const document = JSON.parse(buildBootstrapUserData(input).replace(/^#cloud-config\n/, ""));
  assert.equal(document.runcmd.length, 1);
  assert.deepEqual(document.runcmd[0].slice(0, 2), ["bash", "-c"]);
  assert.match(document.runcmd[0][2], /^#!\/usr\/bin\/env bash\n/);
});

await test("no python3/jq dependency — plain curl only", () => {
  const script = commandOf(buildBootstrapUserData(input));
  assert.doesNotMatch(script, /python3/);
  assert.doesNotMatch(script, /\bjq\b/);
  assert.match(script, /curl -s -o \/dev\/null -w '%\{http_code\}'/);
});

await test("every probe uses a 5s timeout and exactly one retry", () => {
  const script = commandOf(buildBootstrapUserData(input));
  assert.match(script, /--max-time 5 --retry 1/);
  assert.match(script, /case "\$observed" in \[0-9\]\[0-9\]\[0-9\]\)/);
  assert.doesNotMatch(script, /\|\| echo 0/);
});

await test("the token is exported into the environment, never interpolated into a curl argv, and is unset at the end", () => {
  const script = commandOf(buildBootstrapUserData(input));
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
  const script = commandOf(buildBootstrapUserData(input));
  assert.doesNotMatch(script, /sk_(live|test)_/);
  assert.doesNotMatch(script, /whsec_/);
  assert.doesNotMatch(script, /vultr/i);
});

await test("the bootstrap requests its server-pinned installer, never an unpinned latest release", () => {
  const script = commandOf(buildBootstrapUserData(input));
  assert.doesNotMatch(script, /WH_RELEASE_REF/);
  assert.doesNotMatch(script, /latest/);
  assert.match(script, /\/api\/hosting\/instances\/\$WH_INSTANCE_ID\/installer/);
});

await test("the signed installer completes before any readiness probe runs", () => {
  const script = commandOf(buildBootstrapUserData(input));
  const installerRoute = script.indexOf("/installer");
  const installRun = script.indexOf('bash "$INSTALLER"');
  const firstProbe = script.indexOf("https://api.bybit.com/v5/market/time");
  assert.ok(installerRoute > 0 && installRun > installerRoute, "fetches and runs the instance-scoped installer");
  assert.ok(firstProbe > installRun, "venue probes cannot mark an uninstalled box ready");
  assert.match(script, /--data-binary @-/);
  assert.doesNotMatch(script, /installer\?token=/);
});

await test("hosted login is derived with domain separation and never echoes the bootstrap token", () => {
  const script = commandOf(buildBootstrapUserData(input));
  assert.match(script, /TOKEN_HASH=.*sha256sum/);
  assert.match(script, /TOKEN_HASH:password:v1/);
  assert.match(script, /export LIQHUNTER_BOOTSTRAP_PASSWORD/);
  assert.match(script, /unset LIQHUNTER_BOOTSTRAP_PASSWORD/);
  assert.match(script, /WH_HOSTED_MAX_ACCOUNTS=5/);
  assert.match(script, /export LIQHUNTER_HOSTED_MAX_ACCOUNTS/);
});

await test("the shared installer seeds only the forced-change credential for hosted installs, then removes its env copy", () => {
  const installer = fs.readFileSync(new URL("../templates/install.sh", import.meta.url), "utf8");
  const hosted = installer.indexOf('BOOTSTRAP_PW=${LIQHUNTER_BOOTSTRAP_PASSWORD');
  const removeLogin = installer.indexOf("unset_env LIQHUNTER_LOGIN_PASSWORD", hosted);
  const setBootstrap = installer.indexOf('set_env LIQHUNTER_BOOTSTRAP_PASSWORD "$BOOTSTRAP_PW"', removeLogin);
  const verifyRecord = installer.indexOf("VERIFY_BOOTSTRAP_CREDENTIAL", setBootstrap);
  const clearBootstrap = installer.indexOf("unset_env LIQHUNTER_BOOTSTRAP_PASSWORD", verifyRecord);
  assert.ok(hosted > 0 && removeLogin > hosted && setBootstrap > removeLogin);
  assert.ok(verifyRecord > setBootstrap && clearBootstrap > verifyRecord, "plaintext env copy is removed only after the durable must-change record is proved");
  assert.match(installer, /record\.createdFrom !== "bootstrap" \|\| record\.mustChange !== true/);
  assert.match(installer, /LIQHUNTER_HOSTED_MAX_ACCOUNTS/);
  assert.match(installer, /PINNED_RELEASE_B64U="__PINNED_RELEASE_B64U__"/);
  assert.match(installer, /manifest\[field\] !== pinned\[field\]/);
});

await test("posts back to THIS hub origin (via its own shell variable), naming the exact instance id and generation", () => {
  const script = commandOf(buildBootstrapUserData(input));
  // WH_HUB_ORIGIN is a shell variable resolved at boot time on the real
  // instance, set from `hubOrigin` a few lines above — the literal URL is
  // never repeated a second time in the script.
  assert.match(script, /WH_HUB_ORIGIN='https:\/\/hub\.example\.com'/);
  assert.match(script, /"\$WH_HUB_ORIGIN\/api\/hosting\/instances\/\$WH_INSTANCE_ID\/readiness"/);
  assert.match(script, /WH_GENERATION=2/);
  assert.match(script, /--retry 2 --retry-delay 1/);
  assert.match(script, /--data-binary @-/);
  assert.doesNotMatch(script, / -d "\{\\"token/);
});

await test("every configured probe venue gets its own probe call, by id and by its exact URL", () => {
  const script = commandOf(buildBootstrapUserData(input));
  const q = "'";
  for (const v of DEFAULT_PROBE_VENUES) {
    assert.ok(script.includes(`probe ${q}${v.id}${q} ${q}${v.url}${q}`), `missing probe call for ${v.id}`);
  }
});

await test("a venue url containing a single quote cannot break out of the shell quoting (defence in depth for a future policy edit)", () => {
  const hostile = [{ id: "x", label: "X", method: "GET", url: "https://example.com/'; rm -rf / #", expectStatus: 200 }];
  const script = commandOf(buildBootstrapUserData({ ...input, probeVenues: hostile }));
  // The dangerous substring must be neutralised by shell single-quote
  // escaping (`'\''`), never left as a bare unescaped quote.
  assert.doesNotMatch(script, /example\.com\/'; rm -rf/);
});

summary("hosting-bootstrap");
