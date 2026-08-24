// tests/marketcap-http.test.mjs
// THE SERVED SURFACE: GET /api/market-data/market-caps/v1.
//
// Same auth pattern as every other keyed route here — `x-license` or `?key=`,
// through the ONE `licenseTokenOf` that server.ts already has, plus an optional
// `x-hub-key` shared secret compared constant-time. And the same refusal
// discipline as the candle seed: never a 200 with an empty payload, because
// "I have nothing yet" and "there is nothing" must not be one answer.
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { generateKeyPairSync } from "node:crypto";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";
import { DEFAULT_EXCHANGE_SLUGS, DAY_MS, HOUR_MS } from "../dist/src/marketcap/service.js";
import { verifySnapshot } from "../dist/src/marketcap/snapshot.js";

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: { get: () => null } });

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIV_B64U = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).toString("base64url");
const PUB_B64U = (() => {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64url");
})();

const marketCapCfg = (over = {}) => ({
  venues: ["bybit"],
  slugs: { ...DEFAULT_EXCHANGE_SLUGS },
  apiKey: "test-key",
  coingeckoApiKey: "",
  signingKeyB64u: PRIV_B64U,
  signingKeyId: "market-data-1",
  hubKey: "",
  monthlyCeiling: 15_000,
  requestsPerMinute: 50,
  mappingIntervalMs: DAY_MS,
  capIntervalMs: HOUR_MS,
  tickMs: 30_000,
  ttlMs: 3 * HOUR_MS,
  snapshotFile: "",
  overridesFile: "",
  ledgerFile: "",
  quoteBatchSize: 100,
  ...over,
});

const stubHttp = async (url) => {
  const u = new URL(url);
  if (u.pathname === "/v5/exchange/derivatives/list") {
    // The verified shape: data.exchanges[], keyed exchange_id / exchange_slug.
    return json({
      status: { error_code: 0 },
      data: { exchanges: Number(u.searchParams.get("start")) === 1 ? [{ exchange_id: 521, exchange_slug: "bybit", exchange_name: "Bybit", num_market_pairs: 743 }] : [] },
    });
  }
  if (u.pathname === "/v5/exchange/derivatives/market-pairs/list/latest") {
    const first = Number(u.searchParams.get("start")) === 1;
    return json({
      status: { error_code: 0 },
      data: {
        num_market_pairs: 1,
        market_pairs: first
          ? [{ market_pair: "BTC/USDT", market_pair_base: { exchange_symbol: "BTC", crypto_id: 1, currency_symbol: "BTC", currency_name: "Bitcoin" }, market_pair_quote: { exchange_symbol: "USDT" } }]
          : [],
      },
    });
  }
  if (u.pathname === "/v2/cryptocurrency/quotes/latest") {
    return json({
      status: { error_code: 0 },
      data: { 1: { id: 1, symbol: "BTC", name: "Bitcoin", circulating_supply: 19_800_000, is_market_cap_included_in_calc: 1, quote: { USD: { price: 65_000, market_cap: 1_287_000_000_000, last_updated: iso(NOW - 20_000) } } } },
    });
  }
  return json({ status: { error_code: 400 } }, 400);
};

const stubVenue = async () => json({
  result: {
    list: [{ symbol: "BTCUSDT", baseCoin: "BTC", quoteCoin: "USDT", settleCoin: "USDT", status: "Trading", contractType: "LinearPerpetual" }],
    nextPageCursor: "",
  },
});

async function hubWithProducer(cfgOver = {}) {
  const h = await freshHub(
    { marketCap: marketCapCfg(cfgOver) },
    { marketCapHttp: stubHttp, marketCapVenueFetch: stubVenue, marketCapSleep: async () => {}, marketCapNow: () => NOW },
  );
  // The snapshot/ledger paths default to the hub's own data dir when the env
  // does not name one — the same state root everything else here lives in.
  return h;
}

/** A hub cfg carries no file paths in these fixtures, so point them at the
 *  suite's own temp data dir before the service is built. */
function withPaths(dataDir, over = {}) {
  return { ...over, snapshotFile: `${dataDir}/snap.json`, overridesFile: `${dataDir}/ovr.json`, ledgerFile: `${dataDir}/led.json` };
}

const issue = async (h, name = "Tester") => {
  const r = await jsonReq(`${h.origin}/admin/api/licenses`, {
    method: "POST", headers: { "x-hub-admin": "test-admin-token" }, body: JSON.stringify({ name, days: 30 }),
  });
  assert.equal(r.status, 200);
  return r.body.token;
};

// ── 1. the producer is off ──────────────────────────────────────────────────

await test("a hub with no producer answers 503 — not an empty 200", async () => {
  const h = await freshHub();
  const token = await issue(h);
  const r = await jsonReq(`${h.origin}/api/market-data/market-caps/v1`, { headers: { "x-license": token } });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /not configured/);
  await h.close();
});

// ── 2. auth ─────────────────────────────────────────────────────────────────

await test("the snapshot is licensed: no token, no snapshot", async () => {
  const tmp = await freshHub();
  await tmp.close();
  const h = await hubWithProducer(withPaths(tmp.dataDir));
  const token = await issue(h);
  await h.hub.marketCaps.tick();

  assert.equal((await jsonReq(`${h.origin}/api/market-data/market-caps/v1`)).status, 403);
  assert.equal((await jsonReq(`${h.origin}/api/market-data/market-caps/v1`, { headers: { "x-license": "LHK1.nonsense.nonsense" } })).status, 403);
  // Header AND query, exactly like the candle seed: an install older than the
  // release that starts sending the header has no other way to ask.
  assert.equal((await jsonReq(`${h.origin}/api/market-data/market-caps/v1`, { headers: { "x-license": token } })).status, 200);
  assert.equal((await jsonReq(`${h.origin}/api/market-data/market-caps/v1?key=${encodeURIComponent(token)}`)).status, 200);
  await h.close();
});

await test("x-hub-key is accepted only when one is configured, and never when empty", async () => {
  const tmp = await freshHub();
  await tmp.close();
  const h = await hubWithProducer(withPaths(tmp.dataDir, { hubKey: "s3cret-console-key" }));
  await h.hub.marketCaps.tick();
  assert.equal((await jsonReq(`${h.origin}/api/market-data/market-caps/v1`, { headers: { "x-hub-key": "s3cret-console-key" } })).status, 200);
  assert.equal((await jsonReq(`${h.origin}/api/market-data/market-caps/v1`, { headers: { "x-hub-key": "wrong" } })).status, 403);
  // An empty offered key against an empty configured one must NOT match — that
  // is how an unconfigured secret becomes a valid credential.
  assert.equal((await jsonReq(`${h.origin}/api/market-data/market-caps/v1`, { headers: { "x-hub-key": "" } })).status, 403);
  await h.close();
});

// ── 3. the payload, ETag and gzip ───────────────────────────────────────────

await test("the served payload verifies against the pinned key", async () => {
  const tmp = await freshHub();
  await tmp.close();
  const h = await hubWithProducer(withPaths(tmp.dataDir));
  const token = await issue(h);
  await h.hub.marketCaps.tick();

  const res = await fetch(`${h.origin}/api/market-data/market-caps/v1`, { headers: { "x-license": token } });
  const body = JSON.parse(await res.text());
  assert.equal(body.v, 1);
  assert.equal(body.kind, "market-caps");
  assert.equal(body.keyId, "market-data-1");
  assert.deepEqual(verifySnapshot(body, { keys: { "market-data-1": PUB_B64U }, now: NOW }), { ok: true });
  assert.equal(body.instruments[0].marketCapUsd, "1287000000000");
  assert.equal(body.coverage.invariantOk, true);
  await h.close();
});

await test("ETag / If-None-Match answers 304 with no body", async () => {
  const tmp = await freshHub();
  await tmp.close();
  const h = await hubWithProducer(withPaths(tmp.dataDir));
  const token = await issue(h);
  await h.hub.marketCaps.tick();

  const first = await fetch(`${h.origin}/api/market-data/market-caps/v1`, { headers: { "x-license": token } });
  const etag = first.headers.get("etag");
  assert.ok(etag, "an ETag is what makes a big snapshot cheap to re-poll");
  const again = await fetch(`${h.origin}/api/market-data/market-caps/v1`, { headers: { "x-license": token, "if-none-match": etag } });
  assert.equal(again.status, 304);
  assert.equal((await again.text()).length, 0);
  // A stale ETag still gets the payload.
  const stale = await fetch(`${h.origin}/api/market-data/market-caps/v1`, { headers: { "x-license": token, "if-none-match": '"something-else"' } });
  assert.equal(stale.status, 200);
  await h.close();
});

await test("gzip is served when asked for, and the bytes are the same JSON", async () => {
  const tmp = await freshHub();
  await tmp.close();
  const h = await hubWithProducer(withPaths(tmp.dataDir));
  const token = await issue(h);
  await h.hub.marketCaps.tick();

  // `fetch` decodes gzip transparently, so the raw response is read through a
  // socket-level request instead — the point is what went ON the wire.
  const res = await fetch(`${h.origin}/api/market-data/market-caps/v1`, {
    headers: { "x-license": token, "accept-encoding": "gzip" },
  });
  assert.equal(res.headers.get("content-encoding"), "gzip");
  const raw = Buffer.from(await res.arrayBuffer());
  // Node's fetch does not decode when the header is set by hand on some
  // versions; accept either, and prove the payload survives the round trip.
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  assert.equal(JSON.parse(text).kind, "market-caps");
  await h.close();
});

// ── 4. a cold producer ──────────────────────────────────────────────────────

await test("a producer that has not produced anything yet answers 503, never an empty 200", async () => {
  const tmp = await freshHub();
  await tmp.close();
  const h = await hubWithProducer(withPaths(tmp.dataDir));
  const token = await issue(h);
  // No tick has run: the producer exists and holds nothing.
  const r = await jsonReq(`${h.origin}/api/market-data/market-caps/v1`, { headers: { "x-license": token } });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /no market-cap snapshot has been produced yet/);
  await h.close();
});

// ── 5. the credit budget is visible ─────────────────────────────────────────

await test("credit consumption is exposed on the admin surface, and is admin-gated", async () => {
  const tmp = await freshHub();
  await tmp.close();
  const h = await hubWithProducer(withPaths(tmp.dataDir));
  await h.hub.marketCaps.tick();

  assert.equal((await jsonReq(`${h.origin}/admin/api/market-caps`)).status, 401, "spend and slugs are not public");
  const r = await jsonReq(`${h.origin}/admin/api/market-caps`, { headers: { "x-hub-admin": "test-admin-token" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.configured, true);
  // A budget nobody can see is a budget nobody manages.
  assert.equal(r.body.health.credits.ceiling, 15_000);
  assert.ok(r.body.health.credits.used > 0);
  assert.equal(r.body.health.slugs.bybit.slug, "bybit");
  assert.equal(r.body.health.slugs.bybit.validated, true, "the slug was checked against the provider's own list");
  assert.equal(JSON.stringify(r.body).includes(PRIV_B64U), false, "no key material anywhere on this surface");
  await h.close();
});

await test("a hub with no producer says configured:false rather than a row of zeroes", async () => {
  const h = await freshHub();
  const r = await jsonReq(`${h.origin}/admin/api/market-caps`, { headers: { "x-hub-admin": "test-admin-token" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.configured, false, "zeroes would read as a working producer that has found nothing");
  await h.close();
});

await test("the admin page carries the producer panel, and it refreshes with the rest", async () => {
  const h = await freshHub();
  const page = await (await fetch(`${h.origin}/admin`)).text();
  assert.match(page, /id="mcbody"/, "a container for the producer panel");
  assert.match(page, /id="mckey"/, "and one for the signing key a client has to pin");
  assert.match(page, /admin\/api\/market-caps/, "wired to the status route");
  // The three things an operator needs when the first live run goes wrong.
  for (const field of ["credits this month", "last refusal", "pending retries", "durable key"]) {
    assert.ok(page.includes(field), `panel states ${field}`);
  }
  // Anchored on the claim rather than the whole line: which OTHER panels the
  // button refreshes is not this test's business.
  const onclick = /document\.getElementById\("refresh"\)\.onclick = \(\) => \{([^}]*)\}/.exec(page);
  assert.ok(onclick && /\bmcRefresh\(\)/.test(onclick[1]), "the page's Refresh button refreshes the producer panel too");
  // A producer that is OFF and one that is configured-but-unable are different
  // states, and the panel must not report the second as the first: from a
  // client's side "configured and unable" looks exactly like a provider outage.
  assert.ok(page.includes("configured but NOT RUNNING"), "the unable state has its own words");
  await h.close();
});

await test("a configured-but-unable producer NAMES the missing piece", async () => {
  const tmp = await freshHub();
  await tmp.close();
  // Venues named, no CMC key: the hub keeps licensing and candle seeding, the
  // producer refuses to start, and the refusal says WHICH piece is missing —
  // "not configured" would send the operator to read source.
  const h = await freshHub(
    { marketCap: marketCapCfg(withPaths(tmp.dataDir, { apiKey: "" })) },
    { marketCapHttp: stubHttp, marketCapVenueFetch: stubVenue, marketCapNow: () => NOW },
  );
  assert.equal(h.hub.marketCaps, null, "an unusable producer is not built at all");
  assert.equal((await jsonReq(`${h.origin}/api/health`)).status, 200, "and the rest of the hub is unaffected");
  const r = await jsonReq(`${h.origin}/admin/api/market-caps`, { headers: { "x-hub-admin": "test-admin-token" } });
  assert.equal(r.body.configured, false);
  assert.ok(r.body.refusals.some((x) => /CMC_PRO_API_KEY is not set/.test(x)), r.body.refusals.join("; "));
  await h.close();
});

await test("the signing key's PUBLIC half is readable from the admin surface", async () => {
  const tmp = await freshHub();
  await tmp.close();
  const h = await hubWithProducer(withPaths(tmp.dataDir));
  const r = await jsonReq(`${h.origin}/admin/api/market-caps`, { headers: { "x-hub-admin": "test-admin-token" } });
  // A client pins BY keyId, so both halves of that pairing are served together.
  // Without this the first deploy produces snapshots that verify nowhere while
  // looking perfectly healthy from the hub's side.
  assert.equal(r.body.health.signing.keyId, "market-data-1");
  assert.equal(r.body.health.signing.publicKey, PUB_B64U);
  assert.equal(JSON.stringify(r.body).includes(PRIV_B64U), false, "and the private half is nowhere on this surface");
  await h.close();
});

summary("marketcap-http");

// ── THE keyId CONTRACT WITH THE BOT ────────────────────────────────────────
// A live operator enabled the producer, it published keyId "market-data-1",
// and EVERY BOT REFUSED EVERY SNAPSHOT: `asset-market-cap.ts` pins exactly one
// entry — "mcap-1" -> the LICENCE public key — and refuses an unknown keyId
// rather than verifying it against a default. The market-cap page then read
// "no snapshot has been read from the hub yet", which is a live feature
// indistinguishable from one nobody switched on.
test("the default signer is the licence key, labelled mcap-1", async () => {
  const { marketCapSigningFromEnv, LICENSE_MARKET_CAP_KEY_ID, MARKET_DATA_KEY_ID } =
    await import("../dist/src/marketcap/config.js");

  // The SHIPPED default — no variable set at all.
  const dflt = marketCapSigningFromEnv({});
  assert.deepStrictEqual(dflt, { signer: "license", keyId: LICENSE_MARKET_CAP_KEY_ID },
    "the default must be the only keyId a shipped bot can verify");
  assert.strictEqual(LICENSE_MARKET_CAP_KEY_ID, "mcap-1",
    "this string is pinned in the bot's MARKET_CAP_KEYS — changing it strands every install");

  // Opting in to the dedicated key gives the other id.
  assert.deepStrictEqual(
    marketCapSigningFromEnv({ MARKET_CAP_SIGNER: "market-data" }),
    { signer: "market-data", keyId: MARKET_DATA_KEY_ID });

  // ⚠ A keyId RESERVED FOR THE OTHER SIGNER IS REFUSED AT STARTUP, not served.
  // A payload signed by one key and labelled another verifies nowhere, and the
  // symptom lands in someone else's process with no hint of the cause.
  assert.throws(() => marketCapSigningFromEnv({ MARKET_DATA_SIGNING_KEY_ID: "market-data-1" }),
    /reserved for MARKET_CAP_SIGNER=market-data/);
  assert.throws(() => marketCapSigningFromEnv({ MARKET_CAP_SIGNER: "market-data", MARKET_DATA_SIGNING_KEY_ID: "mcap-1" }),
    /reserved for MARKET_CAP_SIGNER=license/);
  assert.throws(() => marketCapSigningFromEnv({ MARKET_CAP_SIGNER: "nonsense" }), /MARKET_CAP_SIGNER must be one of/);

  // An unreserved id is the operator's to choose, under either signer.
  assert.strictEqual(marketCapSigningFromEnv({ MARKET_DATA_SIGNING_KEY_ID: "mcap-2" }).keyId, "mcap-2");
});

test("the licence signer needs no private key in the environment", async () => {
  const { marketCapStartupRefusals } = await import("../dist/src/marketcap/config.js");
  const base = { venues: ["bybit"], apiKey: "k", signingKeyId: "mcap-1", signingKeyB64u: "", monthlyCeiling: 10000 };
  // Under the default signer the hub signs with the key it already has, so
  // demanding MARKET_DATA_SIGNING_PRIVATE_KEY_B64U would refuse to start over a
  // variable nobody needs to set.
  assert.deepStrictEqual(marketCapStartupRefusals({ ...base, signer: "license" }), []);
  // The dedicated signer still requires one, and says so by name.
  const refused = marketCapStartupRefusals({ ...base, signer: "market-data" });
  assert.ok(refused.some((r) => /MARKET_DATA_SIGNING_PRIVATE_KEY_B64U/.test(r)), refused.join(" | "));
});
