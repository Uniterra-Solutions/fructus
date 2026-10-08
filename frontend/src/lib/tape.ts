//! Trades-tape merge (dedupe by seq, newest first, bounded).
//! Stub — product-v3 freeze.

import type { TradeView } from "fructus-sdk/src/api.js";

export const TAPE_CAP = 50;

/** Merge incoming trade rows into the tape: unique by seq, descending, capped. */
export function mergeTrades(current: TradeView[], _incoming: TradeView[], _cap = TAPE_CAP): TradeView[] {
  return current;
}
