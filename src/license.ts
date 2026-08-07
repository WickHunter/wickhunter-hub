// src/license.ts
// License format v1 — PINNED. The bot is built against exactly this; any change
// needs a new "LHK2" prefix, never a mutation of v1.
//
//   token   = LHK1.<base64url(payload-json)>.<base64url(sig)>
//   payload = {"v":1,"id":"<uuid>","name":"<tester name>","exp":<unix-ms>,"iat":<unix-ms>,"plan":"beta"}
//   sig     = Ed25519 over the EXACT payload bytes carried in the token.
//
// Verification signs over the transmitted bytes (never a re-serialisation), so
// the hub and the bot can disagree about JSON formatting without breaking.
// The private key lives ONLY at data/license-signing.key (chmod 600, written by
// `npm run keygen`); the paired public key is what gets baked into the bot.
// This module must never log or return the private key material.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./jsonfile.js";

export const TOKEN_PREFIX = "LHK1";
export const SIGNING_KEY_FILE = "license-signing.key";

export interface LicensePayload {
  v: 1;
  id: string;
  name: string;
  exp: number; // unix-ms
  iat: number; // unix-ms
  plan: string; // "beta" for everything this hub issues
}

export interface LicenseRecord extends LicensePayload {
  revoked: boolean;
  revokedAt?: string; // ISO, present iff revoked
}

export type VerifyResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: "format" | "signature" | "payload" | "expired" | "revoked" };

interface RevokedFile {
  // id -> ISO timestamp of revocation. A map (not an array) so re-revoking is
  // naturally idempotent and lookup is O(1).
  revoked: Record<string, string>;
}

export interface GeneratedKeys {
  privatePem: string; // PKCS8 — file contents for data/license-signing.key
  publicPem: string; // SPKI — for baking into the bot
  publicRawB64u: string; // the 32 raw key bytes, base64url — for compact embedding
}

export function generateSigningKey(): GeneratedKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    // An Ed25519 SPKI is a fixed 12-byte algorithm header + the 32 key bytes.
    publicRawB64u: Buffer.from(spki.subarray(spki.length - 32)).toString("base64url"),
  };
}

/** Everything durable about licensing, rooted at one data directory:
 *  the signing key, the issued-license registry, and revocations. */
export class LicenseStore {
  readonly keyFile: string;
  private readonly licensesFile: string;
  private readonly revokedFile: string;
  private privateKey: KeyObject | null = null;
  private publicKey: KeyObject | null = null;

  constructor(readonly dataDir: string) {
    this.keyFile = path.join(dataDir, SIGNING_KEY_FILE);
    this.licensesFile = path.join(dataDir, "licenses.json");
    this.revokedFile = path.join(dataDir, "revoked.json");
  }

  hasKey(): boolean {
    return fs.existsSync(this.keyFile);
  }

  /** Write a freshly generated private key. Refuses to overwrite — losing the
   *  key orphans every token baked against its public half, so replacing it is
   *  a deliberate operator action (delete the file first), not a code path. */
  writeKey(privatePem: string): void {
    if (this.hasKey()) throw new Error(`refusing to overwrite existing ${this.keyFile}`);
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.keyFile, privatePem, { mode: 0o600 });
  }

  private loadKeys(): { priv: KeyObject; pub: KeyObject } {
    if (!this.privateKey || !this.publicKey) {
      if (!this.hasKey()) {
        throw new Error(`no signing key at ${this.keyFile} — run \`npm run keygen\` first`);
      }
      this.privateKey = createPrivateKey(fs.readFileSync(this.keyFile, "utf8"));
      this.publicKey = createPublicKey(this.privateKey);
    }
    return { priv: this.privateKey, pub: this.publicKey };
  }

  publicKeyPem(): string {
    return this.loadKeys().pub.export({ type: "spki", format: "pem" }).toString();
  }

  issue(name: string, days: number, now = Date.now()): { payload: LicensePayload; token: string } {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) throw new Error("name must be 1..120 characters");
    if (!Number.isFinite(days) || days < 1 || days > 3650) throw new Error("days must be 1..3650");
    const { priv } = this.loadKeys();
    const iat = now;
    const exp = iat + Math.round(days * 86_400_000);
    // Key order below IS the pinned v1 wire order (JS object insertion order
    // survives JSON.stringify). Do not reorder.
    const payload: LicensePayload = { v: 1, id: randomUUID(), name: trimmed, exp, iat, plan: "beta" };
    const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
    const sig = edSign(null, payloadBytes, priv);
    const token = `${TOKEN_PREFIX}.${payloadBytes.toString("base64url")}.${sig.toString("base64url")}`;
    const registry = readJson<Record<string, LicensePayload>>(this.licensesFile, {});
    registry[payload.id] = payload;
    writeJsonAtomic(this.licensesFile, registry);
    return { payload, token };
  }

  /** Full check: format, signature over the exact transmitted bytes, payload
   *  shape, expiry, revocation — in that order, first failure wins. */
  verify(token: string, now = Date.now()): VerifyResult {
    const parts = typeof token === "string" ? token.split(".") : [];
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: "format" };
    const payloadBytes = Buffer.from(parts[1]!, "base64url");
    const sig = Buffer.from(parts[2]!, "base64url");
    let sigOk = false;
    try {
      sigOk = edVerify(null, payloadBytes, this.loadKeys().pub, sig);
    } catch {
      sigOk = false; // malformed signature material is just a bad signature
    }
    if (!sigOk) return { ok: false, reason: "signature" };
    let payload: LicensePayload;
    try {
      payload = JSON.parse(payloadBytes.toString("utf8")) as LicensePayload;
    } catch {
      return { ok: false, reason: "payload" };
    }
    if (
      payload === null || typeof payload !== "object" ||
      payload.v !== 1 ||
      typeof payload.id !== "string" || !payload.id ||
      typeof payload.name !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number" ||
      typeof payload.plan !== "string"
    ) {
      return { ok: false, reason: "payload" };
    }
    if (now >= payload.exp) return { ok: false, reason: "expired" };
    if (this.isRevoked(payload.id)) return { ok: false, reason: "revoked" };
    return { ok: true, payload };
  }

  /** Rebuild the exact token for an already-issued license. Ed25519 is
   *  DETERMINISTIC, so re-signing the stored payload (whose JSON key order is
   *  the pinned v1 wire order, preserved by the registry round-trip)
   *  reproduces the original token byte-for-byte — the hub never needs to
   *  store tokens to re-issue an invite. Null for unknown or revoked ids:
   *  a revoked tester does not get a fresh copy of their key. */
  tokenFor(id: string): string | null {
    const registry = readJson<Record<string, LicensePayload>>(this.licensesFile, {});
    const payload = registry[id];
    if (!payload || this.isRevoked(id)) return null;
    const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
    const sig = edSign(null, payloadBytes, this.loadKeys().priv);
    return `${TOKEN_PREFIX}.${payloadBytes.toString("base64url")}.${sig.toString("base64url")}`;
  }

  /** Signature + shape ONLY — deliberately ignores expiry and revocation.
   *  For surfaces where a lapsed-but-genuine tester still gets a hearing
   *  (feedback intake: an expired key may file a bug; a revoked one may not,
   *  but that check is the CALLER's, via isKnown/isRevoked, so the caller can
   *  distinguish the cases instead of collapsing them into one refusal). */
  decodeGenuine(token: string): LicensePayload | null {
    const parts = typeof token === "string" ? token.split(".") : [];
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    const payloadBytes = Buffer.from(parts[1]!, "base64url");
    const sig = Buffer.from(parts[2]!, "base64url");
    let sigOk = false;
    try {
      sigOk = edVerify(null, payloadBytes, this.loadKeys().pub, sig);
    } catch {
      sigOk = false;
    }
    if (!sigOk) return null;
    let payload: LicensePayload;
    try {
      payload = JSON.parse(payloadBytes.toString("utf8")) as LicensePayload;
    } catch {
      return null;
    }
    if (
      payload === null || typeof payload !== "object" ||
      payload.v !== 1 ||
      typeof payload.id !== "string" || !payload.id ||
      typeof payload.name !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number" ||
      typeof payload.plan !== "string"
    ) {
      return null;
    }
    return payload;
  }

  isRevoked(id: string): boolean {
    return Object.hasOwn(readJson<RevokedFile>(this.revokedFile, { revoked: {} }).revoked, id);
  }

  /** Revoke by id. Returns false for an id this hub never issued (caller
   *  decides whether that is an error); revoking twice is a no-op success. */
  revoke(id: string, now = new Date()): boolean {
    const registry = readJson<Record<string, LicensePayload>>(this.licensesFile, {});
    if (!Object.hasOwn(registry, id)) return false;
    const file = readJson<RevokedFile>(this.revokedFile, { revoked: {} });
    file.revoked[id] ??= now.toISOString();
    writeJsonAtomic(this.revokedFile, file);
    return true;
  }

  /** Whether this id was issued by this hub. Check-ins from unknown ids are
   *  answered as revoked — a license we never issued has no business running. */
  isKnown(id: string): boolean {
    return Object.hasOwn(readJson<Record<string, LicensePayload>>(this.licensesFile, {}), id);
  }

  list(): LicenseRecord[] {
    const registry = readJson<Record<string, LicensePayload>>(this.licensesFile, {});
    const revoked = readJson<RevokedFile>(this.revokedFile, { revoked: {} }).revoked;
    return Object.values(registry)
      .map((p) => ({
        ...p,
        revoked: Object.hasOwn(revoked, p.id),
        ...(Object.hasOwn(revoked, p.id) ? { revokedAt: revoked[p.id]! } : {}),
      }))
      .sort((a, b) => b.iat - a.iat);
  }
}
