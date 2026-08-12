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

/** ── v0.2.12 — KEYS THAT ARE NOT KEYS ──────────────────────────────────────
 *
 *  Found by audit, reproduced end to end against the real route. A licence id
 *  of `__proto__` is not an ordinary string here: `byLicense["__proto__"]`
 *  resolves through the inherited accessor to `Object.prototype` ITSELF, so
 *  `??=` sees a value and never assigns, and the next write lands on the global
 *  prototype. From then on EVERY plain object in the process inherits the flag
 *  — including the check-in reply built for an unrelated, legitimate licence —
 *  and the route answers 200 while reporting the file as unchanged.
 *
 *  It needs no malice to happen: pasting a wrong value into an id field is
 *  enough. So the three names that can reach the prototype are refused at every
 *  door rather than sanitised at one of them, and `Object.create(null)` is used
 *  for the maps themselves so a future door that forgets the check still cannot
 *  find a prototype to corrupt. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const isUnsafeKey = (k: string): boolean => UNSAFE_KEYS.has(k);
/** A map with NO prototype — nothing to pollute, and nothing inherited to
 *  mistake for an entry. */
const bare = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

export interface FlagsFile {
  default: Record<string, boolean>;
  byLicense: Record<string, Record<string, boolean>>;
}

const EMPTY: FlagsFile = { default: bare<boolean>(), byLicense: bare<Record<string, boolean>>() };

/** Tolerant of a hand-edited or absent file: a malformed half is replaced by an
 *  empty one rather than throwing. The bot fails DARK on anything it does not
 *  receive, so the worst case here is a feature staying hidden — never a
 *  half-built feature appearing on a tester's live account. */
export function readFlags(dataDir: string): FlagsFile {
  const raw = readJson<Partial<FlagsFile>>(path.join(dataDir, FLAGS_FILE), EMPTY);
  const obj = (v: unknown): Record<string, boolean> => {
    const out = bare<boolean>();
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    // `Object.entries` already skips inherited keys, but a file hand-edited to
    // contain a literal "__proto__" member yields it as an OWN key here, and
    // writing it into a plain object would set that object's prototype.
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "boolean" && !isUnsafeKey(k)) out[k] = val;
    }
    return out;
  };
  const byLicense = bare<Record<string, boolean>>();
  const src = raw?.byLicense;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const [id, v] of Object.entries(src as Record<string, unknown>)) {
      if (!isUnsafeKey(id)) byLicense[id] = obj(v);
    }
  }
  return { default: obj(raw?.default), byLicense };
}

/** What ONE licence should be told. Only TRUE flags are emitted: an explicit
 *  `false` in `byLicense` exists to cancel a default, and once cancelled there
 *  is nothing to say about it — the bot treats "absent" and "false" identically
 *  (both dark), so sending the false would be noise. */
export function flagsFor(dataDir: string, licenseId: string): Record<string, boolean> {
  const f = readFlags(dataDir);
  const own = !isUnsafeKey(licenseId) ? (f.byLicense[licenseId] ?? {}) : {};
  const merged = { ...f.default, ...own };
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(merged)) if (v === true && !isUnsafeKey(k)) out[k] = true;
  return out;
}

/** Set or clear one flag. `state`:
 *    true  — on for this licence (or for everyone, with id "default")
 *    false — explicitly OFF, which is how one tester is excluded from a default
 *    null  — remove the entry entirely, falling back to the default
 *  Returns the file as it now stands, so the caller can echo it back. */
export function setFlag(dataDir: string, licenseId: string, flag: string, state: boolean | null): FlagsFile {
  const f = readFlags(dataDir);
  // Refused rather than sanitised-and-applied: an id or flag by one of these
  // names is a mistake somewhere upstream, and silently writing it to a
  // different key would hide that mistake instead of surfacing it. The route
  // turns this into a 400.
  if (isUnsafeKey(licenseId) || isUnsafeKey(flag)) return f;
  const bucket = licenseId === "default" ? f.default : (f.byLicense[licenseId] ??= bare<boolean>());
  if (state === null) delete bucket[flag];
  else bucket[flag] = state;
  // Housekeeping: an emptied per-licence bucket is removed so the file does not
  // accumulate a row per tester who was once given something and then had it
  // taken away.
  if (licenseId !== "default" && Object.keys(f.byLicense[licenseId] ?? {}).length === 0) delete f.byLicense[licenseId];
  writeJsonAtomic(path.join(dataDir, FLAGS_FILE), f);
  return f;
}
