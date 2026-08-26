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
MARKETPLACE_STATE_ENV_FILE=/etc/wickhunter-hub/marketplace-state.env
MARKETPLACE_BRIDGE_ENV_FILE=/etc/wickhunter-hub/marketplace.env
ROOT_HELPER=/usr/local/libexec/wickhunter-hub-root-helper
SUDOERS_FILE=/etc/sudoers.d/wickhunter-hub-root-helper
SERVICE=wickhunter-hub
SERVICE_USER=wickhunter-hub
UNIT_FILE=/etc/systemd/system/${SERVICE}.service
PORT=8091
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SOURCE_COMMIT=$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown')
SOURCE_BRANCH=$(git -C "$SRC_DIR" branch --show-current 2>/dev/null || printf 'unknown')

[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash install-hub.sh"
command -v systemctl >/dev/null || die "systemd is required"
command -v node >/dev/null || die "Node 22+ is required — install it first (nodesource: https://deb.nodesource.com)"
NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 22 ] || die "Node 22+ required, found $(node -v)"
[ -f "$SRC_DIR/package.json" ] || die "run this from a checkout of wickhunter-hub"
if [ -n "${HUB_EXPECTED_SOURCE_COMMIT:-}" ] && [ "$SOURCE_COMMIT" != "$HUB_EXPECTED_SOURCE_COMMIT" ]; then
  die "source checkout changed after upgrade verification (wanted $HUB_EXPECTED_SOURCE_COMMIT, found $SOURCE_COMMIT)"
fi
if [ -n "${HUB_EXPECTED_SOURCE_BRANCH:-}" ] && [ "$SOURCE_BRANCH" != "$HUB_EXPECTED_SOURCE_BRANCH" ]; then
  die "source checkout branch changed after upgrade verification (wanted $HUB_EXPECTED_SOURCE_BRANCH, found $SOURCE_BRANCH)"
fi

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
PORT=$(sed -n 's/^HUB_PORT=//p' "$ENV_FILE" | tail -n 1)
printf '%s' "$PORT" | grep -Eq '^[0-9]+$' || die "HUB_PORT in $ENV_FILE must be digits"
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "HUB_PORT in $ENV_FILE must be from 1 through 65535"
if ! grep -q '^HUB_RELEASE_PUBLIC_KEYS_JSON=' "$ENV_FILE"; then
  die "HUB_RELEASE_PUBLIC_KEYS_JSON is required. Generate the dedicated OFFLINE release key in the app repo, paste only its public keyring JSON into $ENV_FILE, sign the current release, then re-run. Never copy the private release key to this Hub."
fi

# The public Hub never reads private Marketplace role files. Its fixed sudo
# helper owns one root-only masked state file, writes split API/worker files,
# and imports the Bybit master over stdin directly into the encrypted vault.
install -d -m 0755 -o root -g root /etc/wickhunter-hub
for private_file in "$MARKETPLACE_STATE_ENV_FILE" "$MARKETPLACE_BRIDGE_ENV_FILE"; do
  if [ -L "$private_file" ] || { [ -e "$private_file" ] && [ ! -f "$private_file" ]; }; then
    die "$private_file must be a regular file, not a symlink or special file"
  fi
  if [ -e "$private_file" ]; then
    chown root:root "$private_file"
    chmod 600 "$private_file"
  fi
done
touch "$MARKETPLACE_BRIDGE_ENV_FILE"
chown root:root "$MARKETPLACE_BRIDGE_ENV_FILE"
chmod 600 "$MARKETPLACE_BRIDGE_ENV_FILE"
ok "Marketplace masked state and status bridge persist root-only"

# Machine leases are additive. A missing/corrupt lease authority must never
# prevent a legacy LHK1 Hub upgrade. Read only the one exact env assignment we
# need; never `source` an operator-owned file into this root shell.
LEASE_KID=$(sed -n 's/^HUB_LICENSE_LEASE_KEY_ID=//p' "$ENV_FILE" | tail -n 1)
LEASE_KID=${LEASE_KID:-lease-1}
if printf '%s' "$LEASE_KID" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'; then
  say "Checking the dedicated machine-lease signing key ($LEASE_KID)"
  lease_key_file="$HUB_DIR/data/license-lease-signing.$LEASE_KID.key"
  lease_ring_file="$HUB_DIR/data/license-lease-public-keys.v1.json"
  # Only the first-install default may be generated as part of an ordinary
  # upgrade. A rotated kid must be explicitly pre-provisioned, its public key
  # shipped in a signed client release, and only then selected in the env.
  if [ "$LEASE_KID" != "lease-1" ] && [ ! -f "$lease_key_file" ]; then
    warn "rotated machine-lease kid $LEASE_KID is not pre-provisioned; it will NOT be generated or activated by this upgrade"
    warn "run the leasekey CLI explicitly, ship its public key in a signed app release, then set HUB_LICENSE_LEASE_KEY_ID"
  elif [ "$LEASE_KID" = "lease-1" ] || { [ -f "$lease_key_file" ] && [ -f "$lease_ring_file" ]; }; then
    if HUB_DATA_DIR="$HUB_DIR/data" node dist/bin/leasekey.js "$LEASE_KID"; then
    warn "PIN THE PUBLIC lease key in a signed app release before activating this kid in the Hub service."
    warn "Back up every data/license-lease-signing.*.key, the complete public keyring, audit ledger, and checkpoint."
    else
      warn "machine-lease key preparation failed; continuing the core Hub upgrade with lease issuance disabled"
      warn "restore/provision the named lease key and re-run after legacy licensing is healthy"
    fi
  else
    warn "machine-lease key/ring state is incomplete; continuing the core Hub upgrade with lease issuance disabled"
    warn "restore both files from the same backup rather than replacing published authority"
  fi
else
  warn "HUB_LICENSE_LEASE_KEY_ID is invalid; continuing the core Hub upgrade with lease issuance disabled"
fi

say "Installing the unprivileged systemd service and fixed root helper"
getent group "$SERVICE_USER" >/dev/null || groupadd --system "$SERVICE_USER"
id -u "$SERVICE_USER" >/dev/null 2>&1 \
  || useradd --system --home /nonexistent --shell /usr/sbin/nologin --gid "$SERVICE_USER" "$SERVICE_USER"
chown -R "$SERVICE_USER:$SERVICE_USER" "$HUB_DIR/data" "$HUB_DIR/releases"
chmod 700 "$HUB_DIR/data" "$HUB_DIR/releases"

command -v sudo >/dev/null || { apt-get update -qq && apt-get install -y -qq sudo; }
install -d -m 0755 -o root -g root "$(dirname "$ROOT_HELPER")"
helper_tmp=$(mktemp)
printf '%s\n' \
  '#!/bin/sh' \
  'exec /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/node /opt/wickhunter-hub/dist/bin/root-helper.js' \
  > "$helper_tmp"
install -o root -g root -m 0755 "$helper_tmp" "$ROOT_HELPER"
rm -f "$helper_tmp"
sudoers_tmp=$(mktemp)
printf '%s ALL=(root) NOPASSWD: %s\n' "$SERVICE_USER" "$ROOT_HELPER" > "$sudoers_tmp"
chmod 0440 "$sudoers_tmp"
visudo -cf "$sudoers_tmp" >/dev/null || die "generated root-helper sudoers policy is invalid"
install -o root -g root -m 0440 "$sudoers_tmp" "$SUDOERS_FILE"
rm -f "$sudoers_tmp"

unit_tmp=$(mktemp)
printf '%s\n' \
  '[Unit]' \
  'Description=Wick Hunter beta hub (licensing + distribution; NO trading code)' \
  'After=network-online.target' \
  'Wants=network-online.target' \
  '' \
  '[Service]' \
  "User=$SERVICE_USER" \
  "Group=$SERVICE_USER" \
  "WorkingDirectory=$HUB_DIR" \
  "EnvironmentFile=$ENV_FILE" \
  "EnvironmentFile=-$MARKETPLACE_BRIDGE_ENV_FILE" \
  'Environment=NODE_ENV=production' \
  "ExecStart=$(command -v node) dist/src/main.js" \
  'Restart=always' \
  'RestartSec=5' \
  'UMask=0077' \
  'PrivateTmp=true' \
  'PrivateDevices=true' \
  'ProtectKernelTunables=true' \
  'ProtectKernelModules=true' \
  'ProtectControlGroups=true' \
  'LockPersonality=true' \
  'RestrictRealtime=true' \
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

# Record the commit only after the new service has actually answered with the
# compiled package version. If restart failed, the old runtime keeps its old
# record instead of being mislabeled as the source we merely attempted.
node dist/bin/buildinfo.js \
  --data "$HUB_DIR/data" \
  --version "$WANT_VERSION" \
  --commit "$SOURCE_COMMIT" \
  --branch "$SOURCE_BRANCH"
health=$(curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health") \
  || die "hub stopped answering while its exact build identity was recorded"
if printf '%s' "$SOURCE_COMMIT" | grep -Eq '^[a-f0-9]{40}$'; then
  printf '%s' "$health" | grep -q "\"commit\":\"$SOURCE_COMMIT\"" \
    || die "hub is healthy but did not read the installed source commit (got: $health)"
else
  printf '%s' "$health" | grep -q '"commit":null' \
    || die "hub build origin is unknown but health did not say so explicitly (got: $health)"
fi
ok "hub healthy with exact build identity: $health"

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
