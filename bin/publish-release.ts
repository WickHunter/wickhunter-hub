#!/usr/bin/env node
// Publish an already-signed customer release without ever loading a signing
// key. The immutable artifact and SHA-addressed manifest land first; only then
// does latest.json move, so a crash can leave extra safe files but cannot point
// customers at a missing or unverified artifact.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_RELEASE_MAX_AGE_MS,
  parseReleasePublicKeys,
  verifyReleaseArtifact,
  verifyReleaseManifest,
} from "../src/release-manifest.js";
import {
  assertProductionPromotionEligible,
  commitReleasePublication,
  recoverPendingReleasePublication,
  readReleaseControlState,
  recordBetaPublication,
  verifyPromotionAttestation,
  writeReleaseControlState,
  type ReleaseChannel,
} from "../src/release-controls.js";

const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    artifact: { type: "string" },
    "releases-dir": { type: "string" },
    channel: { type: "string" },
    "control-state": { type: "string" },
    "beta-releases-dir": { type: "string" },
    "promotion-attestation": { type: "string" },
    "feedback-file": { type: "string" },
    "rollback-releases-dir": { type: "string" },
  },
});

function fail(message: string): never {
  throw new Error(message);
}

if (!values.manifest || !values.artifact || !values["releases-dir"]) {
  console.error("publish release failed: usage: npm run publish-release -- --manifest <signed.json> --artifact <package.tar.gz> --releases-dir <directory>");
  process.exit(1);
}

const publicKeysRaw = process.env.HUB_RELEASE_PUBLIC_KEYS_JSON;
if (!publicKeysRaw) {
  console.error("publish release failed: HUB_RELEASE_PUBLIC_KEYS_JSON is required (public keys only; never place a signing key on the Hub)");
  process.exit(1);
}

let publisherLock: string | null = null;
let ownsPublisherLock = false;

try {
  const channel = (values.channel ?? process.env.HUB_RELEASE_CHANNEL ?? "beta").trim() as ReleaseChannel;
  if (channel !== "beta" && channel !== "production") fail("customer publisher supports only Beta or Production; Alpha is private");
  const manifestBytes = fs.readFileSync(path.resolve(values.manifest));
  const rawManifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  const maxAgeMs = Number(process.env.HUB_RELEASE_MAX_AGE_MS ?? DEFAULT_RELEASE_MAX_AGE_MS);
  const publicKeys = parseReleasePublicKeys(publicKeysRaw);
  const manifest = verifyReleaseManifest(rawManifest, {
    publicKeys,
    now: Date.now(),
    maxAgeMs,
    channel,
    platform: (process.env.HUB_RELEASE_PLATFORM ?? "linux").trim(),
    arch: (process.env.HUB_RELEASE_ARCH ?? "x64").trim(),
  });
  const artifactInput = path.resolve(values.artifact);
  if (path.basename(artifactInput) !== manifest.file) {
    fail(`artifact basename must equal the signed manifest file (${manifest.file})`);
  }
  const artifactBytes = fs.readFileSync(artifactInput);
  verifyReleaseArtifact(manifest, artifactBytes);

  const releasesDir = path.resolve(values["releases-dir"]);
  const now = Date.now();
  let promotionAttestation: ReturnType<typeof verifyPromotionAttestation> | undefined;
  const controlStatePath = values["control-state"] ? path.resolve(values["control-state"]) : path.join(releasesDir, ".release-control.v1.json");
  fs.mkdirSync(path.dirname(controlStatePath), { recursive: true, mode: 0o700 });
  publisherLock = `${controlStatePath}.publish.lock`;
  let lockFd: number;
  try { lockFd = fs.openSync(publisherLock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("another publisher is active or a stale publisher lock needs manual inspection");
    throw error;
  }
  ownsPublisherLock = true;
  fs.writeFileSync(lockFd, `${process.pid}\n`);
  fs.fsyncSync(lockFd);
  fs.closeSync(lockFd);
  const recovered = recoverPendingReleasePublication(controlStatePath, path.join(releasesDir, "latest.json"), publicKeys);
  if (recovered !== "none") console.error(`release publisher recovered pending transaction: ${recovered}`);
  let controlState = readReleaseControlState(controlStatePath);
  if (channel === "production") {
    if (process.env.HUB_RELEASE_AUTO_PROMOTION_ENABLED !== "true") fail("automatic Production promotion is disabled; set HUB_RELEASE_AUTO_PROMOTION_ENABLED=true only for the controlled promotion job");
    if (!values["beta-releases-dir"] || !values["promotion-attestation"] || !values["feedback-file"] || !values["rollback-releases-dir"] || !values["control-state"]) {
      fail("Production requires --beta-releases-dir, --control-state, --promotion-attestation, --feedback-file, and --rollback-releases-dir");
    }
    const betaDir = path.resolve(values["beta-releases-dir"]);
    // A typo or symlink must never publish Production over the Beta head.
    const physical = (value: string): string => fs.existsSync(value)
      ? fs.realpathSync(value)
      : path.join(physical(path.dirname(value)), path.basename(value));
    if (physical(releasesDir) === physical(betaDir)) fail("Beta and Production require separate release shelves");
    const betaRaw: unknown = JSON.parse(fs.readFileSync(path.join(betaDir, "latest.json"), "utf8"));
    const beta = verifyReleaseManifest(betaRaw, { publicKeys, now, maxAgeMs, channel: "beta", platform: manifest.platform, arch: manifest.arch });
    verifyReleaseArtifact(beta, fs.readFileSync(path.join(betaDir, beta.file)));
    const betaArchive = fs.readFileSync(path.join(betaDir, `manifest-${beta.sha256}.json`));
    const archivedRaw: unknown = JSON.parse(betaArchive.toString("utf8"));
    const archived = verifyReleaseManifest(archivedRaw, { publicKeys, now, maxAgeMs, channel: "beta", platform: manifest.platform, arch: manifest.arch });
    if (archived.sha256 !== beta.sha256 || archived.buildId !== beta.buildId || archived.sourceCommit !== beta.sourceCommit || archived.file !== beta.file) {
      fail("Beta latest does not match its SHA-addressed manifest archive");
    }
    controlState = readReleaseControlState(controlStatePath);
    const attestation = JSON.parse(fs.readFileSync(path.resolve(values["promotion-attestation"]), "utf8"));
    const verifiedAttestation = verifyPromotionAttestation(attestation, publicKeys);
    const rollbackDir = path.resolve(values["rollback-releases-dir"]);
    const rollbackRaw: unknown = JSON.parse(fs.readFileSync(path.join(rollbackDir, `manifest-${verifiedAttestation.rollback.targetSha256}.json`), "utf8"));
    const rollbackManifest = verifyReleaseManifest(rollbackRaw, {
      publicKeys, now, maxAgeMs: Number.MAX_SAFE_INTEGER, channel: "production", platform: manifest.platform, arch: manifest.arch,
    });
    if (rollbackManifest.buildId !== verifiedAttestation.rollback.targetBuildId || rollbackManifest.sha256 !== verifiedAttestation.rollback.targetSha256) {
      fail("certified rollback target does not match an archived signed Production manifest");
    }
    verifyReleaseArtifact(rollbackManifest, fs.readFileSync(path.join(rollbackDir, rollbackManifest.file)));
    const rollbackArchive = fs.readFileSync(path.join(rollbackDir, rollbackManifest.file));
    if (rollbackArchive.length === 0) fail("certified rollback artifact is empty");
    promotionAttestation = assertProductionPromotionEligible({
      publicKeys, now, autoPromotionEnabled: true, state: controlState, beta, production: manifest,
      attestation, feedbackFile: path.resolve(values["feedback-file"]),
    });
  }
  fs.mkdirSync(releasesDir, { recursive: true, mode: 0o755 });
  const artifactTarget = path.join(releasesDir, manifest.file);
  const archivedManifestTarget = path.join(releasesDir, `manifest-${manifest.sha256}.json`);
  const latestTarget = path.join(releasesDir, "latest.json");

  installImmutable(artifactTarget, artifactBytes, "artifact");
  installImmutable(archivedManifestTarget, manifestBytes, "archived manifest");
  if (channel === "production" && promotionAttestation) {
    const attestationBytes = fs.readFileSync(path.resolve(values["promotion-attestation"]!));
    installImmutable(path.join(releasesDir, `promotion-${promotionAttestation.betaSha256}.json`), attestationBytes, "promotion attestation");
  }

  const publishedAt = new Date().toISOString();
  const nextControlState = channel === "beta"
    ? recordBetaPublication(controlState, manifest, Date.parse(publishedAt))
    : { ...controlState, production: { buildId: manifest.buildId, file: manifest.file, publishedAt, sha256: manifest.sha256, version: manifest.version } };
  let published = manifest;
  commitReleasePublication({
    latestFile: latestTarget,
    latestBytes: manifestBytes,
    controlStateFile: controlStatePath,
    nextControlState,
  }, {
    replaceLatest(file, bytes) {
      replaceAtomic(file, bytes);
      // Verify the exact shelf bytes after the rename. Any refusal here causes
      // commitReleasePublication to restore the former pointer and state.
      const publishedManifestBytes = fs.readFileSync(file);
      published = verifyReleaseManifest(JSON.parse(publishedManifestBytes.toString("utf8")), {
        publicKeys: parseReleasePublicKeys(publicKeysRaw),
        now: Date.now(), maxAgeMs, channel: manifest.channel,
        platform: manifest.platform, arch: manifest.arch,
      });
      verifyReleaseArtifact(published, fs.readFileSync(artifactTarget));
      if (!publishedManifestBytes.equals(fs.readFileSync(archivedManifestTarget))) {
        throw new Error("latest.json does not exactly match its immutable archived manifest");
      }
    },
  });
  console.log(`Published authenticated release ${published.version} (${published.buildId}) sha256=${published.sha256}`);
} catch (error) {
  console.error(`publish release failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  if (ownsPublisherLock && publisherLock) {
    try {
      fs.unlinkSync(publisherLock);
      const dirFd = fs.openSync(path.dirname(publisherLock), "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error) {
      console.error(`publish release cleanup failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

function installImmutable(target: string, bytes: Buffer, label: string): void {
  try {
    const existing = fs.readFileSync(target);
    if (!existing.equals(bytes)) fail(`${label} already exists with different bytes: ${target}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  replaceAtomic(target, bytes, true);
}

function replaceAtomic(target: string, bytes: Buffer, noReplace = false): void {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o644);
    fs.fchmodSync(fd, 0o644);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (noReplace) {
      try {
        // Linking the fully written temp file is an atomic create-if-absent
        // on the destination filesystem. Unlike a check followed by rename,
        // this cannot overwrite an immutable object that appeared in a race.
        fs.linkSync(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = fs.readFileSync(target);
        if (!existing.equals(bytes)) fail(`immutable destination appeared with different bytes: ${target}`);
      }
      fs.unlinkSync(temp);
    } else {
      fs.renameSync(temp, target);
    }
    const dirFd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
