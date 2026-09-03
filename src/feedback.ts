// src/feedback.ts
// Tester bug reports / feature requests. Two artifacts:
//   data/feedback.jsonl — append-only, one report per line, status edited in
//   place by rewrite (reports are few; a rewrite is simpler than a side index).
//   data/feedback-attachments/<report-id>.<ext> — optional bounded raster;
//   JSONL holds only its integrity metadata so status edits stay cheap.
//
// The operator's loop: testers file from the beta UI → the bot forwards here
// with its license token → the admin page lists them → EXPORT hands the whole
// set (logs included) to the operator's assistant for triage. So the record
// keeps everything the diagnosis needs: version, install, logs, timestamps.
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { appendJsonl } from "./jsonfile.js";

export type FeedbackKind = "bug" | "feature";
export type FeedbackStatus = "new" | "discussing" | "fixed";

export interface FeedbackRecord {
  id: string;
  at: number; // OUR clock, unix-ms
  ts: number; // client's claimed clock, recorded not trusted
  ip: string;
  licenseId: string;
  name: string; // tester name from the VERIFIED token payload, never the body
  installId: string;
  version: string;
  kind: FeedbackKind;
  text: string;
  logs: string[];
  logsTruncated: boolean;
  diagnostics: Record<string, unknown>;
  attachment: StoredFeedbackAttachment | null;
  status: FeedbackStatus;
}

export interface FeedbackAttachment {
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
  bytes: number;
  sha256: string;
}

export interface StoredFeedbackAttachment extends Omit<FeedbackAttachment, "base64"> {
  /** Opaque basename below data/feedback-attachments; never client supplied. */
  file: string;
}

export type FeedbackDetailRecord = Omit<FeedbackRecord, "attachment"> & {
  attachment: (FeedbackAttachment & { file: string }) | null;
  attachmentUnavailable: boolean;
};

export type FeedbackAttachmentValidation =
  | { ok: true; attachment: FeedbackAttachment | null }
  | { ok: false; error: string };

// Caps, enforced server-side regardless of what the bot claims to cap:
export const FEEDBACK_TEXT_MAX = 8_000;
export const FEEDBACK_LOG_LINES_MAX = 300;
export const FEEDBACK_LOG_LINE_MAX = 2_000;
export const FEEDBACK_LOGS_BYTES_MAX = 200 * 1024;
export const FEEDBACK_ATTACHMENT_BYTES_MAX = 2 * 1024 * 1024;
export const FEEDBACK_ATTACHMENT_DIMENSION_MAX = 8_192;
export const FEEDBACK_ATTACHMENT_PIXELS_MAX = 32_000_000;
export const FEEDBACK_DIAGNOSTICS_BYTES_MAX = 24 * 1024;
/** Returned by intake so v2 apps know pictures/diagnostics were understood. */
export const FEEDBACK_EVIDENCE_SCHEMA = 2;

/** Feedback is an internet-facing, license-authenticated write surface. These
 * limits deliberately leave room for a tester to file the six reports from one
 * investigation (and retry a few) without letting one copied/expired token or
 * one source address turn the Hub into an unbounded file store. The IP ceiling
 * is five license-sized bursts so a small office/NAT is not treated as one
 * tester. Rate state is intentionally process-local; the persistent quotas
 * below remain the hard backstop across restarts. */
export const FEEDBACK_RAW_RATE_WINDOW_MS = 60 * 1_000;
export const FEEDBACK_RAW_RATE_IP_MAX = 30;
export const FEEDBACK_RATE_WINDOW_MS = 60 * 60 * 1_000;
export const FEEDBACK_AUTH_RATE_LICENSE_MAX = 30;
export const FEEDBACK_RATE_LICENSE_MAX = 12;
export const FEEDBACK_RATE_IP_MAX = 60;
const FEEDBACK_RATE_KEYS_MAX = 4_096;

/** Hard persistent ceilings for a beta Hub. The tracker is read as a whole by
 * the small admin/status implementation, hence its deliberately modest 32 MiB
 * cap. Pictures live separately: 256 MiB total, but no license may occupy more
 * than 32 MiB (sixteen maximum-size screenshots). Counts also bound tiny
 * reports. Nothing is evicted automatically; a full store must be exported and
 * explicitly cleaned by the operator. */
export const FEEDBACK_RECORDS_MAX = 2_000;
export const FEEDBACK_LICENSE_RECORDS_MAX = 100;
export const FEEDBACK_TRACKER_BYTES_MAX = 32 * 1024 * 1024;
export const FEEDBACK_ATTACHMENTS_BYTES_MAX = 256 * 1024 * 1024;
export const FEEDBACK_LICENSE_ATTACHMENTS_BYTES_MAX = 32 * 1024 * 1024;
export const FEEDBACK_STORAGE_BYTES_MAX = 320 * 1024 * 1024;
export const FEEDBACK_LICENSE_STORAGE_BYTES_MAX = 64 * 1024 * 1024;
export const FEEDBACK_FILESYSTEM_FREE_MIN = 512 * 1024 * 1024;

/** Injectable only at the Hub composition boundary so capacity refusals can be
 * tested without manufacturing hundreds of MiB of sparse files. Production
 * always receives this exact immutable set. */
export interface FeedbackStorageLimits {
  storageBytesMax: number;
  licenseStorageBytesMax: number;
  filesystemFreeMin: number;
}

export const DEFAULT_FEEDBACK_STORAGE_LIMITS: Readonly<FeedbackStorageLimits> = Object.freeze({
  storageBytesMax: FEEDBACK_STORAGE_BYTES_MAX,
  licenseStorageBytesMax: FEEDBACK_LICENSE_STORAGE_BYTES_MAX,
  filesystemFreeMin: FEEDBACK_FILESYSTEM_FREE_MIN,
});

const FILE = "feedback.jsonl";
const ATTACHMENTS_DIR = "feedback-attachments";

export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = ["new", "discussing", "fixed"];

const REDACTED = "[redacted]";
const SECRET_FIELD_SOURCE = String.raw`(?:(?:x[ _-]?(?:bapi[ _-]?)?)?api[ _-]?(?:key|secret)|x[ _-]?bapi[ _-]?sign|(?:x[ _-]?)?client[ _-]?secret|secret(?:[ _-]?key)?|(?:x[ _-]?)?(?:access|private)[ _-]?key|(?:x[ _-]?)?(?:auth[ _-]?)?token|password|passphrase|authorization|(?:set[ _-]?)?cookie|(?:x[ _-]?)?signature|credential|license)`;
const SECRET_FIELD = new RegExp(SECRET_FIELD_SOURCE, "i");
const QUOTED_SECRET_FIELD = new RegExp(
  `(["'])(${SECRET_FIELD_SOURCE})\\1(\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\4)[\\s\\S])*?\\4`,
  "gi",
);
const AUTHORIZATION_SCHEME = /\b(authorization)\s*[:=]\s*(?:Bearer|Basic|Token|ApiKey)\s+[A-Za-z0-9._~+/=-]{4,}/gi;
const COOKIE_HEADER = /\b((?:set[ _-]?)?cookie)\s*[:=]\s*[^\r\n]*/gi;
const SECRET_ASSIGNMENT = new RegExp(
  `\\b(${SECRET_FIELD_SOURCE})\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|[^\\s,;]+)`,
  "gi",
);

export interface FeedbackRateDecision {
  ok: boolean;
  retryAfterSeconds: number;
}

type FeedbackRateRows = Map<string, number[]>;

/** One process-local limiter owns a cheap raw-source gate, an authenticated
 * licence-attempt gate, and two accepted-report buckets. Call takeIpAttempt
 * before reading the body, takeAuthenticatedAttempt after verified auth, then
 * checkAccepted before the synchronous append and recordAccepted only after it
 * succeeds. Thus a copied token cannot distribute expensive failures over IPs,
 * while the tighter accepted allowances still describe stored reports. */
export class FeedbackRateLimiter {
  private readonly rawByIp: FeedbackRateRows = new Map();
  private readonly authByLicense: FeedbackRateRows = new Map();
  private readonly byLicense: FeedbackRateRows = new Map();
  private readonly byIp: FeedbackRateRows = new Map();
  private attempts = 0;

  takeIpAttempt(ip: string, now = Date.now()): FeedbackRateDecision {
    return this.inspect(this.rawByIp, `ip:${ip || "unknown"}`, FEEDBACK_RAW_RATE_IP_MAX, FEEDBACK_RAW_RATE_WINDOW_MS, now, true);
  }

  takeAuthenticatedAttempt(licenseId: string, now = Date.now()): FeedbackRateDecision {
    return this.inspect(this.authByLicense, `license:${licenseId || "unknown"}`, FEEDBACK_AUTH_RATE_LICENSE_MAX, FEEDBACK_RATE_WINDOW_MS, now, true);
  }

  checkAccepted(licenseId: string, ip: string, now = Date.now()): FeedbackRateDecision {
    const license = this.inspect(this.byLicense, `license:${licenseId || "unknown"}`, FEEDBACK_RATE_LICENSE_MAX, FEEDBACK_RATE_WINDOW_MS, now, false);
    const source = this.inspect(this.byIp, `ip:${ip || "unknown"}`, FEEDBACK_RATE_IP_MAX, FEEDBACK_RATE_WINDOW_MS, now, false);
    return license.ok && source.ok
      ? { ok: true, retryAfterSeconds: 0 }
      : { ok: false, retryAfterSeconds: Math.max(license.retryAfterSeconds, source.retryAfterSeconds) };
  }

  recordAccepted(licenseId: string, ip: string, now = Date.now()): void {
    this.inspect(this.byLicense, `license:${licenseId || "unknown"}`, FEEDBACK_RATE_LICENSE_MAX, FEEDBACK_RATE_WINDOW_MS, now, true);
    this.inspect(this.byIp, `ip:${ip || "unknown"}`, FEEDBACK_RATE_IP_MAX, FEEDBACK_RATE_WINDOW_MS, now, true);
  }

  private inspect(
    rows: FeedbackRateRows,
    rawKey: string,
    max: number,
    windowMs: number,
    now: number,
    consume: boolean,
  ): FeedbackRateDecision {
    // A backwards clock must not retain an entry forever. Clamp the comparison
    // point, then discard anything outside this process's current window.
    const at = Number.isFinite(now) ? now : Date.now();
    const cutoff = at - windowMs;
    const key = this.boundedKey(rows, rawKey, cutoff, at);
    const active = (rows.get(key) ?? []).filter((stamp) => stamp > cutoff && stamp <= at);
    if (active.length >= max) {
      rows.set(key, active);
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((active[0]! + windowMs - at) / 1_000)),
      };
    }
    if (consume) {
      active.push(at);
      rows.set(key, active);
    } else if (active.length) {
      rows.set(key, active);
    } else {
      rows.delete(key);
    }
    // X-Forwarded-For is overwritten by the shipped loopback proxy, but still
    // prune old keys so a future proxy/config change cannot grow these maps for
    // the lifetime of the process.
    if (consume && ++this.attempts % 256 === 0) {
      for (const bucket of [this.rawByIp, this.authByLicense, this.byLicense, this.byIp]) {
        for (const [id, stamps] of bucket) {
          const live = stamps.filter((stamp) => stamp > at - FEEDBACK_RATE_WINDOW_MS && stamp <= at);
          if (live.length) bucket.set(id, live);
          else bucket.delete(id);
        }
      }
    }
    return { ok: true, retryAfterSeconds: 0 };
  }

  /** A deliberately shared overflow bucket keeps attacker-controlled source
   * cardinality bounded without granting fresh allowance by evicting a key. */
  private boundedKey(rows: FeedbackRateRows, rawKey: string, cutoff: number, at: number): string {
    const overflow = "!overflow";
    const hasRoom = (): boolean => rows.size < FEEDBACK_RATE_KEYS_MAX - (rows.has(overflow) ? 0 : 1);
    if (rows.has(rawKey) || hasRoom()) return rawKey;
    for (const [id, stamps] of rows) {
      if (!stamps.some((stamp) => stamp > cutoff && stamp <= at)) rows.delete(id);
    }
    return rows.has(rawKey) || hasRoom() ? rawKey : overflow;
  }
}

export type FeedbackQuotaCode =
  | "reports-total"
  | "reports-license"
  | "tracker-bytes"
  | "attachments-total"
  | "attachments-license"
  | "storage-total"
  | "storage-license"
  | "filesystem-free";

export class FeedbackQuotaError extends Error {
  constructor(readonly quota: FeedbackQuotaCode, message: string) {
    super(message);
    this.name = "FeedbackQuotaError";
  }
}

/** The app redacts before sending; the hub repeats that boundary because old
 * or hostile clients must not be able to make credentials durable here. */
export function redactFeedbackText(value: unknown, cap = FEEDBACK_LOG_LINE_MAX): string {
  return String(value ?? "")
    .replace(/\bLHK1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(QUOTED_SECRET_FIELD, (_m, keyQuote: string, key: string, separator: string, valueQuote: string) =>
      `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED}${valueQuote}`)
    .replace(AUTHORIZATION_SCHEME, (_m, key: string) => `${key}=${REDACTED}`)
    .replace(COOKIE_HEADER, (_m, key: string) => `${key}=${REDACTED}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, (_m, key: string) => `${key}=${REDACTED}`)
    .replace(/([?&](?:api[_-]?key|access[_-]?key|key|token|secret|signature|password|license)=)[^&#\s]+/gi, `$1${REDACTED}`)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, cap);
}

type DiagnosticBudget = { bytes: number; nodes: number };

function diagnosticValue(value: unknown, key: string, depth: number, budget: DiagnosticBudget): unknown {
  if (SECRET_FIELD.test(key)) return REDACTED;
  if (budget.bytes >= FEEDBACK_DIAGNOSTICS_BYTES_MAX || budget.nodes >= 500) return "[truncated]";
  budget.nodes++;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const clean = redactFeedbackText(value, 1_000);
    budget.bytes += Buffer.byteLength(clean, "utf8");
    return clean;
  }
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => diagnosticValue(entry, "", depth + 1, budget));
  if (!value || typeof value !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [rawKey, entry] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    const cleanKey = String(rawKey).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
    if (cleanKey) out[cleanKey] = diagnosticValue(entry, cleanKey, depth + 1, budget);
  }
  return out;
}

function pruneDiagnosticTail(value: unknown): boolean {
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    const tail = value[value.length - 1];
    if (tail && typeof tail === "object" && pruneDiagnosticTail(tail)) return true;
    value.pop();
    return true;
  }
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 0) return false;
  const key = keys[keys.length - 1]!;
  const tail = object[key];
  if (tail && typeof tail === "object" && pruneDiagnosticTail(tail)) return true;
  delete object[key];
  return true;
}

/** The construction budget above cheaply stops hostile depth/node/string
 * growth. This final pass owns the advertised wire/storage contract: keys,
 * punctuation and numeric spellings count too, because UTF-8 JSON bytes are
 * what the request and JSONL tracker actually retain. Later fields are pruned
 * first so stable high-value facts at the front of the snapshot survive. */
function clampDiagnosticJsonBytes(value: Record<string, unknown>): Record<string, unknown> {
  while (Buffer.byteLength(JSON.stringify(value), "utf8") > FEEDBACK_DIAGNOSTICS_BYTES_MAX) {
    if (!pruneDiagnosticTail(value)) return {};
  }
  return value;
}

export function normalizeFeedbackDiagnostics(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = diagnosticValue(raw, "", 0, { bytes: 0, nodes: 0 });
  return value && typeof value === "object" && !Array.isArray(value)
    ? clampDiagnosticJsonBytes(value as Record<string, unknown>)
    : {};
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function imageMagicMatches(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return mimeType === "image/webp" && bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

interface ImageDimensions { width: number; height: number }

function pngDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 24 || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

const JPEG_SIZE_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes: Buffer): ImageDimensions | null {
  let offset = 2; // SOI
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return null; // EOI/SOS before a size frame
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || length > bytes.length - offset) return null;
    if (JPEG_SIZE_MARKERS.has(marker)) {
      if (length < 7) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function uint24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function webpDimensions(bytes: Buffer): ImageDimensions | null {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (length > bytes.length - data) return null;
    if (type === "VP8X" && length >= 10) {
      return { width: uint24LE(bytes, data + 4) + 1, height: uint24LE(bytes, data + 7) + 1 };
    }
    if (type === "VP8 " && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      const width = bytes.readUInt16LE(data + 6) & 0x3fff;
      const height = bytes.readUInt16LE(data + 8) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (type === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
      const packed = bytes.readUInt32LE(data + 1);
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    offset = data + length + (length & 1);
  }
  return null;
}

function imageDimensions(mimeType: string, bytes: Buffer): ImageDimensions | null {
  if (!imageMagicMatches(mimeType, bytes)) return null;
  if (mimeType === "image/png") return pngDimensions(bytes);
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  return mimeType === "image/webp" ? webpDimensions(bytes) : null;
}

function dimensionsAreSafe(size: ImageDimensions): boolean {
  return size.width <= FEEDBACK_ATTACHMENT_DIMENSION_MAX
    && size.height <= FEEDBACK_ATTACHMENT_DIMENSION_MAX
    && size.width * size.height <= FEEDBACK_ATTACHMENT_PIXELS_MAX;
}

function imageDimensionsAreSafe(mimeType: string, bytes: Buffer): boolean {
  const size = imageDimensions(mimeType, bytes);
  return !!size && dimensionsAreSafe(size);
}

export function normalizeFeedbackAttachment(raw: unknown): FeedbackAttachmentValidation {
  if (raw === null || raw === undefined || raw === "") return { ok: true, attachment: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "the attached picture is malformed" };
  const obj = raw as Record<string, unknown>;
  const mimeType = String(obj.mimeType ?? "").trim().toLowerCase();
  if (!IMAGE_TYPES.has(mimeType)) return { ok: false, error: "picture must be a PNG, JPEG or WebP image" };
  const base64 = typeof obj.base64 === "string" ? obj.base64.trim() : "";
  const encodedMax = Math.ceil(FEEDBACK_ATTACHMENT_BYTES_MAX / 3) * 4 + 4;
  if (!base64 || base64.length > encodedMax || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return { ok: false, error: `picture must be ${Math.floor(FEEDBACK_ATTACHMENT_BYTES_MAX / 1024 / 1024)} MB or smaller` };
  }
  const bytes = Buffer.from(base64, "base64");
  const canonical = bytes.toString("base64");
  if (!bytes.length || bytes.length > FEEDBACK_ATTACHMENT_BYTES_MAX || canonical.replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
    return { ok: false, error: `picture must be ${Math.floor(FEEDBACK_ATTACHMENT_BYTES_MAX / 1024 / 1024)} MB or smaller` };
  }
  if (!imageMagicMatches(mimeType, bytes)) return { ok: false, error: "picture contents do not match its image type" };
  const dimensions = imageDimensions(mimeType, bytes);
  if (!dimensions) return { ok: false, error: "picture dimensions could not be validated" };
  if (!dimensionsAreSafe(dimensions)) {
    return { ok: false, error: `picture dimensions must be at most ${FEEDBACK_ATTACHMENT_DIMENSION_MAX} px per side and ${FEEDBACK_ATTACHMENT_PIXELS_MAX.toLocaleString()} pixels total` };
  }
  const fallback = mimeType === "image/png" ? "screenshot.png" : mimeType === "image/webp" ? "screenshot.webp" : "screenshot.jpg";
  const name = redactFeedbackText(String(obj.name ?? "").split(/[\\/]/).pop() ?? "", 120) || fallback;
  return {
    ok: true,
    attachment: {
      name,
      mimeType: mimeType as FeedbackAttachment["mimeType"],
      base64: canonical,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

/** Clamp an incoming logs array to the caps. Newest lines win (drop oldest). */
export function clampLogs(raw: unknown): { logs: string[]; truncated: boolean } {
  if (!Array.isArray(raw)) return { logs: [], truncated: false };
  const strings = raw.filter((l): l is string => typeof l === "string");
  let truncated = strings.length !== raw.length;
  let lines = strings.map((l) => {
    const clean = redactFeedbackText(l);
    if (clean !== l || l.length > FEEDBACK_LOG_LINE_MAX) truncated = true;
    return clean;
  });
  if (lines.length > FEEDBACK_LOG_LINES_MAX) {
    lines = lines.slice(lines.length - FEEDBACK_LOG_LINES_MAX);
    truncated = true;
  }
  // Byte cap: drop OLDEST lines until the serialized payload fits.
  let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
  while (lines.length > 0 && bytes > FEEDBACK_LOGS_BYTES_MAX) {
    bytes -= Buffer.byteLength(lines[0]!, "utf8") + 1;
    lines.shift();
    truncated = true;
  }
  return { logs: lines, truncated };
}

export type FeedbackAppendInput =
  Omit<FeedbackRecord, "id" | "at" | "status" | "attachment">
  & { attachment: FeedbackAttachment | null };

function attachmentExtension(mimeType: FeedbackAttachment["mimeType"]): "png" | "webp" | "jpg" {
  return mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
}

function storedAttachmentFor(
  attachment: FeedbackAttachment | null,
  id: string,
): StoredFeedbackAttachment | null {
  return attachment ? {
    file: `${id}.${attachmentExtension(attachment.mimeType)}`,
    name: attachment.name,
    mimeType: attachment.mimeType,
    bytes: attachment.bytes,
    sha256: attachment.sha256,
  } : null;
}

function readableFileBytes(file: string, quota: FeedbackQuotaCode): number {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new FeedbackQuotaError(quota, "feedback storage usage could not be verified; ask the operator to check Hub data-directory permissions");
  }
}

/** Count actual regular files, including a crash-left temp/orphan. Ignoring an
 * unreferenced file here would make the advertised disk ceiling bypassable by
 * exactly the failure residue the ceiling is meant to contain. */
function attachmentDirectoryBytes(dataDir: string): number {
  const dir = path.join(dataDir, ATTACHMENTS_DIR);
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new FeedbackQuotaError("attachments-total", "feedback attachment usage could not be verified; ask the operator to check Hub data-directory permissions");
  }
  let bytes = 0;
  for (const name of names) {
    if (!name.isFile()) continue;
    bytes += readableFileBytes(path.join(dir, name.name), "attachments-total");
    if (bytes > FEEDBACK_ATTACHMENTS_BYTES_MAX) break;
  }
  return bytes;
}

function attributedAttachmentBytes(dataDir: string, row: FeedbackRecord): number {
  if (!row.attachment) return 0;
  try {
    // Metadata is part of the durable charge even if its image later goes
    // missing; if a file was externally enlarged, charge the larger reality.
    return Math.max(row.attachment.bytes, fs.statSync(attachmentPath(dataDir, row.attachment)).size);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return row.attachment.bytes;
    throw new FeedbackQuotaError("attachments-license", "feedback storage usage could not be verified; ask the operator to check Hub data-directory permissions");
  }
}

function quotaMessage(subject: string, limit: string): string {
  return `feedback storage is full for ${subject} (${limit}); no report was written — ask the operator to export evidence and delete resolved reports`;
}

function byteLimitLabel(bytes: number, description: string): string {
  const mib = 1024 * 1024;
  return bytes % mib === 0
    ? `${bytes / mib} MiB ${description}`
    : `${bytes.toLocaleString()} ${bytes === 1 ? "byte" : "bytes"} ${description}`;
}

/** Synchronous check immediately beside the synchronous append. In this
 * one-process Hub no other request can write between the check and effect. */
function assertFeedbackCapacity(
  dataDir: string,
  pending: FeedbackRecord,
  pendingAttachmentBytes: number,
  limits: Readonly<FeedbackStorageLimits>,
): void {
  const tracker = path.join(dataDir, FILE);
  const trackerBytes = readableFileBytes(tracker, "tracker-bytes");
  // This is the exact object appendJsonl receives below — including its real
  // UUID and property order — rather than an estimate that can be one byte on
  // the wrong side of a hard limit.
  const pendingTrackerBytes = Buffer.byteLength(`${JSON.stringify(pending)}\n`, "utf8");
  if (trackerBytes + pendingTrackerBytes > FEEDBACK_TRACKER_BYTES_MAX) {
    throw new FeedbackQuotaError("tracker-bytes", quotaMessage("the report tracker", "32 MiB maximum"));
  }

  let records: FeedbackRecord[];
  try {
    records = listFeedback(dataDir);
  } catch {
    throw new FeedbackQuotaError("tracker-bytes", "feedback storage usage could not be verified; no report was written — ask the operator to check the tracker");
  }
  if (records.length >= FEEDBACK_RECORDS_MAX) {
    throw new FeedbackQuotaError("reports-total", quotaMessage("this Hub", `${FEEDBACK_RECORDS_MAX.toLocaleString()} reports maximum`));
  }
  const licenseRows = records.filter((row) => row.licenseId === pending.licenseId);
  if (licenseRows.length >= FEEDBACK_LICENSE_RECORDS_MAX) {
    throw new FeedbackQuotaError("reports-license", quotaMessage("this license", `${FEEDBACK_LICENSE_RECORDS_MAX} reports maximum`));
  }

  const attachmentsBytes = attachmentDirectoryBytes(dataDir);
  if (attachmentsBytes + pendingAttachmentBytes > FEEDBACK_ATTACHMENTS_BYTES_MAX) {
    throw new FeedbackQuotaError("attachments-total", quotaMessage("Hub picture evidence", "256 MiB maximum"));
  }
  if (trackerBytes + attachmentsBytes + pendingTrackerBytes + pendingAttachmentBytes > limits.storageBytesMax) {
    throw new FeedbackQuotaError("storage-total", quotaMessage("this Hub", byteLimitLabel(limits.storageBytesMax, "combined maximum")));
  }
  const licenseAttachmentBytes = licenseRows.reduce((sum, row) => sum + attributedAttachmentBytes(dataDir, row), 0);
  if (licenseAttachmentBytes + pendingAttachmentBytes > FEEDBACK_LICENSE_ATTACHMENTS_BYTES_MAX) {
    throw new FeedbackQuotaError("attachments-license", quotaMessage("this license's picture evidence", "32 MiB maximum"));
  }
  const licenseTrackerBytes = licenseRows.reduce((sum, row) => sum + Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8"), 0);
  if (licenseTrackerBytes + licenseAttachmentBytes + pendingTrackerBytes + pendingAttachmentBytes > limits.licenseStorageBytesMax) {
    throw new FeedbackQuotaError("storage-license", quotaMessage("this license", byteLimitLabel(limits.licenseStorageBytesMax, "combined maximum")));
  }

  try {
    const disk = fs.statfsSync(dataDir);
    const available = disk.bavail * disk.bsize;
    if (!Number.isFinite(available) || available - pendingTrackerBytes - pendingAttachmentBytes < limits.filesystemFreeMin) {
      throw new FeedbackQuotaError("filesystem-free", quotaMessage("the Hub filesystem", byteLimitLabel(limits.filesystemFreeMin, "free-space reserve")));
    }
  } catch (err) {
    if (err instanceof FeedbackQuotaError) throw err;
    throw new FeedbackQuotaError("filesystem-free", "feedback filesystem capacity could not be verified; no report was written — ask the operator to check the Hub data directory");
  }
}

export function appendFeedback(
  dataDir: string,
  input: FeedbackAppendInput,
  now = Date.now(),
  limits: Readonly<FeedbackStorageLimits> = DEFAULT_FEEDBACK_STORAGE_LIMITS,
): FeedbackRecord {
  const id = randomUUID();
  const { attachment, ...fields } = input;
  const stored = storedAttachmentFor(attachment, id);
  const rec: FeedbackRecord = { ...fields, attachment: stored, id, at: now, status: "new" };
  let storedPath = "";
  let tempPath = "";
  try {
    // Capacity is decided before either the image or its tracker row exists.
    // Never accept a text-only shadow of a report whose picture did not fit.
    assertFeedbackCapacity(dataDir, rec, attachment?.bytes ?? 0, limits);
    if (attachment) {
      const dir = path.join(dataDir, ATTACHMENTS_DIR);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      storedPath = path.join(dir, stored!.file);
      tempPath = `${storedPath}.tmp.${process.pid}`;
      fs.writeFileSync(tempPath, Buffer.from(attachment.base64, "base64"), { mode: 0o600 });
      fs.renameSync(tempPath, storedPath);
      tempPath = "";
    }
    appendJsonl(path.join(dataDir, FILE), rec);
    return rec;
  } catch (err) {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch { /* best effort rollback */ }
    if (storedPath) try { fs.unlinkSync(storedPath); } catch { /* best effort rollback */ }
    throw err;
  }
}

/** One parser owns old-row normalization for list/detail/export so the streamed
 * path cannot accidentally expose a different compatibility shape. */
function parseStoredFeedbackLine(line: string): FeedbackRecord | null {
  if (!line.trim()) return null;
  try {
    const rec = JSON.parse(line) as FeedbackRecord;
    if (typeof rec.id !== "string" || typeof rec.kind !== "string" || typeof rec.text !== "string") return null;
    // Old reports predate these fields. Normalize in memory without rewriting
    // history or requiring a migration before an operator can export it.
    rec.logs = Array.isArray(rec.logs) ? rec.logs.filter((entry): entry is string => typeof entry === "string") : [];
    rec.logsTruncated = rec.logsTruncated === true;
    rec.diagnostics = normalizeFeedbackDiagnostics(rec.diagnostics);
    rec.attachment = validStoredAttachment(rec.attachment) ? rec.attachment : null;
    return rec;
  } catch {
    return null; // torn/garbage line — skip, never take the Hub down
  }
}

/** Read every report, tolerant of a torn/garbage line (skipped, never fatal). */
export function listFeedback(dataDir: string): FeedbackRecord[] {
  const file = path.join(dataDir, FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: FeedbackRecord[] = [];
  for (const line of raw.split("\n")) {
    const rec = parseStoredFeedbackLine(line);
    if (rec) out.push(rec);
  }
  return out;
}

function validStoredAttachment(raw: unknown): raw is StoredFeedbackAttachment {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const a = raw as Record<string, unknown>;
  return typeof a.file === "string" && /^[0-9a-f-]{36}\.(?:png|jpe?g|webp)$/.test(a.file)
    && IMAGE_TYPES.has(String(a.mimeType ?? ""))
    && typeof a.name === "string" && typeof a.bytes === "number" && Number.isSafeInteger(a.bytes)
    && a.bytes > 0 && a.bytes <= FEEDBACK_ATTACHMENT_BYTES_MAX
    && typeof a.sha256 === "string" && /^[a-f0-9]{64}$/.test(a.sha256);
}

function attachmentPath(dataDir: string, attachment: StoredFeedbackAttachment): string {
  return path.join(dataDir, ATTACHMENTS_DIR, attachment.file);
}

/** Full one-report evidence for the gated detail/export surfaces. A missing or
 * tampered file is reported as unavailable rather than crashing the Hub. */
function hydrateFeedbackAttachment(dataDir: string, rec: FeedbackRecord): FeedbackDetailRecord {
  let attachment: (FeedbackAttachment & { file: string }) | null = null;
  if (rec.attachment) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(attachmentPath(dataDir, rec.attachment), "r");
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== rec.attachment.bytes || stat.size > FEEDBACK_ATTACHMENT_BYTES_MAX) {
        throw new Error("attachment size or type mismatch");
      }
      // Allocate from validated metadata and read through the already-open fd.
      // A corrupted/enlarged file can therefore never defeat export's
      // one-bounded-attachment memory contract.
      const bytes = Buffer.allocUnsafe(rec.attachment.bytes);
      let read = 0;
      while (read < bytes.length) {
        const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
        if (count <= 0) throw new Error("attachment ended early");
        read += count;
      }
      const extra = Buffer.allocUnsafe(1);
      if (fs.readSync(fd, extra, 0, 1, bytes.length) !== 0) throw new Error("attachment grew while reading");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length === rec.attachment.bytes && sha256 === rec.attachment.sha256 && imageDimensionsAreSafe(rec.attachment.mimeType, bytes)) {
        attachment = { ...rec.attachment, base64: bytes.toString("base64") };
      }
    } catch { /* attachmentUnavailable below is visible from null */ }
    finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* read already failed */ } }
  }
  return { ...rec, attachment, attachmentUnavailable: !!rec.attachment && !attachment };
}

export function feedbackDetail(dataDir: string, id: string): FeedbackDetailRecord | null {
  const rec = listFeedback(dataDir).find((row) => row.id === id);
  return rec ? hydrateFeedbackAttachment(dataDir, rec) : null;
}

interface FeedbackLineOffset {
  offset: number;
  length: number;
  at: number;
  order: number;
}

function scanFeedbackOffsets(fd: number, size: number): FeedbackLineOffset[] {
  const rows: FeedbackLineOffset[] = [];
  const block = Buffer.allocUnsafe(64 * 1024);
  let blockOffset = 0;
  let lineOffset = 0;
  let order = 0;
  let pieces: Buffer[] = [];

  const inspect = (length: number): void => {
    const line = pieces.length === 0 ? "" : Buffer.concat(pieces, length).toString("utf8");
    const rec = parseStoredFeedbackLine(line);
    if (rec) rows.push({ offset: lineOffset, length, at: Number.isFinite(rec.at) ? rec.at : 0, order });
    pieces = [];
    order++;
  };

  while (blockOffset < size) {
    const wanted = Math.min(block.length, size - blockOffset);
    const read = fs.readSync(fd, block, 0, wanted, blockOffset);
    if (read <= 0) break;
    let cursor = 0;
    for (;;) {
      const newline = block.indexOf(0x0a, cursor);
      if (newline < 0 || newline >= read) {
        if (cursor < read) pieces.push(Buffer.from(block.subarray(cursor, read)));
        break;
      }
      if (newline > cursor) pieces.push(Buffer.from(block.subarray(cursor, newline)));
      const newlineOffset = blockOffset + newline;
      inspect(newlineOffset - lineOffset);
      lineOffset = newlineOffset + 1;
      cursor = newline + 1;
    }
    blockOffset += read;
  }
  // A valid legacy row need not end in LF; a torn one is rejected by parser.
  if (lineOffset < size) inspect(size - lineOffset);
  return rows;
}

function readFeedbackAt(fd: number, row: FeedbackLineOffset): FeedbackRecord | null {
  const bytes = Buffer.allocUnsafe(row.length);
  let read = 0;
  while (read < row.length) {
    const count = fs.readSync(fd, bytes, read, row.length - read, row.offset + read);
    if (count <= 0) return null;
    read += count;
  }
  return parseStoredFeedbackLine(bytes.toString("utf8"));
}

/** Newest-first snapshot iterator. The tracker is scanned into tiny
 * offset/time metadata, then only one report and its bounded attachment are
 * materialized at a time. Holding the original fd also makes an in-flight
 * export immune to an atomic status rewrite while excluding later appends. */
export function* feedbackExport(dataDir: string): Generator<FeedbackDetailRecord, void, void> {
  const file = path.join(dataDir, FILE);
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const offsets = scanFeedbackOffsets(fd, size)
      .sort((a, b) => b.at - a.at || a.order - b.order);
    for (const offset of offsets) {
      const row = readFeedbackAt(fd, offset);
      if (row) yield hydrateFeedbackAttachment(dataDir, row);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Rewrite the whole file from a record set. Atomic (tmp + rename) so a crash
 *  mid-write leaves the previous file intact rather than a truncated one. An
 *  EMPTY set writes an empty file rather than deleting it — a missing file and
 *  a file with nothing in it read the same to `listFeedback`, and leaving the
 *  file in place keeps the directory listing honest about what this hub does. */
function rewrite(dataDir: string, all: FeedbackRecord[]): void {
  const file = path.join(dataDir, FILE);
  const tmp = `${file}.tmp`;
  const next = all.length ? all.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
  const nextBytes = Buffer.byteLength(next, "utf8");
  const currentBytes = readableFileBytes(file, "tracker-bytes");
  // Legacy stores may already exceed today's cap. A delete that makes one
  // smaller must remain possible, but no status rewrite may grow it further.
  if (nextBytes > FEEDBACK_TRACKER_BYTES_MAX && nextBytes > currentBytes) {
    throw new FeedbackQuotaError("tracker-bytes", quotaMessage("the report tracker", "32 MiB maximum"));
  }
  try {
    fs.writeFileSync(tmp, next, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort: never touch evidence rows */ }
    throw err;
  }
}

/** Move a report between new/discussing/fixed. False = unknown id. */
export function setFeedbackStatus(dataDir: string, id: string, status: FeedbackStatus): boolean {
  if (!FEEDBACK_STATUSES.includes(status)) return false;
  const all = listFeedback(dataDir);
  const hit = all.find((r) => r.id === id);
  if (!hit) return false;
  hit.status = status;
  rewrite(dataDir, all);
  return true;
}

/** Delete reports outright. Returns how many were actually removed, which is
 *  how the caller distinguishes "deleted" from "already gone" — an id that
 *  matched nothing must not report success, or the admin page will show a row
 *  vanishing that is still on disk under a different id.
 *
 *  This is a REAL delete, not a status. The operator asked for it to stay
 *  organised, and a fourth status would leave the row in the export forever;
 *  the export is the artifact handed over for triage, so a deleted report has
 *  to leave that too. Deletion is therefore irreversible by design — the admin
 *  page confirms before calling, and the export is the backup. */
export function deleteFeedback(dataDir: string, ids: readonly string[]): number {
  const kill = new Set(ids.filter((i) => typeof i === "string" && i));
  if (kill.size === 0) return 0;
  const all = listFeedback(dataDir);
  const removedRows = all.filter((r) => kill.has(r.id));
  const keep = all.filter((r) => !kill.has(r.id));
  const removed = all.length - keep.length;
  if (removed > 0) {
    rewrite(dataDir, keep);
    for (const row of removedRows) if (row.attachment) {
      try { fs.unlinkSync(attachmentPath(dataDir, row.attachment)); }
      catch { /* the tracker delete succeeded; stale evidence can be cleaned offline */ }
    }
  }
  return removed;
}
