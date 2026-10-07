//! Protocol-wide constants and PDA seeds, mirroring the on-chain
//! `programs/fructus/src/constants.rs` + `exchange.rs`. These are the exact
//! values the trader SDK math (funding / PnL / index) and account layouts are
//! pinned against in the cross-language vector tests.

import { PublicKey } from "@solana/web3.js";

/** Fixed-point scaling for a stored APY/index level: `1.0 == APY_SCALE`. */
export const APY_SCALE = 1_000_000n;

/** Sanity ceiling for a single APY value (100% == APY_SCALE). */
export const MAX_APY = APY_SCALE;

/** Slots per Solana year (canonical 0.4 s slot time): `(365.25*24*60*60)/0.4`. */
export const SLOTS_PER_YEAR = 78_840_000n;

/** Liquidation penalty, in basis points (5% of the released collateral). */
export const LIQUIDATION_PENALTY_BPS = 500;

/** Liquidation TWAP reference window, in slots (reuses the observation ring). */
export const LIQUIDATION_TWAP_WINDOW = 16n;

/** Number of resting orders per side of the on-chain order book.
 *
 * Sized so the zero-copy `OrderBook` account fits the SBF runtime's
 * per-transaction data-growth cap (`MAX_PERMITTED_DATA_INCREASE = 10 KiB`):
 * `8 + OrderBook::LEN = 6_240` bytes with `16` orders/side + `32` events. */
export const MAX_ORDERS_PER_SIDE = 16;

/** Length of the bounded on-chain event-queue ring. */
export const EVENT_QUEUE_LEN = 32;

/** Number of entries in the TWAP observation ring. */
export const TWAP_OBSERVATIONS = 16;

/** Decimals of the USDC collateral mint (validated at vault initialization). */
export const USDC_DECIMALS = 6;

/** Funding convergence-speed bounds (fixed-point scaled by APY_SCALE). */
export const FUNDING_K_MIN = 1n;
export const FUNDING_K_MAX = APY_SCALE;

/** Per-epoch funding-rate cap bound (fixed-point scaled by APY_SCALE). */
export const MAX_FUNDING_MAX = APY_SCALE;

/** Upper bound for margin ratios, expressed in basis points. */
export const MAX_MARGIN_BPS = 10_000;

// --- PDA seeds (mirror `constants.rs`) -------------------------------------

/** PDA seed for the singleton yield oracle account. */
export const ORACLE_SEED = Buffer.from("yield_oracle", "utf8");

/** PDA seed for the singleton perpetual market account. */
export const PERP_MARKET_SEED = Buffer.from("perp_market", "utf8");

/** PDA seed for the collateral-vault token account. */
export const VAULT_SEED = Buffer.from("vault", "utf8");

/** PDA seed for the order-book account (one per market). */
export const ORDER_BOOK_SEED = Buffer.from("order_book", "utf8");

/** PDA seed for the per-`(market, user)` collateral-ledger account. */
export const USER_COLLATERAL_SEED = Buffer.from("user_collateral", "utf8");

/** PDA seed for the per-`(market, user, side)` position account. */
export const POSITION_SEED = Buffer.from("position", "utf8");

/** PDA seed for the per-`(market, user)` operator-delegation record (D3). */
export const OPERATOR_SEED = Buffer.from("operator", "utf8");

/** On-chain program id (`declare_id!` in `programs/fructus/src/lib.rs`). */
export const PROGRAM_ID = new PublicKey("3EsUd5XQ6KChedwL2ho8pv3zrrGGFvMpJEV1PnzN8MD1");

/** Canonical SPL Stake Pool program id (`SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy`). */
export const STAKE_POOL_PROGRAM_ID = new PublicKey(
  new Uint8Array([
    6, 129, 78, 212, 202, 246, 138, 23, 70, 114, 253, 172, 134, 3, 26, 99, 232, 78, 161, 94,
    250, 29, 68, 183, 34, 147, 246, 219, 219, 0, 22, 80,
  ]),
);

// --- Book-side encoding (mirrors `lib.rs` `SIDE_BID` / `SIDE_ASK`) ----------

/** `Position.side` / order `side` byte value for a Long/Bid. */
export const SIDE_BID: number = 0;
/** `Position.side` / order `side` byte value for a Short/Ask. */
export const SIDE_ASK: number = 1;
