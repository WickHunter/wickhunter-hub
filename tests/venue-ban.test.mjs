// tests/venue-ban.test.mjs — HTTP 418 IS A BAN, NOT A HEAVY 429.
//
// ── the defect this pins shut ───────────────────────────────────────────────
//
// Until v0.2.20 `httpRefusal` folded 418 and 429 into one `RateLimitError`, so
// a 418 bought the rate-limit treatment: halve the rate, go quiet for 60
// seconds (doubling, capped at fifteen minutes), resume. On a Binance-family
// venue — which is what Aster is — that is precisely wrong in the one direction
// that costs something. 429 means "you are going too fast". 418 means "this IP
// is ALREADY BANNED", for a period Aster's own manual gives as **2 minutes to 3
// days**, and the manual is explicit that continuing to send requests is what
// lengthens it. So the old handling resumed inside the ban, on a one-minute
// tick, extending it, for as long as the operator left the service running.
//
// And the admin panel called that COOLING — a state the README tells the
// operator in as many words is "the collector working, not a fault". An IP ban
// looked like health.
//
// The bot repo had already settled this question the other way and written the
// reasoning down (liqhunter `src/venues/rate-limited.ts`, v0.86.80): *"418 is
// deliberately NOT treated as a slow-down: by then the venue is refusing the
// address outright and a caller that reads it as 'retry shortly' would keep
// hammering a ban."* The hub and a bot share one IP whenever they share a box.
// They may not disagree about what a ban is.
//
// ── what each section is worth ─────────────────────────────────────────────
//
//  1. THE CLASSIFICATION, and the inheritance that makes it safe. The ban error
//     still satisfies `isRateLimit`, so no existing caller loses its "stop the
//     pass, do not count this as FAILING" handling. That is also the trap: a
//     collector that asks the WIDER question first classifies every ban as a
//     slow-down. The narrower question must go first, and that ordering is
//     asserted through the collector rather than by reading the source.
//  2. THE WAIT. A ban ladder that tops out where the rate-limit ladder tops out
//     is the old behaviour wearing a new state name.
//  3. THE SILENCE. Total, including the instrument list.
//  4. THE RATE THAT EARNED A BAN IS NOT A RATE TO RETURN TO.
//  5. THE ESCALATION SURVIVES SUCCESS. A ban that expires proves the ban
//     expired; it proves nothing about the cause.
//  6. THE OPERATOR IS TOLD, on the panel, in words that do not read as routine.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, summary, tmpDir } from "./helpers.mjs";
import {
  ADAPTERS, VENUE_IDS, isRateLimit, isVenueBan, RateLimitError, VenueBanError,
  asterBanUntilMs, ASTER_BAN_MIN_MS, ASTER_BAN_MAX_MS,
} from "../dist/src/candles/venues.js";
import { VenueCollector, DEFAULT_COLLECTOR_OPTIONS } from "../dist/src/candles/collector.js";
import { collectorOptionsFromEnv } from "../dist/src/candles/service.js";
import { CandleStore, MINUTE_MS, floorMinute } from "../dist/src/candles/store.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const NOW = 1787004534092;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A response stub at a given status, with optional headers and JSON body. */
function stubStatus(status, body = {}, headers = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
  });
}

// ── 1. THE CLASSIFICATION ───────────────────────────────────────────────────

await test("418 is a BAN on every venue here; 429 is a rate limit and is not a ban", async () => {
  for (const v of VENUE_IDS) {
    const banned = await ADAPTERS[v].fetchKlines(stubStatus(418), "BTCUSDT", 0, 60_000).then(() => null, (e) => e);
    assert.equal(isVenueBan(banned), true, `${v}: 418 is a ban`);
    assert.equal(isRateLimit(banned), true,
      `${v}: and STILL a rate limit by inheritance — every existing caller keeps its "stop the pass" handling`);

    const slow = await ADAPTERS[v].fetchKlines(stubStatus(429), "BTCUSDT", 0, 60_000).then(() => null, (e) => e);
    assert.equal(isRateLimit(slow), true, `${v}: 429 is a rate limit`);
    assert.equal(isVenueBan(slow), false,
      `${v}: and NOT a ban — treating a slow-down as a ban would idle a healthy collector for hours`);
  }
});

await test("418 is a ban even on the three venues that do not document sending one", async () => {
  // Only Aster is Binance-family, so a 418 from Bybit/Bitget/Bitunix is a status
  // we do not understand. The safe reading of a status we do not understand is
  // the one that makes the hub go quiet.
  for (const v of ["bybit", "bitunix", "bitget"]) {
    const err = await ADAPTERS[v].fetchKlines(stubStatus(418), "BTCUSDT", 0, 60_000).then(() => null, (e) => e);
    assert.equal(isVenueBan(err), true, v);
  }
});

await test("the ban message says it is a ban, and says that requests lengthen it", async () => {
  const err = await ADAPTERS.aster.fetchKlines(stubStatus(418), "BTCUSDT", 0, 60_000).then(() => null, (e) => e);
  assert.match(err.message, /BANNED/, "'HTTP 418 (rate limited)' is the sentence that caused the defect");
  assert.match(err.message, /lengthens/i, "the operator reading a log line learns the one rule that matters");
});

await test("a plain Error, a 5xx and an ordinary venue rejection are neither", async () => {
  for (const e of [new Error("ETIMEDOUT"), new RateLimitError("slow down"), null, undefined, "418"]) {
    assert.equal(isVenueBan(e), false, String(e));
  }
  const http502 = await ADAPTERS.aster.fetchKlines(stubStatus(502), "BTCUSDT", 0, 60_000).then(() => null, (e) => e);
  assert.equal(isVenueBan(http502), false);
  assert.equal(isRateLimit(http502), false);
  assert.equal(isVenueBan(new VenueBanError("x")), true, "and the class itself, for callers that construct one");
});

// ── THE ASTER BAN DEADLINE, OFF THE VENUE'S OWN BODY ────────────────────────

await test("`banned until <epoch>` is read out of the venue's own message", () => {
  const at = NOW + 3 * HOUR;
  assert.equal(
    asterBanUntilMs(`Way too many requests; IP(1.2.3.4) banned until ${at}. Please use the websocket.`, NOW),
    at,
  );
  assert.equal(asterBanUntilMs(`banned until ${Math.floor(at / 1000)}`, NOW), Math.floor(at / 1000) * 1000,
    "an epoch in SECONDS is the same instant one factor of 1000 away");
});

await test("anything it cannot read is worthless rather than wrong", () => {
  // NOT verified against a live Aster ban — this box has never been banned by
  // this venue and will not arrange to be. So a body that does not match must
  // leave the collector on its own schedule, never invent a shorter one.
  for (const bad of [undefined, null, 42, "", "banned until soon", "banned until 12",
                     `banned until ${NOW - HOUR}`, `banned until ${NOW + 400 * 24 * HOUR}`]) {
    assert.equal(asterBanUntilMs(bad, NOW), undefined, JSON.stringify(bad));
  }
});

await test("the venue's deadline is taken when it is LONGER than Retry-After, and ignored when shorter", async () => {
  const longer = await ADAPTERS.aster.fetchKlines(
    stubStatus(418, { code: -1003, msg: `banned until ${Date.now() + 6 * HOUR}` }, { "retry-after": "60" }),
    "BTCUSDT", 0, 60_000,
  ).then(() => null, (e) => e);
  assert.ok(longer.retryAfterMs > 5 * HOUR, `body deadline wins: ${longer.retryAfterMs}`);
  assert.match(longer.message, /-1003/, "and the venue's own words survive onto the card");

  const shorter = await ADAPTERS.aster.fetchKlines(
    stubStatus(418, { code: -1003, msg: `banned until ${Date.now() + 60_000}` }, { "retry-after": "7200" }),
    "BTCUSDT", 0, 60_000,
  ).then(() => null, (e) => e);
  assert.equal(shorter.retryAfterMs, 7_200_000,
    "a venue may not talk us into probing its ban early — only the LONGER number is ever taken");
});

await test("an unreadable ban body leaves the refusal exactly as it was", async () => {
  const res = async () => ({ ok: false, status: 418, json: async () => { throw new Error("not json"); },
    headers: { get: (n) => (n === "retry-after" ? "120" : null) } });
  const err = await ADAPTERS.aster.fetchKlines(res, "BTCUSDT", 0, 60_000).then(() => null, (e) => e);
  assert.equal(isVenueBan(err), true, "reading the body cannot fail the classification");
  assert.equal(err.retryAfterMs, 120_000, "and Retry-After still stands on its own");
});

// ── THE COLLECTOR ───────────────────────────────────────────────────────────

function stubVenue({ status = 200, headers = {}, body = null, symbols = ["BTCUSDT"] } = {}) {
  const state = { klineRequests: 0, listRequests: 0, status };
  const fetchLike = async (url) => {
    const hdr = { get: (n) => headers[n.toLowerCase()] ?? null };
    if (url.includes("exchangeInfo")) {
      state.listRequests++;
      if (state.status !== 200 && state.status !== 429 && state.status !== 418) throw new Error("list failed");
      return { ok: true, status: 200, headers: hdr,
        json: async () => ({
          symbols: symbols.map((sym) => ({ symbol: sym, quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" })),
        }) };
    }
    state.klineRequests++;
    if (state.status !== 200) {
      return { ok: false, status: state.status, headers: hdr, json: async () => (body ?? { code: -1003, msg: "banned" }) };
    }
    const u = new URL(url);
    const from = Number(u.searchParams.get("startTime"));
    const to = Number(u.searchParams.get("endTime"));
    const rows = [];
    for (let t = from; t <= to && rows.length < 1000; t += MINUTE_MS) {
      if (t % MINUTE_MS !== 0 || t > floorMinute(NOW)) continue;
      rows.push([t, "100", "102", "99", "101", "5.5", t + MINUTE_MS - 1, "550", 3, "1", "1", "0"]);
    }
    return { ok: true, status: 200, headers: hdr, json: async () => rows };
  };
  return { state, fetchLike };
}

function freshCollector(opts = {}) {
  const dir = tmpDir("ban");
  const store = new CandleStore(`${dir}/candles`);
  return new VenueCollector("aster", store, `${dir}/candles`, { ...DEFAULT_COLLECTOR_OPTIONS, ...opts }, NOW);
}

/** Drive one banned pass and hand back the collector, at a frozen clock. */
async function banOnce(collector, venue, at) {
  const deps = { clock: () => at, sleep: async () => {} };
  await collector.tick(venue.fetchLike, 5, at, deps);
  return collector.health(at);
}

await test("THE ORDERING: a ban reaches BANNED, not COOLING — the narrower question is asked first", async () => {
  // The ban error satisfies `isRateLimit` too (see section 1). A collector that
  // asked the wider question first would land here in `cooling`, which is the
  // exact pre-v0.2.20 behaviour under a new name.
  const c = freshCollector();
  const ok = stubVenue();
  await c.refreshSymbols(ok.fetchLike, NOW);
  const banned = stubVenue({ status: 418 });
  const h = await banOnce(c, banned, NOW);
  assert.equal(h.state, "banned");
  assert.equal(h.bans, 1);
  assert.equal(h.consecutiveFailures, 0, "a ban is not the collector failing; FAILING would bury the reason");
});

await test("a 429 on the same collector still reaches COOLING, and is not counted as a ban", async () => {
  const c = freshCollector();
  const ok = stubVenue();
  await c.refreshSymbols(ok.fetchLike, NOW);
  const h = await banOnce(c, stubVenue({ status: 429 }), NOW);
  assert.equal(h.state, "cooling", "the 429 path is untouched");
  assert.equal(h.bans, 0);
  assert.equal(h.banUntil, null);
});

await test("THE WAIT is the ban ladder, and it goes where the rate-limit ladder cannot", async () => {
  const c = freshCollector();
  const ok = stubVenue();
  await c.refreshSymbols(ok.fetchLike, NOW);
  const banned = stubVenue({ status: 418 });

  const first = await banOnce(c, banned, NOW);
  assert.ok(first.banUntil - NOW >= DEFAULT_COLLECTOR_OPTIONS.banCooldownMs,
    `first ban waits the ban schedule (${first.banUntil - NOW}ms), not the 60s a 429 buys`);
  assert.ok(first.banUntil - NOW >= ASTER_BAN_MIN_MS,
    "and never less than the venue's own documented MINIMUM ban — a shorter wait ends inside every ban there is");

  // Three bans, each after the previous has lapsed.
  let t = first.banUntil + 1;
  let h = await banOnce(c, banned, t);
  t = h.banUntil + 1;
  h = await banOnce(c, banned, t);
  assert.ok(h.banUntil - t > DEFAULT_COLLECTOR_OPTIONS.rateLimitMaxCooldownMs,
    `by the third ban the wait (${Math.round((h.banUntil - t) / MIN)}m) is past anything the RATE-LIMIT ladder can `
    + `ever reach (${DEFAULT_COLLECTOR_OPTIONS.rateLimitMaxCooldownMs / MIN}m) — which is the whole point of a separate schedule`);
  assert.equal(h.bans, 3);
});

await test("the ladder is capped at the venue's documented MAXIMUM ban, not above it", async () => {
  const c = freshCollector();
  await c.refreshSymbols(stubVenue().fetchLike, NOW);
  const banned = stubVenue({ status: 418 });
  let t = NOW;
  let wait = 0;
  for (let i = 0; i < 20; i++) {
    const h = await banOnce(c, banned, t);
    wait = h.banUntil - t;
    t = h.banUntil + 1;
  }
  assert.equal(wait, ASTER_BAN_MAX_MS,
    "twenty bans in, the wait has reached the documented 3-day ceiling and stopped exactly there — "
    + "a schedule that ran past what the venue says it ever bans for would be silence we cannot justify");
});

await test("Retry-After LENGTHENS the ban wait and can never shorten it", async () => {
  const long = freshCollector();
  await long.refreshSymbols(stubVenue().fetchLike, NOW);
  const h = await banOnce(long, stubVenue({ status: 418, headers: { "retry-after": "86400" } }), NOW);
  assert.equal(h.banUntil - NOW, 86_400_000, "the venue named a day; we wait a day");

  const short = freshCollector();
  await short.refreshSymbols(stubVenue().fetchLike, NOW);
  const h2 = await banOnce(short, stubVenue({ status: 418, headers: { "retry-after": "5" } }), NOW);
  assert.equal(h2.banUntil - NOW, DEFAULT_COLLECTOR_OPTIONS.banCooldownMs,
    "five seconds is not a ban wait; the schedule stands");
});

// ── 3. THE SILENCE ──────────────────────────────────────────────────────────

await test("a banned collector says NOTHING to the venue — not even the instrument list", async () => {
  // A one-minute symbol cadence so the instrument list is genuinely DUE inside
  // the ban window — otherwise "no list request" would prove only that nothing
  // asked for one.
  const c = freshCollector({ symbolRefreshMs: MIN });
  const ok = stubVenue();
  await c.refreshSymbols(ok.fetchLike, NOW);
  const banned = stubVenue({ status: 418 });
  const first = await banOnce(c, banned, NOW);
  const before = { k: banned.state.klineRequests, l: banned.state.listRequests };

  const later = NOW + 5 * MIN;
  assert.ok(later < first.banUntil, "the probe instant is INSIDE the ban");
  const r = await c.tick(banned.fetchLike, 50, later, { clock: () => later, sleep: async () => {} });
  assert.equal(r.requests, 0);
  assert.equal(banned.state.klineRequests, before.k, "no kline request");
  assert.equal(banned.state.listRequests, before.l,
    "and no instrument list either — the list is a request too, and it is the request that lengthens the ban");
  assert.equal(c.health(later).state, "banned");
});

await test("once the ban lapses the collector resumes, and the ban is still on the record", async () => {
  const c = freshCollector();
  const ok = stubVenue();
  await c.refreshSymbols(ok.fetchLike, NOW);
  const h = await banOnce(c, stubVenue({ status: 418 }), NOW);
  const after = h.banUntil + MIN;
  const r = await c.tick(ok.fetchLike, 5, after, { clock: () => after, sleep: async () => {} });
  assert.ok(r.requests > 0, "it does start again — a ban is a wait, not an abandonment");
  const back = c.health(after);
  assert.equal(back.banUntil, null);
  assert.equal(back.bans, 1,
    "the COUNT stays after the state clears: an expired ban otherwise leaves no trace at exactly the moment "
    + "nobody would think to look for one");
});

// ── 4. THE RATE THAT EARNED A BAN ───────────────────────────────────────────

await test("a ban drops the rate to the FLOOR and halves the CEILING it may climb back to", async () => {
  const c = freshCollector({ requestsPerSecond: 4, minRequestsPerSecond: 0.5 });
  await c.refreshSymbols(stubVenue().fetchLike, NOW);
  assert.equal(c.health(NOW).ceilingRps, 4);
  const h = await banOnce(c, stubVenue({ status: 418 }), NOW);
  assert.equal(h.effectiveRps, 0.5, "to the floor — a ban is not evidence we were slightly too fast");
  assert.equal(h.ceilingRps, 2, "and the ceiling halves, so the creep-back cannot return to the banned rate");
  assert.equal(h.configuredRps, 4, "the CONFIGURED number is unchanged and still shown, so the drop is visible");
});

await test("the creep-back respects the lowered ceiling, however long the clean run", async () => {
  // `noteSuccess` only steps the rate up after RATE_RECOVER_AFTER_SUCCESSES
  // clean requests, so this needs a real clean run — a dozen symbols with a
  // one-minute tail cadence, several hundred successful requests. That is the
  // point: the mutation this catches (creeping toward `opts.requestsPerSecond`
  // instead of the lowered `ceilingRps`) only shows up AFTER a long clean run,
  // which is exactly the situation an operator would call recovered.
  const syms = Array.from({ length: 12 }, (_, i) => `SYM${i}USDT`);
  const c = freshCollector({
    requestsPerSecond: 0.8, minRequestsPerSecond: 0.5, tailFillMinutes: 1, symbolRefreshMs: 1e12,
  });
  const ok = stubVenue({ symbols: syms });
  await c.refreshSymbols(ok.fetchLike, NOW);
  assert.equal(c.health(NOW).ceilingRps, 0.8);

  const h = await banOnce(c, stubVenue({ status: 418, symbols: syms }), NOW);
  assert.equal(h.ceilingRps, 0.5, "halved, then floored at minRequestsPerSecond");

  let t = h.banUntil + MIN;
  let requests = 0;
  for (let i = 0; i < 30; i++) {
    requests += (await c.tick(ok.fetchLike, 60, t, { clock: () => t, sleep: async () => {} })).requests;
    t += 2 * MIN;
  }
  const done = c.health(t);
  assert.ok(requests > 400, `a genuinely long clean run (${requests} successful requests)`);
  assert.equal(done.state, "running");
  assert.ok(done.effectiveRps <= done.ceilingRps + 1e-9,
    `crept to ${done.effectiveRps}/s against a lowered ceiling of ${done.ceilingRps}/s`);
  assert.ok(done.effectiveRps < 0.8 - 1e-9,
    "hundreds of clean requests must not walk the collector back to the rate that got it banned — "
    + "the ban is the evidence that rate was wrong, and a success proves only that the ban expired");
});

// ── 5. THE ESCALATION SURVIVES SUCCESS ──────────────────────────────────────

await test("a successful pass does NOT reset the ban escalation", async () => {
  // A ban expiring proves the ban expired. It says nothing about whether the
  // cause was fixed — and if the escalation reset, a hub whose rate is wrong
  // would sit in a 15-minute loop forever, banned, resuming, banned.
  const c = freshCollector();
  const ok = stubVenue();
  await c.refreshSymbols(ok.fetchLike, NOW);
  const banned = stubVenue({ status: 418 });

  const first = await banOnce(c, banned, NOW);
  const firstWait = first.banUntil - NOW;

  let t = first.banUntil + MIN;
  await c.tick(ok.fetchLike, 5, t, { clock: () => t, sleep: async () => {} });
  assert.equal(c.health(t).state, "running", "a clean pass in between");

  t += MIN;
  const second = await banOnce(c, banned, t);
  assert.ok(second.banUntil - t > firstWait,
    `the second ban waits longer (${Math.round((second.banUntil - t) / MIN)}m) than the first `
    + `(${Math.round(firstWait / MIN)}m) despite the success in between`);
});

await test("a 429 arriving under an active ban cannot shorten it", async () => {
  // Unreachable today — a banned collector sends nothing, so it cannot collect a
  // 429. Written anyway: that assignment used to be unconditional, and the day
  // some path issues a request during a ban is not the day to find out the
  // request also cancelled the ban.
  const c = freshCollector();
  await c.refreshSymbols(stubVenue().fetchLike, NOW);
  const h = await banOnce(c, stubVenue({ status: 418 }), NOW);
  const before = h.banUntil;
  // Reach past the tick's own silence check straight into the classifier.
  await c.tick(stubVenue({ status: 429 }).fetchLike, 5, NOW, { clock: () => NOW, sleep: async () => {} });
  assert.equal(c.health(NOW).banUntil, before, "the ban deadline is a floor on the silence, never a target");
});

// ── 6. THE OPERATOR IS TOLD ─────────────────────────────────────────────────

await test("BANNED outranks COOLING, STALLED and FAILING on the card", async () => {
  const c = freshCollector({ failingAfter: 1 });
  await c.refreshSymbols(stubVenue().fetchLike, NOW);
  // Bank some ordinary failures first, so FAILING would otherwise win.
  const broken = stubVenue({ status: 500 });
  await c.tick(broken.fetchLike, 5, NOW, { clock: () => NOW, sleep: async () => {} });
  const h = await banOnce(c, stubVenue({ status: 418 }), NOW + 1);
  assert.equal(h.state, "banned",
    "FAILING is normally the most actionable thing to say; a ban is more actionable still, and has a different fix");
  // Hours later, long past the stall ceiling, still banned rather than STALLED.
  const late = h.banUntil - MIN;
  assert.equal(c.health(late).state, "banned");
});

await test("the detail names the ban, the wait, the lowered ceiling and what to do", async () => {
  const c = freshCollector();
  await c.refreshSymbols(stubVenue().fetchLike, NOW);
  const h = await banOnce(c, stubVenue({ status: 418 }), NOW);
  assert.match(h.detail, /418/);
  assert.match(h.detail, /BANNED/);
  assert.match(h.detail, /lengthens it/i, "the one rule an operator must not guess at");
  assert.match(h.detail, /NOT the collector working/i,
    "COOLING reads as routine and this must not; the card has to say which it is");
  assert.match(h.detail, /restart/i, "and how to clear the escalation once the cause is dealt with");
});

await test("the SHIPPED admin page can render BANNED and reads the two new fields", () => {
  // A state the server can emit and the page cannot draw is a state nobody sees.
  const page = fs.readFileSync(path.join(ROOT, "public", "admin.html"), "utf8");
  assert.match(page, /\.v-banned\s*\{/, "the badge has its own rule, so BANNED is not an unstyled word");
  assert.ok(!/\.v-banned\s*\{[^}]*\}/.exec(page)[0].includes("#59c"),
    "and it is NOT the cooling blue — the two states call for opposite responses");
  assert.match(page, /h\.bans/, "the lifetime ban count is on the card");
  assert.match(page, /h\.ceilingRps/, "so is the lowered ceiling, or an operator cannot tell why it never speeds up");
});

// ── THE ENV KNOBS ───────────────────────────────────────────────────────────

await test("the ban schedule has its OWN env knobs, not the rate-limit ones", () => {
  const o = collectorOptionsFromEnv({ HUB_CANDLE_COOLDOWN_MS: "1000", HUB_CANDLE_MAX_COOLDOWN_MS: "2000" });
  assert.equal(o.rateLimitCooldownMs, 1000);
  assert.equal(o.banCooldownMs, DEFAULT_COLLECTOR_OPTIONS.banCooldownMs,
    "shortening a rate-limit backoff is reasonable and must not silently shorten how long a ban is waited out");
  assert.equal(o.banMaxCooldownMs, DEFAULT_COLLECTOR_OPTIONS.banMaxCooldownMs);
});

await test("the ban wait may be LENGTHENED by env and may not be shortened below the documented minimum", () => {
  const longer = collectorOptionsFromEnv({ HUB_CANDLE_BAN_COOLDOWN_MS: String(2 * HOUR) });
  assert.equal(longer.banCooldownMs, 2 * HOUR);
  assert.ok(longer.banMaxCooldownMs >= 2 * HOUR, "and the ceiling cannot end up below the first wait");

  const tooShort = collectorOptionsFromEnv({ HUB_CANDLE_BAN_COOLDOWN_MS: "1000" });
  assert.equal(tooShort.banCooldownMs, ASTER_BAN_MIN_MS,
    "a wait under the venue's own minimum ban is not a ban wait at all — floored, not obeyed");
});

summary("venue-ban");
