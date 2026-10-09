# Binance coin market-cap coverage

The live signed Hub snapshot was checked on 2026-10-05: it contained 782 Bybit, 813 Bitget, 733 Bitunix, 572 Aster and 246 WEEX instruments, and zero Binance instruments. Its configured producer venue list omitted Binance. The app's venue key and symbol lookup already use binance and native uppercase symbols; inventing ticker aliases in the app would not fix this absent coverage.

The prepared producer adds Binance to the explicitly supported venue registry, the native USD-M catalogue parser, and the verified provider identity defaults. CoinMarketCap's derivatives list returned Binance id 270, slug binance, with 818 derivative pairs when inspected. The value is checked by the existing exchange-id guard on every mapping refresh. Binance's own baseAsset, quoteAsset, marginAsset, contractType and status determine eligible instruments. No identity is guessed by stripping numeric prefixes.

The tests cover non-USDT and dated-contract exclusion, non-trading instruments, malformed catalogue rows, mapped 1000PEPEUSDT with PEPE's cap unscaled, unmapped unknowns, signed snapshot verification, and explicit configuration. The provider credit ceiling and existing request budgets are unchanged. To activate coverage, the separately authorized Hub rollout must add binance to its existing MARKET_CAP_VENUES and build a fresh signed snapshot. Never relax the app's unknown-market-cap refusal while waiting for data.

The additive liquidation percentile extension is prepared with the app's matching schema and cross-repository parity checks. Existing 50–99.9 configurations use the same legacy stops; the extra quantiles serve new tail requests only.
