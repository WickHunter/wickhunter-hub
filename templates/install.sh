#!/usr/bin/env bash
# Wick Hunter beta installer — served personalised by the hub; the two
# placeholders below are substituted per-tester at download time.
#
# One command on a fresh Ubuntu VPS:
#   curl -fsS "<hub>/install.sh?key=<your key>" | sudo bash
#
# What it does: Node 22, fetch + verify the latest beta build, unpack to
# /opt/wickhunter (your data/ survives re-runs), systemd unit, license key,
# HTTPS via the bot's own vps-setup, health check. Safe to re-run any time —
# re-running upgrades to the latest beta and keeps your settings.
set -Eeuo pipefail

HUB="__HUB_ORIGIN__"
KEY="__LICENSE_KEY__"

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

# When run as `curl | sudo bash`, stdin is the pipe — prompts must come from
# the terminal. No terminal at all (cloud-init etc.) -> generate/skip instead.
ask() { # ask VAR "prompt" [--secret]
  local __var=$1 __prompt=$2 __secret=${3:-} __val=""
  if [ -r /dev/tty ]; then
    if [ "$__secret" = "--secret" ]; then
      read -r -s -p "$__prompt" __val < /dev/tty; printf '\n' > /dev/tty
    else
      read -r -p "$__prompt" __val < /dev/tty
    fi
  fi
  printf -v "$__var" '%s' "$__val"
}

[ "$(id -u)" -eq 0 ] || die "run as root: curl -fsS \"...\" | sudo bash"
command -v systemctl >/dev/null || die "systemd is required (Ubuntu 22.04+ VPS)"

say "Installing prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates rsync tar openssl

# ── Node 22 (nodesource) ────────────────────────────────────────────────────
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }
if ! command -v node >/dev/null || [ "$(node_major)" -lt "$NODE_MAJOR_WANTED" ]; then
  say "Installing Node ${NODE_MAJOR_WANTED} (nodesource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_WANTED}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
[ "$(node_major)" -ge "$NODE_MAJOR_WANTED" ] || die "Node ${NODE_MAJOR_WANTED}+ required, found $(node -v)"
ok "node $(node -v)"

# ── Fetch + verify the latest beta build ────────────────────────────────────
say "Fetching the latest Wick Hunter beta"
meta=$(curl -fsS "$HUB/api/latest?key=$KEY") \
  || die "could not reach the hub (or your key is expired/revoked) — contact the operator"
REL_VERSION=$(node -pe 'JSON.parse(process.argv[1]).version' "$meta")
REL_FILE=$(node -pe 'JSON.parse(process.argv[1]).file' "$meta")
REL_SHA=$(node -pe 'JSON.parse(process.argv[1]).sha256' "$meta")
ok "latest is v$REL_VERSION"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsS -o "$work/$REL_FILE" "$HUB/download/$REL_FILE?key=$KEY" || die "download failed"
echo "$REL_SHA  $work/$REL_FILE" | sha256sum -c --quiet - || die "sha256 mismatch — corrupt download, try again"
ok "downloaded and verified $REL_FILE"

# ── Unpack: tarball root is the app dir; data/ always survives ──────────────
say "Installing to $APP_DIR"
mkdir -p "$work/unpack" "$APP_DIR"
tar -xzf "$work/$REL_FILE" -C "$work/unpack"
# Tolerate both layouts: files at archive root, or a single top-level dir.
src="$work/unpack"
if [ ! -f "$src/package.json" ]; then
  src=$(find "$work/unpack" -mindepth 1 -maxdepth 1 -type d | head -n1)
  [ -n "$src" ] && [ -f "$src/package.json" ] || die "unexpected tarball layout (no package.json)"
fi
rsync -a --delete --exclude data --exclude node_modules "$src/" "$APP_DIR/"
mkdir -p "$APP_DIR/data"

# The beta artifact runs on Node builtins + what is bundled into server.js;
# its only declared deps are ws's OPTIONAL native accelerators, and it ships
# no lockfile — so `npm ci` is wrong here (it dies without one, which took a
# live tester install down). Best-effort `npm install`, never fatal.
say "Installing optional runtime accelerators"
if ( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ); then
  ok "accelerators installed"
else
  warn "optional accelerators skipped — the bot runs fine without them"
fi

# ── Configuration (idempotent: existing values are kept) ────────────────────
say "Configuring"
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

get_env() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1; }
set_env() { # set_env NAME VALUE — replace-or-append, keep the file mode 600
  local tmp; tmp=$(mktemp)
  grep -v "^$1=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  install -m 600 "$tmp" "$ENV_FILE"; rm -f "$tmp"
}

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
LOGIN_PW=$(get_env LIQHUNTER_LOGIN_PASSWORD)
if [ -n "$LOGIN_PW" ] && [ "${#LOGIN_PW}" -lt 8 ]; then
  warn "existing login password is under the bot's 8-character minimum — replacing it"
  LOGIN_PW=""
fi
if [ -z "$LOGIN_PW" ]; then
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
else
  ok "keeping existing login password"
fi

set_env LIQHUNTER_HUB_ORIGIN "$HUB"

# License key: what the bot presents at check-in. Mode 600 — it is a secret.
printf '%s\n' "$KEY" > "$APP_DIR/data/license.key"
chmod 600 "$APP_DIR/data/license.key"
ok "license key installed"

# ── systemd ─────────────────────────────────────────────────────────────────
say "Installing the systemd service"
# The beta artifact is one bundled server.js at the app root (its package.json
# start script is `node server.js`); the full-tree layout is dist/server/index.js.
# Detect which this build is — pointing systemd at the wrong one is a crash loop.
ENTRY="server.js"
[ -f "$APP_DIR/server.js" ] || ENTRY="dist/server/index.js"
[ -f "$APP_DIR/$ENTRY" ] || die "no server entry found in the unpacked build (looked for server.js and dist/server/index.js)"
unit_tmp=$(mktemp)
printf '%s\n' \
  '[Unit]' \
  'Description=Wick Hunter beta bot' \
  'After=network-online.target' \
  'Wants=network-online.target' \
  '' \
  '[Service]' \
  "WorkingDirectory=$APP_DIR" \
  "EnvironmentFile=$ENV_FILE" \
  "ExecStart=$(command -v node) $ENTRY" \
  'Restart=always' \
  'RestartSec=5' \
  '' \
  '[Install]' \
  'WantedBy=multi-user.target' \
  > "$unit_tmp"
install -m 644 "$unit_tmp" "$UNIT_FILE"; rm -f "$unit_tmp"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

# Retry the health check — `systemctl restart` returns before Node has bound
# its port; a single immediate curl races the boot and cries wolf.
say "Waiting for the bot to come up"
health=""
for _try in 1 2 3 4 5 6 7 8 9; do
  health=$(curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health" 2>/dev/null) && break
  sleep 5
done
[ -n "$health" ] || die "the bot did not answer on 127.0.0.1:$PORT after 45s; inspect: journalctl -u $SERVICE -n 50"
ok "bot is healthy: $health"

# ── HTTPS via the bot's own setup (nginx + Let's Encrypt on the public IP) ──
if [ -x "$APP_DIR/scripts/vps-setup.sh" ] || [ -f "$APP_DIR/scripts/vps-setup.sh" ]; then
  say "Setting up trusted HTTPS (the bot's own vps-setup)"
  LIQHUNTER_SERVICE_NAME=$SERVICE LIQHUNTER_ENV_FILE=$ENV_FILE bash "$APP_DIR/scripts/vps-setup.sh" \
    || die "HTTPS setup failed — the bot still works on 127.0.0.1:$PORT; re-run this installer to retry"
else
  warn "no scripts/vps-setup.sh in this build; skipping HTTPS (bot is on 127.0.0.1:$PORT only)"
fi

PUBLIC_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
say "Done — Wick Hunter beta v$REL_VERSION is installed"
ok "URL:      https://${PUBLIC_IP:-<your-vps-ip>}/"
ok "Login:    the password you chose (stored in $ENV_FILE)"
ok "Upgrade:  re-run this same install command any time"
ok "Logs:     journalctl -u $SERVICE -f"
