//! lightweight-charts controller, standard TV layout (candles + volume
//! sub-pane + mark/index price lines): bootstrap/refresh through the injected
//! `fetchCandles`, live trades folded under the current interval, the volume
//! histogram in its own bottom pane (so the price pane autoscales to the
//! candles alone), and mark/index as labeled dashed price lines.

import {
  CandlestickSeries,
  HistogramSeries,
  LineStyle as ChartLineStyle,
  createChart,
  type CreatePriceLineOptions,
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
  /** Mark/index price lines from `market` (`null` level → hidden). */
  setMarkLines(market: MarketView | null): void;
  destroy(): void;
}

/** Raw amounts are decimal strings of base units; charts work in whole USDC. */
const PRICE_SCALE = 1e6;

const DEFAULT_INTERVAL: CandleInterval = "1m";

/** Price pane vs volume pane height ratio (standard TV layout). */
const PRICE_PANE_STRETCH = 4;
const VOLUME_PANE_STRETCH = 1;

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
  /** Candle-direction tint; volume must never read as a candle body. */
  color: string;
}

type PriceLineStyle = Pick<CreatePriceLineOptions, "color" | "title" | "lineStyle" | "lineWidth">;

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
  const up = Number(candle.close) >= Number(candle.open);
  return {
    time: toTime(candle.timeMs),
    value: toPrice(candle.volume),
    color: up ? "rgba(38, 166, 154, 0.6)" : "rgba(239, 83, 80, 0.6)",
  };
}

export function createChartController(opts: ChartControllerOptions): ChartController {
  let interval: CandleInterval = opts.initialInterval ?? DEFAULT_INTERVAL;
  let candles: CandleView[] = [];
  let fetchSeq = 0;
  let destroyed = false;
  let markLine: IPriceLine | null = null;
  let indexLine: IPriceLine | null = null;

  const chart = createChart(opts.container, {
    // The container is a responsive flex/grid cell: autoSize installs the
    // internal ResizeObserver so zoom/window changes re-fit the chart.
    autoSize: true,
    layout: {
      background: { color: "transparent" },
      textColor: "#8b95a7",
      attributionLogo: false,
      panes: { separatorColor: "rgba(139, 149, 167, 0.2)", enableResize: false },
    },
    grid: {
      vertLines: { color: "rgba(139, 149, 167, 0.12)" },
      horzLines: { color: "rgba(139, 149, 167, 0.12)" },
    },
    // Autoscale the price pane to the visible candles; the top margin clears
    // the in-pane legend (two rows on mobile) so the highest candle never
    // touches the legend/labels. The volume pane carries its own scale.
    rightPriceScale: {
      borderColor: "rgba(139, 149, 167, 0.2)",
      autoScale: true,
      scaleMargins: { top: 0.22, bottom: 0.1 },
    },
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
    // Only the explicit mark/index price lines are drawn as levels; their
    // axis tags carry the levels (the series' own tag would duplicate them).
    priceLineVisible: false,
    lastValueVisible: false,
  });

  // Standard TV layout: volume rides its own bottom pane — the price pane
  // then autoscales to the candles alone (no giant overlay bars).
  const volumeSeries = chart.addSeries(
    HistogramSeries,
    { priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false },
    1,
  );
  const panes = chart.panes();
  panes[0]?.setStretchFactor(PRICE_PANE_STRETCH);
  panes[1]?.setStretchFactor(VOLUME_PANE_STRETCH);

  function applyCandles(next: CandleView[]): void {
    candles = next;
    candleSeries.setData(next.map(toCandlePoint));
    // Prints only: zero-volume buckets would dash the histogram baseline.
    volumeSeries.setData(next.filter((candle) => Number(candle.volume) > 0).map(toVolumePoint));
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

  function syncPriceLine(line: IPriceLine | null, price: number | null, style: PriceLineStyle): IPriceLine | null {
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
    },
    setMarkLines(market) {
      if (destroyed) return;
      const mark = market !== null && market.mark !== null ? toPrice(market.mark) : null;
      const index = market !== null ? toPrice(market.index) : null;
      markLine = syncPriceLine(markLine, mark, {
        color: "#f5a623",
        title: "Mark",
        lineStyle: ChartLineStyle.Dashed,
        lineWidth: 1,
      });
      indexLine = syncPriceLine(indexLine, index, {
        color: "#6b7cff",
        title: "Index",
        lineStyle: ChartLineStyle.Dotted,
        lineWidth: 1,
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      fetchSeq += 1;
      candles = [];
      markLine = null;
      indexLine = null;
      chart.remove();
    },
  };
}
