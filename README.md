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

## Candle seed

The bot's Optimized Liquidation Bot computes per-pair entry bands from each
venue's own 1-minute history. Warming a full auto pair list from the venue takes
about 12 hours (~139,500 requests for ~643 pairs at 3.2 req/s) and every fresh
install pays it again. The hub collects that history once and serves it as a
signed download, turning the warm-up into one request per pair.

**The hub is a seed, never a source of truth.** Candles decide entry bands and
bands decide real orders, so a subtly wrong copy would give every user wrong
entries at the same moment instead of one install misbehaving. The bot therefore
re-checks the payload against the venue and discards the whole seed on any
mismatch. Three properties carry that weight:

- **Closed candles only.** Never a forming bar. Filtered against the hub's own
  clock in `dropUnclosed` and again in `CandleStore.write`, so it does not
  depend on any venue's framing being what we expect. Measured per venue:
  Bitget's `/candles` returns the forming bar and its `/history-candles` does
  not (we read the latter); Bitunix excludes it; Bybit includes it.
- **Per venue, per symbol, venue-native spellings.** Never normalised, never
  joined across venues. The same coin is `PEPEUSDT` on Bitget and
  `1000PEPEUSDT` on Bitunix — different books, different prices — and the live
  instrument lists differ by 168 symbols one way and 126 the other.
- **Completeness is stated, never inferred.** `lastClosedMs` is read off the
  newest slot actually filled, and `gaps` lists every missing sub-range
  explicitly. Storage keeps presence per minute, so "we have nothing after
  here" is never deduced from a short page.

### Wire contract v1 (pinned)

```
GET /api/candles/seed?venue=<bybit|bitunix|bitget>&symbol=<VENUE-NATIVE>&fromMs=<ms>&toMs=<ms>

{ "v":1, "venue","symbol", "interval":"1", "fromMs","toMs","lastClosedMs",
  "rows":[[openMs,open,high,low,close,volume],...], "gaps":[[fromMs,toMs],...],
  "keyId":"seed-1", "sig":"<base64 Ed25519>" }
```

`rows` oldest-first, strictly increasing, every `openMs` a multiple of 60000,
numbers not strings. `sig` is Ed25519 over the UTF-8 JSON of the object with
`sig` removed and keys in exactly this order — the verifier must reproduce it
byte-for-byte:

```
v, venue, symbol, interval, fromMs, toMs, lastClosedMs, rows, gaps, keyId
```

Errors: `400` bad venue or malformed window · `404` symbol not listed on that
venue · `503` nothing collected yet for it. **Never a 200 with empty `rows`** —
that would be indistinguishable from a genuinely empty window. Served gzipped
when the client accepts it.

`keyId` names the key that signed the payload — see **Signing key** below. It is
`seed-1` today. **Seeding requires a valid licence key** (`?key=`), like every
other download surface here: it is a licensed benefit and by far the heaviest
thing the hub serves. `HUB_CANDLE_REQUIRE_LICENSE=0` opens it for a local test
hub; nothing else in the licence path changes either way.

### Signing key

Seeds were signed with the licence key. That is sound only because of an
ordering nobody can see: a genuine SEED signature, re-wrapped as
`LHK1.<seed-canonical-bytes>.<sig>`, **passes the licence verifier's signature
check** — same key, same primitive — and is refused only afterwards, when the
verifier re-checks the payload SHAPE and finds no `id/name/exp/iat/plan`. The
separation therefore rests on the shape check running AFTER the signature check.
Invert that order, or relax the shape test, and every seed payload the hub has
ever served becomes a forgeable licence.

So candles get their own key: `data/candle-signing.key`, Ed25519, PKCS8 PEM,
mode 600, beside the licence key. Self-generated on first use — never in config,
never in an env var, never committed. `LicenseStore.sign()` is untouched and the
licence path is unchanged; the overlap has to stay available while the rollout
below is in flight.

**Which key signs is a switch, and the default is the OLD behaviour:**

| `HUB_CANDLE_SIGNER` | signs with | emits `keyId` |
| --- | --- | --- |
| unset / `license` | the licence key (`data/license-signing.key`) | `seed-1` |
| `candle` | the dedicated key (`data/candle-signing.key`) | `candle-1` |

Both halves move together — the keyId is derived from the signer, so there is no
second variable to forget. `HUB_CANDLE_KEY_ID` may still rename the key (for
rotation), but the hub **refuses to start** if that name is the one reserved for
the other signer: a payload signed by one key and labelled another verifies
nowhere, and the symptom shows up in someone else's process with no hint of the
cause.

**Throw the switch in this order, and not before.** The bot pins verifying keys
by `keyId` and refuses an unknown one, so a hub emitting `candle-1` too early
does not fail loudly — every seed is refused, every pair silently falls back to
a ~12-hour venue warm-up, and the feature dies quietly.

1. **Ship the hub change.** The key is generated on first use; its public half
   is printed once at startup, shown on the admin **Exchanges** panel with a
   copy button, and printed by `npm run candlekey` if you are on the box with a
   shell. Seeds are still signed by the licence key, still `seed-1`. Nothing on
   any bot changes.
2. **Paste the public key** into the bot's `OLB_SEED_KEYS` under keyId
   `candle-1`, **alongside** the existing `seed-1` entry — never instead of it.
   It is base64url of the 32 raw Ed25519 bytes, the same encoding as the bot's
   `LICENSE_PUBLIC_KEY_B64U`. It is a **public** key: copying it is safe. Every
   hub has its OWN key — take it from the hub you actually serve seeds from,
   never from a dev checkout.
3. **Ship a bot build** carrying that map, and let it reach the testers.
4. **Only then** set `HUB_CANDLE_SIGNER=candle` in `/etc/wickhunter-hub/env`
   and restart. Bots on the new build verify `candle-1`; bots still on the old
   build refuse — so step 3 has to be actually out, not merely tagged.

Rolling back is step 4 in reverse: unset `HUB_CANDLE_SIGNER`, restart, seeds are
`seed-1` again. Keep the `seed-1` entry in the bot until every install has been
on a `candle-1`-aware build long enough to say so.

### Turning collectors on

Off by default — collecting is hours of outbound requests and gigabytes on disk,
so it is a deliberate operator action, not something a hub upgrade starts doing.
In `/etc/wickhunter-hub/env`:

```
HUB_CANDLE_VENUES=bybit,bitunix,bitget
```

Optional: `HUB_CANDLE_RETENTION_DAYS` (30), `HUB_CANDLE_RPS` (3.2),
`HUB_CANDLE_SYMBOL_REFRESH_MS` (15m), `HUB_CANDLE_STALL_AFTER_MS` (10m),
`HUB_CANDLE_FAILING_AFTER` (5), `HUB_CANDLE_TICK_MS` (60s),
`HUB_CANDLE_TAIL_FILL_MIN` (150 — how much backlog a tail request waits for),
`HUB_CANDLE_SIGNER` (`license`) and `HUB_CANDLE_KEY_ID` (derived from the
signer) — both covered under **Signing key** above; read the four-step order
there before touching either.

**`HUB_CANDLE_RPS` is a CEILING, not a target.** Requests are spaced evenly at
that rate rather than fired in a burst, and the collector drops below it on its
own whenever a venue refuses: a rate limit halves the rate and buys silence for
a doubling cooldown (`HUB_CANDLE_COOLDOWN_MS`, 60s, up to
`HUB_CANDLE_MAX_COOLDOWN_MS`, 15m), never falling under `HUB_CANDLE_MIN_RPS`
(0.5). The rate creeps back toward the ceiling after a long clean run. A venue
in a backoff reads **COOLING** on the exchanges panel with the seconds
remaining — that is the collector working, not a fault; **STALLED** is the one
that wants investigating. The panel also states the live rate and how many
refusals a venue has issued, so "slow" and "broken" are never the same picture.

### Turning collectors off

Same knob, emptied — the collectors stop, the stored candles stay, and adding
the venues back resumes each symbol where it left off:

```
HUB_CANDLE_VENUES=
systemctl restart wickhunter-hub
```

New listings are picked up automatically: the instrument list is re-read on its
own cadence and a new symbol starts collecting on the next tick, no restart.
Delistings stop polling and keep their history. A pair listed hours ago is
served with its short history and an explicit leading gap — never as a thin
result that looks complete.

### Storage

`data/candles/<venue>/<SYMBOL>/<YYYY-MM-DD>.c1m` — one UTC day per file, 1440
fixed 48-byte slots, slot *i* holding the candle at `dayStart + i*60000`. Plain
files, node builtins only, consistent with the rest of the hub's state; no
database dependency, because 1-minute candles are a dense exactly-gridded series
whose every key is known in advance. Presence is stored rather than inferred,
gaps are computed from the data, writes are idempotent and order-free, and
retention pruning is `unlink` of whole day files. Budget ~2 MB per symbol-month,
about 4 GB across all three venues at 30 days.

**Back this up or not, as you like** — unlike `data/licenses.json` it is
entirely reproducible by re-collecting, just slowly.

### Admin

The **Exchanges** panel on the admin page shows one card per venue: RUNNING /
STALLED / FAILING (a collector that last succeeded 40 minutes ago on a 1-minute
cadence is stalled even if nothing threw — it is never "idle", there is always a
tail to advance), last success and last error with times, symbols split into
seedable / backfilling / gapped / empty, oldest and newest candle held, total
missing minutes with the worst offenders named, and pairs first listed in the
last 24h with how much history they hold so far. A venue with no collector says
so rather than showing zeroes that would read as a working collector with an
empty store.

Above the cards sits the **candle seed signing key** box: which key is signing
right now, the dedicated key's public half in full (base64url, with a copy
button, explicitly labelled a public key that is safe to copy), and the
four-step rollout order — because the one thing that must not happen is someone
flipping `HUB_CANDLE_SIGNER` before a bot build knows `candle-1`.

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
| `data/candle-signing.key` | Ed25519 candle-seed private key, mode 600 | a new key is generated, so every bot pinned to the old `candle-1` public key refuses every seed until re-pasted — back this up too |
| `data/licenses.json` | registry of issued licenses | can't tell known ids from foreign ones |
| `data/revoked.json` | durable revocations | revoked keys work again |
| `data/roster.json` | compact last-seen per license | rebuildable from the ledger |
| `data/checkins.jsonl` | append-only check-in ledger | history gone |
| `data/candles/` | collected 1m candles, per venue per symbol | seeds go cold until re-collected (hours, not fatal) |
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
| `GET /api/candles/seed?venue=&symbol=&fromMs=&toMs=` | valid token | signed 1m candle seed (contract v1) |
| `GET /admin` | none (page holds no secrets) | static admin page |
| `GET/POST /admin/api/licenses[/revoke]` | `x-hub-admin` header, constant-time | list / issue / revoke |
| `GET /admin/api/candles` | `x-hub-admin` header | per-exchange collector status + the seed signing key's PUBLIC half |

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

- v0.2.6 — **HOTFIX: the repair request shape broke Bitget.** v0.2.5 clamped a
  repair window to the hole's own end, producing narrow ranges that Bitget's
  `history-candles` answered with HTTP 400 — every kline request on the venue
  failed (298 consecutive; 157 requests, 0 candles) because each of 155 gapped
  symbols queued one. A repair now asks for a full page forward from the hole's
  start: the same request shape already proven against all three venues, which
  fills the hole and whatever follows it. Zero-length and past-the-tail ranges
  are refused before they are issued. No stored candle was affected — the
  failing requests wrote nothing.
- v0.2.5 — **catching up never punches a hole, and holes get repaired.** A
  defect shipped in v0.2.4: the tail asked for the NEWEST page, so a symbol more
  than one page behind had every minute between what we held and where that page
  began silently dropped. Backfill only ever digs BACKWARD from the oldest
  candle, so an interior hole was permanent. Live within a tick of the deploy:
  155 symbols on two venues took ~25-minute holes. A tail request now always
  starts at the minute after what we hold and takes a full page forward, so a
  catch-up is contiguous at every moment. Existing holes are repaired by a new
  work kind that sits between tail and backfill — a hole is worse than shallow
  history (it poisons a seed while the symbol reads deep AND current) and less
  urgent than a stale tail (which fails the bot's verification outright). The
  oldest hole per symbol is memoised, because finding one costs a full-window
  scan of that symbol's day files.
- v0.2.4 — **tail requests carry a page instead of a handful of rows.** Measured
  on the operator's box: 202 requests returned 5,768 candles — **28.6 rows
  against a 200-row page, 14% utilisation**. A symbol entered the tail queue the
  moment it was one minute behind, so with 703 Bitunix symbols a sweep took ~29
  minutes and each request collected only those ~29 minutes; backfill, the
  second half of the queue, never got a turn. A rate-limited venue could not
  converge however long it ran. A symbol is now tail-DUE only once it has
  `HUB_CANDLE_TAIL_FILL_MIN` (150) minutes of backlog, so each request comes
  back most of a page full and the freed budget goes to depth — roughly **7x the
  candles for the same rate limit**, without moving a VPS or dropping a symbol.
  A symbol with NO candles is still collected on the very first pass; the
  cadence governs a tail, not a cold start. **The cost, stated:** the newest
  candle the hub holds is up to 150 minutes old, and the bot bridges that on
  download with one request of its own — one request per bot per seed, instead
  of the hub burning its whole venue budget so that bots need not make it.
  `seedableMaxTailAgeMs` is now DERIVED from the cadence rather than set beside
  it: a fixed 15-minute ceiling under a 150-minute cadence would mark every
  symbol un-seedable forever, with the collector working perfectly and the panel
  reporting nothing servable.
- v0.2.3 — **feedback reports can be deleted.** Per-row **Delete** on the
  Feedback table, plus **Delete all fixed** for clearing the pile in one call
  rather than a row at a time. `POST /admin/api/feedback/delete` takes `{id}` or
  `{ids:[...]}`, is admin-gated, and answers 404 for an id that matched nothing
  — a quiet success would make the table drop a row that is still on disk. This
  is a real delete, not a fourth status: the export is the artifact handed over
  for triage, so a report you have finished with has to leave that too. It is
  therefore irreversible, both paths confirm first, and **the export is your
  only copy** — take one before a bulk clear.
- v0.2.2 — **the collector paces itself and backs off.** Measured on the
  operator's box the day collecting was turned on: `bitunix code 10006:
  request too frequently` and `ONDOUSDT: HTTP 429`. Two causes, both fixed
  here. (1) The pass fired its ENTIRE per-minute budget back-to-back and then
  sat idle — the average was 3.2/s, the instantaneous rate was whatever latency
  allowed, and venues limit on the instantaneous window. Requests are now spaced
  by `1000/rate` ms, and the schedule carries across tick boundaries so there is
  no burst at the top of the minute. (2) A rate-limited request was counted as a
  plain failure and retried at full rate on the next tick, so a limited backfill
  spent its whole budget on rejections and could never converge. Rate limits are
  now their own class (`RateLimitError`, from HTTP 429/418, the venue's own
  too-frequent codes, or its wording), and on one the collector stops the pass,
  halves its rate, and goes silent for a doubling cooldown — honouring the
  venue's `Retry-After` when it asks for longer than we chose. The rate recovers
  by creeping back up after a long clean run and never exceeds the configured
  ceiling: `HUB_CANDLE_RPS` is a maximum, not a target. The exchanges panel gains
  a **COOLING** state (distinct from STALLED — one wants leaving alone, the other
  wants investigating) and states the live request rate and refusal count. The
  three collectors now tick concurrently rather than in series: different hosts,
  independent limits. New knobs, all optional: `HUB_CANDLE_MIN_RPS` (0.5),
  `HUB_CANDLE_COOLDOWN_MS` (60s), `HUB_CANDLE_MAX_COOLDOWN_MS` (15m).
- v0.2.1 — the candle seed gets its own Ed25519 key
  (`data/candle-signing.key`, self-generated on first use), so a seed signature
  can no longer pass the licence verifier's signature check and rely on a
  later shape re-check to be refused. **Default behaviour is unchanged**:
  seeds are still signed by the licence key and still labelled `seed-1` until
  the operator sets `HUB_CANDLE_SIGNER=candle` — see the four-step rollout
  under **Signing key**. The public half is printed once at startup and shown
  on the admin Exchanges panel with a copy button. Also: the collector's start
  time comes from the injected clock, so a suite reasoning about elapsed time
  no longer rots against real wall time.
- v0.2.0 — candle seed service: per-venue 1m collectors (Bybit, Bitunix,
  Bitget) with automatic pick-up of new listings and clean handling of
  delistings, fixed-slot binary day-file storage with presence stored rather
  than inferred, the signed `GET /api/candles/seed` contract v1 (Ed25519 over
  pinned canonical bytes, reusing the licence key, gzip), and an Exchanges
  status panel on the admin page. Collectors off unless `HUB_CANDLE_VENUES`
  is set.
- v0.1.0 — initial hub: LHK1 licensing (issue/verify/revoke, Ed25519),
  check-in intake (ledger + roster), keyed install.sh + release downloads,
  admin surface (CLI, HTTP API, one static page), install-hub.sh with nginx
  snippet emission and retry-loop health check, tester install.sh template.
