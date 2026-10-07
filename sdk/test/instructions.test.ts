import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "../src/constants.js";
import { anchorIxDiscriminator } from "../src/encoding.js";
import {
  buildClosePosition,
  buildDepositCollateral,
  buildInitialize,
  buildLiquidate,
  buildOpenPosition,
  buildPlaceLimitOrder,
  buildResetPosition,
  buildSettleClose,
  buildSettleFunding,
  buildUpdateApy,
  buildWithdrawCollateral,
  TOKEN_PROGRAM_ID,
} from "../src/instructions.js";

// R-SDK1 smoke: every builder emits an 8-byte anchor discriminator + borsh args,
// and the account keys are ordered/write-flagged as the program declares.

test("anchor discriminators are 8 bytes", () => {
  for (const name of [
    "initialize",
    "initialize_market",
    "update_apy",
    "open_position",
    "close_position",
    "deposit_collateral",
    "withdraw_collateral",
    "settle_funding",
    "settle_close",
    "liquidate",
    "place_limit_order",
    "cancel_order",
    "crank",
    // Operator layer (REQ-A1-7): set_operator + the 7 operator_* instructions.
    "set_operator",
    "operator_deposit_collateral",
    "operator_withdraw_collateral",
    "operator_open_position",
    "operator_close_position",
    "operator_place_limit_order",
    "operator_place_market_order",
    "operator_cancel_order",
  ]) {
    assert.equal(anchorIxDiscriminator(name).length, 8, name);
  }
});

test("buildUpdateApy encodes apy/version after the discriminator", () => {
  const oracle = PublicKey.unique();
  const ix = buildUpdateApy({ oracle, apy: 71_840n, version: 1n });
  assert.equal(ix.programId.toBase58(), PROGRAM_ID.toBase58());
  assert.deepEqual(ix.data.subarray(0, 8), anchorIxDiscriminator("update_apy"));
  assert.deepEqual(ix.data.subarray(8), concat(writeU64(71_840n), writeU64(1n)));
  // Keys: oracle (writable) then instruction sysvar (read).
  assert.equal(ix.keys[0].pubkey.toBase58(), oracle.toBase58());
  assert.equal(ix.keys[0].isWritable, true);
  assert.equal(ix.keys[1].isWritable, false);
});

test("buildOpenPosition encodes side/size/price and orders the accounts", () => {
  const owner = PublicKey.unique();
  const market = PublicKey.unique();
  const indexSource = PublicKey.unique();
  const ix = buildOpenPosition({
    owner,
    market,
    indexSource,
    side: 0,
    size: 1_000_000n,
    price: 1_050_000n,
  });
  assert.deepEqual(ix.data.subarray(0, 8), anchorIxDiscriminator("open_position"));
  assert.deepEqual(
    ix.data.subarray(8),
    concat(Buffer.from([0]), writeU64(1_000_000n), writeU64(1_050_000n)),
  );
  // owner is a writable signer first; position + user_collateral are writable.
  assert.equal(ix.keys[0].pubkey.toBase58(), owner.toBase58());
  assert.equal(ix.keys[0].isSigner, true);
  assert.equal(ix.keys[0].isWritable, true);
  assert.equal(ix.keys[4].isWritable, true); // position
  assert.equal(ix.keys[5].isWritable, true); // user_collateral
});

test("buildPlaceLimitOrder requires a nonzero price path", () => {
  const ix = buildPlaceLimitOrder({
    owner: PublicKey.unique(),
    market: PublicKey.unique(),
    indexSource: PublicKey.unique(),
    side: 1,
    price: 1_050_000n,
    size: 500_000n,
  });
  assert.deepEqual(ix.data.subarray(0, 8), anchorIxDiscriminator("place_limit_order"));
  assert.deepEqual(
    ix.data.subarray(8),
    concat(Buffer.from([1]), writeU64(1_050_000n), writeU64(500_000n)),
  );
});

test("close / deposit / withdraw / settle / liquidate encode their args", () => {
  const owner = PublicKey.unique();
  const market = PublicKey.unique();
  const indexSource = PublicKey.unique();
  const pos = PublicKey.unique();
  const uc = PublicKey.unique();
  const liq = PublicKey.unique();

  const close = buildClosePosition({ owner, market, indexSource, position: pos, userCollateral: uc, side: 1, size: 5_000n });
  assert.deepEqual(close.data.subarray(8), concat(Buffer.from([1]), writeU64(5_000n)));
  assert.equal(close.keys.length, 6);

  const dep = buildDepositCollateral({ user: owner, market, userCollateral: uc, vault: liq, userAta: owner, collateralMint: market, amount: 10_000_000n });
  assert.deepEqual(dep.data.subarray(8), writeU64(10_000_000n));

  const wd = buildWithdrawCollateral({ user: owner, market, userCollateral: uc, vault: liq, userAta: owner, collateralMint: market, indexSource, amount: 8_000_000n });
  assert.deepEqual(wd.data.subarray(8), writeU64(8_000_000n));
  // Appendix order: user(S,w), market, user_collateral, vault, user_ata,
  // collateral_mint, index_source, position_long, position_short, token_program.
  assert.equal(wd.keys.length, 10);
  assert.equal(wd.keys[0].isSigner, true);
  assert.equal(wd.keys[0].isWritable, true);
  assert.equal(wd.keys[6].pubkey.toBase58(), indexSource.toBase58());
  assert.equal(wd.keys[7].isWritable, false); // position_long (readonly)
  assert.equal(wd.keys[8].isWritable, false); // position_short (readonly)
  assert.equal(wd.keys[9].pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());

  const sf = buildSettleFunding({ market, position: pos, userCollateral: uc, indexSource });
  assert.equal(sf.data.subarray(8).length, 0);
  assert.equal(sf.keys.length, 5);

  const sc = buildSettleClose({ market, position: pos, userCollateral: uc, indexSource });
  assert.equal(sc.data.subarray(8).length, 0);
  assert.equal(sc.keys.length, 4);

  const other = PublicKey.unique();
  const li = buildLiquidate({ market, position: pos, otherPosition: other, userCollateral: uc, indexSource, liquidator: liq, side: 1, amount: 3_000n });
  assert.deepEqual(li.data.subarray(8), concat(Buffer.from([1]), writeU64(3_000n)));
  // Appendix order: market, position, other_position, user_collateral,
  // order_book, index_source, liquidator(S), liquidator_collateral.
  assert.equal(li.keys.length, 8);
  assert.equal(li.keys[2].pubkey.toBase58(), other.toBase58());
  assert.equal(li.keys[2].isWritable, false);
  // liquidator is a signer but not writable; liquidator_collateral writable.
  const lkPos = li.keys.findIndex((k) => k.pubkey.toBase58() === liq.toBase58());
  assert.equal(lkPos, 6);
  assert.equal(li.keys[lkPos].isSigner, true);
  assert.equal(li.keys[6].isWritable, false);
  assert.equal(li.keys[7].isWritable, true);
});

test("buildResetPosition encodes side", () => {
  const ix = buildResetPosition({
    market: PublicKey.unique(),
    user: PublicKey.unique(),
    side: 1,
  });
  assert.deepEqual(ix.data.subarray(8), Buffer.from([1]));
});

// --- helpers ---
function writeU64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function concat(...bufs: Buffer[]): Buffer {
  return Buffer.concat(bufs);
}
