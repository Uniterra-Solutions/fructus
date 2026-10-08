//! Slot → block-time resolution for indexed fills (product-v3 REQ-K-1):
//! a per-slot cache over `getBlockTime`, falling back to the ingestion clock.
//! Stub — product-v3 freeze (implemented in the K-line wave).

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

export function createSlotClock(_opts: SlotClockOptions): SlotClock {
  return {
    timeForSlot: async (_slot: number) => 0,
  };
}
