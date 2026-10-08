//! RED acceptance tests for the market-maker quote math (product-v3 REQ-M-1):
//! MM-QUOTES-NEVER-CROSS-AND-BOUNDED / MM-LADDER-EXACT-OFFSETS /
//! MM-REQUOTE-PLAN-COVERS-OWN-ORDERS (ACCEPTANCE.md rows under `scripts · mm/devstack`).
//!
//! Contract pinned here (PRD REQ-M-1):
//!  - resolveAnchor(mid, index) = mid when non-null, else the index;
//!  - level k (1-based): bid_k = floor(anchor·(10000 − k·spreadBps) / 10000),
//!    ask_k = ceil(anchor·(10000 + k·spreadBps) / 10000) — integer BigInt math;
//!  - a quote is skipped when it would cross the book (bid_k ≥ bestAsk or
//!    ask_k ≤ bestBid, evaluated per quote; `null` = no constraint); quotes
//!    with price ≤ 0 are never emitted;
//!  - per side, quotes come out in level order k = 1..levels (best-first;
//!    array interleaving across the two sides is NOT pinned here); every
//!    quote carries params.size;
//!  - planRequote cancels exactly the own orders not covered by a desired
//!    quote (identity: side+price+size) and places exactly the desired quotes
//!    not already resting; desired order is preserved in `places`.
//!
//! RED on today's tree: mm-lib.mts is a freeze stub — planQuotes → [],
//! resolveAnchor → 0n, planRequote → empty — so every test below fails on a
//! clean assertion, never on a compile/import error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MM_DEFAULTS, planQuotes, planRequote, resolveAnchor } from "../mm-lib.mjs";
import type { OwnOrder, Quote, QuoteParams } from "../mm-lib.mjs";

// ---------------------------------------------------------------------------
// Seeded PRNG (repo house style: deterministic xorshift64 sweeps, no deps)
// ---------------------------------------------------------------------------

function xorshift(seed: number): () => number {
  let s = BigInt(seed >>> 0) || 1n;
  return () => {
    s ^= s << 13n;
    s ^= s >> 7n;
    s ^= s << 17n;
    s &= 0xffffffffffffffffn;
    return Number(s % 1000000000000000000n);
  };
}

function bigInRange(rng: () => number, lo: bigint, hi: bigint): bigint {
  return lo + (BigInt(rng()) % (hi - lo + 1n));
}

// ---------------------------------------------------------------------------
// In-test reference implementation (independent re-derivation of REQ-M-1)
// ---------------------------------------------------------------------------

const TEN_K = 10_000n;

/** floor(anchor·(10000 − k·s) / 10000) — bids round down, away from the book. */
function refBid(anchor: bigint, k: bigint, spreadBps: bigint): bigint {
  return (anchor * (TEN_K - k * spreadBps)) / TEN_K;
}

/** ceil(anchor·(10000 + k·s) / 10000) — asks round up, away from the book. */
function refAsk(anchor: bigint, k: bigint, spreadBps: bigint): bigint {
  return (anchor * (TEN_K + k * spreadBps) + TEN_K - 1n) / TEN_K;
}

function refPlanQuotes(
  anchor: bigint,
  bestBid: bigint | null,
  bestAsk: bigint | null,
  params: QuoteParams,
): { bids: Quote[]; asks: Quote[] } {
  const bids: Quote[] = [];
  const asks: Quote[] = [];
  const s = BigInt(params.spreadBps);
  for (let k = 1; k <= params.levels; k++) {
    const bid = refBid(anchor, BigInt(k), s);
    const ask = refAsk(anchor, BigInt(k), s);
    if (bid > 0n && (bestAsk === null || bid < bestAsk)) {
      bids.push({ side: 0, price: bid.toString(), size: params.size });
    }
    if (ask > 0n && (bestBid === null || ask > bestBid)) {
      asks.push({ side: 1, price: ask.toString(), size: params.size });
    }
  }
  return { bids, asks };
}

// ---------------------------------------------------------------------------
// MM-QUOTES-NEVER-CROSS-AND-BOUNDED
// ---------------------------------------------------------------------------

test("MM-QUOTES-NEVER-CROSS-AND-BOUNDED: for generated anchors/books/params, bids < asks strictly, no quote crosses the current book (violating levels are omitted), per-side count ≤ min(levels, capacity), prices are positive integers", () => {
  const rng = xorshift(0x4d4d);
  const ITERATIONS = 150;
  let fullGridCases = 0;
  let skippedCases = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const anchor = bigInRange(rng, 1_000_000n, 50_000_000n);
    const levels = Number(bigInRange(rng, 1n, 8n));
    const spreadBps = Number(bigInRange(rng, 1n, 1000n));
    const params: QuoteParams = { levels, spreadBps, size: "1000000" };

    // deepest grid offset = ceil(anchor·levels·s/10000); unit = level-1 offset
    const gridDepth = (anchor * BigInt(levels) * BigInt(spreadBps) + TEN_K - 1n) / TEN_K;
    const unit = (anchor * BigInt(spreadBps) + TEN_K - 1n) / TEN_K;
    const jitter = bigInRange(rng, 1n, 64n);

    let bestBid: bigint | null;
    let bestAsk: bigint | null;
    let expectFullGrid = false;
    switch (i % 6) {
      case 0: // wide two-sided book fully outside the grid — nothing may be omitted
        bestBid = anchor - gridDepth - jitter;
        bestAsk = anchor + gridDepth + jitter;
        expectFullGrid = true;
        break;
      case 1: // empty book
        bestBid = null;
        bestAsk = null;
        expectFullGrid = true;
        break;
      case 2: // ask-only book with the best ask inside the grid — top bids must yield
        bestBid = null;
        bestAsk = anchor - unit * bigInRange(rng, 1n, BigInt(levels));
        break;
      case 3: // bid-only book with the best bid inside the grid — top asks must yield
        bestAsk = null;
        bestBid = anchor + unit * bigInRange(rng, 1n, BigInt(levels));
        break;
      case 4: // two-sided book entirely below the anchor (stale book vs index anchor)
        bestAsk = anchor - unit * bigInRange(rng, 1n, BigInt(levels));
        bestBid = bestAsk - jitter;
        break;
      default: // one-sided wide book — nothing may be omitted
        if (rng() % 2 === 0) {
          bestAsk = anchor + gridDepth + jitter;
          bestBid = null;
        } else {
          bestBid = anchor - gridDepth - jitter;
          bestAsk = null;
        }
        expectFullGrid = true;
        break;
    }

    const quotes = planQuotes(anchor, bestBid, bestAsk, params);
    const ref = refPlanQuotes(anchor, bestBid, bestAsk, params);
    const bids = quotes.filter((q) => q.side === 0);
    const asks = quotes.filter((q) => q.side === 1);
    const ctx = `iter=${i} anchor=${anchor} levels=${levels} spreadBps=${spreadBps} bestBid=${bestBid} bestAsk=${bestAsk}`;

    // exact per-side price lists vs the independently recomputed reference
    assert.deepEqual(bids.map((q) => q.price), ref.bids.map((q) => q.price), `bid ladder drift (${ctx})`);
    assert.deepEqual(asks.map((q) => q.price), ref.asks.map((q) => q.price), `ask ladder drift (${ctx})`);
    assert.deepEqual(bids.map((q) => q.size), ref.bids.map((q) => q.size), `bid sizes drift (${ctx})`);
    assert.deepEqual(asks.map((q) => q.size), ref.asks.map((q) => q.size), `ask sizes drift (${ctx})`);
    assert.equal(quotes.length, ref.bids.length + ref.asks.length, `quote count drift (${ctx})`);

    // no stray quotes: side 0/1, positive integer price strings, params.size
    for (const q of quotes) {
      assert.ok(q.side === 0 || q.side === 1, `bad side ${q.side} (${ctx})`);
      assert.match(q.price, /^[0-9]+$/, `non-integer price ${q.price} (${ctx})`);
      assert.ok(BigInt(q.price) > 0n, `non-positive price ${q.price} (${ctx})`);
      assert.equal(q.size, params.size, `size drift (${ctx})`);
    }

    // strict cross-side ordering: every bid strictly below every ask
    for (const b of bids) {
      for (const a of asks) {
        assert.ok(BigInt(b.price) < BigInt(a.price), `crossing quote bid=${b.price} >= ask=${a.price} (${ctx})`);
      }
    }

    // never cross the current book
    if (bestAsk !== null) {
      for (const b of bids) {
        assert.ok(BigInt(b.price) < bestAsk, `bid ${b.price} crosses bestAsk ${bestAsk} (${ctx})`);
      }
    }
    if (bestBid !== null) {
      for (const a of asks) {
        assert.ok(BigInt(a.price) > bestBid, `ask ${a.price} crosses bestBid ${bestBid} (${ctx})`);
      }
    }

    // construction-level guarantees (non-vacuity: a []-stub fails every case)
    if (expectFullGrid) {
      assert.equal(ref.bids.length, levels, `reference self-check: wide book must build a full bid side (${ctx})`);
      assert.equal(ref.asks.length, levels, `reference self-check: wide book must build a full ask side (${ctx})`);
      assert.equal(quotes.length, 2 * levels, `full grid expected (${ctx})`);
      fullGridCases++;
    }
    if (ref.bids.length < levels || ref.asks.length < levels) skippedCases++;
  }

  // non-vacuity of the sweep itself (unreachable in the RED run — the first
  // per-side deepEqual fails long before these)
  assert.ok(fullGridCases >= 50, `full-grid coverage too thin: ${fullGridCases}/${ITERATIONS}`);
  assert.ok(skippedCases >= 50, `crossing coverage too thin: ${skippedCases}/${ITERATIONS}`);
});

// ---------------------------------------------------------------------------
// MM-LADDER-EXACT-OFFSETS
// ---------------------------------------------------------------------------

test("MM-LADDER-EXACT-OFFSETS: level k sits exactly k×spread bps away (floor/ceil direction) and one-sided books fall back to the index anchor", () => {
  // defaults pinned (PRD REQ-M-1: levels 2, 50 bps, size 1000000, interval 15 s)
  assert.deepEqual(MM_DEFAULTS, { levels: 2, spreadBps: 50, size: "1000000", intervalMs: 15_000 });

  const params: QuoteParams = { levels: 2, spreadBps: 50, size: "1000000" };

  // (a) exact ladder on a round anchor, no book
  const a = planQuotes(1_000_000n, null, null, params);
  assert.equal(a.length, 4, "no-book ladder must be the full 2×levels grid");
  assert.deepEqual(a.filter((q) => q.side === 0).map((q) => q.price), ["995000", "990000"]);
  assert.deepEqual(a.filter((q) => q.side === 1).map((q) => q.price), ["1005000", "1010000"]);

  // (b) rounding remainders: bid floors, ask ceils
  //     bid1 = floor(1_000_003·9950/10000) = floor(995002.985) = 995002
  //     ask1 = ceil(1_000_003·10050/10000) = ceil(1005003.015) = 1005004
  const b = planQuotes(1_000_003n, null, null, params);
  const bBids = b.filter((q) => q.side === 0);
  const bAsks = b.filter((q) => q.side === 1);
  assert.equal(b.length, 4, "rounding-case ladder must be the full 2×levels grid");
  assert.equal(bBids[0]?.price, "995002");
  assert.equal(bAsks[0]?.price, "1005004");
  assert.deepEqual(bBids.map((q) => q.price), ["995002", "990002"]);
  assert.deepEqual(bAsks.map((q) => q.price), ["1005004", "1010004"]);
  // exact objects: the k=1 quotes carry the pinned side/size alongside the price
  assert.deepEqual(bBids[0], { side: 0, price: "995002", size: "1000000" });
  assert.deepEqual(bAsks[0], { side: 1, price: "1005004", size: "1000000" });

  // (c) one-sided fallback: null mid ⇒ the index is the anchor; a mid ⇒ the mid wins
  assert.equal(resolveAnchor(null, 1_234_567n), 1_234_567n);
  assert.equal(resolveAnchor(999_999n, 1_234_567n), 999_999n);
  const anchor = resolveAnchor(null, 2_000_000n);
  assert.equal(anchor, 2_000_000n);
  const oneSided = planQuotes(anchor, null, 3_000_000n, { levels: 1, spreadBps: 50, size: "1000000" });
  assert.deepEqual(oneSided.filter((q) => q.side === 0).map((q) => q.price), ["1990000"]);
  assert.deepEqual(oneSided.filter((q) => q.side === 1).map((q) => q.price), ["2010000"]);
});

// ---------------------------------------------------------------------------
// MM-REQUOTE-PLAN-COVERS-OWN-ORDERS
// ---------------------------------------------------------------------------

test("MM-REQUOTE-PLAN-COVERS-OWN-ORDERS: the cancel+place plan cancels exactly the bot's resting orders and places the desired grid", () => {
  const own: OwnOrder[] = [
    { side: 0, seq: "1", price: "995000", size: "1000000" },
    { side: 1, seq: "2", price: "1005000", size: "1000000" },
    { side: 0, seq: "3", price: "994000", size: "1000000" },
  ];
  const desired: Quote[] = [
    { side: 0, price: "995000", size: "1000000" },
    { side: 1, price: "1005000", size: "1000000" },
    { side: 0, price: "990000", size: "1000000" },
  ];

  const plan = planRequote(own, desired);

  // non-vacuity: the stub returns empties — these MUST be exactly one each
  assert.equal(plan.cancels.length, 1, "seq 3 is covered by no desired quote and must be the only cancel");
  assert.equal(plan.places.length, 1, "the 990000 bid is the only uncovered desired quote and must be the only place");

  // set equality (sort before compare) + exact object identity
  assert.deepEqual(plan.cancels.map((o) => o.seq).sort(), ["3"]);
  assert.deepEqual(plan.places.map((q) => `${q.side}:${q.price}:${q.size}`).sort(), ["0:990000:1000000"]);
  assert.deepEqual(plan.cancels, [own[2]]);
  assert.deepEqual(plan.places, [{ side: 0, price: "990000", size: "1000000" }]);

  // none resting: every desired quote is placed, nothing is cancelled
  const fresh = planRequote([], desired);
  assert.deepEqual(fresh.cancels, []);
  assert.deepEqual(fresh.places, desired);
});
