import assert from "node:assert/strict";
import { createHash, sign as edSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EARLY_ACCESS_ELIGIBILITY_FLAG, setFlag } from "../dist/src/flags.js";
import { releaseSigningBytes, verifyReleaseManifest } from "../dist/src/release-manifest.js";
import { compareReleaseVersions, parseCustomerReleaseChannel, productionTransition } from "../dist/src/release-routing.js";
import { freshHub, jsonReq, test, summary, tmpDir } from "./helpers.mjs";

function signedRelease(h, shelf, channel, version, artifact, sourceCommit = "a".repeat(40)) {
  fs.mkdirSync(shelf, { recursive: true });
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const unsigned = {
    schema: "wickhunter.release.v1", product: "wickhunter", channel, platform: "linux", arch: "x64",
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
