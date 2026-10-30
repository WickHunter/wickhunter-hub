// src/candles/bitunix-migration.ts
// v0.4.102 — ONE-SHOT: discard Bitunix candles stored under the mixed-unit
// contract, so no served window can mix quote turnover with base volume.
//
// Through 0.4.101 every REST-written Bitunix row stored `quoteVol` (USDT
// turnover, ~price x the coin volume) and every websocket-written row stored
// `b` (coin volume); REST reconcile overwrote most websocket rows, so the
// 30-day store is quote turnover with base-volume rows at its tail (checked
// read-only on the production Hub 2026-10-30: BTCUSDT 2026-10-28 rows hold
// ~543,360 where the coin volume was ~6.67; the newest rows hold coin volume).
//
// The store has no per-row provenance and a slot cannot hold "volume
// unknown", so the rows cannot be repaired in place, and converting turnover
// by a price would fabricate a quantity. Waiting 30 days for retention would
// serve mixed windows for 30 days. So the Bitunix venue's minute files, its
// REST frontier and its higher-timeframe cache are REMOVED once, before any
// collector or cache reads them; the collector then re-backfills from REST
// under the base-volume contract (bitunix-volume.ts). While it does, Bitunix
// seeds report gaps/503 exactly as for a new venue — absence, never a wrong
// number. The marker is written only AFTER the removal, so a crash part-way
// re-runs the (idempotent) removal on the next boot. Other venues are not
// touched.

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic, writeTextAtomic } from "../jsonfile.js";
import { BITUNIX_VOLUME_CONTRACT } from "./bitunix-volume.js";

export const BITUNIX_VOLUME_MARKER = ".volume-contract";

export interface BitunixMigrationResult {
  /** True when this call removed pre-contract data. */
  migrated: boolean;
  removedSymbols: number;
  removedTimeframeSymbols: number;
  removedFrontiers: number;
}

/** `collecting`: this Hub runs a Bitunix collector, so the marker is written
 *  even on a fresh data dir (everything it collects from now on is base
 *  volume). Without one, nothing is created unless pre-contract data exists. */
export function migrateBitunixVolumeContract(dataDir: string, log: (m: string) => void = () => {}, collecting = true): BitunixMigrationResult {
  const venueDir = path.join(dataDir, "candles", "bitunix");
  const marker = path.join(venueDir, BITUNIX_VOLUME_MARKER);
  const result: BitunixMigrationResult = { migrated: false, removedSymbols: 0, removedTimeframeSymbols: 0, removedFrontiers: 0 };
  if (!collecting && !fs.existsSync(venueDir) && !fs.existsSync(path.join(dataDir, "candle-timeframes-v2", "bitunix"))) return result;
  let current: string | null = null;
  try { current = fs.readFileSync(marker, "utf8").trim(); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let rolledBack = false;
  if (current === BITUNIX_VOLUME_CONTRACT) {
    // A rollback to <=0.4.101 after this migration would re-collect quote
    // turnover under a marker that says base. Those builds rewrite the REST
    // frontier without its `volumeContract` field (collector.ts), so a present
    // frontier lacking the field means old-reader rows: discard them again.
    const frontier = readJson<{ volumeContract?: unknown } | null>(path.join(venueDir, "rest-frontier.json"), null);
    if (frontier === null || frontier.volumeContract === BITUNIX_VOLUME_CONTRACT) return result;
    rolledBack = true;
  }

  // Minute store + collector REST frontier. symbols.json (the venue roster)
  // carries no candle values and is kept.
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(venueDir, { withFileTypes: true }); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      fs.rmSync(path.join(venueDir, e.name), { recursive: true, force: true });
      result.removedSymbols++;
    }
  }
  fs.rmSync(path.join(venueDir, "rest-frontier.json"), { force: true });
  // Venue-empty ranges (collector.ts) were proven against the discarded
  // rows' coverage; they start again with the re-collected store.
  fs.rmSync(path.join(venueDir, "venue-empty.v1.json"), { force: true });

  // Higher-timeframe cache: native Bitunix pages read `quoteVol` too, and
  // aggregates fold minute volumes.
  const tfRoot = path.join(dataDir, "candle-timeframes-v2");
  const tfVenue = path.join(tfRoot, "bitunix");
  try {
    result.removedTimeframeSymbols = fs.readdirSync(tfVenue, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  fs.rmSync(tfVenue, { recursive: true, force: true });
  const frontierFile = path.join(tfRoot, "native-frontier.v2.json");
  if (fs.existsSync(frontierFile)) {
    const f = readJson<{ v?: number; frontiers?: Record<string, number> }>(frontierFile, { v: 2, frontiers: {} });
    const frontiers = f.frontiers ?? {};
    const kept: Record<string, number> = {};
    for (const [k, v] of Object.entries(frontiers)) {
      if (k.startsWith("bitunix\u0000")) result.removedFrontiers++;
      else kept[k] = v;
    }
    if (result.removedFrontiers > 0) writeJsonAtomic(frontierFile, { ...f, frontiers: kept });
  }

  fs.mkdirSync(venueDir, { recursive: true });
  writeTextAtomic(marker, `${BITUNIX_VOLUME_CONTRACT}\n`);
  result.migrated = rolledBack || current !== null || result.removedSymbols > 0 || result.removedTimeframeSymbols > 0 || result.removedFrontiers > 0;
  if (result.migrated) {
    log(`bitunix: ${rolledBack ? "a pre-0.4.102 build wrote this store after the migration; " : ""}discarded ${result.removedSymbols} symbols' minute candles and ${result.removedTimeframeSymbols} symbols' timeframe cache stored under the pre-0.4.102 mixed volume units (REST quoteVol + WS base); re-collecting from REST with base volume (${BITUNIX_VOLUME_CONTRACT})`);
  }
  return result;
}
