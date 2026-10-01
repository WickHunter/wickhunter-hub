import fs from "node:fs";
import path from "node:path";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { canonicalBytes } from "./marketcap/jcs.js";
import {
  RELEASE_ALG,
  RELEASE_PRODUCT,
  verifyReleaseArtifact,
  verifyReleaseManifest,
  type ReleaseSignature,
  type SignedReleaseManifest,
} from "./release-manifest.js";

export const RELEASE_CHANNELS = ["alpha", "beta", "production"] as const;
export type ReleaseChannel = typeof RELEASE_CHANNELS[number];
export const PROMOTION_ATTESTATION_SCHEMA = "wickhunter.production-promotion.v1";
export const DEFAULT_PRODUCTION_SOAK_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_PROMOTION_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1_000;
export const RELEASE_CONTROL_SCHEMA = "wickhunter.release-control.v1";

export interface ReleaseHead {
  buildId: string;
  file: string;
  publishedAt: string;
  sha256: string;
  version: string;
}
export interface ReleaseControlState {
  schema: typeof RELEASE_CONTROL_SCHEMA;
  beta: ReleaseHead | null;
  production: ReleaseHead | null;
  productionHold: { reason: string; setAt: string } | null;
}
export interface PromotionAttestation {
  schema: typeof PROMOTION_ATTESTATION_SCHEMA;
  betaBuildId: string;
  betaSha256: string;
  sourceCommit: string;
  tests: { passed: boolean; commit: string; completedAt: string; runId: string };
  health: { passed: boolean; checkedAt: string; probeId: string };
  bugs: { unresolved: number; checkedAt: string; reportSet: string };
  rollback: {
    fromBuildId: string;
    fromSha256: string;
    targetBuildId: string;
    targetSha256: string;
    stateCompatible: boolean;
    settingsVersion: number;
    restartHealthProtocol: string;
    nativeCoreProtocol: string;
    coreSha256: string;
    certifiedAt: string;
    expiresAt: string;
  };
  signatures: ReleaseSignature[];
}

export interface PromotionPolicy {
  publicKeys: Record<string, string>;
  now: number;
  soakMs?: number;
  evidenceMaxAgeMs?: number;
  autoPromotionEnabled: boolean;
  state: ReleaseControlState;
  beta: SignedReleaseManifest;
  production: SignedReleaseManifest;
  attestation: unknown;
  feedbackFile: string;
}

export interface PromotionEvaluation {
  eligible: boolean;
  reasons: string[];
  betaAgeMs: number | null;
  unresolvedHubBugs: number | null;
}

export class ReleaseControlError extends Error {
  constructor(message: string) { super(message); this.name = "ReleaseControlError"; }
}

export function defaultReleaseControlState(): ReleaseControlState {
  return { schema: RELEASE_CONTROL_SCHEMA, beta: null, production: null, productionHold: null };
}

/** Old/unset license state stays on Production. Alpha is deliberately not a
 * customer channel. Beta is selected only after both opt-in and Hub eligibility. */
export function customerChannel(input: { earlyAccessOptIn?: unknown; betaEligible?: unknown }): "beta" | "production" {
  return input.earlyAccessOptIn === true && input.betaEligible === true ? "beta" : "production";
}

export function releaseShelf(baseDir: string, channel: ReleaseChannel): string {
  if (channel === "alpha") throw new ReleaseControlError("Alpha is private and is not a customer release shelf");
  return path.join(path.resolve(baseDir), channel);
}

export function readReleaseControlState(file: string): ReleaseControlState {
  let raw: unknown;
  try {
    if (fs.statSync(file).size > 64 * 1024) throw new ReleaseControlError("release control state exceeds its size bound");
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultReleaseControlState();
    if (error instanceof ReleaseControlError) throw error;
    throw new ReleaseControlError("release control state is unreadable or invalid");
  }
  return validateReleaseControlState(raw);
}

export function validateReleaseControlState(raw: unknown): ReleaseControlState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ReleaseControlError("release control state is not an object");
  const value = raw as Partial<ReleaseControlState>;
  if (value.schema !== RELEASE_CONTROL_SCHEMA) throw new ReleaseControlError("unsupported release control state schema");
  const beta = validateHead(value.beta, "beta");
  const production = validateHead(value.production, "production");
  let productionHold: ReleaseControlState["productionHold"] = null;
  if (value.productionHold !== null) {
    const hold = value.productionHold as { reason?: unknown; setAt?: unknown } | undefined;
    if (!hold || typeof hold.reason !== "string" || !hold.reason.trim() || typeof hold.setAt !== "string" || !Number.isFinite(Date.parse(hold.setAt))) {
      throw new ReleaseControlError("release production hold is invalid");
    }
    productionHold = { reason: hold.reason.trim().slice(0, 500), setAt: new Date(hold.setAt).toISOString() };
  }
  return { schema: RELEASE_CONTROL_SCHEMA, beta, production, productionHold };
}

export function writeReleaseControlState(file: string, raw: unknown): ReleaseControlState {
  const state = validateReleaseControlState(raw);
  atomicWrite(file, Buffer.from(JSON.stringify(state) + "\n"), 0o600);
  return state;
}

export interface ReleasePublicationTransaction {
  latestFile: string;
  latestBytes: Buffer;
  controlStateFile: string;
  nextControlState: ReleaseControlState;
}

const PENDING_PUBLICATION_SCHEMA = "wickhunter.release-publication-pending.v1";
interface FileSnapshot { base64: string; mode: number }
interface PendingPublication {
  schema: typeof PENDING_PUBLICATION_SCHEMA;
  latestFile: string;
  priorLatest: FileSnapshot | null;
  priorControl: FileSnapshot | null;
  targetLatest: FileSnapshot;
  targetControl: FileSnapshot;
}

/** Persist a recoverable intent, write control state first, then move latest
 * last. A crash before latest leaves customers on the old release; the next
 * publisher deterministically restores the prior control state. A crash after
 * latest leaves a fully signed target and matching control head; recovery
 * verifies both before clearing the intent. */
export function commitReleasePublication(
  transaction: ReleasePublicationTransaction,
  io: {
    replaceLatest?: (file: string, bytes: Buffer) => void;
    writeControlState?: (file: string, state: ReleaseControlState) => void;
    verifyLatest?: (file: string) => void;
  } = {},
): void {
  const latestFile = path.resolve(transaction.latestFile);
  const stateFile = path.resolve(transaction.controlStateFile);
  if (latestFile === stateFile) throw new ReleaseControlError("release pointer and control state must use separate files");
  const pendingFile = `${stateFile}.pending.v1.json`;
  if (fs.existsSync(pendingFile)) throw new ReleaseControlError("an unresolved release publication marker needs recovery first");
  const beforeLatest = snapshotFile(latestFile);
  const beforeState = snapshotFile(stateFile);
  const replaceLatest = io.replaceLatest ?? ((file, bytes) => atomicWrite(file, bytes, 0o644));
  const writeState = io.writeControlState ?? writeReleaseControlState;
  const verifyLatest = io.verifyLatest ?? (() => {});
  const nextState = validateReleaseControlState(transaction.nextControlState);
  const targetControlBytes = Buffer.from(JSON.stringify(nextState) + "\n");
  const marker: PendingPublication = {
    schema: PENDING_PUBLICATION_SCHEMA,
    latestFile,
    priorLatest: beforeLatest && snapshotToMarker(beforeLatest),
    priorControl: beforeState && snapshotToMarker(beforeState),
    targetLatest: { base64: transaction.latestBytes.toString("base64"), mode: 0o644 },
    targetControl: { base64: targetControlBytes.toString("base64"), mode: 0o600 },
  };
  atomicWrite(pendingFile, Buffer.from(JSON.stringify(marker) + "\n"), 0o600, true);
  try {
    writeState(stateFile, nextState);
    replaceLatest(latestFile, transaction.latestBytes);
    verifyLatest(latestFile);
    removeFile(pendingFile);
  } catch (error) {
    const restoreErrors: unknown[] = [];
    try { restoreSnapshot(latestFile, beforeLatest); } catch (restoreError) { restoreErrors.push(restoreError); }
    try { restoreSnapshot(stateFile, beforeState); } catch (restoreError) { restoreErrors.push(restoreError); }
    if (!restoreErrors.length) {
      try { removeFile(pendingFile); } catch (restoreError) { restoreErrors.push(restoreError); }
    }
    if (restoreErrors.length) {
      throw new AggregateError([error, ...restoreErrors], "release publication failed; pending marker retained because rollback/recovery is incomplete");
    }
    throw error;
  }
}

/** Resolve a stale marker only when the live files are exactly in a known
 * transaction state. Unknown mixtures fail closed for operator recovery. */
export function recoverPendingReleasePublication(controlStateFile: string, latestFile: string, publicKeys: Record<string, string>): "none" | "completed" | "rolled-back" {
  const stateFile = path.resolve(controlStateFile);
  const pointerFile = path.resolve(latestFile);
  const pendingFile = `${stateFile}.pending.v1.json`;
  let raw: unknown;
  try {
    const bytes = fs.readFileSync(pendingFile);
    if (bytes.length > 2 * 1024 * 1024) throw new ReleaseControlError("pending release publication marker exceeds its size bound");
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    if (error instanceof ReleaseControlError) throw error;
    throw new ReleaseControlError("pending release publication marker is unreadable");
  }
  const marker = validatePendingPublication(raw, pointerFile);
  const liveLatest = snapshotFile(pointerFile);
  const liveControl = snapshotFile(stateFile);
  const priorLatest = markerToSnapshot(marker.priorLatest);
  const priorControl = markerToSnapshot(marker.priorControl);
  const targetLatest = markerToSnapshot(marker.targetLatest)!;
  const targetControl = markerToSnapshot(marker.targetControl)!;
  if (sameSnapshot(liveLatest, targetLatest) && sameSnapshot(liveControl, targetControl)) {
    verifyPublishedTarget(pointerFile, marker.targetLatest, marker.targetControl, publicKeys);
    removeFile(pendingFile);
    return "completed";
  }
  if (sameSnapshot(liveLatest, priorLatest)
      && (sameSnapshot(liveControl, priorControl) || sameSnapshot(liveControl, targetControl))) {
    if (!sameSnapshot(liveControl, priorControl)) restoreSnapshot(stateFile, priorControl);
    removeFile(pendingFile);
    return "rolled-back";
  }
  throw new ReleaseControlError("pending release publication has an unknown pointer/control combination; refusing automatic recovery");
}

function validatePendingPublication(raw: unknown, expectedLatest: string): PendingPublication {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ReleaseControlError("pending release publication marker is invalid");
  const value = raw as Partial<PendingPublication>;
  if (value.schema !== PENDING_PUBLICATION_SCHEMA || value.latestFile !== expectedLatest) {
    throw new ReleaseControlError("pending release publication marker does not match this shelf");
  }
  const check = (snapshot: unknown, nullable: boolean): snapshot is FileSnapshot | null => {
    if (nullable && snapshot === null) return true;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
    const candidate = snapshot as FileSnapshot;
    if (typeof candidate.base64 !== "string" || !Number.isInteger(candidate.mode) || candidate.mode < 0 || candidate.mode > 0o777) return false;
    const bytes = Buffer.from(candidate.base64, "base64");
    return bytes.toString("base64") === candidate.base64;
  };
  if (!check(value.priorLatest, true) || !check(value.priorControl, true)
      || !check(value.targetLatest, false) || !check(value.targetControl, false)) {
    throw new ReleaseControlError("pending release publication marker has invalid snapshots");
  }
  validateReleaseControlState(JSON.parse(Buffer.from(value.targetControl!.base64, "base64").toString("utf8")));
  if (value.priorControl) validateReleaseControlState(JSON.parse(Buffer.from(value.priorControl.base64, "base64").toString("utf8")));
  return value as PendingPublication;
}

function verifyPublishedTarget(file: string, snapshot: FileSnapshot, controlSnapshot: FileSnapshot, publicKeys: Record<string, string>): void {
  const bytes = Buffer.from(snapshot.base64, "base64");
  const raw = JSON.parse(bytes.toString("utf8")) as SignedReleaseManifest;
  const manifest = verifyReleaseManifest(raw, {
    publicKeys, now: Date.now(), maxAgeMs: Number.MAX_SAFE_INTEGER,
    channel: raw.channel, platform: raw.platform, arch: raw.arch,
  });
  const targetState = validateReleaseControlState(JSON.parse(Buffer.from(controlSnapshot.base64, "base64").toString("utf8")));
  const head = manifest.channel === "beta" ? targetState.beta : manifest.channel === "production" ? targetState.production : null;
  if (!head || head.buildId !== manifest.buildId || head.sha256 !== manifest.sha256 || head.version !== manifest.version || head.file !== manifest.file) {
    throw new ReleaseControlError("pending publication target does not match its control head");
  }
  const artifact = fs.readFileSync(path.join(path.dirname(file), manifest.file));
  verifyReleaseArtifact(manifest, artifact);
}

function snapshotToMarker(snapshot: { bytes: Buffer; mode: number }): FileSnapshot {
  return { base64: snapshot.bytes.toString("base64"), mode: snapshot.mode };
}
function markerToSnapshot(snapshot: FileSnapshot | null): { bytes: Buffer; mode: number } | null {
  return snapshot === null ? null : { bytes: Buffer.from(snapshot.base64, "base64"), mode: snapshot.mode };
}
function snapshotFile(file: string): { bytes: Buffer; mode: number } | null {
  try {
    const stat = fs.statSync(file);
    return { bytes: fs.readFileSync(file), mode: stat.mode & 0o777 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function sameSnapshot(left: { bytes: Buffer; mode: number } | null, right: { bytes: Buffer; mode: number } | null): boolean {
  return left === null ? right === null : right !== null && left.mode === right.mode && left.bytes.equals(right.bytes);
}

function atomicWrite(file: string, bytes: Buffer, mode: number, noReplace = false): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", mode);
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (noReplace) fs.linkSync(temp, file);
    else fs.renameSync(temp, file);
    syncDirectory(dir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function restoreSnapshot(file: string, snapshot: { bytes: Buffer; mode: number } | null): void {
  if (snapshot === null) {
    try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    syncDirectory(path.dirname(file));
  } else {
    atomicWrite(file, snapshot.bytes, snapshot.mode);
  }
}

function removeFile(file: string): void {
  fs.unlinkSync(file);
  syncDirectory(path.dirname(file));
}

/** Called only after the Beta latest pointer has been verified and advanced by
 * the manual publisher. Identical archive bytes keep the original soak start;
 * any new archive identity restarts the seven-day window. */
export function recordBetaPublication(state: ReleaseControlState, manifest: SignedReleaseManifest, now: number): ReleaseControlState {
  if (manifest.channel !== "beta") throw new ReleaseControlError("only Beta releases can update the Beta head");
  if (!Number.isFinite(now)) throw new ReleaseControlError("Beta publication time is invalid");
  const prior = state.beta;
  const unchanged = prior?.sha256 === manifest.sha256 && prior.buildId === manifest.buildId;
  return {
    ...state,
    beta: {
      buildId: manifest.buildId,
      file: manifest.file,
      publishedAt: unchanged ? prior.publishedAt : new Date(now).toISOString(),
      sha256: manifest.sha256,
      version: manifest.version,
    },
  };
}

export function setProductionHold(state: ReleaseControlState, hold: boolean, reason: string, now: number): ReleaseControlState {
  if (hold && !reason.trim()) throw new ReleaseControlError("a production hold needs a reason");
  return {
    ...state,
    productionHold: hold ? { reason: reason.trim().slice(0, 500), setAt: new Date(now).toISOString() } : null,
  };
}

export function promotionSigningBytes(attestation: PromotionAttestation): Buffer {
  const unsigned: Record<string, unknown> = { ...attestation };
  delete unsigned.signatures;
  return canonicalBytes(unsigned);
}

export function evaluateProductionPromotion(policy: PromotionPolicy): PromotionEvaluation {
  const reasons: string[] = [];
  const soakMs = policy.soakMs ?? DEFAULT_PRODUCTION_SOAK_MS;
  const evidenceMaxAgeMs = policy.evidenceMaxAgeMs ?? DEFAULT_PROMOTION_EVIDENCE_MAX_AGE_MS;
  const state = validateReleaseControlState(policy.state);
  const betaAgeMs = state.beta ? policy.now - Date.parse(state.beta.publishedAt) : null;
  let unresolvedHubBugs: number | null = null;

  if (!policy.autoPromotionEnabled) reasons.push("automatic Production promotion is disabled");
  if (state.productionHold) reasons.push(`Production is on hold: ${state.productionHold.reason}`);
  if (!state.beta) reasons.push("there is no Hub-recorded Beta head");
  if (!state.beta || state.beta.buildId !== policy.beta.buildId || state.beta.sha256 !== policy.beta.sha256) {
    reasons.push("the supplied Beta manifest is not the current Hub-recorded Beta artifact");
  }
  if (policy.beta.channel !== "beta") reasons.push("candidate manifest is not signed for Beta");
  if (policy.production.channel !== "production") reasons.push("target manifest is not signed for Production");
  if (policy.beta.product !== RELEASE_PRODUCT || policy.production.product !== RELEASE_PRODUCT) reasons.push("release product does not match Wick Hunter");
  if (policy.beta.version !== policy.production.version
      || policy.beta.minUpdateProtocol !== policy.production.minUpdateProtocol) {
    reasons.push("Production version and minimum update protocol must match the exact Beta build");
  }
  if (policy.beta.buildId !== policy.production.buildId || policy.beta.sha256 !== policy.production.sha256) {
    reasons.push("Production archive bytes and build identity must exactly match the Beta candidate");
  }
  if (policy.beta.sourceCommit !== policy.production.sourceCommit || typeof policy.beta.sourceCommit !== "string"
      || !/^[0-9a-f]{40}$/.test(policy.beta.sourceCommit)) {
    reasons.push("both signed manifests must identify the same full source commit");
  }
  if (betaAgeMs === null || betaAgeMs < soakMs) reasons.push("the exact Beta archive has not remained unchanged for seven consecutive days");
  if (betaAgeMs !== null && betaAgeMs < 0) reasons.push("Hub Beta publication time is in the future");

  let attestation: PromotionAttestation | null = null;
  try {
    attestation = verifyPromotionAttestation(policy.attestation, policy.publicKeys);
    if (attestation.betaBuildId !== policy.beta.buildId || attestation.betaSha256 !== policy.beta.sha256) reasons.push("promotion evidence is for a different Beta build or archive");
    if (attestation.sourceCommit !== policy.beta.sourceCommit) reasons.push("promotion evidence source commit differs from the signed release");
    if (attestation.tests.passed !== true || attestation.tests.commit !== policy.beta.sourceCommit || !attestation.tests.runId.trim()) reasons.push("matching passing test evidence is missing");
    const testAt = Date.parse(attestation.tests.completedAt);
    if (!Number.isFinite(testAt) || testAt > policy.now || (state.beta && testAt > Date.parse(state.beta.publishedAt) + 5 * 60_000)) reasons.push("test evidence time is invalid or later than Beta publication");
    if (attestation.health.passed !== true || !attestation.health.probeId.trim() || !fresh(attestation.health.checkedAt, policy.now, evidenceMaxAgeMs)) reasons.push("fresh passing health evidence is missing");
    if (attestation.bugs.unresolved !== 0 || !attestation.bugs.reportSet.trim() || !fresh(attestation.bugs.checkedAt, policy.now, evidenceMaxAgeMs)) reasons.push("fresh zero-unresolved-bug evidence is missing");
    if (attestation.rollback.fromBuildId !== policy.beta.buildId || attestation.rollback.fromSha256 !== policy.beta.sha256
        || attestation.rollback.stateCompatible !== true || attestation.rollback.settingsVersion !== 8
        || !attestation.rollback.restartHealthProtocol.trim() || !attestation.rollback.nativeCoreProtocol.trim()
        || !/^[0-9a-f]{64}$/.test(attestation.rollback.coreSha256)
        || !/^[0-9a-f]{64}$/.test(attestation.rollback.targetSha256)
        || attestation.rollback.targetBuildId === policy.beta.buildId
        || !fresh(attestation.rollback.certifiedAt, policy.now, 30 * 24 * 60 * 60_000)
        || !Number.isFinite(Date.parse(attestation.rollback.expiresAt)) || Date.parse(attestation.rollback.expiresAt) <= policy.now) {
      reasons.push("an exact, unexpired, state-compatible signed rollback certification is missing");
    }
  } catch {
    reasons.push("valid release-key-signed Production promotion evidence is missing");
  }

  try {
    unresolvedHubBugs = countUnresolvedHubBugs(policy.feedbackFile, policy.beta.version);
    if (unresolvedHubBugs !== 0) reasons.push(`${unresolvedHubBugs} unresolved Hub bug report(s) are associated with this build`);
  } catch {
    reasons.push("Hub bug report state is unreadable; unresolved bugs cannot be ruled out");
  }

  return { eligible: reasons.length === 0, reasons, betaAgeMs, unresolvedHubBugs };
}

export function assertProductionPromotionEligible(policy: PromotionPolicy): PromotionAttestation {
  const result = evaluateProductionPromotion(policy);
  if (!result.eligible) throw new ReleaseControlError(`Production promotion blocked: ${result.reasons.join("; ")}`);
  return verifyPromotionAttestation(policy.attestation, policy.publicKeys);
}

export function verifyPromotionAttestation(raw: unknown, publicKeys: Record<string, string>): PromotionAttestation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ReleaseControlError("promotion attestation is not an object");
  const value = raw as PromotionAttestation;
  if (value.schema !== PROMOTION_ATTESTATION_SCHEMA) throw new ReleaseControlError("unsupported promotion attestation schema");
  const strings = [value.betaBuildId, value.betaSha256, value.sourceCommit, value.tests?.commit, value.tests?.completedAt, value.tests?.runId,
    value.health?.checkedAt, value.health?.probeId, value.bugs?.checkedAt, value.bugs?.reportSet,
    value.rollback?.fromBuildId, value.rollback?.fromSha256, value.rollback?.targetBuildId, value.rollback?.targetSha256,
    value.rollback?.restartHealthProtocol, value.rollback?.nativeCoreProtocol, value.rollback?.coreSha256,
    value.rollback?.certifiedAt, value.rollback?.expiresAt];
  if (strings.some((field) => typeof field !== "string" || !field.trim())) throw new ReleaseControlError("promotion attestation is incomplete");
  if (!/^[0-9a-f]{64}$/.test(value.betaSha256) || !/^[0-9a-f]{40}$/.test(value.sourceCommit)
      || !/^[0-9a-f]{64}$/.test(value.rollback.fromSha256) || !/^[0-9a-f]{64}$/.test(value.rollback.targetSha256)
      || !/^[0-9a-f]{64}$/.test(value.rollback.coreSha256)) throw new ReleaseControlError("promotion attestation contains malformed digests");
  if (!Number.isSafeInteger(value.bugs.unresolved) || value.bugs.unresolved < 0 || !Number.isSafeInteger(value.rollback.settingsVersion)) {
    throw new ReleaseControlError("promotion attestation counts or settings version are invalid");
  }
  if (!Array.isArray(value.signatures) || !value.signatures.length) throw new ReleaseControlError("promotion attestation has no signatures");
  const bytes = promotionSigningBytes(value);
  for (const signature of value.signatures) {
    if (!signature || signature.alg !== RELEASE_ALG || typeof signature.kid !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(signature.kid)
        || typeof signature.sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature.sig)) continue;
    const keyRaw = publicKeys[signature.kid];
    if (!keyRaw || !/^[A-Za-z0-9_-]{43}$/.test(keyRaw)) continue;
    try {
      const keyBytes = Buffer.from(keyRaw, "base64url");
      const sig = Buffer.from(signature.sig, "base64url");
      if (keyBytes.length !== 32 || keyBytes.toString("base64url") !== keyRaw
          || sig.length !== 64 || sig.toString("base64url") !== signature.sig) continue;
      const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), keyBytes]), format: "der", type: "spki" });
      if (edVerify(null, bytes, key, sig)) return value;
    } catch { /* another trusted rotation signature may still verify */ }
  }
  throw new ReleaseControlError("promotion attestation is not signed by a trusted release key");
}

/** Reads the Hub's own feedback ledger. A missing ledger means no report has
 * been filed; malformed/oversized ledgers fail closed instead of assuming 0. */
export function countUnresolvedHubBugs(file: string, version: string): number {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  if (bytes.length > 32 * 1024 * 1024) throw new ReleaseControlError("feedback ledger exceeds its size bound");
  let count = 0;
  for (const [index, line] of bytes.toString("utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { throw new ReleaseControlError(`feedback ledger has malformed row ${index + 1}`); }
    if (record.kind === "bug" && record.version === version && record.status !== "fixed") count++;
  }
  return count;
}

function validateHead(value: unknown, label: string): ReleaseHead | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReleaseControlError(`release control ${label} head is invalid`);
  const head = value as ReleaseHead;
  if (typeof head.buildId !== "string" || !head.buildId || typeof head.file !== "string" || !head.file
      || typeof head.version !== "string" || !/^\d+\.\d+\.\d+$/.test(head.version)
      || !/^[0-9a-f]{64}$/.test(head.sha256) || !Number.isFinite(Date.parse(head.publishedAt))) {
    throw new ReleaseControlError(`release control ${label} head is incomplete`);
  }
  return { buildId: head.buildId, file: head.file, publishedAt: new Date(head.publishedAt).toISOString(), sha256: head.sha256, version: head.version };
}
function fresh(value: string, now: number, maxAge: number): boolean {
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now && now - at <= maxAge;
}
