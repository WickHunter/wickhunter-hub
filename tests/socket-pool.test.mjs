import assert from "node:assert/strict";
import { test, summary } from "./helpers.mjs";
import { SocketPool } from "../dist/src/net/socket-pool.js";

const adapter = { id: "probe", url: "wss://example.invalid", maxTopicsPerConnection: 10,
  subscribeFrames: (symbols) => [{ op: "subscribe", symbols }] };
const fakeSockets = () => {
  const made = [];
  const socket = (_url, h) => {
    const s = { h, sent: [], closes: 0, send: (v) => s.sent.push(v), close: () => { s.closes++; } };
    made.push(s); return s;
  };
  return { made, socket };
};

await test("an error-only failed handshake closes once and reconnects once", async () => {
  const { made, socket } = fakeSockets(); let messages = 0, discards = 0;
  const pool = new SocketPool({ adapter, symbols: () => ["BTCUSDT"], makeExtra: () => ({}),
    onMessage: () => { messages++; }, onDiscard: () => { discards++; }, socket,
    reconnectMs: 4, reconnectMaxMs: 4, connectTimeoutMs: 1000 });
  pool.start(); const failed = made[0];
  failed.h.onError(new Error("non-101"));
  assert.equal(failed.closes, 1, "the failed socket is actively retired");
  assert.equal(pool.status().open, 0, "failure cannot leave opened=true");
  failed.h.onClose(1006);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(made.length, 2, "error plus later close schedules only one replacement");
  assert.equal(discards, 1, "attempt state is discarded once");
  failed.h.onMessage("late"); failed.h.onOpen();
  assert.equal(messages, 0, "callbacks from the retired generation cannot act");
  assert.equal(pool.status().open, 0, "a retired open callback cannot mark the replacement live");
  made[1].h.onOpen();
  assert.equal(pool.status().open, 1);
  pool.stop();
});

await test("a hanging handshake times out into the same bounded reconnect path", async () => {
  const { made, socket } = fakeSockets();
  const pool = new SocketPool({ adapter, symbols: () => ["BTCUSDT"], makeExtra: () => ({}),
    onMessage: () => {}, socket, reconnectMs: 4, reconnectMaxMs: 4, connectTimeoutMs: 5 });
  pool.start();
  await new Promise((r) => setTimeout(r, 18));
  assert.ok(made.length >= 2, "a socket that never opens cannot hold the slot forever");
  assert.equal(made[0].closes, 1, "timeout retires the hanging socket");
  assert.equal(pool.connections.length, 1, "retries reuse one bounded connection record");
  pool.stop();
});

summary("socket-pool");
