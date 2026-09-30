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

The candidate still requires a complete test gate and the unchanged live
freshness check before being recorded as deployed.
