//! Client-side candle folding (mirrors the server aggregation semantics).

import type { CandleView, TradeView } from "fructus-sdk/src/api.js";

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export const CANDLE_INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
export const DEFAULT_CANDLE_LIMIT = 300;

/** Fold one trade print into the candles (pure): merge into the last bucket or append; older trades are ignored. */
export function applyTradeToCandles(
  candles: CandleView[],
  trade: TradeView,
  intervalMs: number,
  limit = DEFAULT_CANDLE_LIMIT,
): CandleView[] {
  // Pre-migration rows carry no time and cannot be bucketed.
  if (trade.timeMs === null) return candles;

  const bucket = Math.floor(Number(trade.timeMs) / intervalMs) * intervalMs;
  const cap = Math.max(0, Math.floor(limit));
  const last = candles.length > 0 ? candles[candles.length - 1] : null;

  // A trade older than the newest bucket is a straggler: the tape is left untouched.
  if (last !== null && bucket < Number(last.timeMs)) return candles;

  if (last === null || bucket > Number(last.timeMs)) {
    // Fresh bucket: open = high = low = close = price, volume = size, one trade.
    const price = BigInt(trade.price).toString();
    const appended: CandleView[] = [
      ...candles,
      {
        timeMs: String(bucket),
        open: price,
        high: price,
        low: price,
        close: price,
        volume: BigInt(trade.size).toString(),
        trades: 1,
      },
    ];
    return appended.length > cap ? appended.slice(appended.length - cap) : appended;
  }

  // Same bucket as the last candle: open stays, high/low extend, close moves, volume/trades accumulate.
  const price = BigInt(trade.price);
  const merged: CandleView = {
    timeMs: last.timeMs,
    open: last.open,
    high: (price > BigInt(last.high) ? price : BigInt(last.high)).toString(),
    low: (price < BigInt(last.low) ? price : BigInt(last.low)).toString(),
    close: price.toString(),
    volume: (BigInt(last.volume) + BigInt(trade.size)).toString(),
    trades: last.trades + 1,
  };
  const next = [...candles.slice(0, candles.length - 1), merged];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
