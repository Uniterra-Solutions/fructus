//! Recent trades tape (REQ-F-3).

import type { TradeView } from "fructus-sdk/src/api.js";
import { formatAmount } from "../lib/amount.js";
import { useLocale } from "../i18n/index.js";

export interface TradesTapeProps {
  trades: TradeView[];
}

export function TradesTape({ trades }: TradesTapeProps) {
  const { t } = useLocale();
  return (
    <section data-testid="trades-tape" className="flex min-w-0 flex-col rounded border border-line bg-panel p-3">
      <h2 className="mb-2 text-xs uppercase tracking-wider text-muted">{t("tape.title")}</h2>
      {trades.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted">{t("tape.empty")}</div>
      ) : (
        <ol className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {trades.map((trade) => (
            <li key={trade.seq} className="grid grid-cols-[56px_1fr_1fr] gap-2 text-xs">
              <span className={trade.side === 0 ? "text-up" : "text-down"}>
                {trade.side === 0 ? t("positions.long") : t("positions.short")}
              </span>
              <span className="text-right text-ink">{formatAmount(trade.price)}</span>
              <span className="text-right text-muted">{formatAmount(trade.size)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
