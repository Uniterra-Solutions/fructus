//! K-line chart panel (lightweight-charts). Stub.

import type { CandleView } from "fructus-sdk/src/api.js";
import type { CandleInterval } from "../lib/candles.js";

export interface ChartPanelProps {
  candles: CandleView[];
  interval: CandleInterval;
  onIntervalChange(interval: CandleInterval): void;
}

export function ChartPanel(_props: ChartPanelProps) {
  return null;
}
