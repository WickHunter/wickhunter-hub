import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, summary } from "./helpers.mjs";

const installer = fs.readFileSync(new URL("../templates/install.sh", import.meta.url), "utf8");
const slice = (start, end) => {
  const a = installer.indexOf(start), b = installer.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing installer section ${start}`);
  return installer.slice(a, b);
};
const codec = slice("env_file() {", "\nSECRET=$(get_env");
const config = slice("SECRET=$(get_env", "\n# License key:");
const preflight = slice("preflight_artifact() {", '\nENTRY=$(preflight_artifact');
const readiness = slice("HEALTH_DEADLINE_SECONDS=", '\nSTARTUP_SINCE=$(date');
const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), "wh-startup-fixture-"));
const base = 'set -Eeuo pipefail\ndie() { printf "ERROR: %s\\n" "$*" >&2; exit 1; }\nwarn() { printf "%s\\n" "$*" >&2; }\nok() { printf "%s\\n" "$*"; }\nsay() { :; }\n';
const run = (script, env = {}, timeout = 12000) => spawnSync("bash", ["-c", base + script], {
  encoding: "utf8", timeout,
  env: { PATH: process.env.PATH, HOME: os.homedir(), ...env },
});
const executable = (file, body) => fs.writeFileSync(file, "#!/usr/bin/env bash\nset -eu\n" + body, { mode: 0o755 });

await test("typed eight-character login and punctuation secret survive systemd-compatible encoding and rerun", () => {
  const dir = sandbox();
  try {
    const file = path.join(dir, "env");
    fs.mkdirSync(path.join(dir, "data")); fs.writeFileSync(file, "# retained comment\nOTHER=keep\n");
    const password = 'a"b\\$` c';
    assert.equal(password.length, 8);
    const secret = '  secret "quoted" \\ $HOME `touch /tmp/never-wh-secret` $(touch /tmp/never-wh-secret)  ';
    const script = codec + '\nask() { case "$1" in SECRET) SECRET=$TEST_SECRET;; LOGIN_PW) LOGIN_PW=$TEST_PASSWORD;; *) exit 99;; esac; }\n' + config
      + '\n[ "$(get_env LIQHUNTER_SECRET)" = "$TEST_SECRET" ]\n[ "$(get_env LIQHUNTER_LOGIN_PASSWORD)" = "$TEST_PASSWORD" ]\n';
    const env = { ENV_FILE: file, APP_DIR: dir, HUB: "https://hub.example.test", TEST_SECRET: secret, TEST_PASSWORD: password };
    const first = run(script, env);
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout + first.stderr, /quoted|never-wh-secret/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const before = fs.readFileSync(file, "utf8");
    const rerun = run(codec + '\nask() { exit 99; }\n' + config, env);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    // The canonical writer emits the subset whose backslash/quote semantics
    // are shared by systemd EnvironmentFile and POSIX double-quoted strings.
    // An independent shell decoder proves special characters cannot execute.
    const decoded = run('source "$ENV_FILE"\nprintf "%s" "$LIQHUNTER_LOGIN_PASSWORD"', { ENV_FILE: file });
    assert.equal(decoded.status, 0, decoded.stderr); assert.equal(decoded.stdout, password);
    const decodedSecret = run('source "$ENV_FILE"\nprintf "%s" "$LIQHUNTER_SECRET"', { ENV_FILE: file });
    assert.equal(decodedSecret.stdout, secret);
    assert.equal(fs.existsSync("/tmp/never-wh-secret"), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test("existing quoted, escaped, duplicate, multiline and hash credentials remain data", () => {
  const dir = sandbox();
  try {
    const file = path.join(dir, "env"); fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(file, '# comment\nLIQHUNTER_SECRET=old\nLIQHUNTER_SECRET="new \\"secret\\" \\\\ path"\nLIQHUNTER_LOGIN_PASSWORD_HASH=opaque-existing-hash\nMULTI=\'first\nsecond\'\nRAW=literal$HOME`id`\n');
    const result = run(codec + '\nask() { exit 99; }\n' + config + '\n[ "$(get_env LIQHUNTER_SECRET)" = \'new "secret" \\ path\' ]\n[ "$(get_env MULTI)" = $\'first\\nsecond\' ]\n[ "$(get_env RAW)" = \'literal$HOME`id`\' ]\n', { ENV_FILE: file, APP_DIR: dir, HUB: "https://hub.example.test" });
    assert.equal(result.status, 0, result.stderr);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /LIQHUNTER_LOGIN_PASSWORD_HASH=opaque-existing-hash/);
    assert.doesNotMatch(text, /^LIQHUNTER_LOGIN_PASSWORD=/m);
    const malformed = 'LIQHUNTER_SECRET="never-wh-secret\n'; fs.writeFileSync(file, malformed);
    const invalid = run(codec + '\nget_env LIQHUNTER_SECRET', { ENV_FILE: file });
    assert.notEqual(invalid.status, 0); assert.doesNotMatch(invalid.stderr, /never-wh-secret/);
    assert.equal(fs.readFileSync(file, "utf8"), malformed);
    fs.writeFileSync(file, 'UNRELATED="unterminated\nLIQHUNTER_SECRET=preserved\n');
    const unrelated = run(codec + '\nset_env LIQHUNTER_HUB_ORIGIN https://hub.example.test', { ENV_FILE: file });
    assert.notEqual(unrelated.status, 0);
    assert.equal(fs.readFileSync(file, "utf8"), 'UNRELATED="unterminated\nLIQHUNTER_SECRET=preserved\n');
    fs.writeFileSync(file, 'LIQHUNTER_SECRET=existing\\  \n');
    const escaped = run(codec + '\nget_env LIQHUNTER_SECRET', { ENV_FILE: file });
    assert.equal(escaped.status, 0, escaped.stderr); assert.equal(escaped.stdout, 'existing ');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test("archive preflight executes Node syntax and native identity checks for both entry layouts", () => {
  const dir = sandbox();
  try {
    const preload = path.join(dir, "arch.cjs");
    fs.writeFileSync(preload, 'Object.defineProperty(process,"arch",{value:"x64"});');
    fs.mkdirSync(path.join(dir, "bin"));
    const core = path.join(dir, "bin", "wh-core-linux-amd64");
    executable(core, 'printf "wh-core fixture protocol=1 algorithm=1\\n"\n');
    const env = { FIXTURE: dir, NODE_OPTIONS: `--require=${preload}` };
    for (const entry of ["server.js", "dist/server/index.js"]) {
      fs.mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
      fs.writeFileSync(path.join(dir, entry), 'console.log("fixture");');
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module", scripts: { start: `node ${entry}` } }));
      const result = run(preflight + '\npreflight_artifact "$FIXTURE"', env);
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, entry);
    }
    // A stale root server.js must not override a signed full-tree start script.
    fs.writeFileSync(path.join(dir, "server.js"), 'syntax {{{');
    assert.equal(run(preflight + '\npreflight_artifact "$FIXTURE"', env).stdout, "dist/server/index.js");
    fs.writeFileSync(path.join(dir, "dist/server/index.js"), 'syntax {{{');
    assert.match(run(preflight + '\npreflight_artifact "$FIXTURE"', env).stderr, /Node syntax preflight/);
    fs.writeFileSync(path.join(dir, "dist/server/index.js"), 'console.log("fixture");');
    executable(core, 'printf "wh-core-alpha fixture protocol=1 algorithm=1\\n"\n');
    assert.match(run(preflight + '\npreflight_artifact "$FIXTURE"', env).stderr, /production wh-core/);
    executable(core, 'printf "https://hub.invalid/?key=never-wh-secret" >&2\nexit 1\n');
    const failed = run(preflight + '\npreflight_artifact "$FIXTURE"', env);
    assert.match(failed.stderr, /could not execute/); assert.doesNotMatch(failed.stderr, /never-wh-secret|https:/);
    fs.chmodSync(core, 0o644);
    assert.match(run(preflight + '\npreflight_artifact "$FIXTURE"', env).stderr, /executable protected native core/);
    fs.writeFileSync(preload, 'Object.defineProperty(process,"arch",{value:"arm64"});');
    assert.match(run(preflight + '\npreflight_artifact "$FIXTURE"', env).stderr, /requires Linux x64/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function readinessFixture(dir, mode) {
  // macOS has no GNU timeout. This fixture enforces the same elapsed deadline
  // around the real subprocess; Ubuntu uses its installed coreutils timeout.
  fs.writeFileSync(path.join(dir, "timeout"), '#!/usr/bin/env node\nconst {spawnSync}=require("node:child_process");const r=spawnSync(process.argv[3],process.argv.slice(4),{stdio:"inherit",timeout:parseFloat(process.argv[2])*1000});process.exit(r.status??124);\n', { mode: 0o755 });
  executable(path.join(dir, "systemctl"), `count=0; [ ! -f "$COUNTER" ] || count=$(cat "$COUNTER"); count=$((count+1)); printf '%s' "$count" > "$COUNTER"
case "$MOCK_MODE" in
 failed) printf 'ActiveState=failed\\nSubState=failed\\nResult=exit-code\\nMainPID=0\\nNRestarts=95\\n';;
 oom) printf 'ActiveState=failed\\nSubState=failed\\nResult=oom-kill\\nMainPID=0\\nNRestarts=1\\n';;
 restarting) printf 'ActiveState=activating\\nSubState=auto-restart\\nResult=exit-code\\nMainPID=0\\nNRestarts=1\\n';;
 changed) printf 'ActiveState=active\\nSubState=running\\nResult=success\\nMainPID=42\\nNRestarts=%s\\n' "$count";;
 *) printf 'ActiveState=active\\nSubState=running\\nResult=success\\nMainPID=42\\nNRestarts=0\\n';;
esac
`);
  executable(path.join(dir, "curl"), `budget=0
while [ "$#" -gt 0 ]; do if [ "$1" = --max-time ]; then shift; budget=$1; fi; shift; done
printf '%s\\n' "$budget" >> "$CURL_BUDGETS"
case "$MOCK_MODE" in
 good) printf '{"ok":true,"version":"0.90.135"}';;
 wrong) printf '{"ok":true,"version":"0.90.134","url":"https://private/?key=never-wh-secret"}';;
 invalid) printf 'not-json-never-wh-secret';;
 oversized) node -e 'process.stdout.write("x".repeat(66000))';;
 hung) sleep "$budget"; exit 28;;
 *) exit 7;;
esac
`);
  executable(path.join(dir, "journalctl"), 'printf "bybit /v5/market/tickers HTTP 403 https://private/?key=never-wh-secret\\nEADDRINUSE never-wh-secret\\nout of memory never-wh-secret\\n"\n');
  executable(path.join(dir, "ss"), 'printf \'LISTEN 0 100 127.0.0.1:8090 0.0.0.0:* users:(("never-wh-secret",pid=333,fd=1))\\n\'\n');
  return { PATH: `${dir}:${process.env.PATH}`, SERVICE: "wickhunter", PORT: "8090", REL_VERSION: "0.90.135", STARTUP_SINCE: "100", MOCK_MODE: mode, COUNTER: path.join(dir, "count"), CURL_BUDGETS: path.join(dir, "budgets") };
}

await test("startup accepts only the signed version, detects exit/restart/OOM, and redacts diagnostics", () => {
  for (const mode of ["good", "wrong", "invalid", "oversized", "failed", "oom", "restarting", "changed"]) {
    const dir = sandbox();
    try {
      const result = run(readiness + '\nwait_for_signed_version', readinessFixture(dir, mode));
      assert.equal(result.status === 0, mode === "good", `${mode}: ${result.stderr}`);
      if (mode !== "good") {
        assert.match(result.stderr, /Bybit denied this VPS request/);
        assert.match(result.stderr, /port listener: 127.0.0.1:8090 pid=333/);
        assert.doesNotMatch(result.stderr + result.stdout, /never-wh-secret|https:/);
      }
      if (["failed", "oom", "restarting"].includes(mode)) assert.equal(fs.existsSync(path.join(dir, "budgets")), false, "exited service does not waste time probing health");
      if (mode === "changed") assert.match(result.stderr, /restarted before health/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

await test("a hung health call stays inside the single readiness deadline", () => {
  const dir = sandbox();
  try {
    const started = Date.now();
    const result = run(readiness.replace("HEALTH_DEADLINE_SECONDS=45", "HEALTH_DEADLINE_SECONDS=2") + '\nwait_for_signed_version', readinessFixture(dir, "hung"));
    assert.notEqual(result.status, 0); assert.match(result.stderr, /within 2s/);
    assert.ok(Date.now() - started < 4000, "hung curl cannot repeat the full deadline for nine attempts");
    const budgets = fs.readFileSync(path.join(dir, "budgets"), "utf8").trim().split("\n").map(Number);
    assert.equal(budgets.length, 1);
    assert.ok(budgets[0] >= 1 && budgets[0] <= 2, "service-state time consumes the same deadline before curl starts");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

summary("installer-startup");
