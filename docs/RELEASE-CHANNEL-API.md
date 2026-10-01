# Customer release channel API

This protocol is additive. The existing customer endpoints continue serving the current Beta shelf for legacy installations. New channel-aware clients use the endpoints below only after their own settings UI has persisted an explicit channel selection. The Hub channel routes remain dark unless `HUB_RELEASE_CHANNEL_ROUTING_ENABLED=true`.

## Channel heads

Configure Beta with `HUB_RELEASES_DIR` and Production with `HUB_PRODUCTION_RELEASES_DIR`. Production must use a separate directory; an unset, blank, invalid, or Beta-aliasing Production shelf is unavailable. The Hub does not fall back from a missing Production head to Beta. A missing channel head returns `404` with `status: "unavailable"`.

`GET /api/releases/{channel}/latest` returns the signed manifest for `beta` or `production`. Send:

- `x-license: <signed license token>`
- `x-release-channel: beta|production`, matching the path
- `x-early-access-opt-in: true` when requesting Beta

The Hub requires the `earlyAccess` flag to be true in that exact license's `flags.json` row before it serves Beta. The admin console's **Early Access eligibility** control changes only this Hub eligibility; it does not enroll the customer, publish a release, or grant Marketplace access. Global/default flags never grant Early Access. A customer remains on Production unless the app separately records an explicit Beta choice and sends the opt-in header. Alpha is private and returns `404` through customer routes.

The successful response contains the signed manifest plus the legacy-compatible unsigned `ok` field. `x-release-status` is transport metadata: `update-available` or `current-same-artifact`. It is not part of the signature. A client verifies the manifest after removing only the `ok` envelope, then checks that `manifest.channel` matches its selected channel.

`GET /api/releases/{channel}/download/{latest|signed-file}` uses the same headers and access checks. It serves only the exact file named by that channel's currently verified signed `latest.json`; it never serves another channel's file or an arbitrary archive. For Production, a client that supplies installed identity (`installedChannel`, `installedVersion`, `installedBuildId`, `installedSha256`) also receives the forward-only transition check before a download:

- `200` with `x-release-status: update-available` when Production is newer;
- `200` with `x-release-status: current-same-artifact` in metadata, or `204` on download, when the signed Production manifest names the same archive bytes and version;
- `409` with `status: waiting-for-production` when Production is older, has a different archive at the same version, or the claimed installed identity cannot be verified from a signed archived Beta/Production manifest.

The client must keep its installed Beta artifact and pin intact on `waiting-for-production`; it must never downgrade to satisfy a channel change. A later Production request can offer an update once the signed Production head is strictly newer, or can become a no-op when it is byte-for-byte the same artifact. The installed identity fields are checked against a signed, archived manifest and its artifact digest; client-supplied version text alone is not trusted.

## Compatibility and current controls

`GET /api/latest`, `/download/latest`, and existing `/download/<file>` retain their current single-Beta behavior for clients that do not know the channel protocol. Check-in still reports the legacy Beta version. The operator Alpha app uses its Git self-updater and must not call a customer release route.

The Hub does not install or restart customer services as a result of channel selection or publication. The Promotion publisher remains separately gated and automatic Production promotion remains disabled by default. Enabling channel routing does not publish a Beta or Production release. The current launch keeps channel routing off until the app stores the selected channel and sends the matching contract above.
