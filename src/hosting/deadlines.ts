// src/hosting/deadlines.ts
// The pure hosting-expiration policy (H6). Every timestamp in and out is a
// UTC Unix-millisecond instant — durations are exact elapsed hours, never an
// ambiguous local-calendar day, so this function is DST-safe by construction
// (it never looks at a calendar). Formatting in the customer's timezone is a
// presentation concern for the caller; it never changes a deadline computed
// here.
//
// Adapted from the handoff's illustrative `deadlines()` (Part 1B §16) to this
// Hub's actual policy shape (`HostingPolicy`, src/hosting/policy.ts) instead
// of hard-coded constants, so an operator's configured grace/retention hours
// actually drive it rather than a second copy of the same numbers.
//
// NEVER reset these anchors because a webhook arrives late, retries, or is
// re-processed — `paidThrough` is the hosting subscription's own paid-through
// instant (never webhook-arrival time, never "now"), and the same
// (paidThrough, reason, policy) always produces the same four instants. An
// operator who deliberately reschedules a deadline does so by bumping the
// instance's `lifecycleVersion` and computing fresh deadlines from a fresh
// anchor (src/hosting/service.ts) — this file has no opinion about that.

export type HostingEndReason = "renewal_unpaid" | "intentional_cancellation";

export interface HostingDeadlines {
  /** When the VPS is powered off. */
  suspendAt: number;
  /** When the VPS and its provider resources are permanently removed. */
  deleteAt: number;
  /** `deleteAt - 72h` — the three-day reminder. */
  threeDaysAt: number;
  /** `deleteAt - 24h` — the final reminder. */
  oneDayAt: number;
}

export interface DeadlinePolicyHours {
  /** Nonpayment grace before suspension — default 72. */
  renewalGraceHours: number;
  /** How long a suspended instance is retained before deletion — default 168. */
  retentionHours: number;
  /** Hours before `deleteAt` each reminder fires — default [72, 24], and the
   *  first two entries are read as the three-day/one-day notices; a longer
   *  list is honoured by the notice scheduler (service.ts) but this
   *  function only ever needs the first two to name `threeDaysAt`/`oneDayAt`. */
  reminderHoursBeforeDelete: readonly number[];
}

const HOUR = 60 * 60 * 1000;

/** Pure. Throws on a non-finite anchor — an invalid entitlement instant must
 *  never silently produce `NaN` deadlines that compare `false` against every
 *  clock check downstream (a bug there would read as "never due", the
 *  fail-open direction, which is the wrong default for a delete pipeline). */
export function deadlines(paidThrough: number, reason: HostingEndReason, policy: DeadlinePolicyHours): HostingDeadlines {
  if (!Number.isFinite(paidThrough)) throw new Error("hosting deadlines: invalid entitlement anchor (paidThrough is not finite)");
  const suspendAt = paidThrough + (reason === "renewal_unpaid" ? policy.renewalGraceHours * HOUR : 0);
  const deleteAt = suspendAt + policy.retentionHours * HOUR;
  const [threeDaysHours, oneDayHours] = policy.reminderHoursBeforeDelete;
  return {
    suspendAt,
    deleteAt,
    threeDaysAt: deleteAt - (threeDaysHours ?? 72) * HOUR,
    oneDayAt: deleteAt - (oneDayHours ?? 24) * HOUR,
  };
}
