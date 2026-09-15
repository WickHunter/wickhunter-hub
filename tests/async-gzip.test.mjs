import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { AsyncGzipQueue, GzipCapacityError } from "../dist/src/async-gzip.js";
import { CandleStore, MINUTE_MS } from "../dist/src/candles/store.js";
import { freshHub, test, summary } from "./helpers.mjs";

await test("async gzip round-trips bytes", async () => {
  const queue = new AsyncGzipQueue();
  const reservation = queue.reserve();
  assert.ok(reservation);
  const input = Buffer.from("decimal candle rows ".repeat(1_000));
  const zipped = await reservation.compress(input);
  assert.deepEqual(gunzipSync(zipped), input);
  assert.deepEqual(queue.status, { active: 0, queued: 0, jobs: 0, retainedBytes: 0 });
});

await test("only two jobs run and completing one promotes the queued job", async () => {
  const callbacks = [];
  const queue = new AsyncGzipQueue({
    maxActive: 2, maxJobs: 3, maxRetainedBytes: 100,
    gzip: (input, callback) => callbacks.push({ input, callback }),
  });
  const reservations = [queue.reserve(), queue.reserve(), queue.reserve()];
  assert.ok(reservations.every(Boolean));
  const promises = reservations.map((reservation, i) => reservation.compress(Buffer.from(`job-${i}`)));
  assert.equal(callbacks.length, 2, "two worker jobs start");
  assert.deepEqual(queue.status, { active: 2, queued: 1, jobs: 3, retainedBytes: 15 });

  callbacks[0].callback(null, Buffer.from("done-0"));
  assert.equal((await promises[0]).toString(), "done-0");
  assert.equal(callbacks.length, 3, "the queued job starts as capacity opens");
  callbacks[1].callback(null, Buffer.from("done-1"));
  callbacks[2].callback(null, Buffer.from("done-2"));
  await Promise.all(promises.slice(1));
  assert.deepEqual(queue.status, { active: 0, queued: 0, jobs: 0, retainedBytes: 0 });
});

await test("failure and byte overflow release all capacity", async () => {
  let callback;
  const queue = new AsyncGzipQueue({
    maxActive: 1, maxJobs: 1, maxRetainedBytes: 5,
    gzip: (_input, cb) => { callback = cb; },
  });
  const failed = queue.reserve();
  const failure = failed.compress(Buffer.from("12345"));
  callback(new Error("worker failed"));
  await assert.rejects(failure, /worker failed/);
  const afterFailure = queue.reserve();
  assert.ok(afterFailure, "a worker error releases the job slot");
  afterFailure.release();

  const overflowQueue = new AsyncGzipQueue({ maxActive: 1, maxJobs: 1, maxRetainedBytes: 4 });
  const overflow = overflowQueue.reserve();
  await assert.rejects(overflow.compress(Buffer.from("12345")), GzipCapacityError);
  assert.deepEqual(overflowQueue.status, { active: 0, queued: 0, jobs: 0, retainedBytes: 0 });
  const afterOverflow = overflowQueue.reserve();
  assert.ok(afterOverflow, "byte-cap refusal releases the job slot");
  afterOverflow.release();
});

await test("health stays responsive and excess gzip gets Retry-After while compression is pending", async () => {
  const pending = [];
  const h = await freshHub({}, {
    responseGzip: (input, callback) => pending.push({ input, callback }),
    responseGzipLimits: { maxActive: 1, maxJobs: 1, maxRetainedBytes: 1024 * 1024 },
  });
  const waitFor = async (condition) => {
    const deadline = Date.now() + 2_000;
    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    const token = h.store.issue("Async Gzip", 30).token;
    const start = Date.parse("2026-09-01T00:00:00.000Z");
    new CandleStore(`${h.dataDir}/candles`).write("bitget", "BTCUSDT", [
      { openMs: start, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    ]);
    const url = `${h.origin}/api/candles/seed?venue=bitget&symbol=BTCUSDT&fromMs=${start}&toMs=${start}&key=${token}`;
    const first = fetch(url, { headers: { "accept-encoding": "gzip" } });
    await waitFor(() => pending.length === 1);
    assert.equal(pending.length, 1, "the first response is waiting on compression");

    const healthStarted = Date.now();
    const health = await fetch(`${h.origin}/api/health`);
    assert.equal(health.status, 200);
    assert.ok(Date.now() - healthStarted < 500, "health does not wait behind response compression");

    const excess = await fetch(url, { headers: { "accept-encoding": "gzip" } });
    assert.equal(excess.status, 503);
    assert.equal(excess.headers.get("retry-after"), "1");
    assert.match((await excess.json()).error, /compression is busy/);

    pending[0].callback(null, gzipSync(pending[0].input));
    const completed = await first;
    assert.equal(completed.status, 200);
    assert.equal(completed.headers.get("content-encoding"), "gzip");
    assert.equal((await completed.json()).rows.length, 1);

    const originalSeed = h.candles.seed.bind(h.candles);
    h.candles.seed = () => { throw new Error("forced seed failure"); };
    const failed = await fetch(url, { headers: { "accept-encoding": "gzip" } });
    assert.equal(failed.status, 500, "the route reports an unexpected pre-compression failure");
    h.candles.seed = originalSeed;

    const recoveredRequest = fetch(url, { headers: { "accept-encoding": "gzip" } });
    await waitFor(() => pending.length === 2);
    assert.equal(pending.length, 2, "the failed builder released its reservation for the next request");
    pending[1].callback(null, gzipSync(pending[1].input));
    assert.equal((await recoveredRequest).status, 200);
  } finally {
    for (const job of pending) job.callback(null, gzipSync(job.input));
    await h.close();
  }
});

summary("async gzip");
