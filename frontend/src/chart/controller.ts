//! lightweight-charts controller (candles + volume + mark trail + index line):
//! bootstrap/refresh through the injected `fetchCandles`, live trades folded
//! under the current interval, a dashed mark trail that follows the served
//! series up to the latest price, and a createPriceLine index overlay.

import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle as ChartLineStyle,
  createChart,
  type IPriceLine,
  type UTCTimestamp,
} from "lightweight-charts";
import type { CandleView, MarketView, TradeView } from "fructus-sdk/src/api.js";
import { applyTradeToCandles, CANDLE_INTERVAL_MS, type CandleInterval } from "../lib/candles.js";

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
  /** Index horizontal line (`null` index → hidden); the mark trail follows the series. */
  setMarkLines(market: MarketView | null): void;
  destroy(): void;
}

/** Raw amounts are decimal strings of base units; charts work in whole USDC. */
const PRICE_SCALE = 1e6;

const DEFAULT_INTERVAL: CandleInterval = "1m";

interface CandlePoint {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface VolumePoint {
  time: UTCTimestamp;
  value: number;
}

interface MarkPoint {
  time: UTCTimestamp;
  value: number;
}

interface LineStyle {
  color: string;
  title: string;
}

function toPrice(raw: string): number {
  return Number(raw) / PRICE_SCALE;
}

function toTime(raw: string): UTCTimestamp {
  return Math.floor(Number(raw) / 1000) as UTCTimestamp;
}

function toCandlePoint(candle: CandleView): CandlePoint {
  return {
    time: toTime(candle.timeMs),
    open: toPrice(candle.open),
    high: toPrice(candle.high),
    low: toPrice(candle.low),
    close: toPrice(candle.close),
  };
}

function toVolumePoint(candle: CandleView): VolumePoint {
  return { time: toTime(candle.timeMs), value: toPrice(candle.volume) };
}

/** The mark trail point: the served series' close (the sampled reference price). */
function toMarkPoint(candle: CandleView): MarkPoint {
  return { time: toTime(candle.timeMs), value: toPrice(candle.close) };
}

export function createChartController(opts: ChartControllerOptions): ChartController {
  let interval: CandleInterval = opts.initialInterval ?? DEFAULT_INTERVAL;
  let candles: CandleView[] = [];
  let fetchSeq = 0;
  let destroyed = false;
  let indexLine: IPriceLine | null = null;

  const chart = createChart(opts.container, {
    // The container is a responsive flex/grid cell: autoSize installs the
    // internal ResizeObserver so zoom/window changes re-fit the chart.
    autoSize: true,
    layout: {
      background: { color: "transparent" },
      textColor: "#8b95a7",
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: "rgba(139, 149, 167, 0.12)" },
      horzLines: { color: "rgba(139, 149, 167, 0.12)" },
    },
    rightPriceScale: { borderColor: "rgba(139, 149, 167, 0.2)" },
    // Fixed bar width: the series scrolls like a terminal instead of
    // fitContent stretching a handful of samples across the whole pane.
    timeScale: {
      borderColor: "rgba(139, 149, 167, 0.2)",
      timeVisible: true,
      secondsVisible: false,
      barSpacing: 8,
      rightOffset: 4,
    },
  });

  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: "#26a69a",
    downColor: "#ef5350",
    borderVisible: false,
    wickUpColor: "#26a69a",
    wickDownColor: "#ef5350",
  });

  const volumeSeries = chart.addSeries(HistogramSeries, {
    priceScaleId: "",
    priceFormat: { type: "volume" },
    lastValueVisible: false,
    priceLineVisible: false,
  });

  // Dashed orange trail over the served closes: the mark, extended to the
  // latest price — never a full-width horizontal line.
  const markSeries = chart.addSeries(LineSeries, {
    color: "#f5a623",
    lineWidth: 1,
    lineStyle: ChartLineStyle.Dashed,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  function applyCandles(next: CandleView[]): void {
    candles = next;
    candleSeries.setData(next.map(toCandlePoint));
    // Zero-volume buckets paint hairline dashes on the histogram baseline;
    // keep the volume series sparse (print buckets only) so the flat sampled
    // minutes stay clean.
    volumeSeries.setData(next.filter((candle) => Number(candle.volume) > 0).map(toVolumePoint));
    markSeries.setData(next.map(toMarkPoint));
  }

  function load(target: CandleInterval): void {
    const seq = ++fetchSeq;
    let fetched: Promise<CandleView[]>;
    try {
      fetched = Promise.resolve(opts.fetchCandles(target));
    } catch (error) {
      opts.onError?.(error);
      return;
    }
    fetched.then(
      (next) => {
        if (destroyed || seq !== fetchSeq) return;
        applyCandles(next);
      },
      (error: unknown) => {
        if (destroyed || seq !== fetchSeq) return;
        opts.onError?.(error);
      },
    );
  }

  function syncPriceLine(line: IPriceLine | null, price: number | null, style: LineStyle): IPriceLine | null {
    if (price === null || !Number.isFinite(price)) {
      line?.applyOptions({ lineVisible: false, axisLabelVisible: false });
      return line;
    }
    if (line === null) {
      return candleSeries.createPriceLine({ price, lineVisible: true, axisLabelVisible: true, ...style });
    }
    line.applyOptions({ price, lineVisible: true, axisLabelVisible: true });
    return line;
  }

  // Bootstrap: the initial fetch for the starting interval.
  load(interval);

  return {
    setInterval(next) {
      if (destroyed) return;
      interval = next;
      load(next);
    },
    setCandles(next) {
      if (destroyed) return;
      applyCandles(next);
    },
    onTrade(trade) {
      if (destroyed) return;
      const folded = applyTradeToCandles(candles, trade, CANDLE_INTERVAL_MS[interval]);
      if (folded === candles) return; // straggler older than the newest bucket
      candles = folded;
      const last = candles[candles.length - 1];
      if (last === undefined) return;
      candleSeries.update(toCandlePoint(last));
      if (Number(last.volume) > 0) volumeSeries.update(toVolumePoint(last));
      markSeries.update(toMarkPoint(last));
    },
    setMarkLines(market) {
      if (destroyed) return;
      const index = market !== null ? toPrice(market.index) : null;
      indexLine = syncPriceLine(indexLine, index, { color: "#6b7cff", title: "Index" });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      fetchSeq += 1;
      candles = [];
      indexLine = null;
      chart.remove();
    },
  };
}
