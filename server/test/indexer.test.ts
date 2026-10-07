//! RED acceptance tests for the chain indexer (D12, REQ-B-2):
//!
//!  - `INDEXER-EVENT-DIFF-NO-LOSS-NO-DUP` — folding any snapshot sequence
//!    (out-of-order, duplicated, wrapped, gapped→resync) through the pure
//!    `foldIndexerEvents` seam yields each fill/funding event exactly once, in
//!    seq order, with correct fields.
//!  - `INDEXER-STATE-MATCHES-CHAIN` (e2e) — after `createIndexer(...).resync()`
//!    against a live hermetic validator, every indexed account in SQLite is
//!    byte-identical to a direct `getProgramAccounts` read.
//!
//! RED on today's tree: `foldIndexerEvents` is a conservative STUB (`fills: []`)
//! and `createIndexer(...).resync()` is a no-op, so every test below fails on an
//! assertion — never on a compile/import error.
//!
//! Deterministic style: seeded xorshift64 (same PRNG as
//! `sdk/test/review-invariants.test.ts`), `node:test`, `assert/strict`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import {
  EVENT_QUEUE_LEN,
  PROGRAM_ID,
  buildDepositCollateral,
  marketPda,
  userCollateralPda,
} from "fructus-sdk/src/index.js";
import { decodeUserCollateral, type OutEventState } from "fructus-sdk/src/account/decode.js";
import { ACCOUNT_DISCRIMINATORS } from "fructus-sdk/src/encoding.js";
import {
  createIndexer,
  foldIndexerEvents,
  type Indexer,
  type IndexerFoldState,
  type MarketFundingSnapshot,
  type OrderBookEventSnapshot,
} from "../src/indexer.js";
import {
  ACCOUNT_KINDS,
  openDb,
  type AccountKind,
  type Db,
  type FillRow,
  type FundingEventRow,
} from "../src/db.js";
import {
  DEFAULT_MARKET,
  createMint,
  fundTrader,
  initMarket,
  startValidator,
  stopAll,
  submit,
} from "./harness.js";

const MARKET = marketPda(PROGRAM_ID).address.toBase58();

/** A deterministic xorshift64 PRNG so a divergence reproduces exactly. */
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

/** Uniform integer in `[0, m)` from the PRNG. */
function pick(rng: () => number, m: number): number {
  return Number(BigInt(rng()) % BigInt(m));
}

/** Uniform bigint in `[lo, hi]`. */
function bigInRange(rng: () => number, lo: bigint, hi: bigint): bigint {
  return lo + (BigInt(rng()) % (hi - lo + 1n));
}

const OWNERS: PublicKey[] = [1, 2, 3].map(
  (fill) => Keypair.fromSeed(new Uint8Array(32).fill(fill)).publicKey,
);

// ---------------------------------------------------------------------------
// Model helpers: build rings exactly the way the on-chain OrderBook does —
// event with seq `s` lands at physical index `s % EVENT_QUEUE_LEN`, unwritten
// slots stay the all-zero default (whose `seq` is 0 AND `kind` is Fill(0), so
// they are a real phantom-fill trap).
// ---------------------------------------------------------------------------

interface ModelEvent {
  seq: bigint;
  kind: number;
  side: number;
  price: bigint;
  size: bigint;
  ownerIdx: number;
}

function makeLog(rng: () => number, n: number): ModelEvent[] {
  const out: ModelEvent[] = [];
  for (let i = 0; i < n; i++) {
    const roll = pick(rng, 100);
    out.push({
      seq: BigInt(i),
      kind: roll < 80 ? 0 : roll < 90 ? 1 : 2, // 0 = Fill, 1 = Cancel, 2 = Residual
      side: pick(rng, 2),
      price: bigInRange(rng, 1_000n, 1_000_000n),
      size: bigInRange(rng, 1n, 1_000_000n),
      ownerIdx: pick(rng, OWNERS.length),
    });
  }
  return out;
}

/** A fully deterministic fill-only log: `seq = i`, `price = 1e6 + i`, `size = 10 + i`. */
function fixedLog(n: number): ModelEvent[] {
  const out: ModelEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      seq: BigInt(i),
      kind: 0,
      side: i % 2,
      price: 1_000_000n + BigInt(i),
      size: 10n + BigInt(i),
      ownerIdx: i % OWNERS.length,
    });
  }
  return out;
}

function zeroEvent(): OutEventState {
  return {
    seq: 0n,
    price: 0n,
    size: 0n,
    owner: PublicKey.default,
    counterparty: PublicKey.default,
    entryTotalLamports: 0n,
    entryPoolTokenSupply: 0n,
    settled: 0,
    kind: 0,
    side: 0,
  };
}

function ringFor(log: ModelEvent[], cursor: number): OutEventState[] {
  const ring: OutEventState[] = Array.from({ length: EVENT_QUEUE_LEN }, zeroEvent);
  for (let s = Math.max(0, cursor - EVENT_QUEUE_LEN); s < cursor; s++) {
    const ev = log[s];
    ring[s % EVENT_QUEUE_LEN] = {
      seq: ev.seq,
      price: ev.price,
      size: ev.size,
      owner: OWNERS[ev.ownerIdx],
      counterparty: OWNERS[(ev.ownerIdx + 1) % OWNERS.length],
      entryTotalLamports: 0n,
      entryPoolTokenSupply: 0n,
      settled: 0,
      kind: ev.kind,
      side: ev.side,
    };
  }
  return ring;
}

function fillRowFor(ev: ModelEvent, slot: number): FillRow {
  return {
    seq: Number(ev.seq),
    slot,
    market: MARKET,
    owner: OWNERS[ev.ownerIdx].toBase58(),
    side: ev.side,
    price: ev.price.toString(),
    size: ev.size.toString(),
  };
}

/**
 * Deliver `deliveries` (indices into `cursors`) through the fold and compare
 * against the model: every event that any delivered ring contains, exactly
 * once, in seq order. `slot` of a fill = the slot of the snapshot that FIRST
 * delivered its event (the seam contract).
 */
function checkFills(
  label: string,
  log: ModelEvent[],
  cursors: number[],
  deliveries: number[],
): { actual: FillRow[]; expected: FillRow[] } {
  const rings = cursors.map((cursor) => ringFor(log, cursor));
  const slots = cursors.map((cursor) => 10_000 + cursor);

  const firstSlot = new Map<number, number>();
  for (const d of deliveries) {
    const cursor = cursors[d];
    for (let s = Math.max(0, cursor - EVENT_QUEUE_LEN); s < cursor; s++) {
      if (!firstSlot.has(s)) firstSlot.set(s, slots[d]);
    }
  }
  const expected: FillRow[] = [];
  for (let s = 0; s < log.length; s++) {
    if (log[s].kind === 0 && firstSlot.has(s)) {
      expected.push(fillRowFor(log[s], firstSlot.get(s)!));
    }
  }

  let state: IndexerFoldState | null = null;
  const actual: FillRow[] = [];
  for (const d of deliveries) {
    const snapshot: OrderBookEventSnapshot = {
      kind: "order_book",
      market: MARKET,
      slot: slots[d],
      eventWriteCursor: BigInt(cursors[d]),
      events: rings[d],
    };
    const result = foldIndexerEvents(state, snapshot);
    state = result.state;
    actual.push(...result.fills);
  }

  assert.equal(
    actual.length,
    expected.length,
    `${label}: folded ${actual.length} fill(s), expected ${expected.length} — exactly-once/no-loss violated`,
  );
  assert.deepEqual(actual, expected, `${label}: folded fills differ from the delivered ring model`);
  for (let i = 1; i < actual.length; i++) {
    assert.ok(actual[i].seq > actual[i - 1].seq, `${label}: fills must be strictly seq-ascending`);
  }
  return { actual, expected };
}

// ---------------------------------------------------------------------------
// Funding model helpers
// ---------------------------------------------------------------------------

interface FundingSnap {
  slot: number;
  epoch: bigint;
  acc: bigint;
}

/**
 * Contract: the first snapshot is the baseline (no row); a snapshot with a
 * newer slot folds exactly one row per accumulator change (`amount` = signed
 * delta vs the last folded accumulator); an equal-or-older slot (duplicate or
 * stale delivery) is a no-op; an unchanged accumulator folds nothing.
 */
function checkFunding(
  label: string,
  snaps: FundingSnap[],
  deliveries: number[],
): { actual: FundingEventRow[]; expected: FundingEventRow[] } {
  const expected: FundingEventRow[] = [];
  let lastSlot = -1;
  let lastAcc: bigint | null = null;
  let seq = 1;
  for (const d of deliveries) {
    const s = snaps[d];
    if (lastAcc === null) {
      lastAcc = s.acc;
      lastSlot = s.slot;
      continue;
    }
    if (s.slot <= lastSlot) continue;
    lastSlot = s.slot;
    if (s.acc !== lastAcc) {
      expected.push({ seq: seq++, slot: s.slot, market: MARKET, amount: (s.acc - lastAcc).toString() });
      lastAcc = s.acc;
    }
  }

  let state: IndexerFoldState | null = null;
  const actual: FundingEventRow[] = [];
  for (const d of deliveries) {
    const s = snaps[d];
    const snapshot: MarketFundingSnapshot = {
      kind: "market",
      market: MARKET,
      slot: s.slot,
      fundingEpoch: s.epoch,
      fundingAccumulator: s.acc,
    };
    const result = foldIndexerEvents(state, snapshot);
    state = result.state;
    actual.push(...result.fundingEvents);
  }

  assert.equal(
    actual.length,
    expected.length,
    `${label}: folded ${actual.length} funding event(s), expected ${expected.length} — exactly-once violated`,
  );
  assert.deepEqual(actual, expected, `${label}: folded funding events differ from the delivery model`);
  for (let i = 1; i < actual.length; i++) {
    assert.ok(actual[i].seq > actual[i - 1].seq, `${label}: funding rows must be strictly seq-ascending`);
  }
  return { actual, expected };
}

// ---------------------------------------------------------------------------
// Seeded sweeps — INDEXER-EVENT-DIFF-NO-LOSS-NO-DUP
// ---------------------------------------------------------------------------

/** Coverage of `[0, n)` by the KEPT ring windows (windows slide monotonically). */
function coversAll(cursors: number[], keep: boolean[], n: number): boolean {
  let need = 0;
  for (let i = 0; i < cursors.length; i++) {
    if (!keep[i]) continue;
    if (cursors[i] <= need) continue;
    if (Math.max(0, cursors[i] - EVENT_QUEUE_LEN) > need) return false;
    need = cursors[i];
    if (need >= n) return true;
  }
  return need >= n;
}

test("INDEXER-EVENT-DIFF-NO-LOSS-NO-DUP: seeded fill-ring sweep folds every event exactly once, in seq order", () => {
  for (let caseIdx = 0; caseIdx < 240; caseIdx++) {
    const rng = xorshift(0xc0ffee ^ (caseIdx * 2654435761));

    const n = 40 + pick(rng, 361); // 40..400 events
    const log = makeLog(rng, n);

    // Checkpoints: every delivered snapshot is the ring at some write cursor.
    const cursors: number[] = [];
    let w = 1 + pick(rng, 31); // initial ring: seqs 0..w-1
    cursors.push(w);
    while (w < n) {
      w = Math.min(n, w + 1 + pick(rng, 15));
      cursors.push(w);
    }

    // Drop ~12% of the middle checkpoints (delivery gaps); repair until the
    // kept windows still cover every event, so "exactly once" is achievable.
    const keep = cursors.map((_, i) => i === 0 || pick(rng, 100) >= 12);
    for (let i = 0; i < cursors.length && !coversAll(cursors, keep, n); i++) keep[i] = true;

    // Deliver: the initial baseline ring FIRST (the indexer's resync snapshot),
    // then the rest in a seeded shuffle + re-deliveries (duplicates/stale).
    const rest = cursors.map((_, i) => i).filter((i) => i > 0 && keep[i]);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = pick(rng, i + 1);
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const deliveries: number[] = [0];
    for (const d of rest) {
      deliveries.push(d);
      if (pick(rng, 100) < 22) deliveries.push(d); // immediate duplicate
    }
    for (let k = 0; k < 3; k++) {
      // a stale re-delivery interleaved later (never before the baseline)
      deliveries.splice(1 + pick(rng, deliveries.length), 0, deliveries[pick(rng, deliveries.length)]);
    }

    checkFills(`fill case ${caseIdx} (n=${n}, cursors=${cursors.length}, deliveries=${deliveries.length})`, log, cursors, deliveries);
  }
});

test("INDEXER-EVENT-DIFF-NO-LOSS-NO-DUP: seeded funding sweep folds every accumulator change exactly once", () => {
  for (let caseIdx = 0; caseIdx < 160; caseIdx++) {
    const rng = xorshift(0xf00d ^ (caseIdx * 40503));

    const snaps: FundingSnap[] = [];
    let slot = 3 + pick(rng, 10);
    let epoch = 0n;
    let acc = bigInRange(rng, -(10n ** 12n), 10n ** 12n);
    snaps.push({ slot, epoch, acc });
    const count = 5 + pick(rng, 36);
    for (let k = 0; k < count; k++) {
      if (pick(rng, 100) < 80) {
        const delta = bigInRange(rng, -(10n ** 9n), 10n ** 9n);
        acc += delta === 0n ? 7n : delta; // signed accumulator walk
      }
      slot += 1 + pick(rng, 7);
      epoch += BigInt(pick(rng, 2));
      snaps.push({ slot, epoch, acc });
    }

    const deliveries: number[] = [];
    for (let i = 0; i < snaps.length; i++) {
      if (i > 0 && i < snaps.length - 1 && pick(rng, 100) < 10) continue; // delivery gap
      deliveries.push(i);
      if (pick(rng, 100) < 30) deliveries.push(i); // duplicate delivery
    }
    for (let k = 0; k < 3; k++) {
      deliveries.push(pick(rng, snaps.length - 1)); // stale (older-slot) re-delivery
    }

    const { actual } = checkFunding(`funding case ${caseIdx} (snaps=${snaps.length})`, snaps, deliveries);

    // Independent invariant: the folded diffs must telescope to the first/last
    // delivered accumulator, no matter the gaps and duplicates in between.
    const sum = actual.reduce((total, row) => total + BigInt(row.amount), 0n);
    const maxIdx = Math.max(...deliveries);
    const minIdx = Math.min(...deliveries);
    assert.equal(
      sum,
      snaps[maxIdx].acc - snaps[minIdx].acc,
      `funding case ${caseIdx}: folded deltas must telescope (no value lost or invented)`,
    );
  }
});

// ---------------------------------------------------------------------------
// Hostile specials (deterministic)
// ---------------------------------------------------------------------------

test("hostile: an empty ring folds nothing; a single-fill ring folds exactly once", () => {
  checkFills("empty ring (write cursor 0)", [], [0], [0, 0, 0, 0, 0]);

  const single: ModelEvent[] = [
    { seq: 0n, kind: 0, side: 0, price: 123_456n, size: 789n, ownerIdx: 0 },
  ];
  const { actual } = checkFills("single fill (seq 0)", single, [1], [0, 0, 0, 0, 0]);
  assert.deepEqual(actual, [fillRowFor(single[0], 10_001)], "single fill must round-trip its fields");
});

test("hostile: a full ring wrap emits in seq order and a duplicate burst is a no-op", () => {
  const log = fixedLog(40);
  // Write cursor 40 ⇒ the ring holds seqs 8..39; physical order wraps
  // (index 0..7 hold 32..39, index 8..31 hold 8..31) — NOT seq-sorted on disk.
  const { actual } = checkFills("full wrap (cursor 40, 6 duplicate deliveries)", log, [40], [0, 0, 0, 0, 0, 0]);
  assert.equal(actual.length, 32, "the wrapped ring holds exactly EVENT_QUEUE_LEN events");
  assert.deepEqual(actual[0], fillRowFor(log[8], 10_040), "first emitted fill is the oldest in the ring (seq 8)");
  assert.deepEqual(actual[31], fillRowFor(log[39], 10_040), "last emitted fill is the newest in the ring (seq 39)");
});

test("hostile: unwritten ring slots (default seq 0) are not phantom fills", () => {
  // Write cursor 3 ⇒ slots 3..31 are the all-zero default, whose `seq` is 0 and
  // whose `kind` is Fill(0) — they must not duplicate or fabricate fills.
  const log = fixedLog(4);
  const { actual } = checkFills("unwrapped ring with default slots", log, [3, 4], [0, 1]);
  assert.equal(actual.length, 4, "only the four written events fold");
  assert.deepEqual(
    actual.map((row) => row.seq),
    [0, 1, 2, 3],
    "written seqs fold in order; the default slots add nothing",
  );
});

test("hostile: only Fill (kind 0) events become fills; cancels/residuals still advance the watermark", () => {
  const log: ModelEvent[] = [
    { seq: 0n, kind: 0, side: 0, price: 100n, size: 1n, ownerIdx: 0 },
    { seq: 1n, kind: 1, side: 0, price: 101n, size: 2n, ownerIdx: 1 }, // Cancel
    { seq: 2n, kind: 2, side: 1, price: 102n, size: 3n, ownerIdx: 2 }, // Residual
    { seq: 3n, kind: 0, side: 1, price: 103n, size: 4n, ownerIdx: 0 },
  ];
  const { actual } = checkFills("mixed kinds in one ring", log, [4], [0]);
  assert.deepEqual(
    actual.map((row) => row.seq),
    [0, 3],
    "kinds 1/2 fold no rows",
  );

  // A later fill must still drain: the cancel/residual seqs are consumed (they
  // sit below the watermark), so the drain never stalls behind them.
  const extended = [...log, { seq: 4n, kind: 0, side: 0, price: 104n, size: 5n, ownerIdx: 1 }];
  const next = checkFills("continuation after cancels", extended, [4, 5], [0, 1]);
  assert.deepEqual(
    next.actual.map((row) => row.seq),
    [0, 3, 4],
    "seq 4 folds even though seqs 1/2 were non-fill events",
  );
});

test("hostile: out-of-order deliveries buffer ahead-of-gap events and re-drain in seq order", () => {
  // Baseline ring at cursor 4 (seqs 0..3). Then the NEWER ring (cursor 60,
  // seqs 28..59) arrives BEFORE the older ring (cursor 36, seqs 4..35) that
  // covers the gap. Folding the newer ring's events immediately would lose
  // seqs 4..27 forever; a correct fold buffers and drains 0..59 in order.
  const log = fixedLog(60);
  const { actual } = checkFills("out-of-order rings (60 then 36)", log, [4, 60, 36], [0, 1, 2]);
  assert.equal(actual.length, 60, "every delivered event folds exactly once");
  assert.deepEqual(
    actual.map((row) => row.seq),
    Array.from({ length: 60 }, (_, i) => i),
    "fills are emitted in seq order across the reordered deliveries",
  );
  assert.deepEqual(actual[4], fillRowFor(log[4], 10_036), "seq 4 first arrived with the cursor-36 ring");
  assert.deepEqual(actual[28], fillRowFor(log[28], 10_060), "seq 28 first arrived with the cursor-60 ring");
});

test("hostile: a delivery gap is recovered by the next (resync) snapshot", () => {
  // Baseline at cursor 8 (seqs 0..7). Snapshots at cursors 16/24/32 were missed
  // (socket gap). The resync snapshot at cursor 40 still holds seqs 8..39 in the
  // 32-slot ring, so the fold recovers them; another gap, then a resync at 64
  // recovers 40..63. Every event lands exactly once, in seq order.
  const log = fixedLog(64);
  const { actual } = checkFills("gap → resync (cursors 8, 40, 64)", log, [8, 40, 64], [0, 1, 2]);
  assert.equal(actual.length, 64, "all 64 events recovered across the two gaps");
  assert.deepEqual(
    actual.map((row) => row.seq),
    Array.from({ length: 64 }, (_, i) => i),
    "recovered fills are contiguous and seq-ordered",
  );
});

test("hostile: funding duplicates, no-change deliveries and stale re-deliveries are no-ops", () => {
  const snaps: FundingSnap[] = [
    { slot: 10, epoch: 0n, acc: 1_000n }, // baseline — folds nothing
    { slot: 12, epoch: 1n, acc: 1_250n },
    { slot: 15, epoch: 1n, acc: 1_250n }, // newer slot, unchanged accumulator
    { slot: 19, epoch: 2n, acc: 900n }, // signed move downwards
  ];
  const { actual } = checkFunding("funding specials", snaps, [0, 0, 1, 2, 1, 3, 2]);
  assert.deepEqual(
    actual,
    [
      { seq: 1, slot: 12, market: MARKET, amount: "250" },
      { seq: 2, slot: 19, market: MARKET, amount: "-350" },
    ] as FundingEventRow[],
    "one signed row per accumulator change; duplicates and the stale slot-12 replay fold nothing",
  );
});

test("one fold state threads order-book and market snapshots together", () => {
  const log = fixedLog(40);
  let state: IndexerFoldState | null = null;

  const r1 = foldIndexerEvents(state, {
    kind: "order_book",
    market: MARKET,
    slot: 1_000,
    eventWriteCursor: 32n,
    events: ringFor(log, 32),
  });
  state = r1.state;

  const r2 = foldIndexerEvents(state, {
    kind: "market",
    market: MARKET,
    slot: 1_001,
    fundingEpoch: 1n,
    fundingAccumulator: 500n,
  });
  state = r2.state;

  const r3 = foldIndexerEvents(state, {
    kind: "order_book",
    market: MARKET,
    slot: 1_002,
    eventWriteCursor: 40n,
    events: ringFor(log, 40),
  });
  state = r3.state;

  const r4 = foldIndexerEvents(state, {
    kind: "market",
    market: MARKET,
    slot: 1_003,
    fundingEpoch: 2n,
    fundingAccumulator: 750n,
  });

  assert.equal(r1.fills.length, 32, "the baseline ring folds its 32 events");
  assert.deepEqual(
    r1.fills,
    fixedLog(32).map((ev) => fillRowFor(ev, 1_000)),
    "baseline fill fields",
  );
  assert.deepEqual(r2.fundingEvents, [], "the first market snapshot is the funding baseline");
  assert.deepEqual(
    r3.fills,
    fixedLog(40)
      .slice(32)
      .map((ev) => fillRowFor(ev, 1_002)),
    "only seqs 32..39 are new after a re-delivered overlap",
  );
  assert.deepEqual(
    r4.fundingEvents,
    [{ seq: 1, slot: 1_003, market: MARKET, amount: "250" }] as FundingEventRow[],
    "the accumulator diff folds through the same state",
  );
});

// ---------------------------------------------------------------------------
// INDEXER-STATE-MATCHES-CHAIN (e2e, harness validator)
// ---------------------------------------------------------------------------

const KIND_BY_TYPE_NAME: Record<string, AccountKind> = {
  YieldOracle: "oracle",
  PerpMarket: "market",
  OrderBook: "order_book",
  UserCollateral: "user_collateral",
  Position: "position",
  Operator: "operator",
};

const KIND_BY_DISCRIMINATOR = new Map<string, AccountKind>(
  Object.entries(ACCOUNT_DISCRIMINATORS).map(([name, bytes]) => [
    bytes.join(","),
    KIND_BY_TYPE_NAME[name] as AccountKind,
  ]),
);

/** Every program account must have a byte-identical indexed row — and back. */
async function compareIndexedState(
  label: string,
  db: Db,
  connection: Connection,
  programId: PublicKey,
): Promise<void> {
  const chainAccounts = await connection.getProgramAccounts(programId, { commitment: "confirmed" });
  assert.ok(
    chainAccounts.length >= 4,
    `${label}: expected >= 4 program accounts (market + order_book + 2 user_collateral), got ${chainAccounts.length}`,
  );

  let indexedRows = 0;
  for (const { pubkey, account } of chainAccounts) {
    const data = account.data;
    const kind = KIND_BY_DISCRIMINATOR.get(data.subarray(0, 8).join(",")) ?? null;
    assert.notEqual(
      kind,
      null,
      `${label}: unrecognised account discriminator ${data.subarray(0, 8).toString("hex")} at ${pubkey.toBase58()}`,
    );
    const row = db.getAccount(kind as AccountKind, pubkey.toBase58());
    assert.ok(
      row !== null,
      `${label}: no indexed row for ${kind} ${pubkey.toBase58()} — the indexer resync did not index this account (STUB)`,
    );
    assert.equal(
      Buffer.from(row!.data).equals(data),
      true,
      `${label}: indexed bytes differ from the chain for ${kind} ${pubkey.toBase58()}`,
    );
    indexedRows++;
  }

  let storedRows = 0;
  for (const kind of ACCOUNT_KINDS) {
    for (const row of db.listAccounts(kind)) {
      assert.ok(
        chainAccounts.some((a) => a.pubkey.toBase58() === row.pubkey),
        `${label}: phantom indexed row ${kind} ${row.pubkey} has no chain account`,
      );
      storedRows++;
    }
  }
  assert.equal(storedRows, indexedRows, `${label}: indexed row count must equal the chain account count`);
}

test("INDEXER-STATE-MATCHES-CHAIN: after resync every indexed account is byte-identical to a direct RPC read", async () => {
  const validator = await startValidator();
  const db = openDb(":memory:");
  let indexer: Indexer | null = null;
  try {
    await createMint(validator);
    const env = await initMarket(validator, DEFAULT_MARKET);

    const traderA = Keypair.generate();
    const traderB = Keypair.generate();
    const ataA = await fundTrader(validator, traderA.publicKey, 50_000_000n, "trader-a");
    const ataB = await fundTrader(validator, traderB.publicKey, 25_000_000n, "trader-b");

    // Direct-protocol traffic through the SDK builders (no server involvement).
    await submit(
      validator,
      buildDepositCollateral({
        user: traderA.publicKey,
        market: env.market,
        userAta: ataA,
        collateralMint: validator.mint,
        amount: 20_000_000n,
        programId: validator.programId,
      }),
      traderA,
    );
    await submit(
      validator,
      buildDepositCollateral({
        user: traderB.publicKey,
        market: env.market,
        userAta: ataB,
        collateralMint: validator.mint,
        amount: 5_000_000n,
        programId: validator.programId,
      }),
      traderB,
    );

    indexer = createIndexer({ connection: validator.connection, db, programId: validator.programId });
    await indexer.start();
    await indexer.resync();
    await compareIndexedState("initial resync", db, validator.connection, validator.programId);

    // A later direct tx + a fresh resync must refresh the stored row too.
    await submit(
      validator,
      buildDepositCollateral({
        user: traderB.publicKey,
        market: env.market,
        userAta: ataB,
        collateralMint: validator.mint,
        amount: 3_000_000n,
        programId: validator.programId,
      }),
      traderB,
    );
    await indexer.resync();
    await compareIndexedState("post-deposit resync", db, validator.connection, validator.programId);

    const collateralB = userCollateralPda(env.market, traderB.publicKey, validator.programId).address;
    const rowB = db.getAccount("user_collateral", collateralB.toBase58());
    assert.ok(rowB !== null, "trader B collateral row missing after the second resync");
    const decodedB = decodeUserCollateral(Buffer.from(rowB!.data));
    assert.ok(decodedB !== null, "trader B collateral row does not decode with the SDK decoder");
    assert.equal(
      decodedB!.deposited,
      8_000_000n,
      "trader B `deposited` must equal the chain sum of both deposits",
    );
  } finally {
    if (indexer !== null) await indexer.stop();
    db.close();
    await stopAll();
  }
});
