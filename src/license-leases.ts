// Machine-bound licence leases (v1).
//
// LHK1 remains the long-lived entitlement and is deliberately unchanged. A
// lease is a short-lived, install-key-bound capability minted only after the
// install proves possession of its Ed25519 private key. The append-only ledger
// is both state and audit: every line is hash-chained and signed by the
// dedicated lease key, so editing an activation or sequence is detected rather
// than silently accepted on restart.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LicensePayload, LicenseStore } from "./license.js";
import { readJson } from "./jsonfile.js";

export const LEASE_TOKEN_PREFIX = "WHL1";
export const LEASE_PAYLOAD_TYPE = "wickhunter.license.lease.v1";
export const LEASE_LEDGER_FILE = "license-lease-audit.v1.jsonl";
export const LEASE_LEDGER_HEAD_FILE = "license-lease-audit-head.v1.json";
export const LEASE_KEYRING_FILE = "license-lease-public-keys.v1.json";
export const DEFAULT_LEASE_KEY_ID = "lease-1";
export const DEFAULT_LEASE_DURATION_MS = 6 * 60 * 60 * 1_000;
export const DEFAULT_LEASE_GRACE_MS = 72 * 60 * 60 * 1_000;
export const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const DEFAULT_MAX_MACHINES = 1;
const LEDGER_DOMAIN = "wickhunter.license.lease-ledger.v1\n";
const CHALLENGE_DOMAIN = "wickhunter.license.challenge.v1";
const LEASE_SIGNATURE_DOMAIN = Buffer.from("WICKHUNTER\0LICENSE_LEASE\0V1\0", "utf8");
const MAX_OUTSTANDING_CHALLENGES = 8;
const MAX_CHALLENGES_PER_LICENSE_PER_HOUR = 120;
const MAX_LEDGER_BYTES = 128 * 1024 * 1024;
const RAW_PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type LeasePurpose = "activate" | "renew" | "deactivate" | "rebind";

export interface LeasePolicyFacts {
  readonly refreshAfterMs: number;
  readonly cachedGraceUntilMs: number;
  readonly maxClockSkewMs: number;
  readonly offlineAfterExpiry: "cached_entitlement_until_grace_then_exit_only";
  readonly revocationBehavior: "exit_only";
  readonly exitsAlwaysAllowed: true;
}

export interface LicenseLeasePayload {
  readonly v: 1;
  readonly type: typeof LEASE_PAYLOAD_TYPE;
  readonly kid: string;
  readonly licenseId: string;
  readonly activationId: string;
  readonly installPublicKey: string;
  readonly features: readonly string[];
  readonly issuedAtMs: number;
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
  readonly entitlementExpiresAtMs: number;
  readonly sequence: number;
  readonly serverTimeMs: number;
  readonly policy: LeasePolicyFacts;
}

export interface SignedLicenseLease {
  readonly token: string;
  readonly payload: LicenseLeasePayload;
}

export interface LeaseActivation {
  readonly id: string;
  readonly licenseId: string;
  readonly installId: string;
  readonly installPublicKey: string;
  readonly status: "active" | "deactivated";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly lastSequence: number;
  readonly lastLeaseExpiresAtMs: number | null;
  readonly deactivatedAtMs: number | null;
  readonly deactivationReason: string | null;
  readonly revision: number;
}

export interface LeaseChallengeInput {
  readonly purpose: LeasePurpose;
  readonly installId: string;
  readonly installPublicKey: string;
  readonly activationId?: string;
  readonly newInstallId?: string;
  readonly newInstallPublicKey?: string;
}

export interface LeaseChallenge {
  readonly nonce: string;
  readonly purpose: LeasePurpose;
  readonly licenseId: string;
  readonly activationId: string | null;
  readonly activationRevision: number | null;
  readonly installId: string;
  readonly installPublicKey: string;
  readonly newInstallId: string | null;
  readonly newInstallPublicKey: string | null;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly serverTimeMs: number;
  /** Exact bytes the install signs, base64url encoded. */
  readonly proofBytesB64u: string;
}

export interface LeaseOperationResult {
  readonly replayed: boolean;
  readonly activation: LeaseActivation;
  readonly lease: SignedLicenseLease | null;
}

export interface LeasePublicKeyEntry {
  readonly publicKey: string;
  readonly createdAtMs: number;
}

export interface LeasePublicKeyring {
  readonly v: 1;
  readonly keys: Readonly<Record<string, LeasePublicKeyEntry>>;
}

export interface LicenseLeaseConfig {
  readonly activeKeyId?: string;
  readonly leaseDurationMs?: number;
  readonly cachedGraceMs?: number;
  readonly challengeTtlMs?: number;
  readonly maxClockSkewMs?: number;
  readonly defaultMaxMachines?: number;
}

export interface LicenseLeaseDeps {
  readonly now?: () => number;
  /** Monotonic process clock used to reject a sudden forward wall-clock jump
   * before that false future can be signed into durable lease state. */
  readonly monotonicNow?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly randomId?: () => string;
  readonly featuresFor?: (licenseId: string) => readonly string[];
}

interface ChallengeFacts {
  readonly nonceHash: string;
  readonly purpose: LeasePurpose;
  readonly licenseId: string;
  readonly activationId: string | null;
  readonly activationRevision: number | null;
  readonly installId: string;
  readonly installPublicKey: string;
  readonly newInstallId: string | null;
  readonly newInstallPublicKey: string | null;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

type LeaseAuditEvent =
  | {
      readonly schemaVersion: 1;
      readonly eventId: string;
      readonly kind: "ledger_initialized";
      readonly atMs: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: string;
      readonly kind: "challenge_issued";
      readonly atMs: number;
      readonly challenge: ChallengeFacts;
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: string;
      readonly kind: "activation_created" | "lease_renewed";
      readonly atMs: number;
      readonly nonceHash: string;
      readonly actor: "install";
      readonly activation: LeaseActivation;
      readonly lease: SignedLicenseLease;
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: string;
      readonly kind: "activation_rebound";
      readonly atMs: number;
      readonly nonceHash: string;
      readonly actor: "install";
      readonly activation: LeaseActivation;
      readonly lease: SignedLicenseLease;
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: string;
      readonly kind: "activation_deactivated";
      readonly atMs: number;
      readonly nonceHash: string | null;
      readonly actor: "install" | "admin";
      readonly reason: string;
      readonly activation: LeaseActivation;
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: string;
      readonly kind: "seat_override_set";
      readonly atMs: number;
      readonly actor: "admin";
      readonly licenseId: string;
      readonly maxMachines: number | null;
      readonly reason: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: string;
      readonly kind: "license_revocation_observed";
      readonly atMs: number;
      readonly actor: "admin";
      readonly licenseId: string;
      readonly reason: string;
    };

interface LedgerLine {
  readonly v: 1;
  readonly kid: string;
  readonly previousHash: string | null;
  readonly event: LeaseAuditEvent;
  readonly sig: string;
}

interface LedgerHead {
  readonly v: 1;
  readonly kid: string;
  readonly eventCount: number;
  readonly lastHash: string;
  readonly updatedAtMs: number;
  readonly sig: string;
}

interface ReplayState {
  readonly activations: Map<string, LeaseActivation>;
  readonly challenges: Map<string, ChallengeFacts>;
  readonly challengesByLicense: Map<string, ChallengeFacts[]>;
  readonly consumed: Map<string, LeaseOperationResult>;
  readonly seatOverrides: Map<string, number>;
  readonly events: LeaseAuditEvent[];
  readonly eventIds: Set<string>;
  readonly adminRecoveryLocked: Set<string>;
  lastHash: string | null;
  maxServerTimeMs: number;
}

interface ReplayCache {
  readonly state: ReplayState;
  readonly ledgerSize: number;
  readonly ledgerMtimeMs: number;
  readonly ledgerIno: number;
  readonly keyringHash: string;
}

export type LeaseVerifyResult =
  | { readonly ok: true; readonly payload: LicenseLeasePayload }
  | { readonly ok: false; readonly reason: "format" | "unknown_key" | "signature" | "payload" };

export type LeasePolicyResult =
  | { readonly state: "active" | "cached_grace"; readonly payload: LicenseLeasePayload }
  | { readonly state: "exit_only"; readonly payload: LicenseLeasePayload; readonly reason: "expired" | "clock" }
  | { readonly state: "refused"; readonly reason: "format" | "unknown_key" | "signature" | "payload" | "machine" | "sequence" };

export type LeaseRequestFailureKind = "auth" | "proof" | "expired" | "conflict" | "input" | "durable";

export interface LeaseRequestFailure {
  readonly kind: LeaseRequestFailureKind;
  readonly status: 400 | 403 | 409 | 410 | 503;
  readonly publicMessage: string;
  readonly operatorMessage: string | null;
}

/** Converts internal validation/storage errors into the stable HTTP contract.
 * Callers switch on `kind`; arbitrary exception text is never copied to a
 * response. This is deliberately beside the domain service instead of a set
 * of message-regex branches in the HTTP server. */
export function leaseRequestFailure(err: unknown): LeaseRequestFailure {
  const message = err instanceof Error ? err.message : "lease request was refused";
  if (/active LHK1|genuine known LHK1|issued by this Hub/.test(message)) {
    return { kind: "auth", status: 403, publicMessage: "license bearer was not accepted", operatorMessage: null };
  }
  if (/proof signature must be canonical/.test(message)) {
    return { kind: "input", status: 400, publicMessage: "lease request fields were invalid or did not identify an eligible binding", operatorMessage: null };
  }
  if (/proof signature|prove possession/.test(message)) {
    return { kind: "proof", status: 403, publicMessage: "machine possession proof was not accepted", operatorMessage: null };
  }
  if (/challenge expired/.test(message)) {
    return { kind: "expired", status: 410, publicMessage: "challenge expired before it was consumed", operatorMessage: null };
  }
  if (/limit reached|already bound|already active|collision|use rebind|stale|revision changed|changed concurrently|recovery-locked|writer is busy/.test(message)) {
    return { kind: "conflict", status: 409, publicMessage: "lease state changed or conflicts with this request; refresh and retry safely", operatorMessage: null };
  }
  if (/purpose|install|activation|challenge|nonce|replacement|rebind|maxMachines|machine limit|reason|unknown license/.test(message)) {
    return { kind: "input", status: 400, publicMessage: "lease request fields were invalid or did not identify an eligible binding", operatorMessage: null };
  }
  return {
    kind: "durable", status: 503,
    publicMessage: "machine-bound lease service could not verify its durable state",
    operatorMessage: message,
  };
}

function finiteInt(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function safeKid(kid: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(kid)) {
    throw new Error("lease key id must be 1..64 letters, digits, dot, underscore or dash");
  }
  return kid;
}

function boundedText(name: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const text = value.trim();
  if (text.length < 1 || text.length > max) throw new Error(`${name} must be 1..${max} characters`);
  return text;
}

function exactB64u(value: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === bytes && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function publicKeyObject(rawB64u: string): KeyObject {
  if (!exactB64u(rawB64u, RAW_PUBLIC_KEY_BYTES)) {
    throw new Error("install public key must be exactly 32 Ed25519 bytes in canonical base64url");
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawB64u, "base64url")]),
    format: "der",
    type: "spki",
  });
}

function rawPublicKey(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - RAW_PUBLIC_KEY_BYTES)).toString("base64url");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function lineUnsigned(line: Omit<LedgerLine, "sig">): Buffer {
  return Buffer.from(LEDGER_DOMAIN + JSON.stringify(line), "utf8");
}

function headUnsigned(head: Omit<LedgerHead, "sig">): Buffer {
  return Buffer.from(`wickhunter.license.lease-head.v1\n${JSON.stringify(head)}`, "utf8");
}

function leaseSigningBytes(payloadBytes: Buffer): Buffer {
  return Buffer.concat([LEASE_SIGNATURE_DOMAIN, payloadBytes]);
}

function lineHash(line: LedgerLine): string {
  return sha256(Buffer.from(JSON.stringify(line), "utf8"));
}

function durableAppendLine(file: string, line: LedgerLine): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  const needsSeparator = existed && fs.statSync(file).size > 0
    && fs.readFileSync(file).subarray(-1)[0] !== 0x0a;
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeSync(fd, `${needsSeparator ? "\n" : ""}${JSON.stringify(line)}\n`, undefined, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existed) fsyncDirectory(path.dirname(file));
}

function fsyncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (err) {
    // Some filesystems do not support directory fsync. The file itself is
    // already synced; ignore only that platform limitation, never file errors.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw err;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function writeExclusiveDurable(file: string, bytes: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes, "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fsyncDirectory(path.dirname(file));
}

function writeJsonAtomicDurable(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const suffix = randomBytes(12).toString("hex");
  const tmp = `${file}.tmp.${process.pid}.${suffix}`;
  writeExclusiveDurable(tmp, JSON.stringify(value, null, 2) + "\n");
  try {
    fs.renameSync(tmp, file);
    fsyncDirectory(path.dirname(file));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

function strictPublicKeyring(raw: unknown): LeasePublicKeyring {
  if (raw === null || typeof raw !== "object" || (raw as { v?: unknown }).v !== 1) {
    throw new Error("lease public keyring is not schema v1");
  }
  const keys = (raw as { keys?: unknown }).keys;
  if (keys === null || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error("lease public keyring keys must be an object");
  }
  for (const [kid, entry] of Object.entries(keys)) {
    safeKid(kid);
    if (entry === null || typeof entry !== "object") throw new Error(`lease public key ${kid} is malformed`);
    const publicKey = (entry as { publicKey?: unknown }).publicKey;
    const createdAtMs = (entry as { createdAtMs?: unknown }).createdAtMs;
    if (typeof publicKey !== "string" || !exactB64u(publicKey, RAW_PUBLIC_KEY_BYTES)) {
      throw new Error(`lease public key ${kid} is not canonical Ed25519 base64url`);
    }
    finiteInt(`lease public key ${kid} createdAtMs`, Number(createdAtMs), 0, Number.MAX_SAFE_INTEGER);
  }
  return raw as LeasePublicKeyring;
}

/** Dedicated lease signer and rotation keyring. It never reads or signs with
 * the LHK1, release, candle, or market-data keys. */
export class LicenseLeaseKeyStore {
  readonly keyringFile: string;
  private readonly keyFile: string;
  private readonly keyringLockFile: string;
  private privateKey: KeyObject | null = null;

  constructor(
    readonly dataDir: string,
    readonly activeKeyId = DEFAULT_LEASE_KEY_ID,
    private readonly now: () => number = Date.now,
  ) {
    safeKid(activeKeyId);
    this.keyFile = path.join(dataDir, `license-lease-signing.${activeKeyId}.key`);
    this.keyringFile = path.join(dataDir, LEASE_KEYRING_FILE);
    this.keyringLockFile = path.join(dataDir, "license-lease-keyring.v1.lock");
  }

  hasActiveKey(): boolean {
    return fs.existsSync(this.keyFile);
  }

  ensureActiveKey(): LeasePublicKeyring {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const current = fs.existsSync(this.keyringFile)
      ? strictPublicKeyring(readJson<unknown>(this.keyringFile, null))
      : { v: 1 as const, keys: {} };
    const existing = current.keys[this.activeKeyId];
    if (!fs.existsSync(this.keyFile)) {
      if (existing) {
        throw new Error(`lease private key ${this.activeKeyId} is missing; restore it from backup — refusing to replace a published authority`);
      }
      if (Object.keys(current.keys).length > 0 || this.activeKeyId !== DEFAULT_LEASE_KEY_ID) {
        throw new Error(`lease signing kid ${this.activeKeyId} was not pre-provisioned; run leasekey and ship its public key before activating it`);
      }
      return this.provisionActiveKey();
    }
    if (!existing) return this.provisionActiveKey();
    return this.loadActive(current);
  }

  /** Explicit staging seam used by the operator CLI. Runtime activation never
   * invents a rotation key merely because an environment variable changed. */
  provisionActiveKey(): LeasePublicKeyring {
    fs.mkdirSync(this.dataDir, { recursive: true });
    let fd: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fd = fs.openSync(this.keyringLockFile, "wx", 0o600);
        fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
        fs.fsyncSync(fd);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        let owner = 0;
        try { owner = Number(fs.readFileSync(this.keyringLockFile, "utf8").trim()); } catch { /* refused below */ }
        let alive = Number.isSafeInteger(owner) && owner > 0;
        if (alive) {
          try { process.kill(owner, 0); } catch { alive = false; }
        }
        if (alive || attempt > 0) throw new Error("lease keyring writer is busy in another process");
        try { fs.unlinkSync(this.keyringLockFile); } catch { throw new Error("lease keyring writer lock could not be recovered"); }
      }
    }
    if (fd === null) throw new Error("lease keyring writer lock could not be acquired");
    try {
      return this.provisionActiveKeyLocked();
    } finally {
      try { fs.closeSync(fd); } finally { try { fs.unlinkSync(this.keyringLockFile); } catch { /* next writer fails closed */ } }
    }
  }

  private provisionActiveKeyLocked(): LeasePublicKeyring {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const current = fs.existsSync(this.keyringFile)
      ? strictPublicKeyring(readJson<unknown>(this.keyringFile, null))
      : { v: 1 as const, keys: {} };
    const existing = current.keys[this.activeKeyId];
    if (!fs.existsSync(this.keyFile)) {
      if (existing) throw new Error(`lease private key ${this.activeKeyId} is missing; restore it from backup — refusing to replace a published authority`);
      const pair = generateKeyPairSync("ed25519");
      const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      // wx makes two racing Hub processes fail instead of replacing authority.
      writeExclusiveDurable(this.keyFile, pem);
    }
    return this.loadActive(current);
  }

  private loadActive(current: LeasePublicKeyring): LeasePublicKeyring {
    const existing = current.keys[this.activeKeyId];
    const priv = createPrivateKey(fs.readFileSync(this.keyFile, "utf8"));
    const publicKey = rawPublicKey(createPublicKey(priv));
    if (existing && existing.publicKey !== publicKey) {
      throw new Error(`lease keyring ${this.activeKeyId} does not match its private key`);
    }
    if (!existing) {
      const createdAtMs = finiteInt("lease key createdAtMs", this.now(), 0, Number.MAX_SAFE_INTEGER);
      const next: LeasePublicKeyring = {
        v: 1,
        keys: { ...current.keys, [this.activeKeyId]: { publicKey, createdAtMs } },
      };
      writeJsonAtomicDurable(this.keyringFile, next);
      this.privateKey = priv;
      return next;
    }
    this.privateKey = priv;
    return current;
  }

  publicKeyring(): LeasePublicKeyring {
    return this.ensureActiveKey();
  }

  sign(bytes: Buffer): string {
    if (!this.privateKey) this.ensureActiveKey();
    return edSign(null, bytes, this.privateKey!).toString("base64url");
  }

  signLease(payload: LicenseLeasePayload): SignedLicenseLease {
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const sig = this.sign(leaseSigningBytes(bytes));
    return { token: `${LEASE_TOKEN_PREFIX}.${bytes.toString("base64url")}.${sig}`, payload };
  }
}

function validPolicy(value: unknown): value is LeasePolicyFacts {
  if (value === null || typeof value !== "object") return false;
  const p = value as Partial<LeasePolicyFacts>;
  return Number.isSafeInteger(p.refreshAfterMs)
    && Number.isSafeInteger(p.cachedGraceUntilMs)
    && Number.isSafeInteger(p.maxClockSkewMs)
    && p.offlineAfterExpiry === "cached_entitlement_until_grace_then_exit_only"
    && p.revocationBehavior === "exit_only"
    && p.exitsAlwaysAllowed === true;
}

function validLeasePayload(value: unknown): value is LicenseLeasePayload {
  if (value === null || typeof value !== "object") return false;
  const p = value as Partial<LicenseLeasePayload>;
  const features = Array.isArray(p.features) ? p.features : [];
  return p.v === 1 && p.type === LEASE_PAYLOAD_TYPE
    && typeof p.kid === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p.kid)
    && typeof p.licenseId === "string" && !!p.licenseId
    && typeof p.activationId === "string" && !!p.activationId
    && typeof p.installPublicKey === "string" && exactB64u(p.installPublicKey, RAW_PUBLIC_KEY_BYTES)
    && features.every((f) => typeof f === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(f))
    && new Set(features).size === features.length
    && JSON.stringify(features) === JSON.stringify([...features].sort())
    && Number.isSafeInteger(p.issuedAtMs) && Number.isSafeInteger(p.notBeforeMs)
    && Number.isSafeInteger(p.expiresAtMs) && Number.isSafeInteger(p.entitlementExpiresAtMs)
    && Number.isSafeInteger(p.sequence) && Number(p.sequence) >= 1
    && Number.isSafeInteger(p.serverTimeMs) && validPolicy(p.policy)
    && Number(p.notBeforeMs) <= Number(p.issuedAtMs)
    && Number(p.issuedAtMs) === Number(p.serverTimeMs)
    && Number(p.issuedAtMs) < Number(p.expiresAtMs)
    && Number(p.expiresAtMs) <= Number(p.entitlementExpiresAtMs)
    && Number(p.policy?.refreshAfterMs) >= Number(p.issuedAtMs)
    && Number(p.policy?.refreshAfterMs) <= Number(p.expiresAtMs)
    && Number(p.policy?.cachedGraceUntilMs) >= Number(p.expiresAtMs)
    && Number(p.policy?.cachedGraceUntilMs) <= Number(p.entitlementExpiresAtMs);
}

export function verifyLicenseLease(
  token: string,
  keyring: LeasePublicKeyring,
): LeaseVerifyResult {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts[0] !== LEASE_TOKEN_PREFIX) return { ok: false, reason: "format" };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(parts[1]!, "base64url");
    if (bytes.toString("base64url") !== parts[1] || !exactB64u(parts[2]!, SIGNATURE_BYTES)) {
      return { ok: false, reason: "format" };
    }
  } catch {
    return { ok: false, reason: "format" };
  }
  let payload: unknown;
  try { payload = JSON.parse(bytes.toString("utf8")); }
  catch { return { ok: false, reason: "payload" }; }
  if (!validLeasePayload(payload)) return { ok: false, reason: "payload" };
  const entry = strictPublicKeyring(keyring).keys[payload.kid];
  if (!entry) return { ok: false, reason: "unknown_key" };
  let valid = false;
  try {
    valid = edVerify(null, leaseSigningBytes(bytes), publicKeyObject(entry.publicKey), Buffer.from(parts[2]!, "base64url"));
  } catch { valid = false; }
  return valid ? { ok: true, payload } : { ok: false, reason: "signature" };
}

/** Cryptographic validity is not entitlement usability. Client code must use
 * this policy result so an old-but-well-signed lease cannot become a new-entry
 * authorization after expiry, key cloning, or sequence rollback. */
export function evaluateLicenseLease(
  token: string,
  keyring: LeasePublicKeyring,
  input: { readonly nowMs: number; readonly installPublicKey: string; readonly minimumSequence: number },
): LeasePolicyResult {
  const verified = verifyLicenseLease(token, keyring);
  if (!verified.ok) return { state: "refused", reason: verified.reason };
  if (verified.payload.installPublicKey !== input.installPublicKey) return { state: "refused", reason: "machine" };
  if (!Number.isSafeInteger(input.minimumSequence) || verified.payload.sequence < input.minimumSequence) {
    return { state: "refused", reason: "sequence" };
  }
  // `notBeforeMs` is already issuedAt minus the allowed skew. Subtracting the
  // policy again here would silently double the advertised tolerance.
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < verified.payload.notBeforeMs) {
    return { state: "exit_only", payload: verified.payload, reason: "clock" };
  }
  if (input.nowMs < verified.payload.expiresAtMs) return { state: "active", payload: verified.payload };
  if (input.nowMs <= verified.payload.policy.cachedGraceUntilMs) return { state: "cached_grace", payload: verified.payload };
  return { state: "exit_only", payload: verified.payload, reason: "expired" };
}

function validateActivation(value: LeaseActivation): void {
  boundedText("activation id", value.id, 128);
  boundedText("license id", value.licenseId, 128);
  boundedText("install id", value.installId, 128);
  publicKeyObject(value.installPublicKey);
  if (value.status !== "active" && value.status !== "deactivated") throw new Error("activation status is invalid");
  finiteInt("activation sequence", value.lastSequence, 0, Number.MAX_SAFE_INTEGER);
  finiteInt("activation revision", value.revision, 1, Number.MAX_SAFE_INTEGER);
  finiteInt("activation createdAtMs", value.createdAtMs, 0, Number.MAX_SAFE_INTEGER);
  finiteInt("activation updatedAtMs", value.updatedAtMs, value.createdAtMs, Number.MAX_SAFE_INTEGER);
  if (value.lastLeaseExpiresAtMs !== null) finiteInt("activation lastLeaseExpiresAtMs", value.lastLeaseExpiresAtMs, 0, Number.MAX_SAFE_INTEGER);
  if (value.deactivatedAtMs !== null) finiteInt("activation deactivatedAtMs", value.deactivatedAtMs, value.createdAtMs, Number.MAX_SAFE_INTEGER);
  if (value.status === "active" && (value.deactivatedAtMs !== null || value.deactivationReason !== null)) {
    throw new Error("active activation cannot carry deactivation facts");
  }
  if (value.status === "deactivated" && (value.deactivatedAtMs === null || !value.deactivationReason)) {
    throw new Error("deactivated activation must carry its audit facts");
  }
}

function validateAuditEvent(event: LeaseAuditEvent): void {
  if (event.schemaVersion !== 1 || typeof event.eventId !== "string" || !event.eventId
    || !Number.isSafeInteger(event.atMs) || event.atMs < 0) {
    throw new Error("lease audit event has an invalid v1 envelope");
  }
  switch (event.kind) {
    case "ledger_initialized": return;
    case "challenge_issued":
      {
        const c = event.challenge;
        if (!/^[a-f0-9]{64}$/.test(c.nonceHash)) throw new Error("lease challenge hash is invalid");
        if (!(c.purpose === "activate" || c.purpose === "renew" || c.purpose === "deactivate" || c.purpose === "rebind")) {
          throw new Error("lease challenge purpose is invalid");
        }
        boundedText("challenge licenseId", c.licenseId, 128);
        boundedText("challenge installId", c.installId, 128);
        publicKeyObject(c.installPublicKey);
        finiteInt("challenge issuedAtMs", c.issuedAtMs, 0, Number.MAX_SAFE_INTEGER);
        finiteInt("challenge expiresAtMs", c.expiresAtMs, c.issuedAtMs + 1, Number.MAX_SAFE_INTEGER);
        if (c.purpose === "activate" ? c.activationId !== null : !c.activationId) {
          throw new Error("lease challenge activation identity does not match its purpose");
        }
        if (c.purpose === "activate" ? c.activationRevision !== null
          : !Number.isSafeInteger(c.activationRevision) || Number(c.activationRevision) < 1) {
          throw new Error("lease challenge activation revision does not match its purpose");
        }
        if (c.purpose === "rebind") {
          boundedText("challenge newInstallId", c.newInstallId, 128);
          publicKeyObject(boundedText("challenge newInstallPublicKey", c.newInstallPublicKey, 128));
        } else if (c.newInstallId !== null || c.newInstallPublicKey !== null) {
          throw new Error("only a rebind challenge may carry replacement install facts");
        }
      }
      return;
    case "activation_created":
    case "lease_renewed":
    case "activation_rebound":
      validateActivation(event.activation);
      if (event.activation.status !== "active") throw new Error("a lease cannot be issued to a deactivated machine");
      if (!validLeasePayload(event.lease.payload)) throw new Error("lease audit carries a malformed lease payload");
      if (event.lease.payload.licenseId !== event.activation.licenseId
        || event.lease.payload.activationId !== event.activation.id
        || event.lease.payload.installPublicKey !== event.activation.installPublicKey
        || event.lease.payload.sequence !== event.activation.lastSequence
        || event.lease.payload.expiresAtMs !== event.activation.lastLeaseExpiresAtMs) {
        throw new Error("lease audit payload does not match its activation revision");
      }
      return;
    case "activation_deactivated": validateActivation(event.activation); return;
    case "seat_override_set":
      if (event.maxMachines !== null) finiteInt("seat override", event.maxMachines, 1, 64);
      boundedText("seat override reason", event.reason, 500);
      return;
    case "license_revocation_observed": boundedText("revocation reason", event.reason, 500); return;
    default: throw new Error("lease audit event kind is not supported by this Hub build");
  }
}

function emptyReplay(): ReplayState {
  return {
    activations: new Map(), challenges: new Map(), challengesByLicense: new Map(), consumed: new Map(), seatOverrides: new Map(),
    events: [], eventIds: new Set(), adminRecoveryLocked: new Set(), lastHash: null, maxServerTimeMs: 0,
  };
}

function lowerBoundChallenge(
  rows: readonly ChallengeFacts[],
  value: number,
  select: (row: ChallengeFacts) => number,
): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (select(rows[mid]!) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class LicenseLeaseService {
  readonly ledgerFile: string;
  readonly ledgerHeadFile: string;
  readonly mutationLockFile: string;
  readonly keyStore: LicenseLeaseKeyStore;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly nonceBytes: (size: number) => Buffer;
  private readonly randomId: () => string;
  private readonly featuresFor: (licenseId: string) => readonly string[];
  private readonly leaseDurationMs: number;
  private readonly cachedGraceMs: number;
  private readonly challengeTtlMs: number;
  private readonly maxClockSkewMs: number;
  private readonly defaultMaxMachines: number;
  private replayCache: ReplayCache | null = null;
  private readonly wallClockAnchorMs: number;
  private readonly monotonicAnchorMs: number;

  constructor(
    readonly dataDir: string,
    private readonly licenses: Pick<LicenseStore, "verify" | "decodeGenuine" | "isKnown" | "isRevoked" | "list">,
    cfg: LicenseLeaseConfig = {},
    deps: LicenseLeaseDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.monotonicNow = deps.monotonicNow ?? (() => performance.now());
    this.nonceBytes = deps.randomBytes ?? randomBytes;
    this.randomId = deps.randomId ?? randomUUID;
    this.featuresFor = deps.featuresFor ?? (() => []);
    this.leaseDurationMs = finiteInt("leaseDurationMs", cfg.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS, 60_000, 7 * 86_400_000);
    this.cachedGraceMs = finiteInt("cachedGraceMs", cfg.cachedGraceMs ?? DEFAULT_LEASE_GRACE_MS, 0, 30 * 86_400_000);
    this.challengeTtlMs = finiteInt("challengeTtlMs", cfg.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS, 10_000, 60 * 60_000);
    this.maxClockSkewMs = finiteInt("maxClockSkewMs", cfg.maxClockSkewMs ?? DEFAULT_CLOCK_SKEW_MS, 0, 60 * 60_000);
    this.defaultMaxMachines = finiteInt("defaultMaxMachines", cfg.defaultMaxMachines ?? DEFAULT_MAX_MACHINES, 1, 64);
    this.wallClockAnchorMs = finiteInt("server clock", this.now(), 0, Number.MAX_SAFE_INTEGER);
    this.monotonicAnchorMs = this.monotonicNow();
    if (!Number.isFinite(this.monotonicAnchorMs) || this.monotonicAnchorMs < 0) throw new Error("monotonic server clock is unavailable");
    this.keyStore = new LicenseLeaseKeyStore(dataDir, cfg.activeKeyId ?? DEFAULT_LEASE_KEY_ID, this.now);
    this.keyStore.ensureActiveKey();
    this.ledgerFile = path.join(dataDir, LEASE_LEDGER_FILE);
    this.ledgerHeadFile = path.join(dataDir, LEASE_LEDGER_HEAD_FILE);
    this.mutationLockFile = path.join(dataDir, "license-lease-write.v1.lock");
    const haveLedger = fs.existsSync(this.ledgerFile);
    const haveHead = fs.existsSync(this.ledgerHeadFile);
    if (!haveLedger && !haveHead) {
      this.appendEvent({ schemaVersion: 1, eventId: this.randomId(), kind: "ledger_initialized", atMs: this.rawNow() }, null);
    } else {
      if (!haveLedger || !haveHead) throw new Error("lease audit ledger/checkpoint pair is incomplete; restore both from the same backup");
      const recovered = this.replay(); // fail closed on corruption, deletion, truncation, or rollback
      if (recovered.events.length === 0) throw new Error("lease audit ledger is empty after it was initialized");
    }
  }

  private rawNow(): number {
    const raw = finiteInt("server clock", this.now(), 0, Number.MAX_SAFE_INTEGER);
    const monotonic = this.monotonicNow();
    if (!Number.isFinite(monotonic) || monotonic < this.monotonicAnchorMs) {
      throw new Error("monotonic server clock moved backwards");
    }
    const expected = this.wallClockAnchorMs + (monotonic - this.monotonicAnchorMs);
    if (raw > expected + this.maxClockSkewMs) {
      throw new Error("server clock jumped forward beyond the configured safety bound; refusing to sign future lease state until time catches up");
    }
    return raw;
  }

  private readLines(): { readonly lines: LedgerLine[]; readonly malformedTailOffset: number | null } {
    let text: string;
    try { text = fs.readFileSync(this.ledgerFile, "utf8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], malformedTailOffset: null };
      throw err;
    }
    if (!text) return { lines: [], malformedTailOffset: null };
    const raw = text.split("\n");
    if (raw.at(-1) === "") raw.pop();
    const lines: LedgerLine[] = [];
    let offset = 0;
    for (const [index, line] of raw.entries()) {
      if (!line) { offset += 1; continue; }
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch {
        if (index === raw.length - 1) return { lines, malformedTailOffset: offset };
        throw new Error(`lease audit line ${index + 1} is not JSON`);
      }
      if (parsed === null || typeof parsed !== "object") throw new Error(`lease audit line ${index + 1} is not an object`);
      lines.push(parsed as LedgerLine);
      offset += Buffer.byteLength(line, "utf8") + 1;
    }
    return { lines, malformedTailOffset: null };
  }

  private readHead(keyring: LeasePublicKeyring): LedgerHead | null {
    if (!fs.existsSync(this.ledgerHeadFile)) return null;
    const raw = readJson<unknown>(this.ledgerHeadFile, null);
    if (raw === null || typeof raw !== "object") throw new Error("lease audit checkpoint is malformed");
    const h = raw as Partial<LedgerHead>;
    if (h.v !== 1 || typeof h.kid !== "string" || !Number.isSafeInteger(h.eventCount)
      || Number(h.eventCount) < 1 || typeof h.lastHash !== "string" || !/^[a-f0-9]{64}$/.test(h.lastHash)
      || !Number.isSafeInteger(h.updatedAtMs) || typeof h.sig !== "string" || !exactB64u(h.sig, SIGNATURE_BYTES)) {
      throw new Error("lease audit checkpoint is not a valid v1 head");
    }
    const entry = keyring.keys[h.kid];
    if (!entry) throw new Error(`lease audit checkpoint uses unknown retained key ${h.kid}`);
    const unsigned = { v: 1 as const, kid: h.kid, eventCount: Number(h.eventCount), lastHash: h.lastHash, updatedAtMs: Number(h.updatedAtMs) };
    if (!edVerify(null, headUnsigned(unsigned), publicKeyObject(entry.publicKey), Buffer.from(h.sig, "base64url"))) {
      throw new Error("lease audit checkpoint signature is invalid");
    }
    return h as LedgerHead;
  }

  private writeHead(eventCount: number, lastHash: string, updatedAtMs: number): void {
    const unsigned = { v: 1 as const, kid: this.keyStore.activeKeyId, eventCount, lastHash, updatedAtMs };
    const head: LedgerHead = { ...unsigned, sig: this.keyStore.sign(headUnsigned(unsigned)) };
    writeJsonAtomicDurable(this.ledgerHeadFile, head);
  }

  private replay(): ReplayState {
    const keyring = this.keyStore.publicKeyring();
    const head = this.readHead(keyring);
    const keyringHash = sha256(JSON.stringify(keyring));
    let before: fs.Stats | null = null;
    try { before = fs.statSync(this.ledgerFile); } catch { /* full replay reports the exact state below */ }
    if (head && before && this.replayCache
      && this.replayCache.state.events.length === head.eventCount
      && this.replayCache.state.lastHash === head.lastHash
      && this.replayCache.ledgerSize === before.size
      && this.replayCache.ledgerMtimeMs === before.mtimeMs
      && this.replayCache.ledgerIno === before.ino
      && this.replayCache.keyringHash === keyringHash) {
      return this.replayCache.state;
    }
    const state = emptyReplay();
    const read = this.readLines();
    for (const [index, line] of read.lines.entries()) {
      if (line.v !== 1 || typeof line.kid !== "string" || typeof line.sig !== "string"
        || !(line.previousHash === null || typeof line.previousHash === "string")
        || line.previousHash !== state.lastHash) {
        throw new Error(`lease audit line ${index + 1} breaks the v1 hash chain`);
      }
      const entry = keyring.keys[line.kid];
      if (!entry) throw new Error(`lease audit line ${index + 1} uses unknown key ${line.kid}`);
      if (!exactB64u(line.sig, SIGNATURE_BYTES)) throw new Error(`lease audit line ${index + 1} has malformed signature`);
      const unsigned = { v: line.v, kid: line.kid, previousHash: line.previousHash, event: line.event } as const;
      if (!edVerify(null, lineUnsigned(unsigned), publicKeyObject(entry.publicKey), Buffer.from(line.sig, "base64url"))) {
        throw new Error(`lease audit line ${index + 1} signature is invalid`);
      }
      validateAuditEvent(line.event);
      const event = line.event;
      if (state.eventIds.has(event.eventId)) throw new Error(`lease audit line ${index + 1} repeats event id ${event.eventId}`);
      state.eventIds.add(event.eventId);
      if (event.kind === "activation_created" || event.kind === "lease_renewed" || event.kind === "activation_rebound") {
        const verifiedLease = verifyLicenseLease(event.lease.token, keyring);
        if (!verifiedLease.ok || JSON.stringify(verifiedLease.payload) !== JSON.stringify(event.lease.payload)) {
          throw new Error(`lease audit line ${index + 1} carries an invalid or mismatched signed lease`);
        }
      }
      state.events.push(event);
      state.maxServerTimeMs = Math.max(state.maxServerTimeMs, event.atMs);
      switch (event.kind) {
        case "ledger_initialized":
          if (index !== 0 || state.events.length !== 1) {
            throw new Error(`lease audit line ${index + 1} puts the schema marker anywhere but first`);
          }
          break;
        case "challenge_issued":
          if (state.challenges.has(event.challenge.nonceHash)) {
            throw new Error(`lease audit line ${index + 1} repeats a challenge nonce`);
          }
          state.challenges.set(event.challenge.nonceHash, event.challenge);
          {
            const rows = state.challengesByLicense.get(event.challenge.licenseId) ?? [];
            rows.push(event.challenge);
            state.challengesByLicense.set(event.challenge.licenseId, rows);
          }
          break;
        case "activation_created":
          {
            const challenge = state.challenges.get(event.nonceHash);
            if (!challenge || challenge.purpose !== "activate" || state.consumed.has(event.nonceHash)
              || challenge.licenseId !== event.activation.licenseId
              || challenge.activationRevision !== null
              || challenge.installId !== event.activation.installId
              || challenge.installPublicKey !== event.activation.installPublicKey
              || state.activations.has(event.activation.id)
              || event.activation.lastSequence !== 1 || event.activation.revision !== 1) {
              throw new Error(`lease audit line ${index + 1} is not a valid first activation transition`);
            }
          }
          state.activations.set(event.activation.id, event.activation);
          state.consumed.set(event.nonceHash, { replayed: true, activation: event.activation, lease: event.lease });
          break;
        case "lease_renewed":
          {
            const challenge = state.challenges.get(event.nonceHash);
            const prior = state.activations.get(event.activation.id);
            if (!challenge || state.consumed.has(event.nonceHash) || !prior || prior.status !== "active"
              || !(challenge.purpose === "renew" || challenge.purpose === "activate")
              || challenge.licenseId !== event.activation.licenseId
              || challenge.installId !== event.activation.installId
              || challenge.installPublicKey !== event.activation.installPublicKey
              || (challenge.purpose === "renew" && challenge.activationId !== event.activation.id)
              || (challenge.purpose === "renew" && challenge.activationRevision !== prior.revision)
              || event.activation.installId !== prior.installId
              || event.activation.installPublicKey !== prior.installPublicKey
              || event.activation.lastSequence !== prior.lastSequence + 1
              || event.activation.revision !== prior.revision + 1
              || event.activation.createdAtMs !== prior.createdAtMs) {
              throw new Error(`lease audit line ${index + 1} is not a monotonic renewal transition`);
            }
          }
          state.activations.set(event.activation.id, event.activation);
          state.consumed.set(event.nonceHash, { replayed: true, activation: event.activation, lease: event.lease });
          break;
        case "activation_rebound":
          {
            const challenge = state.challenges.get(event.nonceHash);
            const prior = state.activations.get(event.activation.id);
            if (!challenge || challenge.purpose !== "rebind" || state.consumed.has(event.nonceHash)
              || !prior || prior.status !== "active" || challenge.activationId !== prior.id
              || challenge.activationRevision !== prior.revision
              || challenge.installId !== prior.installId
              || challenge.installPublicKey !== prior.installPublicKey
              || challenge.licenseId !== event.activation.licenseId
              || challenge.newInstallId !== event.activation.installId
              || challenge.newInstallPublicKey !== event.activation.installPublicKey
              || event.activation.lastSequence !== prior.lastSequence + 1
              || event.activation.revision !== prior.revision + 1
              || event.activation.createdAtMs !== prior.createdAtMs) {
              throw new Error(`lease audit line ${index + 1} is not a valid binding revision transition`);
            }
          }
          state.activations.set(event.activation.id, event.activation);
          state.consumed.set(event.nonceHash, { replayed: true, activation: event.activation, lease: event.lease });
          break;
        case "activation_deactivated":
          {
            const prior = state.activations.get(event.activation.id);
            if (!prior || prior.status !== "active" || event.activation.licenseId !== prior.licenseId
              || event.activation.installId !== prior.installId
              || event.activation.installPublicKey !== prior.installPublicKey
              || event.activation.lastSequence !== prior.lastSequence
              || event.activation.revision !== prior.revision + 1
              || event.activation.createdAtMs !== prior.createdAtMs) {
              throw new Error(`lease audit line ${index + 1} is not a valid deactivation transition`);
            }
            if (event.actor === "install") {
              const challenge = event.nonceHash ? state.challenges.get(event.nonceHash) : null;
              if (!challenge || challenge.purpose !== "deactivate" || state.consumed.has(event.nonceHash!)
                || challenge.activationId !== prior.id || challenge.activationRevision !== prior.revision
                || challenge.installId !== prior.installId || challenge.installPublicKey !== prior.installPublicKey
                || challenge.licenseId !== prior.licenseId) {
                throw new Error(`lease audit line ${index + 1} does not consume its deactivation challenge exactly once`);
              }
            } else if (event.nonceHash !== null) {
              throw new Error(`lease audit line ${index + 1} gives an admin deactivation an install nonce`);
            }
          }
          state.activations.set(event.activation.id, event.activation);
          if (event.actor === "admin") state.adminRecoveryLocked.add(event.activation.licenseId);
          if (event.nonceHash) state.consumed.set(event.nonceHash, { replayed: true, activation: event.activation, lease: null });
          break;
        case "seat_override_set":
          if (event.maxMachines === null) state.seatOverrides.delete(event.licenseId);
          else state.seatOverrides.set(event.licenseId, event.maxMachines);
          break;
        case "license_revocation_observed": break;
        default: throw new Error(`lease audit line ${index + 1} has an unsupported event kind`);
      }
      state.lastHash = lineHash(line);
    }
    if (head === null) {
      if (state.events.length > 0) throw new Error("lease audit checkpoint is missing for an existing ledger");
    } else if (state.events.length !== head.eventCount || state.lastHash !== head.lastHash) {
      throw new Error("lease audit ledger does not match its independently durable signed checkpoint; deletion, truncation, rollback, or an interrupted append was detected");
    }
    if (read.malformedTailOffset !== null) {
      // Repair only bytes that were never checkpointed. A complete JSON final
      // line (even without a newline) was parsed above and must match the head;
      // a checkpoint that names the malformed tail would already have refused.
      if (head === null || state.events.length !== head.eventCount || state.lastHash !== head.lastHash) {
        throw new Error("lease audit malformed tail cannot be reconciled to its signed checkpoint");
      }
      fs.truncateSync(this.ledgerFile, read.malformedTailOffset);
      const fd = fs.openSync(this.ledgerFile, "a");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    let finalStat: fs.Stats | null = null;
    try { finalStat = fs.statSync(this.ledgerFile); } catch { /* first-ever empty initialization */ }
    this.replayCache = finalStat ? {
      state,
      ledgerSize: finalStat.size,
      ledgerMtimeMs: finalStat.mtimeMs,
      ledgerIno: finalStat.ino,
      keyringHash,
    } : null;
    return state;
  }

  /** Update the verified in-process replay cache only after both the ledger
   * line and signed head are durable. External writers/tampering change the
   * head or file stat and force a full signed replay on the next request. */
  private cacheAppendedEvent(state: ReplayState, event: LeaseAuditEvent, hash: string): void {
    state.events.push(event);
    state.eventIds.add(event.eventId);
    state.maxServerTimeMs = Math.max(state.maxServerTimeMs, event.atMs);
    switch (event.kind) {
      case "ledger_initialized": break;
      case "challenge_issued": {
        state.challenges.set(event.challenge.nonceHash, event.challenge);
        const rows = state.challengesByLicense.get(event.challenge.licenseId) ?? [];
        rows.push(event.challenge);
        state.challengesByLicense.set(event.challenge.licenseId, rows);
        break;
      }
      case "activation_created":
      case "lease_renewed":
      case "activation_rebound":
        state.activations.set(event.activation.id, event.activation);
        state.consumed.set(event.nonceHash, { replayed: true, activation: event.activation, lease: event.lease });
        break;
      case "activation_deactivated":
        state.activations.set(event.activation.id, event.activation);
        if (event.actor === "admin") state.adminRecoveryLocked.add(event.activation.licenseId);
        if (event.nonceHash) state.consumed.set(event.nonceHash, { replayed: true, activation: event.activation, lease: null });
        break;
      case "seat_override_set":
        if (event.maxMachines === null) state.seatOverrides.delete(event.licenseId);
        else state.seatOverrides.set(event.licenseId, event.maxMachines);
        break;
      case "license_revocation_observed": break;
    }
    state.lastHash = hash;
    const stat = fs.statSync(this.ledgerFile);
    this.replayCache = {
      state,
      ledgerSize: stat.size,
      ledgerMtimeMs: stat.mtimeMs,
      ledgerIno: stat.ino,
      keyringHash: sha256(JSON.stringify(this.keyStore.publicKeyring())),
    };
  }

  private appendEvent(event: LeaseAuditEvent, expectedLastHash: string | null): void {
    let fd: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fd = fs.openSync(this.mutationLockFile, "wx", 0o600);
        fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
        fs.fsyncSync(fd);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        let owner = 0;
        try { owner = Number(fs.readFileSync(this.mutationLockFile, "utf8").trim()); } catch { /* refused below */ }
        let alive = Number.isSafeInteger(owner) && owner > 0;
        if (alive) {
          try { process.kill(owner, 0); } catch { alive = false; }
        }
        if (alive || attempt > 0) throw new Error("lease audit writer is busy in another Hub process");
        try { fs.unlinkSync(this.mutationLockFile); } catch { throw new Error("lease audit writer lock could not be recovered"); }
      }
    }
    if (fd === null) throw new Error("lease audit writer lock could not be acquired");
    try {
      const state = this.replay();
      if (state.lastHash !== expectedLastHash) {
        throw new Error("lease audit changed concurrently; retry from a fresh challenge or admin snapshot");
      }
      validateAuditEvent(event);
      if (state.eventIds.has(event.eventId)) throw new Error(`lease audit event id ${event.eventId} already exists`);
      const unsigned = {
        v: 1 as const,
        kid: this.keyStore.activeKeyId,
        previousHash: state.lastHash,
        event,
      };
      const line: LedgerLine = { ...unsigned, sig: this.keyStore.sign(lineUnsigned(unsigned)) };
      if (fs.existsSync(this.ledgerFile) && fs.statSync(this.ledgerFile).size >= MAX_LEDGER_BYTES) {
        throw new Error("lease audit ledger reached its configured safety ceiling; archive with a signed operator procedure before accepting more mutations");
      }
      durableAppendLine(this.ledgerFile, line);
      const hash = lineHash(line);
      this.writeHead(state.events.length + 1, hash, event.atMs);
      this.cacheAppendedEvent(state, event, hash);
    } finally {
      try { fs.closeSync(fd); } finally { try { fs.unlinkSync(this.mutationLockFile); } catch { /* next writer fails closed */ } }
    }
  }

  private serverNow(state: ReplayState): number {
    return Math.max(this.rawNow(), state.maxServerTimeMs);
  }

  private authenticate(token: string, allowLapsed: boolean, atMs: number): LicensePayload {
    if (allowLapsed) {
      const payload = this.licenses.decodeGenuine(token);
      if (!payload || !this.licenses.isKnown(payload.id)) throw new Error("a genuine known LHK1 license is required");
      return payload;
    }
    const verified = this.licenses.verify(token, atMs);
    if (!verified.ok) throw new Error(`an active LHK1 license is required (${verified.reason})`);
    const current = this.licenses.list().find((row) => row.id === verified.payload.id);
    if (!current || current.revoked || this.licenses.isRevoked(verified.payload.id) || atMs >= current.exp) {
      throw new Error("an active license issued by this Hub is required");
    }
    // The bearer and registry are separate durable facts. A lease may outlive
    // neither: a shortened registry row wins immediately, while an extension
    // still requires the operator's re-minted LHK1 bearer.
    return { ...verified.payload, exp: Math.min(verified.payload.exp, current.exp) };
  }

  private activationFor(state: ReplayState, licenseId: string, id: string | undefined): LeaseActivation {
    if (!id) throw new Error("activationId is required");
    const activation = state.activations.get(id);
    if (!activation || activation.licenseId !== licenseId) throw new Error("activation was not found for this license");
    if (activation.status !== "active") throw new Error("activation is deactivated");
    return activation;
  }

  challenge(token: string, input: LeaseChallengeInput): LeaseChallenge {
    const purpose = input?.purpose;
    if (!(["activate", "renew", "deactivate", "rebind"] as readonly unknown[]).includes(purpose)) {
      throw new Error("purpose must be activate, renew, deactivate, or rebind");
    }
    const allowLapsed = purpose === "deactivate";
    const state = this.replay();
    let now = this.serverNow(state);
    const license = this.authenticate(token, allowLapsed, now);
    if (allowLapsed) now = Math.min(now, state.maxServerTimeMs + this.challengeTtlMs);
    const installId = boundedText("installId", input.installId, 128);
    const installPublicKey = boundedText("installPublicKey", input.installPublicKey, 128);
    publicKeyObject(installPublicKey);
    let activationId: string | null = null;
    let activationRevision: number | null = null;
    let newInstallId: string | null = null;
    let newInstallPublicKey: string | null = null;
    if (purpose !== "activate") {
      const activation = this.activationFor(state, license.id, input.activationId);
      if (activation.installId !== installId || activation.installPublicKey !== installPublicKey) {
        throw new Error("install identity does not match the active machine binding");
      }
      activationId = activation.id;
      activationRevision = activation.revision;
    }
    if (purpose === "rebind") {
      newInstallId = boundedText("newInstallId", input.newInstallId, 128);
      newInstallPublicKey = boundedText("newInstallPublicKey", input.newInstallPublicKey, 128);
      publicKeyObject(newInstallPublicKey);
      if (newInstallId === installId && newInstallPublicKey === installPublicKey) {
        throw new Error("rebind target must differ from the current machine binding");
      }
    }
    const licenseChallenges = state.challengesByLicense.get(license.id) ?? [];
    const unexpiredAt = lowerBoundChallenge(licenseChallenges, now, (row) => row.expiresAtMs);
    const outstanding = licenseChallenges.slice(unexpiredAt).filter((c) => !state.consumed.has(c.nonceHash));
    if (outstanding.length >= MAX_OUTSTANDING_CHALLENGES) {
      throw new Error("too many unconsumed challenges for this license; wait for one to expire");
    }
    const recentAt = lowerBoundChallenge(licenseChallenges, now - 60 * 60_000, (row) => row.issuedAtMs);
    const recent = licenseChallenges.length - recentAt;
    if (recent >= MAX_CHALLENGES_PER_LICENSE_PER_HOUR) {
      throw new Error("lease challenge rate limit reached for this license; wait for the one-hour window");
    }
    const nonce = this.nonceBytes(32).toString("base64url");
    if (!exactB64u(nonce, 32)) throw new Error("nonce source did not return 32 bytes");
    if (state.challenges.has(sha256(nonce))) throw new Error("nonce source repeated a prior challenge; issuance was refused");
    const facts: ChallengeFacts = {
      nonceHash: sha256(nonce), purpose, licenseId: license.id, activationId, activationRevision,
      installId, installPublicKey, newInstallId, newInstallPublicKey,
      issuedAtMs: now, expiresAtMs: now + this.challengeTtlMs,
    };
    this.appendEvent({ schemaVersion: 1, eventId: this.randomId(), kind: "challenge_issued", atMs: now, challenge: facts }, state.lastHash);
    return { nonce, ...facts, serverTimeMs: now, proofBytesB64u: challengeProofBytes(facts, nonce).toString("base64url") };
  }

  private consume(
    token: string,
    purpose: LeasePurpose,
    nonce: string,
    signature: string,
    newSignature?: string,
  ): { license: LicensePayload; state: ReplayState; facts: ChallengeFacts; now: number; nonceHash: string; replay: LeaseOperationResult | null } {
    if (!exactB64u(nonce, 32)) throw new Error("nonce must be exactly 32 bytes in canonical base64url");
    if (!exactB64u(signature, SIGNATURE_BYTES)) throw new Error("proof signature must be canonical Ed25519 base64url");
    const state = this.replay();
    let now = this.serverNow(state);
    const allowLapsed = purpose === "deactivate";
    const license = this.authenticate(token, allowLapsed, now);
    const nonceHash = sha256(nonce);
    const replay = state.consumed.get(nonceHash) ?? null;
    const facts = state.challenges.get(nonceHash);
    if (!facts || facts.licenseId !== license.id || facts.purpose !== purpose) {
      throw new Error("challenge was not found for this license and operation");
    }
    if (allowLapsed) now = Math.min(now, facts.issuedAtMs + Math.min(1_000, this.challengeTtlMs - 1));
    const message = challengeProofBytes(facts, nonce);
    if (!edVerify(null, message, publicKeyObject(facts.installPublicKey), Buffer.from(signature, "base64url"))) {
      throw new Error("install proof signature was not accepted");
    }
    if (purpose === "rebind") {
      if (!facts.newInstallPublicKey || !newSignature || !exactB64u(newSignature, SIGNATURE_BYTES)
        || !edVerify(null, message, publicKeyObject(facts.newInstallPublicKey), Buffer.from(newSignature, "base64url"))) {
        throw new Error("the replacement install must also prove possession of its private key");
      }
    }
    if (replay) return { license, state, facts, now, nonceHash, replay };
    if (facts.activationId !== null) {
      const current = this.activationFor(state, license.id, facts.activationId);
      if (current.revision !== facts.activationRevision || current.installId !== facts.installId
        || current.installPublicKey !== facts.installPublicKey) {
        throw new Error("challenge was issued for a stale machine binding revision; request a fresh challenge from the current install");
      }
    }
    if (now >= facts.expiresAtMs) throw new Error("challenge expired before it was consumed");
    return { license, state, facts, now, nonceHash, replay: null };
  }

  private leaseFor(license: LicensePayload, activation: LeaseActivation, now: number): SignedLicenseLease {
    const expiresAtMs = Math.min(license.exp, now + this.leaseDurationMs);
    const features = [...new Set(["beta", ...this.featuresFor(license.id)])]
      .filter((f) => typeof f === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(f))
      .sort();
    const payload: LicenseLeasePayload = {
      v: 1,
      type: LEASE_PAYLOAD_TYPE,
      kid: this.keyStore.activeKeyId,
      licenseId: license.id,
      activationId: activation.id,
      installPublicKey: activation.installPublicKey,
      features,
      issuedAtMs: now,
      notBeforeMs: Math.max(0, now - this.maxClockSkewMs),
      expiresAtMs,
      entitlementExpiresAtMs: license.exp,
      sequence: activation.lastSequence,
      serverTimeMs: now,
      policy: {
        refreshAfterMs: Math.min(expiresAtMs, now + Math.max(60_000, Math.floor(this.leaseDurationMs / 2))),
        cachedGraceUntilMs: Math.min(license.exp, expiresAtMs + this.cachedGraceMs),
        maxClockSkewMs: this.maxClockSkewMs,
        offlineAfterExpiry: "cached_entitlement_until_grace_then_exit_only",
        revocationBehavior: "exit_only",
        exitsAlwaysAllowed: true,
      },
    };
    return this.keyStore.signLease(payload);
  }

  activate(token: string, nonce: string, signature: string): LeaseOperationResult {
    const c = this.consume(token, "activate", nonce, signature);
    if (c.replay) return c.replay;
    const duplicate = [...c.state.activations.values()].find((a) =>
      a.licenseId === c.license.id && a.status === "active" && a.installId === c.facts.installId);
    if (duplicate && duplicate.installPublicKey !== c.facts.installPublicKey) {
      throw new Error("this installId is already bound to another public key; use rebind");
    }
    const active = [...c.state.activations.values()].filter((a) => a.licenseId === c.license.id && a.status === "active");
    if (!duplicate && c.state.adminRecoveryLocked.has(c.license.id)) {
      throw new Error("this license is recovery-locked after an audited admin deactivation; copied LHK1 bearers cannot claim the freed seat. Reissue the license or use dual-key rebind before key loss");
    }
    const maxMachines = c.state.seatOverrides.get(c.license.id) ?? this.defaultMaxMachines;
    if (!duplicate && active.length >= maxMachines) {
      throw new Error(`license machine limit reached (${active.length}/${maxMachines}); deactivate a machine or request an audited admin override`);
    }
    if (!duplicate && active.some((a) => a.installPublicKey === c.facts.installPublicKey)) {
      throw new Error("this install public key is already bound under a different installId");
    }
    const activation: LeaseActivation = duplicate
      ? { ...duplicate, updatedAtMs: c.now, lastSequence: duplicate.lastSequence + 1,
          lastLeaseExpiresAtMs: Math.min(c.license.exp, c.now + this.leaseDurationMs), revision: duplicate.revision + 1 }
      : {
          id: this.randomId(), licenseId: c.license.id, installId: c.facts.installId,
          installPublicKey: c.facts.installPublicKey, status: "active", createdAtMs: c.now, updatedAtMs: c.now,
          lastSequence: 1, lastLeaseExpiresAtMs: Math.min(c.license.exp, c.now + this.leaseDurationMs),
          deactivatedAtMs: null, deactivationReason: null, revision: 1,
        };
    const lease = this.leaseFor(c.license, activation, c.now);
    this.appendEvent({ schemaVersion: 1, eventId: this.randomId(),
      kind: duplicate ? "lease_renewed" : "activation_created", atMs: c.now,
      nonceHash: c.nonceHash, actor: "install", activation, lease }, c.state.lastHash);
    return { replayed: false, activation, lease };
  }

  renew(token: string, nonce: string, signature: string): LeaseOperationResult {
    const c = this.consume(token, "renew", nonce, signature);
    if (c.replay) return c.replay;
    const current = this.activationFor(c.state, c.license.id, c.facts.activationId ?? undefined);
    const activation: LeaseActivation = {
      ...current, updatedAtMs: c.now, lastSequence: current.lastSequence + 1,
      lastLeaseExpiresAtMs: Math.min(c.license.exp, c.now + this.leaseDurationMs), revision: current.revision + 1,
    };
    const lease = this.leaseFor(c.license, activation, c.now);
    this.appendEvent({ schemaVersion: 1, eventId: this.randomId(), kind: "lease_renewed", atMs: c.now,
      nonceHash: c.nonceHash, actor: "install", activation, lease }, c.state.lastHash);
    return { replayed: false, activation, lease };
  }

  deactivate(token: string, nonce: string, signature: string): LeaseOperationResult {
    const c = this.consume(token, "deactivate", nonce, signature);
    if (c.replay) return c.replay;
    const current = this.activationFor(c.state, c.license.id, c.facts.activationId ?? undefined);
    const activation: LeaseActivation = {
      ...current, status: "deactivated", updatedAtMs: c.now, deactivatedAtMs: c.now,
      deactivationReason: "deactivated by the bound install", revision: current.revision + 1,
    };
    this.appendEvent({ schemaVersion: 1, eventId: this.randomId(), kind: "activation_deactivated",
      atMs: c.now, nonceHash: c.nonceHash, actor: "install", reason: activation.deactivationReason!, activation }, c.state.lastHash);
    return { replayed: false, activation, lease: null };
  }

  rebind(token: string, nonce: string, signature: string, newSignature: string): LeaseOperationResult {
    const c = this.consume(token, "rebind", nonce, signature, newSignature);
    if (c.replay) return c.replay;
    const current = this.activationFor(c.state, c.license.id, c.facts.activationId ?? undefined);
    const newInstallId = c.facts.newInstallId!;
    const newInstallPublicKey = c.facts.newInstallPublicKey!;
    const collision = [...c.state.activations.values()].find((a) => a.licenseId === c.license.id
      && a.status === "active" && a.id !== current.id
      && (a.installId === newInstallId || a.installPublicKey === newInstallPublicKey));
    if (collision) throw new Error("replacement install identity is already active on this license");
    const activation: LeaseActivation = {
      ...current, installId: newInstallId, installPublicKey: newInstallPublicKey,
      updatedAtMs: c.now, lastSequence: current.lastSequence + 1,
      lastLeaseExpiresAtMs: Math.min(c.license.exp, c.now + this.leaseDurationMs), revision: current.revision + 1,
    };
    const lease = this.leaseFor(c.license, activation, c.now);
    this.appendEvent({ schemaVersion: 1, eventId: this.randomId(), kind: "activation_rebound", atMs: c.now,
      nonceHash: c.nonceHash, actor: "install", activation, lease }, c.state.lastHash);
    return { replayed: false, activation, lease };
  }

  setSeatOverride(licenseId: string, maxMachines: number | null, reason: string, expectedAuditRevision: number): void {
    const id = boundedText("licenseId", licenseId, 128);
    if (!this.licenses.isKnown(id)) throw new Error("unknown license id");
    if (maxMachines !== null) finiteInt("maxMachines", maxMachines, 1, 64);
    const why = boundedText("reason", reason, 500);
    const state = this.replay();
    if (!Number.isSafeInteger(expectedAuditRevision) || expectedAuditRevision !== state.events.length) {
      throw new Error(`lease audit revision changed; expected ${expectedAuditRevision}, current ${state.events.length}`);
    }
    const effective = maxMachines ?? this.defaultMaxMachines;
    const active = [...state.activations.values()].filter((a) => a.licenseId === id && a.status === "active").length;
    if (active > effective) {
      throw new Error(`cannot lower the machine limit to ${effective} while ${active} activations are active; deactivate the intended machine explicitly first`);
    }
    const now = this.serverNow(state);
    this.appendEvent({ schemaVersion: 1, eventId: this.randomId(), kind: "seat_override_set",
      atMs: now, actor: "admin", licenseId: id, maxMachines, reason: why }, state.lastHash);
  }

  adminDeactivate(licenseId: string, activationId: string, expectedRevision: number, reason: string): LeaseActivation {
    const state = this.replay();
    const current = this.activationFor(state, boundedText("licenseId", licenseId, 128), activationId);
    if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) {
      throw new Error(`activation revision changed; expected ${expectedRevision}, current ${current.revision}`);
    }
    const now = this.serverNow(state);
    const why = boundedText("reason", reason, 500);
    const activation: LeaseActivation = {
      ...current, status: "deactivated", updatedAtMs: now, deactivatedAtMs: now,
      deactivationReason: why, revision: current.revision + 1,
    };
    this.appendEvent({ schemaVersion: 1, eventId: this.randomId(), kind: "activation_deactivated",
      atMs: now, nonceHash: null, actor: "admin", reason: why, activation }, state.lastHash);
    return activation;
  }

  observeRevocation(licenseId: string, reason: string): void {
    const state = this.replay();
    const now = this.serverNow(state);
    this.appendEvent({ schemaVersion: 1, eventId: this.randomId(), kind: "license_revocation_observed",
      atMs: now, actor: "admin", licenseId: boundedText("licenseId", licenseId, 128),
      reason: boundedText("reason", reason, 500) }, state.lastHash);
  }

  adminSnapshot(licenseId?: string): {
    readonly activeKeyId: string;
    readonly publicKeys: LeasePublicKeyring;
    readonly defaultMaxMachines: number;
    readonly auditRevision: number;
    readonly activations: readonly LeaseActivation[];
    readonly seatOverrides: Readonly<Record<string, number>>;
    readonly audit: readonly LeaseAuditEvent[];
    readonly recoveryLockedLicenses: readonly string[];
  } {
    const state = this.replay();
    const activations = [...state.activations.values()]
      .filter((a) => !licenseId || a.licenseId === licenseId)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id));
    const seatOverrides = Object.fromEntries([...state.seatOverrides.entries()]
      .filter(([id]) => !licenseId || id === licenseId));
    const audit = state.events.filter((event) => {
      if (!licenseId) return event.kind !== "challenge_issued";
      if (event.kind === "challenge_issued") return event.challenge.licenseId === licenseId;
      if ("licenseId" in event) return event.licenseId === licenseId;
      if ("activation" in event) return event.activation.licenseId === licenseId;
      return false;
    }).slice(-250);
    return {
      activeKeyId: this.keyStore.activeKeyId, publicKeys: this.keyStore.publicKeyring(),
      defaultMaxMachines: this.defaultMaxMachines, auditRevision: state.events.length,
      activations, seatOverrides, audit,
      recoveryLockedLicenses: [...state.adminRecoveryLocked].filter((id) => !licenseId || id === licenseId).sort(),
    };
  }
}

export function challengeProofBytes(facts: ChallengeFacts, nonce: string): Buffer {
  const proof = {
    v: 1,
    domain: CHALLENGE_DOMAIN,
    purpose: facts.purpose,
    nonce,
    licenseId: facts.licenseId,
    activationId: facts.activationId,
    activationRevision: facts.activationRevision,
    installId: facts.installId,
    installPublicKey: facts.installPublicKey,
    newInstallId: facts.newInstallId,
    newInstallPublicKey: facts.newInstallPublicKey,
    issuedAtMs: facts.issuedAtMs,
    expiresAtMs: facts.expiresAtMs,
  } as const;
  return Buffer.from(JSON.stringify(proof), "utf8");
}
