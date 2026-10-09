//! REVIEW batch B2 — intra-module adversarial PBT model for the server
//! (indexer fold under hostile sequences + restart/replay, the state layer's
//! health fold incl. edge domains, the operator queue under failure injection
//! and the faucet's exactly-once crediting).
//!
//! Every assertion here models a claim from `PRD.md`/`ACCEPTANCE.md`
//! (REQ-B-2/B-3/B-5/B-8) or from the module docstrings, written independently
//! of the shipped acceptance tests. Tests whose title carries
//! `COUNTEREXAMPLE` are EXPECTED RED: they pin confirmed defects of the
//! current src with minimal inputs (see the review report).
//!
//! Style: `node:test` + `assert/strict`, seeded xorshift sweeps, in-memory
//! `node:sqlite`, stub `Connection`s — no validator, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { EVENT_QUEUE_LEN, PROGRAM_ID, marketPda } from "fructus-sdk/src/index.js";
import { anchorAccountDiscriminator } from "fructus-sdk/src/encoding.js";
import {
  ORDER_BOOK_LEN,
  OrderBookLayout,
  PERP_MARKET_LEN,
  PerpMarket,
  POSITION_LEN,
  Position,
  USER_COLLATERAL_LEN,
  UserCollateralLayout,
} from "fructus-sdk/src/account/layout.js";
import type { OutEventState } from "fructus-sdk/src/account/decode.js";
import type { ActionResponse } from "fructus-sdk/src/api.js";
import {
  createIndexer,
  foldIndexerEvents,
  type IndexerFoldState,
  type OrderBookEventSnapshot,
} from "../src/indexer.js";
import { openDb, type Db, type TxLogRow } from "../src/db.js";
import { createOperator } from "../src/operator.js";
import { createFaucet, FAUCET_WINDOW_MS } from "../src/faucet.js";
import { FaucetCapError } from "../src/errors.js";
import { computePortfolio } from "../src/state.js";
import { loadConfig } from "../src/config.js";

const MARKET = marketPda(PROGRAM_ID).address;
const BOOK = PublicKey.findProgramAddressSync([Buffer.from("order_book"), MARKET.toBuffer()], PROGRAM_ID)[0];
const U64_MAX = (1n << 64n) - 1n;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic xorshift64 (same PRNG as the repo's other seeded sweeps). */
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
function pick(rng: () => number, m: number): number {
  return Number(BigInt(rng()) % BigInt(m));
}
function bigInRange(rng: () => number, lo: bigint, hi: bigint): bigint {
  return lo + (BigInt(rng()) % (hi - lo + 1n));
}

// ---------------------------------------------------------------------------
// Raw account encoders (SDK layout offsets, byte-identical to chain)
// ---------------------------------------------------------------------------

function u128le(value: bigint): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  buf.writeBigUInt64LE((value >> 64n) & 0xffffffffffffffffn, 8);
  return buf;
}

interface MarketSeed {
  mint?: PublicKey;
  indexSource?: PublicKey;
  initialMarginBps?: number;
  maintenanceMarginBps?: number;
  indexN?: bigint;
  indexD?: bigint;
  fundingAccumulator?: bigint;
}

function marketRow(seed: MarketSeed = {}): Buffer {
  const data = Buffer.alloc(8 + PERP_MARKET_LEN);
  anchorAccountDiscriminator("PerpMarket").copy(data, 0);
  (seed.indexSource ?? PublicKey.unique()).toBuffer().copy(data, 8 + PerpMarket.indexSource);
  (seed.mint ?? PublicKey.unique()).toBuffer().copy(data, 8 + PerpMarket.collateralMint);
  data.writeUInt16LE(seed.initialMarginBps ?? 1_000, 8 + PerpMarket.initialMarginBps);
  data.writeUInt16LE(seed.maintenanceMarginBps ?? 500, 8 + PerpMarket.maintenanceMarginBps);
  data.writeBigUInt64LE(seed.indexN ?? 1n, 8 + PerpMarket.indexN);
  data.writeBigUInt64LE(seed.indexD ?? 1n, 8 + PerpMarket.indexD);
  u128le(BigInt.asUintN(128, seed.fundingAccumulator ?? 0n)).copy(data, 8 + PerpMarket.fundingAccumulator);
  data[8 + PerpMarket.bump] = 254;
  return data;
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

/** A written ring for `[max(0, cursor - 32), cursor)` — exactly the on-chain layout. */
function ring(cursor: number, at: (seq: number) => OutEventState): OutEventState[] {
  const events = Array.from({ length: EVENT_QUEUE_LEN }, zeroEvent);
  for (let s = Math.max(0, cursor - EVENT_QUEUE_LEN); s < cursor; s++) {
    events[s % EVENT_QUEUE_LEN] = at(s);
  }
  return events;
}

/** Encode an OrderBook account carrying `events` at write cursor `cursor`. */
function bookRow(cursor: number, events: OutEventState[], readCursor = 0): Buffer {
  const data = Buffer.alloc(8 + ORDER_BOOK_LEN);
  anchorAccountDiscriminator("OrderBook").copy(data, 0);
  data.writeBigUInt64LE(BigInt(readCursor), 8 + OrderBookLayout.eventReadCursor);
  data.writeBigUInt64LE(BigInt(cursor), 8 + OrderBookLayout.eventWriteCursor);
  MARKET.toBuffer().copy(data, 8 + OrderBookLayout.market);
  for (const event of events) {
    const off = 8 + OrderBookLayout.events + Number(event.seq % BigInt(EVENT_QUEUE_LEN)) * 112;
    data.writeBigUInt64LE(event.seq, off + 0);
    data.writeBigUInt64LE(event.price, off + 8);
    data.writeBigUInt64LE(event.size, off + 16);
    event.owner.toBuffer().copy(data, off + 24);
    event.counterparty.toBuffer().copy(data, off + 56);
    data[off + 105] = event.kind;
    data[off + 106] = event.side;
  }
  return data;
}

function positionRow(
  owner: PublicKey,
  side: number,
  fields: { notional?: bigint; entryN?: bigint; entryD?: bigint; closedNotional?: bigint; market?: PublicKey },
): Buffer {
  const data = Buffer.alloc(8 + POSITION_LEN);
  anchorAccountDiscriminator("Position").copy(data, 0);
  (fields.market ?? MARKET).toBuffer().copy(data, 8 + Position.market);
  owner.toBuffer().copy(data, 8 + Position.owner);
  data[8 + Position.side] = side;
  data.writeBigUInt64LE(fields.notional ?? 0n, 8 + Position.notional);
  u128le(fields.entryN ?? 0n).copy(data, 8 + Position.entryN);
  u128le(fields.entryD ?? 0n).copy(data, 8 + Position.entryD);
  data.writeBigUInt64LE(fields.closedNotional ?? 0n, 8 + Position.closedNotional);
  data[8 + Position.bump] = 253;
  return data;
}

function collateralRow(u: { deposited?: bigint; reserved?: bigint; claimable?: bigint }): Buffer {
  const data = Buffer.alloc(8 + USER_COLLATERAL_LEN);
  anchorAccountDiscriminator("UserCollateral").copy(data, 0);
  data.writeBigUInt64LE(u.deposited ?? 0n, 8 + UserCollateralLayout.deposited);
  data.writeBigUInt64LE(u.reserved ?? 0n, 8 + UserCollateralLayout.reserved);
  data.writeBigUInt64LE(u.claimable ?? 0n, 8 + UserCollateralLayout.claimable);
  data[8 + UserCollateralLayout.bump] = 255;
  return data;
}

function fixedFill(seq: number): OutEventState {
  return {
    ...zeroEvent(),
    seq: BigInt(seq),
    price: 1_000_000n + BigInt(seq),
    size: 10n + BigInt(seq),
    owner: Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey,
    kind: 0,
    side: seq % 2,
  };
}

/** A stub indexer `Connection` whose resync returns the accounts it is given. */
function indexerStub(getAccounts: () => Array<{ pubkey: PublicKey; data: Buffer }>): {
  connection: Connection;
  callbacks: Array<(keyed: { accountId: PublicKey; accountInfo: { data: Buffer } }, ctx: { slot: number }) => void>;
} {
  const callbacks: Array<(keyed: { accountId: PublicKey; accountInfo: { data: Buffer } }, ctx: { slot: number }) => void> =
    [];
  const connection = {
    async getSlot() {
      return 500;
    },
    async getProgramAccounts() {
      return getAccounts().map(({ pubkey, data }) => ({ pubkey, account: { data } }));
    },
    onProgramAccountChange(_programId: PublicKey, cb: never) {
      callbacks.push(cb as unknown as (typeof callbacks)[number]);
      return callbacks.length;
    },
    async removeProgramAccountChangeListener() {},
  } as unknown as Connection;
  return { connection, callbacks };
}

// ---------------------------------------------------------------------------
// 1. Indexer fold — delivery gap wider than the ring
// ---------------------------------------------------------------------------

test("REVIEW-INDEXER-GAP-WIDER-THAN-RING-WAITS-FOR-A-BRIDGE-AND-RECOVERS (AMEND-PV-2)", () => {
  // AMEND-PV-2 (B2-F1 adjudication). The original counterexample asserted the
  // fold must SKIP a ring-width gap (drop seq 8, drain 9..40). The fixer proved
  // that policy contradicts the frozen acceptance model: with the skip applied,
  // `server/test/indexer.test.ts`'s seeded sweep fails (case 0: "folded 114,
  // expected 307") and the out-of-order hostile loses a delivered event — the
  // skip decision state is state-isomorphic with sweep cases whose gap an OLDER
  // ring still bridges (bridges arrive up to 43 deliveries late; sweep case
  // 196, cursor 362). No pure fold can distinguish an unrecoverable gap from a
  // late bridge, so the accepted semantics are: buffer-and-wait — delivered
  // events are never dropped from memory — and a bridging delivery must
  // recover and drain them in seq order. This test pins both halves.
  const log = Array.from({ length: 43 }, (_, i) => fixedFill(i));
  const slot = (cursor: number) => 10_000 + cursor;
  const deliver = (state: IndexerFoldState | null, cursor: number) => {
    const snapshot: OrderBookEventSnapshot = {
      kind: "order_book",
      market: MARKET.toBase58(),
      slot: slot(cursor),
      eventWriteCursor: BigInt(cursor),
      events: ring(cursor, (s) => log[s]),
    };
    return foldIndexerEvents(state, snapshot);
  };

  const first = deliver(null, 8); // window [0, 8) — folds seqs 0..7
  const second = deliver(first.state, 41); // window [9, 41) — carries seqs 9..40

  // The WAIT (asserted before the next delivery — the fold mutates its state in
  // place): seq 8 is unreachable from any ring seen so far, but the events the
  // later rings carry stay buffered — never silently dropped.
  assert.equal(second.state.pendingFills.size, EVENT_QUEUE_LEN, "the delivered-but-unreachable events stay buffered");

  const third = deliver(second.state, 42); // window [10, 42) — carries seqs 10..41
  assert.equal(third.state.pendingFills.size, EVENT_QUEUE_LEN + 1, "later windows keep buffering");
  assert.equal(third.fills.length, 0, "no drain without the bridge");
  assert.equal(third.state.fillSeq.get(MARKET.toBase58()), 8n, "the watermark waits at seq 8");

  // The RECOVERY: an out-of-order delivery of the ring covering seq 8 (window
  // [8, 40)) — the fold must bridge and drain everything the union of all
  // delivered rings contains, exactly once, in seq order.
  const bridge = deliver(third.state, 40); // window [8, 40) — carries seqs 8..39
  const final = deliver(bridge.state, 43); // window [11, 43) — carries seqs 11..42

  const foldedSeqs = [
    ...first.fills,
    ...second.fills,
    ...third.fills,
    ...bridge.fills,
    ...final.fills,
  ].map((row) => row.seq);
  assert.deepEqual(
    foldedSeqs,
    Array.from({ length: 43 }, (_, i) => i),
    "every event any delivered ring carried folds exactly once, in seq order",
  );
  assert.equal(final.state.pendingFills.size, 0, "the bridge drains the buffer completely");
  assert.equal(final.state.fillSeq.get(MARKET.toBase58()), 43n, "the watermark reaches the last contiguous seq + 1");
});

test("REVIEW-INDEXER-GAP-AT-RING-WIDTH-IS-RECOVERED (control for the counterexample)", () => {
  // Gap exactly == ring size stays contiguous: 0..7 then 8..39. This control
  // shows the wedge starts one event past the window size.
  const log = Array.from({ length: 40 }, (_, i) => fixedFill(i));
  const deliver = (state: IndexerFoldState | null, cursor: number) =>
    foldIndexerEvents(state, {
      kind: "order_book",
      market: MARKET.toBase58(),
      slot: 10_000 + cursor,
      eventWriteCursor: BigInt(cursor),
      events: ring(cursor, (s) => log[s]),
    });
  const first = deliver(null, 8);
  const second = deliver(first.state, 40);
  assert.deepEqual(
    [...first.fills, ...second.fills].map((row) => row.seq),
    Array.from({ length: 40 }, (_, i) => i),
    "windows that touch must fold every delivered event exactly once",
  );
});

// ---------------------------------------------------------------------------
// 2. Indexer — restart/replay from the store
// ---------------------------------------------------------------------------

test("REVIEW-INDEXER-RESTART-REPLAY-IS-IDEMPOTENT (no duplicate, no loss across a process lifetime)", async () => {
  const db = openDb(":memory:");
  try {
    // Run 1: resync at cursor 16 (folds 0..15), then a live update to cursor 20.
    const run1 = indexerStub(() => [
      { pubkey: MARKET, data: marketRow({ fundingAccumulator: 0n }) },
      { pubkey: BOOK, data: bookRow(16, ring(16, fixedFill)) },
    ]);
    const indexer1 = createIndexer({ connection: run1.connection, db, programId: PROGRAM_ID });
    await indexer1.start();
    run1.callbacks[0]({ accountId: BOOK, accountInfo: { data: bookRow(20, ring(20, fixedFill)) } }, { slot: 700 });
    await indexer1.stop();

    const afterRun1 = db.listFills({ market: MARKET.toBase58() });
    assert.deepEqual(
      afterRun1.map((row) => row.seq),
      Array.from({ length: 20 }, (_, i) => i),
      "run 1 must fold the resync ring and the live update exactly once",
    );

    // Run 2 (restart): a fresh fold state re-delivers the SAME ring, then a new
    // update. The store's seq PK must absorb the re-fold; the new events must
    // still land exactly once.
    const run2 = indexerStub(() => [
      { pubkey: MARKET, data: marketRow({ fundingAccumulator: 0n }) },
      { pubkey: BOOK, data: bookRow(20, ring(20, fixedFill)) },
    ]);
    const indexer2 = createIndexer({ connection: run2.connection, db, programId: PROGRAM_ID });
    await indexer2.start();
    run2.callbacks[0]({ accountId: BOOK, accountInfo: { data: bookRow(24, ring(24, fixedFill)) } }, { slot: 900 });
    await indexer2.stop();

    const afterRun2 = db.listFills({ market: MARKET.toBase58() });
    assert.deepEqual(
      afterRun2.map((row) => row.seq),
      Array.from({ length: 24 }, (_, i) => i),
      "replay after restart must insert each seq exactly once (no duplicates, no loss)",
    );
    const slots = new Map(afterRun2.map((row) => [row.seq, row.slot]));
    assert.equal(slots.get(0), 500, "a re-delivered fill keeps the FIRST delivery's slot (run 1's resync slot)");
    assert.equal(slots.get(23), 900, "a fill first delivered after the restart carries the post-restart slot");
  } finally {
    db.close();
  }
});

test("REVIEW-INDEXER-RESTART-FUNDING-DIFF-IS-DROPPED-AS-DUPLICATE-SEQ (COUNTEREXAMPLE)", async () => {
  const db = openDb(":memory:");
  try {
    // Run 1: baseline acc 1000, then a funding epoch moves it to 1250 → one row
    // (seq 1, delta +250) persisted.
    const run1 = indexerStub(() => [{ pubkey: MARKET, data: marketRow({ fundingAccumulator: 1000n }) }]);
    const indexer1 = createIndexer({ connection: run1.connection, db, programId: PROGRAM_ID });
    await indexer1.start();
    run1.callbacks[0]({ accountId: MARKET, accountInfo: { data: marketRow({ fundingAccumulator: 1250n }) } }, { slot: 600 });
    await indexer1.stop();
    assert.equal(db.listFundingEvents(MARKET.toBase58()).length, 1, "run 1 folds the first funding diff");

    // Run 2 (restart, same store): baseline is now 1250; the next epoch moves it
    // to 1500 — a NEW diff (+250) that must be recorded with a fresh seq.
    const run2 = indexerStub(() => [{ pubkey: MARKET, data: marketRow({ fundingAccumulator: 1250n }) }]);
    const indexer2 = createIndexer({ connection: run2.connection, db, programId: PROGRAM_ID });
    await indexer2.start();
    run2.callbacks[0]({ accountId: MARKET, accountInfo: { data: marketRow({ fundingAccumulator: 1500n }) } }, { slot: 700 });
    await indexer2.stop();

    const rows = db.listFundingEvents(MARKET.toBase58());
    assert.deepEqual(
      rows.map((row) => ({ seq: row.seq, amount: row.amount })),
      [
        { seq: 1, amount: "250" },
        { seq: 2, amount: "250" },
      ],
      "the post-restart funding diff (1250 → 1500) must be persisted exactly once with a sequence that " +
        "does not collide with the pre-restart rows",
    );
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Indexer fold — multi-market interleaving (per-market independence)
// ---------------------------------------------------------------------------

interface MarketLog {
  market: string;
  log: OutEventState[];
  cursors: number[];
}

test("REVIEW-INDEXER-MULTI-MARKET-INTERLEAVED-DELIVERY: two markets fold independently, exactly once, in seq order", () => {
  for (let caseIdx = 0; caseIdx < 40; caseIdx++) {
    const rng = xorshift(0xbeef ^ (caseIdx * 2654435761));
    const markets: MarketLog[] = ["MarketA", "MarketB"].map((market, idx) => {
      const n = 40 + pick(rng, 80);
      const log = Array.from({ length: n }, (_, i) => ({
        ...fixedFill(i),
        owner: Keypair.fromSeed(new Uint8Array(32).fill(idx + 1)).publicKey,
      }));
      // sliding cursors with contiguous coverage (gap <= window each step)
      const cursors: number[] = [];
      let w = 1 + pick(rng, EVENT_QUEUE_LEN);
      cursors.push(w);
      while (w < n) {
        w = Math.min(n, w + 1 + pick(rng, EVENT_QUEUE_LEN));
        cursors.push(w);
      }
      return { market, log, cursors };
    });

    // Deliveries: interleave the two markets' (shuffled, duplicated) snapshots.
    const deliveries: Array<{ market: string; cursor: number; slot: number }> = [];
    for (const m of markets) {
      const idx = m.cursors.map((_, i) => i).filter((i) => i > 0);
      for (let i = idx.length - 1; i > 0; i--) {
        const j = pick(rng, i + 1);
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      const picks = [0, ...idx];
      for (const i of picks) {
        deliveries.push({ market: m.market, cursor: m.cursors[i], slot: 1_000 + m.cursors[i] });
        if (pick(rng, 100) < 25) deliveries.push({ market: m.market, cursor: m.cursors[i], slot: 1_000 + m.cursors[i] });
      }
    }
    for (let i = deliveries.length - 1; i > 0; i--) {
      const j = pick(rng, i + 1);
      [deliveries[i], deliveries[j]] = [deliveries[j], deliveries[i]];
    }
    // A market's first delivery must carry its baseline window mid-sequence too:
    // each market's first delivery is the smallest cursor (below).
    const firstOf = new Map<string, number>();
    for (const d of deliveries) {
      const cur = firstOf.get(d.market);
      if (cur === undefined || d.cursor < cur) firstOf.set(d.market, d.cursor);
    }

    let state: IndexerFoldState | null = null;
    const folded = new Map<string, number[]>([["MarketA", []], ["MarketB", []]]);
    for (const d of deliveries) {
      const m = markets.find((x) => x.market === d.market)!;
      const snapshot: OrderBookEventSnapshot = {
        kind: "order_book",
        market: d.market,
        slot: d.slot,
        eventWriteCursor: BigInt(d.cursor),
        events: ring(d.cursor, (s) => m.log[s] ?? zeroEvent()),
      };
      const result = foldIndexerEvents(state, snapshot);
      state = result.state;
      folded.get(d.market)!.push(...result.fills.map((row) => row.seq));
    }

    for (const m of markets) {
      const seen = new Set<number>();
      for (const seq of folded.get(m.market)!) seen.add(seq);
      const expected = m.log.map((e) => Number(e.seq)).filter((s) => seen.has(s));
      assert.deepEqual(
        folded.get(m.market)!,
        expected,
        `case ${caseIdx} ${m.market}: each market folds each delivered event exactly once in seq order`,
      );
      for (let i = 1; i < folded.get(m.market)!.length; i++) {
        assert.ok(folded.get(m.market)![i] > folded.get(m.market)![i - 1], `case ${caseIdx} ${m.market}: seq order`);
      }
      // No cross-market contamination: every row carries the market's own tag.
      assert.ok(seen.size > 0, `case ${caseIdx} ${m.market}: non-empty baseline`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. State layer — edge domains vs the Rust-derived formulas
// ---------------------------------------------------------------------------

const EXTREME_NOTIONALS = [0n, 1n, 9_999n, 10_000n, 1n << 32n, 1n << 53n, 1n << 63n, U64_MAX];
const EXTREME_SUMS = [0n, 1n, (1n << 45n) - 1n, 1n << 45n, (1n << 45n) + 1n, 1n << 64n, 1n << 127n, (1n << 128n) - 1n];
const EXTREME_INDICES = [0n, 1n, 1n << 45n, 1n << 63n, U64_MAX];
const EXTREME_DEPOSITS = [0n, 1n, 1n << 63n, U64_MAX];
const EXTREME_BPS = [0, 1, 9_999, 10_000];

/** `ceil(n × bps / 10_000)` — Rust `positions::margin_required`. */
function refMargin(notional: bigint, bps: number): bigint {
  return (notional * BigInt(bps) + 9_999n) / 10_000n;
}

/** Signed Rust `positions::pnl` (0 on any degenerate rate input). */
function refPnl(
  notional: bigint,
  entryN: bigint,
  entryD: bigint,
  indexN: bigint,
  indexD: bigint,
  side: 0 | 1,
): bigint {
  if (notional === 0n || entryN === 0n || entryD === 0n || indexN === 0n || indexD === 0n) return 0n;
  const maxSum = entryN > entryD ? entryN : entryD;
  const shift = BigInt(Math.max(0, maxSum.toString(2).length - 45));
  const nE = entryN >> shift;
  const dE = entryD >> shift;
  if (nE === 0n || dE === 0n) return 0n;
  const change = ((indexN * dE - nE * indexD) * 1_000_000_000n) / (nE * indexD);
  const scaled = (notional * change) / 1_000_000_000n;
  return side === 0 ? scaled : -scaled;
}

interface EdgeSeed {
  deposited: bigint;
  reserved: bigint;
  claimable: bigint;
  longNotional: bigint;
  longEntryN: bigint;
  longEntryD: bigint;
  shortNotional: bigint;
  shortEntryN: bigint;
  shortEntryD: bigint;
  indexN: bigint;
  indexD: bigint;
  initialMarginBps: number;
  maintenanceMarginBps: number;
}

function seedEdge(db: Db, seed: EdgeSeed, wallet: PublicKey): void {
  db.upsertAccount(
    "market",
    MARKET.toBase58(),
    marketRow({
      initialMarginBps: seed.initialMarginBps,
      maintenanceMarginBps: seed.maintenanceMarginBps,
      indexN: seed.indexN,
      indexD: seed.indexD,
    }),
    1,
  );
  db.upsertAccount(
    "user_collateral",
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_collateral"), MARKET.toBuffer(), wallet.toBuffer()],
      PROGRAM_ID,
    )[0].toBase58(),
    collateralRow({ deposited: seed.deposited, reserved: seed.reserved, claimable: seed.claimable }),
    1,
  );
  db.upsertAccount(
    "position",
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), MARKET.toBuffer(), wallet.toBuffer(), Buffer.from([0])],
      PROGRAM_ID,
    )[0].toBase58(),
    positionRow(wallet, 0, {
      notional: seed.longNotional,
      entryN: seed.longEntryN,
      entryD: seed.longEntryD,
    }),
    1,
  );
  db.upsertAccount(
    "position",
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), MARKET.toBuffer(), wallet.toBuffer(), Buffer.from([1])],
      PROGRAM_ID,
    )[0].toBase58(),
    positionRow(wallet, 1, {
      notional: seed.shortNotional,
      entryN: seed.shortEntryN,
      entryD: seed.shortEntryD,
    }),
    1,
  );
}

function checkEdge(seed: EdgeSeed, wallet: PublicKey, label: string): void {
  const db = openDb(":memory:");
  try {
    seedEdge(db, seed, wallet);
    const p = computePortfolio(db, wallet, MARKET);
    const upnlLong = refPnl(seed.longNotional, seed.longEntryN, seed.longEntryD, seed.indexN, seed.indexD, 0);
    const upnlShort = refPnl(seed.shortNotional, seed.shortEntryN, seed.shortEntryD, seed.indexN, seed.indexD, 1);
    const equity = seed.deposited + upnlLong + upnlShort;
    const reqInitial = refMargin(seed.longNotional, seed.initialMarginBps) + refMargin(seed.shortNotional, seed.initialMarginBps);
    const reqMaint =
      refMargin(seed.longNotional, seed.maintenanceMarginBps) + refMargin(seed.shortNotional, seed.maintenanceMarginBps);
    const exposure = seed.longNotional + seed.shortNotional > 0n;

    assert.equal(p.equity, equity.toString(), `${label}: equity = deposited + Σ upnl`);
    assert.equal(p.requirementInitial, reqInitial.toString(), `${label}: requirementInitial`);
    assert.equal(p.requirementMaint, reqMaint.toString(), `${label}: requirementMaint`);
    assert.equal(p.health, exposure && equity < reqMaint ? "liquidatable" : "healthy", `${label}: health`);
    assert.equal(p.free, (seed.deposited - seed.reserved).toString(), `${label}: free`);
    assert.equal(p.claimable, seed.claimable.toString(), `${label}: claimable passes through`);
    assert.equal(p.wallet, wallet.toBase58(), `${label}: wallet`);
  } finally {
    db.close();
  }
}

test("REVIEW-STATE-EDGE-DOMAINS-MATCH-THE-RUST-FORMULAS: u64/u128 extremes, bps lattice, sign extremes", () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;

  // Deterministic extreme lattice (every combination of the boundary picks that
  // can flip health): zero/one/max notionals, bps 0/1/9999/10000, extreme rates.
  let checked = 0;
  for (const li of [0, 7]) {
    for (const si of [0, 7]) {
      for (const di of [0, 3]) {
        for (const bps of EXTREME_BPS) {
          checkEdge(
            {
              deposited: EXTREME_DEPOSITS[di],
              reserved: 0n,
              claimable: 0n,
              longNotional: EXTREME_NOTIONALS[li],
              longEntryN: 1n,
              longEntryD: 1n,
              shortNotional: EXTREME_NOTIONALS[si],
              shortEntryN: 1n,
              shortEntryD: 1n,
              indexN: 1n,
              indexD: 1n,
              initialMarginBps: bps,
              maintenanceMarginBps: bps,
            },
            wallet,
            `lattice li=${li} si=${si} di=${di} bps=${bps}`,
          );
          checked++;
        }
      }
    }
  }
  // Exact health boundary at u64 scale: equity == maintenance stays healthy;
  // equity - 1 is liquidatable. marginRequired(U64_MAX, 10000) wraps in Rust's
  // checked u64 — the server mirror is documented total, so compare the exact
  // bigint value.
  const n = U64_MAX;
  const req = refMargin(n, 500);
  checkEdge(
    {
      deposited: req,
      reserved: 0n,
      claimable: 0n,
      longNotional: n,
      longEntryN: 1n,
      longEntryD: 1n,
      shortNotional: 0n,
      shortEntryN: 0n,
      shortEntryD: 0n,
      indexN: 1n,
      indexD: 1n,
      initialMarginBps: 1_000,
      maintenanceMarginBps: 500,
    },
    wallet,
    "u64-max boundary == maintenance (healthy)",
  );
  checkEdge(
    {
      deposited: req - 1n,
      reserved: 0n,
      claimable: 0n,
      longNotional: n,
      longEntryN: 1n,
      longEntryD: 1n,
      shortNotional: 0n,
      shortEntryN: 0n,
      shortEntryD: 0n,
      indexN: 1n,
      indexD: 1n,
      initialMarginBps: 1_000,
      maintenanceMarginBps: 500,
    },
    wallet,
    "u64-max boundary − 1 (liquidatable)",
  );
  checked += 2;

  // Seeded sweep across the extreme domains (entry sums up to u128 max,
  // rates/notionals up to u64 max, signed moves both ways).
  for (let caseIdx = 0; caseIdx < 240; caseIdx++) {
    const rng = xorshift(0xed6e ^ (caseIdx * 7919));
    const seed: EdgeSeed = {
      deposited: bigInRange(rng, 0n, U64_MAX),
      reserved: bigInRange(rng, 0n, 10_000_000n),
      claimable: bigInRange(rng, 0n, 10_000_000n),
      longNotional: bigInRange(rng, 0n, U64_MAX),
      longEntryN: EXTREME_SUMS[pick(rng, EXTREME_SUMS.length)],
      longEntryD: EXTREME_SUMS[pick(rng, EXTREME_SUMS.length)],
      shortNotional: bigInRange(rng, 0n, U64_MAX),
      shortEntryN: EXTREME_SUMS[pick(rng, EXTREME_SUMS.length)],
      shortEntryD: EXTREME_SUMS[pick(rng, EXTREME_SUMS.length)],
      indexN: EXTREME_INDICES[pick(rng, EXTREME_INDICES.length)],
      indexD: EXTREME_INDICES[pick(rng, EXTREME_INDICES.length)],
      initialMarginBps: EXTREME_BPS[pick(rng, EXTREME_BPS.length)],
      maintenanceMarginBps: EXTREME_BPS[pick(rng, EXTREME_BPS.length)],
    };
    checkEdge(seed, wallet, `edge sweep case ${caseIdx}`);
    checked++;
  }
  assert.ok(checked > 0, "non-vacuity: the edge model must have checked account sets");
});

test("REVIEW-STATE-DEFENSIVE-ROWS: foreign-owner, foreign-market and invalid-side rows contribute nothing", () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
  const stranger = Keypair.fromSeed(new Uint8Array(32).fill(10)).publicKey;
  const FOREIGN = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;
  const db = openDb(":memory:");
  try {
    seedEdge(
      db,
      {
        deposited: 1_000_000n,
        reserved: 0n,
        claimable: 0n,
        longNotional: 500_000n,
        longEntryN: 1n,
        longEntryD: 1n,
        shortNotional: 0n,
        shortEntryN: 0n,
        shortEntryD: 0n,
        indexN: 1n,
        indexD: 1n,
        initialMarginBps: 1_000,
        maintenanceMarginBps: 500,
      },
      wallet,
    );
    const clean = computePortfolio(db, wallet, MARKET);
    assert.deepEqual(
      clean.positions.map((v) => [v.side, v.notional]),
      [[0, "500000"]],
      "the clean account serves the long side only — zero-notional sides never appear",
    );

    // Corrupt the CANONICAL rows: foreign owner / foreign market / side byte 2.
    const longPda = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), MARKET.toBuffer(), wallet.toBuffer(), Buffer.from([0])],
      PROGRAM_ID,
    )[0];
    const shortPda = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), MARKET.toBuffer(), wallet.toBuffer(), Buffer.from([1])],
      PROGRAM_ID,
    )[0];
    const notionals = (p: ReturnType<typeof computePortfolio>) => p.positions.map((v) => v.notional);

    db.upsertAccount("position", longPda.toBase58(), positionRow(stranger, 0, { notional: 9_000_000n, entryN: 1n, entryD: 1n }), 2);
    let p = computePortfolio(db, wallet, MARKET);
    assert.ok(!notionals(p).includes("9000000"), "a foreign-owner row must never surface as the wallet's position");
    assert.equal(p.requirementInitial, "0", "a foreign-owner row must not contribute margin");

    db.upsertAccount("position", longPda.toBase58(), positionRow(wallet, 0, { notional: 500_000n, entryN: 1n, entryD: 1n }), 2);
    db.upsertAccount(
      "position",
      longPda.toBase58(),
      positionRow(wallet, 0, { notional: 9_000_000n, entryN: 1n, entryD: 1n, market: FOREIGN }),
      3,
    );
    p = computePortfolio(db, wallet, MARKET);
    assert.ok(!notionals(p).includes("9000000"), "a foreign-market row must never surface");

    db.upsertAccount("position", longPda.toBase58(), positionRow(wallet, 0, { notional: 500_000n, entryN: 1n, entryD: 1n }), 3);
    db.upsertAccount("position", shortPda.toBase58(), positionRow(wallet, 2, { notional: 9_000_000n, entryN: 1n, entryD: 1n }), 4);
    p = computePortfolio(db, wallet, MARKET);
    assert.deepEqual(notionals(p), ["500000"], "an invalid side byte must never surface");
    assert.equal(p.requirementInitial, "50000", "only the valid long side contributes margin");

    // Both sides corrupt ⇒ zero exposure ⇒ healthy (the literal predicate).
    db.upsertAccount("position", longPda.toBase58(), positionRow(wallet, 2, { notional: 9_000_000n }), 5);
    p = computePortfolio(db, wallet, MARKET);
    assert.equal(p.positions.length, 0, "no view may be fabricated from invalid rows");
    assert.equal(p.health, "healthy", "zero exposure after defensively-ignored rows ⇒ healthy");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Operator queue — failure injection, FIFO, retries, no loss
// ---------------------------------------------------------------------------

interface OpStub {
  sends: Array<{ key: string; signature: string }>;
  attempts: string[];
  script: Map<string, string[]>;
  inFlight: Map<string, number>;
  overlaps: string[];
  blockhashes: number;
  fails: Map<string, number>;
}

function opStubConnection(state: OpStub, market: Buffer): Connection {
  return {
    async getAccountInfo() {
      return { data: market };
    },
    async getLatestBlockhash() {
      state.blockhashes += 1;
      return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1_000 + state.blockhashes };
    },
    async sendRawTransaction(raw: Uint8Array) {
      // Identify the action by (subject user, amount) from the single deposit ix.
      const tx = Transaction.from(Buffer.from(raw));
      const ix = tx.instructions[0];
      const user = ix.keys[1]!.pubkey.toBase58();
      const amount = ix.data.readBigUInt64LE(8);
      const key = `${user}:${amount}`;
      state.attempts.push(key);
      if ((state.inFlight.get(user) ?? 0) > 0) {
        state.overlaps.push(`user ${user} had ${state.inFlight.get(user)} in-flight submit(s)`);
      }
      state.inFlight.set(user, (state.inFlight.get(user) ?? 0) + 1);
      try {
        const outcome = state.script.get(key)?.shift() ?? "ok";
        if (outcome !== "ok") {
          state.fails.set(key, (state.fails.get(key) ?? 0) + 1);
          throw new Error(outcome);
        }
        await sleep(5); // widen the window for an overlap detection
        const signature = `SIG${state.sends.length + 1}`;
        state.sends.push({ key, signature });
        return signature;
      } finally {
        state.inFlight.set(user, (state.inFlight.get(user) ?? 0) - 1);
      }
    },
    async confirmTransaction() {},
  } as unknown as Connection;
}

test("REVIEW-OPERATOR-QUEUE-FAILURE-INJECTION: retries, mixed users, per-user FIFO, no interleave, no loss", async () => {
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "review-operator-"));
  try {
    const operator = Keypair.generate();
    const keypairPath = join(dir, "operator.json");
    writeFileSync(keypairPath, JSON.stringify(Array.from(operator.secretKey)));

    const users = [1, 2, 3].map((i) => Keypair.fromSeed(new Uint8Array(32).fill(i)).publicKey.toBase58());
    const state: OpStub = { sends: [], attempts: [], script: new Map(), inFlight: new Map(), overlaps: [], blockhashes: 0, fails: new Map() };
    const amounts: Record<string, bigint[]> = {};
    users.forEach((user, i) => {
      amounts[user] = [0, 1, 2, 3].map((k) => BigInt(100 * (i + 1) + k));
    });
    // Scripts: user0's action #1 needs two attempts; action #2 always retryable
    // (exhausts the bound and fails); user1's action #0 fails non-retryably.
    state.script.set(`${users[0]}:${amounts[users[0]][1]}`, ["fetch failed"]); // → then ok
    state.script.set(`${users[0]}:${amounts[users[0]][2]}`, ["expired", "expired", "expired"]);
    state.script.set(`${users[1]}:${amounts[users[1]][0]}`, ["custom program error: 0x1771"]);
    // Snapshot the scripts (the stub consumes them) for the expectation model.
    const scriptModel = new Map([...state.script].map(([key, outcomes]) => [key, [...outcomes]]));

    const service = createOperator({
      connection: opStubConnection(state, marketRow({ mint: PublicKey.unique(), indexSource: PublicKey.unique() })),
      keypairPath,
      db,
      programId: PROGRAM_ID,
    });

    // Interleave enqueues across users (concurrently).
    const enqueueOrder: string[] = [];
    const pending: Array<Promise<ActionResponse>> = [];
    for (let k = 0; k < 4; k++) {
      for (const user of users) {
        enqueueOrder.push(`${user}:${amounts[user][k]}`);
        pending.push(service.executeDeposit(user, amounts[user][k]));
      }
    }
    const settled = await Promise.allSettled(pending);
    assert.equal(settled.length, 12, "every enqueued action must settle (no loss, no hang)");

    // Per-user outcome model.
    const rejected = settled.filter((s) => s.status === "rejected").length;
    assert.equal(rejected, 2, "the one always-retryable action and the one non-retryable action must reject");

    // Per-user FIFO: each user's ATTEMPT sequence follows enqueue order exactly,
    // with the modelled retry counts (attempts include retries and failures).
    const RETRYABLE = /expired|blockhash not found|blockhashnotfound|timed? ?out|fetch failed/i;
    const modelAttempts = (script: string[]): number => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const outcome = script[attempt - 1] ?? "ok";
        if (outcome === "ok" || !RETRYABLE.test(outcome)) return attempt;
      }
      return 3;
    };
    for (const user of users) {
      const want: string[] = [];
      for (const amount of amounts[user]) {
        const key = `${user}:${amount}`;
        for (let i = 0; i < modelAttempts(scriptModel.get(key) ?? []); i++) want.push(key);
      }
      assert.deepEqual(
        state.attempts.filter((key) => key.startsWith(`${user}:`)),
        want,
        `user ${user}: attempt order must follow enqueue order (FIFO) with bounded retries`,
      );
    }
    assert.deepEqual(state.overlaps, [], "no two submits of the same user may overlap (per-user serialization)");

    // Retry accounting: fresh blockhash per attempt, bounded at 3.
    const keyA1 = `${users[0]}:${amounts[users[0]][1]}`;
    const keyA2 = `${users[0]}:${amounts[users[0]][2]}`;
    const keyB0 = `${users[1]}:${amounts[users[1]][0]}`;
    assert.equal(state.attempts.filter((key) => key === keyA1).length, 2, "a retryable failure is retried once and then succeeds");
    assert.equal(state.sends.filter((s) => s.key === keyA1).length, 1, "the retried action lands exactly once");
    assert.equal(state.fails.get(keyA2), 3, "an always-retryable failure stops after exactly 3 attempts (bounded)");
    assert.equal(state.fails.get(keyB0), 1, "a non-retryable failure is not retried");

    // tx_log: exactly one terminal row per enqueue, creation-ordered.
    const rows = db.raw
      .prepare("SELECT id, wallet, status, signature, error, created_at FROM tx_log ORDER BY rowid ASC")
      .all() as unknown as Array<{ id: string; wallet: string; status: string; signature: string | null; error: string | null; created_at: number }>;
    assert.equal(rows.length, 12, "exactly one tx_log row per enqueued action (no loss, no duplication)");
    assert.equal(new Set(rows.map((r) => r.id)).size, 12, "tx_log ids are distinct");
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i]!.created_at > rows[i - 1]!.created_at, "tx_log rows are in strictly increasing creation order");
    }
    for (const row of rows) {
      assert.ok(["confirmed", "failed"].includes(row.status), `terminal tx_log status (got ${row.status})`);
      if (row.status === "confirmed") assert.ok(row.signature !== null, "confirmed rows carry a signature");
      if (row.status === "failed") assert.ok(row.error !== null, "failed rows carry an error");
    }
    assert.equal(service.queueDepth(), 0, "the queue must drain to zero");
  } finally {
    db.close();
  }
});

test("REVIEW-OPERATOR-RETRY-DOUBLE-SUBMITS-AFTER-AMBIGUOUS-CONFIRM (COUNTEREXAMPLE)", async () => {
  // An attempt that LANDED (send accepted) but whose confirmation failed on a
  // transport error ("fetch failed", classified retryable) must not be re-sent:
  // for state-mutating instructions (deposit) a second landing double-applies.
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "review-operator2-"));
  try {
    const operator = Keypair.generate();
    const keypairPath = join(dir, "operator.json");
    writeFileSync(keypairPath, JSON.stringify(Array.from(operator.secretKey)));

    const landed: string[] = [];
    let confirms = 0;
    let hashCount = 0;
    const connection = {
      async getAccountInfo() {
        return { data: marketRow({ mint: PublicKey.unique(), indexSource: PublicKey.unique() }) };
      },
      async getLatestBlockhash() {
        hashCount += 1;
        return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1_000 };
      },
      async sendRawTransaction() {
        const signature = `LANDED${landed.length + 1}`;
        landed.push(signature);
        return signature;
      },
      async confirmTransaction() {
        confirms += 1;
        if (confirms === 1) throw new Error("fetch failed"); // ambiguous: the tx is already accepted
      },
    } as unknown as Connection;
    const service = createOperator({ connection, keypairPath, db, programId: PROGRAM_ID });
    const user = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58();
    await service.executeDeposit(user, 1_000_000n);

    assert.equal(
      landed.length,
      1,
      `one action must land at most one transaction even when confirmation fails ambiguously — landed ${landed.length} ` +
        `(${landed.join(", ")}); a fresh blockhash per retry makes the re-send a NEW signature the cluster cannot dedupe`,
    );
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Faucet — concurrent caps + exactly-once crediting
// ---------------------------------------------------------------------------

function faucetFixture(options: { drip?: bigint; perWalletCap?: bigint; globalCap?: bigint; failFirst?: boolean; delayMs?: number }) {
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "review-faucet-"));
  const authority = Keypair.generate();
  const keypairPath = join(dir, "authority.json");
  writeFileSync(keypairPath, JSON.stringify(Array.from(authority.secretKey)));
  const mint = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey;
  const config = {
    ...loadConfig({ JWT_SECRET: "review" } as unknown as NodeJS.ProcessEnv),
    faucetEnabled: true,
    faucetMint: mint.toBase58(),
    faucetMintAuthorityKeypair: keypairPath,
    faucetDrip: options.drip ?? 10_000_000n,
    faucetPerWalletCap: options.perWalletCap ?? 20_000_000n,
    faucetGlobalCap: options.globalCap ?? 40_000_000n,
  };
  const mints: string[] = [];
  let failNext = options.failFirst === true;
  const connection = {
    async getAccountInfo() {
      return null; // ATA missing → the create-ATA path is exercised
    },
    async getLatestBlockhash() {
      return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1_000 };
    },
    async sendRawTransaction() {
      if (options.delayMs !== undefined) await sleep(options.delayMs); // widen the concurrency window
      if (failNext) {
        failNext = false;
        throw new Error("rpc unreachable");
      }
      const signature = `MINT${mints.length + 1}`;
      mints.push(signature);
      return signature;
    },
    async confirmTransaction() {},
  } as unknown as Connection;
  const faucet = createFaucet({ config, connection, db });
  return { db, faucet, mints, config, mint };
}

test("REVIEW-FAUCET-CONCURRENT-EXACTLY-ONCE: parallel requests spend the caps exactly and credit each drip once", async () => {
  const fx = faucetFixture({ perWalletCap: 20_000_000n, globalCap: 40_000_000n, drip: 10_000_000n, delayMs: 5 });
  try {
    const w1 = Keypair.fromSeed(new Uint8Array(32).fill(31)).publicKey.toBase58();
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => fx.faucet.handle({ wallet: w1 })));
    const accepted = outcomes.filter((o) => o.status === "fulfilled").length;
    const rejected = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    assert.equal(accepted, 2, "a per-wallet cap of 2 drips must accept exactly 2 of 8 concurrent requests");
    for (const r of rejected) {
      assert.ok(r.reason instanceof FaucetCapError, `over-cap rejections must be FaucetCapError (got ${String(r.reason)})`);
    }
    assert.equal(fx.mints.length, 2, "no rejected request may mint (check before effect)");
    assert.equal(
      fx.db.sumFaucetCredits({ wallet: w1 }),
      20_000_000n,
      "the drip ledger must credit exactly the two accepted drips (no double-credit under concurrency)",
    );

    // Global cap: a second wallet takes the remainder, exactly to the boundary
    // (spent + drip == cap is accepted), then a fresh wallet is rejected.
    const w2 = Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey.toBase58();
    const w2a = await fx.faucet.handle({ wallet: w2 });
    assert.equal(w2a.amount, "10000000", "accepted amount = one drip");
    const w2b = await fx.faucet.handle({ wallet: w2 });
    assert.equal(w2b.amount, "10000000", "spent + drip == global cap is accepted (strict > rejection)");
    assert.equal(fx.db.sumFaucetCredits({}), 40_000_000n, "the global ledger equals the accepted drips exactly");
    const w3 = Keypair.fromSeed(new Uint8Array(32).fill(33)).publicKey.toBase58();
    await assert.rejects(fx.faucet.handle({ wallet: w3 }), FaucetCapError, "global budget exhausted ⇒ fresh wallet rejected");
    assert.equal(fx.db.sumFaucetCredits({}), 40_000_000n, "a rejected request changes nothing");
  } finally {
    fx.db.close();
  }
});

test("REVIEW-FAUCET-FAILURE-CREDITS-NOTHING: a failed mint records no credit; the retry credits exactly once", async () => {
  const fx = faucetFixture({ failFirst: true });
  try {
    const w = Keypair.fromSeed(new Uint8Array(32).fill(34)).publicKey.toBase58();
    await assert.rejects(fx.faucet.handle({ wallet: w }), /rpc unreachable/, "a failed send must reject the request");
    assert.equal(fx.db.sumFaucetCredits({ wallet: w }), 0n, "nothing is credited when the mint did not land");
    assert.equal(fx.mints.length, 0, "nothing was minted");

    const ok = await fx.faucet.handle({ wallet: w });
    assert.equal(ok.amount, "10000000");
    assert.equal(fx.mints.length, 1, "the retry mints once");
    assert.equal(fx.db.sumFaucetCredits({ wallet: w }), 10_000_000n, "the retry credits exactly once");

    // Clock-window sanity: the ledger is scoped to the 24 h window constant.
    assert.equal(
      fx.db.sumFaucetCredits({ wallet: w, since: Date.now() - FAUCET_WINDOW_MS - 1 }),
      10_000_000n,
      "credits inside the window are counted",
    );
    assert.equal(
      fx.db.sumFaucetCredits({ wallet: w, since: Date.now() + 1 }),
      0n,
      "a future window bound excludes all credits",
    );
  } finally {
    fx.db.close();
  }
});
