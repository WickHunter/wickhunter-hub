# Hub 0.4.103 working notes (branch claude/hub-qfl-year-horizon)

Done
- 0.4.103 standing timeframe horizon (HUB_TIMEFRAME_HORIZON), month files, cursors, two-proof floors,
  long-window worker, venue fixes, admin card, README/docs, version bump.
- Review fixes S1 (busy before work, O(1) long prepare), S2 (month-step prime, 10 ms turns),
  S3 (prune in ~10 ms turns), S4 (horizon-memory.v1.json: unset never deletes month files early),
  S5 (request-driven first; horizon <= 1 slot in 4 beside 1m backfill), S6 (WEEX 1 legacy turn in 8,
  HUB_TIMEFRAME_WEEX_HISTORY_EVERY), S8 (per-request demand kept until the cursor's newest page lands),
  S11 (stale *.tmp.<pid> removed after 1 h). Tests in tests/timeframe-horizon.test.mjs (32 checks);
  mutations M1–M20 and N1–N10 all red.
- Full suite (TMPDIR=/var/tmp, nice 19): 126/127 pass; only liq-percentiles (known flaky, env path).

Next
- Nothing required for code review. Deploy is NOT done and needs operator authorisation.
- Deferred: gz LRU for long bodies, fold of untouched pre-existing day files, proof-file pruning for
  delisted pairs, Binance/Aster 1500-row pages, prime-turn p95 ~17 ms / max ~35 ms under load.
