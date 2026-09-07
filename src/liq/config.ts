// src/liq/config.ts
// The liquidation recorder's env contract, in one place — the same shape
// `marketcap/config.ts` and `candles/service.ts`'s `collectorOptionsFromEnv`
// use, so `main.ts`'s single `configFromEnv()` call stays the one place a
// misconfiguration can surface, never a throw that takes the whole process
// with it (`marketcap/config.ts`'s own header records why that rule exists).
import { isLiqSourceId, LIQ_SOURCE_IDS, type LiqSourceId } from "./sources.js";
import { DEFAULT_LIQ_SERVICE_CONFIG, type LiqServiceConfig } from "./service.js";

export interface LiqEnv {
  HUB_LIQ_RECORD?: string;
  HUB_LIQ_SOURCES?: string;
  HUB_LIQ_RETENTION_DAYS?: string;
  HUB_LIQ_WINDOW_DAYS?: string;
  HUB_LIQ_MAX_PRINTS?: string;
  HUB_LIQ_REBUILD_MS?: string;
  HUB_LIQ_FLUSH_MS?: string;
  HUB_LIQ_PRUNE_MS?: string;
  HUB_LIQ_ROSTER_REFRESH_MS?: string;
  HUB_LIQ_BYBIT_LINEAR_WS?: string;
  HUB_LIQ_BYBIT_INVERSE_WS?: string;
  HUB_LIQ_BYBIT_REST?: string;
  HUB_LIQ_BINANCE_FWS?: string;
  HUB_LIQ_BINANCE_DWS?: string;
  HUB_LIQ_BINANCE_DAPI?: string;
  HUB_LIQ_OKX_WS?: string;
  HUB_LIQ_OKX_REST?: string;
}

const num = (raw: string | undefined, fallback: number, min: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/** `HUB_LIQ_RECORD` defaults ON — recording costs nothing but disk (no paid
 *  credit, unlike the market-cap producer) and every source is WS-only with
 *  no history endpoint anywhere, so a print not recorded the instant it
 *  prints is gone forever. `=0` is the one way to turn the whole feature off. */
export function liqRecordEnabled(env: LiqEnv = process.env as LiqEnv): boolean {
  return (env.HUB_LIQ_RECORD ?? "1") !== "0";
}

/** Comma list of source ids (see `sources.ts`'s `LIQ_SOURCE_IDS`); empty or
 *  absent means every source. Unknown tokens are dropped rather than
 *  refused — this must never be the variable that stops the hub booting. */
export function liqSourcesFromEnv(env: LiqEnv = process.env as LiqEnv): readonly LiqSourceId[] {
  const raw = (env.HUB_LIQ_SOURCES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const wanted = [...new Set(raw.filter(isLiqSourceId))];
  return wanted.length ? wanted : LIQ_SOURCE_IDS;
}

export function liqServiceConfigFromEnv(env: LiqEnv = process.env as LiqEnv, dataDir: string): LiqServiceConfig {
  const d = DEFAULT_LIQ_SERVICE_CONFIG;
  return {
    dataDir,
    sources: liqSourcesFromEnv(env),
    retentionDays: num(env.HUB_LIQ_RETENTION_DAYS, d.retentionDays, 1),
    windowDays: num(env.HUB_LIQ_WINDOW_DAYS, d.windowDays, 1),
    maxPrints: num(env.HUB_LIQ_MAX_PRINTS, d.maxPrints, 1),
    flushMs: num(env.HUB_LIQ_FLUSH_MS, d.flushMs, 500),
    pruneMs: num(env.HUB_LIQ_PRUNE_MS, d.pruneMs, 60_000),
    rebuildMs: num(env.HUB_LIQ_REBUILD_MS, d.rebuildMs, 60_000),
    bybitLinearUrl: env.HUB_LIQ_BYBIT_LINEAR_WS?.trim() || d.bybitLinearUrl,
    bybitInverseUrl: env.HUB_LIQ_BYBIT_INVERSE_WS?.trim() || d.bybitInverseUrl,
    bybitRestBase: env.HUB_LIQ_BYBIT_REST?.trim() || d.bybitRestBase,
    binanceUsdtWsUrl: env.HUB_LIQ_BINANCE_FWS?.trim() || d.binanceUsdtWsUrl,
    binanceCoinWsUrl: env.HUB_LIQ_BINANCE_DWS?.trim() || d.binanceCoinWsUrl,
    binanceDapiBase: env.HUB_LIQ_BINANCE_DAPI?.trim() || d.binanceDapiBase,
    okxWsUrl: env.HUB_LIQ_OKX_WS?.trim() || d.okxWsUrl,
    okxRestBase: env.HUB_LIQ_OKX_REST?.trim() || d.okxRestBase,
    rosterRefreshMs: num(env.HUB_LIQ_ROSTER_REFRESH_MS, d.rosterRefreshMs, 60_000),
  };
}
