# Launch preparation — September 30, 2026

Deployment scope: **Alpha application, Hub, Stripe configuration, and website only.**
Beta and Production publication, promotion, and deployment are prohibited by the current user instruction. Prepare release controls with automation disabled.

This is a working checklist, not a claim that the launch is complete. No campaign emails or live test charges are authorized.

| Work | Current state | Remaining verification |
| --- | --- | --- |
| Website inline support | Published | Verified live at 390/1440px, close/Escape and inline frame; blank-frame loading flash fixed in website b1c03d2 |
| Bitunix referral URL | Website published; maintained app/Hub links reviewed | Maintained Hub Earn and website registration links use exact requested URL; app exchange links are API/documentation endpoints, unchanged. |
| 25% recurring launch discount | Local Hub implementation and regression coverage | UNLEASHED25 created in test and live. All five Checkout types accepted in both modes, required Terms consent verified, then expired without charge or customer/subscription creation. |
| Free card access until Oct 15, 2026, midnight Eastern | Local fixed-anchor checkout | Stripe test-mode lifecycle, near-deadline behavior, website disclosure |
| First-charge reminder | Durable local worker; regression tests passing | Integrated worker/tests and Hub health display pass. Resend API confirms sender domain wickhunterunleashed.com verified with sending enabled; no test email sent. |
| Crypto Yearly/Lifetime | Local one-time checkout | Test async payment/refund behavior and live capability/session creation |
| Crypto Yearly paid before launch | Access through Oct 15, 2027 implemented locally | Verify entitlement from settled payment only |
| App subscription and Earn screens | Local implementation; focused tests passing | Mobile light/desktop dark review passed with all five correct card/crypto amounts; final full gate and deployment pending |
| Subscription reporting and Discord notifications | Local implementation | Retry/idempotency/discount regressions and browser review pass. Central webhook is not configured; do not reuse trading webhooks. |
| Support ticket notifications | Local persisted handoff | Restart/failure regression and configured central webhook |
| Brevo connection/import safeguards | Local module; no key configured | Hub controls; account connection; preserve unsubscribes on real test contact |
| Launch email with A/B variants | Local draft | Rendered at 390/900px; offer links and Brevo unsubscribe merge field checked. Real Brevo account setup deferred by user until tomorrow. |
| Legal terms/privacy/refunds | Published website d035d72; Draft removed | All three live policies verified: no Draft labels, correct entity/address and approved policy. Website 17/17 tests pass. |
| Lifetime access | Automatic technical token renewal implemented locally | Paid legacy entitlement reconciliation; customer wording and tests |
| Smarter Support | DCA/common bot explanations fixed locally | DCA/common-bot regression passes; deployment now explicitly includes public/support-knowledge.json. Final runtime verification pending. |
| Hub simplification | Integrated revenue, notifications, Brevo and release overview | Mobile/desktop/light/dark browser review passed; final integrated release gate/deployment pending. |
| Release channels and rollback controls | Policy implemented; publisher crash-recovery review in progress | Enforced channel routing, seven-day gates, compatible rollback; no publication |
| Full release gates | Hub interim 86-suite gate passed; final exact-source gates running | Final source must be committed, built, captured, and tested before packaging; interim results are not deployment proof. |

Business decisions: refund requests within seven days of the first actual software payment, including Lifetime; renewals generally nonrefundable except mandatory rights. Lifetime means life-of-product access, with automatic renewal of technical tokens. Wick Hunter Software, LLC is a Delaware LLC at 131 Continental Dr Suite 305, Newark, DE 19713 US.

External setup still needed: a Brevo API key/list IDs and the intended central Hub Discord webhook if not already stored. Do not substitute account trading webhooks.

The older trading audit remains separate. Its closure review records twelve evidence-dependent findings: BIN-2, BTX-1, BTX-5, BTX-7, ORD-17, UTA-24, UTA-43, UTA-84, WXL-4, WXO-1, WXO-7, WXSP-6. Launch UI/billing work does not close them.

Verified operational state: Hub 0.4.64 and Alpha 0.90.149 remain deployed until final candidate gates pass. Stripe portal policy URLs and webhook dispute-closure/invoice-success events updated in both modes; unrelated portal features preserved. Fresh test and live card Monthly/Yearly/Lifetime plus Crypto Yearly/Lifetime Checkout probes all passed and were expired without charges. Beta remains 0.90.135, artifact SHA-256 `6c649a93a5371af3ae658512b9947cccd62442666c20d50c7dc1c88e40eb4b1e`.

Release preparation includes explicit channel preferences, separately verified shelves, fresh-host channel installation and signed seven-day promotion gates. Channel routing and all publishing remain off. No scheduler is activated. First Production publication must have an explicitly reviewed baseline and compatible rollback evidence before automatic promotion can be enabled.

Final review corrected browser customer links to the canonical HTTPS Hub domain and added same-origin protection for cookie-authenticated customer writes. Hub deployment includes only the deliberate HUB_PUBLIC_ORIGIN correction; legacy API/webhook proxy paths remain available. The deployment seal protects the full Beta/Production release shelf and all unrelated environment settings.
