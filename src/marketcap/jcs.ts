// src/marketcap/jcs.ts
// RFC 8785 JSON Canonicalization Scheme — the bytes that get signed.
//
// ── WHY NOT THE PINNED-KEY-ORDER TRICK THE CANDLE SEED USES ─────────────────
// `candles/seed.ts` canonicalises by rebuilding a fresh object literal in one
// pinned key order, and that is right for a payload with ten fixed scalar
// fields. This payload is a tree: per-instrument rows, per-asset rows, a
// coverage census, a credit report — a shape that will grow. Pinning a key
// order by hand across a growing tree means every future field is one forgotten
// line away from a signature nobody can verify, and the failure lands in
// somebody else's process with no hint of the cause (README, "Signing key").
//
// JCS removes the choice: keys sort by UTF-16 code unit, numbers serialise by
// the ECMAScript Number-to-String algorithm, strings by JSON escaping. Two
// implementations that both follow it produce identical bytes without having
// agreed on anything, which is exactly what a client written in another
// language needs.
//
// ── WHAT THIS IMPLEMENTATION DELIBERATELY REFUSES ───────────────────────────
// NaN, Infinity, -0 and undefined-in-an-array are REFUSED rather than coerced.
// RFC 8785 has no representation for the first two; `-0` serialises as "0" per
// I-JSON, and quietly folding a signed zero would mean the object you signed is
// not the object you were handed. Money never reaches this file as a number at
// all (see decimal.ts) — every monetary field is already a decimal STRING — so
// the numbers here are timestamps, counts and ids, where a refusal is a bug
// report rather than a lost payment.

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/** RFC 8785 canonical JSON text. Throws on anything the scheme cannot express;
 *  callers sign the UTF-8 encoding of what comes back. */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, out, 0);
  return out.join("");
}

/** The bytes to sign. One function, so a caller cannot sign a re-serialisation
 *  that differs from the one that was canonicalised. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}

/** Depth bound: a self-referential object would otherwise recurse until the
 *  stack dies inside a signing call. */
const MAX_DEPTH = 64;

function write(v: unknown, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) throw new CanonicalizationError("value nests deeper than the canonicalizer allows");
  if (v === null) {
    out.push("null");
    return;
  }
  switch (typeof v) {
    case "boolean":
      out.push(v ? "true" : "false");
      return;
    case "number":
      out.push(numberLiteral(v));
      return;
    case "string":
      out.push(stringLiteral(v));
      return;
    case "object":
      break;
    default:
      throw new CanonicalizationError(`cannot canonicalize a ${typeof v}`);
  }
  if (Array.isArray(v)) {
    out.push("[");
    for (let i = 0; i < v.length; i++) {
      if (i) out.push(",");
      const el = v[i];
      if (el === undefined) throw new CanonicalizationError(`array element ${i} is undefined`);
      write(el, out, depth + 1);
    }
    out.push("]");
    return;
  }
  const obj = v as Record<string, unknown>;
  // OWN enumerable keys only, sorted by UTF-16 code unit — which is exactly
  // what the default string sort does in JavaScript. RFC 8785 §3.2.3.
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  out.push("{");
  for (let i = 0; i < keys.length; i++) {
    if (i) out.push(",");
    out.push(stringLiteral(keys[i]!), ":");
    write(obj[keys[i]!], out, depth + 1);
  }
  out.push("}");
}

function numberLiteral(n: number): string {
  if (!Number.isFinite(n)) throw new CanonicalizationError(`${n} has no JSON representation`);
  if (Object.is(n, -0)) throw new CanonicalizationError("-0 is refused: it would canonicalize to 0");
  // JSON.stringify uses the ECMAScript Number-to-String algorithm, which is the
  // one RFC 8785 §3.2.2.3 adopts by reference.
  return JSON.stringify(n);
}

function stringLiteral(s: string): string {
  // JSON.stringify implements the JSON string escaping RFC 8785 §3.2.2.2
  // requires (shortest escapes, lowercase \u00xx for the remaining controls),
  // and since ES2019 ("well-formed JSON.stringify") it escapes lone surrogates
  // rather than emitting invalid UTF-8 — which is the one case where a naive
  // implementation and a conforming one produce different BYTES for the same
  // string, and therefore different signatures.
  return JSON.stringify(s);
}
