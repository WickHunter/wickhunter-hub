// src/marketcap/decimal.ts
// Exact decimal arithmetic on BigInt, for money.
//
// ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
// A market cap decides which pairs a bot is allowed to trade, and the accept /
// reject rules below compare one figure against another within 2%. A threshold
// decided by float rounding is a threshold that answers differently on two
// machines for the same inputs, and the disagreement is invisible: both sides
// print the same number. So every money value that reaches a wire, a comparison
// or a signature is a DECIMAL STRING carried through exact integer arithmetic,
// and the only float in the pipeline is the one the provider's JSON hands us —
// converted once, losslessly, at the edge.
//
// "Losslessly" is precise: `Number.prototype.toString()` emits the shortest
// decimal that round-trips to the same IEEE-754 double, so parsing that string
// preserves exactly the value the provider's JSON parsed to. It does NOT
// recover digits the double never held — nothing can — which is why the
// cross-check tolerance below is 2% and not 2 parts per billion.

/** value = (neg ? -1 : 1) * unscaled / 10^scale, with unscaled >= 0. */
export interface Dec {
  readonly neg: boolean;
  readonly unscaled: bigint;
  readonly scale: number;
}

const ZERO: Dec = { neg: false, unscaled: 0n, scale: 0 };

/** Guard against a hostile or malformed exponent turning one parse into a
 *  multi-gigabyte BigInt. Real market caps live around 1e12; 1e6 digits of
 *  scale is far past anything legitimate and far short of anything harmful. */
const MAX_SCALE = 1_000_000;

/** Parse a decimal STRING or a finite JS number. Returns null for anything that
 *  is not an exact finite decimal — never a zero, never a NaN, never a guess.
 *  A caller that turns this null into 0 has invented a fact; see caps.ts. */
export function dec(v: unknown): Dec | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    // Shortest round-trip form; may be exponential for very large/small values,
    // which the string path below handles.
    return dec(v.toString());
  }
  if (typeof v === "bigint") return normalise({ neg: v < 0n, unscaled: v < 0n ? -v : v, scale: 0 });
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  const [, sign, intPart = "", fracPart = "", expPart] = m;
  if (!intPart && !fracPart) return null; // "." / "" / "e5" are not numbers
  const exp = expPart ? Number(expPart) : 0;
  if (!Number.isFinite(exp)) return null;
  const digits = `${intPart}${fracPart}`;
  let scale = fracPart.length - exp;
  let unscaled = BigInt(digits === "" ? "0" : digits);
  if (scale < 0) {
    if (-scale > MAX_SCALE) return null;
    unscaled *= 10n ** BigInt(-scale);
    scale = 0;
  }
  if (scale > MAX_SCALE) return null;
  return normalise({ neg: sign === "-", unscaled, scale });
}

/** Strip trailing fractional zeros and collapse -0 to 0. Two Decs that are
 *  equal in value therefore serialise to identical bytes, which matters because
 *  these strings go inside a SIGNED payload. */
function normalise(d: Dec): Dec {
  let { unscaled, scale } = d;
  while (scale > 0 && unscaled % 10n === 0n) {
    unscaled /= 10n;
    scale--;
  }
  if (unscaled === 0n) return ZERO;
  return { neg: d.neg, unscaled, scale };
}

/** Plain decimal notation, never exponential — the wire form. */
export function decToString(d: Dec): string {
  if (d.unscaled === 0n) return "0";
  const digits = d.unscaled.toString();
  const sign = d.neg ? "-" : "";
  if (d.scale === 0) return `${sign}${digits}`;
  const pad = digits.padStart(d.scale + 1, "0");
  const cut = pad.length - d.scale;
  return `${sign}${pad.slice(0, cut)}.${pad.slice(cut)}`;
}

/** The one-call edge conversion: anything -> wire string, or null. */
export function decStringOf(v: unknown): string | null {
  const d = dec(v);
  return d ? decToString(d) : null;
}

const signed = (d: Dec): bigint => (d.neg ? -d.unscaled : d.unscaled);

function align(a: Dec, b: Dec): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  const sa = signed(a) * 10n ** BigInt(scale - a.scale);
  const sb = signed(b) * 10n ** BigInt(scale - b.scale);
  return { a: sa, b: sb, scale };
}

export function decMul(a: Dec, b: Dec): Dec {
  const prod = signed(a) * signed(b);
  return normalise({ neg: prod < 0n, unscaled: prod < 0n ? -prod : prod, scale: a.scale + b.scale });
}

export function decSub(a: Dec, b: Dec): Dec {
  const { a: x, b: y, scale } = align(a, b);
  const diff = x - y;
  return normalise({ neg: diff < 0n, unscaled: diff < 0n ? -diff : diff, scale });
}

export function decIsPositive(d: Dec): boolean {
  return !d.neg && d.unscaled > 0n;
}

export function decIsZero(d: Dec): boolean {
  return d.unscaled === 0n;
}

/** -1 / 0 / 1, by value. */
export function decCmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const { a: x, b: y } = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** |a - b| as a fraction of |a|, in parts per million, rounded UP.
 *  `null` when the reference is zero — a relative error against zero is not a
 *  large number, it is an undefined one, and returning a large number here
 *  would silently classify it as "disputed" on the strength of a division that
 *  never happened. */
export function relativeErrorPpm(reference: Dec, other: Dec): bigint | null {
  if (decIsZero(reference)) return null;
  const diff = decSub(reference, other);
  const { a: d, b: r } = align(diff, reference);
  const num = (d < 0n ? -d : d) * 1_000_000n;
  const den = r < 0n ? -r : r;
  // Ceiling division: a tolerance test must never pass because the error was
  // rounded down onto the boundary.
  return (num + den - 1n) / den;
}

/** Does `other` sit within `tolerancePpm` of `reference`? A null relative error
 *  (zero reference) is NOT within tolerance — it is unknown, and unknown must
 *  never read as agreement. */
export function withinRelative(reference: Dec, other: Dec, tolerancePpm: bigint): boolean {
  const err = relativeErrorPpm(reference, other);
  return err !== null && err <= tolerancePpm;
}
