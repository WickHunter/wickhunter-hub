#!/usr/bin/env bash
# SEC-10 Hub auth-only runtime patch. Run on the Hub host with a copied,
# reviewed server.js artifact, a root-only valid probe licence file, and the
# Alpha install root. The exact old binary is kept for atomic rollback.
set -Eeuo pipefail

HUB_DIR=/opt/wickhunter-hub
TARGET=$HUB_DIR/dist/src/server.js
BASELINE_SHA=712739282ac8236d98f3205eb9b1e4a8bbd4787b247f28f60ae5fbdc01cb8ca3
PATCH_SHA=797c82eb9a20a68dc1724c6f1dfc75a4dfed0666e485b4ab7ef9807cc4b52f7f
ARTIFACT=${1:-}
PROBE_FILE=${HUB_SEC10_PROBE_LICENSE_FILE:-}
ALPHA_DIR=${HUB_SEC10_ALPHA_DIR:-}

die() { printf 'SEC-10 Hub deploy refused: %s\n' "$*" >&2; exit 1; }
sha() { sha256sum "$1" | cut -d ' ' -f 1; }
# Include relative names, file bytes, modes and symlink destinations. This
# detects changes in protected Alpha trees without printing any file content.
tree_sha() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = process.argv[2], h = createHash('sha256');
function walk(full, relative) {
  const s = fs.lstatSync(full);
  h.update(relative + '\0' + s.mode.toString(8) + '\0');
  if (s.isSymbolicLink()) h.update('L' + fs.readlinkSync(full) + '\0');
  else if (s.isFile()) h.update('F').update(fs.readFileSync(full));
  else if (s.isDirectory()) {
    h.update('D');
    for (const name of fs.readdirSync(full).sort()) walk(path.join(full, name), path.join(relative, name));
  } else throw new Error('unsupported protected path: ' + full);
}
walk(root, '.');
process.stdout.write(h.digest('hex'));
NODE
}

[ "$(id -u)" -eq 0 ] || die 'run as root on the Hub host'
[ -n "$ARTIFACT" ] && [ -f "$ARTIFACT" ] && [ ! -L "$ARTIFACT" ] || die 'supply the compiled server.js artifact as argument'
[ -n "$PROBE_FILE" ] && [ -f "$PROBE_FILE" ] && [ ! -L "$PROBE_FILE" ] || die 'set HUB_SEC10_PROBE_LICENSE_FILE to a root-only valid licence file'
[ "$(stat -c %a "$PROBE_FILE")" = 600 ] || die 'probe licence file must have mode 0600'
[ -n "$ALPHA_DIR" ] && [ -d "$ALPHA_DIR/dist" ] && [ -d "$ALPHA_DIR/public" ] \
  && [ -f "$ALPHA_DIR/package.json" ] || die 'set HUB_SEC10_ALPHA_DIR to the installed Alpha root'
[ -f "$TARGET" ] && [ ! -L "$TARGET" ] || die 'installed Hub server.js is missing or a symlink'
[ "$(sha "$ARTIFACT")" = "$PATCH_SHA" ] || die 'artifact hash differs from reviewed source build'
[ "$(sha "$TARGET")" = "$BASELINE_SHA" ] || die 'live binary differs from the reviewed 0.4.61 baseline; inspect before any change'
systemctl is-active --quiet wickhunter-hub || die 'Hub service is not active before change'
old_pid=$(systemctl show -p MainPID --value wickhunter-hub)
[[ "$old_pid" =~ ^[1-9][0-9]*$ ]] || die 'Hub has no running MainPID'
IFS= read -r PROBE_LICENSE < "$PROBE_FILE" || true
[[ "$PROBE_LICENSE" =~ ^[A-Za-z0-9._-]+$ ]] || die 'probe licence has an invalid token shape'

BETA_LATEST=$HUB_DIR/releases/latest.json
[ -f "$BETA_LATEST" ] && [ ! -L "$BETA_LATEST" ] || die 'Beta latest.json is missing or a symlink'
BETA_FILE=$(node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(m.file??""))' "$BETA_LATEST")
[[ "$BETA_FILE" =~ ^[A-Za-z0-9._-]+$ ]] || die 'Beta manifest file name is not a safe basename'
BETA_ARTIFACT=$HUB_DIR/releases/$BETA_FILE
[ -f "$BETA_ARTIFACT" ] && [ ! -L "$BETA_ARTIFACT" ] || die 'Beta release artifact is missing or a symlink'
beta_latest_before=$(sha "$BETA_LATEST")
beta_artifact_before=$(sha "$BETA_ARTIFACT")
alpha_dist_before=$(tree_sha "$ALPHA_DIR/dist")
alpha_public_before=$(tree_sha "$ALPHA_DIR/public")
alpha_package_before=$(tree_sha "$ALPHA_DIR/package.json")

health() {
  curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8091/api/health \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const h=JSON.parse(s);process.exit(h.ok===true&&h.version==="0.4.61"?0:1)}catch{process.exit(1)}})'
}
health || die 'Hub health/version preflight failed'

probe_dir=$(mktemp -d)
backup=$(mktemp "$HUB_DIR/dist/src/.server.js.sec10-pre.XXXXXXXX")
cp -p "$TARGET" "$backup"
old_uid=$(stat -c %u "$TARGET")
old_gid=$(stat -c %g "$TARGET")
old_mode=$(stat -c %a "$TARGET")
installed=false
candidate=''
finish() {
  local prior_status=$?
  trap - EXIT
  if [ "$installed" = true ]; then
    local restore
    restore=$(mktemp "$HUB_DIR/dist/src/.server.js.sec10-restore.XXXXXXXX")
    cp -p "$backup" "$restore"
    mv -f "$restore" "$TARGET"
    systemctl restart wickhunter-hub || true
    printf 'SEC-10 Hub runtime restored atomically from %s after a failed check.\n' "$backup" >&2
  fi
  [ -z "$candidate" ] || rm -f "$candidate"
  rm -rf "$probe_dir"
  exit "$prior_status"
}
trap finish EXIT

header_probe() {
  local status file digest route
  status=$(curl --silent --show-error --max-time 20 --output "$probe_dir/manifest.json" --write-out '%{http_code}' --config - <<EOF
url = "http://127.0.0.1:8091/api/latest"
header = "x-license: $PROBE_LICENSE"
EOF
  )
  [ "$status" = 200 ] || return 1
  read -r file digest < <(node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(String(m.file??"")+" "+String(m.sha256??""))' "$probe_dir/manifest.json")
  [ "$file" = "$BETA_FILE" ] && [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  [ "$digest" = "$beta_artifact_before" ] || return 1
  status=$(curl --silent --show-error --max-time 120 --output "$probe_dir/download" --write-out '%{http_code}' --config - <<EOF
url = "http://127.0.0.1:8091/download/$file"
header = "x-license: $PROBE_LICENSE"
EOF
  )
  [ "$status" = 200 ] && [ "$(sha "$probe_dir/download")" = "$digest" ] || return 1
  for route in /api/latest "/download/$file"; do
    status=$(curl --silent --show-error --max-time 20 --output /dev/null --write-out '%{http_code}' \
      --header 'x-license: LHK1.invalid.signature' "http://127.0.0.1:8091$route")
    [ "$status" = 403 ] || return 1
  done
}

candidate=$(mktemp "$HUB_DIR/dist/src/.server.js.sec10-new.XXXXXXXX")
install -o "$old_uid" -g "$old_gid" -m "$old_mode" "$ARTIFACT" "$candidate"
mv -f "$candidate" "$TARGET"
candidate=''
installed=true
systemctl restart wickhunter-hub
ready=false
for _ in {1..20}; do
  new_pid=$(systemctl show -p MainPID --value wickhunter-hub)
  if systemctl is-active --quiet wickhunter-hub && [[ "$new_pid" =~ ^[1-9][0-9]*$ ]] \
    && [ "$new_pid" != "$old_pid" ] && health; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || die 'new Hub process did not pass PID, service and health checks'
header_probe || die 'new Hub process failed header metadata/download or invalid-header checks'
[ "$(sha "$TARGET")" = "$PATCH_SHA" ] || die 'installed binary hash changed after restart'
[ "$(stat -c %u "$TARGET")" = "$old_uid" ] && [ "$(stat -c %g "$TARGET")" = "$old_gid" ] \
  && [ "$(stat -c %a "$TARGET")" = "$old_mode" ] || die 'installed binary ownership or mode changed'
[ "$(sha "$BETA_LATEST")" = "$beta_latest_before" ] && [ "$(sha "$BETA_ARTIFACT")" = "$beta_artifact_before" ] \
  || die 'protected Beta latest or artifact changed'
[ "$(tree_sha "$ALPHA_DIR/dist")" = "$alpha_dist_before" ] \
  && [ "$(tree_sha "$ALPHA_DIR/public")" = "$alpha_public_before" ] \
  && [ "$(tree_sha "$ALPHA_DIR/package.json")" = "$alpha_package_before" ] \
  || die 'protected Alpha dist, public or package changed'
installed=false
printf 'SEC-10 Hub auth-only runtime verified at PID %s; prior binary kept at %s\n' "$new_pid" "$backup"
