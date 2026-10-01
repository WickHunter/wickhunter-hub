# Launch preparation — September 30, 2026

Deployment scope: **Alpha application, Hub, Stripe configuration, and website only.**
Beta and Production publication, promotion, and deployment are prohibited by the current user instruction. Prepare release controls with automation disabled.

This is a working checklist, not a claim that the launch is complete. No campaign emails or live test charges are authorized.

| Work | Current state | Remaining verification |
| --- | --- | --- |
| Website inline support | Published | Live desktop/mobile session and keyboard behavior |
| Bitunix referral URL | Website published; app/Hub review ongoing | Search all maintained surfaces for stale registration URLs |
| 25% recurring launch discount | Local Hub implementation and regression coverage | UNLEASHED25 created in test and live. Five test Checkout types accepted and expired without charge. Live Checkout awaits Dashboard Terms URL. |
| Free card access until Oct 15, 2026, midnight Eastern | Local fixed-anchor checkout | Stripe test-mode lifecycle, near-deadline behavior, website disclosure |
| First-charge reminder | Durable local worker; regression tests passing | Integrated event trigger, delivery readiness, Hub visibility |
| Crypto Yearly/Lifetime | Local one-time checkout | Test async payment/refund behavior and live capability/session creation |
| Crypto Yearly paid before launch | Access through Oct 15, 2027 implemented locally | Verify entitlement from settled payment only |
| App subscription and Earn screens | Local implementation; focused tests passing | Full Alpha build gate, UI review, deployment and runtime checks |
| Subscription reporting and Discord notifications | Local implementation | Review retry durability, current discounts, configured central webhook |
| Support ticket notifications | Local persisted handoff | Restart/failure regression and configured central webhook |
| Brevo connection/import safeguards | Local module; no key configured | Hub controls; account connection; preserve unsubscribes on real test contact |
| Launch email with A/B variants | Local draft | Render, verified offer links, unsubscribe merge field, Brevo setup |
| Legal terms/privacy/refunds | Published website d035d72; Draft removed | Live Terms verified with launch terms and legal address; website 16/16 tests passed. |
| Lifetime access | Automatic technical token renewal implemented locally | Paid legacy entitlement reconciliation; customer wording and tests |
| Smarter Support | DCA/common bot explanations fixed locally | Integrated source-backed chat regression and deployment |
| Hub simplification | Integrated revenue, notifications, Brevo and release overview | Mobile/desktop/light/dark review and integration |
| Release channels and rollback controls | Policy accepted; implementation in progress | Enforced channel routing, seven-day gates, compatible rollback; no publication |
| Full release gates | Focused tests only on current candidate | Complete Hub and Alpha suites against exact deployable artifacts |

Business decisions: refund requests within seven days of the first actual software payment, including Lifetime; renewals generally nonrefundable except mandatory rights. Lifetime means life-of-product access, with automatic renewal of technical tokens. Wick Hunter Software, LLC is a Delaware LLC at 131 Continental Dr Suite 305, Newark, DE 19713 US.

External setup still needed: a Brevo API key/list IDs and the intended central Hub Discord webhook if not already stored. Do not substitute account trading webhooks.

The older trading audit remains separate. Its closure review records twelve evidence-dependent findings: BIN-2, BTX-1, BTX-5, BTX-7, ORD-17, UTA-24, UTA-43, UTA-84, WXL-4, WXO-1, WXO-7, WXSP-6. Launch UI/billing work does not close them.

Verified operational state: Hub 0.4.64 and Alpha 0.90.149 remain deployed until final candidate gates pass. Stripe portal policy URLs and webhook dispute-closure/invoice-success events updated in both modes; unrelated portal features preserved. Beta remains 0.90.135, artifact SHA-256 `6c649a93a5371af3ae658512b9947cccd62442666c20d50c7dc1c88e40eb4b1e`.
