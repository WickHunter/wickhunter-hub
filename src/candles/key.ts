// src/candles/key.ts
// The candle seed's OWN Ed25519 signing key.
//
// ── WHY A SECOND KEY AT ALL ─────────────────────────────────────────────────
// Seeds were signed with the SAME key that mints LHK1 licence tokens. That is
// sound only because of an ordering nobody can see: a genuine SEED signature,
// re-wrapped as `LHK1.<seed-canonical-bytes>.<sig>`, PASSES the licence
// verifier's signature check — same key, same primitive — and is refused only
// afterwards, when `verifyLicenseToken` re-checks the payload SHAPE and finds
// no id/name/exp/iat/plan. The separation therefore rests on the shape check
// running AFTER the signature check. Anyone who later inverts that order, or
// relaxes the shape test, silently turns every seed payload the hub has ever
// served into a forgeable licence.
//
// Giving candles their own key removes that dependency entirely: a seed
// signature is then made by a key the licence verifier does not hold, so it
// fails at the signature step no matter what order any future verifier checks
// things in. `LicenseStore.sign()` stays exactly as it is — the overlap has to
// remain available while the rollout below is in flight.
//
// ── THE PATTERN IS DELIBERATELY THE ONE THIS REPO ALREADY HAS ───────────────
// Self-generated Ed25519, PKCS8 PEM, mode 600, in the data directory beside
// `license-signing.key`. Never in config, never in an env var, never committed
// (`data/` is gitignored), never printed, never returned by any route. The only
// difference from `LicenseStore`: this one generates itself on first use rather
// than waiting for `npm run keygen`, because a hub that has not been re-keyed
// must still be able to show the operator the public half it will eventually
// sign with (rollout step (a) below).
import { createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateSigningKey } from "../license.js";

export const CANDLE_SIGNING_KEY_FILE = "candle-signing.key";

/** keyId emitted when the DEDICATED candle key signs. */
export const CANDLE_KEY_ID = "candle-1";
/** keyId emitted when the LICENCE key signs — today's default, unchanged. */
export const LICENSE_SEED_KEY_ID = "seed-1";

/** Which key signs a seed. `"license"` is the shipped default; see the rollout
 *  order in config.ts before changing it. */
export type CandleSigner = "license" | "candle";
export const CANDLE_SIGNERS: readonly CandleSigner[] = ["license", "candle"];

export function isCandleSigner(v: unknown): v is CandleSigner {
  return typeof v === "string" && (CANDLE_SIGNERS as readonly string[]).includes(v);
}

/** Every reserved keyId and the signer it belongs to. A keyId that names one
 *  key while another key does the signing produces payloads that cannot be
 *  verified by anybody, and the symptom (silent refusal, far away, in a bot)
 *  points nowhere near the cause — so the pairing is enforced, not documented. */
export const RESERVED_KEY_IDS: Readonly<Record<string, CandleSigner>> = {
  [LICENSE_SEED_KEY_ID]: "license",
  [CANDLE_KEY_ID]: "candle",
};

/** The hub's dedicated candle-signing key: generated once, reused forever.
 *
 *  Regenerating it would invalidate every signature already served AND every
 *  public key the operator has pasted into a bot, so the write is guarded twice
 *  — by an existence check and by the `wx` open flag, which makes two hubs
 *  racing on the same data dir land on one key rather than clobbering. */
export class CandleKeyStore {
  readonly keyFile: string;
  private privateKey: KeyObject | null = null;
  private publicKey: KeyObject | null = null;

  constructor(readonly dataDir: string) {
    this.keyFile = path.join(dataDir, CANDLE_SIGNING_KEY_FILE);
  }

  hasKey(): boolean {
    return fs.existsSync(this.keyFile);
  }

  private loadKeys(): { priv: KeyObject; pub: KeyObject } {
    if (!this.privateKey || !this.publicKey) {
      if (!this.hasKey()) {
        fs.mkdirSync(this.dataDir, { recursive: true });
        try {
          fs.writeFileSync(this.keyFile, generateSigningKey().privatePem, { mode: 0o600, flag: "wx" });
        } catch (err) {
          // Another process won the race and wrote the file between our check
          // and our open. Its key is as good as ours — read that one.
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
      this.privateKey = createPrivateKey(fs.readFileSync(this.keyFile, "utf8"));
      this.publicKey = createPublicKey(this.privateKey);
    }
    return { priv: this.privateKey, pub: this.publicKey };
  }

  publicKeyPem(): string {
    return this.loadKeys().pub.export({ type: "spki", format: "pem" }).toString();
  }

  /** The 32 raw public-key bytes, base64url — the SAME encoding the bot's
   *  `LICENSE_PUBLIC_KEY_B64U` uses, because the operator pastes this string
   *  into the bot's source by hand and must not have to convert anything. */
  publicKeyRawB64u(): string {
    const spki = this.loadKeys().pub.export({ type: "spki", format: "der" });
    // An Ed25519 SPKI is a fixed 12-byte algorithm header + the 32 key bytes.
    return Buffer.from(spki.subarray(spki.length - 32)).toString("base64url");
  }

  /** Ed25519-sign arbitrary bytes. Returns a signature only — this module
   *  never returns, prints or logs key material, exactly like license.ts. */
  sign(bytes: Buffer): Buffer {
    return edSign(null, bytes, this.loadKeys().priv);
  }
}

/** The startup banner. Built as a pure string so it can be asserted on without
 *  capturing stdout — and so a test can prove it carries the PUBLIC half only.
 *
 *  Says three things the operator needs at once: which key is signing right
 *  now, the exact string to paste, and that pasting it is safe. */
export function candleKeyBanner(publicKeyB64u: string, activeSigner: CandleSigner, activeKeyId: string): string {
  const signingWith = activeSigner === "candle"
    ? `the DEDICATED candle key, emitting keyId "${activeKeyId}"`
    : `the LICENCE key, emitting keyId "${activeKeyId}" (unchanged default)`;
  return [
    `[hub] candle seed is signing with ${signingWith}`,
    `[hub] CANDLE SEED PUBLIC KEY (keyId "${CANDLE_KEY_ID}") — this is a PUBLIC key, safe to copy and paste:`,
    `[hub]   ${publicKeyB64u}`,
    `[hub]   Paste it into the bot's OLB_SEED_KEYS, ship a bot build, and only THEN set`,
    `[hub]   HUB_CANDLE_SIGNER=candle. Flipping it earlier makes every bot refuse every seed.`,
  ].join("\n");
}
