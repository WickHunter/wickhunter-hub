// src/seats.ts
// ONE LICENCE, ONE VPS — enforced at the check-in seam, with no bot change.
//
// Until now the Hub only REPORTED sharing (`sharingSignals`: distinct installs
// inside 48 h). The check-in reply is the enforcement point that already
// exists: `revoked:true` puts an install into exit-only (durable marker on
// the box) and a later plain `ok` lifts it. So the Hub binds each licence to
// the first install id that checks in — its SEAT — and answers every other
// install `revoked:true` while the seat holder is alive. Nothing is written
// to the registry: the licence itself stays valid, only the extra install is
// refused, and the refusal is lifted by itself the moment the seat frees.
//
// WHY A SEAT FREES ON SILENCE rather than never: the honest case that must
// keep working is a move. A customer reinstalls on a new VPS (new install
// id) and destroys the old one; the old one stops checking in at once. After
// `releaseAfterMs` of silence (default 30 min, six missed check-ins) the
// seat is free and the new install takes it on its next check-in — which is
// also exactly the window a sharer cannot fake: two live boxes both check in
// every five minutes, so neither ever goes silent, so the second is refused
// for as long as the first runs.
//
// WHAT THIS CANNOT SEE: a copied `data/` directory carries the install id,
// so two clones present the SAME identity. They still betray themselves by
// checking in from two IPs in the same window; that is surfaced as a clone
// signal (and may be enforced, off by default — home lines behind carrier NAT
// can legitimately change egress IP). Closing that gap for good is the
// machine-bound lease (an install-held private key), whose Hub half already
// ships and whose bot half is a separate rollout.
import path from "node:path";
import { readJson, writeJsonAtomic } from "./jsonfile.js";

export const SEATS_FILE = "license-seats.v1.json";
export const DEFAULT_SEAT_RELEASE_MS = 30 * 60_000;
export const DEFAULT_SEAT_LIMIT = 1;
/** IP history kept per install, for the clone signal. */
const IP_HISTORY_MS = 60 * 60_000;
const IP_HISTORY_MAX = 40;
/** Distinct IPs inside this window is the clone signal. */
const CLONE_WINDOW_MS = 15 * 60_000;
/** A→B→A→B: three switches inside the history window is the enforceable one. */
const CLONE_SWITCHES = 3;
const MAX_SEAT_LIMIT = 50;

export interface SeatPolicy {
  /** Refuse a second live install (default on). Off = record only. */
  enforce: boolean;
  /** Silence after which a seat holder is considered gone. */
  releaseAfterMs: number;
  /** Refuse an install whose id checks in from alternating IPs (default off). */
  cloneEnforce: boolean;
  /** Installs a licence may run at once unless overridden per licence. */
  defaultLimit: number;
}

export const DEFAULT_SEAT_POLICY: SeatPolicy = {
  enforce: true,
  releaseAfterMs: DEFAULT_SEAT_RELEASE_MS,
  cloneEnforce: false,
  defaultLimit: DEFAULT_SEAT_LIMIT,
};

export function seatPolicyFromEnv(env: NodeJS.ProcessEnv): SeatPolicy {
  const minutes = Number(env.HUB_SEAT_RELEASE_MINUTES ?? 30);
  const limit = Number(env.HUB_SEAT_DEFAULT_LIMIT ?? DEFAULT_SEAT_LIMIT);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error("HUB_SEAT_RELEASE_MINUTES must be 1..1440");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEAT_LIMIT) throw new Error(`HUB_SEAT_DEFAULT_LIMIT must be 1..${MAX_SEAT_LIMIT}`);
  return {
    enforce: (env.HUB_SEAT_ENFORCE ?? "1") !== "0",
    releaseAfterMs: Math.round(minutes * 60_000),
    cloneEnforce: (env.HUB_SEAT_CLONE_ENFORCE ?? "0") === "1",
    defaultLimit: limit,
  };
}

export interface SeatInstall {
  installId: string;
  firstSeenMs: number;
  lastSeenMs: number;
  lastIp: string;
  /** Recent (ip, at) samples, newest last, pruned to IP_HISTORY_MS. */
  recentIps: Array<{ ip: string; at: number }>;
}

export interface SeatRecord {
  licenseId: string;
  /** Per-licence override of the policy's default limit. */
  limit?: number;
  installs: SeatInstall[];
  refused: number;
  lastRefusedAtMs: number | null;
  lastRefusedInstallId: string | null;
  lastRefusedIp: string | null;
  /** Set by an admin release; cleared when the next install binds. */
  releasedAtMs: number | null;
}

interface SeatsFile {
  v: 1;
  seats: Record<string, SeatRecord>;
}

export interface CloneSignal {
  /** Distinct IPs inside the last CLONE_WINDOW_MS. */
  ips: number;
  /** IP changes between consecutive check-ins inside the history window. */
  switches: number;
  windowMinutes: number;
}

export type AdmitResult =
  | { admitted: true; seat: SeatRecord; bound: boolean; evicted: string[]; clone: CloneSignal | null }
  | { admitted: false; reason: "seat-taken" | "clone"; seat: SeatRecord; clone: CloneSignal | null };

export interface SeatView {
  limit: number;
  enforce: boolean;
  installs: Array<{ installId: string; firstSeenMs: number; lastSeenMs: number; lastIp: string; alive: boolean; clone: CloneSignal | null }>;
  refused: number;
  lastRefusedAtMs: number | null;
  lastRefusedInstallId: string | null;
  lastRefusedIp: string | null;
  releasedAtMs: number | null;
}

function bare<T>(from: Record<string, T> = {}): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, from);
}

function cloneSignal(install: SeatInstall, now: number): CloneSignal | null {
  const recent = install.recentIps.filter((s) => now - s.at <= CLONE_WINDOW_MS);
  const ips = new Set(recent.map((s) => s.ip)).size;
  let switches = 0;
  for (let i = 1; i < install.recentIps.length; i++) {
    if (install.recentIps[i]!.ip !== install.recentIps[i - 1]!.ip) switches++;
  }
  return ips >= 2 ? { ips, switches, windowMinutes: Math.round(CLONE_WINDOW_MS / 60_000) } : null;
}

export class SeatStore {
  private readonly file: string;

  constructor(readonly dataDir: string, readonly policy: SeatPolicy = DEFAULT_SEAT_POLICY) {
    this.file = path.join(dataDir, SEATS_FILE);
  }

  private read(): SeatsFile {
    const raw = readJson<Partial<SeatsFile>>(this.file, { v: 1, seats: {} });
    return { v: 1, seats: bare(raw.seats ?? {}) };
  }

  private write(f: SeatsFile): void {
    writeJsonAtomic(this.file, f);
  }

  private fresh(licenseId: string): SeatRecord {
    return { licenseId, installs: [], refused: 0, lastRefusedAtMs: null, lastRefusedInstallId: null, lastRefusedIp: null, releasedAtMs: null };
  }

  limitFor(seat: SeatRecord | null): number {
    return seat?.limit ?? this.policy.defaultLimit;
  }

  get(licenseId: string): SeatRecord | null {
    return this.read().seats[licenseId] ?? null;
  }

  /** The decision for one check-in. ALWAYS records (so history exists when
   *  enforcement is switched on later); refuses only when the policy says so. */
  admit(licenseId: string, installId: string, ip: string, now = Date.now()): AdmitResult {
    const f = this.read();
    const seat = f.seats[licenseId] ?? this.fresh(licenseId);
    const limit = this.limitFor(seat);
    const existing = seat.installs.find((i) => i.installId === installId);
    if (existing) {
      existing.lastSeenMs = now;
      existing.lastIp = ip;
      existing.recentIps = existing.recentIps.filter((s) => now - s.at <= IP_HISTORY_MS);
      const last = existing.recentIps.at(-1);
      // Sample on change or every few minutes, so a stable box does not fill
      // the history with identical rows.
      if (!last || last.ip !== ip || now - last.at >= 4 * 60_000) existing.recentIps.push({ ip, at: now });
      if (existing.recentIps.length > IP_HISTORY_MAX) existing.recentIps.splice(0, existing.recentIps.length - IP_HISTORY_MAX);
      const clone = cloneSignal(existing, now);
      f.seats[licenseId] = seat;
      if (this.policy.enforce && this.policy.cloneEnforce && clone && clone.switches >= CLONE_SWITCHES) {
        seat.refused++;
        seat.lastRefusedAtMs = now;
        seat.lastRefusedInstallId = installId;
        seat.lastRefusedIp = ip;
        this.write(f);
        return { admitted: false, reason: "clone", seat, clone };
      }
      this.write(f);
      return { admitted: true, seat, bound: false, evicted: [], clone };
    }
    // A NEW install id. Silent seat holders are gone; live ones hold the seat.
    const alive = seat.installs.filter((i) => now - i.lastSeenMs < this.policy.releaseAfterMs);
    const evicted = seat.installs.filter((i) => !alive.includes(i)).map((i) => i.installId);
    if (alive.length >= limit && this.policy.enforce) {
      seat.refused++;
      seat.lastRefusedAtMs = now;
      seat.lastRefusedInstallId = installId;
      seat.lastRefusedIp = ip;
      f.seats[licenseId] = seat;
      this.write(f);
      return { admitted: false, reason: "seat-taken", seat, clone: null };
    }
    // Not enforcing but over the limit: keep the newest `limit` installs so
    // the record stays bounded and still names who is running.
    const kept = alive.length >= limit ? alive.slice(alive.length - limit + 1) : alive;
    kept.push({ installId, firstSeenMs: now, lastSeenMs: now, lastIp: ip, recentIps: [{ ip, at: now }] });
    seat.installs = kept;
    seat.releasedAtMs = null;
    f.seats[licenseId] = seat;
    this.write(f);
    return { admitted: true, seat, bound: true, evicted, clone: null };
  }

  /** Admin: free the seat now. The next install to check in takes it. */
  release(licenseId: string, now = Date.now()): boolean {
    const f = this.read();
    const seat = f.seats[licenseId];
    if (!seat) return false;
    seat.installs = [];
    seat.releasedAtMs = now;
    this.write(f);
    return true;
  }

  /** Admin: allow this licence N installs at once (null = back to default). */
  setLimit(licenseId: string, limit: number | null): SeatRecord {
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEAT_LIMIT)) {
      throw new Error(`limit must be 1..${MAX_SEAT_LIMIT} or null`);
    }
    const f = this.read();
    const seat = f.seats[licenseId] ?? this.fresh(licenseId);
    if (limit === null) delete seat.limit; else seat.limit = limit;
    f.seats[licenseId] = seat;
    this.write(f);
    return seat;
  }

  view(licenseId: string, now = Date.now()): SeatView | null {
    const seat = this.get(licenseId);
    if (!seat) return null;
    return {
      limit: this.limitFor(seat),
      enforce: this.policy.enforce,
      installs: seat.installs.map((i) => ({
        installId: i.installId,
        firstSeenMs: i.firstSeenMs,
        lastSeenMs: i.lastSeenMs,
        lastIp: i.lastIp,
        alive: now - i.lastSeenMs < this.policy.releaseAfterMs,
        clone: cloneSignal(i, now),
      })),
      refused: seat.refused,
      lastRefusedAtMs: seat.lastRefusedAtMs,
      lastRefusedInstallId: seat.lastRefusedInstallId,
      lastRefusedIp: seat.lastRefusedIp,
      releasedAtMs: seat.releasedAtMs,
    };
  }

  /** Every seat, for the admin list — one read, not one per row. */
  views(now = Date.now()): Record<string, SeatView> {
    const out: Record<string, SeatView> = {};
    for (const id of Object.keys(this.read().seats)) {
      const v = this.view(id, now);
      if (v) out[id] = v;
    }
    return out;
  }
}
