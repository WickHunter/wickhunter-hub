# Hub 0.4.91 — deployment record (2026-10-09)

Deployed on the Hub box by the operator `scripts/deploy-hub-0491.py` (stage
`/root/wh-hub0491-attempt2-20261009`, operator at the stop-proof fix of PR #84,
`HEALTH_TIMEOUT` still 15 s on that copy — the launcher timed the run inside the
Hub's responsive window). Source commit `6c01ff4504464c2b22e3bead753c3828f518e253`
(the qualified commit bound in `DEPLOY-HUB-0491-RUNBOOK.md`).

## Result line

```
{"ok": true, "result": "deployed-and-verified", "receipt": "/root/wh-hub0491-attempt2-20261009/stage/receipt.json",
 "receiptSha256": "73591abbecbfad4c0d94e7b2d66ac1458bd534b22138eee0d3acc24ad93ca2fa", "version": "0.4.91",
 "commit": "6c01ff4504464c2b22e3bead753c3828f518e253", "oldPid": 1109340, "oldInvocation": "2aae8bedc6584ebc9a3cdc129622d292",
 "newPid": 1117428, "newInvocation": "29d054ee6b6947de881309074031532e",
 "dataBackup": "/root/wh-hub0491-attempt2-20261009/stage/backup/data-20261009T191021Z-d3d57d.tar.gz"}
```

Phases: stop 19:06:56Z (clean SIGTERM, `ExecMainCode=1` accepted) → data backup
1,531,736,831 bytes / 99,890 members excluding `candles/`, verified 19:17:59Z →
install + build record 19:18:06Z → start 19:18:52Z → post-verify 19:19:19Z.
Hub downtime 19:06:56–19:18:43Z (the data backup dominates, as the runbook says).

## verify (19:19:55Z, same flags) — VERIFY PASS, 17 of 17

```
[   pass] receipt.present — Hub 0.4.91 — initial subscription term after checkout (docs/incidents/2026-10-09-initial-subscription-term.md): 0.4.90 -> 0.4.91 at 6c01ff4504464c2b22e3bead753c3828f518e253, verified 2026-10-09T19:19:19Z
[   pass] service.binding — wickhunter-hub.service bound fresh: install /opt/wickhunter-hub, port 8091, data /opt/wickhunter-hub/data
[   pass] service.identity — MainPID 1117428 invocation 29d054ee6b6947de881309074031532e NRestarts 0 (receipt: 1117428 / 29d054ee6b6947de881309074031532e)
[   pass] health.identity — version '0.4.91' commit '6c01ff4504464c2b22e3bead753c3828f518e253'
[   pass] health.listener — port 8091 owned by MainPID 1117428; loopback only: True
[   pass] runtime.files — 4 installed file(s) match their after hashes; 0 removal(s) absent
[   pass] runtime.tree — runtime tree digest c7d4fdc8164b6d75… (receipt c7d4fdc8164b6d75…)
[   pass] protected.paths — protected paths match the receipt
[   pass] protected.service.liqhunter.service — present active MainPID 1035398 (receipt 1035398)
[   pass] protected.service.liqhunter-marketplace-api.service — present active MainPID 1035400 (receipt 1035400)
[   pass] protected.service.liqhunter-marketplace-worker.service — present active MainPID 1035407 (receipt 1035407)
[   pass] protected.service.nginx.service — present active MainPID 3458865 (receipt 3458865)
[   pass] protected.service.postgresql.service — present active MainPID 0 (receipt 0)
[   pass] protected.service.postgresql@18-main.service — present active MainPID 3458916 (receipt 3458916)
[   pass] data.licences — licences 94, revoked 1 (receipt {'licenses': 94, 'revoked': 1})
[   pass] data.build-record — hub-build.v1.json sha256 5459dcb46e820fee… value {'schemaVersion': 1, 'packageVersion': '0.4.91', 'commit': '6c01ff4504464c2b22e3bead753c3828f518e253', 'branch': None, 'builtAtMs': 1791573486319}
[   pass] data.entries — 221356 entries under /opt/wickhunter-hub/data now (receipt after start: 221355)
VERIFY PASS
```

Release shelf identical (42 files; Beta 0.90.135 sha `6c649a93…` unchanged).
Public health through nginx reports 0.4.91 at `6c01ff4`.

## Receipt provenance

`HUB-0491-DEPLOYMENT.json` beside this file is the stage receipt as relayed from
the box session and re-serialised (pretty-printed, UTF-8). The canonical copy is
`/root/wh-hub0491-attempt2-20261009/stage/receipt.json` on the box, sha256
`73591abbecbfad4c0d94e7b2d66ac1458bd534b22138eee0d3acc24ad93ca2fa`; the relayed
copy was scanned for tokens, keys, env values and customer rows (none — identity
and env files appear only as sha256 fingerprints), and its `->` arrows were
restored where the relay had HTML-escaped them. Compare the box copy against this
one before relying on a byte-level hash.

## Subscription deadline recheck after the deploy (section 6 of SUBSCRIPTION-DEADLINE-RECHECK.md)

Read-only run on the deployed 0.4.91 at 19:19Z (the Hub had refreshed Stripe
facts itself at 19:19:06Z): `graceDays` 3, `bootstrapDays` 3, 35 known live
recurring subscriptions, 32 eligible, `refreshError` null, 0 null period ends,
customers 50 rows, licences 94. **11 rows were `STRICT_SHORT`** — active,
`exp == currentPeriodEndMs == 2026-10-15T04:00:00Z` (the launch anchor, no
grace), shortfall 3.00 d, checkouts 2026-10-05 to 2026-10-09: 10 software-only
plans (unleashed monthly/yearly) and 1 hosted yearly bundle. This is scenario
4.7 and it is **not limited to hosted bundles**: the ledger shows no `invoice.*`
event at a software-only launch checkout, so `exp` stays at the bare anchor that
`onSubscriptionCheckout` writes.

Repair, applied in the user's own box session on the user's instruction at
19:32Z: `POST /admin/api/licenses/expiry {id, exp: 1792296000000}`
(2026-10-18T04:00:00Z = paid-through + 3 d) for each of the 11; 11 of 11 answered
200 with that `exp`. Section 6.3 re-run afterwards: 35 known live, 32 eligible,
**0 flagged short**. Check-ins every 5.0 min (one 20-min gap across the deploy
downtime), no seat refusals in the last day, 0 error outcomes; 37 unclassified
`charge.succeeded` (expected, 4.9); "older bundle lifecycle event ignored" on six
`invoice.paid`/`payment_succeeded` events 10-07 to 10-09 (the last an alias
duplicate after its `invoice.paid` was applied).

**Follow-up on the Hub source (not made here):** `onSubscriptionCheckout` should
write the launch anchor plus the grace for software-only launch checkouts too, or
every launch checkout made before 2026-10-15 is a new `STRICT_SHORT` row. Re-run
section 6.3 on 2026-10-14 for rows created after this repair.
