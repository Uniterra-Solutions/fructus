//! K-line chart panel — container only (the chart controller is wired elsewhere, REQ-F-6).

import type { CandleView } from "fructus-sdk/src/api.js";
import { CANDLE_INTERVALS, type CandleInterval } from "../lib/candles.js";
import { useLocale } from "../i18n/index.js";

export interface ChartPanelProps {
  candles: CandleView[];
  interval: CandleInterval;
  onIntervalChange(interval: CandleInterval): void;
}

export function ChartPanel({ candles, interval, onIntervalChange }: ChartPanelProps) {
  const { t } = useLocale();
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
      <div data-testid="chart-container" className="h-64 w-full rounded bg-base" />
      <p className="mt-2 text-[10px] text-muted">
        {candles.length} · {interval}
      </p>
    </section>
  );
}
