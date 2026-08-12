// src/flags.ts
// v0.2.11 — PER-LICENCE FEATURE FLAGS.
//
// The bot ships ONE build for alpha and beta. A feature that is not finished is
// compiled in but DARK, and this file is what decides who can see it: the daily
// check-in reply carries a `flags` object, and the bot hides anything not named
// there (src/feature-flags.ts on the bot side).
//
// ── WHY THE FLAGS ARE NOT IN THE SIGNED TOKEN ──────────────────────────────
// src/license.ts opens with "License format v1 — PINNED. The bot is built
// against exactly this; any change needs a new LHK2 prefix, never a mutation of
// v1." Putting flags in the payload would break that rule, or force every
// already-issued key to be reissued before a single tester could be given a
// feature.
//
// The check-in reply already carries `revoked` and `latest`, is answered per
// licence id, and happens daily. Flags belong there:
//   · every key already issued gains flags with no reissue;
//   · enabling a feature for ONE tester lands within a day;
//   · disabling is equally cheap, which matters because the whole point is
//     shipping things that are not finished.
//
// ── SHAPE ──────────────────────────────────────────────────────────────────
//   data/flags.json = { "default": { "<flag>": true }, "byLicense": { "<id>": { "<flag>": true|false } } }
//
// `default` applies to everyone; `byLicense` overrides it per tester, and an
// explicit `false` there is how ONE tester is excluded from something everyone
// else has. Resolution is a plain merge with the per-licence entry winning.
//
// The hub does NOT keep a registry of valid flag names, and that is deliberate:
// the bot has one (`FEATURE_FLAGS`) and ignores anything it does not know, so
// the authority over what a flag MEANS lives with the build that implements it.
// A hub that named a flag the bot has never heard of would simply be ignored,
// which is the right failure — the alternative is a hub that has to be
// redeployed in lockstep with every bot release.
import path from "node:path";
import { readJson, writeJsonAtomic } from "./jsonfile.js";

const FLAGS_FILE = "flags.json";

export interface FlagsFile {
  default: Record<string, boolean>;
  byLicense: Record<string, Record<string, boolean>>;
}

const EMPTY: FlagsFile = { default: {}, byLicense: {} };

/** Tolerant of a hand-edited or absent file: a malformed half is replaced by an
 *  empty one rather than throwing. The bot fails DARK on anything it does not
 *  receive, so the worst case here is a feature staying hidden — never a
 *  half-built feature appearing on a tester's live account. */
export function readFlags(dataDir: string): FlagsFile {
  const raw = readJson<Partial<FlagsFile>>(path.join(dataDir, FLAGS_FILE), EMPTY);
  const obj = (v: unknown): Record<string, boolean> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "boolean") out[k] = val;
    }
    return out;
  };
  const byLicense: Record<string, Record<string, boolean>> = {};
  const src = raw?.byLicense;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const [id, v] of Object.entries(src as Record<string, unknown>)) byLicense[id] = obj(v);
  }
  return { default: obj(raw?.default), byLicense };
}

/** What ONE licence should be told. Only TRUE flags are emitted: an explicit
 *  `false` in `byLicense` exists to cancel a default, and once cancelled there
 *  is nothing to say about it — the bot treats "absent" and "false" identically
 *  (both dark), so sending the false would be noise. */
export function flagsFor(dataDir: string, licenseId: string): Record<string, boolean> {
  const f = readFlags(dataDir);
  const merged = { ...f.default, ...(f.byLicense[licenseId] ?? {}) };
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(merged)) if (v === true) out[k] = true;
  return out;
}

/** Set or clear one flag. `state`:
 *    true  — on for this licence (or for everyone, with id "default")
 *    false — explicitly OFF, which is how one tester is excluded from a default
 *    null  — remove the entry entirely, falling back to the default
 *  Returns the file as it now stands, so the caller can echo it back. */
export function setFlag(dataDir: string, licenseId: string, flag: string, state: boolean | null): FlagsFile {
  const f = readFlags(dataDir);
  const bucket = licenseId === "default" ? f.default : (f.byLicense[licenseId] ??= {});
  if (state === null) delete bucket[flag];
  else bucket[flag] = state;
  // Housekeeping: an emptied per-licence bucket is removed so the file does not
  // accumulate a row per tester who was once given something and then had it
  // taken away.
  if (licenseId !== "default" && Object.keys(f.byLicense[licenseId] ?? {}).length === 0) delete f.byLicense[licenseId];
  writeJsonAtomic(path.join(dataDir, FLAGS_FILE), f);
  return f;
}
