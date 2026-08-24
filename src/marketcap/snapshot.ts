// src/marketcap/snapshot.ts
// THE SIGNED SNAPSHOT — its shape, its coverage invariants, and the bytes.
//
// ── WIRE CONTRACT v1, PINNED ────────────────────────────────────────────────
// Like `LHK1` and like the candle seed's v1: a client is built against exactly
// these fields, so a change needs `v: 2`, never a mutation of v1.
//
// ── ITS OWN SIGNING KEY, AND THAT IS NOT TIDINESS ───────────────────────────
// `candles/key.ts` records what it costs to share one: a genuine seed signature
// re-wrapped as a licence token PASSES the licence verifier's signature check
// and is refused only by a later shape test, so the separation rests on an
// ordering nobody can see. This payload gets a third key
// (`MARKET_DATA_SIGNING_PRIVATE_KEY_B64U`) so a market-cap signature is made by
// a key neither of the other two verifiers holds and fails at the signature
// step whatever order anyone checks things in. The private half comes from the
// environment, is never written to a file by this service, never logged, and
// never appears in the payload — only `keyId` does.
//
// ── AND THE CANONICAL BYTES ─────────────────────────────────────────────────
// `signatures` is REMOVED — the whole field, not just the `sig` inside it —
// then the rest is RFC 8785 canonicalised, UTF-8 encoded and Ed25519-signed.
// Removing the whole field is what lets the payload carry more than one
// signature later (key rotation) without the second signature changing the
// bytes the first one covered.
import { createPublicKey, sign as edSign, verify as edVerify, createPrivateKey, type KeyObject } from "node:crypto";
import { canonicalBytes } from "./jcs.js";
import type { CapFact, CapCensus } from "./caps.js";
import type { IdentityCensus, IdentityRow } from "./identity.js";

export const SNAPSHOT_WIRE_VERSION = 1;
export const SNAPSHOT_ALG = "ed25519";

/** One instrument's answer: an identity verdict, and — only where both stages
 *  succeeded — a market cap. The two are separate fields because they are
 *  separate claims: "we know which coin this is" and "we know what it is
 *  worth" fail independently, and a row that collapses them cannot say which. */
export interface InstrumentRow {
  venue: string;
  symbol: string;
  exchangeBase: string;
  exchangeQuote: string;
  identity: IdentityRow["state"];
  cryptoId: number | null;
  cryptoSymbol: string | null;
  identitySource: IdentityRow["source"];
  /** `verified` | `fallback` | `missing` | `disputed` | `stale` |
   *  `not_applicable`, or null when identity never got far enough to ask. */
  capStatus: CapFact["status"] | null;
  /** DECIMAL STRING. The asset's own market cap, UNCHANGED — a x1000 contract
   *  carries its underlying's cap, never a scaled one. */
  marketCapUsd: string | null;
  /** Why this row has no usable cap, in words. Null when it has one. */
  reason: string | null;
  /** Review-only ticker reading; never used to resolve anything. */
  multiplierSuggestion: IdentityRow["multiplierSuggestion"];
}

export interface AssetRow {
  cryptoId: number;
  symbol: string | null;
  name: string | null;
  status: CapFact["status"];
  marketCapUsd: string | null;
  priceUsd: string | null;
  circulatingSupply: string | null;
  providerLastUpdated: number | null;
  source: CapFact["source"];
  marketCapIncludedInCalc: boolean | null;
  crossCheck: CapFact["crossCheck"];
  reason: string | null;
}

export interface SnapshotCoverage {
  instruments: IdentityCensus;
  assets: CapCensus;
  /** Both invariants at once. A snapshot is not published unless this is true;
   *  it rides on the wire so a client can refuse one that somehow is. */
  invariantOk: boolean;
  /** Ids requested from the provider that came back with nothing. Named, never
   *  merely counted: a count tells an operator that something is missing and
   *  not which listing to go and look at. */
  omittedIds: number[];
}

export interface SnapshotUnsigned {
  v: number;
  kind: "market-caps";
  generatedAt: number;
  /** After this, a consumer must treat the snapshot as expired. Hourly cap
   *  refresh, so the default is comfortably longer than one refresh and far
   *  shorter than a day: a stale snapshot must age out on its own even if the
   *  producer dies without saying so. */
  expiresAt: number;
  /** Which provider said what, and when each stage last succeeded. */
  sources: {
    caps: { provider: string; fetchedAt: number };
    pairMap: { provider: string; fetchedAt: number; exchanges: Array<{ venue: string; slug: string; pairs: number }> };
  };
  instruments: InstrumentRow[];
  assets: AssetRow[];
  coverage: SnapshotCoverage;
  credits: { month: string; used: number; ceiling: number; refusals: number };
  keyId: string;
}

export interface SnapshotSignature {
  keyId: string;
  alg: string;
  /** base64url of the raw Ed25519 signature. */
  sig: string;
}

export interface SnapshotSigned extends SnapshotUnsigned {
  signatures: SnapshotSignature[];
}

/** THE BYTES. `signatures` is dropped whole; everything else is canonicalised.
 *  Exported because a verifier in any language must be able to reproduce it,
 *  and because the suite asserts that adding a signature does not move it. */
export function snapshotSigningBytes(snapshot: SnapshotUnsigned | SnapshotSigned): Buffer {
  const { ...rest } = snapshot as SnapshotSigned;
  delete (rest as Partial<SnapshotSigned>).signatures;
  return canonicalBytes(rest);
}

/** ⚠ A SIGNING FUNCTION AND A PUBLIC KEY — NOT A PRIVATE `KeyObject`.
 *
 *  It held `key: KeyObject`, which meant the ONLY thing that could sign a
 *  snapshot was a key this module had been handed the private half of. The
 *  licence key cannot be supplied that way: `LicenseStore.sign()` returns a
 *  signature and NEVER key material, by that module's own rule.
 *
 *  This is the shape the candle seed already uses — `server.ts` picks a
 *  `(bytes) => Buffer` and `seed.ts` calls `deps.sign(...)` — so the two
 *  signing surfaces in this repo now work the same way. */
export interface SignerKey {
  keyId: string;
  /** Public half only, for `publicKeyRawB64u` and the admin panel. */
  publicKey: KeyObject;
  sign(bytes: Buffer): Buffer;
}

/** Load the signing key from its base64url form. Accepts either the 32 raw
 *  seed bytes or a PKCS8 DER/PEM, because an operator pasting a key from a
 *  password store should not have to know which of those they have.
 *
 *  THROWS on anything unusable, and the caller turns that into a refusal to
 *  START — a service that boots with no key and discovers it at publish time
 *  is a service whose failure lands hours later, on a timer, in a log. */
export function loadSigningKey(b64u: string, keyId: string): SignerKey {
  const id = String(keyId ?? "").trim();
  if (!id) throw new Error("MARKET_DATA_SIGNING_KEY_ID is required — a signature nobody can attribute is not a signature");
  const raw = String(b64u ?? "").trim();
  if (!raw) throw new Error("MARKET_DATA_SIGNING_PRIVATE_KEY_B64U is required");
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length === 32) {
    // A bare Ed25519 seed, wrapped into the PKCS8 the crypto API wants. The
    // 16-byte prefix is the fixed ASN.1 header for an Ed25519 private key.
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), bytes]);
    return signerFromPrivateKey(id, createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }));
  }
  try {
    const key = raw.includes("PRIVATE KEY")
      ? createPrivateKey(raw)
      : createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error(`the market-data signing key is ${key.asymmetricKeyType}, not ed25519`);
    }
    return signerFromPrivateKey(id, key);
  } catch (err) {
    throw new Error(`MARKET_DATA_SIGNING_PRIVATE_KEY_B64U is not a usable Ed25519 private key: ${(err as Error).message}`);
  }
}

/** The 32 raw PUBLIC bytes, base64url — what a client pins. Public material
 *  only; this module never returns or prints the private half. */
export function publicKeyRawB64u(signer: SignerKey): string {
  const spki = signer.publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64url");
}

/** Wrap a private key we DO hold. */
export function signerFromPrivateKey(keyId: string, key: KeyObject): SignerKey {
  return { keyId, publicKey: createPublicKey(key), sign: (bytes) => edSign(null, bytes, key) };
}

/** Wrap a signer we do NOT hold the private half of — the licence key, whose
 *  store hands out signatures and never key material. */
export function signerFromSignFn(
  keyId: string,
  publicKey: KeyObject,
  sign: (bytes: Buffer) => Buffer,
): SignerKey {
  const id = String(keyId ?? "").trim();
  if (!id) throw new Error("a market-cap signer needs a keyId — a signature nobody can attribute is not a signature");
  return { keyId: id, publicKey, sign };
}

export function signSnapshot(unsigned: SnapshotUnsigned, signer: SignerKey): SnapshotSigned {
  const sig = signer.sign(snapshotSigningBytes(unsigned));
  return { ...unsigned, signatures: [{ keyId: signer.keyId, alg: SNAPSHOT_ALG, sig: sig.toString("base64url") }] };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface VerifyDeps {
  /** keyId -> the 32 raw public bytes, base64url. An UNKNOWN keyId is a
   *  refusal, never a "try it anyway": pinning is what makes a rotated or
   *  stolen key stop working. */
  keys: Record<string, string>;
  now: number;
}

/** The client-side check, implemented here so the suite drives the real thing
 *  rather than a re-implementation that could agree with a bug. */
export function verifySnapshot(snapshot: SnapshotSigned, deps: VerifyDeps): VerifyResult {
  if (!snapshot || typeof snapshot !== "object") return { ok: false, reason: "not an object" };
  if (snapshot.v !== SNAPSHOT_WIRE_VERSION) return { ok: false, reason: `unsupported wire version ${String(snapshot.v)}` };
  const sigs = Array.isArray(snapshot.signatures) ? snapshot.signatures : [];
  if (!sigs.length) return { ok: false, reason: "no signature" };
  const bytes = snapshotSigningBytes(snapshot);
  const failures: string[] = [];
  for (const s of sigs) {
    if (!s || typeof s !== "object") continue;
    // ALGORITHM FIRST. A payload naming an algorithm we do not implement is
    // refused rather than verified with the one we happen to have — "alg" has
    // been the hole in more than one signature format.
    if (s.alg !== SNAPSHOT_ALG) continue;
    const pub = Object.prototype.hasOwnProperty.call(deps.keys, s.keyId) ? deps.keys[s.keyId] : undefined;
    if (!pub) continue;
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub, "base64url")]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (!edVerify(null, bytes, key, Buffer.from(String(s.sig ?? ""), "base64url"))) {
      // KEEP LOOKING, rather than failing on the first bad one. During a key
      // rotation a payload legitimately carries two signatures and a client may
      // hold either key; failing on the first mismatch would make which one it
      // holds decide whether a perfectly good snapshot verifies.
      failures.push(`keyId "${s.keyId}"`);
      continue;
    }
    // EXPIRY IS CHECKED AFTER THE SIGNATURE, deliberately: an expiry read off
    // an unverified payload is an expiry the sender chose.
    if (Number.isFinite(snapshot.expiresAt) && deps.now > snapshot.expiresAt) {
      return { ok: false, reason: `snapshot expired at ${new Date(snapshot.expiresAt).toISOString()}` };
    }
    return { ok: true };
  }
  return {
    ok: false,
    reason: failures.length
      ? `no signature verifies (tried ${failures.join(", ")})`
      : `no signature from a known keyId (${sigs.map((s) => String(s?.keyId)).join(", ")})`,
  };
}

export interface BuildInput {
  now: number;
  ttlMs: number;
  keyId: string;
  identityRows: IdentityRow[];
  identityCensus: IdentityCensus;
  capFacts: Map<number, CapFact>;
  capCensus: CapCensus;
  omittedIds: number[];
  sources: SnapshotUnsigned["sources"];
  credits: SnapshotUnsigned["credits"];
}

export type BuildOutcome =
  | { ok: true; snapshot: SnapshotUnsigned }
  /** THE INVARIANT FAILED. The caller keeps its last known good and emits ONE
   *  feed-health error. Publishing a snapshot whose own census does not add up
   *  would make hundreds of pairs look unmapped, which is the failure this
   *  whole service exists to make impossible. */
  | { ok: false; error: string };

export function buildSnapshot(input: BuildInput): BuildOutcome {
  /** Mapped rows for which the cap stage produced NO verdict at all. Collected
   *  rather than papered over: every other "no cap" outcome is a fact about the
   *  provider, and this one is a fact about US. */
  const orphans: string[] = [];
  const instruments: InstrumentRow[] = input.identityRows.map((r) => {
    const fact = r.cryptoId !== null ? input.capFacts.get(r.cryptoId) : undefined;
    // ── EVERY ROW GETS A REASON WHEN IT HAS NO CAP ────────────────────────
    // "no cap and no explanation" is the outcome an operator cannot act on, so
    // it is constructed to be impossible: identity failure reports the identity
    // reason, cap failure reports the cap reason, and a mapped id with no fact
    // at all reports THAT, which would be a bug in this producer rather than in
    // the provider and must not look like provider lag.
    if (r.state === "mapped" && !fact) orphans.push(`${r.venue} ${r.symbol}`);
    const capStatus = r.state === "not_applicable"
      ? "not_applicable" as const
      : r.state !== "mapped"
        ? null
        : fact?.status ?? "missing";
    const usable = capStatus === "verified" || capStatus === "fallback";
    return {
      venue: r.venue,
      symbol: r.symbol,
      exchangeBase: r.exchangeBase,
      exchangeQuote: r.exchangeQuote,
      identity: r.state,
      cryptoId: r.cryptoId,
      cryptoSymbol: r.cryptoSymbol,
      identitySource: r.source,
      capStatus,
      // The asset's own figure, byte for byte. NOTHING multiplies or divides a
      // market cap by a contract multiplier anywhere in this service.
      marketCapUsd: usable ? (fact?.marketCapUsd ?? null) : null,
      reason: usable
        ? null
        : r.state !== "mapped"
          ? r.reason
          : fact?.reason ?? `crypto id ${String(r.cryptoId)} is mapped but no cap fact was produced for it — this is a producer bug, not provider lag`,
      multiplierSuggestion: r.multiplierSuggestion,
    };
  });

  const assets: AssetRow[] = [...input.capFacts.values()]
    .sort((a, b) => a.cryptoId - b.cryptoId)
    .map((f) => ({
      cryptoId: f.cryptoId,
      symbol: f.symbol,
      name: f.name,
      status: f.status,
      marketCapUsd: f.marketCapUsd,
      priceUsd: f.priceUsd,
      circulatingSupply: f.circulatingSupply,
      providerLastUpdated: f.providerLastUpdated,
      source: f.source,
      marketCapIncludedInCalc: f.marketCapIncludedInCalc,
      crossCheck: f.crossCheck,
      reason: f.reason,
    }));

  const coverage: SnapshotCoverage = {
    instruments: input.identityCensus,
    assets: input.capCensus,
    invariantOk: input.identityCensus.invariantOk && input.capCensus.invariantOk,
    omittedIds: [...input.omittedIds].sort((a, b) => a - b),
  };

  if (!coverage.invariantOk) {
    const i = input.identityCensus;
    const c = input.capCensus;
    return {
      ok: false,
      error: !i.invariantOk
        ? `instrument coverage invariant failed: ${i.activeInstruments} active instruments but `
          + `${i.mapped} mapped + ${i.ambiguous} ambiguous + ${i.provider_untracked} untracked + ${i.not_applicable} not-applicable`
        : `asset coverage invariant failed: ${c.requested} unique ids requested but `
          + `${c.verified} verified + ${c.fallback} fallback + ${c.missing} missing + ${c.disputed} disputed + ${c.stale} stale + ${c.not_applicable} not-applicable`,
    };
  }
  // A mapped row with no fact is the producer bug named above; caught here
  // rather than shipped with an apology in a `reason` string. The invariants
  // above CANNOT see it: the row is counted as `mapped` and the id it points at
  // was never requested, so both censuses balance perfectly while the snapshot
  // quietly carries a pair whose cap nobody ever tried to fetch.
  if (orphans.length) {
    return {
      ok: false,
      error: `${orphans.length} mapped instrument(s) produced no cap verdict at all (${orphans.slice(0, 5).join(", ")}) — `
        + "this is a producer bug, not provider lag",
    };
  }

  return {
    ok: true,
    snapshot: {
      v: SNAPSHOT_WIRE_VERSION,
      kind: "market-caps",
      generatedAt: input.now,
      expiresAt: input.now + input.ttlMs,
      sources: input.sources,
      instruments,
      assets,
      coverage,
      credits: input.credits,
      keyId: input.keyId,
    },
  };
}
