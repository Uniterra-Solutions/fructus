//! Mark-price sampler (product-v3 candles v2): every `intervalMs` the current
//! reference price — book mid, else the pool-rate index, else the last trade —
//! is appended to `mark_samples`, so the candle series is continuous even when
//! no orders or trades exist in a bucket (a flat open==close candle).
//!
//! The sampler reads only the indexed state (`samplePrice`), never the RPC, so
//! it cannot fail on network trouble; a sample that has no price source yet is
//! skipped silently. Samples older than `RETENTION_MS` are pruned
//! opportunistically (at start and at most hourly).

import type { PublicKey } from "@solana/web3.js";
import type { Db } from "./db.js";
import { samplePrice } from "./state.js";

export interface MarkSampler {
  /** One sampling pass (exposed for tests). */
  tick(): void;
  start(): void;
  stop(): void;
}

/** 5 s default cadence; a sample per tick, idempotent per ms. */
export const DEFAULT_MARK_SAMPLE_INTERVAL_MS = 5_000;
/** Retention horizon for `mark_samples` — 3 days comfortably covers the served windows. */
export const MARK_SAMPLE_RETENTION_MS = 3 * 24 * 60 * 60 * 1_000;
/** Prune at most hourly (the retention horizon makes tighter sweeps pointless). */
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

export function createMarkSampler(opts: {
  db: Db;
  market: PublicKey;
  intervalMs?: number;
  /** Clock injection for tests; defaults to `Date.now`. */
  now?: () => number;
}): MarkSampler {
  const intervalMs = Math.max(1, opts.intervalMs ?? DEFAULT_MARK_SAMPLE_INTERVAL_MS);
  const now = opts.now ?? (() => Date.now());
  let timer: NodeJS.Timeout | null = null;
  let lastPrune = 0;

  const prune = (at: number): void => {
    if (at - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = at;
    try {
      opts.db.pruneMarkSamples(at - MARK_SAMPLE_RETENTION_MS);
    } catch (err) {
      console.error(`fructus-server: mark-sample prune failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const tick = (): void => {
    try {
      const price = samplePrice(opts.db, opts.market);
      if (price === null) return;
      const at = now();
      opts.db.insertMarkSample(at, price);
      prune(at);
    } catch (err) {
      // A sampling failure must never take the server down; the next tick retries.
      console.error(`fructus-server: mark sample failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    tick,
    start(): void {
      if (timer !== null) return;
      tick();
      timer = setInterval(tick, intervalMs);
      // Never hold the process open for samples alone (mirrors the nonce sweep).
      timer.unref?.();
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
