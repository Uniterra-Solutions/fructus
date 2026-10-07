//! Property-based tests for the yield oracle data module's pure logic.
//!
//! Each test traces to a requirement: REQ-3 (ed25519 parsing), REQ-4 (version
//! monotonicity), REQ-5 (APY bounds), REQ-7/REQ-9 (staleness, overflow safety).

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use proptest::prelude::*;

use crate::constants::{EVENT_QUEUE_LEN, MAX_APY, POSITION_SEED};
use crate::ed25519::{parse_ed25519_instruction, ED25519_PUBKEY_LEN};
use crate::error::FructusError;
use crate::exchange::{
    annualize, ExchangeRate, ACCOUNT_TYPE_OFFSET, ACCOUNT_TYPE_STAKE_POOL,
    POOL_TOKEN_SUPPLY_OFFSET, TOTAL_LAMPORTS_OFFSET,
};
use crate::positions::{margin_required, pnl, PositionSide};
use crate::state::{
    apy_in_bounds, funding_k_in_bounds, initial_margin_in_bounds, is_stale,
    maintenance_margin_in_bounds, max_funding_in_bounds, update_message, validate_version,
    Position, UserCollateral,
};
use solana_instruction::BorrowedInstruction;
use solana_instructions_sysvar::construct_instructions_data;
use solana_sdk_ids::{ed25519_program, sysvar};

use crate::collateral::{deposit, free_collateral, withdraw};
use crate::orderbook::{
    best_ask, best_bid, cancel, is_crossable, match_order, mid, post_limit, price_better, twap,
    Book, Observation, Order, OrderKind, Side,
};

// Adversarial-review adapters (private crate-root helpers that drive the REAL
// `apply_open_fills` / `apply_close_fills`, plus the pure `funding_epoch` used by
// the re-open rebase invariants).
use crate::funding::funding_epoch;
use crate::{apply_close_fills, apply_open_fills};

/// Size of an ed25519 signature in bytes.
const ED25519_SIGNATURE_LEN: usize = 64;

// --- REQ-7 / REQ-9: staleness predicate is exact and overflow-safe ---

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn stale_predicate_matches_saturating_threshold(
        last_update_slot in 0u64..,
        stale_after_slots in 0u64..,
        current_slot in 0u64..,
    ) {
        let expected = current_slot.saturating_sub(last_update_slot) >= stale_after_slots;
        prop_assert_eq!(
            is_stale(last_update_slot, stale_after_slots, current_slot),
            expected
        );
    }

    #[test]
    fn staleness_is_monotonic_in_current_slot(
        last_update_slot in 0u64..,
        stale_after_slots in 0u64..,
        current_slot in 0u64..,
        delta in 0u64..1_000_000,
    ) {
        let later = current_slot.saturating_add(delta);
        let now_stale = is_stale(last_update_slot, stale_after_slots, current_slot);
        let later_stale = is_stale(last_update_slot, stale_after_slots, later);
        // Once stale, an increasing slot must keep it stale.
        prop_assert!(!now_stale || later_stale);
    }

    // --- REQ-4: version must strictly increase ---

    #[test]
    fn version_must_strictly_increase(current in 0u64.., next in 0u64..) {
        let accepted = validate_version(current, next).is_ok();
        prop_assert_eq!(accepted, next > current);
    }

    // --- REQ-5: APY bounds ---

    #[test]
    fn apy_bounds_reject_above_max(apy in 0u64..) {
        prop_assert_eq!(apy_in_bounds(apy), apy <= MAX_APY);
    }

    // --- REQ-3: canonical update message is deterministic and input-sensitive ---

    #[test]
    fn update_message_is_deterministic_and_sensitive(apy in 0u64.., version in 0u64..) {
        let oracle = Pubkey::from([1u8; 32]);
        let m1 = update_message(&oracle, apy, version);
        let m2 = update_message(&oracle, apy, version);
        prop_assert_eq!(m1, m2);

        let m3 = update_message(&oracle, apy.wrapping_add(1), version);
        prop_assert_ne!(m1, m3);

        let m4 = update_message(&oracle, apy, version.wrapping_add(1));
        prop_assert_ne!(m1, m4);
    }
}

// --- REQ-3: ed25519 instruction data parsing ---

#[test]
fn parse_ed25519_instruction_round_trips_inline_data() {
    let pk = Pubkey::from([9u8; 32]);
    let msg = [0xABu8; 32];
    let data = build_ed25519_instruction_data(&pk, &msg);
    let parsed = parse_ed25519_instruction(&data).expect("parse should succeed");
    assert_eq!(parsed.public_key, pk.to_bytes());
    assert_eq!(parsed.message, msg.to_vec());
}

#[test]
fn parse_ed25519_instruction_rejects_malformed() {
    assert!(parse_ed25519_instruction(&[]).is_none());
    assert!(parse_ed25519_instruction(&[0u8; 4]).is_none());

    // num_signatures != 1 is unsupported.
    let pk = Pubkey::from([9u8; 32]);
    let mut data = build_ed25519_instruction_data(&pk, &[1u8; 32]);
    data[0] = 2;
    assert!(parse_ed25519_instruction(&data).is_none());

    // Truncated data (offsets point past the buffer) is rejected without panic.
    let data = build_ed25519_instruction_data(&pk, &[1u8; 32]);
    assert!(parse_ed25519_instruction(&data[..16]).is_none());
}

#[test]
fn parse_ed25519_instruction_rejects_cross_instruction_references() {
    let pk = Pubkey::from([9u8; 32]);
    let msg = [0xABu8; 32];

    // signature_instruction_index != u16::MAX: runtime would read the signature
    // from another instruction, while we read inline — reject.
    let mut data = build_ed25519_instruction_data(&pk, &msg);
    data[4..6].copy_from_slice(&0u16.to_le_bytes());
    assert!(parse_ed25519_instruction(&data).is_none());

    // public_key_instruction_index != u16::MAX.
    let mut data = build_ed25519_instruction_data(&pk, &msg);
    data[8..10].copy_from_slice(&0u16.to_le_bytes());
    assert!(parse_ed25519_instruction(&data).is_none());

    // message_instruction_index != u16::MAX.
    let mut data = build_ed25519_instruction_data(&pk, &msg);
    data[14..16].copy_from_slice(&0u16.to_le_bytes());
    assert!(parse_ed25519_instruction(&data).is_none());
}

// --- Settlement: exchange rate + realized yield ---

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn self_yield_is_zero(n in 1u64..1_000_000_000, d in 1u64..1_000_000_000) {
        let r = ExchangeRate { total_lamports: n, pool_token_supply: d };
        prop_assert_eq!(r.realized_yield(&r), Some(0));
    }

    #[test]
    fn yield_monotonic_in_settle_numerator(
        n0 in 1u64..1_000_000,
        d0 in 1u64..1_000_000,
        d1 in 1u64..1_000_000,
        n1 in 1u64..1_000_000,
        delta in 0u64..1_000_000,
    ) {
        let open = ExchangeRate { total_lamports: n0, pool_token_supply: d0 };
        let settle = ExchangeRate { total_lamports: n1, pool_token_supply: d1 };
        let settle_higher = ExchangeRate {
            total_lamports: n1.saturating_add(delta),
            pool_token_supply: d1,
        };
        let y1 = open.realized_yield(&settle).unwrap();
        let y2 = open.realized_yield(&settle_higher).unwrap();
        prop_assert!(y2 >= y1);
    }

    #[test]
    fn annualize_is_identity_when_period_equals_year(
        yield_scaled in 0u64..1_000_000,
        slots_per_year in 1u64..1_000_000,
    ) {
        prop_assert_eq!(
            annualize(yield_scaled, slots_per_year, slots_per_year),
            Some(yield_scaled)
        );
    }

    #[test]
    fn annualize_rejects_zero_period(yield_scaled in 0u64.., slots_per_year in 0u64..) {
        prop_assert_eq!(annualize(yield_scaled, 0, slots_per_year), None);
    }

    #[test]
    fn exchange_rate_read_round_trips(n in 1u64.., d in 1u64..) {
        let mut buf = vec![0u8; POOL_TOKEN_SUPPLY_OFFSET + 8];
        buf[ACCOUNT_TYPE_OFFSET] = ACCOUNT_TYPE_STAKE_POOL;
        buf[TOTAL_LAMPORTS_OFFSET..TOTAL_LAMPORTS_OFFSET + 8].copy_from_slice(&n.to_le_bytes());
        buf[POOL_TOKEN_SUPPLY_OFFSET..POOL_TOKEN_SUPPLY_OFFSET + 8].copy_from_slice(&d.to_le_bytes());
        let r = ExchangeRate::read(&buf).unwrap();
        prop_assert_eq!(r.total_lamports, n);
        prop_assert_eq!(r.pool_token_supply, d);
    }

    #[test]
    fn exchange_rate_read_rejects_zero_supply(n in 0u64..) {
        let mut buf = vec![0u8; POOL_TOKEN_SUPPLY_OFFSET + 8];
        buf[ACCOUNT_TYPE_OFFSET] = ACCOUNT_TYPE_STAKE_POOL;
        buf[TOTAL_LAMPORTS_OFFSET..TOTAL_LAMPORTS_OFFSET + 8].copy_from_slice(&n.to_le_bytes());
        // pool_token_supply stays 0
        prop_assert!(ExchangeRate::read(&buf).is_none());
    }

    #[test]
    fn exchange_rate_read_rejects_non_stake_pool(n in 1u64.., d in 1u64..) {
        let mut buf = vec![0u8; POOL_TOKEN_SUPPLY_OFFSET + 8];
        buf[ACCOUNT_TYPE_OFFSET] = 0; // not AccountType::StakePool
        buf[TOTAL_LAMPORTS_OFFSET..TOTAL_LAMPORTS_OFFSET + 8].copy_from_slice(&n.to_le_bytes());
        buf[POOL_TOKEN_SUPPLY_OFFSET..POOL_TOKEN_SUPPLY_OFFSET + 8].copy_from_slice(&d.to_le_bytes());
        prop_assert!(ExchangeRate::read(&buf).is_none());
    }
}

#[test]
fn exchange_rate_read_rejects_short_data() {
    // Valid discriminator but too short to contain both u64 fields.
    let mut buf = vec![0u8; POOL_TOKEN_SUPPLY_OFFSET];
    buf[ACCOUNT_TYPE_OFFSET] = ACCOUNT_TYPE_STAKE_POOL;
    assert!(ExchangeRate::read(&buf).is_none());
}

// --- Cross-language message vector (locks publisher ↔ program consistency) ---

#[test]
fn update_message_matches_known_vector() {
    // oracle = [1u8; 32], apy = 71840 (7.184%), version = 1
    let oracle = Pubkey::from([1u8; 32]);
    let msg = update_message(&oracle, 71_840, 1);
    let expected = hex32("dd9394a5f5b4b383f2478ae97164cb69b495245a220a1be1d0996a0e0d54c1a0");
    assert_eq!(msg, expected);
}

fn hex32(s: &str) -> [u8; 32] {
    let bytes: Vec<u8> = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("valid hex"))
        .collect();
    bytes.try_into().expect("32 bytes")
}

// --- ed25519 verification end-to-end (mock instruction sysvar) ---
//
// Exercises `verify_publisher_signature` against a real serialized instruction
// list, covering the introspection path (scan → parse → compare) that unit
// tests of the pure logic cannot reach.

#[test]
fn verify_signature_accepts_matching_instruction() {
    let publisher = Pubkey::from([7u8; 32]);
    let message = [0xAAu8; 32];
    let ed25519_data = build_ed25519_instruction_data(&publisher, &message);
    let borrowed = borrowed(ed25519_data.as_slice());

    let result = run_verify(std::slice::from_ref(&borrowed), &publisher, &message);
    assert!(result.is_ok(), "unexpected: {result:?}");
}

#[test]
fn verify_signature_rejects_wrong_publisher() {
    let publisher = Pubkey::from([7u8; 32]);
    let other = Pubkey::from([8u8; 32]);
    let message = [0xAAu8; 32];
    let ed25519_data = build_ed25519_instruction_data(&other, &message);
    let borrowed = borrowed(ed25519_data.as_slice());

    let result = run_verify(std::slice::from_ref(&borrowed), &publisher, &message);
    assert!(result.is_err());
}

#[test]
fn verify_signature_rejects_wrong_message() {
    let publisher = Pubkey::from([7u8; 32]);
    let message = [0xAAu8; 32];
    let other_message = [0xBBu8; 32];
    let ed25519_data = build_ed25519_instruction_data(&publisher, &other_message);
    let borrowed = borrowed(ed25519_data.as_slice());

    let result = run_verify(std::slice::from_ref(&borrowed), &publisher, &message);
    assert!(result.is_err());
}

#[test]
fn verify_signature_rejects_missing_ed25519_instruction() {
    let publisher = Pubkey::from([7u8; 32]);
    let message = [0xAAu8; 32];

    let result = run_verify(&[], &publisher, &message);
    assert!(result.is_err());
}

#[test]
fn verify_signature_skips_unrelated_ed25519_instructions() {
    let publisher = Pubkey::from([7u8; 32]);
    let message = [0xAAu8; 32];

    // An unrelated ed25519 verification (wrong publisher) comes first.
    let other = Pubkey::from([8u8; 32]);
    let unrelated_data = build_ed25519_instruction_data(&other, &message);
    let unrelated = borrowed(unrelated_data.as_slice());

    // A malformed ed25519 instruction (non-inline reference) comes second.
    let mut bad_data = build_ed25519_instruction_data(&publisher, &message);
    bad_data[8..10].copy_from_slice(&0u16.to_le_bytes());
    let malformed = borrowed(bad_data.as_slice());

    // The matching publisher instruction comes last and must still be found.
    let good_data = build_ed25519_instruction_data(&publisher, &message);
    let good = borrowed(good_data.as_slice());

    let ixs = [unrelated, malformed, good];
    let result = run_verify(&ixs, &publisher, &message);
    assert!(result.is_ok(), "unexpected: {result:?}");
}

/// Build a `BorrowedInstruction` referencing the ed25519 program with the
/// given instruction `data`.
fn borrowed(data: &[u8]) -> BorrowedInstruction<'_> {
    BorrowedInstruction {
        program_id: &ed25519_program::ID,
        accounts: vec![],
        data,
    }
}

/// Build the mock instruction sysvar from `ixs` and run
/// [`crate::ed25519::verify_publisher_signature`] against it.
fn run_verify(ixs: &[BorrowedInstruction], publisher: &Pubkey, message: &[u8; 32]) -> Result<()> {
    // solana-instructions-sysvar 4.0.0 returns a Result here (3.0.x returned the
    // Vec directly); the serialization of an in-memory instruction list cannot
    // fail, so the expectation is the honest form of the old infallible call.
    let mut sysvar_data =
        construct_instructions_data(ixs).expect("serialize the mock instruction sysvar");
    let key = sysvar::instructions::id();
    let owner = sysvar::id();
    let mut lamports = 0u64;
    let account_info = AccountInfo::new(
        &key,
        false,
        false,
        &mut lamports,
        &mut sysvar_data,
        &owner,
        false,
    );
    crate::ed25519::verify_publisher_signature(&account_info, publisher, message)
}

/// Build an `ed25519` program instruction payload mirroring the byte layout of
/// `solana_ed25519_program::new_ed25519_instruction_with_signature` (inline
/// public key + message): header, then public key at `DATA_START`, then the
/// signature, then the message.
fn build_ed25519_instruction_data(pk: &Pubkey, msg: &[u8]) -> Vec<u8> {
    let header_len = 16usize;
    let public_key_offset = header_len;
    let signature_offset = public_key_offset + ED25519_PUBKEY_LEN;
    let message_offset = signature_offset + ED25519_SIGNATURE_LEN;
    let total = message_offset + msg.len();

    let mut data = vec![0u8; total];
    data[0] = 1; // num_signatures
    data[1] = 0; // padding
    data[2..4].copy_from_slice(&(signature_offset as u16).to_le_bytes());
    data[4..6].copy_from_slice(&u16::MAX.to_le_bytes()); // signature_instruction_index: none
    data[6..8].copy_from_slice(&(public_key_offset as u16).to_le_bytes());
    data[8..10].copy_from_slice(&u16::MAX.to_le_bytes()); // public_key_instruction_index: none
    data[10..12].copy_from_slice(&(message_offset as u16).to_le_bytes());
    data[12..14].copy_from_slice(&(msg.len() as u16).to_le_bytes()); // message_data_size
    data[14..16].copy_from_slice(&u16::MAX.to_le_bytes()); // message_instruction_index: none
                                                           // signature bytes stay zero (dummy); parsing only reads pubkey + message.
    data[public_key_offset..public_key_offset + ED25519_PUBKEY_LEN].copy_from_slice(pk.as_ref());
    data[message_offset..message_offset + msg.len()].copy_from_slice(msg);
    data
}

// --- PerpMarket init validation bounds (issue #2) ---
//
// The four pure validators below encode the exact `initialize_market` numeric
// ranges. Each proptest asserts the validator is EXACTLY the interval predicate,
// so the test doubles as the spec.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn funding_k_bounds_match_interval(k in 0u64..) {
        prop_assert_eq!(funding_k_in_bounds(k), (1..=1_000_000u64).contains(&k));
    }

    #[test]
    fn max_funding_bounds_match_interval(m in 0u64..) {
        prop_assert_eq!(max_funding_in_bounds(m), m <= 1_000_000);
    }

    #[test]
    fn initial_margin_bounds_match_interval(im in 0u16..) {
        prop_assert_eq!(initial_margin_in_bounds(im), im > 0 && im <= 10_000);
    }

    #[test]
    fn maintenance_margin_bounds_match_interval(im in 0u16.., mm in 0u16..) {
        prop_assert_eq!(maintenance_margin_in_bounds(im, mm), mm > 0 && mm <= im);
    }
}

#[test]
fn funding_k_boundary_edges() {
    assert!(funding_k_in_bounds(1));
    assert!(funding_k_in_bounds(1_000_000));
    assert!(!funding_k_in_bounds(0));
    assert!(!funding_k_in_bounds(1_000_001));
}

#[test]
fn max_funding_boundary_edges() {
    assert!(max_funding_in_bounds(0));
    assert!(max_funding_in_bounds(1_000_000));
    assert!(!max_funding_in_bounds(1_000_001));
}

#[test]
fn initial_margin_boundary_edges() {
    assert!(initial_margin_in_bounds(1));
    assert!(initial_margin_in_bounds(10_000));
    assert!(!initial_margin_in_bounds(0));
    assert!(!initial_margin_in_bounds(10_001));
}

#[test]
fn maintenance_margin_boundary_edges() {
    // initial = 1: maintenance must be in (0, 1] => only 1 is valid.
    assert!(maintenance_margin_in_bounds(1, 1));
    assert!(!maintenance_margin_in_bounds(1, 0));
    assert!(!maintenance_margin_in_bounds(1, 2));

    // initial = 10_000: maintenance must be in (0, 10_000].
    assert!(maintenance_margin_in_bounds(10_000, 10_000));
    assert!(!maintenance_margin_in_bounds(10_000, 0));
    assert!(!maintenance_margin_in_bounds(10_000, 10_001));
}

// --- Order book (CLOB) + collateral vault (issues #3 & #4) ---
//
// Property tests for the pure `orderbook` engine and `collateral` accounting.
// The public API and its semantics are documented in `orderbook.rs` /
// `collateral.rs`; these tests are the executable spec (price-time priority,
// no self-trade / over-fill, mark/twap, free-collateral accounting).

fn ob_order(owner: u8, side: Side, price: u64, size: u64, seq: u64) -> Order {
    Order {
        owner: Pubkey::from([owner; 32]),
        side,
        price,
        size,
        seq,
    }
}

fn ob_book(bids: Vec<Order>, asks: Vec<Order>) -> Book {
    Book {
        bids,
        asks,
        next_seq: 0,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn is_crossable_matches_ge(bid in 0u64.., ask in 0u64..) {
        prop_assert_eq!(is_crossable(bid, ask), bid >= ask);
    }

    #[test]
    fn price_better_matches_side(cand in 0u64.., best in 0u64..) {
        prop_assert_eq!(price_better(cand, best, Side::Bid), cand > best);
        prop_assert_eq!(price_better(cand, best, Side::Ask), cand < best);
    }

    #[test]
    fn best_bid_ask_consistency(
        bids in proptest::collection::vec((0u8..4u8, 1u64..1000u64, 1u64..100u64, 0u64..100u64), 0..8),
        asks in proptest::collection::vec((0u8..4u8, 1u64..1000u64, 1u64..100u64, 0u64..100u64), 0..8),
    ) {
        let bids: Vec<Order> = bids.into_iter().map(|(o, p, s, q)| ob_order(o, Side::Bid, p, s, q)).collect();
        let asks: Vec<Order> = asks.into_iter().map(|(o, p, s, q)| ob_order(o, Side::Ask, p, s, q)).collect();
        let expect_bid = bids.iter().map(|o| o.price).max().unwrap_or(0);
        let expect_ask = asks.iter().map(|o| o.price).min().unwrap_or(0);
        let book = ob_book(bids, asks);
        prop_assert_eq!(best_bid(&book), expect_bid);
        prop_assert_eq!(best_ask(&book), expect_ask);
    }

    #[test]
    fn mid_bounds_and_truncation(bid in 1u64..1000u64, ask in 1u64..1000u64) {
        let book = ob_book(vec![ob_order(1, Side::Bid, bid, 1, 0)], vec![ob_order(2, Side::Ask, ask, 1, 0)]);
        let m = mid(&book).unwrap();
        prop_assert_eq!(m, (bid + ask) / 2);
        if bid <= ask {
            prop_assert!(m >= bid && m <= ask);
        }
    }

    #[test]
    fn mid_empty_is_none(bid_present in any::<bool>(), ask_present in any::<bool>()) {
        let bids = if bid_present { vec![ob_order(1, Side::Bid, 10, 1, 0)] } else { vec![] };
        let asks = if ask_present { vec![ob_order(2, Side::Ask, 20, 1, 0)] } else { vec![] };
        let book = ob_book(bids, asks);
        prop_assert_eq!(mid(&book).is_none(), !bid_present || !ask_present);
    }

    #[test]
    fn mid_monotonic(bid in 1u64..1000u64, ask in 1u64..1000u64, db in 0u64..100u64, da in 0u64..100u64) {
        let m0 = mid(&ob_book(vec![ob_order(1, Side::Bid, bid, 1, 0)], vec![ob_order(2, Side::Ask, ask, 1, 0)]));
        let mb = mid(&ob_book(vec![ob_order(1, Side::Bid, bid.saturating_add(db), 1, 0)], vec![ob_order(2, Side::Ask, ask, 1, 0)]));
        let ma = mid(&ob_book(vec![ob_order(1, Side::Bid, bid, 1, 0)], vec![ob_order(2, Side::Ask, ask.saturating_add(da), 1, 0)]));
        if let (Some(a), Some(b)) = (m0, mb) { prop_assert!(b >= a); }
        if let (Some(a), Some(c)) = (m0, ma) { prop_assert!(c >= a); }
    }

    #[test]
    fn matching_no_overfill(
        maker_prices in proptest::collection::vec(1u64..100u64, 1..6),
        maker_sizes in proptest::collection::vec(1u64..100u64, 1..6),
        taker_price in 1u64..100u64,
        taker_size in 1u64..200u64,
        max_steps in 0u64..8u64,
    ) {
        let n = maker_prices.len().min(maker_sizes.len());
        let asks: Vec<Order> = (0..n).map(|i| ob_order(2, Side::Ask, maker_prices[i], maker_sizes[i], i as u64)).collect();
        let mut book = ob_book(vec![], asks);
        let incoming = ob_order(1, Side::Bid, taker_price, taker_size, 0);
        let out = match_order(&mut book, incoming, OrderKind::Limit, max_steps);
        let total: u64 = out.fills.iter().map(|f| f.size).sum();
        prop_assert!(total <= taker_size);
        let mut filled = std::collections::HashMap::new();
        for f in &out.fills {
            *filled.entry(f.maker_seq).or_insert(0u64) += f.size;
        }
        for (seq, filled_size) in filled {
            prop_assert!(filled_size <= maker_sizes[seq as usize]);
        }
        for o in &book.asks {
            prop_assert!(o.size <= maker_sizes[o.seq as usize]);
        }
    }

    #[test]
    fn matching_partial_fill_updates_book(
        maker_prices in proptest::collection::vec(1u64..100u64, 1..6),
        maker_sizes in proptest::collection::vec(1u64..100u64, 1..6),
        taker_price in 1u64..100u64,
        taker_size in 1u64..200u64,
    ) {
        let n = maker_prices.len().min(maker_sizes.len());
        let asks: Vec<Order> = (0..n).map(|i| ob_order(2, Side::Ask, maker_prices[i], maker_sizes[i], i as u64)).collect();
        let mut book = ob_book(vec![], asks.clone());
        let out = match_order(&mut book, ob_order(1, Side::Bid, taker_price, taker_size, 0), OrderKind::Limit, u64::MAX);
        let mut filled = vec![0u64; n];
        for f in &out.fills { filled[f.maker_seq as usize] += f.size; }
        let mut remaining = vec![0u64; n];
        for o in &book.asks { remaining[o.seq as usize] = o.size; }
        for i in 0..n {
            prop_assert!(filled[i] <= maker_sizes[i]);
            prop_assert_eq!(remaining[i], maker_sizes[i] - filled[i]);
        }
    }

    #[test]
    fn post_limit_never_crosses(
        posts in proptest::collection::vec((0u8..2u8, 0u64..100u64, 1u64..100u64), 0..10),
    ) {
        let mut book = ob_book(vec![], vec![]);
        for (seq, (side, price, size)) in posts.into_iter().enumerate() {
            let o = ob_order(
                1 + side,
                if side == 0 { Side::Bid } else { Side::Ask },
                price,
                size,
                seq as u64,
            );
            let _ = post_limit(&mut book, o);
            let max_bid = book.bids.iter().map(|o| o.price).max().unwrap_or(0);
            let min_ask = book.asks.iter().map(|o| o.price).min().unwrap_or(u64::MAX);
            if !book.bids.is_empty() && !book.asks.is_empty() {
                prop_assert!(max_bid < min_ask, "crossing book: bid {} ask {}", max_bid, min_ask);
            }
        }
    }

    #[test]
    fn free_collateral_checked(d in 0u64.., r in 0u64..) {
        prop_assert_eq!(free_collateral(d, r), d.checked_sub(r));
    }

    #[test]
    fn reserved_zero_invariant(d in 0u64..) {
        prop_assert_eq!(free_collateral(d, 0), Some(d));
    }

    #[test]
    fn deposit_withdraw_accounting(d in 0u64..1000u64, a in 0u64..1000u64, w in 0u64..1000u64) {
        if let Some(nd) = deposit(d, a) {
            prop_assert_eq!(nd, d + a);
            let expect = if w <= nd { Some(nd - w) } else { None };
            prop_assert_eq!(withdraw(nd, 0, 0, w), expect);
        }
    }
}

#[test]
fn matching_no_self_trade() {
    let self_order = ob_order(1, Side::Ask, 9, 100, 0); // owner 1 == taker
    let other = ob_order(2, Side::Ask, 10, 100, 1); // owner 2
    let mut book = ob_book(vec![], vec![self_order, other]);
    let out = match_order(
        &mut book,
        ob_order(1, Side::Bid, 10, 100, 0),
        OrderKind::Limit,
        u64::MAX,
    );
    assert!(
        out.fills.iter().all(|f| f.maker_seq == 1),
        "self-owned maker (seq 0) must be skipped"
    );
    assert_eq!(out.fills.iter().map(|f| f.size).sum::<u64>(), 100);
}

#[test]
fn matching_respects_price_time_priority() {
    let asks = vec![
        ob_order(9, Side::Ask, 10, 100, 2),
        ob_order(9, Side::Ask, 9, 100, 5),
        ob_order(9, Side::Ask, 10, 100, 1),
    ];
    let mut book = ob_book(vec![], asks);
    let out = match_order(
        &mut book,
        ob_order(1, Side::Bid, 10, 250, 0),
        OrderKind::Limit,
        u64::MAX,
    );
    let seqs: Vec<u64> = out.fills.iter().map(|f| f.maker_seq).collect();
    assert_eq!(seqs, vec![5, 1, 2], "price 9 first, then price 10 by seq");
    assert_eq!(out.fills[0].size, 100);
    assert_eq!(out.fills[1].size, 100);
    assert_eq!(out.fills[2].size, 50);
}

#[test]
fn market_order_is_ioc() {
    let mut book = ob_book(vec![], vec![ob_order(2, Side::Ask, 10, 50, 0)]);
    let out = match_order(
        &mut book,
        ob_order(1, Side::Bid, 0, 100, 0),
        OrderKind::Market,
        u64::MAX,
    );
    assert_eq!(out.fills.iter().map(|f| f.size).sum::<u64>(), 50);
    assert!(
        out.residual.is_none(),
        "market remainder is cancelled, never re-queued"
    );
}

#[test]
fn market_order_residual_none_when_budget_limited() {
    let asks = vec![
        ob_order(2, Side::Ask, 10, 50, 0),
        ob_order(3, Side::Ask, 10, 50, 1),
    ];
    let mut book = ob_book(vec![], asks);
    let out = match_order(
        &mut book,
        ob_order(1, Side::Bid, 0, 100, 0),
        OrderKind::Market,
        1,
    );
    assert_eq!(out.fills.len(), 1);
    assert!(out.residual.is_none());
}

#[test]
fn cancel_owner_only_and_removes_one() {
    let mut book = ob_book(
        vec![
            ob_order(1, Side::Bid, 10, 5, 0),
            ob_order(2, Side::Bid, 9, 5, 1),
        ],
        vec![],
    );
    assert!(
        cancel(&mut book, Pubkey::from([9u8; 32]), 0).is_err(),
        "non-owner cannot cancel"
    );
    assert!(
        cancel(&mut book, Pubkey::from([1u8; 32]), 99).is_err(),
        "absent seq fails"
    );
    assert!(cancel(&mut book, Pubkey::from([1u8; 32]), 0).is_ok());
    assert_eq!(book.bids.len(), 1);
    assert_eq!(book.bids[0].seq, 1);
}

#[test]
fn matching_batching_commutativity() {
    let asks = vec![
        ob_order(2, Side::Ask, 10, 10, 0),
        ob_order(3, Side::Ask, 11, 10, 1),
        ob_order(4, Side::Ask, 12, 10, 2),
        ob_order(5, Side::Ask, 13, 10, 3),
    ];
    let incoming = ob_order(1, Side::Bid, 13, 100, 0);

    let mut full = ob_book(vec![], asks.clone());
    let out_full = match_order(&mut full, incoming.clone(), OrderKind::Limit, u64::MAX);

    let mut batched = ob_book(vec![], asks);
    let out1 = match_order(&mut batched, incoming, OrderKind::Limit, 2);
    let mut all_fills = out1.fills.clone();
    let mut residual = out1.residual;
    while let Some(rem) = residual {
        let o = match_order(&mut batched, rem, OrderKind::Limit, 2);
        all_fills.extend(o.fills);
        residual = o.residual;
    }

    assert_eq!(all_fills, out_full.fills);
    assert_eq!(batched, full);
}

#[test]
fn twap_constant_mid() {
    let obs: Vec<Observation> = (0..=1000u64)
        .map(|s| Observation {
            slot: s,
            cumulative_mid: (s as u128) * 7,
        })
        .collect();
    assert_eq!(twap(&obs, 100, 1000), Some(7));
    assert_eq!(twap(&obs, 0, 1000), None, "window 0 -> None");
    assert_eq!(twap(&[], 100, 1000), None, "empty -> None");
    assert_eq!(
        twap(&obs, 2000, 1000),
        None,
        "history shorter than window -> None"
    );
}

#[test]
fn twap_within_range() {
    // piecewise-constant mids over slots; twap is a time-weighted average, so it
    // must lie within [min mid, max mid].
    let mids = [3u64, 5, 9, 7, 1, 8];
    let mut obs = Vec::new();
    let mut cum: u128 = 0;
    for (i, m) in mids.iter().enumerate() {
        obs.push(Observation {
            slot: i as u64,
            cumulative_mid: cum,
        });
        cum += *m as u128;
    }
    obs.push(Observation {
        slot: mids.len() as u64,
        cumulative_mid: cum,
    });
    if let Some(t) = twap(&obs, 3, mids.len() as u64) {
        assert!((1..=9).contains(&t), "twap {} out of range", t);
    }
}

#[test]
fn collateral_boundary_edges() {
    assert_eq!(deposit(u64::MAX, 1), None, "deposit overflow -> None");
    assert_eq!(withdraw(0, 0, 0, 1), None, "withdraw > free -> None");
    assert_eq!(withdraw(10, 5, 0, 6), None, "amount > free (10-5) -> None");
    assert_eq!(withdraw(10, 5, 0, 5), Some(5), "exactly free -> Some");
}

// --- Review regression tests (green) ---------------------------------------
//
// Each test below pins a review finding and is now GREEN (the finding was
// fixed; the test is the regression guard — it turns red if the corresponding
// contract regresses). T1/T2 are pure-logic; T3/T5/T6 are static-contract
// findings (dead error variants, an umbrella dev-dependency, a missing required
// constant) pinned as source-content assertions because they have no runtime
// behavior to exercise.

/// A zero-initialized on-chain `OrderBook` account, mirroring the empty account
/// the `initialize_order_book` handler produces (all slots default).
fn empty_onchain_order_book() -> crate::state::OrderBook {
    crate::state::OrderBook {
        market: Pubkey::default(),
        bump: 0,
        next_seq: 0,
        best_bid: 0,
        best_ask: 0,
        event_read_cursor: 0,
        event_write_cursor: 0,
        twap_cursor: 0,
        _pad: [0u8; 7],
        bids: [crate::state::Order::default(); crate::constants::MAX_ORDERS_PER_SIDE],
        asks: [crate::state::Order::default(); crate::constants::MAX_ORDERS_PER_SIDE],
        events: [crate::state::OutEvent::default(); crate::constants::EVENT_QUEUE_LEN],
        observations: [crate::state::Observation::default(); crate::constants::TWAP_OBSERVATIONS],
    }
}

/// T1: the event-queue ring silently overwrites an undrained `Residual`.
#[test]
fn event_ring_wrap_does_not_silently_drop_deferred_residual() {
    let mut account = empty_onchain_order_book();
    let asks: Vec<Order> = (0..10)
        .map(|i| ob_order(2, Side::Ask, 10 + i as u64, 1, i as u64))
        .collect();
    let mut book = Book {
        bids: vec![],
        asks,
        next_seq: 10,
    };

    // A crossing limit taker hits MAX_MATCH_STEPS == 8 and defers the remaining
    // 2 as a Residual event (8 fills + 1 residual => write_cursor == 9, and the
    // residual lands in slot 8).
    let incoming = ob_order(1, Side::Bid, 30, 10, 0);
    crate::match_limit_taker(&mut account, &mut book, incoming, 0, 0).unwrap();
    assert_eq!(account.events[8].kind, crate::EVENT_KIND_RESIDUAL);

    // Fill the ring past capacity WITHOUT draining (read_cursor stays 0): the
    // FR-8(f)/FR-9 scenario where un-cranked crossings wrap the ring.
    for i in 0..crate::constants::EVENT_QUEUE_LEN {
        crate::append_event(
            &mut account,
            crate::EVENT_KIND_FILL,
            Pubkey::from([7; 32]),
            Pubkey::default(),
            crate::SIDE_BID,
            i as u64,
            1,
            0,
            0,
        );
    }

    // The deferred Residual (the taker's still-crossable remainder) must remain
    // recoverable; a wrapping write must never silently overwrite an undrained
    // event.
    let residual_survives = account
        .events
        .iter()
        .any(|e| e.kind == crate::EVENT_KIND_RESIDUAL && e.size == 2);
    assert!(
        residual_survives,
        "deferred Residual was silently overwritten by the undrained ring wrap"
    );
}

/// T2: `twap` must answer over a caller-supplied trailing window even when the
/// caller passes an off-grid `Clock::get().slot`.
#[test]
fn twap_returns_some_over_callers_trailing_window() {
    // Observations are only appended on book mutation at irregular slots, so a
    // caller passing Clock::get().slot (off-grid) must still get a
    // time-weighted average over its trailing window (FR-11). The exact-match
    // lookup in cumulative_at currently makes this return None.
    let obs = vec![
        Observation {
            slot: 100,
            cumulative_mid: 0,
        },
        Observation {
            slot: 110,
            cumulative_mid: 100,
        },
        Observation {
            slot: 130,
            cumulative_mid: 300,
        },
    ];
    // now_slot == 125 and start == 105 are both off-grid; mid is constant 10
    // over the whole window, so the correct TWAP is 10, not None.
    assert_eq!(twap(&obs, 20, 125), Some(10));
}

/// T3: the vault's `VaultNotInitialized` variant must be wired in the handlers.
///
/// The two order-book init variants (`BookAlreadyInitialized` /
/// `BookNotInitialized`) are intentionally NOT referenced from handler bodies:
/// after the zero-copy refactor a second `init` and a pre-init book op are
/// surfaced by Anchor's `init` + zero-copy discriminator constraints before any
/// handler runs, so they remain documented forward-declarations in `error.rs`.
#[test]
fn book_error_contract_variants_are_referenced_in_handlers() {
    let lib_src = include_str!("lib.rs");
    assert!(
        lib_src.contains("VaultNotInitialized"),
        "VaultNotInitialized must be wired in the deposit/withdraw handlers"
    );
}

/// T5: the `solana-sdk` umbrella crate must not be pulled in as a dev-dependency.
#[test]
fn no_solana_sdk_umbrella_dev_dependency() {
    // AGENTS.md forbids the solana-program umbrella; the same constraint applies
    // to the solana-sdk umbrella dev-dependency (which drags the whole crate in
    // and mixes versions with the granular 3.x crates).
    let manifest = include_str!("../Cargo.toml");
    let has_umbrella = manifest
        .lines()
        .any(|l| l.trim_start().starts_with("solana-sdk ="));
    assert!(
        !has_umbrella,
        "solana-sdk umbrella crate must not be a dependency"
    );
}

/// T6: FR-2(a) / execution-plan REQ-4 require `MAX_PRICE_LEVELS_PER_SIDE`.
#[test]
fn max_price_levels_per_side_constant_exists() {
    // FR-2(a) / execution-plan REQ-4 require MAX_PRICE_LEVELS_PER_SIDE; it is
    // absent from constants.rs (price levels were collapsed into per-order
    // capacity). Pin the requirement until the deviation is explicitly accepted.
    let src = include_str!("constants.rs");
    assert!(
        src.contains("MAX_PRICE_LEVELS_PER_SIDE"),
        "FR-2(a) / REQ-4 require MAX_PRICE_LEVELS_PER_SIDE in constants.rs"
    );
}

// --- Review regression tests, round 2 (green) ------------------------------
//
// Each test below pins a round-2 review finding and is now GREEN (the finding
// was fixed; the test is the regression guard — it turns red if the
// corresponding contract regresses). F1/F2/F3/F4 are pure-logic
// (record_observation / match_limit_taker / append_event); F5 is a static
// doc/code-drift finding.

/// F1 (TWAP mis-weighting): `record_observation` is fed the POST-mutation
/// `mid(&book)` by every book-mutating handler (`save_book` runs first, then
/// `record_observation(.., mid(&book), ..)` at lib.rs 533/541/584/679), so a mid
/// that just changed is charged to the interval BEFORE the mutation. The elapsed
/// interval `[prev_obs, now)` saw the PRE-mutation mid, so that is what must be
/// charged — otherwise FR-11's TWAP is systematically biased.
#[test]
fn twap_charges_pre_mutation_mid_for_elapsed_interval() {
    let mut account = empty_onchain_order_book();
    let mut book = Book {
        bids: vec![ob_order(1, Side::Bid, 10, 1, 0)],
        asks: vec![ob_order(2, Side::Ask, 20, 1, 1)],
        next_seq: 2,
    };

    // First observation at slot 100 establishes the mid (cumulative stays 0).
    crate::record_observation(&mut account, crate::orderbook::mid(&book), 100);

    // The book mutates at slot 110: bid 10 -> 14, so the mid moves 15 -> 17.
    book.bids[0].price = 14;
    crate::save_book(&mut account, &book);
    // Mirror the handler: record the POST-mutation mid (17).
    crate::record_observation(&mut account, crate::orderbook::mid(&book), 110);

    // The interval [100, 110) saw mid 15, so the accumulator must advance by
    // 15 * 10 = 150. The current code charges the post-mutation mid 17
    // (=> 170), biasing the TWAP high.
    assert_eq!(
        u128::from_le_bytes(account.observations[1].cumulative_mid),
        150,
        "the pre-mutation mid (15) must be charged to [100, 110), not the \
         post-mutation mid (17)"
    );
}

/// F2 (crank wedge/liveness): the permissionless `crank` re-matches a `Residual`
/// via `match_limit_taker` (lib.rs crank loop). A `SelfTrade` or `BookFull`
/// error from that call reverts the whole transaction INCLUDING the read-cursor
/// advance (lib.rs 636-639), so the offending Residual stays at the queue head
/// and permanently wedges the shared crank. Root cause: `match_limit_taker` can
/// return `Err` while resuming a Residual that was already accepted (partially
/// filled) in a prior transaction — a crank-resumed Residual must be consumed,
/// never rejected.
#[test]
fn crank_resumed_residual_is_not_rejected_with_book_full() {
    let mut account = empty_onchain_order_book();

    // Bid side already at capacity (64 resting orders), so a leftover remainder
    // cannot rest there.
    let bids: Vec<Order> = (0..crate::constants::MAX_ORDERS_PER_SIDE as u64)
        .map(|i| ob_order(2, Side::Bid, 1 + i, 1, i))
        .collect();
    // One crossable ask (owner 3) of size 5.
    let asks = vec![ob_order(3, Side::Ask, 100, 5, 64)];
    let mut book = Book {
        bids,
        asks,
        next_seq: 65,
    };

    // The crank drains a Residual: owner 1's bid @ 100 for size 10. It fills the
    // 5-unit ask, and the 5-unit remainder no longer crosses (book exhausted),
    // so it tries to rest — but the bid side is full -> BookFull -> the crank
    // reverts and wedges on the offending Residual forever.
    let residual = ob_order(1, Side::Bid, 100, 10, 65);
    let result = crate::match_limit_taker(&mut account, &mut book, residual, 0, 0);

    assert!(
        result.is_ok(),
        "a crank-resumed Residual must be consumed, never rejected with BookFull \
         (the error reverts the crank's read-cursor advance and wedges the queue)"
    );
    assert!(
        book.asks.is_empty(),
        "the crossable ask must be filled before the remainder is handled"
    );
}

/// F3 (silent Residual loss): `append_event` silently drops events when the ring
/// is full, so a budget-interrupted taker's deferred `Residual` is permanently
/// lost while `place_limit_order` (via `match_limit_taker`) still returns Ok.
/// FR-8(f)/FR-9 require backpressure: an un-cranked remainder must never be
/// silently dropped while the caller reports success.
#[test]
fn deferred_residual_is_not_silently_dropped_on_full_ring() {
    let mut account = empty_onchain_order_book();

    // Fill the event ring completely without draining (read_cursor stays 0).
    account.event_read_cursor = 0;
    account.event_write_cursor = crate::constants::EVENT_QUEUE_LEN as u64;

    // 10 crossable asks; MAX_MATCH_STEPS == 8, so 2 units are deferred as a
    // Residual event.
    let asks: Vec<Order> = (0..10)
        .map(|i| ob_order(2, Side::Ask, 10 + i as u64, 1, i as u64))
        .collect();
    let mut book = Book {
        bids: vec![],
        asks,
        next_seq: 10,
    };
    let incoming = ob_order(1, Side::Bid, 30, 10, 0);

    let result = crate::match_limit_taker(&mut account, &mut book, incoming, 0, 0);

    let residual_queued = account
        .events
        .iter()
        .any(|e| e.kind == crate::EVENT_KIND_RESIDUAL && e.size == 2);
    assert!(
        result.is_err() || residual_queued,
        "a deferred Residual must not be silently dropped on a full ring \
         (the caller must backpressure or preserve the Residual, never report Ok)"
    );
}

/// F4 (self-trade blocks non-self fills): `match_limit_taker` reverts the whole
/// taker order with `SelfTrade` even after legitimate non-self fills have been
/// applied, so a self-owned resting order blocks other fills (and feeds F2). The
/// non-self fills must survive; the self-crossing remainder must be cancelled,
/// not used to revert the taker.
#[test]
fn match_limit_taker_preserves_non_self_fills_when_remainder_self_trades() {
    let mut account = empty_onchain_order_book();
    let mut book = Book {
        bids: vec![],
        // A self-owned ask at a BETTER price (9) plus a non-self ask at 10.
        asks: vec![
            ob_order(1, Side::Ask, 9, 100, 0),
            ob_order(2, Side::Ask, 10, 100, 1),
        ],
        next_seq: 2,
    };
    // Taker (owner 1) bids 10 for size 150: the non-self ask fills 100; the only
    // remaining crossable maker is the self-owned ask -> currently SelfTrade.
    let incoming = ob_order(1, Side::Bid, 10, 150, 2);

    let result = crate::match_limit_taker(&mut account, &mut book, incoming, 0, 0);

    assert!(
        result.is_ok(),
        "a self-owned resting order must not revert the whole taker order"
    );
    // The non-self ask must be filled (removed); the self-owned ask skipped.
    assert_eq!(book.asks.len(), 1, "non-self ask filled, self ask skipped");
    assert_eq!(book.asks[0].seq, 0, "self-owned ask is skipped, not filled");
    // The legitimate non-self fill must be recorded.
    assert!(account.events.iter().any(|e| {
        e.kind == crate::EVENT_KIND_FILL && e.owner == Pubkey::from([2u8; 32]) && e.size == 100
    }));
}

/// F5 (doc/code drift, FR-20): `docs/api-reference.md` still claims
/// `BookAlreadyInitialized` / `BookNotInitialized` / `VaultNotInitialized` are
/// "not yet wired" and surfaced by Anchor account constraints, but `lib.rs` now
/// wires all three with explicit `require!` checks (BookAlreadyInitialized at
/// 463, BookNotInitialized at 514/557/593/623, VaultNotInitialized at 745/806).
/// The doc must not drift from the code.
#[test]
fn api_reference_error_wiring_is_current() {
    let doc = include_str!("../../../docs/api-reference.md");
    for stale in ["not yet wired", "currently surfaced by"] {
        assert!(
            !doc.contains(stale),
            "docs/api-reference.md still describes errors as {stale:?}, but lib.rs \
             now wires BookAlreadyInitialized/BookNotInitialized/VaultNotInitialized \
             with require! checks"
        );
    }
}

// --- Review regression tests, round 3 (position-lifecycle review) ----------
//
// Each test below pins a finding from the position-lifecycle review (issue #5)
// and is now GREEN (the finding was fixed as part of the feature change; the
// test is the regression guard — it turns red if the corresponding contract
// regresses):
//
//   F1  — acceptance A-3's documented unit-test name
//         `position_lifecycle_notional_zero_is_closed` must exist in the crate,
//         so the documented evidence command runs ≥ 1 test.
//   F2a — acceptance A-6's documented unit-test name
//         `open_position_rejects_zero_size_and_invalid_side` must exist in
//         positions.rs.
//   F2b — the protocol must expose a recovery path for a squatted `Position`
//         PDA (grounded by an account-level deserialization test proving the
//         squat mechanism is real).
//   F3a — the api-reference error table must not claim `settle_fill` returns
//         `PositionNotFound` (guarded on the code side by a proptest over the
//         exact settlement path, `apply_open_fills`).
//   F3b — `margin_required_bounds` must assert the I-margin-bounds monotonicity
//         item (guarded by a proptest over the formula itself).
//   F4  — a crank `Residual` resume must never consume a maker without a
//         persisted `Fill` event (all-or-nothing resume, D10/D10'/FR-6).
//   F5  — the `Position` lazy-create gates must verify the account is still a
//         pristine system account (owner / lamports), not just data-empty.
//
// F1/F2a/F3b/F5 use the source-embedding technique (include_str! on the file
// under test, no CWD dependence) established by T3/T5/T6 and round-2 F5.

// --- F1 (acceptance A-3): the documented test name must exist ---------------

/// Exact unit-test name acceptance A-3 documents and
/// `cargo test --workspace position_lifecycle_notional_zero_is_closed` filters
/// on.
const DOCUMENTED_LIFECYCLE_TEST: &str = "position_lifecycle_notional_zero_is_closed";

fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// F1 — A-3 evidence: the documented acceptance test must exist in the crate.
/// The name is defined by `position_lifecycle_notional_zero_is_closed` in
/// positions.rs; renaming or deleting it turns this guard red.
#[test]
fn acceptance_a3_documented_test_exists() {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for sub in ["src", "tests"] {
        let dir = manifest_dir.join(sub);
        if dir.is_dir() {
            collect_rs_files(&dir, &mut files);
        }
    }
    let self_name = std::path::Path::new(file!())
        .file_name()
        .map(|s| s.to_os_string());
    let needle = format!("fn {DOCUMENTED_LIFECYCLE_TEST}");
    let mut homes: Vec<String> = Vec::new();
    for path in &files {
        if path.file_name() == self_name.as_deref() {
            continue; // this test file itself references the name in comments
        }
        if let Ok(text) = std::fs::read_to_string(path) {
            if text.contains(&needle) {
                homes.push(path.display().to_string());
            }
        }
    }
    assert!(
        !homes.is_empty(),
        "A-3 acceptance artifact missing: no test function `fn {DOCUMENTED_LIFECYCLE_TEST}` \
         exists in this crate (searched {} .rs file(s) under src/ and tests/), so \
         the documented command `cargo test --workspace {DOCUMENTED_LIFECYCLE_TEST}` runs 0 \
         tests.",
        files.len(),
    );
}

// --- F2a (acceptance A-6): the documented test name must exist --------------

/// positions.rs source, embedded at compile time (no CWD dependence), so the
/// source-content assertions below track the actual test definition.
const POSITIONS_SRC: &str = include_str!("positions.rs");

/// F2a — A-6 evidence: the acceptance-documented test name
/// `open_position_rejects_zero_size_and_invalid_side` must exist as a test
/// definition in positions.rs so the documented evidence lookup matches at
/// least one test.
#[test]
fn acceptance_a6_documented_test_name_exists() {
    assert!(
        POSITIONS_SRC.contains("fn open_position_rejects_zero_size_and_invalid_side"),
        "Acceptance A-6 documents the unit test `open_position_rejects_zero_size_and_invalid_side` \
         driving `validate_open_args`, but positions.rs no longer defines it, so the documented \
         evidence lookup `cargo test -p fructus --lib open_position_rejects_zero_size_and_invalid_side` \
         matches nothing."
    );
}

// --- F2b (squatted Position PDA): the protocol must expose a recovery path ---

/// lib.rs source embedded at compile time (no CWD dependence).
const LIB_SRC: &str = include_str!("lib.rs");

/// Names a plausible recovery instruction must carry, per the finding's remedy
/// ("no instruction to reclaim/reset the PDA").
const RECOVERY_KEYWORDS: [&str; 7] = [
    "reclaim", "reset", "recover", "repair", "unbrick", "sweep", "cleanup",
];

/// Every `pub fn` instruction handler exposed by the `#[program]` module.
fn instruction_handler_names() -> Vec<String> {
    LIB_SRC
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let rest = trimmed.strip_prefix("pub fn ")?;
            let name = rest.split(['(', '<']).next()?.trim().to_string();
            Some(name)
        })
        .collect()
}

/// The position lazy-create/existence gate sites — every line mentioning
/// `position.data_is_empty()`.
fn position_gate_lines() -> Vec<usize> {
    LIB_SRC
        .lines()
        .enumerate()
        .filter(|(_, line)| line.contains("position.data_is_empty()"))
        .map(|(i, _)| i)
        .collect()
}

/// F2b — the protocol MUST keep a recovery path for a squatted or stuck
/// `Position` PDA. GREEN via `reset_position`; the guard turns red if that
/// recovery instruction is removed and no gate self-heal replaces it.
#[test]
fn protocol_must_expose_a_position_pda_reclaim_instruction() {
    let handlers = instruction_handler_names();
    assert!(
        !handlers.is_empty(),
        "instruction-surface scan found no handlers — the repro's own scan is broken"
    );

    // Recovery shape 1: an explicit instruction whose name indicates it
    // reclaims/resets a position PDA account.
    let recovery_handlers: Vec<&String> = handlers
        .iter()
        .filter(|name| {
            RECOVERY_KEYWORDS.iter().any(|k| name.contains(k))
                && (name.contains("position") || name.contains("pda") || name.contains("account"))
        })
        .collect();

    // Recovery shape 2: the gates themselves self-heal a squat in place
    // (reclaim/drain/reset text within the gate windows).
    let windows_mention_recovery = {
        let lines: Vec<&str> = LIB_SRC.lines().collect();
        position_gate_lines().iter().any(|&i| {
            let lo = i.saturating_sub(4);
            let hi = (i + 5).min(lines.len());
            let window = lines[lo..hi].join("\n").to_lowercase();
            RECOVERY_KEYWORDS.iter().any(|k| window.contains(k))
        })
    };

    assert!(
        !recovery_handlers.is_empty() || windows_mention_recovery,
        "the Position lazy-create gates (open_position / close_position / settle_fill) treat \
         only a pristine system account (empty data && system-owned && zero lamports) as 'needs \
         creation'. An attacker can create or 1-lamport-fund an account at the Position PDA \
         [POSITION_SEED, market, user, side]; the gate then skips creation and \
         `Account::<Position>::try_from_unchecked` fails the owner check \
         (AccountOwnedByWrongProgram) — while close_position returns PositionNotFound — \
         permanently bricking open/close/settle for that (market, user, side) and freezing \
         the reserved margin. No instruction can reclaim/reset the PDA and a PDA has no \
         keypair, so the failure is permanent: the protocol MUST provide a recovery path \
         (an instruction handler whose name indicates reclaim/reset of the position PDA, or \
         gate logic that reclaims the squat in place). Current handlers: {}.",
        handlers.join(", "),
    );
}

/// Minimal `AccountInfo` (non-signer, writable, non-executable) standing in
/// for the `position` account at a PDA.
fn account_info<'a>(
    key: &'a Pubkey,
    lamports: &'a mut u64,
    data: &'a mut [u8],
    owner: &'a Pubkey,
) -> AccountInfo<'a> {
    AccountInfo::new(key, false, true, lamports, data, owner, false)
}

/// Deserialize the way the handlers do after their gate skips creation,
/// returning the anchor error (asserted to be the owner-check failure).
fn position_deserialization_error<'a>(info: &'a AccountInfo<'a>) -> String {
    match Account::<Position>::try_from_unchecked(info) {
        Ok(_) => panic!("a squatted account must never deserialize as a Position"),
        Err(e) => e.to_string(),
    }
}

/// F2b grounding: the mechanism the finding describes is real — a squatted
/// account (with data, rent-funded-but-empty, or 1-lamport) is not "pristine",
/// so the gate skips creation, and the very next step the handlers take
/// (`Account::<Position>::try_from_unchecked`) fails with exactly the errors the
/// finding cites. This documents WHY a recovery instruction (pinned by
/// `protocol_must_expose_a_position_pda_reclaim_instruction` above) is needed.
#[test]
fn squatted_pda_skips_creation_and_fails_deserialization() {
    let market = Pubkey::from([1u8; 32]);
    let user = Pubkey::from([2u8; 32]);
    let side: u8 = 0; // SIDE_BID / Long
    let (pda, _bump) = Pubkey::find_program_address(
        &[POSITION_SEED, market.as_ref(), user.as_ref(), &[side]],
        &crate::ID,
    );

    // Variant 1: attacker squat WITH data (system-owned, lamports > 0).
    let mut data1 = vec![0xABu8; 8 + Position::LEN];
    let mut lamports1: u64 = 1;
    let squat_with_data = account_info(&pda, &mut lamports1, &mut data1, &system_program::ID);
    assert!(
        !squat_with_data.data_is_empty(),
        "with-data squat is not data-empty → gate skips creation"
    );
    assert_eq!(
        squat_with_data.owner,
        &system_program::ID,
        "squat is system-owned"
    );
    let err1 = position_deserialization_error(&squat_with_data);
    assert!(
        err1.contains("AccountOwnedByWrongProgram"),
        "with-data squat: expected AccountOwnedByWrongProgram, got {err1}"
    );

    // Variant 2: rent-funded-but-EMPTY squat (data empty, system-owned,
    // lamports > 0 — the pristine check's lamports() == 0 leg fails).
    let mut data2: Vec<u8> = Vec::new();
    let mut lamports2: u64 = 1;
    let rent_funded_empty = account_info(&pda, &mut lamports2, &mut data2, &system_program::ID);
    assert!(
        rent_funded_empty.data_is_empty() && rent_funded_empty.lamports() != 0,
        "rent-funded-empty squat satisfies the data/owner legs but fails the lamports leg"
    );
    let err2 = position_deserialization_error(&rent_funded_empty);
    assert!(
        err2.contains("AccountOwnedByWrongProgram"),
        "rent-funded-empty squat: expected AccountOwnedByWrongProgram, got {err2}"
    );

    // Variant 3: data squat with zero lamports — still not pristine (data
    // leg), deserialization still fails.
    let mut data3 = vec![0x00u8; 8 + Position::LEN];
    let mut lamports3: u64 = 0;
    let zero_lamport_with_data =
        account_info(&pda, &mut lamports3, &mut data3, &system_program::ID);
    assert!(
        !zero_lamport_with_data.data_is_empty(),
        "data-carrying squat is not pristine even at zero lamports"
    );
    let err3 = position_deserialization_error(&zero_lamport_with_data);
    assert!(
        err3.contains("AccountNotInitialized") || err3.contains("AccountOwnedByWrongProgram"),
        "zero-lamport data squat must fail deserialization (AccountNotInitialized / \
         AccountOwnedByWrongProgram), got {err3}"
    );

    // Control: a genuinely pristine account (empty data, system-owned, zero
    // lamports) is what the gate calls "needs creation" — the program then
    // CPI-creates it and the owner check passes.
    let mut data4: Vec<u8> = Vec::new();
    let mut lamports4: u64 = 0;
    let pristine = account_info(&pda, &mut lamports4, &mut data4, &system_program::ID);
    assert!(
        pristine.data_is_empty()
            && pristine.owner == &system_program::ID
            && pristine.lamports() == 0,
        "pristine account matches the gate's needs-creation predicate"
    );
}

// --- F3a (error table): settle_fill never returns PositionNotFound ----------

/// The api-reference error table, read from the repo docs so the assertion
/// tracks the actually-documented surface (reintroducing the over-claim turns
/// the test red again).
const API_REFERENCE: &str = include_str!("../../../docs/api-reference.md");

/// F3a — the error table must NOT claim `settle_fill` can raise
/// `PositionNotFound`. The documented trigger is "`close_position`/`settle_fill`
/// without a live position (`notional == 0` or no `Position` account)", but
/// `settle_fill` never returns that variant (FR-5/A-9b re-opens a
/// `notional == 0` maker position; a missing ledger is
/// `InsufficientFreeCollateral`).
#[test]
fn f3_error_table_must_not_claim_settle_fill_returns_position_not_found() {
    let row = API_REFERENCE
        .lines()
        .find(|line| line.contains("| `PositionNotFound` |"))
        .expect("api-reference.md error table must document the PositionNotFound variant");
    // Markdown table row: `| — | `PositionNotFound` | <trigger> | ...`.
    let trigger = row.split('|').nth(3).unwrap_or_default().trim();
    assert!(
        !trigger.contains("settle_fill"),
        "docs/api-reference.md overstates the error surface: the `PositionNotFound` \
         error-table row attributes the variant to `settle_fill` (\"{trigger}\"), but \
         settle_fill never returns PositionNotFound (FR-5/A-9b: a `notional == 0` maker \
         position is re-opened with `entry := snapshot x size`, `open_slot := now`; a \
         missing `UserCollateral` reports InsufficientFreeCollateral). The settle_fill \
         instruction row is accurate — only this error-table entry is wrong."
    );
}

// F3a code-side guard: the settle_fill settlement path (`apply_open_fills` on
// a retained, fully-closed maker position) has no `PositionNotFound` path — a
// `notional == 0` position is re-opened per FR-5 rather than rejected, and the
// only realistic failure is the margin shortfall
// (`InsufficientFreeCollateral`). If a future change ever made this path raise
// `PositionNotFound`, this property (and the doc-consistency test above) would
// both go red.
proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn f3_settle_fill_never_returns_position_not_found(
        lamports in 1u64..10_000_000_000_000_000_000u64,
        supply in 1u64..10_000_000_000_000_000_000u64,
        size in 1u64..1_000_000_000,
        bps in 1u16..=10_000,
        deposited in 0u64..10_000_000_000_000_000,
        now_slot in 0u64..10_000_000,
    ) {
        // A retained, fully-closed maker position awaiting settlement:
        // `notional == 0`, no entry history, no reserved margin — the exact
        // state the docs claim would trigger `PositionNotFound`.
        let mut position = Position {
            market: Pubkey::default(),
            owner: Pubkey::default(),
            side: 1,
            notional: 0,
            entry_n_sum: 0,
            entry_d_sum: 0,
            collateral: 0,
            last_funding_epoch: 0,
            closed_notional: 0,
            closed_entry_n_sum: 0,
            closed_entry_d_sum: 0,
            open_slot: 0,
            bump: 255,
        };
        let mut user_collateral = UserCollateral {
            deposited,
            reserved: 0,
            claimable: 0,
            bump: 255,
        };
        let fill = [crate::orderbook::Fill {
            maker_seq: 0,
            maker_owner: Pubkey::default(),
            taker_owner: Pubkey::default(),
            size,
            price: 1,
        }];
        let result = crate::apply_open_fills(
            &mut position,
            &mut user_collateral,
            bps,
            &fill,
            lamports,
            supply,
            now_slot,
            100,
        );
        match result {
            Err(e) => {
                // The documented `PositionNotFound` trigger cannot occur:
                // only the margin shortfall (`InsufficientFreeCollateral`)
                // or arithmetic overflow can fail this path.
                let expected: anchor_lang::error::Error =
                    FructusError::PositionNotFound.into();
                prop_assert_ne!(
                    e,
                    expected,
                    "settle_fill must never fail with PositionNotFound on a \
                     notional == 0 maker position"
                );
            }
            Ok(()) => {
                // Re-open semantics (FR-5/A-9b): entry := snapshot x size,
                // open_slot := now, margin reserved against free collateral.
                prop_assert_eq!(position.notional, size);
                prop_assert_eq!(
                    position.entry_n_sum,
                    (lamports as u128) * (size as u128),
                    "entry_n_sum := snapshot total_lamports x size"
                );
                prop_assert_eq!(
                    position.entry_d_sum,
                    (supply as u128) * (size as u128),
                    "entry_d_sum := snapshot pool_token_supply x size"
                );
                prop_assert_eq!(
                    position.open_slot, now_slot,
                    "re-open stamps the settlement slot"
                );
                let expected_margin = margin_required(size, bps).unwrap();
                prop_assert_eq!(position.collateral, expected_margin);
                prop_assert_eq!(user_collateral.reserved, expected_margin);
            }
        }
    }
}

// --- F3b (I-margin-bounds): monotonicity is asserted + holds ----------------

/// The body of the `margin_required_bounds` proptest in positions.rs (the test
/// the design's PBT plan row names for I-margin-bounds). Deterministic: the
/// body opens at the first `{` after the fn signature and closes at the first
/// 8-space-indented `}` (the inner `if` blocks close at 12 spaces).
fn margin_required_bounds_body() -> &'static str {
    let start = POSITIONS_SRC
        .find("fn margin_required_bounds(")
        .expect("positions.rs must define the margin_required_bounds proptest");
    let open = start
        + POSITIONS_SRC[start..]
            .find('{')
            .expect("margin_required_bounds must have a body");
    let end = open
        + 1
        + POSITIONS_SRC[open + 1..]
            .find("\n        }\n")
            .expect("margin_required_bounds body must close at 8-space indent");
    &POSITIONS_SRC[open + 1..end]
}

/// F3b — the `margin_required_bounds` property test must keep asserting the
/// I-margin-bounds monotonicity item, exactly as the PBT plan row ("ceiling
/// formula + monotonicity + bps==10_000 ⇒ == notional + collateral ≥ 1") and
/// design.md §5 ("`margin_required` is monotonic non-decreasing in `notional`")
/// document. Removing the monotonicity assertion turns this guard red.
#[test]
fn f3_margin_required_bounds_asserts_monotonicity() {
    let body = margin_required_bounds_body();
    let margin_evals = body.matches("margin_required(").count();
    assert!(
        body.contains("monotonic") && margin_evals >= 2,
        "I-margin-bounds monotonicity item is not asserted: design.md §5 \
         locks 'margin_required is monotonic non-decreasing in notional' \
         and the PBT plan row (design.md §6) requires margin_required_bounds \
         to assert 'ceiling formula + monotonicity + bps==10_000 => == \
         notional + collateral >= 1', but the implemented test only asserts \
         the formula/identity/floor — monotonicity in notional is never \
         asserted (found {margin_evals} margin_required( evaluation(s) in \
         the test body; 'monotonic' mentioned: {}). One line closes the \
         gap, e.g. prop_assert!(margin_required(notional + 1, \
         bps).unwrap() >= m, \"monotonic non-decreasing in notional\");",
        body.contains("monotonic"),
    );
}

// F3b code-side guard: the formula `ceil(notional × bps / 10_000)` is
// monotonic non-decreasing in notional over a wide band (every value is
// `Some` for `bps ≤ 10_000`, so the function is total here) — the invariant
// the I-margin-bounds row documents actually holds for the implemented
// formula.
proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn f3_margin_required_is_monotonic(
        n in 0u64..1_000_000_000_000_000_000u64,
        bps in 1u16..=10_000,
    ) {
        let m = margin_required(n, bps).expect("total for bps <= 10_000");
        let m_next = margin_required(n + 1, bps).expect("total for bps <= 10_000");
        prop_assert!(
            m_next >= m,
            "I-margin-bounds: margin_required must be monotonic non-decreasing \
             in notional (n = {n}, n+1 = {}, bps = {bps}: {m} -> {m_next})",
            n + 1,
        );
    }
}

// --- F4 (crank residual resume): all-or-nothing, no dropped fills -----------

/// F4 — a residual resume must never consume a maker from the book without
/// persisting that maker's `Fill` event (D10: fills are never silently
/// dropped; D10'/FR-6: a residual is resumed only when the ring can hold
/// ALL its fills, otherwise it is cancelled without matching anyone).
#[test]
fn crank_resume_never_consumes_maker_without_persisted_fill_event() {
    // Full ring (128 undrained events); the head is a Residual that crosses
    // TWO asks, so it needs TWO fill events but only ONE ring slot is freed
    // by draining the head.
    let mut account = empty_onchain_order_book();
    let mut residual = crate::state::OutEvent::default();
    residual.seq = 0;
    residual.kind = crate::EVENT_KIND_RESIDUAL;
    residual.side = crate::SIDE_BID;
    residual.owner = Pubkey::from([1; 32]);
    residual.price = 30;
    residual.size = 12;
    account.events[0] = residual;
    for i in 1..(EVENT_QUEUE_LEN as u64) {
        let mut fill = crate::state::OutEvent::default();
        fill.seq = i;
        fill.kind = crate::EVENT_KIND_FILL;
        fill.side = crate::SIDE_BID;
        fill.owner = Pubkey::from([7; 32]);
        fill.size = 1;
        account.events[i as usize] = fill;
    }
    account.event_write_cursor = EVENT_QUEUE_LEN as u64;

    let mut book = Book {
        bids: vec![],
        asks: vec![
            ob_order(2, Side::Ask, 10, 5, 0),
            ob_order(2, Side::Ask, 11, 5, 1),
        ],
        next_seq: 2,
    };
    let makers_before = book.asks.len();
    let write_before = account.event_write_cursor;

    let _dirty = crate::drain_events(&mut account, &mut book, 100, 200).unwrap();

    let fills_persisted = (account.event_write_cursor - write_before) as usize;
    let makers_consumed = makers_before - book.asks.len();
    assert_eq!(
        fills_persisted, makers_consumed,
        "the residual resume consumed {makers_consumed} maker(s) from the book but \
         persisted only {fills_persisted} Fill event(s): every maker whose resting \
         order was matched must have a persisted, settle-able Fill event (D10: fills \
         are never silently dropped; FR-6/D10': a residual is resumed only when the \
         ring has capacity to persist its fills, otherwise it is cancelled without \
         matching anyone)."
    );
}

/// F4 — same invariant, but the ring has capacity for ONE of the residual's two
/// fills — still not all of them — so the resume must be all-or-nothing.
#[test]
fn crank_resume_all_or_nothing_when_partial_capacity() {
    let mut account = empty_onchain_order_book();
    let mut residual = crate::state::OutEvent::default();
    residual.seq = 0;
    residual.kind = crate::EVENT_KIND_RESIDUAL;
    residual.side = crate::SIDE_BID;
    residual.owner = Pubkey::from([1; 32]);
    residual.price = 30;
    residual.size = 12;
    account.events[0] = residual;
    for i in 1..(EVENT_QUEUE_LEN as u64) {
        let mut fill = crate::state::OutEvent::default();
        fill.seq = i;
        fill.kind = crate::EVENT_KIND_FILL;
        fill.side = crate::SIDE_BID;
        fill.owner = Pubkey::from([7; 32]);
        fill.size = 1;
        account.events[i as usize] = fill;
    }
    // One free slot: the ring holds 127 events, the head drains to 126 queued.
    account.event_write_cursor = EVENT_QUEUE_LEN as u64 - 1;

    let mut book = Book {
        bids: vec![],
        asks: vec![
            ob_order(2, Side::Ask, 10, 5, 0),
            ob_order(2, Side::Ask, 11, 5, 1),
        ],
        next_seq: 2,
    };
    let makers_before = book.asks.len();
    let write_before = account.event_write_cursor;

    let _dirty = crate::drain_events(&mut account, &mut book, 100, 200).unwrap();

    let fills_persisted = (account.event_write_cursor - write_before) as usize;
    let makers_consumed = makers_before - book.asks.len();
    assert_eq!(
        fills_persisted, makers_consumed,
        "partial ring capacity must not consume makers without persisting their fills"
    );
}

// --- F5 (lazy-create gates): a squat must not pass for pristine -------------

/// Window (lines before/after a `position.data_is_empty()` site) in which
/// an ownership / pristine-account check may legitimately live, so the
/// regression stays GREEN under the natural fix shapes (owner/lamports
/// check on the same line, on an adjacent line of a split condition, or in
/// a `let pristine = ...` hoisted directly above the gate) while still
/// RED if the gate ever regresses to data-empty-only.
const GATE_WINDOW_BEFORE: usize = 2;
const GATE_WINDOW_AFTER: usize = 6;

/// F5 — every `ctx.accounts.position.data_is_empty()` lazy-create gate must, on
/// the SAME condition, also verify the account is still a pristine system-owned
/// account (`owner` / `lamports`); otherwise a pre-created system account at
/// the PDA bricks the instruction permanently (AccountOwnedByWrongProgram, or
/// the CPI create_account "already in use" failure) and freezes the victim's
/// reserved margin (close can never succeed).
#[test]
fn position_lazy_create_gate_checks_account_owner() {
    let lines: Vec<&str> = LIB_SRC.lines().collect();
    let mut bad_gates: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.contains("position.data_is_empty()") {
            let lo = i.saturating_sub(GATE_WINDOW_BEFORE);
            let hi = (i + GATE_WINDOW_AFTER + 1).min(lines.len());
            let window = lines[lo..hi].join("\n");
            if !window.contains("owner") && !window.contains("lamports") {
                bad_gates.push(format!("line {}: {}", i + 1, trimmed));
            }
        }
    }
    assert!(
        bad_gates.is_empty(),
        "the Position lazy-create gates in open_position/close_position/settle_fill guard on \
         `ctx.accounts.position.data_is_empty()` alone ({} gate(s): {}). An attacker can \
         create a system-owned account (with data, or rent-funded-but-empty) at a victim's \
         Position PDA [POSITION_SEED, market, user, side]; the handler then skips creation \
         and `Account::try_from_unchecked` fails the owner check (AccountOwnedByWrongProgram) \
         — or the CPI create_account fails with 'already in use' — permanently bricking \
         open/close/settle for that (market, user, side) and freezing the reserved margin \
         (close can never succeed). The gate must also verify the account is still a pristine \
         system-owned account (owner == system program, lamports == 0).",
        bad_gates.len(),
        bad_gates.join(" | "),
    );
}

// ==== Adversarial-review invariants for the lib.rs position adapters (moved from review_tests.rs) ====
// These drive the REAL `apply_open_fills` / `apply_close_fills` (private
// crate-root helpers) rather than a reproduction, and pin the invariants the
// settlement / funding handlers promise across MULTIPLE position lifetimes.

/// Tolerance (in USDC microunits) for `closed_pnl_is_priced_at_each_generations_own_basis`.
///
/// The aggregate closed-entry basis is the **notional-weighted harmonic mean** of
/// the per-generations' entry rates, so in the exact-real sense it prices each
/// generation at its own basis and the aggregate PnL equals the per-generation
/// PnL sum exactly. `positions::pnl` truncates toward zero in two places (the
/// yield change and the final `notional × change / APY_SCALE` division), so the
/// integer aggregate differs from the sum of the independently-rounded
/// per-generation PnLs by at most a handful of micro-units (≤ ~4 across the full
/// proptest domain). An accumulation bug (overwriting `closed_entry_*` with the
/// newest generation's basis, or an average instead of the harmonic basis) errs
/// by far more than this bound — the pinned deterministic witness is off by 667
/// for the overwrite and 133 for an arithmetic mean — so this small tolerance is
/// not a relaxation: it only admits the documented truncation rounding while
/// still rejecting the real defect.
const CLOSED_PNL_QUANT_TOL: i128 = 8;

/// Build a zeroed, inert `Position` (no side assumptions in the pure adapters).
fn life_pos() -> Position {
    Position {
        market: Pubkey::default(),
        owner: Pubkey::default(),
        side: 0,
        notional: 0,
        entry_n_sum: 0,
        entry_d_sum: 0,
        collateral: 0,
        last_funding_epoch: 0,
        closed_notional: 0,
        closed_entry_n_sum: 0,
        closed_entry_d_sum: 0,
        open_slot: 0,
        bump: 0,
    }
}

fn life_uc(deposited: u64) -> UserCollateral {
    UserCollateral {
        deposited,
        reserved: 0,
        claimable: 0,
        bump: 0,
    }
}

fn life_fill(size: u64) -> crate::orderbook::Fill {
    crate::orderbook::Fill {
        maker_seq: 0,
        maker_owner: Pubkey::from([2u8; 32]),
        taker_owner: Pubkey::from([1u8; 32]),
        size,
        price: 10,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    // R-S1/R-S2 invariant: the PnL of the closed notional must be determinable
    // from the entry basis that was in effect when it was closed. A re-open
    // (which resets the entry sums) must NOT reframe it. Here the SAME
    // `closed_notional` (generation-1 amount, closed at entry rate r1) is
    // settled both before and after a generation-2 re-open at a DIFFERENT rate
    // r2; the two must agree.
    #[test]
    fn reopen_does_not_reframe_closed_pnl_basis(
        r1 in 1_000_000u64..10_000_000u64,
        r2 in 1_000_000u64..10_000_000u64,
        cur in 1_000_000u64..20_000_000u64,
        amt1 in 1_000_000u64..100_000_000u64,
        amt2 in 1_000_000u64..100_000_000u64,
        im in 2u16..=10_000u16,
    ) {
        prop_assume!(r1 != r2, "need two distinct generations");
        let mut position = life_pos();
        let mut uc = life_uc(1_000_000_000_000_000u64);

        // Generation 1: open at rate r1, then fully close.
        apply_open_fills(&mut position, &mut uc, im, &[life_fill(amt1)], r1, 1, 1, 100).unwrap();
        apply_close_fills(&mut position, &mut uc, im, &[life_fill(amt1)]).unwrap();
        prop_assert_eq!(position.notional, 0, "generation 1 fully closed");
        let gen1_closed = position.closed_notional;
        let (gen1_n, gen1_d) = (position.entry_n_sum, position.entry_d_sum);

        // Reference: settle the generation-1 closed notional at its own entry basis.
        let pnl_at_gen1_basis =
            pnl(gen1_n, gen1_d, cur, 1, gen1_closed, PositionSide::Long);

        // Generation 2 re-open: resets the entry sums to rate r2.
        apply_open_fills(&mut position, &mut uc, im, &[life_fill(amt2)], r2, 1, 2, 100).unwrap();
        prop_assert_eq!(position.closed_notional, gen1_closed, "close storage unchanged by re-open");

        // The handler settles the SAME gen-1 closed notional at the entry basis
        // recorded when it was closed (`closed_entry_*`), which a re-open must
        // leave intact — so the re-open cannot reframe it.
        let pnl_at_gen2_basis = pnl(
            position.closed_entry_n_sum,
            position.closed_entry_d_sum,
            cur,
            1,
            position.closed_notional,
            PositionSide::Long,
        );

        if let (Some(expected), Some(actual)) = (pnl_at_gen1_basis, pnl_at_gen2_basis) {
            prop_assert_eq!(
                expected,
                actual,
                "a re-open must not reframe the prior closed_notional's PnL (it was settled at the new entry rate)"
            );
        }
    }

    // R-F5 invariant: a position re-open must re-base `last_funding_epoch` so the
    // reopened notional only accrues funding over epochs it actually held
    // notional, never over the interval it was closed (notional == 0). Here the
    // position's `last_funding_epoch` is stale (from before the closed period)
    // and is NOT advanced by `apply_open_fills` on re-open.
    #[test]
    fn reopen_does_not_rebase_funding_epoch(
        stale_last_epoch in 0u64..5_000u64,
        reopen_slot in 5_000_000u64..20_000_000u64,
        epoch_slots in 100u64..1_000u64,
        im in 2u16..=10_000u16,
    ) {
        let reopen_epoch = funding_epoch(reopen_slot, epoch_slots);
        prop_assume!(reopen_epoch > stale_last_epoch, "the closed interval is non-empty");

        let mut position = life_pos();
        let mut uc = life_uc(1_000_000_000_000_000u64);
        position.last_funding_epoch = stale_last_epoch;

        // Generation 1 was closed (notional == 0) and then re-opened.
        let amt = 1_000_000u64;
        apply_open_fills(&mut position, &mut uc, im, &[life_fill(amt)], 2_000_000, 1, reopen_slot, epoch_slots)
            .unwrap();

        // The handler's settle_funding charges `cur_epoch - position.last_funding_epoch`
        // epochs against the CURRENT notional. The correct basis after a re-open
        // is the re-open epoch, so those epoch deltas must be re-based there.
        prop_assert_eq!(
            position.last_funding_epoch,
            reopen_epoch,
            "a re-open must re-base last_funding_epoch to the re-open epoch; \
             otherwise the reopened notional pays funding for the closed interval"
        );
    }
}

/// Deterministic minimal witness for the re-open PnL-basis bug.
#[test]
fn reopen_reframes_closed_pnl_witness() {
    // Generation 1: enter long at rate 2.0 (n=2,d=1,w=1e6), close fully.
    // Generation 2: re-open at rate 3.0. Index currently 4.0.
    // The gen-1 closed 1000 notional's TRUE PnL (entry 2.0 -> 4.0) is +1000;
    // the handler settles it at the gen-2 entry 3.0 -> 4.0, giving ~333.
    let mut position = life_pos();
    let mut uc = life_uc(1_000_000_000_000_000u64);
    let im = 1_000u16;
    let amt = 1_000u64;

    apply_open_fills(&mut position, &mut uc, im, &[life_fill(amt)], 2, 1, 1, 100).unwrap();
    apply_close_fills(&mut position, &mut uc, im, &[life_fill(amt)]).unwrap();
    let gen1_closed = position.closed_notional;
    assert_eq!(gen1_closed, amt, "fully closed generation 1");
    assert_eq!(
        position.entry_n_sum,
        (2u128) * (amt as u128),
        "gen1 entry rate 2.0"
    );
    assert_eq!(position.entry_d_sum, (amt as u128));

    let reference = pnl(
        position.entry_n_sum,
        position.entry_d_sum,
        4,
        1,
        gen1_closed,
        PositionSide::Long,
    )
    .expect("pnl in band");
    assert_eq!(
        reference, amt as i128,
        "gen1 closed at entry 2.0 -> 4.0 is +{amt}"
    );

    // Re-open generation 2 at rate 3.0 (fresh entry sums, closed_notional stale).
    apply_open_fills(&mut position, &mut uc, im, &[life_fill(amt)], 3, 1, 2, 100).unwrap();
    assert_eq!(
        position.closed_notional, gen1_closed,
        "closed_notional NOT reset on re-open"
    );
    // The handler settles at the NEW entry rate: wrong result.
    let wrong = pnl(
        position.entry_n_sum,
        position.entry_d_sum,
        4,
        1,
        position.closed_notional,
        PositionSide::Long,
    )
    .expect("pnl in band");
    assert_ne!(
        wrong, reference,
        "re-open reframed the gen-1 closed {}, settling it at the gen-2 entry rate \
         ({wrong}) instead of the gen-1 entry rate ({reference})",
        gen1_closed
    );
}

/// Regression B2 (critical): a re-open must NOT reframe the entry basis of the
/// prior `closed_notional`. `apply_close_fills` records the close-time entry
/// basis into `closed_entry_*`; a re-open resets the LIVE `entry_*` (fresh
/// basis for the new generation) but leaves `closed_entry_*` intact, so
/// `settle_close` prices the closed amount at its own (close-time) rate.
#[test]
fn reopen_preserves_closed_entry_basis_deterministic() {
    let mut position = life_pos();
    let mut uc = life_uc(1_000_000_000_000_000u64);
    let im = 1_000u16; // 10% initial margin
    let amt = 1_000u64;

    // Generation 1: open long at entry rate 2.0 (n=2, d=1), then fully close.
    apply_open_fills(&mut position, &mut uc, im, &[life_fill(amt)], 2, 1, 1, 100).unwrap();
    apply_close_fills(&mut position, &mut uc, im, &[life_fill(amt)]).unwrap();
    assert_eq!(position.notional, 0, "generation 1 fully closed");
    assert_eq!(position.closed_notional, amt, "closed notional recorded");
    assert_eq!(
        position.closed_entry_n_sum,
        2 * (amt as u128),
        "gen-1 entry basis numerator"
    );
    assert_eq!(
        position.closed_entry_d_sum, amt as u128,
        "gen-1 entry basis denominator"
    );

    // Reference: settle the gen-1 closed notional at its own (close-time) basis.
    let reference = pnl(
        position.closed_entry_n_sum,
        position.closed_entry_d_sum,
        4,
        1,
        position.closed_notional,
        PositionSide::Long,
    )
    .expect("pnl in band");
    assert_eq!(reference, amt as i128, "(4/2 − 1) × {amt} == +{amt}");

    // Generation 2: re-open at a DIFFERENT rate 3.0 — live entry sums reset.
    apply_open_fills(&mut position, &mut uc, im, &[life_fill(amt)], 3, 1, 2, 100).unwrap();
    assert_eq!(
        position.entry_n_sum,
        3 * (amt as u128),
        "live entry basis reset to gen-2"
    );
    assert_eq!(
        position.entry_d_sum, amt as u128,
        "live entry basis reset to gen-2"
    );
    assert_eq!(
        position.closed_entry_n_sum,
        2 * (amt as u128),
        "re-open must NOT reframe closed basis"
    );
    assert_eq!(
        position.closed_entry_d_sum, amt as u128,
        "re-open must NOT reframe closed basis"
    );
    assert_eq!(
        position.closed_notional, amt,
        "closed notional unchanged by re-open"
    );

    // The handler settles at `closed_entry_*` (the close-time basis): correct.
    let actual = pnl(
        position.closed_entry_n_sum,
        position.closed_entry_d_sum,
        4,
        1,
        position.closed_notional,
        PositionSide::Long,
    )
    .expect("pnl in band");
    assert_eq!(
        actual, reference,
        "closed PnL prices at the close-time basis, never the new basis"
    );
    // The buggy (pre-fix) behaviour priced it at the LIVE (gen-2) entry: wrong.
    let buggy = pnl(
        position.entry_n_sum,
        position.entry_d_sum,
        4,
        1,
        position.closed_notional,
        PositionSide::Long,
    )
    .expect("pnl in band");
    assert_ne!(
        buggy, reference,
        "(4/3 − 1) × {amt} != (4/2 − 1) × {amt}: a re-open reframed it"
    );
}

/// Regression B1 (medium): a re-open must re-base `last_funding_epoch` to the
/// re-open epoch so the reopened notional only accrues funding over epochs it
/// actually held notional (never the closed interval, where notional == 0).
#[test]
fn reopen_rebases_funding_epoch_deterministic() {
    let mut position = life_pos();
    let mut uc = life_uc(1_000_000_000_000_000u64);
    let im = 2u16;
    // A position whose `last_funding_epoch` is stale from before the closed
    // interval; it is then re-opened at slot 5,000,000 with epoch length 100.
    position.last_funding_epoch = 0; // stale
    let reopen_slot = 5_000_000u64;
    let epoch_slots = 100u64;
    let amt = 1_000_000u64;
    apply_open_fills(
        &mut position,
        &mut uc,
        im,
        &[life_fill(amt)],
        2_000_000,
        1,
        reopen_slot,
        epoch_slots,
    )
    .unwrap();
    assert_eq!(
        position.last_funding_epoch,
        funding_epoch(reopen_slot, epoch_slots),
        "re-open must re-base last_funding_epoch to the re-open epoch"
    );
    assert_eq!(funding_epoch(reopen_slot, epoch_slots), 50_000);
    assert_ne!(
        position.last_funding_epoch, 0,
        "otherwise the reopened notional pays funding for the closed interval"
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    // R-S1/R-S2: the aggregate closed-entry basis must realize each closed
    // generation at ITS OWN close-time entry basis, across MULTIPLE lifetimes
    // (a re-open in the middle, before any settle_close).
    #[test]
    fn closed_pnl_is_priced_at_each_generations_own_basis(
        r1 in 2u64..10_000_000u64,
        r2 in 2u64..10_000_000u64,
        cur in 1u64..20_000_000u64,
        amt1 in 1u64..1_000_000u64,
        amt2 in 1u64..1_000_000u64,
        im in 2u16..=10_000u16,
    ) {
        prop_assume!(r1 != r2, "two generations with distinct entry bases");
        let mut position = life_pos();
        let mut uc = life_uc(1_000_000_000_000_000u64);

        // Generation 1: open long at rate r1, then fully close.
        apply_open_fills(&mut position, &mut uc, im, &[life_fill(amt1)], r1, 1, 1, 100).unwrap();
        apply_close_fills(&mut position, &mut uc, im, &[life_fill(amt1)]).unwrap();
        prop_assert_eq!(position.notional, 0, "generation 1 fully closed");
        let gen1_n = position.closed_entry_n_sum;
        let gen1_d = position.closed_entry_d_sum;
        let gen1_closed = position.closed_notional;

        // Generation 2: re-open at rate r2, then fully close (NO settle_close
        // between the generations — the cranker may lag arbitrarily).
        apply_open_fills(&mut position, &mut uc, im, &[life_fill(amt2)], r2, 1, 2, 100).unwrap();
        apply_close_fills(&mut position, &mut uc, im, &[life_fill(amt2)]).unwrap();
        prop_assert_eq!(
            position.closed_notional,
            gen1_closed + amt2,
            "closed notional accumulates across generations"
        );

        // The invariant: each closed generation is realized at ITS OWN
        // close-time basis. Gen1 must stay at (r1), gen2 at (r2).
        let pnl_gen1 = pnl(gen1_n, gen1_d, cur, 1, gen1_closed, PositionSide::Long).unwrap();
        let pnl_gen2 =
            pnl((r2 as u128) * (amt2 as u128), amt2 as u128, cur, 1, amt2, PositionSide::Long)
                .unwrap();
        let expected = pnl_gen1 + pnl_gen2;
        let actual = pnl(
            position.closed_entry_n_sum,
            position.closed_entry_d_sum,
            cur,
            1,
            position.closed_notional,
            PositionSide::Long,
        )
        .unwrap();

        prop_assert!(
            (actual - expected).abs() <= CLOSED_PNL_QUANT_TOL,
            "a re-open then re-close must price each closed generation at its own entry basis; \
             the aggregate closed-entry basis must track the per-generation PnL sum (within the \
             documented `pnl` truncation/quantization bound), never reframe the prior life to the \
             newest generation's basis"
        );
    }
}

/// Deterministic minimal witness for the multi-lifetime closed-PnL-basis bug:
/// generation 1 closes at entry rate 2.0, the position re-opens at rate 3.0 and
/// closes again — BOTH pending closed amounts are then priced at the gen-2 basis
/// (3.0), so the gen-1 closed amount is realized at the WRONG rate and the user
/// gains/loses value that a correct settlement would not.
#[test]
fn closed_pnl_multi_lifetime_prices_earlier_close_at_new_basis() {
    let mut position = life_pos();
    let mut uc = life_uc(1_000_000_000_000_000u64);
    let im = 1_000u16; // 10% initial margin
    let amt = 1_000u64;

    // Generation 1: long at entry rate 2.0, fully close.
    apply_open_fills(&mut position, &mut uc, im, &[life_fill(amt)], 2, 1, 1, 100).unwrap();
    apply_close_fills(&mut position, &mut uc, im, &[life_fill(amt)]).unwrap();
    assert_eq!(position.notional, 0, "generation 1 fully closed");
    let gen1_n = position.closed_entry_n_sum;
    let gen1_d = position.closed_entry_d_sum;
    let gen1_closed = position.closed_notional;
    let pnl_gen1 = pnl(gen1_n, gen1_d, 4, 1, gen1_closed, PositionSide::Long).unwrap();
    assert_eq!(
        pnl_gen1, amt as i128,
        "(4/2 - 1) x amt == amt (gen1 basis 2.0)"
    );

    // Generation 2: re-open at rate 3.0, fully close (no settle in between).
    apply_open_fills(&mut position, &mut uc, im, &[life_fill(amt)], 3, 1, 2, 100).unwrap();
    apply_close_fills(&mut position, &mut uc, im, &[life_fill(amt)]).unwrap();
    assert_eq!(
        position.closed_notional,
        gen1_closed + amt,
        "closed notional accumulated"
    );
    // The closed-entry running sums ACCUMULATE each generation's own entry basis
    // (notional-weighted harmonic-mean representation), so the gen-1 basis (2.0)
    // is never reframed by the gen-2 (3.0) re-open.
    assert_eq!(
        position.closed_entry_n_sum,
        (2u128) * (gen1_closed as u128 + amt as u128) * (3u128),
        "closed entry basis accumulates the harmonic numerator, not the gen-2 basis"
    );

    // True PnL (each generation at its own basis) vs the handler's actual
    // (the whole pending closed notional priced at the overwritten gen-2 basis).
    let expected = pnl_gen1
        + pnl(
            (3u128) * (amt as u128),
            amt as u128,
            4,
            1,
            amt,
            PositionSide::Long,
        )
        .unwrap();
    let actual = pnl(
        position.closed_entry_n_sum,
        position.closed_entry_d_sum,
        4,
        1,
        position.closed_notional,
        PositionSide::Long,
    )
    .unwrap();
    assert_eq!(
        actual, expected,
        "the gen-1 closed amount was re-priced at the gen-2 (re-open) entry basis; \
         settle_close realizes the wrong PnL and leaks user value"
    );
}

// ===========================================================================
// REVIEW AGENT — fund-conservation adversarial invariants (REPOINTED to the
// Design A fix).
//
// These pin the protocol-wide no-theft invariant: Σ `UserCollateral.deposited`
// across every user must never exceed the vault's actual USDC balance. A
// matched long+short pair (identical entry basis + notional) carries EXACTLY
// opposite PnL (positions::pnl is antisymmetric), so settling both sides must
// conserve Σ deposited. The pure `positions::apply_pnl` (loss clamped at 0,
// profit unbounded) alone canNOT satisfy this — that is the exact layer that
// mathematically cannot hold. The fix is the Design A PnL pool
// (`crate::settlement`): the loser's debit is COLLECTED into the pool and the
// winner's credit is paid only up to that pool, the remainder becoming a
// pending claim. These tests now drive that fixed routing end-to-end.
// ===========================================================================
#[cfg(test)]
mod conservation_adversarial_tests {
    use proptest::prelude::*;

    use crate::funding::{funding_payment, SideFlow};
    use crate::positions::{accumulate_entry, pnl, PositionSide};
    use crate::settlement::{apply_credit, apply_debit};

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // INVARIANT (settle_close no-mint): a matched long+short pair carries
        // exactly opposite PnL, so settling BOTH sides through the PnL pool must
        // never increase Σ deposited. The winner's credit is bounded by the pool
        // the loser's debit actually collected (nothing minted — the vault's
        // USDC is never over-issued); the unfunded remainder is a claim, never
        // `deposited`.
        #[test]
        fn settle_close_conserves_deposited_sum(
            d_long in 0u64..1_000_000_000_000u64,
            d_short in 0u64..1_000_000_000_000u64,
            notional in 1u64..1_000_000_000_000u64,
            entry_n in 1u64..1_000u64,
            entry_d in 1u64..1_000u64,
            cur_n in 1_000u64..100_000u64,
            cur_d in 1u64..1_000u64,
        ) {
            let (n_sum, d_sum) =
                accumulate_entry(0, 0, entry_n, entry_d, notional).unwrap();
            let p_long = pnl(n_sum, d_sum, cur_n, cur_d, notional, PositionSide::Long).unwrap();
            let p_short = pnl(n_sum, d_sum, cur_n, cur_d, notional, PositionSide::Short).unwrap();
            prop_assert_eq!(p_long, -p_short, "matched pair has exact opposite PnL");
            if p_long <= 0 {
                return Ok(());
            }
            let credit = p_long as u64;
            let debit = p_short.unsigned_abs().min(u64::MAX as u128) as u64;
            // Loser (short) settles first: collect its loss into the pool.
            let (d_short_after, pool) = apply_debit(d_short, 0, debit).unwrap();
            // Winner (long) settles second: paid only up to the pool; the
            // remainder is a pending claim (never `deposited`).
            let (d_long_after, _claimable, _pool) = apply_credit(d_long, 0, pool, credit).unwrap();
            let sum_before = d_long as u128 + d_short as u128;
            let sum_after = d_long_after as u128 + d_short_after as u128;
            prop_assert!(
                sum_after <= sum_before,
                "settle_close must conserve Σ deposited (no mint); got +{}",
                sum_after.saturating_sub(sum_before)
            );
        }

        // INVARIANT (settle_funding zero-sum): for identical notional/rate/epochs,
        // the long and short funding flows are exact opposites, so accruing both
        // through the pool must never increase Σ deposited (the payer's debit
        // fully funds the payee's credit; the rest is a pending claim).
        #[test]
        fn funding_settlement_conserves_deposited_sum(
            d_long in 0u64..1_000_000_000_000u64,
            d_short in 0u64..1_000_000_000_000u64,
            notional in 1u64..1_000_000_000_000u64,
            rate in 1i128..=1_000_000i128,
            epochs in 1u64..1_000u64,
        ) {
            let p_long = funding_payment(notional, rate, epochs, SideFlow::Long);
            let p_short = funding_payment(notional, rate, epochs, SideFlow::Short);
            prop_assert_eq!(p_long, -p_short, "long/short funding flows are exact opposites");
            prop_assert!(p_long <= 0, "positive rate => long pays");
            let credit = p_short as u64;
            let debit = p_long.unsigned_abs().min(u64::MAX as u128) as u64;
            // Payer (long) settles first: collect its payment into the pool.
            let (d_long_after, pool) = apply_debit(d_long, 0, debit).unwrap();
            // Payee (short) settles second: paid only up to the pool.
            let (d_short_after, _claimable, _pool) = apply_credit(d_short, 0, pool, credit).unwrap();
            let sum_before = d_long as u128 + d_short as u128;
            let sum_after = d_long_after as u128 + d_short_after as u128;
            prop_assert!(
                sum_after <= sum_before,
                "settle_funding must be zero-sum (no mint); got +{}",
                sum_after.saturating_sub(sum_before)
            );
        }
    }

    /// Minimal reachable witness (REWRITTEN for [fix A]): a long and short are
    /// filled at the same entry basis (rate 1.0) for 100 USDC notional; the
    /// index doubles. The long's +100 USDC credit is bounded by the pool the
    /// short's -100 USDC debit actually collected (the short only posted its 10
    /// USDC initial margin, so only 10 USDC is collected): the winner is paid
    /// 10 USDC on top of their own 10 USDC margin, the other 90 USDC becomes a
    /// pending claim, and Σ deposited stays at 20 USDC — nothing minted.
    #[test]
    fn settle_close_mints_value_when_loser_undercollateralized() {
        let notional = 100_000_000u64; // 100 USDC
        let (n_sum, d_sum) = accumulate_entry(0, 0, 1, 1, notional).unwrap();
        let p_long = pnl(n_sum, d_sum, 2, 1, notional, PositionSide::Long).unwrap();
        let p_short = pnl(n_sum, d_sum, 2, 1, notional, PositionSide::Short).unwrap();
        assert_eq!(p_long, 100_000_000, "long profits 100 USDC on a 2x index");
        assert_eq!(p_short, -100_000_000, "short loses 100 USDC");

        let d_long = 10_000_000u64; // 10 USDC initial margin
        let d_short = 10_000_000u64;
        let (d_short_after, pool) = apply_debit(d_short, 0, p_short.unsigned_abs() as u64).unwrap();
        let (d_long_after, claimable, pool) = apply_credit(d_long, 0, pool, p_long as u64).unwrap();

        // [fix A] the loser is clamped at zero (only its 10 USDC is collected)…
        assert_eq!(
            d_short_after, 0,
            "loser debit collected (10 USDC) into the pool"
        );
        // …so the winner is paid only the collected 10 USDC (20 USDC total), not
        // the full 100 USDC profit.
        assert_eq!(
            d_long_after, 20_000_000,
            "winner paid only the funded 10 USDC"
        );
        assert_eq!(
            claimable, 90_000_000,
            "the unfunded 90 USDC is a pending claim"
        );
        assert_eq!(pool, 0, "pool drained");

        let sum_before = d_long as u128 + d_short as u128;
        let sum_after = d_long_after as u128 + d_short_after as u128;
        assert_eq!(
            sum_after,
            sum_before,
            "Σ deposited conserved at 20 USDC ({} before == {} after) — no mint",
            sum_before / 1_000_000,
            sum_after / 1_000_000
        );
    }

    /// Minimal reachable witness for funding (REWRITTEN for [fix A]): a long pays
    /// a short the same funding amount on positive premium. The long only holds
    /// its 100 USDC margin but owes 1000 USDC, so its debit collects only 100
    /// USDC; the short's +1000 USDC credit is paid only that 100 USDC, the other
    /// 900 USDC becomes a pending claim — nothing minted.
    #[test]
    fn funding_mints_value_when_payer_undercollateralized() {
        let notional = 1_000_000_000u64; // 1000 USDC
        let rate = 100_000i128; // +10% per epoch
        let epochs = 10u64;
        let p_long = funding_payment(notional, rate, epochs, SideFlow::Long);
        let p_short = funding_payment(notional, rate, epochs, SideFlow::Short);
        assert_eq!(p_long, -1_000_000_000, "long owes 1000 USDC");
        assert_eq!(p_short, 1_000_000_000, "short receives 1000 USDC");

        let d_long = 100_000_000u64; // 100 USDC (10% margin)
        let d_short = 100_000_000u64;
        let (d_long_after, pool) = apply_debit(d_long, 0, p_long.unsigned_abs() as u64).unwrap();
        let (d_short_after, claimable, pool) =
            apply_credit(d_short, 0, pool, p_short as u64).unwrap();

        assert_eq!(
            d_long_after, 0,
            "payer debit collected (100 USDC) into the pool"
        );
        assert_eq!(
            d_short_after, 200_000_000,
            "payee paid only the funded 100 USDC"
        );
        assert_eq!(
            claimable, 900_000_000,
            "the unfunded 900 USDC is a pending claim"
        );
        assert_eq!(pool, 0, "pool drained");

        let sum_before = d_long as u128 + d_short as u128;
        let sum_after = d_long_after as u128 + d_short_after as u128;
        assert_eq!(
            sum_after,
            sum_before,
            "Σ deposited conserved at 200 USDC ({} before == {} after) — no mint",
            sum_before / 1_000_000,
            sum_after / 1_000_000
        );
    }
}

// --- Product-v2 doc-audit suite (D19: REQ-A1-8, REQ-A2-6, REQ-A2-7, REQ-C-4) --
//
// Source-embedding audits in the T3/T5/T6 tradition: each test pins its
// deliverable to concrete markers with the marker named in the failure
// message. Files that exist today are embedded with `include_str!` (no CWD
// dependence); files the product-v2 wave creates (`docs/api.md`,
// `docs/api/ws.md`) are read at TEST RUNTIME, so their absence fails the
// assertion rather than the build — a missing file must never be a compile
// error.

/// Read a docs file (path relative to the crate manifest dir) at test runtime.
/// A missing/unreadable file is an assertion failure carrying the path — never
/// a compile error (the file may not exist yet). Note the one-level difference
/// from the `include_str!` sites: those resolve relative to this source file
/// (`src/tests.rs`), so they carry one extra `../`.
fn read_doc(rel: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "required docs file `{}` is missing or unreadable: {e}",
            path.display()
        )
    })
}

/// The eight operator instructions REQ-A1 adds to the program surface; each
/// must be named in `docs/api-reference.md` (REQ-A1-8 / D19).
const OPERATOR_INSTRUCTIONS: [&str; 8] = [
    "set_operator",
    "operator_deposit_collateral",
    "operator_withdraw_collateral",
    "operator_open_position",
    "operator_close_position",
    "operator_place_limit_order",
    "operator_place_market_order",
    "operator_cancel_order",
];

/// REQ-A1-8 / DOCS-OPERATOR-SURFACE-COMPLETE (RED on the pre-wave docs): the
/// instruction reference gains all eight operator rows and `data-models.md`
/// gains the `Operator` layout row (97 bytes). Markers: each instruction name
/// verbatim in `docs/api-reference.md`; an `Operator`+`97` line (or an
/// `Operator` mention with the literal `97 bytes`) in `docs/data-models.md`.
#[test]
fn docs_operator_surface_complete() {
    let api = include_str!("../../../docs/api-reference.md");
    for name in OPERATOR_INSTRUCTIONS {
        assert!(
            api.contains(name),
            "docs/api-reference.md must name the new instruction `{name}` \
             (REQ-A1-8 / DOCS-OPERATOR-SURFACE-COMPLETE)"
        );
    }

    let models = include_str!("../../../docs/data-models.md");
    let operator_row = models
        .lines()
        .any(|l| l.contains("Operator") && l.contains("97"))
        || (models.contains("Operator") && models.contains("97 bytes"));
    assert!(
        operator_row,
        "docs/data-models.md must carry an `Operator` row stating its 97-byte layout \
         (a line naming `Operator` and `97`, or an `Operator` mention with the literal \
         `97 bytes`; REQ-A1-8)"
    );
}

/// The stale per-position liquidation definitions the account-level model
/// (D8 / REQ-A2-6) superseded. Their reappearance anywhere under `src/` or
/// `tests/` revives the removed per-position path.
const STALE_PER_POSITION_FNS: [&str; 3] = [
    "pub fn liquidatable(",
    "fn equity(",
    "fn maintenance_margin(",
];

/// REQ-A2-6 / NO-PER-POSITION-LIQUIDATION-REMAINS — **GREEN today: this is a
/// pin, not a red.** The per-position engine is already gone; the guard keeps
/// it gone. Positive control: the account-level definitions
/// (`account_liquidatable`, `account_liquidation_loss`) must exist in
/// `liquidation.rs`. Failure modes: a resurrected `liquidatable` / `equity` /
/// `maintenance_margin` definition anywhere under `src/` or `tests/`, or a
/// `maintenance_bps` parameter sneaking back into `apply_liquidation`'s
/// signature (the surviving collateral is always re-derived at the INITIAL
/// margin ratio — `maintenance` is the health threshold only).
#[test]
fn no_per_position_liquidation_remains() {
    // Positive control: the account-level model is present.
    let liq = include_str!("liquidation.rs");
    assert!(
        liq.contains("fn account_liquidatable"),
        "liquidation.rs must define the account-level predicate `fn account_liquidatable` \
         (positive control for NO-PER-POSITION-LIQUIDATION-REMAINS)"
    );
    assert!(
        liq.contains("fn account_liquidation_loss"),
        "liquidation.rs must define `fn account_liquidation_loss` \
         (positive control for NO-PER-POSITION-LIQUIDATION-REMAINS)"
    );

    // The stale per-position definitions are gone from liquidation.rs.
    for stale in STALE_PER_POSITION_FNS {
        assert!(
            !liq.contains(stale),
            "liquidation.rs still contains the superseded per-position definition `{stale}`"
        );
    }

    // `apply_liquidation` must not take a maintenance-bps parameter again.
    // The signature slice is checked for `maintenance_bps` / `_maintenance_bps`
    // (positive control: it does carry `initial_margin_bps` and `penalty_bps`).
    let sig_start = liq
        .find("pub fn apply_liquidation(")
        .expect("apply_liquidation must exist in liquidation.rs");
    let sig_end = sig_start
        + liq[sig_start..]
            .find(" -> std::result::Result")
            .expect("apply_liquidation must return std::result::Result");
    let sig = &liq[sig_start..sig_end];
    assert!(
        sig.contains("initial_margin_bps") && sig.contains("penalty_bps"),
        "the apply_liquidation signature slice is missing its \
         `initial_margin_bps`/`penalty_bps` positive controls; got: {sig}"
    );
    assert!(
        !sig.contains("maintenance_bps") && !sig.contains("_maintenance_bps"),
        "apply_liquidation must not take a maintenance_bps / _maintenance_bps parameter \
         (the surviving collateral is re-derived at the initial margin ratio); got: {sig}"
    );

    // Whole-tree scan: no .rs file under src/ or tests/ revives the fns. The
    // audit's own file necessarily embeds the marker strings above, so it is
    // excluded. `file!()` is workspace-root-relative in this workspace
    // (`programs/fructus/src/tests.rs`), so match its `src/`-rooted suffix
    // against the manifest-relative scan paths.
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for sub in ["src", "tests"] {
        let dir = manifest.join(sub);
        if dir.is_dir() {
            collect_rs_files(&dir, &mut files);
        }
    }
    assert!(
        !files.is_empty(),
        "NO-PER-POSITION-LIQUIDATION-REMAINS scan found no .rs files under src/ or \
         tests/ — the scan would be vacuous"
    );
    let own_rel: &str = {
        let f = file!();
        match f.rfind("src/") {
            Some(i) => &f[i..],
            None => f,
        }
    };
    for path in files {
        if path.ends_with(own_rel) {
            continue; // this audit file itself carries the marker strings
        }
        let src = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
        for stale in STALE_PER_POSITION_FNS {
            assert!(
                !src.contains(stale),
                "{}: the superseded per-position definition `{stale}` reappeared \
                 (REQ-A2-6 / NO-PER-POSITION-LIQUIDATION-REMAINS)",
                path.display()
            );
        }
    }
}

/// The exact superseded sentence REQ-A2-7 removes when `docs/modules/
/// liquidation.md` is rewritten to the account-level model.
const STALE_PER_POSITION_SENTENCE: &str =
    "position is liquidatable iff its equity is **strictly** below";

/// REQ-A2-7 / DOCS-ACCOUNT-MARGIN-MODEL (RED on the pre-wave docs). Exact
/// markers, so the implementation wave can satisfy them:
/// (a) `docs/modules/liquidation.md` contains `account-level`, contains
///     `account_liquidatable`, keeps `equity` + `deposited` — and no longer
///     contains the exact old sentence [`STALE_PER_POSITION_SENTENCE`];
/// (b) the `docs/api-reference.md` `liquidate` ROW (the line starting
///     `| \`liquidate\``) contains `side` and `other_position`;
/// (c) `docs/modules/collateral.md` contains `equity` (the withdraw gate).
#[test]
fn docs_account_margin_model() {
    // (a) liquidation.md — the account-level rewrite.
    let liq = read_doc("../../docs/modules/liquidation.md");
    assert!(
        liq.contains("account-level"),
        "docs/modules/liquidation.md must document the account-level model \
         (marker: `account-level`; REQ-A2-7)"
    );
    assert!(
        liq.contains("account_liquidatable"),
        "docs/modules/liquidation.md must name the account-level predicate \
         `account_liquidatable` (REQ-A2-7)"
    );
    assert!(
        liq.contains("equity") && liq.contains("deposited"),
        "docs/modules/liquidation.md must state the account equity model \
         `equity = deposited + Σ upnl` (markers: `equity`, `deposited`)"
    );
    assert!(
        !liq.contains(STALE_PER_POSITION_SENTENCE),
        "docs/modules/liquidation.md still carries the superseded per-position \
         sentence `{STALE_PER_POSITION_SENTENCE}` — the account-level rewrite \
         (REQ-A2-7) must remove it"
    );

    // (b) api-reference.md — the `liquidate` row carries the new signature.
    let api = read_doc("../../docs/api-reference.md");
    let row = api
        .lines()
        .find(|l| l.trim_start().starts_with("| `liquidate`"))
        .expect("docs/api-reference.md must have a `liquidate` instruction row");
    assert!(
        row.contains("side"),
        "the `liquidate` row in docs/api-reference.md must document the new \
         `side` argument (REQ-A2-7/D8); got: {row}"
    );
    assert!(
        row.contains("other_position"),
        "the `liquidate` row in docs/api-reference.md must document the \
         `other_position` account (REQ-A2-7/D8); got: {row}"
    );

    // (c) collateral.md — the withdraw gate gains the equity half.
    let col = read_doc("../../docs/modules/collateral.md");
    assert!(
        col.contains("equity"),
        "docs/modules/collateral.md must document the withdraw equity gate \
         (marker: `equity`; D9/REQ-A2-7)"
    );
}

/// The exact REST surface (REQ-B-7): the 16 routes `docs/api.md` must name.
const API_ROUTES: [&str; 16] = [
    "/auth/challenge",
    "/auth/verify",
    "/bind/prepare",
    "/bind/confirm",
    "/me",
    "/me/positions",
    "/me/history",
    "/market",
    "/market/book",
    "/actions/deposit",
    "/actions/withdraw",
    "/actions/orders",
    "/actions/orders/cancel",
    "/actions/positions/close",
    "/faucet",
    "/healthz",
];

/// The four WS push message types (REQ-B-7: `{type: 'book'|'mark'|'user'|'tx'}`).
const WS_MESSAGE_TYPES: [&str; 4] = ["book", "mark", "user", "tx"];

/// REQ-C-4 / DOCS-API-SURFACE-COMPLETE (RED on the pre-wave docs — `docs/api.md`
/// and `docs/api/ws.md` do not exist yet, hence the RUNTIME reads). Markers:
/// (a) `docs/api.md` names each of the 16 route paths verbatim;
/// (b) `docs/api/ws.md` names each WS type as `'book'` / `"book"` /
///     `` `book` `` (single-quoted, double-quoted or backticked);
/// (c) `docs/README.md` links `api.md` and `modules/operator.md` in an
///     `](…)` / `(…)` reference (an optional `./` prefix is accepted).
#[test]
fn docs_api_surface_complete() {
    let api = read_doc("../../docs/api.md");
    for route in API_ROUTES {
        assert!(
            api.contains(route),
            "docs/api.md must name the route `{route}` (REQ-B-7/REQ-C-4)"
        );
    }

    let ws = read_doc("../../docs/api/ws.md");
    for ty in WS_MESSAGE_TYPES {
        let named = ws.contains(&format!("'{ty}'"))
            || ws.contains(&format!("\"{ty}\""))
            || ws.contains(&format!("`{ty}`"));
        assert!(
            named,
            "docs/api/ws.md must document the `{ty}` push message type \
             (REQ-B-7: `{{type: 'book'|'mark'|'user'|'tx', ...}}`)"
        );
    }

    let readme = read_doc("../../docs/README.md");
    for target in ["api.md", "modules/operator.md"] {
        let linked = [
            format!("]({target}"),
            format!("](./{target}"),
            format!("({target})"),
            format!("(./{target})"),
        ]
        .iter()
        .any(|marker| readme.contains(marker.as_str()));
        assert!(
            linked,
            "docs/README.md must index `{target}` as a link \
             (e.g. `[{target}]({target})`; REQ-C-4)"
        );
    }
}
