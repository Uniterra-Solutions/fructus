//! Typed account decoders (R-SDK2): raw-offset reads matching `state.rs`.
//!
//! Every decoder expects the **full** account data buffer (including the 8-byte
//! Anchor discriminator) and reads fields at `DISCRIMINATOR + <payload offset>`.
//! `u64` fields are `bigint`, `u128`/`i128` are `bigint`, `Pubkey` is a
//! `PublicKey`, and the zero-copy `OrderBook` arrays are decoded element-by-
//! element. A truncated buffer yields `null`.

import { PublicKey } from "@solana/web3.js";
import { readI128LE, readU128LE } from "../encoding.js";
import {
  DISCRIMINATOR,
  ObservationLayout,
  ORDER_LEN,
  OrderBookLayout,
  OrderLayout,
  OPERATOR_LEN,
  OUT_EVENT_LEN,
  OperatorLayout,
  OutEventLayout,
  PERP_MARKET_LEN,
  PerpMarket,
  POSITION_LEN,
  Position,
  USER_COLLATERAL_LEN,
  UserCollateralLayout,
  YIELD_ORACLE_LEN,
  YieldOracleLayout,
} from "./layout.js";

function need(data: Uint8Array, payloadLen: number): boolean {
  return data.length >= DISCRIMINATOR + payloadLen;
}

function readPubkey(data: Uint8Array, off: number): PublicKey {
  return new PublicKey(data.subarray(off, off + 32));
}

// ---------------------------------------------------------------------------
// PerpMarket
// ---------------------------------------------------------------------------

export interface PerpMarketState {
  indexSource: PublicKey;
  collateralMint: PublicKey;
  fundingK: bigint;
  maxFunding: bigint;
  fundingEpochSlots: bigint;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  authority: PublicKey;
  vault: PublicKey;
  fundingEpoch: bigint;
  indexN: bigint;
  indexD: bigint;
  /** Signed cumulative funding (i128). */
  fundingAccumulator: bigint;
  /** Market-level PnL pool (Design A): USDC microunits collected from losers. */
  pnlPool: bigint;
  bump: number;
}

export function decodePerpMarket(data: Buffer | null): PerpMarketState | null {
  if (!data || !need(data, PERP_MARKET_LEN)) {
    return null;
  }
  const d = DISCRIMINATOR;
  return {
    indexSource: readPubkey(data, d + PerpMarket.indexSource),
    collateralMint: readPubkey(data, d + PerpMarket.collateralMint),
    fundingK: data.readBigUInt64LE(d + PerpMarket.fundingK),
    maxFunding: data.readBigUInt64LE(d + PerpMarket.maxFunding),
    fundingEpochSlots: data.readBigUInt64LE(d + PerpMarket.fundingEpochSlots),
    initialMarginBps: data.readUInt16LE(d + PerpMarket.initialMarginBps),
    maintenanceMarginBps: data.readUInt16LE(d + PerpMarket.maintenanceMarginBps),
    authority: readPubkey(data, d + PerpMarket.authority),
    vault: readPubkey(data, d + PerpMarket.vault),
    fundingEpoch: data.readBigUInt64LE(d + PerpMarket.fundingEpoch),
    indexN: data.readBigUInt64LE(d + PerpMarket.indexN),
    indexD: data.readBigUInt64LE(d + PerpMarket.indexD),
    fundingAccumulator: readI128LE(data, d + PerpMarket.fundingAccumulator),
    pnlPool: data.readBigUInt64LE(d + PerpMarket.pnlPool),
    bump: data[d + PerpMarket.bump],
  };
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export interface PositionState {
  market: PublicKey;
  owner: PublicKey;
  /** `0` = Long/Bid, `1` = Short/Ask. */
  side: number;
  notional: bigint;
  entryN: bigint;
  entryD: bigint;
  collateral: bigint;
  lastFundingEpoch: bigint;
  closedNotional: bigint;
  /** Entry basis (numerator) carried by `closedNotional`, captured at close time. */
  closedEntryN: bigint;
  /** Entry basis (denominator) carried by `closedNotional`, captured at close time. */
  closedEntryD: bigint;
  openSlot: bigint;
  bump: number;
}

export function decodePosition(data: Buffer | null): PositionState | null {
  if (!data || !need(data, POSITION_LEN)) {
    return null;
  }
  const d = DISCRIMINATOR;
  return {
    market: readPubkey(data, d + Position.market),
    owner: readPubkey(data, d + Position.owner),
    side: data[d + Position.side],
    notional: data.readBigUInt64LE(d + Position.notional),
    entryN: readU128LE(data, d + Position.entryN),
    entryD: readU128LE(data, d + Position.entryD),
    collateral: data.readBigUInt64LE(d + Position.collateral),
    lastFundingEpoch: data.readBigUInt64LE(d + Position.lastFundingEpoch),
    closedNotional: data.readBigUInt64LE(d + Position.closedNotional),
    closedEntryN: readU128LE(data, d + Position.closedEntryN),
    closedEntryD: readU128LE(data, d + Position.closedEntryD),
    openSlot: data.readBigUInt64LE(d + Position.openSlot),
    bump: data[d + Position.bump],
  };
}

// ---------------------------------------------------------------------------
// UserCollateral
// ---------------------------------------------------------------------------

export interface UserCollateralState {
  deposited: bigint;
  reserved: bigint;
  /** Pending (unfunded) PnL/funding claim (Design A); not directly withdrawable. */
  claimable: bigint;
  bump: number;
}

export function decodeUserCollateral(data: Buffer | null): UserCollateralState | null {
  if (!data || !need(data, USER_COLLATERAL_LEN)) {
    return null;
  }
  const d = DISCRIMINATOR;
  return {
    deposited: data.readBigUInt64LE(d + UserCollateralLayout.deposited),
    reserved: data.readBigUInt64LE(d + UserCollateralLayout.reserved),
    claimable: data.readBigUInt64LE(d + UserCollateralLayout.claimable),
    bump: data[d + UserCollateralLayout.bump],
  };
}

// ---------------------------------------------------------------------------
// YieldOracle
// ---------------------------------------------------------------------------

export interface YieldOracleState {
  apy: bigint;
  version: bigint;
  lastUpdateSlot: bigint;
  publisher: PublicKey;
  authority: PublicKey;
  staleAfterSlots: bigint;
  bump: number;
}

export function decodeYieldOracle(data: Buffer | null): YieldOracleState | null {
  if (!data || !need(data, YIELD_ORACLE_LEN)) {
    return null;
  }
  const d = DISCRIMINATOR;
  return {
    apy: data.readBigUInt64LE(d + YieldOracleLayout.apy),
    version: data.readBigUInt64LE(d + YieldOracleLayout.version),
    lastUpdateSlot: data.readBigUInt64LE(d + YieldOracleLayout.lastUpdateSlot),
    publisher: readPubkey(data, d + YieldOracleLayout.publisher),
    authority: readPubkey(data, d + YieldOracleLayout.authority),
    staleAfterSlots: data.readBigUInt64LE(d + YieldOracleLayout.staleAfterSlots),
    bump: data[d + YieldOracleLayout.bump],
  };
}

// ---------------------------------------------------------------------------
// Operator
// ---------------------------------------------------------------------------

export interface OperatorState {
  market: PublicKey;
  user: PublicKey;
  /** The delegate key; `PublicKey.default` ⇒ revoked (record kept). */
  operator: PublicKey;
  bump: number;
}

/**
 * Decode the 97-byte `Operator` payload (`market@0, user@32, operator@64,
 * bump@96`, after the 8-byte Anchor discriminator). A buffer shorter than
 * `DISCRIMINATOR + OPERATOR_LEN` yields `null`; trailing padding is ignored
 * (the `need()` >= convention).
 */
export function decodeOperator(data: Buffer | Uint8Array | null): OperatorState | null {
  if (!data || !need(data, OPERATOR_LEN)) {
    return null;
  }
  const d = DISCRIMINATOR;
  return {
    market: readPubkey(data, d + OperatorLayout.market),
    user: readPubkey(data, d + OperatorLayout.user),
    operator: readPubkey(data, d + OperatorLayout.operator),
    bump: data[d + OperatorLayout.bump],
  };
}

// ---------------------------------------------------------------------------
// OrderBook (zero-copy)
// ---------------------------------------------------------------------------

export interface OrderState {
  owner: PublicKey;
  price: bigint;
  size: bigint;
  seq: bigint;
  active: number;
}

export interface OutEventState {
  seq: bigint;
  price: bigint;
  size: bigint;
  owner: PublicKey;
  counterparty: PublicKey;
  entryTotalLamports: bigint;
  entryPoolTokenSupply: bigint;
  settled: number;
  kind: number;
  side: number;
}

export interface ObservationState {
  slot: bigint;
  mid: bigint;
  cumulativeMid: bigint;
}

export interface OrderBookState {
  nextSeq: bigint;
  bestBid: bigint;
  bestAsk: bigint;
  eventReadCursor: bigint;
  eventWriteCursor: bigint;
  twapCursor: bigint;
  market: PublicKey;
  bump: number;
  bids: OrderState[];
  asks: OrderState[];
  events: OutEventState[];
  observations: ObservationState[];
}

export function decodeOrderBook(data: Buffer | null): OrderBookState | null {
  if (!data || !need(data, 6_232)) {
    return null;
  }
  const d = DISCRIMINATOR;
  const L = OrderBookLayout;
  return {
    nextSeq: data.readBigUInt64LE(d + L.nextSeq),
    bestBid: data.readBigUInt64LE(d + L.bestBid),
    bestAsk: data.readBigUInt64LE(d + L.bestAsk),
    eventReadCursor: data.readBigUInt64LE(d + L.eventReadCursor),
    eventWriteCursor: data.readBigUInt64LE(d + L.eventWriteCursor),
    twapCursor: data.readBigUInt64LE(d + L.twapCursor),
    market: readPubkey(data, d + L.market),
    bump: data[d + L.bump],
    bids: decodeOrders(data, d + L.bids),
    asks: decodeOrders(data, d + L.asks),
    events: decodeEvents(data, d + L.events),
    observations: decodeObservations(data, d + L.observations),
  };
}

function decodeOrders(data: Buffer, base: number): OrderState[] {
  const out: OrderState[] = [];
  for (let i = 0; i < 16; i++) {
    const off = base + i * ORDER_LEN;
    out.push({
      owner: readPubkey(data, off + OrderLayout.owner),
      price: data.readBigUInt64LE(off + OrderLayout.price),
      size: data.readBigUInt64LE(off + OrderLayout.size),
      seq: data.readBigUInt64LE(off + OrderLayout.seq),
      active: data[off + OrderLayout.active],
    });
  }
  return out;
}

function decodeEvents(data: Buffer, base: number): OutEventState[] {
  const out: OutEventState[] = [];
  for (let i = 0; i < 32; i++) {
    const off = base + i * OUT_EVENT_LEN;
    out.push({
      seq: data.readBigUInt64LE(off + OutEventLayout.seq),
      price: data.readBigUInt64LE(off + OutEventLayout.price),
      size: data.readBigUInt64LE(off + OutEventLayout.size),
      owner: readPubkey(data, off + OutEventLayout.owner),
      counterparty: readPubkey(data, off + OutEventLayout.counterparty),
      entryTotalLamports: data.readBigUInt64LE(off + OutEventLayout.entryTotalLamports),
      entryPoolTokenSupply: data.readBigUInt64LE(off + OutEventLayout.entryPoolTokenSupply),
      settled: data[off + OutEventLayout.settled],
      kind: data[off + OutEventLayout.kind],
      side: data[off + OutEventLayout.side],
    });
  }
  return out;
}

function decodeObservations(data: Buffer, base: number): ObservationState[] {
  const out: ObservationState[] = [];
  for (let i = 0; i < 16; i++) {
    const off = base + i * 32;
    out.push({
      slot: data.readBigUInt64LE(off + ObservationLayout.slot),
      mid: data.readBigUInt64LE(off + ObservationLayout.mid),
      cumulativeMid: readU128LE(data, off + ObservationLayout.cumulativeMid),
    });
  }
  return out;
}
