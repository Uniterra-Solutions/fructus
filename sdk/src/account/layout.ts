//! Account layout constants (offsets + sizes) for the on-chain account types.
//!
//! These mirror the field order and sizes declared in
//! `programs/fructus/src/state.rs`. Borsh `#[account]` types (`PerpMarket`,
//! `Position`, `UserCollateral`, `YieldOracle`) are packed little-endian; the
//! `#[account(zero_copy)]` `OrderBook` type is `#[repr(C)]` with explicit
//! padding (no implicit packing), and both begin after the standard 8-byte
//! Anchor account discriminator.
//!
//! The `*_OFFSET` constants are the payload offsets (i.e. relative to the start
//! of the account data, *after* the 8-byte discriminator). Decoders add
//! `DISCRIMINATOR` to read from the raw account buffer.

/** Anchor account discriminator length prepended to every account payload. */
export const DISCRIMINATOR = 8;

// --- PerpMarket (borsh `#[account]`), payload LEN = 205 ---------------------
export const PERP_MARKET_LEN = 205;
export const PerpMarket = {
  indexSource: 0,
  collateralMint: 32,
  fundingK: 64,
  maxFunding: 72,
  fundingEpochSlots: 80,
  initialMarginBps: 88,
  maintenanceMarginBps: 90,
  authority: 92,
  vault: 124,
  fundingEpoch: 156,
  indexN: 164,
  indexD: 172,
  fundingAccumulator: 180,
  pnlPool: 196,
  bump: 204,
} as const;

// --- Position (borsh `#[account]`), payload LEN = 170 -----------------------
export const POSITION_LEN = 170;
export const Position = {
  market: 0,
  owner: 32,
  side: 64,
  notional: 65,
  entryN: 73,
  entryD: 89,
  collateral: 105,
  lastFundingEpoch: 113,
  closedNotional: 121,
  closedEntryN: 129,
  closedEntryD: 145,
  openSlot: 161,
  bump: 169,
} as const;

// --- UserCollateral (borsh `#[account]`), payload LEN = 25 ------------------
export const USER_COLLATERAL_LEN = 25;
export const UserCollateralLayout = {
  deposited: 0,
  reserved: 8,
  claimable: 16,
  bump: 24,
} as const;

// --- Operator (borsh `#[account]`), payload LEN = 97 ------------------------
// Per-`(market, user)` delegation record (D3): the `operator` field holds the
// delegate key, or `Pubkey::default()` when revoked.
export const OPERATOR_LEN = 97;
export const OperatorLayout = {
  market: 0,
  user: 32,
  operator: 64,
  bump: 96,
} as const;

// --- YieldOracle (borsh `#[account]`), payload LEN = 97 ---------------------
export const YIELD_ORACLE_LEN = 97;
export const YieldOracleLayout = {
  apy: 0,
  version: 8,
  lastUpdateSlot: 16,
  publisher: 24,
  authority: 56,
  staleAfterSlots: 88,
  bump: 96,
} as const;

// --- OrderBook (`#[account(zero_copy)]`, `#[repr(C)]`), payload LEN = 6_232 --
export const ORDER_BOOK_LEN = 6_232;
export const OrderBookLayout = {
  nextSeq: 0,
  bestBid: 8,
  bestAsk: 16,
  eventReadCursor: 24,
  eventWriteCursor: 32,
  twapCursor: 40,
  market: 48,
  bump: 80,
  // header `_pad[7]` fills bytes 81..88
  headerLen: 88,
  bids: 88,
  asks: 88 + 16 * 64, // 1_112
  events: 88 + 16 * 64 + 16 * 64, // 2_136
  observations: 88 + 16 * 64 + 16 * 64 + 32 * 112, // 5_720
} as const;

// --- Order (zero-copy, `#[repr(C)]`), LEN = 64 --------------------------------
export const ORDER_LEN = 64;
export const OrderLayout = {
  owner: 0,
  price: 32,
  size: 40,
  seq: 48,
  active: 56,
  // `_pad[7]` fills bytes 57..64
} as const;

// --- OutEvent (zero-copy, `#[repr(C)]`), LEN = 112 ----------------------------
export const OUT_EVENT_LEN = 112;
export const OutEventLayout = {
  seq: 0,
  price: 8,
  size: 16,
  owner: 24,
  counterparty: 56,
  entryTotalLamports: 88,
  entryPoolTokenSupply: 96,
  settled: 104,
  kind: 105,
  side: 106,
  // `_pad[5]` fills bytes 107..112
} as const;

// --- Observation (zero-copy, `#[repr(C)]`), LEN = 32 ---------------------------
export const OBSERVATION_LEN = 32;
export const ObservationLayout = {
  slot: 0,
  mid: 8,
  cumulativeMid: 16,
} as const;
