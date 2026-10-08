//! Client-side candle folding (mirrors the server aggregation semantics).
//! Stub — product-v3 freeze.

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
  _trade: TradeView,
  _intervalMs: number,
  _limit = DEFAULT_CANDLE_LIMIT,
): CandleView[] {
  return candles;
}
