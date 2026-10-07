//! Chain indexer (D12, REQ-B-2): ingest every program account over the RPC
//! WebSocket (`onProgramAccountChange`, commitment `confirmed`), decode via the
//! SDK decoders, upsert into SQLite, and derive `fills` / `funding_events` from
//! the OrderBook event ring and the funding accumulator. Full
//! `getProgramAccounts` resync at start and every 60 s. STUB: the loop and the
//! diff fold land in a later wave; the contract below is what the WS layer and
//! the test shards drive.

import type { Connection, PublicKey } from "@solana/web3.js";
import type { OutEventState } from "fructus-sdk/src/account/decode.js";
import type { AccountKind, Db, FillRow, FundingEventRow } from "./db.js";

/** In-process update event emitted after each indexed change (REQ-B-2 → REQ-B-7 pushes). */
export interface IndexerUpdate {
  kind: AccountKind;
  pubkey: string;
  slot: number;
}

export interface IndexerOptions {
  connection: Connection;
  db: Db;
  programId: PublicKey;
  /** Consumed by the WS layer for book/mark/user pushes. */
  onUpdate?: (update: IndexerUpdate) => void;
}

export interface Indexer {
  /** Initial full resync, then the WS subscription (idempotent). */
  start(): Promise<void>;
  /** Unsubscribe + cancel timers (idempotent). */
  stop(): Promise<void>;
  /** One full `getProgramAccounts` sweep (start + every RESYNC_INTERVAL_MS). */
  resync(): Promise<void>;
}

/** Resync period (D12: devnet data is tiny, so a full sweep is cheap). */
export const RESYNC_INTERVAL_MS = 60_000;

export function createIndexer(opts: IndexerOptions): Indexer {
  // STUB (REQ-B-2). Later wave wires:
  //  - connection.onProgramAccountChange(opts.programId, handler, "confirmed"),
  //    decode via the SDK decoders, opts.db.upsertAccount(kind, …) per kind;
  //  - `fills` from OrderBook event-ring diffs and `funding_events` from
  //    PerpMarket.funding_accumulator diffs — exactly-once, seq-ordered, safe
  //    under out-of-order updates, duplicate deliveries, ring wrap and gaps;
  //  - resync() = getProgramAccounts sweep at start + every RESYNC_INTERVAL_MS;
  //  - opts.onUpdate(…) after each committed change (WS push fan-out).
  void opts;
  return {
    async start(): Promise<void> {
      // STUB: resync(); subscribe.
    },
    async stop(): Promise<void> {
      // STUB: unsubscribe; clear the resync timer.
    },
    async resync(): Promise<void> {
      // STUB: getProgramAccounts(programId, …) → decode → upsert.
    },
  };
}

// ---------------------------------------------------------------------------
// Pure event-diff fold (REQ-B-2, INDEXER-EVENT-DIFF-NO-LOSS-NO-DUP)
// ---------------------------------------------------------------------------

/** One decoded `order_book` account update, as delivered by the WS/RPC layer. */
export interface OrderBookEventSnapshot {
  kind: "order_book";
  /** Market PDA (base58). */
  market: string;
  /** Slot of the account update that carried this ring. */
  slot: number;
  /** Ring write cursor; events with `seq < eventWriteCursor` have been written. */
  eventWriteCursor: bigint;
  /**
   * Decoded ring in PHYSICAL order: index `i` holds the event with
   * `seq % EVENT_QUEUE_LEN === i`, or a stale/default slot when unwritten.
   */
  events: OutEventState[];
}

/** One decoded `market` (PerpMarket) account update. */
export interface MarketFundingSnapshot {
  kind: "market";
  market: string;
  slot: number;
  fundingEpoch: bigint;
  /** Signed cumulative funding accumulator (i128). */
  fundingAccumulator: bigint;
}

export type IndexerSnapshot = OrderBookEventSnapshot | MarketFundingSnapshot;

/** An order-book event buffered ahead of the contiguous watermark. */
export interface BufferedFillEvent {
  market: string;
  /** Slot of the snapshot that FIRST delivered this event (→ `FillRow.slot`). */
  slot: number;
  event: OutEventState;
}

/** Fold state carried across snapshot deliveries; per market where noted. */
export interface IndexerFoldState {
  /** market → highest CONTIGUOUS folded event seq (absent = not started). */
  fillSeq: Map<string, bigint>;
  /** Events received ahead of a gap, keyed by `${market}:${seq}`. */
  pendingFills: Map<string, BufferedFillEvent>;
  /** market → slot of the last folded funding snapshot. */
  fundingSlot: Map<string, number>;
  /** market → accumulator of the last folded funding snapshot. */
  fundingAccumulator: Map<string, bigint>;
  /** Next `FundingEventRow.seq` (1-based, monotone). */
  nextFundingSeq: number;
}

export interface IndexerFoldResult {
  state: IndexerFoldState;
  /** New fill rows, strictly ascending by `seq`. */
  fills: FillRow[];
  /** New funding rows, strictly ascending by `seq`. */
  fundingEvents: FundingEventRow[];
}

/**
 * Fold one decoded account update into the derived history (REQ-B-2): the pure
 * seam behind `fills` / `funding_events` — exactly-once, seq-ordered, safe
 * under out-of-order, duplicated, wrapped and gapped deliveries.
 *
 * Contract (pinned by `test/indexer.test.ts`):
 *  - `order_book`: the written window is
 *    `[max(0, eventWriteCursor - EVENT_QUEUE_LEN), eventWriteCursor)`; the
 *    event for seq `s` is read at `events[s % EVENT_QUEUE_LEN]`. Stale/default
 *    slots outside the window are ignored — an unwritten slot's default
 *    carries `seq 0` (and `kind 0`), so scanning slots by `seq < cursor` would
 *    both fabricate fills and clobber the real first event. The FIRST snapshot
 *    that carries a market's events establishes that market's baseline and
 *    folds them immediately; afterwards events buffer until the contiguous
 *    watermark (`fillSeq`) lets them drain in seq order. A re-delivered or
 *    older ring contributes nothing. Only `kind === 0` (Fill) events become
 *    `FillRow`s — a cancel/residual still advances the watermark; `owner`/
 *    `side`/`price`/`size` come from the event, `slot` from the snapshot that
 *    first delivered it.
 *  - `market`: the first snapshot establishes the funding baseline; a newer
 *    slot folds one `FundingEventRow` per accumulator change (`amount` = the
 *    signed delta vs the last folded accumulator, `seq` = `nextFundingSeq++`);
 *    an equal-or-older slot, or an unchanged accumulator, contributes nothing.
 *
 * `state === null` starts a fresh fold (the indexer threads the returned state
 * through every subsequent call).
 */
export function foldIndexerEvents(
  state: IndexerFoldState | null,
  snapshot: IndexerSnapshot,
): IndexerFoldResult {
  // STUB (REQ-B-2): conservative pass-through — the real fold (ring dedup,
  // contiguous drain, funding diffs) lands with the indexer wave. The state
  // shape is kept so callers can thread it today.
  void snapshot;
  return {
    state: state ?? {
      fillSeq: new Map(),
      pendingFills: new Map(),
      fundingSlot: new Map(),
      fundingAccumulator: new Map(),
      nextFundingSeq: 1,
    },
    fills: [],
    fundingEvents: [],
  };
}
