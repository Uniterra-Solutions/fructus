//! Anchor instruction/account discriminators and borsh-serialization helpers.
//!
//! Anchor prefixes every instruction with the first 8 bytes of
//! `sha256("global:<ix_name>")` and every `#[account]` (and `#[account(zero_copy)]`)
//! with the first 8 bytes of `sha256("account:<TypeName>")`. The `write*` helpers
//! encode instruction args in borsh's little-endian fixed-width form, matching
//! the on-chain `Context<...>` argument decoding.

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

/** The first 8 bytes of `sha256("global:<name>")` — the Anchor ix discriminator. */
export function anchorIxDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/** The first 8 bytes of `sha256("account:<name>")` — the Anchor account discriminator. */
export function anchorAccountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

/**
 * Precomputed Anchor instruction discriminators, keyed by instruction name:
 * `sha256("global:<name>")[0..8]` (D13, REQ-C-2 — the browser path must not
 * need `node:crypto`). Covers all 21 direct instructions plus the operator
 * layer (`set_operator` + the 7 `operator_*` instructions). The
 * `anchorIxDiscriminator` helper above is the runtime reference the table is
 * pinned against in tests.
 */
export const IX_DISCRIMINATORS: Record<string, number[]> = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  initialize_market: [35, 35, 189, 193, 155, 48, 170, 203],
  update_apy: [94, 110, 147, 45, 73, 167, 222, 77],
  set_stale_window: [189, 158, 76, 38, 2, 227, 121, 34],
  set_publisher: [110, 54, 4, 216, 151, 85, 46, 91],
  read_exchange_rate: [76, 106, 201, 30, 188, 207, 136, 137],
  initialize_order_book: [93, 233, 9, 128, 33, 199, 152, 88],
  initialize_collateral_vault: [50, 63, 54, 33, 53, 166, 24, 61],
  deposit_collateral: [156, 131, 142, 116, 146, 247, 162, 120],
  withdraw_collateral: [115, 135, 168, 106, 139, 214, 138, 150],
  place_limit_order: [108, 176, 33, 186, 146, 229, 1, 197],
  place_market_order: [90, 118, 192, 252, 192, 99, 39, 145],
  cancel_order: [95, 129, 237, 240, 8, 49, 223, 132],
  crank: [0, 232, 3, 195, 124, 117, 105, 53],
  open_position: [135, 128, 47, 77, 15, 152, 240, 49],
  close_position: [123, 134, 81, 0, 49, 68, 98, 98],
  settle_fill: [197, 81, 135, 50, 191, 3, 171, 75],
  reset_position: [26, 231, 79, 28, 18, 115, 223, 107],
  settle_close: [151, 229, 199, 24, 177, 153, 171, 49],
  settle_funding: [11, 251, 12, 161, 199, 228, 133, 87],
  liquidate: [223, 179, 226, 125, 48, 46, 39, 74],
  set_operator: [238, 153, 101, 169, 243, 131, 36, 1],
  operator_deposit_collateral: [227, 121, 250, 186, 80, 122, 95, 197],
  operator_withdraw_collateral: [182, 227, 182, 161, 137, 249, 205, 119],
  operator_open_position: [145, 102, 139, 11, 219, 188, 135, 6],
  operator_close_position: [30, 80, 0, 23, 102, 42, 40, 234],
  operator_place_limit_order: [37, 112, 3, 92, 173, 69, 195, 193],
  operator_place_market_order: [173, 65, 20, 137, 115, 249, 143, 227],
  operator_cancel_order: [209, 183, 185, 237, 87, 125, 31, 99],
};

/**
 * Precomputed Anchor account discriminators, keyed by account type name:
 * `sha256("account:<TypeName>")[0..8]` (D13, REQ-C-2). The
 * `anchorAccountDiscriminator` helper above is the runtime reference the table
 * is pinned against in tests.
 */
export const ACCOUNT_DISCRIMINATORS: Record<string, number[]> = {
  YieldOracle: [141, 184, 168, 160, 175, 58, 138, 33],
  PerpMarket: [10, 223, 12, 44, 107, 245, 55, 247],
  OrderBook: [55, 230, 125, 218, 149, 39, 65, 248],
  UserCollateral: [105, 117, 183, 100, 173, 169, 109, 65],
  Position: [170, 188, 143, 228, 122, 64, 247, 208],
  Operator: [219, 31, 188, 145, 69, 139, 204, 117],
};

/** Encode a `u64` / `i64` as 8 little-endian bytes (borsh). */
export function writeU64LE(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n);
  return buf;
}

/** Encode a signed `i64` as 8 little-endian bytes (borsh). `n` must fit in i64. */
export function writeI64LE(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(n);
  return buf;
}

/** Encode a `u16` / `i16` as 2 little-endian bytes (borsh). */
export function writeU16LE(n: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n);
  return buf;
}

/** Encode a `u8` as a single byte (borsh). */
export function writeU8(n: number): Buffer {
  return Buffer.from([n & 0xff]);
}

/** Encode a `Pubkey` as its 32 raw bytes. */
export function writePubkey(pk: PublicKey): Buffer {
  return pk.toBuffer();
}

/**
 * Read an unsigned 128-bit integer stored as 16 bytes little-endian (borsh
 * `u128`, or the raw `[u8; 16]` `cumulative_mid` of a zero-copy observation).
 */
export function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

/**
 * Read a signed 128-bit integer stored as 16 bytes little-endian (borsh `i128`),
 * e.g. `PerpMarket.funding_accumulator`.
 */
export function readI128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  let value = (hi << 64n) | lo;
  // Two's-complement sign extension from bit 127.
  if (value >= 1n << 127n) {
    value -= 1n << 128n;
  }
  return value;
}

/** Read a `u64` from `data` at `ADDRESS_OFFSET`, tolerating short buffers. */
export function readU64LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

export function readU8(data: Buffer, offset: number): number {
  return data[offset];
}
