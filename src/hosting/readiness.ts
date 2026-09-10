// src/hosting/readiness.ts
// Pure verdict over one reachability-probe run — never makes an HTTP call
// itself. The probe runs FROM the new instance (the bootstrap script) and
// reports its raw results back to POST /api/hosting/instances/:id/readiness;
// this module only decides, from those results plus the policy's venue list,
// whether the instance may be marked `ready`.
//
// docs/HOSTING-REGION-2026-09-10.md §4: "Refuse readiness, naming the venue,
// on any non-200 for a venue... never silently drop it and mark ready."
// 403 = CDN/WAF geo-block (Bybit's CloudFront shape), 451 = "Unavailable For
// Legal Reasons" (Binance's shape, names the eligibility clause), a
// timeout/refused-after-retry is a hard block too — all three, and every
// other non-200, refuse readiness the same way: BY NAME, never guessed past.
import type { ProbeVenue } from "./policy.js";

export type ProbeOutcome =
  | { kind: "ok"; status: 200 }
  | { kind: "blocked"; status: number; reason: "cdn-geo-block" | "legal-block" | "unexpected-status" }
  | { kind: "unreachable"; reason: "timeout" | "refused" | "error"; detail: string };

export interface ProbeResult {
  venueId: string;
  outcome: ProbeOutcome;
}

export interface ReadinessVerdict {
  ready: boolean;
  /** One sentence per blocked/unreachable venue, naming it — never a bare
   *  "readiness failed". Empty when `ready`. */
  refusals: string[];
  /** Every venue this Hub's software supports and the outcome the probe
   *  reported for it (or "missing" when the report omitted one entirely —
   *  treated as a refusal, never as "not configured therefore fine": the
   *  probe is supposed to run all seven regardless of which venues a
   *  customer has actually connected). */
  perVenue: { venueId: string; label: string; status: "ok" | "blocked" | "unreachable" | "missing" }[];
}

/** Classify one HTTP status the way the research names them. Exported so the
 *  bootstrap-side probe script and the Hub agree on the SAME classification
 *  from one implementation, rather than the script guessing its own words. */
export function classifyProbeStatus(status: number): ProbeOutcome {
  if (status === 200) return { kind: "ok", status };
  if (status === 403) return { kind: "blocked", status, reason: "cdn-geo-block" };
  if (status === 451) return { kind: "blocked", status, reason: "legal-block" };
  return { kind: "blocked", status, reason: "unexpected-status" };
}

/** Pure. `venues` is the policy's configured probe list for THIS region
 *  attempt; `results` is what the instance reported. Every configured venue
 *  must report `ok`, or the whole attempt is refused — this function never
 *  narrows to "only the venues this customer configured" (the research's
 *  own instruction: run all seven regardless, since venues can be added
 *  later without a re-provision). */
export function readinessVerdict(venues: readonly ProbeVenue[], results: readonly ProbeResult[]): ReadinessVerdict {
  const byVenue = new Map(results.map((r) => [r.venueId, r.outcome]));
  const refusals: string[] = [];
  const perVenue: ReadinessVerdict["perVenue"] = [];
  for (const v of venues) {
    const outcome = byVenue.get(v.id);
    if (!outcome) {
      refusals.push(`${v.label}: no probe result was reported — refusing readiness rather than assuming reachable`);
      perVenue.push({ venueId: v.id, label: v.label, status: "missing" });
      continue;
    }
    if (outcome.kind === "ok") {
      perVenue.push({ venueId: v.id, label: v.label, status: "ok" });
      continue;
    }
    if (outcome.kind === "blocked") {
      const why = outcome.reason === "cdn-geo-block" ? `blocked by ${v.label}'s edge (HTTP 403) from this region's IP range`
        : outcome.reason === "legal-block" ? `refused by ${v.label} for legal/eligibility reasons (HTTP 451) from this region's IP range`
          : `answered HTTP ${outcome.status} from this region's IP range, not the expected 200`;
      refusals.push(`${v.label}: ${why}`);
      perVenue.push({ venueId: v.id, label: v.label, status: "blocked" });
      continue;
    }
    refusals.push(`${v.label}: unreachable from this region (${outcome.reason}: ${outcome.detail})`);
    perVenue.push({ venueId: v.id, label: v.label, status: "unreachable" });
  }
  return { ready: refusals.length === 0, refusals, perVenue };
}
