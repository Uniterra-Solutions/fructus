//! REQ-F-6 · CHART-CONTROLLER-INTERVAL-SWITCH — frontend red baseline (product-v3).
//! Unit test with a mocked lightweight-charts: creation performs the initial fetch,
//! an interval switch refetches with the new parameter and replaces the series data,
//! and a live trade folds into the series via update() under the CURRENT interval.
//! The mock dispatches per series definition, so an implementation feeding candle +
//! volume (HistogramSeries) series is fine — assertions target the candle series.

import { expect, it, vi } from "vitest";
import type { CandleView, TradeView } from "fructus-sdk/src/api.js";
import type { CandleInterval } from "../src/lib/candles.js";
import { createChartController } from "../src/chart/controller.js";

const fakes = vi.hoisted(() => {
  const candlesDef = { __series: "candles" };
  const otherDef = { __series: "other" };
  const mkSeries = () => ({
    setData: vi.fn(),
    update: vi.fn(),
    createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
    applyOptions: vi.fn(),
  });
  const candleSeries = mkSeries();
  const otherSeries = mkSeries();
  const fakeChart = {
    addSeries: vi.fn((def: unknown) => (def === candlesDef ? candleSeries : otherSeries)),
    remove: vi.fn(),
    applyOptions: vi.fn(),
    timeScale: () => ({ fitContent: vi.fn() }),
    panes: () => [{ setStretchFactor: vi.fn() }, { setStretchFactor: vi.fn() }],
  };
  return { fakeChart, candleSeries, otherSeries, candlesDef, otherDef };
});

vi.mock("lightweight-charts", () => ({
  createChart: vi.fn(() => fakes.fakeChart),
  CandlestickSeries: fakes.candlesDef,
  LineSeries: fakes.otherDef,
  HistogramSeries: fakes.otherDef,
  LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
}));

/** Drain microtasks + a few macrotask turns so fetch promises settle deterministically. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Interval-coherent fixtures: each candle's timeMs sits exactly on its interval bucket. */
const candlesByInterval: Record<CandleInterval, CandleView[]> = {
  "1m": [
    { timeMs: "60000", open: "1000000", high: "1100000", low: "900000", close: "1050000", volume: "3", trades: 2 },
  ],
  "5m": [
    { timeMs: "300000", open: "1000000", high: "1100000", low: "900000", close: "1050000", volume: "3", trades: 2 },
  ],
  "15m": [],
  "1h": [],
  "4h": [],
  "1d": [],
};

it(`CHART-CONTROLLER-INTERVAL-SWITCH: switching interval refetches with the new interval parameter and replaces the series data; a trade push updates the series with the folded last candle`, async () => {
  const container = document.createElement("div");
  const fetchCandles = vi.fn(async (interval: CandleInterval): Promise<CandleView[]> => candlesByInterval[interval]);

  const controller = createChartController({ container, fetchCandles, initialInterval: "1m" });

  // Creation performs the initial fetch (time = Number(timeMs)/1000 floored; values = Number(raw)/1e6).
  await settle();
  expect(fetchCandles).toHaveBeenCalledWith("1m");
  if (fetchCandles.mock.calls.length === 0) return; // clean first red on the stub
  expect(fakes.candleSeries.setData).toHaveBeenCalledWith([
    { time: 60, open: 1, high: 1.1, low: 0.9, close: 1.05 },
  ]);
  expect(fakes.candleSeries.update).not.toHaveBeenCalled();

  // Switching the interval refetches with the new parameter and replaces the series data.
  controller.setInterval("5m");
  await settle();
  expect(fetchCandles).toHaveBeenCalledTimes(2);
  expect(fetchCandles).toHaveBeenLastCalledWith("5m");
  expect(fakes.candleSeries.setData).toHaveBeenCalledTimes(2);
  expect(fakes.candleSeries.setData).toHaveBeenLastCalledWith([
    { time: 300, open: 1, high: 1.1, low: 0.9, close: 1.05 },
  ]);

  // A live trade push folds under the CURRENT interval (5m): 660000 ms falls into the
  // 600000 bucket — a NEW bucket after the 300000 candle — so update() receives the
  // freshly folded candle. (A 1m-bucketed implementation would give time 660, and a
  // seconds-domain merge would give 300 — neither is the pinned contract.)
  const trade: TradeView = {
    seq: "9",
    slot: "1",
    timeMs: "660000",
    owner: "o",
    side: 0,
    price: "1200000",
    size: "1000000",
  };
  controller.onTrade(trade);
  await settle();
  expect(fakes.candleSeries.update).toHaveBeenCalledTimes(1);
  expect(fakes.candleSeries.update).toHaveBeenCalledWith({ time: 600, open: 1.2, high: 1.2, low: 1.2, close: 1.2 });
});
