//! Acceptance tests for product-v3 candles v2 (REQ-K-2): the pure OHLCV
//! aggregation over the sampled price series (mark samples ∪ trade prints) and
//! the query parsing. A naive in-test oracle reimplements the bucket/window
//! semantics independently of the module.
//!
//! The v2 contract: the series is the union of mark samples (no size) and
//! trade prints (size) — a bucket exists even without trades (a flat
//! open==close candle), volume/trade counts come from the prints only, and
//! every intervalMs is the same standard grouping (higher timeframes are the
//! standard fold of the base buckets).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CandleView } from "fructus-sdk/src/api.js";
import type { FillRow, MarkSampleRow } from "../src/db.js";
import {
  CANDLE_INTERVAL_MS,
  aggregateCandles,
  fillPoints,
  mergePoints,
  parseCandlesQuery,
  samplePoints,
  type PricePoint,
} from "../src/market-data.js";

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

function sample(timeMs: number, price: bigint): MarkSampleRow {
  return { timeMs, price: price.toString() };
}

/** Naive REQ-K-2 reimplementation: merge points, bucket, first/last, compact window. */
function oracle(points: PricePoint[], intervalMs: number, limit: number): CandleView[] {
  const ordered = points
    .slice()
    .sort((a, b) => a.timeMs - b.timeMs || (a.size === null ? 0 : 1) - (b.size === null ? 0 : 1));
  if (ordered.length === 0) return [];
  interface Acc {
    open: bigint;
    high: bigint;
    low: bigint;
    close: bigint;
    volume: bigint;
    trades: number;
  }
  const buckets = new Map<number, Acc>();
  for (const p of ordered) {
    const bucket = Math.floor(p.timeMs / intervalMs) * intervalMs;
    const acc = buckets.get(bucket);
    if (acc === undefined) {
      buckets.set(bucket, {
        open: p.price,
        high: p.price,
        low: p.price,
        close: p.price,
        volume: p.size ?? 0n,
        trades: p.size === null ? 0 : 1,
      });
    } else {
      if (p.price > acc.high) acc.high = p.price;
      if (p.price < acc.low) acc.low = p.price;
      acc.close = p.price;
      if (p.size !== null) {
        acc.volume += p.size;
        acc.trades += 1;
      }
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

test("CANDLES-BUCKET-AND-OHLC: per-bucket open/high/low/close/volume/trades equal an independently computed grouping of the generated points", () => {
  // Concrete micro-case pinned first: samples + one trade, two buckets.
  const micro: PricePoint[] = mergePoints(
    samplePoints([sample(59_000, 1_199_000n), sample(61_000, 1_200_000n), sample(119_000, 1_205_000n)]),
    fillPoints([fill(1, 61_500, 1_201_000n, 7n)]),
  );
  assert.deepEqual(aggregateCandles(micro, 60_000, 1_000), [
    { timeMs: "0", open: "1199000", high: "1199000", low: "1199000", close: "1199000", volume: "0", trades: 0 },
    { timeMs: "60000", open: "1200000", high: "1205000", low: "1200000", close: "1205000", volume: "7", trades: 1 },
  ]);

  // Sweep: random points across interval edges, both directions of price.
  const intervals = Object.values(CANDLE_INTERVAL_MS);
  const base = 1_700_000_000_000;
  for (let iteration = 0; iteration < 60; iteration++) {
    const intervalMs = intervals[pick(intervals.length)];
    const count = 1 + pick(40);
    const points: PricePoint[] = [];
    for (let i = 1; i <= count; i++) {
      const bucket = pick(6);
      const inBucket = pick(intervalMs);
      // Sometimes land exactly on the bucket edge.
      const offset = pick(4) === 0 ? 0 : inBucket;
      const price = BigInt(1 + pick(1_000_000));
      points.push(
        pick(2) === 0
          ? { timeMs: base + bucket * intervalMs + offset, price, size: null }
          : { timeMs: base + bucket * intervalMs + offset, price, size: BigInt(1 + pick(1_000_000)) },
      );
    }
    const expected = oracle(points, intervalMs, 1_000);
    assert.ok(expected.length >= 1, "generator sanity: at least one point");
    assert.deepEqual(
      aggregateCandles(points, intervalMs, 1_000),
      expected,
      `aggregation must equal the grouping oracle (interval ${intervalMs}, ${count} points)`,
    );
  }
});

test("CANDLES-CONTINUOUS-FLAT-BUCKETS: mark samples alone advance the series — every interval bucket exists with open==high==low==close while the price is constant", () => {
  const intervalMs = 60_000;
  // Minute-aligned so `m` maps 1:1 onto buckets.
  const base = Math.floor(1_700_000_000_000 / intervalMs) * intervalMs;
  const points: PricePoint[] = [];
  for (let m = 0; m < 5; m++) {
    for (let s = 0; s < 60; s += 5) {
      points.push({ timeMs: base + m * intervalMs + s * 1_000, price: 1_200_000n, size: null });
    }
  }
  const candles = aggregateCandles(points, intervalMs, 300);
  assert.equal(candles.length, 5, "one candle per minute even with zero trades");
  for (const candle of candles) {
    assert.equal(candle.open, "1200000");
    assert.equal(candle.high, candle.open);
    assert.equal(candle.low, candle.open);
    assert.equal(candle.close, candle.open);
    assert.equal(candle.volume, "0");
    assert.equal(candle.trades, 0);
  }
  for (let i = 1; i < candles.length; i++) {
    assert.equal(
      Number(candles[i].timeMs) - Number(candles[i - 1].timeMs),
      intervalMs,
      "consecutive buckets sit exactly one interval apart (continuity)",
    );
  }

  // A trade inside one minute (as the bucket's last print) moves that
  // minute's close/high/low + volume.
  const withTrade: PricePoint[] = [
    ...points,
    { timeMs: base + 2 * intervalMs + 59_500, price: 1_210_000n, size: 9n },
  ];
  const mixed = aggregateCandles(withTrade, intervalMs, 300);
  const touched = mixed[2];
  assert.equal(touched.open, "1200000");
  assert.equal(touched.high, "1210000");
  assert.equal(touched.low, "1200000");
  assert.equal(touched.close, "1210000");
  assert.equal(touched.volume, "9");
  assert.equal(touched.trades, 1);
  assert.equal(mixed[3].open, "1200000", "the next minute opens at its own first sample");
});

test("CANDLES-STANDARD-CROSS-INTERVAL: a higher timeframe equals the standard fold (first open, last close, max high, min low, summed volume/trades) of its base buckets", () => {
  const baseMs = 60_000;
  const widerMs = baseMs * 5;
  const base = 1_700_000_000_000;

  for (let iteration = 0; iteration < 40; iteration++) {
    const points: PricePoint[] = [];
    for (let b = 0; b < 10; b++) {
      const bucketStart = base + b * baseMs;
      for (let s = 0; s < 60_000; s += 5_000) {
        points.push({ timeMs: bucketStart + s, price: BigInt(1_000_000 + pick(1_000)), size: null });
      }
      if (pick(2) === 0) {
        points.push({
          timeMs: bucketStart + 30_000,
          price: BigInt(1_000_000 + pick(1_000)),
          size: BigInt(1 + pick(500)),
        });
      }
    }

    const minutes = aggregateCandles(points, baseMs, 1_000);
    const fives = aggregateCandles(points, widerMs, 1_000);

    // Independent standard fold of the base series into the wider buckets.
    interface Fold {
      open: bigint;
      high: bigint;
      low: bigint;
      close: bigint;
      volume: bigint;
      trades: number;
    }
    const fold = new Map<number, Fold>();
    for (const candle of minutes) {
      const key = Math.floor(Number(candle.timeMs) / widerMs) * widerMs;
      const open = BigInt(candle.open);
      const high = BigInt(candle.high);
      const low = BigInt(candle.low);
      const close = BigInt(candle.close);
      const volume = BigInt(candle.volume);
      const acc = fold.get(key);
      if (acc === undefined) {
        fold.set(key, { open, high, low, close, volume, trades: candle.trades });
      } else {
        if (high > acc.high) acc.high = high;
        if (low < acc.low) acc.low = low;
        acc.close = close;
        acc.volume += volume;
        acc.trades += candle.trades;
      }
    }

    assert.equal(fives.length, fold.size, "the wider series has one candle per wider bucket");
    for (const [key, acc] of fold) {
      const candle = fives.find((c) => Number(c.timeMs) === key);
      assert.ok(candle !== undefined, `missing wider bucket ${key}`);
      assert.deepEqual(
        candle,
        {
          timeMs: String(key),
          open: acc.open.toString(),
          high: acc.high.toString(),
          low: acc.low.toString(),
          close: acc.close.toString(),
          volume: acc.volume.toString(),
          trades: acc.trades,
        },
        `wider bucket ${key} must equal the standard fold of its base buckets`,
      );
    }
  }
});

test("CANDLES-COMPACT-ASCENDING-WINDOWED: the array is ascending, holds only non-empty buckets, never exceeds limit, never contains a bucket below B_max − (limit−1)×intervalMs, and its last bucket is B_max", () => {
  const intervalMs = 60_000;
  const base = 1_700_000_000_000;

  for (let iteration = 0; iteration < 40; iteration++) {
    const buckets = 2 + pick(8);
    const limit = 1 + pick(5);
    const points: PricePoint[] = [];
    for (let b = 0; b < buckets; b++) {
      const trades = 1 + pick(4);
      for (let j = 0; j < trades; j++) {
        points.push({
          timeMs: base + b * intervalMs + pick(intervalMs),
          price: BigInt(1 + pick(1_000)),
          size: BigInt(1 + pick(1_000)),
        });
      }
      // Samples land in the same buckets (some buckets may be sample-only).
      points.push({ timeMs: base + b * intervalMs + pick(intervalMs), price: BigInt(1 + pick(1_000)), size: null });
    }
    const candles = aggregateCandles(points, intervalMs, limit);

    assert.ok(candles.length <= limit, `at most limit buckets — got ${candles.length} for limit ${limit}`);
    assert.deepEqual(candles, oracle(points, intervalMs, limit), "must equal the windowed oracle");

    for (let i = 1; i < candles.length; i++) {
      assert.ok(
        Number(candles[i - 1].timeMs) < Number(candles[i].timeMs),
        `candles must be strictly ascending by timeMs — got ${candles.map((c) => c.timeMs).join(",")}`,
      );
    }
    const maxBucket = Math.max(...points.map((p) => Math.floor(p.timeMs / intervalMs) * intervalMs));
    if (candles.length > 0) {
      assert.equal(
        Number(candles[candles.length - 1].timeMs),
        maxBucket,
        "the last bucket must be the latest point's bucket",
      );
      assert.ok(
        Number(candles[0].timeMs) >= maxBucket - (limit - 1) * intervalMs,
        "no bucket below the window floor",
      );
      for (const candle of candles) {
        assert.equal(Number(candle.timeMs) % intervalMs, 0, "bucket starts are interval multiples");
      }
    }
  }

  // Empty series: an empty array, never a padded one.
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

  const expected = oracle(fillPoints(timed), intervalMs, 300);
  assert.ok(expected.length === 2, "generator sanity: two timed fills in two buckets");
  assert.deepEqual(
    aggregateCandles(fillPoints(all), intervalMs, 300),
    expected,
    "null-time fills must be skipped entirely (no buckets, no bounds, no volume)",
  );

  const candles = aggregateCandles(fillPoints(all), intervalMs, 300);
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
