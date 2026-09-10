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
//   - the pinned release reference to install (never "latest")
//   - the per-venue probe list, so the script and the Hub verdict
//     (src/hosting/readiness.ts) agree on exactly which checks run
// The token is written into the script BODY, never into a URL a shell
// history or a proxy log would capture verbatim on its own, and every
// command that touches it redirects its own stdout/stderr so a copy never
// reaches the instance's boot log. Real end-to-end installation on the
// bootstrapped release artifact — the app's forced-password-change wiring
// (LIQHUNTER_BOOTSTRAP_PASSWORD, liqhunter-private CLAUDE.md's v0.90.65
// contract) — is application-repo work outside this file's boundary; this
// script's only job is to fetch and run THAT repo's own installer with the
// right environment, exactly the way an operator's `curl | sudo bash`
// install command already works on a self-hosted box (README).
import type { ProbeVenue } from "./policy.js";

export interface BootstrapInput {
  instanceId: string;
  generation: number;
  bootstrapToken: string;
  hubOrigin: string;
  /** A pinned release ref/digest; refuses to install "latest" silently. */
  releaseRef: string;
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
WH_RELEASE_REF=${shellSingleQuote(input.releaseRef)}

# Install the pinned Unleashed release through the existing supported
# deployment path (the operator's own self-update/install scripts) — not
# reproduced here; this script's job ends at "readiness", the app's own
# forced-password-change flow (LIQHUNTER_BOOTSTRAP_PASSWORD) is what makes
# the installed app itself refuse to trade until the customer sets a
# permanent password.
# install_unleashed "$WH_RELEASE_REF"   # left to the operator's real installer

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
