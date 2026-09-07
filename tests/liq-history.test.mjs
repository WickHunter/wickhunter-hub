// tests/liq-history.test.mjs — the durable liquidation-print archive: day
// rollover, buffered flush, retention pruning, and a torn final line after a
// crash losing nothing before it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, summary, tmpDir } from "./helpers.mjs";
import { LiqHistory } from "../dist/src/liq/history.js";

const DAY_MS = 86_400_000;
const DAY0 = Date.parse("2026-01-01T00:00:00Z");

function row(ts, symbol = "BTCUSDT", src = "bybit-usdt") {
  return { ts, src, symbol, side: "long", price: 65_000, sizeUsd: 1_000 };
}

await test("record() buffers; nothing on disk until flush()", () => {
  const dir = tmpDir("liq-history");
  const h = new LiqHistory(dir, 60);
  h.record(row(DAY0));
  assert.deepEqual(h.days(), [], "buffered rows are not yet on disk");
  h.flush();
  const days = h.days();
  assert.equal(days.length, 1);
  assert.equal(days[0].day, "2026-01-01");
  assert.equal(days[0].events, 1);
});

await test("rows split across UTC day boundaries into separate files", () => {
  const dir = tmpDir("liq-history");
  const h = new LiqHistory(dir, 60);
  h.record(row(DAY0));
  h.record(row(DAY0 + DAY_MS));
  h.record(row(DAY0 + DAY_MS + 1_000));
  h.flush();
  const days = h.days();
  assert.equal(days.length, 2, "two distinct UTC days");
  const byDay = Object.fromEntries(days.map((d) => [d.day, d.events]));
  assert.equal(byDay["2026-01-01"], 1);
  assert.equal(byDay["2026-01-02"], 2);
});

await test("days() is newest-first", () => {
  const dir = tmpDir("liq-history");
  const h = new LiqHistory(dir, 60);
  h.record(row(DAY0));
  h.record(row(DAY0 + 3 * DAY_MS));
  h.record(row(DAY0 + DAY_MS));
  h.flush();
  const order = h.days().map((d) => d.day);
  assert.deepEqual(order, ["2026-01-04", "2026-01-02", "2026-01-01"]);
});

await test("a burst past 500 buffered rows flushes on its own", () => {
  const dir = tmpDir("liq-history");
  const h = new LiqHistory(dir, 60);
  for (let i = 0; i < 500; i++) h.record(row(DAY0 + i));
  const days = h.days();
  assert.equal(days.length, 1);
  assert.equal(days[0].events, 500, "the burst threshold flushed without an explicit flush() call");
});

await test("read() parses a day's rows and skips a malformed line", () => {
  const dir = tmpDir("liq-history");
  const h = new LiqHistory(dir, 60);
  h.record(row(DAY0, "BTCUSDT"));
  h.record(row(DAY0 + 1, "ETHUSDT"));
  h.flush();
  fs.appendFileSync(path.join(dir, "2026-01-01.jsonl"), "not json\n");
  const rows = h.read("2026-01-01");
  assert.equal(rows.length, 2, "the malformed line is skipped, not fatal");
  assert.equal(rows[0].symbol, "BTCUSDT");
  assert.equal(rows[1].symbol, "ETHUSDT");
});

await test("read() of an absent day answers empty, never throws", () => {
  const dir = tmpDir("liq-history");
  const h = new LiqHistory(dir, 60);
  assert.deepEqual(h.read("2099-01-01"), []);
});

await test("prune() removes only day files strictly older than retention, and never a foreign file", () => {
  const dir = tmpDir("liq-history");
  const h = new LiqHistory(dir, 2); // 2-day retention
  const now = DAY0 + 10 * DAY_MS;
  h.record(row(now - 5 * DAY_MS)); // well outside the window
  h.record(row(now - 1 * DAY_MS)); // inside
  h.record(row(now));              // inside (today)
  h.flush();
  fs.writeFileSync(path.join(dir, "notes.txt"), "leave me alone");
  const removed = h.prune(now);
  assert.equal(removed, 1);
  const remainingDays = h.days().map((d) => d.day).sort();
  assert.deepEqual(remainingDays, [
    new Date(now - DAY_MS).toISOString().slice(0, 10),
    new Date(now).toISOString().slice(0, 10),
  ].sort());
  assert.ok(fs.existsSync(path.join(dir, "notes.txt")), "a file that is not a day file is never touched");
});

await test("flush() on an empty buffer is a no-op, and record() never throws", () => {
  const dir = tmpDir("liq-history");
  const h = new LiqHistory(dir, 60);
  assert.doesNotThrow(() => h.flush());
  assert.doesNotThrow(() => h.record(row(DAY0)));
});

summary("liq-history");
