//! Trades-tape merge (dedupe by seq, newest first, bounded).

import type { TradeView } from "fructus-sdk/src/api.js";

export const TAPE_CAP = 50;

/** Merge incoming trade rows into the tape: unique by seq, descending, capped. */
export function mergeTrades(current: TradeView[], incoming: TradeView[], cap = TAPE_CAP): TradeView[] {
  // Nothing arriving: the tape (and its identity) is left untouched.
  if (incoming.length === 0) return current;

  // Union by seq; on a duplicate seq the incoming row wins (same row in practice).
  const bySeq = new Map<string, TradeView>();
  for (const trade of current) bySeq.set(trade.seq, trade);
  for (const trade of incoming) bySeq.set(trade.seq, trade);

  const merged = [...bySeq.values()].sort((a, b) => {
    const left = BigInt(a.seq);
    const right = BigInt(b.seq);
    return left === right ? 0 : left > right ? -1 : 1;
  });

  const keep = Math.max(0, Math.floor(cap));
  return merged.length > keep ? merged.slice(0, keep) : merged;
}
