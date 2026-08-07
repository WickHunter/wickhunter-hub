# wickhunter-hub

Admin hub for the Wick Hunter beta: license issuing/revocation, beta build
distribution, and tester check-in intake. **Contains no trading code** — it
runs on the same VPS as the bot (its own systemd unit, loopback-only on
`127.0.0.1:8091`, published by the existing nginx under `/hub/`).

Zero runtime dependencies: node builtins only. TypeScript + a hermetic test
suite gate every commit: `npx tsc && node tests/run-all.mjs`.

## Tester feedback

Beta bots POST bug reports / feature requests to `/api/feedback`, authenticated
by their own license token (genuine-but-expired may file; revoked/unknown may
not). Each report carries the tester's verified name, app version, install id
and a bounded tail of their Activity log (300 lines / 200 KB, oldest dropped).
The admin page lists them with a `new / discussing / fixed` status per row, and
**Export all** downloads the entire set — logs included — as one JSON file to
hand to your assistant for triage.

## License format v1 (pinned)

```
LHK1.<base64url(payload-json)>.<base64url(sig)>
payload: {"v":1,"id":"<uuid>","name":"<tester name>","exp":<unix-ms>,"iat":<unix-ms>,"plan":"beta"}
sig:     Ed25519 over the exact payload bytes carried in the token
```

The bot is built against exactly this. Any change gets a new `LHK2` prefix —
v1 is never mutated. The private key lives at `data/license-signing.key`
(mode 600, written only by keygen, never logged); the paired public key is
baked into the bot.

## Operator runbook

### 1. Install the hub (once, on the VPS)

```
git clone <this repo> /root/dev/wickhunter-hub
cd /root/dev/wickhunter-hub
sudo bash install-hub.sh
```

The installer: checks Node 22+, syncs to `/opt/wickhunter-hub`, builds, runs
keygen on first install (**copy the printed public key into the bot** — it is
what tokens verify against), generates `HUB_ADMIN_TOKEN` (echoed exactly
once; afterwards read it from `/etc/wickhunter-hub/env`), installs the
`wickhunter-hub` systemd unit, and health-checks with a retry loop.

**One manual step**: it never edits the live nginx config. Add inside the
existing `server { listen 443 ssl; ... }` block:

```
include /opt/wickhunter-hub/nginx/hub.locations.conf;
```

then `nginx -t && systemctl reload nginx`. Re-running `install-hub.sh`
upgrades in place and keeps `data/`, `releases/`, and the admin token.

### 2. Issue a key

Over SSH (no web UI needed):

```
cd /opt/wickhunter-hub
npm run issue -- --name "Ada Lovelace" --days 30
```

It prints the token, the expiry, and the ready-to-send install command.
Or use the admin page at `https://<vps-ip>/hub/admin` (enter the
`HUB_ADMIN_TOKEN` when prompted — it is held in page memory only).

### 3. Send the invite

The exact text a tester receives (the issue CLI/admin page prints the
personalised command):

> Hey `<name>` — you're in the Wick Hunter beta.
>
> You'll need a fresh Ubuntu 22.04+ VPS (1 GB RAM is plenty). On it, run this
> one command:
>
> ```
> curl -fsS "https://<vps-ip>/hub/install.sh?key=<TOKEN>" | sudo bash
> ```
>
> It installs Node, the bot, and HTTPS, then prints your dashboard URL and
> login when it finishes (about 2–3 minutes). It will ask you to choose a
> dashboard password (or press Enter to have one generated). Your key expires
> on `<date>`. To upgrade to a newer beta later, just re-run the same command
> — your settings and data survive.
>
> The key is yours alone — please don't share it. Your bot checks in with my
> hub (version + install id only) so I can see who's on what build and revoke
> keys if needed. Nothing else leaves your VPS.

### 4. Watch the roster

```
npm run list          # id, name, state, expiry, last check-in, version, ip
```

Same data on the admin page. Bots check in periodically; `lastSeen` is the
hub's clock, `ts` is the bot's claim.

### 5. Revoke

```
npm run revoke -- --id <uuid>      # ids from `npm run list`
```

Immediate for `install.sh`/downloads; the running bot learns at its next
check-in (`{ok:true,revoked:true}`). Check-ins from ids this hub never issued
are also answered `revoked:true` — fail safe.

### 6. Publish a beta release

Copy the built bot tarball + `latest.json` into `/opt/wickhunter-hub/releases/`
— tarball first, `latest.json` last (it is the pointer). Full contract and a
copy-paste publish snippet: [`releases/README.md`](releases/README.md).
Testers upgrade by re-running their install command.

### Where the data lives (and backup)

| Path | What | Loss means |
| --- | --- | --- |
| `data/license-signing.key` | Ed25519 private key, mode 600 | **every issued token orphaned** — back this up offline |
| `data/licenses.json` | registry of issued licenses | can't tell known ids from foreign ones |
| `data/revoked.json` | durable revocations | revoked keys work again |
| `data/roster.json` | compact last-seen per license | rebuildable from the ledger |
| `data/checkins.jsonl` | append-only check-in ledger | history gone |
| `releases/` | beta tarballs + `latest.json` | republish from the bot repo |
| `/etc/wickhunter-hub/env` | `HUB_ADMIN_TOKEN`, origin, port | regenerate via `install-hub.sh` |

Backup = the `data/` directory plus the env file. A nightly
`tar -czf - /opt/wickhunter-hub/data /etc/wickhunter-hub/env` shipped
anywhere private is enough; everything else is reproducible.

## HTTP surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health` | none | `{ok:true,version}` |
| `POST /api/license/checkin` | none (records everything) | bot phone-home; answers `revoked:true` for revoked/unknown ids |
| `GET /install.sh?key=` | valid token | personalised tester installer |
| `GET /api/latest?key=` | valid token | `{version,file,sha256}` |
| `GET /download/<file\|latest>?key=` | valid token | beta tarballs |
| `GET /admin` | none (page holds no secrets) | static admin page |
| `GET/POST /admin/api/licenses[/revoke]` | `x-hub-admin` header, constant-time | list / issue / revoke |

License keys travel in query strings by design (curl-pasteable); the hub never
logs a URL's query, and the shipped nginx snippet sets `access_log off` for
`/hub/`.

## Development

```
npm ci
npx tsc && node tests/run-all.mjs   # the gate before every commit
npm start                            # local hub on 127.0.0.1:8091
```

Tests are hermetic: each suite builds its own temp data/releases dirs and a
real hub on an ephemeral loopback port. Nothing in the repo tree is touched.

## Changelog

- v0.1.0 — initial hub: LHK1 licensing (issue/verify/revoke, Ed25519),
  check-in intake (ledger + roster), keyed install.sh + release downloads,
  admin surface (CLI, HTTP API, one static page), install-hub.sh with nginx
  snippet emission and retry-loop health check, tester install.sh template.
