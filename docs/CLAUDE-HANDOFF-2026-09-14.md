# Claude handoff: account/candle/marketplace audit

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
gap, while an unaffected symbol keeps its exact cached coverage. Retention days,
REST frontiers, stream behavior and request rates are unchanged. Package,
lockfile and runtime identity move to v0.4.34; the admin footer reads that served
identity. Build, all 53 suites, and the focused 78-check candle suite passed on
this Mac with Bash 5 and the real app percentile module.

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
