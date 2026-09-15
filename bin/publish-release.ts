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

const { values } = parseArgs({
  options: {
    manifest: { type: "string" },
    artifact: { type: "string" },
    "releases-dir": { type: "string" },
  },
});

function fail(message: string): never {
  console.error(`publish release failed: ${message}`);
  process.exit(1);
}

if (!values.manifest || !values.artifact || !values["releases-dir"]) {
  fail("usage: npm run publish-release -- --manifest <signed.json> --artifact <package.tar.gz> --releases-dir <directory>");
}

const publicKeysRaw = process.env.HUB_RELEASE_PUBLIC_KEYS_JSON;
if (!publicKeysRaw) fail("HUB_RELEASE_PUBLIC_KEYS_JSON is required (public keys only; never place a signing key on the Hub)");

try {
  const manifestBytes = fs.readFileSync(path.resolve(values.manifest));
  const rawManifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  const maxAgeMs = Number(process.env.HUB_RELEASE_MAX_AGE_MS ?? DEFAULT_RELEASE_MAX_AGE_MS);
  const manifest = verifyReleaseManifest(rawManifest, {
    publicKeys: parseReleasePublicKeys(publicKeysRaw),
    now: Date.now(),
    maxAgeMs,
    channel: (process.env.HUB_RELEASE_CHANNEL ?? "beta").trim(),
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
  fs.mkdirSync(releasesDir, { recursive: true, mode: 0o755 });
  const artifactTarget = path.join(releasesDir, manifest.file);
  const archivedManifestTarget = path.join(releasesDir, `manifest-${manifest.sha256}.json`);
  const latestTarget = path.join(releasesDir, "latest.json");

  installImmutable(artifactTarget, artifactBytes, "artifact");
  installImmutable(archivedManifestTarget, manifestBytes, "archived manifest");
  replaceAtomic(latestTarget, manifestBytes);

  // Verify the exact shelf bytes after all renames. This also catches a
  // surprising filesystem/operator race before reporting success.
  const publishedManifestBytes = fs.readFileSync(latestTarget);
  const published = verifyReleaseManifest(JSON.parse(publishedManifestBytes.toString("utf8")), {
    publicKeys: parseReleasePublicKeys(publicKeysRaw),
    now: Date.now(),
    maxAgeMs,
    channel: manifest.channel,
    platform: manifest.platform,
    arch: manifest.arch,
  });
  const publishedArtifact = fs.readFileSync(artifactTarget);
  verifyReleaseArtifact(published, publishedArtifact);
  if (!publishedManifestBytes.equals(fs.readFileSync(archivedManifestTarget))) {
    fail("latest.json does not exactly match its immutable archived manifest");
  }
  console.log(`Published authenticated release ${published.version} (${published.buildId}) sha256=${published.sha256}`);
} catch (error) {
  fail((error as Error).message);
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
