# Existing Oskaras offers and dashboard access

This candidate is based on the deployed Hub `30fad51830e81438ae288d03e2000f3b023de435`. It has not been deployed and has not changed LIVE Stripe or Hub data.

The reviewed email is `oskarasridikas@gmail.com`. The existing LIVE codes are `OskarasTrading10K7` (10%), `OskarasTrading20M4` (20%), and `OskarasTrading25R8` (25%). Their exact existing promotion and coupon IDs are in `src/earn-oskaras-offers.ts`. An expanded provider GET proved the exact existing product scope is `["prod_VGI40Usk9WlTQU"]`. The earlier null projection did not expand that field and was not proof of global scope. Adoption pins the actual product scope and preserves the terms.

## Identity and visibility

The email's billing license and the license installed at `45.76.111.22` are different. Ordinary `bindOwner` initializes the email's genuine member. A separate audited viewing grant associates the exact reviewed dashboard license with that member. It never merges the dashboard's billing or Stripe identity into the member's owner bindings, transfers a license, or creates a payout recipient.

Both licenses require their own Earn feature flag. The delegated license may GET the dashboard; every POST is refused. Saved payout destinations, UIDs, and payout-job details are omitted from that view. The canonical owner continues to use ordinary authenticated Hub customer sign-in.

The updated Hub `/earn` displays the three offers and paginated owner-filtered referral statuses. Labels are opaque; there is no cross-customer email dump. Subscription status is not a claim that an invoice was paid or commission earned. Reconciliation records its observation time and marks old snapshots stale. Incomplete scans preserve the prior complete snapshot. Existing subscription webhooks update already recorded status rows; discovering older or newly attributed subscriptions requires the explicit status reconciliation operation.

The signed customer177 asset remains untouched. Its existing Earn UI can regain aggregate access through the grant and flag, but it cannot render the new detailed fields. Use the normal authenticated Hub `/earn` for the detailed view until the matching asset is included in a separately qualified customer release. Do not patch an installed signed asset.

## Reviewed operator operation

After normal reviewed Hub deployment, run in its existing runtime environment:

```sh
node scripts/adopt-oskaras-existing-promotions.mjs --execute-reviewed-live
```

The tool uses the existing admin boundary on loopback, without printing credentials. The exact email/license hashes are checked in the server. All six existing provider objects are read before any local or provider write. Only `wh_earn_owner` and `wh_earn_code` metadata are added. `managed_by`, scope, discount percentage, duration, activation, expiry, restrictions, subscriptions and payouts are unchanged. The old `register-oskaras-promotions.mjs` creation workflow is not used.

A provider failure can leave a partially completed metadata operation. Preserve that evidence; do not describe it as rollback or automatically retry an uncertain timeout. Exact same-owner metadata is safely resumable, while another owner or changed terms cause refusal. Profile registration follows successful readback of every object. Status reconciliation is a separate request, and never replays invoices or commissions.

Before execution, independently recheck the exact provider field shape, particularly expanded `applies_to`. This verifier requires exactly the observed product list; omitted/unexpanded or changed scope fails closed. Archive the relevant before images through the approved operational workflow. No financial files, customer keys, encrypted credentials or installed customer source are changed by this command.

Normal software-price, mixed-VPS, self-referral, charge, refund, dispute and stacked-discount accounting protections remain in force. Legacy metadata ownership does not bypass the existing software/VPS attribution checks.

### Purchase-status completeness

A status refresh scans all bounded subscription pages and completed Checkout pages before publishing either result. One-time and Lifetime rows require an actual paid Checkout, the exact applied owner promotion/coupon, configured one-time software price and permitted product, and a matching settled PaymentIntent/charge. Mixed Lifetime+VPS purchases additionally prove the initial paid invoice and its payment; recurring VPS renewal is not a Lifetime purchase. Status labels are purchase facts (paid, partially refunded, refunded, disputed), not subscription state or an access entitlement. A partial mixed software/VPS refund is explicitly refund_allocation_unknown because the charge cannot prove which component was refunded. Guest checkout uses a session-derived opaque label. Incomplete/ambiguous payment, item or pagination data retains the previous complete snapshot; no financial ledger, payout or commission replay occurs.

This is an explicitly reconciled as-of view, not a realtime census: subscription events update existing rows, while newly discovered and one-time status changes appear on the next authorized status refresh. Finite limits refuse incomplete scans rather than claiming all rows.

A delegated dashboard response omits the nested test-mode ledger view entirely, as well as redacting live payout/UID fields; test mode never expands viewing permissions. Mixed purchases require the initial invoice total and currency to match Checkout and a single exact InvoicePayment allocation equal to that total. A larger successful PaymentIntent shared by other invoices is insufficient. Missing, partial, excessive or foreign allocation retains the previous snapshot.
