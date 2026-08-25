# releases/ — the beta build drop directory

This directory is the hub's distribution shelf. It is live state on the VPS
(`/opt/wickhunter-hub/releases/`), never populated from git.

## Contract (the bot repo's release step writes these)

```
releases/
  wickhunter-beta-<version>.tar.gz   # the built bot: dist/, package.json,
                                     # package-lock.json, public/, scripts/ —
                                     # app at the ARCHIVE ROOT, no data/,
                                     # no node_modules/
  latest.json                        # signed wickhunter.release.v1 manifest;
                                     # legacy version/file/sha256 stay top-level
```

Publish order matters: copy the tarball FIRST, write `latest.json` LAST
(atomically — write a temp file, then `mv`). `latest.json` is the pointer;
until it moves, testers keep getting the previous build. Old tarballs may stay
for rollback (point `latest.json` back at one) and are served by exact
filename to any valid key.

`latest.json` binds product, channel, platform, architecture, version, build
id, filename, SHA-256, issue time and minimum updater protocol. Its `signatures`
array carries `kid`, `alg: "Ed25519"` and a base64url signature over RFC 8785
canonical JSON with the whole signatures field removed. The Hub holds only the
public keyring in `HUB_RELEASE_PUBLIC_KEYS_JSON`; the dedicated private release
key stays offline and is never a Hub setting.

The Hub independently verifies the signature, freshness, target and tarball
hash before serving `latest`. The installer and signed-aware updater verify
again before extraction/deployment. `GET /download/latest?key=<token>` resolves
only through an authenticated manifest; `GET /api/latest?key=<token>` adds an
unsigned `ok:true` compatibility envelope that new clients exclude from the
signed bytes.

Build and sign in the bot repo with the offline environment documented in
`docs/SIGNED-RELEASES.md`, then publish:

```
scripts/publish-beta.sh /opt/wickhunter-hub/releases
```

Rollout is Hub-first but the signed manifest comes before the Hub restart:
sign the currently published artifact, configure only its public key on the
Hub, atomically publish the signed manifest, deploy the Hub, then publish the
first signed-aware app. Old clients ignore the additive fields; a new client
talking to an old/unsigned Hub refuses only the update and keeps its current
version running.
