//! RED acceptance tests for product-v3 REQ-K-2 (candles): the pure OHLCV
//! aggregation and the query parsing. A naive in-test oracle reimplements the
//! REQ's bucket/window semantics independently of the module.
//!
//! RED on today's tree: `aggregateCandles` is a stub returning `[]` and
//! `parseCandlesQuery` returns null for everything — every assertion below
//! fails behaviourally (non-empty oracle vs [] / null), never on compile.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CandleView } from "fructus-sdk/src/api.js";
import type { FillRow } from "../src/db.js";
import { CANDLE_INTERVAL_MS, aggregateCandles, parseCandlesQuery } from "../src/market-data.js";

// --- deterministic xorshift64 (repo house style) ----------------------------

let seed = 0x9e3779b97f4a7c15n;
function rng(): number {
  seed ^= seed << 13n;
  seed ^= seed >> 7n;
  seed ^= seed << 17n;
  seed &= 0xffff_ffff_ffff_ffffn;
  return Number(seed % 1_000_000_000n);
}
const pick = (n: number): number => Number(BigInt(rng()) % BigInt(n));

// --- fixtures + the independent oracle --------------------------------------

function fill(seq: number, timeMs: number | null, price: bigint, size: bigint): FillRow {
  return {
    seq,
    slot: 100 + seq,
    market: "M",
    owner: "O",
    side: seq % 2,
    price: price.toString(),
    size: size.toString(),
    timeMs,
  };
}

/** Naive REQ-K-2 reimplementation: bucket, first/last by seq, compact window. */
function oracle(fills: FillRow[], intervalMs: number, limit: number): CandleView[] {
  const timed = fills
    .filter((f) => f.timeMs !== null && f.timeMs !== undefined)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  if (timed.length === 0) return [];
  interface Acc {
    open: bigint;
    high: bigint;
    low: bigint;
    close: bigint;
    volume: bigint;
    trades: number;
  }
  const buckets = new Map<number, Acc>();
  for (const f of timed) {
    const bucket = Math.floor((f.timeMs as number) / intervalMs) * intervalMs;
    const price = BigInt(f.price);
    const size = BigInt(f.size);
    const acc = buckets.get(bucket);
    if (acc === undefined) {
      buckets.set(bucket, { open: price, high: price, low: price, close: price, volume: size, trades: 1 });
    } else {
      if (price > acc.high) acc.high = price;
      if (price < acc.low) acc.low = price;
      acc.close = price;
      acc.volume += size;
      acc.trades += 1;
    }
  }
  const maxBucket = Math.max(...buckets.keys());
  const floor = maxBucket - (limit - 1) * intervalMs;
  return [...buckets.entries()]
    .filter(([time]) => time >= floor)
    .sort((a, b) => a[0] - b[0])
    .map(([time, acc]) => ({
      timeMs: String(time),
      open: acc.open.toString(),
      high: acc.high.toString(),
      low: acc.low.toString(),
      close: acc.close.toString(),
      volume: acc.volume.toString(),
      trades: acc.trades,
    }));
}

// ---------------------------------------------------------------------------

test("CANDLES-BUCKET-AND-OHLC: per-bucket open/high/low/close/volume/trades equal an independently computed grouping of the generated fills", () => {
  // Concrete micro-case pinned first: three fills, two buckets, a boundary.
  const micro = [
    fill(1, 119_000, 10n, 1n),
    fill(2, 119_999, 12n, 2n),
    fill(3, 120_000, 11n, 3n),
  ];
  assert.deepEqual(aggregateCandles(micro, 60_000, 1_000), [
    { timeMs: "60000", open: "10", high: "12", low: "10", close: "12", volume: "3", trades: 2 },
    { timeMs: "120000", open: "11", high: "11", low: "11", close: "11", volume: "3", trades: 1 },
  ]);

  // Sweep: random fills across interval edges, both directions of price.
  const intervals = Object.values(CANDLE_INTERVAL_MS);
  const base = 1_700_000_000_000;
  for (let iteration = 0; iteration < 60; iteration++) {
    const intervalMs = intervals[pick(intervals.length)];
    const count = 1 + pick(40);
    const fills: FillRow[] = [];
    for (let i = 1; i <= count; i++) {
      const bucket = pick(6);
      const inBucket = pick(intervalMs);
      // Sometimes land exactly on the bucket edge.
      const offset = pick(4) === 0 ? 0 : inBucket;
      fills.push(fill(i, base + bucket * intervalMs + offset, BigInt(1 + pick(1_000_000)), BigInt(1 + pick(1_000_000))));
    }
    const expected = oracle(fills, intervalMs, 1_000);
    assert.ok(expected.length >= 1, "generator sanity: at least one timed fill");
    assert.deepEqual(
      aggregateCandles(fills, intervalMs, 1_000),
      expected,
      `aggregation must equal the grouping oracle (interval ${intervalMs}, ${count} fills)`,
    );
  }
});

test("CANDLES-COMPACT-ASCENDING-WINDOWED: the array is ascending, holds only non-empty buckets, never exceeds limit, never contains a bucket below B_max − (limit−1)×intervalMs, and its last bucket is B_max", () => {
  const intervalMs = 60_000;
  const base = 1_700_000_000_000;

  for (let iteration = 0; iteration < 40; iteration++) {
    const buckets = 2 + pick(8);
    const limit = 1 + pick(5);
    const fills: FillRow[] = [];
    let seq = 1;
    for (let b = 0; b < buckets; b++) {
      const trades = 1 + pick(4);
      for (let j = 0; j < trades; j++) {
        fills.push(fill(seq++, base + b * intervalMs + pick(intervalMs), BigInt(1 + pick(1_000)), 1n));
      }
    }
    const candles = aggregateCandles(fills, intervalMs, limit);

    assert.ok(candles.length <= limit, `at most limit buckets — got ${candles.length} for limit ${limit}`);
    assert.deepEqual(candles, oracle(fills, intervalMs, limit), "must equal the windowed oracle");

    for (let i = 1; i < candles.length; i++) {
      assert.ok(
        Number(candles[i - 1].timeMs) < Number(candles[i].timeMs),
        `candles must be strictly ascending by timeMs — got ${candles.map((c) => c.timeMs).join(",")}`,
      );
    }
    const maxBucket = Math.max(...fills.map((f) => Math.floor((f.timeMs as number) / intervalMs) * intervalMs));
    if (candles.length > 0) {
      assert.equal(
        Number(candles[candles.length - 1].timeMs),
        maxBucket,
        "the last bucket must be the latest fill's bucket",
      );
      assert.ok(
        Number(candles[0].timeMs) >= maxBucket - (limit - 1) * intervalMs,
        "no bucket below the window floor",
      );
      for (const candle of candles) {
        assert.ok(candle.trades >= 1, "only non-empty buckets are served");
        assert.equal(Number(candle.timeMs) % intervalMs, 0, "bucket starts are interval multiples");
      }
    }
  }

  // Empty market: an empty array, never a padded one.
  assert.deepEqual(aggregateCandles([], intervalMs, 300), []);
});

test("CANDLES-SKIP-UNTIMED-FILLS: NULL-time fills never create, extend or bound a bucket", () => {
  const intervalMs = 60_000;
  const base = 1_700_000_000_000;

  const timed = [fill(1, base + 1_000, 100n, 5n), fill(3, base + 61_000, 101n, 7n)];
  const all = [
    fill(0, null, 9_999n, 9_999n), // null at the head
    timed[0],
    fill(2, null, 9_999n, 9_999n), // null mid
    timed[1],
    fill(4, null, 9_999n, 9_999n), // null with the LARGEST seq
  ];

  const expected = oracle(timed, intervalMs, 300);
  assert.ok(expected.length === 2, "generator sanity: two timed fills in two buckets");
  assert.deepEqual(
    aggregateCandles(all, intervalMs, 300),
    expected,
    "null-time fills must be skipped entirely (no buckets, no bounds, no volume)",
  );

  const candles = aggregateCandles(all, intervalMs, 300);
  assert.equal(
    Number(candles[candles.length - 1].timeMs),
    Math.floor((base + 61_000) / intervalMs) * intervalMs,
    "B_max comes from the latest TIMED fill, never a larger-seq null row",
  );
});

test("CANDLES-REJECT-BAD-PARAMS: unknown interval and out-of-range/non-numeric limit are rejected rather than defaulted", () => {
  assert.deepEqual(
    parseCandlesQuery(new URLSearchParams("interval=1m&limit=5")),
    { interval: "1m", intervalMs: 60_000, limit: 5 },
    "a valid pair parses to its exact shape",
  );
  assert.deepEqual(
    parseCandlesQuery(new URLSearchParams("interval=1h")),
    { interval: "1h", intervalMs: 3_600_000, limit: 300 },
    "limit defaults to 300",
  );
  assert.deepEqual(
    parseCandlesQuery(new URLSearchParams("interval=1d&limit=1000")),
    { interval: "1d", intervalMs: 86_400_000, limit: 1_000 },
    "the maximum limit is accepted exactly",
  );

  const bad = [
    "", // no interval
    "limit=5", // interval is required
    "interval=2h",
    "interval=60m",
    "interval=1M",
    "interval=1m&limit=0",
    "interval=1m&limit=1001",
    "interval=1m&limit=-1",
    "interval=1m&limit=abc",
    "interval=1m&limit=1.5",
    "interval=1m&limit=1e3",
    "interval=1m&limit=",
  ];
  for (const query of bad) {
    assert.equal(
      parseCandlesQuery(new URLSearchParams(query)),
      null,
      `must reject ${JSON.stringify(query)} rather than defaulting`,
    );
  }
});
