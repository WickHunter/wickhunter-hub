import { createHmac, randomBytes } from "node:crypto";
import type { RateDecision } from "./ratelimit.js";

/** Bounded conservative sliding-window sketch for anonymous session admission.
 * Four independent keyed buckets avoid one shared overflow allowance blocking
 * every new visitor after 4095 addresses. Collisions may refuse early under
 * heavy saturation, but can never grant extra allowance to a tracked address.
 * The global and guest monetary budgets remain independent hard limits.
 * In-memory state resets on restart, as did the previous IP limiter. */
export class SupportSessionLimiter {
  private readonly timestamps: Float64Array;
  private readonly key: Buffer;
  private lastNow = -Infinity;
  constructor(private readonly windowMs = 24 * 60 * 60_000,
    private readonly max = 3, private readonly width = 65_536, key?: Buffer) {
    if (!Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isSafeInteger(max) || max < 1 || max > 100
      || !Number.isSafeInteger(width) || width < 1 || width > 65_536 || (width & (width - 1)) !== 0) {
      throw new Error("Invalid support-session limiter bounds");
    }
    this.key = key ? Buffer.from(key) : randomBytes(32);
    this.timestamps = new Float64Array(4 * width * max).fill(-Infinity);
  }
  take(address: string, now: number): RateDecision {
    if (!Number.isFinite(now)) return {ok: false, retryAfterSeconds: 1};
    const at = Math.max(now, this.lastNow);
    this.lastNow = at;
    const cutoff = at - this.windowMs;
    const digest = createHmac("sha256", this.key).update(address).digest();
    const offsets = Array.from({length: 4}, (_, i) => (i * this.width + (digest.readUInt32LE(i * 4) & (this.width - 1))) * this.max);
    let available = false, retryAt = Infinity;
    for (const offset of offsets) {
      // Only the last max admissions are needed. Once they all lie inside
      // the window the address is limited, regardless of older events.
      if (this.timestamps[offset]! <= cutoff) available = true;
      else retryAt = Math.min(retryAt, this.timestamps[offset]! + this.windowMs);
    }
    if (!available) return {ok: false, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - at) / 1000))};
    for (const offset of offsets) {
      for (let j = 1; j < this.max; j++) this.timestamps[offset + j - 1] = this.timestamps[offset + j]!;
      this.timestamps[offset + this.max - 1] = at;
    }
    return {ok: true, retryAfterSeconds: 0};
  }
  /** Fixed memory independent of distinct visitor count. */
  get bytes(): number { return this.timestamps.byteLength; }
}
