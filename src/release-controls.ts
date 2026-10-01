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
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(state) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return state;
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
