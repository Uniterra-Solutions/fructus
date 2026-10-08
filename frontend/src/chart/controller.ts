//! lightweight-charts controller (candles + volume + mark/index lines).
//! Stub — product-v3 freeze.

import type { CandleView, MarketView, TradeView } from "fructus-sdk/src/api.js";
import type { CandleInterval } from "../lib/candles.js";

export interface ChartControllerOptions {
  container: HTMLElement;
  fetchCandles: (interval: CandleInterval) => Promise<CandleView[]>;
  initialInterval?: CandleInterval;
  onError?: (error: unknown) => void;
}

export interface ChartController {
  /** Switch the interval: refetch + replace the series data. */
  setInterval(interval: CandleInterval): void;
  /** Replace the whole series (bootstrap / interval switch). */
  setCandles(candles: CandleView[]): void;
  /** Fold a live trade into the chart. */
  onTrade(trade: TradeView): void;
  /** Mark/index horizontal lines (`null` mark → hidden). */
  setMarkLines(market: MarketView | null): void;
  destroy(): void;
}

export function createChartController(_opts: ChartControllerOptions): ChartController {
  return {
    setInterval() {
      /* stub */
    },
    setCandles() {
      /* stub */
    },
    onTrade() {
      /* stub */
    },
    setMarkLines() {
      /* stub */
    },
    destroy() {
      /* stub */
    },
  };
}
