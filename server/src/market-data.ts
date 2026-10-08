//! Market-data read models (product-v3): fill→candle aggregation and the
//! trade-row projections for `/market/candles` + `/market/trades`.
//! Stub — product-v3 freeze (implemented in the K-line wave).

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

/** Parse + validate `/market/candles` query params; `null` means 400. */
export function parseCandlesQuery(_params: URLSearchParams): CandlesQuery | null {
  return null;
}

/** Parse + validate the `/market/trades` `limit`; `null` means 400. */
export function parseTradesLimit(_params: URLSearchParams): number | null {
  return null;
}

/** Aggregate timed fills into OHLCV candles: ascending, compact (non-empty buckets), at most `limit`. */
export function aggregateCandles(_fills: FillRow[], _intervalMs: number, _limit: number): CandleView[] {
  return [];
}

/** Project one stored fill to its wire view. */
export function toTradeView(fill: FillRow): TradeView {
  return {
    seq: String(fill.seq),
    slot: String(fill.slot),
    timeMs: null,
    owner: fill.owner ?? "",
    side: fill.side === 1 ? 1 : 0,
    price: fill.price,
    size: fill.size,
  };
}
