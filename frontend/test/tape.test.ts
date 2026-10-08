//! RED acceptance test for product-v3 REQ-F-3 (trades-tape merge).
//! Duplicate and out-of-order trade messages converge to a unique
//! seq-descending tape capped at TAPE_CAP; head = max seq; empty incoming is a
//! no-op.
//!
//! RED on today's tree: `mergeTrades` is a stub returning the current tape
//! unchanged — folding batches leaves `[]` where the oracle holds the highest
//! `cap` seqs, so the length assertion fails behaviourally, never on a
//! compile/import error.

import { expect, it } from "vitest";
import { TAPE_CAP, mergeTrades } from "../src/lib/tape.js";
import type { TradeView } from "fructus-sdk/src/api.js";

// --- deterministic xorshift64 (repo house style) ----------------------------

const MASK64 = (1n << 64n) - 1n;
let seed = 0x9e3779b97f4a7c15n;
function next64(): bigint {
  seed ^= (seed << 13n) & MASK64;
  seed ^= seed >> 7n;
  seed ^= (seed << 17n) & MASK64;
  seed &= MASK64;
  return seed;
}
const pick = (n: number): number => Number(next64() % BigInt(n));

function mkRow(seq: number): TradeView {
  return {
    seq: String(seq),
    slot: String(100 + seq),
    timeMs: String(1_700_000_000_000 + seq * 1_000),
    owner: "OWNER",
    side: seq % 2 === 0 ? 0 : 1,
    price: String(1_000_000 + seq),
    size: String(seq * 1_000),
  };
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

/** Shuffled delivery with duplicates injected, cut into random batches. */
function deliver(fills: TradeView[], duplicateCount: number, batchMax: number): TradeView[][] {
  const delivery = shuffle(fills);
  for (let d = 0; d < duplicateCount; d++) {
    const donor = delivery[pick(delivery.length)];
    delivery.splice(pick(delivery.length + 1), 0, donor);
  }
  const batches: TradeView[][] = [];
  let i = 0;
  while (i < delivery.length) {
    const size = 1 + pick(batchMax);
    batches.push(delivery.slice(i, i + size));
    i += size;
  }
  return batches;
}

it("TAPE-DEDUPES-AND-ORDERS: duplicate and out-of-order trade messages converge to a unique seq-descending tape capped at 50", () => {
  expect(TAPE_CAP).toBe(50);

  const rounds: Array<{ unique: number; cap: number; duplicates: number; batchMax: number }> = [
    { unique: 10, cap: TAPE_CAP, duplicates: 3, batchMax: 4 },
    { unique: 55, cap: TAPE_CAP, duplicates: 9, batchMax: 7 },
    { unique: 120, cap: TAPE_CAP, duplicates: 25, batchMax: 13 },
    { unique: 200, cap: TAPE_CAP, duplicates: 40, batchMax: 11 },
    { unique: 200, cap: 3, duplicates: 17, batchMax: 9 },
    { unique: 30, cap: TAPE_CAP, duplicates: 6, batchMax: 5 },
  ];

  for (const round of rounds) {
    const fills = Array.from({ length: round.unique }, (_, i) => mkRow(i + 1));

    const merge = (prev: TradeView[], batch: TradeView[]): TradeView[] =>
      round.cap === TAPE_CAP ? mergeTrades(prev, batch) : mergeTrades(prev, batch, round.cap);

    const batches = deliver(fills, round.duplicates, round.batchMax);
    const delivered = batches.flat();
    expect(new Set(delivered.map((trade) => trade.seq)).size).toBe(round.unique); // every seq delivered
    expect(delivered.length).toBeGreaterThan(round.unique); // duplicates were injected

    let tape: TradeView[] = [];
    for (const batch of batches) tape = merge(tape, batch);

    // The exact highest `cap` seqs, descending.
    const expected = fills.slice(-round.cap).reverse();
    expect(tape.length).toBe(Math.min(round.unique, round.cap));
    expect(tape).toEqual(expected);

    // Head = max seq seen; strictly descending; deduped by seq.
    expect(tape[0].seq).toBe(String(round.unique));
    expect(tape.every((trade, i) => i === 0 || BigInt(tape[i - 1].seq) > BigInt(trade.seq))).toBe(true);
    expect(new Set(tape.map((trade) => trade.seq)).size).toBe(tape.length);
    if (round.unique > round.cap) {
      // min seq kept == maxSeq − cap + 1
      expect(BigInt(tape[tape.length - 1].seq)).toBe(BigInt(round.unique - round.cap + 1));
    }

    // Convergence: a different shuffled delivery of the same set yields the identical tape.
    const batchesAgain = deliver(fills, round.duplicates + 5, round.batchMax + 3);
    let tapeAgain: TradeView[] = [];
    for (const batch of batchesAgain) tapeAgain = merge(tapeAgain, batch);
    expect(tapeAgain).toEqual(tape);

    // Empty incoming: the tape is left unchanged (both with default and explicit cap).
    expect(mergeTrades(tape, [])).toEqual(tape);
    expect(mergeTrades(tape, [], round.cap)).toEqual(tape);
  }
});
