// src/server.ts
// The hub's HTTP server: node:http, no framework, no runtime dependencies.
//
// Surfaces, outermost first:
//   public   GET  /api/health                    liveness + version
//   keyed    POST /api/license/checkin           bot phone-home; answers revoked
//   keyed    POST /api/feedback                  tester bug/feature reports (license token in body)
//   keyed    GET  /install.sh?key=<token>        templated tester installer
//   keyed    GET  /api/latest?key=<token>        authenticated signed release manifest
//   keyed    GET  /download/<file>?key=<token>   beta tarballs ("latest" resolves)
//   keyed    GET  /api/candles/seed              signed 1m candle seed (contract v1)
//   keyed    GET  /api/market-data/market-caps/v1 signed market-cap snapshot (contract v1)
//   keyed    GET  /api/hub/strategies            community Strat gallery
//   keyed    POST /api/hub/strategies/publish    share 1..N bots as one Strat
//   keyed    POST /api/hub/strategies/vote       one vote per LICENCE
//   keyed    POST /api/hub/strategies/delete     an author removes their own
//   admin    GET  /admin                         static admin page (auth lives in its API calls)
//   admin    GET  /admin/api/licenses            list with last-seen
//   admin    POST /admin/api/licenses            issue {name, days} -> token
//   admin    POST /admin/api/licenses/expiry     {id, exp} -> re-minted command
//   admin    POST /admin/api/licenses/revoke     {id}
//   admin    GET  /admin/api/market-caps       producer health + credit spend
//   admin    GET  /admin/api/flags                per-licence feature flags
//   admin    POST /admin/api/flags                {id|"default", flag, state:true|false|null}
//   admin    GET  /admin/api/licenses/command    ?id= -> rebuilt install command (active only)
//   admin    GET  /admin/api/feedback            report list (sans logs)
//   admin    POST /admin/api/feedback/status     {id, status: new|discussing|fixed}
//   admin    POST /admin/api/feedback/delete     {id} or {ids:[...]} -> gone for good
//   admin    GET  /admin/api/feedback/export     full JSON download, logs included
//   admin    POST /admin/api/upgrade             self-upgrade: git pull + install-hub.sh (detached)
//
// "keyed" = a valid, unexpired, unrevoked LHK1 token in ?key= — or, on the
// community routes, in an `x-license` header, which is what the bot sends and
// what keeps a token out of an access log. "admin" = the
// HUB_ADMIN_TOKEN in an x-hub-admin header, compared constant-time. No
// sessions, no cookies anywhere.
//
// SECRETS IN URLS: download/install keys ride in the query string by design
// (curl-pasteable), so this file must never log a raw req.url — log the
// pathname only. The nginx snippet the installer emits does not add an access
// log for /hub/ either; if the operator turns one on, that is on them.
import fs from "node:fs";
import { createHash, timingSafeEqual, createPublicKey } from "node:crypto";
import { gzipSync } from "node:zlib";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { CandleService, type CandleServiceDeps } from "./candles/service.js";
import { MarketCapService } from "./marketcap/service.js";
import { marketCapStartupRefusals } from "./marketcap/config.js";
import { CoinGeckoFallback } from "./marketcap/coingecko.js";
import { loadSigningKey, signerFromSignFn } from "./marketcap/snapshot.js";
import type { HttpLike } from "./marketcap/cmc.js";
import { CommunityService } from "./community.js";
import { CANDLE_KEY_ID, CandleKeyStore } from "./candles/key.js";
import { isVenueId } from "./candles/venues.js";
import { recordCheckin, readRoster, sharingSignals } from "./checkins.js";
import { flagsFor, isUnsafeKey, readFlags, setFlag } from "./flags.js";
import {
  FEEDBACK_STATUSES, FEEDBACK_TEXT_MAX, appendFeedback, clampLogs, deleteFeedback, listFeedback,
  setFeedbackStatus, type FeedbackStatus,
} from "./feedback.js";
import type { HubConfig } from "./config.js";
import { LicenseStore, type LicensePayload } from "./license.js";
import {
  LicenseLeaseService,
  leaseRequestFailure,
  type LeaseChallengeInput,
  type LeasePurpose,
} from "./license-leases.js";
import { HUB_VERSION } from "./version.js";
import { spawn as nodeSpawn } from "node:child_process";
import {
  verifyReleaseArtifact,
  verifyReleaseManifest,
  type SignedReleaseManifest,
} from "./release-manifest.js";
import {
  fetchMarketplaceStatus,
  marketplaceStatusBridgeFromEnv,
  type MarketplaceStatusFetch,
} from "./marketplace-status.js";
import {
  readBuildRecord,
  probeSourceCheckout,
  readUpgradeLogTail,
  readUpgradeStatus,
  writeUpgradeStatus,
} from "./operations.js";

/** The provider fetcher for the market-cap producer. A separate shape from the
 *  candles' `FetchLike` because this one carries an API-key HEADER — which is
 *  where a paid credential belongs, never in a query string that reaches a log. */
const realCmcHttp: HttpLike = async (url, init) => {
  const res = await fetch(url, { headers: init.headers });
  return { ok: res.ok, status: res.status, json: () => res.json(), headers: res.headers };
};

/** The venues' own public endpoints, for the instrument catalogues. Same shape
 *  the candle service uses; no key, no header. */
const realVenueFetch: NonNullable<CandleServiceDeps["fetchLike"]> = async (url: string) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  return { ok: res.ok, status: res.status, json: () => res.json(), headers: res.headers };
};

const MAX_BODY_BYTES = 64 * 1024; // largest legitimate body is a tiny JSON object
// Feedback carries a bounded log tail (see feedback.ts caps) — its own limit:
const MAX_FEEDBACK_BODY_BYTES = 256 * 1024;

export interface Hub {
  server: http.Server;
  store: LicenseStore;
  candles: CandleService;
  /** Null when the producer is not configured (no venues, or no CMC key) —
   *  which is every install by default, because every call it makes spends a
   *  credit against a plan the operator pays for. */
  marketCaps: MarketCapService | null;
  /** The dedicated candle-signing key. Exposed so main.ts can print its PUBLIC
   *  half at startup; it never yields private material to anyone. */
  candleKey: CandleKeyStore;
  /** Null only when the additive lease authority could not initialize. Legacy
   * LHK1 and check-in surfaces remain available in that case. */
  licenseLeases: LicenseLeaseService | null;
  /** Bind cfg.host:cfg.port (port 0 ok for tests); resolves to the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export interface HubDeps {
  /** Injectable for tests; production is node:child_process.spawn. */
  spawn?: typeof nodeSpawn;
  /** Injectable so candle tests never touch the network. */
  candleFetch?: CandleServiceDeps["fetchLike"];
  /** Injectable so candle tests do not wait out the collector's request pacing. */
  candleSleep?: CandleServiceDeps["sleep"];
  /** Injectable so market-cap tests never reach a paid provider. */
  marketCapHttp?: HttpLike;
  /** The venues' own public endpoints, for the instrument catalogues. */
  marketCapVenueFetch?: CandleServiceDeps["fetchLike"];
  marketCapSleep?: (ms: number) => Promise<void>;
  marketCapNow?: () => number;
  /** Injectable machine-lease clock/entropy for hermetic replay/clock tests. */
  licenseLeaseNow?: () => number;
  licenseLeaseMonotonicNow?: () => number;
  licenseLeaseRandomBytes?: (size: number) => Buffer;
  licenseLeaseRandomId?: () => string;
  /** Injectable so Marketplace status tests never leave loopback. */
  marketplaceStatusFetch?: MarketplaceStatusFetch;
}

export function createHub(cfg: HubConfig, deps: HubDeps = {}): Hub {
  const store = new LicenseStore(cfg.dataDir);
  let licenseLeases: LicenseLeaseService | null = null;
  try {
    licenseLeases = new LicenseLeaseService(cfg.dataDir, store, cfg.licenseLease, {
      now: deps.licenseLeaseNow,
      monotonicNow: deps.licenseLeaseMonotonicNow,
      randomBytes: deps.licenseLeaseRandomBytes,
      randomId: deps.licenseLeaseRandomId,
      featuresFor: (licenseId) => Object.keys(flagsFor(cfg.dataDir, licenseId)),
    });
  } catch (err) {
    // This is an additive migration. A missing/corrupt lease authority must
    // fail lease issuance closed without taking old LHK1 installs, downloads,
    // feedback, or exit-capable check-ins offline.
    console.warn(`[license-lease] disabled: ${(err as Error).message}`);
  }
  const community = new CommunityService(cfg.dataDir);
  /** A Strat body is bigger than a vote and smaller than a feedback log dump:
   *  ten bot configs, capped again inside the service regardless of this. */
  const STRAT_BODY_BYTES_MAX = 256 * 1024;
  const spawn = deps.spawn ?? nodeSpawn;
  const marketplaceStatusFetch: MarketplaceStatusFetch = deps.marketplaceStatusFetch ?? (async (url, init) => {
    const response = await fetch(url, init);
    return { ok: response.ok, status: response.status, text: () => response.text() };
  });
  const candleKey = new CandleKeyStore(cfg.dataDir);
  // ── WHICH KEY SIGNS A SEED ────────────────────────────────────────────────
  // One expression picks BOTH halves — `cfg.candleKeyId` was derived from the
  // same `cfg.candleSigner` back in config.ts — because a payload signed by one
  // key and labelled another is unverifiable everywhere and diagnosable
  // nowhere. If you are adding a third signer, add it in both places or in
  // neither. Default is `"license"`: the licence key, labelled `seed-1`,
  // exactly as before. See candleSigningFromEnv for why flipping it early
  // kills seeding silently.
  const signSeed = cfg.candleSigner === "candle"
    ? (bytes: Buffer) => candleKey.sign(bytes)
    : (bytes: Buffer) => store.sign(bytes);
  const candles = new CandleService(
    {
      dataDir: cfg.dataDir,
      venues: cfg.candleVenues,
      // INTERSECTED, not trusted: a stream is a faster tail for a venue the
      // collector already owns, never a way to collect one it does not.
      streamVenues: (cfg.candleStreamVenues ?? []).filter((v) => cfg.candleVenues.includes(v)),
      keyId: cfg.candleKeyId,
      options: cfg.candleOptions,
      tickMs: cfg.candleTickMs,
    },
    { sign: signSeed, fetchLike: deps.candleFetch, sleep: deps.candleSleep },
  );
  // ── THE MARKET-CAP PRODUCER ───────────────────────────────────────────────
  // Built only when it is configured AND usable. A refusal is PRINTED and the
  // service stays null: the hub also does licensing and candle seeding, and a
  // missing provider key must not take those down — but it must not be silent
  // either, because "configured and unable" looks exactly like "the provider is
  // down" from every client's side.
  const marketCaps = ((): MarketCapService | null => {
    const mc = cfg.marketCap;
    if (!mc || !mc.venues.length) return null;
    const refusals = marketCapStartupRefusals(mc);
    if (refusals.length) {
      for (const r of refusals) console.warn(`[marketcap] not starting: ${r}`);
      return null;
    }
    try {
      /* ⚠ THE LICENCE KEY IS THE DEFAULT, AND IT IS THE ONLY ONE ANY SHIPPED
         BOT CAN VERIFY. `asset-market-cap.ts` pins `mcap-1` -> the licence
         public key and REFUSES an unknown keyId. The first operator to enable
         this published `market-data-1`, every bot refused every snapshot, and
         the page read "no snapshot has been read from the hub yet" — a live
         feature indistinguishable from one nobody switched on. This is the
         same two-line choice the candle seed makes ~30 lines above. */
      /* ⚠ THE TEST FOR THE LICENCE BRANCH IS `=== "license"`, NEVER
         `!== "market-data"`, AND THE HUB'S OWN SUITE CAUGHT THE DIFFERENCE.
         `MarketCapEnvConfig` is built BY HAND in tests and tools as well as by
         `configFromEnv` — config.ts says so in its own words — so an absent
         `signer` is a real shape. Read as "not market-data" it took the LICENCE
         key while still carrying a dedicated private key and labelling the
         payload `market-data-1`: signed by one key, labelled another,
         verifiable by nobody. `configFromEnv` always sets it explicitly, so
         only a hand-built config reaches the fallback, and the honest fallback
         is the key it actually supplied. */
      const signer = mc.signer === "license"
        ? signerFromSignFn(mc.signingKeyId, createPublicKey(store.publicKeyPem()), (bytes) => store.sign(bytes))
        : loadSigningKey(mc.signingKeyB64u, mc.signingKeyId);
      return new MarketCapService(mc, {
        http: deps.marketCapHttp ?? realCmcHttp,
        apiKey: mc.apiKey,
        venueFetch: deps.marketCapVenueFetch ?? realVenueFetch,
        signer,
        gecko: mc.coingeckoApiKey
          ? new CoinGeckoFallback({ http: deps.marketCapHttp ?? realCmcHttp, apiKey: mc.coingeckoApiKey, idMap: {} })
          : new CoinGeckoFallback(null),
        now: deps.marketCapNow,
        sleep: deps.marketCapSleep,
      });
    } catch (err) {
      // A bad signing key is a startup refusal, not a publish-time surprise
      // four hours later on a timer.
      console.warn(`[marketcap] not starting: ${(err as Error).message}`);
      return null;
    }
  })();

  let upgradeStartedAt = 0;
  let sourceProbeCache: { readonly atMs: number; readonly runtimeKey: string; readonly source: ReturnType<typeof probeSourceCheckout> } | null = null;

  function operationsStatus(includeLog: boolean): Record<string, unknown> {
    const build = readBuildRecord(cfg.dataDir, HUB_VERSION);
    const runtimeKey = `${build.packageVersion}:${build.commit ?? "unknown"}:${build.builtAtMs}`;
    const now = Date.now();
    if (!sourceProbeCache || sourceProbeCache.runtimeKey !== runtimeKey || now - sourceProbeCache.atMs >= 10_000) {
      sourceProbeCache = { atMs: now, runtimeKey, source: probeSourceCheckout(cfg.srcDir, build) };
    }
    const source = sourceProbeCache.source;
    const upgrade = readUpgradeStatus(cfg.dataDir);
    return {
      packageVersion: HUB_VERSION,
      build,
      source,
      sourceVsRuntime: source.relationToRuntime,
      upgrade,
      ...(includeLog ? { upgradeLogTail: readUpgradeLogTail(cfg.dataDir) } : {}),
    };
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Never leak internals to the wire; do log them (message only) locally.
      console.error(`[hub] 500 on ${req.method} ${pathOf(req)}: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal error" });
      else res.destroy();
    });
  });
  // Beta hub, small bodies, loopback-only: short timeouts beat resource pileup.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://hub.invalid");
    const p = url.pathname;
    const m = req.method ?? "GET";

    if (m === "GET" && p === "/api/health") {
      return sendJson(res, 200, { ok: true, version: HUB_VERSION, ...operationsStatus(false) });
    }
    if (m === "POST" && p === "/api/license/checkin") return checkin(req, res);
    if (m === "POST" && p === "/api/license/lease/challenge") return leaseChallenge(req, res);
    if (m === "POST" && p === "/api/license/lease/activate") return leaseOperation(req, res, "activate");
    if (m === "POST" && p === "/api/license/lease/renew") return leaseOperation(req, res, "renew");
    if (m === "POST" && p === "/api/license/lease/deactivate") return leaseOperation(req, res, "deactivate");
    if (m === "POST" && p === "/api/license/lease/rebind") return leaseOperation(req, res, "rebind");
    if (m === "POST" && p === "/api/feedback") return feedbackIntake(req, res);
    if (m === "GET" && p === "/install.sh") return installScript(url, res);
    if (m === "GET" && p === "/api/latest") return latestMeta(url, res);
    if (m === "GET" && p === "/api/candles/seed") return candleSeed(req, url, res);
    if (m === "GET" && p === "/api/market-data/market-caps/v1") return marketCapSnapshot(req, url, res);
    // ── the community Strat gallery ────────────────────────────────────────
    // These paths are the BOT's existing ones, deliberately: a liqhunter
    // install can also host a gallery (LIQHUNTER_HUB_KEY with no URL), and
    // keeping one wire contract means the two are interchangeable and an
    // operator can move between them without upgrading every install.
    if (m === "GET" && p === "/api/hub/strategies") return communityList(req, url, res);
    if (m === "POST" && p === "/api/hub/strategies/publish") return communityPublish(req, url, res);
    if (m === "POST" && p === "/api/hub/strategies/vote") return communityVote(req, url, res);
    if (m === "POST" && p === "/api/hub/strategies/delete") return communityDelete(req, url, res);
    if (m === "GET" && p.startsWith("/download/")) return download(url, res);
    if (m === "GET" && (p === "/admin" || p === "/admin/")) return adminPage(res);
    if (p.startsWith("/admin/api/")) return adminApi(req, res, url);
    sendJson(res, 404, { ok: false, error: "not found" });
  }

  // ── tester surface ────────────────────────────────────────────────────────

  async function checkin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (
      body === null ||
      typeof body.licenseId !== "string" || !body.licenseId ||
      typeof body.installId !== "string" || !body.installId ||
      typeof body.version !== "string" ||
      typeof body.ts !== "number"
    ) {
      return sendJson(res, 400, { ok: false, error: "bad checkin body" });
    }
    // Record EVERYTHING, including revoked/unknown ids — the record is the
    // point (who is still running what). Cap field lengths so a hostile client
    // cannot balloon the roster.
    recordCheckin(
      cfg.dataDir,
      {
        licenseId: body.licenseId.slice(0, 64),
        installId: body.installId.slice(0, 64),
        version: body.version.slice(0, 32),
        ts: body.ts,
      },
      clientIp(req),
    );
    // Unknown id => revoked:true. A licenseId this hub never issued has no
    // business running; failing safe here is the whole kill switch.
    const revoked = !store.isKnown(body.licenseId) || store.isRevoked(body.licenseId);
    // The reply also carries the latest published beta version (when one
    // exists) so the bot can show "update available" — informational only;
    // a bot that ignores it loses nothing.
    const latest = readLatest()?.version;
    // v0.2.11 — FEATURE FLAGS, per licence. See src/flags.ts for why they ride
    // the check-in rather than the signed token (format v1 is pinned, and a
    // reply reaches every already-issued key without a reissue).
    //
    // ALWAYS SENT, even when empty. The bot distinguishes an absent `flags` key
    // ("this hub predates flags — leave my cache alone") from `{}` ("the hub
    // says none"), and only the second can turn a feature back off. A hub that
    // omitted the key when it had nothing to say could never darken anything.
    //
    // Sent to REVOKED and unknown ids too, for the same reason `latest` is: the
    // reply is about what this build would show, and a revoked install still
    // deserves a truthful answer. Nothing here grants access to anything — the
    // licence gate is a separate mechanism at the order-submit seam.
    const flags = flagsFor(cfg.dataDir, body.licenseId);
    sendJson(res, 200, {
      ok: true,
      ...(revoked ? { revoked: true } : {}),
      ...(latest ? { latest } : {}),
      flags,
    });
  }

  // ── machine-bound lease surface ─────────────────────────────────────────
  // New clients use an x-license bootstrap bearer and prove possession of an
  // install-local Ed25519 key. These routes are additive; the historical
  // unauthenticated check-in above is intentionally byte-for-byte unchanged.
  function leaseBearer(req: IncomingMessage): string | null {
    const value = req.headers["x-license"];
    return typeof value === "string" && value.length <= 16_384 ? value : null;
  }

  function leaseError(res: ServerResponse, err: unknown): void {
    const failure = leaseRequestFailure(err);
    if (failure.operatorMessage) console.warn(`[license-lease] request failed closed: ${failure.operatorMessage}`);
    sendLeaseJson(res, failure.status, { ok: false, error: failure.publicMessage, code: failure.kind });
  }

  function sendLeaseJson(res: ServerResponse, status: number, body: unknown): void {
    sendJson(res, status, body, { "cache-control": "no-store" });
  }

  async function leaseChallenge(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!licenseLeases) return sendLeaseJson(res, 503, { ok: false, error: "machine-bound lease service is unavailable" });
    const token = leaseBearer(req);
    if (!token) return sendLeaseJson(res, 401, { ok: false, error: "x-license is required" });
    const body = await readJsonBody(req);
    if (body === null) return sendLeaseJson(res, 400, { ok: false, error: "bad lease challenge body" });
    const input: LeaseChallengeInput = {
      purpose: body.purpose as LeasePurpose,
      installId: body.installId as string,
      installPublicKey: body.installPublicKey as string,
      ...(typeof body.activationId === "string" ? { activationId: body.activationId } : {}),
      ...(typeof body.newInstallId === "string" ? { newInstallId: body.newInstallId } : {}),
      ...(typeof body.newInstallPublicKey === "string" ? { newInstallPublicKey: body.newInstallPublicKey } : {}),
    };
    try {
      return sendLeaseJson(res, 200, { ok: true, challenge: licenseLeases.challenge(token, input) });
    } catch (err) { return leaseError(res, err); }
  }

  async function leaseOperation(
    req: IncomingMessage,
    res: ServerResponse,
    purpose: LeasePurpose,
  ): Promise<void> {
    if (!licenseLeases) return sendLeaseJson(res, 503, { ok: false, error: "machine-bound lease service is unavailable" });
    const token = leaseBearer(req);
    if (!token) return sendLeaseJson(res, 401, { ok: false, error: "x-license is required" });
    const body = await readJsonBody(req);
    if (body === null || typeof body.nonce !== "string" || typeof body.signature !== "string") {
      return sendLeaseJson(res, 400, { ok: false, error: "expected {nonce, signature}" });
    }
    try {
      const result = purpose === "activate"
        ? licenseLeases.activate(token, body.nonce, body.signature)
        : purpose === "renew"
          ? licenseLeases.renew(token, body.nonce, body.signature)
          : purpose === "deactivate"
            ? licenseLeases.deactivate(token, body.nonce, body.signature)
            : typeof body.newSignature === "string"
              ? licenseLeases.rebind(token, body.nonce, body.signature, body.newSignature)
              : (() => { throw new Error("rebind requires newSignature"); })();
      return sendLeaseJson(res, 200, { ok: true, ...result });
    } catch (err) { return leaseError(res, err); }
  }

  // ── community Strat gallery ───────────────────────────────────────────────
  //
  // AUTH IS THE LICENCE, and identity comes from the VERIFIED payload rather
  // than anything in the body. That is the feedback.ts rule ("name from the
  // VERIFIED token payload, never the body") and it matters more here, because
  // this surface can DELETE. The bot sends an `install` string and a free-text
  // `author`; both are display-only and neither may decide who owns what.
  //
  // The token is read from `x-license` (what the bot sends — a header keeps it
  // out of access logs) or from `?key=`, the convention every other keyed route
  // here uses. Accepting both costs one line and means neither side had to
  // move to meet the other. Through `licenseTokenOf`, which is the ONE place
  // that order is decided — see its docstring for why that matters.
  function communityLicense(req: IncomingMessage, url: URL, res: ServerResponse): { id: string } | null {
    const payload = store.decodeGenuine(licenseTokenOf(req, url));
    if (!payload || !store.isKnown(payload.id) || store.isRevoked(payload.id)) {
      sendJson(res, 403, { ok: false, error: "a valid license is required to use the community gallery" });
      return null;
    }
    return { id: payload.id };
  }

  function communityList(req: IncomingMessage, url: URL, res: ServerResponse): void {
    const who = communityLicense(req, url, res);
    if (!who) return;
    sendJson(res, 200, { ok: true, strategies: community.list(who.id) });
  }

  async function communityPublish(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const who = communityLicense(req, url, res);
    if (!who) return;
    const body = await readJsonBody(req, STRAT_BODY_BYTES_MAX);
    if (body === null) return sendJson(res, 400, { ok: false, error: "bad strategy body" });
    const r = community.publish({ licenseId: who.id, name: body.name, desc: body.desc, author: body.author, bots: body.bots });
    sendJson(res, r.ok ? 200 : 400, r);
  }

  async function communityVote(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const who = communityLicense(req, url, res);
    if (!who) return;
    const body = await readJsonBody(req);
    if (body === null) return sendJson(res, 400, { ok: false, error: "bad vote body" });
    sendJson(res, 200, community.vote(body.id, who.id, body.vote));
  }

  async function communityDelete(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const who = communityLicense(req, url, res);
    if (!who) return;
    const body = await readJsonBody(req);
    if (body === null) return sendJson(res, 400, { ok: false, error: "bad delete body" });
    // A wrong owner and an unknown id give the IDENTICAL answer — see
    // CommunityService.deleteOwn. Distinguishing them would confirm the
    // existence of arbitrary ids to anyone holding any valid licence.
    const ok = community.deleteOwn(body.id, who.id);
    sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: "no such strategy of yours" });
  }

  async function feedbackIntake(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req, MAX_FEEDBACK_BODY_BYTES);
    if (body === null) return sendJson(res, 400, { ok: false, error: "bad feedback body" });
    // Auth is the license TOKEN in the body — same credential the bot already
    // holds. Genuine-but-EXPIRED may still file (a lapsed tester reporting a
    // bug is exactly who we want to hear from); unknown or revoked may not.
    const payload = store.decodeGenuine(typeof body.license === "string" ? body.license : "");
    if (!payload) return sendJson(res, 403, { ok: false, error: "a valid license is required to file a report" });
    if (!store.isKnown(payload.id) || store.isRevoked(payload.id)) {
      return sendJson(res, 403, { ok: false, error: "this license is not accepted here" });
    }
    const kind = body.kind;
    if (kind !== "bug" && kind !== "feature") return sendJson(res, 400, { ok: false, error: "kind must be bug or feature" });
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return sendJson(res, 400, { ok: false, error: "an empty report says nothing — describe what happened" });
    const { logs, truncated } = clampLogs(body.logs);
    const rec = appendFeedback(cfg.dataDir, {
      ts: typeof body.ts === "number" ? body.ts : 0,
      ip: clientIp(req),
      licenseId: payload.id,
      name: payload.name,
      installId: typeof body.installId === "string" ? body.installId.slice(0, 64) : "",
      version: typeof body.version === "string" ? body.version.slice(0, 32) : "",
      kind,
      text: text.slice(0, FEEDBACK_TEXT_MAX),
      logs,
      logsTruncated: truncated,
    });
    sendJson(res, 200, { ok: true, id: rec.id });
  }

  /** ── WHERE A LICENCE TOKEN IS READ FROM, AND THERE IS ONE OF THESE ────────
   *
   *  `x-license` FIRST, `?key=` second. The header keeps the token out of
   *  access logs; the query parameter is the convention the curl-facing
   *  endpoints use and is what every already-installed bot sends, so it cannot
   *  be dropped without silently cutting those installs off.
   *
   *  ONE FUNCTION because there were two readings of this idea and they had
   *  already drifted: `communityLicense` read the header and the seed endpoint
   *  did not, so the HEAVIER surface had the weaker handling. A second copy is
   *  how the next surface gets it wrong too.
   *
   *  NOT used by `requireKey`: install.sh and /download are fetched by a bare
   *  `curl` line a human pastes, which has no header to send — and install.sh
   *  additionally SUBSTITUTES `?key=` into the script it returns, so the query
   *  parameter is load-bearing there rather than incidental. */
  function licenseTokenOf(req: IncomingMessage, url: URL): string {
    const header = req.headers["x-license"];
    return String((Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("key") ?? "").trim();
  }

  /** Shared gate for install.sh / latest / download. Sends the 403 itself. */
  function requireKey(url: URL, res: ServerResponse): LicensePayload | null {
    const v = store.verify(url.searchParams.get("key") ?? "");
    if (v.ok) return v.payload;
    // Plain-text 403 (these endpoints feed curl, not a JSON client). The
    // reason is safe to disclose: the caller already holds the token.
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end(`forbidden: license ${v.reason}\n`);
    return null;
  }

  async function installScript(url: URL, res: ServerResponse): Promise<void> {
    if (!requireKey(url, res)) return;
    if (!readLatest()) {
      return sendJson(res, 503, { ok: false, error: "no authenticated release is available" });
    }
    const template = fs.readFileSync(path.join(cfg.templatesDir, "install.sh"), "utf8");
    const script = template
      .replaceAll("__HUB_ORIGIN__", cfg.publicOrigin)
      .replaceAll("__LICENSE_KEY__", url.searchParams.get("key")!)
      .replaceAll("__RELEASE_KEYS_B64U__", Buffer.from(JSON.stringify(cfg.releasePublicKeys), "utf8").toString("base64url"))
      .replaceAll("__RELEASE_MAX_AGE_MS__", String(cfg.releaseMaxAgeMs));
    res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8" });
    res.end(script);
  }

  function readLatest(): SignedReleaseManifest | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(cfg.releasesDir, "latest.json"), "utf8"));
      const manifest = verifyReleaseManifest(raw, {
        publicKeys: cfg.releasePublicKeys,
        now: Date.now(),
        maxAgeMs: cfg.releaseMaxAgeMs,
        channel: cfg.releaseChannel,
        platform: cfg.releasePlatform,
        arch: cfg.releaseArch,
      });
      const artifact = fs.readFileSync(path.join(cfg.releasesDir, manifest.file));
      verifyReleaseArtifact(manifest, artifact);
      return manifest;
    } catch {
      /* fall through */
    }
    return null;
  }

  async function latestMeta(url: URL, res: ServerResponse): Promise<void> {
    if (!requireKey(url, res)) return;
    const latest = readLatest();
    if (!latest) return sendJson(res, 404, { ok: false, error: "no release published" });
    // Additive response: old clients keep reading version/file/sha256; new
    // clients remove the unsigned `ok` envelope and verify every manifest field.
    sendJson(res, 200, { ok: true, ...latest });
  }

  async function download(url: URL, res: ServerResponse): Promise<void> {
    if (!requireKey(url, res)) return;
    let name = decodeURIComponent(url.pathname.slice("/download/".length));
    if (name === "latest") {
      const latest = readLatest();
      if (!latest) return sendJson(res, 404, { ok: false, error: "no release published" });
      name = latest.file;
    }
    // Whitelist, then containment check — belt and braces against traversal.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      return sendJson(res, 404, { ok: false, error: "no such file" });
    }
    const file = path.resolve(cfg.releasesDir, name);
    if (!file.startsWith(path.resolve(cfg.releasesDir) + path.sep)) {
      return sendJson(res, 404, { ok: false, error: "no such file" });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error("not a file");
    } catch {
      return sendJson(res, 404, { ok: false, error: "no such file" });
    }
    res.writeHead(200, {
      "content-type": name.endsWith(".json") ? "application/json" : "application/gzip",
      "content-length": stat.size,
      "content-disposition": `attachment; filename="${name}"`,
    });
    const stream = fs.createReadStream(file);
    stream.pipe(res);
    stream.on("error", () => res.destroy());
  }

  // ── candle seed ───────────────────────────────────────────────────────────
  //
  // GET /api/candles/seed?venue=&symbol=&fromMs=&toMs=  — wire contract v1.
  //
  // AUTH DECISION: this endpoint is KEYED, like every other download surface
  // on this hub. Three reasons. It is a licensed benefit — the whole point is
  // saving a tester the ~12-hour venue warm-up. It is by far the heaviest thing
  // the hub serves, tens of MB per pair-window and gigabytes across a fleet, so
  // an unauthenticated copy of it is an open bandwidth tap. And it costs the
  // bot nothing: it already holds a token and already sends `?key=` for
  // install.sh, /api/latest and /download. Nothing in the licence path is
  // weakened or bypassed — `requireKey` is the same gate, unchanged, and a
  // revoked or expired key is refused here exactly as it is there.
  // HUB_CANDLE_REQUIRE_LICENSE=0 exists for a local test hub only.
  //
  // The 403 here is JSON, unlike the plain-text 403 the curl-facing endpoints
  // send, because this endpoint's client is a JSON parser.
  //
  // THE TOKEN IS READ FROM `x-license` FIRST, and that is the point of this
  // paragraph. A licence in a QUERY STRING is written to every access log it
  // passes through — this hub's, nginx's, and any proxy between — where it
  // outlives the request and is readable by anyone with log access, which is
  // not the same set as "people entitled to a licence". `communityLicense`
  // already reads the header for exactly this reason and says so; the seed
  // endpoint is the heavier of the two surfaces and had the weaker handling.
  //
  // `?key=` IS STILL ACCEPTED, and must be: an install older than the release
  // that starts sending the header has no other way to ask, and a hub upgrade
  // that silently stopped seeding those installs would look like the venue
  // warm-up simply coming back. Accepting both is one line and costs nothing.
  // Header first, so an install sending both is judged on the safer one.
  async function candleSeed(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    if (cfg.candleRequireLicense) {
      const v = store.verify(licenseTokenOf(req, url));
      if (!v.ok) return sendJson(res, 403, { ok: false, error: `license ${v.reason}` });
    }
    const venue = url.searchParams.get("venue") ?? "";
    const symbol = url.searchParams.get("symbol") ?? "";
    if (!isVenueId(venue)) {
      return sendJson(res, 400, { ok: false, error: `unknown venue: ${venue.slice(0, 32)}` });
    }
    // The symbol is a VENUE-NATIVE spelling and becomes a path segment; the
    // store whitelists it too, but rejecting it here keeps the 400/404 split
    // meaningful (malformed request vs. symbol this venue does not list).
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(symbol)) {
      return sendJson(res, 400, { ok: false, error: "symbol must be a venue-native instrument spelling" });
    }
    const rawFrom = url.searchParams.get("fromMs");
    const rawTo = url.searchParams.get("toMs");
    if (rawFrom === null || rawTo === null || !/^\d{1,15}$/.test(rawFrom) || !/^\d{1,15}$/.test(rawTo)) {
      return sendJson(res, 400, { ok: false, error: "fromMs and toMs must be epoch-ms integers" });
    }
    const outcome = candles.seed({ venue, symbol, fromMs: Number(rawFrom), toMs: Number(rawTo) });
    if (!outcome.ok) return sendJson(res, outcome.code, { ok: false, error: outcome.error });

    // The payload's own key order IS the signed canonical order plus `sig`
    // last, so serialising it directly cannot disagree with what was signed.
    const body = Buffer.from(JSON.stringify(outcome.payload), "utf8");
    const wantsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    // A 30-day seed is ~43k rows of mostly-decimal JSON; gzip takes roughly an
    // order of magnitude off it, which is the difference between this being a
    // download and being a problem.
    const bytes = wantsGzip ? gzipSync(body) : body;
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": bytes.length,
      ...(wantsGzip ? { "content-encoding": "gzip" } : {}),
      // Candles are immutable once closed, but `lastClosedMs` advances every
      // minute, so the response is only good for about that long.
      "cache-control": "public, max-age=60",
    });
    res.end(bytes);
  }

  // ── the signed market-cap snapshot ────────────────────────────────────────
  //
  // AUTH IS THE SAME PATTERN THE REST OF THE HUB ALREADY USES, through the same
  // one function: `x-license` (what a bot sends — a header keeps the token out
  // of an access log) or `?key=`. `x-hub-key` is additionally accepted when the
  // operator has configured one, for a hub-hosted console that holds no licence
  // of its own; it is compared CONSTANT-TIME, like the admin token, and an
  // unconfigured hub key can never match (an empty configured secret would
  // otherwise make an empty header a valid credential).
  function marketCapAuthorised(req: IncomingMessage, url: URL): boolean {
    const configured = cfg.marketCap?.hubKey ?? "";
    const offered = String(req.headers["x-hub-key"] ?? "");
    if (configured && offered && sameSecret(offered, configured)) return true;
    return store.verify(licenseTokenOf(req, url)).ok;
  }

  async function marketCapSnapshot(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    if (!marketCaps) {
      return sendJson(res, 503, { ok: false, error: "the market-cap producer is not configured on this hub" });
    }
    if (!marketCapAuthorised(req, url)) {
      return sendJson(res, 403, { ok: false, error: "a valid license is required for the market-cap snapshot" });
    }
    const current = marketCaps.snapshot();
    // NEVER A 200 WITH AN EMPTY PAYLOAD, for the reason the candle seed never
    // answers 200 with empty rows: "I have nothing yet" and "there is nothing"
    // would become the same answer, and a consumer cannot tell a cold producer
    // from a universe with no pairs in it.
    if (!current) {
      return sendJson(res, 503, { ok: false, error: "no market-cap snapshot has been produced yet" });
    }
    const inm = String(req.headers["if-none-match"] ?? "");
    if (inm && inm.split(",").some((t) => t.trim() === current.etag)) {
      res.writeHead(304, { etag: current.etag, "cache-control": "public, max-age=60" });
      return void res.end();
    }
    const wantsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    const bytes = wantsGzip ? gzipSync(current.body) : current.body;
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": bytes.length,
      ...(wantsGzip ? { "content-encoding": "gzip" } : {}),
      etag: current.etag,
      // Caps refresh hourly and the payload carries its own `expiresAt`; a
      // minute of caching costs nothing and takes the repeat-poll load off.
      "cache-control": "public, max-age=60",
    });
    res.end(bytes);
  }

  // ── admin surface ─────────────────────────────────────────────────────────

  function adminPage(res: ServerResponse): void {
    // The page itself is served without auth — it contains no secrets, only
    // the JS that prompts for the token and sends it per-request.
    const html = fs.readFileSync(path.join(cfg.publicDir, "admin.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  }

  function adminAuthorized(req: IncomingMessage): boolean {
    if (!cfg.adminToken) return false;
    return sameSecret(String(req.headers["x-hub-admin"] ?? ""), cfg.adminToken);
  }

  async function adminApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!cfg.adminToken) {
      return sendJson(res, 503, { ok: false, error: "admin disabled: HUB_ADMIN_TOKEN is not set" });
    }
    if (!adminAuthorized(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
    const m = req.method ?? "GET";
    const p = url.pathname;

    if (m === "GET" && p === "/admin/api/licenses") {
      const roster = readRoster(cfg.dataDir);
      // Reported, never enforced — see `sharingSignals`. The roster is
      // last-write-wins per licence, so two installs sharing a key overwrite
      // each other there and nothing looks wrong; the ledger is where the
      // second one is visible.
      const sharing = sharingSignals(cfg.dataDir);
      const licenses = store.list().map((l) => ({
        ...l, lastSeen: roster[l.id] ?? null, sharing: sharing[l.id] ?? null,
      }));
      return sendJson(res, 200, { ok: true, origin: cfg.publicOrigin, licenses });
    }
    if (m === "POST" && p === "/admin/api/licenses") {
      const body = await readJsonBody(req);
      if (body === null || typeof body.name !== "string" || typeof body.days !== "number") {
        return sendJson(res, 400, { ok: false, error: "expected {name, days}" });
      }
      let issued;
      try {
        issued = store.issue(body.name, body.days);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: (err as Error).message });
      }
      return sendJson(res, 200, {
        ok: true,
        license: issued.payload,
        token: issued.token,
        installCommand: `curl -fsS "${cfg.publicOrigin}/install.sh?key=${issued.token}" | sudo bash`,
      });
    }
    if (m === "GET" && p === "/admin/api/license-leases") {
      if (!licenseLeases) return sendLeaseJson(res, 503, { ok: false, error: "machine-bound lease service is unavailable" });
      const licenseId = url.searchParams.get("licenseId") || undefined;
      return sendLeaseJson(res, 200, { ok: true, ...licenseLeases.adminSnapshot(licenseId) });
    }
    if (m === "GET" && p === "/admin/api/operations") {
      return sendJson(res, 200, { ok: true, ...operationsStatus(true) }, { "cache-control": "no-store" });
    }
    if (m === "GET" && p === "/admin/api/marketplace-status") {
      const config = cfg.marketplaceStatus ?? marketplaceStatusBridgeFromEnv({});
      const status = await fetchMarketplaceStatus(config, marketplaceStatusFetch);
      return sendJson(res, 200, { ok: true, marketplace: status }, { "cache-control": "no-store" });
    }
    if (m === "POST" && p === "/admin/api/license-leases/seat-override") {
      if (!licenseLeases) return sendLeaseJson(res, 503, { ok: false, error: "machine-bound lease service is unavailable" });
      const body = await readJsonBody(req);
      if (body === null || typeof body.licenseId !== "string"
        || !(body.maxMachines === null || typeof body.maxMachines === "number")
        || typeof body.expectedAuditRevision !== "number"
        || typeof body.reason !== "string") {
        return sendLeaseJson(res, 400, { ok: false, error: "expected {licenseId, maxMachines:number|null, expectedAuditRevision, reason}" });
      }
      try {
        licenseLeases.setSeatOverride(body.licenseId, body.maxMachines, body.reason, body.expectedAuditRevision);
        return sendLeaseJson(res, 200, { ok: true, ...licenseLeases.adminSnapshot(body.licenseId) });
      } catch (err) { return leaseError(res, err); }
    }
    if (m === "POST" && p === "/admin/api/license-leases/deactivate") {
      if (!licenseLeases) return sendLeaseJson(res, 503, { ok: false, error: "machine-bound lease service is unavailable" });
      const body = await readJsonBody(req);
      if (body === null || typeof body.licenseId !== "string"
        || typeof body.activationId !== "string" || typeof body.expectedRevision !== "number"
        || typeof body.reason !== "string") {
        return sendLeaseJson(res, 400, { ok: false, error: "expected {licenseId, activationId, expectedRevision, reason}" });
      }
      try {
        return sendLeaseJson(res, 200, { ok: true,
          activation: licenseLeases.adminDeactivate(body.licenseId, body.activationId, body.expectedRevision, body.reason) });
      } catch (err) { return leaseError(res, err); }
    }
    if (m === "POST" && p === "/admin/api/upgrade") {
      // The detached runner refuses dirty/wrong-branch source, fetches and
      // fast-forwards exactly to origin/main, verifies HEAD, then invokes the
      // installer without putting paths or credentials through a shell.
      const prior = readUpgradeStatus(cfg.dataDir);
      if (upgradeStartedAt && (prior.state === "failed" || prior.state === "succeeded")) upgradeStartedAt = 0;
      if (upgradeStartedAt || ((prior.state === "queued" || prior.state === "running")
        && prior.startedAtMs !== null && Date.now() - prior.startedAtMs < 30 * 60_000)) {
        return sendJson(res, 409, { ok: false, error: "an upgrade is already running — the hub will restart when it finishes" });
      }
      upgradeStartedAt = Date.now();
      const build = readBuildRecord(cfg.dataDir, HUB_VERSION);
      writeUpgradeStatus(cfg.dataDir, {
        state: "queued", startedAtMs: upgradeStartedAt, completedAtMs: null,
        fromCommit: build.commit, targetCommit: null,
        message: "Upgrade queued; waiting for the detached origin/main verifier.",
      });
      const entry = typeof process.argv[1] === "string" ? path.resolve(process.argv[1]) : path.join(process.cwd(), "dist/src/main.js");
      const runner = path.resolve(path.dirname(entry), "../bin/upgrade-runner.js");
      try {
        const child = spawn(
          "systemd-run",
          ["--unit", `wickhunter-hub-upgrade-${Date.now()}`, "--collect", process.execPath, runner,
            "--source", cfg.srcDir, "--data", cfg.dataDir],
          { stdio: "ignore", detached: true },
        );
        child.on("error", (err) => {
          writeUpgradeStatus(cfg.dataDir, {
            state: "failed", startedAtMs: upgradeStartedAt || Date.now(), completedAtMs: Date.now(),
            fromCommit: build.commit, targetCommit: null,
            message: `The detached upgrade process could not start: ${err.message}`.slice(0, 1_000),
          });
          upgradeStartedAt = 0;
        });
        child.on("exit", (code) => {
          if (code === 0 || code === null) return;
          const latest = readUpgradeStatus(cfg.dataDir);
          if (latest.state !== "queued") return;
          writeUpgradeStatus(cfg.dataDir, {
            state: "failed", startedAtMs: upgradeStartedAt || Date.now(), completedAtMs: Date.now(),
            fromCommit: build.commit, targetCommit: null,
            message: `systemd-run exited ${code} before the verified upgrade worker started.`,
          });
          upgradeStartedAt = 0;
        });
        child.unref();
      } catch {
        writeUpgradeStatus(cfg.dataDir, {
          state: "failed", startedAtMs: upgradeStartedAt, completedAtMs: Date.now(),
          fromCommit: build.commit, targetCommit: null,
          message: "The detached upgrade process could not be started.",
        });
        upgradeStartedAt = 0;
        return sendJson(res, 500, { ok: false, error: "could not start the upgrade (systemd-run unavailable?)" });
      }
      return sendJson(res, 200, {
        ok: true,
        version: HUB_VERSION,
        note: "upgrade queued — origin/main will be fetched, verified, installed, and recorded in the Hub operations panel",
      });
    }
    // Per-exchange collector status: one card per venue on the admin page.
    // Venues with no collector configured are included and say so — a card of
    // zeroes would be indistinguishable from a collector that is running and
    // has collected nothing, which is the opposite diagnosis.
    if (m === "GET" && p === "/admin/api/candles") {
      // PUBLIC halves only. Nothing on this route, on the admin page or in any
      // log line ever carries private key material — see license.ts's rule,
      // which candles/key.ts follows.
      let seedPublicKey: string | null = null;
      try {
        // The key that is signing seeds RIGHT NOW — it follows the switch, so
        // this is always the one a client must verify today's payloads with.
        seedPublicKey = cfg.candleSigner === "candle"
          ? candleKey.publicKeyRawB64u()
          : store.publicKeyRawB64u();
      } catch { seedPublicKey = null; }
      let candlePublicKey: string | null = null;
      // The dedicated key is shown whether or not it is in use: rollout step
      // (b) is "paste this into the bot" and happens BEFORE the switch flips.
      try { candlePublicKey = candleKey.publicKeyRawB64u(); } catch { candlePublicKey = null; }
      return sendJson(res, 200, {
        ok: true,
        enabled: candles.enabled,
        keyId: cfg.candleKeyId,
        signer: cfg.candleSigner,
        requiresLicense: cfg.candleRequireLicense,
        retentionDays: cfg.candleOptions.retentionDays,
        seedPublicKey,
        candleKeyId: CANDLE_KEY_ID,
        candlePublicKey,
        venues: candles.status(),
      });
    }
    if (m === "GET" && p === "/admin/api/feedback") {
      // Table view: everything EXCEPT the logs (they can be hundreds of KB
      // per report) — the export carries those.
      const reports = listFeedback(cfg.dataDir)
        .sort((a, b) => b.at - a.at)
        .map(({ logs, ...rest }) => ({ ...rest, logLines: logs.length }));
      return sendJson(res, 200, { ok: true, reports });
    }
    if (m === "POST" && p === "/admin/api/feedback/status") {
      const body = await readJsonBody(req);
      if (
        body === null || typeof body.id !== "string" || !body.id ||
        typeof body.status !== "string" || !FEEDBACK_STATUSES.includes(body.status as FeedbackStatus)
      ) {
        return sendJson(res, 400, { ok: false, error: "expected {id, status: new|discussing|fixed}" });
      }
      if (!setFeedbackStatus(cfg.dataDir, body.id, body.status as FeedbackStatus)) {
        return sendJson(res, 404, { ok: false, error: "unknown report id" });
      }
      return sendJson(res, 200, { ok: true });
    }
    if (m === "POST" && p === "/admin/api/feedback/delete") {
      // Accepts one id or many, so "clear every fixed report" is one call
      // rather than a loop of requests each rewriting the file.
      const body = await readJsonBody(req);
      const ids: unknown = body === null ? null : Array.isArray(body.ids) ? body.ids : body.id;
      const list = (Array.isArray(ids) ? ids : [ids]).filter((x): x is string => typeof x === "string" && !!x);
      if (list.length === 0) {
        return sendJson(res, 400, { ok: false, error: "expected {id} or {ids: [...]}" });
      }
      const removed = deleteFeedback(cfg.dataDir, list);
      // An id that matched nothing is a 404, not a quiet success: the admin
      // page would otherwise drop a row that is still on disk.
      if (removed === 0) return sendJson(res, 404, { ok: false, error: "no such report id" });
      return sendJson(res, 200, { ok: true, removed });
    }
    if (m === "GET" && p === "/admin/api/feedback/export") {
      // The whole set, LOGS INCLUDED — the file the operator hands to their
      // assistant for triage. Attachment headers so the browser downloads it.
      const reports = listFeedback(cfg.dataDir).sort((a, b) => b.at - a.at);
      const bytes = Buffer.from(JSON.stringify({ exportedAt: Date.now(), hubVersion: HUB_VERSION, reports }, null, 2));
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": bytes.length,
        "content-disposition": `attachment; filename="wickhunter-feedback-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      return void res.end(bytes);
    }
    if (m === "GET" && p === "/admin/api/licenses/command") {
      const id = url.searchParams.get("id") ?? "";
      const token = id ? store.tokenFor(id) : null;
      if (!token) return sendJson(res, 404, { ok: false, error: "unknown or revoked license id" });
      return sendJson(res, 200, {
        ok: true,
        installCommand: `curl -fsS "${cfg.publicOrigin}/install.sh?key=${token}" | sudo bash`,
      });
    }
    // ── CHANGE AN ISSUED LICENSE'S EXPIRY ──────────────────────────────────
    // Returns the re-minted install command alongside the updated record,
    // because the two are inseparable: `exp` is inside the SIGNED payload and
    // the bot checks it offline, so the new date does nothing until the tester
    // installs this command. The check-in answers `revoked` and `latest` and
    // carries no expiry at all. The admin page prints that, and the field name
    // `installCommand` is the same one `/licenses/command` returns so the page
    // renders it through the same path.
    if (m === "POST" && p === "/admin/api/licenses/expiry") {
      const body = await readJsonBody(req);
      if (body === null || typeof body.id !== "string" || !body.id || typeof body.exp !== "number") {
        return sendJson(res, 400, { ok: false, error: "expected {id, exp} with exp a unix-ms timestamp" });
      }
      let payload;
      try { payload = store.setExpiry(body.id, body.exp); }
      catch (e) { return sendJson(res, 400, { ok: false, error: (e as Error).message }); }
      if (!payload) return sendJson(res, 404, { ok: false, error: "unknown or revoked license id" });
      const token = store.tokenFor(body.id);
      return sendJson(res, 200, {
        ok: true,
        exp: payload.exp,
        installCommand: token ? `curl -fsS "${cfg.publicOrigin}/install.sh?key=${token}" | sudo bash` : null,
      });
    }
    if (m === "GET" && p === "/admin/api/flags") {
      return sendJson(res, 200, { ok: true, flags: readFlags(cfg.dataDir) });
    }
    if (m === "POST" && p === "/admin/api/flags") {
      const body = await readJsonBody(req);
      // `id` is a licence id, or the literal "default" for everyone. `state`
      // is true / false / null — false is how ONE tester is excluded from a
      // default, null removes the entry and falls back to it.
      if (
        body === null ||
        typeof body.id !== "string" || !body.id ||
        typeof body.flag !== "string" || !body.flag ||
        !(body.state === true || body.state === false || body.state === null)
      ) {
        return sendJson(res, 400, { ok: false, error: "expected {id, flag, state: true|false|null}" });
      }
      // A flag name is echoed straight into a JSON file and then into every
      // check-in reply, so it is length-capped and charset-restricted here
      // rather than trusted. The BOT ignores names it does not know, which is
      // the real protection; this is the hygiene that keeps the file readable.
      if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(body.flag)) {
        return sendJson(res, 400, { ok: false, error: "flag names are letters, digits and underscores, max 40 chars" });
      }
      // v0.2.12 — REFUSED, not silently dropped. `setFlag` also guards these
      // (see src/flags.ts on why `__proto__` is not an ordinary key here), but
      // a guard that returns the file unchanged would answer 200 and report
      // "nothing happened" — which is exactly how the original defect stayed
      // invisible. The FLAG name needs the same treatment: the charset rule
      // above excludes `__proto__` (it starts with an underscore) but not
      // `constructor` or `prototype`.
      if (isUnsafeKey(body.id) || isUnsafeKey(body.flag)) {
        const bad = isUnsafeKey(body.id) ? `licence id "${body.id}"` : `flag name "${body.flag}"`;
        return sendJson(res, 400, { ok: false, error: `${bad} is not usable — it collides with a JavaScript object member` });
      }
      const file = setFlag(cfg.dataDir, body.id.slice(0, 64), body.flag, body.state);
      return sendJson(res, 200, { ok: true, flags: file });
    }
    // ── market-cap producer health ──────────────────────────────────────────
    // CREDIT CONSUMPTION IS EXPOSED, because a budget nobody can see is a
    // budget nobody manages. Admin-gated: it names the venues, the slugs, the
    // spend and the refusals. It carries NO key material and no snapshot rows
    // — the snapshot itself has its own licensed route.
    if (m === "GET" && p === "/admin/api/market-caps") {
      if (!marketCaps) {
        // configured:false, never a row of zeroes — zeroes read as a working
        // producer that has found nothing, which is the opposite diagnosis.
        return sendJson(res, 200, {
          ok: true,
          configured: false,
          venues: cfg.marketCap?.venues ?? [],
          // Named so the panel can say WHICH piece is missing rather than
          // "not configured", which sends the operator to read source.
          refusals: cfg.marketCap ? marketCapStartupRefusals(cfg.marketCap) : [],
        });
      }
      return sendJson(res, 200, { ok: true, configured: true, health: marketCaps.health() });
    }
    if (m === "POST" && p === "/admin/api/licenses/revoke") {
      const body = await readJsonBody(req);
      if (body === null || typeof body.id !== "string" || !body.id) {
        return sendJson(res, 400, { ok: false, error: "expected {id}" });
      }
      if (!store.revoke(body.id)) return sendJson(res, 404, { ok: false, error: "unknown license id" });
      try { licenseLeases?.observeRevocation(body.id, "license revoked by Hub administrator"); }
      catch (err) { console.warn(`[license-lease] could not audit revocation ${body.id}: ${(err as Error).message}`); }
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  }

  return {
    server,
    store,
    candles,
    marketCaps,
    candleKey,
    licenseLeases,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(cfg.port, cfg.host, () => {
          server.removeListener("error", reject);
          // Collectors start only once the hub is actually serving, so a hub
          // that cannot bind never begins hammering three exchanges.
          candles.start();
          // Same rule as the collectors: the producer starts only once the hub
          // is actually serving, so a hub that cannot bind never spends a
          // credit.
          marketCaps?.start();
          resolve((server.address() as AddressInfo).port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        candles.stop();
        marketCaps?.stop();
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

// ── plumbing ────────────────────────────────────────────────────────────────

function pathOf(req: IncomingMessage): string {
  // Log-safe request path: strip the query, which may carry a license key.
  return (req.url ?? "/").split("?")[0]!;
}

function clientIp(req: IncomingMessage): string {
  // Behind the VPS nginx the socket peer is 127.0.0.1; the snippet we ship
  // sets X-Forwarded-For to $remote_addr (a single hop, so first value wins).
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/** Constant-time secret comparison. ONE implementation, because there are now
 *  two shared secrets on this server (the admin token and the market-data hub
 *  key) and a second copy is where the next one gets a `===`.
 *
 *  Hashing both sides first is what lets `timingSafeEqual` see equal lengths,
 *  so the compare leaks nothing about the secret's length or its bytes. */
function sameSecret(given: string, want: string): boolean {
  if (!want) return false; // an unconfigured secret can never be matched
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    ...extraHeaders,
  });
  res.end(bytes);
}

/** Read a JSON object body; null on any malformation (caller answers 400). */
function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
