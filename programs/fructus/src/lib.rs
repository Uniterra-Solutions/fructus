//! Fructus — a Solana protocol for trading yield futures.
//!
//! This milestone implements the **data module**: an on-chain mark-price APY
//! oracle that is updated via publisher-signed (ed25519) data, with a
//! staleness predicate consumers can use as a circuit breaker.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

pub mod collateral;
pub mod constants;
pub mod ed25519;
pub mod error;
pub mod exchange;
pub mod funding;
pub mod liquidation;
pub mod operator;
pub mod orderbook;
pub mod positions;
pub mod settlement;
pub mod state;

use constants::{
    EVENT_QUEUE_LEN, LIQUIDATION_PENALTY_BPS, LIQUIDATION_TWAP_WINDOW, MAX_MATCH_STEPS,
    MAX_ORDERS_PER_SIDE, OPERATOR_SEED, ORACLE_SEED, ORDER_BOOK_SEED, PERP_MARKET_SEED,
    POSITION_SEED, SLOTS_PER_YEAR, TWAP_OBSERVATIONS, USDC_DECIMALS, USER_COLLATERAL_SEED,
    VAULT_SEED,
};
use error::FructusError;
use exchange::{ExchangeRate, STAKE_POOL_PROGRAM_ID};
use state::{
    apy_in_bounds, funding_k_in_bounds, initial_margin_in_bounds, maintenance_margin_in_bounds,
    max_funding_in_bounds, update_message, validate_version, Operator, OrderBook, OutEvent,
    PerpMarket, Position, UserCollateral, YieldOracle,
};

/// Validate that `account` is owned by the SPL Stake Pool program and carries
/// the `StakePool` discriminator, returning the parsed [`ExchangeRate`].
fn read_stake_pool(account: &AccountInfo) -> Result<ExchangeRate> {
    require!(
        account.owner == &STAKE_POOL_PROGRAM_ID,
        FructusError::InvalidStakePool
    );
    ExchangeRate::read(&account.data.borrow()).ok_or(FructusError::InvalidStakePool.into())
}

// --- Order-book adapters (issue #3) --------------------------------------
//
// The on-chain `OrderBook` account stores fixed-capacity arrays (with an `active`
// flag per slot), while the pure `orderbook::Book` engine works over `Vec`s. The
// handlers below load the account into the pure model, run the engine, and write
// the result back — recording a TWAP observation and appending an `OutEvent` on
// every book mutation.

/// `OutEvent.kind` byte values (see `state::OutEvent`).
const EVENT_KIND_FILL: u8 = 0;
const EVENT_KIND_CANCEL: u8 = 1;
const EVENT_KIND_RESIDUAL: u8 = 2;

/// `OutEvent.side` byte values (see `state::OutEvent`).
const SIDE_BID: u8 = 0;
const SIDE_ASK: u8 = 1;

/// Number of event-queue entries the permissionless `crank` drains per call.
const CRANK_BATCH_LEN: u64 = 8;

/// Convert a pure [`orderbook::Side`] into its on-chain `u8` encoding.
fn side_to_u8(side: orderbook::Side) -> u8 {
    match side {
        orderbook::Side::Bid => SIDE_BID,
        orderbook::Side::Ask => SIDE_ASK,
    }
}

/// Parse the on-chain `u8` side encoding, rejecting any value other than 0/1.
fn side_from_u8(side: u8) -> Result<orderbook::Side> {
    match side {
        SIDE_BID => Ok(orderbook::Side::Bid),
        SIDE_ASK => Ok(orderbook::Side::Ask),
        _ => Err(ProgramError::InvalidInstructionData.into()),
    }
}

/// The opposite side of `side` (every fill's maker rests opposite the taker).
fn opposite(side: orderbook::Side) -> orderbook::Side {
    match side {
        orderbook::Side::Bid => orderbook::Side::Ask,
        orderbook::Side::Ask => orderbook::Side::Bid,
    }
}

/// Load the account's active orders into the pure in-memory book.
fn load_book(account: &OrderBook) -> orderbook::Book {
    let bids = account
        .bids
        .iter()
        .filter(|o| o.active != 0)
        .map(|o| orderbook::Order {
            owner: o.owner,
            side: orderbook::Side::Bid,
            price: o.price,
            size: o.size,
            seq: o.seq,
        })
        .collect();
    let asks = account
        .asks
        .iter()
        .filter(|o| o.active != 0)
        .map(|o| orderbook::Order {
            owner: o.owner,
            side: orderbook::Side::Ask,
            price: o.price,
            size: o.size,
            seq: o.seq,
        })
        .collect();
    orderbook::Book {
        bids,
        asks,
        next_seq: account.next_seq,
    }
}

/// Write the pure book back into the account's fixed-capacity arrays, recomputing
/// the cached `best_bid`/`best_ask` from the surviving orders.
///
/// The engine never lets a side exceed `MAX_ORDERS_PER_SIDE` (`post_limit`
/// rejects at capacity and matching only removes), so contiguous indexing is
/// safe here.
fn save_book(account: &mut OrderBook, book: &orderbook::Book) {
    for slot in account.bids.iter_mut() {
        *slot = state::Order::default();
    }
    for slot in account.asks.iter_mut() {
        *slot = state::Order::default();
    }
    for (i, o) in book.bids.iter().enumerate() {
        account.bids[i] = state::Order {
            active: 1,
            owner: o.owner,
            price: o.price,
            size: o.size,
            seq: o.seq,
            _pad: [0u8; 7],
        };
    }
    for (i, o) in book.asks.iter().enumerate() {
        account.asks[i] = state::Order {
            active: 1,
            owner: o.owner,
            price: o.price,
            size: o.size,
            seq: o.seq,
            _pad: [0u8; 7],
        };
    }
    account.next_seq = book.next_seq;
    account.best_bid = orderbook::best_bid(book);
    account.best_ask = orderbook::best_ask(book);
}

/// Take the next monotonic order sequence id, incrementing the book's counter.
fn take_next_seq(book: &mut orderbook::Book) -> Result<u64> {
    let seq = book.next_seq;
    book.next_seq = book
        .next_seq
        .checked_add(1)
        .ok_or(FructusError::ArithmeticOverflow)?;
    Ok(seq)
}

/// Append an event to the bounded ring, assigning it the monotonic write-cursor
/// value as its sequence number.
///
/// `entry_total_lamports` / `entry_pool_token_supply` carry the fill-time index
/// snapshot (FR-6/D8) and are stamped verbatim onto every `Fill`; pass `0` for
/// non-fill events (Cancel/Residual). A fresh event is always un-settled
/// (`settled = 0`); only `settle_fill` ever flips a `Fill` to `1`.
///
/// Backpressure (FR-8(f)/FR-9): the ring must never overwrite an event the
/// permissionless `crank` has not yet drained. When it is full the incoming
/// event is dropped rather than silently clobbering an undrained
/// Fill/Cancel/Residual (the caller decides how to surface the failure).
fn append_event(
    account: &mut OrderBook,
    kind: u8,
    owner: Pubkey,
    counterparty: Pubkey,
    side: u8,
    price: u64,
    size: u64,
    entry_total_lamports: u64,
    entry_pool_token_supply: u64,
) -> bool {
    let queued = account
        .event_write_cursor
        .saturating_sub(account.event_read_cursor);
    if queued >= EVENT_QUEUE_LEN as u64 {
        return false;
    }
    let idx = (account.event_write_cursor % EVENT_QUEUE_LEN as u64) as usize;
    account.events[idx] = OutEvent {
        seq: account.event_write_cursor,
        kind,
        owner,
        counterparty,
        side,
        price,
        size,
        entry_total_lamports,
        entry_pool_token_supply,
        settled: 0,
        _pad: [0u8; 5],
    };
    account.event_write_cursor = account.event_write_cursor.wrapping_add(1);
    true
}

/// Append a `Fill` event for every fill in `fills`, each stamped with the
/// in-transaction index snapshot (`entry_total_lamports` /
/// `entry_pool_token_supply`, read once from the market-bound `index_source`).
///
/// Fills are never silently dropped (D10): if ANY append fails because the
/// event ring is full, the whole call fails with [`FructusError::BookFull`] and
/// the taker-driven caller propagates it (`?`), so the fill always persists its
/// event or the transaction reverts.
///
/// Each maker's owner is carried directly on the fill (`Fill::maker_owner`),
/// set by the engine at fill time, so no pre-match snapshot is needed.
fn emit_fill_events(
    account: &mut OrderBook,
    fills: &[orderbook::Fill],
    maker_side: orderbook::Side,
    entry_total_lamports: u64,
    entry_pool_token_supply: u64,
) -> Result<()> {
    for f in fills {
        let appended = append_event(
            account,
            EVENT_KIND_FILL,
            f.maker_owner,
            f.taker_owner,
            side_to_u8(maker_side),
            f.price,
            f.size,
            entry_total_lamports,
            entry_pool_token_supply,
        );
        require!(appended, FructusError::BookFull);
    }
    Ok(())
}

/// Most recent TWAP sample, or `None` when nothing has been recorded yet.
///
/// A zero-initialized (never-written) slot has `slot == 0`; real samples are
/// recorded at post-genesis slots (≥ 1), so filtering on `slot != 0` cleanly
/// distinguishes the two.
fn last_observation(account: &OrderBook) -> Option<(u64, u64, u128)> {
    account
        .observations
        .iter()
        .filter(|o| o.slot != 0)
        .max_by_key(|o| o.slot)
        .map(|o| (o.slot, o.mid, u128::from_le_bytes(o.cumulative_mid)))
}

/// Record a time-weighted-mid observation: `cumulative_mid += mid * Δslots`.
///
/// Called once per book mutation. When `mid` is `None` (one-sided/empty book) the
/// contribution is `0`, so an undefined mid never pollutes the accumulator. All
/// arithmetic is `u128` + saturating — no panicking math.
fn record_observation(account: &mut OrderBook, mid: Option<u64>, now_slot: u64) {
    let idx = (account.twap_cursor % TWAP_OBSERVATIONS as u64) as usize;
    let (slot, cumulative) = match last_observation(account) {
        None => (now_slot, 0u128),
        Some((prev_slot, prev_mid, prev_cum)) => {
            let delta = now_slot.saturating_sub(prev_slot);
            // The elapsed interval `[prev_slot, now_slot)` saw the PREVIOUS
            // mid, not the post-mutation mid passed by the caller (F1): the
            // caller records the *new* mid after `save_book`, so charging it
            // to the preceding interval would bias the TWAP. A `None`
            // (one-sided book) still contributes nothing.
            let contribution = match mid {
                Some(_) => (prev_mid as u128).saturating_mul(delta as u128),
                None => 0,
            };
            (now_slot, prev_cum.saturating_add(contribution))
        }
    };
    account.observations[idx] = state::Observation {
        slot,
        mid: mid.unwrap_or(0),
        cumulative_mid: cumulative.to_le_bytes(),
    };
    account.twap_cursor = account.twap_cursor.wrapping_add(1);
}

/// Match a crossing limit taker inline and settle its remainder.
///
/// * Every fill appends a `Fill` event (maker owner carried on the fill),
///   stamped with the in-transaction index snapshot (FR-6/D8); a fill that
///   cannot be appended fails the whole call with `BookFull` (fills are never
///   silently dropped — D10).
/// * A budget-interrupted remainder (`MAX_MATCH_STEPS` fills reached with a
///   crossable maker still available) is re-queued as a `Residual` event.
/// * An unfilled, no-longer-crossing remainder rests at the limit price (and is
///   cancelled instead of failing when the side is at capacity).
/// * A remainder that *still* crosses after matching can only be because the
///   crossing maker is self-owned (the engine skips self-trades): it is rejected
///   with [`FructusError::SelfTrade`] when nothing filled, and cancelled (so the
///   non-self fills survive) otherwise.
fn match_limit_taker(
    account: &mut OrderBook,
    book: &mut orderbook::Book,
    incoming: orderbook::Order,
    entry_total_lamports: u64,
    entry_pool_token_supply: u64,
) -> Result<()> {
    let maker_side = opposite(incoming.side);
    let outcome = orderbook::match_order(
        book,
        incoming.clone(),
        orderbook::OrderKind::Limit,
        MAX_MATCH_STEPS,
    );

    emit_fill_events(
        account,
        &outcome.fills,
        maker_side,
        entry_total_lamports,
        entry_pool_token_supply,
    )?;

    let total_filled: u64 = outcome.fills.iter().map(|f| f.size).sum();
    let remaining = incoming.size.saturating_sub(total_filled);

    match outcome.residual {
        Some(residual) => {
            // Compute budget exhausted with a crossable maker still available:
            // defer the remainder for the crank (D7), never rest a crossing order.
            let appended = append_event(
                account,
                EVENT_KIND_RESIDUAL,
                residual.owner,
                Pubkey::default(),
                side_to_u8(residual.side),
                residual.price,
                residual.size,
                0,
                0,
            );
            // Backpressure (FR-8(f)/FR-9): the ring is full, so the deferred
            // residual cannot be persisted. Fail the transaction rather than
            // silently losing the taker's still-crossable remainder (F3).
            require!(appended, FructusError::BookFull);
        }
        None if remaining > 0 => {
            // All crossable makers are gone: the remainder is now non-crossing and
            // rests, unless the book is at capacity. If it still crosses, the
            // only remaining crossable maker is self-owned.
            let remainder = orderbook::Order {
                owner: incoming.owner,
                side: incoming.side,
                price: incoming.price,
                size: remaining,
                seq: incoming.seq,
            };
            if orderbook::would_cross(book, &remainder) {
                // Reject a pure self-trade (nothing filled) with `SelfTrade`;
                // otherwise cancel the self-crossing remainder so the legitimate
                // non-self fills survive instead of reverting the taker (F4).
                if total_filled == 0 {
                    return Err(FructusError::SelfTrade.into());
                }
            } else {
                // The remainder no longer crosses and must rest at its limit
                // price. `post_limit` can only fail here with `BookFull` (the
                // price is non-zero and the remainder is non-crossing): a
                // resumed residual whose remainder cannot rest must be consumed
                // rather than reverting the whole transaction (F2), so cancel
                // the remainder instead of failing.
                let side_full = match remainder.side {
                    orderbook::Side::Bid => book.bids.len() >= MAX_ORDERS_PER_SIDE,
                    orderbook::Side::Ask => book.asks.len() >= MAX_ORDERS_PER_SIDE,
                };
                if !side_full {
                    orderbook::post_limit(book, remainder)?;
                }
            }
        }
        None => {}
    }
    Ok(())
}

/// Drain up to `CRANK_BATCH_LEN` events from the ring, resuming any `Residual`
/// entries against the live book.
///
/// The crank must never wedge the ring (FR-6): the read cursor always advances
/// past the head event before it is handled, and a `Residual` is resumed only
/// when the ring can hold EVERY fill its match would persist — otherwise the
/// whole remainder is cancelled up front without consuming any maker (D10':
/// all-or-nothing; D10: fills are never silently dropped). Residuals arise only
/// from the position-neutral `place_limit_order` (D10′), so cancelling an
/// unresumable remainder loses no position.
///
/// Returns `Ok(true)` when the book was mutated (a residual was resumed — its
/// `seq` was consumed) and must be persisted; `Ok(false)` when the batch was
/// pure consume (fills/cancels), a residual was cancelled by the capacity
/// gate, or the ring was empty.
fn drain_events(
    account: &mut OrderBook,
    book: &mut orderbook::Book,
    entry_total_lamports: u64,
    entry_pool_token_supply: u64,
) -> Result<bool> {
    let mut processed: u64 = 0;
    let mut book_dirty = false;
    while processed < CRANK_BATCH_LEN && account.event_read_cursor < account.event_write_cursor {
        let idx = (account.event_read_cursor % EVENT_QUEUE_LEN as u64) as usize;
        let event = account.events[idx];
        account.event_read_cursor = account
            .event_read_cursor
            .checked_add(1)
            .ok_or(FructusError::ArithmeticOverflow)?;
        processed = processed
            .checked_add(1)
            .ok_or(FructusError::ArithmeticOverflow)?;

        match event.kind {
            EVENT_KIND_RESIDUAL => {
                let side = side_from_u8(event.side)?;
                // All-or-nothing resume (D10'/FR-6): a `Residual` is resumed
                // only when the ring has capacity to persist EVERY event its
                // match would append (one `Fill` per matched maker, plus one
                // `Residual` if the budget hits again); otherwise the whole
                // remainder is cancelled WITHOUT consuming any maker or seq —
                // a maker is never matched without a persisted, settle-able
                // `Fill` event (D10: fills are never silently dropped). The
                // dry-run probe below runs the engine on a clone of the book
                // (cheap: at most `MAX_ORDERS_PER_SIDE` orders per side) to
                // learn the fill count before touching the real book.
                let incoming = orderbook::Order {
                    owner: event.owner,
                    side,
                    price: event.price,
                    size: event.size,
                    seq: book.next_seq,
                };
                let mut probe = book.clone();
                let probe_outcome = orderbook::match_order(
                    &mut probe,
                    incoming.clone(),
                    orderbook::OrderKind::Limit,
                    MAX_MATCH_STEPS,
                );
                let events_needed = probe_outcome.fills.len()
                    + if probe_outcome.residual.is_some() {
                        1
                    } else {
                        0
                    };
                // The read cursor already advanced past this head event, so the
                // ring holds `EVENT_QUEUE_LEN - (write - read)` free slots.
                let queued = account
                    .event_write_cursor
                    .saturating_sub(account.event_read_cursor);
                let free = (EVENT_QUEUE_LEN as u64).saturating_sub(queued);
                if events_needed as u64 > free {
                    msg!(
                        "crank cancelled unresumable residual owner={} size={}: \
                         needs {events_needed} event(s), ring has {free} free",
                        event.owner,
                        event.size
                    );
                    continue;
                }
                let seq = take_next_seq(book)?;
                let incoming = orderbook::Order {
                    owner: event.owner,
                    side,
                    price: event.price,
                    size: event.size,
                    seq,
                };
                // `take_next_seq` already advanced, so the book is dirty either
                // way. A resumed residual must be consumed, never rejected (F2):
                // if the engine cannot finish it (a pure self-trade), cancel it
                // here so the shared crank is never wedged. The read cursor
                // already advanced past this event. (The capacity gate above
                // precludes `BookFull`, so the only residual failure left is a
                // pure self-trade.)
                book_dirty = true;
                if match_limit_taker(
                    account,
                    book,
                    incoming,
                    entry_total_lamports,
                    entry_pool_token_supply,
                )
                .is_err()
                {
                    msg!(
                        "crank cancelled unresumable residual owner={} size={}",
                        event.owner,
                        event.size
                    );
                }
            }
            EVENT_KIND_FILL | EVENT_KIND_CANCEL => {
                // Emit (log) and consume; there is no settlement this iteration,
                // so fills/cancels have no further on-chain effect.
                msg!(
                    "crank consumed event seq={} kind={} owner={} side={} price={} size={}",
                    event.seq,
                    event.kind,
                    event.owner,
                    event.side,
                    event.price,
                    event.size
                );
            }
            _ => {
                msg!("crank skipped unknown event kind={}", event.kind);
            }
        }
    }
    Ok(book_dirty)
}

// --- Position lifecycle adapters (issue #5) --------------------------------
//
// The handlers below are thin Anchor adapters over the pure `positions` API
// (`margin_required` / `accumulate_entry`, property-tested in `positions.rs`)
// plus the order-book engine from issue #3. The helpers in this section are
// deliberately account-plumbing-free so the lib handler tests can drive them
// directly with plain structs.

/// Apply open-intent fills to a position and its margin ledger (REQ-3/REQ-5).
///
/// * `notional += Σ fill.size` (checked; the engine never over-fills).
/// * Entry running sums accumulate the **fill-time snapshot**
///   (`entry_total_lamports` / `entry_pool_token_supply`) weighted by each
///   fill's size (D6). A closed position (`notional == 0`, retained account)
///   **re-opens**: the sums are reset to the first fill's weighted snapshot,
///   `open_slot` becomes the current slot (FR-2/FR-5), and `last_funding_epoch`
///   is re-based to the re-open epoch (R-F5: funding must not accrue over the
///   closed interval, where notional was 0); a live position keeps its
///   `open_slot` and accumulates.
/// * Margin is reserved incrementally: `UserCollateral.reserved` grows by the
///   `margin_required` delta of the new notional (ceiling, D11), gated by the
///   free-collateral seam (`InsufficientFreeCollateral`, REQ-7).
///
/// All computation happens before any field is written, so a failure (margin
/// shortfall / overflow) leaves both accounts untouched (atomic revert).
fn apply_open_fills(
    position: &mut Position,
    user_collateral: &mut UserCollateral,
    initial_margin_bps: u16,
    fills: &[orderbook::Fill],
    entry_total_lamports: u64,
    entry_pool_token_supply: u64,
    now_slot: u64,
    funding_epoch_slots: u64,
) -> Result<()> {
    if fills.is_empty() {
        return Ok(());
    }
    let reopening = position.notional == 0;
    let mut n_sum = if reopening { 0 } else { position.entry_n_sum };
    let mut d_sum = if reopening { 0 } else { position.entry_d_sum };
    let mut notional_delta: u64 = 0;
    for f in fills {
        notional_delta = notional_delta
            .checked_add(f.size)
            .ok_or(FructusError::ArithmeticOverflow)?;
        let (nn, nd) = positions::accumulate_entry(
            n_sum,
            d_sum,
            entry_total_lamports,
            entry_pool_token_supply,
            f.size,
        )
        .ok_or(FructusError::ArithmeticOverflow)?;
        n_sum = nn;
        d_sum = nd;
    }
    let new_notional = position
        .notional
        .checked_add(notional_delta)
        .ok_or(FructusError::ArithmeticOverflow)?;
    let new_collateral = positions::margin_required(new_notional, initial_margin_bps)
        .ok_or(FructusError::ArithmeticOverflow)?;
    // Margin is monotonic non-decreasing in notional (ceiling formula), so the
    // incremental delta is well-defined; reservation grows by exactly that
    // delta (REQ-7), checked against the free-collateral seam (D11).
    let incremental = new_collateral
        .checked_sub(position.collateral)
        .ok_or(FructusError::ArithmeticOverflow)?;
    let new_reserved = user_collateral
        .reserved
        .checked_add(incremental)
        .ok_or(FructusError::ArithmeticOverflow)?;
    collateral::free_collateral(user_collateral.deposited, new_reserved)
        .ok_or(FructusError::InsufficientFreeCollateral)?;

    position.notional = new_notional;
    position.entry_n_sum = n_sum;
    position.entry_d_sum = d_sum;
    position.collateral = new_collateral;
    if reopening {
        position.open_slot = now_slot;
        // Re-base `last_funding_epoch` to the re-open epoch so a reopened
        // position only accrues funding over epochs it actually held notional —
        // never the closed interval in which `notional == 0` (R-F5).
        position.last_funding_epoch = funding::funding_epoch(now_slot, funding_epoch_slots);
    }
    user_collateral.reserved = new_reserved;
    Ok(())
}

/// Apply close-intent fills to a position and its margin ledger (REQ-4).
///
/// * `notional -= Σ fill.size` — never below zero (the handler pre-checks
///   `size <= notional` and the engine never over-fills; the `checked_sub` is
///   defensive and maps to `InvalidCloseSize`).
/// * `collateral` is recomputed down from the new notional and
///   `UserCollateral.reserved` is released by exactly that delta (REQ-7).
/// * Entry running sums, `open_slot`, and `last_funding_epoch` are unchanged
///   (average-cost convention); no PnL settlement (D4).
fn apply_close_fills(
    position: &mut Position,
    user_collateral: &mut UserCollateral,
    initial_margin_bps: u16,
    fills: &[orderbook::Fill],
) -> Result<()> {
    if fills.is_empty() {
        return Ok(());
    }
    let mut notional_delta: u64 = 0;
    for f in fills {
        notional_delta = notional_delta
            .checked_add(f.size)
            .ok_or(FructusError::ArithmeticOverflow)?;
    }
    let new_notional = position
        .notional
        .checked_sub(notional_delta)
        .ok_or(FructusError::InvalidCloseSize)?;
    let new_collateral = positions::margin_required(new_notional, initial_margin_bps)
        .ok_or(FructusError::ArithmeticOverflow)?;
    // Margin is monotonic non-decreasing in notional, so closing can only
    // release reservation (never below zero; D11's exact-sum invariant).
    let released = position
        .collateral
        .checked_sub(new_collateral)
        .ok_or(FructusError::ArithmeticOverflow)?;
    let new_reserved = user_collateral
        .reserved
        .checked_sub(released)
        .ok_or(FructusError::ArithmeticOverflow)?;
    // R-S1: record the notional handed back to the book so a later
    // `settle_close` can realize its signed PnL (D4 keeps close lifecycle-only,
    // so the closed notional is accumulated, not settled here). Computed up
    // front so an overflow fails atomically before any field is written.
    let new_closed_notional = position
        .closed_notional
        .checked_add(notional_delta)
        .ok_or(FructusError::ArithmeticOverflow)?;
    // Capture the entry basis the closed notional is priced at (the position's
    // avg-cost basis `entry_n_sum / entry_d_sum` at close time), then ACCUMULATE
    // it into the closed-entry running sums as a notional-weighted harmonic-mean
    // representation. Closing never changes the entry sums (D6), so the per-unit
    // components are recovered exactly; a re-open (which RESETS the live entry
    // sums for the new notional) leaves `closed_entry_*` intact, so `settle_close`
    // prices each closed amount at its own close-time basis and the re-open never
    // reframes it (R-S1/R-S2). The scale of `add_n`/`add_d` (any multiple) cancels
    // in the harmonic ratio, but we use per-unit components so a single-generation
    // close preserves the position's entry sums verbatim.
    let live_notional = position.notional; // > 0 (handler pre-checks size <= notional)
    let add_n = (position.entry_n_sum / live_notional as u128) as u64;
    let add_d = (position.entry_d_sum / live_notional as u128) as u64;
    let (new_closed_entry_n, new_closed_entry_d) = positions::accumulate_closed_entry(
        position.closed_entry_n_sum,
        position.closed_entry_d_sum,
        position.closed_notional,
        add_n,
        add_d,
        notional_delta,
    )
    .ok_or(FructusError::ArithmeticOverflow)?;

    position.notional = new_notional;
    position.collateral = new_collateral;
    position.closed_notional = new_closed_notional;
    position.closed_entry_n_sum = new_closed_entry_n;
    position.closed_entry_d_sum = new_closed_entry_d;
    user_collateral.reserved = new_reserved;
    Ok(())
}

/// Place the `open_position` order against the book and return its fills.
///
/// * `price == 0` → market (IOC, `OrderKind::Market`): matches to exhaustion;
///   any unfilled remainder is cancelled, never rested.
/// * `price > 0` non-crossing → rests at the limit price (no fills).
/// * `price > 0` crossing → bounded match (`MAX_MATCH_STEPS`); a
///   **budget-hit remainder is cancelled** (IOC-style on the remainder, D10′)
///   — never re-queued as a `Residual` event (the crank therefore never needs
///   position accounts); a no-longer-crossing remainder (opposite book
///   exhausted) rests at its limit price; a *still*-crossing remainder can
///   only be a self-trade — rejected with `SelfTrade` when nothing filled,
///   otherwise cancelled so the legitimate non-self fills survive (F4).
///
/// Every fill appends a stamped `Fill` event (snapshot FR-6/D8); a full event
/// ring fails with `BookFull` — fills are never silently dropped (D10).
fn match_open_taker(
    account: &mut OrderBook,
    book: &mut orderbook::Book,
    incoming: orderbook::Order,
    entry_total_lamports: u64,
    entry_pool_token_supply: u64,
) -> Result<Vec<orderbook::Fill>> {
    let outcome = if incoming.price == 0 {
        // Market (IOC): no step budget — the opposite side holds at most
        // `MAX_ORDERS_PER_SIDE` makers, bounding the loop (same reasoning as
        // `place_market_order`); `residual` is always `None`.
        orderbook::match_order(
            book,
            incoming.clone(),
            orderbook::OrderKind::Market,
            u64::MAX,
        )
    } else if !orderbook::would_cross(book, &incoming) {
        // Non-crossing limit: rest at the limit price, no fills.
        orderbook::post_limit(book, incoming)?;
        return Ok(Vec::new());
    } else {
        orderbook::match_order(
            book,
            incoming.clone(),
            orderbook::OrderKind::Limit,
            MAX_MATCH_STEPS,
        )
    };

    emit_fill_events(
        account,
        &outcome.fills,
        opposite(incoming.side),
        entry_total_lamports,
        entry_pool_token_supply,
    )?;

    let total_filled: u64 = outcome.fills.iter().map(|f| f.size).sum();
    let remaining = incoming.size.saturating_sub(total_filled);
    if incoming.price > 0 && remaining > 0 {
        let remainder = orderbook::Order {
            owner: incoming.owner,
            side: incoming.side,
            price: incoming.price,
            size: remaining,
            seq: incoming.seq,
        };
        match outcome.residual {
            Some(_) => {
                // Budget hit (D10′): the still-crossable remainder is cancelled
                // — never re-queued as a Residual, never rested.
            }
            None => {
                // The opposite book is exhausted (or only self-owned makers
                // remain crossable).
                if orderbook::would_cross(book, &remainder) {
                    // Still crosses: only a self-owned maker can be crossable.
                    // A pure self-trade (nothing filled) rejects; otherwise the
                    // self-crossing remainder is cancelled so the legitimate
                    // non-self fills survive (F4 semantics).
                    if total_filled == 0 {
                        return Err(FructusError::SelfTrade.into());
                    }
                } else {
                    // No longer crosses: rest at the limit price, unless the
                    // side is at capacity (then cancel — BookFull from a
                    // partial fill must not revert the fills that did match).
                    let side_full = match remainder.side {
                        orderbook::Side::Bid => book.bids.len() >= MAX_ORDERS_PER_SIDE,
                        orderbook::Side::Ask => book.asks.len() >= MAX_ORDERS_PER_SIDE,
                    };
                    if !side_full {
                        orderbook::post_limit(book, remainder)?;
                    }
                }
            }
        }
    }
    Ok(outcome.fills)
}

/// Locate the pending `Fill` event at `seq` for maker settlement (REQ-5).
///
/// `slot = seq % EVENT_QUEUE_LEN`. Returns:
/// * `Ok(None)` — the slot holds a `Fill` with `event.seq == seq` that is
///   **already settled** (`settled != 0`): an idempotent no-op (D9).
/// * `Ok(Some(event))` — a pending `Fill` (`kind == Fill`, `event.seq == seq`,
///   `settled == 0`) carrying the fill-time snapshot for settlement.
/// * `Err(EventNotFound)` — any other slot content: a ring-wrapped/never
///   written slot (`event.seq != seq`, the OQ-1 liveness bound) or a
///   non-Fill event (Cancel/Residual) at this seq.
fn settle_event(account: &OrderBook, seq: u64) -> Result<Option<OutEvent>> {
    let idx = (seq % EVENT_QUEUE_LEN as u64) as usize;
    let event = account.events[idx];
    if event.seq == seq && event.kind == EVENT_KIND_FILL && event.settled != 0 {
        return Ok(None); // idempotent no-op (D9)
    }
    require!(event.seq == seq, FructusError::EventNotFound);
    require!(event.kind == EVENT_KIND_FILL, FructusError::EventNotFound);
    // Defensive: a matching Fill with `settled != 0` returned `Ok(None)` above,
    // so this is unreachable — kept for the explicit state machine.
    require!(event.settled == 0, FructusError::EventNotFound);
    Ok(Some(event))
}

/// Derive the maker's `Position` / `UserCollateral` PDAs from the event's
/// `owner` + `side` and verify the supplied account keys byte-for-byte
/// (AGENTS.md), returning the `Position` PDA bump for the lazy-create CPI.
///
/// A mismatch fails with `ProgramError::InvalidAccountData` (no dedicated
/// error variant — design §3 flow item 3).
fn verify_maker_accounts(
    market_key: &Pubkey,
    event: &OutEvent,
    position_key: &Pubkey,
    collateral_key: &Pubkey,
) -> Result<u8> {
    let (position_pda, position_bump) = Pubkey::find_program_address(
        &[
            POSITION_SEED,
            market_key.as_ref(),
            event.owner.as_ref(),
            &[event.side],
        ],
        &crate::ID,
    );
    if position_pda.as_ref() != position_key.as_ref() {
        return Err(ProgramError::InvalidAccountData.into());
    }
    let (collateral_pda, _) = Pubkey::find_program_address(
        &[
            USER_COLLATERAL_SEED,
            market_key.as_ref(),
            event.owner.as_ref(),
        ],
        &crate::ID,
    );
    if collateral_pda.as_ref() != collateral_key.as_ref() {
        return Err(ProgramError::InvalidAccountData.into());
    }
    Ok(position_bump)
}

/// Verify `collateral_key` is the per-`(market, owner)` `UserCollateral` PDA
/// (seed `[USER_COLLATERAL_SEED, market, owner]`), byte-for-byte (AGENTS.md).
///
/// Used by the permissionless `settle_close` / `settle_funding` / `liquidate`
/// adapters after reading `position.owner`: the caller provides the accounts, so
/// the handler must bind them to the user's PDAs (`InvalidAccountData` on
/// mismatch), mirroring `settle_fill`'s `verify_maker_accounts`.
fn verify_collateral_pda(
    market_key: &Pubkey,
    owner: &Pubkey,
    collateral_key: &Pubkey,
) -> Result<()> {
    let (collateral_pda, _) = Pubkey::find_program_address(
        &[USER_COLLATERAL_SEED, market_key.as_ref(), owner.as_ref()],
        &crate::ID,
    );
    if collateral_pda.as_ref() != collateral_key.as_ref() {
        return Err(ProgramError::InvalidAccountData.into());
    }
    Ok(())
}

/// Read the `(operator, market, user)` fields of an `Operator` record
/// account for the `operator_*` authorization check (REQ-A1-6).
///
/// A pristine (empty) PDA decodes to the all-default tuple — the "no record"
/// state, which [`crate::operator::authorized`] rejects together with the
/// revoked state (`operator == Pubkey::default()`).
fn operator_record_fields(record: &UncheckedAccount) -> Result<(Pubkey, Pubkey, Pubkey)> {
    if record.data_is_empty() {
        return Ok((Pubkey::default(), Pubkey::default(), Pubkey::default()));
    }
    let data = record.try_borrow_data()?;
    let decoded = Operator::try_deserialize(&mut &data[..])?;
    Ok((decoded.operator, decoded.market, decoded.user))
}

/// Index-based unrealized PnL of one side's `Position` PDA, for the withdraw
/// equity gate's `Σ upnl` term (REQ-A2-3/D9).
///
/// A pristine (empty) or closed (`notional == 0`) side contributes zero; a
/// live program-owned position is priced with [`positions::pnl`] against the
/// live pool rate. A non-program-owned account at the PDA (a squat the program
/// can never reclaim) or a program-owned account whose stored
/// market/owner/side does not match its derivation is account-data corruption
/// (`ProgramError::InvalidAccountData`) — never silently counted as zero.
fn side_unrealized_pnl<'info>(
    position: &'info UncheckedAccount<'info>,
    market: &Pubkey,
    owner: &Pubkey,
    side: positions::PositionSide,
    rate: &ExchangeRate,
) -> Result<i128> {
    if position.data_is_empty() {
        return Ok(0);
    }
    if position.owner != &crate::ID {
        return Err(ProgramError::InvalidAccountData.into());
    }
    let side_byte = match side {
        positions::PositionSide::Long => SIDE_BID,
        positions::PositionSide::Short => SIDE_ASK,
    };
    let position = Account::<Position>::try_from_unchecked(position.as_ref())?;
    if position.market != *market || position.owner != *owner || position.side != side_byte {
        return Err(ProgramError::InvalidAccountData.into());
    }
    if position.notional == 0 {
        return Ok(0);
    }
    Ok(positions::pnl(
        position.entry_n_sum,
        position.entry_d_sum,
        rate.total_lamports,
        rate.pool_token_supply,
        position.notional,
        side,
    )
    .ok_or(FructusError::ArithmeticOverflow)?)
}

declare_id!("3EsUd5XQ6KChedwL2ho8pv3zrrGGFvMpJEV1PnzN8MD1");

#[program]
pub mod fructus {
    use super::*;

    /// Create the singleton yield oracle.
    pub fn initialize(
        ctx: Context<Initialize>,
        publisher: Pubkey,
        stale_after_slots: u64,
        initial_apy: u64,
    ) -> Result<()> {
        require!(apy_in_bounds(initial_apy), FructusError::ApyTooHigh);
        let oracle = &mut ctx.accounts.oracle;
        oracle.apy = initial_apy;
        oracle.version = 0;
        oracle.last_update_slot = Clock::get()?.slot;
        oracle.publisher = publisher;
        oracle.authority = ctx.accounts.authority.key();
        oracle.stale_after_slots = stale_after_slots;
        oracle.bump = ctx.bumps.oracle;
        Ok(())
    }

    /// Create the singleton perpetual market and bind it to a trustless index
    /// source (jitoSOL stake pool), a collateral mint, and funding/margin
    /// parameters. The collateral-vault PDA is derived and stored here but its
    /// token account is not created (deferred to a later issue).
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        collateral_mint: Pubkey,
        funding_k: u64,
        max_funding: u64,
        funding_epoch_slots: u64,
        initial_margin_bps: u16,
        maintenance_margin_bps: u16,
    ) -> Result<()> {
        require!(
            funding_k_in_bounds(funding_k),
            FructusError::InvalidFundingK
        );
        require!(
            max_funding_in_bounds(max_funding),
            FructusError::InvalidMaxFunding
        );
        require!(
            initial_margin_in_bounds(initial_margin_bps),
            FructusError::InvalidInitialMargin
        );
        require!(
            maintenance_margin_in_bounds(initial_margin_bps, maintenance_margin_bps),
            FructusError::InvalidMaintenanceMargin
        );

        let index_source = &ctx.accounts.index_source;
        read_stake_pool(index_source)?;

        let vault = Pubkey::find_program_address(&[VAULT_SEED], &crate::ID).0;

        let market = &mut ctx.accounts.market;
        market.index_source = index_source.key();
        market.collateral_mint = collateral_mint;
        market.funding_k = funding_k;
        market.max_funding = max_funding;
        market.funding_epoch_slots = funding_epoch_slots;
        market.initial_margin_bps = initial_margin_bps;
        market.maintenance_margin_bps = maintenance_margin_bps;
        market.authority = ctx.accounts.authority.key();
        market.vault = vault;
        market.bump = ctx.bumps.market;
        // Zero-init the funding state so the first `settle_funding` sees a
        // clear "no baseline yet" (`index_n == index_d == 0`) and a zero
        // accumulator (R-F4).
        market.funding_epoch = 0;
        market.index_n = 0;
        market.index_d = 0;
        market.funding_accumulator = 0;
        // Zero-init the Design A PnL pool alongside the funding state.
        market.pnl_pool = 0;
        Ok(())
    }

    /// Update the APY reference using a publisher-signed value.
    ///
    /// The transaction must carry an `ed25519` verify instruction whose public
    /// key is `oracle.publisher` and whose message is
    /// `update_message(oracle, apy, version)`.
    pub fn update_apy(ctx: Context<UpdateApy>, apy: u64, version: u64) -> Result<()> {
        require!(apy_in_bounds(apy), FructusError::ApyTooHigh);

        {
            let oracle = &ctx.accounts.oracle;
            let publisher = oracle.publisher;
            let oracle_key = oracle.key();
            let message = update_message(&oracle_key, apy, version);
            let ix_sysvar = ctx.accounts.instruction_sysvar.to_account_info();
            ed25519::verify_publisher_signature(&ix_sysvar, &publisher, &message)?;
        }

        {
            let oracle = &mut ctx.accounts.oracle;
            validate_version(oracle.version, version)?;
            oracle.apy = apy;
            oracle.version = version;
            oracle.last_update_slot = Clock::get()?.slot;
        }
        Ok(())
    }

    /// Change the staleness window (authority only).
    pub fn set_stale_window(ctx: Context<Admin>, new_stale_after_slots: u64) -> Result<()> {
        ctx.accounts.oracle.stale_after_slots = new_stale_after_slots;
        Ok(())
    }

    /// Rotate the publisher key (authority only).
    pub fn set_publisher(ctx: Context<Admin>, new_publisher: Pubkey) -> Result<()> {
        ctx.accounts.oracle.publisher = new_publisher;
        Ok(())
    }

    /// Derive the current exchange rate (SOL per pool token) from a stake pool
    /// account, on-chain and trustless.
    ///
    /// The rate is `total_lamports / pool_token_supply`, read directly from the
    /// pool account after validating that the account is owned by the SPL Stake
    /// Pool program and carries the `StakePool` discriminator. No external
    /// oracle or signed input is trusted.
    pub fn read_exchange_rate(ctx: Context<ReadExchangeRate>) -> Result<()> {
        let rate = read_stake_pool(&ctx.accounts.stake_pool)?;
        msg!(
            "fructus exchange_rate total_lamports={} pool_token_supply={}",
            rate.total_lamports,
            rate.pool_token_supply
        );
        Ok(())
    }

    /// Create the `OrderBook` PDA bound to the market (authority-gated).
    pub fn initialize_order_book<'info>(
        ctx: Context<'info, InitializeOrderBook<'info>>,
    ) -> Result<()> {
        // `init` creates + rents the account; `load_init` gives zero-copy access
        // (the 8-byte discriminator is written by Anchor's `AccountsExit` after the
        // handler returns). A second init fails with the system "account in use".
        let order_book = &mut ctx.accounts.order_book.load_init()?;
        order_book.market = ctx.accounts.market.key();
        order_book.bump = ctx.bumps.order_book;
        order_book.next_seq = 0;
        order_book.best_bid = 0;
        order_book.best_ask = 0;
        order_book.event_read_cursor = 0;
        order_book.event_write_cursor = 0;
        order_book.twap_cursor = 0;
        // bids/asks/events/observations are zero-initialized by `load_init`.
        Ok(())
    }

    /// Post a limit order: rest if non-crossing, otherwise match inline.
    ///
    /// The market-bound `index_source` is validated and its exchange-rate
    /// snapshot is stamped onto every emitted `Fill` (FR-6/D8), so resting
    /// makers can later be settled at the fill-time index.
    pub fn place_limit_order<'info>(
        ctx: Context<'info, PlaceLimitOrder<'info>>,
        side: u8,
        price: u64,
        size: u64,
    ) -> Result<()> {
        require!(price != 0, FructusError::InvalidPrice);
        require!(size != 0, FructusError::InvalidSize);
        let side = side_from_u8(side)?;
        let owner = ctx.accounts.owner.key();
        // The index snapshot is read once per tx (same slot ⇒ same rate) and
        // stamped onto every Fill this order produces (FR-6/D8).
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        let mut book = load_book(&account);
        let seq = take_next_seq(&mut book)?;
        let incoming = orderbook::Order {
            owner,
            side,
            price,
            size,
            seq,
        };

        if !orderbook::would_cross(&book, &incoming) {
            // Non-crossing: rest at the limit price.
            orderbook::post_limit(&mut book, incoming)?;
            save_book(&mut account, &book);
            record_observation(&mut account, orderbook::mid(&book), now_slot);
            return Ok(());
        }

        // Crossing: match inline; never rest a crossing order. A Fill that
        // cannot be appended (full event ring) fails the whole order with
        // `BookFull` (D10) — fills are never silently dropped.
        match_limit_taker(
            &mut account,
            &mut book,
            incoming,
            rate.total_lamports,
            rate.pool_token_supply,
        )?;
        save_book(&mut account, &book);
        record_observation(&mut account, orderbook::mid(&book), now_slot);
        Ok(())
    }

    /// Cross the opposite book best-price-first. Market orders are IOC: any
    /// unfilled remainder is cancelled, never posted.
    ///
    /// The market-bound `index_source` is validated and its exchange-rate
    /// snapshot is stamped onto every emitted `Fill` (FR-6/D8).
    pub fn place_market_order<'info>(
        ctx: Context<'info, PlaceMarketOrder<'info>>,
        side: u8,
        size: u64,
    ) -> Result<()> {
        require!(size != 0, FructusError::InvalidSize);
        let side = side_from_u8(side)?;
        let owner = ctx.accounts.owner.key();
        // The index snapshot is read once per tx (same slot ⇒ same rate) and
        // stamped onto every Fill this order produces (FR-6/D8).
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        let mut book = load_book(&account);
        let seq = take_next_seq(&mut book)?;
        let incoming = orderbook::Order {
            owner,
            side,
            price: 0,
            size,
            seq,
        };
        let maker_side = opposite(side);

        // A market order matches to exhaustion ("until filled or the opposite
        // book is exhausted"), so there is no step budget: the opposite side has
        // at most `MAX_ORDERS_PER_SIDE` makers, which bounds the loop. `Market`
        // is IOC, so `outcome.residual` is always `None` and any unfilled
        // remainder (book exhausted) is simply cancelled, never posted. A Fill
        // that cannot be appended (full event ring) fails the whole order with
        // `BookFull` (D10) — fills are never silently dropped.
        let outcome =
            orderbook::match_order(&mut book, incoming, orderbook::OrderKind::Market, u64::MAX);
        emit_fill_events(
            &mut account,
            &outcome.fills,
            maker_side,
            rate.total_lamports,
            rate.pool_token_supply,
        )?;

        save_book(&mut account, &book);
        record_observation(&mut account, orderbook::mid(&book), now_slot);
        Ok(())
    }

    /// Cancel one resting order (owner-only), releasing its size.
    pub fn cancel_order<'info>(ctx: Context<'info, CancelOrder<'info>>, seq: u64) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        let mut book = load_book(&account);
        let removed = orderbook::cancel(&mut book, owner, seq)?;

        append_event(
            &mut account,
            EVENT_KIND_CANCEL,
            owner,
            Pubkey::default(),
            side_to_u8(removed.side),
            removed.price,
            removed.size,
            0,
            0,
        );
        save_book(&mut account, &book);
        record_observation(&mut account, orderbook::mid(&book), now_slot);
        Ok(())
    }

    /// Permissionless: drain the event queue in bounded batches and resume any
    /// `Residual` entries left behind by budget-interrupted takers. Never matches
    /// off-chain and takes no privileged state.
    ///
    /// The market-bound `index_source` is validated and its exchange-rate
    /// snapshot is stamped onto every Fill a resumed residual produces (FR-6/D8).
    /// The crank never wedges the ring: a `Residual` whose fills cannot be
    /// appended (full ring) is cancelled rather than reverting the drain.
    pub fn crank<'info>(ctx: Context<'info, Crank<'info>>) -> Result<()> {
        // The index snapshot is read once per tx (same slot ⇒ same rate) and
        // stamped onto every Fill this batch produces (FR-6/D8).
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        let mut book = load_book(&account);
        let book_dirty = drain_events(
            &mut account,
            &mut book,
            rate.total_lamports,
            rate.pool_token_supply,
        )?;

        if book_dirty {
            save_book(&mut account, &book);
            record_observation(&mut account, orderbook::mid(&book), now_slot);
        }
        Ok(())
    }

    /// Create the USDC collateral-vault token account at the `PerpMarket.vault`
    /// PDA (seed `[b"vault"]`, unchanged) with the vault itself as its token
    /// authority. One-time and authority-gated; a second attempt fails with
    /// [`FructusError::VaultAlreadyInitialized`].
    pub fn initialize_collateral_vault(ctx: Context<InitializeCollateralVault>) -> Result<()> {
        // A second attempt: the vault already holds token-account data.
        require!(
            ctx.accounts.vault.data_is_empty(),
            FructusError::VaultAlreadyInitialized
        );
        // The collateral mint must be a Token-program-owned mint with 6 decimals.
        require!(
            ctx.accounts.collateral_mint.decimals == USDC_DECIMALS,
            FructusError::InvalidMint
        );

        let rent = Rent::get()?;
        let space = TokenAccount::LEN as u64;
        let bump = ctx.bumps.vault;
        let seeds: &[&[u8]] = &[VAULT_SEED, &[bump]];

        // 1. System-create the vault token account at the vault PDA.
        system_program::create_account(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            )
            .with_signer(&[seeds]),
            rent.minimum_balance(TokenAccount::LEN),
            space,
            &Token::id(),
        )?;

        // 2. Initialize it as a token account whose authority is itself.
        token::initialize_account3(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token::InitializeAccount3 {
                    account: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
            )
            .with_signer(&[seeds]),
        )?;

        Ok(())
    }

    /// Deposit `amount` USDC from the user's ATA into the vault and credit the
    /// user's `UserCollateral` ledger (lazily created on first deposit).
    pub fn deposit_collateral<'info>(
        ctx: Context<'info, DepositCollateral<'info>>,
        amount: u64,
    ) -> Result<()> {
        require!(amount != 0, FructusError::InvalidSize);
        require!(
            !ctx.accounts.vault.data_is_empty(),
            FructusError::VaultNotInitialized
        );

        // Lazily create the per-(market, user) ledger on first deposit.
        let was_empty = ctx.accounts.user_collateral.data_is_empty();
        if was_empty {
            let rent = Rent::get()?;
            let space = 8 + UserCollateral::LEN;
            let market_key = ctx.accounts.market.key();
            let user_key = ctx.accounts.user.key();
            let bump = ctx.bumps.user_collateral;
            let seeds: &[&[u8]] = &[
                USER_COLLATERAL_SEED,
                market_key.as_ref(),
                user_key.as_ref(),
                &[bump],
            ];
            system_program::create_account(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::CreateAccount {
                        from: ctx.accounts.user.to_account_info(),
                        to: ctx.accounts.user_collateral.to_account_info(),
                    },
                )
                .with_signer(&[seeds]),
                rent.minimum_balance(space),
                space as u64,
                &crate::ID,
            )?;
        }

        // Move `amount` USDC from the user's ATA into the vault (user signs).
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token::Transfer {
                    from: ctx.accounts.user_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // Credit the ledger with checked arithmetic (atomic: any error unwinds).
        let mut user_collateral =
            Account::<UserCollateral>::try_from_unchecked(ctx.accounts.user_collateral.as_ref())?;
        user_collateral.bump = ctx.bumps.user_collateral;
        if was_empty {
            // [fix A] a fresh ledger starts with no pending claim.
            user_collateral.claimable = 0;
        }
        // [fix A] Convert any funded pending claim into deposited first (claims
        // are only usable through claim payout), then credit the fresh deposit.
        let (claimed_deposited, new_claimable, new_pool) = settlement::claim_payout(
            user_collateral.deposited,
            user_collateral.claimable,
            ctx.accounts.market.pnl_pool,
        )
        .ok_or(FructusError::ArithmeticOverflow)?;
        let deposited = collateral::deposit(claimed_deposited, amount)
            .ok_or(FructusError::ArithmeticOverflow)?;
        user_collateral.deposited = deposited;
        user_collateral.claimable = new_claimable;
        ctx.accounts.market.pnl_pool = new_pool;
        user_collateral.exit(&crate::ID)?;

        Ok(())
    }

    /// Withdraw `amount` USDC from the vault to the user's ATA, gated by the
    /// free-collateral seam (`amount <= deposited - reserved`) AND the
    /// account-level equity gate (`equity - amount >= reserved`, where
    /// `equity = deposited + Σ upnl` over both sides; REQ-A2-3/D9).
    pub fn withdraw_collateral<'info>(
        ctx: Context<'info, WithdrawCollateral<'info>>,
        amount: u64,
    ) -> Result<()> {
        require!(amount != 0, FructusError::InvalidSize);
        require!(
            !ctx.accounts.vault.data_is_empty(),
            FructusError::VaultNotInitialized
        );

        let user_collateral = &mut ctx.accounts.user_collateral;

        // [fix A] Convert any funded pending claim into deposited BEFORE the
        // free-seam check, so claims become withdrawable collateral (a claim is
        // never directly withdrawable — only through claim payout against the
        // pool).
        let (claimed_deposited, new_claimable, new_pool) = settlement::claim_payout(
            user_collateral.deposited,
            user_collateral.claimable,
            ctx.accounts.market.pnl_pool,
        )
        .ok_or(FructusError::ArithmeticOverflow)?;
        user_collateral.deposited = claimed_deposited;
        user_collateral.claimable = new_claimable;
        ctx.accounts.market.pnl_pool = new_pool;

        // Σ unrealized PnL (index-based) over both of the user's sides — the
        // equity half of the withdraw gate (REQ-A2-3): a pristine/closed side
        // contributes zero.
        let market_key = ctx.accounts.market.key();
        let user_key = ctx.accounts.user.key();
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let pnl_sum = side_unrealized_pnl(
            &ctx.accounts.position_long,
            &market_key,
            &user_key,
            positions::PositionSide::Long,
            &rate,
        )?
        .checked_add(side_unrealized_pnl(
            &ctx.accounts.position_short,
            &market_key,
            &user_key,
            positions::PositionSide::Short,
            &rate,
        )?)
        .ok_or(FructusError::ArithmeticOverflow)?;

        // Enforce the free-collateral seam (`amount <= deposited - reserved`)
        // plus the equity gate (`equity - amount >= reserved`), computing the
        // post-withdraw balance up front so the ledger is debited only after
        // the transfer.
        let new_deposited = collateral::withdraw(
            user_collateral.deposited,
            user_collateral.reserved,
            pnl_sum,
            amount,
        )
        .ok_or(FructusError::InsufficientFreeCollateral)?;

        // Move `amount` USDC from the vault to the user's ATA (vault PDA signs).
        let bump = ctx.bumps.vault;
        let seeds: &[&[u8]] = &[VAULT_SEED, &[bump]];
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
            )
            .with_signer(&[seeds]),
            amount,
        )?;

        user_collateral.deposited = new_deposited;

        Ok(())
    }

    /// Delegate (or rotate / revoke) the `operator` key for the signer's
    /// `(market, user)` record: `Pubkey::default()` stores the revoke state.
    ///
    /// Lazily creates the record on the first call (payer = user, rent-exempt,
    /// `8 + Operator::LEN`, bump stored); an existing program-owned record is
    /// overwritten (rotate) and the revoke state writes like any other
    /// delegation — the account is never closed. A non-program-owned,
    /// non-pristine account squatting the PDA is rejected with
    /// [`FructusError::OperatorPdaSquatted`] and never reclaimed: Solana
    /// forbids a program from mutating an account it does not own.
    pub fn set_operator<'info>(
        ctx: Context<'info, SetOperator<'info>>,
        operator: Pubkey,
    ) -> Result<()> {
        let record_info = &ctx.accounts.operator_record;
        let market_key = ctx.accounts.market.key();
        let user_key = ctx.accounts.user.key();

        // "Needs creation" means the PDA is still a pristine system account —
        // empty data, system-owned, zero lamports (F5): an attacker-created
        // account at the PDA (with data, or rent-funded but empty) must not be
        // mistaken for never-created.
        if record_info.data_is_empty()
            && record_info.owner == &system_program::ID
            && record_info.lamports() == 0
        {
            let rent = Rent::get()?;
            let space = 8 + Operator::LEN;
            let bump = ctx.bumps.operator_record;
            let seeds: &[&[u8]] = &[
                OPERATOR_SEED,
                market_key.as_ref(),
                user_key.as_ref(),
                &[bump],
            ];
            system_program::create_account(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::CreateAccount {
                        from: ctx.accounts.user.to_account_info(),
                        to: record_info.to_account_info(),
                    },
                )
                .with_signer(&[seeds]),
                rent.minimum_balance(space),
                space as u64,
                &crate::ID,
            )?;
        } else if record_info.owner != &crate::ID {
            // A non-program-owned squat of the record PDA: reject with the
            // dedicated error so the brick is diagnosable instead of surfacing
            // as a generic owner mismatch.
            return Err(FructusError::OperatorPdaSquatted.into());
        }

        // Create / rotate / revoke: always (re)write the full record. Revoke
        // is the all-default `operator` field — the record account is kept.
        let mut record = Account::<Operator>::try_from_unchecked(record_info.as_ref())?;
        record.market = market_key;
        record.user = user_key;
        record.operator = operator;
        record.bump = ctx.bumps.operator_record;
        record.exit(&crate::ID)?;
        Ok(())
    }

    /// Operator-signed deposit: move `amount` USDC from the subject `user`'s
    /// ATA into the vault (the bound `Operator` PDA as the SPL delegate) and
    /// credit the subject's ledger — no user signature (D4).
    ///
    /// Mirrors the direct `deposit_collateral` exactly: the ledger is lazily
    /// created on first deposit (payer = operator signer), any funded pending
    /// claim is converted first (`claim_payout`), the credit is checked
    /// arithmetic and the vault transfer is signed by the Operator PDA via
    /// `invoke_signed` (the SPL delegate the user approved at bind time). The
    /// signer must be the record's live delegate (`OperatorUnauthorized`
    /// otherwise); a missing/short SPL approval propagates the token
    /// program's error and no ledger mutation persists.
    pub fn operator_deposit_collateral<'info>(
        ctx: Context<'info, OperatorDepositCollateral<'info>>,
        amount: u64,
    ) -> Result<()> {
        let (record_operator, record_market, record_user) =
            operator_record_fields(&ctx.accounts.operator_record)?;
        let signer = ctx.accounts.operator.key();
        let market_key = ctx.accounts.market.key();
        let user_key = ctx.accounts.user.key();
        if !crate::operator::authorized(
            &signer,
            &record_operator,
            &record_market,
            &record_user,
            &market_key,
            &user_key,
        ) {
            return Err(FructusError::OperatorUnauthorized.into());
        }

        require!(amount != 0, FructusError::InvalidSize);
        require!(
            !ctx.accounts.vault.data_is_empty(),
            FructusError::VaultNotInitialized
        );

        // `user_ata` is an `UncheckedAccount` in this struct (the account set
        // mirrors the PRD Appendix), so the mint + subject-owner binding the
        // direct path expresses with Anchor constraints is validated in-handler
        // before any transfer.
        let user_ata = Account::<TokenAccount>::try_from(ctx.accounts.user_ata.as_ref())?;
        require!(
            user_ata.mint == ctx.accounts.market.collateral_mint,
            FructusError::InvalidMint
        );
        if user_ata.owner != user_key {
            return Err(ProgramError::InvalidAccountData.into());
        }

        // Lazily create the per-(market, user) ledger on first deposit
        // (payer = operator signer, mirroring `deposit_collateral`).
        let was_empty = ctx.accounts.user_collateral.data_is_empty();
        if was_empty {
            let rent = Rent::get()?;
            let space = 8 + UserCollateral::LEN;
            let bump = ctx.bumps.user_collateral;
            let seeds: &[&[u8]] = &[
                USER_COLLATERAL_SEED,
                market_key.as_ref(),
                user_key.as_ref(),
                &[bump],
            ];
            system_program::create_account(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::CreateAccount {
                        from: ctx.accounts.operator.to_account_info(),
                        to: ctx.accounts.user_collateral.to_account_info(),
                    },
                )
                .with_signer(&[seeds]),
                rent.minimum_balance(space),
                space as u64,
                &crate::ID,
            )?;
        }

        // Move `amount` USDC from the subject's ATA into the vault, signed by
        // the Operator PDA (the SPL delegate approved by the subject at bind
        // time).
        let bump = ctx.bumps.operator_record;
        let seeds: &[&[u8]] = &[
            OPERATOR_SEED,
            market_key.as_ref(),
            user_key.as_ref(),
            &[bump],
        ];
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token::Transfer {
                    from: ctx.accounts.user_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.operator_record.to_account_info(),
                },
            )
            .with_signer(&[seeds]),
            amount,
        )?;

        // Credit the subject's ledger (claim-payout then checked credit);
        // atomic — any error unwinds the whole instruction.
        let mut user_collateral =
            Account::<UserCollateral>::try_from_unchecked(ctx.accounts.user_collateral.as_ref())?;
        user_collateral.bump = ctx.bumps.user_collateral;
        if was_empty {
            // [fix A] a fresh ledger starts with no pending claim.
            user_collateral.claimable = 0;
        }
        let (claimed_deposited, new_claimable, new_pool) = settlement::claim_payout(
            user_collateral.deposited,
            user_collateral.claimable,
            ctx.accounts.market.pnl_pool,
        )
        .ok_or(FructusError::ArithmeticOverflow)?;
        let deposited = collateral::deposit(claimed_deposited, amount)
            .ok_or(FructusError::ArithmeticOverflow)?;
        user_collateral.deposited = deposited;
        user_collateral.claimable = new_claimable;
        ctx.accounts.market.pnl_pool = new_pool;
        user_collateral.exit(&crate::ID)?;

        Ok(())
    }

    /// Operator-signed withdrawal: pay `amount` USDC from the vault to the
    /// subject `user`'s own ATA only (mint + owner checked in-handler; D5),
    /// gated by the same equity gate as the direct path.
    ///
    /// Mirrors the direct `withdraw_collateral`: any funded pending claim is
    /// converted first, the `Σ upnl` over the subject's two sides (pristine /
    /// closed ⇒ zero) is passed to [`collateral::withdraw`] together with the
    /// ledger's `reserved`, and the vault → subject transfer is signed by the
    /// vault PDA. The operator can never redirect funds: the destination must
    /// be the subject's own token account for the market's collateral mint.
    pub fn operator_withdraw_collateral<'info>(
        ctx: Context<'info, OperatorWithdrawCollateral<'info>>,
        amount: u64,
    ) -> Result<()> {
        let (record_operator, record_market, record_user) =
            operator_record_fields(&ctx.accounts.operator_record)?;
        let signer = ctx.accounts.operator.key();
        let market_key = ctx.accounts.market.key();
        let user_key = ctx.accounts.user.key();
        if !crate::operator::authorized(
            &signer,
            &record_operator,
            &record_market,
            &record_user,
            &market_key,
            &user_key,
        ) {
            return Err(FructusError::OperatorUnauthorized.into());
        }

        require!(amount != 0, FructusError::InvalidSize);
        require!(
            !ctx.accounts.vault.data_is_empty(),
            FructusError::VaultNotInitialized
        );

        // The destination must be the SUBJECT's own token account for the
        // market's collateral mint: tokens can never reach a foreign account.
        // `user_ata` is an `UncheckedAccount` in this struct (the account set
        // mirrors the PRD Appendix), so the binding is validated in-handler
        // before any transfer.
        let user_ata = Account::<TokenAccount>::try_from(ctx.accounts.user_ata.as_ref())?;
        require!(
            user_ata.mint == ctx.accounts.market.collateral_mint,
            FructusError::InvalidMint
        );
        if user_ata.owner != user_key {
            return Err(ProgramError::InvalidAccountData.into());
        }

        let user_collateral = &mut ctx.accounts.user_collateral;

        // [fix A] Convert any funded pending claim into deposited BEFORE the
        // gate, so claims become withdrawable collateral (mirrors the direct
        // path).
        let (claimed_deposited, new_claimable, new_pool) = settlement::claim_payout(
            user_collateral.deposited,
            user_collateral.claimable,
            ctx.accounts.market.pnl_pool,
        )
        .ok_or(FructusError::ArithmeticOverflow)?;
        user_collateral.deposited = claimed_deposited;
        user_collateral.claimable = new_claimable;
        ctx.accounts.market.pnl_pool = new_pool;

        // Σ unrealized PnL (index-based) over both of the subject's sides —
        // the equity half of the withdraw gate (REQ-A2-3).
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let pnl_sum = side_unrealized_pnl(
            &ctx.accounts.position_long,
            &market_key,
            &user_key,
            positions::PositionSide::Long,
            &rate,
        )?
        .checked_add(side_unrealized_pnl(
            &ctx.accounts.position_short,
            &market_key,
            &user_key,
            positions::PositionSide::Short,
            &rate,
        )?)
        .ok_or(FructusError::ArithmeticOverflow)?;

        // Enforce the free-collateral seam + equity gate, computing the
        // post-withdraw balance up front so the ledger is debited only after
        // the transfer.
        let new_deposited = collateral::withdraw(
            user_collateral.deposited,
            user_collateral.reserved,
            pnl_sum,
            amount,
        )
        .ok_or(FructusError::InsufficientFreeCollateral)?;

        // Move `amount` USDC from the vault to the subject's ATA (the vault
        // PDA signs, mirroring the direct path).
        let bump = ctx.bumps.vault;
        let seeds: &[&[u8]] = &[VAULT_SEED, &[bump]];
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
            )
            .with_signer(&[seeds]),
            amount,
        )?;

        user_collateral.deposited = new_deposited;

        Ok(())
    }

    /// Operator-signed open: open a position on `side` (0 = Long, 1 = Short)
    /// for the subject `user` by routing an order through the CLOB, with the
    /// operator as the only signer (D2) — same core logic as the direct
    /// `open_position`; the position is attributed to the subject
    /// (`position.owner = user`).
    ///
    /// Mirrors the direct handler exactly: the order carries the subject as
    /// its owner, the position PDA is the subject's (lazily created on first
    /// fill, payer = operator signer), the subject's ledger must pre-exist
    /// (`InsufficientFreeCollateral` otherwise) and the taker fills settle
    /// inline against the subject's notional / entry sums / reserved margin.
    pub fn operator_open_position<'info>(
        ctx: Context<'info, OperatorOpenPosition<'info>>,
        side: u8,
        size: u64,
        price: u64,
    ) -> Result<()> {
        positions::validate_open_args(side, size)?;
        let (record_operator, record_market, record_user) =
            operator_record_fields(&ctx.accounts.operator_record)?;
        let signer = ctx.accounts.operator.key();
        let market_key = ctx.accounts.market.key();
        let user_key = ctx.accounts.user.key();
        if !crate::operator::authorized(
            &signer,
            &record_operator,
            &record_market,
            &record_user,
            &market_key,
            &user_key,
        ) {
            return Err(FructusError::OperatorUnauthorized.into());
        }

        let side = side_from_u8(side)?;
        // Everything is attributed to the SUBJECT: the order owner, the
        // position PDA seed and the margin ledger.
        let owner = user_key;
        // The index snapshot is read once per tx (same slot ⇒ same rate) and
        // stamped onto every Fill this order produces (FR-6/D8).
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        let mut book = load_book(&account);
        let seq = take_next_seq(&mut book)?;
        let incoming = orderbook::Order {
            owner,
            side,
            price,
            size,
            seq,
        };
        let fills = match_open_taker(
            &mut account,
            &mut book,
            incoming,
            rate.total_lamports,
            rate.pool_token_supply,
        )?;

        if !fills.is_empty() {
            // Lazily create the subject's per-(market, user, side) `Position`
            // on first fill (mirror `open_position`; payer = operator signer).
            // "Needs creation" means the PDA is still a pristine system
            // account — empty data, system-owned, zero lamports (F5).
            if ctx.accounts.position.data_is_empty()
                && ctx.accounts.position.owner == &system_program::ID
                && ctx.accounts.position.lamports() == 0
            {
                let rent = Rent::get()?;
                let space = 8 + Position::LEN;
                let side_byte = side_to_u8(side);
                let bump = ctx.bumps.position;
                let seeds: &[&[u8]] = &[
                    POSITION_SEED,
                    market_key.as_ref(),
                    owner.as_ref(),
                    &[side_byte],
                    &[bump],
                ];
                system_program::create_account(
                    CpiContext::new(
                        ctx.accounts.system_program.key(),
                        system_program::CreateAccount {
                            from: ctx.accounts.operator.to_account_info(),
                            to: ctx.accounts.position.to_account_info(),
                        },
                    )
                    .with_signer(&[seeds]),
                    rent.minimum_balance(space),
                    space as u64,
                    &crate::ID,
                )?;
            } else if ctx.accounts.position.owner != &crate::ID {
                return Err(FructusError::PositionPdaSquatted.into());
            }

            // The ledger must pre-exist (D13): a missing `UserCollateral` is a
            // free-collateral error (REQ-7), not an account-format error.
            require!(
                !ctx.accounts.user_collateral.data_is_empty(),
                FructusError::InsufficientFreeCollateral
            );

            // Settle the taker's fills inline (D2) on the SUBJECT's position +
            // ledger: notional, entry sums, and reserved margin update
            // atomically or the tx reverts.
            let mut position =
                Account::<Position>::try_from_unchecked(ctx.accounts.position.as_ref())?;
            position.bump = ctx.bumps.position;
            position.market = market_key;
            position.owner = owner;
            position.side = side_to_u8(side);
            let mut user_collateral = Account::<UserCollateral>::try_from_unchecked(
                ctx.accounts.user_collateral.as_ref(),
            )?;
            apply_open_fills(
                &mut position,
                &mut user_collateral,
                ctx.accounts.market.initial_margin_bps,
                &fills,
                rate.total_lamports,
                rate.pool_token_supply,
                now_slot,
                ctx.accounts.market.funding_epoch_slots,
            )?;
            position.exit(&crate::ID)?;
            user_collateral.exit(&crate::ID)?;
        }

        save_book(&mut account, &book);
        record_observation(&mut account, orderbook::mid(&book), now_slot);
        Ok(())
    }

    /// Operator-signed close: close `size` of the subject's position on `side`
    /// (0 = Long, 1 = Short), with the operator as the only signer (D2) — same
    /// core logic as the direct `close_position`.
    ///
    /// Mirrors the direct handler exactly: the market-IOC order on the
    /// opposite side is attributed to the subject, the position must be a live
    /// program-owned account (`PositionNotFound` / `PositionPdaSquatted`), and
    /// the subject's ledger releases the margin of the closed notional.
    pub fn operator_close_position<'info>(
        ctx: Context<'info, OperatorClosePosition<'info>>,
        side: u8,
        size: u64,
    ) -> Result<()> {
        require!(size != 0, FructusError::InvalidSize);
        let (record_operator, record_market, record_user) =
            operator_record_fields(&ctx.accounts.operator_record)?;
        let signer = ctx.accounts.operator.key();
        let market_key = ctx.accounts.market.key();
        let user_key = ctx.accounts.user.key();
        if !crate::operator::authorized(
            &signer,
            &record_operator,
            &record_market,
            &record_user,
            &market_key,
            &user_key,
        ) {
            return Err(FructusError::OperatorUnauthorized.into());
        }

        let side = side_from_u8(side)?;
        let owner = user_key;
        // The index snapshot is read once per tx and stamped onto every Fill
        // this order produces (FR-6/D8).
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        // The position must exist and be live before any book mutation (FR-4).
        // "Exists" means a real program-owned `Position` account: a
        // system-owned squat at the PDA is distinguished from a never-opened
        // position with the dedicated `PositionPdaSquatted` error (F2/F5).
        if ctx.accounts.position.owner != &crate::ID {
            if ctx.accounts.position.data_is_empty() {
                return Err(FructusError::PositionNotFound.into());
            }
            return Err(FructusError::PositionPdaSquatted.into());
        }
        let mut position = Account::<Position>::try_from_unchecked(ctx.accounts.position.as_ref())?;
        require!(position.notional > 0, FructusError::PositionNotFound);
        require!(size <= position.notional, FructusError::InvalidCloseSize);

        let mut book = load_book(&account);
        let seq = take_next_seq(&mut book)?;
        let incoming = orderbook::Order {
            owner,
            side: opposite(side),
            price: 0,
            size,
            seq,
        };
        // Market (IOC) on the opposite side: matches to exhaustion, remainder
        // cancelled, never posted (see `place_market_order`). Fills rest on
        // the position's own side, so their events carry `side` as the maker
        // side.
        let outcome =
            orderbook::match_order(&mut book, incoming, orderbook::OrderKind::Market, u64::MAX);
        emit_fill_events(
            &mut account,
            &outcome.fills,
            side,
            rate.total_lamports,
            rate.pool_token_supply,
        )?;

        if !outcome.fills.is_empty() {
            // The subject's ledger backs the position's reserved margin, so it
            // must exist; releasing reservation never fails (D11 exact-sum).
            let mut user_collateral = Account::<UserCollateral>::try_from_unchecked(
                ctx.accounts.user_collateral.as_ref(),
            )?;
            apply_close_fills(
                &mut position,
                &mut user_collateral,
                ctx.accounts.market.initial_margin_bps,
                &outcome.fills,
            )?;
            position.exit(&crate::ID)?;
            user_collateral.exit(&crate::ID)?;
        }

        save_book(&mut account, &book);
        record_observation(&mut account, orderbook::mid(&book), now_slot);
        Ok(())
    }

    /// Operator-signed limit order: post an order on `side` for the subject
    /// `user`, with the operator as the only signer (D2) — same core logic as
    /// the direct `place_limit_order`; the resting order is attributed to the
    /// subject (`order.owner = user`).
    pub fn operator_place_limit_order<'info>(
        ctx: Context<'info, OperatorPlaceLimitOrder<'info>>,
        side: u8,
        price: u64,
        size: u64,
    ) -> Result<()> {
        require!(price != 0, FructusError::InvalidPrice);
        require!(size != 0, FructusError::InvalidSize);
        let (record_operator, record_market, record_user) =
            operator_record_fields(&ctx.accounts.operator_record)?;
        let signer = ctx.accounts.operator.key();
        let market_key = ctx.accounts.market.key();
        let user_key = ctx.accounts.user.key();
        if !crate::operator::authorized(
            &signer,
            &record_operator,
            &record_market,
            &record_user,
            &market_key,
            &user_key,
        ) {
            return Err(FructusError::OperatorUnauthorized.into());
        }

        let side = side_from_u8(side)?;
        // The resting order is attributed to the SUBJECT.
        let owner = user_key;
        // The index snapshot is read once per tx (same slot ⇒ same rate) and
        // stamped onto every Fill this order produces (FR-6/D8).
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        let mut book = load_book(&account);
        let seq = take_next_seq(&mut book)?;
        let incoming = orderbook::Order {
            owner,
            side,
            price,
            size,
            seq,
        };

        if !orderbook::would_cross(&book, &incoming) {
            // Non-crossing: rest at the limit price.
            orderbook::post_limit(&mut book, incoming)?;
            save_book(&mut account, &book);
            record_observation(&mut account, orderbook::mid(&book), now_slot);
            return Ok(());
        }

        // Crossing: match inline; never rest a crossing order (mirrors the
        // direct handler).
        match_limit_taker(
            &mut account,
            &mut book,
            incoming,
            rate.total_lamports,
            rate.pool_token_supply,
        )?;
        save_book(&mut account, &book);
        record_observation(&mut account, orderbook::mid(&book), now_slot);
        Ok(())
    }

    /// Operator-signed market order: cross the opposite book for the subject
    /// `user` (IOC), with the operator as the only signer (D2) — same core
    /// logic as the direct `place_market_order`.
    pub fn operator_place_market_order<'info>(
        ctx: Context<'info, OperatorPlaceMarketOrder<'info>>,
        side: u8,
        size: u64,
    ) -> Result<()> {
        require!(size != 0, FructusError::InvalidSize);
        let (record_operator, record_market, record_user) =
            operator_record_fields(&ctx.accounts.operator_record)?;
        let signer = ctx.accounts.operator.key();
        let market_key = ctx.accounts.market.key();
        let user_key = ctx.accounts.user.key();
        if !crate::operator::authorized(
            &signer,
            &record_operator,
            &record_market,
            &record_user,
            &market_key,
            &user_key,
        ) {
            return Err(FructusError::OperatorUnauthorized.into());
        }

        let side = side_from_u8(side)?;
        // The taker fill events are attributed to the SUBJECT.
        let owner = user_key;
        // The index snapshot is read once per tx (same slot ⇒ same rate) and
        // stamped onto every Fill this order produces (FR-6/D8).
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        let mut book = load_book(&account);
        let seq = take_next_seq(&mut book)?;
        let incoming = orderbook::Order {
            owner,
            side,
            price: 0,
            size,
            seq,
        };
        let maker_side = opposite(side);

        // A market order matches to exhaustion (see `place_market_order` for
        // the budget reasoning); `Market` is IOC, so any unfilled remainder
        // (book exhausted) is simply cancelled, never posted.
        let outcome =
            orderbook::match_order(&mut book, incoming, orderbook::OrderKind::Market, u64::MAX);
        emit_fill_events(
            &mut account,
            &outcome.fills,
            maker_side,
            rate.total_lamports,
            rate.pool_token_supply,
        )?;

        save_book(&mut account, &book);
        record_observation(&mut account, orderbook::mid(&book), now_slot);
        Ok(())
    }

    /// Operator-signed cancel: cancel the subject's resting order `seq`, with
    /// the operator as the only signer (D2) — same core logic as the direct
    /// `cancel_order` (owner-only becomes operator-for-subject).
    ///
    /// Appends the subject-attributed `Cancel` event exactly like the direct
    /// `cancel_order` (event parity for indexers and consumers; AMEND-PV-1
    /// restored this after the W1 shard had omitted it to satisfy a
    /// frozen-test ring read — the test now reads the fill at its actual slot
    /// and pins the cancel event too).
    pub fn operator_cancel_order<'info>(
        ctx: Context<'info, OperatorCancelOrder<'info>>,
        seq: u64,
    ) -> Result<()> {
        let (record_operator, record_market, record_user) =
            operator_record_fields(&ctx.accounts.operator_record)?;
        let signer = ctx.accounts.operator.key();
        let market_key = ctx.accounts.market.key();
        let user_key = ctx.accounts.user.key();
        if !crate::operator::authorized(
            &signer,
            &record_operator,
            &record_market,
            &record_user,
            &market_key,
            &user_key,
        ) {
            return Err(FructusError::OperatorUnauthorized.into());
        }

        // Only the SUBJECT's resting orders can be cancelled.
        let owner = user_key;
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        let mut book = load_book(&account);
        let removed = orderbook::cancel(&mut book, owner, seq)?;

        append_event(
            &mut account,
            EVENT_KIND_CANCEL,
            owner,
            Pubkey::default(),
            side_to_u8(removed.side),
            removed.price,
            removed.size,
            0,
            0,
        );
        save_book(&mut account, &book);
        record_observation(&mut account, orderbook::mid(&book), now_slot);
        Ok(())
    }

    /// Open a position on `side` (0 = Long/Bid, 1 = Short/Ask) by routing an
    /// order through the CLOB. `price == 0` selects a market (IOC) order;
    /// `price > 0` selects a limit order that rests when non-crossing and
    /// cancels a budget-hit remainder (D10′). Taker fills settle inline: the
    /// position grows (`notional += fill.size`), the entry running sums
    /// accumulate the in-transaction index snapshot, and margin is reserved
    /// against the user's free collateral (REQ-3/REQ-7).
    pub fn open_position<'info>(
        ctx: Context<'info, OpenPosition<'info>>,
        side: u8,
        size: u64,
        price: u64,
    ) -> Result<()> {
        positions::validate_open_args(side, size)?;
        let side = side_from_u8(side)?;
        let owner = ctx.accounts.owner.key();
        // The index snapshot is read once per tx (same slot ⇒ same rate) and
        // stamped onto every Fill this order produces (FR-6/D8).
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        let mut book = load_book(&account);
        let seq = take_next_seq(&mut book)?;
        let incoming = orderbook::Order {
            owner,
            side,
            price,
            size,
            seq,
        };
        let fills = match_open_taker(
            &mut account,
            &mut book,
            incoming,
            rate.total_lamports,
            rate.pool_token_supply,
        )?;

        if !fills.is_empty() {
            // Lazily create the per-(market, user, side) `Position` on first
            // fill (mirror `deposit_collateral`; payer = user). "Needs
            // creation" means the PDA is still a pristine system account —
            // empty data, system-owned, zero lamports (F5): an
            // attacker-created account at the PDA (with data, or rent-funded
            // but empty) must not be mistaken for never-created.
            if ctx.accounts.position.data_is_empty()
                && ctx.accounts.position.owner == &system_program::ID
                && ctx.accounts.position.lamports() == 0
            {
                let rent = Rent::get()?;
                let space = 8 + Position::LEN;
                let market_key = ctx.accounts.market.key();
                let side_byte = side_to_u8(side);
                let bump = ctx.bumps.position;
                let seeds: &[&[u8]] = &[
                    POSITION_SEED,
                    market_key.as_ref(),
                    owner.as_ref(),
                    &[side_byte],
                    &[bump],
                ];
                system_program::create_account(
                    CpiContext::new(
                        ctx.accounts.system_program.key(),
                        system_program::CreateAccount {
                            from: ctx.accounts.owner.to_account_info(),
                            to: ctx.accounts.position.to_account_info(),
                        },
                    )
                    .with_signer(&[seeds]),
                    rent.minimum_balance(space),
                    space as u64,
                    &crate::ID,
                )?;
            } else if ctx.accounts.position.owner != &crate::ID {
                // F2: an account at the PDA that is neither pristine nor
                // program-owned is an attacker squat (system-owned, with data
                // or rent-funded): Solana forbids a program from mutating an
                // account it does not own, so the (market, user, side) can
                // never be reclaimed on-chain. Fail with the dedicated error
                // instead of the generic owner check, so the brick is
                // diagnosable (`reset_position` reports the same error and
                // reclaims program-owned stuck positions).
                return Err(FructusError::PositionPdaSquatted.into());
            }

            // The ledger must pre-exist (D13): a missing `UserCollateral` is a
            // free-collateral error (REQ-7), not an account-format error.
            require!(
                !ctx.accounts.user_collateral.data_is_empty(),
                FructusError::InsufficientFreeCollateral
            );

            // Settle the taker's fills inline (D2): notional, entry sums, and
            // reserved margin update atomically or the tx reverts.
            let mut position =
                Account::<Position>::try_from_unchecked(ctx.accounts.position.as_ref())?;
            position.bump = ctx.bumps.position;
            position.market = ctx.accounts.market.key();
            position.owner = owner;
            position.side = side_to_u8(side);
            let mut user_collateral = Account::<UserCollateral>::try_from_unchecked(
                ctx.accounts.user_collateral.as_ref(),
            )?;
            apply_open_fills(
                &mut position,
                &mut user_collateral,
                ctx.accounts.market.initial_margin_bps,
                &fills,
                rate.total_lamports,
                rate.pool_token_supply,
                now_slot,
                ctx.accounts.market.funding_epoch_slots,
            )?;
            position.exit(&crate::ID)?;
            user_collateral.exit(&crate::ID)?;
        }

        save_book(&mut account, &book);
        record_observation(&mut account, orderbook::mid(&book), now_slot);
        Ok(())
    }

    /// Close `size` of the position on `side` (0 = Long, 1 = Short) by placing
    /// a **market-IOC order on the opposite side** (an ask closes a long, a
    /// bid closes a short) — never rests (D5). Fills reduce the position
    /// (`notional -= fill.size`, never below zero), recompute collateral down
    /// (releasing reserved margin), and leave the entry sums unchanged; no PnL
    /// settlement (D4). `size == 0` → `InvalidSize`; no live position →
    /// `PositionNotFound`; `size > notional` → `InvalidCloseSize` (REQ-4).
    pub fn close_position<'info>(
        ctx: Context<'info, ClosePosition<'info>>,
        side: u8,
        size: u64,
    ) -> Result<()> {
        require!(size != 0, FructusError::InvalidSize);
        let side = side_from_u8(side)?;
        let owner = ctx.accounts.owner.key();
        // The index snapshot is read once per tx and stamped onto every Fill
        // this order produces (FR-6/D8), so the opposite-side makers can later
        // settle at the fill-time index.
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        // The position must exist and be live before any book mutation (FR-4).
        // "Exists" means a real program-owned `Position` account: an
        // attacker-squatted system account with data at the PDA must not pass
        // the gate (F5) — `try_from_unchecked` would otherwise fail the owner
        // check and brick the close, freezing the reserved margin. F2: a squat
        // is distinguished from a never-opened position with the dedicated
        // `PositionPdaSquatted` error (Solana forbids the program from
        // reclaiming an account it does not own; `reset_position` reports the
        // same error and reclaims program-owned stuck positions).
        if ctx.accounts.position.owner != &crate::ID {
            if ctx.accounts.position.data_is_empty() {
                return Err(FructusError::PositionNotFound.into());
            }
            return Err(FructusError::PositionPdaSquatted.into());
        }
        let mut position = Account::<Position>::try_from_unchecked(ctx.accounts.position.as_ref())?;
        require!(position.notional > 0, FructusError::PositionNotFound);
        require!(size <= position.notional, FructusError::InvalidCloseSize);

        let mut book = load_book(&account);
        let seq = take_next_seq(&mut book)?;
        let incoming = orderbook::Order {
            owner,
            side: opposite(side),
            price: 0,
            size,
            seq,
        };
        // Market (IOC) on the opposite side: matches to exhaustion, remainder
        // cancelled, never posted (see `place_market_order` for the budget
        // reasoning). Fills rest on the position's own side, so their events
        // carry `side` as the maker side.
        let outcome =
            orderbook::match_order(&mut book, incoming, orderbook::OrderKind::Market, u64::MAX);
        emit_fill_events(
            &mut account,
            &outcome.fills,
            side,
            rate.total_lamports,
            rate.pool_token_supply,
        )?;

        if !outcome.fills.is_empty() {
            // The ledger backs the position's reserved margin, so it must
            // exist; releasing reservation never fails (D11 exact-sum).
            let mut user_collateral = Account::<UserCollateral>::try_from_unchecked(
                ctx.accounts.user_collateral.as_ref(),
            )?;
            apply_close_fills(
                &mut position,
                &mut user_collateral,
                ctx.accounts.market.initial_margin_bps,
                &outcome.fills,
            )?;
            position.exit(&crate::ID)?;
            user_collateral.exit(&crate::ID)?;
        }

        save_book(&mut account, &book);
        record_observation(&mut account, orderbook::mid(&book), now_slot);
        Ok(())
    }

    /// Permissionless maker-side settlement: book one resting maker's `Fill`
    /// from the event queue (REQ-5). `slot = seq % EVENT_QUEUE_LEN`; an
    /// already-settled `Fill` is an idempotent no-op, a stale slot or non-Fill
    /// event is `EventNotFound`. The maker's `Position` / `UserCollateral`
    /// PDAs are derived from the event's `owner` + `side` and verified
    /// byte-for-byte (mismatch → `ProgramError::InvalidAccountData`); a
    /// missing ledger is `InsufficientFreeCollateral` (D13). Open-intent:
    /// a closed position re-opens (`entry :=` event snapshot × size,
    /// `open_slot :=` now), a live position accumulates the event-carried
    /// snapshot; margin is reserved against the maker's free collateral and
    /// the event is marked settled only on success (retryable on shortfall).
    /// No `index_source`: the event carries the fill-time snapshot (REQ-6).
    pub fn settle_fill<'info>(ctx: Context<'info, SettleFill<'info>>, seq: u64) -> Result<()> {
        let market = &ctx.accounts.market;
        let mut account = ctx.accounts.order_book.load_mut()?;
        let now_slot = Clock::get()?.slot;

        let Some(event) = settle_event(&account, seq)? else {
            return Ok(()); // idempotent no-op (D9)
        };

        let position_bump = verify_maker_accounts(
            &market.key(),
            &event,
            &ctx.accounts.position.key(),
            &ctx.accounts.user_collateral.key(),
        )?;

        // The maker's ledger must pre-exist (D13): a missing `UserCollateral`
        // is a free-collateral error, not an account-format error.
        require!(
            !ctx.accounts.user_collateral.data_is_empty(),
            FructusError::InsufficientFreeCollateral
        );

        // Lazily create the maker's `Position` on first settlement
        // (payer = cranker, D13). "Needs creation" means the PDA is still a
        // pristine system account — empty data, system-owned, zero lamports
        // (F5): an attacker-created account at the PDA (with data, or
        // rent-funded but empty) must not be mistaken for never-created.
        if ctx.accounts.position.data_is_empty()
            && ctx.accounts.position.owner == &system_program::ID
            && ctx.accounts.position.lamports() == 0
        {
            let rent = Rent::get()?;
            let space = 8 + Position::LEN;
            let market_key = market.key();
            let seeds: &[&[u8]] = &[
                POSITION_SEED,
                market_key.as_ref(),
                event.owner.as_ref(),
                &[event.side],
                &[position_bump],
            ];
            system_program::create_account(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::CreateAccount {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.position.to_account_info(),
                    },
                )
                .with_signer(&[seeds]),
                rent.minimum_balance(space),
                space as u64,
                &crate::ID,
            )?;
        } else if ctx.accounts.position.owner != &crate::ID {
            // F2: an account at the PDA that is neither pristine nor
            // program-owned is an attacker squat (system-owned, with data or
            // rent-funded): Solana forbids a program from mutating an account
            // it does not own, so the (market, user, side) can never be
            // reclaimed on-chain — fail with the dedicated error so the brick
            // is diagnosable (`reset_position` reports the same error and
            // reclaims program-owned stuck positions).
            return Err(FructusError::PositionPdaSquatted.into());
        }

        let mut position = Account::<Position>::try_from_unchecked(ctx.accounts.position.as_ref())?;
        position.bump = position_bump;
        position.market = market.key();
        position.owner = event.owner;
        position.side = event.side;
        let mut user_collateral =
            Account::<UserCollateral>::try_from_unchecked(ctx.accounts.user_collateral.as_ref())?;

        // Open-intent maker settlement: the event carries the fill-time
        // snapshot (D7); re-open resets, live positions accumulate (D6).
        let fill = [orderbook::Fill {
            maker_seq: event.seq,
            maker_owner: event.owner,
            taker_owner: event.counterparty,
            size: event.size,
            price: event.price,
        }];
        apply_open_fills(
            &mut position,
            &mut user_collateral,
            market.initial_margin_bps,
            &fill,
            event.entry_total_lamports,
            event.entry_pool_token_supply,
            now_slot,
            market.funding_epoch_slots,
        )?;

        position.exit(&crate::ID)?;
        user_collateral.exit(&crate::ID)?;

        // Mark settled — only on success, so a margin shortfall leaves the
        // event un-settled and retryable (FR-5).
        account.events[(seq % EVENT_QUEUE_LEN as u64) as usize].settled = 1;
        Ok(())
    }

    /// Position-PDA recovery (F2): reset a **closed** (`notional == 0`)
    /// `Position` in place — zeroing its fields so the next `open_position` /
    /// `settle_fill` lazy-create gate starts fresh — and reject anything else
    /// with a dedicated, diagnosable error.
    ///
    /// * Program-owned, closed position → reset (fields zeroed in place; the
    ///   account stays program-owned and rent-funded, so no lamport moves).
    /// * Program-owned, LIVE position (`notional > 0`) → `PositionNotFound`:
    ///   a live position must be unwound through `close_position`, which
    ///   releases its reserved margin; resetting it here would orphan the
    ///   ledger reservation.
    /// * System-owned account at the PDA (an attacker squat) →
    ///   `PositionPdaSquatted`: Solana's ownership rule forbids a program from
    ///   mutating an account it does not own, so a squat is permanently
    ///   unreclaimable on-chain — the dedicated error makes the brick
    ///   diagnosable (the `open_position` / `settle_fill` create-gates return
    ///   the same error).
    ///
    /// Owner-gated: only the position's user may reclaim their own dormant
    /// PDA (the `user` signer is bound into the PDA seed).
    pub fn reset_position<'info>(
        ctx: Context<'info, ResetPosition<'info>>,
        side: u8,
    ) -> Result<()> {
        let _side = side_from_u8(side)?;
        require!(
            ctx.accounts.position.owner == &crate::ID,
            FructusError::PositionPdaSquatted
        );
        let mut position = Account::<Position>::try_from_unchecked(ctx.accounts.position.as_ref())?;
        require!(position.notional == 0, FructusError::PositionNotFound);
        // Zero every field in place (fixed borsh layout). The retained
        // closed-position convention (entry sums / open_slot) is intentionally
        // cleared — the next open/settle re-open resets them anyway.
        position.market = Pubkey::default();
        position.owner = Pubkey::default();
        position.side = 0;
        position.notional = 0;
        position.entry_n_sum = 0;
        position.entry_d_sum = 0;
        position.collateral = 0;
        position.last_funding_epoch = 0;
        position.closed_notional = 0;
        position.closed_entry_n_sum = 0;
        position.closed_entry_d_sum = 0;
        position.open_slot = 0;
        position.exit(&crate::ID)?;
        Ok(())
    }

    /// Permissionless: realize the **signed** realized-yield PnL of the notional
    /// a position has closed (issue #7, R-S2/R-S3).
    ///
    /// `close_position` is lifecycle-only (D4): it reduces `notional`, releases
    /// margin, and records the closed amount in `Position.closed_notional` (and
    /// its entry basis in `closed_entry_n_sum`/`closed_entry_d_sum`) but settles
    /// nothing. `settle_close` settles that notional against its **close-time**
    /// entry basis (`positions::pnl`, trustless via the recorded closed-entry
    /// running sums) against the market's live stake-pool index into the user's
    /// `UserCollateral.deposited`, then resets `closed_notional` and the
    /// closed-entry sums to `0`. It depends **only** on `exchange.rs` data — the
    /// recorded closed-entry sums + the current pool read — never the mark
    /// oracle (R-S2). A re-open (which resets the live entry sums) therefore
    /// never reframes the pending closed-notional PnL (R-S1).
    ///
    /// * `closed_notional == 0` is an idempotent no-op (R-S3).
    /// * The signed PnL is routed through the Design A PnL pool
    ///   ([`crate::settlement::settle_signed`]): a loss is collected into
    ///   `PerpMarket.pnl_pool` (clamped at `deposited`, so it never goes
    ///   negative — R-S3); a profit is paid only up to the pool, the unfunded
    ///   remainder becoming a pending `claimable` (never minted into
    ///   `deposited`).
    pub fn settle_close<'info>(ctx: Context<'info, SettleClose<'info>>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let position = &mut ctx.accounts.position;

        // Bind the supplied accounts to the market + the user's PDAs
        // (byte-level compare per AGENTS.md; `InvalidAccountData` on mismatch).
        require!(
            position.market == market.key(),
            FructusError::PositionNotFound
        );
        let side = positions::PositionSide::from_side_u8(position.side)
            .ok_or(ProgramError::InvalidAccountData)?;
        verify_collateral_pda(
            &market.key(),
            &position.owner,
            &ctx.accounts.user_collateral.key(),
        )?;

        let closed = position.closed_notional;
        if closed == 0 {
            return Ok(());
        }

        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let pnl = positions::pnl(
            position.closed_entry_n_sum,
            position.closed_entry_d_sum,
            rate.total_lamports,
            rate.pool_token_supply,
            closed,
            side,
        )
        .ok_or(FructusError::ArithmeticOverflow)?;
        // [fix A] Route through the PnL pool: a loser's debit is collected into
        // the pool, a winner's credit is paid only up to the pool (the remainder
        // becomes a pending claim) — never minted into `deposited`.
        let (new_deposited, new_claimable, new_pool) = settlement::settle_signed(
            ctx.accounts.user_collateral.deposited,
            ctx.accounts.user_collateral.claimable,
            market.pnl_pool,
            pnl,
        )
        .ok_or(FructusError::ArithmeticOverflow)?;
        ctx.accounts.user_collateral.deposited = new_deposited;
        ctx.accounts.user_collateral.claimable = new_claimable;
        market.pnl_pool = new_pool;
        position.closed_notional = 0;
        position.closed_entry_n_sum = 0;
        position.closed_entry_d_sum = 0;
        Ok(())
    }

    /// Permissionless per-position funding accrual (issue #6, R-F5).
    ///
    /// Settles `epochs = cur_epoch - position.last_funding_epoch` **full**
    /// elapsed epochs of funding for the position: the trustless on-chain
    /// `index` (`annualize` of the stake-pool `realized_yield` harness, from the
    /// market's last-settlement baseline `index_n/index_d` to the live pool
    /// rate), the `mark` (order-book `mid`, falling back to `index` so a
    /// one-sided/empty book yields `premium == 0`), the clamped
    /// [`funding::funding_rate`], and the signed
    /// [`funding::funding_payment`] applied to the user's collateral via the
    /// Design A PnL pool ([`crate::settlement::settle_signed`]) — a payer's
    /// debit is collected into `PerpMarket.pnl_pool`, a payee's credit is paid
    /// only up to the pool, the remainder becoming a pending claim (long flow
    /// negative on positive premium — R-F3).
    ///
    /// * `epochs == 0` is an idempotent no-op (re-settling the same epoch adds
    ///   nothing — R-F5).
    /// * On settlement the market baseline is advanced to the live pool rate and
    ///   [`PerpMarket::funding_accumulator`] accumulates the signed payment.
    ///
    /// [INFERRED]: the MVP applies the **current** funding rate to all elapsed
    /// epochs (not a per-epoch premium history) — a deterministic approximation
    /// the accumulator makes net-additive.
    pub fn settle_funding<'info>(ctx: Context<'info, SettleFunding<'info>>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let position = &mut ctx.accounts.position;

        require!(
            position.market == market.key(),
            FructusError::PositionNotFound
        );
        let side = positions::PositionSide::from_side_u8(position.side)
            .ok_or(ProgramError::InvalidAccountData)?;
        verify_collateral_pda(
            &market.key(),
            &position.owner,
            &ctx.accounts.user_collateral.key(),
        )?;

        let now_slot = Clock::get()?.slot;
        let cur_epoch = funding::funding_epoch(now_slot, market.funding_epoch_slots);
        let epochs = cur_epoch.saturating_sub(position.last_funding_epoch);
        if epochs == 0 {
            return Ok(()); // idempotent (R-F5)
        }

        // Trustless index: realized yield from the market's last-settlement
        // baseline to the live pool rate, annualized over the elapsed epochs.
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let elapsed_slots = epochs
            .checked_mul(market.funding_epoch_slots)
            .ok_or(FructusError::ArithmeticOverflow)?;
        let index = if market.index_d == 0 {
            // No baseline yet (first settlement): establish it now; no realized
            // yield to annualize, so `index == 0` (premium = mark - 0).
            0
        } else {
            let baseline = exchange::ExchangeRate {
                total_lamports: market.index_n,
                pool_token_supply: market.index_d,
            };
            let realized = baseline
                .realized_yield(&rate)
                .ok_or(FructusError::ArithmeticOverflow)?;
            exchange::annualize(realized, elapsed_slots, SLOTS_PER_YEAR)
                .ok_or(FructusError::ArithmeticOverflow)?
        };

        // Mark = order-book mid; fall back to index so a one-sided/empty book
        // yields premium == 0 (no funding) rather than a spurious spike.
        let order_book = ctx.accounts.order_book.load()?;
        let book = load_book(&order_book);
        let mark = orderbook::mid(&book).unwrap_or(index);

        let premium = funding::premium(mark, index);
        let funding_rate_value =
            funding::funding_rate(premium, market.funding_k, market.max_funding);
        let payment = funding::funding_payment(
            position.notional,
            funding_rate_value,
            epochs,
            funding::SideFlow::from_position_side(side),
        );

        // [fix A] Route the signed payment through the PnL pool: a payer's debit
        // is collected into the pool, a payee's credit is paid only up to the
        // pool (the remainder becomes a pending claim) — never minted.
        let (new_deposited, new_claimable, new_pool) = settlement::settle_signed(
            ctx.accounts.user_collateral.deposited,
            ctx.accounts.user_collateral.claimable,
            market.pnl_pool,
            payment,
        )
        .ok_or(FructusError::ArithmeticOverflow)?;
        ctx.accounts.user_collateral.deposited = new_deposited;
        ctx.accounts.user_collateral.claimable = new_claimable;
        market.pnl_pool = new_pool;
        position.last_funding_epoch = cur_epoch;
        market.funding_epoch = cur_epoch;
        market.index_n = rate.total_lamports;
        market.index_d = rate.pool_token_supply;
        market.funding_accumulator = market
            .funding_accumulator
            .checked_add(payment)
            .ok_or(FructusError::ArithmeticOverflow)?;
        Ok(())
    }

    /// Permissionless ACCOUNT-level liquidation (product-v2 A2, D8; supersedes
    /// the per-position engine of issue #8).
    ///
    /// Liquidates `amount` of the `side` position (`side` names the targeted
    /// account: `0` = Long, `1` = Short) of an account whose **account-level**
    /// health is below its total maintenance requirement:
    /// `equity < Σ_side margin_required(n_side, maintenance_bps)` (strict `<`).
    /// Both sides are read — `position` (the targeted side) and `other_position`
    /// (the opposite side's `Position` PDA; a pristine/missing side contributes
    /// zero). Unrealized PnL is **index-based** (trustless `positions::pnl` vs
    /// the live pool) — the health metric — while the order-book **TWAP** is the
    /// reserved liquidation reference price + the window/staleness guard
    /// (R-L1/R-L4): a book that does not reach back a full
    /// [`LIQUIDATION_TWAP_WINDOW`] yields no reference and the liquidation is
    /// refused. The trigger is a strict `<` — an exactly-maintained account is
    /// healthy.
    ///
    /// The liquidated notional releases its margin backing, paying a
    /// [`LIQUIDATION_PENALTY_BPS`] reward to the liquidator out of the targeted
    /// position's collateral (R-L3); the account's unrealized loss
    /// `max(0, −Σ upnl)` is booked into the PnL pool with the seam clamp
    /// (`deposited − reserved_after − reward`). `amount == notional` fully
    /// closes the targeted exposure. Neither partial nor full liquidations
    /// create value out of thin air.
    ///
    /// On success the handler writes the account-level transition:
    /// `position.collateral := min(m(n − amount, initial_margin_bps),
    /// position.collateral)` and `position.notional −= amount` on the targeted
    /// side (the `other_position` account is never touched), releases
    /// `position_collateral − remaining` from the victim's `reserved`, debits
    /// the victim's `deposited` by the booked loss + the reward, credits the
    /// pool with the booked loss and the liquidator's ledger with the reward.
    pub fn liquidate<'info>(
        ctx: Context<'info, Liquidate<'info>>,
        side: u8,
        amount: u64,
    ) -> Result<()> {
        // The instruction names the targeted side (0 = Long, 1 = Short).
        let side = positions::PositionSide::from_side_u8(side)
            .ok_or(ProgramError::InvalidInstructionData)?;
        let side_byte = match side {
            positions::PositionSide::Long => SIDE_BID,
            positions::PositionSide::Short => SIDE_ASK,
        };
        let other_side_byte = match side {
            positions::PositionSide::Long => SIDE_ASK,
            positions::PositionSide::Short => SIDE_BID,
        };

        let market = &ctx.accounts.market;
        let position = &ctx.accounts.position;

        require!(
            position.market == market.key(),
            FructusError::PositionNotFound
        );
        require!(position.notional > 0, FructusError::PositionNotFound);
        // The targeted position account must be the named side's PDA data
        // (market/owner/side self-describing, like the seed).
        if position.side != side_byte {
            return Err(ProgramError::InvalidAccountData.into());
        }
        verify_collateral_pda(
            &market.key(),
            &position.owner,
            &ctx.accounts.user_collateral.key(),
        )?;

        // `other_position` must byte-equal the OPPOSITE side's Position PDA
        // `[POSITION_SEED, market, position.owner, other_side]`. A pristine
        // (never-created) side contributes zero exposure; a system-owned account
        // with data (or rent) at the PDA is an attacker squat the program can
        // never reclaim (`PositionPdaSquatted`, F2/F5); a program-owned account
        // whose fields do not match the derivation is account-data corruption
        // (`InvalidAccountData`).
        let (other_pda, _) = Pubkey::find_program_address(
            &[
                POSITION_SEED,
                market.key().as_ref(),
                position.owner.as_ref(),
                &[other_side_byte],
            ],
            &crate::ID,
        );
        if other_pda.as_ref() != ctx.accounts.other_position.key().as_ref() {
            return Err(ProgramError::InvalidAccountData.into());
        }
        let other: Option<Account<'info, Position>> = if ctx.accounts.other_position.data_is_empty()
        {
            None // pristine/missing side: zero contribution
        } else if ctx.accounts.other_position.owner != &crate::ID {
            return Err(FructusError::PositionPdaSquatted.into());
        } else {
            let other =
                Account::<Position>::try_from_unchecked(ctx.accounts.other_position.as_ref())?;
            if other.market != market.key()
                || other.owner != position.owner
                || other.side != other_side_byte
            {
                return Err(ProgramError::InvalidAccountData.into());
            }
            Some(other)
        };
        let other_notional = other.as_ref().map(|o| o.notional).unwrap_or(0);

        // TWAP reference-price + window/staleness guard (R-L1/R-L4): a book that
        // does not reach back a full window has no liquidation reference.
        let now_slot = Clock::get()?.slot;
        let order_book = ctx.accounts.order_book.load()?;
        // The on-chain account stores `state::Observation` (raw `[u8;16]`
        // cumulative); the pure `orderbook::twap` works over its own lightweight
        // `orderbook::Observation`. Convert at the adapter boundary (only `slot`
        // and the decoded cumulative accumulator matter to the TWAP).
        let obs: Vec<orderbook::Observation> = order_book
            .observations
            .iter()
            .map(|o| orderbook::Observation {
                slot: o.slot,
                cumulative_mid: u128::from_le_bytes(o.cumulative_mid),
            })
            .collect();
        let twap = orderbook::twap(&obs, LIQUIDATION_TWAP_WINDOW, now_slot)
            .ok_or(FructusError::NotLiquidatable)?;
        let _reference_price = twap;

        // Health metric: index-based unrealized PnL summed over BOTH sides.
        let rate = read_stake_pool(&ctx.accounts.index_source)?;
        let pnl = positions::pnl(
            position.entry_n_sum,
            position.entry_d_sum,
            rate.total_lamports,
            rate.pool_token_supply,
            position.notional,
            side,
        )
        .ok_or(FructusError::ArithmeticOverflow)?;
        let other_pnl = match &other {
            // A pristine (missing) side contributes zero...
            None => 0i128,
            // ...and so does a closed (zero-notional) program-owned side.
            Some(other) if other.notional == 0 => 0i128,
            Some(other) => {
                let other_side = positions::PositionSide::from_side_u8(other.side)
                    .ok_or(ProgramError::InvalidAccountData)?;
                positions::pnl(
                    other.entry_n_sum,
                    other.entry_d_sum,
                    rate.total_lamports,
                    rate.pool_token_supply,
                    other.notional,
                    other_side,
                )
                .ok_or(FructusError::ArithmeticOverflow)?
            }
        };
        let pnl_sum = pnl
            .checked_add(other_pnl)
            .ok_or(FructusError::ArithmeticOverflow)?;

        // Account-level trigger (D8): equity below the TOTAL (both-side)
        // maintenance requirement; `None` (requirement overflow) is treated as
        // not-liquidatable (the old `.unwrap_or(false)` convention).
        let (n_long, n_short) = match side {
            positions::PositionSide::Long => (position.notional, other_notional),
            positions::PositionSide::Short => (other_notional, position.notional),
        };
        let account_liquidatable = liquidation::account_liquidatable(
            ctx.accounts.user_collateral.deposited,
            pnl_sum,
            n_long,
            n_short,
            market.maintenance_margin_bps,
        )
        .unwrap_or(false);
        require!(account_liquidatable, FructusError::NotLiquidatable);

        // Account-level transition (D8): release the targeted side's margin
        // backing at the INITIAL margin ratio via `apply_liquidation` (the
        // keeper of the `position.collateral == margin_required(notional,
        // initial_margin_bps)` invariant — `amount == 0` / `amount > notional`
        // are rejected there), pay the liquidator the penalty share of the
        // freed collateral, book the account loss `max(0, −Σ upnl)` into the
        // PnL pool with the `deposited − reserved_after − reward` seam clamp,
        // and debit the victim by the booked loss + the reward.
        let (remaining, reward) = liquidation::apply_liquidation(
            position.collateral,
            position.notional,
            amount,
            market.initial_margin_bps,
            LIQUIDATION_PENALTY_BPS,
        )
        .map_err(FructusError::from)?;
        let released = position.collateral.saturating_sub(remaining);
        // The surviving `reserved` is exactly Σ_side m(n_i, initial_margin_bps):
        // the targeted side keeps `remaining`, the other side is untouched.
        let reserved_after = ctx
            .accounts
            .user_collateral
            .reserved
            .checked_sub(released)
            .ok_or(FructusError::ArithmeticOverflow)?;
        let loss = liquidation::account_liquidation_loss(pnl_sum);
        let (victim_after_loss, booked) = settlement::apply_liquidation_loss(
            ctx.accounts.user_collateral.deposited,
            reserved_after,
            loss,
            reward,
        )
        .ok_or(FructusError::ArithmeticOverflow)?;
        let victim_after = victim_after_loss
            .checked_sub(reward)
            .ok_or(FructusError::ArithmeticOverflow)?;
        let pool_after = ctx
            .accounts
            .market
            .pnl_pool
            .checked_add(booked)
            .ok_or(FructusError::ArithmeticOverflow)?;
        let liquidator_after = ctx
            .accounts
            .liquidator_collateral
            .deposited
            .checked_add(reward)
            .ok_or(FructusError::ArithmeticOverflow)?;
        let surviving_notional = position
            .notional
            .checked_sub(amount)
            .ok_or(FructusError::ArithmeticOverflow)?;

        // Writes: the targeted position, the victim ledger (the released
        // backing + the booked loss + the reward), the pool credit, and the
        // liquidator's reward. The untargeted side's account is never touched.
        ctx.accounts.position.notional = surviving_notional;
        ctx.accounts.position.collateral = remaining;
        ctx.accounts.user_collateral.reserved = reserved_after;
        ctx.accounts.user_collateral.deposited = victim_after;
        ctx.accounts.market.pnl_pool = pool_after;
        ctx.accounts.liquidator_collateral.deposited = liquidator_after;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + YieldOracle::LEN,
        seeds = [ORACLE_SEED],
        bump
    )]
    pub oracle: Account<'info, YieldOracle>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + PerpMarket::LEN,
        seeds = [PERP_MARKET_SEED],
        bump
    )]
    pub market: Account<'info, PerpMarket>,
    /// CHECK: the handler validates owner == SPL Stake Pool program and
    /// account_type == StakePool before using it as the index source.
    pub index_source: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateApy<'info> {
    #[account(mut, seeds = [ORACLE_SEED], bump = oracle.bump)]
    pub oracle: Account<'info, YieldOracle>,
    /// CHECK: the instruction sysvar, used to introspect the ed25519 verify
    /// instruction. `load_instruction_at_checked` rejects a non-sysvar account.
    pub instruction_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(mut, seeds = [ORACLE_SEED], bump = oracle.bump, has_one = authority)]
    pub oracle: Account<'info, YieldOracle>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ReadExchangeRate<'info> {
    /// CHECK: the handler validates the owner (SPL Stake Pool program) and the
    /// `account_type == StakePool` discriminator before reading the fields.
    pub stake_pool: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitializeOrderBook<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + OrderBook::LEN,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    #[account(
        seeds = [PERP_MARKET_SEED],
        bump = market.bump,
        has_one = authority
    )]
    pub market: Account<'info, PerpMarket>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceLimitOrder<'info> {
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; its exchange-rate snapshot is stamped onto every Fill.
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct PlaceMarketOrder<'info> {
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; its exchange-rate snapshot is stamped onto every Fill.
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Crank<'info> {
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; its exchange-rate snapshot is stamped onto every Fill a
    /// resumed residual produces.
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeCollateralVault<'info> {
    #[account(
        seeds = [PERP_MARKET_SEED],
        bump = market.bump,
        has_one = authority
    )]
    pub market: Account<'info, PerpMarket>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the vault token-account PDA, system-created and initialized by
    /// CPI in the handler (authority = the vault itself).
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    /// CHECK: the per-(market, user) ledger, lazily created by the handler on
    /// first deposit.
    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_collateral: UncheckedAccount<'info>,
    /// CHECK: the vault token account (authority = the vault PDA); the handler
    /// rejects an uninitialized vault with `VaultNotInitialized` before use.
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = user
    )]
    pub user_ata: Account<'info, TokenAccount>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_collateral: Account<'info, UserCollateral>,
    /// CHECK: the vault token account (authority = the vault PDA); the handler
    /// rejects an uninitialized vault with `VaultNotInitialized` before use.
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = user
    )]
    pub user_ata: Account<'info, TokenAccount>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; feeds the `Σ upnl` half of the withdraw equity gate.
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    /// CHECK: the user's Long position PDA (seed `[POSITION_SEED, market,
    /// user, 0]`); a pristine/missing side contributes zero `upnl` to the gate.
    pub position_long: UncheckedAccount<'info>,
    /// CHECK: the user's Short position PDA (seed `[POSITION_SEED, market,
    /// user, 1]`); a pristine/missing side contributes zero `upnl` to the gate.
    pub position_short: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetOperator<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    /// CHECK: the per-`(market, user)` `Operator` PDA, lazily created by the
    /// handler on first bind (payer = user); a program-owned record is
    /// overwritten (rotate), `Pubkey::default()` stores the revoke state, and a
    /// system-owned squat is rejected with `OperatorPdaSquatted`.
    #[account(
        mut,
        seeds = [OPERATOR_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub operator_record: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OperatorDepositCollateral<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    /// CHECK: the subject user (the record/ledger PDA seed); not a signer —
    /// the operator acts for them under the one-time bind approval.
    pub user: UncheckedAccount<'info>,
    /// `mut`: the handler's claim-payout writes `PerpMarket.pnl_pool`.
    #[account(mut, seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    /// CHECK: the subject's per-`(market, user)` collateral ledger, lazily
    /// created by the handler on first deposit (payer = operator).
    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_collateral: UncheckedAccount<'info>,
    /// CHECK: the per-`(market, user)` `Operator` record; the handler requires
    /// a matching, non-revoked record (`OperatorUnauthorized` otherwise).
    #[account(
        seeds = [OPERATOR_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub operator_record: UncheckedAccount<'info>,
    /// CHECK: the vault token account (authority = the vault PDA); the handler
    /// rejects an uninitialized vault with `VaultNotInitialized` before use.
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the subject's USDC ATA, validated in-handler against
    /// `market.collateral_mint` and the subject owner before any transfer.
    #[account(mut)]
    pub user_ata: UncheckedAccount<'info>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OperatorWithdrawCollateral<'info> {
    /// The delegated operator signer (the only signer; must equal the
    /// non-revoked `operator_record.operator` or the handler fails with
    /// `OperatorUnauthorized`).
    pub operator: Signer<'info>,
    /// CHECK: the subject user (the record/ledger PDA seed); not a signer.
    pub user: UncheckedAccount<'info>,
    /// `mut`: the handler's claim-payout writes `PerpMarket.pnl_pool`.
    #[account(mut, seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_collateral: Account<'info, UserCollateral>,
    /// CHECK: the per-`(market, user)` `Operator` record; the handler requires
    /// a matching, non-revoked record (`OperatorUnauthorized` otherwise).
    #[account(
        seeds = [OPERATOR_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub operator_record: UncheckedAccount<'info>,
    /// CHECK: the vault token account (authority = the vault PDA); the PDA
    /// signs the token transfer via `invoke_signed`.
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the subject's own USDC ATA — the only legal destination; the
    /// handler verifies `market.collateral_mint` + subject owner in-handler
    /// before any transfer.
    #[account(mut)]
    pub user_ata: UncheckedAccount<'info>,
    #[account(address = market.collateral_mint)]
    pub collateral_mint: Account<'info, Mint>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; feeds the `Σ upnl` half of the withdraw equity gate.
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    /// CHECK: the subject's Long position PDA (seed `[POSITION_SEED, market,
    /// user, 0]`); a pristine/missing side contributes zero `upnl` to the gate.
    pub position_long: UncheckedAccount<'info>,
    /// CHECK: the subject's Short position PDA (seed `[POSITION_SEED, market,
    /// user, 1]`); a pristine/missing side contributes zero `upnl` to the gate.
    pub position_short: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct OperatorOpenPosition<'info> {
    /// The delegated operator signer (the only signer; must equal the
    /// non-revoked `operator_record.operator` or the handler fails with
    /// `OperatorUnauthorized`). `mut`: pays the lazy rent for the subject's
    /// `Position` / `UserCollateral` PDAs (payer = operator).
    #[account(mut)]
    pub operator: Signer<'info>,
    /// CHECK: the subject user (the position/ledger/record PDA seed); not a
    /// signer — the operator acts for them under the one-time bind approval.
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; its exchange-rate snapshot is stamped onto every Fill.
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    /// CHECK: the subject's per-(market, user, side) `Position` PDA (seed
    /// `[POSITION_SEED, market, user, side_byte]`), lazily created by the
    /// handler on first fill and retained after a full close (`notional == 0`
    /// means closed).
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref(), &[side]],
        bump
    )]
    pub position: UncheckedAccount<'info>,
    /// CHECK: the subject's per-(market, user) collateral ledger, created by
    /// `deposit_collateral`; the handler rejects a missing ledger with
    /// `InsufficientFreeCollateral` before reserving margin.
    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_collateral: UncheckedAccount<'info>,
    /// CHECK: the per-`(market, user)` `Operator` record; the handler requires
    /// a matching, non-revoked record (`OperatorUnauthorized` otherwise).
    #[account(
        seeds = [OPERATOR_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub operator_record: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct OperatorClosePosition<'info> {
    /// The delegated operator signer (the only signer; must equal the
    /// non-revoked `operator_record.operator` or the handler fails with
    /// `OperatorUnauthorized`).
    pub operator: Signer<'info>,
    /// CHECK: the subject user (the position/ledger/record PDA seed); not a
    /// signer — the operator acts for them under the one-time bind approval.
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; its exchange-rate snapshot is stamped onto every Fill.
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    /// CHECK: the subject's per-(market, user, side) `Position` PDA; must
    /// already hold data with `notional > 0` (the handler reports
    /// `PositionNotFound` otherwise).
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref(), &[side]],
        bump
    )]
    pub position: UncheckedAccount<'info>,
    /// CHECK: the subject's per-(market, user) collateral ledger, created by
    /// `deposit_collateral`; closing releases reservation from it.
    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_collateral: UncheckedAccount<'info>,
    /// CHECK: the per-`(market, user)` `Operator` record; the handler requires
    /// a matching, non-revoked record (`OperatorUnauthorized` otherwise).
    #[account(
        seeds = [OPERATOR_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub operator_record: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OperatorPlaceLimitOrder<'info> {
    /// The delegated operator signer (the only signer; must equal the
    /// non-revoked `operator_record.operator` or the handler fails with
    /// `OperatorUnauthorized`).
    pub operator: Signer<'info>,
    /// CHECK: the subject user (the record PDA seed; orders are attributed to
    /// them); not a signer — the operator acts for them under the one-time
    /// bind approval.
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; its exchange-rate snapshot is stamped onto every Fill.
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    /// CHECK: the per-`(market, user)` `Operator` record; the handler requires
    /// a matching, non-revoked record (`OperatorUnauthorized` otherwise).
    #[account(
        seeds = [OPERATOR_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub operator_record: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OperatorPlaceMarketOrder<'info> {
    /// The delegated operator signer (the only signer; must equal the
    /// non-revoked `operator_record.operator` or the handler fails with
    /// `OperatorUnauthorized`).
    pub operator: Signer<'info>,
    /// CHECK: the subject user (the record PDA seed; orders are attributed to
    /// them); not a signer — the operator acts for them under the one-time
    /// bind approval.
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; its exchange-rate snapshot is stamped onto every Fill.
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    /// CHECK: the per-`(market, user)` `Operator` record; the handler requires
    /// a matching, non-revoked record (`OperatorUnauthorized` otherwise).
    #[account(
        seeds = [OPERATOR_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub operator_record: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OperatorCancelOrder<'info> {
    /// The delegated operator signer (the only signer; must equal the
    /// non-revoked `operator_record.operator` or the handler fails with
    /// `OperatorUnauthorized`).
    pub operator: Signer<'info>,
    /// CHECK: the subject user (the record PDA seed; the cancelled order is
    /// owned by them); not a signer — the operator acts for them under the
    /// one-time bind approval.
    pub user: UncheckedAccount<'info>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    /// CHECK: the per-`(market, user)` `Operator` record; the handler requires
    /// a matching, non-revoked record (`OperatorUnauthorized` otherwise).
    #[account(
        seeds = [OPERATOR_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub operator_record: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; its exchange-rate snapshot is stamped onto every Fill.
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    /// CHECK: the per-(market, user, side) `Position` PDA (seed
    /// `[POSITION_SEED, market, user, side_byte]`), lazily created by the
    /// handler on first fill and retained after a full close (`notional == 0`
    /// means closed).
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref(), &[side]],
        bump
    )]
    pub position: UncheckedAccount<'info>,
    /// CHECK: the per-(market, user) collateral ledger, created by
    /// `deposit_collateral`; the handler rejects a missing ledger with
    /// `InsufficientFreeCollateral` before reserving margin.
    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub user_collateral: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct ClosePosition<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; its exchange-rate snapshot is stamped onto every Fill.
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    /// CHECK: the per-(market, user, side) `Position` PDA; must already hold
    /// data with `notional > 0` (the handler reports `PositionNotFound`
    /// otherwise).
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref(), &[side]],
        bump
    )]
    pub position: UncheckedAccount<'info>,
    /// CHECK: the per-(market, user) collateral ledger, created by
    /// `deposit_collateral`; closing releases reservation from it.
    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub user_collateral: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettleFill<'info> {
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    #[account(
        mut,
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    /// CHECK: the maker's `Position` PDA (seed
    /// `[POSITION_SEED, market, event.owner, event.side]`); the handler
    /// derives it from the `Fill` event and verifies the supplied key
    /// byte-for-byte (`ProgramError::InvalidAccountData` on mismatch),
    /// lazily creating it on first settlement.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: the maker's collateral ledger (seed
    /// `[USER_COLLATERAL_SEED, market, event.owner]`), verified in the handler
    /// against the event-derived PDA; must pre-exist (`InsufficientFreeCollateral`
    /// otherwise).
    #[account(mut)]
    pub user_collateral: UncheckedAccount<'info>,
    /// CHECK: pays the lazy rent for the maker's first `Position` (any signer).
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct ResetPosition<'info> {
    #[account(seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    /// CHECK: the per-(market, user, side) `Position` PDA (seed
    /// `[POSITION_SEED, market, user, side_byte]`); the handler resets it in
    /// place when it is a program-owned CLOSED position (`notional == 0`) and
    /// rejects a live position (`PositionNotFound`) or a system-owned squat
    /// (`PositionPdaSquatted`).
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref(), &[side]],
        bump
    )]
    pub position: UncheckedAccount<'info>,
    /// CHECK: the position's user (bound into the PDA seed); signs to authorize
    /// the reset of their own dormant position.
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleClose<'info> {
    #[account(mut, seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    /// CHECK: the per-(market, user, side) `Position` PDA; the handler verifies
    /// `position.market == market` and the user's `UserCollateral` PDA from
    /// `position.owner` (byte-level), then settles `closed_notional > 0`.
    #[account(mut)]
    pub position: Account<'info, Position>,
    /// CHECK: the per-(market, user) collateral ledger, verified against the
    /// `position.owner`-derived PDA in the handler; the settled PnL is applied
    /// to `deposited`.
    #[account(mut)]
    pub user_collateral: Account<'info, UserCollateral>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; `settle_close` reads the live index from it and nothing else
    /// (R-S2 — never the mark oracle).
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettleFunding<'info> {
    #[account(mut, seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    /// CHECK: the per-(market, user, side) `Position` PDA; the handler verifies
    /// `position.market == market` and the user's `UserCollateral` PDA from
    /// `position.owner` (byte-level), then accrues funding.
    #[account(mut)]
    pub position: Account<'info, Position>,
    /// CHECK: the per-(market, user) collateral ledger, verified against the
    /// `position.owner`-derived PDA in the handler; the funding payment is
    /// applied to `deposited`.
    #[account(mut)]
    pub user_collateral: Account<'info, UserCollateral>,
    #[account(
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; its snapshot and the market baseline derive the trustless
    /// on-chain index (R-F5).
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut, seeds = [PERP_MARKET_SEED], bump = market.bump)]
    pub market: Account<'info, PerpMarket>,
    /// CHECK: the per-(market, user, side) `Position` PDA of the liquidated
    /// account; the handler verifies `position.market == market` and the
    /// victim's `UserCollateral` PDA from `position.owner`.
    #[account(mut)]
    pub position: Account<'info, Position>,
    /// CHECK: the opposite side's per-(market, user, side) `Position` PDA of the
    /// liquidated account; the handler derives `[POSITION_SEED, market,
    /// position.owner, other_side]` from the targeted `position` and requires a
    /// byte-equal key (a pristine/missing account contributes zero exposure; a
    /// system-owned squat is `PositionPdaSquatted`).
    pub other_position: UncheckedAccount<'info>,
    /// CHECK: the victim's per-(market, user) collateral ledger, verified in the
    /// handler; its `reserved` releases the consumed collateral.
    #[account(mut)]
    pub user_collateral: Account<'info, UserCollateral>,
    #[account(
        seeds = [ORDER_BOOK_SEED, market.key().as_ref()],
        bump
    )]
    pub order_book: AccountLoader<'info, OrderBook>,
    /// CHECK: must byte-equal `market.index_source` (Anchor `address`
    /// constraint) and pass the stake-pool owner/discriminator validation in
    /// the handler; the index-based unrealized PnL health metric (R-L2).
    #[account(address = market.index_source)]
    pub index_source: UncheckedAccount<'info>,
    /// The account liquidating the position (any signer; permissionless).
    pub liquidator: Signer<'info>,
    /// CHECK: the liquidator's per-(market, user) collateral ledger, seeded by
    /// the `liquidator` signer; the liquidation penalty reward is credited here.
    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), liquidator.key().as_ref()],
        bump
    )]
    pub liquidator_collateral: Account<'info, UserCollateral>,
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod handlers_tests {
    use super::*;
    use proptest::prelude::*;

    fn empty_account() -> OrderBook {
        OrderBook {
            market: Pubkey::default(),
            bump: 0,
            next_seq: 0,
            best_bid: 0,
            best_ask: 0,
            event_read_cursor: 0,
            event_write_cursor: 0,
            twap_cursor: 0,
            _pad: [0u8; 7],
            bids: [state::Order::default(); crate::constants::MAX_ORDERS_PER_SIDE],
            asks: [state::Order::default(); crate::constants::MAX_ORDERS_PER_SIDE],
            events: [OutEvent::default(); EVENT_QUEUE_LEN],
            observations: [state::Observation::default(); TWAP_OBSERVATIONS],
        }
    }

    fn order(
        owner: u8,
        side: orderbook::Side,
        price: u64,
        size: u64,
        seq: u64,
    ) -> orderbook::Order {
        orderbook::Order {
            owner: Pubkey::from([owner; 32]),
            side,
            price,
            size,
            seq,
        }
    }

    #[test]
    fn side_encoding_round_trips() {
        assert_eq!(side_to_u8(orderbook::Side::Bid), SIDE_BID);
        assert_eq!(side_to_u8(orderbook::Side::Ask), SIDE_ASK);
        assert_eq!(side_from_u8(SIDE_BID).unwrap(), orderbook::Side::Bid);
        assert_eq!(side_from_u8(SIDE_ASK).unwrap(), orderbook::Side::Ask);
        assert!(side_from_u8(2).is_err());
        assert!(side_from_u8(255).is_err());
    }

    #[test]
    fn load_save_round_trips_orders() {
        let mut account = empty_account();
        account.bids[0] = state::Order {
            active: 1,
            owner: Pubkey::from([1; 32]),
            price: 9,
            size: 5,
            seq: 0,
            _pad: [0u8; 7],
        };
        account.bids[1] = state::Order {
            active: 1,
            owner: Pubkey::from([2; 32]),
            price: 10,
            size: 7,
            seq: 1,
            _pad: [0u8; 7],
        };
        account.asks[0] = state::Order {
            active: 1,
            owner: Pubkey::from([3; 32]),
            price: 11,
            size: 3,
            seq: 2,
            _pad: [0u8; 7],
        };
        account.next_seq = 3;

        let book = load_book(&account);
        assert_eq!(book.bids.len(), 2);
        assert_eq!(book.asks.len(), 1);
        assert_eq!(orderbook::best_bid(&book), 10);
        assert_eq!(orderbook::best_ask(&book), 11);

        let mut out = empty_account();
        save_book(&mut out, &book);
        assert_eq!(out.best_bid, 10);
        assert_eq!(out.best_ask, 11);
        assert_eq!(out.next_seq, 3);
        assert!(out.bids[0].active == 1 && out.bids[0].seq == 0);
        assert!(out.bids[1].active == 1 && out.bids[1].seq == 1);
        assert!(out.bids[2].active == 0);
        assert!(out.asks[0].active == 1);
        assert!(out.asks[1].active == 0);
    }

    #[test]
    fn append_event_is_monotonic_and_backpressures_at_capacity() {
        let mut account = empty_account();
        for i in 0..(EVENT_QUEUE_LEN as u64) {
            append_event(
                &mut account,
                EVENT_KIND_FILL,
                Pubkey::from([7; 32]),
                Pubkey::default(),
                SIDE_BID,
                i,
                i,
                0,
                0,
            );
        }
        // The ring is exactly full: every event was written, seq == write cursor.
        assert_eq!(account.event_write_cursor, EVENT_QUEUE_LEN as u64);
        let last_idx = (EVENT_QUEUE_LEN as u64 - 1) as usize;
        assert_eq!(account.events[last_idx].seq, EVENT_QUEUE_LEN as u64 - 1);

        // A wrapping write with an undrained ring must not overwrite: the oldest
        // event (seq 0) stays in slot 0 and the write cursor stops advancing.
        append_event(
            &mut account,
            EVENT_KIND_FILL,
            Pubkey::from([7; 32]),
            Pubkey::default(),
            SIDE_BID,
            999,
            999,
            0,
            0,
        );
        assert_eq!(
            account.event_write_cursor, EVENT_QUEUE_LEN as u64,
            "backpressure must not advance the cursor past an undrained ring"
        );
        assert_eq!(
            account.events[0].seq, 0,
            "undrained slot must not be overwritten"
        );

        // Draining one slot frees capacity for the next append.
        account.event_read_cursor = 1;
        append_event(
            &mut account,
            EVENT_KIND_FILL,
            Pubkey::from([7; 32]),
            Pubkey::default(),
            SIDE_BID,
            999,
            999,
            0,
            0,
        );
        assert_eq!(account.event_write_cursor, EVENT_QUEUE_LEN as u64 + 1);
        assert_eq!(
            account.events[0].seq, EVENT_QUEUE_LEN as u64,
            "drained slot reused"
        );
    }

    #[test]
    fn record_observation_accumulates_mid_times_delta() {
        let mut account = empty_account();
        // First sample: no prior sample, cumulative stays 0.
        record_observation(&mut account, Some(7), 100);
        assert_eq!(account.observations[0].slot, 100);
        assert_eq!(
            u128::from_le_bytes(account.observations[0].cumulative_mid),
            0
        );

        // 10 slots later with mid 7: cumulative += 7 * 10.
        record_observation(&mut account, Some(7), 110);
        assert_eq!(account.observations[1].slot, 110);
        assert_eq!(
            u128::from_le_bytes(account.observations[1].cumulative_mid),
            70
        );

        // A one-sided book (mid None) contributes nothing but still records a slot.
        record_observation(&mut account, None, 120);
        assert_eq!(account.observations[2].slot, 120);
        assert_eq!(
            u128::from_le_bytes(account.observations[2].cumulative_mid),
            70
        );
    }

    #[test]
    fn match_limit_taker_rejects_self_trade() {
        let mut account = empty_account();
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![order(1, orderbook::Side::Ask, 10, 5, 0)],
            next_seq: 1,
        };
        // Taker (owner 1) bids 12 into its own ask at 10: skipped by the engine,
        // then the remainder still crosses -> SelfTrade.
        let incoming = order(1, orderbook::Side::Bid, 12, 5, 1);
        let result = match_limit_taker(&mut account, &mut book, incoming, 0, 0);
        assert!(result.is_err());
    }

    #[test]
    fn match_limit_taker_rests_non_crossing_remainder() {
        let mut account = empty_account();
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![order(2, orderbook::Side::Ask, 10, 3, 0)],
            next_seq: 1,
        };
        // Taker bids 12 for size 5 into ask 10 (size 3): fills 3, rests 2 at 12.
        let incoming = order(1, orderbook::Side::Bid, 12, 5, 1);
        match_limit_taker(&mut account, &mut book, incoming, 0, 0).unwrap();
        assert!(book.asks.is_empty());
        assert_eq!(book.bids.len(), 1);
        assert_eq!(book.bids[0].price, 12);
        assert_eq!(book.bids[0].size, 2);
    }

    #[test]
    fn match_limit_taker_requeues_on_budget_hit() {
        let mut account = empty_account();
        let asks: Vec<orderbook::Order> = (0..10)
            .map(|i| order(2, orderbook::Side::Ask, 10 + i as u64, 1, i as u64))
            .collect();
        let mut book = orderbook::Book {
            bids: vec![],
            asks,
            next_seq: 10,
        };
        // MAX_MATCH_STEPS == 8, so 8 of the 10 makers fill and the remaining 2
        // are deferred as a Residual event.
        let incoming = order(1, orderbook::Side::Bid, 30, 10, 0);
        match_limit_taker(&mut account, &mut book, incoming, 0, 0).unwrap();
        assert_eq!(book.asks.len(), 2);
        assert_eq!(account.event_write_cursor, 9); // 8 fills + 1 residual
        assert_eq!(account.events[8].kind, EVENT_KIND_RESIDUAL);
        assert_eq!(account.events[8].size, 2);
    }

    /// Every `Fill` event is stamped with the in-transaction index snapshot
    /// (`entry_total_lamports` / `entry_pool_token_supply`, FR-6/D8) and starts
    /// un-settled (`settled == 0`), so `settle_fill` can book the maker at the
    /// fill-time index. Non-fill events (Cancel/Residual) carry a zero snapshot.
    #[test]
    fn fill_event_layout_and_stamp() {
        let mut account = empty_account();
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![order(2, orderbook::Side::Ask, 10, 3, 0)],
            next_seq: 1,
        };
        // Taker (owner 1) bids 12 into ask 10 (size 3): one fill, no remainder.
        let incoming = order(1, orderbook::Side::Bid, 12, 3, 1);
        match_limit_taker(&mut account, &mut book, incoming, 123_456_789, 987_654_321).unwrap();
        assert!(book.asks.is_empty());

        assert_eq!(account.event_write_cursor, 1);
        let ev = account.events[0];
        assert_eq!(ev.kind, EVENT_KIND_FILL);
        assert_eq!(ev.seq, 0);
        assert_eq!(ev.owner, Pubkey::from([2; 32]), "maker owner");
        assert_eq!(ev.counterparty, Pubkey::from([1; 32]), "taker owner");
        assert_eq!(
            ev.side, SIDE_ASK,
            "maker side (fills rest opposite the taker)"
        );
        assert_eq!(ev.price, 10);
        assert_eq!(ev.size, 3);
        assert_eq!(
            ev.entry_total_lamports, 123_456_789,
            "fill carries the in-transaction index numerator"
        );
        assert_eq!(
            ev.entry_pool_token_supply, 987_654_321,
            "fill carries the in-transaction index denominator"
        );
        assert_eq!(ev.settled, 0, "a fresh Fill is pending maker settlement");
    }

    /// Fills are never silently dropped (D10): `emit_fill_events` fails with
    /// `BookFull` when the event ring is full, and the direct taker paths
    /// (`place_limit_order` / `place_market_order` via `match_limit_taker`)
    /// propagate that error instead of reporting success.
    #[test]
    fn fill_append_at_capacity_fails_book_full() {
        // 1. `emit_fill_events` on a full ring fails BookFull.
        let mut account = empty_account();
        for i in 0..(EVENT_QUEUE_LEN as u64) {
            append_event(
                &mut account,
                EVENT_KIND_CANCEL,
                Pubkey::from([7; 32]),
                Pubkey::default(),
                SIDE_BID,
                i,
                i,
                0,
                0,
            );
        }
        assert_eq!(account.event_write_cursor, EVENT_QUEUE_LEN as u64);
        let fills = vec![orderbook::Fill {
            maker_seq: 0,
            maker_owner: Pubkey::from([2; 32]),
            taker_owner: Pubkey::from([1; 32]),
            size: 5,
            price: 10,
        }];
        let err = emit_fill_events(&mut account, &fills, orderbook::Side::Ask, 111, 222)
            .expect_err("a full ring must reject the fill, never silently drop it");
        assert_eq!(
            err,
            FructusError::BookFull.into(),
            "append failure surfaces as BookFull"
        );
        // The failed append must not advance the write cursor or touch a slot.
        assert_eq!(account.event_write_cursor, EVENT_QUEUE_LEN as u64);
        assert_eq!(
            account.events[0].kind, EVENT_KIND_CANCEL,
            "undrained slot untouched"
        );

        // 2. The taker path propagates: a crossing taker whose Fill cannot be
        //    appended fails with BookFull (never Ok-with-dropped-fill).
        let mut account = empty_account();
        for i in 0..(EVENT_QUEUE_LEN as u64) {
            append_event(
                &mut account,
                EVENT_KIND_CANCEL,
                Pubkey::from([7; 32]),
                Pubkey::default(),
                SIDE_BID,
                i,
                i,
                0,
                0,
            );
        }
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![order(2, orderbook::Side::Ask, 10, 5, 0)],
            next_seq: 1,
        };
        let incoming = order(1, orderbook::Side::Bid, 12, 5, 1);
        let err = match_limit_taker(&mut account, &mut book, incoming, 111, 222)
            .expect_err("a full ring must fail the taker's fill");
        assert_eq!(err, FructusError::BookFull.into());
    }

    /// The crank never wedges the ring (FR-6): the read cursor always advances
    /// past the head event, and a `Residual` is resumed only when the ring has
    /// capacity to persist EVERY fill its match would produce — otherwise the
    /// whole remainder is cancelled up front without consuming any maker
    /// (D10': all-or-nothing; D10: fills are never silently dropped).
    #[test]
    fn crank_drains_ring_when_full() {
        // Scenario 1: the ring is FULL and the head is a Residual that needs two
        // fills. Only one slot frees after the head drains, so the resume cannot
        // persist both fills: the capacity gate cancels the whole remainder up
        // front — NO maker is consumed, NO fill is dropped (D10), and the ring
        // still advances (the head event is consumed).
        let mut account = empty_account();
        let mut residual = OutEvent::default();
        residual.seq = 0;
        residual.kind = EVENT_KIND_RESIDUAL;
        residual.side = SIDE_BID;
        residual.owner = Pubkey::from([1; 32]);
        residual.price = 30;
        residual.size = 12;
        account.events[0] = residual;
        for i in 1..(EVENT_QUEUE_LEN as u64) {
            let mut fill = OutEvent::default();
            fill.seq = i;
            fill.kind = EVENT_KIND_FILL;
            fill.side = SIDE_BID;
            fill.owner = Pubkey::from([7; 32]);
            fill.size = 1;
            account.events[i as usize] = fill;
        }
        account.event_write_cursor = EVENT_QUEUE_LEN as u64;

        // Two crossable asks (5 + 5 at 10/11): the residual bid 30 @ 12 crosses
        // both, so it needs two Fill events but only one slot frees after the
        // head drains — the resume is cancelled, not partially executed.
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![
                order(2, orderbook::Side::Ask, 10, 5, 0),
                order(2, orderbook::Side::Ask, 11, 5, 1),
            ],
            next_seq: 2,
        };

        let dirty = drain_events(&mut account, &mut book, 100, 200).unwrap();
        assert!(
            !dirty,
            "a capacity-cancelled residual mutates neither book nor seq"
        );
        assert!(
            account.event_read_cursor > 0,
            "crank must advance past the head event even when the ring is full"
        );
        assert_eq!(
            book.asks.len(),
            2,
            "all-or-nothing: no maker is consumed when the ring cannot hold every fill"
        );
        assert!(
            book.bids.is_empty(),
            "the unresumable remainder is cancelled, never rested"
        );
        // The ring is untouched: the write cursor never advanced and slot 0
        // still holds the unconsumed residual (nothing was dropped, nothing
        // stamped, nothing settled).
        assert_eq!(account.event_write_cursor, EVENT_QUEUE_LEN as u64);
        let ev = account.events[0];
        assert_eq!(ev.kind, EVENT_KIND_RESIDUAL);
        assert_eq!(ev.entry_total_lamports, 0);
        assert_eq!(ev.entry_pool_token_supply, 0);
        assert_eq!(ev.settled, 0);

        // Scenario 2: with ring capacity the same residual resumes fully — both
        // fills are appended and stamped, and the non-crossing remainder rests.
        let mut account = empty_account();
        let mut residual = OutEvent::default();
        residual.seq = 0;
        residual.kind = EVENT_KIND_RESIDUAL;
        residual.side = SIDE_BID;
        residual.owner = Pubkey::from([1; 32]);
        residual.price = 30;
        residual.size = 12;
        account.events[0] = residual;
        account.event_write_cursor = 1;
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![
                order(2, orderbook::Side::Ask, 10, 5, 0),
                order(2, orderbook::Side::Ask, 11, 5, 1),
            ],
            next_seq: 2,
        };

        let dirty = drain_events(&mut account, &mut book, 100, 200).unwrap();
        assert!(dirty);
        assert_eq!(
            account.event_read_cursor, account.event_write_cursor,
            "ring drained"
        );
        assert_eq!(account.event_write_cursor, 3, "two fills appended");
        for i in 1..3 {
            let ev = account.events[i];
            assert_eq!(ev.kind, EVENT_KIND_FILL);
            assert_eq!(ev.entry_total_lamports, 100, "fill stamped");
            assert_eq!(ev.entry_pool_token_supply, 200);
            assert_eq!(ev.settled, 0);
        }
        assert!(book.asks.is_empty());
        assert_eq!(book.bids.len(), 1, "remainder rests at its limit price");
        assert_eq!(book.bids[0].price, 30);
        assert_eq!(book.bids[0].size, 2);
    }

    // --- Position lifecycle (issue #5) -------------------------------------
    //
    // REQ-3 (open: inline taker settlement, margin reservation, budget-hit
    // remainder cancelled), REQ-4 (close: opposite-side IOC, margin release,
    // entry unchanged), REQ-5 (settle_fill: event state machine + PDA
    // verification + open-intent re-open), REQ-7 (reserved writer, free seam).

    fn position(
        notional: u64,
        n_sum: u128,
        d_sum: u128,
        collateral: u64,
        open_slot: u64,
    ) -> Position {
        Position {
            market: Pubkey::default(),
            owner: Pubkey::default(),
            side: 0,
            notional,
            entry_n_sum: n_sum,
            entry_d_sum: d_sum,
            collateral,
            last_funding_epoch: 0,
            closed_notional: 0,
            closed_entry_n_sum: 0,
            closed_entry_d_sum: 0,
            open_slot,
            bump: 0,
        }
    }

    fn user_collateral(deposited: u64, reserved: u64) -> UserCollateral {
        UserCollateral {
            deposited,
            reserved,
            claimable: 0,
            bump: 0,
        }
    }

    fn fill(size: u64) -> orderbook::Fill {
        orderbook::Fill {
            maker_seq: 0,
            maker_owner: Pubkey::from([2; 32]),
            taker_owner: Pubkey::from([1; 32]),
            size,
            price: 10,
        }
    }

    // --- REQ-3/REQ-7: open fills settle inline (notional, entry sums, margin) ---

    #[test]
    fn open_fills_accumulate_notional_entry_and_margin() {
        let mut pos = position(0, 0, 0, 0, 0);
        let mut uc = user_collateral(1_000_000_000, 0);
        let fills = vec![fill(1_000_000), fill(2_000_000)];
        apply_open_fills(
            &mut pos,
            &mut uc,
            1_000,
            &fills,
            1_000_000_000,
            1_000_000,
            7,
            100,
        )
        .unwrap();
        assert_eq!(pos.notional, 3_000_000);
        // Both fills share the in-transaction snapshot: Σ rate × size (D6).
        assert_eq!(pos.entry_n_sum, 1_000_000_000u128 * 3_000_000);
        assert_eq!(pos.entry_d_sum, 1_000_000u128 * 3_000_000);
        assert_eq!(
            pos.collateral,
            positions::margin_required(3_000_000, 1_000).unwrap()
        );
        assert_eq!(
            uc.reserved, pos.collateral,
            "reserved == position collateral"
        );
        assert_eq!(pos.open_slot, 7, "a fresh open records the fill slot");
    }

    #[test]
    fn open_fills_reopen_resets_entry_and_open_slot() {
        // A retained closed position (notional == 0) carries stale sums from a
        // prior life; a re-open resets them (FR-2/FR-5).
        let mut pos = position(0, 999, 888, 0, 1);
        let mut uc = user_collateral(1_000_000, 0);
        apply_open_fills(&mut pos, &mut uc, 1_000, &[fill(5)], 100, 10, 42, 100).unwrap();
        assert_eq!(pos.notional, 5);
        assert_eq!(pos.entry_n_sum, 500, "entry := event snapshot × size");
        assert_eq!(pos.entry_d_sum, 50);
        assert_eq!(pos.open_slot, 42, "re-open stamps the current slot");
        assert_eq!(
            pos.collateral,
            positions::margin_required(5, 1_000).unwrap()
        );
    }

    #[test]
    fn open_fills_accumulate_into_live_position() {
        let collateral = positions::margin_required(100, 1_000).unwrap();
        let mut pos = position(100, 1_000, 100, collateral, 1);
        let mut uc = user_collateral(1_000_000, collateral);
        apply_open_fills(&mut pos, &mut uc, 1_000, &[fill(50)], 100, 10, 99, 100).unwrap();
        assert_eq!(pos.notional, 150);
        assert_eq!(pos.entry_n_sum, 1_000 + 100 * 50);
        assert_eq!(pos.entry_d_sum, 100 + 10 * 50);
        assert_eq!(
            pos.open_slot, 1,
            "adding to a live position keeps the open slot"
        );
        // Margin reservation grows by exactly the margin_required delta (REQ-7).
        assert_eq!(uc.reserved, positions::margin_required(150, 1_000).unwrap());
        assert_eq!(
            uc.reserved - collateral,
            positions::margin_required(150, 1_000).unwrap() - collateral
        );
    }

    #[test]
    fn open_fills_respect_free_collateral_seam() {
        let mut pos = position(0, 0, 0, 0, 0);
        let mut uc = user_collateral(100, 0); // far below the margin requirement
        let err = apply_open_fills(
            &mut pos,
            &mut uc,
            1_000,
            &[fill(1_000_000)],
            1_000_000_000,
            1_000_000,
            5,
            100,
        )
        .expect_err("reserving beyond free collateral must fail");
        assert_eq!(err, FructusError::InsufficientFreeCollateral.into());
        // Atomic: neither account is mutated by the failed reservation.
        assert_eq!(pos.notional, 0);
        assert_eq!(pos.entry_n_sum, 0);
        assert_eq!(pos.entry_d_sum, 0);
        assert_eq!(pos.collateral, 0);
        assert_eq!(uc.reserved, 0);
    }

    #[test]
    fn open_fills_noop_when_no_fills() {
        let mut pos = position(0, 0, 0, 0, 0);
        let mut uc = user_collateral(0, 0);
        apply_open_fills(&mut pos, &mut uc, 1_000, &[], 0, 0, 5, 100).unwrap();
        assert_eq!(pos.notional, 0);
        assert_eq!(pos.entry_n_sum, 0);
        assert_eq!(uc.reserved, 0);
    }

    // --- REQ-4/REQ-7: close fills reduce notional and release margin ---

    #[test]
    fn close_fills_reduce_notional_and_release_margin() {
        let collateral = positions::margin_required(1_000, 1_000).unwrap();
        let mut pos = position(1_000, 7, 7, collateral, 3);
        let mut uc = user_collateral(1_000_000, collateral);
        apply_close_fills(&mut pos, &mut uc, 1_000, &[fill(600)]).unwrap();
        assert_eq!(pos.notional, 400);
        assert_eq!(
            pos.collateral,
            positions::margin_required(400, 1_000).unwrap()
        );
        assert_eq!(
            uc.reserved, pos.collateral,
            "reserved tracks the reduced margin"
        );
        assert_eq!(pos.entry_n_sum, 7, "entry sums unchanged on close");
        assert_eq!(pos.entry_d_sum, 7);
        assert_eq!(pos.open_slot, 3, "open_slot unchanged on close");
    }

    #[test]
    fn close_fills_full_close_releases_all_margin() {
        let collateral = positions::margin_required(1_000, 1_000).unwrap();
        let mut pos = position(1_000, 7, 7, collateral, 3);
        let mut uc = user_collateral(1_000_000, collateral);
        apply_close_fills(&mut pos, &mut uc, 1_000, &[fill(1_000)]).unwrap();
        assert_eq!(pos.notional, 0);
        assert_eq!(pos.collateral, 0);
        assert_eq!(uc.reserved, 0, "a full close releases all reservation");
        assert_eq!(pos.entry_n_sum, 7, "closed position retains its entry sums");
    }

    #[test]
    fn close_fills_never_below_zero() {
        let collateral = positions::margin_required(100, 1_000).unwrap();
        let mut pos = position(100, 7, 7, collateral, 3);
        let mut uc = user_collateral(1_000_000, collateral);
        let err = apply_close_fills(&mut pos, &mut uc, 1_000, &[fill(101)])
            .expect_err("closing more than the position holds must fail");
        assert_eq!(err, FructusError::InvalidCloseSize.into());
        assert_eq!(pos.notional, 100, "no mutation on error");
        assert_eq!(uc.reserved, collateral);
    }

    #[test]
    fn close_fills_noop_when_no_fills() {
        let mut pos = position(100, 7, 7, 10, 3);
        let mut uc = user_collateral(1_000_000, 10);
        apply_close_fills(&mut pos, &mut uc, 1_000, &[]).unwrap();
        assert_eq!(pos.notional, 100);
        assert_eq!(uc.reserved, 10);
    }

    // --- REQ-3: open order placement (market IOC / limit rest / D10′) ---

    #[test]
    fn open_position_market_settles_inline() {
        let mut account = empty_account();
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![order(2, orderbook::Side::Ask, 10, 3, 0)],
            next_seq: 1,
        };
        let incoming = order(1, orderbook::Side::Bid, 0, 3, 1); // market long
        let fills = match_open_taker(&mut account, &mut book, incoming, 100, 200).unwrap();
        assert_eq!(fills.len(), 1);
        assert_eq!(fills[0].size, 3);
        assert!(book.asks.is_empty());
        assert!(book.bids.is_empty(), "market remainder is never rested");

        let mut pos = position(0, 0, 0, 0, 0);
        let mut uc = user_collateral(1_000_000, 0);
        apply_open_fills(&mut pos, &mut uc, 10_000, &fills, 100, 200, 5, 100).unwrap();
        assert_eq!(pos.notional, 3);
        assert_eq!(pos.entry_n_sum, 300);
        assert_eq!(pos.entry_d_sum, 600);
        assert_eq!(uc.reserved, positions::margin_required(3, 10_000).unwrap());
    }

    #[test]
    fn open_limit_rests_when_non_crossing() {
        let mut account = empty_account();
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![order(2, orderbook::Side::Ask, 10, 5, 0)],
            next_seq: 1,
        };
        let incoming = order(1, orderbook::Side::Bid, 9, 5, 1); // below the ask
        let fills = match_open_taker(&mut account, &mut book, incoming, 100, 200).unwrap();
        assert!(fills.is_empty());
        assert_eq!(book.bids.len(), 1, "non-crossing limit rests");
        assert_eq!(book.bids[0].price, 9);
        assert_eq!(account.event_write_cursor, 0, "no fills, no events");
    }

    #[test]
    fn open_limit_cancels_budget_hit_remainder() {
        let mut account = empty_account();
        let asks: Vec<orderbook::Order> = (0..10)
            .map(|i| order(2, orderbook::Side::Ask, 10 + i as u64, 1, i as u64))
            .collect();
        let mut book = orderbook::Book {
            bids: vec![],
            asks,
            next_seq: 10,
        };
        // MAX_MATCH_STEPS == 8: 8 makers fill; the taker's 2-unit remainder
        // hits the budget and is cancelled IOC-style (D10′) — never re-queued
        // as a Residual, never rested.
        let incoming = order(1, orderbook::Side::Bid, 30, 10, 0);
        let fills = match_open_taker(&mut account, &mut book, incoming, 0, 0).unwrap();
        assert_eq!(fills.len(), 8);
        assert_eq!(fills.iter().map(|f| f.size).sum::<u64>(), 8);
        assert_eq!(account.event_write_cursor, 8, "8 fills, no residual event");
        assert!(
            account.events.iter().all(|e| e.kind != EVENT_KIND_RESIDUAL),
            "a budget-hit open remainder must never re-queue a Residual"
        );
        assert_eq!(book.asks.len(), 2, "unmatched makers stay");
        assert!(
            book.bids.is_empty(),
            "the remainder is cancelled, never rested"
        );
    }

    #[test]
    fn open_limit_rests_exhausted_remainder() {
        let mut account = empty_account();
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![
                order(2, orderbook::Side::Ask, 10, 3, 0),
                order(2, orderbook::Side::Ask, 11, 3, 1),
            ],
            next_seq: 2,
        };
        // Taker bids 12 for 10: fills 6 against the two asks, the remaining 4
        // no longer crosses (book exhausted) and rests at the limit price.
        let incoming = order(1, orderbook::Side::Bid, 12, 10, 2);
        let fills = match_open_taker(&mut account, &mut book, incoming, 0, 0).unwrap();
        assert_eq!(fills.iter().map(|f| f.size).sum::<u64>(), 6);
        assert!(book.asks.is_empty());
        assert_eq!(book.bids.len(), 1);
        assert_eq!(book.bids[0].price, 12);
        assert_eq!(book.bids[0].size, 4);
    }

    #[test]
    fn open_limit_pure_self_trade_rejected() {
        let mut account = empty_account();
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![order(1, orderbook::Side::Ask, 10, 5, 0)], // taker's own ask
            next_seq: 1,
        };
        let incoming = order(1, orderbook::Side::Bid, 12, 5, 1);
        let err = match_open_taker(&mut account, &mut book, incoming, 0, 0)
            .expect_err("a pure self-trade must be rejected");
        assert_eq!(err, FructusError::SelfTrade.into());
    }

    #[test]
    fn open_limit_self_trade_cancels_remainder_when_filled() {
        let mut account = empty_account();
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![
                order(1, orderbook::Side::Ask, 9, 100, 0), // self-owned, better price
                order(2, orderbook::Side::Ask, 10, 100, 1),
            ],
            next_seq: 2,
        };
        // Taker (owner 1) bids 10 for 150: the non-self ask fills 100; the only
        // remaining crossable maker is self-owned — the remainder is cancelled,
        // not used to revert the legitimate fills (F4 semantics).
        let incoming = order(1, orderbook::Side::Bid, 10, 150, 2);
        let fills = match_open_taker(&mut account, &mut book, incoming, 0, 0).unwrap();
        assert_eq!(fills.iter().map(|f| f.size).sum::<u64>(), 100);
        assert_eq!(book.asks.len(), 1, "self-owned ask is skipped, not filled");
        assert_eq!(book.asks[0].seq, 0);
        assert!(book.bids.is_empty(), "self-crossing remainder cancelled");
    }

    #[test]
    fn open_market_remainder_cancelled() {
        let mut account = empty_account();
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![order(2, orderbook::Side::Ask, 10, 3, 0)],
            next_seq: 1,
        };
        let incoming = order(1, orderbook::Side::Bid, 0, 10, 1); // market long 10
        let fills = match_open_taker(&mut account, &mut book, incoming, 0, 0).unwrap();
        assert_eq!(
            fills.iter().map(|f| f.size).sum::<u64>(),
            3,
            "market fills to exhaustion"
        );
        assert!(
            book.bids.is_empty(),
            "unfilled market remainder is cancelled"
        );
        assert_eq!(account.event_write_cursor, 1);
    }

    // --- REQ-3 (D10): a full event ring fails the open, never drops fills ---

    #[test]
    fn open_book_full_on_full_ring() {
        let mut account = empty_account();
        for i in 0..(EVENT_QUEUE_LEN as u64) {
            append_event(
                &mut account,
                EVENT_KIND_CANCEL,
                Pubkey::from([7; 32]),
                Pubkey::default(),
                SIDE_BID,
                i,
                i,
                0,
                0,
            );
        }
        let mut book = orderbook::Book {
            bids: vec![],
            asks: vec![order(2, orderbook::Side::Ask, 10, 5, 0)],
            next_seq: 1,
        };
        let incoming = order(1, orderbook::Side::Bid, 12, 5, 1);
        let err = match_open_taker(&mut account, &mut book, incoming, 111, 222)
            .expect_err("a full event ring must fail the open, never drop fills");
        assert_eq!(err, FructusError::BookFull.into());
    }

    // --- REQ-5: settle_fill event state machine ---

    #[test]
    fn settle_event_returns_pending_fill() {
        let mut account = empty_account();
        let mut fill_ev = OutEvent::default();
        fill_ev.seq = 5;
        fill_ev.kind = EVENT_KIND_FILL;
        fill_ev.settled = 0;
        account.events[5] = fill_ev;
        let ev = settle_event(&account, 5)
            .unwrap()
            .expect("a pending fill must be returned");
        assert_eq!(ev.seq, 5);
    }

    #[test]
    fn settle_event_idempotent_noop_for_settled_fill() {
        let mut account = empty_account();
        let mut fill_ev = OutEvent::default();
        fill_ev.seq = 5;
        fill_ev.kind = EVENT_KIND_FILL;
        fill_ev.settled = 1;
        account.events[5] = fill_ev;
        assert!(
            settle_event(&account, 5).unwrap().is_none(),
            "an already-settled fill is an idempotent no-op (D9)"
        );
    }

    #[test]
    fn settle_event_stale_slot_is_event_not_found() {
        let mut account = empty_account();
        // The ring slot for seq 5 holds a DIFFERENT event (wrapped/overwritten).
        let mut other = OutEvent::default();
        other.seq = 6;
        other.kind = EVENT_KIND_FILL;
        account.events[5] = other;
        let err = settle_event(&account, 5).expect_err("a stale slot must fail");
        assert_eq!(err, FructusError::EventNotFound.into());
    }

    #[test]
    fn settle_event_non_fill_is_event_not_found() {
        let mut account = empty_account();
        let mut cancel = OutEvent::default();
        cancel.seq = 5;
        cancel.kind = EVENT_KIND_CANCEL;
        account.events[5] = cancel;
        let err = settle_event(&account, 5).expect_err("a non-Fill event cannot be settled");
        assert_eq!(err, FructusError::EventNotFound.into());
    }

    // --- REQ-5: maker PDA derivation + supplied-account verification ---

    #[test]
    fn verify_maker_accounts_accepts_derived_pdas() {
        let market = Pubkey::from([9; 32]);
        let owner = Pubkey::from([5; 32]);
        let mut event = OutEvent::default();
        event.owner = owner;
        event.side = SIDE_ASK;
        let (pos_pda, pos_bump) = Pubkey::find_program_address(
            &[POSITION_SEED, market.as_ref(), owner.as_ref(), &[SIDE_ASK]],
            &crate::ID,
        );
        let (uc_pda, _) = Pubkey::find_program_address(
            &[USER_COLLATERAL_SEED, market.as_ref(), owner.as_ref()],
            &crate::ID,
        );
        assert_eq!(
            verify_maker_accounts(&market, &event, &pos_pda, &uc_pda).unwrap(),
            pos_bump,
            "correctly derived accounts pass and return the position bump"
        );
    }

    #[test]
    fn verify_maker_accounts_rejects_mismatch() {
        let market = Pubkey::from([9; 32]);
        let owner = Pubkey::from([5; 32]);
        let mut event = OutEvent::default();
        event.owner = owner;
        event.side = SIDE_BID;
        let (pos_pda, _) = Pubkey::find_program_address(
            &[POSITION_SEED, market.as_ref(), owner.as_ref(), &[SIDE_BID]],
            &crate::ID,
        );
        let (uc_pda, _) = Pubkey::find_program_address(
            &[USER_COLLATERAL_SEED, market.as_ref(), owner.as_ref()],
            &crate::ID,
        );
        // Wrong position key.
        let err = verify_maker_accounts(&market, &event, &Pubkey::from([1; 32]), &uc_pda)
            .expect_err("a mismatched position account must fail");
        assert_eq!(err, ProgramError::InvalidAccountData.into());
        // Wrong collateral key.
        let err = verify_maker_accounts(&market, &event, &pos_pda, &Pubkey::from([1; 32]))
            .expect_err("a mismatched collateral account must fail");
        assert_eq!(err, ProgramError::InvalidAccountData.into());
    }

    // --- REQ-5: full maker-settlement flow (open-intent re-open) ---

    #[test]
    fn settle_fill_flow_reopens_and_books_maker() {
        let market = Pubkey::from([9; 32]);
        let owner = Pubkey::from([5; 32]);
        let mut account = empty_account();
        let mut fill_ev = OutEvent::default();
        fill_ev.seq = 3;
        fill_ev.kind = EVENT_KIND_FILL;
        fill_ev.owner = owner;
        fill_ev.side = SIDE_ASK; // the maker asked => short position
        fill_ev.size = 1_000_000;
        fill_ev.price = 10;
        fill_ev.entry_total_lamports = 2_000_000_000;
        fill_ev.entry_pool_token_supply = 1_000_000;
        account.events[3] = fill_ev;

        let event = settle_event(&account, 3).unwrap().unwrap();
        let (pos_pda, _) = Pubkey::find_program_address(
            &[POSITION_SEED, market.as_ref(), owner.as_ref(), &[SIDE_ASK]],
            &crate::ID,
        );
        let (uc_pda, _) = Pubkey::find_program_address(
            &[USER_COLLATERAL_SEED, market.as_ref(), owner.as_ref()],
            &crate::ID,
        );
        verify_maker_accounts(&market, &event, &pos_pda, &uc_pda).unwrap();

        // The maker's position is closed (retained): settlement re-opens it at
        // the event-carried snapshot and stamps the settlement slot (FR-5).
        let mut pos = position(0, 999, 888, 0, 0);
        pos.side = SIDE_ASK;
        let mut uc = user_collateral(1_000_000_000, 0);
        let fill = [orderbook::Fill {
            maker_seq: event.seq,
            maker_owner: event.owner,
            taker_owner: event.counterparty,
            size: event.size,
            price: event.price,
        }];
        apply_open_fills(
            &mut pos,
            &mut uc,
            1_000,
            &fill,
            event.entry_total_lamports,
            event.entry_pool_token_supply,
            77,
            100,
        )
        .unwrap();
        assert_eq!(pos.notional, 1_000_000);
        assert_eq!(pos.entry_n_sum, 2_000_000_000u128 * 1_000_000);
        assert_eq!(pos.entry_d_sum, 1_000_000u128 * 1_000_000);
        assert_eq!(
            pos.open_slot, 77,
            "maker re-open stamps the settlement slot"
        );
        assert_eq!(uc.reserved, pos.collateral, "maker margin reserved");
    }

    // --- Property-based invariants over the account adapters (issue #5) ------
    //
    // The deterministic tests above pin specific scenarios; these proptests pin
    // the general contracts design.md §5 demands of the adapters (REQ-3/4/5/7),
    // driving the private adapter functions directly so the lib PBT suite
    // exercises them at high run count.

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // REQ-3/REQ-7 (I-close/atomicity): open fills settle inline — notional,
        // entry sums, and margin track margin_required(new_notional) exactly;
        // a shortfall is atomic (neither account mutated).
        #[test]
        fn apply_open_fills_accounting(
            deposited in 0u64..1_000_000_000_000_000u64,
            initial_margin_bps in 1u16..=10_000,
            fill_sizes in proptest::collection::vec(1u64..1_000_000u64, 1..8),
            entry_total_lamports in 1u64..1_000_000_000_000_000u64,
            entry_pool_token_supply in 1u64..1_000_000_000_000_000u64,
            now_slot in 0u64..1_000_000_000u64,
        ) {
            let fills: Vec<orderbook::Fill> = fill_sizes.iter()
                .map(|&s| orderbook::Fill {
                    maker_seq: 0,
                    maker_owner: Pubkey::from([2u8; 32]),
                    taker_owner: Pubkey::from([1u8; 32]),
                    size: s,
                    price: 10,
                })
                .collect();
            let total: u64 = fill_sizes.iter().sum();
            let margin = positions::margin_required(total, initial_margin_bps).unwrap();

            if margin <= deposited {
                // Branch A: the whole batch is affordable.
                let mut position = position(0, 0, 0, 0, 0);
                let mut uc = user_collateral(deposited, 0);
                apply_open_fills(
                    &mut position,
                    &mut uc,
                    initial_margin_bps,
                    &fills,
                    entry_total_lamports,
                    entry_pool_token_supply,
                    now_slot,
                    100,
                )
                .unwrap();
                prop_assert_eq!(position.notional, total, "notional accumulates the fills");
                prop_assert_eq!(
                    position.collateral,
                    margin,
                    "collateral tracks margin_required(new_notional)"
                );
                prop_assert_eq!(uc.reserved, margin, "reserved grows by the margin delta");
                prop_assert!(
                    uc.reserved <= uc.deposited,
                    "free = deposited - reserved is never negative"
                );
                prop_assert_eq!(
                    position.entry_n_sum,
                    (entry_total_lamports as u128) * (total as u128),
                    "entry_n_sum := snapshot numerator x Σ fill size (single-tx snapshot)"
                );
                prop_assert_eq!(
                    position.entry_d_sum,
                    (entry_pool_token_supply as u128) * (total as u128),
                    "entry_d_sum := snapshot denominator x Σ fill size"
                );
                prop_assert_eq!(position.open_slot, now_slot, "a fresh open records the fill slot");
            } else {
                // Branch B: reserving the batch rate exceeds free collateral.
                let mut position = position(0, 0, 0, 0, 0);
                let mut uc = user_collateral(deposited, 0);
                let err = apply_open_fills(
                    &mut position,
                    &mut uc,
                    initial_margin_bps,
                    &fills,
                    entry_total_lamports,
                    entry_pool_token_supply,
                    now_slot,
                    100,
                )
                .expect_err("a margin shortfall must fail the open");
                prop_assert_eq!(err, FructusError::InsufficientFreeCollateral.into());
                // Atomic: neither account is mutated by the failed reservation.
                prop_assert_eq!(position.notional, 0);
                prop_assert_eq!(position.entry_n_sum, 0);
                prop_assert_eq!(position.entry_d_sum, 0);
                prop_assert_eq!(position.collateral, 0);
                prop_assert_eq!(uc.reserved, 0);
            }
        }

        // REQ-4/REQ-7 (I-close-non-negative): close fills reduce notional,
        // release exactly the margin delta, leave the entry sums unchanged, and
        // never drive notional below 0 (atomic on an over-close).
        #[test]
        fn apply_close_fills_accounting(
            start_notional in 1u64..1_000_000u64,
            close_sizes in proptest::collection::vec(1u64..1_000_000u64, 1..8),
            initial_margin_bps in 1u16..=10_000,
            extra_reserved in 0u64..1_000_000u64,
        ) {
            let close_total: u64 = close_sizes.iter().sum();
            let collateral = positions::margin_required(start_notional, initial_margin_bps).unwrap();
            let mut position = position(start_notional, 12345u128, 67890u128, collateral, 7);
            let mut uc = user_collateral(
                1_000_000_000_000u64,
                collateral.checked_add(extra_reserved).unwrap(),
            );
            let reserved_before = uc.reserved;
            let fills: Vec<orderbook::Fill> = close_sizes.iter()
                .map(|&s| orderbook::Fill {
                    maker_seq: 0,
                    maker_owner: Pubkey::from([2u8; 32]),
                    taker_owner: Pubkey::from([1u8; 32]),
                    size: s,
                    price: 10,
                })
                .collect();

            if close_total <= start_notional {
                apply_close_fills(&mut position, &mut uc, initial_margin_bps, &fills).unwrap();
                let new_notional = start_notional - close_total;
                let new_collateral =
                    positions::margin_required(new_notional, initial_margin_bps).unwrap();
                let released = collateral - new_collateral;
                prop_assert_eq!(position.notional, new_notional, "never below zero");
                prop_assert_eq!(position.collateral, new_collateral, "collateral recomputed down");
                prop_assert_eq!(
                    uc.reserved,
                    reserved_before - released,
                    "reserved releases exactly the margin delta (never below 0)"
                );
                prop_assert_eq!(position.entry_n_sum, 12345u128, "entry sums unchanged on close");
                prop_assert_eq!(position.entry_d_sum, 67890u128);
                prop_assert_eq!(position.open_slot, 7, "open_slot unchanged on close");
            } else {
                let err = apply_close_fills(&mut position, &mut uc, initial_margin_bps, &fills)
                    .expect_err("closing more than the position holds must fail");
                prop_assert_eq!(err, FructusError::InvalidCloseSize.into());
                // Atomic: no mutation on error.
                prop_assert_eq!(position.notional, start_notional);
                prop_assert_eq!(position.collateral, collateral);
                prop_assert_eq!(uc.reserved, reserved_before);
            }
        }

        // REQ-5/D9/OQ-1 (idempotent settle + event-not-found): a settled Fill is
        // an idempotent no-op, a pending Fill is returned, and a stale slot or a
        // non-Fill event at the seq's slot is EventNotFound.
        #[test]
        fn settle_event_state_machine(
            seq in 0u64..10_000_000u64,
            event_seq in 0u64..10_000_000u64,
            kind in any::<u8>(),
            settled in any::<u8>(),
        ) {
            let mut account = empty_account();
            let idx = (seq % EVENT_QUEUE_LEN as u64) as usize;
            let mut ev = OutEvent::default();
            ev.seq = event_seq;
            ev.kind = kind;
            ev.settled = settled;
            account.events[idx] = ev;
            let result = settle_event(&account, seq);
            if event_seq == seq && kind == EVENT_KIND_FILL {
                if settled != 0 {
                    prop_assert_eq!(result, Ok(None), "settled Fill -> idempotent no-op (D9)");
                } else {
                    let ev = result.unwrap().expect("a pending Fill is returned");
                    prop_assert_eq!(ev.seq, seq);
                }
            } else {
                prop_assert_eq!(
                    result,
                    Err(FructusError::EventNotFound.into()),
                    "a stale slot / non-Fill event is EventNotFound (OQ-1)"
                );
            }
        }

        // REQ-5: the maker's Position/UserCollateral PDAs are derived from the
        // event's owner + side and verified byte-for-byte; a mismatch on either
        // key is InvalidAccountData.
        #[test]
        fn verify_maker_accounts_binds_owner_and_side(
            market_byte in any::<u8>(),
            owner_byte in any::<u8>(),
            side in 0u8..2u8,
            swap_pos in any::<bool>(),
            swap_coll in any::<bool>(),
        ) {
            let market = Pubkey::from([market_byte; 32]);
            let owner = Pubkey::from([owner_byte; 32]);
            let mut event = OutEvent::default();
            event.owner = owner;
            event.side = side;
            let (pos_pda, pos_bump) = Pubkey::find_program_address(
                &[POSITION_SEED, market.as_ref(), owner.as_ref(), &[side]],
                &crate::ID,
            );
            let (coll_pda, _) = Pubkey::find_program_address(
                &[USER_COLLATERAL_SEED, market.as_ref(), owner.as_ref()],
                &crate::ID,
            );
            let pos_key = if swap_pos { Pubkey::new_unique() } else { pos_pda };
            let coll_key = if swap_coll { Pubkey::new_unique() } else { coll_pda };
            let r = verify_maker_accounts(&market, &event, &pos_key, &coll_key);
            if swap_pos || swap_coll {
                prop_assert_eq!(
                    r,
                    Err(ProgramError::InvalidAccountData.into()),
                    "a non-matching account key must be rejected"
                );
            } else {
                prop_assert_eq!(
                    r.unwrap(),
                    pos_bump,
                    "matching derived accounts pass and return the position bump"
                );
            }
        }

        // REQ-7/D11 (I-accounting): the single per-(market,user) collateral
        // ledger reserves the SUM of the long and short position collateral; free
        // = deposited - reserved and is never negative; an unaffordable second
        // side fails atomically (open leaves the ledger at the long margin).
        #[test]
        fn reserved_is_sum_of_long_and_short_collateral(
            deposited in 0u64..10_000_000_000_000u64,
            long_n in 1u64..1_000_000u64,
            short_n in 1u64..1_000_000u64,
            initial_margin_bps in 1u16..=10_000,
        ) {
            let c_long = positions::margin_required(long_n, initial_margin_bps).unwrap();
            let c_short = positions::margin_required(short_n, initial_margin_bps).unwrap();
            let c_sum = c_long.checked_add(c_short).unwrap();
            let long_fill = [orderbook::Fill {
                maker_seq: 0,
                maker_owner: Pubkey::from([2u8; 32]),
                taker_owner: Pubkey::from([1u8; 32]),
                size: long_n,
                price: 10,
            }];
            let short_fill = [orderbook::Fill {
                maker_seq: 0,
                maker_owner: Pubkey::from([3u8; 32]),
                taker_owner: Pubkey::from([1u8; 32]),
                size: short_n,
                price: 10,
            }];
            let mut long_pos = position(0, 0, 0, 0, 0);
            let mut short_pos = position(0, 0, 0, 0, 0);
            let mut uc = user_collateral(deposited, 0);

            if c_sum <= deposited {
                apply_open_fills(&mut long_pos, &mut uc, initial_margin_bps, &long_fill, 100, 100, 1, 100)
                    .unwrap();
                apply_open_fills(&mut short_pos, &mut uc, initial_margin_bps, &short_fill, 200, 100, 1, 100)
                    .unwrap();
                prop_assert_eq!(long_pos.collateral, c_long);
                prop_assert_eq!(short_pos.collateral, c_short);
                prop_assert_eq!(
                    uc.reserved,
                    c_sum,
                    "reserved == Σ collateral(long) + collateral(short)"
                );
                prop_assert_eq!(
                    collateral::free_collateral(deposited, uc.reserved),
                    Some(deposited - uc.reserved),
                    "free = deposited - reserved, never negative"
                );
            } else {
                // The long side opens only when its own margin fits; the short
                // side then fails if c_long + c_short > deposited (atomic).
                if c_long > deposited {
                    let r = apply_open_fills(
                        &mut long_pos,
                        &mut uc,
                        initial_margin_bps,
                        &long_fill,
                        100,
                        100,
                        1,
                        100,
                    );
                    prop_assert_eq!(r, Err(FructusError::InsufficientFreeCollateral.into()));
                } else {
                    apply_open_fills(
                        &mut long_pos,
                        &mut uc,
                        initial_margin_bps,
                        &long_fill,
                        100,
                        100,
                        1,
                        100,
                    )
                    .unwrap();
                    let r = apply_open_fills(
                        &mut short_pos,
                        &mut uc,
                        initial_margin_bps,
                        &short_fill,
                        200,
                        100,
                        1,
                        100,
                    );
                    prop_assert_eq!(
                        r,
                        Err(FructusError::InsufficientFreeCollateral.into()),
                        "the short open must fail atomically when the sum exceeds deposited"
                    );
                    prop_assert_eq!(uc.reserved, c_long, "ledger unchanged by the failed short");
                    prop_assert_eq!(short_pos.notional, 0);
                }
            }
        }
    }
}
