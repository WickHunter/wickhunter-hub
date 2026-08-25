#!/usr/bin/env bash
# Wick Hunter beta installer — served personalised by the hub; the two
# placeholders below are substituted per-tester at download time.
#
# One command on a fresh Ubuntu VPS:
#   curl -q -fsS "<hub>/install.sh?key=<your key>" | sudo bash
#
# What it does: Node 22, fetch + verify the latest beta build, unpack to
# /opt/wickhunter (your data/ survives re-runs), systemd unit, license key,
# HTTPS via the bot's own vps-setup, health check. Safe to re-run any time —
# re-running upgrades to the latest beta and keeps your settings.
set -Eeuo pipefail

HUB="__HUB_ORIGIN__"
KEY="__LICENSE_KEY__"
RELEASE_KEYS_B64U="__RELEASE_KEYS_B64U__"
RELEASE_MAX_AGE_MS="__RELEASE_MAX_AGE_MS__"

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

[ "$(id -u)" -eq 0 ] || die "run as root: curl -q -fsS \"...\" | sudo bash"
command -v systemctl >/dev/null || die "systemd is required (Ubuntu 22.04+ VPS)"
case "$HUB" in https://*) ;; *) die "the WickHunter Hub must use HTTPS" ;; esac

say "Installing prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates rsync tar openssl

# ── Node 22 (nodesource) ────────────────────────────────────────────────────
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }
if ! command -v node >/dev/null || [ "$(node_major)" -lt "$NODE_MAJOR_WANTED" ]; then
  say "Installing Node ${NODE_MAJOR_WANTED} (nodesource)"
  curl -q -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_WANTED}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
[ "$(node_major)" -ge "$NODE_MAJOR_WANTED" ] || die "Node ${NODE_MAJOR_WANTED}+ required, found $(node -v)"
ok "node $(node -v)"

# ── Fetch + verify the latest beta build ────────────────────────────────────
say "Fetching the latest Wick Hunter beta"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Ignore a machine-local curlrc and request an identity response. Never ask
# curl to decompress: Ubuntu 22.04's curl can expand a tiny response past its
# size limit before the caller gets control. The bounded verifier below handles
# the one safe compatibility exception (a gzip response) itself.
curl_hub() {
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
if fetch_bounded "$HUB/api/latest?key=$KEY" "$work/latest.json" 1048576 'application/json'; then
  :
else
  fetch_code=$?
  if [ "$fetch_code" -eq 65 ]; then
    die "release manifest response exceeded 1 MiB — proxy or network corruption"
  fi
  die "could not reach the hub (or your key is expired/revoked) — contact the operator"
fi

# Verify the offline Ed25519 release authority before trusting even the file
# name. The Hub has only this public keyring; it cannot mint a release. `ok` is
# an unsigned compatibility envelope and is deliberately excluded from the
# canonical manifest bytes.
if ! node - "$work/latest.json" "$work/verified.json" "$RELEASE_KEYS_B64U" "$RELEASE_MAX_AGE_MS" "$APP_DIR" <<'VERIFY_RELEASE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { TextDecoder } = require("node:util");
const [manifestPath, verifiedPath, keysB64u, maxAgeRaw, appDir] = process.argv.slice(2);
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
if (manifest.product !== "wickhunter" || manifest.channel !== "beta" || manifest.platform !== "linux" || manifest.arch !== process.arch) fail("release target mismatch");
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

REL_VERSION=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' "$work/verified.json")
REL_FILE=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).file' "$work/verified.json")
REL_SHA=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sha256' "$work/verified.json")
ok "latest is v$REL_VERSION"

if fetch_bounded "$HUB/download/$REL_FILE?key=$KEY" "$work/$REL_FILE" 268435456 'application/gzip'; then
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
mkdir -p "$work/unpack" "$APP_DIR"
tar -xzf "$work/$REL_FILE" -C "$work/unpack"
# Tolerate both layouts: files at archive root, or a single top-level dir.
src="$work/unpack"
if [ ! -f "$src/package.json" ]; then
  src=$(find "$work/unpack" -mindepth 1 -maxdepth 1 -type d | head -n1)
  [ -n "$src" ] && [ -f "$src/package.json" ] || die "unexpected tarball layout (no package.json)"
fi
rsync -a --checksum --delete --exclude data --exclude node_modules "$src/" "$APP_DIR/"
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
  health=$(curl -q -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health" 2>/dev/null) && break
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
