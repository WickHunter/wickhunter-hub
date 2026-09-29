#!/usr/bin/env bash
# Reviewed SEC-10 Hub runtime patch. Run on the Hub host only after copying
# the single compiled server.js artifact and supplying a root-readable probe
# licence file. No source checkout, data, releases, Beta client or Alpha app
# file is changed. A failed restart/probe restores the exact prior binary.
set -Eeuo pipefail

HUB_DIR=/opt/wickhunter-hub
TARGET=$HUB_DIR/dist/src/server.js
BASELINE_SHA=712739282ac8236d98f3205eb9b1e4a8bbd4787b247f28f60ae5fbdc01cb8ca3
PATCH_SHA=797c82eb9a20a68dc1724c6f1dfc75a4dfed0666e485b4ab7ef9807cc4b52f7f
ARTIFACT=${1:-}
PROBE_FILE=${HUB_SEC10_PROBE_LICENSE_FILE:-}

die() { printf 'SEC-10 Hub deploy refused: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die 'run as root on the Hub host'
[ -n "$ARTIFACT" ] && [ -f "$ARTIFACT" ] && [ ! -L "$ARTIFACT" ] || die 'supply the compiled server.js artifact as argument'
[ -n "$PROBE_FILE" ] && [ -f "$PROBE_FILE" ] && [ ! -L "$PROBE_FILE" ] || die 'set HUB_SEC10_PROBE_LICENSE_FILE to a root-only valid licence file'
[ "$(stat -c %a "$PROBE_FILE")" = 600 ] || die 'probe licence file must have mode 0600'
[ -f "$TARGET" ] && [ ! -L "$TARGET" ] || die 'installed Hub server.js is missing or a symlink'
[ "$(sha256sum "$ARTIFACT" | cut -d ' ' -f 1)" = "$PATCH_SHA" ] || die 'artifact hash differs from reviewed source build'
[ "$(sha256sum "$TARGET" | cut -d ' ' -f 1)" = "$BASELINE_SHA" ] || die 'live binary differs from the reviewed 0.4.61 baseline; inspect before any change'
systemctl is-active --quiet wickhunter-hub || die 'Hub service is not active before change'
IFS= read -r PROBE_LICENSE < "$PROBE_FILE" || true
[[ "$PROBE_LICENSE" =~ ^[A-Za-z0-9._-]+$ ]] || die 'probe licence has an invalid token shape'

health() {
  curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8091/api/health \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const h=JSON.parse(s);process.exit(h.ok===true&&h.version==="0.4.61"?0:1)}catch{process.exit(1)}})'
}
header_probe() {
  local status
  status=$(curl --silent --show-error --max-time 8 --output /dev/null --write-out '%{http_code}' --config - <<EOF
url = "http://127.0.0.1:8091/api/latest"
header = "x-license: $PROBE_LICENSE"
EOF
  )
  [ "$status" = 200 ]
}
health || die 'Hub health/version preflight failed'

backup=$(mktemp "$HUB_DIR/dist/src/.server.js.sec10-pre.XXXXXXXX")
cp -p "$TARGET" "$backup"
chmod 0600 "$backup"
installed=false
rollback() {
  if [ "$installed" = true ]; then
    cp -p "$backup" "$TARGET"
    systemctl restart wickhunter-hub || true
    printf 'SEC-10 Hub runtime was restored from %s after a failed check.\n' "$backup" >&2
  fi
}
trap rollback EXIT

candidate=$(mktemp "$HUB_DIR/dist/src/.server.js.sec10-new.XXXXXXXX")
install -o root -g root -m 0644 "$ARTIFACT" "$candidate"
mv -f "$candidate" "$TARGET"
installed=true
systemctl restart wickhunter-hub
ready=false
for _ in {1..20}; do
  if systemctl is-active --quiet wickhunter-hub && health && header_probe; then
    ready=true
    break
  fi
  sleep 1
done
[ "$ready" = true ] || die 'new Hub runtime did not pass service, health and header-auth probes'
[ "$(sha256sum "$TARGET" | cut -d ' ' -f 1)" = "$PATCH_SHA" ] || die 'installed binary hash changed after restart'
installed=false
trap - EXIT
printf 'SEC-10 Hub auth-only runtime verified. Prior binary kept at %s\n' "$backup"
