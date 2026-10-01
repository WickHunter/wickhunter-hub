# Launch verification — October 1, 2026

Scope: **Alpha, Hub, Stripe configuration, and website only.** Beta and Production remain untouched. This is a record of verified work and outstanding dependencies, not a declaration that every historical trading finding is fixed.

| Area | Verified result | Remaining boundary |
| --- | --- | --- |
| Hub | 0.4.70, runtime commit `199a51150c35b28dcd8f6529cbc5b7a459969e6d`; 86 suites passed. Deployed runtime matches the sealed manifest. Candle samples advanced after restart. | Central Discord webhook and Brevo credentials are not configured. |
| Alpha | 0.90.152, commit `43d2b88997e71f9cfe678d832563d84be6ad79e7`; 74,881 checks passed, zero failures. All four contexts ready; native lease pair and Marketplace API/worker/storage verified. | Controlled API restart passed with paused WebSocket and incomplete ingress; accepted work drains before store cleanup. |
| Website | Commit `8a64886` is live; 20 tests pass. Mobile 390px and desktop 1440px reviews verified actual Hub pricing, inline support, and intercepted checkout requests. | Browser checkout POSTs were intercepted; the separate Stripe probes exercised the real backend. |
| Launch discount | `UNLEASHED25`: 25% off base software through October 15, 2026, 11:59 p.m. Eastern; ongoing discount on eligible recurring subscriptions. | Hosting and add-ons are excluded. |
| Card subscriptions | Card required; prelaunch Monthly/Yearly signup costs $0 now, first discounted charge October 15 at midnight Eastern, no proration. Signups on October 15 are charged immediately. | No live customer was charged as a test. |
| Crypto | Yearly/Lifetime are immediate, one-time, nonrenewing purchases. Prelaunch Yearly access runs through October 15, 2027. | Settlement, delayed payments, disputes, refunds, and renewal behavior have fixture coverage; no real live crypto payment was submitted. |
| Stripe | All five real live Checkout types accepted correct amounts, policy consent, payment method, dates, and return URLs; sessions expired unpaid. Same five types also passed in test mode. Portal policy URLs and webhook invoice-success/dispute-closure events are configured. Both canonical and retained IP webhook origins have valid TLS and reject unsigned requests. | Checkout creation is not a completed-payment test. |
| Hosting | Selecting VPS now preserves the launch software discount and sends the buyer through software checkout first. Dashboard hosting is separately billed and shown only when available. | No paid VPS was provisioned as a test. |
| Reminders | Durable first-charge reminder worker, retries, idempotency, and health display verified. Resend sender domain is verified with sending enabled. | No actual customer reminder email was sent as a test. |
| App billing and Earn | Subscription management, card/crypto amounts and dates, customer portal, and in-app Earn views deployed. Browser customer links use the canonical Hub domain. | Authenticated Alpha UI exercised with protected-API fixtures; no live customer login was bypassed. |
| Reporting and notifications | Software subscription counts, scheduled/active MRR, discounts, signup/renewal/failure events, and support-ticket events are implemented. Annual fractional-cent MRR renders correctly (discounted Yearly ≈ $43.69/month). | Software reports exclude separately billed VPS subscriptions. Central Discord delivery awaits its intended webhook. |
| Brevo and email | Scoped import/deduplication, explicit consent provenance, global/list opt-out preservation, and authenticated unsubscribe webhook are implemented. A/B email draft rendered at 390/900px with offer links and Brevo unsubscribe field checked. | User deferred Brevo API key/list setup until tomorrow. Real connection and test-contact opt-out verification remain. No campaign sent. |
| Policies | Terms, Privacy, and Refund pages are published; Draft labels removed. Seven-day refund requests from first actual payment, including Lifetime; mandatory rights retained. | Published terms reflect the user's approved business decisions. |
| Lifetime and licenses | Life-of-product access with automatic technical-token renewal. Focused legacy migration coverage passes. All 39 non-revoked licenses already run through October 15 or later; no further extension was needed. | Retained Hub data contains no live paid Lifetime billing fixture; do not infer historical Stripe charges outside that dataset. |
| Support | Inline website chat and smarter DCA/common-bot knowledge are deployed, including the verified knowledge JSON. Mobile layout and compact feedback covered. | Central ticket notification delivery awaits the intended Discord webhook. |
| Release controls | Private Alpha, explicit opt-in Beta/Early Access, and default Production for verified fresh installs are implemented. Same signed Beta archive must pass seven days, unresolved-bug checks, fresh tests/health, compatible rollback evidence, and hold checks. | Routing and publishing disabled. No automatic Production runner installed or enabled; first Production rollback baseline and later authorization are still required. |

Approved company: Wick Hunter Software, LLC, a Delaware LLC, 131 Continental Dr Suite 305, Newark, DE 19713 US.

## Deployment evidence

Hub receipt: `/root/wh-hub0470-launch-reviewed-20261001/receipt.json`.
Alpha receipt: `/root/wh-alpha0152-launch-20261001/receipt.json`.
Full local evidence: `/Users/zloren/Documents/Wick Hunter Launch 2026/verification/`.

Alpha 0.90.152, commit 43d2b88997e71f9cfe678d832563d84be6ad79e7, is deployed after 74,881 checks passed with zero failures. The final build, source tree, and all 1,207 runtime artifacts were captured before the full gate and verified during deployment. All four trading contexts, the native lease pair, and Marketplace API/worker/storage are ready.

The follow-up fixes incomplete HTTP ingress and unsupported upgrades, tracks accepted HTTP/dispatch/WebSocket replay and grant work until it settles, and adds PostgreSQL client/idle-pool error listeners. Independent review found and corrected both HTTP pipelining and WebSocket work-drain gaps before the final gate. No main trading drain, order behavior, or service stop deadline was changed.

A live API-only restart passed with a paused unauthenticated WebSocket, unsupported upgrade, incomplete body, and incomplete headers. The stop/start transition took 2,321 ms, the journal recorded a clean stop and no forced kill, and the main trading and Hub PIDs stayed unchanged. PostgreSQL error handling was verified by focused regressions; the database was not deliberately restarted as a test. The earlier failed restart on 0.90.151 and the external host-maintenance/database-restart observations remain preserved. The exact connection responsible for the original timeout has not been identified.

Deployment receipts, exact test proofs, protected release hashes, restart receipt, and final health report are in the local verification folder listed above. Earlier failed/superseded checks are retained and are not counted as passes. The final gate used a 4 GiB local test-runner heap after the default 2 GiB run exhausted memory; production memory settings were not changed.

Hub source-based Upgrade is unavailable on this manually deployed host because its configured source checkout is absent. Reviewed package deployment, code backups, and rollback receipts are available.

The complete release shelf stayed unchanged, including Beta 0.90.135 (artifact SHA-256 `6c649a93a5371af3ae658512b9947cccd62442666c20d50c7dc1c88e40eb4b1e`). No Production artifact exists. No automatic publishing scheduler was activated.

## Separate historical trading audit

The September 30 closure review retains twelve open findings: **BIN-2, BTX-1, BTX-5, BTX-7, ORD-17, UTA-24, UTA-43, UTA-84, WXL-4, WXO-1, WXO-7, WXSP-6**. Ten require additional exchange evidence or a proven safe design; two remain unconfirmed. Launch billing/website work does not close them. See the Alpha repository's `docs/audit-2026-09-24/completion/CLOSURE-REVIEW-20260930.md` for exact closure requirements.
