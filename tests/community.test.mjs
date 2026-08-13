// tests/community.test.mjs — the community Strat gallery, hub side.
//
// A Strat is one or more BOTS under one name ("a liq bot and a hedge bot
// together"). The load-bearing property is not that publishing works — it is
// that IDENTITY COMES FROM THE VERIFIED LICENCE and never from the body,
// because this is the first tester-facing surface with a DESTRUCTIVE
// operation. A client can put anything in a body; it cannot forge a signed
// licence. So the tests that matter here are the ones where a caller LIES.
import assert from "node:assert/strict";
import { freshHub, jsonReq, test, summary } from "./helpers.mjs";

const h = await freshHub();
const alice = h.store.issue("Alice", 30);
const bob = h.store.issue("Bob", 30);
const revoked = h.store.issue("Revoked", 30);
h.store.revoke(revoked.payload.id);

const auth = (t) => ({ "x-license": t.token });
const post = (path, token, body) =>
  jsonReq(`${h.origin}/api/hub/strategies${path}`, { method: "POST", headers: auth(token), body: JSON.stringify(body) });
const list = (token) => jsonReq(`${h.origin}/api/hub/strategies`, { headers: auth(token) });

const combo = {
  name: "Scalp + Hedge",
  desc: "the pair",
  author: "Alice ⚡",
  bots: [
    { type: "bot1", config: { strategy: { levels: [3, 9] } } },
    { type: "bot3", config: { hedge: { activationPct: 2.5 } } },
  ],
};

await test("a licensed install publishes a MULTI-BOT Strat and both bots come back", async () => {
  const r = await post("/publish", alice, combo);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const g = await list(alice);
  assert.equal(g.body.strategies.length, 1);
  const s = g.body.strategies[0];
  assert.equal(s.bots.length, 2, "both bots survive the round trip");
  assert.deepEqual(s.bots.map((b) => b.type), ["bot1", "bot3"]);
  assert.equal(s.bots[1].config.hedge.activationPct, 2.5, "each bot keeps its own config");
  assert.equal(s.mine, true, "the publisher's own row is marked, so the UI can offer Delete");
});

await test("the licenceId is NEVER sent to a client — not the owner's, not a voter's", async () => {
  const g = await list(bob);
  const s = g.body.strategies[0];
  assert.equal("licenseId" in s, false, JSON.stringify(Object.keys(s)));
  assert.equal("votes" in s, false, "raw votes would carry licence ids too");
  assert.equal(s.mine, undefined, "and another licence is not marked as the owner");
});

await test("NO performance figure is served, and nothing stands in its place", async () => {
  const s = (await list(alice)).body.strategies[0];
  for (const k of ["verified", "verifyError", "symbol", "backtest"]) {
    assert.equal(k in s, false, `the gallery must not carry \`${k}\``);
  }
});

await test("an unlicensed, unknown or revoked caller is refused everywhere", async () => {
  const none = await jsonReq(`${h.origin}/api/hub/strategies`, {});
  assert.equal(none.status, 403);
  const bad = await jsonReq(`${h.origin}/api/hub/strategies`, { headers: { "x-license": "LHK1.not.a.token" } });
  assert.equal(bad.status, 403);
  const rev = await jsonReq(`${h.origin}/api/hub/strategies`, { headers: auth(revoked) });
  assert.equal(rev.status, 403, "a revoked licence loses the gallery with everything else");
  const pub = await post("/publish", revoked, combo);
  assert.equal(pub.status, 403);
});

await test("the token may also ride in ?key=, the convention every other keyed route uses", async () => {
  const r = await jsonReq(`${h.origin}/api/hub/strategies?key=${encodeURIComponent(alice.token)}`, {});
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
});

await test("one vote per LICENCE; re-voting replaces and 0 clears", async () => {
  const id = (await list(alice)).body.strategies[0].id;
  await post("/vote", bob, { id, vote: 1 });
  await post("/vote", bob, { id, vote: 1 });
  assert.equal((await list(alice)).body.strategies[0].up, 1, "the same licence cannot stack votes");
  await post("/vote", bob, { id, vote: -1 });
  const flipped = (await list(alice)).body.strategies[0];
  assert.equal(flipped.up, 0);
  assert.equal(flipped.down, 1, "re-voting replaces rather than adding");
  await post("/vote", bob, { id, vote: 0 });
  assert.equal((await list(alice)).body.strategies[0].down, 0, "0 clears");
});

await test("A CLAIMED IDENTITY IN THE BODY DECIDES NOTHING", async () => {
  // The bot sends `install` and a free-text `author`. Neither may gate
  // anything. Bob publishes while claiming to be Alice's install, and must
  // still own only his own row.
  const r = await post("/publish", bob, { ...combo, name: "Bob's", author: "Alice ⚡", install: "alice-box", licenseId: alice.payload.id });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const asAlice = (await list(alice)).body.strategies;
  const bobsRow = asAlice.find((s) => s.name === "Bob's");
  assert.equal(bobsRow.mine, undefined, "a body-claimed licenceId did not transfer ownership");
  assert.equal(bobsRow.author, "Alice ⚡", "…while the free-text author is still shown as written");
});

await test("an author deletes their OWN Strat, and only their own", async () => {
  const bobsId = (await list(bob)).body.strategies.find((s) => s.name === "Bob's").id;
  const notYours = await post("/delete", alice, { id: bobsId });
  assert.equal(notYours.status, 404, "a different licence cannot delete it");
  assert.equal((await list(bob)).body.strategies.some((s) => s.id === bobsId), true, "…and it is still there");

  // A wrong owner and an id that never existed must be INDISTINGUISHABLE, or
  // the hub confirms which ids exist to anyone holding any valid licence.
  const ghost = await post("/delete", alice, { id: "s-never-existed" });
  assert.equal(ghost.status, notYours.status);
  assert.deepEqual(ghost.body, notYours.body);

  const mine = await post("/delete", bob, { id: bobsId });
  assert.equal(mine.body.ok, true);
  assert.equal((await list(bob)).body.strategies.some((s) => s.id === bobsId), false, "gone from the gallery");
  // HARD delete, unlike moderation's tombstone: the author asked for it gone,
  // so their config must not survive on our disk.
  const again = await post("/delete", bob, { id: bobsId });
  assert.equal(again.status, 404, "and it does not linger as a hidden row");
});

await test("caps are enforced HERE, whatever the bot claims to cap", async () => {
  const many = { ...combo, name: "Too many", bots: Array.from({ length: 11 }, () => ({ type: "grid", config: {} })) };
  assert.equal((await post("/publish", alice, many)).body.ok, false);
  const nameless = await post("/publish", alice, { ...combo, name: "   " });
  assert.equal(nameless.body.ok, false);
  const noBots = await post("/publish", alice, { ...combo, name: "Empty", bots: [] });
  assert.equal(noBots.body.ok, false);
  const unknown = await post("/publish", alice, { ...combo, name: "Odd", bots: [{ type: "nope", config: {} }] });
  assert.equal(unknown.body.ok, false);
  assert.match(unknown.body.error, /Bot 1/, "the refusal names WHICH bot");
  // One cap for the whole Strat: ten bots each just under a per-bot ceiling is
  // the same storage problem the ceiling exists to stop.
  const fat = { ...combo, name: "Fat", bots: Array.from({ length: 5 }, () => ({ type: "grid", config: { blob: "x".repeat(40_000) } })) };
  assert.equal((await post("/publish", alice, fat)).body.ok, false);
});

await test("republishing the same name REPLACES that licence's own row and keeps its votes", async () => {
  const before = (await list(alice)).body.strategies.find((s) => s.name === "Scalp + Hedge");
  await post("/vote", bob, { id: before.id, vote: 1 });
  const r = await post("/publish", alice, { ...combo, bots: [{ type: "bot1", config: { strategy: { levels: [5] } } }] });
  assert.equal(r.body.id, before.id, "same id — an improved version is one action, not litter");
  const after = (await list(alice)).body.strategies.find((s) => s.name === "Scalp + Hedge");
  assert.equal(after.bots.length, 1, "the new bot list took");
  assert.equal(after.up, 1, "votes survive a republish");
});

// The hub holds an open listener; every suite here closes it before
// summarising, or the process never exits.
await h.close();
summary();
