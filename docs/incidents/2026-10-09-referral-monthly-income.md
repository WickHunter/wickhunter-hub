# Recurring referral forecast

The Earn API and page expose expected monthly referral income separately from booked earnings. The estimate applies the member's effective commission rate, including overrides, to known recurring software MRR after discounts. Billing reporting already excludes hosting fees and normalizes annual recurring prices to months.

The join is restricted to the authenticated owner's full referral-status scope, independently of display pagination, using the existing opaque subscription hash. Exact known software customers must match each fact. Refunded/disputed customers, inactive or cancelling subscriptions and future-start subscriptions do not contribute to the current estimate. Lifetime and other one-time purchases are excluded. Unknown amounts and stale/ambiguous facts remain visibly incomplete rather than being guessed. Currencies are never summed together. Status scope expires after 24 hours; pricing facts after 15 minutes. No provider mutation, commission booking or payout action occurs during projection.

Custom commission overrides display their own active-rate message instead of incorrectly promising a lower next tier. The same HTML must be included in a newly qualified signed App package before customer App installations display it; changing Hub HTML alone does not change signed installed assets.
