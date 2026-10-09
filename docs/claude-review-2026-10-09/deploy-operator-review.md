# Review of `scripts/deploy-hub-0491.py` against the handoff findings

Date: 2026-10-09. Subject: the Hub-only 0.4.90 → 0.4.91 deployment operator that
replaces the unexecuted draft `deploy-hub0491.py` left on the previous team's
workstation. The precedent is `scripts/deploy-audit-hub.py` (0.4.62/0.4.64, see
`docs/HUB-0464-DEPLOYMENT.json`); what that operator did right is kept
(root-owned 0700 stage, per-file before/after hashes, private verified copies,
durable code backup, protected fingerprints of the Alpha tree and the release
shelf, exact-version health). What the review of the draft demanded is listed
below, finding by finding, with the function that satisfies it. Function names
are the anchor; line numbers move.

Self-test: `python3 scripts/deploy-hub-0491.py --self-test` (runs
`scripts/deploy-hub-0491-selftest.py` against a fake install tree and a fake
systemd whose `systemctl start` launches a real child process serving
`/api/health` on loopback). Result line at the time of writing:
`SELF-TEST: 13 passed, 0 failed`.

| # | Finding (quoted from the handoff) | How the operator satisfies it | Where |
| --- | --- | --- | --- |
| 1 | "typed empty-stop checks" | Every check is a `Check(name, status, detail)` whose `status` is one of `pass`/`fail`/`unknown` — the constructor refuses anything else and refuses an empty name or detail. `Checklist.render()` refuses to print an empty list. `preflight` emits 20+ named checks; a refusal is never a bare stop: `run_preflight` exits 2 (a fail) or 3 (only unknowns) and says so. `deploy` re-runs the same checklist and refuses on anything but all-pass. | `Check`, `Checklist`, `preflight`, `run_preflight`, `run_deploy` |
| 2 | "complete original natural exit/process/cgroup drain proof" | Before the stop: `capture_original` records the ORIGINAL MainPID, InvocationID, ControlGroup, `/proc/<pid>/stat` start time, NRestarts, and proves the PID sits inside its own cgroup. After `systemctl stop`: `judge_stop_state` requires `ActiveState=inactive`, `SubState=dead`, `MainPID=0`, `ControlPID=0`, `Job=""`, `Result=success`, `ExecMainCode=exited`, `ExecMainStatus=0` (the Hub's `main.ts` exits 0 on SIGTERM, so a SIGKILL escalation or a non-zero exit is a refusal, not a pass); then the PID must be gone or carry a different start time (`pidFate`), and the cgroup must be absent or have empty `cgroup.procs` and `populated 0` across descendants (`cgroup_state`). Everything is bounded by `STOP_SETTLE_SECONDS`; any disagreement raises before a single file is replaced. The self-test drives SIGKILL, a lingering PID and a stuck cgroup and expects refusals. | `capture_original`, `stop_and_prove`, `judge_stop_state`, `Host.cgroup_state`, `Host.proc_starttime` |
| 3 | "bounded subprocess calls" | The only process-spawning path is `Host.run`: argv list, `shell=False`, `stdin=DEVNULL`, `capture_output`, a mandatory `timeout`, and a fixed minimal environment (`SAFE_ENV`: PATH/LANG/LC_ALL/SYSTEMD_PAGER…, no proxy variables). `systemctl` is only ever invoked as `show`, `stop`, `start` with a regex-validated unit name. `main` turns a `TimeoutExpired` into a refusal. No `os.system`, no `shell=True` anywhere. | `Host.run`, `Host.systemctl_show`, `Host.systemctl`, `main` |
| 4 | "literal-loopback bounded no-proxy/no-redirect health tied to new PID/invocation and exact commit" | `fetch_health` opens `http.client.HTTPConnection("127.0.0.1", port, timeout=…)` — the literal is in the code and `http.client` has no proxy support at all; `scrub_proxy_env` additionally deletes every proxy variable at start of every mode (the self-test sets a dead `HTTP_PROXY` and still reaches the fake Hub). Any status other than 200 is a refusal (3xx explicitly "redirect refused"); the body is capped at 1 MiB. `judge_health_body` requires `ok:true`, `version`, `packageVersion`, `build.packageVersion` and `build.commit` to equal the manifest exactly. `await_ready` only accepts a MainPID ≠ the original and an InvocationID ≠ the original, then `prove_listener` requires every LISTEN socket on the Hub port to be an inode held by that MainPID (`/proc/net/tcp*` + `/proc/<pid>/fd`), and the MainPID/InvocationID/NRestarts must be identical before the request, after it, and after a stability window. | `fetch_health`, `judge_health_body`, `await_ready`, `prove_listener`, `scrub_proxy_env` |
| 5 | "fresh service/environment/path authority binding" | `ServiceFacts` reads everything from `systemctl show` at run time: `FragmentPath` (must be a real file under a system unit directory; hashed), `DropInPaths`, `User`/`Group` (resolved to uid/gid), `WorkingDirectory` (→ install dir; must be a real root-owned directory), the first required `EnvironmentFile=` (→ env file; must be 0600-class), `ExecStart` (must start `dist/src/main.js` under that WorkingDirectory), `KillSignal`, `TimeoutStopUSec` (→ the stop budget). The port, data dir and releases dir come from the bound env file (`HUB_PORT`, `HUB_DATA_DIR`, `HUB_RELEASES_DIR`) exactly as `src/config.ts` reads them. `NeedDaemonReload=yes` is a refusal. The baseline captured earlier must agree with the live binding (`baseline.service` check). No path constant is used for the live service; `DEFAULT_SERVICE` is only the unit NAME, overridable with `--service`. | `ServiceFacts`, `parse_env_file`, `parse_exec_argv`, `preflight` (`baseline.service`) |
| 6 | "trusted no-follow exclusive temporary paths" | `exclusive_temp` opens `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC` with a random name INSIDE the trusted directory (the 0700 root-owned stage, or the target's own validated parent for the atomic replace); `write_exclusive` uses the same flags for every private file; nothing is ever created under `/tmp`. `check_stage_dir` requires the stage to be a real root-owned 0700 directory on a non-tmpfs/ramfs filesystem (`/proc/self/mountinfo`); `check_stage_tree` refuses any symlink, special file, foreign owner or group/other-writable entry under it; `safe_target` and `stage_file` walk every ancestor and refuse symlinks and writable directories. Reads use `O_NOFOLLOW` and prove the inode/size/mtime did not move during the read (`read_regular`). | `exclusive_temp`, `write_exclusive`, `check_stage_dir`, `check_stage_tree`, `stage_file`, `safe_target`, `read_regular`, `install_file` |
| 7 | "exact source/runtime/qualification receipt hashes" | The manifest (built by `package`) carries `sourceCommit`, `sourceTree` (git tree id), `sourceTarballSha256` (the shipped `source.tar.gz`), `qualificationSha256` (the shipped `qualification.json`), `baselineSha256`, per-file before/after SHA-256, `runtimeBundleSha256` (digest of all after hashes) and `buildTreeSha256` (digest of the whole built runtime tree). `load_stage` re-hashes every one of them on the box; `deploy` records in `receipt.json` the manifest hash, all of the above, `installedRuntimeSha256` (digest of the bytes actually on disk after install — must equal `runtimeBundleSha256`), `installedTreeSha256` (must equal `buildTreeSha256` when `fullTree`), the unit file hash, the env-file hash, PIDs, invocation ids, cgroup, timestamps per phase, version and commit. | `run_package`, `validate_manifest`, `load_stage`, `runtime_bundle_digest`, `tree_digest`, `runtime_tree_hashes`, `run_deploy` |
| 8 | "verified recoverable backups before replacement" | Before the stop: every file to be replaced or retired is copied into `<stage>/backup/runtime/…` and re-hashed against its `before` hash; the env file is copied (0600, root) and hash-checked. After the stop (so the copy is quiescent) and still before any replacement: `backup_data_dir` writes `data-<ts>.tar.gz` (0600) and `verify_data_backup` re-opens the archive end to end, re-hashing every regular member against the hash taken from the source and refusing a missing or extra member (the self-test tampers a hash and expects the refusal); the hashed listing is written beside it; `recovery.json` holds the manual restore recipe. Only then does `install_file` run. The pre-existing `hub-build.v1.json` is additionally copied to `backup/build-record-before.json`. | `backup_runtime_files`, `backup_data_dir`, `verify_data_backup`, `write_recovery`, `rollback_recipe` |
| 9 | "Preserve data, licenses, release shelf, Alpha/Marketplace identities and all original failure evidence" | `data/` is never written except `hub-build.v1.json` (named in the receipt as `dataWrites`, exactly what `install-hub.sh` + `bin/buildinfo.ts` write; without it `/api/health` reports `commit:null` and the deploy would refuse itself). `tree_listing` after the stop and again just before the start must differ ONLY in that file (`dataUntouchedExceptBuildRecord`). Licence and revocation counts are read before and after and must be equal. `protected_fingerprints` hashes the Alpha tree (`/opt/liqhunter/{dist,src,public,scripts,migrations,package*.json,.deployed-commit,.deployed-at,bin,native,.native}`), every Hub code root not named in the manifest, the whole release shelf (`releases/`), the env file, the unit file and drop-ins, and every Marketplace/Alpha identity file (`IDENTITY_FILES`: `/etc/wickhunter-hub/marketplace-state.env`, `marketplace.env`, `support.env`, `/etc/liqhunter/marketplace-{common,api,worker,migrate}.env`, `/etc/liqhunter/marketplace.env`) before and after; any drift fails the post-verify. Protected services (`liqhunter`, `liqhunter-marketplace-api`, `liqhunter-marketplace-worker`, `nginx`, `postgresql`) must keep their MainPID/InvocationID/ActiveState. Nothing is ever deleted: a manifest removal MOVES the file into `backup/retired/`, a failed private write is parked under `.partial-*`, failure evidence accumulates as `deploy-failed-*.json`, and a stage that carries any marker is refused rather than cleaned. | `run_deploy` (data-proof and post-verify phases), `protected_fingerprints`, `protected_service_facts`, `retire_file`, `write_exclusive`, `stage_markers` |
| 10 | "Do not run old pins or automatically retry/roll back" | There is no retry loop around any mutation and no rollback code path at all: on any exception `run_deploy` writes `deploy-failed-<ts>.json` (phase, error, every fact captured, the list of files replaced so far, the current unit state), prints the manual recipe from `recovery.json` (or states that nothing was replaced), leaves the in-progress marker in place and exits 2. The self-test proves that a wrong-identity health answer after the start leaves the NEW files in place, the NEW process running, and issues exactly one `stop` and two `start`s. `print-rollback` only prints. A new stage must be produced for any second attempt; `baseline` must be re-taken because the live tree has moved. | `run_deploy` (except clause), `rollback_recipe`, `run_print_rollback` |
| 11 | "Deploy the Hub-only update once … verify health/build identity and protected data/services" | One `deploy` invocation performs the single mutation; `verify` re-binds the service fresh and re-checks health identity (version + commit), MainPID/InvocationID against the receipt, listener ownership, installed file hashes, runtime tree digest, protected fingerprints, protected services, licence counts and the build record. The runbook lists the manual before/after listings. | `run_deploy`, `run_verify` |
| 12 | Idempotency guard | `stage_markers` refuses a stage holding `deploy-in-progress.json`, `receipt.json`, `deploy-finished-*.json` or any `deploy-failed-*.json`; the marker is created `O_EXCL` as the first act of `deploy` and renamed (never deleted) to `deploy-finished-<ts>.json` only after the receipt is durably written. `--confirm-version` must equal the manifest's `expectedVersion`. | `stage_markers`, `run_deploy` |

## Adversarial re-read, and what it changed

* A programming error inside `deploy` (first caught by the self-test as an
  `IndexError` in a refusal message) escaped the original `except` tuple as a
  bare traceback — no evidence file, no recipe. `run_deploy` now catches
  `Exception`: whatever goes wrong mid-deploy leaves `deploy-failed-*.json` and
  prints the recipe.
* `await_ready` originally retried on some `DeployError` messages by string
  matching. Now every `DeployError` from inside the probe (non-200, redirect,
  wrong identity, foreign listener, moved PID) is definitive; only transport
  errors (connection refused/reset while Node binds) are waited out, bounded by
  `READY_SECONDS`.
* The stop-settle loop waited on a compound condition that could exit early on
  `Job=""` while `ActiveState=deactivating`; it now waits while the unit is
  deactivating or has a job, then judges once.
* `retire_file` used `os.rename` into the stage, which fails with `EXDEV` when
  the stage is on another filesystem; it now falls back to copy + verify +
  unlink of the original, so the moved-aside evidence always exists.
* A failed private write originally unlinked the partial file (the precedent's
  behaviour); it now parks it as `<name>.partial-<random>` and names it — the
  operator never deletes.
* The proxy test in the self-test assumed a clean environment; this container
  has the agent proxy set, which is exactly the situation the scrub exists for.
  The assertion now checks a superset and that no proxy variable survives.

## What is NOT satisfied, or is deliberately left to the operator

* **The box was not reachable from this container**: no live preflight, stop
  or deployment has occurred. Everything above is proven against a fake install
  and a fake systemd; the real `systemctl show` property spellings are the
  ones `templates/install.sh` (v0.4.86) already relies on.
* **The qualified commit SHA is a placeholder** until the billing review
  finishes; `validate_manifest` refuses the all-zero placeholder and `package`
  refuses a build dir whose `HEAD` ≠ `--commit`.
* **`postgresql.service`** is the distribution's default unit name; if the box
  runs `postgresql@16-main.service`, pass it with `--protected-service` (the
  absent default is reported, typed, as `absent`, and `--require-service`
  turns an absence into a failure).
* The data backup copies **all** of `data/` by default (candles included). If
  disk space forbids, `--data-backup-exclude candles` is the only subtree the
  README calls reproducible ("seeds go cold until re-collected (hours, not
  fatal)"); the exclusion is recorded in the receipt and the preflight's
  free-space check accounts for it.
* The `source.tar.gz` shipped in the stage is whatever the packager is handed
  (`git archive <commit>` is the recommended producer); its hash is recorded,
  its content is not re-derived on the box.

## Findings from the first live run on the Hub box (2026-10-09, after this review)

1. **The stop proof refused a natural stop.** `judge_stop_state` expected `ExecMainCode=exited`; `systemctl show` answers the exit's si_code as a digit (`1` = CLD_EXITED, `2` = CLD_KILLED, `3` = CLD_DUMPED) and only `systemctl status` renders the word. The first live `systemctl stop` was refused as `ExecMainCode='1' (want 'exited')` with the service already cleanly stopped. Fixed: `EXEC_MAIN_CODE_EXITED = "1"`, the self-test's fake host answers digits, and a new assertion refuses the word. The review's self-test could not see this because its fake host was written from the same wrong reading of the property.
2. **`--protected-service` replaces the default list** and the global flags must precede the subcommand; the runbook's bracketed examples put them after it. Runbook corrected (`$PROTECTED` names all five defaults plus `postgresql@18-main.service`, the unit on the box).
3. **The Hub's event loop blocks 45–50 s** while it builds a `bitget 1440m x30` candle snapshot, so the 15 s health probe timed out on a healthy service. `HEALTH_TIMEOUT` is 90 s. The block is a Hub defect to fix on the Hub (the snapshot build runs on the event loop); it is recorded here, not worked around further.

