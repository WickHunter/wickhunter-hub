// src/server.ts
// The hub's HTTP server: node:http, no framework, no runtime dependencies.
//
// Surfaces, outermost first:
//   public   GET  /api/health                    liveness + version
//   keyed    POST /api/license/checkin           bot phone-home; answers revoked
//   keyed    GET  /install.sh?key=<token>        templated tester installer
//   keyed    GET  /api/latest?key=<token>        release metadata (version/file/sha256)
//   keyed    GET  /download/<file>?key=<token>   beta tarballs ("latest" resolves)
//   admin    GET  /admin                         static admin page (auth lives in its API calls)
//   admin    GET  /admin/api/licenses            list with last-seen
//   admin    POST /admin/api/licenses            issue {name, days} -> token
//   admin    POST /admin/api/licenses/revoke     {id}
//
// "keyed" = a valid, unexpired, unrevoked LHK1 token in ?key=. "admin" = the
// HUB_ADMIN_TOKEN in an x-hub-admin header, compared constant-time. No
// sessions, no cookies anywhere.
//
// SECRETS IN URLS: download/install keys ride in the query string by design
// (curl-pasteable), so this file must never log a raw req.url — log the
// pathname only. The nginx snippet the installer emits does not add an access
// log for /hub/ either; if the operator turns one on, that is on them.
import fs from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { recordCheckin, readRoster } from "./checkins.js";
import type { HubConfig } from "./config.js";
import { LicenseStore, type LicensePayload } from "./license.js";
import { HUB_VERSION } from "./version.js";

const MAX_BODY_BYTES = 64 * 1024; // largest legitimate body is a tiny JSON object

export interface Hub {
  server: http.Server;
  store: LicenseStore;
  /** Bind cfg.host:cfg.port (port 0 ok for tests); resolves to the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

interface LatestJson {
  version: string;
  file: string;
  sha256: string;
}

export function createHub(cfg: HubConfig): Hub {
  const store = new LicenseStore(cfg.dataDir);

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
      return sendJson(res, 200, { ok: true, version: HUB_VERSION });
    }
    if (m === "POST" && p === "/api/license/checkin") return checkin(req, res);
    if (m === "GET" && p === "/install.sh") return installScript(url, res);
    if (m === "GET" && p === "/api/latest") return latestMeta(url, res);
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
    sendJson(res, 200, revoked ? { ok: true, revoked: true } : { ok: true });
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
    const template = fs.readFileSync(path.join(cfg.templatesDir, "install.sh"), "utf8");
    const script = template
      .replaceAll("__HUB_ORIGIN__", cfg.publicOrigin)
      .replaceAll("__LICENSE_KEY__", url.searchParams.get("key")!);
    res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8" });
    res.end(script);
  }

  function readLatest(): LatestJson | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(cfg.releasesDir, "latest.json"), "utf8"));
      if (typeof raw.version === "string" && typeof raw.file === "string" && typeof raw.sha256 === "string") {
        return raw as LatestJson;
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  async function latestMeta(url: URL, res: ServerResponse): Promise<void> {
    if (!requireKey(url, res)) return;
    const latest = readLatest();
    if (!latest) return sendJson(res, 404, { ok: false, error: "no release published" });
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
    // Hash both sides so timingSafeEqual gets equal lengths and the compare
    // leaks nothing about the token's length or bytes.
    const given = createHash("sha256").update(String(req.headers["x-hub-admin"] ?? "")).digest();
    const want = createHash("sha256").update(cfg.adminToken).digest();
    return timingSafeEqual(given, want);
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
      const licenses = store.list().map((l) => ({ ...l, lastSeen: roster[l.id] ?? null }));
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
    if (m === "POST" && p === "/admin/api/licenses/revoke") {
      const body = await readJsonBody(req);
      if (body === null || typeof body.id !== "string" || !body.id) {
        return sendJson(res, 400, { ok: false, error: "expected {id}" });
      }
      if (!store.revoke(body.id)) return sendJson(res, 404, { ok: false, error: "unknown license id" });
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  }

  return {
    server,
    store,
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(cfg.port, cfg.host, () => {
          server.removeListener("error", reject);
          resolve((server.address() as AddressInfo).port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length });
  res.end(bytes);
}

/** Read a JSON object body; null on any malformation (caller answers 400). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
