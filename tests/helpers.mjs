// tests/helpers.mjs — shared hermetic-test plumbing.
// Every suite gets a throwaway data/releases dir and (when needed) a real hub
// listening on an ephemeral loopback port. No network beyond 127.0.0.1, no
// shared state between suites.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSigningKey, LicenseStore } from "../dist/src/license.js";
import { createHub } from "../dist/src/server.js";
import { DEFAULT_COLLECTOR_OPTIONS } from "../dist/src/candles/collector.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wickhub-${prefix}-`));
}

/** A LicenseStore in a fresh temp dir with a fresh signing key. */
export function freshStore() {
  const dataDir = tmpDir("data");
  const store = new LicenseStore(dataDir);
  store.writeKey(generateSigningKey().privatePem);
  return { store, dataDir };
}

/** A full hub on an ephemeral port. Returns fetch-ready origin + teardown. */
export async function freshHub(overrides = {}, deps = undefined) {
  const { store, dataDir } = freshStore();
  const releasesDir = tmpDir("releases");
  const cfg = {
    dataDir,
    releasesDir,
    publicDir: path.join(ROOT, "public"), // real admin page — reading it is part of the test
    templatesDir: path.join(ROOT, "templates"), // real installer template likewise
    host: "127.0.0.1",
    port: 0,
    adminToken: "test-admin-token",
    publicOrigin: "https://hub.test/hub",
    srcDir: "/nonexistent/hub-src",
    // Candle collectors are OFF unless a suite asks for them: a test hub must
    // never make an outbound venue request. Suites that exercise the collector
    // pass their own venue list plus a stub fetch through `deps`.
    candleVenues: [],
    // The shipped default: seeds are signed by the LICENCE key and labelled
    // "seed-1". A suite that wants the dedicated key overrides BOTH, exactly
    // as configFromEnv derives them together.
    candleSigner: "license",
    candleKeyId: "seed-1",
    candleRequireLicense: true,
    candleTickMs: 60_000,
    candleOptions: { ...DEFAULT_COLLECTOR_OPTIONS },
    ...overrides,
  };
  // A test hub never waits out the collector's request pacing. The pacing still
  // RUNS — the same code path, the same gaps computed — the sleep is just a
  // no-op, so a suite that ticks a collector does not spend 312 ms per request.
  const hub = createHub(cfg, { candleSleep: async () => {}, ...deps });
  const port = await hub.listen();
  return {
    hub,
    store,
    candles: hub.candles,
    cfg,
    dataDir,
    releasesDir,
    origin: `http://127.0.0.1:${port}`,
    close: () => hub.close(),
  };
}

/** fetch + parse JSON, returning {status, body}. */
export async function jsonReq(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

let passed = 0;
export async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exit(1);
  }
}
export function summary(suite) {
  console.log(`${suite}: ${passed} checks passed`);
}
