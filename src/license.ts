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

  /** The 32 raw public-key bytes, base64url — the compact form baked into the
   *  bot. Same encoding `generateSigningKey` reports at keygen time, offered
   *  here so the admin page can show the operator which key to pair a
   *  seed-verifying client against without them re-running keygen. */
  publicKeyRawB64u(): string {
    const spki = this.loadKeys().pub.export({ type: "spki", format: "der" });
    return Buffer.from(spki.subarray(spki.length - 32)).toString("base64url");
  }

  /** Ed25519-sign arbitrary bytes with the hub's signing key.
   *
   *  This is the SAME key and the same primitive that mints LHK1 licence
   *  tokens, deliberately: the candle-seed service needs signed payloads, and a
   *  second key would mean a second thing to generate, back up, rotate and bake
   *  into the bot, for no security gain. Nothing about it is licence-specific —
   *  `issue()` signs a payload, this signs a caller's bytes.
   *
   *  Domain separation is structural rather than by prefix: a licence signature
   *  covers a JSON object with `v/id/name/exp/iat/plan`, a seed signature covers
   *  one with `v/venue/symbol/interval/...`, and neither parses as the other, so
   *  a signature lifted from one surface is inert on the other.
   *
   *  Returns a signature only — never key material, per this module's rule. */
  sign(bytes: Buffer): Buffer {
    return edSign(null, bytes, this.loadKeys().priv);
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

  /** ── CHANGE AN ISSUED LICENSE'S EXPIRY ──────────────────────────────────
   *
   *  Rewrites the stored payload's `exp` and returns the updated record, so
   *  `tokenFor(id)` then re-signs it into a NEW token.
   *
   *  WHAT THIS DOES NOT DO, and the caller must say so out loud: it does not
   *  change the expiry of the token the tester is already running. `exp` lives
   *  INSIDE the signed payload, and the bot checks it offline against its own
   *  stored copy — the daily check-in answers `revoked` and `latest` and
   *  carries no expiry at all. So an extension only takes effect once the
   *  tester installs the re-minted token, and a shortening does not cut anyone
   *  off early. Revocation is the mechanism that acts on a running bot.
   *
   *  The payload is rebuilt in the PINNED v1 KEY ORDER rather than mutated in
   *  place. JS object insertion order survives JSON.stringify, the token is a
   *  signature over those exact bytes, and `tokenFor`'s whole contract is that
   *  re-signing a stored payload reproduces the token byte-for-byte. A
   *  registry round-trip that reordered a key would silently mint a token that
   *  verifies but differs from the one the operator last copied.
   *
   *  Refuses a revoked id for the same reason `tokenFor` does: a revoked
   *  tester does not get a fresh key, and extending one would be the start of
   *  exactly that. */
  setExpiry(id: string, exp: number, now = Date.now()): LicensePayload | null {
    const registry = readJson<Record<string, LicensePayload>>(this.licensesFile, {});
    const current = registry[id];
    if (!current || this.isRevoked(id)) return null;
    if (!Number.isFinite(exp)) throw new Error("exp must be a finite unix-ms timestamp");
    const ms = Math.round(exp);
    // Bounded by the same reasoning as `issue()`'s 1..3650 days, measured from
    // when the license was ISSUED so the window cannot be walked forward
    // indefinitely by repeated edits.
    if (ms <= current.iat) throw new Error("expiry must be after the license was issued");
    if (ms > current.iat + 3650 * 86_400_000) throw new Error("expiry must be within 3650 days of issue");
    void now;
    const payload: LicensePayload = {
      v: current.v, id: current.id, name: current.name, exp: ms, iat: current.iat, plan: current.plan,
    };
    registry[id] = payload;
    writeJsonAtomic(this.licensesFile, registry);
    return payload;
  }

  /** The stored payload for an id, or null for an unknown or revoked one. The
   *  check-in reads this to learn whether the registry now promises a LATER
   *  expiry than the token a tester is presenting. */
  get(id: string): LicensePayload | null {
    const registry = readJson<Record<string, LicensePayload>>(this.licensesFile, {});
    const payload = registry[id];
    return payload && !this.isRevoked(id) ? payload : null;
  }

  /** ── EXTEND EVERY ACTIVE LICENCE TO ONE DATE (v0.3.19) ───────────────────
   *
   *  Operator, 2026-09-04: "extend every beta tester's sub to 9/30 — I am going
   *  to start charging on 10/1. I want it to be as easy on users and myself."
   *  One call, every non-revoked licence whose expiry is EARLIER than `exp`
   *  moves to `exp`; a licence already past that date is left alone (this
   *  never shortens anything — `setExpiry` is the tool for that, one at a
   *  time). A licence the bound refuses (more than 3650 days from its issue)
   *  is reported by name rather than aborting the rest.
   *
   *  The re-minted key reaches a running bot through the check-in (see
   *  `server.ts`'s check-in reply) once the bot presents its current key, so
   *  after this call the operator has nothing else to send. */
  extendAll(exp: number, now = Date.now()): { extended: LicensePayload[]; unchanged: number; refused: Array<{ id: string; name: string; error: string }> } {
    if (!Number.isFinite(exp)) throw new Error("exp must be a finite unix-ms timestamp");
    const extended: LicensePayload[] = [];
    const refused: Array<{ id: string; name: string; error: string }> = [];
    let unchanged = 0;
    for (const rec of this.list()) {
      if (rec.revoked) continue;
      if (rec.exp >= exp) { unchanged++; continue; }
      try {
        const p = this.setExpiry(rec.id, exp, now);
        if (p) extended.push(p);
      } catch (e) {
        refused.push({ id: rec.id, name: rec.name, error: (e as Error).message });
      }
    }
    return { extended, unchanged, refused };
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
