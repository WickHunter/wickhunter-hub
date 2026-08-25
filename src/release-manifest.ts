// Read-only verification for offline-signed WickHunter releases. This module
// intentionally has no signing function and accepts no private key: the Hub is
// a distribution shelf, not a release authority.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { canonicalBytes } from "./marketcap/jcs.js";

export const RELEASE_SCHEMA = "wickhunter.release.v1";
export const RELEASE_ALG = "Ed25519";
export const RELEASE_PRODUCT = "wickhunter";
export const RELEASE_PROTOCOL = 1;
export const DEFAULT_RELEASE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_RELEASE_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface ReleaseSignature {
  kid: string;
  alg: string;
  sig: string;
}

/** `version`, `file`, and `sha256` remain at top level for old clients. */
export interface SignedReleaseManifest {
  schema: string;
  product: string;
  channel: string;
  platform: string;
  arch: string;
  version: string;
  buildId: string;
  file: string;
  sha256: string;
  issuedAt: string;
  minUpdateProtocol: number;
  signatures: ReleaseSignature[];
  [key: string]: unknown;
}

export interface ReleaseVerifyPolicy {
  publicKeys: Record<string, string>;
  now: number;
  maxAgeMs: number;
  product?: string;
  channel?: string;
  platform?: string;
  arch?: string;
}

export class ReleaseManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseManifestError";
  }
}

function decodeB64u(value: unknown, label: string, expectedLength: number): Buffer {
  const raw = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new ReleaseManifestError(`${label} is not base64url`);
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== expectedLength || bytes.toString("base64url") !== raw) {
    throw new ReleaseManifestError(`${label} has the wrong encoding or length`);
  }
  return bytes;
}

export function parseReleasePublicKeys(raw: unknown): Record<string, string> {
  let parsed = raw;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { throw new ReleaseManifestError("HUB_RELEASE_PUBLIC_KEYS_JSON is not valid JSON"); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReleaseManifestError("release public keyring must be an object");
  }
  const result: Record<string, string> = {};
  for (const [kid, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(kid)) throw new ReleaseManifestError(`invalid release key id ${JSON.stringify(kid)}`);
    result[kid] = decodeB64u(value, `release public key ${kid}`, 32).toString("base64url");
  }
  if (!Object.keys(result).length) throw new ReleaseManifestError("release public keyring is empty");
  return result;
}

export function releaseSigningBytes(manifest: SignedReleaseManifest): Buffer {
  const unsigned: Record<string, unknown> = { ...manifest };
  delete unsigned.signatures;
  delete unsigned.ok;
  return canonicalBytes(unsigned);
}

export function verifyReleaseManifest(raw: unknown, policy: ReleaseVerifyPolicy): SignedReleaseManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ReleaseManifestError("release manifest is not an object");
  const manifest = raw as SignedReleaseManifest;
  if (manifest.schema !== RELEASE_SCHEMA) throw new ReleaseManifestError(`unsupported release schema ${String(manifest.schema)}`);
  for (const field of ["product", "channel", "platform", "arch", "version", "buildId", "file", "sha256", "issuedAt"] as const) {
    if (typeof manifest[field] !== "string" || !manifest[field]) throw new ReleaseManifestError(`release manifest ${field} is missing`);
  }
  if (manifest.product !== (policy.product ?? RELEASE_PRODUCT)) throw new ReleaseManifestError("release product does not match this Hub");
  if (manifest.channel !== (policy.channel ?? "beta")) throw new ReleaseManifestError("release channel does not match this Hub");
  if (manifest.platform !== (policy.platform ?? "linux")) throw new ReleaseManifestError("release platform does not match this Hub");
  if (manifest.arch !== (policy.arch ?? "x64")) throw new ReleaseManifestError("release architecture does not match this Hub");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new ReleaseManifestError("release version is not numeric x.y.z");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.file)) throw new ReleaseManifestError("release file name is unsafe");
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256)) throw new ReleaseManifestError("release sha256 is malformed");
  if (!Number.isInteger(manifest.minUpdateProtocol) || manifest.minUpdateProtocol < 1) throw new ReleaseManifestError("release minUpdateProtocol is invalid");
  const issuedAt = Date.parse(manifest.issuedAt);
  if (!Number.isFinite(issuedAt)) throw new ReleaseManifestError("release issuedAt is invalid");
  if (issuedAt > policy.now + MAX_RELEASE_FUTURE_SKEW_MS) throw new ReleaseManifestError("release manifest is issued in the future");
  if (!Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs <= 0 || policy.now - issuedAt > policy.maxAgeMs) {
    throw new ReleaseManifestError("release manifest is stale");
  }
  if (!Array.isArray(manifest.signatures) || !manifest.signatures.length) throw new ReleaseManifestError("release manifest has no signatures");
  const keys = parseReleasePublicKeys(policy.publicKeys);
  const bytes = releaseSigningBytes(manifest);
  let known = false;
  for (const signature of manifest.signatures) {
    if (!signature || signature.alg !== RELEASE_ALG || typeof signature.kid !== "string") continue;
    const rawKey = keys[signature.kid];
    if (!rawKey) continue;
    known = true;
    try {
      const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), decodeB64u(rawKey, "release public key", 32)]);
      const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
      if (edVerify(null, bytes, publicKey, decodeB64u(signature.sig, `release signature ${signature.kid}`, 64))) return manifest;
    } catch { /* a second trusted rotation signature may still verify */ }
  }
  throw new ReleaseManifestError(known ? "release signature is invalid" : "release is not signed by a trusted key id");
}

export function verifyReleaseArtifact(manifest: SignedReleaseManifest, bytes: Buffer): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== manifest.sha256) throw new ReleaseManifestError("release artifact sha256 does not match the signed manifest");
}

