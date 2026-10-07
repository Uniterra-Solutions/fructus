//! Protocol-wide constants for the yield oracle data module.

/// Fixed-point scaling for the stored APY value: `1.0 == APY_SCALE`.
pub const APY_SCALE: u64 = 1_000_000;

/// Sanity ceiling for a single APY value (100% == `APY_SCALE`).
pub const MAX_APY: u64 = APY_SCALE;

/// Domain-separator prefix for update signatures.
pub const UPDATE_DOMAIN_SEPARATOR: &[u8] = b"fructus::update_apy";

/// PDA seed for the singleton yield oracle account.
pub const ORACLE_SEED: &[u8] = b"yield_oracle";

/// PDA seed for the singleton perpetual market account.
pub const PERP_MARKET_SEED: &[u8] = b"perp_market";

/// PDA seed for the collateral-vault account (derived, not created at init).
pub const VAULT_SEED: &[u8] = b"vault";

/// Lower bound (inclusive) for the funding convergence-speed parameter `funding_k`.
pub const FUNDING_K_MIN: u64 = 1;

/// Upper bound (inclusive) for `funding_k`, fixed-point scaled by `APY_SCALE`.
pub const FUNDING_K_MAX: u64 = APY_SCALE;

/// Upper bound (inclusive) for the per-epoch funding-rate cap `max_funding`.
pub const MAX_FUNDING_MAX: u64 = APY_SCALE;

/// Upper bound (inclusive) for margin ratios, expressed in basis points.
pub const MAX_MARGIN_BPS: u16 = 10_000;

/// Slots per Solana year (at the canonical 0.4 s slot time).
///
/// `(365.25 × 24 × 60 × 60) / 0.4 = 78_840_000`. Used by `settle_funding` to
/// annualize a realized yield spanning a measured number of slots
/// (`exchange::annualize(.., SLOTS_PER_YEAR)`).
pub const SLOTS_PER_YEAR: u64 = 78_840_000;

/// Liquidation penalty, in basis points (5% of the released collateral).
///
/// Paid to the liquidator out of the position's collateral (R-L3); wired by the
/// `liquidate` handler as the `penalty_bps` of
/// [`crate::liquidation::apply_liquidation`].
pub const LIQUIDATION_PENALTY_BPS: u16 = 500;

/// Liquidation TWAP reference window, in slots.
///
/// Reuses the `TWAP_OBSERVATIONS` ring value (16) as the on-chain window the
/// `liquidate` handler reads the order-book TWAP against; a book that does not
/// reach back a full window yields no reference price and the liquidation is
/// refused (R-L1/R-L4 window/staleness guard).
pub const LIQUIDATION_TWAP_WINDOW: u64 = 16;

// --- Order book + collateral vault (issues #3 & #4) ---

/// PDA seed for the order-book account (one per market, bound by the market key).
pub const ORDER_BOOK_SEED: &[u8] = b"order_book";

/// PDA seed for the per-`(market, user)` collateral-ledger account.
pub const USER_COLLATERAL_SEED: &[u8] = b"user_collateral";

/// Maximum number of resting orders per side of the order book.
///
/// Drives the inline `[Order; MAX_ORDERS_PER_SIDE]` arrays in `OrderBook`, so it
/// is a `usize` (used directly as an array length and compared with `Vec::len`).
///
/// Sized so the whole zero-copy `OrderBook` account stays under the runtime's
/// per-transaction account-growth cap (`MAX_PERMITTED_DATA_INCREASE = 10 KiB`):
/// `8 + OrderBook::LEN = 6_240` bytes with `16` orders/side + `32` events. Any
/// larger and the on-chain `initialize_order_book` inner-CPI allocation fails
/// with `InvalidRealloc` (see docs/modules/order-book.md).
pub const MAX_ORDERS_PER_SIDE: usize = 16;

/// Maximum number of distinct price levels per side (FR-2(a) / REQ-4).
///
/// This iteration collapses price-level capacity into per-order capacity: every
/// resting order may occupy its own level, so the level bound equals the order
/// bound. It is kept as a named constant so the FR-2(a) capacity contract is
/// explicit rather than dropped (see docs/modules/order-book.md).
pub const MAX_PRICE_LEVELS_PER_SIDE: usize = MAX_ORDERS_PER_SIDE;

/// Length of the bounded on-chain event-queue ring (fills/cancels/residuals).
///
/// Sized with [`MAX_ORDERS_PER_SIDE`] so the `OrderBook` account fits the 10 KiB
/// per-transaction data-growth cap (see the constant's doc comment).
pub const EVENT_QUEUE_LEN: usize = 32;

/// Number of entries in the TWAP observation ring.
///
/// Each entry is 32 bytes (an 8-byte slot, an 8-byte mid, and a 16-byte `u128`
/// accumulator), so
/// raising this is cheap; issue #8 fixes the actual liquidation window and may
/// widen the ring then (design OQ-4).
pub const TWAP_OBSERVATIONS: usize = 16;

/// Bounded per-transaction matching budget (the compute "batch").
///
/// `match_order` stops after this many fills and defers any still-crossable
/// remainder as a `Residual` event for the permissionless `crank` to resume
/// (design D6/D7). Chosen `8`: each step rewrites one array slot plus
/// `best_bid`/`best_ask` and appends an event + a TWAP observation, so 8 fills
/// stay comfortably inside the default 200k CU budget while a worst-case full
/// book (16 makers) is drained in at most 2 cranks.
pub const MAX_MATCH_STEPS: u64 = 8;

/// Decimals of the USDC collateral mint (validated at vault initialization).
pub const USDC_DECIMALS: u8 = 6;

// --- Position lifecycle (issue #5) ---

/// PDA seed for the per-`(market, user, side)` position account.
pub const POSITION_SEED: &[u8] = b"position";

// --- Operator delegation (product-v2 A1) ---

/// PDA seed for the per-`(market, user)` operator-delegation record.
pub const OPERATOR_SEED: &[u8] = b"operator";
