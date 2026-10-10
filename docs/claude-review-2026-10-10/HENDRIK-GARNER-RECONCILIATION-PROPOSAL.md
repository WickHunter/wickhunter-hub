# Hendrik Garner — record of the situation and the options considered (no changes authorized)

> **Operator instruction (2026-10-10): "don't change anything."** No record
> change is authorized at this time: no refund, no coupon, no deletion hold,
> no resume of renewal, no licence edit, no customer email. This document is
> a record of the situation, of the options that were considered and not
> taken, and of what would be done if the operator later decides to reverse
> the Hub-originated cancellation. Nothing in it has been applied, scheduled
> or prepared for application.
>
> Contains customer identifiers. The repository's incident notes keep
> customer-specific identifiers out of the public repository
> (`docs/incidents/2026-10-09-initial-subscription-term.md`); keep this file
> on the operator's side or strip the identifiers before any push to a
> shared remote. Times are UTC.

## 1. The situation

- Customer `cus_VOBbKE0iQyHu6r`, garner@posteo.at. Checkout completed
  2026-10-06 03:39:59 (`evt_1UNPEQKEy2hVxsez1UZhYt9g`), charged **$79.40** =
  $59.40 discounted software + $20.00 Managed VPS on one combined
  subscription `sub_1UNPEPKEy2hVxsezQWJlMmJl`, period 2026-10-06 03:39:55 →
  **2026-11-06 03:39:55**. Server `45.77.17.97` (Vultr
  `379867e9-bc86-4cfe-bb4d-e08b499636ac`) running; hosting row
  `host_BAhG6SZLJcwGqm-A`; licence `b9c32411-65fb-43a6-a3b2-070523a31b5c`;
  launch intent `d93374c0…`.
- What happened (code-level detail in `BILLING-IGNORED-INVOICE-FINDINGS.md`):
  the Hub, then on 0.4.90, discarded his initial paid invoice
  (`evt_1UNPERKEy2hVxsezKhzzBSvg`, `evt_1UNPERKEy2hVxsezvGiE9ajV`) as "older
  bundle lifecycle event ignored", let his licence lapse at 2026-10-09
  03:39:59 after the three-day bootstrap grant, and at 03:40:15 queued and
  sent `cancel_at_period_end=true` for the whole subscription as
  `software-ineligible`. Stripe's echo (`evt_1UOUfMKEy2hVxsez1RnAnGWG`,
  03:40:16) extended his licence to the paid term plus grace; the Hub
  recorded the cancellation as the customer's own intent
  (`intentional_cancellation`); at 03:40:46 he was emailed "Your VPS
  hosting will end on November 6". He did not ask for any of this.
- Expected current state (derived from the code paths; not read from the
  live box by this review): Stripe subscription `active` with
  `cancel_at_period_end: true`, ends 2026-11-06 03:39:55. Hub customer
  record `subscriptionStatus: "active (cancels at period end)"`,
  `cancelAtPeriodEnd: true`, `periodEndMs` 2026-11-06 03:39:55; licence `exp`
  **2026-11-09 03:39:55** (period end + 3-day grace; epoch ms
  `1794195595000`). Hosting row stage `cancel_scheduled`,
  `cancellationReason: "intentional_cancellation"`, `suspendAtMs` 2026-11-06
  03:39:55, `deleteAtMs` **2026-11-13 03:39:55**. Pending outbox jobs:
  `suspend` (11-06 03:39:55), `email three_days` (11-10 03:39:55), `email
  one_day` (11-12 03:39:55), `delete` (11-13 03:39:55); one `billing_reconcile`
  job `sent` with `payload.reason: "software-ineligible"`.

## 2. Consequence of no action (the instruction in force)

With nothing changed, the Hub's own cancellation stands as the recorded
intent and the following happens on the Hub's existing schedule:

| When (UTC) | What |
| --- | --- |
| 2026-11-06 03:39:55 | Stripe ends the subscription at period end; no renewal is charged. The Hub applies `customer.subscription.deleted` → software and hosting records `canceled`. |
| 2026-11-06 03:39:55 | The `suspend` job powers the VPS off (`drainSuspend`); "suspended" email is queued. Bot management on the server stops; exchange positions and orders are not touched by that. |
| 2026-11-09 03:39:55 | The software licence lapses (`exp`); the app becomes exit-only from then (no new entries; closes, TP/SL and protection continue). |
| 2026-11-10 03:39:55 | "3 days until deletion" reminder email. |
| 2026-11-12 03:39:55 | "1 day until deletion" reminder email. |
| 2026-11-13 03:39:55 | The `delete` job permanently removes the VPS and its data (`drainDelete`); "terminated" email. |

A renewal that nevertheless arrived (it will not, with the cancellation in
place) would be treated as a late payment after deletion once the delete
has committed, never as a restoration. The customer dashboard shows the
subscription as cancelled by him and offers "Resume software + hosting
renewal" until 11-06 03:39:55; if he clicks it himself, the Hub reverses
the cancellation through the same implementation described in section 4.

## 3. Options considered and not taken

| Option | What it would do | Status |
| --- | --- | --- |
| Reverse the Hub-originated cancellation (section 4) | Stripe `cancel_at_period_end=false`, hosting row back to running, end jobs obsoleted; licence already at the paid term. | **Not authorized** ("don't change anything"). Checklist retained below in case the decision changes before 2026-11-06 03:39:55. |
| A. Keep the bundle, refund the first month's VPS ($20.00 partial refund of the 10-06 charge) | Hub-safe: a partial `charge.refunded` is "partial refund recorded; licence untouched" on both roles; nothing revoked. | Considered (briefly decided, then withdrawn); **not taken**. |
| B. Keep one subscription, stop charging for the VPS ($20.00 refund + a recurring $20-off coupon → $59.40/month) | Safe for entitlement (both prices stay on each invoice). Caveat: the invoice-level discount may re-derive the software `discountPercent` and the Earn/referral share; the VPS cannot be retired while the combined subscription continues (a force-suspend is undone by the next paid period; a deletion makes the next hosting payment a late-payment exception). | **Not taken**. |
| C. Software-only subscription instead | Not supported by the Hub today: a second subscription on this launch-managed customer is refused, and removing the VPS line from the existing subscription breaks the mixed-checkout identity (`splitBundleIdentity`) so renewals would not be applied. Needs a Hub change first. | **Not taken**; product gap noted. |
| Customer email | Draft in section 5. | **Not to be sent.** |

## 4. If the operator later decides to reverse — ordered checklist (deadline 2026-11-06 03:39:55 UTC)

Everything below is conditional on a new operator decision. The admin
reversal action exists on this branch (Hub 0.4.93, `adminResumeRenewal`,
`POST /admin/api/hosting/instances/:id/resume-renewal`) and needs the 0.4.93
rollout first; it is the customer's own "Resume renewal" with operator
admission, running the same implementation (Stripe first, then the row).
After 2026-11-06 03:39:55 the suspend has run and this path no longer
applies (the row is `suspended`; a reversal would then be a restore, which
requires paid evidence).

### 4.0 Read everything first (read-only; expected values in section 1)

```sh
ENV=/etc/wickhunter-hub/env; TOKEN=$(sed -n 's/^HUB_ADMIN_TOKEN=//p' $ENV); H=http://127.0.0.1:8091
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/billing/customers | jq '.[] | select(.stripeCustomerId=="cus_VOBbKE0iQyHu6r")'
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/licenses | jq '.licenses[] | select(.id=="b9c32411-65fb-43a6-a3b2-070523a31b5c")'
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/hosting/instances | jq '.instances[] | select(.id=="host_BAhG6SZLJcwGqm-A")'
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/hosting/instances/host_BAhG6SZLJcwGqm-A/outbox
HUB_DATA_DIR=/opt/wickhunter-hub/data node scripts/audit-ignored-initial-invoices.mjs --since=2026-10-01   # from the 0.4.93 checkout; writes nothing
```

Confirm the state in section 1 and the Stripe subscription in the
Dashboard. If anything differs, stop and re-derive before acting. Never
shorten a licence.

### 4.1 Deletion hold (reversible; protects the 11-13 delete, not the 11-06 suspend)

`POST /admin/api/hosting/instances/host_BAhG6SZLJcwGqm-A/hold`
`{"by":"<initials>","reason":"Hub-originated cancellation under review (2026-10-09 initial-invoice defect)"}`

- Effect: `drainDelete` refuses while held; the three-day/one-day reminders
  are suppressed; the dashboard shows "This server is on hold by support."
- **Does not stop the 11-06 03:39:55 suspend** (`drainSuspend` has no hold
  guard). Step 4.2 must complete before then.
- Verify: instance row `deletionHold` set; no new email jobs queued.

### 4.2 Operator-side reversal (primary path; no customer action required)

`POST /admin/api/hosting/instances/host_BAhG6SZLJcwGqm-A/resume-renewal`
`{"by":"<initials>","reason":"2026-10-09 initial-invoice defect; Hub-originated cancellation"}`

What it does (`src/hosting/service.ts`, `adminResumeRenewal` →
`reverseScheduledCancellation`): refuses unless the row is
`cancel_scheduled` with `intentional_cancellation` and the Hub's mirror of
the subscription is active (not `past_due`/`canceled`, not refunded or
disputed); asks Stripe for `cancel_at_period_end=false` and changes nothing
locally unless Stripe confirms (503 `PROVIDER_STATUS_UNKNOWN` otherwise —
retry); then sets the row to `ready`, clears `cancellationReason`,
`suspendAtMs`, `deleteAtMs` and the deletion hold, bumps the lifecycle
version so the pending suspend/delete/reminder jobs become `obsolete`, and
appends an `admin.hosting.resume-renewal` row to the billing audit ledger
with the operator's `by` and `reason`. A repeat answers `changed: false`
and calls Stripe again only if something is scheduled. The customer's
dashboard button does the same thing through the same code.

- Verify at Stripe: subscription `active`, no scheduled cancellation, next
  invoice 2026-11-06 for $79.40.
- Verify at the Hub: response `{"ok":true,"stage":"ready","changed":true}`;
  the resulting `customer.subscription.updated` (`cancel_at_period_end:
  false`) is `applied` in the admin events list; customer record
  `subscriptionStatus: "active"`, `cancelAtPeriodEnd: false`, `periodEndMs`
  unchanged (11-06); hosting role record `active`; instance row `stage:
  "ready"`, `cancellationReason: null`, `suspendAtMs: null`, `deleteAtMs:
  null`, `deletionHold: null`; `/outbox` shows `suspend`, `delete`,
  `three_days`, `one_day` as `obsolete`; the audit ledger has
  `admin.hosting.resume-renewal` with `actor: "operator"`.

Fallback without the 0.4.93 rollout: the customer's own "Resume software +
hosting renewal" click (same implementation; allowed until 11-06 03:39:55),
or Stripe Dashboard un-cancel plus a service-stopped edit of the hosting row
(not recommended; the row keeps its 11-06 suspend job after a Stripe-only
un-cancel because a payment or status change never clears an
`intentional_cancellation`).

### 4.3 Licence (verify; repair only if short)

Expected `exp` = **2026-11-09T03:39:55Z** (`1794195595000`), already set by
the echo webhook. Only if the registry shows anything earlier:
`POST /admin/api/licenses/expiry {"id":"b9c32411-65fb-43a6-a3b2-070523a31b5c","exp":1794195595000}`.
Verify `GET /admin/api/licenses`; the customer's app installs a later `exp`
on its next 5-minute check-in (`lastSeen` advances). Never set an earlier
value. `periodEndMs` needs no hand edit.

### 4.4 Money: none

No refund, no coupon, no change to the subscription items or the VPS
(options A–C in section 3 are recorded as considered and not taken).
Renewal continues at $79.40 on 2026-11-06 after a reversal.

### 4.5 Close-out after 2026-11-06 03:39:55

- `invoice.paid` (`billing_reason: subscription_cycle`) for the renewal is
  `applied` with "licence extended to 2026-12-09"; customer `periodEndMs`
  2026-12-06 03:39:55; hosting role `periodEndMs` 12-06; instance
  `paidThroughMs` 12-06, stage `ready`. Re-run the audit script: his rows
  read `HEALED` and no `software-ineligible` job is dated after 10-09.

## 5. Customer email — draft, NOT TO BE SENT

Kept only as a record of what would have been said; the operator decided
no email is to be sent.

> Subject: Your Wick Hunter subscription — our billing error, and what we've done
>
> Hi Hendrik,
>
> I'm writing about the email you received on 9 October saying your hosting
> would end on 6 November. You did not cancel anything — that cancellation
> was triggered by a bug on our side. Our system failed to record the payment
> you made on 6 October and, three days later, treated your subscription as
> unpaid and scheduled it to end. Your payment of $79.40 was received and
> your access was never meant to lapse. I'm sorry.
>
> The scheduled cancellation has been removed, so your subscription continues
> normally, your software licence runs through the period you paid for and
> renews as usual, and the server deletion that was scheduled for 13 November
> has been cancelled. Nothing is needed from you.
>
> Best regards,
> Wick Hunter Support

## 6. Safety notes

- Never use `force-delete` or delete the Vultr instance as part of this.
- Do not edit `licenses.json`, `billing-customers.v1.json` or
  `hosting-db.v1.json` while the service runs; the admin endpoints above are
  the supported path.
- Nothing here changes Stripe, the Hub or the provider until an operator
  performs it under a new decision; this document records the state, the
  consequence of leaving it, and the checks around any later reversal.
