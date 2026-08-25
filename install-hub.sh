#!/usr/bin/env bash
# Install (or upgrade) the Wick Hunter hub on the operator VPS.
#
# Run from a checkout of this repo, as root:
#   sudo bash install-hub.sh
#
# What it does: node check, sync to /opt/wickhunter-hub, build, systemd unit on
# 127.0.0.1:8091, signing keygen (first run), HUB_ADMIN_TOKEN (generated and
# echoed ONCE), and it emits the nginx /hub/ location snippet with instructions
# — it NEVER edits the live nginx config itself. Safe to re-run: existing
# data/, releases/, and the admin token are all kept.
set -Eeuo pipefail

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   + %s\n' "$*"; }
warn() { printf '   ! %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

HUB_DIR=${HUB_DIR:-/opt/wickhunter-hub}
ENV_FILE=${HUB_ENV_FILE:-/etc/wickhunter-hub/env}
SERVICE=wickhunter-hub
UNIT_FILE=/etc/systemd/system/${SERVICE}.service
PORT=8091
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash install-hub.sh"
command -v systemctl >/dev/null || die "systemd is required"
command -v node >/dev/null || die "Node 22+ is required — install it first (nodesource: https://deb.nodesource.com)"
NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 22 ] || die "Node 22+ required, found $(node -v)"
[ -f "$SRC_DIR/package.json" ] || die "run this from a checkout of wickhunter-hub"

say "Syncing the hub to $HUB_DIR"
if [ "$SRC_DIR" != "$HUB_DIR" ]; then
  command -v rsync >/dev/null || { apt-get update -qq && apt-get install -y -qq rsync; }
  mkdir -p "$HUB_DIR"
  # data/ and releases/ are live state and never come from the checkout.
  rsync -a --delete \
    --exclude data --exclude releases --exclude node_modules --exclude dist --exclude .git \
    "$SRC_DIR/" "$HUB_DIR/"
  ok "synced from $SRC_DIR"
else
  ok "already running from $HUB_DIR"
fi
mkdir -p "$HUB_DIR/data" "$HUB_DIR/releases"
chmod 700 "$HUB_DIR/data"

say "Building"
cd "$HUB_DIR"
# The build needs the TypeScript toolchain, production needs NOTHING (zero
# runtime deps) — so: full install, build, then prune the toolchain away.
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null
npm prune --omit=dev --no-audit --no-fund >/dev/null
ok "built dist/ ($(node -pe 'require("./package.json").version'))"

if [ ! -f "$HUB_DIR/data/license-signing.key" ]; then
  say "Generating the license signing key (first run)"
  node dist/bin/keygen.js
  warn "BAKE THE PUBLIC KEY ABOVE INTO THE BOT — tokens verify against it."
  warn "Back up $HUB_DIR/data/license-signing.key; losing it orphans every issued key."
else
  ok "keeping existing signing key at $HUB_DIR/data/license-signing.key"
fi

say "Configuring $ENV_FILE"
mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ] || ! grep -q '^HUB_ADMIN_TOKEN=' "$ENV_FILE"; then
  ADMIN_TOKEN=$(node -pe 'require("node:crypto").randomBytes(32).toString("hex")')
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  printf 'HUB_ADMIN_TOKEN=%s\n' "$ADMIN_TOKEN" >> "$ENV_FILE"
  say "YOUR ADMIN TOKEN — shown exactly once, then only readable from $ENV_FILE:"
  printf '\n    %s\n\n' "$ADMIN_TOKEN"
else
  ok "keeping existing HUB_ADMIN_TOKEN (read it from $ENV_FILE if needed)"
fi
PUBLIC_IP=${HUB_PUBLIC_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')}
if ! grep -q '^HUB_PUBLIC_ORIGIN=' "$ENV_FILE"; then
  [ -n "$PUBLIC_IP" ] || die "could not detect the public IP; set HUB_PUBLIC_IP and re-run"
  printf 'HUB_PUBLIC_ORIGIN=https://%s/hub\n' "$PUBLIC_IP" >> "$ENV_FILE"
fi
grep -q '^HUB_PORT=' "$ENV_FILE" || printf 'HUB_PORT=%s\n' "$PORT" >> "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "origin: $(sed -n 's/^HUB_PUBLIC_ORIGIN=//p' "$ENV_FILE")"
if ! grep -q '^HUB_RELEASE_PUBLIC_KEYS_JSON=' "$ENV_FILE"; then
  die "HUB_RELEASE_PUBLIC_KEYS_JSON is required. Generate the dedicated OFFLINE release key in the app repo, paste only its public keyring JSON into $ENV_FILE, sign the current release, then re-run. Never copy the private release key to this Hub."
fi

say "Installing the systemd service"
unit_tmp=$(mktemp)
printf '%s\n' \
  '[Unit]' \
  'Description=Wick Hunter beta hub (licensing + distribution; NO trading code)' \
  'After=network-online.target' \
  'Wants=network-online.target' \
  '' \
  '[Service]' \
  "WorkingDirectory=$HUB_DIR" \
  "EnvironmentFile=$ENV_FILE" \
  'Environment=NODE_ENV=production' \
  "ExecStart=$(command -v node) dist/src/main.js" \
  'Restart=always' \
  'RestartSec=5' \
  'NoNewPrivileges=true' \
  '' \
  '[Install]' \
  'WantedBy=multi-user.target' \
  > "$unit_tmp"
install -m 644 "$unit_tmp" "$UNIT_FILE"; rm -f "$unit_tmp"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

# Retry the health check: systemctl restart returns before Node binds the
# port. A single immediate curl races the boot and reports failure on a
# perfectly healthy install (the bot repo's HTTPS setup learned this live).
say "Waiting for the hub to come up on 127.0.0.1:$PORT"
WANT_VERSION=$(node -pe 'require("./package.json").version')
health=""
for _try in 1 2 3 4 5 6 7 8 9; do
  health=$(curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health" 2>/dev/null) && break
  sleep 5
done
[ -n "$health" ] || die "hub did not answer after 45s; inspect: journalctl -u $SERVICE -n 50"
printf '%s' "$health" | grep -q "\"version\":\"$WANT_VERSION\"" \
  || die "hub is up but on the wrong version (wanted $WANT_VERSION, got: $health) — stale dist?"
ok "hub healthy: $health"

say "Nginx: ONE manual step (this installer never edits the live config)"
cat <<EOF
   The location snippet is at: $HUB_DIR/nginx/hub.locations.conf
   Add this single line INSIDE the existing 'server { listen 443 ssl; ... }'
   block (usually /etc/nginx/conf.d/liqhunter.conf):

       include $HUB_DIR/nginx/hub.locations.conf;

   then:  nginx -t && systemctl reload nginx
EOF
if grep -rqs "hub.locations.conf" /etc/nginx/ 2>/dev/null; then
  ok "an include for hub.locations.conf already exists in /etc/nginx — nothing to do"
fi

say "Done"
ok "hub:    http://127.0.0.1:$PORT (public at /hub/ once nginx includes the snippet)"
ok "admin:  https://$PUBLIC_IP/hub/admin (token from $ENV_FILE)"
ok "issue:  cd $HUB_DIR && npm run issue -- --name \"Tester\" --days 30"
