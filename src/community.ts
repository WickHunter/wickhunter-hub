// src/community.ts
// The COMMUNITY STRAT GALLERY. One artifact: data/community.json — the whole
// set rewritten atomically, because entries are few (capped at 500) and a
// rewrite is simpler than a side index, exactly as feedback.ts argues.
//
// ── WHAT A STRAT IS ─────────────────────────────────────────────────────────
// One or more BOTS shared under one name: "a liq bot and a hedge bot together"
// (operator, 2026-08-12). Self-contained — a Strat carries the full config of
// every bot in it, never a reference to another Strat. The alternative was a
// combo pointing at member shares by id, and it fails the moment an author
// deletes a member: every combo built on it silently loses a bot, and the
// person importing has no way to tell.
//
// ── IDENTITY COMES FROM THE TOKEN, NEVER THE BODY ──────────────────────────
// This is the rule feedback.ts already states ("name from the VERIFIED token
// payload, never the body") and it matters more here, because this surface has
// a DESTRUCTIVE operation. Ownership is the LICENCE ID out of the verified
// payload. The bot also sends an `install` string and a free-text `author`;
// both are display-only and neither may ever decide who can delete what. A
// client can put anything in a body — it cannot forge a signed licence.
//
// One vote per LICENCE for the same reason.
//
// ── NO PERFORMANCE NUMBERS, AND NOTHING SAID ───────────────────────────────
// There is deliberately no verified-backtest field here, and none may be added
// without asking. A Strat can hold bots whose INTERACTION (a hedge layered
// under a liq bot) no replay models, so any figure would describe something
// other than the thing being copied. The gallery shows the CONFIG.
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readJson, writeJsonAtomic } from "./jsonfile.js";

const FILE = "community.json";

/** Bot types the gallery accepts. Mirrors the bot's own SHARE_TYPES; an
 *  unknown type is refused rather than stored, so the gallery can never offer
 *  a card the importing install has no idea what to do with. */
export const COMMUNITY_BOT_TYPES = ["grid", "bot1", "tv", "sb", "bot3"] as const;
export type CommunityBotType = (typeof COMMUNITY_BOT_TYPES)[number];

export const STRAT_MAX = 500;
export const STRAT_BOTS_MAX = 10;
export const STRAT_BYTES_MAX = 128 * 1024;

export interface CommunityBot {
  type: CommunityBotType;
  config: Record<string, unknown>;
  label?: string;
}

export interface CommunityStrat {
  id: string;
  at: number;
  /** THE OWNER, from the verified licence payload. Never sent to a client. */
  licenseId: string;
  /** Free text, display only — it proves nothing and gates nothing. */
  author: string;
  name: string;
  desc: string;
  bots: CommunityBot[];
  /** licenceId -> vote. One per licence; re-voting replaces, 0 clears. */
  votes: Record<string, 1 | -1>;
  removed?: boolean;
}

/** What a browsing install sees. No licenceId, ever — not the owner's and not
 *  the voters'. `mine` is computed per request from the ASKING licence. */
export interface CommunityStratView {
  id: string; name: string; desc: string; author: string;
  bots: CommunityBot[]; at: number;
  up: number; down: number; score: number;
  mine?: true;
}

const s60 = (v: unknown) => String(v ?? "").slice(0, 60);
const s400 = (v: unknown) => String(v ?? "").slice(0, 400);

export class CommunityService {
  private items = new Map<string, CommunityStrat>();

  constructor(private readonly dataDir: string) {
    const raw = readJson<{ items?: unknown[] }>(this.file(), { items: [] });
    for (const it of raw.items ?? []) {
      const rec = it as CommunityStrat | null;
      if (rec && typeof rec === "object" && rec.id) this.items.set(rec.id, rec);
    }
  }

  private file(): string { return path.join(this.dataDir, FILE); }
  private persist(): void { writeJsonAtomic(this.file(), { items: [...this.items.values()] }); }

  /** Validate a bot list off the wire. Returns the cleaned list or a reason.
   *  Caps are enforced HERE regardless of what the bot claims to cap. */
  private static parseBots(raw: unknown): { bots: CommunityBot[] } | { error: string } {
    if (!Array.isArray(raw) || !raw.length) return { error: "a strategy needs at least one bot" };
    if (raw.length > STRAT_BOTS_MAX) return { error: `a strategy is capped at ${STRAT_BOTS_MAX} bots` };
    const bots: CommunityBot[] = [];
    for (let i = 0; i < raw.length; i++) {
      const b = raw[i] as Partial<CommunityBot> | null;
      const at = `Bot ${i + 1}`;
      if (!b || typeof b !== "object") return { error: `${at} is not a bot` };
      if (!COMMUNITY_BOT_TYPES.includes(b.type as CommunityBotType)) return { error: `${at}: unknown bot type "${String(b.type)}"` };
      if (!b.config || typeof b.config !== "object" || Array.isArray(b.config)) return { error: `${at}: config must be an object` };
      bots.push({ type: b.type as CommunityBotType, config: b.config as Record<string, unknown>, ...(b.label ? { label: s60(b.label) } : {}) });
    }
    // ONE cap for the whole Strat, not per bot: ten bots each just under a
    // per-bot ceiling is the same storage problem the ceiling exists to stop.
    if (JSON.stringify(bots).length > STRAT_BYTES_MAX) return { error: "strategy too large" };
    return { bots };
  }

  /** Publish, or REPLACE this licence's own Strat of the same name — an
   *  improved version is one action, not litter. Votes survive a republish. */
  publish(p: { licenseId: string; name: unknown; desc?: unknown; author?: unknown; bots: unknown }): { ok: true; id: string } | { ok: false; error: string } {
    const name = s60(p.name).trim();
    if (!name) return { ok: false, error: "name required" };
    const parsed = CommunityService.parseBots(p.bots);
    if ("error" in parsed) return { ok: false, error: parsed.error };

    const prior = [...this.items.values()].find((x) => x.licenseId === p.licenseId && x.name === name && !x.removed);
    const id = prior?.id ?? "s" + randomBytes(5).toString("hex");
    this.items.set(id, {
      id, at: Date.now(), licenseId: p.licenseId,
      author: s60(p.author) || "anonymous",
      name, desc: s400(p.desc),
      bots: parsed.bots,
      votes: prior?.votes ?? {},
    });
    // Capacity: drop the lowest-scored, oldest entries past the cap.
    if (this.items.size > STRAT_MAX) {
      const surplus = [...this.items.values()]
        .filter((x) => !x.removed)
        .sort((a, b) => this.scoreOf(a) - this.scoreOf(b) || a.at - b.at)
        .slice(0, this.items.size - STRAT_MAX);
      for (const x of surplus) this.items.delete(x.id);
    }
    this.persist();
    return { ok: true, id };
  }

  /** One vote per LICENCE. Re-voting replaces; 0 clears. */
  vote(id: unknown, licenseId: string, vote: unknown): { ok: boolean; error?: string } {
    const it = this.items.get(String(id ?? ""));
    if (!it || it.removed) return { ok: false, error: "unknown strategy" };
    const v = Number(vote);
    if (v === 0) delete it.votes[licenseId];
    else if (v === 1 || v === -1) it.votes[licenseId] = v;
    else return { ok: false, error: "vote must be 1, -1 or 0" };
    this.persist();
    return { ok: true };
  }

  /** An author deletes their OWN Strat, keyed on the verified licence.
   *
   *  A wrong owner and an unknown id return the SAME false. A hub that
   *  distinguished them would confirm the existence of arbitrary ids to anyone
   *  holding any valid licence. HARD delete, not a tombstone: the author asked
   *  for it gone, and a hidden row would keep their config on our disk after
   *  they had every reason to believe otherwise. */
  deleteOwn(id: unknown, licenseId: string): boolean {
    const it = this.items.get(String(id ?? ""));
    if (!it || it.removed || it.licenseId !== licenseId) return false;
    this.items.delete(it.id);
    this.persist();
    return true;
  }

  /** Admin moderation — a tombstone, unlike an author's own delete: the
   *  operator may need to know what was removed and by whose licence. */
  remove(id: unknown): boolean {
    const it = this.items.get(String(id ?? ""));
    if (!it) return false;
    it.removed = true;
    this.persist();
    return true;
  }

  private scoreOf(x: CommunityStrat): number {
    let up = 0, down = 0;
    for (const v of Object.values(x.votes)) v === 1 ? up++ : down++;
    return up - down;
  }

  /** The public gallery, score-sorted. `asking` decides `mine` and is never
   *  echoed back. */
  list(asking?: string): CommunityStratView[] {
    return [...this.items.values()].filter((x) => !x.removed).map((x) => {
      let up = 0, down = 0;
      for (const v of Object.values(x.votes)) v === 1 ? up++ : down++;
      return {
        id: x.id, name: x.name, desc: x.desc, author: x.author,
        bots: x.bots, at: x.at,
        up, down, score: up - down,
        ...(asking && x.licenseId === asking ? { mine: true as const } : {}),
      };
    }).sort((a, b) => b.score - a.score || b.at - a.at);
  }

  /** Admin view — the only place a licenceId is exposed, so the operator can
   *  see who published what when moderating. */
  listAdmin(): CommunityStrat[] {
    return [...this.items.values()].sort((a, b) => b.at - a.at);
  }
}
