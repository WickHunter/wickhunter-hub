# Claude handoff: account/candle/marketplace audit

## v0.4.36 follow-up: REST accounting must match storage admission

The deployed v0.4.35 fairness fix advanced the previously starved Bitget/WEEX
BTC frontiers, but a separate post-deploy seed check found Bitunix and Aster
both declaring 2026-09-14 20:56 UTC as their frontier with that exact last slot
missing. A read-only disk check at 21:05:33 UTC confirmed real rows at 20:55
and 20:57, no 20:56 slot, and the durable frontier at 20:56 on both venues.
This was not a cached-gap or client price-validation error.

The startup tick captured 20:57:33 before its yielding coverage scan. New WS
rows could arrive during that scan, causing reconciliation to request beyond
that captured time's 20:55 settlement cutoff. `dropUnclosed()` admitted the
merely closed 20:56 row; `store.write()` rejected it for the extra minute of
clock-skew grace. Coverage, correction counts and the durable REST frontier
then incorrectly used the pre-write array. The same discrepancy could falsely
count a correction of a WS grace row already on disk without writing its REST
value.

The collector now filters REST rows to the captured store cutoff before recent
contiguity selection, correction comparison, writing and accounting. The store
retains its own admission gate. Real CandleStore and Bitunix/Aster adapter
regressions advance the clock three minutes during coverage preparation and
three more while the REST request is pending. They cover an absent grace row,
a different WS value already present, cache/disk/frontier agreement, a seed
without a false trailing gap, and a later tick that actually writes and credits
the newly settled data. Short, grace-only and empty responses cannot credit
the requested end; a WEEX cold current-page fixture applies settlement before
choosing its contiguous suffix.

No stored data or frontier is rewritten. Existing gaps heal through ordinary
reconciliation/repair. The existing maximum-observed REST watermark remains;
this change does not introduce per-slot provenance or alter handling of an
interior omission in a REST response. All rates, budgets, backoff, fair queue
ordering, signing and app depth/gap checks remain unchanged. Package and served
runtime identity move to v0.4.36; the admin footer reads that served version.
Build and all 53 Hub suites passed on this Mac with Bash 5 and the real app
percentile module. The focused reconciliation suite now passes 16 checks;
independent review and its separate focused run found no blocking issue.
This local change has not deployed or modified production; root owns rollout
and the subsequent signed-seed/frontier recovery check.

## v0.4.35 follow-up: fair reconciliation under a changing due set

At 20:47–20:49 UTC on 2026-09-14, v0.4.34 kept all 29 native candle sockets
open and its warmed status returned in 29–33 ms. However, the signed BTC seed
frontiers were 49–69 minutes behind on Bitget/WEEX while their streamed tails
continued advancing. Both BTC symbols occupy insertion position zero. Bitget
had 223 of 783 active symbols without a persisted REST frontier; WEEX had 179
of 239. Rates and backoff remained bounded; increasing them was not the remedy.

`workQueue()` rotated the filtered reconciliation list by a counter incremented
once per tick. Symbols left that list after confirmation and returned after
five minutes, changing what each index meant. Untouched peers could be skipped
while previously served rows consumed another turn. Actual-collector fixtures
with continuously advancing WS data first reproduced this: the first 783
Bitget requests reached only 506 distinct symbols, and the first 239 WEEX
requests reached only 71. The fixture uses real collector/REST adapter and
frontier persistence paths with an in-memory candle store to avoid irrelevant
large disk rewrites.

Reconciliation now anchors to the last attempted symbol in the full tracked
roster, including retained delisted/untradable records. It resumes with the
next due symbol after that anchor and wraps. Only an attempted reconciliation
advances it: failures/429/empty responses yield, but zero budgets, deadlines,
cooldowns and higher-priority tail-only work do not consume an unseen turn.
Other work ordering, all request limits/backoff, the 60-minute reconcile span,
gaps, signing and REST frontier advancement rules are unchanged. Package and
runtime identity move to v0.4.35; the admin footer reads the served identity.
At WEEX's unchanged five historical requests per minute, a 239-symbol sweep
still takes about 48 minutes: fairness removes starvation, not the venue's
capacity bound. No app seed-depth or entry-staleness check is loosened.
Build, all 53 suites, and the focused 9-check reconciliation suite passed on
this Mac with Bash 5 and the real app percentile module. Independent review
also passed that focused suite and found no blocking issues. The new version
has not been deployed as part of this local change; root owns rollout and its
subsequent live frontier verification.

## v0.4.34 follow-up: do not repeat unaffected coverage scans

The v0.4.33 deployment kept health responsive with all six candle streams
enabled, but candle diagnostics encountered a second slow exact-coverage scan.
Source inspection found that the first completed collector tick runs retention,
and `VenueCollector.prune()` discarded every coverage-cache entry even when no
file was removed. This is independent of the stream batching/settlement fix.

Retention now invalidates only symbols for which `CandleStore.prune()` reports
an actual file deletion. The regression first failed because a no-op pass
rescanned both warm symbols. It also proves that deleting one symbol's expired
day file rescans that symbol alone and recomputes its bounds, count and interior
gap, while an unaffected symbol keeps its exact cached coverage. The adjacent
repair-gap cache is invalidated on actual removal too: a second regression
primed an old gap, crossed midnight by two milliseconds, and proved that its
ten-minute cache incorrectly refetched the expired day. The fix recomputes the
remaining gap and preserves both caches on a no-op pass. Retention days,
REST frontiers, stream behavior and request rates are unchanged. Package,
lockfile and runtime identity move to v0.4.34; the admin footer reads that served
identity. Build, all 53 suites, and the focused 79-check candle suite passed on
this Mac with Bash 5 and the real app percentile module, including both the
exact-coverage and expired-repair regressions.

Before this follow-up, deployed v0.4.33 (`df9058d`) was verified at 19:51:11 UTC:
all 29 candle sockets were open, and all six venues had advancing stored-close
counters, including Binance at 1,388 after its delayed startup. Health remained
responsive during the cold scans. No current venue errors or rate-limit hits
were reported. This v0.4.34 cache fix still needs its own deployment identity
check; it changes neither those stream settings nor their settlement logic.

## v0.4.33 follow-up: Bitget snapshot startup starvation

On 2026-09-14, enabling all six supported native candle streams on the VPS
bound the Hub port but made health and graceful shutdown unresponsive. The
failed process used 164.5 CPU seconds over 181.3 seconds and peaked at 305.7 MB;
there was no kernel OOM event. The operator restored the previous stream config.

A separate, credentialless one-symbol probe confirmed that Bitget opens its
`candle1m` subscription with 500 ascending rows. The existing closure buffer
produced 499 synchronous store calls for that single frame. At the observed
783-symbol roster this projects to 390,717 day-file rewrites, roughly 27 GB of
written buffers. One-symbol probes of the other native adapters stayed responsive.

The runner now batches settled closed rows by symbol within each frame. The
audit also found that all other native streams dropped live closes arriving
inside the local one-minute clock-skew grace. WEEX's existing bounded settlement
path is now shared: retain up to three complete rows per symbol, flush eligible
rows every second, preserve them across reconnect/re-sharding, and discard them
on symbol removal or stop. Forming observations never enter that queue. REST
alone advances `rest-frontier.json`; no rates, signer, enabled venues or
production flags change in this patch. A counter increments by settled rows
after a successful store call, never by deferred rows or write calls.

The 500-row regression first failed with `499 !== 1`. Its real-store fixture
covers midnight and preserves the closed prefix and forming tail. Native frames
from Bitget/Bitunix's ordering-based protocols and Bybit/Binance/Aster's explicit
confirmations prove that a clock-only timer flushes each complete close into a
real store without advancing REST provenance. Another fixture pins the cap,
duplicates, reconnect/re-sharding, counter ownership, removal and stop. Build
and all 53 suites passed on this Mac using Bash 5 and the real app percentile
module. The focused stream-runner suite passed 21 checks; independent review
also passed the stream protocol and REST reconciliation suites. The admin
footer derives its version from health, so package/lockfile and `src/version.ts`
move together to v0.4.33. Production rollout and all-venue live counter checks
remain separate from this local validation.

GitHub base: `b893589` (v0.4.31), fetched again on 2026-09-14.
Related app and Go work uses `codex/account-assignment-audit` in
`WickHunter/liqhunter-private` and `WickHunter/wickhunterunleashed-go`.

v0.4.32 exposes `streamStatus()` through the authenticated candle-status
response and renders socket coverage and candle counters in each venue card.
The quick review also found that restart treated every existing disk candle as
REST-confirmed, including WebSocket-only writes. The collector now persists
`rest-frontier.json` only after successful REST collection and reconciles missing
or stale provenance within the existing request budget. Old installations
without that file temporarily withhold unconfirmed seeds while REST catches up.
Collector defaults and signing contracts are unchanged.

Related app fixes cover stable bot homes, account-scoped mutations, shared 1m
ATR input independent of entry interval, and live-tail admission refreshed even
without an Optimized bot. Marketplace backlog starvation and its new index are
in the app repository's marketplace service.

## Candle findings

- `HUB_CANDLE_VENUES` controls collection; empty deliberately leaves it off.
- `HUB_CANDLE_STREAM` controls optional venue WebSocket collectors. WEEX is
  automatically included for an enabled candle service unless explicitly
  excluded with `-weex`. Other venue stream choices are preserved.
- Keep v0.4.31's REST reconciliation. WebSocket trade/candle tails cannot by
  themselves establish the REST-confirmed history frontier served to clients.
  The bot validates signed seed overlap against its own traded venue and falls
  back to rate-bounded same-venue REST when the seed is absent or unsuitable.
- All candle, HTTP seed, stream, stream-runner, reconciliation and WEEX tests
  passed. This proves code behavior, not that every production venue is enabled
  or currently healthy. Read the deployed candle configuration and admin
  candle status before asserting complete live coverage.
- Marketplace WebSocket delivery likewise depends on deployment flags in the
  app's marketplace service. Its focused bridge/status/nginx tests pass here;
  use the app's `docs/MARKETPLACE-AUDIT-2026-09-14.md` for the speed findings.

## Validation portability change

The percentile parity test previously required an app checkout at a hardcoded
Linux path. `LIQHUNTER_BOT_MODULE` now optionally points at the current compiled
app module. The original default remains; parity still compares the actual app
implementation, with no copied expectations or skipped assertions.

On this Mac, build and **all 53 suites passed** using Bash 5 for the production
backup-script tests (macOS's bundled Bash 3 lacks `mapfile`) and:

```sh
LIQHUNTER_BOT_MODULE='../account-assignment-audit-private/dist/liq/size-percentiles.js' npm test
```

No live configuration, signing keys, deployment, subscription or trade changed.
