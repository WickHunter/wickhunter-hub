# Release promotion operations

Production promotion is currently manual and disabled. Do not publish Beta or
Production, enable `HUB_RELEASE_AUTO_PROMOTION_ENABLED`, install a timer, or
place a signing private key on the Hub as part of this launch.

The Hub stores only `HUB_RELEASE_PUBLIC_KEYS_JSON`. Release archives,
channel-specific manifests, and promotion attestations are signed outside the
Hub. `bin/publish-release.ts` verifies those signatures and the evidence; it
does not create signatures.

## First Production rollback baseline

The first Production promotion needs a prior, state-compatible rollback
artifact even though the Production head is still empty. Before a future
promotion is considered:

1. Select the last known-good customer release and verify its artifact hash,
   deployment record, restart/health protocol, settings compatibility, and
   native-core protocol against the state that will exist after the candidate.
2. Have the offline release signer produce a Production-channel manifest for
   that rollback archive. Keep its immutable
   `manifest-<sha256>.json` and named artifact together in a protected rollback
   shelf separate from both active channel shelves. Do not use an unsigned
   copy or a Beta manifest as the Production rollback identity.
3. Have the authorized evidence signer attest the exact rollback build ID and
   digest, state compatibility, settings version, restart/health protocol,
   native-core protocol, and core digest. Keep the attestation's signing key
   outside the Hub. The Hub must find and verify the signed Production
   manifest and artifact before it can publish the first Production head.
4. Keep the active Production shelf empty until a separately authorized
   promotion has passed the seven-day exact-Beta soak, matching test/source
   evidence, fresh health evidence, zero unresolved bugs, and rollback checks.

The publisher intentionally does not require an existing Production
`latest.json`; the protected offline rollback shelf is the bootstrap baseline.
The signed attestation must identify that exact archived Production artifact.

## Manual promotion checklist for a future authorized release

- Confirm the candidate Beta `latest.json`, its SHA-addressed manifest, and
  archive all verify under the configured public keyring. Confirm the Hub's
  control state records that same build and digest for at least seven days.
- Confirm the candidate Production manifest has the same archive digest,
  build ID, source commit, version, and minimum updater protocol as Beta.
- Confirm current test, health, and feedback evidence, plus the signed
  rollback attestation and its archived Production target.
- Keep Beta and Production shelves physically distinct. Keep the control-state
  path shared with Beta's `.release-control.v1.json` so the admin overview and
  publisher use the same soak record.
- Only after a separate release authorization, run the publisher once with
  `--channel production`, the exact `--beta-releases-dir`, `--control-state`,
  `--promotion-attestation`, `--feedback-file`, and
  `--rollback-releases-dir`. Set the production-enable environment variable
  only for that explicit invocation. Review its result and the resulting
  immutable manifests and control head.

The publisher installs immutable artifact, manifest, and evidence objects
before changing `latest.json`. A durable pending marker records the old and
intended pointer/control bytes. The publisher commits control state first and
moves `latest.json` last. A failed commit restores both prior files and their
modes. A single-instance lock refuses concurrent publishers. Unreferenced
immutable files left by a refused or failed publication are safe to retain and
do not change what customers receive.

After an interrupted process, the next publisher validates the pending marker
against the exact shelf and control-state paths. If only control state advanced,
it restores the recorded prior state and leaves the pointer and Beta soak
untouched. If both pointer and control state reached the signed target, it
verifies the signature, artifact digest, and matching control head before
clearing the marker. Any other combination remains held for manual inspection;
do not remove a stale lock or marker until the process and on-disk state have
been reviewed. Recovery never invents or backdates a soak interval.

## Future automation boundary

No scheduler or timer is installed by this preparation. Any later automation
must be separately authorized and reviewed. Prepare its runner outside the
Hub, default it to dry-run/disabled, use a single-instance lock, and require
fresh signed evidence for the exact Beta artifact on every run. Keep signing
private keys in the external signer or protected signing service; the Hub gets
public verification keys only. Do not activate a schedule until the first
Production rollback baseline and the manual promotion path have been exercised
and reviewed.
