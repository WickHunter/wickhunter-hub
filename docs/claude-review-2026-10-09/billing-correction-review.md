# Independent review — hub PR #82 billing correction (0.4.91)

Reviewed: `git diff b24234c7..8ac142d3` (deployed 0.4.90 → PR head, package 0.4.91), read against the whole bundle lifecycle in `src/billing/service.ts` (`handleWebhook`, `applyEvent`, `splitBundleIdentity`, `bundleIdentity`, `applyBundleEvent`, `applyHostingEvent`, the software handlers, `touch`/`touchHosting`) and `src/billing/store.ts`. Reviewer worked in `/home/user/wickhunter-hub` on branch `claude/hub-billing-review`; nothing committed, nothing pushed, no fetch.

## Verdict: accept-with-fixes

The correction is sound. Every path a Stripe event can take through the changed admission (`service.ts:636-673`) was traced and probed against the built `dist`; no reachable defect was found in the diff itself. The two fixes applied in the working tree are (1) removal of the Earn/forecast residue sentence from the incident note and (2) fourteen regression tests covering the gaps in the diff's own coverage (refund/dispute fences, duplicate delivery, superseding renewal, repeated refusal with an alias in between, and every interruption point of the **mixed v2 checkout**, which the diff tested only for the legacy v1 bundle). No `src/billing/` change was needed; version stays 0.4.91.

Two limitations are recorded below (one pre-existing attribution gap outside the diff, one theoretical ordering) — neither is introduced by this change and neither was fixed here, for the reasons given.

## The residue hit

`git diff b24234c7..8ac142d3 | grep -ciE 'forecast|monthly.?income|referral'` → 1, at `docs/incidents/2026-10-09-initial-subscription-term.md:13`: *"The deferred referral-income display and App182 release are excluded from this billing-only change."* It names the skipped `62028139` feature in a public incident note about a billing-only fix. Removed; the sentence now reads *"Qualification and deployment remain separate steps."* The README `## v0.4.91` entry (`README.md:1-3`) is billing-only and unchanged. The working-tree diff now matches the pattern only on the removed `-` line.

## Findings (each traced on the code, confirmed by probe or test)

### F1 — Partial-write retry: closed (confirms the prior review's concern)
Path: `handleWebhook` marks an event seen only after `applyEvent` returns (`service.ts:421`), so a throw anywhere in `applyBundleEvent` leaves the event unseen and Stripe retries it. `initialPaidAfterCheckout` (`:645`) writes `initialPaidPending {eventSha256, checkoutWatermarkMs}` onto the bundle record (`:673`) **before** either role changes; `resumingInitialPaid` (`:660`) re-admits only the same bytes (`sha256(JSON.stringify(ev))` over the normalized `{id,type,livemode,createdMs,object}` that `parseStripeEvent` builds — `pending_webhooks`/`request` never enter it), only while the bundle watermark is the admission's checkout watermark, only while both roles are `active`, unrefunded, undisputed, and each role is either still checkout-only with no paid-through or already carries exactly `lastEventType === ev.type && lastEventId === ev.id`. Completion writes the explicitly-built `ledger` (`:685-698`) at `:766`, which carries no `initialPaidPending`, so the admission is retired by the same write that establishes the term. `extendLicense` only moves forward, `periodEndMs` only grows, `noteFirstActualPayment` takes the minimum — the re-run of `onInvoicePaid`/`applyHostingEvent` on a retry is idempotent. **Real and covered** (diff's restart loop; my repeated-refusal test adds a second refusal and the alias event).

### F2 — `lastEventId` atomicity: covered
`touch` (`:1581`) and `touchHosting` (`:920`) set `lastEventType`, `lastEventId`, `lastEventAtMs` on the same in-memory record that the single `putCustomer`/`putRoleSubscription` (`writeJsonAtomic`) persists. A crash between the pending write and a role write leaves checkout-only roles → re-admission through `initialPaidAfterCheckout` (rewrites the identical pending). A crash after a role write leaves `lastEventId === ev.id` → resumption. A crash after completion leaves no pending and the stale guard refuses the redelivery. There is no state that is neither resumable nor ignorable; a pending that never completes is inert (sha-bound to one event) and is dropped by the next applied bundle event. **No defect.**

### F3 — Duplicate delivery of the same event id: covered
Same-id concurrency → 409 (`:385`); seen → `duplicate` (`:399`). The only double-apply shape is a crash between `applyEvent` success and `markSeen` (`:421`). Probed and pinned: the second `applyEvent` of the exact event answers `ignored` (completed admission gone; stale guard), licence expiry, both paid-through dates and the hook count are unchanged. **No defect.**

### F4 — Newer refund / dispute / failure / cancellation before the retry: covered where attributable
Failure → `pendingStatus: past_due` and the watermark moves (`:692-693`), pending dropped → retry refused by `!prior.pendingStatus` and by the watermark. Cancellation → terminal ledger written first (`:700`) → retry refused at `:626`. Full refund / dispute **when attributable to the bundle** → `onRefund`/`onDispute` flag + revoke, `applyHostingEvent` flags hosting, ledger write drops the pending → retry `ignored`, licence stays revoked, hook not re-fired. Pinned end to end for v1 and v2 (hosting-hook interruption point, so both roles know the charge). **No defect.** Note: the `!refunded/!disputed` clauses inside `resumingInitialPaid` are structurally redundant with the per-role exact-identity clause (every handler that sets a flag also rewrites `lastEventId`), so a mutation of those clauses alone cannot be observed; they are defence in depth, not load-bearing.

### F5 — Lifetime, one-price historical bundles, `initialPaidAfterCheckout` branch
`initialPaidAfterCheckout` is gated `!lifetimeHosting`; `lifetimeInitialPaid` (`:624`) is untouched; the pending is therefore never written for a Lifetime mixed checkout and `resumingInitialPaid` is unreachable there. v1 one-price bundles have no `bundle.hosting`, so `lifetimeHosting` is always false and the new path applies as intended (the diff's own v1 tests). `activatingBehindFailure` is untouched. The watermark arithmetic (`:692`) is unchanged and `Math.max` keeps it monotone (pinned in every new completion assertion). **No behaviour change for these populations.**

### F6 — Nothing widens a deadline or issues extra authority
On admission the software target is `periodEnd + graceDays` through the unchanged `extendLicense` cap chain; the retry writes the same target again. Hosting `periodEndMs` only advances. Both are pinned against the exact expected expiry in the v2 matrix (`Math.max(bootstrapExp, swEnd + grace)`, unchanged across the failed attempt and the completing retry).

### L1 — LIMITATION (pre-existing, outside the diff): a charge-level event delivered while only the software half knows the charge is `unclassified`
`bundleIdentity`'s charge branch (`:600-607`) requires **both** `findByCharge` (software) and `findRoleSubscriptionByCharge("hosting", …)` to match. After a partial application that wrote software but not hosting, a `charge.refunded` / `charge.dispute.created` / `charge.succeeded` for the initial charge falls to the role dispatcher, where the bundle has never populated the role index and `classifyRole` with empty facts answers `unknown` whenever the hosting allowlist is non-empty (`roles.ts:89`) — and hosting cannot be enabled without a classified hosting price (`hosting/service.ts:215`). Probe result (realistic config): refund → `200/unclassified`, licence not revoked, then the retry resumes and completes the hosting term. The refund is recorded "for reconciliation" in the admin event list, but nothing revokes. The same window existed before this change (an in-order invoice whose hosting write failed leaves the identical half-known charge), so it is not introduced here. Not fixed: widening `bundleIdentity` to accept a software-only charge match would also route an older, unrelated software charge's refund onto the hosting record of a later bundle — a protection applied to the wrong product — and is an attribution design change, not a minimal correction. Recommend a follow-up that attributes a charge to the bundle only when the charge id is on the software record **and** that record's current `subscriptionId` has a bundle row whose admitted initial invoice named that charge.

### L2 — LIMITATION (theoretical): the "checkout-only" precondition is keyed on `lastEventType`
`initialPaidAfterCheckout` requires both roles' `lastEventType` to start with `checkout.session.`. A **newer** `customer.subscription.updated` applied between checkout and the older initial invoice rewrites `lastEventType` on both roles. Probed: when that update carries a period end (every conforming active subscription object does — `subscriptionFacts` reads `current_period_end` on the object and on items), both roles are healed by the update itself and the older initial invoice is then inert with no double extension — correct. Only an active update carrying **no** readable period end would leave the incident state (both `periodEndMs: null`, invoice `ignored`), which I could not construct from a conforming Stripe payload. `charge.succeeded` cannot cause this (L1's `unclassified` outcome, confirmed by probe). Recorded, not changed.

### Noted, outside scope
A second `checkout.session.completed` for a second subscription on the same customer answers 500 (`hosted bundle reservation could not be bound…`) before and after this change; unrelated to the admission logic.

## Tests added (all registered automatically — `tests/run-all.mjs` globs `tests/*.test.mjs`)

`tests/hosting-bundle.test.mjs` (legacy v1 bundle), after the diff's restart loop:
1. `a refund landing after a partially applied older initial invoice revokes and fences its retry`
2. `a dispute landing after a partially applied older initial invoice revokes and fences its retry`
3. `an older initial invoice applied once but never marked seen is inert on its exact redelivery`
4. `a newer renewal supersedes a completion-interrupted older initial invoice; its retry adds nothing`
5. `repeated hosting write refusals keep the exact admission; an alias event cannot borrow it; the next delivery completes once`

`tests/billing-six-plan.test.mjs` (mixed v2 checkout, `launchIntentId` identity, full `createHub` restart against the durable files before the retry), nine parametrized cases `mixed older initial invoice restart at <point>, newer fence=<fence>`:
- points: `reservation-hook` (the `onBundleEvent` binding hook, before any role write), `post-software-write` (the customer write after `onInvoicePaid`'s own), `hosting-write`, `hosting-hook`, `completion-write`
- fences: `hosting-write`+`failure`, `hosting-write`+`cancellation`, `hosting-hook`+`refund`, `hosting-hook`+`dispute`

Each positive case asserts: the first delivery is `500` with the pending admission durable (sha + checkout watermark), the event unseen, exactly the expected roles written, the licence expiry exactly `max(bootstrap, period+grace)` and unchanged by the retry, the retry `applied`, the hosting hook fired exactly once from the restart, the watermark still the checkout's, the pending gone, a re-send `duplicate`, the `invoice.payment_succeeded` alias `ignored`. Each fence case asserts the fence `applied`, the pending retired, the retry `ignored`, the expected status/flags, revoked licence with no re-issue, and no hosting hook call from the retry.

## Mutation evidence (on COPIES of `dist` under the scratchpad; source and the real `dist` untouched — real `dist/src/billing/service.js` sha256 `dd8c122d…` before and after)

Harness copies were patched to continue past the first failure so every red test is listed (`process.exit(1)` → `process.exitCode = 1` in the scratch `helpers.mjs`).

- **M1 — fix removed** (`service.js:640` restored to the 0.4.90 guard `if (stale && !activatingBehindFailure && !lifetimeInitialPaid)`; copy sha `e06b6eab…`): hosting-bundle **11 FAIL** (the diff's 6 + my 5) / 14 passed, exit 1; six-plan **10 FAIL** (the diff's 1 + my 9) / 30 passed, exit 1. Every new test is red.
- **M2 — resumption removed** (`&& !resumingInitialPaid` dropped; sha `c12795ac…`): hosting-bundle 4 FAIL (restart hosting-write / hosting-hook / completion-write, repeated-refusal) / 21 passed; six-plan 4 FAIL (post-software-write / hosting-write / hosting-hook / completion-write) / 36 passed. Fence, duplicate, superseded and reservation-hook cases stay green by design (they do not depend on resumption).
- **M5 — stale guard admits every stale event** (`if (…) return ignored` → `if (false)`; sha `b085a3c2…`): hosting-bundle 11 FAIL incl. both refund/dispute fences, the failure fence, duplicate, superseded, repeated, and the pre-existing `an older paid event cannot undo a newer failed-payment state` / 14 passed; six-plan 9 FAIL incl. refund/dispute/failure fences / 31 passed. Cancellation fences stay green under M5 because the terminal guard at `:626` is a separate, earlier fence — expected.

With the real build: every new test green (below).

## Commands run and result lines

- `npm run build` → `> tsc`, **exit 0** (run before and after the test edits; `dist/src/billing/service.js` sha unchanged `dd8c122d…`).
- Baseline before edits: `node tests/hosting-bundle.test.mjs` → `20 checks passed`, exit 0; `node tests/billing-six-plan.test.mjs` → `Six-plan billing: 31 checks passed`, exit 0.
- After edits: `node tests/hosting-bundle.test.mjs` → `25 checks passed`, exit 0; `node tests/billing-six-plan.test.mjs` → `Six-plan billing: 40 checks passed`, exit 0.
- Other billing/hosting suites on the real tree, all exit 0: billing 29, billing-after-commit-outbox 5, billing-fulfillment-lifecycle 4, billing-launch 25, billing-legacy-lifetime 5, billing-payment-replay 12, billing-reminders 9, billing-reporting (passed line), billing-roles 18, hosting-service 16, hosting-deadlines 6, hosting-holds 12, hosting-bootstrap 13, foreign-product-family 4.
- Exploratory probe script (scratchpad, not a suite) against `dist`: 11 scenarios; results quoted in F1–F4, L1, L2.
- Full `npm test` deliberately NOT run (lead's instruction).

## Files changed in the working tree by this review
- `docs/incidents/2026-10-09-initial-subscription-term.md` — residue sentence removed (one line).
- `tests/hosting-bundle.test.mjs` — `parseStripeEvent` import; five tests + two helpers (+159 lines).
- `tests/billing-six-plan.test.mjs` — `createHub` import; nine parametrized tests + three helpers (+70 lines).
- `docs/claude-review-2026-10-09/billing-correction-review.md` — this report.

No `src/` change. Version 0.4.91 kept. README not touched by this review.

## Not mine / could not verify
- The working tree also carries changes I did not make and did not touch: `README.md` (a v0.4.91 bullet under `## Changelog`), `tests/installer-rerun-safety.test.mjs` (NODE_OPTIONS strip), untracked `tests/claude-deadline-charge-interleave.test.mjs`, `scripts/deploy-hub-0491.py`, and `docs/claude-review-2026-10-09/SUBSCRIPTION-DEADLINE-RECHECK.md` — another session is working in this clone concurrently (timestamps 16:52–17:02 UTC). My runs may have overlapped with theirs; every result above was re-checked on a quiet re-run.
- Stripe's retry payload byte-equality (which the sha256 identity relies on) is taken from Stripe's documented immutable-event semantics, not observed live.
- Whether a conforming active `customer.subscription.updated` can ever arrive without any readable period end (L2) was not verifiable offline.
- The production hosting role allowlist was not inspected; L1's `unclassified` outcome holds whenever it is non-empty, which `hosting/service.ts:215` requires for managed hosting to operate.
