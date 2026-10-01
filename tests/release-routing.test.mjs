import assert from "node:assert/strict";
import { createHash, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { EARLY_ACCESS_ELIGIBILITY_FLAG, setFlag } from "../dist/src/flags.js";
import { releaseSigningBytes, verifyReleaseManifest } from "../dist/src/release-manifest.js";
import { compareReleaseVersions, parseCustomerReleaseChannel, productionTransition } from "../dist/src/release-routing.js";
import { freshHub, jsonReq, test, summary, tmpDir } from "./helpers.mjs";

function signedRelease(h, shelf, channel, version, artifact, sourceCommit = "a".repeat(40), arch = "x64") {
  fs.mkdirSync(shelf, { recursive: true });
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const unsigned = {
    schema: "wickhunter.release.v1", product: "wickhunter", channel, platform: "linux", arch,
    version, buildId: `build-${channel}-${version}-${sha256.slice(0, 8)}`,
    file: `wickhunter-${channel}-${version}.tar.gz`, sha256, sourceCommit,
    issuedAt: new Date().toISOString(), minUpdateProtocol: 1,
  };
  const manifest = { ...unsigned, signatures: [{
    kid: h.releaseSigner.kid, alg: "Ed25519",
    sig: edSign(null, releaseSigningBytes(unsigned), h.releaseSigner.privateKey).toString("base64url"),
  }] };
  fs.writeFileSync(path.join(shelf, manifest.file), artifact);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(shelf, `manifest-${sha256}.json`), manifestBytes);
  fs.writeFileSync(path.join(shelf, "latest.json"), manifestBytes);
  return manifest;
}

function requestHeaders(token, channel, optIn = false) {
  return { "x-license": token, "x-release-channel": channel, ...(optIn ? { "x-early-access-opt-in": "true" } : {}) };
}
async function channelReq(url, opts = {}) {
  const res = await fetch(url, opts);
  const body = await res.json();
  return { status: res.status, body, headers: res.headers };
}

await test("customer release channel parser keeps Alpha private and transition is forward-only", () => {
  assert.equal(parseCustomerReleaseChannel("beta"), "beta");
  assert.equal(parseCustomerReleaseChannel("production"), "production");
  assert.throws(() => parseCustomerReleaseChannel("alpha"), /private/);
  assert.throws(() => parseCustomerReleaseChannel("canary"), /unknown/);
  assert.equal(compareReleaseVersions("1.10.0", "1.9.99"), 1);
  const installed = { channel: "beta", version: "1.4.0", sha256: "a".repeat(64) };
  assert.equal(productionTransition(installed, { channel: "production", version: "1.3.0", sha256: "b".repeat(64) }), "waiting-for-production");
  assert.equal(productionTransition(installed, { channel: "production", version: "1.4.0", sha256: "a".repeat(64) }), "current-same-artifact");
  assert.equal(productionTransition(installed, { channel: "production", version: "1.4.1", sha256: "c".repeat(64) }), "update-available");
  assert.equal(productionTransition(installed, { channel: "production", version: "1.4.0", sha256: "d".repeat(64) }), "waiting-for-production");
});

await test("legacy routes remain Beta while feature-off explicit channel routes stay dark", async () => {
  const h = await freshHub();
  try {
    const { token } = h.store.issue("Legacy Beta", 30);
    const beta = signedRelease(h, h.releasesDir, "beta", "1.0.0", Buffer.from("legacy beta package"));
    const oldLatest = await jsonReq(`${h.origin}/api/latest?key=${token}`);
    assert.equal(oldLatest.status, 200);
    assert.equal(oldLatest.body.channel, "beta");
    const dark = await jsonReq(`${h.origin}/api/releases/production/latest`, { headers: requestHeaders(token, "production") });
    assert.equal(dark.status, 404);
    assert.match(dark.body.error, /not enabled/);
    const darkInstaller = await jsonReq(`${h.origin}/install/channels/production.sh`, { headers: requestHeaders(token, "production") });
    assert.equal(darkInstaller.status, 404);
    assert.match(darkInstaller.body.error, /not enabled/);
    assert.equal(beta.channel, "beta");
  } finally { await h.close(); }
});

await test("Beta needs a matching explicit opt-in and an individual Hub eligibility flag", async () => {
  const productionDir = tmpDir("release-routing-production");
  const h = await freshHub({ releaseRoutingEnabled: true, productionReleasesDir: productionDir });
  try {
    const issued = h.store.issue("Early Access", 30);
    const beta = signedRelease(h, h.releasesDir, "beta", "1.0.0", Buffer.from("beta package"));
    let response = await channelReq(`${h.origin}/api/releases/beta/latest`, { headers: requestHeaders(issued.token, "beta") });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /opt-in/);
    response = await channelReq(`${h.origin}/api/releases/beta/latest`, { headers: requestHeaders(issued.token, "beta", true) });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /not enabled/);
    assert.equal(setFlag(h.dataDir, "default", EARLY_ACCESS_ELIGIBILITY_FLAG, true).default[EARLY_ACCESS_ELIGIBILITY_FLAG], true);
    response = await channelReq(`${h.origin}/api/releases/beta/latest`, { headers: requestHeaders(issued.token, "beta", true) });
    assert.equal(response.status, 403, "a global flag never grants Early Access eligibility");
    setFlag(h.dataDir, issued.payload.id, EARLY_ACCESS_ELIGIBILITY_FLAG, true);
    response = await channelReq(`${h.origin}/api/releases/beta/latest`, { headers: requestHeaders(issued.token, "beta", true) });
    assert.equal(response.status, 200);
    assert.equal(response.body.channel, "beta");
    assert.equal(response.headers.get("x-release-status"), "update-available");
    assert.equal(response.body.sha256, beta.sha256);
    const download = await fetch(`${h.origin}/api/releases/beta/download/latest`, { headers: requestHeaders(issued.token, "beta", true) });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from("beta package"));
    const mismatchedHeader = await jsonReq(`${h.origin}/api/releases/beta/latest`, { headers: requestHeaders(issued.token, "production", true) });
    assert.equal(mismatchedHeader.status, 400);
    const alpha = await jsonReq(`${h.origin}/api/releases/alpha/latest`, { headers: requestHeaders(issued.token, "alpha") });
    assert.equal(alpha.status, 404);
  } finally { await h.close(); }
});

await test("Production has no Beta fallback and same archive may have a separately signed Production manifest", async () => {
  const productionDir = tmpDir("release-routing-production");
  const h = await freshHub({ releaseRoutingEnabled: true, productionReleasesDir: productionDir });
  try {
    const { token } = h.store.issue("Production", 30);
    const archive = Buffer.from("same signed customer archive");
    const beta = signedRelease(h, h.releasesDir, "beta", "1.2.0", archive);
    const absent = await jsonReq(`${h.origin}/api/releases/production/latest`, { headers: requestHeaders(token, "production") });
    assert.equal(absent.status, 404);
    assert.equal(absent.body.channel, "production");
    assert.equal(absent.body.status, "unavailable");
    assert.equal(Object.hasOwn(absent.body, "file"), false);

    const production = signedRelease(h, productionDir, "production", "1.2.0", archive);
    assert.equal(beta.sha256, production.sha256);
    assert.notDeepEqual(beta.signatures, production.signatures, "the channel-bound manifests are signed separately");
    const installedQuery = new URLSearchParams({ installedChannel: "beta", installedVersion: beta.version, installedBuildId: beta.buildId, installedSha256: beta.sha256 });
    const current = await channelReq(`${h.origin}/api/releases/production/latest?${installedQuery}`, { headers: requestHeaders(token, "production") });
    assert.equal(current.status, 200);
    assert.equal(current.body.channel, "production");
    assert.equal(current.headers.get("x-release-status"), "current-same-artifact");
    const verified = verifyReleaseManifest(current.body, { publicKeys: h.releaseSigner.publicKeys, now: Date.now(), maxAgeMs: 30 * 86400_000, channel: "production", platform: "linux", arch: "x64" });
    assert.equal(verified.sha256, beta.sha256);
  } finally { await h.close(); }
});

await test("explicit channel installers are gated, pinned to their own signed shelf, and never change legacy Beta", async () => {
  const productionDir = tmpDir("installer-production");
  const h = await freshHub({ releaseRoutingEnabled: true, productionReleasesDir: productionDir });
  try {
    const issued = h.store.issue("Channel installer", 30);
    const beta = signedRelease(h, h.releasesDir, "beta", "1.0.0", Buffer.from("beta archive"));
    const legacy = await fetch(`${h.origin}/install.sh?key=${issued.token}`);
    assert.equal(legacy.status, 200);
    const legacyScript = await legacy.text();
    assert.match(legacyScript, /INSTALL_CHANNEL="beta"/);
    assert.match(legacyScript, /CHANNEL_AWARE="0"/);
    const base = `${h.origin}/install/channels`;
    const productionHeaders = requestHeaders(issued.token, "production");
    const missing = await channelReq(`${base}/production.sh`, { headers: productionHeaders });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.status, "unavailable");
    assert.equal((await fetch(`${base}/alpha.sh`, { headers: requestHeaders(issued.token, "alpha") })).status, 404);
    assert.equal((await fetch(`${base}/production.sh`, { headers: requestHeaders("not-a-license", "production") })).status, 403);
    assert.equal((await fetch(`${base}/production.sh`, { headers: requestHeaders(issued.token, "beta") })).status, 400);
    assert.equal((await fetch(`${base}/beta.sh`, { headers: requestHeaders(issued.token, "beta", true) })).status, 403,
      "an opt-in header alone cannot grant Beta eligibility");
    setFlag(h.dataDir, issued.payload.id, EARLY_ACCESS_ELIGIBILITY_FLAG, true);
    assert.equal((await fetch(`${base}/beta.sh`, { headers: requestHeaders(issued.token, "beta") })).status, 403,
      "eligibility alone cannot opt the customer into Beta");
    const explicitBeta = await fetch(`${base}/beta.sh`, { headers: requestHeaders(issued.token, "beta", true) });
    assert.equal(explicitBeta.status, 200);
    const betaScript = await explicitBeta.text();
    assert.match(betaScript, /INSTALL_CHANNEL="beta"/);
    assert.match(betaScript, /CHANNEL_AWARE="1"/);
    assert.match(betaScript, /x-early-access-opt-in: true/);
    const betaPinned = /PINNED_MANIFEST_B64U="([A-Za-z0-9_-]+)"/.exec(betaScript);
    assert.equal(JSON.parse(Buffer.from(betaPinned[1], "base64url").toString()).sha256, beta.sha256);

    const production = signedRelease(h, productionDir, "production", "1.0.0", Buffer.from("production archive"));
    const response = await fetch(`${base}/production.sh`, { headers: productionHeaders });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /shellscript/);
    const script = await response.text();
    assert.match(script, /INSTALL_CHANNEL="production"/);
    assert.match(script, /CHANNEL_AWARE="1"/);
    assert.match(script, /channel installer requires a fresh host/);
    assert.match(script, /release-channel-preference\.v1\.json/);
    assert.match(script, /api\/releases\/\$INSTALL_CHANNEL\/download/);
    const pinned = /PINNED_MANIFEST_B64U="([A-Za-z0-9_-]+)"/.exec(script);
    assert.deepEqual(JSON.parse(Buffer.from(pinned[1], "base64url").toString()), production);
    fs.rmSync(path.join(productionDir, `manifest-${production.sha256}.json`));
    const noArchive = await channelReq(`${base}/production.sh`, { headers: productionHeaders });
    assert.equal(noArchive.status, 404, "current latest alone is not enough to issue a Production installer");
    assert.equal((await fetch(`${h.origin}/install.sh?key=${issued.token}`)).status, 200,
      "the generic Beta installer remains available and unchanged");
  } finally { await h.close(); }
});

await test("channel installer verifies the exact signed channel and refuses existing install state", async () => {
  const productionDir = tmpDir("installer-verifier-production");
  const h = await freshHub({ releaseRoutingEnabled: true, productionReleasesDir: productionDir });
  try {
    const manifest = signedRelease(h, productionDir, "production", "1.2.3", Buffer.from("prod archive"), "a".repeat(40), process.arch);
    const template = fs.readFileSync(new URL("../templates/install.sh", import.meta.url), "utf8");
    const verifier = /<<'VERIFY_RELEASE'\n([\s\S]*?)\nVERIFY_RELEASE/.exec(template);
    assert.ok(verifier);
    const dir = tmpDir("installer-verifier-script");
    const code = path.join(dir, "verify.cjs"), input = path.join(dir, "manifest.json"), output = path.join(dir, "verified.json"), appDir = path.join(dir, "app");
    fs.mkdirSync(appDir);
    fs.writeFileSync(code, verifier[1]);
    fs.writeFileSync(input, JSON.stringify(manifest));
    const args = [code, input, output, Buffer.from(JSON.stringify(h.releaseSigner.publicKeys)).toString("base64url"), String(h.cfg.releaseMaxAgeMs), appDir];
    execFileSync(process.execPath, [...args, "production"]);
    assert.equal(JSON.parse(fs.readFileSync(output)).channel, "production");
    assert.notEqual(spawnSync(process.execPath, [...args, "beta"], { encoding: "utf8" }).status, 0);

    const start = template.indexOf('if [ "$CHANNEL_AWARE" = "1" ]; then\n  case "$INSTALL_CHANNEL"');
    const end = template.indexOf('\n\nsay "Installing prerequisites"', start);
    assert.ok(start >= 0 && end > start);
    const guard = template.slice(start, end);
    const runner = path.join(dir, "guard.sh");
    fs.writeFileSync(runner, `#!/usr/bin/env bash\nset -Eeuo pipefail\nCHANNEL_AWARE="\$1"\nINSTALL_CHANNEL=production\nPINNED_MANIFEST_B64U=pin\nPINNED_RELEASE_B64U=pin\nAPP_DIR="\$2"\nENV_FILE="\$3"\nUNIT_FILE="\$4"\ndie(){ echo "\$*" >&2; exit 1; }\n${guard}\n`);
    const appPath = path.join(dir, "host-app"), envPath = path.join(dir, "host-env"), unitPath = path.join(dir, "host-unit");
    assert.equal(spawnSync("bash", [runner, "1", appPath, envPath, unitPath]).status, 0);
    fs.mkdirSync(appPath);
    assert.notEqual(spawnSync("bash", [runner, "1", appPath, envPath, unitPath]).status, 0,
      "a missing preference on an existing app cannot turn it into Production");
    assert.equal(spawnSync("bash", [runner, "0", appPath, envPath, unitPath]).status, 0,
      "the legacy installer retains its existing rerun behavior");
  } finally { await h.close(); }
});

await test("the exact installer seeds only new channel state from verified manifest identity", () => {
  const template = fs.readFileSync(new URL("../templates/install.sh", import.meta.url), "utf8");
  const seed = /<<'SEED_CHANNEL_STATE'\n([\s\S]*?)\nSEED_CHANNEL_STATE/.exec(template);
  assert.ok(seed);
  const dir = tmpDir("channel-seed");
  const code = path.join(dir, "seed.cjs");
  fs.writeFileSync(code, seed[1]);
  const manifestPath = path.join(dir, "verified.json");
  const data = path.join(dir, "data");
  fs.mkdirSync(data);
  const manifest = { schema: "wickhunter.release.v1", channel: "production", version: "1.2.3",
    buildId: "prod-123", sha256: "a".repeat(64), issuedAt: new Date().toISOString() };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  execFileSync(process.execPath, [code, manifestPath, data, "production"]);
  const preference = JSON.parse(fs.readFileSync(path.join(data, "release-channel-preference.v1.json")));
  const state = JSON.parse(fs.readFileSync(path.join(data, "release-state.json")));
  assert.equal(preference.channel, "production");
  assert.equal(preference.betaOptIn, false);
  assert.equal(state.schema, manifest.schema);
  assert.equal(state.channel, "production");
  for (const field of ["version", "buildId", "sha256", "issuedAt"]) assert.equal(state[field], manifest[field]);
  assert.ok(Number.isFinite(Date.parse(state.installedAt)));
  const again = spawnSync(process.execPath, [code, manifestPath, data, "production"], { encoding: "utf8" });
  assert.notEqual(again.status, 0, "existing channel preference cannot be overwritten");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "release-channel-preference.v1.json"))), preference);
  const betaData = path.join(dir, "beta-data");
  fs.mkdirSync(betaData);
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, channel: "beta" }));
  execFileSync(process.execPath, [code, manifestPath, betaData, "beta"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(betaData, "release-channel-preference.v1.json"))).betaOptIn, true);
  const denied = spawnSync(process.execPath, [code, manifestPath, path.join(dir, "denied"), "production"], { encoding: "utf8" });
  assert.notEqual(denied.status, 0, "channel mismatch cannot seed installed identity");
});

await test("an incomplete fresh channel install stops its service and removes only the new channel records", () => {
  const template = fs.readFileSync(new URL("../templates/install.sh", import.meta.url), "utf8");
  const cleanup = /cleanup\(\) \{\n([\s\S]*?)\n\}\ntrap cleanup EXIT/.exec(template);
  assert.ok(cleanup);
  const dir = tmpDir("channel-cleanup"), data = path.join(dir, "app/data"), work = path.join(dir, "scratch");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(work);
  for (const name of ["release-channel-preference.v1.json", "release-state.json"]) fs.writeFileSync(path.join(data, name), "new");
  fs.writeFileSync(path.join(data, "customer-settings.json"), "preserve");
  const runner = path.join(dir, "cleanup.sh");
  fs.writeFileSync(runner, `#!/usr/bin/env bash\nset -Eeuo pipefail\nCHANNEL_AWARE=1\nCHANNEL_STATE_SEEDED=1\nCHANNEL_INSTALL_COMPLETE=0\nAPP_DIR="\$1"\nwork="\$2"\nSERVICE=wickhunter\nsystemctl(){ printf '%s' "\$*" > "\$APP_DIR/stop-call"; }\ncleanup(){\n${cleanup[1]}\n}\ncleanup\n`);
  assert.equal(spawnSync("bash", [runner, path.join(dir, "app"), work]).status, 0);
  assert.equal(fs.existsSync(path.join(data, "release-channel-preference.v1.json")), false);
  assert.equal(fs.existsSync(path.join(data, "release-state.json")), false);
  assert.equal(fs.readFileSync(path.join(data, "customer-settings.json"), "utf8"), "preserve");
  assert.equal(fs.readFileSync(path.join(dir, "app/stop-call"), "utf8"), "stop wickhunter");
  assert.equal(fs.existsSync(work), false);
});

await test("Production route refuses a shelf alias that would overwrite or reinterpret the legacy Beta shelf", async () => {
  const h = await freshHub({ releaseRoutingEnabled: true });
  try {
    const { token } = h.store.issue("Shelf alias", 30);
    signedRelease(h, h.releasesDir, "beta", "1.0.0", Buffer.from("beta only"));
    h.cfg.productionReleasesDir = h.releasesDir;
    const response = await jsonReq(`${h.origin}/api/releases/production/latest`, { headers: requestHeaders(token, "production") });
    assert.equal(response.status, 404);
    assert.equal(response.body.status, "unavailable");
    const legacy = await jsonReq(`${h.origin}/api/latest?key=${token}`);
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.channel, "beta");
  } finally { await h.close(); }
});

await test("leaving Beta with a newer or same-version-different Production target withholds the manifest", async () => {
  const productionDir = tmpDir("release-routing-production");
  const h = await freshHub({ releaseRoutingEnabled: true, productionReleasesDir: productionDir });
  try {
    const { token } = h.store.issue("Leave Beta", 30);
    const beta = signedRelease(h, h.releasesDir, "beta", "2.0.0", Buffer.from("beta newer archive"));
    signedRelease(h, productionDir, "production", "1.9.9", Buffer.from("prod older archive"));
    const identity = new URLSearchParams({ installedChannel: "beta", installedVersion: beta.version, installedBuildId: beta.buildId, installedSha256: beta.sha256 });
    let response = await channelReq(`${h.origin}/api/releases/production/latest?${identity}`, { headers: requestHeaders(token, "production") });
    assert.equal(response.status, 409);
    assert.equal(response.body.status, "waiting-for-production");
    assert.equal(Object.hasOwn(response.body, "file"), false);
    const blockedDownload = await jsonReq(`${h.origin}/api/releases/production/download/latest?${identity}`, { headers: requestHeaders(token, "production") });
    assert.equal(blockedDownload.status, 409);
    assert.equal(blockedDownload.body.status, "waiting-for-production");

    fs.rmSync(path.join(productionDir, "latest.json"));
    signedRelease(h, productionDir, "production", "2.0.0", Buffer.from("different same-version archive"));
    response = await channelReq(`${h.origin}/api/releases/production/latest?${identity}`, { headers: requestHeaders(token, "production") });
    assert.equal(response.status, 409);
    assert.equal(response.body.status, "waiting-for-production");

    fs.rmSync(path.join(productionDir, "latest.json"));
    signedRelease(h, productionDir, "production", "2.0.1", Buffer.from("forward-safe prod archive"));
    response = await channelReq(`${h.origin}/api/releases/production/latest?${identity}`, { headers: requestHeaders(token, "production") });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-release-status"), "update-available");
    assert.equal(response.body.version, "2.0.1");
  } finally { await h.close(); }
});

await test("channel routing admin authorization is per-license and the console labels the control separately", async () => {
  const h = await freshHub({ releaseRoutingEnabled: true });
  try {
    const issued = h.store.issue("Eligible tester", 30);
    const headers = { "x-hub-admin": "test-admin-token", "content-type": "application/json" };
    let response = await fetch(`${h.origin}/admin/api/flags`, { method: "POST", headers, body: JSON.stringify({ id: "default", flag: "earlyAccess", state: true }) });
    assert.equal(response.status, 400);
    response = await fetch(`${h.origin}/admin/api/flags`, { method: "POST", headers, body: JSON.stringify({ id: issued.payload.id, flag: "earlyAccess", state: true }) });
    assert.equal(response.status, 200);
    const list = await jsonReq(`${h.origin}/admin/api/licenses`, { headers: { "x-hub-admin": "test-admin-token" } });
    assert.equal(list.body.licenses.find((row) => row.id === issued.payload.id).earlyAccessEligible, true);
    const checkin = await jsonReq(`${h.origin}/api/license/checkin`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ licenseId: issued.payload.id, installId: "early-access-test", version: "1.0.0", ts: Date.now(), token: issued.token }),
    });
    assert.equal(checkin.status, 200);
    assert.equal(Object.hasOwn(checkin.body.flags, EARLY_ACCESS_ELIGIBILITY_FLAG), false, "channel eligibility does not leak into app feature flags");
    const html = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
    assert.match(html, /Early Access eligibility/);
    assert.match(html, /does not enroll them, publish a release, or grant Marketplace access/);
  } finally { await h.close(); }
});

summary("release-routing");
