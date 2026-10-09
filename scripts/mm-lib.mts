//! Market-maker quote math (product-v3 REQ-M-1): pure planning functions.
//!
//! Contract (pinned by `test/mm-lib.test.ts`):
//!  - `resolveAnchor(index)` = the trustless index rate (`null` ⇒ 0n, the
//!    caller skips the cycle); the book mid never drags the ladder;
//!  - level k (1-based): `bid_k = floor(anchor·(10000 − k·spreadBps) / 10000)`,
//!    `ask_k = ceil(anchor·(10000 + k·spreadBps) / 10000)` — integer BigInt math;
//!  - a quote is skipped when it would cross the book (`bid_k ≥ bestAsk` or
//!    `ask_k ≤ bestBid`, evaluated per quote; `null` = no constraint); quotes
//!    with price ≤ 0 are never emitted;
//!  - per side, quotes come out in level order `k = 1..levels` (best-first);
//!    every quote carries `params.size`;
//!  - `planRequote` cancels exactly the own orders not covered by a desired
//!    quote (identity: side+price+size) and places exactly the desired quotes
//!    not already resting; desired order is preserved in `places`.

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

/** Per-side ladder bound (PRD REQ-M-1: `MM_LEVELS` 1..8). */
const MAX_LEVELS = 8;
/** Per-level spread bound in basis points (PRD REQ-M-1: `MM_SPREAD_BPS` 1..10000). */
const MAX_SPREAD_BPS = 10_000;
/** Broker loop floor (PRD REQ-M-1: `MM_INTERVAL_MS` minimum 5000). */
const MIN_INTERVAL_MS = 5_000;

const TEN_K = 10_000n;

/** Parse a digits-only integer within `[min, max]`; `null` on anything else. */
function parseBoundedInt(raw: string, min: number, max: number): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

/** `true` iff `raw` is a digits-only string encoding a value > 0. */
function isPositiveDecimal(raw: string): boolean {
  return /^[0-9]+$/.test(raw) && BigInt(raw) > 0n;
}

/** Parse MM_* env overrides; `null` = invalid configuration. */
export function parseQuoteParams(env: Record<string, string | undefined>): QuoteParams | null {
  const levels =
    env.MM_LEVELS === undefined
      ? MM_DEFAULTS.levels
      : parseBoundedInt(env.MM_LEVELS, 1, MAX_LEVELS);
  if (levels === null) return null;

  const spreadBps =
    env.MM_SPREAD_BPS === undefined
      ? MM_DEFAULTS.spreadBps
      : parseBoundedInt(env.MM_SPREAD_BPS, 1, MAX_SPREAD_BPS);
  if (spreadBps === null) return null;

  const size = env.MM_SIZE === undefined ? MM_DEFAULTS.size : env.MM_SIZE;
  if (!isPositiveDecimal(size)) return null;

  return { levels, spreadBps, size };
}

/**
 * Parse `MM_INTERVAL_MS`: default `MM_DEFAULTS.intervalMs`, floored at 5000 ms
 * (PRD REQ-M-1). A non-numeric override falls back to the default rather than
 * killing the bot; there is no upper bound.
 */
export function parseIntervalMs(env: Record<string, string | undefined>): number {
  const raw = env.MM_INTERVAL_MS;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return MM_DEFAULTS.intervalMs;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return MM_DEFAULTS.intervalMs;
  return value < MIN_INTERVAL_MS ? MIN_INTERVAL_MS : value;
}

/**
 * Anchor = the trustless index rate. The book mid is self-referential while
 * the book only carries the MM's own quotes, so it must not drag the ladder
 * away from the index.
 */
export function resolveAnchor(index: bigint | null): bigint {
  return index ?? 0n;
}

/**
 * Plan the two-sided quote grid: level k at ±k×spread bps from `anchor`,
 * skipping any quote that would cross the book (per-quote check; `null` best
 * bid/ask = no constraint) and any quote whose price would be ≤ 0. Bids floor,
 * asks ceil, so quotes round away from the anchor/inside the book. Per side the
 * quotes are best-first (k = 1..levels); the return is bids then asks.
 */
export function planQuotes(
  anchor: bigint,
  bestBid: bigint | null,
  bestAsk: bigint | null,
  params: QuoteParams,
): Quote[] {
  const bids: Quote[] = [];
  const asks: Quote[] = [];
  const spread = BigInt(params.spreadBps);

  for (let k = 1; k <= params.levels; k++) {
    const level = BigInt(k);
    const bid = (anchor * (TEN_K - level * spread)) / TEN_K; // floor (anchor ≥ 0)
    const ask = (anchor * (TEN_K + level * spread) + TEN_K - 1n) / TEN_K; // ceil

    if (bid > 0n && (bestAsk === null || bid < bestAsk)) {
      bids.push({ side: 0, price: bid.toString(), size: params.size });
    }
    if (ask > 0n && (bestBid === null || ask > bestBid)) {
      asks.push({ side: 1, price: ask.toString(), size: params.size });
    }
  }

  return [...bids, ...asks];
}

/**
 * Diff the desired grid against the bot's resting orders: cancel exactly the
 * own orders not covered by a desired quote (identity: side+price+size,
 * matched one-to-one so a duplicate resting order still yields a cancel), and
 * place exactly the desired quotes not already resting, in desired order.
 */
export function planRequote(ownOrders: OwnOrder[], desired: Quote[]): RequotePlan {
  const taken = new Array<boolean>(desired.length).fill(false);
  const cancels: OwnOrder[] = [];

  for (const own of ownOrders) {
    const match = desired.findIndex(
      (q, i) => !taken[i] && q.side === own.side && q.price === own.price && q.size === own.size,
    );
    if (match >= 0) {
      taken[match] = true;
    } else {
      cancels.push(own);
    }
  }

  const places = desired.filter((_, i) => !taken[i]);
  return { cancels, places };
}
