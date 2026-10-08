//! Chain indexer (D12, REQ-B-2): ingest every program account over the RPC
//! WebSocket (`onProgramAccountChange`, commitment `confirmed`), decode via the
//! SDK decoders, upsert into SQLite, and derive `fills` / `funding_events` from
//! the OrderBook event ring and the funding accumulator. Full
//! `getProgramAccounts` resync at start and every 60 s.
//!
//! Every newly folded fill carries the block time of its first-delivery slot
//! (REQ-K-1, `timestamps.ts` clock), and only fills whose row insert actually
//! succeeded ride the update event's `fills` field (REQ-K-4 → the WS `trade`
//! push; resync re-deliveries of already-persisted fills push nothing).

import type { Connection, Context, KeyedAccountInfo, PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_DISCRIMINATORS,
  EVENT_QUEUE_LEN,
  decodeOrderBook,
  decodePerpMarket,
  type OutEventState,
} from "fructus-sdk/src/index.js";
import type { AccountKind, Db, FillRow, FundingEventRow } from "./db.js";
import { createSlotClock } from "./timestamps.js";

/** In-process update event emitted after each indexed change (REQ-B-2 → REQ-B-7 pushes). */
export interface IndexerUpdate {
  kind: AccountKind;
  pubkey: string;
  slot: number;
  /**
   * Fills persisted by this update (ascending by seq; product-v3 REQ-K-4 trade
   * push). Absent/empty when the update carried no NEW fills (duplicates from
   * a resync re-delivery never reach this field).
   */
  fills?: FillRow[];
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
  /** Highest slot observed by a resync or an account update; `null` before the first. */
  lastSlot(): number | null;
}

/** Resync period (D12: devnet data is tiny, so a full sweep is cheap). */
export const RESYNC_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Account-kind mapping (Anchor discriminator → indexed table)
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

function kindFor(data: Uint8Array): AccountKind | null {
  if (data.length < 8) return null;
  return KIND_BY_DISCRIMINATOR.get(Array.from(data.subarray(0, 8)).join(",")) ?? null;
}

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------

export function createIndexer(opts: IndexerOptions): Indexer {
  let started = false;
  let subscriptionId: number | null = null;
  let resyncTimer: NodeJS.Timeout | null = null;
  let foldState: IndexerFoldState | null = null;
  let lastIndexedSlot: number | null = null;
  // Fire-and-forget subscription ingests, drained by stop() so a caller that
  // stops the indexer observes everything already delivered (a live update must
  // land even when stop() follows immediately — REVIEW-INDEXER-RESTART-REPLAY).
  const inflightIngests = new Set<Promise<void>>();
  function trackIngest(promise: Promise<void>): void {
    inflightIngests.add(promise);
    void promise.finally(() => inflightIngests.delete(promise));
  }

  // Per-process slot → block-time clock (REQ-K-1): fills carry the block time
  // of the slot that first delivered them; the clock's cache dedupes the RPC
  // fetches, so a fill batch that shares a slot costs one `getBlockTime`.
  const clock = createSlotClock({
    getBlockTime: (slot) => opts.connection.getBlockTime(slot),
    now: Date.now,
  });

  /**
   * 1 + the highest `funding_events.seq` already persisted. The store's seq PK
   * is global, and the fold's counter is per-process — a restart must continue
   * past the persisted seqs or the next funding diff is swallowed as a
   * duplicate (see `createIndexerFoldState`).
   */
  function persistedFundingFloor(): number {
    const row = opts.db.raw
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max FROM funding_events")
      .get() as { max: number } | undefined;
    return Number(row?.max ?? 0) + 1;
  }

  /**
   * Fold one decoded account payload into the derived history and persist it.
   * Returns the fills this delivery newly folded (ascending by seq) — the
   * caller resolves their block times before inserting (REQ-K-1).
   */
  function foldDerived(kind: AccountKind, data: Buffer, slot: number, pubkeyB58: string): FillRow[] {
    foldState ??= createIndexerFoldState(persistedFundingFloor());
    if (kind === "order_book") {
      const book = decodeOrderBook(data);
      if (book === null) return [];
      const result = foldIndexerEvents(foldState, {
        kind: "order_book",
        market: book.market.toBase58(),
        slot,
        eventWriteCursor: book.eventWriteCursor,
        events: book.events,
      });
      foldState = result.state;
      return result.fills;
    } else if (kind === "market") {
      const market = decodePerpMarket(data);
      if (market === null) return [];
      const result = foldIndexerEvents(foldState, {
        kind: "market",
        market: pubkeyB58,
        slot,
        fundingEpoch: market.fundingEpoch,
        fundingAccumulator: market.fundingAccumulator,
      });
      foldState = result.state;
      for (const row of result.fundingEvents) insertIgnoreDuplicateFunding(row);
    }
    return [];
  }

  /** Insert one folded fill; `false` when the seq was already persisted (no-op). */
  function insertIgnoreDuplicate(fill: FillRow): boolean {
    try {
      opts.db.insertFill(fill);
      return true;
    } catch {
      // Already folded in an earlier process lifetime (fresh fold state after a
      // restart re-delivers the ring baseline) — the seq PK makes it a no-op.
      return false;
    }
  }

  function insertIgnoreDuplicateFunding(row: FundingEventRow): void {
    try {
      opts.db.insertFundingEvent(row);
    } catch {
      // Duplicate funding seq after a restart — see insertIgnoreDuplicate.
    }
  }

  /**
   * Upsert one raw account, derive its history, and emit the update event.
   * Every newly folded fill gets its slot's block time resolved (REQ-K-1,
   * cached per slot) BEFORE the insert; only fills whose row insert actually
   * succeeded ride the update's `fills` (REQ-K-4 — resync re-deliveries of
   * already-persisted fills must not push).
   */
  async function ingest(kind: AccountKind, pubkey: PublicKey, data: Buffer, slot: number): Promise<void> {
    opts.db.upsertAccount(kind, pubkey.toBase58(), data, slot);
    if (lastIndexedSlot === null || slot > lastIndexedSlot) lastIndexedSlot = slot;
    const folded = foldDerived(kind, data, slot, pubkey.toBase58());
    const newlyInserted: FillRow[] = [];
    for (const fill of folded) {
      const row: FillRow = { ...fill, timeMs: await clock.timeForSlot(fill.slot) };
      if (insertIgnoreDuplicate(row)) newlyInserted.push(row);
    }
    opts.onUpdate?.({
      kind,
      pubkey: pubkey.toBase58(),
      slot,
      fills: newlyInserted.length > 0 ? newlyInserted : undefined,
    });
  }

  async function resync(): Promise<void> {
    const slot = await opts.connection.getSlot("confirmed");
    const accounts = await opts.connection.getProgramAccounts(opts.programId, {
      commitment: "confirmed",
    });
    for (const { pubkey, account } of accounts) {
      const kind = kindFor(account.data);
      if (kind === null) continue;
      await ingest(kind, pubkey, account.data, slot);
    }
    if (lastIndexedSlot === null || slot > lastIndexedSlot) lastIndexedSlot = slot;
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      await resync();
      try {
        subscriptionId = opts.connection.onProgramAccountChange(
          opts.programId,
          (keyed: KeyedAccountInfo, context: Context) => {
            const kind = kindFor(keyed.accountInfo.data);
            if (kind === null) return;
            trackIngest(
              ingest(kind, keyed.accountId, keyed.accountInfo.data, context.slot).catch(
                (err: unknown) => {
                  console.error(`fructus-server: indexer update failed: ${describe(err)}`);
                },
              ),
            );
          },
          "confirmed",
        );
      } catch (err) {
        console.error(`fructus-server: indexer subscription failed: ${describe(err)}`);
      }
      resyncTimer = setInterval(() => {
        void resync().catch((err: unknown) => {
          console.error(`fructus-server: resync failed: ${describe(err)}`);
        });
      }, RESYNC_INTERVAL_MS);
      resyncTimer.unref();
    },

    async stop(): Promise<void> {
      if (subscriptionId !== null) {
        try {
          await opts.connection.removeProgramAccountChangeListener(subscriptionId);
        } catch {
          /* already gone (e.g. validator stopped) */
        }
        subscriptionId = null;
      }
      if (resyncTimer !== null) {
        clearInterval(resyncTimer);
        resyncTimer = null;
      }
      started = false;
      // Drain in-flight subscription ingests: fire-and-forget on the hot path,
      // but stop() must be deterministic — everything the callbacks delivered
      // before the unsubscribe has landed in the store (and emitted its
      // update) once stop() resolves.
      await Promise.allSettled([...inflightIngests]);
    },

    async resync(): Promise<void> {
      await resync();
    },

    lastSlot(): number | null {
      return lastIndexedSlot;
    },
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * Fresh fold state. `nextFundingSeq` is the next `FundingEventRow.seq`: the
 * indexer seeds it past the seqs already persisted in the store, so a
 * post-restart funding diff cannot collide with the store's seq PK (which
 * would silently swallow it as a duplicate) — a pure caller starts at 1.
 */
export function createIndexerFoldState(nextFundingSeq = 1): IndexerFoldState {
  return {
    fillSeq: new Map(),
    pendingFills: new Map(),
    fundingSlot: new Map(),
    fundingAccumulator: new Map(),
    nextFundingSeq,
  };
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
  const next = state ?? createIndexerFoldState();
  return snapshot.kind === "order_book"
    ? foldOrderBook(next, snapshot)
    : foldMarketFunding(next, snapshot);
}

function foldOrderBook(
  state: IndexerFoldState,
  snapshot: OrderBookEventSnapshot,
): IndexerFoldResult {
  const { market } = snapshot;
  const queueLen = BigInt(EVENT_QUEUE_LEN);
  const cursor = snapshot.eventWriteCursor;
  const windowStart = cursor > queueLen ? cursor - queueLen : 0n;

  let expected = state.fillSeq.get(market);
  if (expected === undefined) {
    // First snapshot for this market: it is the baseline. Events older than the
    // ring window are unrecoverable (already overwritten on-chain), so the
    // watermark starts at the window start; the rest folds below.
    expected = windowStart;
    state.fillSeq.set(market, expected);
  }
  if (cursor <= expected) {
    // Stale or duplicate ring: everything it carries sits below the watermark.
    return { state, fills: [], fundingEvents: [] };
  }

  // Buffer every not-yet-folded event in the written window. The FIRST
  // delivery's slot wins; duplicates and stale re-deliveries never overwrite.
  const from = expected > windowStart ? expected : windowStart;
  for (let seq = from; seq < cursor; seq++) {
    const key = `${market}:${seq}`;
    if (state.pendingFills.has(key)) continue;
    const event = snapshot.events[Number(seq % queueLen)];
    state.pendingFills.set(key, { market, slot: snapshot.slot, event });
  }

  // Drain the contiguous watermark in seq order; only Fill (kind 0) events
  // become rows, but every drained seq advances the watermark (so a later fill
  // never stalls behind a cancel/residual) and no seq is ever emitted twice.
  const fills: FillRow[] = [];
  for (;;) {
    const key = `${market}:${expected}`;
    const buffered = state.pendingFills.get(key);
    if (buffered === undefined) break;
    state.pendingFills.delete(key);
    if (buffered.event.kind === 0) {
      fills.push({
        seq: Number(expected),
        slot: buffered.slot,
        market: buffered.market,
        owner: buffered.event.owner.toBase58(),
        side: buffered.event.side,
        price: buffered.event.price.toString(),
        size: buffered.event.size.toString(),
      });
    }
    expected += 1n;
  }
  state.fillSeq.set(market, expected);
  return { state, fills, fundingEvents: [] };
}

function foldMarketFunding(
  state: IndexerFoldState,
  snapshot: MarketFundingSnapshot,
): IndexerFoldResult {
  const { market } = snapshot;
  const lastSlot = state.fundingSlot.get(market);
  const lastAcc = state.fundingAccumulator.get(market);
  if (lastSlot === undefined || lastAcc === undefined) {
    // First snapshot for this market: the funding baseline (no row).
    state.fundingSlot.set(market, snapshot.slot);
    state.fundingAccumulator.set(market, snapshot.fundingAccumulator);
    return { state, fills: [], fundingEvents: [] };
  }
  if (snapshot.slot <= lastSlot) {
    // Duplicate or stale delivery: an equal-or-older slot is a no-op.
    return { state, fills: [], fundingEvents: [] };
  }
  state.fundingSlot.set(market, snapshot.slot);
  if (snapshot.fundingAccumulator === lastAcc) {
    // Newer slot, unchanged accumulator: nothing to fold.
    return { state, fills: [], fundingEvents: [] };
  }
  const row: FundingEventRow = {
    seq: state.nextFundingSeq,
    slot: snapshot.slot,
    market,
    amount: (snapshot.fundingAccumulator - lastAcc).toString(),
  };
  state.nextFundingSeq += 1;
  state.fundingAccumulator.set(market, snapshot.fundingAccumulator);
  return { state, fills: [], fundingEvents: [row] };
}
