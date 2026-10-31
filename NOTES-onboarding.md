# Onboarding UX — working notes (branch `claude/hub-onboarding-ux`)

Base: `claude/hub-bitunix-ws-fold` (Hub 0.4.102). No version bump; no `src/candles/*` changes.

## Done (commit 4ab3c94)
1. Hosted welcome email for hosted buyers (`hostedWelcomeEmail`); self-hosted email unchanged. `CustomerRecord.welcomeKind`.
2. Hosted temp-password reset: customer route `POST /api/hosting/:id/reset-password` (3/day, one pending), admin `POST /admin/api/hosting/instances/:id/reset-password`; management agent polls `…/instances/:id/credential-reset`, derives password locally, seeds via app bootstrap contract, confirms on `…/credential-reset/confirm`; email only after confirmation; nonce erased after send. Admin list masks token hashes + nonce.
3. Install commands keep the Hub's reason (`safeInstallCommand` everywhere, `Wick Hunter: …` one-line refusals, `install.sh` `hub_reason`).
4. Post-checkout panel on `/customer` + `GET /api/checkout/summary`; Stripe success URLs carry `session_id`.
5. Customer-safe failure messages + `WH-XXXXXXXX` support references (`src/hosting/customer-messages.ts`); raw reason stays in admin/logs.
- Hosting emails moved to the shared mobile layout; README changelog entry.
- Tests: `tests/onboarding-ux.test.mjs` (17), `tests/onboarding-pages.test.mjs` (8). Full suite 125/127; the 2 failures (`hosting-bootstrap` node-on-PATH, `liq-percentiles` missing liqhunter-private) are environmental and fail on the base branch too.

## Next / needs operator decision
- Verify against the real customer app that a missing `app-credential.json` + `LIQHUNTER_BOOTSTRAP_PASSWORD` re-seeds a forced-change credential, and whether old dashboard sessions survive a reset.
- Existing VPSs have the old agent (no reset support) — decide on re-provision or an ops update; security sign-off on the agent's new restart/credential capability.
- Confirm limits: 2 h reset TTL, 3 customer resets/day, 24 h agent-freshness window.
- Confirm the public `/api/checkout/summary` (masked email, plan, server stage) is acceptable.
- v1 bundle checkout returns to the marketing site's `/thanks/` (not in this repo) — unchanged.
