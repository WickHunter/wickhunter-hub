#!/usr/bin/env node
// tests/run-all.mjs — the pre-commit gate. Runs every tests/*.test.mjs in its
// own process (hermetic: each suite builds its own temp data dir and hub
// instance; nothing touches the repo's data/ or releases/).
//
// Usage: npx tsc && node tests/run-all.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
if (!fs.existsSync(path.join(here, "..", "dist", "src", "server.js"))) {
  console.error("dist/ is missing or stale — run `npx tsc` first");
  process.exit(1);
}

const files = fs.readdirSync(here).filter((f) => f.endsWith(".test.mjs")).sort();
let failed = 0;
for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: "inherit" });
  const ms = Date.now() - started;
  if (r.status === 0) {
    console.log(`PASS ${f} (${ms}ms)`);
  } else {
    console.error(`FAIL ${f} (exit ${r.status})`);
    failed++;
  }
}
console.log(failed === 0 ? `\nall ${files.length} suites passed` : `\n${failed}/${files.length} suites FAILED`);
process.exit(failed === 0 ? 0 : 1);
