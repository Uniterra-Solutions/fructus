//! Instruction builders + submit helpers for the full Fructus instruction set
//! (R-SDK1). Mirrors the program's `#[program]` functions and `#[derive(Accounts)]`
//! structs in `programs/fructus/src/lib.rs`, without the Anchor TS client.
//!
//! Every builder returns a `TransactionInstruction`. PDA accounts are derived
//! automatically from `programId` (an explicit address may be passed to override
//! in tests). Data is borsh-encoded (discriminator + little-endian args), exactly
//! as the on-chain `Context<...>` decoding expects.

import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { PROGRAM_ID } from "./constants.js";
import { anchorIxDiscriminator, writePubkey, writeU16LE, writeU64LE, writeU8 } from "./encoding.js";
import { marketPda, orderBookPda, oraclePda, positionPda, userCollateralPda, vaultPda } from "./pda.js";

// --- SPL token program ids (anchor `tokenc::Token` / `associated_token` deps) ---
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** Build a `TransactionInstruction` with a borsh data payload. */
function ix(
  programId: PublicKey,
  name: string,
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
  dataArgs: Buffer[],
): TransactionInstruction {
  return new TransactionInstruction({
    keys,
    programId,
    data: Buffer.concat([anchorIxDiscriminator(name), ...dataArgs]),
  });
}

// --- Submitting -----------------------------------------------------------

/** Sign + submit a `Transaction` and return its signature. */
export async function submitTransaction(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = tx.feePayer ?? signers[0]?.publicKey;
  tx.sign(...signers);
  return await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
}

/**
 * Build a `Transaction` from one instruction, set a fee payer, and sign+submit.
 * Returns the transaction signature.
 */
export async function submitInstruction(
  connection: Connection,
  instruction: TransactionInstruction,
  signers: Keypair[],
  feePayer?: PublicKey,
): Promise<string> {
  const tx = new Transaction().add(instruction);
  tx.feePayer = feePayer ?? signers[0]?.publicKey;
  return submitTransaction(connection, tx, signers);
}

// --- Oracle + market init -------------------------------------------------

export interface InitializeParams {
  oracle?: PublicKey;
  authority: PublicKey;
  publisher: PublicKey;
  staleAfterSlots: bigint;
  initialApy: bigint;
  programId?: PublicKey;
}

export function buildInitialize(p: InitializeParams): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "initialize", [
    { pubkey: p.oracle ?? oraclePda(p.programId ?? PROGRAM_ID).address, isSigner: false, isWritable: true },
    { pubkey: p.authority, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], [writePubkey(p.publisher), writeU64LE(p.staleAfterSlots), writeU64LE(p.initialApy)]);
}

export interface InitializeMarketParams {
  indexSource: PublicKey;
  authority: PublicKey;
  payer: PublicKey;
  collateralMint: PublicKey;
  fundingK: bigint;
  maxFunding: bigint;
  fundingEpochSlots: bigint;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  programId?: PublicKey;
}

export function buildInitializeMarket(p: InitializeMarketParams): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "initialize_market", [
    { pubkey: marketPda(programId).address, isSigner: false, isWritable: true },
    { pubkey: p.indexSource, isSigner: false, isWritable: false },
    { pubkey: p.authority, isSigner: true, isWritable: false },
    { pubkey: p.payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], [
    writePubkey(p.collateralMint),
    writeU64LE(p.fundingK),
    writeU64LE(p.maxFunding),
    writeU64LE(p.fundingEpochSlots),
    writeU16LE(p.initialMarginBps),
    writeU16LE(p.maintenanceMarginBps),
  ]);
}

export interface UpdateApyParams {
  oracle: PublicKey;
  apy: bigint;
  version: bigint;
  programId?: PublicKey;
}

export function buildUpdateApy(p: UpdateApyParams): TransactionInstruction {
  return ix(p.programId ?? PROGRAM_ID, "update_apy", [
    { pubkey: p.oracle, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ], [writeU64LE(p.apy), writeU64LE(p.version)]);
}

export interface AdminParams {
  oracle?: PublicKey;
  authority: PublicKey;
  programId?: PublicKey;
}

export function buildSetStaleWindow(p: AdminParams & { newStaleAfterSlots: bigint }): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "set_stale_window", [
    { pubkey: p.oracle ?? oraclePda(programId).address, isSigner: false, isWritable: true },
    { pubkey: p.authority, isSigner: true, isWritable: false },
  ], [writeU64LE(p.newStaleAfterSlots)]);
}

export function buildSetPublisher(p: AdminParams & { newPublisher: PublicKey }): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "set_publisher", [
    { pubkey: p.oracle ?? oraclePda(programId).address, isSigner: false, isWritable: true },
    { pubkey: p.authority, isSigner: true, isWritable: false },
  ], [writePubkey(p.newPublisher)]);
}

export function buildReadExchangeRate(p: { stakePool: PublicKey; programId?: PublicKey }): TransactionInstruction {
  return ix(p.programId ?? PROGRAM_ID, "read_exchange_rate", [
    { pubkey: p.stakePool, isSigner: false, isWritable: false },
  ], []);
}

export function buildInitializeOrderBook(p: {
  market: PublicKey;
  orderBook?: PublicKey;
  authority: PublicKey;
  payer: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "initialize_order_book", [
    { pubkey: p.orderBook ?? orderBookPda(p.market, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.market, isSigner: false, isWritable: false },
    { pubkey: p.authority, isSigner: true, isWritable: false },
    { pubkey: p.payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], []);
}

export function buildInitializeCollateralVault(p: {
  market: PublicKey;
  vault?: PublicKey;
  authority: PublicKey;
  payer: PublicKey;
  collateralMint: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "initialize_collateral_vault", [
    { pubkey: p.market, isSigner: false, isWritable: false },
    { pubkey: p.authority, isSigner: true, isWritable: false },
    { pubkey: p.payer, isSigner: true, isWritable: true },
    { pubkey: p.vault ?? vaultPda(programId).address, isSigner: false, isWritable: true },
    { pubkey: p.collateralMint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ], []);
}

// --- Collateral -----------------------------------------------------------

export interface CollateralParams {
  user: PublicKey;
  market: PublicKey;
  userCollateral?: PublicKey;
  vault?: PublicKey;
  userAta: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
  programId?: PublicKey;
}

/**
 * `withdraw_collateral` params (REQ-A2-3/D9): the account set gained the index
 * source plus both side positions (the equity gate reads `Σ upnl`); the
 * long/short positions are derived from `(market, user)`.
 */
export interface WithdrawCollateralParams extends CollateralParams {
  /** The index source (stake pool) account; address-checked against the market. */
  indexSource: PublicKey;
}

export function buildDepositCollateral(p: CollateralParams): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "deposit_collateral", [
    { pubkey: p.user, isSigner: true, isWritable: true },
    { pubkey: p.market, isSigner: false, isWritable: true },
    { pubkey: p.userCollateral ?? userCollateralPda(p.market, p.user, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.vault ?? vaultPda(programId).address, isSigner: false, isWritable: true },
    { pubkey: p.userAta, isSigner: false, isWritable: true },
    { pubkey: p.collateralMint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ], [writeU64LE(p.amount)]);
}

export function buildWithdrawCollateral(p: WithdrawCollateralParams): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "withdraw_collateral", [
    { pubkey: p.user, isSigner: true, isWritable: true },
    { pubkey: p.market, isSigner: false, isWritable: true },
    { pubkey: p.userCollateral ?? userCollateralPda(p.market, p.user, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.vault ?? vaultPda(programId).address, isSigner: false, isWritable: true },
    { pubkey: p.userAta, isSigner: false, isWritable: true },
    { pubkey: p.collateralMint, isSigner: false, isWritable: false },
    { pubkey: p.indexSource, isSigner: false, isWritable: false },
    { pubkey: positionPda(p.market, p.user, 0, programId).address, isSigner: false, isWritable: false },
    { pubkey: positionPda(p.market, p.user, 1, programId).address, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ], [writeU64LE(p.amount)]);
}

// --- CLOB / orders --------------------------------------------------------

export interface OrderParams {
  orderBook?: PublicKey;
  market: PublicKey;
  indexSource: PublicKey;
  owner: PublicKey;
  side: number;
  programId?: PublicKey;
}

export function buildPlaceLimitOrder(p: OrderParams & { price: bigint; size: bigint }): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "place_limit_order", [
    { pubkey: p.orderBook ?? orderBookPda(p.market, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.market, isSigner: false, isWritable: false },
    { pubkey: p.indexSource, isSigner: false, isWritable: false },
    { pubkey: p.owner, isSigner: true, isWritable: false },
  ], [writeU8(p.side), writeU64LE(p.price), writeU64LE(p.size)]);
}

export function buildPlaceMarketOrder(p: OrderParams & { size: bigint }): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "place_market_order", [
    { pubkey: p.orderBook ?? orderBookPda(p.market, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.market, isSigner: false, isWritable: false },
    { pubkey: p.indexSource, isSigner: false, isWritable: false },
    { pubkey: p.owner, isSigner: true, isWritable: false },
  ], [writeU8(p.side), writeU64LE(p.size)]);
}

export function buildCancelOrder(p: {
  orderBook?: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  seq: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "cancel_order", [
    { pubkey: p.orderBook ?? orderBookPda(p.market, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.market, isSigner: false, isWritable: false },
    { pubkey: p.owner, isSigner: true, isWritable: false },
  ], [writeU64LE(p.seq)]);
}

export function buildCrank(p: {
  orderBook?: PublicKey;
  market: PublicKey;
  indexSource: PublicKey;
  cranker: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "crank", [
    { pubkey: p.orderBook ?? orderBookPda(p.market, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.market, isSigner: false, isWritable: false },
    { pubkey: p.indexSource, isSigner: false, isWritable: false },
    { pubkey: p.cranker, isSigner: true, isWritable: false },
  ], []);
}

// --- Position lifecycle ---------------------------------------------------

export function buildOpenPosition(p: {
  owner: PublicKey;
  market: PublicKey;
  orderBook?: PublicKey;
  indexSource: PublicKey;
  position?: PublicKey;
  userCollateral?: PublicKey;
  side: number;
  size: bigint;
  price: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "open_position", [
    { pubkey: p.owner, isSigner: true, isWritable: true },
    { pubkey: p.market, isSigner: false, isWritable: false },
    { pubkey: p.orderBook ?? orderBookPda(p.market, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.indexSource, isSigner: false, isWritable: false },
    { pubkey: p.position ?? positionPda(p.market, p.owner, p.side, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.userCollateral ?? userCollateralPda(p.market, p.owner, programId).address, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], [writeU8(p.side), writeU64LE(p.size), writeU64LE(p.price)]);
}

export function buildClosePosition(p: {
  owner: PublicKey;
  market: PublicKey;
  orderBook?: PublicKey;
  indexSource: PublicKey;
  position?: PublicKey;
  userCollateral?: PublicKey;
  side: number;
  size: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "close_position", [
    { pubkey: p.owner, isSigner: true, isWritable: false },
    { pubkey: p.market, isSigner: false, isWritable: false },
    { pubkey: p.orderBook ?? orderBookPda(p.market, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.indexSource, isSigner: false, isWritable: false },
    { pubkey: p.position ?? positionPda(p.market, p.owner, p.side, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.userCollateral ?? userCollateralPda(p.market, p.owner, programId).address, isSigner: false, isWritable: true },
  ], [writeU8(p.side), writeU64LE(p.size)]);
}

export function buildSettleFill(p: {
  market: PublicKey;
  orderBook?: PublicKey;
  position: PublicKey;
  userCollateral: PublicKey;
  payer: PublicKey;
  seq: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "settle_fill", [
    { pubkey: p.market, isSigner: false, isWritable: false },
    { pubkey: p.orderBook ?? orderBookPda(p.market, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.position, isSigner: false, isWritable: true },
    { pubkey: p.userCollateral, isSigner: false, isWritable: true },
    { pubkey: p.payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], [writeU64LE(p.seq)]);
}

export function buildResetPosition(p: {
  market: PublicKey;
  position?: PublicKey;
  user: PublicKey;
  side: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "reset_position", [
    { pubkey: p.market, isSigner: false, isWritable: false },
    { pubkey: p.position ?? positionPda(p.market, p.user, p.side, programId).address, isSigner: false, isWritable: true },
    { pubkey: p.user, isSigner: true, isWritable: false },
  ], [writeU8(p.side)]);
}

export function buildSettleClose(p: {
  market: PublicKey;
  position: PublicKey;
  userCollateral: PublicKey;
  indexSource: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  return ix(p.programId ?? PROGRAM_ID, "settle_close", [
    { pubkey: p.market, isSigner: false, isWritable: true },
    { pubkey: p.position, isSigner: false, isWritable: true },
    { pubkey: p.userCollateral, isSigner: false, isWritable: true },
    { pubkey: p.indexSource, isSigner: false, isWritable: false },
  ], []);
}

export function buildSettleFunding(p: {
  market: PublicKey;
  position: PublicKey;
  userCollateral: PublicKey;
  orderBook?: PublicKey;
  indexSource: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "settle_funding", [
    { pubkey: p.market, isSigner: false, isWritable: true },
    { pubkey: p.position, isSigner: false, isWritable: true },
    { pubkey: p.userCollateral, isSigner: false, isWritable: true },
    { pubkey: p.orderBook ?? orderBookPda(p.market, programId).address, isSigner: false, isWritable: false },
    { pubkey: p.indexSource, isSigner: false, isWritable: false },
  ], []);
}

/**
 * `liquidate` params (REQ-A2-2/D8): account-level liquidation takes both sides'
 * positions (`position` = targeted side, `otherPosition` = the opposite
 * Position PDA, pristine/missing ⇒ zero contribution) and the targeted
 * `side` byte.
 */
export function buildLiquidate(p: {
  market: PublicKey;
  position: PublicKey;
  /** The opposite side's Position PDA (pristine/missing ⇒ zero contribution). */
  otherPosition: PublicKey;
  userCollateral: PublicKey;
  orderBook?: PublicKey;
  indexSource: PublicKey;
  liquidator: PublicKey;
  liquidatorCollateral?: PublicKey;
  /** The targeted side byte (`0` = Long, `1` = Short). */
  side: number;
  amount: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "liquidate", [
    { pubkey: p.market, isSigner: false, isWritable: true },
    { pubkey: p.position, isSigner: false, isWritable: true },
    { pubkey: p.otherPosition, isSigner: false, isWritable: false },
    { pubkey: p.userCollateral, isSigner: false, isWritable: true },
    { pubkey: p.orderBook ?? orderBookPda(p.market, programId).address, isSigner: false, isWritable: false },
    { pubkey: p.indexSource, isSigner: false, isWritable: false },
    { pubkey: p.liquidator, isSigner: true, isWritable: false },
    { pubkey: p.liquidatorCollateral ?? userCollateralPda(p.market, p.liquidator, programId).address, isSigner: false, isWritable: true },
  ], [writeU8(p.side), writeU64LE(p.amount)]);
}

// --- Operator delegation (A1) — STUBS ---------------------------------------
//
// REQ-A1-7: the operator surface is additive — `set_operator` + 7 `operator_*`
// instructions (D2) plus the wallet-signable bind/revoke helpers (D4). These
// builders land with their real signatures now; the account metas and argument
// encodings land together with the operator red tests, so every body below is
// a deliberate STUB (`ix(programId, "<name>", [], [])`: discriminator only,
// no accounts, no args).

export interface SetOperatorParams {
  /** The subject user; the only signer, and the payer of a lazily-created record. */
  user: PublicKey;
  market: PublicKey;
  /** The delegate key to store; `PublicKey.default()` is the revoke state. */
  operator: PublicKey;
  /** Override the record PDA (default: derived `[OPERATOR_SEED, market, user]`). */
  operatorRecord?: PublicKey;
  programId?: PublicKey;
}

/** STUB: emit `set_operator(operator: Pubkey)`. */
export function buildSetOperator(p: SetOperatorParams): TransactionInstruction {
  // STUB: accounts [user(S,mut), market, operator_record(mut), system_program]
  // + the `operator` pubkey arg land with SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE.
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "set_operator", [], []);
}

export interface OperatorDepositCollateralParams {
  /** The delegate; the only signer. Must equal `operator_record.operator`. */
  operator: PublicKey;
  /** The subject user; keys the ledger PDA and receives the credit. */
  user: PublicKey;
  market: PublicKey;
  userCollateral?: PublicKey;
  operatorRecord?: PublicKey;
  vault?: PublicKey;
  /** The subject's own ATA (validated in-handler against mint + owner). */
  userAta: PublicKey;
  collateralMint: PublicKey;
  amount: bigint;
  programId?: PublicKey;
}

/** STUB: emit `operator_deposit_collateral(amount: u64)`. */
export function buildOperatorDepositCollateral(
  p: OperatorDepositCollateralParams,
): TransactionInstruction {
  // STUB: the 10-account list (operator S+mut first, … system_program) +
  // `amount` land with SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE.
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "operator_deposit_collateral", [], []);
}

export interface OperatorWithdrawCollateralParams {
  operator: PublicKey;
  user: PublicKey;
  market: PublicKey;
  userCollateral?: PublicKey;
  operatorRecord?: PublicKey;
  vault?: PublicKey;
  /** The subject's own ATA; withdrawal can only ever land here (D5). */
  userAta: PublicKey;
  collateralMint: PublicKey;
  /** The index source (stake pool) account; the equity gate reads `Σ upnl`. */
  indexSource: PublicKey;
  amount: bigint;
  programId?: PublicKey;
}

/** STUB: emit `operator_withdraw_collateral(amount: u64)`. */
export function buildOperatorWithdrawCollateral(
  p: OperatorWithdrawCollateralParams,
): TransactionInstruction {
  // STUB: the 12-account list + `amount` land with
  // SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE.
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "operator_withdraw_collateral", [], []);
}

export interface OperatorOpenPositionParams {
  operator: PublicKey;
  user: PublicKey;
  market: PublicKey;
  orderBook?: PublicKey;
  indexSource: PublicKey;
  position?: PublicKey;
  userCollateral?: PublicKey;
  side: number;
  size: bigint;
  price: bigint;
  programId?: PublicKey;
}

/** STUB: emit `operator_open_position(side: u8, size: u64, price: u64)`. */
export function buildOperatorOpenPosition(
  p: OperatorOpenPositionParams,
): TransactionInstruction {
  // STUB: the account list + `side/size/price` land with
  // SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE.
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "operator_open_position", [], []);
}

export interface OperatorClosePositionParams {
  operator: PublicKey;
  user: PublicKey;
  market: PublicKey;
  orderBook?: PublicKey;
  indexSource: PublicKey;
  position?: PublicKey;
  userCollateral?: PublicKey;
  side: number;
  size: bigint;
  programId?: PublicKey;
}

/** STUB: emit `operator_close_position(side: u8, size: u64)`. */
export function buildOperatorClosePosition(
  p: OperatorClosePositionParams,
): TransactionInstruction {
  // STUB: the account list + `side/size` land with
  // SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE.
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "operator_close_position", [], []);
}

export interface OperatorPlaceLimitOrderParams {
  operator: PublicKey;
  user: PublicKey;
  market: PublicKey;
  orderBook?: PublicKey;
  indexSource: PublicKey;
  side: number;
  price: bigint;
  size: bigint;
  programId?: PublicKey;
}

/** STUB: emit `operator_place_limit_order(side: u8, price: u64, size: u64)`. */
export function buildOperatorPlaceLimitOrder(
  p: OperatorPlaceLimitOrderParams,
): TransactionInstruction {
  // STUB: the account list + `side/price/size` land with
  // SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE.
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "operator_place_limit_order", [], []);
}

export interface OperatorPlaceMarketOrderParams {
  operator: PublicKey;
  user: PublicKey;
  market: PublicKey;
  orderBook?: PublicKey;
  indexSource: PublicKey;
  side: number;
  size: bigint;
  programId?: PublicKey;
}

/** STUB: emit `operator_place_market_order(side: u8, size: u64)`. */
export function buildOperatorPlaceMarketOrder(
  p: OperatorPlaceMarketOrderParams,
): TransactionInstruction {
  // STUB: the account list + `side/size` land with
  // SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE.
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "operator_place_market_order", [], []);
}

export interface OperatorCancelOrderParams {
  operator: PublicKey;
  user: PublicKey;
  market: PublicKey;
  orderBook?: PublicKey;
  seq: bigint;
  programId?: PublicKey;
}

/** STUB: emit `operator_cancel_order(seq: u64)`. */
export function buildOperatorCancelOrder(
  p: OperatorCancelOrderParams,
): TransactionInstruction {
  // STUB: the account list + `seq` land with
  // SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE.
  const programId = p.programId ?? PROGRAM_ID;
  return ix(programId, "operator_cancel_order", [], []);
}

export interface OperatorBindParams {
  user: PublicKey;
  market: PublicKey;
  /** The delegate key to bind (also the SPL delegate; the Operator PDA holds it). */
  operator: PublicKey;
  /** SPL delegate allowance in raw units; the D4 flow uses `u64::MAX`. */
  approveAmount?: bigint;
  operatorRecord?: PublicKey;
  programId?: PublicKey;
}

/**
 * STUB: build the wallet-signable bind transaction —
 * `[spl approve(Operator PDA, u64::MAX), set_operator(operator)]` (D4), signed
 * once by the user.
 */
export function buildOperatorBindInstructions(p: OperatorBindParams): TransactionInstruction[] {
  // STUB: the composed [approve, set_operator] pair lands with
  // SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE (bind/revoke helper composition).
  return [];
}

export interface OperatorRevokeParams {
  user: PublicKey;
  market: PublicKey;
  operatorRecord?: PublicKey;
  programId?: PublicKey;
}

/**
 * STUB: build the wallet-signable revoke transaction —
 * `[spl approve(Operator PDA, 0), set_operator(Pubkey::default())]`, record kept
 * (D3: revoke clears the field; no account close).
 */
export function buildOperatorRevokeInstructions(p: OperatorRevokeParams): TransactionInstruction[] {
  // STUB: the composed [approve(0), set_operator(default)] pair lands with
  // SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE.
  return [];
}

export { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };
