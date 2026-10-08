//! Order book (L2, ≤16 levels/side) — REQ-F-4.

import type { BookView } from "fructus-sdk/src/api.js";
import { formatAmount } from "../lib/amount.js";
import { useLocale } from "../i18n/index.js";

export interface OrderBookPanelProps {
  book: BookView | null;
  /** Click a level: prefill the trade form with this raw price + side (0 long / 1 short). */
  onPriceSelect(price: string, side: 0 | 1): void;
}

export function OrderBookPanel({ book, onPriceSelect }: OrderBookPanelProps) {
  const { t } = useLocale();
  const bids = book !== null ? book.bids : [];
  const asks = book !== null ? book.asks : [];
  const empty = bids.length === 0 && asks.length === 0;

  return (
    <section data-testid="book-panel" className="flex min-w-0 flex-col rounded border border-line bg-panel p-3">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wider text-muted">{t("book.title")}</h2>
        <div className="flex gap-4 text-[10px] uppercase tracking-wide text-muted">
          <span>{t("book.price")}</span>
          <span>{t("book.size")}</span>
        </div>
      </header>
      {empty ? (
        <div data-testid="book-empty" className="py-8 text-center text-xs text-muted">
          {t("book.empty")}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {asks.map(([price, size], index) => (
            <button
              key={`ask-${index}`}
              type="button"
              data-testid="book-ask"
              className="grid grid-cols-2 gap-3 rounded px-1 py-0.5 text-right text-xs text-down transition-colors hover:bg-panel2"
              onClick={() => onPriceSelect(price, 1)}
            >
              <span>{formatAmount(price)}</span>
              <span className="text-muted">{formatAmount(size)}</span>
            </button>
          ))}
          {bids.map(([price, size], index) => (
            <button
              key={`bid-${index}`}
              type="button"
              data-testid="book-bid"
              className="grid grid-cols-2 gap-3 rounded px-1 py-0.5 text-right text-xs text-up transition-colors hover:bg-panel2"
              onClick={() => onPriceSelect(price, 0)}
            >
              <span>{formatAmount(price)}</span>
              <span className="text-muted">{formatAmount(size)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
