# Customer installer recovery and startup verification

The personalized command is safe to rerun within its link validity window. A
support-issued reusable link stays attached to the same licence; it does not
create a second licence or bypass machine activation limits. Revoked or expired
links still refuse. Download the command successfully before running Bash;
`curl --fail-with-body` preserves a refusal reason that `curl -f` would hide.

An existing installation is handled before package installation or writes to
application files, its environment, licence, or current data:

- A running service is checked without a stop, restart, upgrade, or file write.
  Successful verification directs the customer to the authenticated app updater.
- A failed or inactive service can be started once only when its installed
  integrity document verifies against the Hub's trusted release keys, every
  signed file matches, its systemd unit starts that exact server entry, and no
  release operation or recovery is pending. MainPID and ControlPID must be zero,
  there must be no queued systemd job, and the exact cgroup must be absent or
  have empty process lists and `populated 0`, including descendants.
- A partial or altered installation, unrecognized unit, restarting service,
  surviving process, or unresolved release operation requires support recovery.
  The installer preserves all evidence and does not overwrite, force-kill,
  clear activation state, or restore old data.

Stopped recovery acquires the installed signed updater's existing
`release-operation.lock` contract before starting. A live guard owns the lock
through start and readiness. This is the only temporary write under existing
`data/`; financial state, credentials, licence and machine identity are retained.
Successful completion removes only its exact unchanged owner file and empty
lock directory after checking bytes, PID, boot ID and inode identity. Failed or
ambiguous recovery retains the lock evidence for support; it never reclaims a
stale or foreign owner. An outside lock would not coordinate the existing
updater, so it is not used.

Recovery starts the installed signed release, even when the public shelf names
another version. Upgrading a trading runtime requires the installed updater's
real graceful persistence and release-transition proof. An installer rerun is
not an alternate path around those requirements.

Startup requires the health version to match the signed artifact; an advertised
health build ID must also match. Every listener on the bot port must belong to
the current systemd MainPID. The service PID, invocation and restart count must
remain stable. The app's actual `data/release-readiness.json` must be fresh within
five seconds and match the signed build, native binary hash, current PID, a
nonempty context census, and a stable generation for ten seconds. A pending
transition nonce or missing readiness document is not accepted as success. The
45-second shared wait budget includes bounded service and HTTP probes.

Newly installed units disable systemd SIGKILL escalation and allow a bounded
five-minute graceful stop. Existing units are not rewritten during recovery.
Diagnostic output contains safe service metadata and recognized failure labels,
not raw journal lines, credentials, licence URLs, or account information.
For local investigation use `journalctl -u wickhunter -n 80 --no-pager`; the `-u`
option belongs to journalctl, not systemctl.

Public Beta 0.90.135 can still fail its mandatory Bybit bootstrap when Bybit
refuses the VPS IP with HTTP 403, including a restricted US IP. A script retry
does not change that runtime or the exchange's eligibility rules. HTTP 403 is
reported as a refusal with possible causes, never automatically as an IP rate
ban. Use a location and account eligible under the exchange's rules; support
must inspect the actual response before diagnosing another cause.

The private 0.90.172 preview has a separate empty-roster setup path: a fresh
installation with no stored accounts and no API credentials can expose setup
without starting default Bybit market feeds. Configured real accounts still
fail closed on a Bybit refusal. This does not promote 172 to the public Beta
shelf or claim a restricted account is ready to trade.
