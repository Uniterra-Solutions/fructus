//! Market-data read models (product-v3): fill→candle aggregation and the
//! trade-row projections for `/market/candles` + `/market/trades`.

import type { CandleView, TradeView } from "fructus-sdk/src/api.js";
import type { FillRow } from "./db.js";

/** The candle intervals the API serves. */
export type CandleIntervalName = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export const CANDLE_INTERVAL_MS: Record<CandleIntervalName, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export const DEFAULT_CANDLE_LIMIT = 300;
export const MAX_CANDLE_LIMIT = 1_000;
export const DEFAULT_TRADES_LIMIT = 50;
export const MAX_TRADES_LIMIT = 200;

export interface CandlesQuery {
  interval: CandleIntervalName;
  intervalMs: number;
  limit: number;
}

/** The DTO convention: plain unsigned decimal digits (rejects `1.5`, `1e3`, `-1`, ``). */
const DIGITS_ONLY = /^\d+$/;

/** Parse + validate `/market/candles` query params; `null` means 400. */
export function parseCandlesQuery(params: URLSearchParams): CandlesQuery | null {
  const interval = params.get("interval");
  if (interval === null || !Object.hasOwn(CANDLE_INTERVAL_MS, interval)) return null;
  const name = interval as CandleIntervalName;

  const rawLimit = params.get("limit");
  let limit = DEFAULT_CANDLE_LIMIT;
  if (rawLimit !== null) {
    if (!DIGITS_ONLY.test(rawLimit)) return null;
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_CANDLE_LIMIT) return null;
  }

  return { interval: name, intervalMs: CANDLE_INTERVAL_MS[name], limit };
}

/** Parse + validate the `/market/trades` `limit`; `null` means 400. */
export function parseTradesLimit(params: URLSearchParams): number | null {
  const raw = params.get("limit");
  if (raw === null) return DEFAULT_TRADES_LIMIT;
  if (!DIGITS_ONLY.test(raw)) return null;
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_TRADES_LIMIT) return null;
  return limit;
}

interface CandleAcc {
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
  trades: number;
}

/** Aggregate timed fills into OHLCV candles: ascending, compact (non-empty buckets), at most `limit`. */
export function aggregateCandles(fills: FillRow[], intervalMs: number, limit: number): CandleView[] {
  // Only fills with a block time can bucket (pre-migration rows are excluded);
  // seq order decides open/close, so sort ascending by seq first.
  const timed = fills
    .filter((fill) => fill.timeMs !== null && fill.timeMs !== undefined)
    .sort((a, b) => a.seq - b.seq);

  const buckets = new Map<number, CandleAcc>();
  for (const fill of timed) {
    const bucket = Math.floor((fill.timeMs as number) / intervalMs) * intervalMs;
    const price = BigInt(fill.price);
    const size = BigInt(fill.size);
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
  if (buckets.size === 0) return [];

  // Compact window ending at the latest timed fill's bucket B_max: keep only
  // buckets `>= B_max − (limit−1)×intervalMs` (at most `limit` bucket starts).
  let maxBucket = -Infinity;
  for (const bucket of buckets.keys()) if (bucket > maxBucket) maxBucket = bucket;
  const floor = maxBucket - (limit - 1) * intervalMs;

  return [...buckets.entries()]
    .filter(([bucket]) => bucket >= floor)
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, acc]) => ({
      timeMs: String(bucket),
      open: acc.open.toString(),
      high: acc.high.toString(),
      low: acc.low.toString(),
      close: acc.close.toString(),
      volume: acc.volume.toString(),
      trades: acc.trades,
    }));
}

/** Project one stored fill to its wire view. */
export function toTradeView(fill: FillRow): TradeView {
  const timeMs = fill.timeMs;
  return {
    seq: String(fill.seq),
    slot: String(fill.slot),
    timeMs: timeMs === null || timeMs === undefined ? null : String(timeMs),
    owner: fill.owner ?? "",
    side: fill.side === 1 ? 1 : 0,
    price: fill.price,
    size: fill.size,
  };
}
