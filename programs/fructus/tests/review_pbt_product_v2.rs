//! Review B1 — adversarial property-test modelling of the product-v2 program
//! (program side), **layer 1: intra-module + composition**.
//!
//! This file is a REVIEW artifact (new, never editing existing tests): it
//! re-derives the product-v2 contracts from their acceptance propositions and
//! measures the implementation against independently written expectations over
//! the FULL domains (including the hostile extremes), rather than against the
//! implementation's own assumptions.
//!
//! Coverage (review.md §B, layer 1):
//! * `operator::authorized` — the full authorization matrix as a truth table
//!   over the key-equality classes (signer / default / foreign, per field), with
//!   in-property mutation controls proving each conjunct is load-bearing.
//! * The four account-margin functions — `account_equity`,
//!   `account_margin_required`, `account_liquidatable`,
//!   `account_liquidation_loss` — over extremes of `u64`/`i128`/`u16`,
//!   including the strict-`<` boundary (equity == requirement is healthy) and
//!   the zero-exposure short-circuit.
//! * The withdraw-gate composition: `collateral::withdraw` equals an
//!   independent formulation (`amount <= deposited - reserved` AND the
//!   post-withdraw equity comparison rewritten without saturation), and —
//!   the cross-module invariant the gate exists for — a SUCCESSFUL withdraw
//!   can never leave an account liquidatable when `reserved` is the account's
//!   initial-margin requirement (no self-drain to forced liquidation).
//! * `orderbook::cancel` — exact-removal / owner-mismatch / not-found semantics
//!   with byte-exact book immutability on rejection.
//! * The liquidation release algebra (`apply_liquidation`) against inline
//!   ceiling arithmetic, tying the released collateral to the account-level
//!   requirement identity `reserved_after == Σ m(n_i, im)`.

use anchor_lang::prelude::Pubkey;
use proptest::prelude::*;

use fructus::collateral::withdraw;
use fructus::error::FructusError;
use fructus::liquidation::{
    account_equity, account_liquidatable, account_liquidation_loss, account_margin_required,
    apply_liquidation,
};
use fructus::operator::authorized;
use fructus::orderbook::{cancel, Book, Order, Side};
use fructus::positions::margin_required;

// ---------------------------------------------------------------------------
// Shared domain helpers (hostile extremes are REACHABLE, not astronomically
// unlikely: every "any" draw below mixes uniform values with the exact
// boundary shapes the code turns on).
// ---------------------------------------------------------------------------

/// Arbitrary pubkey plus the two boundary shapes: the all-zero key
/// (`Pubkey::default()` — the revoke state) and a repeated-byte key.
fn any_pubkey() -> impl Strategy<Value = Pubkey> {
    prop_oneof![
        8 => proptest::array::uniform32(any::<u8>()),
        1 => Just([0u8; 32]),
        1 => any::<u8>().prop_map(|b| [b; 32]),
    ]
    .prop_map(Pubkey::from)
}

fn any_u64_extreme() -> impl Strategy<Value = u64> {
    prop_oneof![
        6 => any::<u64>(),
        1 => Just(u64::MAX),
        1 => Just(0u64),
        1 => Just(1u64),
        1 => Just(1u64 << 63),
        // Production-band values (USDC microunits) mixed in.
        3 => 0u64..=1_000_000_000_000,
    ]
}

fn any_i128_extreme() -> impl Strategy<Value = i128> {
    prop_oneof![
        6 => any::<i128>(),
        1 => Just(i128::MIN),
        1 => Just(i128::MAX),
        1 => Just(0i128),
        1 => Just(-(u64::MAX as i128)),
        1 => Just(u64::MAX as i128),
        1 => Just(-1i128),
        1 => Just(1i128),
        // Production-band PnL values (USDC microunits).
        3 => -1_000_000_000_000i128..=1_000_000_000_000,
    ]
}

/// Inline ceiling `margin_required` in u128 (total on the whole domain) —
/// never routed through the function under test.
fn ceil_margin(n: u64, bps: u16) -> u128 {
    ((n as u128) * (bps as u128)).div_ceil(10_000)
}

/// Inline account requirement: the checked sum of both sides' ceilings.
fn inline_account_required(n_long: u64, n_short: u64, bps: u16) -> Option<u64> {
    u64::try_from(ceil_margin(n_long, bps) + ceil_margin(n_short, bps)).ok()
}

/// Extract the numeric anchor error code from an `anchor_lang` error.
fn anchor_code(err: &anchor_lang::error::Error) -> u32 {
    match err {
        anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
        other => panic!("expected an AnchorError, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 1. `operator::authorized` — full domain
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// REQ-A1-6: `authorized` holds iff `record_operator == signer != default`
    /// AND `record_market == market` AND `record_user == user`, over the full
    /// key domain. Each record field is drawn from {ground truth, foreign key,
    /// all-default}, so every bind/not-bind class combination is sampled —
    /// the property fails on a predicate that never authorizes AND on one that
    /// always authorizes.
    #[test]
    fn operator_auth_matrix_full_domain(
        signer in any_pubkey(),
        market in any_pubkey(),
        user in any_pubkey(),
        foreign_op in any_pubkey(),
        foreign_mkt in any_pubkey(),
        foreign_usr in any_pubkey(),
        // The equality classes, forced: 0 = ground truth, 1 = default, 2 = foreign.
        op_class in 0u8..=2u8,
        mkt_class in 0u8..=2u8,
        usr_class in 0u8..=2u8,
    ) {
        let pick = |class: u8, ground: Pubkey, foreign: Pubkey| match class {
            0 => ground,
            1 => Pubkey::default(),
            _ => foreign,
        };
        let record_operator = pick(op_class, signer, foreign_op);
        let record_market = pick(mkt_class, market, foreign_mkt);
        let record_user = pick(usr_class, user, foreign_usr);

        let expected = record_operator == signer
            && record_operator != Pubkey::default()
            && record_market == market
            && record_user == user;

        prop_assert_eq!(
            authorized(
                &signer,
                &record_operator,
                &record_market,
                &record_user,
                &market,
                &user
            ),
            expected,
            "authorized must be exactly (record_operator == signer != default) ∧ \
             record_market == market ∧ record_user == user \
             (signer={}, record_operator={}, record_market={}, record_user={}, \
             market={}, user={})",
            signer,
            record_operator,
            record_market,
            record_user,
            market,
            user
        );

        // Mutation control: from a satisfying tuple, breaking ANY single
        // conjunct flips the answer to false — each conjunct is load-bearing.
        if expected {
            // Break the operator: a foreign key (or default) authorizes nothing.
            if foreign_op != signer {
                prop_assert!(
                    !authorized(
                        &signer,
                        &foreign_op,
                        &record_market,
                        &record_user,
                        &market,
                        &user
                    ),
                    "a foreign record_operator must not authorize"
                );
            }
            prop_assert!(
                !authorized(
                    &signer,
                    &Pubkey::default(),
                    &record_market,
                    &record_user,
                    &market,
                    &user
                ),
                "the revoked (default) record_operator must not authorize"
            );
            // Break the scope: another signer, market or user must not pass.
            if foreign_usr != user {
                prop_assert!(
                    !authorized(
                        &signer,
                        &record_operator,
                        &record_market,
                        &record_user,
                        &market,
                        &foreign_usr
                    ),
                    "a record scoped to another user must not authorize"
                );
            }
            if foreign_mkt != market {
                prop_assert!(
                    !authorized(
                        &signer,
                        &record_operator,
                        &record_market,
                        &record_user,
                        &foreign_mkt,
                        &user
                    ),
                    "a record scoped to another market must not authorize"
                );
            }
        }
    }
}

/// Deterministic truth table (the pin the PBT above shrinks to): 3×3×3×3 over
/// {signer, default, foreign} classes, with explicit expected values.
#[test]
fn operator_auth_truth_table_pinned() {
    let signer = Pubkey::new_from_array([1u8; 32]);
    let foreign = Pubkey::new_from_array([2u8; 32]);
    let market = Pubkey::new_from_array([3u8; 32]);
    let user = Pubkey::new_from_array([4u8; 32]);
    // Each field's class list contains its ground truth, the revoke state and
    // a foreign key: 3×3×3 = 27 cells with exactly one satisfying tuple.
    let op_classes = [signer, Pubkey::default(), foreign];
    let mkt_classes = [market, Pubkey::default(), foreign];
    let usr_classes = [user, Pubkey::default(), foreign];
    let mut true_count = 0usize;
    let mut false_count = 0usize;
    for &record_operator in &op_classes {
        for &record_market in &mkt_classes {
            for &record_user in &usr_classes {
                let expected = record_operator == signer
                    && record_operator != Pubkey::default()
                    && record_market == market
                    && record_user == user;
                let got = authorized(
                    &signer,
                    &record_operator,
                    &record_market,
                    &record_user,
                    &market,
                    &user,
                );
                assert_eq!(got, expected, "truth-table cell mismatch");
                if got {
                    true_count += 1;
                } else {
                    false_count += 1;
                }
            }
        }
    }
    // Non-vacuity: the table discriminates (exactly one satisfying cell).
    assert_eq!(true_count, 1, "exactly one authorization cell must hold");
    assert!(false_count > 0, "the table must reject as well as accept");
}

// ---------------------------------------------------------------------------
// 2. The four account-margin functions — full domain incl. extremes
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// REQ-A2-1: `account_equity(deposited, pnl_sum)` is `deposited + pnl_sum`
    /// as a signed i128, saturating at the i128 extremes — total, no panic.
    #[test]
    fn account_equity_is_saturating_add_extremes(
        deposited in any_u64_extreme(),
        pnl_sum in any_i128_extreme(),
    ) {
        let expected = (deposited as i128).saturating_add(pnl_sum);
        prop_assert_eq!(
            account_equity(deposited, pnl_sum),
            expected,
            "account_equity({}, {}) must be the saturating i128 sum",
            deposited,
            pnl_sum
        );
    }

    /// REQ-A2-1: `account_margin_required` is the CHECKED sum of both sides'
    /// ceilings (no netting: a long and a short both require margin), total on
    /// `u64 × u64 × u16`, and `None` exactly when the sum overflows `u64`.
    #[test]
    fn account_margin_required_full_domain_no_netting(
        n_long in any_u64_extreme(),
        n_short in any_u64_extreme(),
        bps in any::<u16>(),
    ) {
        let expected = inline_account_required(n_long, n_short, bps);
        prop_assert_eq!(
            account_margin_required(n_long, n_short, bps),
            expected,
            "account_margin_required({}, {}, {}) must be the checked sum of both \
             ceilings",
            n_long,
            n_short,
            bps
        );

        // No netting, discriminated: equal two-sided exposure costs exactly
        // twice the single-side ceiling (a netting model would return m(0)=0
        // or m(n)).
        if n_long == n_short && n_long > 0 {
            if let (Some(req), Some(side)) =
                (account_margin_required(n_long, n_short, bps), margin_required(n_long, bps))
            {
                prop_assert_eq!(
                    req,
                    2 * side,
                    "hedged legs must NOT net off: ({}, {}) at {} bps",
                    n_long,
                    n_short,
                    bps
                );
            }
        }
    }

    /// REQ-A2-1: `account_liquidatable` — zero exposure ⇒ false; else the
    /// STRICT comparison `equity < Σ m(n_i, maintenance)`; `None` only on the
    /// requirement-sum overflow. The in-property boundary construction pins
    /// `equity == requirement ⇒ healthy` and `equity == requirement - 1 ⇒
    /// liquidatable`.
    #[test]
    fn account_liquidatable_full_domain_strict_boundary(
        deposited in any_u64_extreme(),
        pnl_sum in any_i128_extreme(),
        n_long in any_u64_extreme(),
        n_short in any_u64_extreme(),
        mm in any::<u16>(),
    ) {
        let expected = inline_account_required(n_long, n_short, mm).map(|required| {
            if n_long == 0 && n_short == 0 {
                false
            } else {
                (deposited as i128).saturating_add(pnl_sum) < required as i128
            }
        });
        prop_assert_eq!(
            account_liquidatable(deposited, pnl_sum, n_long, n_short, mm),
            expected,
            "account_liquidatable(d={}, p={}, nl={}, ns={}, mm={}) must be the \
             strict account formula",
            deposited,
            pnl_sum,
            n_long,
            n_short,
            mm
        );
    }

    /// The exact `<` boundary, constructed: with `equity == requirement` the
    /// account is healthy; one microunit less of equity (when representable) is
    /// liquidatable. Uses realistic notionals + the full bps band.
    #[test]
    fn account_liquidatable_equality_boundary_is_healthy(
        n_long in 1u64..1_000_000_000_000u64,
        n_short in 0u64..1_000_000_000_000u64,
        mm in 1u16..=10_000u16,
        pnl_sum in -1_000_000_000_000i128..=1_000_000_000_000,
    ) {
        let required = match inline_account_required(n_long, n_short, mm) {
            Some(r) => r,
            None => return Ok(()),
        };
        // d_exact = required - pnl_sum must land in the u64 domain.
        let d_exact = required as i128 - pnl_sum;
        if d_exact < 0 || d_exact > u64::MAX as i128 {
            return Ok(());
        }
        let d = d_exact as u64;
        // equity == required: strictly healthy.
        prop_assert_eq!(
            account_liquidatable(d, pnl_sum, n_long, n_short, mm),
            Some(false),
            "equity == requirement must be healthy (d={}, p={}, req={})",
            d,
            pnl_sum,
            required
        );
        // One microunit of equity less: liquidatable (exposure is non-zero).
        if d >= 1 {
            prop_assert_eq!(
                account_liquidatable(d - 1, pnl_sum, n_long, n_short, mm),
                Some(true),
                "equity == requirement - 1 must be liquidatable (d={}, p={})",
                d,
                pnl_sum
            );
        }
    }

    /// REQ-A2-2: the booked account loss is `max(0, −Σ upnl)`, u64-saturated —
    /// independent of the seam clamp; `i128::MIN` saturates to `u64::MAX`.
    #[test]
    fn account_liquidation_loss_full_domain(pnl_sum in any_i128_extreme()) {
        let expected = if pnl_sum < 0 {
            pnl_sum.unsigned_abs().min(u64::MAX as u128) as u64
        } else {
            0
        };
        prop_assert_eq!(
            account_liquidation_loss(pnl_sum),
            expected,
            "account_liquidation_loss({}) must be max(0, -pnl_sum), u64-saturated",
            pnl_sum
        );
    }
}

/// Extreme pins for the four account-margin functions (deterministic).
#[test]
fn account_margin_extreme_pins() {
    // Saturation pins.
    assert_eq!(account_equity(u64::MAX, i128::MAX), i128::MAX);
    assert_eq!(account_equity(0, i128::MIN), i128::MIN);
    assert_eq!(
        account_equity(u64::MAX, i128::MIN),
        i128::MIN + u64::MAX as i128,
        "MIN + (2^64 - 1) is representable; no saturation needed"
    );
    assert_eq!(account_liquidation_loss(i128::MIN), u64::MAX);
    assert_eq!(account_liquidation_loss(-(u64::MAX as i128)), u64::MAX);
    assert_eq!(account_liquidation_loss(-1), 1);
    assert_eq!(account_liquidation_loss(0), 0);
    assert_eq!(account_liquidation_loss(i128::MAX), 0);

    // Requirement extremes: the checked sum overflows exactly past u64.
    assert_eq!(account_margin_required(0, 0, u16::MAX), Some(0));
    assert_eq!(
        account_margin_required(u64::MAX, 0, 1),
        Some(margin_required(u64::MAX, 1).unwrap()),
        "one huge side at 1 bps is still representable"
    );
    assert_eq!(
        account_margin_required(u64::MAX, 0, u16::MAX),
        None,
        "ceil(u64::MAX × 65535 / 1e4) exceeds u64"
    );
    assert_eq!(
        account_margin_required(0, u64::MAX, u16::MAX),
        None,
        "the short side overflows the same way"
    );
    assert_eq!(
        account_margin_required(u64::MAX, u64::MAX, 0),
        Some(0),
        "zero bps costs no margin even on the extreme notionals"
    );

    // Zero-exposure short-circuit is total, including degenerate bps.
    assert_eq!(account_liquidatable(0, i128::MIN, 0, 0, 0), Some(false));
    assert_eq!(
        account_liquidatable(u64::MAX, i128::MAX, 0, 0, u16::MAX),
        Some(false)
    );

    // A one-microunit long at 1 bps requires 1; equity 0 < 1 ⇒ liquidatable.
    assert_eq!(account_margin_required(1, 0, 1), Some(1));
    assert_eq!(account_liquidatable(0, 0, 1, 0, 1), Some(true));
    assert_eq!(account_liquidatable(1, 0, 1, 0, 1), Some(false));
}

// ---------------------------------------------------------------------------
// 3. Withdraw-gate composition
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// REQ-A2-3: `collateral::withdraw` succeeds iff `amount <= deposited −
    /// reserved` AND the post-withdraw equity `deposited + pnl_sum − amount`
    /// stays `>= reserved`. The gate comparison is re-derived WITHOUT the
    /// saturating composition: `post >= reserved ⟺ pnl_sum >= amount + reserved
    /// − deposited` (verified equivalent incl. saturation), evaluated in i128
    /// where every term is exact.
    #[test]
    fn withdraw_gate_composition_full_domain(
        deposited in any_u64_extreme(),
        reserved in any_u64_extreme(),
        pnl_sum in any_i128_extreme(),
        amount in any_u64_extreme(),
    ) {
        let expected = match deposited.checked_sub(reserved) {
            None => None,
            Some(free) => {
                if amount > free {
                    None
                } else {
                    // Independent gate formulation: exact i128 threshold.
                    // t = amount + reserved − deposited fits i128 comfortably.
                    let t = (amount as i128) + (reserved as i128) - (deposited as i128);
                    if pnl_sum >= t {
                        Some(deposited - amount)
                    } else {
                        None
                    }
                }
            }
        };
        prop_assert_eq!(
            withdraw(deposited, reserved, pnl_sum, amount),
            expected,
            "withdraw({}, {}, {}, {}) must be free-seam ∧ equity-gate",
            deposited,
            reserved,
            pnl_sum,
            amount
        );
    }

    /// The composition that motivates the gate (REQ-A2-3 / D9): for a real
    /// account whose `reserved` IS its initial-margin requirement
    /// `Σ m(n_i, im)`, a successful withdraw can never leave the account
    /// liquidatable under any maintenance ratio `mm <= im` — the ledger-only
    /// gate would let a user self-drain into forced liquidation.
    #[test]
    fn successful_withdraw_never_leaves_account_liquidatable(
        deposited in any_u64_extreme(),
        pnl_sum in any_i128_extreme(),
        n_long in any_u64_extreme(),
        n_short in any_u64_extreme(),
        im in any::<u16>(),
        mm in any::<u16>(),
        amount in any_u64_extreme(),
    ) {
        prop_assume!(mm <= im);
        let reserved = match inline_account_required(n_long, n_short, im) {
            Some(r) => r,
            None => return Ok(()),
        };
        if let Some(new_deposited) = withdraw(deposited, reserved, pnl_sum, amount) {
            // The post-withdraw ledger must still respect the free seam...
            prop_assert!(
                new_deposited >= reserved,
                "post-withdraw deposited {} must back the reserved requirement {}",
                new_deposited,
                reserved
            );
            // ...and, because mm <= im, must not be liquidatable.
            prop_assert_ne!(
                account_liquidatable(new_deposited, pnl_sum, n_long, n_short, mm),
                Some(true),
                "a successful withdraw left the account liquidatable \
                 (d={}, new_d={}, p={}, nl={}, ns={}, im={}, mm={}, amount={})",
                deposited,
                new_deposited,
                pnl_sum,
                n_long,
                n_short,
                im,
                mm,
                amount
            );
        }
    }

    /// Discriminative leg: the equity gate must bite exactly on negative PnL.
    /// With `amount == free` and `pnl_sum == -1`, the pre-v2 ledger-only gate
    /// would have allowed the withdrawal; the v2 gate must refuse it until the
    /// PnL is non-negative again.
    #[test]
    fn negative_pnl_at_the_free_seam_is_refused_by_the_equity_gate(
        reserved in 0u64..1_000_000_000_000u64,
        extra in 1u64..1_000_000_000_000u64,
    ) {
        let deposited = reserved.checked_add(extra).expect("in-band sum");
        let free = extra;
        // pnl_sum = 0: the free seam permits it.
        prop_assert_eq!(
            withdraw(deposited, reserved, 0, free),
            Some(reserved),
            "at zero PnL the free seam is the binding gate"
        );
        // pnl_sum = -1: the equity gate refuses the exact free seam.
        prop_assert_eq!(
            withdraw(deposited, reserved, -1, free),
            None,
            "one microunit of loss must close the gate at the free seam"
        );
        // pnl_sum = +1 (or any positive) re-opens it.
        prop_assert_eq!(
            withdraw(deposited, reserved, 1, free),
            Some(reserved),
            "positive PnL keeps the free seam open"
        );
    }
}

// ---------------------------------------------------------------------------
// 4. `orderbook::cancel` — exact removal, immutability on rejection
// ---------------------------------------------------------------------------

/// Build a random book with globally unique seqs: bids get `0..n_bid`, asks
/// continue after them. Owners are drawn from a small set so owner mismatches
/// are common.
fn any_book() -> impl Strategy<Value = Book> {
    (0usize..=6, 0usize..=6, any::<[u8; 24]>()).prop_map(|(n_bid, n_ask, seed)| {
        let owners: Vec<Pubkey> = (0u8..3)
            .map(|i| Pubkey::new_from_array([i + 7; 32]))
            .collect();
        let mut seq = 0u64;
        let mut bids = Vec::with_capacity(n_bid);
        let mut asks = Vec::with_capacity(n_ask);
        let byte = |k: usize| seed[(k * 3) % seed.len()];
        for i in 0..n_bid {
            let b = byte(i);
            bids.push(Order {
                owner: owners[(b as usize) % owners.len()],
                side: Side::Bid,
                price: 1 + (b as u64 % 300),
                size: 1 + (b as u64 % 500),
                seq,
            });
            seq += 1;
        }
        for i in 0..n_ask {
            let b = byte(i + n_bid);
            asks.push(Order {
                owner: owners[(b as usize) % owners.len()],
                side: Side::Ask,
                price: 1_000 + (b as u64 % 300),
                size: 1 + (b as u64 % 500),
                seq,
            });
            seq += 1;
        }
        Book {
            bids,
            asks,
            next_seq: seq,
        }
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// `orderbook::cancel` removes EXACTLY the addressed owned order and leaves
    /// every other order byte-identical and in order; `next_seq` is untouched.
    #[test]
    fn orderbook_cancel_removes_exactly_one_owned_order(
        book in any_book(),
        pick_bits in any::<u32>(),
    ) {
        let total = book.bids.len() + book.asks.len();
        if total == 0 {
            return Ok(());
        }
        let pre = book.clone();
        let idx = (pick_bits as usize) % total;
        let target = if idx < book.bids.len() {
            book.bids[idx].clone()
        } else {
            book.asks[idx - book.bids.len()].clone()
        };
        let mut after = book;
        let removed = cancel(&mut after, target.owner, target.seq)
            .expect("a present, owned order must cancel");
        prop_assert_eq!(removed.seq, target.seq);
        prop_assert_eq!(removed.owner, target.owner);
        prop_assert_eq!(removed.side, target.side);
        prop_assert_eq!(removed.price, target.price);
        prop_assert_eq!(removed.size, target.size);

        // Exact book: pre-book minus the removed element, everything else in
        // the same order.
        let mut expected_bids = pre.bids.clone();
        let mut expected_asks = pre.asks.clone();
        if idx < pre.bids.len() {
            expected_bids.remove(idx);
        } else {
            expected_asks.remove(idx - pre.bids.len());
        }
        prop_assert_eq!(&after.bids, &expected_bids, "bids must be exactly the pre-book minus the removal");
        prop_assert_eq!(&after.asks, &expected_asks, "asks must be exactly the pre-book minus the removal");
        prop_assert_eq!(after.next_seq, pre.next_seq, "cancel must not consume a seq");
    }

    /// A wrong owner is rejected with `OrderOwnerMismatch` and the book is
    /// byte-identical; an absent seq is rejected with `OrderNotFound`, same.
    #[test]
    fn orderbook_cancel_rejections_are_immutable(
        book in any_book(),
        pick_bits in any::<u32>(),
    ) {
        let total = book.bids.len() + book.asks.len();
        let stranger = Pubkey::new_from_array([250u8; 32]);
        if total > 0 {
            let idx = (pick_bits as usize) % total;
            let target = if idx < book.bids.len() {
                book.bids[idx].clone()
            } else {
                book.asks[idx - book.bids.len()].clone()
            };
            if target.owner != stranger {
                let mut same = book.clone();
                let err = cancel(&mut same, stranger, target.seq).unwrap_err();
                prop_assert_eq!(
                    anchor_code(&err),
                    u32::from(FructusError::OrderOwnerMismatch),
                    "cancelling another owner's order must be OrderOwnerMismatch"
                );
                prop_assert_eq!(&same, &book, "a rejected cancel must not mutate the book");
            }
        }
        // Absent seq: never present (unique seqs < next_seq).
        let absent = book.next_seq + 7;
        let mut same = book.clone();
        let err = cancel(&mut same, Pubkey::default(), absent).unwrap_err();
        prop_assert_eq!(
            anchor_code(&err),
            u32::from(FructusError::OrderNotFound),
            "an unknown seq must be OrderNotFound"
        );
        prop_assert_eq!(&same, &book, "a not-found cancel must not mutate the book");
    }
}

// ---------------------------------------------------------------------------
// 5. Liquidation release algebra against the account-level requirement
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// REQ-A2-2: for a position backed at the initial margin ratio, a
    /// liquidation of `amount` releases exactly
    /// `m(n, im) − m(n−amount, im)`; the account-level bookkeeping identity
    /// `reserved_after == old_reserved − released == Σ m(n_i', im)` holds; the
    /// reward is the ceiling penalty on the released collateral; and no value
    /// is created (`remaining + reward <= collateral`).
    #[test]
    fn liquidation_release_matches_account_margin_sums(
        n_target in 1u64..1_000_000_000_000u64,
        n_other in 0u64..1_000_000_000_000u64,
        amount in 1u64..1_000_000_000_000u64,
        im in 1u16..=10_000u16,
    ) {
        let amount = amount.min(n_target);
        let collateral =
            u64::try_from(ceil_margin(n_target, im)).expect("in-band ceiling fits u64");
        let (remaining, reward) =
            apply_liquidation(collateral, n_target, amount, im, 500).expect("valid amount");
        let surviving = n_target - amount;
        let expected_remaining =
            u64::try_from(ceil_margin(surviving, im)).expect("in-band ceiling fits u64");
        prop_assert_eq!(
            remaining,
            expected_remaining,
            "the survivor must hold m(n - amount, im)"
        );
        let released = collateral - remaining;
        // Account-level identity: reserved_after == Σ m(n_i', im).
        let reserved_before =
            u64::try_from(ceil_margin(n_target, im) + ceil_margin(n_other, im)).unwrap();
        let reserved_after = reserved_before - released;
        let expected_reserved_after =
            u64::try_from(ceil_margin(surviving, im) + ceil_margin(n_other, im)).unwrap();
        prop_assert_eq!(
            reserved_after,
            expected_reserved_after,
            "released collateral must move reserved exactly to Σ m(n_i', im)"
        );
        // Reward = ceiling penalty on the released margin.
        let expected_reward = released.div_ceil(20); // 500 bps = 1/20, ceiling
        prop_assert_eq!(reward, expected_reward, "reward must be ceil(released / 20)");
        prop_assert!(
            remaining + reward <= collateral,
            "no value created: remaining {} + reward {} > collateral {}",
            remaining,
            reward,
            collateral
        );
    }

    /// Full liquidation empties the targeted side (zero collateral), and the
    /// invalid-amount domain is exactly {0, > notional}.
    #[test]
    fn liquidation_full_and_invalid_amounts(
        n_target in 1u64..1_000_000_000_000u64,
        im in 1u16..=10_000u16,
        junk in any_u64_extreme(),
    ) {
        let collateral = u64::try_from(ceil_margin(n_target, im)).unwrap();
        let (remaining, _) =
            apply_liquidation(collateral, n_target, n_target, im, 500).expect("full is valid");
        prop_assert_eq!(remaining, 0, "a full liquidation releases all collateral");
        prop_assert_eq!(
            apply_liquidation(collateral, n_target, 0, im, 500),
            Err(fructus::liquidation::LiquidateError::InvalidAmount)
        );
        if junk > n_target {
            prop_assert_eq!(
                apply_liquidation(collateral, n_target, junk, im, 500),
                Err(fructus::liquidation::LiquidateError::InvalidAmount)
            );
        }
    }
}
