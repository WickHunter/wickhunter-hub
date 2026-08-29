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
  not (we read the latter); Bitunix excludes it; Bybit and Aster include it.
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
GET /api/candles/seed?venue=<bybit|bitunix|bitget|aster>&symbol=<VENUE-NATIVE>&fromMs=<ms>&toMs=<ms>

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
HUB_CANDLE_VENUES=bybit,bitunix,bitget,binance,aster
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

Each venue runs at **its own** published ceiling when `HUB_CANDLE_RPS` is unset
— Bybit 15/s, Bitget 10/s, Bitunix 5/s, Binance 4/s, Aster 4/s, each about half
what that venue allows. Setting `HUB_CANDLE_RPS` replaces all five with your number,
including when it is lower.

**Binance means USD-M USDT perpetuals, exactly.** Its collector reads only
mainnet `/fapi/v1/exchangeInfo` rows whose `quoteAsset` and `marginAsset` are
both `USDT` and whose `contractType` is `PERPETUAL`; the native symbol then
names both the store partition and the signed seed. The REST path is
`/fapi/v1/klines` at one minute and the optional stream is
`wss://fstream.binance.com/market/stream` with `@kline_1m`. Binance's merged
UM/CM market-data surface does not weaken that boundary: explicit non-UM
stream frames are refused, and there is no Bybit or testnet fallback.
This expands only `HUB_CANDLE_VENUES`: Binance remains outside the separately
verified, paid `MARKET_CAP_VENUES` registry.

Binance uses the same published request-weight shape as Aster: 2400/minute per
IP and weight 5 for the 1000-row page, so its default 4 req/s spends half the
budget. Its `x-mbx-used-weight-1m` readout also triggers the pre-refusal backoff.

**Aster is paced to a weight budget, not a request count.** Its published limit
is `REQUEST_WEIGHT` **2400 per minute per IP** — stated in its docs and in the
`rateLimits` array of its own `/fapi/v1/exchangeInfo` — and a kline request
costs weight by the page size asked for (`[1,100)`→1, `[100,500)`→2,
`[500,1000]`→5, `>1000`→10, measured against the live API). The hub pages at
**1000 rows for 5 weight**, which is the best rows-per-weight the venue offers
— its 1500-row maximum costs 10 and is a third worse value — and runs at
**4 req/s**, exactly half the budget, ~240 pages a minute. Aster also reports
this IP's spend in `x-mbx-used-weight-1m` on every response: past 80% of the
budget the collector backs off on its own, keeping the page it has already paid
for. **That readout outranks `HUB_CANDLE_RPS`** — set it too high for Aster and
the venue's own number pulls you back, which is the intended direction, because
this venue bans repeat offenders for 2 minutes to 3 days and an IP ban here
takes history away from every install at once. It also means the hub notices if
something else on the same box is spending the IP's Aster budget.

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
about 6 GB across all five venues at 30 days (actual size follows each venue's
current native USDT-perpetual roster).

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

## Market-cap snapshot

The bots want a market cap per tradeable pair — to size, to filter, to refuse a
book that is too thin. The hub produces that once, for everybody, and serves it
as one signed snapshot.

**Three authorities, kept apart, and this is the whole design:**

```
exchange instrument API   -> which pairs EXIST and are tradeable
CMC derivative pair map   -> exchange-native symbol -> stable canonical asset id
CMC quotes by canonical id-> USD market cap, supply, price, timestamp
```

The provider never decides which pairs exist — a provider lagging a listing must
not be able to delist a live market from under a bot — and a ticker never
decides which coin it is about. There is no page-per-pair anywhere and no join
on ticker text.

**Verified live against the operator's key, 2026-08-24.** The record lives in
`CMC_ENDPOINT_CLAIM` (`src/marketcap/cmc.ts`) and states the observation rather
than the conclusion, so the next reader can judge whether it still holds:

- `GET /v5/exchange/derivatives/list` answers **`data.exchanges[]`** — an object
  carrying an array, not a bare array — with rows keyed `exchange_id`,
  `exchange_name`, `exchange_slug`, `num_market_pairs` (and score/rank fields).
  1 credit per call.
- **`start`/`limit` paging is real**, proved by observation: `start=1&limit=2`
  → `[binance, tapbit]`, `start=3&limit=2` → `[echobit, okx]` — distinct rows,
  so the parameter names are right rather than merely plausible.
- ⚠ **No `total_count` on that endpoint**, so the end of the list can only be
  inferred from a short page. The loop therefore *also* stops on a page that
  adds no exchange it has not already seen: a provider that clamps `start` and
  answers a full page forever would otherwise be asked one credit at a time
  until the page bound. 134 derivative exchanges exist today, so one page covers
  it — the paging stays because a venue we serve could fall past the first page
  later, which is exactly the failure it is there to prevent.
- The four venues, **by their durable numeric id**: `bybit` 521 (743 pairs),
  `bitget` 513 (698), `bitunix` 7302 (671), `aster-pro` 1452 (572).
- `market-pairs/list/latest?exchange_slug=aster-pro&category=perpetual` →
  `num_market_pairs: 572`, joining `market_pair_base.exchange_symbol` →
  `market_pair_base.crypto_id` (BTC 1, ETH 1027, SOL 5426). ⚠ **`market_pair`
  itself came back `null`** — it is parsed for the evidence trail and nothing
  joins on it.

**The id is the durable key; the slug is a label.** A slug that *disappears* is
loud — every pair on that venue reads `provider_untracked` and says so. A slug
*reused* for a different exchange is silent: the map still resolves, both
censuses still balance, and one venue's book quietly takes another venue's
identities. So the observed `exchange_id` is compared against
`DEFAULT_EXCHANGE_IDS` on every mapping pass, a mismatch is refused **by name**,
and that venue's pair map is not read at all until it is corrected
(`MARKET_CAP_SLUGS` / `MARKET_CAP_EXCHANGE_IDS`).

### `1000PEPE` is not a coin

It is a PEPE contract quoted in thousands and it takes **PEPE's market cap,
unchanged**. Nothing in this service multiplies or divides a market cap by a
contract multiplier. `1000SATS`, meanwhile, **is** its own listed asset and is
not Bitcoin, however much the name looks like a Bitcoin denomination — and no
parser can tell those two apart, because the difference is a fact about the
world and not about the string.

So identity comes from the pair map, always. `suggestMultiplier` exists and
produces a **review suggestion for a human** looking at an unmapped row; it is
wired to nothing that resolves anything, and the genuine numeric-leading tickers
— `1INCH`, `0G`, `2Z`, `4`, `100X` — come out of it untouched.

### The coverage invariant

Checked on every refresh, and exported on the payload:

```
active exchange instruments = mapped + ambiguous + provider_untracked + not_applicable
unique mapped assets requested = verified + fallback + missing + disputed + stale + not_applicable
```

For every batch call `requestedIds - returnedIds` is computed and each omitted
id becomes an explicit `missing` fact with a reason. `skip_invalid=true` is what
makes that necessary: it lets a batch of a hundred succeed while quietly
dropping rows, and an id that vanished without leaving a fact behind would be
indistinguishable from an id nobody asked for. **A pair with no cap still gets a
row and a reason.**

### Accepting a cap

A strict figure needs all of: a proven canonical id; `market_cap`,
`circulating_supply` and `price` all finite and > 0; a `last_updated` no more
than **15 minutes** old (and no more than 2 minutes in the future, for clock
skew); and `market_cap` agreeing with `price × circulating_supply` within
**2%**. That last one is free evidence the provider hands us on the same row —
the row proves its own claim rather than declaring it — and a disagreement is
reported as `disputed` with the size of the gap, never silently corrected.

Never substituted, each for its own reason: **fully-diluted valuation** (it
prices tokens that do not exist), **`self_reported_market_cap`** (the issuer's
own number, present on exactly the assets whose supply nobody could verify),
**`total_supply × price`** (FDV with extra steps), **two providers averaged**
(a figure neither would stand behind), **one provider's price with another's
supply** (the same defect in a better costume, and it defeats the cross-check).
**A null cap is never zero** — zero is a claim, and it passes every "is it a
number" test on the way to a size filter. `is_market_cap_included_in_calc` is
retained and surfaced rather than folded into a status word.

All money is a **decimal string**, carried through exact BigInt arithmetic, so
no threshold is ever decided by float rounding.

### ⚠ The credit budget is the binding constraint

The plan is **15,000 credits/month, 50 requests/minute**. Measured before
anything was built: a 5-minute pair-map refresh is ~34,560 credits a month for
the **mapping alone** — two to three times the whole plan, before a single
market cap is fetched. The schedule is therefore:

| stage | cadence | why |
| --- | --- | --- |
| derivative pair mapping | **daily** | which coin a ticker means changes when an exchange lists something, not every five minutes |
| unseen symbol | immediate **targeted** refresh, then ~1/5/15/60 min | one exchange's pages, never a sweep |
| cap facts | **hourly**, batched 100 ids per call | one request per coin is 528 credits an hour — 25× the plan for the same facts |

That comes to **≈6,990 credits/month** (750 mapping + 1,200 targeted + 5,040
caps), about 47% of the plan. The arithmetic is `estimateMonthlyCredits()` in
`src/marketcap/budget.ts` — a function, not a paragraph, so the suite holds it
to the plan and a cadence change moves the reported number instead of leaving a
stale claim in a comment.

The provider states what each call actually cost (`status.credit_count`) and
that figure **outranks our own estimate upward only** — a higher number is
charged and reported, a lower one refunds nothing, because handing back budget
on a figure we cannot audit is the direction that overspends. Same asymmetry the
candle collector applies to Aster's `x-mbx-used-weight-1m`.

**A refresh that would cross the ceiling does not start.** It is judged on the
whole planned cost, not the next call, because a refresh that stops halfway
publishes a snapshot with a third of the book missing. The refusal names the
numbers, is counted, and reaches `GET /admin/api/market-caps`; the last known
good snapshot keeps serving and states its own age.

### Publishing is all-or-nothing

Fetch every page → validate the shapes → compare each catalogue against the last
good one → build a row for every active instrument → check both invariants →
only then sign, write `tmp` + `fsync` + `rename`, and swap. A catalogue that
collapses (below 80% of last time, or under 90% symbol overlap) is **refused**,
because a truncated page and a mass delisting are the same bytes. Any failure
leaves the previous snapshot exactly where it was and emits **one** feed-health
error. Never a partial map that makes hundreds of live pairs look unmapped.

### The signing key is its own

`MARKET_DATA_SIGNING_PRIVATE_KEY_B64U` / `MARKET_DATA_SIGNING_KEY_ID` — **never
the licence key and never the candle-seed key**. See *Signing key* above for
what sharing one costs: a seed signature re-wrapped as a licence token passes
the licence verifier's signature check and is refused only by a later shape
test, so that separation rests on an ordering nobody can see. A third key
removes the dependency entirely. The private half comes from the environment,
is never written to a file by this service, never logged, and never appears in
a payload — only `keyId` does.

**Generating it is a required deploy step, and skipping it is quiet.** Unlike
the licence and candle keys this one is not self-generated — the spec puts it in
the environment, so there is nothing on disk for the hub to find and nothing for
it to invent:

```
npm run marketcapkey                 # or: npm run marketcapkey market-data-2
```

That prints the **private** line to paste into `/etc/wickhunter-hub/env` (once,
there, and nowhere else) and the **public** half plus the `keyId` to give
whoever builds the client. After a restart the public half is readable three
ways, so that output never needs keeping: the **startup log**
(`journalctl -u wickhunter-hub`), the admin page's **Market caps** panel with a
copy button, and `GET /admin/api/market-caps` (`health.signing`). A hub started
with no key refuses to run the producer and prints why; a hub started with a key
nobody wrote down produces snapshots that verify **nowhere** while looking
perfectly healthy from this side — the same failure shape as flipping
`HUB_CANDLE_SIGNER` too early.

**The client pins `keyId` → public key** and refuses an unknown one, exactly as
the bot pins `OLB_SEED_KEYS`.

Signature bytes: remove the **entire** `signatures` field, RFC 8785
canonicalise the rest, UTF-8 encode, Ed25519-sign. Removing the whole field
(rather than blanking a `sig`) is what lets a second signature be added for key
rotation without moving the bytes the first one covered. Unknown `alg`, unknown
`keyId` and an expired `expiresAt` are all refusals — and expiry is checked
**after** the signature, because an expiry read off an unverified payload is an
expiry the sender chose.

### Turning it on

Off by default, and for a harder reason than the candle collectors: every call
spends a credit against a plan the operator pays for. In
`/etc/wickhunter-hub/env`:

```
MARKET_CAP_VENUES=bybit,aster,bitget,bitunix
CMC_PRO_API_KEY=...
MARKET_DATA_SIGNING_PRIVATE_KEY_B64U=...      # base64url: 32-byte seed or PKCS8
MARKET_DATA_SIGNING_KEY_ID=market-data-1
```

Optional: `CMC_MONTHLY_CREDIT_CEILING` (15000), `CMC_REQUESTS_PER_MINUTE` (50),
`MARKET_CAP_MAP_INTERVAL_MS` (24h), `MARKET_CAP_REFRESH_INTERVAL_MS` (1h),
`MARKET_CAP_TICK_MS` (30s), `MARKET_CAP_TTL_MS` (3h),
`MARKET_CAP_SNAPSHOT_FILE`, `ASSET_IDENTITY_OVERRIDES_FILE`,
`MARKET_CAP_CREDIT_LEDGER_FILE`, `MARKET_CAP_EXCHANGE_IDS=bybit:521,...`,
`MARKET_CAP_SLUGS=aster:aster-pro,...` (an escape hatch for the day a provider
renames one), `MARKET_DATA_HUB_KEY` (an `x-hub-key` shared secret for a console
that holds no licence), `COINGECKO_PRO_API_KEY` (secondary provider, absent-safe
and entirely optional).

⚠ **The state files default into the hub's own `data/` directory
(`/opt/wickhunter-hub/data`), not the `/var/lib/liqhunter-hub/...` path the spec
names.** Deliberate: this hub already owns one state root that is mode 700,
excluded from the installer's rsync and backed up as a unit, and a second root
is a second thing to permission, back up and remember. Each env var above
honours an absolute path exactly when set, so the spec's layout is one line away
if you want it.

A missing key does **not** crash the hub: the producer refuses to start, prints
why, and licensing and candle seeding carry on. It is not silent either —
"configured and unable" is the one state that looks, from a client's side,
exactly like a provider outage.

### Identity overrides

`data/asset-identity-overrides-v1.json`, re-read on every publish (no restart):

```json
{ "overrides": {
  "bybit:CATUSDT":  { "cryptoId": 111, "note": "the map offers two ids; this is the one" },
  "bybit:IDXUSDT":  { "notApplicable": true, "note": "a basket index, no single asset" }
} }
```

An override outranks the pair map — it exists to correct it — and is the answer
to an `ambiguous` row, which is refused rather than guessed at because guessing
attaches one coin's market cap to another coin's book while every screen looks
perfectly healthy.

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

## Machine-bound lease v1 (additive)

LHK1 remains the bootstrap entitlement for old clients. A lease-aware install
generates its own Ed25519 keypair, asks the Hub for a five-minute nonce, and
signs the exact challenge bytes returned by the Hub. Successful activation
binds one licence seat to that public key and returns:

```
WHL1.<base64url(payload-json)>.<base64url(signature)>
```

The dedicated lease key signs domain-separated bytes and is never the LHK1,
release, candle, or market-data key. The signed payload carries the key id,
licence/activation ids, install public key, current features, Hub-issued time,
not-before/expiry, monotonic activation sequence, and the offline policy:
cached entitlement only through the signed grace instant, then exit-only.
Revocation is likewise exit-only. A licensing outage or refusal must never
prevent position reduction, reconciliation, or cleanup.

The activation ledger is append-only, fsynced, hash-chained, and each record is
Ed25519 signed. A separately fsynced, signed head anchors the expected event
count and final hash. Missing/zeroed/truncated/edited state fails the lease
service closed while legacy LHK1/check-in stays online. Only malformed bytes
after the signed head (an interrupted, never-checkpointed append) are repaired;
a complete final JSON line is never discarded merely for lacking a newline.
Machine binding means possession of a software private key—not hardware
identity. Root access or cloning that private key can clone the machine.

### Pinned lease protocol bytes

The app must never guess or reserialize either signed object. A lease signature
is Ed25519 over these exact bytes:

```text
UTF-8("WICKHUNTER\\0LICENSE_LEASE\\0V1\\0") || raw payload JSON bytes from WHL1
```

Challenge responses carry `proofBytesB64u`; the install decodes and validates
those exact bytes before signing them. The v1 decoded JSON key order is:

```text
{"v":1,"domain":"wickhunter.license.challenge.v1","purpose":...,"nonce":...,"licenseId":...,"activationId":...,"activationRevision":...,"installId":...,"installPublicKey":...,"newInstallId":...,"newInstallPublicKey":...,"issuedAtMs":...,"expiresAtMs":...}
```

`tests/license-leases.test.mjs` pins a complete rebind vector byte-for-byte so
the Hub and the app cannot silently drift. Public Ed25519 keys are canonical
base64url raw 32-byte values; signatures are canonical base64url 64-byte values.

### Required rollout order

1. Deploy Hub 0.3.4 or later. It creates `lease-1` without changing LHK1 or check-in
   and exposes only its PUBLIC verifier in the authenticated admin UI.
2. Run `npm run leasekey` and pin the printed PUBLIC `lease-1` key in an app
   release. Do not trust a key fetched dynamically by the app.
3. Ship that app while legacy LHK1 remains accepted. Let installs create their
   local private key and activate; watch `/admin/api/license-leases`.
4. Only after recovery/deactivation has been exercised should a later app
   release make the signed lease the local new-exposure authority. Exits remain
   allowed without a valid lease.
5. To rotate, run `npm run leasekey -- lease-2`, ship both public keys, wait for
   adoption, then set `HUB_LICENSE_LEASE_KEY_ID=lease-2`. Runtime startup and
   the ordinary installer will not invent a named rotation key. Retain every
   old **public** key for as long as any retained audit line names its kid
   (normally indefinitely); the old private signer may go offline after the
   cutover unless an intentional rollback remains possible.

This Hub release intentionally does not globally disable LHK1: no lease-aware
app has shipped yet, and doing so would strand every existing user. It provides
the complete Hub issuance/seat/recovery half for that staged migration.
An already-issued WHL1 token is offline-verifiable until its signed grace
instant, so a rebind/revocation cannot erase that window from an offline copy.
New-entry authority must become exit-only immediately when an online check sees
revocation, and always after grace; exits and cleanup remain allowed. An admin
lost-key deactivation recovery-locks that licence against a copied-LHK1
first-claim race. Rebind with both keys before loss, or reissue the LHK1 after
loss—ordinary activation cannot silently take the freed seat.

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

The admin page's top panel shows the running package version, full installed
commit/branch/build time, configured checkout HEAD and locally fetched
`origin/main`, source-versus-runtime relation, dirty-worktree refusal, and the
last upgrade outcome/time/log tail. **Upgrade hub** now refuses a dirty or
non-`main` checkout, fetches `origin/main`, permits only a fast-forward, verifies
the exact commit, and records the build only after the restarted service answers
with the compiled package version. A failed or stale v0.3.0 runtime is therefore
visible instead of looking like a successful current checkout.

### Marketplace operations bridge (alpha only)

Marketplace trading, payments, Demo credentials, and subscription persistence
remain in the private service; none are copied into this public Hub. The normal
admin form asks only for Bybit and MoonPay facts the server cannot know. Safe
localhost/storage/timing defaults, internal credentials, signing material,
vault settings and alpha verifier data are generated or derived automatically;
database/build/Hub identity facts are supplied by the private deployment.
Secrets are write-only, persist in `/etc/liqhunter/marketplace.env` with mode
0600, and are never returned to the browser. The public Hub loads only a
separate `/etc/wickhunter-hub/marketplace.env` containing the three status
bridge values; database, signer, Bybit, vault and MoonPay credentials never
enter the Hub process. To configure the status bridge manually instead, set:

```
HUB_MARKETPLACE_STATUS_ORIGIN=http://127.0.0.1:<private-marketplace-port>
HUB_MARKETPLACE_STATUS_CREDENTIAL=<dedicated-32+-character-status-secret>
```

Set the same `HUB_MARKETPLACE_STATUS_CREDENTIAL` on the private Marketplace
service. The bridge accepts only an exact loopback origin, always uses the fixed
`GET /api/marketplace/operator/status` path and server-side bearer, and never
sends that credential to the browser. The panel shows exact required variable
names plus configured/missing/invalid/defaulted state, service/migration/worker,
Bybit Demo evidence and crypto-only MoonPay readiness. It also shows state-only
proof that the public alpha origin is reachable, the distributed intent verifier
matches the live signer, and the Marketplace feature grant is confirmed for the
alpha licence cohort. Raw origins, keyrings and credentials never cross the
bridge. The feature remains alpha-only (`betaIncluded:false`). If the private
service is absent, it says unavailable and renders the static setup checklist,
including all three alpha-client inputs, without claiming readiness. Older
private status responses remain readable while the additive proof is absent.

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
> curl -q -fsS "https://<vps-ip>/hub/install.sh?key=<TOKEN>" | sudo bash
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

Copy the built bot tarball + offline-signed `latest.json` into
`/opt/wickhunter-hub/releases/` — tarball first, `latest.json` last (it is the
pointer). The Hub holds only the dedicated release PUBLIC keyring in
`HUB_RELEASE_PUBLIC_KEYS_JSON`; never copy the private release key here and
never reuse the licence/candle/market-data keys. Full signed contract, rollout
order and publish snippet: [`releases/README.md`](releases/README.md).
Testers upgrade by re-running their install command.

### Signed-release rollout (mandatory order)

1. Generate the dedicated Ed25519 release key offline with the app repository's
   `scripts/generate-release-key.mjs`. Keep the private PEM offline.
2. Use `scripts/sign-release-manifest.mjs` there to sign the artifact currently
   published by the old Hub. Publish that artifact first and the signed
   `latest.json` last/atomically.
3. Put only the public keyring in `/etc/wickhunter-hub/env`, quoted so systemd
   preserves its JSON: `HUB_RELEASE_PUBLIC_KEYS_JSON='{"release-2026-01":"…"}'`.
4. Deploy this Hub. Production startup requires HTTPS and the public keyring;
   release/install endpoints refuse unsigned, stale, wrong-target, badly
   signed, or hash-mismatched metadata. The Hub has no release signing API or
   private-key configuration.
5. Publish the first signed-aware app. Old clients accept it because
   `version`, `file`, and `sha256` are unchanged top-level fields. After that
   bootstrap, updates run the verifier already installed on the client and do
   not execute a downloaded Hub script.

Compatibility is intentionally asymmetric: old client + new signed Hub works;
new client + old/unsigned Hub refuses only the update and continues running its
current version. Licence (`LHK1`) and trading protection/exit behavior are not
part of this release authority and remain unchanged. The default manifest
freshness window is 30 days (`HUB_RELEASE_MAX_AGE_MS`); re-sign an unchanged
artifact before it expires if no new build is planned.

### Where the data lives (and backup)

| Path | What | Loss means |
| --- | --- | --- |
| `data/license-signing.key` | Ed25519 private key, mode 600 | **every issued token orphaned** — back this up offline |
| `data/license-lease-signing.<kid>.key` | dedicated Ed25519 lease private key(s), mode 600 | that kid can no longer renew/sign leases; retain old kids through rotation overlap |
| `data/license-lease-public-keys.v1.json` | lease verifier keyring | old signed audit/lease records cannot be verified by kid |
| `data/license-lease-audit.v1.jsonl` | signed activation, nonce, seat/rebind and revocation audit/state | machine bindings and monotonic sequences are lost; do not re-enrol blindly |
| `data/license-lease-audit-head.v1.json` | independently signed expected ledger count/hash | deletion, truncation and interrupted state cannot be distinguished safely; restore with the ledger from one backup |
| `data/hub-build.v1.json` | installed package/commit/branch/build time | runtime identity becomes explicitly unknown until the next verified install |
| `data/upgrade-status.v1.json`, `data/upgrade.log` | last self-upgrade outcome and bounded diagnostic log | upgrade remains possible, but the admin loses the previous audit trail |
| `data/candle-signing.key` | Ed25519 candle-seed private key, mode 600 | a new key is generated, so every bot pinned to the old `candle-1` public key refuses every seed until re-pasted — back this up too |
| `data/licenses.json` | registry of issued licenses | can't tell known ids from foreign ones |
| `data/revoked.json` | durable revocations | revoked keys work again |
| `data/roster.json` | compact last-seen per license | rebuildable from the ledger |
| `data/checkins.jsonl` | append-only check-in ledger | history gone |
| `data/candles/` | collected 1m candles, per venue per symbol | seeds go cold until re-collected (hours, not fatal) |
| `releases/` | beta tarballs + `latest.json` | republish from the bot repo |
| `/etc/wickhunter-hub/env` | `HUB_ADMIN_TOKEN`, origin, port, release PUBLIC keyring | regenerate token/configure public keys; no release private key belongs here |

Backup = the `data/` directory plus the env file. A nightly
`tar -czf - /opt/wickhunter-hub/data /etc/wickhunter-hub/env` shipped
anywhere private is enough; everything else is reproducible.

## HTTP surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health` | none | version plus installed build, source checkout comparison and last upgrade outcome (no log tail) |
| `POST /api/license/checkin` | none (records everything) | bot phone-home; answers `revoked:true` for revoked/unknown ids |
| `POST /api/license/lease/challenge` | active LHK1 in `x-license` (lapsed genuine LHK1 only for deactivation) | one-time purpose/key-bound nonce and exact proof bytes |
| `POST /api/license/lease/activate` | LHK1 + install Ed25519 proof | consume nonce, enforce seat limit, create binding and WHL1 lease |
| `POST /api/license/lease/renew` | LHK1 + bound install proof | increment sequence and issue a short lease |
| `POST /api/license/lease/deactivate` | genuine known LHK1 + bound install proof | release a seat even after expiry/revocation |
| `POST /api/license/lease/rebind` | active LHK1 + old and replacement key proofs | atomically move one activation to a new install key |
| `GET /install.sh?key=` | valid token | personalised tester installer |
| `GET /api/latest?key=` | valid token | signed `wickhunter.release.v1` manifest; legacy `{version,file,sha256}` remain top-level |
| `GET /download/<file\|latest>?key=` | valid token | beta tarballs |
| `GET /api/candles/seed?venue=&symbol=&fromMs=&toMs=` | valid token | signed 1m candle seed (contract v1) |
| `GET /api/market-data/market-caps/v1` | valid token (`x-license` / `?key=`) or `x-hub-key` | signed market-cap snapshot (contract v1); ETag + gzip |
| `GET /admin` | none (page holds no secrets) | static admin page |
| `GET/POST /admin/api/licenses[/revoke]` | `x-hub-admin` header, constant-time | list / issue / revoke |
| `GET /admin/api/license-leases` | `x-hub-admin` header | public keyring, activations, seat overrides and bounded audit view |
| `POST /admin/api/license-leases/seat-override` | `x-hub-admin` header | reason-required, audited machine limit override |
| `POST /admin/api/license-leases/deactivate` | `x-hub-admin` header | reason-required recovery for a lost machine key |
| `GET /admin/api/operations` | `x-hub-admin` header | exact running/source/upgrade facts plus a redacted bounded log tail |
| `GET /admin/api/marketplace-status` | `x-hub-admin` header | sanitized alpha Marketplace readiness and exact operator-input checklist; upstream credential stays server-side |
| `GET /admin/api/marketplace-config` | `x-hub-admin` header | masked state for the exact Marketplace input allowlist; secret values are never returned |
| `POST /admin/api/marketplace-config` | `x-hub-admin`, fixed CSRF header, JSON | asks one fixed root helper to write split least-privilege API/worker files, encrypt the Bybit master and restart only the private services; restores files on failure |
| `GET /admin/api/marketplace-providers` | `x-hub-admin` header | sanitized provider application roster from the private API; its Hub identity stays behind the root helper |
| `POST /admin/api/marketplace-providers/:id/decision` | `x-hub-admin`, fixed CSRF header, JSON | written-reason provider approval/rejection/suspension through the private audited service |
| `GET /admin/api/candles` | `x-hub-admin` header | per-exchange collector status + the seed signing key's PUBLIC half |
| `GET /admin/api/market-caps` | `x-hub-admin` header | market-cap producer health, credit spend and refusals |

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

- v0.3.16 — Normalize installed code and compiled-runtime permissions after a
  root build so an inherited restrictive umask cannot leave new modules
  unreadable by the unprivileged Hub service. Keep `data/` and `releases/`
  pruned from normalization, service-owned and mode 0700.
- v0.3.15 — Collect, persist and serve signed Binance USD-M USDT-perpetual
  one-minute candles for Optimized bots. Binance uses its own native symbol
  census, REST history, optional finalized WebSocket tail and request-weight
  pacing; its seed data remains venue-partitioned and never falls back to
  Bybit. Keep the separate paid market-cap producer venue list unchanged.
- v0.3.14 — Add the required Bybit Demo worker egress IP allowlist as a masked,
  strictly validated JSON array of literal addresses routed only to the private
  Marketplace API role; refuse hostnames, CIDRs, wildcards, duplicates and
  malformed input without exposing the saved network boundary.
- v0.3.13 — Pin the private Marketplace services to mock subscriptions, expose
  only the two real Bybit vendor inputs, split secrets strictly by service role,
  migrate the encrypted Demo vault into its worker-only StateDirectory, retire
  the legacy monolithic secret environment after a healthy restart, and restore
  both role files and vault bytes if any apply/restart step fails.
- v0.3.12 — Hydrate the masked Marketplace setup from the already-running
  split service roles, tolerate duplicate unrelated Hub settings while reading
  the one public origin, keep deferred MoonPay defaults out of readiness, and
  import the Bybit master as the dedicated worker so its encrypted vault stays
  worker-owned.
- v0.3.11 — Return the root-written, non-secret build identity record to the
  unprivileged Hub service before the installer verifies the running commit.
  This preserves the v0.3.10 privilege boundary while making installs and the
  Upgrade button finish cleanly when the source checkout lives under `/root`.

- v0.3.10 — **The public Hub is no longer root and no longer reads Marketplace
  secrets.** A single fixed, root-owned, no-argument helper accepts bounded JSON
  on stdin, writes the v0.89.43 split API/worker environment files, derives only
  public verifier material, imports the Bybit master directly into the
  encrypted worker vault, and restarts an exact service allowlist with rollback.
  Self-upgrade uses the same narrow helper. The normal Marketplace page asks
  only for the two required Bybit values; optional MoonPay inputs stay collapsed
  while subscriptions are mocked. Provider applications can now be approved,
  rejected or suspended from the Hub with a mandatory audited reason.

- v0.3.9 — **The Hub is organized around the operator's real jobs.** The admin
  UI opens on Licenses & installs, groups candle and market-cap operations on a
  Market data page, gives Marketplace its own vendor-only setup page, and moves
  build, lease and feedback detail to System & feedback. Automatic Marketplace
  setup also keeps the optional five-part Bybit Demo credential group wholly
  absent until both master API credentials are saved together, so a fresh
  install can boot safely before vendor keys are entered.

- v0.3.8 — **Marketplace setup asks only for vendor facts.** The normal Hub
  form now contains only the WickHunter-owned Bybit API pair and MoonPay
  credentials/payout information. Saving fills safe service defaults and
  generates the status pair, Ed25519 intent signer/public verifier, Demo vault
  key and worker credential automatically; deployment supplies PostgreSQL,
  build and central-Hub identity facts. Alpha membership is a per-licence
  button on the existing roster and is mirrored into the central allowlist,
  while beta remains excluded. The former wall of environment variables is
  retained only inside collapsed, read-only advanced diagnostics.

- v0.3.7 — **Every Marketplace operator input has a safe Hub-admin home.** The
  authenticated admin form exposes the exact alpha, PostgreSQL, signer, Bybit
  Demo and crypto-only MoonPay variable names, with server-side generation only
  for internal status/vault/worker credentials. Vendor keys remain explicit
  operator inputs. Secrets are write-only and masked; validated changes are
  fsynced into root-only EnvironmentFiles and private API/worker restart is an
  allowlisted transaction with byte-for-byte rollback. The public Hub receives
  only a separate three-value status bridge file—never database, signing,
  exchange, vault or payment credentials. Alpha remains centrally allowlisted;
  this UI does not enable Marketplace for beta users.

- v0.3.6 — **Installer manifest transport is deterministic on home servers and
  managed networks.** Hub metadata is non-cacheable and marked no-transform.
  The installer ignores machine-local curl configuration, requests an identity
  response, streams response bytes through a hard cap, and tolerates bounded
  declared or undeclared gzip from a
  broken reverse proxy. Corrupt, non-UTF-8, or non-JSON responses now fail
  closed with a useful network/proxy message instead of printing binary symbols
  and a raw JSON parser excerpt. The installed Wick Hunter version remains
  untouched on every failure.

- v0.3.5 — **Alpha client readiness is visible without exposing deployment
  material.** The public Hub now allowlists and renders the private service's
  state-only proof for the public HTTPS origin, matching distributed intent
  verifier, and alpha licence feature grant. Migration corruption counts are
  displayed as bounded integers, every new required input and operator action
  remains usable in the responsive checklist, and old private-status responses
  continue to render. Raw origins, public keyrings, credentials, paths and
  hostile additive fields are discarded at the bridge boundary; Marketplace
  remains excluded from beta.

- v0.3.4 — **Mobile Marketplace setup is actionable.** At phone widths, each
  required Marketplace input now stacks its state, safe detail and exact
  operator action under the variable name. Critical setup instructions no
  longer live off-screen behind horizontal table scrolling. Lease verification
  also applies the signed `notBeforeMs` boundary exactly once, rather than
  accidentally doubling the configured clock-skew tolerance.
  The admin also shows the active machine-lease key id and full copyable PUBLIC
  key, activation/seat/recovery status, and the non-breaking rollout order;
  private keys and lease tokens never enter the browser response.

- v0.3.3 — **Exact Hub operations, alpha Marketplace status, and staged
  machine-bound licensing without breaking LHK1.** The admin now makes a stale
  deployment unmistakable: package/build commit/branch, checkout HEAD and
  `origin/main`, runtime comparison, last upgrade outcome and redacted log are
  visible together; upgrade is a shell-free, clean-main, verified fast-forward.
  A loopback-only server credential exposes the private Marketplace's sanitized
  migration/worker/Demo-evidence/crypto-payment/input readiness in this public
  Hub without importing trading/payment code or exposing secrets, and labels it
  alpha-only. The Hub also supports a future lease-aware install that generates
  an Ed25519 key and proves possession against a
  purpose-bound, five-minute Hub nonce before it can claim a licence seat.
  Activate, renew, deactivate and dual-proof rebind operations are durable in
  an append-only, fsynced, hash-chained and signed audit ledger plus independently
  signed head; every signed
  WHL1 lease carries the exact install public key, features, Hub time window,
  monotonic activation sequence, and cached-offline/exit-only facts. Default is
  one machine, with reason-required audited admin overrides and recovery
  deactivation locked against copied-bearer reclaim. Stale pre-rebind challenges,
  ledger loss/truncation, concurrent writers and unprovisioned rotation kids all
  fail closed. The signer/keyring is a fourth, dedicated Ed25519 authority and
  supports explicitly staged overlapping kids. LHK1 bytes, unauthenticated legacy
  check-in, install/download behavior and existing users remain unchanged while
  the public lease key and lease-aware app roll out in the documented order.

- v0.3.2 — **Offline-authenticated releases.** The beta shelf now accepts only
  an RFC 8785-canonical `wickhunter.release.v1` manifest signed by a dedicated
  offline Ed25519 release key and matching the artifact's SHA-256. The Hub has
  public keys only: production requires HTTPS and
  `HUB_RELEASE_PUBLIC_KEYS_JSON`, and it refuses unsigned, unknown-key,
  stale, wrong-target, tampered, or hash-mismatched releases. The fresh
  installer independently verifies that signature and hash before extracting
  the app. Legacy `version`/`file`/`sha256` remain top-level so existing clients
  can bootstrap the first signed-aware app. Licence `LHK1`, entitlement and
  trading-protection behavior are unchanged.

- v0.3.1 — **The snapshot the bot can actually read, and a producer fault that
  can no longer take the hub down.** Three fixes to v0.3.0, all found by
  enabling it on a live box for the first time.
  **The keyId was one no bot could verify:** the producer required a
  self-generated key and the operator's install published `market-data-1`,
  while every shipped bot pins exactly one entry — `mcap-1` → the LICENCE
  public key — and refuses an unknown keyId rather than verifying it against a
  default. `MARKET_CAP_SIGNER` now defaults to `license`/`mcap-1`, mirroring
  the candle seed's own staged rollout, whose default is likewise the OLD key
  so no bot in the field is stranded.
  **A market-cap variable took down licensing.** `marketCapSigningFromEnv`
  threw, `configFromEnv` calls it, and `main.ts` calls that on its first line —
  so one stale variable stopped the hub constructing its config at all and
  nginx served 502. The signer refusal is DATA now: the producer refuses by
  name and the hub keeps serving, which is what `marketCapStartupRefusals`
  already existed to do.
  **And the wire format was never reconciled with the consumer.** The bot
  validates `generatedAtMs`/`expiresAtMs`, a nested `cap{}` on each row, and a
  census of `{activeInstruments, byStatus}`. The hub now publishes those names
  BESIDE its own — safe because the two vocabularies collide on nothing but
  `venue` and `symbol`, which mean the same thing — so no existing reader
  moves and no bot needs a redeploy to understand it.
  Refresh cadence stays HOURLY: 805 assets is 9 provider credits a cycle,
  ~8,365/month against a 15,000 ceiling, while a ten-minute cadence is
  ~41,215 — 2.7x over the plan. The BOT's freshness ceiling moved instead.

- v0.3.0 — **The market-cap snapshot producer.** One signed snapshot of every
  tradeable pair's market cap, produced once for everybody. Three authorities
  kept strictly apart: the exchange says which pairs exist, CMC's derivative
  pair map says which canonical asset a venue-native symbol means, CMC's quotes
  say what that asset is worth. **`1000PEPE` takes PEPE's cap unchanged** — the
  multiplier is a contract size, and nothing here multiplies or divides a market
  cap by one; **`1000SATS` is not Bitcoin**, which no parser could ever tell you,
  which is why identity comes from the map and a ticker parser may only produce a
  review suggestion (`1INCH`, `0G`, `2Z`, `4`, `100X` come out untouched).
  **Both coverage invariants are checked on every refresh and exported on the
  payload**, and every id a batch omits — `skip_invalid=true` drops rows while
  the call succeeds — becomes an explicit `missing` fact with a reason rather
  than a silence. A cap is accepted only when all three figures are positive, the
  provider's stamp is under 15 minutes old, and the published cap agrees with
  `price × circulating_supply` within 2%; FDV, `self_reported_market_cap`,
  `total_supply × price`, averaged providers and one provider's price with
  another's supply are all refused by name, and **a null cap is never zero**.
  Money is a decimal string throughout, so no threshold is decided by float
  rounding. **The credit budget is the binding constraint and it is enforced with
  a refusal**: 15,000/month and 50/min, mapping DAILY and caps HOURLY batched 100
  ids to a call — ≈6,990 credits a month against the ~34,560 the 5-minute
  refresh would have cost for the mapping alone — and a refresh that would cross
  the ceiling does not start, says so, and leaves the last known good serving.
  Publishing is all-or-nothing behind a catalogue-sanity check, because a
  truncated page and a mass delisting are the same bytes. **A third Ed25519 key**
  (never the licence key, never the candle key), RFC 8785 canonicalisation with
  the whole `signatures` field removed, `ETag`/`If-None-Match` and gzip on
  `GET /api/market-data/market-caps/v1`. Off by default: every call spends a
  credit against a plan the operator pays for. **The provider's own
  `status.credit_count` outranks our estimate upward only** — a higher figure is
  charged and reported, a lower one refunds nothing, because handing back budget
  on a number we cannot audit is the direction that overspends (the asymmetry
  the candle collector already applies to Aster's `x-mbx-used-weight-1m`).
  **Endpoint shapes, paging and exchange ids verified live 2026-08-24** and
  recorded as an observation in `CMC_ENDPOINT_CLAIM`: `data.exchanges[]` keyed
  `exchange_id`/`exchange_slug`, `start`/`limit` proved by two overlapping
  windows returning distinct rows, **no `total_count`** — so the loop stops on a
  short page *and* on a page adding nothing new, which is what keeps a clamped
  `start` from spending a credit per attempt. **The exchange id is the durable
  key**, and a slug reused for a different id is refused by name and its pair map
  is not read: a vanished slug is loud, a reused one is silent and hands one
  venue's book another venue's identities. `market_pair` came back null on the
  live response and nothing joins on it. Admin **Market caps** panel (spend,
  refusals, slug/id agreement, recent errors, and the signing key's public half
  with a copy button), and `npm run marketcapkey` as the documented,
  one-time key-generation step.

- v0.2.19 — **AsterDex collects, and it is the first venue whose limit is not a
  request rate.** Aster is a Binance USD-M clone: `https://fapi.asterdex.com`,
  `GET /fapi/v1/klines`, `wss://fstream.asterdex.com`. **Mainnet only** — there
  is a testnet base, it is deliberately not wired even as a fallback, and a test
  reads the built files to prove no testnet host appears in either adapter.
  **THE CEILING IS REQUEST_WEIGHT 2400/MINUTE PER IP**, which the venue publishes
  in its docs *and* in the `rateLimits` array of its own `/fapi/v1/exchangeInfo`,
  and a kline request's weight depends on the `limit` asked for — `[1,100)`→1,
  `[100,500)`→2, `[500,1000]`→5, `>1000`→10. Measured live, not inherited:
  repeated identical requests moved `x-mbx-used-weight-1m` by exactly those
  amounts. **The page is 1000 rows, not the venue's 1500 maximum**, because 1000
  rows for 5 weight is 200 rows per weight unit and 1500 rows for 10 weight is
  only 150 — the biggest page this venue allows is 25% worse value than the one
  below it, so "ask for the maximum" is the wrong optimisation and there is now a
  test that says why. The collect rate is **derived** from that arithmetic
  (`asterPacedRps`), never typed in: 2400 × ½ ÷ 5 ÷ 60 = **4 req/s**, exactly
  half the published budget, matching what the other three venues do with their
  own figures. That is 240 pages a minute, so a ~530-pair roster warms 30 days
  of 1-minute history in about an hour and a half.
  **Aster also publishes this IP's spend on every response**, and the collector
  now acts on it: over 80% of the budget a page comes back carrying `slowDown`,
  the rate halves and the venue is left alone for a cooldown — the same handling
  a 429 gets, one notch early, because Aster bans repeat offenders for 2 minutes
  to 3 days and an IP ban on the hub takes history away from every install at
  once. The candles are **kept**, not thrown away: their weight is already spent,
  and discarding them is the "budget spent on requests that never become candles"
  failure the rate-limit handling exists to avoid. This also makes the venue's
  real budget outrank `HUB_CANDLE_RPS` — an operator who sets that too high is
  throttled back by the venue's own readout. The other three venues never set the
  field and are bit-for-bit unchanged.
  **Its websocket states closure.** `x` ("Is this kline closed?") is documented
  *and* was observed flipping `false`→`true` on the minute boundary, and the
  frame carries the candle's own open time `t` — so Aster is the second venue to
  state closure and the first whose statement this repo proved rather than
  inherited. It needs no application-level ping (Aster sends protocol ping
  frames, which Node answers itself) and its subscribe is **one frame per
  chunk**, because the venue caps incoming messages at 10/s and bans IPs it
  repeatedly disconnects.
  **One venue quirk that would have cost a live collector its pass:** Aster
  refuses `startTime === endTime` outright (HTTP 400, `-1023 "Start time is
  greater than end time."`), and the collector's backfill produces exactly that
  window on the pass that lands on the retention horizon. The end is widened to
  the last millisecond of the requested minute, which cannot reach the next
  minute's open time and so changes no other window's meaning. This is the
  v0.2.6 Bitget incident — odd-shaped ranges answered with HTTP 400, 298
  consecutive failures — headed off rather than repeated.
  Also: `VENUE_IDS` is now the source for the panel-card, stream-adapter and
  paced-rate checks instead of three typed-out lists, so the *next* venue cannot
  be added and forgotten by any of them.
- v0.2.18 — **the candle seed takes its licence in a header, and `?key=` still
  works.** A licence in a query string is written to every access log the request
  passes through — this hub's, nginx's, any proxy between — where it outlives the
  request and is readable by anyone with log access, which is not the same set as
  "people entitled to a licence". `/api/candles/seed` now reads `x-license`
  first, exactly as the community routes already did and for exactly that stated
  reason: **the heavier of the two surfaces had the weaker handling.** `?key=` is
  still accepted and must be — an install older than the bot release that starts
  sending the header has no other way to ask, and a hub that quietly stopped
  seeding those would look like the venue warm-up simply coming back. Header
  first, so an install sending both is judged on the safer one. `licenseTokenOf`
  is now the ONE place that order is decided (there were two readings of this
  idea and they had already drifted); `requireKey` deliberately does NOT use it —
  install.sh and `/download` are fetched by a bare `curl` line a human pastes,
  which has no header to send, and install.sh SUBSTITUTES `?key=` into the script
  it returns. Mutation-verified: restoring the query-only read turns the header
  check red and nothing else notices.
- v0.2.17 — **the websocket tail is wired, and OFF until an operator asks.**
  v0.2.16 was the protocol; this is the sockets — chunking at each venue's own
  topic cap, bounded jittered reconnect, and closed candles written straight to
  the store. `HUB_CANDLE_STREAM=bitget,bitunix` turns it on per venue, and that
  list is INTERSECTED with the collecting venues rather than trusted: a stream
  is a faster tail for a venue the collector already owns, never a way to
  collect one it does not.
  **Default OFF on purpose.** Bitget and Bitunix were verified against their
  live streams; **Bybit's adapter was not** — this build environment is
  geo-blocked from Bybit — and a default-on stream would make that unverified
  leg everyone's problem on upgrade.
  **The property that makes it safe to enable:** the runner only ever writes
  closed candles the REST tail would have fetched later. It never backfills,
  never touches retention or the tracked set, and never reports health the
  collector acts on, so if every socket dies the collector repairs the gap on
  its own schedule and turning it off again leaves nothing behind. The forming
  bar held across a reconnect is DROPPED rather than published — a bar
  assembled from a fraction of its trades is worse than a gap this system
  already knows how to repair. Reconnect is jittered so one blip cannot
  reconnect every chunk of every venue on the same tick.
- v0.2.16 — **the websocket tail: candle protocol work, verified against the
  live streams.** The collector polls, which is why `tailFillMinutes` is 100 — a
  request returning one row is a request wasted, so a symbol is not tail-due
  until it has most of a page. A stream removes the reason for that trade: closed
  minutes arrive as they happen at no REST cost, so the tail is current AND the
  whole request budget goes to depth.
  **Zero new dependencies** — Node >= 22 (this package's own `engines`) ships a
  global `WebSocket`, and a candle feed is not the place to start adding packages
  that run beside the signing key.
  **The hard part is that two of three venues never mark a candle closed.** Frames
  were captured LIVE from the real endpoints while writing this: Bitget repeats
  the same `openMs` with changing values as the bar forms, and **Bitunix carries
  no candle open time at all** — only a message `ts`, so the minute must be
  derived from it, which is a materially weaker guarantee than the other two and
  is named (`openMsFromTs`) rather than inlined. Only Bybit states closure.
  So a minute is published only once the venue sends a LATER minute — an ORDERING
  fact about the venue is own stream, never a comparison against this machine is
  clock, which `olb-venue-candles.ts` refuses for entries and a hub feeding every
  install has no more right to.
  Verified end to end against the live Bitget and Bitunix streams: each published
  bar is close equals the next bar is open, which only holds if parsing, bucketing
  and the closure rule are all correct. **Bybit is leg is from its v5 contract and
  the working client in the bot repo — this build environment is geo-blocked from
  Bybit and could not probe it. Verify that one against a live stream before
  enabling it.**
  **This release is the PROTOCOL only** — adapters, the closure buffer and their
  tests. The connection manager (reconnect, resubscribe, per-connection topic
  batching) and the service wiring are not built, so nothing streams yet and
  nothing changes at runtime.
- v0.2.15 — **each venue collects at its own documented rate.** Every collector
  ran at ONE global 3.2 req/s: 32% of Bitunix's documented 10/s, 16% of
  Bitget's 20/s and 2.7% of Bybit's ~120/s. The two venues that need the budget
  most were the ones starved of it, and a budget-starved collector is exactly
  why tails sat ~100 minutes behind — `tailFillMinutes` is high because a
  request that returns one row is a request wasted, and there was never enough
  budget to do better. Ceilings are now a VENUE FACT beside `pageLimit`
  (Bybit 15/s, Bitget 10/s, Bitunix 5/s — about half of each documented figure,
  because these are continuous requests and the adaptive backoff is a recovery
  mechanism, not a licence to sit on the limit). `HUB_CANDLE_RPS` still
  overrides every venue and CLEARS the table, so an operator's single number
  means what it says — including when it is lower.
  **A related constraint has just been lifted bot-side and is worth knowing
  here:** liqhunter v0.79.0 anchors the seed cross-check at the seed's own
  reach instead of at `now`, so the "(200 − tailFillMinutes) of overlap"
  reasoning that pinned `tailFillMinutes` to 100 no longer binds. Freshness and
  page utilisation can now be traded on their own merits. Nothing here changes
  `tailFillMinutes` — that is an operator decision, and it should be made with
  the new headroom in mind rather than against a cliff that no longer exists.
- v0.2.14 — **the candle signing card stops reading as a to-do.** It led with
  the dedicated key and a numbered four-step rollout, which looks like
  outstanding setup work. It is not: the shipped default signs with the licence
  key, every bot pins that key at build time, and seeding works for every
  install with nothing pasted anywhere by anyone. The card now says "nothing to
  do" and folds the dedicated key away as optional hardening. That step cannot
  be automated and the card now says why — the bot pins its verification keys
  **in the build** on purpose, so a compromised hub cannot introduce a key of
  its own; fetching keys from the hub would defeat pinning entirely. A
  dedicated key therefore always costs one bot release, which is a trade to
  take deliberately rather than a chore to be nagged about on every visit.
- v0.2.13 — **the community Strat gallery.** Four keyed routes
  (`/api/hub/strategies` + `/publish`, `/vote`, `/delete`) serving the gallery
  every liqhunter install now resolves to by default. A **Strat is one or more
  bots** under one name — "a liq bot and a hedge bot together" — and is
  self-contained: it carries each bot's full config, never a reference to
  another Strat, which would break the moment an author deleted a member.
  **Identity comes from the verified licence, never the body** (the
  `feedback.ts` rule, and it matters more here because this is the first
  tester-facing surface that can DELETE): ownership and votes key on the signed
  payload's licence id, while the `install` string and free-text `author` the
  bot sends are display-only. A wrong owner and an unknown id give the
  identical 404, or the hub confirms which ids exist to anyone with a valid
  licence. An author's delete is hard, not a tombstone. No licence id ever
  reaches a client. **No performance figure is served and nothing stands in its
  place** — a Strat can hold bots whose interaction no replay models. The token
  is accepted from an `x-license` header (what the bot sends; keeps it out of
  access logs) or from `?key=`.
- v0.2.12 — **`__proto__` is not a licence id.** Found by an independent audit of
  v0.2.11 and reproduced end to end against the real route.

  `byLicense["__proto__"]` does not resolve to `undefined` — it resolves through
  the inherited accessor to **`Object.prototype` itself**, so the `??=` in
  `setFlag` never assigned and the next write landed on the global prototype.
  From that moment every plain object in the process inherited the flag,
  including the check-in reply built for an unrelated, legitimate licence — and
  the route answered **200 while reporting the file as unchanged**, which is
  precisely how it would have stayed invisible.

  It needs no malice: pasting a wrong value into an id field is enough.

  Fixed in three places rather than one. The three names that can reach the
  prototype are **refused at the route** (a 400, not a silent no-op — a guard
  that returns the file unchanged reproduces the original invisibility), refused
  again in `setFlag`, and the maps themselves are now `Object.create(null)`, so a
  future door that forgets the check still has no prototype to corrupt. The flag
  NAME gets the same treatment as the id: the charset rule already excluded
  `__proto__`, but not `constructor` or `prototype`.

  The same root cause was fixed on `checkins.ts`'s roster, which is reachable
  from the **unauthenticated** check-in route: `roster["__proto__"] = {…}` sets
  that object's prototype instead of adding a row, so the check-in silently
  vanished from the roster — and from `sharingSignals`, the one thing that
  catches a key being run on several machines.

- v0.2.11 — **per-licence FEATURE FLAGS, so one bot build serves alpha and beta.**
  The bot now ships unfinished features compiled in but DARK; this is the half
  that decides who may see them. `data/flags.json` carries a `default` set plus
  per-licence overrides, and every check-in reply names the merged result.

  **WHY NOT IN THE SIGNED TOKEN.** `src/license.ts` opens with "License format
  v1 — PINNED. Any change needs a new LHK2 prefix, never a mutation of v1."
  Putting flags in the payload would break that rule, or force every issued key
  to be reissued before a single tester could be given a feature. The check-in
  reply already carries `revoked` and `latest`, is answered per licence, and
  happens daily — so flags belong there. Every key already issued gains them
  with no reissue, enabling one tester lands within a day, and disabling is
  equally cheap, which matters because the whole point is shipping things that
  are not finished.

  `flags` is **always** in the reply, even empty: the bot distinguishes an absent
  key ("this hub predates flags — leave my cache alone") from `{}` ("the hub says
  none"), and only the second can turn a feature back off. Only TRUE flags are
  emitted — an explicit `false` in `byLicense` exists to cancel a default for one
  tester, and once cancelled there is nothing to say.

  This hub keeps **no registry of valid flag names**, deliberately: the build
  that implements a flag is the authority on what it means, and the bot ignores
  names it does not know. A registry here would have to be redeployed in lockstep
  with every bot release. New: `GET`/`POST /admin/api/flags`.

- v0.2.10 — **a finished venue no longer reports a fault, and a fast clock can
  no longer store a forming bar.** Two consequences of the tail cadence, both
  found on the operator's live panel. (1) **CAUGHT UP IS NOT STALLED.** A venue
  whose symbols are all current correctly issues no requests for up to
  `HUB_CANDLE_TAIL_FILL_MIN`; the only thing still touching `lastSuccessAt` is
  the 15-minute symbol refresh, against a 10-minute stall ceiling — so a
  FINISHED venue reported STALLED for a third of every quarter-hour. Bybit hit
  it at 695 of 699 seedable with zero gaps. A pass that finds nothing due now
  reads RUNNING and says why; a collector that has stopped ticking altogether
  is still stalled. (2) **A CLOCK-SKEW GRACE.** Both closed-candle gates read
  the hub's own clock, so skew is asymmetric: behind is harmless, AHEAD accepts
  a bar the venue still considers forming — and permanently, since nothing
  re-fetches a minute already written to correct it. That failure is invisible
  from both ends: the bot discards the whole seed on any mismatch, so a skewed
  hub silently serves seeds that always fail verification while this panel
  reports perfect health. Candles are now stored only once **settled**
  (`CLOSED_GRACE_MS`, one minute), making any skew under 60 seconds
  structurally incapable of admitting a forming bar. `dropUnclosed` keeps its
  own unmargined test — that one is about the venue's framing, this is about
  our clock being wrong.
- v0.2.9 — **the tail cadence drops to 100 minutes, for the seed cross-check.**
  Page utilisation wants this number high; the bot's seed verification wants it
  low, and that is the harder bound. Every seed is checked against one recent
  venue page before a candle is accepted and **zero overlap is a failure** — an
  unverifiable seed is discarded exactly like a wrong one. Bitunix and Bitget
  pages span 200 minutes, so at the previous 150 the overlap margin was only 50
  minutes; one slow sweep past it and every seed on those venues is silently
  refused while each bot falls back to a ~12-hour venue warm-up. 100 leaves a
  100-minute margin and still fills half a page per request — 3.5x the
  utilisation this replaced. `HUB_CANDLE_TAIL_FILL_MIN` still overrides it.
- v0.2.8 — **a young listing is no longer reported as gapped.** Operator: "What
  if a pair isn't 30 days old? I think that's some of these gaps but shouldn't
  be listed as a gap?" Exactly right. When the venue answered a backfill with an
  empty page, the collector recorded "no more history here" by dragging
  `firstClosedMs` DOWN across the range it had just proved empty — and coverage
  computes `interiorMissing = span - count` from that marker, so span grew while
  count stood still and the pair reported a hole the size of its own
  **pre-listing silence**. It compounded one page per pass until it reached the
  retention horizon: newly listed Bybit equity tokens (CSOPSKHYNIX2L, MEITUAN,
  EBAY) read **25–29.5 day gaps**, and the venue totalled **1,034,104 "missing
  minutes"** that were never missing. The proven-empty floor is now tracked
  separately from held coverage — it still stops the backfill re-asking the same
  range forever, but the gap arithmetic is only ever about candles that were
  actually possible. A pair that did not exist yet is not a pair with a hole in
  it.
- v0.2.7 — **the version the hub reports is now checked, not commented.**
  `src/version.ts` carried "keep in lockstep with package.json" as a comment and
  drifted for five releases: 0.2.2 through 0.2.6 all shipped while it said
  0.2.1, so the admin page and `GET /api/health` reported a build that had not
  run for hours. `install-hub.sh` does compare the served version against
  package.json and refused correctly — but the admin **Upgrade hub** button runs
  it detached into `data/upgrade.log`, so the refusal landed where nobody looks
  while the restart itself had already succeeded. The suite now pins
  `HUB_VERSION`, `package.json` and the newest changelog entry to each other.
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
