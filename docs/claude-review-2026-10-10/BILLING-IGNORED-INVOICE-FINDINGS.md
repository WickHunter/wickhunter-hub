# Discarded initial invoice → hosting cancellation of a paid subscription (2026-10-10 review)

Scope: the automatic cancellation of a paid combined software+VPS subscription
three days after checkout, traced on the Hub source, with a fix, regression
coverage, a read-only audit and the checkout-UI question. Everything here is
from source, the repository's own tests and hermetic fixtures. Nothing on the
live Hub, Stripe or the provider was read or changed by this review; the
production log sequence and record identifiers are the operator's, taken as
data. Line numbers are given for the deployed build at the time of the
incident (**0.4.90, `b24234c7`**) and for **`main` at `67baf20`** (0.4.92);
this branch adds comment lines to `src/billing/service.ts`, so its numbers
below line 644 are eight higher on the branch.

## 1. Root cause — confirmed, with two corrections to the operator's reading

### 1.1 The invoice events were classified "older" by the Stripe event clock

- `applyBundleEvent`, 0.4.90 `src/billing/service.ts:636` (main `:636`):
  `const stale = !terminal && orderingRelevant && prior && ev.createdMs < prior.latestEventCreatedMs;`
  `ev.createdMs` is the Stripe **event's** `created` in seconds × 1000
  (`src/billing/stripe.ts:104`), so the comparison has one-second resolution
  and is strict. `prior.latestEventCreatedMs` is the per-subscription bundle
  watermark the checkout event had just written (0.4.90 `:658`, main `:692`:
  `Math.max(prior ?? 0, ev.createdMs)`).
- Stripe creates the subscription and pays its first invoice **before** it
  marks the Checkout Session complete, so `invoice.paid` and
  `invoice.payment_succeeded` carry a `created` at least one second earlier
  than `checkout.session.completed` — yet Stripe delivered the checkout first.
  Checkout `evt_1UNPEQ…` set the watermark to 03:39:59; both invoice events
  (`evt_1UNPER…`, created ≤ 03:39:58) were then `stale`.
- 0.4.90 `:641`: `if (stale && !activatingBehindFailure && !lifetimeInitialPaid) return { outcome: "ignored", note: "older bundle lifecycle event ignored" };`
  — the only two exceptions did not cover a monthly initial invoice behind
  its own checkout. **Correction to the operator's reading:** the relevant
  0.4.90 lines are 636 (the comparison) and 641 (the guard), not 627–641 as
  a block; lines 627–635 are the identity and `confirmed`/`orderingRelevant`
  derivations, which were right.
- Both events were answered `200 ignored` and marked seen
  (`handleWebhook`, main `:421`), so a Stripe retry or dashboard resend of
  those exact ids is `duplicate` and never reaches `applyEvent`.

### 1.2 The bootstrap grant was the only entitlement

`onSubscriptionCheckout`, 0.4.90 `:1202-1206` (main `:1237-1241`):
`bootstrapExp = Math.max(now + policy.bootstrapDays·DAY, grant?.firstPaymentAtMs ?? 0)`.
A v2 hosted launch intent always has `firstPaymentAtMs: null`
(`src/billing/launch.ts:361`; `splitBundleIdentity` refuses otherwise, main
`:547`), so with the live box's `bootstrapDays: 3` the licence expired at
exactly **2026-10-09T03:39:59Z**, and the customer record kept
`periodEndMs: null`, `subscriptionStatus: "active"`,
`lastEventType: "checkout.session.completed"`.

### 1.3 Hosting reconciliation acted on the local clock

`src/hosting/service.ts` (identical in 0.4.90 and main before this branch):

- `softwareEligible` `:184-190` is purely local: a customer record, a
  non-revoked licence, and `lic.exp > nowMs`.
- `reconcileOwner` `:536-539`: `if (!this.softwareEligible(ownerId, nowMs))` →
  the log line *"refusing paid hosting provisioning … no eligible software
  licence is bound to this exact customer"* →
  `enqueueStripeCancellation(instance, sub.subscriptionId, "software-ineligible", nowMs)`
  (`:1479-1485`, dedupe key `stripe-cancel:<instance>:<subscription>:software-ineligible`).
- The same `tick()` (`:950-964`, every 30 s from `start()`) drains the
  `billing_reconcile` job: `:975-978` → `setStripeCancellation(subscriptionId, true)`
  `:1467-1476` → `POST /v1/subscriptions/{id}` with `cancel_at_period_end=true`.
  **The operator's `:975-977` is exact.**
- For a combined subscription that single Stripe call cancels software and
  hosting together, because they are one subscription.

### 1.4 Why the echo webhook extended the licence yet left the cancellation

Stripe's `customer.subscription.updated` (`evt_1UOUfM…`, 03:40:16) was the
echo of the Hub's own change: `status: active`, `cancel_at_period_end: true`,
`current_period_end` = 2026-11-06T03:39:55Z.

- It is ordering-relevant and newer than the watermark, so it applied.
  Software first: `onSubscriptionUpdated` (0.4.90 `:1307`, main `:1342-1359`)
  sets `cancelAtPeriodEnd = true`, `subscriptionStatus = "active (cancels at
  period end)"`, and because `status === "active"` with a period end,
  `extendLicense(rec, current_period_end + graceDays·DAY)` → the licence moved
  to **2026-11-09T03:39:55Z** (with `graceDays: 3`) and `periodEndMs` to Nov 6.
  Then hosting: `applyHostingEvent` (main `:974-982`) mirrored the same status
  and period end onto the hosting role record.
- The hosting hook ran `reconcileOwner` again; the licence was now eligible,
  so `applyBillingSignal` recorded `paidThroughMs` (main `:607`, `:624-644`). On the
  next tick (`:645-647`) the status `"active (cancels at period end)"` is
  `scheduledCancel` → `scheduleEnd(instance, "intentional_cancellation",
  periodEnd)` (`:670-683`): stage `cancel_scheduled`, `suspendAt` = Nov 6
  03:39:55, `deleteAt` = Nov 13 03:39:55 (`deadlines()`: no grace for an
  intentional cancellation, `retentionHours` 168), and `queueDeadlineJobs`
  (`:685-696`) queued the `cancellation_scheduled` email (sent 03:40:46), the
  three-day/one-day reminders, the suspend and the delete.
- Nothing un-cancels: the service's design is that the hosting lifecycle is
  derived from the mirrored Stripe record (file header, `:10-28`), the only
  `cancel_at_period_end=false` path is the customer's own
  `resumeRenewal` (`:750-766`; `bestEffortResumeStripeSubscription` is unused),
  and the instance row carries no fact that **the Hub** originated the
  cancellation (only the outbox job's `payload.reason` does). The Hub's own
  mistake was therefore recorded as the customer's intent
  (`cancellationReason: "intentional_cancellation"`), which is also what the
  customer dashboard shows.

### 1.5 What was already fixed before this review, and what was not

- The invoice half was corrected in 0.4.91 (`41c012a` `initialPaidAfterCheckout`,
  main `:645-654`; `8ac142d` durable retry, main `:660-671`), deployed
  **2026-10-09 19:18:52Z** (`docs/claude-review-2026-10-09/HUB-0491-DEPLOYMENT.md`),
  about 15.6 hours after this customer's cancellation at 03:40:15Z. His
  checkout on 10-06 ran on 0.4.90. The 0.4.91 admission does not re-apply
  already-discarded events (their ids are seen), so it changed nothing for
  records already in the incident state.
- The hosting half — cancelling a paid subscription on the Hub's own licence
  clock — was not addressed by 0.4.91. It also had no regression test
  (`software-ineligible` appears in no suite before this branch).

## 2. The fix on this branch (`claude/billing-ignored-invoice-tmp`, package 0.4.93)

Design choice: keep the 0.4.91 ordering decision (it admits exactly this
case) and remove the irreversible action from the other side. A local licence
expiry is the Hub's **derived** record; Stripe's word about the subscription
is the mirrored `subscriptionStatus`. When the two contradict each other,
the Hub's is the suspect one.

- `src/hosting/service.ts`
  - `softwareIneligibility()` (new, next to `softwareEligible`, which now
    delegates to it): `null` while eligible, else `unbound` (no customer or
    registry entry), `revoked`, or `lapsed { licenseExp, subscriptionStatus,
    subscriptionActive }`, where `subscriptionActive` is a set
    `subscriptionId`, status in {`active`, `trialing`, `active (cancels at
    period end)`}, and neither `refunded` nor `disputed`.
  - `reconcileOwner`: a `lapsed` + `subscriptionActive` result **withholds**
    the `software-ineligible` cancellation and the ordered-row deletion,
    logs one journal line per episode per process (with the licence expiry,
    the subscription id and status, and the repair path), skips
    provisioning of an unprovisioned order, and otherwise still derives the
    hosting lifecycle from the hosting record. `unbound`, `revoked`, and a
    lapse against `past_due`/`canceled`/no subscription cancel exactly as
    before; the existing log line keeps its text and gains the reason.
  - `drainProvision`: the same hold refuses (retryable, like the master
    switch) a `provision` job that was queued before the lapse, so no
    provider server is created for a licence `bootstrapLicenseToken` would
    refuse.
- `src/billing/service.ts`: comment only — the exact clock mechanics above,
  next to `initialPaidAfterCheckout`.
- Operator-side reversal (added on the operator's instruction, since a
  customer cannot be relied on to click "Resume renewal"):
  `HostingService.adminResumeRenewal` behind
  `POST /admin/api/hosting/instances/:id/resume-renewal` (admin token; body
  `{by, reason}`; 404 unknown, 503 when Stripe does not confirm, 409 with a
  code otherwise) and a "Resume renewal" button on `cancel_scheduled` rows
  of the admin page. The customer's `resumeRenewal` and the admin action
  now share one implementation, `reverseScheduledCancellation`: refuse
  (`SUBSCRIPTION_NOT_ACTIVE`) when the hosting record is not
  active/trialing/"active (cancels at period end)" or a charge is refunded
  or disputed (also the combined subscription's software charge); Stripe
  `cancel_at_period_end=false` first through the existing
  `setStripeCancellation`; only on confirmation reset the row to `ready`,
  clear the scheduled end and any deletion hold, bump the lifecycle version
  (pending suspend/delete/reminder jobs become `obsolete`), and append an
  `admin.hosting.resume-renewal` / `customer.hosting.resume-renewal` row
  to the billing audit ledger (the same ledger `admin.install.*` uses)
  naming actor, `by`, reason, instance, subscription, obsoleted jobs and any
  released hold. Admission differs only in the window: the operator may
  reverse while the row is still `cancel_scheduled`; a row with nothing
  scheduled answers `changed: false` (idempotent repeat); a `renewal_unpaid`
  schedule is refused (`RESTORATION_UNAVAILABLE`), payment reverses that.
- Not done, on purpose: the Hub does not auto-resume a cancellation it
  queued itself. It cannot tell, after the fact, its own cancellation from
  one the customer made in the portal in between. Recording `hubOriginated`
  on the instance row would make a safe auto-resume possible later; it is a
  design change, not part of this correction.
- Version: `package.json`, `package-lock.json`, `src/version.ts` → 0.4.93;
  README narrative and changelog entries (pinned by `tests/server.test.mjs`).

### Regression coverage — `tests/hosting-paid-term-guard.test.mjs` (11 checks)

Offline fixtures only (signed test webhook secret, FakeProvider, no network
beyond loopback), live-mode mixed v2 checkout with the live box's
`graceDays: 3` / `bootstrapDays: 3`, and the incident's clock shape: checkout
event `created` 2026-10-06T03:39:59Z, invoice events one second earlier,
period end 2026-11-06T03:39:55Z, reconciliation at 2026-10-09T03:40:15Z,
subscription update at 03:40:16Z, $59.40 discounted software + $20 VPS.

1. Exact event order → licence `exp` = 2026-11-09T03:39:55Z, `periodEndMs`
   and hosting `periodEndMs` = Nov 6, watermark unchanged, alias ignored,
   no `billing_reconcile` job after the three-day tick, instance stays
   `ready`, update keeps `active`/`cancelAtPeriodEnd: false`, and all four
   events replay as `duplicate` with an unchanged state snapshot.
2. Pre-0.4.91 state (invoice never applied): held, 0 cancellation jobs over
   three ticks, exactly one journal line, no cancellation email; the update
   extends the licence and lifts the hold.
3. The discarded invoice delivered three days late is still admitted
   (0.4.91) and lifts the hold.
4. An unprovisioned order is neither cancelled nor provisioned while held;
   the pending `provision` job waits (retryable error) and runs after the
   paid period lands.
5. Preserved: `invoice.payment_failed` (past_due), `customer.subscription.deleted`
   (canceled) and a full `charge.refunded` (revoked) still queue the
   `software-ineligible` cancellation and are never held.
6. `softwareIneligibility` classification matrix.
7. Separate hosting subscription next to a software-only subscription:
   lapse while active → held until the software `invoice.paid`.
8. Same shape, Stripe ends the software subscription → cancelled as before.
9. Operator reversal on the incident fixture (checkout, lapse, Stripe's
   echo with `cancel_at_period_end: true`, the Hub's `cancel_scheduled` row
   with the Nov 6 suspend / Nov 13 delete, an admin hold): one Stripe
   `cancel_at_period_end=false`, row `ready`, no pending end job, hold
   released, licence unchanged at Nov 9, audit row with actor/by/reason,
   the un-cancel echo and three ticks change nothing, a repeat answers
   `changed: false` with no Stripe call and no second audit row.
10. Refusals: no admin token (401), unknown instance (404), Stripe not
    confirming (503; row, hold and jobs untouched; no audit row), refunded /
    disputed / canceled / past-due subscription (409
    `SUBSCRIPTION_NOT_ACTIVE`, Stripe never asked), a running row
    (`changed: false`), a `renewal_unpaid` schedule (409
    `RESTORATION_UNAVAILABLE`).
11. The customer path and the admin path call the shared core exactly once
    each and produce identical row, job and Stripe-call outcomes; only the
    audit origin differs; the customer path now shares the refusals; the
    admin page wires the action on `cancel_scheduled` rows.

Mutation evidence (scratch copy of `dist` only; the real `dist/src/hosting/service.js`
sha256 `5bf7b975…` untouched): with the hold removed (`if (false)` at both
guard sites, copy sha `5484138e…`) tests 2, 3, 4 and 7 fail and 1, 5, 6, 8
stay green — the new assertions are load-bearing and the preserved cases do
not depend on the new code.

Other suites after the change, all passing with unchanged counts:
hosting-bundle 25, billing-six-plan 40, hosting-service 16, hosting-holds 12,
hosting-guardrails 17, hosting-bootstrap 13, hosting-readiness 8,
hosting-deadlines 6, hosting-store 9, billing-roles 18, billing-launch 25,
billing-payment-replay 12, billing-reminders 9, billing-legacy-lifetime 5,
billing-fulfillment-lifecycle 4, billing-after-commit-outbox 5,
claude-deadline-charge-interleave 3, foreign-product-family 4, server 21,
customer-sessions 19, license 14, billing-reporting and
hosting-access-email-notice (exit 0). The full `npm test` gate was **not**
run (lead's instruction); it is required before any release.

## 3. Audit for other customers — `scripts/audit-ignored-initial-invoices.mjs`

The Hub's storage is JSON files under the data directory (default
`/opt/wickhunter-hub/data`, or `HUB_DATA_DIR` from `/etc/wickhunter-hub/env`),
not a database. The script is read-only (read-only descriptors, no writes,
no Stripe or provider calls) and reports three things:

- **A.** every `invoice.paid`/`invoice.payment_succeeded` in the complete
  `billing-events.v1.jsonl` whose outcome is `ignored` with note
  `older bundle lifecycle event ignored`, grouped under the applied
  `checkout.session.completed` received within the window before it
  (default 300 s). The ledger stores no subscription id, so attribution is a
  **candidate** list: customers whose `firstActualPaymentAtMs` or
  `createdAtMs` falls within the window of that checkout, each with a
  verdict — `BOOTSTRAP_ONLY[_LAPSED]` (still no paid-through; would have
  cancelled at `exp` under ≤ 0.4.92, is held under 0.4.93),
  `HEALED_BUT_CANCELLATION_SCHEDULED` (this customer's pattern), `HEALED`.
  Ignored invoice events with no checkout in the window are listed as
  orphans, never attributed.
- **B.** every `hosting-db.v1.json` outbox job
  `billing_reconcile` / `action: cancel` / `reason: software-ineligible`
  (the `unreserved-payment` reason is a different thing and excluded), with
  the instance's stage/deadlines, the owner's records and the Stripe fact
  from `launch-billing-report.v1.json`; flags `stripeActiveAtQueue`
  (Stripe reported `active`/`trialing` with a period end after the job was
  queued) and `hubOriginatedCancellationScheduled` (job `sent`, instance
  `intentional_cancellation`, customer `cancelAtPeriodEnd`).
- **C.** every live customer still on a bootstrap-only grant
  (`periodEndMs: null`, `lastEventType` `checkout.session.*`), with whether
  it has already lapsed while its subscription is active.

Local results (no production run): against an incident-shaped fixture with
fixture identifiers (`tests/audit-ignored-initial-invoices.test.mjs`) it
finds the one checkout group with two ignored events attributed to the
affected customer as `HEALED_BUT_CANCELLATION_SCHEDULED`, the one
`software-ineligible` job flagged `stripeActiveAtQueue` and
`hubOriginatedCancellationScheduled`, the one bootstrap-only row, and an
orphan alias; against an empty directory and a hermetic hub's own data
directory it finds nothing; file hashes and mtimes are unchanged by every
run. The repository has no local production DB (`data/` is gitignored and
absent).

Operator run (read-only; as `root` or `wickhunter-hub`, on the Hub box, from
the checkout that carries this script):

```sh
HUB_DATA_DIR=/opt/wickhunter-hub/data node scripts/audit-ignored-initial-invoices.mjs            # text report
HUB_DATA_DIR=/opt/wickhunter-hub/data node scripts/audit-ignored-initial-invoices.mjs --json > /root/audit-$(date -u +%Y%m%dT%H%M%SZ).json
HUB_DATA_DIR=/opt/wickhunter-hub/data node scripts/audit-ignored-initial-invoices.mjs --since=2026-10-01
```

Refresh the Stripe facts first if they are older than a day
(`POST /admin/api/billing/report/refresh`, read-only against Stripe), so
section B's flags rest on a fresh fact; the report prints each fact's age.
The 0.4.91 deployment record already notes six "older bundle lifecycle event
ignored" invoice events between 10-07 and 10-09 in the admin ledger tail;
this customer's two are from 10-06 and may lie outside that 2 MiB tail, which
is why the script reads the whole file.

## 4. Why the checkout included hosting — what this repository can and cannot show

- **The website chooser is not in this repository.** `/buy` with no plan
  redirects to `${siteOrigin}/unleashed/#pricing` (`src/server.ts:981-999`;
  `siteOrigin` is admin configuration). Whether the public pricing page
  pre-selects "with VPS", how the toggle is labelled, or what the buttons
  say cannot be verified here; the README (v0.4.87) describes the chooser's
  VPS as "optional".
- **The Hub itself never defaults to hosting.** `/api/billing/checkout`
  requires `hosting` to be a boolean when present and treats an absent or
  `false` value as software-only (`src/billing/launch.ts:257, 275`); the
  choice is part of the attempt's immutable request identity. The customer's
  launch intent (`d93374c0…`) therefore carries `hostingRequested: true`
  and a `hosting` price proof: the request the Hub received asked for VPS.
- **A link can be the consent.** `/buy?plan=monthly&hosting=true`, or a
  hosted alias such as `/buy?plan=monthly-hosted` / `hosted-monthly`
  (`src/server.ts:1004-1010`), goes straight to a hosted Stripe Checkout
  with no interstitial. If the pricing page's "with VPS" button, a referral
  link or a support reply used such a link, one click selected hosting.
- **What the customer saw at Stripe.** Two line items — the software price
  (discounted; $59.40) and the separate VPS product price ($20.00/month) —
  a total of $79.40, and the submit text the Hub sets for hosted monthly
  plans (`src/billing/launch.ts:401-403`): *"Software and VPS bill today and
  renew together monthly until canceled. VPS is $20/month; software
  promotion codes exclude VPS. VPS plans bill immediately due to VPS
  provider fees. Cancel in Manage subscription."* The metadata names the
  bundle (`software-hosting-v2`).
- **After purchase.** A server was provisioned and the "installation ready"
  email with the VPS address and temporary password was sent
  (`hosting/emails.ts`, `installationReadyEmail`); the customer dashboard
  labels the subscription "combined software + hosting" and warns that
  cancelling or resuming affects both (`public/customer.html:406, 417, 457-459, 473`).
- **How to settle it:** read
  `data/billing-launch-intents.v1/d93374c0….json` (`hostingRequested`,
  `stripeParams.line_items[1][price]`, `custom_text[submit][message]`) and
  the Stripe Checkout Session's `client_reference_id`/`metadata` for the
  exact request, and the pricing page's current markup for the default
  state of the VPS option. Neither is in this repository.

## 5. Not verified here

- The live values: the customer's current `exp`, record fields, outbox
  rows, and Stripe subscription state — the proposal assumes the operator's
  log sequence and derives the expected values from the code paths above.
- That a conforming Stripe `customer.subscription.updated` is what will
  arrive after an un-cancel (it is, per the same handler that applied the
  echo), and Stripe's retry byte-equality for the 0.4.91 admission.
- The public website's checkout UI and default VPS selection.
- The full `npm test` gate on this branch.
