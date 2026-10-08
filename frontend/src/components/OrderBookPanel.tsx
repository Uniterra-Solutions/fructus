//! Order book (L2, ≤16 levels/side). Stub.

import type { BookView } from "fructus-sdk/src/api.js";

export interface OrderBookPanelProps {
  book: BookView | null;
  /** Click a level: prefill the trade form with this raw price + side (0 long / 1 short). */
  onPriceSelect(price: string, side: 0 | 1): void;
}

export function OrderBookPanel(_props: OrderBookPanelProps) {
  return null;
}
