//! Slot → block-time resolution for indexed fills (product-v3 REQ-K-1):
//! a per-slot cache over `getBlockTime`, falling back to the ingestion clock.

export interface SlotClock {
  /** The slot's block time in ms (seconds × 1000); falls back to the ingestion clock. */
  timeForSlot(slot: number): Promise<number>;
}

export interface SlotClockOptions {
  /** Reads the chain block time (seconds) for a slot; `null` = unknown. */
  getBlockTime: (slot: number) => Promise<number | null>;
  /** Ingestion wall-clock clock (defaults to `Date.now`); the fallback + test seam. */
  now?: () => number;
  /** Max cached slot→time entries (FIFO eviction); default 1024. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 1024;

export function createSlotClock(opts: SlotClockOptions): SlotClock {
  const getBlockTime = opts.getBlockTime;
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // Slot → resolution in ms. The pending promise is cached before it resolves,
  // so concurrent callers for the same slot share one fetch: each distinct slot
  // is fetched from the block-time source exactly once. Insertion order is the
  // FIFO order; entries are never re-set, so eviction = drop the oldest key.
  const cache = new Map<number, Promise<number>>();

  /** One fetch: seconds → ms; `null`/`undefined`/throw ⇒ the ingestion clock. */
  async function resolveSlot(slot: number): Promise<number> {
    try {
      const seconds = await getBlockTime(slot);
      if (seconds === null || seconds === undefined) return now();
      return seconds * 1000;
    } catch {
      // A failed block-time read must never propagate into ingestion.
      return now();
    }
  }

  return {
    async timeForSlot(slot: number): Promise<number> {
      const cached = cache.get(slot);
      if (cached !== undefined) return cached;

      const pending = resolveSlot(slot);
      cache.set(slot, pending);
      if (cache.size > maxEntries) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return pending;
    },
  };
}
