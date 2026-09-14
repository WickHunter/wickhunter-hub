# Timeframe candle seed v2

## Compatibility boundary

`GET /api/candles/seed` keeps its shipped minute contract unchanged when
`interval` is omitted or exactly `1`. The response remains v1, its signed bytes
remain the existing v1 bytes, and its REST-confirmed minute frontier, errors,
authentication, gzip and cache behavior do not change.

A request with a higher interval selects v2:

```text
GET /api/candles/seed?venue=<venue>&symbol=<native>&interval=<minutes>&fromMs=<ms>&toMs=<ms>
```

Supported interval strings are `3`, `5`, `15`, `30`, `60`, `120`, `180`,
`240`, `360`, `720`, and `1440`. Authentication is the existing seed rule:
`x-license` first and `?key=` as the compatibility fallback.

## Signed envelope

```json
{
  "v": 2,
  "venue": "bybit",
  "symbol": "BTCUSDT",
  "interval": "180",
  "fromMs": 1785542400000,
  "toMs": 1785553199999,
  "requiredFromMs": 1785542400000,
  "requiredClosedToMs": 1785542400000,
  "closedFrontierMs": 1785542400000,
  "availableFromMs": 1785542400000,
  "availableRows": 1,
  "requiredRows": 1,
  "complete": true,
  "rows": [[1785542400000, 1, 3, 0.5, 2, 7]],
  "gaps": [],
  "segments": [[1785542400000, 1785542400000, "aggregate", 60]],
  "keyId": "seed-1",
  "sig": "<base64 Ed25519>"
}
```

`rows` are `[openMs, open, high, low, close, baseVolume]`, oldest first,
strictly increasing and unique. Every row is aligned to
`interval * 60,000`. `fromMs` and `toMs` echo the integer request bounds.
The actual closed window is:

```text
bucketMs = interval * 60,000
requiredFromMs = ceil(fromMs / bucketMs) * bucketMs
requiredClosedToMs = min(
  floor(toMs / bucketMs) * bucketMs,
  floor(now / bucketMs) * bucketMs - bucketMs
)
requiredRows = max(0, (requiredClosedToMs - requiredFromMs) / bucketMs + 1)
```

Thus `toMs` is an inclusive time bound, while `requiredClosedToMs` is the open
timestamp of the last requested closed bucket. A forming or future bucket is
never a required row and is never returned. Native admission uses the Hub's
additional one-minute settlement grace; this can temporarily leave
`closedFrontierMs` behind `requiredClosedToMs`, which makes the response
incomplete rather than admitting a possibly forming value.

`closedFrontierMs` is the newest safely sourced returned bucket open. It is an
observation, not proof that earlier rows exist. `availableFromMs` is the oldest
returned bucket open and `availableRows` is the number of returned rows inside
this request. Successful v2 responses always contain at least one row; a cold
zero-row cache answers 503 and registers bounded background work.

`gaps` is always present. Each tuple is an inclusive run of missing required
bucket-open timestamps. `complete` is true only when the full required window
is present: `availableRows === requiredRows`, gaps are empty, and every exact
slot exists. Clients must still derive this from the signed rows and gaps and
must check freshness; the boolean is a report, not a relaxation.

`segments` is always present and exactly covers returned rows. Each tuple is:

```text
[firstOpenMs, lastOpenMs, "native" | "aggregate", baseIntervalMinutes]
```

For `native`, the base interval equals the response interval. For `aggregate`,
the base is a proper divisor. Aggregation uses first open, maximum high,
minimum low, last close and summed base volume, and is allowed only when every
constituent base row exists and has REST provenance. Adjacent rows with the
same source and base coalesce into one segment. Native target rows take
deterministic precedence over derived rows; a later native REST read may
correct a native row.

The signature is Ed25519 over UTF-8 `JSON.stringify` of a fresh object literal,
with no replacer, whitespace or trailing newline, and with `sig` removed. The
canonical key order is exactly:

```text
v, venue, symbol, interval, fromMs, toMs, requiredFromMs,
requiredClosedToMs, closedFrontierMs, availableFromMs, availableRows,
requiredRows, complete, rows, gaps, segments, keyId
```

The response appends `sig` last. Numbers use JavaScript JSON number formatting.
V2 adds an ETag over the exact signed response bytes and honors
`If-None-Match`; an ETag is only a transport cache key and does not replace
signature, identity, row, segment or venue comparison checks.

## Native support and bounded fallback

Native interval support is explicit, based on each venue's documented route:

| venue | native higher intervals used by the Hub |
| --- | --- |
| Bybit | 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440 |
| Bitunix | 3, 5, 15, 30, 60, 120, 240, 1440 |
| Bitget | 3, 5, 15, 30, 60, 240, 360, 720, 1440 |
| Binance | 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440 |
| Aster | 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440 |
| WEEX | 60, 240, 720, 1440 |

The mapping is mirrored by the app's field-verified
`src/venues/kline-intervals.ts`: Bitunix documents 3m/2h on its public futures
kline endpoint, and the Aster adapter records its 2026-08-17 public BTCUSDT
interval-by-interval verification plus rejected invalid controls. Aster's
official `asterdex/api-docs` repository documents the `/fapi/v1/klines` row
shape and interval enumeration. WEEX documents `/capi/v3/market/klines` as
weight 1 with at most 1,000 newest rows; the Hub limits its native WEEX set to
widths whose 30-day retention fits that single page. The existing older 1m
history route remains capped at 100 rows and weight 5.

Primary route evidence:

- [Bybit v5 Get Kline](https://bybit-exchange.github.io/docs/v5/market/kline)
- [Bitunix Get Kline](https://www.bitunix.com/api-docs/futures/market/get_kline)
- [Bitget futures history candles](https://www.bitget.com/api-doc/contract/market/Get-History-Candle-Data)
- [Binance USD-M Kline/Candlestick Data](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data)
- [Aster public API documentation](https://github.com/asterdex/api-docs)
- [WEEX Get Kline](https://www.weex.com/api-doc/contract/Market_API/GetKlines) and [access restrictions](https://www.weex.com/api-doc/contract/QuickStart/AccessRestrictions)

The bounded 2026-09-14 WEEX read-only check used no authentication or orders.
`/capi/v3/market/exchangeInfo` returned this sanitized rate-limit fact:
`REQUEST_WEIGHT`, `interval=MINUTE`, `intervalNum=10`, `limit=500` (50 weight
per minute averaged). One three-row BTCUSDT `interval=1h` request returned
ascending, hour-aligned opens with the documented OHLCV shape. The route docs
assign weight 1 and permit 1,000 rows. The Hub uses half the published envelope:
25 weight/minute. It does not raise the legacy weight-5 history route above five
pages/minute or raise any other collector.

An unsupported target uses the largest compatible smaller native interval.
For example, Bybit 180-minute history folds three complete native 60-minute
bars. If no proved native divisor exists, the Hub uses its REST-confirmed 1m
history. It never expands a coarse bar into minute rows and never folds across
a missing base row.

Native fetches run inside the existing per-venue collector. Live minute tails,
REST reconciliation and interior-gap repair remain ahead of all depth work.
Demanded timeframe depth and ordinary 1m deep backfill are interleaved by
request weight, with their first turn alternating each tick. They share the same
request budget, pacing, request-weight alarms, Retry-After handling, adaptive
rate and cooldown. Duplicate demand keys coalesce and the in-memory demand set
is capped at 4,096 entries with a six-hour inactive expiry. The oldest inactive
series can be evicted beyond that bound and its next app request registers it
again. Interests are capped at 4,096 symbols, while 8,192 materialization
entries accommodate 700 pairs at all 11 offered higher intervals; both indexes
also expire after six idle hours.

The binary cache is keyed by exact venue, venue-native symbol and interval.
Each slot stores source and base interval beside OHLCV; native frontiers persist
atomically in `candle-timeframes-v2/native-frontier.v2.json`. Interval day files
remain for the configured minute retention plus one full UTC day of boundary
padding. The collectors admit only their existing USDT-margined perpetual
census. A persisted census-generation identity fences every venue/symbol; if a
delisted spelling reappears, its prior interval files and frontiers are removed
before the new book can use them. The existing v1 minute files and retention are unchanged. REST writes
rebuild only aggregate buckets they overlap; a websocket row cannot advance
aggregate provenance before ordinary REST reconciliation confirms it.

Native and restored slots require finite positive prices, ordered high/low, a
close inside that range, and finite nonnegative volume. Opens are also inside
the range on every venue except Bitunix's verified carried-open shape: an
out-of-range Bitunix open is retained exactly only when it equals the prior
row's close and the rows are adjacent by the requested interval. An unproven
first boundary is unavailable. No tolerance or price clamping is applied.

Warm-cache Hub serving performs no venue history requests; the client still
performs its required matching-venue overlap verification. Only requested
series receive proactive native warmup. Cached rows, native frontiers and
instrument-generation fences persist across restart; demand does not, and the
first app request after restart reconstructs it. Cold caches, new listings,
missing base history and venue outages return 503 or a signed partial response
with exact gaps; they do not claim the warm-cache startup target. At the
unchanged conservative WEEX 25-weight/minute share, the deterministic 48-second
scheduler pass serves 21 cheap current pages when no other work competes: an
optimistic 34-minute floor for 700 cold hourly pairs. With legacy 1m backfill
continuously present, cost-weighted fairness produced 11 native pages and two
weight-5 legacy pages in the same pass, an optimistic 64-minute floor. Urgent
tails/reconciliation/repairs, retries, empty listings and client verification
can only increase those times. They are cold recovery bounds, not startup SLAs.
