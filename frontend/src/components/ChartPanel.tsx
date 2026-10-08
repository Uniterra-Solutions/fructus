//! K-line chart panel — container + the lightweight-charts controller mount (REQ-F-6).
//! The terminal store stays the single source of truth: this panel feeds the
//! controller from the `candles` prop (bootstrap read, WS trade folds and
//! interval refetches all land there) and renders mark/index lines from `market`.

import { useEffect, useRef } from "react";
import type { CandleView, MarketView } from "fructus-sdk/src/api.js";
import { CANDLE_INTERVALS, type CandleInterval } from "../lib/candles.js";
import { createChartController, type ChartController } from "../chart/controller.js";
import { useLocale } from "../i18n/index.js";

export interface ChartPanelProps {
  candles: CandleView[];
  interval: CandleInterval;
  onIntervalChange(interval: CandleInterval): void;
  /** When provided, the lightweight-charts controller mounts into the container. */
  fetchCandles?: (interval: CandleInterval) => Promise<CandleView[]>;
  /** Mark/index price-line source (`mark` null → line hidden). */
  market?: MarketView | null;
}

export function ChartPanel({
  candles,
  interval,
  onIntervalChange,
  fetchCandles,
  market = null,
}: ChartPanelProps) {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ChartController | null>(null);
  const candlesRef = useRef<CandleView[]>(candles);
  candlesRef.current = candles;

  // Mount the chart controller (skipped in environments without the fetcher —
  // e.g. component tests — so no canvas is required under jsdom).
  useEffect(() => {
    if (!fetchCandles || containerRef.current === null) return;
    const controller = createChartController({
      container: containerRef.current,
      // Data is store-driven: the factory's bootstrap load reads the latest
      // snapshot, and every store change re-enters through `setCandles`.
      fetchCandles: () => Promise.resolve(candlesRef.current),
    });
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, [fetchCandles]);

  useEffect(() => {
    controllerRef.current?.setCandles(candles);
  }, [candles]);

  useEffect(() => {
    controllerRef.current?.setMarkLines(market);
  }, [market]);

  return (
    <section data-testid="chart-panel" className="flex min-w-0 flex-col rounded border border-line bg-panel p-3">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-wider text-muted">{t("chart.title")}</h2>
        <div className="flex gap-1">
          {CANDLE_INTERVALS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={value === interval}
              className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                value === interval ? "border-accent text-accent" : "border-line text-muted hover:text-ink"
              }`}
              onClick={() => onIntervalChange(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </header>
      <div ref={containerRef} data-testid="chart-container" className="h-64 w-full rounded bg-base" />
      <p className="mt-2 text-[10px] text-muted">
        {candles.length} · {interval}
      </p>
    </section>
  );
}
