import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID } from "../src/constants.js";
import { anchorIxDiscriminator, writeU8, writeU64LE } from "../src/encoding.js";
import {
  marketPda,
  operatorPda,
  orderBookPda,
  positionPda,
  userCollateralPda,
  vaultPda,
} from "../src/pda.js";
import {
  buildOperatorBindInstructions,
  buildOperatorCancelOrder,
  buildOperatorClosePosition,
  buildOperatorDepositCollateral,
  buildOperatorOpenPosition,
  buildOperatorPlaceLimitOrder,
  buildOperatorPlaceMarketOrder,
  buildOperatorRevokeInstructions,
  buildOperatorWithdrawCollateral,
  buildSetOperator,
  TOKEN_PROGRAM_ID,
} from "../src/instructions.js";

// SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE (REQ-A1-7): every operator builder
// must emit the exact anchor discriminator, borsh argument bytes and account
// meta list (keys, order, signer/writable flags) the program's
// `#[derive(Accounts)]` structs declare — the PRD Appendix rows, transcribed
// literally below. The bind/revoke helpers additionally compose the
// wallet-signable [spl approve, set_operator] pair (D4).

// --- fixed vectors ----------------------------------------------------------

function fill(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}

const MARKET = marketPda().address; // canonical [PERP_MARKET_SEED] PDA
const USER = fill(0x11);
const OPERATOR = fill(0x22);
const INDEX_SOURCE = fill(0x33);
const COLLATERAL_MINT = fill(0x44);
const USER_ATA = fill(0x55);

const ORDER_BOOK = orderBookPda(MARKET).address;
const USER_COLLATERAL = userCollateralPda(MARKET, USER).address;
const OPERATOR_RECORD = operatorPda(MARKET, USER).address;
const VAULT = vaultPda().address;
const POSITION_LONG = positionPda(MARKET, USER, 0).address;
const POSITION_SHORT = positionPda(MARKET, USER, 1).address;

// --- surface assertion helpers ----------------------------------------------

interface ExpectedMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): ExpectedMeta {
  return { pubkey: pubkey.toBase58(), isSigner, isWritable };
}

function metasOf(ix: TransactionInstruction): ExpectedMeta[] {
  return ix.keys.map((k) => meta(k.pubkey, k.isSigner, k.isWritable));
}

/** Assert the full surface: program, discriminator, borsh args, account metas. */
function assertSurface(
  ix: TransactionInstruction,
  name: string,
  args: Buffer,
  expected: ExpectedMeta[],
): void {
  assert.equal(ix.programId.toBase58(), PROGRAM_ID.toBase58(), `${name}: program id`);
  assert.deepEqual(ix.data.subarray(0, 8), anchorIxDiscriminator(name), `${name}: anchor discriminator`);
  assert.deepEqual(ix.data.subarray(8), args, `${name}: borsh argument bytes`);
  assert.deepEqual(metasOf(ix), expected, `${name}: account metas (keys, order, signer/writable)`);
}

// The 4-account tail shared by `set_operator` (the bind/revoke helpers embed it).
const SET_OPERATOR_METAS = (record: PublicKey): ExpectedMeta[] => [
  meta(USER, true, true), // user (S, mut)
  meta(MARKET, false, false), // market
  meta(record, false, true), // operator_record (U, mut)
  meta(SystemProgram.programId, false, false), // system_program
];

// --- the 8 instructions ------------------------------------------------------

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares.", () => {
  const ix = buildSetOperator({ user: USER, market: MARKET, operator: OPERATOR });
  assertSurface(ix, "set_operator", OPERATOR.toBuffer(), SET_OPERATOR_METAS(OPERATOR_RECORD));
});

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares. operator_deposit_collateral — u64 LE amount + 10 accounts.", () => {
  const ix = buildOperatorDepositCollateral({
    operator: OPERATOR,
    user: USER,
    market: MARKET,
    userAta: USER_ATA,
    collateralMint: COLLATERAL_MINT,
    amount: 7_000_000n,
  });
  assertSurface(ix, "operator_deposit_collateral", writeU64LE(7_000_000n), [
    meta(OPERATOR, true, true), // operator (S, mut)
    meta(USER, false, false), // user (U)
    meta(MARKET, false, true), // market (mut — claim-payout writes pnl_pool)
    meta(USER_COLLATERAL, false, true), // user_collateral (U, mut)
    meta(OPERATOR_RECORD, false, false), // operator_record (U)
    meta(VAULT, false, true), // vault (U, mut)
    meta(USER_ATA, false, true), // user_ata (U, mut)
    meta(COLLATERAL_MINT, false, false), // collateral_mint
    meta(TOKEN_PROGRAM_ID, false, false), // token_program
    meta(SystemProgram.programId, false, false), // system_program
  ]);
});

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares. operator_withdraw_collateral — u64 LE amount + 12 accounts.", () => {
  const ix = buildOperatorWithdrawCollateral({
    operator: OPERATOR,
    user: USER,
    market: MARKET,
    indexSource: INDEX_SOURCE,
    userAta: USER_ATA,
    collateralMint: COLLATERAL_MINT,
    amount: 3_000_000n,
  });
  assertSurface(ix, "operator_withdraw_collateral", writeU64LE(3_000_000n), [
    meta(OPERATOR, true, false), // operator (S)
    meta(USER, false, false), // user (U)
    meta(MARKET, false, true), // market (mut — claim-payout writes pnl_pool)
    meta(USER_COLLATERAL, false, true), // user_collateral (Account, mut)
    meta(OPERATOR_RECORD, false, false), // operator_record (U)
    meta(VAULT, false, true), // vault (U, mut)
    meta(USER_ATA, false, true), // user_ata (U, mut)
    meta(COLLATERAL_MINT, false, false), // collateral_mint
    meta(INDEX_SOURCE, false, false), // index_source (address = market.index_source)
    meta(POSITION_LONG, false, false), // position_long
    meta(POSITION_SHORT, false, false), // position_short
    meta(TOKEN_PROGRAM_ID, false, false), // token_program
  ]);
});

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares. operator_open_position — side/size/price + 9 accounts (position PDA keyed by side).", () => {
  const ix = buildOperatorOpenPosition({
    operator: OPERATOR,
    user: USER,
    market: MARKET,
    indexSource: INDEX_SOURCE,
    side: 0,
    size: 1_000_000n,
    price: 1_050_000n,
  });
  assertSurface(
    ix,
    "operator_open_position",
    Buffer.concat([writeU8(0), writeU64LE(1_000_000n), writeU64LE(1_050_000n)]),
    [
      meta(OPERATOR, true, true), // operator (S, mut)
      meta(USER, false, false), // user (U)
      meta(MARKET, false, false), // market
      meta(ORDER_BOOK, false, true), // order_book (U, mut)
      meta(INDEX_SOURCE, false, false), // index_source (address = market.index_source)
      meta(POSITION_LONG, false, true), // position (U, mut) — seed [...user, side]
      meta(USER_COLLATERAL, false, true), // user_collateral (U, mut)
      meta(OPERATOR_RECORD, false, false), // operator_record (U)
      meta(SystemProgram.programId, false, false), // system_program
    ],
  );

  // The position PDA is seeded by the `side` byte: 1 selects the Short PDA.
  const shortIx = buildOperatorOpenPosition({
    operator: OPERATOR,
    user: USER,
    market: MARKET,
    indexSource: INDEX_SOURCE,
    side: 1,
    size: 2n,
    price: 3n,
  });
  assert.equal(shortIx.keys[5].pubkey.toBase58(), POSITION_SHORT.toBase58(), "side 1 => position_short PDA");
});

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares. operator_close_position — side/size + 8 accounts.", () => {
  const ix = buildOperatorClosePosition({
    operator: OPERATOR,
    user: USER,
    market: MARKET,
    indexSource: INDEX_SOURCE,
    side: 1,
    size: 500_000n,
  });
  assertSurface(ix, "operator_close_position", Buffer.concat([writeU8(1), writeU64LE(500_000n)]), [
    meta(OPERATOR, true, false), // operator (S)
    meta(USER, false, false), // user (U)
    meta(MARKET, false, false), // market
    meta(ORDER_BOOK, false, true), // order_book (U, mut)
    meta(INDEX_SOURCE, false, false), // index_source (address = market.index_source)
    meta(POSITION_SHORT, false, true), // position (U, mut)
    meta(USER_COLLATERAL, false, true), // user_collateral (U, mut)
    meta(OPERATOR_RECORD, false, false), // operator_record (U)
  ]);
});

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares. operator_place_limit_order — side/price/size + 6 accounts.", () => {
  const ix = buildOperatorPlaceLimitOrder({
    operator: OPERATOR,
    user: USER,
    market: MARKET,
    indexSource: INDEX_SOURCE,
    side: 0,
    price: 1_050_000n,
    size: 250_000n,
  });
  assertSurface(
    ix,
    "operator_place_limit_order",
    Buffer.concat([writeU8(0), writeU64LE(1_050_000n), writeU64LE(250_000n)]),
    [
      meta(OPERATOR, true, false), // operator (S)
      meta(USER, false, false), // user (U)
      meta(MARKET, false, false), // market
      meta(ORDER_BOOK, false, true), // order_book (U, mut)
      meta(INDEX_SOURCE, false, false), // index_source (address = market.index_source)
      meta(OPERATOR_RECORD, false, false), // operator_record (U)
    ],
  );
});

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares. operator_place_market_order — side/size + 6 accounts.", () => {
  const ix = buildOperatorPlaceMarketOrder({
    operator: OPERATOR,
    user: USER,
    market: MARKET,
    indexSource: INDEX_SOURCE,
    side: 1,
    size: 100_000n,
  });
  assertSurface(
    ix,
    "operator_place_market_order",
    Buffer.concat([writeU8(1), writeU64LE(100_000n)]),
    [
      meta(OPERATOR, true, false), // operator (S)
      meta(USER, false, false), // user (U)
      meta(MARKET, false, false), // market
      meta(ORDER_BOOK, false, true), // order_book (U, mut)
      meta(INDEX_SOURCE, false, false), // index_source (address = market.index_source)
      meta(OPERATOR_RECORD, false, false), // operator_record (U)
    ],
  );
});

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares. operator_cancel_order — seq + 5 accounts.", () => {
  const ix = buildOperatorCancelOrder({
    operator: OPERATOR,
    user: USER,
    market: MARKET,
    seq: 42n,
  });
  assertSurface(ix, "operator_cancel_order", writeU64LE(42n), [
    meta(OPERATOR, true, false), // operator (S)
    meta(USER, false, false), // user (U)
    meta(MARKET, false, false), // market
    meta(ORDER_BOOK, false, true), // order_book (U, mut)
    meta(OPERATOR_RECORD, false, false), // operator_record (U)
  ]);
});

// --- bind / revoke helpers (D4) ---------------------------------------------

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares. buildOperatorBindInstructions composes [spl approve(Operator PDA, amount), set_operator(operator)].", () => {
  // NOTE: the SPL `approve` source (the subject's token account) cannot be
  // derived from (user, market) alone, so the real bodies land together with a
  // `userAta: PublicKey` field on `OperatorBindParams` — the params object is
  // passed as a variable because that field is not on the stub interface yet.
  const params = {
    user: USER,
    market: MARKET,
    operator: OPERATOR,
    approveAmount: 12_345n,
    userAta: USER_ATA,
  };
  const ixs = buildOperatorBindInstructions(params);
  assert.equal(ixs.length, 2, "bind composes exactly [spl approve, set_operator]");

  const [approve, setOperator] = ixs;
  assert.equal(approve.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58(), "approve targets the SPL token program");
  assert.deepEqual(
    approve.data,
    Buffer.concat([Buffer.from([4]), writeU64LE(12_345n)]),
    "SPL Approve = tag 4 + u64 LE allowance",
  );
  assert.deepEqual(
    metasOf(approve),
    [
      meta(USER_ATA, false, true), // source (w)
      meta(OPERATOR_RECORD, false, false), // delegate = the Operator PDA (readonly)
      meta(USER, true, false), // owner (signer)
    ],
    "approve accounts [source(w), delegate(readonly), owner(signer)]",
  );

  assertSurface(setOperator, "set_operator", OPERATOR.toBuffer(), SET_OPERATOR_METAS(OPERATOR_RECORD));

  // Wallet-signable: the subject user is the only signer across the pair.
  const signers = [...approve.keys, ...setOperator.keys].filter((k) => k.isSigner);
  assert.equal(signers.length, 2, "one signer per instruction");
  for (const k of signers) {
    assert.equal(k.pubkey.toBase58(), USER.toBase58(), "only the subject user signs the bind");
  }
});

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares. buildOperatorBindInstructions defaults the allowance to u64::MAX (D4).", () => {
  const params = { user: USER, market: MARKET, operator: OPERATOR, userAta: USER_ATA };
  const ixs = buildOperatorBindInstructions(params);
  assert.equal(ixs.length, 2, "bind composes exactly [spl approve, set_operator]");
  const [approve] = ixs;
  assert.deepEqual(
    approve.data,
    Buffer.concat([Buffer.from([4]), writeU64LE(0xffffffffffffffffn)]),
    "the one-time bind approval is u64::MAX",
  );
});

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares. buildOperatorRevokeInstructions composes [spl approve(Operator PDA, 0), set_operator(default)].", () => {
  const params = { user: USER, market: MARKET, userAta: USER_ATA };
  const ixs = buildOperatorRevokeInstructions(params);
  assert.equal(ixs.length, 2, "revoke composes exactly [spl approve(0), set_operator(default)]");

  const [approve, setOperator] = ixs;
  assert.equal(approve.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58(), "approve targets the SPL token program");
  assert.deepEqual(
    approve.data,
    Buffer.concat([Buffer.from([4]), writeU64LE(0n)]),
    "revoke clears the SPL allowance",
  );
  assert.deepEqual(
    metasOf(approve),
    [
      meta(USER_ATA, false, true), // source (w)
      meta(OPERATOR_RECORD, false, false), // delegate = the Operator PDA (readonly)
      meta(USER, true, false), // owner (signer)
    ],
    "approve accounts [source(w), delegate(readonly), owner(signer)]",
  );

  // set_operator(Pubkey::default()) — the revoke state; the record is kept (D3).
  assertSurface(setOperator, "set_operator", Buffer.alloc(32), SET_OPERATOR_METAS(OPERATOR_RECORD));
});

// --- explicit PDA overrides --------------------------------------------------

test("SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares. explicit PDA overrides take precedence over derivation.", () => {
  const record = fill(0x66);
  const position = fill(0x67);
  const collateral = fill(0x68);
  const book = fill(0x69);
  const explicitVault = fill(0x6a);

  const so = buildSetOperator({ user: USER, market: MARKET, operator: OPERATOR, operatorRecord: record });
  assert.equal(so.keys.length, 4, "set_operator: 4 accounts");
  assert.equal(so.keys[2].pubkey.toBase58(), record.toBase58(), "set_operator uses operatorRecord");

  const dep = buildOperatorDepositCollateral({
    operator: OPERATOR,
    user: USER,
    market: MARKET,
    userCollateral: collateral,
    operatorRecord: record,
    vault: explicitVault,
    userAta: USER_ATA,
    collateralMint: COLLATERAL_MINT,
    amount: 1n,
  });
  assert.equal(dep.keys.length, 10, "operator_deposit_collateral: 10 accounts");
  assert.equal(dep.keys[3].pubkey.toBase58(), collateral.toBase58(), "deposit uses userCollateral");
  assert.equal(dep.keys[4].pubkey.toBase58(), record.toBase58(), "deposit uses operatorRecord");
  assert.equal(dep.keys[5].pubkey.toBase58(), explicitVault.toBase58(), "deposit uses vault");

  const open = buildOperatorOpenPosition({
    operator: OPERATOR,
    user: USER,
    market: MARKET,
    orderBook: book,
    indexSource: INDEX_SOURCE,
    position,
    userCollateral: collateral,
    side: 1,
    size: 1n,
    price: 1n,
  });
  assert.equal(open.keys.length, 9, "operator_open_position: 9 accounts");
  assert.equal(open.keys[3].pubkey.toBase58(), book.toBase58(), "open uses orderBook");
  assert.equal(open.keys[5].pubkey.toBase58(), position.toBase58(), "open uses position");
  assert.equal(open.keys[6].pubkey.toBase58(), collateral.toBase58(), "open uses userCollateral");
});
