// src/hosting/bootstrap.ts
// Builds the cloud-init user-data script a fresh instance boots with. Pure
// string construction — never called from a route the suite exercises over
// the network, and never itself makes a network call. Kept in its own file
// so the shape of what a customer VPS is handed is reviewable independent of
// src/hosting/service.ts's orchestration.
//
// WHAT IT CARRIES, AND WHAT IT NEVER DOES (handoff §6):
//   - a SHORT-LIVED, INSTANCE-SCOPED bootstrap token (never a company-wide
//     Vultr/Stripe/email credential, never an exchange secret)
//   - the Hub's own public origin, so the script can call back to
//     POST /api/hosting/instances/:id/readiness
//   - an instance-scoped installer request; the Hub responds with the complete
//     signed release identity pinned for this generation (never bare "latest")
//   - the per-venue probe list, so the script and the Hub verdict
//     (src/hosting/readiness.ts) agree on exactly which checks run
// The token is written into the script BODY, never into a URL a shell
// history or a proxy log would capture verbatim on its own, and every
// command that touches it redirects its own stdout/stderr so a copy never
// reaches the instance's boot log. It fetches and runs the same signed
// customer installer used by self-hosted boxes, with the hosted app's
// forced-password-change and connected-account-limit environment contracts.
import type { ProbeVenue } from "./policy.js";

export interface BootstrapInput {
  instanceId: string;
  generation: number;
  bootstrapToken: string;
  managementToken: string;
  hubOrigin: string;
  maxAccounts: number;
  probeVenues: readonly ProbeVenue[];
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Bash. Idempotent-ish (re-running does not re-register a stale generation
 *  — the Hub refuses a readiness callback whose generation does not match
 *  the row's current one, src/hosting/service.ts's `reportReadiness`). */
export function buildBootstrapUserData(input: BootstrapInput): string {
  const probeLines = input.probeVenues
    .map((v) => `probe ${shellSingleQuote(v.id)} ${shellSingleQuote(v.url)}`)
    .join("\n");
  // JSON is a strict YAML subset. Encoding the command as JSON avoids a
  // second, subtly different YAML quoting language around an already quoted
  // Bash program; cloud-init receives exactly one `bash -c` argv triple.
  return `#cloud-config\n${JSON.stringify({ runcmd: [["bash", "-c", bootstrapScript(input, probeLines)]] })}\n`;
}

function bootstrapScript(input: BootstrapInput, probeLines: string): string {
  // The token is exported into the script's own environment rather than
  // interpolated into every curl invocation's argv (argv is visible to any
  // other process on the box via /proc; an env var handed only to this one
  // child process is not). set +x / no `set -x` anywhere in this script —
  // a trace would print the token.
  //
  // PLAIN CURL ONLY, NO python3/jq DEPENDENCY: the customer application
  // artifact ships no reachability-probe module of its own (the
  // liqhunter-private build's allowlist excludes it — nothing server-side
  // imports it, so it never reaches the customer bundle), and a minimal
  // cloud image cannot be assumed to carry python3 either. Every venue id
  // here is one of THIS file's own known-safe [a-z] strings (never
  // operator/customer input) and every status is curl's own numeric
  // `%{http_code}`, so building the JSON array by string concatenation is
  // exactly as safe as a JSON library would be for this specific shape —
  // there is nothing here that needs escaping.
  return `#!/usr/bin/env bash
set -euo pipefail
export WH_BOOTSTRAP_TOKEN=${shellSingleQuote(input.bootstrapToken)}
WH_HUB_ORIGIN=${shellSingleQuote(input.hubOrigin)}
WH_INSTANCE_ID=${shellSingleQuote(input.instanceId)}
WH_GENERATION=${input.generation}
WH_HOSTED_MAX_ACCOUNTS=${input.maxAccounts}

# Fetch the existing personalized installer through the instance-scoped
# bootstrap credential. The credential stays in the POST body (not the URL or
# curl argv), and that installer verifies the Hub's signed release manifest
# and artifact before it installs anything.
INSTALLER=$(mktemp)
trap 'rm -f "$INSTALLER"' EXIT
printf '{"token":"%s","generation":%s}' "$WH_BOOTSTRAP_TOKEN" "$WH_GENERATION" \
  | curl -q -fsS --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 90 \
      -H 'content-type: application/json' --data-binary @- \
      "$WH_HUB_ORIGIN/api/hosting/instances/$WH_INSTANCE_ID/installer" \
      -o "$INSTALLER"
chmod 700 "$INSTALLER"

# The app treats this as a temporary credential and refuses dashboard and
# exposure-increasing access until the customer replaces it. Both ends can
# derive it from the bootstrap proof without persisting that proof itself.
export LIQHUNTER_BOOTSTRAP_PASSWORD
export LIQHUNTER_HOSTED_MAX_ACCOUNTS="$WH_HOSTED_MAX_ACCOUNTS"
TOKEN_HASH=$(printf '%s' "$WH_BOOTSTRAP_TOKEN" | sha256sum | cut -d' ' -f1)
LIQHUNTER_BOOTSTRAP_PASSWORD=$(printf '%s' "$TOKEN_HASH:password:v1" | sha256sum | cut -c1-24)
unset TOKEN_HASH
installed=0
for attempt in 1 2 3; do
  if bash "$INSTALLER"; then installed=1; break; fi
  [ "$attempt" -eq 3 ] || sleep $((attempt * 15))
done
[ "$installed" -eq 1 ] || { echo "managed installation failed after 3 attempts" >&2; exit 1; }

# Install a readiness-only boot agent for paid power-on recovery. Its bearer
# lives in a root-owned file and can only submit a higher one-shot boot counter
# for this instance/generation; it cannot fetch an installer or configure the
# application.
install -d -m 700 /etc/wickhunter-hosting
printf '%s' ${shellSingleQuote(input.managementToken)} > /etc/wickhunter-hosting/token
chmod 600 /etc/wickhunter-hosting/token
printf '0\n' > /etc/wickhunter-hosting/counter
printf '%s' ${shellSingleQuote(managementAgentScript(input, probeLines))} > /usr/local/sbin/wickhunter-hosting-readiness
chmod 700 /usr/local/sbin/wickhunter-hosting-readiness
cat > /etc/systemd/system/wickhunter-hosting-readiness.service <<'WH_HOSTING_UNIT'
[Unit]
Description=Wick Hunter managed-hosting boot readiness proof
After=network-online.target wickhunter.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/wickhunter-hosting-readiness

[Install]
WantedBy=multi-user.target
WH_HOSTING_UNIT
cat > /etc/systemd/system/wickhunter-hosting-readiness.timer <<'WH_HOSTING_TIMER'
[Unit]
Description=Retry Wick Hunter managed-hosting readiness proof

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30s
Persistent=true

[Install]
WantedBy=timers.target
WH_HOSTING_TIMER

# BEGIN HOSTING SYSTEMCTL RETRY HELPER
# Fresh Ubuntu may briefly disconnect systemctl's D-Bus client while package
# activity reloads systemd. Retrying these idempotent operations is safe. Each
# client attempt is bounded without killing systemd or the unit it controls,
# and the whole retry window is bounded as well.
HOSTING_SYSTEMCTL_DEADLINE=$((SECONDS + 300))
systemctl_retry() {
  local remaining this_attempt this_delay
  while true; do
    remaining=$((HOSTING_SYSTEMCTL_DEADLINE - SECONDS))
    [ "$remaining" -gt 0 ] || return 1
    this_attempt=30
    [ "$this_attempt" -le "$remaining" ] || this_attempt=$remaining
    if timeout --foreground "\${this_attempt}s" systemctl "$@"; then return 0; fi
    remaining=$((HOSTING_SYSTEMCTL_DEADLINE - SECONDS))
    [ "$remaining" -gt 0 ] || return 1
    this_delay=5
    [ "$this_delay" -le "$remaining" ] || this_delay=$remaining
    sleep "$this_delay"
  done
}
# END HOSTING SYSTEMCTL RETRY HELPER
systemctl_retry daemon-reload
systemctl_retry enable --now wickhunter-hosting-readiness.timer >/dev/null
systemctl_retry is-enabled wickhunter-hosting-readiness.timer >/dev/null
systemctl_retry is-active wickhunter-hosting-readiness.timer >/dev/null

unset LIQHUNTER_BOOTSTRAP_PASSWORD
unset LIQHUNTER_HOSTED_MAX_ACCOUNTS

RESULTS=""
probe() {
  local id="$1" url="$2" status
  # 5s timeout, one retry — a venue's edge is a "server time" GET, never a
  # long-poll; a hard-blocked venue answers fast (403/451) and a dead one
  # should not hold the whole callback up for minutes.
  status=0
  if observed=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --retry 1 "$url" 2>/dev/null); then
    case "$observed" in [0-9][0-9][0-9]) status="$observed" ;; esac
  fi
  RESULTS="\${RESULTS}\${RESULTS:+,}{\\"venueId\\":\\"\${id}\\",\\"status\\":\${status}}"
}
${probeLines}

printf '{"token":"%s","generation":%s,"results":[%s]}' "$WH_BOOTSTRAP_TOKEN" "$WH_GENERATION" "$RESULTS" \\
  | curl -q -fsS --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 90 \\
      --retry 2 --retry-delay 1 -H 'content-type: application/json' --data-binary @- \\
      "$WH_HUB_ORIGIN/api/hosting/instances/$WH_INSTANCE_ID/readiness" -o /dev/null

unset WH_BOOTSTRAP_TOKEN
`;
}

function managementAgentScript(input: BootstrapInput, probeLines: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
HUB=${shellSingleQuote(input.hubOrigin)}
INSTANCE=${shellSingleQuote(input.instanceId)}
GENERATION=${input.generation}
TOKEN=$(cat /etc/wickhunter-hosting/token)
COUNTER=$(cat /etc/wickhunter-hosting/counter 2>/dev/null || echo 0)
case "$COUNTER" in *[!0-9]*|'') COUNTER=0 ;; esac
COUNTER=$((COUNTER + 1))
counter_tmp=$(mktemp /etc/wickhunter-hosting/counter.XXXXXX)
printf '%s\n' "$COUNTER" > "$counter_tmp"
chmod 600 "$counter_tmp"
mv "$counter_tmp" /etc/wickhunter-hosting/counter

APP_VERSION=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version' /opt/wickhunter/package.json)
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const originOk=x.createdFrom==="bootstrap"?x.mustChange===true:x.createdFrom==="user"?x.mustChange===false:false;if(!originOk||typeof x.hash!=="string"||!x.hash)process.exit(1)' /opt/wickhunter/data/app-credential.json
healthy=0
for _try in $(seq 1 60); do
  body=$(curl -q -fsS --max-time 5 http://127.0.0.1:8090/api/health 2>/dev/null || true)
  if node -e 'const [r,v]=process.argv.slice(1);try{const x=JSON.parse(r);process.exit(x.ok===true&&x.version===v?0:1)}catch{process.exit(1)}' "$body" "$APP_VERSION"; then healthy=1; break; fi
  sleep 5
done
[ "$healthy" -eq 1 ] || exit 1

RESULTS=""
probe() {
  local id="$1" url="$2" status=0 observed
  if observed=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --retry 1 "$url" 2>/dev/null); then
    case "$observed" in [0-9][0-9][0-9]) status="$observed" ;; esac
  fi
  RESULTS="\${RESULTS}\${RESULTS:+,}{\\"venueId\\":\\"\${id}\\",\\"status\\":\${status}}"
}
${probeLines}
printf '{"managementToken":"%s","counter":%s,"generation":%s,"results":[%s]}' "$TOKEN" "$COUNTER" "$GENERATION" "$RESULTS" \\
  | curl -q -fsS --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 90 --retry 2 --retry-delay 1 \\
      -H 'content-type: application/json' --data-binary @- "$HUB/api/hosting/instances/$INSTANCE/readiness" -o /dev/null
unset TOKEN
`;
}
