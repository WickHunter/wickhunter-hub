import fs from 'node:fs';
import path from 'node:path';
import type { CustomerRecord } from './store.js';
import type { LaunchIntent } from './launch.js';
import type { StripeEvent } from './stripe.js';

export const STARTER_PACK_END_MS = Date.parse('2026-10-16T00:00:00-04:00');
const STARTER_PACK_START_MS = Date.parse('2026-10-01T00:00:00-04:00');

/** A grant follows a new, verified launch checkout completed during the
 * October offer. Delivery time and email status never decide eligibility. */
export function starterPackGrantAt(intent: LaunchIntent | null, event: StripeEvent, firstPurchase: boolean): number | null {
  if (!intent || intent.mode !== 'live' || !firstPurchase || !event.livemode ||
      !Number.isSafeInteger(intent.createdAtMs) || !Number.isSafeInteger(event.createdMs) ||
      intent.createdAtMs < STARTER_PACK_START_MS || intent.createdAtMs >= STARTER_PACK_END_MS ||
      event.createdMs < STARTER_PACK_START_MS || event.createdMs >= STARTER_PACK_END_MS) return null;
  return event.createdMs;
}

export function starterPackEligible(rec: CustomerRecord): boolean {
  return rec.livemode && rec.launchManaged === true && !rec.refunded && !rec.disputed &&
    Number.isSafeInteger(rec.starterPackGrantedAtMs) &&
    Number(rec.starterPackGrantedAtMs) >= STARTER_PACK_START_MS &&
    Number(rec.starterPackGrantedAtMs) < STARTER_PACK_END_MS;
}

interface BotExport { ok: boolean; kind: string; v: number; name: string; exportedAt: number; app: string; bots: Array<{ type: string; config: Record<string, unknown>; label?: string }> }

function readBot(file: string, type: string): BotExport {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as BotExport;
  if (value?.kind !== 'liqhunter-config' || value.v !== 1 || !value.ok || !Array.isArray(value.bots) ||
      value.bots.length !== 1 || value.bots[0]?.type !== type || !value.bots[0]?.config) {
    throw Error('Starter pack export has an unexpected format');
  }
  return value;
}

export function loadStarterPack(templatesDir: string) {
  const dir = path.join(templatesDir, 'starter-pack');
  const liquidation = readBot(path.join(dir, 'liquidation-bot.json'), 'bot1');
  const hedge = readBot(path.join(dir, 'hedge-bot.json'), 'bot3');
  if (liquidation.app !== hedge.app) throw Error('Starter pack exports target different app versions');
  const bundle: BotExport = {
    ok: true, kind: 'liqhunter-config', v: 1, name: 'Wick Hunter Starter Pack',
    exportedAt: Math.max(liquidation.exportedAt, hedge.exportedAt), app: liquidation.app,
    bots: [liquidation.bots[0], hedge.bots[0]],
  };
  const entry = liquidation.bots[0].config.entry as Record<string, unknown>;
  const strategy = liquidation.bots[0].config.strategy as Record<string, unknown>;
  const hedgeRules = hedge.bots[0].config.hedge as Record<string, unknown>;
  const rungs = Array.isArray(strategy.dcaRungs) ? strategy.dcaRungs as Array<Record<string, unknown>> : [];
  return {
    bundle: JSON.stringify(bundle, null, 2),
    liquidation: JSON.stringify(liquidation, null, 2),
    hedge: JSON.stringify(hedge, null, 2),
    summary: {
      liquidation: `${entry.side} entries · ${entry.leverage}× leverage · ${entry.entrySizeUsd}% of balance entry · builder DCA rung sizes ${rungs.map(r => r.size).join(', ')}% of balance · ${strategy.tpPct}% take profit`,
      hedge: `${Array.isArray(hedgeRules.levels) ? hedgeRules.levels.length : 0} hedge levels · choose pairs and review before enabling`,
    },
  };
}
