# Claude handoff: account/candle/marketplace audit

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
