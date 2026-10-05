# Oskaras private Earn offers

Status: prepared, inactive until a verified Oskaras email matches an existing
Earn member and an operator explicitly confirms Stripe setup.

| Code | Discount | Duration | Scope |
| --- | ---: | --- | --- |
| `OskarasTrading10K7` | 10% | Forever | Recurring USD software plans |
| `OskarasTrading20M4` | 20% | Forever | Recurring USD software plans |
| `OskarasTrading25R8` | 25% | Forever | Recurring USD software plans |

The codes are reusable and have no default expiry or redemption cap. Checkout
accepts a single promotion, so codes do not stack. Their referral commissions
use the existing Earn member tiers. The partner email is not yet known; do not
create a placeholder owner, bind an existing account by guess, or issue a
payout recipient.

After the partner supplies and confirms the account email, the operator must
first verify that it resolves to the intended existing Earn member. Build the
Hub, then run `node scripts/register-oskaras-promotions.mjs` in an interactive
terminal with the intended Hub data directory and Stripe mode configured. Review the displayed
member and mode before entering the exact confirmation phrase. The tool refuses
unknown emails and never creates or binds an Earn account. It verifies reusable
Stripe promotions and forever coupons before persisting them in the member's
Stripe profile. Re-running it is idempotent; a conflicting existing code stops
the setup for manual review.

Do not run this setup until the verified account email has been provided and
the operator has reviewed the selected member and Stripe mode.
