//! Market-maker quote math (product-v3 REQ-M-1): pure planning functions.
//! Stub — product-v3 freeze (implemented in the MM wave).

export interface QuoteParams {
  /** Ladder depth per side. */
  levels: number;
  /** Level k sits at k × spreadBps from the anchor. */
  spreadBps: number;
  /** Raw size (u64 decimal string) per quote. */
  size: string;
}

export interface Quote {
  side: 0 | 1;
  price: string;
  size: string;
}

/** One of the bot's own resting orders (decoded from the book). */
export interface OwnOrder {
  side: 0 | 1;
  seq: string;
  price: string;
  size: string;
}

export interface RequotePlan {
  cancels: OwnOrder[];
  places: Quote[];
}

export const MM_DEFAULTS = {
  levels: 2,
  spreadBps: 50,
  size: "1000000",
  intervalMs: 15_000,
} as const;

/** Parse MM_* env overrides; `null` = invalid configuration. */
export function parseQuoteParams(_env: Record<string, string | undefined>): QuoteParams | null {
  return null;
}

/** Anchor = floor(mid) when the book is two-sided, else the index rate. */
export function resolveAnchor(_mid: bigint | null, _index: bigint): bigint {
  return 0n;
}

/** Plan the two-sided quote grid: level k at ±k×spread bps, skipping any quote that would cross the book. */
export function planQuotes(
  _anchor: bigint,
  _bestBid: bigint | null,
  _bestAsk: bigint | null,
  _params: QuoteParams,
): Quote[] {
  return [];
}

/** Diff the desired grid against the bot's resting orders: cancel stale, place missing, keep the rest. */
export function planRequote(_ownOrders: OwnOrder[], _desired: Quote[]): RequotePlan {
  return { cancels: [], places: [] };
}
