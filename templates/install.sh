#!/usr/bin/env bash
# Wick Hunter customer installer. The legacy /install.sh renderer remains
# Beta; gated channel routes pin one separately signed customer shelf.
#
# One command on a fresh Ubuntu VPS:
#   curl -q -fsS "<hub>/install.sh?key=<your key>" | sudo bash
#
# What it does: Node 22, fetch + verify the latest beta build, unpack to
# /opt/wickhunter (your data/ survives re-runs), systemd unit, license key,
# HTTPS via the bot's own vps-setup, and verified startup. Re-runs validate an
# existing signed installation; only a proven stopped service may be started.
# Upgrades use the authenticated app updater, never overwrite a running bot.
set -Eeuo pipefail

HUB="__HUB_ORIGIN__"
KEY="__LICENSE_KEY__"
RELEASE_KEYS_B64U="__RELEASE_KEYS_B64U__"
RELEASE_MAX_AGE_MS="__RELEASE_MAX_AGE_MS__"
PINNED_RELEASE_B64U="__PINNED_RELEASE_B64U__"
PINNED_MANIFEST_B64U="__PINNED_MANIFEST_B64U__"
INSTALL_CHANNEL="__INSTALL_CHANNEL__"
CHANNEL_AWARE="__CHANNEL_AWARE__"

APP_DIR=/opt/wickhunter
ENV_FILE=/etc/wickhunter/env
SERVICE=wickhunter
UNIT_FILE=/etc/systemd/system/${SERVICE}.service
NODE_MAJOR_WANTED=22
PORT=8090

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   + %s\n' "$*"; }
warn() { printf '   ! %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Fresh Ubuntu images can start unattended-upgrades at the same time as
# cloud-init.  Let dpkg finish normally: never kill it and never remove its
# lock files.  Each apt attempt waits up to 30 seconds for dpkg's lock, and
# failed attempts retry for up to ten minutes. Once apt has acquired the lock,
# let that package transaction finish normally even if the retry window passes.
APT_RETRY_DEADLINE_SECONDS=600
APT_LOCK_TIMEOUT_SECONDS=30
APT_RETRY_SLEEP_SECONDS=5
apt_retry() { # apt_retry update -qq | apt_retry install ...
  local started now remaining attempt delay status lock_wait
  started=$(date +%s)
  attempt=1
  while :; do
    now=$(date +%s)
    remaining=$((APT_RETRY_DEADLINE_SECONDS - (now - started)))
    # The first attempt always runs. Later failed attempts stop at the shared
    # deadline; a short final attempt waits only the remaining seconds for the
    # lock rather than starting another full 30-second lock wait.
    [ "$attempt" -eq 1 ] || [ "$remaining" -gt 0 ] || return "$status"
    lock_wait=$APT_LOCK_TIMEOUT_SECONDS
    [ "$remaining" -ge "$lock_wait" ] || lock_wait=$remaining
    [ "$lock_wait" -ge 1 ] || lock_wait=1
    set +e
    apt-get -o "DPkg::Lock::Timeout=$lock_wait" "$@"
    status=$?
    set -e
    [ "$status" -eq 0 ] && return 0
    now=$(date +%s)
    remaining=$((APT_RETRY_DEADLINE_SECONDS - (now - started)))
    [ "$remaining" -gt 0 ] || return "$status"
    delay=$APT_RETRY_SLEEP_SECONDS
    [ "$delay" -le "$remaining" ] || delay=$remaining
    warn "apt command failed on attempt $attempt (status $status); waiting ${delay}s before retry"
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

# NodeSource's setup script performs its own apt operations. A temporary
# APT_CONFIG gives those calls the same native lock wait, while this wrapper
# retries the idempotent setup script within the shared ten-minute window.
retry_command() { # retry_command command args...
  local started now remaining attempt delay status
  started=$(date +%s)
  attempt=1
  while :; do
    set +e
    "$@"
    status=$?
    set -e
    [ "$status" -eq 0 ] && return 0
    now=$(date +%s)
    remaining=$((APT_RETRY_DEADLINE_SECONDS - (now - started)))
    [ "$remaining" -gt 0 ] || return "$status"
    delay=$APT_RETRY_SLEEP_SECONDS
    [ "$delay" -le "$remaining" ] || delay=$remaining
    warn "package repository setup failed on attempt $attempt (status $status); waiting ${delay}s before retry"
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

# When run as `curl | sudo bash`, stdin is the pipe — prompts must come from
# the terminal. No terminal at all (cloud-init etc.) -> generate/skip instead.
ask() { # ask VAR "prompt" [--secret]
  local __var=$1 __prompt=$2 __secret=${3:-} __val=""
  # The device node can be readable with no controlling terminal (cloud-init).
  # Probe an actual open in a guarded subshell so errexit cannot abort setup.
  if ( : < /dev/tty ) 2>/dev/null; then
    if [ "$__secret" = "--secret" ]; then
      read -r -s -p "$__prompt" __val < /dev/tty || __val=""
      printf '\n' > /dev/tty || true
    else
      read -r -p "$__prompt" __val < /dev/tty || __val=""
    fi
  fi
  printf -v "$__var" '%s' "$__val"
}

# Existing installs take a separate path before package/app/env/license writes.
# Authenticate with the Hub-embedded keyring, never a key from local metadata.
verify_signed_tree() {
  timeout 30s node - "$1" "$RELEASE_KEYS_B64U" <<'VERIFY_SIGNED_TREE'
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const [root,keysB64u]=process.argv.slice(2);
const fail=()=>{console.error("signed installation integrity could not be verified; no files changed");process.exit(1);};
try {
  const regular=file=>{let at=path.resolve(file);while(at!==path.dirname(at)){const st=fs.lstatSync(at);if(st.isSymbolicLink())fail();at=path.dirname(at);}const st=fs.lstatSync(file);if(!st.isFile())fail();return st;};
  const json=file=>{if(regular(file).size>1048576)fail();return JSON.parse(fs.readFileSync(file,"utf8"));};
  const d=json(path.join(root,"integrity.json")), keys=JSON.parse(Buffer.from(keysB64u,"base64url"));
  if(d.schema!=="wickhunter.integrity.v1"||d.product!=="wickhunter"||d.recoveryProtocol!==1
    ||!/^\d+\.\d+\.\d+$/.test(d.version)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(d.buildId)
    ||!Number.isFinite(Date.parse(d.issuedAt))||!Array.isArray(d.files)||!d.files.length)fail();
  const canonical=(v,depth=0)=>{if(depth>64)fail();if(v===null)return "null";if(typeof v==="number"&&(!Number.isFinite(v)||Object.is(v,-0)))fail();if(["string","number","boolean"].includes(typeof v))return JSON.stringify(v);if(Array.isArray(v))return "["+v.map(x=>canonical(x,depth+1)).join(",")+"]";if(!v||typeof v!=="object")fail();return "{"+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k],depth+1)).join(",")+"}";};
  const decode=(v,n)=>{if(typeof v!=="string"||! /^[A-Za-z0-9_-]+$/.test(v))throw Error();const b=Buffer.from(v,"base64url");if(b.length!==n||b.toString("base64url")!==v)throw Error();return b;};
  const unsigned={...d};delete unsigned.signatures;delete unsigned.ok;
  const bytes=Buffer.from(canonical(unsigned));
  if(!Array.isArray(d.signatures)||!d.signatures.some(sig=>{try{return sig.alg==="Ed25519"&&Object.hasOwn(keys,sig.kid)&&crypto.verify(null,bytes,crypto.createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),decode(keys[sig.kid],32)]),format:"der",type:"spki"}),decode(sig.sig,64));}catch{return false;}}))fail();
  let previous="";const names=new Set();
  for(const f of d.files){if(typeof f.path!=="string"||!f.path||f.path.includes("\\")||f.path.startsWith("/")||f.path.startsWith("data/")||f.path.split("/").some(x=>!x||x==="."||x==="..")||f.path<=previous||!/^[a-f0-9]{64}$/.test(f.sha256))fail();previous=f.path;names.add(f.path);const file=path.join(root,f.path);regular(file);if(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")!==f.sha256)fail();}
  const pkg=json(path.join(root,"package.json")), entry={"node server.js":"server.js","node dist/server/index.js":"dist/server/index.js"}[pkg.scripts?.start];
  if(pkg.version!==d.version||!entry||!["package.json",entry,"bin/wh-core-linux-amd64","scripts/release-auth.mjs"].every(x=>names.has(x)))fail();
  const core=d.files.find(f=>f.path==="bin/wh-core-linux-amd64");fs.accessSync(path.join(root,core.path),fs.constants.X_OK);
  process.stdout.write([d.version,d.buildId,core.sha256,entry,d.files.find(f=>f.path==="scripts/release-auth.mjs").sha256].join("\n"));
} catch { fail(); }
VERIFY_SIGNED_TREE
}

# No process signals are sent here. An absent cgroup is acceptable only under
# the exact service scope on a proven cgroup-v2 host; surviving children refuse.
prove_empty_service() {
  local state
  state=$(timeout 3s systemctl show "$SERVICE" --all --property=ActiveState,SubState,MainPID,ControlPID,Job,ControlGroup 2>/dev/null) \
    || die "could not verify stopped service ownership; no files changed"
  node - "$state" "$SERVICE" <<'VERIFY_EMPTY_SERVICE'
const fs=require("node:fs"),path=require("node:path");
try {
 const [raw,service]=process.argv.slice(2), s={};for(const line of raw.split("\n")){if(!line)continue;const i=line.indexOf("=");const k=line.slice(0,i);if(i<1||Object.hasOwn(s,k))throw Error();s[k]=line.slice(i+1);}
 if(!["inactive","failed"].includes(s.ActiveState)||!["dead","failed"].includes(s.SubState)||s.MainPID!=="0"||s.ControlPID!=="0"||s.Job!=="")throw Error();
 const scope="/system.slice/"+service+".service", root="/sys/fs/cgroup";
 if(s.ControlGroup!==""&&s.ControlGroup!==scope)throw Error();
 const regular=file=>{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error();};
 for(const file of [root,path.join(root,"system.slice")]){const st=fs.lstatSync(file);if(!st.isDirectory()||st.isSymbolicLink())throw Error();}
 regular(path.join(root,"cgroup.controllers"));
 const dir=root+scope;
 let st;try{st=fs.lstatSync(dir);}catch(e){if(e.code!=="ENOENT")throw e;process.exit(0);}
 if(!st.isDirectory()||st.isSymbolicLink())throw Error();
 let count=0;const visit=dir=>{if(++count>256)throw Error();for(const file of ["cgroup.procs","cgroup.events"])regular(path.join(dir,file));if(fs.readFileSync(path.join(dir,"cgroup.procs"),"utf8").trim())throw Error();const events={};for(const row of fs.readFileSync(path.join(dir,"cgroup.events"),"utf8").trim().split("\n")){const m=/^([a-z_]+) ([0-9]+)$/.exec(row);if(!m||Object.hasOwn(events,m[1]))throw Error();events[m[1]]=m[2];}if(events.populated!=="0")throw Error();for(const name of fs.readdirSync(dir)){const file=path.join(dir,name),st=fs.lstatSync(file);if(st.isSymbolicLink())throw Error();if(st.isDirectory())visit(file);}};visit(dir);
} catch {console.error("stopped service/cgroup proof is missing or still occupied; no start or files changed");process.exit(1);}
VERIFY_EMPTY_SERVICE
}
verify_existing_unit() {
  local state
  [ -f "$UNIT_FILE" ] && [ ! -L "$UNIT_FILE" ] && [ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] \
    || die "partial installation has no trustworthy unit/environment; support recovery is required, no files changed"
  state=$(timeout 3s systemctl show "$SERVICE" --all --property=LoadState,FragmentPath,WorkingDirectory,ExecStart,EnvironmentFiles,User,NeedDaemonReload,DropInPaths,ExecStartPre,ExecStartPost,Environment,ExecCondition,ExecStopPost 2>/dev/null) \
    || die "could not verify installed service identity"
  node - "$state" "$APP_DIR" "$UNIT_FILE" "$ENV_FILE" "$ENTRY" "$(command -v node)" <<'VERIFY_EXISTING_UNIT'
try {
 const [raw,app,unit,env,entry,node]=process.argv.slice(2),s={};for(const line of raw.split("\n")){if(!line)continue;const i=line.indexOf("=");if(i<1||Object.hasOwn(s,line.slice(0,i)))throw Error();s[line.slice(0,i)]=line.slice(i+1);}
 const m=/^\{ path=([^ ;]+) ; argv\[\]=([^;]+) ;/.exec(s.ExecStart??"");
 // systemctl prints structured Exec arrays once per command; empty arrays
 // can be omitted even with --all. Only these four hooks permit omission.
 const hooksEmpty=["ExecStartPre","ExecStartPost","ExecCondition","ExecStopPost"].every(k=>!Object.hasOwn(s,k)||s[k]==="");
 if(s.LoadState!=="loaded"||s.FragmentPath!==unit||s.WorkingDirectory!==app||s.NeedDaemonReload!=="no"||!["","root"].includes(s.User)
   ||s.EnvironmentFiles!==env+" (ignore_errors=no)"||s.DropInPaths!==""||s.Environment!==""||!hooksEmpty||!m||m[1]!==node||![node+" "+entry,node+" "+app+"/"+entry].includes(m[2].trim()))throw Error();
} catch {console.error("installed unit does not match the verified server entry; no files changed");process.exit(1);}
VERIFY_EXISTING_UNIT
}
verify_existing_license() {
  node -e 'const fs=require("node:fs");try{const s=fs.lstatSync(process.argv[1]);if(!s.isFile()||s.isSymbolicLink()||s.size>1048576||/^\s*NODE_OPTIONS\s*=/m.test(fs.readFileSync(process.argv[1],"utf8")))process.exit(1)}catch{process.exit(1)}' "$ENV_FILE" \
    || die "existing environment contains an unsafe Node preload or cannot be read; no files changed"
  printf '%s' "$KEY" | node -e 'const fs=require("node:fs"),path=require("node:path");try{const f=process.argv[1],d=fs.lstatSync(path.dirname(f)),s=fs.lstatSync(f);if(!d.isDirectory()||d.isSymbolicLink()||!s.isFile()||s.isSymbolicLink()||s.size>8192||fs.readFileSync(f,"utf8").replace(/\r?\n$/,"")!==fs.readFileSync(0,"utf8"))process.exit(1)}catch{process.exit(1)}' "$APP_DIR/data/license.key" \
    || die "installer licence does not match this existing installation; no activation or files changed"

}
verify_recovery_lock() {
  node - "$APP_DIR/data/release-operation.lock" "$1" <<'VERIFY_RECOVERY_LOCK'
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
try {
 const [dir,raw]=process.argv.slice(2),p=JSON.parse(Buffer.from(raw,"base64url")),d=fs.lstatSync(dir),parent=fs.lstatSync(path.dirname(dir)),o=fs.lstatSync(path.join(dir,"owner.json")),bytes=fs.readFileSync(path.join(dir,"owner.json")),owner=JSON.parse(bytes);
 if(!d.isDirectory()||d.isSymbolicLink()||!o.isFile()||o.isSymbolicLink()||d.dev!==p.dev||d.ino!==p.ino||parent.dev!==p.parentDev||parent.ino!==p.parentIno||o.dev!==p.ownerDev||o.ino!==p.ownerIno||crypto.createHash("sha256").update(bytes).digest("hex")!==p.sha||owner.pid!==p.pid||owner.bootId!==p.bootId||fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()!==p.bootId)process.exit(1);
 process.kill(p.pid,0);
} catch {process.exit(1);}
VERIFY_RECOVERY_LOCK
}
with_recovery_lock() {
  # Pipe the already-trusted shell functions/variables through a private FD,
  # not argv. The long-lived guard owns the installed updater's actual lock.
  timeout 180s node - "$APP_DIR" "$REL_AUTH_SHA" 3< <(
    printf 'set -Eeuo pipefail\n'
    declare -f die warn ok say verify_signed_tree verify_existing_unit verify_existing_license prove_empty_service verify_recovery_lock verify_no_release_operation startup_diagnostics startup_failed startup_generation wait_for_signed_version
    declare -f sleep 2>/dev/null || true
    declare -p APP_DIR ENV_FILE UNIT_FILE SERVICE PORT KEY RELEASE_KEYS_B64U REL_VERSION REL_BUILD_ID REL_CORE_SHA REL_AUTH_SHA ENTRY HEALTH_DEADLINE_SECONDS STARTUP_SINCE identity
    cat <<'RECOVERY_CHILD'
[ "$(verify_signed_tree "$APP_DIR")" = "$identity" ] && verify_existing_unit && prove_empty_service && verify_existing_license && verify_no_release_operation "$RECOVERY_LOCK_PROOF" \
  || die "existing installation changed under the recovery guard; no start or files changed"
timeout 15s systemctl start "$SERVICE" || startup_failed "systemd could not start the existing verified release"
wait_for_signed_version
RECOVERY_CHILD
  ) <<'OWN_RECOVERY_LOCK'
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),{spawnSync}=require("node:child_process");
(async()=>{
 let proof;
 const fail=()=>{console.error("same-release recovery could not be confirmed; retained release ownership evidence for support, no force or data restore");process.exitCode=1;};
 try {
  const [root,sha]=process.argv.slice(2),helper=path.join(root,"scripts/release-auth.mjs"),st=fs.lstatSync(helper),bytes=fs.readFileSync(helper);
  if(!st.isFile()||st.isSymbolicLink()||crypto.createHash("sha256").update(bytes).digest("hex")!==sha)throw Error();
  // Import the exact verified bytes, preventing a pathname change between
  // authentication and execution. This existing module imports built-ins only.
  const auth=await import("data:text/javascript;base64,"+bytes.toString("base64"));
  const script=fs.readFileSync(3,"utf8"),dir=path.join(root,"data/release-operation.lock"),ownerFile=path.join(dir,"owner.json");
  const bootId=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId))throw Error();
  auth.acquireReleaseLock(root); // Do not call its recursive cleanup closure.
  const d=fs.lstatSync(dir),parent=fs.lstatSync(path.dirname(dir)),o=fs.lstatSync(ownerFile),ownerBytes=fs.readFileSync(ownerFile),owner=JSON.parse(ownerBytes);
  if(owner.pid!==process.pid||owner.bootId!==bootId||!d.isDirectory()||d.isSymbolicLink()||!o.isFile()||o.isSymbolicLink())throw Error();
  proof={dev:d.dev,ino:d.ino,parentDev:parent.dev,parentIno:parent.ino,ownerDev:o.dev,ownerIno:o.ino,sha:crypto.createHash("sha256").update(ownerBytes).digest("hex"),pid:process.pid,bootId};
  const result=spawnSync("bash",["-s"],{input:script,stdio:["pipe","inherit","inherit"],timeout:150000,env:{...process.env,RECOVERY_LOCK_PROOF:Buffer.from(JSON.stringify(proof)).toString("base64url")}});
  if(result.status!==0)throw Error();
  const nowD=fs.lstatSync(dir),nowP=fs.lstatSync(path.dirname(dir)),nowO=fs.lstatSync(ownerFile),nowBytes=fs.readFileSync(ownerFile);
  if(nowD.isSymbolicLink()||nowO.isSymbolicLink()||nowD.dev!==proof.dev||nowD.ino!==proof.ino||nowP.dev!==proof.parentDev||nowP.ino!==proof.parentIno||nowO.dev!==proof.ownerDev||nowO.ino!==proof.ownerIno||!nowBytes.equals(ownerBytes)||JSON.parse(nowBytes).pid!==process.pid||JSON.parse(nowBytes).bootId!==bootId||fs.readdirSync(dir).length!==1)throw Error();
  fs.unlinkSync(ownerFile);fs.rmdirSync(dir);
 } catch {fail();}
})();
OWN_RECOVERY_LOCK
}
verify_no_release_operation() {
  local marker
  for marker in release-operation.lock release-transition.json; do
    if [ "$marker" = release-operation.lock ] && [ -n "${1:-}" ]; then
      verify_recovery_lock "$1" || die "recovery lock ownership changed; retained evidence, no start"
    else
      [ ! -e "$APP_DIR/data/$marker" ] && [ ! -L "$APP_DIR/data/$marker" ] \
        || die "an authenticated release operation needs recovery; retain all data and use support"
    fi
  done
  if [ -e "$APP_DIR/data/revert-state.json" ] || [ -L "$APP_DIR/data/revert-state.json" ]; then
    node -e 'const fs=require("node:fs");try{const s=fs.lstatSync(process.argv[1]);const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!s.isFile()||s.isSymbolicLink()||!["complete","failed"].includes(x.phase))process.exit(1)}catch{process.exit(1)}' "$APP_DIR/data/revert-state.json" \
      || die "a release recovery record needs support; no files changed"
  fi
}
recover_existing_install() {
  unset RECOVERY_LOCK_PROOF
  [ -z "${NODE_OPTIONS:-}" ] || die "NODE_OPTIONS preloads are not allowed for verified installer recovery"
  command -v node >/dev/null && command -v timeout >/dev/null && command -v ss >/dev/null \
    || die "existing installation needs Node, timeout and ss for safe recovery; no files changed"
  node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' \
    || die "existing service recovery requires Node22+; no files changed"
  local identity state
  identity=$(verify_signed_tree "$APP_DIR") || die "partial or changed installation requires support recovery; no files changed"
  REL_VERSION=$(printf '%s\n' "$identity" | sed -n '1p')
  REL_BUILD_ID=$(printf '%s\n' "$identity" | sed -n '2p')
  REL_CORE_SHA=$(printf '%s\n' "$identity" | sed -n '3p')
  ENTRY=$(printf '%s\n' "$identity" | sed -n '4p')
  REL_AUTH_SHA=$(printf '%s\n' "$identity" | sed -n '5p')
  verify_existing_unit || die "existing service identity is unsafe for automatic recovery"
  verify_existing_license
  verify_no_release_operation
  STARTUP_SINCE=$(( $(date +%s) - 600 ))
  state=$(timeout 3s systemctl show "$SERVICE" --property=ActiveState,SubState,MainPID 2>/dev/null) || die "could not inspect the existing service"
  if printf '%s\n' "$state" | grep -qx 'ActiveState=active'; then
    wait_for_signed_version
    ok "already installed; use the authenticated app updater for upgrades. No files or service state changed."
    return
  fi
  prove_empty_service || startup_failed "existing runtime cannot safely be started; inspect local service diagnostics"
  # Recheck authenticated bytes and unit immediately before the only mutation.
  [ "$(verify_signed_tree "$APP_DIR")" = "$identity" ] && verify_existing_unit && prove_empty_service && verify_existing_license && verify_no_release_operation \
    || die "existing installation changed during verification; no start or files changed"
  with_recovery_lock || die "existing signed release still needs support recovery; ownership evidence retained"
  ok "existing signed release recovered; code, environment, licence and current data were retained"
}

HEALTH_DEADLINE_SECONDS=45
startup_diagnostics() {
  warn "startup diagnostics for $SERVICE (credentials and raw logs omitted)"
  timeout 3s systemctl show "$SERVICE" \
    --property=ActiveState,SubState,Result,MainPID,ExecMainCode,ExecMainStatus,NRestarts,MemoryCurrent,MemoryPeak,OOMPolicy \
    2>/dev/null | sed -n '/^\(ActiveState\|SubState\|Result\|OOMPolicy\)=[a-z-]*$/p; /^\(MainPID\|ExecMainCode\|ExecMainStatus\|NRestarts\|MemoryCurrent\|MemoryPeak\)=[0-9]*$/p' >&2 || true
  # Output only recognized diagnostic labels, never a matching log line.
  timeout 3s journalctl -u "$SERVICE" --since "@$STARTUP_SINCE" -n 80 --no-pager -o cat 2>/dev/null \
    | node -e 'let s=""; process.stdin.on("data",x=>{if(s.length<131072)s+=x});process.stdin.on("end",()=>{for(const [label,re] of [["Bybit denied this VPS request (HTTP 403; US IP restrictions or rate limits may apply; check the response body)",/bybit.*(?:HTTP 403|\b403\b)/i],["port already in use",/EADDRINUSE/],["missing runtime dependency",/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/],["server syntax error",/SyntaxError/],["memory exhaustion",/out of memory|oom-kill|oom-killed/i],["native core startup failure",/native core.*(?:failed|missing|not found|refus)/i],["invalid login configuration",/password.*(?:minimum|at least|too short)|LIQHUNTER_SECRET.*(?:required|missing)/i]])if(re.test(s))console.error("   ! journal signal: "+label)})' || true
  if command -v ss >/dev/null; then
    # Only the listening address and numeric PID are shown, not process names.
    timeout 3s ss -H -ltnp "sport = :$PORT" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",x=>{if(s.length<16384)s+=x});process.stdin.on("end",()=>{for(const line of s.split("\n")){const address=line.trim().split(/\s+/)[3];if(!address||!/^[a-fA-F0-9.*:[\]]+$/.test(address))continue;const pid=/pid=(\d+)/.exec(line)?.[1];console.error("   ! port listener: "+address+(pid?" pid="+pid:""))}})' || true
  fi
  warn "inspect locally: journalctl -u $SERVICE -n 80 --no-pager (do not share credentials or license URLs)"
}
startup_failed() { startup_diagnostics; die "$1"; }
startup_generation() {
  remaining=$((deadline - SECONDS)); [ "$remaining" -gt 0 ] || return 1
  budget=$remaining; [ "$budget" -le 2 ] || budget=2
  timeout "${budget}s" node - "$APP_DIR/data/release-readiness.json" "$REL_VERSION" "$REL_BUILD_ID" "$REL_CORE_SHA" "$1" <<'VERIFY_STARTUP_READINESS'
const fs=require("node:fs");
try {
  const [file,version,buildId,coreSha,pid]=process.argv.slice(2), st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>65536)process.exit(1);
  const x=JSON.parse(fs.readFileSync(file,"utf8")), age=Date.now()-x.at;
  if(x.ready!==true||x.version!==version||x.buildId!==buildId||x.coreSha256!==coreSha||x.pid!==Number(pid)
    ||!Number.isFinite(age)||age<0||age>=5000||typeof x.generation!=="string"||!x.generation
    ||x.nonce!==null||!Array.isArray(x.contextKeys)||!x.contextKeys.length
    ||x.contextKeys.some(k=>typeof k!=="string"||!k)||new Set(x.contextKeys).size!==x.contextKeys.length)process.exit(1);
  process.stdout.write(JSON.stringify([x.pid,x.generation,[...x.contextKeys].sort()]));
} catch { process.exit(1); }
VERIFY_STARTUP_READINESS
}
wait_for_signed_version() {
  local deadline=$((SECONDS + HEALTH_DEADLINE_SECONDS)) remaining budget status restarts baseline="" baseline_pid="" active sub result pid invocation baseline_invocation="" health listeners generation stable_since="" stable_generation=""
  while :; do
    [ -z "${RECOVERY_LOCK_PROOF:-}" ] || verify_recovery_lock "$RECOVERY_LOCK_PROOF" || startup_failed "release ownership changed during recovery; retained evidence"
    remaining=$((deadline - SECONDS))
    [ "$remaining" -gt 0 ] || startup_failed "the bot did not prove signed v$REL_VERSION startup on 127.0.0.1:$PORT within ${HEALTH_DEADLINE_SECONDS}s"
    budget=$remaining; [ "$budget" -le 2 ] || budget=2
    status=$(timeout "${budget}s" systemctl show "$SERVICE" --property=ActiveState,SubState,Result,MainPID,NRestarts,InvocationID 2>/dev/null) \
      || startup_failed "could not read the bot service state"
    active=$(printf '%s\n' "$status" | sed -n 's/^ActiveState=//p')
    sub=$(printf '%s\n' "$status" | sed -n 's/^SubState=//p')
    result=$(printf '%s\n' "$status" | sed -n 's/^Result=//p')
    pid=$(printf '%s\n' "$status" | sed -n 's/^MainPID=//p')
    invocation=$(printf '%s\n' "$status" | sed -n 's/^InvocationID=//p')
    restarts=$(printf '%s\n' "$status" | sed -n 's/^NRestarts=//p')
    case "$restarts:$pid" in *[!0-9:]*|:*|*:) startup_failed "the bot service returned invalid process metadata" ;; esac
    [ -n "$baseline" ] || baseline=$restarts
    case "$active:$sub:$result" in failed:*|inactive:*|*:auto-restart:*|*:*:oom-kill|*:*:exit-code|*:*:signal|*:*:core-dump)
      startup_failed "the bot service exited or is restarting before health became ready" ;; esac
    [ "$restarts" -eq "$baseline" ] || startup_failed "the bot service restarted before health became ready"
    if [ "$pid" -gt 0 ]; then
      [[ "$invocation" =~ ^[0-9a-f]{32}$ ]] || startup_failed "the bot service has no invocation identity"
      [ -n "$baseline_invocation" ] || baseline_invocation=$invocation
      [ "$invocation" = "$baseline_invocation" ] || startup_failed "the bot service invocation changed before startup proof stabilized"
      [ -n "$baseline_pid" ] || baseline_pid=$pid
      [ "$pid" = "$baseline_pid" ] || startup_failed "the bot service process changed before startup proof stabilized"
    fi
    remaining=$((deadline - SECONDS)); [ "$remaining" -gt 0 ] || continue
    budget=$remaining; [ "$budget" -le 3 ] || budget=3
    if health=$(curl -q -fsS --noproxy '*' --connect-timeout "$budget" --max-time "$budget" "http://127.0.0.1:$PORT/api/health" 2>/dev/null | head -c 65537); then
      [ "${#health}" -le 65536 ] || startup_failed "the local health responder exceeded the response limit"
      remaining=$((deadline - SECONDS)); [ "$remaining" -gt 0 ] || continue
      budget=$remaining; [ "$budget" -le 2 ] || budget=2
      printf '%s' "$health" | timeout "${budget}s" node -e 'const fs=require("node:fs");let x;try{x=JSON.parse(fs.readFileSync(0,"utf8"))}catch{process.exit(1)};if(x.ok!==true||x.version!==process.argv[1]||(x.buildId!==undefined&&x.buildId!==process.argv[2]))process.exit(1)' "$REL_VERSION" "$REL_BUILD_ID" \
        || startup_failed "the local health responder does not match the signed release (check for a port conflict)"
      [ "$active:$sub:$result" = active:running:success ] && [ "$pid" -gt 0 ] || startup_failed "health answered without a running bot service"
      remaining=$((deadline - SECONDS)); [ "$remaining" -gt 0 ] || continue
      budget=$remaining; [ "$budget" -le 2 ] || budget=2
      listeners=$(timeout "${budget}s" ss -H -ltnp "sport = :$PORT" 2>/dev/null) || startup_failed "could not prove ownership of the bot listener"
      remaining=$((deadline - SECONDS)); [ "$remaining" -gt 0 ] || continue
      budget=$remaining; [ "$budget" -le 2 ] || budget=2
      printf '%s' "$listeners" | timeout "${budget}s" node -e 'const fs=require("node:fs");const rows=fs.readFileSync(0,"utf8").trim().split("\n").filter(Boolean);if(!rows.length||rows.some(row=>{const p=[...row.matchAll(/pid=(\d+)/g)].map(x=>x[1]);return !p.length||p.some(x=>x!==process.argv[1])}))process.exit(1)' "$pid" \
        || startup_failed "the port listener is not owned exclusively by the current bot service process"
      # Use the existing signed-customer release readiness contract. Minimal
      # public health alone never proves native/account startup, including135.
      generation=$(startup_generation "$pid") || generation=""
      if [ -n "$generation" ]; then
        if [ "$generation" != "$stable_generation" ]; then stable_generation=$generation; stable_since=$SECONDS; fi
        if [ $((SECONDS - stable_since)) -ge 10 ]; then
          # Re-read after all external probes so an old process cannot provide
          # the final proof for a changed/restarting unit.
          remaining=$((deadline - SECONDS)); [ "$remaining" -gt 0 ] || continue
          budget=$remaining; [ "$budget" -le 2 ] || budget=2
          status=$(timeout "${budget}s" systemctl show "$SERVICE" --property=ActiveState,SubState,Result,MainPID,NRestarts,InvocationID 2>/dev/null) \
            || startup_failed "could not confirm final service identity"
          [ "$(printf '%s\n' "$status" | sed -n 's/^MainPID=//p')" = "$pid" ] \
            && [ "$(printf '%s\n' "$status" | sed -n 's/^NRestarts=//p')" = "$baseline" ] \
            && [ "$(printf '%s\n' "$status" | sed -n 's/^ActiveState=//p')" = active ] \
            && [ "$(printf '%s\n' "$status" | sed -n 's/^SubState=//p')" = running ] \
            || startup_failed "the bot service changed during final startup verification"
          [ "$(printf '%s\n' "$status" | sed -n 's/^InvocationID=//p')" = "$baseline_invocation" ] \
            && [ "$(printf '%s\n' "$status" | sed -n 's/^Result=//p')" = success ] \
            && [ "$(startup_generation "$pid")" = "$generation" ] \
            || startup_failed "the final signed startup proof is stale or belongs to another invocation"
          [ -z "${RECOVERY_LOCK_PROOF:-}" ] || verify_recovery_lock "$RECOVERY_LOCK_PROOF" || startup_failed "release ownership changed before recovery confirmation; retained evidence"
          [ "$SECONDS" -lt "$deadline" ] || continue
          ok "signed bot v$REL_VERSION passed stable process, native and context startup checks"
          return 0
        fi
      else stable_since=""; stable_generation=""; fi
    else stable_since=""; stable_generation=""; fi
    remaining=$((deadline - SECONDS)); [ "$remaining" -gt 0 ] || continue
    budget=$remaining; [ "$budget" -le 2 ] || budget=2
    sleep "$budget"
  done
}


# END_STARTUP_FUNCTIONS
[ "$(id -u)" -eq 0 ] || die "run as root: curl -q -fsS \"...\" | sudo bash"
command -v systemctl >/dev/null || die "systemd is required (Ubuntu 22.04+ VPS)"
case "$HUB" in https://*) ;; *) die "the WickHunter Hub must use HTTPS" ;; esac
if [ "$CHANNEL_AWARE" = "1" ]; then
  case "$INSTALL_CHANNEL" in beta|production) ;; *) die "invalid customer release channel" ;; esac
  [ -n "$PINNED_MANIFEST_B64U" ] && [ -n "$PINNED_RELEASE_B64U" ] || die "channel installer must pin a signed release"
  # The channel route is for genuinely new hosts. Missing preference on an
  # existing install means legacy Beta, never implicit Production migration.
  [ ! -e "$APP_DIR" ] && [ ! -L "$APP_DIR" ] && [ ! -e "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] \
    && [ ! -e "$UNIT_FILE" ] && [ ! -L "$UNIT_FILE" ] \
    || die "channel installer requires a fresh host; existing installs keep their release channel"
fi

[ -z "${NODE_OPTIONS:-}" ] || die "NODE_OPTIONS preloads are not allowed for verified installation"
command -v timeout >/dev/null || die "bounded systemd inspection requires coreutils timeout"
service_load=$(timeout 3s systemctl show "$SERVICE" --all --property=LoadState 2>/dev/null || true)
service_load=$(printf '%s\n' "$service_load" | sed -n 's/^LoadState=//p')
case "$service_load" in
  not-found) existing_service=0 ;;
  loaded|error|masked|bad-setting|stub|merged) existing_service=1 ;;
  *) die "service ownership could not be inspected; no packages or installation files changed" ;;
esac
if [ "$existing_service" = "1" ] || [ -e "$APP_DIR" ] || [ -L "$APP_DIR" ] || [ -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ] || [ -e "$UNIT_FILE" ] || [ -L "$UNIT_FILE" ]; then
  recover_existing_install
  exit 0
fi

say "Installing prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt_retry update -qq || die "apt update did not complete after bounded retries; unattended upgrades may still be running"
apt_retry install -y -qq curl ca-certificates rsync tar openssl \
  || die "prerequisite packages did not install after bounded retries"

# ── Node 22 (nodesource) ────────────────────────────────────────────────────
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }
if ! command -v node >/dev/null || [ "$(node_major)" -lt "$NODE_MAJOR_WANTED" ]; then
  say "Installing Node ${NODE_MAJOR_WANTED} (nodesource)"
  nodesource_setup=$(mktemp)
  nodesource_apt_config=$(mktemp)
  curl -q -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_WANTED}.x" > "$nodesource_setup"
  printf 'DPkg::Lock::Timeout "%s";\n' "$APT_LOCK_TIMEOUT_SECONDS" > "$nodesource_apt_config"
  if ! retry_command env APT_CONFIG="$nodesource_apt_config" bash "$nodesource_setup" >/dev/null; then
    rm -f "$nodesource_setup" "$nodesource_apt_config"
    die "NodeSource repository setup did not complete after bounded retries"
  fi
  rm -f "$nodesource_setup" "$nodesource_apt_config"
  apt_retry install -y -qq nodejs || die "Node.js did not install after bounded apt retries"
fi
[ "$(node_major)" -ge "$NODE_MAJOR_WANTED" ] || die "Node ${NODE_MAJOR_WANTED}+ required, found $(node -v)"
ok "node $(node -v)"

# ── Fetch + verify the selected signed build ────────────────────────────────
say "Fetching the latest Wick Hunter $INSTALL_CHANNEL"
work=$(mktemp -d)
CHANNEL_STATE_SEEDED=0
CHANNEL_INSTALL_COMPLETE=0
cleanup() {
  if [ "$CHANNEL_AWARE" = "1" ] && [ "$CHANNEL_STATE_SEEDED" = "1" ] && [ "$CHANNEL_INSTALL_COMPLETE" != "1" ]; then
    if (verify_existing_unit) && timeout 330s systemctl stop "$SERVICE" >/dev/null 2>&1 && prove_empty_service; then
      rm -f "$APP_DIR/data/release-channel-preference.v1.json" "$APP_DIR/data/release-state.json"
    else
      warn "fresh channel startup did not stop cleanly; retained release records for support recovery"
    fi
  fi
  rm -rf "$work"
}
trap cleanup EXIT
if [ "$CHANNEL_AWARE" = "1" ]; then
  # Curl reads private headers from a 0600 config file; the license is never
  # put in a URL or process argv for the channel-specific metadata/download.
  case "$KEY" in *[!A-Za-z0-9._-]*|'') die "invalid license token" ;; esac
  printf 'header = "x-license: %s"\nheader = "x-release-channel: %s"\n' "$KEY" "$INSTALL_CHANNEL" > "$work/channel-headers.curl"
  if [ "$INSTALL_CHANNEL" = "beta" ]; then
    printf 'header = "x-early-access-opt-in: true"\n' >> "$work/channel-headers.curl"
  fi
  chmod 600 "$work/channel-headers.curl"
fi
# Ignore a machine-local curlrc and request an identity response. Never ask
# curl to decompress: Ubuntu 22.04's curl can expand a tiny response past its
# size limit before the caller gets control. The bounded verifier below handles
# the one safe compatibility exception (a gzip response) itself.
curl_hub() {
  if [ "${CHANNEL_AWARE:-0}" = "1" ]; then set -- --config "$work/channel-headers.curl" "$@"; fi
  curl -q --fail --silent --show-error \
    --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 90 \
    --retry 2 --retry-delay 1 \
    --header 'Accept-Encoding: identity' "$@"
}
# `curl --max-filesize` did not bound unknown-length bodies on the oldest curl
# we support. Stream through `head` and retain MAX+1 bytes instead: disk and
# memory stay bounded even for a hostile/chunked response. Return 65 when the
# response crossed the cap, or 1 for a transport failure.
fetch_bounded() {
  fetch_url=$1 fetch_out=$2 fetch_max=$3 fetch_accept=$4
  set +e
  curl_hub --header "Accept: $fetch_accept" "$fetch_url" \
    | head -c "$((fetch_max + 1))" > "$fetch_out"
  fetch_status=("${PIPESTATUS[@]}")
  set -e
  fetch_bytes=$(wc -c < "$fetch_out")
  if [ "$fetch_bytes" -gt "$fetch_max" ]; then return 65; fi
  [ "${fetch_status[0]:-1}" -eq 0 ] && [ "${fetch_status[1]:-1}" -eq 0 ]
}
if [ -n "$PINNED_MANIFEST_B64U" ]; then
  node - "$PINNED_MANIFEST_B64U" "$work/latest.json" <<'DECODE_PINNED_MANIFEST' || die "embedded pinned release manifest is malformed"
const fs = require("node:fs");
const [encoded, out] = process.argv.slice(2);
if (!/^[A-Za-z0-9_-]+$/.test(encoded)) process.exit(1);
const bytes = Buffer.from(encoded, "base64url");
if (!bytes.length || bytes.length > 1024 * 1024 || bytes.toString("base64url") !== encoded) process.exit(1);
fs.writeFileSync(out, bytes, { mode: 0o600 });
DECODE_PINNED_MANIFEST
else
  latest_url="$HUB/api/latest?key=$KEY"
  [ "$CHANNEL_AWARE" != "1" ] || latest_url="$HUB/api/releases/$INSTALL_CHANNEL/latest"
  if fetch_bounded "$latest_url" "$work/latest.json" 1048576 'application/json'; then
    :
  else
    fetch_code=$?
    if [ "$fetch_code" -eq 65 ]; then
      die "release manifest response exceeded 1 MiB — proxy or network corruption"
    fi
    die "could not reach the hub (or your key is expired/revoked) — contact the operator"
  fi
fi

# Verify the offline Ed25519 release authority before trusting even the file
# name. The Hub has only this public keyring; it cannot mint a release. `ok` is
# an unsigned compatibility envelope and is deliberately excluded from the
# canonical manifest bytes.
if ! node - "$work/latest.json" "$work/verified.json" "$RELEASE_KEYS_B64U" "$RELEASE_MAX_AGE_MS" "$APP_DIR" "$INSTALL_CHANNEL" <<'VERIFY_RELEASE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { TextDecoder } = require("node:util");
const [manifestPath, verifiedPath, keysB64u, maxAgeRaw, appDir, expectedChannel = "beta"] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
const write = (value, out, depth = 0) => {
  if (depth > 64) fail("manifest nests too deeply");
  if (value === null) { out.push("null"); return; }
  if (typeof value === "string") { out.push(JSON.stringify(value)); return; }
  if (typeof value === "boolean") { out.push(value ? "true" : "false"); return; }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail("non-canonical number");
    out.push(JSON.stringify(value)); return;
  }
  if (!value || typeof value !== "object") fail("unsupported manifest value");
  if (Array.isArray(value)) {
    out.push("["); value.forEach((entry, i) => { if (i) out.push(","); write(entry, out, depth + 1); }); out.push("]"); return;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  out.push("{"); keys.forEach((key, i) => { if (i) out.push(","); out.push(JSON.stringify(key), ":"); write(value[key], out, depth + 1); }); out.push("}");
};
const decode = (value, size, label) => {
  const raw = String(value ?? "");
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) fail(`${label} is not base64url`);
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== size || bytes.toString("base64url") !== raw) fail(`${label} has wrong length`);
  return bytes;
};
const MAX_MANIFEST_BYTES = 1024 * 1024;
const wire = fs.readFileSync(manifestPath);
if (!wire.length || wire.length > MAX_MANIFEST_BYTES) fail("release manifest response has invalid size");
let body = wire;
// A correctly configured Hub sends identity. Curl deliberately leaves any
// transport encoding intact, and this bounded decoder handles gzip whether a
// proxy declared it correctly or forgot Content-Encoding.
if (wire.length >= 2 && wire[0] === 0x1f && wire[1] === 0x8b) {
  try { body = zlib.gunzipSync(wire, { maxOutputLength: MAX_MANIFEST_BYTES }); }
  catch { fail("release manifest transport used invalid or oversized gzip"); }
}
let manifestText;
try { manifestText = new TextDecoder("utf-8", { fatal: true }).decode(body); }
catch { fail("release manifest response is not UTF-8 JSON (proxy or network corruption)"); }
let manifest;
try { manifest = JSON.parse(manifestText); }
catch { fail("release manifest response is not valid JSON (proxy or network corruption)"); }
let publicKeys;
try { publicKeys = JSON.parse(Buffer.from(keysB64u, "base64url").toString("utf8")); }
catch { fail("embedded release public keyring is invalid"); }
if (!manifest || manifest.schema !== "wickhunter.release.v1") fail("unsupported release schema");
for (const field of ["product","channel","platform","arch","version","buildId","file","sha256","issuedAt"]) {
  if (typeof manifest[field] !== "string" || !manifest[field]) fail(`missing ${field}`);
}
if (manifest.product !== "wickhunter" || manifest.channel !== expectedChannel || manifest.platform !== "linux" || manifest.arch !== process.arch) fail("release target mismatch");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.file) || !/^[0-9a-f]{64}$/.test(manifest.sha256)) fail("malformed release identity");
if (!Number.isInteger(manifest.minUpdateProtocol) || manifest.minUpdateProtocol < 1 || manifest.minUpdateProtocol > 1) fail("unsupported update protocol");
const issued = Date.parse(manifest.issuedAt), now = Date.now(), maxAge = Number(maxAgeRaw);
if (!Number.isFinite(issued) || issued > now + 300000 || !Number.isFinite(maxAge) || maxAge <= 0 || now - issued > maxAge) fail("stale or future release manifest");
let current = null;
try { current = JSON.parse(fs.readFileSync(`${appDir}/package.json`, "utf8")).version; } catch {}
const parts = (value) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "")); return m && m.slice(1).map(Number); };
if (current) {
  const a = parts(manifest.version), b = parts(current);
  if (!a || !b) fail("malformed installed version");
  let order = 0; for (let i = 0; i < 3 && !order; i++) order = Math.sign(a[i] - b[i]);
  if (order < 0) fail("release would downgrade this install");
}
const unsigned = { ...manifest }; delete unsigned.signatures; delete unsigned.ok;
const out = []; write(unsigned, out); const bytes = Buffer.from(out.join(""), "utf8");
let verified = false, known = false;
for (const signature of Array.isArray(manifest.signatures) ? manifest.signatures : []) {
  if (!signature || signature.alg !== "Ed25519" || !Object.hasOwn(publicKeys, signature.kid)) continue;
  known = true;
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), decode(publicKeys[signature.kid], 32, "public key")]);
  const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  try { if (crypto.verify(null, bytes, key, decode(signature.sig, 64, "signature"))) { verified = true; break; } } catch {}
}
if (!verified) fail(known ? "invalid release signature" : "unknown release key id");
fs.writeFileSync(verifiedPath, JSON.stringify(manifest), { mode: 0o600 });
VERIFY_RELEASE
then
  die "release manifest authentication failed — continuing to run the current version"
fi

# Managed instances pin the complete signed release identity chosen for this
# provisioning generation. The structured value is base64url JSON, so no
# operator-controlled release field is interpolated into shell syntax. Manual
# installs leave the value empty and continue following the latest signed beta.
if [ -n "$PINNED_RELEASE_B64U" ]; then
  if ! node - "$work/verified.json" "$PINNED_RELEASE_B64U" <<'VERIFY_PINNED_RELEASE'
const fs = require("node:fs");
const [manifestPath, pinnedB64u] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
if (!/^[A-Za-z0-9_-]+$/.test(pinnedB64u)) fail("pinned release identity is not base64url");
const bytes = Buffer.from(pinnedB64u, "base64url");
if (bytes.toString("base64url") !== pinnedB64u) fail("pinned release identity is not canonical base64url");
let manifest, pinned;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
catch { fail("verified release manifest is unreadable"); }
try { pinned = JSON.parse(bytes.toString("utf8")); }
catch { fail("pinned release identity is invalid JSON"); }
const keys = Object.keys(pinned ?? {}).sort();
if (keys.join(",") !== "buildId,sha256,version") fail("pinned release identity has unexpected fields");
for (const field of keys) {
  if (typeof pinned[field] !== "string" || !pinned[field] || manifest[field] !== pinned[field]) {
    fail(`signed release does not match pinned ${field}`);
  }
}
VERIFY_PINNED_RELEASE
  then
    die "signed release does not match this managed instance's pinned release"
  fi
fi

REL_VERSION=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' "$work/verified.json")
REL_BUILD_ID=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).buildId' "$work/verified.json")
REL_FILE=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).file' "$work/verified.json")
REL_SHA=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sha256' "$work/verified.json")
ok "latest is v$REL_VERSION"

download_url="$HUB/download/$REL_FILE?key=$KEY"
[ "$CHANNEL_AWARE" != "1" ] || download_url="$HUB/api/releases/$INSTALL_CHANNEL/download/$REL_FILE"
if fetch_bounded "$download_url" "$work/$REL_FILE" 268435456 'application/gzip'; then
  :
else
  fetch_code=$?
  [ "$fetch_code" -eq 65 ] && die "release artifact exceeded the 256 MiB safety limit"
  die "download failed"
fi
echo "$REL_SHA  $work/$REL_FILE" | sha256sum -c --quiet - || die "sha256 mismatch — corrupt download, try again"
ok "signature and artifact hash verified for $REL_FILE"

# ── Unpack: tarball root is the app dir; data/ always survives ──────────────
say "Installing to $APP_DIR"
mkdir -p "$work/unpack"
if [ "$CHANNEL_AWARE" = "1" ]; then
  mkdir "$APP_DIR" || die "another install created $APP_DIR; refusing to overwrite its channel"
else
  mkdir "$APP_DIR" || die "another installation appeared; refusing to overwrite it"
fi
tar -xzf "$work/$REL_FILE" -C "$work/unpack"
# Tolerate both layouts: files at archive root, or a single top-level dir.
src="$work/unpack"
if [ ! -f "$src/package.json" ]; then
  src=$(find "$work/unpack" -mindepth 1 -maxdepth 1 -type d | head -n1)
  [ -n "$src" ] && [ -f "$src/package.json" ] || die "unexpected tarball layout (no package.json)"
fi

PACKAGE_VERSION=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' "$src/package.json")
[ "$PACKAGE_VERSION" = "$REL_VERSION" ] || die "signed release version $REL_VERSION does not match package version $PACKAGE_VERSION"
# Preflight the authenticated archive before replacing any installed files.
# Every customer runs the protected native core, including manually installed
# hosts. Capture child errors: they may include URLs or credentials.
preflight_artifact() {
  node - "$1" <<'PREFLIGHT_ARTIFACT'
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = process.argv[2];
const fail = (message) => { console.error(message); process.exit(1); };
let pkg;
try { pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
catch { fail("unreadable signed package metadata"); }
const entries = { "node server.js": "server.js", "node dist/server/index.js": "dist/server/index.js" };
const entry = entries[pkg.scripts?.start];
if (!entry || !fs.statSync(path.join(root, entry), { throwIfNoEntry: false })?.isFile()) fail("signed package has no supported server entry");
try { execFileSync(process.execPath, ["--check", path.join(root, entry)], { timeout: 10000, maxBuffer: 65536, stdio: "pipe" }); }
catch { fail("signed server entry failed the Node syntax preflight"); }
if (process.arch !== "x64") fail("protected native core currently requires Linux x64");
const core = path.join(root, "bin/wh-core-linux-amd64");
try { fs.accessSync(core, fs.constants.X_OK); }
catch { fail("signed release is missing its executable protected native core"); }
let version;
try { version = execFileSync(core, ["-version"], { cwd: root, timeout: 5000, maxBuffer: 4096, stdio: "pipe", encoding: "utf8" }); }
catch { fail("protected native core could not execute on this host"); }
if (!/^wh-core \S+ protocol=\d+ algorithm=\d+$/m.test(version)) fail("protected native core did not identify as the production wh-core");
process.stdout.write(entry);
PREFLIGHT_ARTIFACT
}
ENTRY=$(preflight_artifact "$src") || die "signed artifact startup preflight failed; installed files were not replaced"
identity=$(verify_signed_tree "$src") || die "signed artifact integrity preflight failed"
[ "$(printf '%s\n' "$identity" | sed -n '1p')" = "$REL_VERSION" ] && [ "$(printf '%s\n' "$identity" | sed -n '2p')" = "$REL_BUILD_ID" ] \
  || die "signed artifact build identity differs from the release manifest"
REL_CORE_SHA=$(printf '%s\n' "$identity" | sed -n '3p')
rsync -a --checksum --delete --exclude data --exclude node_modules "$src/" "$APP_DIR/"
mkdir -p "$APP_DIR/data"
if [ "$CHANNEL_AWARE" = "1" ]; then
  # These new records exist only on a fresh host and only for an archive whose
  # channel-bound signature and bytes were verified above. Seed before first
  # boot so the app never briefly routes a Production artifact as legacy Beta.
  # A failed installation stops the service and removes both records in EXIT.
  CHANNEL_STATE_SEEDED=1
  if ! node - "$work/verified.json" "$APP_DIR/data" "$INSTALL_CHANNEL" <<'SEED_CHANNEL_STATE'
const fs = require("node:fs");
const path = require("node:path");
const [manifestFile, dataDir, expectedChannel] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
if (manifest.schema !== "wickhunter.release.v1" || manifest.channel !== expectedChannel ||
    !["beta", "production"].includes(expectedChannel)) process.exit(1);
const now = new Date().toISOString();
const preference = { schema: 1, channel: expectedChannel,
  betaOptIn: expectedChannel === "beta", updatedAt: now };
const state = { schema: manifest.schema, channel: manifest.channel,
  version: manifest.version, buildId: manifest.buildId,
  sha256: manifest.sha256, issuedAt: manifest.issuedAt, installedAt: now };
const records = [
  ["release-channel-preference.v1.json", preference],
  ["release-state.json", state],
];
for (const [name, value] of records) {
  const file = path.join(dataDir, name);
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
const dir = fs.openSync(dataDir, "r");
try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
SEED_CHANNEL_STATE
  then
    die "could not seed verified channel and installed identity"
  fi
fi

# The beta artifact runs on Node builtins + what is bundled into server.js;
# its only declared deps are ws's OPTIONAL native accelerators, and it ships
# no lockfile — so `npm ci` is wrong here (it dies without one, which took a
# live tester install down). Best-effort `npm install`, never fatal.
say "Installing optional runtime accelerators"
if [ -n "${LIQHUNTER_BOOTSTRAP_PASSWORD:-}" ]; then
  ok "hosted install uses only the signed artifact; optional registry packages skipped"
elif ( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ); then
  ok "accelerators installed"
else
  warn "optional accelerators skipped — the bot runs fine without them"
fi

# ── Configuration (idempotent: existing values are kept) ────────────────────
say "Configuring"
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

# EnvironmentFile is data, never shell code. Write one double-quoted value
# with systemd's escaping, and decode previous quoted/unquoted assignments on
# reruns. Values travel on fd 3, never in a command argument or error message.
env_file() { # env_file get|set|unset NAME
  node - "$ENV_FILE" "$1" "$2" <<'ENV_FILE_CODEC'
const fs = require("node:fs");
const [file, mode, name] = process.argv.slice(2);
const fail = () => { console.error("invalid EnvironmentFile assignment; inspect the root-only environment file locally"); process.exit(1); };
if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !["get", "set", "unset"].includes(mode)) fail();
const text = fs.readFileSync(file, "utf8");
// Parse records, including multiline quoted values and backslash continuations.
// Comments and unrelated assignments remain byte-for-byte unchanged.
const records = [];
let pos = 0;
while (pos < text.length) {
  const start = pos;
  const match = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t\r]*/.exec(text.slice(pos));
  if (!match) { const end = text.indexOf("\n", pos); pos = end < 0 ? text.length : end + 1; records.push({ raw: text.slice(start, pos) }); continue; }
  pos += match[0].length;
  let value = "", quote = null, trailing = "", whitespace = "";
  if (text[pos] === '"' || text[pos] === "'") quote = text[pos++];
  let closed = !quote;
  while (pos < text.length) {
    const c = text[pos++];
    if (quote && c === quote) { closed = true; break; }
    if (!quote && c === "\n") break;
    if (c === "\\" && quote !== "'") {
      if (pos === text.length) { value += "\\"; break; }
      const next = text[pos++];
      if (next === "\n") continue;
      if (!quote) { value += whitespace + next; whitespace = ""; }
      else if (['\\', '"', '$', '`'].includes(next)) value += next;
      else value += "\\" + next;
    } else if (!quote && /[ \t\r]/.test(c)) whitespace += c;
    else { value += whitespace + c; whitespace = ""; }
  }
  if (quote) {
    while (pos < text.length && text[pos] !== "\n") trailing += text[pos++];
    if (text[pos] === "\n") pos++;
  }
  // Refuse malformed unrelated records too: an unterminated quote can absorb
  // every later credential, so appending another value would corrupt the file.
  if (!closed || trailing.trim()) fail();
  records.push({ name: match[1], value, raw: text.slice(start, pos) });
}
if (mode === "get") {
  process.stdout.write(records.filter((r) => r.name === name).at(-1)?.value ?? "");
} else {
  let output = records.filter((r) => r.name !== name).map((r) => r.raw).join("");
  if (mode === "set") {
    const value = fs.readFileSync(3, "utf8");
    if (/[\0\r\n]/.test(value)) fail();
    const encoded = '"' + value.replace(/[\\"$`]/g, (c) => "\\" + c) + '"';
    if (output && !output.endsWith("\n")) output += "\n";
    output += name + "=" + encoded + "\n";
  }
  // Same-directory atomic replacement retains mode 0600 even on a rerun.
  const tmp = file + ".tmp-" + process.pid;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, output); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
ENV_FILE_CODEC
}
get_env() { env_file get "$1"; }
set_env() {
  env_file set "$1" 3< <(printf '%s' "$2")
  [ "$(get_env "$1")" = "$2" ] || die "EnvironmentFile value did not round-trip; configuration is incomplete"
}
unset_env() { env_file unset "$1"; }

SECRET=$(get_env LIQHUNTER_SECRET)
if [ -z "$SECRET" ]; then
  ask SECRET "LIQHUNTER_SECRET (Enter to auto-generate): " --secret
  [ -n "$SECRET" ] || SECRET=$(openssl rand -hex 32)
  set_env LIQHUNTER_SECRET "$SECRET"
  ok "secret configured"
else
  ok "keeping existing LIQHUNTER_SECRET"
fi

# The bot refuses to boot on a plaintext password under 8 characters (v0.74.26+) — so the
# installer must never store one. The old auto-generate (base64 12 bytes minus
# stripped symbols) landed at ~15 chars and crash-looped a real tester box.
BOOTSTRAP_PW=${LIQHUNTER_BOOTSTRAP_PASSWORD:-$(get_env LIQHUNTER_BOOTSTRAP_PASSWORD)}
LOGIN_PW=$(get_env LIQHUNTER_LOGIN_PASSWORD)
LOGIN_HASH=$(get_env LIQHUNTER_LOGIN_PASSWORD_HASH)
DURABLE_CREDENTIAL=""
[ -s "$APP_DIR/data/app-credential.json" ] && DURABLE_CREDENTIAL=1
if [ -n "$BOOTSTRAP_PW" ]; then
  [ "${#BOOTSTRAP_PW}" -ge 8 ] || die "LIQHUNTER_BOOTSTRAP_PASSWORD must be at least 8 characters"
  unset_env LIQHUNTER_LOGIN_PASSWORD
  unset_env LIQHUNTER_LOGIN_PASSWORD_HASH
  set_env LIQHUNTER_BOOTSTRAP_PASSWORD "$BOOTSTRAP_PW"
  ok "temporary hosted login configured; the application will require a password change"
fi
if [ -z "$BOOTSTRAP_PW" ] && [ -z "$DURABLE_CREDENTIAL" ] && [ -n "$LOGIN_HASH" ]; then
  # Match AppAuth's accepted scrypt parameters and decoded byte lengths.
  # Prefer an existing valid hash over competing plaintext; never replace it
  # with a newly generated password, and never guess at a malformed hash.
  printf '%s' "$LOGIN_HASH" | node -e 'const s=require("node:fs").readFileSync(0,"utf8").split("$");process.exit(s.length===6&&s[0]==="scrypt"&&s[1]==="16384"&&s[2]==="8"&&s[3]==="1"&&Buffer.from(s[4],"base64url").length===16&&Buffer.from(s[5],"base64url").length===32?0:1)' \
    || die "existing login password hash is malformed; credential values were preserved for local repair"
  if [ -n "$LOGIN_PW" ]; then
    unset_env LIQHUNTER_LOGIN_PASSWORD
    LOGIN_PW=""
    ok "keeping the existing login password hash; removed competing plaintext password"
  fi
fi
if [ -z "$BOOTSTRAP_PW" ] && [ -n "$LOGIN_PW" ] && [ "${#LOGIN_PW}" -lt 8 ]; then
  warn "existing login password is under the bot's 8-character minimum — replacing it"
  unset_env LIQHUNTER_LOGIN_PASSWORD
  LOGIN_PW=""
fi
if [ -z "$BOOTSTRAP_PW" ] && [ -z "$DURABLE_CREDENTIAL" ] && [ -z "$LOGIN_PW" ] && [ -z "$LOGIN_HASH" ]; then
  while :; do
    ask LOGIN_PW "Choose a dashboard login password (8+ characters; Enter to auto-generate): " --secret
    if [ -z "$LOGIN_PW" ] || [ "${#LOGIN_PW}" -ge 8 ]; then break; fi
    warn "too short — the bot requires at least 8 characters"
  done
  GENERATED=""
  if [ -z "$LOGIN_PW" ]; then LOGIN_PW=$(openssl rand -hex 12); GENERATED=1; fi
  set_env LIQHUNTER_LOGIN_PASSWORD "$LOGIN_PW"
  if [ -n "$GENERATED" ]; then
    say "YOUR DASHBOARD PASSWORD (write it down; also stored in $ENV_FILE):"
    printf '\n    %s\n\n' "$LOGIN_PW"
  else
    ok "login password configured"
  fi
elif [ -z "$BOOTSTRAP_PW" ] && [ -z "$DURABLE_CREDENTIAL" ]; then
  ok "keeping existing login password or password hash"
elif [ -z "$BOOTSTRAP_PW" ]; then
  ok "keeping the application's durable login credential"
fi

set_env LIQHUNTER_HUB_ORIGIN "$HUB"
if [ -n "${LIQHUNTER_HOSTED_MAX_ACCOUNTS:-}" ]; then
  case "$LIQHUNTER_HOSTED_MAX_ACCOUNTS" in *[!0-9]*|'') die "LIQHUNTER_HOSTED_MAX_ACCOUNTS must be a positive integer" ;; esac
  [ "$LIQHUNTER_HOSTED_MAX_ACCOUNTS" -ge 1 ] || die "LIQHUNTER_HOSTED_MAX_ACCOUNTS must be a positive integer"
  set_env LIQHUNTER_HOSTED_MAX_ACCOUNTS "$LIQHUNTER_HOSTED_MAX_ACCOUNTS"
fi

# License key: what the bot presents at check-in. Mode 600 — it is a secret.
printf '%s\n' "$KEY" > "$APP_DIR/data/license.key"
chmod 600 "$APP_DIR/data/license.key"
ok "license key installed"

# ── systemd ─────────────────────────────────────────────────────────────────
say "Installing the systemd service"
# ENTRY was selected from the signed package start script and syntax-checked
# before rsync; stale files on a rerun cannot select a different entry.
unit_tmp=$(mktemp)
printf '%s\n' \
  '[Unit]' \
  "Description=Wick Hunter $INSTALL_CHANNEL bot" \
  'After=network-online.target' \
  'Wants=network-online.target' \
  '' \
  '[Service]' \
  "WorkingDirectory=$APP_DIR" \
  "EnvironmentFile=$ENV_FILE" \
  "ExecStart=$(command -v node) $ENTRY" \
  'Restart=always' \
  'RestartSec=5' \
  'SendSIGKILL=no' \
  'TimeoutStopSec=300s' \
  '' \
  '[Install]' \
  'WantedBy=multi-user.target' \
  > "$unit_tmp"
install -m 644 "$unit_tmp" "$UNIT_FILE"; rm -f "$unit_tmp"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
# Keep every health attempt inside one elapsed-time budget. Detect a failed
# process or restart loop before waiting for the full budget. Diagnostic output
# is allowlisted metadata/codes; raw journals and health bodies stay private.

STARTUP_SINCE=$(date +%s)
timeout 330s systemctl restart "$SERVICE" || startup_failed "systemd could not restart the bot"
say "Waiting for the bot to come up"
wait_for_signed_version

# A hosted install is ready only after the app has durably consumed the
# temporary password into its forced-change credential record. Remove the
# plaintext environment copy once that proof exists; the record remains
# authoritative across restart and update.
if [ -n "$BOOTSTRAP_PW" ]; then
  node - "$APP_DIR/data/app-credential.json" <<'VERIFY_BOOTSTRAP_CREDENTIAL'
const fs = require("node:fs");
const record = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (record.createdFrom !== "bootstrap" || record.mustChange !== true || typeof record.hash !== "string" || !record.hash) process.exit(1);
VERIFY_BOOTSTRAP_CREDENTIAL
  unset_env LIQHUNTER_BOOTSTRAP_PASSWORD
  unset BOOTSTRAP_PW
  unset LIQHUNTER_BOOTSTRAP_PASSWORD
  STARTUP_SINCE=$(date +%s)
  timeout 330s systemctl restart "$SERVICE" || startup_failed "systemd could not restart the bot after credential seeding"
  wait_for_signed_version
  ok "temporary hosted login was seeded and removed from the restarted service environment"
fi

# Verify the public endpoint with normal CA/hostname checks before claiming
# that setup is complete. The signed version must be served through HTTPS.
verify_public_https() {
  local public_ip=$1 health_file=$2
  fetch_bounded "https://${public_ip}/api/health" "$health_file" 65536 'application/json' || return 1
  node - "$health_file" "$REL_VERSION" <<'VERIFY_PUBLIC_HTTPS'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
try {
  const health = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (health.ok !== true || health.version !== version) process.exit(1);
} catch { process.exit(1); }
VERIFY_PUBLIC_HTTPS
}

# ── HTTPS via the bot's own setup (nginx + Let's Encrypt on the public IP) ──
if [ -x "$APP_DIR/scripts/vps-setup.sh" ] || [ -f "$APP_DIR/scripts/vps-setup.sh" ]; then
  say "Setting up trusted HTTPS (the bot's own vps-setup)"
  LIQHUNTER_REQUIRE_HTTPS=1 LIQHUNTER_SERVICE_NAME=$SERVICE LIQHUNTER_ENV_FILE=$ENV_FILE bash "$APP_DIR/scripts/vps-setup.sh" \
    || die "HTTPS setup failed — re-run this installer to retry"
else
  die "no scripts/vps-setup.sh in this build; trusted HTTPS setup is required"
fi

PUBLIC_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
[ -n "$PUBLIC_IP" ] || die "could not determine the VPS address for HTTPS verification"
verify_public_https "$PUBLIC_IP" "$work/public-health.json" || die "trusted public HTTPS did not serve the signed app version — setup is incomplete"
CHANNEL_INSTALL_COMPLETE=1
say "Done — Wick Hunter $INSTALL_CHANNEL v$REL_VERSION is installed"
ok "URL:      https://${PUBLIC_IP}/"
ok "Login:    use your configured dashboard password or hosted access details"
ok "Upgrade:  use the authenticated app updater; installer reruns verify or recover the current release"
ok "Logs:     journalctl -u $SERVICE -f"
