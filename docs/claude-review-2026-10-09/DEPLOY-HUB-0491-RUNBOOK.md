# Runbook — Hub-only update 0.4.90 → 0.4.91 with `scripts/deploy-hub-0491.py`

Status: **prepared, not executed.** The Hub host was not reachable from the
environment that wrote this; no live preflight, stop or deployment has
occurred. Everything below is executed by the operator on the box, once,
through the reviewed procedure. The companion review is
`docs/claude-review-2026-10-09/deploy-operator-review.md`.

> **FILL IN BEFORE RUNNING**
>
> * `QUALIFIED_COMMIT` = `6c01ff4504464c2b22e3bead753c3828f518e253` (final qualified 0.4.91 source; see `LINUX-QUALIFICATION-2026-10-09.md`. Deploy HEAD of `claude/hub-billing-review` and confirm `git diff --stat 6c01ff4 HEAD` touches only `docs/`; if it does not, STOP.)
> * `QUAL_FILE` = `docs/claude-review-2026-10-09/linux-qualification-6c01ff4.json` (shape as
>   `docs/HUB-0464-VERIFICATION.json`: at least `sourceCommit`, `version`,
>   `gateExit`, `gateSuites`; the operator requires `sourceCommit`/`version`
>   to agree with the manifest when present).
> * `STAGE_ROOT` = `/root/wh-hub0491-<YYYYMMDD>` on the box (the precedent
>   naming; a persistent filesystem, never `/tmp`).
> * The PostgreSQL unit name on the box if it is not `postgresql.service`
>   (on the Hub box it is `postgresql@18-main.service`, found on the first live
>   run 2026-10-09): pass it as `--protected-service`. ⚠ `--protected-service`
>   REPLACES the script's default list, it does not add to it — name all five
>   defaults again beside it (the `PROTECTED` line in step 4), and put every
>   `--protected-service` / `--data-backup-exclude` BEFORE the subcommand: they
>   are global flags, and after `preflight`/`deploy`/`verify` argparse refuses them.
> * Whether `--data-backup-exclude candles` is needed: compare
>   `du -sh /opt/wickhunter-hub/data` against `df -h /root` (the preflight's
>   `stage.free-space` check does the arithmetic; `candles/` is the only data
>   subtree the README calls reproducible).

## What is on the box (learned from this repo; the operator re-binds every one of these from systemd at run time and refuses on disagreement)

| Fact | Value / source |
| --- | --- |
| Hub service | `wickhunter-hub.service`, `User=Group=wickhunter-hub`, `WorkingDirectory=/opt/wickhunter-hub`, `ExecStart=<node> dist/src/main.js`, `Restart=always` (`install-hub.sh`; hardened variant in `deploy/wickhunter-hub-hardened.service`) |
| Environment file | `/etc/wickhunter-hub/env` (0600): `HUB_ADMIN_TOKEN`, `HUB_PUBLIC_ORIGIN`, `HUB_PORT=8091`, `HUB_RELEASE_PUBLIC_KEYS_JSON`, lease kid; optional `EnvironmentFile=-/etc/wickhunter-hub/marketplace.env` and `-/etc/wickhunter-hub/support.env` |
| Install tree | `/opt/wickhunter-hub` deployed **without git** (`docs/LAUNCH-READINESS-20260930.md`: "Hub source-based Upgrade is unavailable on this manually deployed host"); runtime = `dist/`, `public/`, `templates/`, `package.json`, `package-lock.json`; zero runtime npm deps |
| Data | `/opt/wickhunter-hub/data` (service-owned 0700): licence signer, lease signers + keyring + audit ledger + head, `licenses.json`, `revoked.json`, `roster.json`, `checkins.jsonl`, `license-seats.v1.json`, `billing-config.v1.json`, `hub-build.v1.json`, `upgrade-status.v1.json`, `upgrade.log`, `candle-signing.key`, `candles/` (README "Where the data lives") |
| Release shelf | `/opt/wickhunter-hub/releases/` (service-owned 0700): `wickhunter-beta-<v>.tar.gz`, `manifest-<sha>.json`, `latest.json`, `.release-control.v1.json` — live state, never from git (`releases/README.md`). Beta 0.90.135 artifact sha `6c649a93…` must be unchanged afterwards |
| Health | `GET http://127.0.0.1:8091/api/health` → `{ok, version, packageVersion, build:{schemaVersion,packageVersion,commit,branch,builtAtMs}, source, sourceVsRuntime, upgrade}`; `build.commit` is read from `data/hub-build.v1.json` (`src/operations.ts`), which `install-hub.sh` writes through `bin/buildinfo.ts` — the operator writes that one file the same way so health reports the exact commit |
| Reverse proxy | nginx includes `/opt/wickhunter-hub/nginx/hub.locations.conf` → `/hub/` → `127.0.0.1:8091`; the operator never touches nginx |
| Other services on the box | `liqhunter.service` (Alpha trading app, `/opt/liqhunter`, protected tree incl. `.deployed-commit`), `liqhunter-marketplace-api.service`, `liqhunter-marketplace-worker.service` (private Marketplace, PostgreSQL-backed), `nginx.service`, `postgresql` (unit name to confirm) |
| Alpha/Marketplace identity files | `/etc/wickhunter-hub/marketplace-state.env` (root-only masked Marketplace state, intent signing identity), `/etc/wickhunter-hub/marketplace.env` (status-bridge credential), `/etc/wickhunter-hub/support.env`, `/etc/liqhunter/marketplace-{common,api,worker,migrate}.env`, `/etc/liqhunter/marketplace.env` (`bin/root-helper.ts`); fingerprinted before/after, never read into any record |
| Prior evidence to preserve | `/root/wh-hub0462-audit-20260929/`, `/root/wh-hub0463-candles-20260929/` (failed 0.4.63 rollback evidence), `/root/wh-hub0464-candles-20260929/`, `/root/wh-hub0470-launch-reviewed-20261001/receipt.json` and any later stage directories — the operator never touches another stage |

## Prerequisites

* Workstation: a clean checkout of `wickhunter-hub` at `QUALIFIED_COMMIT`, Node 22+, Python 3.9+.
* Box: root shell, Python 3.9+ (`python3 --version`), systemd, the Hub active and healthy on 0.4.90, free disk per the placeholder note, no other deployment or `Upgrade hub` action in flight, nothing in `/root/wh-hub0491-*` from an earlier attempt (a used stage is refused and must not be reused).
* This operator only: do not run `install-hub.sh`, the admin **Upgrade hub** button, `scripts/deploy-audit-hub.py` (pinned to 0.4.62) or the workstation draft `deploy-hub0491.py`.

## Command sequence

### 0. Ship the operator (workstation → box)

```
STAGE_ROOT=/root/wh-hub0491-$(date -u +%Y%m%d)
ssh root@HUB "install -d -m 0700 -o root -g root $STAGE_ROOT"
scp scripts/deploy-hub-0491.py scripts/deploy-hub-0491-selftest.py root@HUB:$STAGE_ROOT/
ssh root@HUB "cd $STAGE_ROOT && python3 -I deploy-hub-0491.py --self-test | tail -1"   # expect: SELF-TEST: 13 passed, 0 failed
```

### 1. Baseline (box, read-only)

```
cd $STAGE_ROOT
python3 -I deploy-hub-0491.py baseline --out $STAGE_ROOT/baseline-$(date -u +%Y%m%dT%H%M%SZ).json
```
Prints `{"ok":true,"version":"0.4.90","commit":"<live commit>","files":N,...}`. Copy the baseline file back to the workstation (`scp root@HUB:$STAGE_ROOT/baseline-*.json .`). The baseline is a hash listing of the runtime tree plus non-secret service facts; it holds no credential.

### 2. Build, qualify and package (workstation)

```
git checkout "$QUALIFIED_COMMIT" && test -z "$(git status --porcelain --untracked-files=no)"
npm ci && npm run build && npm test                     # the gate; record its output into QUAL_FILE
git archive --format=tar.gz -o "source-$QUALIFIED_COMMIT.tar.gz" "$QUALIFIED_COMMIT"
python3 scripts/deploy-hub-0491.py package \
  --build-dir . --baseline baseline-<ts>.json --out stage-0491 \
  --commit "$QUALIFIED_COMMIT" --version 0.4.91 --baseline-version 0.4.90 \
  --qualification "$QUAL_FILE" --source-tarball "source-$QUALIFIED_COMMIT.tar.gz" \
  --change "Hub 0.4.91 — initial subscription term after checkout (docs/incidents/2026-10-09-initial-subscription-term.md)"
```
Expected: `{"ok":true,"files":<n>,"removals":<m>,...}`. Read `stage-0491/manifest.json`: every path must be under `dist/`, `public/`, `templates/` or be `package.json`/`package-lock.json`; `dist/src/version.js` and `package.json` must be present with a `before` hash; removals (modules the new build no longer emits) are moved aside on the box, never deleted.

### 3. Transfer the stage (workstation → box)

```
rsync -a --chown=root:root stage-0491/ root@HUB:$STAGE_ROOT/stage/
ssh root@HUB "chmod 0700 $STAGE_ROOT/stage && chmod -R go-rwx $STAGE_ROOT/stage && find $STAGE_ROOT/stage -type l"   # the find must print nothing
```

### 4. Preflight (box, read-only; repeatable)

```
cd $STAGE_ROOT
# Global flags go BEFORE the subcommand. --protected-service REPLACES the default list, so
# the five defaults are named again beside the box's PostgreSQL unit (postgresql@18-main.service).
PROTECTED="--protected-service liqhunter.service --protected-service liqhunter-marketplace-api.service --protected-service liqhunter-marketplace-worker.service --protected-service nginx.service --protected-service postgresql.service --protected-service postgresql@18-main.service"
python3 -I deploy-hub-0491.py $PROTECTED [--data-backup-exclude candles] preflight --stage $STAGE_ROOT/stage \
  | tee $STAGE_ROOT/preflight-$(date -u +%Y%m%dT%H%M%SZ).txt
```
Every line is `[pass|fail|unknown] name — detail`. Proceed only on `PREFLIGHT PASS`. Use exactly the same `$PROTECTED` / `--data-backup-exclude` flags on every later command. An `unknown` (exit 3) is not a pass.

The health probe waits up to 90 s per request (was 15 s): the Hub's event loop blocks for 45–50 s while it builds a `bitget 1440m x30` candle snapshot (observed on the box 2026-10-09), and a 15 s probe timed out on a healthy service. A preflight or verify that still reports a health timeout is re-run once; never restart the service to clear it. The block itself is a Hub defect (a snapshot build running on the event loop) and is a follow-up on the Hub, not something this runbook works around further.

### 5. Before-listings by hand (box, read-only; for the deployment record)

```
ls -la /opt/wickhunter-hub/data /opt/wickhunter-hub/releases | tee $STAGE_ROOT/listing-before.txt
find /opt/wickhunter-hub/data -type f | wc -l | tee -a $STAGE_ROOT/listing-before.txt
python3 -c 'import json;print("licences",len(json.load(open("/opt/wickhunter-hub/data/licenses.json"))))' | tee -a $STAGE_ROOT/listing-before.txt
sha256sum /opt/wickhunter-hub/releases/latest.json /opt/wickhunter-hub/releases/*.tar.gz | tee -a $STAGE_ROOT/listing-before.txt
for u in wickhunter-hub liqhunter liqhunter-marketplace-api liqhunter-marketplace-worker nginx postgresql postgresql@18-main; do systemctl show $u --property=Id,ActiveState,MainPID,InvocationID,NRestarts; done | tee $STAGE_ROOT/services-before.txt
curl -sS --noproxy '*' --max-time 10 http://127.0.0.1:8091/api/health | tee $STAGE_ROOT/health-before.json
```

### 6. Deploy (box; the single mutation)

```
cd $STAGE_ROOT
python3 -I deploy-hub-0491.py $PROTECTED [same --data-backup-exclude as step 4] deploy --stage $STAGE_ROOT/stage --confirm-version 0.4.91 \
  2>&1 | tee $STAGE_ROOT/deploy-$(date -u +%Y%m%dT%H%M%SZ).txt
```
Order inside: preflight again → in-progress marker → runtime-file + env backup (verified) → `systemctl stop` + natural-exit/PID/cgroup proof → data tarball (verified member by member) + `recovery.json` → replace files (exclusive temp + atomic rename) and move removals aside → write `data/hub-build.v1.json` → prove data/ untouched otherwise → `systemctl start` → health on literal loopback tied to the new MainPID/InvocationID, exact version and commit → protected paths/services/licence counts unchanged → `receipt.json`. Downtime is stop + data backup + start (the data backup dominates on a large `candles/`).

On success the last line is `{"ok":true,"result":"deployed-and-verified",...,"oldPid":...,"newPid":...}` and `$STAGE_ROOT/stage/receipt.json` exists. On failure see "If deploy fails" below — **do not re-run it**.

### 7. Verify (box, read-only; repeatable) and after-listings

```
python3 -I deploy-hub-0491.py $PROTECTED [same --data-backup-exclude] verify --stage $STAGE_ROOT/stage | tee $STAGE_ROOT/verify-$(date -u +%Y%m%dT%H%M%SZ).txt
ls -la /opt/wickhunter-hub/data /opt/wickhunter-hub/releases | tee $STAGE_ROOT/listing-after.txt
find /opt/wickhunter-hub/data -type f | wc -l | tee -a $STAGE_ROOT/listing-after.txt
python3 -c 'import json;print("licences",len(json.load(open("/opt/wickhunter-hub/data/licenses.json"))))' | tee -a $STAGE_ROOT/listing-after.txt
sha256sum /opt/wickhunter-hub/releases/latest.json /opt/wickhunter-hub/releases/*.tar.gz | tee -a $STAGE_ROOT/listing-after.txt
for u in wickhunter-hub liqhunter liqhunter-marketplace-api liqhunter-marketplace-worker nginx postgresql postgresql@18-main; do systemctl show $u --property=Id,ActiveState,MainPID,InvocationID,NRestarts; done | tee $STAGE_ROOT/services-after.txt
nginx -t && curl -sS --max-time 10 "$(sed -n 's/^HUB_PUBLIC_ORIGIN=//p' /etc/wickhunter-hub/env)/api/health"   # through nginx, from the box or the workstation
journalctl -u wickhunter-hub -n 40 --no-pager                      # the clean stop and the new start, no restart loop
```

### 8. Record

Copy `receipt.json`, the preflight/deploy/verify transcripts and the before/after listings off the box; add the receipt to the repo as `docs/HUB-0491-DEPLOYMENT.json` (the 0.4.64 precedent). The receipt holds hashes, PIDs, invocation ids and paths only — no token, no key, no env value.

## Verification checklist

| Check | Expected | Where it is proven |
| --- | --- | --- |
| Health 200 with expected version and commit | `version` = `packageVersion` = `build.packageVersion` = `0.4.91`; `build.commit` = `QUALIFIED_COMMIT`; `ok:true` | `deploy` (`await_ready`), `verify` (`health.identity`), step 7 curl |
| Answer came from the new process | MainPID ≠ old PID, InvocationID ≠ old invocation, every listener on 8091 owned by the new MainPID, PID/invocation/NRestarts stable across the probe | receipt `new.listener`, `original` vs `new`; `verify` (`service.identity`, `health.listener`) |
| Original process exited naturally | `ExecMainCode=exited`, `ExecMainStatus=0`, `Result=success`, `MainPID=0`, `ControlPID=0`, no job; PID gone; cgroup absent or empty with `populated 0` | receipt `stopProof`; journal shows the clean stop |
| Data dirs intact | `data/` listing after stop == listing before start except `hub-build.v1.json`; after-start listing count ≥ before (the Hub appends its own ledgers); step-5/7 listings compare | receipt `dataUntouchedExceptBuildRecord`, `dataListingAfterStop`/`AfterStart`; `listing-before/after.txt` |
| Licence count unchanged | `licenses.json` and `revoked.json` entry counts equal before and after | receipt `licenceCountsBefore/After`; `verify` (`data.licences`); step 5/7 |
| Release shelf unchanged | fingerprint of `releases/` identical; `latest.json` and tarball sha256 identical in step 5/7 | receipt `protectedFingerprintsBefore/After` |
| Alpha tree and identity files unchanged | fingerprints of `/opt/liqhunter/*` and every `/etc/wickhunter-hub/*.env`, `/etc/liqhunter/marketplace-*.env` identical | same |
| Existing services still running, not restarted | `liqhunter`, `liqhunter-marketplace-api`, `liqhunter-marketplace-worker`, `nginx`, `postgresql`: same ActiveState, MainPID, InvocationID before and after | receipt `protectedServicesBefore/After`; `services-before/after.txt` |
| Installed bytes are the qualified bytes | every manifest file's sha256 == `after`; `installedRuntimeSha256` == `runtimeBundleSha256`; `installedTreeSha256` == `buildTreeSha256` | receipt; `verify` (`runtime.files`, `runtime.tree`) |
| Backups exist and were verified before replacement | `backup/data-*.tar.gz` (every member re-hashed), `backup/runtime/…`, `backup/env-file`, `backup/recovery.json`, `backup/build-record-before.json` | receipt `dataBackup.verified`, `runtimeBackup`, `recovery` |
| Source/qualification identity | `sourceTarballSha256`, `sourceTree`, `qualificationSha256`, `manifest.sha256` in the receipt match the workstation copies | receipt `manifest` |

## If deploy fails

The operator prints `DEPLOY FAILED in phase '<phase>': …`, writes `$STAGE_ROOT/stage/deploy-failed-<ts>.json`, prints the manual rollback recipe (or states that nothing was replaced), leaves `deploy-in-progress.json` in place and exits 2. It never retries and never rolls back.

1. Read the failure file: `phase`, `error`, `replaced` (files already swapped), `retired`, `serviceStateNow`.
2. Decide by phase:
   * `runtime-backup`, `stop`, `data-backup` — nothing under `/opt/wickhunter-hub` was replaced. If the service is stopped, inspect `journalctl -u wickhunter-hub -n 80 --no-pager`, then `systemctl start wickhunter-hub` by hand and confirm `/api/health` reports `0.4.90`. A stop that did not prove a natural exit (SIGKILL escalation, lingering PID, populated cgroup) is a Hub defect to investigate before any new attempt.
   * `install`, `build-record`, `data-proof` — the tree is partially or fully 0.4.91 and the service is stopped. Either finish by hand only after understanding the error (not recommended) or roll back (below).
   * `start`, `post-verify` — 0.4.91 is installed and may be running but failed identity/protection checks. Roll back (below) unless the failure is a protected-service drift you can account for.
3. Never re-run `deploy` against the same stage; a new attempt needs a new `baseline` (the tree moved) and a new stage.
4. Keep the stage directory whole: it is the evidence.

## Manual rollback procedure (code only; data/ is not restored unless it was damaged)

The exact lines, with the real paths and expected hashes, are in `$STAGE_ROOT/stage/backup/recovery.json` → `manualRollback`, and `python3 -I deploy-hub-0491.py print-rollback --stage $STAGE_ROOT/stage` prints them without executing anything. The shape:

```
systemctl stop wickhunter-hub
systemctl show wickhunter-hub --property=ActiveState,SubState,MainPID,ControlPID,Job,Result,ExecMainCode,ExecMainStatus   # inactive/dead/0/0//success/exited/0
# for every replaced file:
install -o <uid> -g <gid> -m <mode> $STAGE_ROOT/stage/backup/runtime/<path> /opt/wickhunter-hub/<path>
sha256sum /opt/wickhunter-hub/<path>                              # want the manifest "before" hash
# for every file new in 0.4.91:
mkdir -p $STAGE_ROOT/stage/backup/rolled-back-new-files/<dir> && mv -n /opt/wickhunter-hub/<path> $STAGE_ROOT/stage/backup/rolled-back-new-files/<path>
# for every removal (moved aside at $STAGE_ROOT/stage/backup/retired/<path>):
install -o <uid> -g <gid> -m <mode> $STAGE_ROOT/stage/backup/runtime/<path> /opt/wickhunter-hub/<path>
# the build record:
install -o wickhunter-hub -g wickhunter-hub -m 600 $STAGE_ROOT/stage/backup/build-record-before.json /opt/wickhunter-hub/data/hub-build.v1.json
systemctl start wickhunter-hub
curl -sS --noproxy '*' --max-time 10 http://127.0.0.1:8091/api/health      # want "version":"0.4.90" and the previous commit
systemctl show wickhunter-hub --property=MainPID,InvocationID,NRestarts,ActiveState
```

Data compatibility caveat: 0.4.91 persists additive billing fields (an exact-event digest and the checkout watermark, `docs/incidents/2026-10-09-initial-subscription-term.md`). Rolling the CODE back to 0.4.90 leaves those fields in place; confirm with the billing reviewer that 0.4.90 ignores them before rolling back after any live traffic. Restoring `data/` from `backup/data-*.tar.gz` discards every check-in, lease event and billing event since the backup and is only for a damaged data directory: `tar -tzf` first, extract into a scratch directory, compare, then copy individual files with `install -o wickhunter-hub -g wickhunter-hub -m 600`. The lease-ledger reader guard from the 0.4.62 era (`scripts/prepare-hub-audit-rollback.mjs`) is unrelated to this change and is not run.

## Left to fill in later (summary)

* `QUALIFIED_COMMIT` and `QUAL_FILE` (after the billing review).
* The PostgreSQL unit name; whether `candles/` must be excluded from the data backup.
* The step-5/7 by-hand listings and the receipt, to be committed as `docs/HUB-0491-DEPLOYMENT.json`.
