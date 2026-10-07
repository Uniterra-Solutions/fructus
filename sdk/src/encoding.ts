//! Anchor instruction/account discriminators and borsh-serialization helpers.
//!
//! Anchor prefixes every instruction with the first 8 bytes of
//! `sha256("global:<ix_name>")` and every `#[account]` (and `#[account(zero_copy)]`)
//! with the first 8 bytes of `sha256("account:<TypeName>")`. The `write*` helpers
//! encode instruction args in borsh's little-endian fixed-width form, matching
//! the on-chain `Context<...>` argument decoding.

import { PublicKey } from "@solana/web3.js";

// --- pure-JS SHA-256 (browser path, D13/REQ-C-2) ----------------------------
//
// Anchor discriminators are the first 8 bytes of `sha256("global:<name>")` /
// `sha256("account:<name>")`. The browser entry must bundle without Node
// builtins, so this self-contained FIPS 180-4 SHA-256 replaces `node:crypto`'s
// `createHash` with zero dependencies (`TextEncoder` is standard in browsers
// and Node >= 11).

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** SHA-256 over raw bytes (FIPS 180-4), returned as 32 big-endian bytes. */
function sha256(bytes: Uint8Array): Uint8Array {
  const bitLen = bytes.length * 8;
  // Pad to `1 || 0* || 64-bit length`: ceil((len + 9) / 64) blocks.
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x1_0000_0000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(off + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr32(x, 7) ^ rotr32(x, 18) ^ (x >>> 3);
      const s1 = rotr32(y, 17) ^ rotr32(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, h[i], false);
  }
  return out;
}

/** The first 8 bytes of `sha256(prefix + name)` as a Buffer. */
function discriminator(prefix: string, name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(prefix + name)).subarray(0, 8));
}

/** The first 8 bytes of `sha256("global:<name>")` — the Anchor ix discriminator. */
export function anchorIxDiscriminator(name: string): Buffer {
  return discriminator("global:", name);
}

/** The first 8 bytes of `sha256("account:<name>")` — the Anchor account discriminator. */
export function anchorAccountDiscriminator(name: string): Buffer {
  return discriminator("account:", name);
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
