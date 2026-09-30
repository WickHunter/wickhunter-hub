# Candle freshness investigation

The Hub on 45.76.105.174 was behind on Bybit, Binance and Aster on September 30
UTC. Open sockets and a recent symbol-list refresh did not prove fresh candles.
Alpha's separate update attempt also encountered slow Hub seeds; its readiness
guard restored Alpha 0.90.145 and preserved current trading data.

Hub 0.4.63 bounded collector queue preparation but did not pass the live check:
BTCUSDT candles from all three affected venues had to advance and be no more
than ten minutes old within ten minutes. Binance and Aster initially advanced;
Bybit did not. The deployment helper restored Hub 0.4.62 code, preserving all
current Hub data. Beta 0.90.135 was not changed.

A 22-second Node CPU profile attributed about 48% of sampled time to the admin
status route's full-roster coverage prime. Deep coverage decoded five price and
volume values and allocated an object for every occupied minute merely to count
it. The admin request timed out after 120 seconds, leaving the scan running.
An independent public Bybit BTCUSDT WebSocket probe subscribed successfully and
received updates from the same host.

The diagnostic inspector cleanup used an unsupported dynamic import and caused
one unhandled rejection at 03:32:48 UTC. Systemd restarted the Hub; the inspector
port closed. Alpha's trading service was not restarted by this diagnostic.
Do not reuse that cleanup expression. The failed freshness gate and rollback
evidence remain in `/root/wh-hub0463-candles-20260929` on the host.

The 0.4.64 candidate bounds admin priming, reports unchecked coverage explicitly,
counts exact timestamp slots without decoding candle values, and finds the first
repair gap without constructing the entire candle window. In a local synthetic
30-day fixture, twenty exact coverage scans took 107 ms before and 51 ms after;
twenty early-gap lookups took 152 ms before and 1 ms after, with identical facts.
These are local measurements, not a production throughput guarantee.

Hub 0.4.64 is verified live from `b201ec55355d6446a7c2fbce6c4bb93b83525d95`.
All 76 test suites passed. The unchanged live gate observed all three BTCUSDT
samples advance to 03:46 UTC, within its ten-minute age bound. The admin
status request returned in 0.24 seconds; header-based update metadata/download
authentication passed and invalid credentials were rejected. Alpha services and
Beta release artifacts remained unchanged during the Hub deployment. See
[deployment](HUB-0464-DEPLOYMENT.json) and [verification](HUB-0464-VERIFICATION.json).

A second 22-second CPU profile found the full admin scanner gone. Remaining
activity was distributed across stream snapshot writes, seed requests and the
startup liquidation percentile rebuild. Its diagnostic cleanup closed the
inspector without restarting the process. Cold coverage still warms in bounded
slices; unchecked symbols and known historical gaps remain explicitly reported.

At the final observation after Alpha146 passed readiness, stored BTCUSDT
candles on all six configured venues were 2.6–5.6 minutes old. Bybit, Binance
and Aster REST-confirmed BTC history was 3.6–5.6 minutes old; WEEX confirmation
was still 21.6 minutes old within its slower reconciliation lane. The admin
request completed in 2.0 seconds under load. Historical gaps and unchecked
coverage are still present and explicitly reported; this is a freshness
recovery, not a claim that every historical gap has been repaired.
[Final observation](HUB-0464-FRESHNESS-OBSERVATION.json).
