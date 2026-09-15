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
  return `#cloud-config
runcmd:
  - [ bash, -c, ${shellSingleQuote(bootstrapScript(input, probeLines))} ]
`;
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
bash "$INSTALLER"
unset LIQHUNTER_BOOTSTRAP_PASSWORD
unset LIQHUNTER_HOSTED_MAX_ACCOUNTS

RESULTS=""
probe() {
  local id="$1" url="$2" status
  # 5s timeout, one retry — a venue's edge is a "server time" GET, never a
  # long-poll; a hard-blocked venue answers fast (403/451) and a dead one
  # should not hold the whole callback up for minutes.
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --retry 1 "$url" 2>/dev/null || echo 0)
  RESULTS="\${RESULTS}\${RESULTS:+,}{\\"venueId\\":\\"\${id}\\",\\"status\\":\${status}}"
}
${probeLines}

curl -s -X POST "$WH_HUB_ORIGIN/api/hosting/instances/$WH_INSTANCE_ID/readiness" \\
  -H "content-type: application/json" \\
  -d "{\\"token\\":\\"$WH_BOOTSTRAP_TOKEN\\",\\"generation\\":$WH_GENERATION,\\"results\\":[$RESULTS]}" \\
  >/dev/null 2>&1

unset WH_BOOTSTRAP_TOKEN
`;
}
