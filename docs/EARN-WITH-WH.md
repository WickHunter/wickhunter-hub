# Earn with WH — private Alpha / Hub preview

Hub 0.4.42; Alpha app 0.90.124. No public Beta release. Hub data is stored in
`data/earn.v1.json` using atomic, owner-preserving writes. Back up this file with
normal Hub data. Dollar amounts are integer USD cents. Never edit the ledger
in place: use an adjustment or reversal.

## Implemented

- Shared Hub customer page and authenticated Alpha app view; app stores no earnings.
- Per-license `earn: true` admission on Hub. Off by default. Customer-session access
  requires a live billing customer with an enabled license. Admin uses existing bearer.
- App route returns 404 in USER_BUILD, and customer builds strip its nav/view/init.
- WH standard tiers: 0–20 active subscriptions 20%; 21–40 30%; 41+ 40%.
- Default friend discount 10%; admin commission/discount/rebate overrides.
- Bybit, Bitget, Bitunix, WEEX links. No Aster.
- One main UID per exchange per member, unique across members for that exchange.
  User declaration does not verify main status: admin must check ownership, main-account
  status and referral attribution against the exchange's evidence before verification.
- Exchange rebates: default 50% of commission WH actually received. One complete monthly
  CSV aggregates across registered exchanges per member. Monthly rebate >= $15 qualifies;
  smaller totals remain visible on the statement but are not credited or carried forward.
- Strict CSV header `exchange,uid,commission_usd`; lowercase venue IDs, decimal USD.
  A preview digest ties commit to reviewed inputs and rate snapshots. One finalized
  import per completed UTC month; duplicate imports never double-credit.
- Admin confirmed earnings and signed adjustments by program; manual payouts with
  actual date, method and unique reference. Payouts cannot exceed that program balance.
- Original ledger entries persist after reversals. Rate/UID verification changes audited.
- Marketplace settlement and payout history can be recorded manually, separately from
  exchange rebates. No estimated profits and no claims based on trading PNL.

## Not activated / outstanding before earning-program launch

The UI is intentionally truthful about these boundaries. A generated member code is
reserved locally, but referral checkout is NOT activated, so the share-link control
is disabled outside the clearly labeled design preview. Stripe coupon/promotion-code
provisioning, referral attribution, paid-subscription counting, recurring commissions,
refund/dispute adjustments, automatic marketplace settlement imports, recipient onboarding
and automatic payouts still need their integrations and end-to-end verification.
No Stripe object, payment or recipient is created by this preview. Cash earnings and
subscription credits must stay separate; conversion to invoice credit is not implemented.
Do not invite public customers to earn yet. Confirm discount/commission duration and
Stripe acceptance of exchange referral rebates before enabling live payouts.

Beta stays at 0.90.123. The preview uses sample data only on localhost and is not
included in deployment archives. Public pages/API disclose no private member data
without the corresponding account/license permission.

## Private deployment verified

Deployed only to `45.76.105.174`: Alpha 0.90.124 and Hub 0.4.42. Both health
checks passed. Only the installed Alpha license has `earn: true`; default remains
off. Anonymous earnings and admin requests return 401. Public Beta 0.90.123
manifest is byte-for-byte unchanged; Alpha Go binary and environment unchanged.
Rollback files and receipt: `/root/wh-earn-preview-20260916` on that VPS.
Browser session expired on restart; signed-in live UI review remains for the user.
Local mock UI was browser-checked; Hub full suite and app auth/navigation/build
checks passed. No Stripe objects, automatic commissions or payouts were activated.

## Stripe integration under private verification (September 16–17)

The sections above describe the deployed 0.4.42 preview. The working branch now
adds recurring, product-scoped friend discounts; Stripe-hosted referral Checkout;
charge-backed invoice commissions; subscription counts; refund/dispute adjustments;
recipient onboarding; and monthly Global Payouts dispatch/reconciliation. These
changes have not yet been deployed. Marketplace revenue imports remain manual.

The existing standard billing keys remain responsible for coupons, Checkout and
invoice verification. Live Global Payouts requires a separate restricted `rk_live_`
key, saved by an authenticated Hub administrator in Earn settings. Grant Recipient
Configuration Write, Financial Accounts Read, Payout Methods Write and Outbound
Payments Write, plus destination-specific permissions required by Stripe. The
payout key is stored in owner-only `earn-stripe-secrets.v1.json` and never returned
by admin or member APIs. Sandbox payouts can use the saved Sandbox test key.

Only new general Sandboxes support the tested recipient onboarding path. Legacy
Test mode rejects this flow even though its dashboard banner also says Sandbox.
Test invoices and payouts use an isolated ledger under `data/earn-test`. The real
Sandbox confirmed the coupon/Checkout flow: a $100 test invoice collected $90 and
credited $18 to the test referral ledger; the live ledger remained at zero. Test
subscription renewal was canceled at period end. Recipient account-link creation
also passed; Stripe returned `accounts.stripe.com`, which is explicitly allowed.

Automatic payouts default off. Submission reserves eligible prior-month earnings
with file and directory fsync before any request. Stable idempotency keys survive
process restarts; uncertain outcomes retain reservations and require review after
23 hours. Submitted jobs reconcile even when dispatch is paused. Confirmed failed
or returned transfers restore amounts owed. A failure in one month does not erase
the earnings; it is eligible for the next monthly cycle. Stripe-managed ledger
entries cannot be manually reversed. Pausing enrollment does not discard renewals,
refunds or disputes for already attributed subscriptions.

Live launch still requires a restricted payout key, funded financial account,
verified recipient, and configured signed webhooks including invoice paid,
subscription updates/deletion, refunds, dispute creation and dispute closure.
Country support and fees depend on Stripe's available capabilities. Passing a US
Sandbox test does not establish every international payout corridor.

Sandbox API verification now includes a successful $18 virtual payout with exactly-once ledger settlement and a $5 returned payout with full balance restoration. The new Sandbox financial account is open; no live payouts were made. Candidate versions: Hub 0.4.43 and Alpha 0.90.125.

Admin usability: mobile uses a section selector, fluid settings cards and stacked
Earn records at 640px and below. Billing/Earn were visually checked at 320px,
390px and desktop widths. API credentials require an explicit Edit key action;
locked autofill values are excluded from save payloads. Cancel retains existing
stored credentials, and explicit Clear remains supported. Login autofill stays
available for the separate admin sign-in form.
