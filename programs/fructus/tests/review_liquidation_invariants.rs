//! Independent review-agent regression suite for the collateral-tracking
//! invariant of the account-level liquidation engine (product-v2 A2,
//! REQ-A2-2 / proposition `LIQUIDATION-SURVIVOR-BACKED-AT-INITIAL-MARGIN`).
//!
//! The source documents `Position.collateral` as:
//!
//! > "Reserved margin for this position, in USDC microunits: always equals
//! > `margin_required(notional, initial_margin_bps)`."
//!
//! (`programs/fructus/src/state.rs`.) The `apply_open_fills` / `apply_close_fills`
//! adapters maintain exactly that invariant (`position.collateral` is recomputed
//! from the new notional at `initial_margin_bps` on every open/close). This suite
//! pins the SAME invariant across the (account-level) `liquidate` path's
//! **targeted side**: after a partial or full liquidation of `amount`, the
//! surviving side's collateral must equal
//! `margin_required(notional - amount, initial_margin_bps)` — and, in
//! particular, a **fully** liquidated (closed, `notional == 0`) side must retain
//! **zero** collateral — while `release + reward <= position_collateral`
//! (no value is created).
//!
//! NOTE: this is the REVIEW agent's suite. It asserts the invariant documented in
//! `state.rs`, NOT the `remaining`-collateral behavior described in
//! docs/modules/liquidation.md. If it fails, the `liquidate` adapter decouples
//! `position.collateral` from `margin_required(notional)`. The release math is
//! unchanged by the A2 supersession, so this suite is a PIN (expected GREEN).

use fructus::liquidation::{apply_liquidation, liquidation_penalty};
use fructus::positions::margin_required;
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// LIQUIDATION-SURVIVOR-BACKED-AT-INITIAL-MARGIN: with the targeted side
    /// backed at the initial margin ratio (`position_collateral = m(notional,
    /// im)`), a liquidation of `amount <= notional` leaves exactly
    /// `remaining == m(notional - amount, im)` (full ⇒ zero), pays
    /// `reward == penalty(released)` and creates no value
    /// (`remaining + reward <= position_collateral`).
    #[test]
    fn liquidation_survivor_backed_at_initial_margin(
        (notional, amount, initial_bps, penalty_bps) in
            (1u64..1_000_000_000_000u64, 1u16..=10_000u16, 0u16..=10_000u16)
                .prop_flat_map(|(notional, initial_bps, penalty_bps)| {
                    (
                        Just(notional),
                        // The task domain: 1 <= amount <= notional.
                        1u64..=notional,
                        Just(initial_bps),
                        Just(penalty_bps),
                    )
                })
    ) {
        let position_collateral =
            margin_required(notional, initial_bps).expect("margin_required is total");
        let (remaining, reward) = apply_liquidation(
            position_collateral,
            notional,
            amount,
            initial_bps,
            penalty_bps,
        )
        .expect("a 1..=notional amount is a valid liquidation");

        // The surviving side holds exactly m(notional - amount, im) — the
        // state.rs invariant, maintained by the liquidation path like open/close.
        let surviving_notional = notional - amount;
        let expected_remaining =
            margin_required(surviving_notional, initial_bps).expect("total");
        prop_assert_eq!(
            remaining,
            expected_remaining,
            "after liquidating {} of {} at {} bps, the survivor must hold \
             m({}, {}) = {}, not {}",
            amount,
            notional,
            initial_bps,
            surviving_notional,
            initial_bps,
            expected_remaining,
            remaining
        );

        // A FULL liquidation (amount == notional) closes the side: zero collateral.
        if amount == notional {
            prop_assert_eq!(
                remaining,
                0,
                "a fully liquidated (notional == 0) side must retain ZERO collateral"
            );
        }

        // The liquidator reward is the penalty share of the released collateral.
        let released = position_collateral.saturating_sub(remaining);
        prop_assert_eq!(
            reward,
            liquidation_penalty(released, penalty_bps).expect("penalty is total on u64 x u16"),
            "reward must be penalty(released) at {} bps",
            penalty_bps
        );

        // No value created: the survivor + the reward never exceed the backing.
        prop_assert!(
            remaining + reward <= position_collateral,
            "value created: remaining {} + reward {} > position_collateral {}",
            remaining,
            reward,
            position_collateral
        );
    }
}

/// Deterministic witness of the pinned invariant (partial + full), including the
/// exact release/reward arithmetic the review shrank in earlier rounds.
#[test]
fn liquidation_survivor_backed_at_initial_margin_witness() {
    // notional = 100, initial 10% (collateral = 10), targeted amount = 50:
    // remaining = m(50, 1000) = 5, released = 5, reward = ceil(5 * 500 / 1e4) = 1.
    let notional = 100u64;
    let initial_bps = 1_000u16;
    let position_collateral = margin_required(notional, initial_bps).expect("total");
    assert_eq!(position_collateral, 10);

    let (remaining, reward) =
        apply_liquidation(position_collateral, notional, 50, initial_bps, 500)
            .expect("valid partial liquidation");
    assert_eq!(remaining, margin_required(50, initial_bps).expect("total"));
    assert_eq!(remaining, 5, "survivor held at the initial margin ratio");
    assert_eq!(reward, 1, "penalty = ceil(released * 500 / 1e4)");
    assert!(
        remaining + reward <= position_collateral,
        "no value created"
    );

    // Full liquidation of the same side: notional -> 0, so collateral -> 0.
    let (remaining_full, reward_full) =
        apply_liquidation(position_collateral, notional, notional, initial_bps, 500)
            .expect("valid full liquidation");
    assert_eq!(
        remaining_full,
        margin_required(0, initial_bps).expect("total"),
        "a fully liquidated (notional == 0) side releases ALL collateral"
    );
    assert_eq!(remaining_full, 0);
    let released = position_collateral - remaining_full;
    assert_eq!(
        reward_full,
        liquidation_penalty(released, 500).expect("total"),
        "full-liquidation reward is the penalty on the whole released collateral"
    );
    assert!(
        remaining_full + reward_full <= position_collateral,
        "no value created"
    );
}
