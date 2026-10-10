# Reconciliation proposal — Hendrik Garner (NOT applied)

> Contains customer identifiers. The repository's incident notes keep
> customer-specific identifiers out of the public repository
> (`docs/incidents/2026-10-09-initial-subscription-term.md`); keep this file on
> the operator's side or strip the identifiers before any push to a shared
> remote. Nothing in this document has been executed. Every step names what to
> verify before the next one. Times are UTC.

## The customer's position

- Customer `cus_VOBbKE0iQyHu6r`, garner@posteo.at. Checkout completed
  2026-10-06 03:39:59 (`evt_1UNPEQKEy2hVxsez1UZhYt9g`), charged **$79.40** =
  $59.40 discounted software + $20.00 Managed VPS, one combined subscription
  `sub_1UNPEPKEy2hVxsezQWJlMmJl`, period 2026-10-06 03:39:55 → **2026-11-06
  03:39:55**. Server `45.77.17.97` (Vultr `379867e9-bc86-4cfe-bb4d-e08b499636ac`)
  running; hosting row `host_BAhG6SZLJcwGqm-A`; licence
  `b9c32411-65fb-43a6-a3b2-070523a31b5c`; launch intent `d93374c0…`.
- What went wrong (details in `BILLING-IGNORED-INVOICE-FINDINGS.md`): the
  Hub discarded his initial paid invoice (`evt_1UNPERKEy2hVxsezKhzzBSvg`,
  `evt_1UNPERKEy2hVxsezvGiE9ajV`), let his licence lapse on 10-09 03:39:59
  after the three-day bootstrap grant, and at 03:40:15 queued and sent a
  `cancel_at_period_end=true` for the whole subscription as
  `software-ineligible`. Stripe's echo (`evt_1UOUfMKEy2hVxsez1RnAnGWG`,
  03:40:16) extended his licence to the paid term but the Hub recorded the
  cancellation as his own; he received "Your VPS hosting will end on
  November 6" at 03:40:46. He did not ask for any of this.
- Expected current state (verify in step 0): Stripe `active`,
  `cancel_at_period_end: true`, ends 11-06 03:39:55. Hub customer record
  `subscriptionStatus: "active (cancels at period end)"`,
  `cancelAtPeriodEnd: true`, `periodEndMs` 11-06 03:39:55; licence `exp`
  **2026-11-09 03:39:55** (period end + 3-day grace; epoch ms
  `1794195595000`); hosting row stage `cancel_scheduled`,
  `cancellationReason: "intentional_cancellation"`, `suspendAtMs` 11-06
  03:39:55, `deleteAtMs` **2026-11-13 03:39:55**; pending outbox jobs
  `suspend` (11-06 03:39:55), `email three_days` (11-10 03:39:55), `email
  one_day` (11-12 03:39:55), `delete` (11-13 03:39:55); one `billing_reconcile`
  job `sent` with `payload.reason: software-ineligible`.

## Order of operations

### Step 0 — read everything first (read-only)

```sh
ENV=/etc/wickhunter-hub/env; TOKEN=$(sed -n 's/^HUB_ADMIN_TOKEN=//p' $ENV); H=http://127.0.0.1:8091
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/billing/customers | jq '.[] | select(.stripeCustomerId=="cus_VOBbKE0iQyHu6r")'
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/licenses | jq '.licenses[] | select(.id=="b9c32411-65fb-43a6-a3b2-070523a31b5c")'
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/hosting/instances | jq '.[] | select(.id=="host_BAhG6SZLJcwGqm-A")'
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/hosting/instances/host_BAhG6SZLJcwGqm-A/outbox
HUB_DATA_DIR=/opt/wickhunter-hub/data node scripts/audit-ignored-initial-invoices.mjs --since=2026-10-01   # from this branch's checkout
```

Confirm the expected state above and the Stripe subscription in the
Dashboard. If `exp` is already later than 2026-11-09 03:39:55 or the Stripe
subscription no longer shows a scheduled cancellation, adjust the steps
below accordingly — never shorten anything. Record the outputs.

### Step 1 — stop the irreversible part now (reversible, operator)

`POST /admin/api/hosting/instances/host_BAhG6SZLJcwGqm-A/hold`
`{"reason":"Hub-originated cancellation under review (2026-10-09 initial-invoice defect)"}`

- Effect: `drainDelete` refuses the 11-13 deletion while held, and the
  three-day/one-day reminder emails are suppressed. The customer dashboard
  shows "This server is on hold by support." with no dates.
- **It does not stop the 11-06 03:39:55 suspend** (`drainSuspend` has no
  hold guard). Step 2 must be completed before then.
- Verify: instance row `deletionHold` set; no new email jobs.

### Step 2 — reverse the cancellation (the actual fix)

**Preferred, one action, Hub-safe:** the customer clicks **"Resume software
+ hosting renewal"** on his dashboard (`https://<hub>/customer#hosting`,
sign-in by email link). That is `POST /api/hosting/host_BAhG6SZLJcwGqm-A/resume-renewal`
(`src/hosting/service.ts`, `resumeRenewal`): it first asks Stripe for
`cancel_at_period_end=false` and only on Stripe's confirmation resets the row
to `ready`, clears `cancellationReason`/`suspendAtMs`/`deleteAtMs`, bumps the
lifecycle version and obsoletes the pending suspend/delete/reminder jobs.
It is allowed while stage is `cancel_scheduled` and now < 11-06 03:39:55.

- Verify at Stripe: subscription `active`, no scheduled cancellation, next
  invoice 11-06 for $79.40 (or the amount after step 5).
- Verify at the Hub: the resulting `customer.subscription.updated`
  (`cancel_at_period_end: false`) is `applied` in the admin events list;
  customer record `subscriptionStatus: "active"`, `cancelAtPeriodEnd: false`,
  `periodEndMs` unchanged (11-06); hosting role record `active`; instance row
  `stage: "ready"`, `cancellationReason: null`, `suspendAtMs: null`,
  `deleteAtMs: null`; `/outbox` shows `suspend`, `delete`, `three_days`,
  `one_day` as `obsolete`.
- Then release the hold: `POST /admin/api/hosting/instances/host_BAhG6SZLJcwGqm-A/release-hold`
  (with no expiry pipeline on the row it just clears the hold). Verify the
  customer view shows normal dates again (paid through 11-06, no suspension).

**Operator fallback (only if the customer cannot act before 11-06):**

1. Stripe Dashboard → subscription → remove the scheduled cancellation
   (`cancel_at_period_end=false`). The echo webhook heals the billing
   records (`active`, `cancelAtPeriodEnd: false`) but **not** the hosting
   row — it stays `cancel_scheduled` with the 11-06 suspend job, because a
   payment or status change never clears an `intentional_cancellation`
   (`applyBillingSignal`, `clearsEndSchedule`).
2. There is no admin endpoint that resets that row. The remaining options
   are (a) a Hub change adding an admin "resume" that performs
   `resumeRenewal`'s row mutation without the Stripe call (recommended
   follow-up; small), or (b) a last-resort edit of `hosting-db.v1.json`
   with the service stopped and a fresh `scripts/backup-data.sh` backup:
   on `instances.host_BAhG6SZLJcwGqm-A` set `stage: "ready"`,
   `cancellationReason: null`, `suspendAtMs: null`, `deleteAtMs: null`,
   `lifecycleVersion: <current + 1>`, and set every `outbox` row for this
   instance that is `pending` with the old `lifecycleVersion` to
   `status: "obsolete"`. Keep the hold from step 1 until this is done.

### Step 3 — the licence (verify; repair only if short)

Expected `exp` = **2026-11-09T03:39:55Z** (`1794195595000`), already set by
the echo webhook. If the registry shows anything earlier:

`POST /admin/api/licenses/expiry {"id":"b9c32411-65fb-43a6-a3b2-070523a31b5c","exp":1794195595000}`

- Verify: `GET /admin/api/licenses` shows the new `exp`; the customer's app
  installs it on its next 5-minute check-in (`lastSeen` advances; the app
  journal logs "licence extended by the hub"). Never set an earlier value.
- Nothing else in the billing record needs a hand edit; `periodEndMs` is
  already 11-06 from the echo webhook and the 11-06 renewal will advance
  it.

### Step 4 — the $20 hosting he says he does not use

Facts first: a VPS was provisioned and is running; the Hub's checkout only
adds hosting when the request says `hosting: true`, and the Stripe page
showed the $20 VPS line and "Software and VPS bill today and renew together
monthly" (findings §4). Ask him what he wants before touching Stripe. The
Hub-side consequences of each option:

| Option | Money | Hub safety | Notes |
| --- | --- | --- | --- |
| **A. Keep the combined plan as bought, refund the first month's VPS as goodwill** | Partial refund **$20.00** of the 10-06 charge (ch_… on `in_…`). | Safe: `charge.refunded` for less than the charge is "partial refund recorded; licence untouched" on both roles. | He keeps the server at 45.77.17.97; renews at $79.40 on 11-06. Choose this if he wants to keep the VPS. |
| **B. Keep one subscription, stop charging for the VPS** | $20.00 refund now **and** a recurring Stripe coupon of **$20.00 off** (`amount_off` 2000 USD, `duration: forever`) on `sub_1UNPEP…`, so renewals charge $59.40. | Safe for entitlement: both prices stay on every invoice, so the Hub's bundle identity holds and the licence renews. Caveat: the invoice-level discount is read by `checkoutDiscountPercent`/`softwareInvoiceProjection` and may re-derive his software `discountPercent` and the Earn/referral share — check the first renewal's event note and the Earn ledger. | The VPS cannot be retired while the combined subscription continues: an admin force-suspend is undone by the next paid period (`restore`), and deleting it would make the 11-06 hosting payment a "late payment after deletion" exception. The provider cost (half the $20 price by policy) is then borne by the business. |
| **C. Software-only subscription instead** | Let the combined subscription end on 11-06 (keep today's scheduled cancellation) and sell a software-only plan starting 11-06; refund $20.00 for October. | **Not supported by the Hub today:** a second subscription on this launch-managed customer is refused (`onInvoicePaid`: "Paid invoice belongs to a different subscription on this customer"), and removing the VPS line item from the existing subscription breaks the mixed-checkout identity (`splitBundleIdentity` requires the hosting price on every invoice → 500 → Stripe retries → no renewal applied). Either needs a Hub change (a "drop hosting from a combined subscription" path, or an admin rebind of the customer's `subscriptionId`). | Do not attempt without that change. |

Recommendation: **A** if he will use the server, **B** if he will not — both
are safe today — and a follow-up Hub change for C so this choice exists for
every hosted customer. Whatever is chosen, keep step 2 (un-cancel) first:
under C the un-cancel would be reversed deliberately later, never left to
the Hub's mistaken schedule.

How to issue the $20.00 refund: Stripe Dashboard → payment of 10-06 ($79.40)
→ Refund → amount 20.00 → reason "requested_by_customer" with the note
"Managed VPS month 1 — billing error on our side". Verify in the Hub admin
events: `charge.refunded … applied — bundle software: partial refund
recorded; licence untouched; hosting: hosting partial refund recorded`; the
licence is not revoked (`revoked: false`).

### Step 5 — after 2026-11-06 03:39:55 (close-out)

- `invoice.paid` (`billing_reason: subscription_cycle`) for the renewal is
  `applied` and the note reads "licence extended to 2026-12-09"; customer
  `periodEndMs` 12-06 03:39:55; hosting role `periodEndMs` 12-06; instance
  `paidThroughMs` 12-06, stage `ready`. Re-run the audit script; his rows
  should show `HEALED` with no `software-ineligible` job after 10-09.
- If option B was chosen: the renewal charged $59.40, and the Hub's
  `discountPercent`/Earn figures were checked.

## Draft email to the customer

Subject: Your Wick Hunter subscription — our billing error, and what we've done

Hi Hendrik,

I'm writing about the email you received on 9 October saying your hosting
would end on 6 November. You did not cancel anything — that cancellation was
triggered by a bug on our side. Our system failed to record the payment you
made on 6 October and, three days later, treated your subscription as unpaid
and scheduled it to end. Your payment of $79.40 was received and your access
was never meant to lapse. I'm sorry.

What we are doing:

- The scheduled cancellation is being removed, so your subscription
  continues normally and your software licence runs through the period you
  paid for (and renews as usual). [If using the dashboard path: the quickest
  way is for you to open your dashboard at <link> and click "Resume software
  + hosting renewal"; that single click reverses it on both our side and
  Stripe's. If you'd rather we do it, reply and we will.]
- The server deletion that was scheduled for 13 November has been put on
  hold and will be cancelled.
- Your purchase included a Managed VPS at $20/month (the server at
  45.77.17.97 that was set up for you). You mentioned you don't use it. We
  can either keep it running for you, or refund the $20 for this month and
  stop charging for it going forward — just tell us which you prefer.

Nothing further is needed from you unless you want to choose one of the
options above. Thank you for your patience, and again, apologies for the
alarm.

Best regards,
Wick Hunter Support

## Safety notes

- Never use `force-delete` or delete the Vultr instance as part of this.
- Do not edit `licenses.json`, `billing-customers.v1.json` or
  `hosting-db.v1.json` while the service runs; the admin endpoints above are
  the supported path, and the one unsupported edit (step 2 fallback b) needs
  the service stopped and a backup.
- Nothing here is a Stripe refund, coupon or cancellation change until the
  operator performs it; this document records the intended changes and the
  checks around them.
