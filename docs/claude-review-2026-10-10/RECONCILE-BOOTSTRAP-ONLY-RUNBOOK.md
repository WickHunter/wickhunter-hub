# Runbook: reconcile bootstrap-only customers from Stripe (Hub 0.4.94)

> **Contains customer identifiers** (Stripe customer ids in section 6, as the
> operator's lists). The repository's incident notes keep customer-specific
> identifiers out of the public repository
> (`docs/incidents/2026-10-09-initial-subscription-term.md`); keep this file
> on the operator's side or strip section 6 before any push to a shared
> remote. Times are UTC.

Nothing in this runbook has been run. Running it is the operator's, on the
Hub box, after Hub 0.4.94 is deployed and its post-start health shows
0.4.94. Building, qualifying and deploying 0.4.94 are separate steps.

## 1. What the tool does and does not do

`POST /admin/api/billing/reconcile-subscription` (admin token) with
`{subscriptionId}` or `{customerId}`:

- **Reads Stripe, read-only**, through the Hub's own Stripe client and key:
  `GET /v1/subscriptions/{id}`, `GET /v1/subscriptions?customer=…&status=all`,
  `GET /v1/invoices?subscription=…`. Nothing is ever written to Stripe.
- **Applies the latest paid invoice's term** (status `paid`, `amount_paid` > 0)
  through `applyPaidInvoiceTerm`, the same function the `invoice.paid` webhook
  uses, with a mixed software+VPS subscription's invoice projected to its
  software lines exactly as the webhook projects it. Fields set:
  `periodEndMs` (Stripe's period end), the first actual payment (earliest
  `paid_at`), status `active` (a "cancels at period end" status is left as
  it is), the software discount, and `lastEventType`
  `admin.billing.reconcile-subscription`. Licence expiry becomes
  **max(existing, period end + graceDays)**: an expiry already at or past the
  paid term is left exactly as it is (the line says `exp … unchanged`) and is
  never shortened.
- **Dry run by default.** Only `dryRun: false` with `by` and `reason` writes.
  A dry run returns the exact before → after it would apply and writes no
  file.
- An apply writes the customer record, the licence registry only if the
  expiry moves, and one `admin.billing.reconcile-subscription` row in the
  billing audit ledger (actor, by, reason, customer, subscription, licence,
  invoice, amount, before/after).
- **Never**: changes `cancel_at_period_end`, the hosting role record, the VPS
  instance or its lifecycle, a deletion hold, or sends an email.
- A record that already carries the paid term → `NOTHING_TO_APPLY` (no write,
  no audit row). A repeat after an apply is `NOTHING_TO_APPLY`.
- **Refuses by name, writing nothing** ("needs operator review"):
  `SUBSCRIPTION_NOT_ACTIVE` (Stripe status not active/trialing),
  `LICENSE_REVOKED`, `REFUNDED_OR_DISPUTED`, `MULTIPLE_ACTIVE_SUBSCRIPTIONS`
  (more than one subscription on the Stripe customer that has not ended),
  `LATEST_INVOICE_UNSETTLED` (latest invoice open, draft or uncollectible),
  `PERIOD_MISMATCH` (the paid invoice's period does not contain Stripe's
  `current_period_end`), `NO_PAID_INVOICE_YET` (no invoice with a positive
  amount paid; a $0 anchor invoice is not a paid term), `IDENTITY_MISMATCH`,
  `INVOICE_LINES_INCOMPLETE`, `LIFETIME_NOT_A_TERM`, `RECOVERY_PENDING`,
  `CONCURRENT_CHANGE` (run again). `STRIPE_READ_FAILED` / `STRIPE_UNAVAILABLE`
  are errors; nothing is written either.
- A customer with no Stripe subscription (Lifetime, one-time, complimentary)
  is `NO_SUBSCRIPTION`, skipped.

`scripts/reconcile-bootstrap-only.mjs` drives that route for a list. It never
opens the data directory and never talks to Stripe itself (the running Hub
owns both), reads the admin token from `HUB_ADMIN_TOKEN` or
`/etc/wickhunter-hub/env` and never prints it. Excluded ids are dropped before
any request, so they are never read from Stripe.

## 2. Before you start

```sh
cd /path/to/the/0.4.94/checkout                       # the scripts below
ENV=/etc/wickhunter-hub/env; TOKEN=$(sed -n 's/^HUB_ADMIN_TOKEN=//p' $ENV); H=http://127.0.0.1:8091
curl -sS $H/api/health | jq '{version, packageVersion}'          # must be 0.4.94
HUB_DATA_DIR=/opt/wickhunter-hub/data scripts/backup-data.sh /opt/wickhunter-hub/data /root/hub-backups   # a backup before any apply
```

Then a fresh, read-only audit as the input list:

```sh
AUDIT=/root/audit-$(date -u +%Y%m%dT%H%M%SZ).json
HUB_DATA_DIR=/opt/wickhunter-hub/data node scripts/audit-ignored-initial-invoices.mjs --json > $AUDIT
jq '.summary.bootstrapOnlyCustomers, [.bootstrapOnly[].customerKey]' $AUDIT   # expect the 18 of section 6
```

## 3. Dry run (writes nothing)

```sh
EXCLUDE=cus_VNlxMsY7Mjeib2,cus_VNmdL008FnqQBT,cus_VObt4QGUGeZwdE,cus_VNsRukjKTkFdAb
node scripts/reconcile-bootstrap-only.mjs --from-audit=$AUDIT --exclude=$EXCLUDE
node scripts/reconcile-bootstrap-only.mjs --from-audit=$AUDIT --exclude=$EXCLUDE --json > /root/reconcile-dry-$(date -u +%Y%m%dT%H%M%SZ).json
```

One customer only:

```sh
curl -sS -H "x-hub-admin: $TOKEN" -H 'content-type: application/json' \
  -d '{"customerId":"cus_…"}' $H/admin/api/billing/reconcile-subscription | jq
```

Each line reads: customer, subscription → verdict | Stripe status,
`current_period_end`; paid invoice id, `billing_reason`, `amount_paid` (minor
units) and currency, period start → end | `periodEnd`, `paidThrough`
(period end + graceDays), `firstActualPayment`, `exp` as before → after or
`unchanged` | note. A summary follows, with every "needs operator review" row
and its reason.

**Expected for the 18 (section 6):**

- Each of the nine hosted: `WOULD_APPLY`; Stripe `active`, `current_period_end`
  = the paid invoice's period end (Nov 6–8); `subscription_create`;
  `amount_paid` = what the customer was charged at checkout (software after
  discount + VPS, e.g. `7940 usd`); `periodEnd null→<period end>`;
  `paidThrough null→<period end + 3 d>`; `firstActualPayment` either
  unchanged or a second or two earlier (Stripe's `paid_at` precedes the
  checkout event); **`exp <period end + 3 d> unchanged`** (the 2026-10-09
  hand repair). `paidThrough` after must equal `exp`.
- Each of the nine launch-cohort: `NEEDS OPERATOR REVIEW (NO_PAID_INVOICE_YET)`
  — "no paid invoice yet … current period ends 2026-10-15T04:00:00.000Z";
  nothing will be applied. This is the correct state until the first charge.
- Summary: `would apply 9; nothing to apply 0; needs operator review 9;
  excluded 0; skipped (no subscription) 0; errors 0` (the four excluded
  customers are not in the audit's bootstrap-only list; `excluded` counts
  only listed ones).

**Stop** and do not apply if any hosted line shows a refusal, an `exp` that
would move earlier (impossible by construction — report it), an
`amount_paid` that is not the checkout charge, a period end that differs
from `current_period_end`, or a Stripe status other than `active`.

## 4. Apply

```sh
node scripts/reconcile-bootstrap-only.mjs --from-audit=$AUDIT --exclude=$EXCLUDE \
  --apply --by=<initials> --reason="2026-10-06..08 initial invoices discarded by 0.4.90; record the Stripe paid term"
```

Expected: `applied 9`, the same nine launch-cohort review rows, `errors 0`.
Rows already applied by an earlier run answer `NOTHING_TO_APPLY`.

## 5. Verify after

```sh
node scripts/reconcile-bootstrap-only.mjs --from-audit=$AUDIT --exclude=$EXCLUDE        # hosted rows: NOTHING_TO_APPLY
curl -sS -H "x-hub-admin: $TOKEN" $H/admin/api/billing/customers | jq '.customers[] | select(.customerId=="cus_…") | {periodEndMs, subscriptionStatus, lastEventType, exp}'
curl -sS -H "x-hub-admin: $TOKEN" "$H/admin/api/billing/events?limit=200" | jq '.events[] | select(.type=="admin.billing.reconcile-subscription") | .note | fromjson | {customerKey, by, reason, before, after}'
HUB_DATA_DIR=/opt/wickhunter-hub/data node scripts/audit-ignored-initial-invoices.mjs   # section C: only the nine launch-cohort rows remain
```

For each hosted customer: `periodEndMs` = Stripe period end;
`subscriptionStatus` `active`; `lastEventType`
`admin.billing.reconcile-subscription`; `exp` exactly what it was before
(period end + 3 d); one audit row with your `by`/`reason`. The hosting
instance and the hosting role record are unchanged: their paid-through stays
empty until the next renewal's `invoice.paid` fills it (a renewal is newer
than the bundle watermark and applies normally). Customers need nothing:
the app's next check-in carries the subscription card's period end; the
licence did not change.

**Launch cohort after the first charge (2026-10-15T04:00Z + ~1 h):** their
first `invoice.paid` applies through the ordinary webhook (software-only
subscriptions have no ordering guard). Re-run the dry run then: expected
`NOTHING_TO_APPLY` for all nine. A row still `WOULD_APPLY` after that means
its webhook did not apply — check the events list, then apply that one with
the single-customer call (`"dryRun": false, "by": …, "reason": …`).

**Charged correctly:** the tool changes no money and no Stripe object. The
hosted nine renew on Stripe's schedule at their checkout price; the launch
cohort is first charged by Stripe on 10-15. Each line puts the amount paid
next to the entitlement so the two can be read side by side.

**Rollback:** an apply only moves `periodEndMs` / first payment forward and
stamps the record; each audit row holds the exact before/after. Never edit
the data files while the service runs, and never shorten a licence.

## 6. The lists (from the operator's 2026-10-10 cross-check of 48 live customers)

**Included — the audit's 18 bootstrap-only rows:**

- Hosted, initial invoice discarded, `exp` already = Stripe period end + 3 d
  (expect `WOULD_APPLY`, exp unchanged): cus_VOUNoanlbQzNlh,
  cus_VOUq2Ntg3o1F7j, cus_VOf4aHnGcVm66m, cus_VOgCadpgeByu6N,
  cus_VOhOr4XrKknQke, cus_VOjYALq7tFwLAr, cus_VOqvUG6P6zh0Gl,
  cus_VP3frXNwPHcLIk, cus_VP6bIVH2iJmFsU.
- Launch cohort, scheduled start, Stripe active to 2026-10-15T04:00Z, `exp`
  2026-10-18T04:00Z, no VPS, no paid invoice yet (expect
  `NO_PAID_INVOICE_YET`, nothing applied): cus_VNvyPLF7MzjcXF,
  cus_VNxa0vB8mliKZi, cus_VNzTaPB0Y2clOP, cus_VO2AC4tfaC3J8M,
  cus_VO7BjzMzp4Mn2b, cus_VOIO0dAvvE34Wc, cus_VONgrHYyVRATwQ,
  cus_VOhQoMHs7R7YkU (yearly), cus_VOmVRoOeU6UE6m.

**Excluded (`--exclude`) — nothing to apply, never sent:**

- cus_VNlxMsY7Mjeib2, cus_VNmdL008FnqQBT, cus_VObt4QGUGeZwdE — Stripe
  canceled before their first charge; `exp` = the grace and they lapse
  correctly on 10-18. If sent anyway, the tool refuses them as
  `SUBSCRIPTION_NOT_ACTIVE`.
- cus_VNsRukjKTkFdAb — the customer's own portal cancellation; `periodEndMs`
  already applied, VPS `cancel_scheduled`. Must not be resumed or
  reconciled; if sent anyway the answer is `NOTHING_TO_APPLY` and nothing
  changes (the tool never touches a cancellation).

**Not excluded any more:** cus_VOBbKE0iQyHu6r. The operator reversed the
Hub-originated cancellation at 2026-10-10T04:28:49Z (0.4.93 admin
resume-renewal; stage `ready`, licence `exp` 2026-11-09T03:39:55Z, period end
2026-11-06T03:39:55Z). His paid term is already recorded, so a reconcile
answers `NOTHING_TO_APPLY`; he is not on the bootstrap-only list. In the
audit's section B his `software-ineligible` job (still `sent`) now reads
`REVERSED` with the instance's current stage.

Other cross-check facts: no `past_due` subscription; no customer with two
active subscriptions; no Hub period end disagreeing with Stripe; no licence
longer than period end + grace on an active subscription; 12 live customers
have no Stripe subscription (Lifetime/complimentary) — with `--all` they
appear as `NO_SUBSCRIPTION`, skipped.

## 7. Not verified offline

The tests use offline fixtures shaped like Stripe API version
2025-03-31.basil (the version the Hub's client sends): subscription period
end on the items, the invoice's subscription under
`parent.subscription_details`, line prices under `pricing.price_details`,
discounts as `pretax_credit_amounts`. The live account's exact invoice and
list shapes (for example whether `lines` arrives complete inside an invoice
list) were not read. If a live shape differs, the tool fails closed
(`IDENTITY_MISMATCH`, `INVOICE_LINES_INCOMPLETE`, `PERIOD_MISMATCH` or
`NO_PAID_INVOICE_YET`) and writes nothing; the dry run shows that before
any apply.
