# Initial subscription term after checkout

A hosted subscription checkout can be timestamped later than its initial paid invoice, even when the checkout webhook is delivered first. Checkout establishes a three-day bootstrap license and advances the bundle lifecycle watermark. The older initial invoice was then discarded by the stale-event guard, leaving the paid-through date unset.

The correction admits an older `subscription_create` paid invoice only when both existing software and hosting records are active, checkout-only, have no paid-through date, and have no refund/dispute or pending-failure state. The terminal and durable identity fences remain in force. The lifecycle watermark never moves backwards. Old renewals and duplicate initial invoice aliases remain inert after the term is established.

A separate live remediation used the existing authenticated license-expiry endpoint for nine affected licenses. Each target was bound to its exact known customer/subscription, a fresh active Stripe reporting fact, the original license expiry, and the configured three-day grace policy. No provider subscription, payment, discount, payout, or renewal date was changed. The post-repair audit at 2026-10-09 15:59:27 UTC found no short licenses among 31 eligible active subscriptions, across 34 known live subscriptions; none had an unknown reporting period.

The remediation changes license expiry only. It does not rewrite billing event history or populate missing billing paid-through fields. Source qualification and deployment of this preventive correction are separate from that completed license repair. Customer-specific identifiers and raw operational receipts are retained locally and are intentionally excluded from this public repository.

An exact-event digest and the checkout watermark are persisted before the admitted initial invoice changes either role. Both role records also retain the last event ID. A retry after restart may finish only the same admitted event while both roles still reflect checkout or that exact invoice and no newer failure, terminal, refund or dispute fence intervenes. Completion removes the pending admission only after both role writes and the hosting hook return. Tests inject hosting write, hosting hook and completion-record failures and reconstruct the service against its durable files before retrying.

Qualification and deployment remain separate steps.
