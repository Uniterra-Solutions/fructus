//! RED acceptance test for product-v3 REQ-F-3 (client-side candle folding).
//! A naive in-test oracle reimplements the REQ-K-2 semantics independently:
//! bucket = floor(t / intervalMs) × intervalMs; open = first fill by asc seq,
//! close = last, high/low = max/min, volume = Σ size (raw bigint), trades =
//! count; ascending, compact, ≤ limit, window = last `limit` buckets.
//!
//! RED on today's tree: `applyTradeToCandles` is a stub returning the input
//! unchanged — folding leaves `[]` where the oracle holds candles, so the
//! sweep assertion fails behaviourally, never on a compile/import error.

import { expect, it } from "vitest";
import { CANDLE_INTERVAL_MS, applyTradeToCandles } from "../src/lib/candles.js";
import type { CandleInterval } from "../src/lib/candles.js";
import type { CandleView, TradeView } from "fructus-sdk/src/api.js";

// --- deterministic xorshift64 (repo house style) ----------------------------

const MASK64 = (1n << 64n) - 1n;
let seed = 0x9e3779b97f4a7c15n;
function next64(): bigint {
  seed ^= (seed << 13n) & MASK64;
  seed ^= seed >> 7n;
  seed ^= (seed << 17n) & MASK64;
  seed &= MASK64;
  return seed;
}
const pick = (n: number): number => Number(next64() % BigInt(n));
const pickBig = (bound: bigint): bigint => ((next64() << 64n) | next64()) % bound;

const INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const LIMIT = 300;

function mkTrade(seq: number, timeMs: number, price: string, size: string): TradeView {
  return {
    seq: String(seq),
    slot: "1",
    timeMs: String(timeMs),
    owner: "OWNER",
    side: seq % 2 === 0 ? 0 : 1,
    price,
    size,
  };
}

/** Naive independent reimplementation of the REQ-K-2 aggregation. */
function oracle(fills: TradeView[], intervalMs: number, limit: number): CandleView[] {
  const buckets = new Map<number, { seq: bigint; price: bigint; size: bigint }[]>();
  for (const fill of fills) {
    if (fill.timeMs === null) continue;
    const bucket = Math.floor(Number(fill.timeMs) / intervalMs) * intervalMs;
    const row = { seq: BigInt(fill.seq), price: BigInt(fill.price), size: BigInt(fill.size) };
    const existing = buckets.get(bucket);
    if (existing === undefined) buckets.set(bucket, [row]);
    else existing.push(row);
  }

  const bucketTimes = [...buckets.keys()].sort((a, b) => a - b);
  const windowed = bucketTimes.slice(Math.max(0, bucketTimes.length - limit));

  return windowed.map((time) => {
    const rows = (buckets.get(time) as { seq: bigint; price: bigint; size: bigint }[])
      .slice()
      .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    let high = rows[0].price;
    let low = rows[0].price;
    let volume = 0n;
    for (const row of rows) {
      if (row.price > high) high = row.price;
      if (row.price < low) low = row.price;
      volume += row.size;
    }
    return {
      timeMs: String(time),
      open: rows[0].price.toString(),
      high: high.toString(),
      low: low.toString(),
      close: rows[rows.length - 1].price.toString(),
      volume: volume.toString(),
      trades: rows.length,
    };
  });
}

it("CANDLE-INCREMENTAL-EQUALS-BATCH: folding trade-by-trade onto candles equals aggregating the whole fill sequence at once (any bucket boundary crossing), and a trade older than the last candle is ignored", () => {
  let lastFolded: CandleView[] = [];
  let lastFills: TradeView[] = [];
  let lastIntervalMs = CANDLE_INTERVAL_MS["1m"];

  for (let iteration = 0; iteration < 120; iteration++) {
    const interval = INTERVALS[iteration % INTERVALS.length];
    const intervalMs = CANDLE_INTERVAL_MS[interval];
    const count = 5 + pick(56);
    const base = intervalMs * (2 + pick(5));

    // Ascending seqs with NON-decreasing bucket times (a straggler is tested
    // separately): bucket index advances by 0..3, offsets include exact bucket
    // boundaries (offset 0), repeated offsets (equal timestamps) and random ones.
    const fills: TradeView[] = [];
    let bucketIndex = 0;
    let offset = pick(intervalMs);
    for (let i = 0; i < count; i++) {
      bucketIndex += pick(4);
      if (pick(10) < 3) offset = 0;
      else if (pick(10) < 2) {
        /* keep the previous offset → equal timestamps */
      } else offset = pick(intervalMs);
      const timeMs = base + bucketIndex * intervalMs + offset;
      const size = pick(4) === 0 ? 1n : pickBig(1n << BigInt(4 + pick(58))) + 1n;
      const price = pickBig(1n << BigInt(1 + pick(52))) + 1n;
      fills.push(mkTrade(i + 1, timeMs, price.toString(), size.toString()));
    }
    // One size far beyond 2^53 (float arithmetic would corrupt the sum).
    fills[0] = { ...fills[0], size: (2n ** 53n + 12_345n).toString() };

    // Fold one-by-one with a large limit, then with small limits.
    let folded: CandleView[] = [];
    for (const trade of fills) folded = applyTradeToCandles(folded, trade, intervalMs, LIMIT);
    expect(folded).toEqual(oracle(fills, intervalMs, LIMIT));

    for (const smallLimit of [1, 2, 3]) {
      let smallFolded: CandleView[] = [];
      for (const trade of fills) smallFolded = applyTradeToCandles(smallFolded, trade, intervalMs, smallLimit);
      expect(smallFolded).toEqual(oracle(fills, intervalMs, smallLimit));
    }

    lastFolded = folded;
    lastFills = fills;
    lastIntervalMs = intervalMs;
  }

  // Straggler: a later-arriving trade whose time falls in an older bucket is
  // ignored — the folded array must be left exactly as it was.
  const lastBucket = Number(lastFolded[lastFolded.length - 1].timeMs);
  const stragglerTime = lastBucket - lastIntervalMs + 1;
  const stragglerBucket = Math.floor(stragglerTime / lastIntervalMs) * lastIntervalMs;
  expect(stragglerBucket).toBeLessThan(lastBucket);
  const straggler = mkTrade(lastFills.length + 1, stragglerTime, "999999", "1000000");
  const before = lastFolded.map((candle) => ({ ...candle }));
  const after = applyTradeToCandles(lastFolded, straggler, lastIntervalMs, LIMIT);
  expect(after).toEqual(before);

  // Concrete micro-case pinned (mirrors the server REQ-K-2 micro fixture):
  // t=119000/119999 fall into bucket 60000; t=120000 opens bucket 120000.
  const microFills = [mkTrade(1, 119_000, "10", "1"), mkTrade(2, 119_999, "12", "2"), mkTrade(3, 120_000, "11", "3")];
  let microCandles: CandleView[] = [];
  for (const trade of microFills) {
    microCandles = applyTradeToCandles(microCandles, trade, CANDLE_INTERVAL_MS["1m"], LIMIT);
  }
  expect(microCandles).toEqual([
    { timeMs: "60000", open: "10", high: "12", low: "10", close: "12", volume: "3", trades: 2 },
    { timeMs: "120000", open: "11", high: "11", low: "11", close: "11", volume: "3", trades: 1 },
  ]);
});
