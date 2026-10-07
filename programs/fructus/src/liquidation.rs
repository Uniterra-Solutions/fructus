//! Pure account-level liquidation logic (product-v2 A2, D6/D8; supersedes the
//! per-position engine of issue #8): the account health predicate, the
//! cross-margin (NO netting) requirement, the account loss-booking convention,
//! and the per-side penalty/partial/full liquidation transition. Free of Anchor
//! account plumbing so `proptest` drives the invariants directly; the thin
//! `liquidate` adapter in `lib.rs` applies it to the on-chain `Position` /
//! `UserCollateral` accounts.
//!
//! Model (units = APY_SCALE / USDC microunits, all signed where required):
//! * **Cross margin, no netting** (D6): the margin requirement is the sum over
//!   the two sides, `Σ_side margin_required(n_side, bps)` — a long and a short
//!   do NOT offset each other.
//! * **Account equity** `= deposited + Σ_side upnl` (signed `i128`, saturating
//!   at the i128 extremes so hostile inputs can never panic).
//! * **Account-liquidatable** iff the account has exposure
//!   (`n_long + n_short > 0`) and `equity < Σ_side margin_required(n_side,
//!   maintenance_bps)` — a **strict** `<`; an exactly-maintained account is
//!   healthy. A zero-exposure account is never liquidatable.
//! * **Account loss**: the unrealized loss a liquidation books into the PnL
//!   pool is `max(0, −Σ_side upnl)`, saturated at `u64::MAX`. The seam clamp
//!   (`deposited − reserved_after − reward`) is applied by the caller through
//!   `settlement::apply_liquidation_loss`.
//! * **Per-side transition** (D8): liquidating `amount` of the targeted side
//!   reduces the surviving exposure to `notional − amount`; the surviving
//!   collateral is re-derived at the **initial** margin ratio
//!   (`state.rs`: `position.collateral == margin_required(notional,
//!   initial_margin_bps)`), so the released collateral is
//!   `position_collateral − min(margin_required(notional − amount,
//!   initial_margin_bps), position_collateral)`; the liquidator reward is the
//!   penalty share of that released collateral (R-L3). For a full liquidation
//!   it is the whole `position_collateral` (a closed position holds zero
//!   collateral).
//!
//! All arithmetic is signed `i128` with `checked_*`/`saturating_*` — no panicking
//! math (AGENTS.md).

use anchor_lang::prelude::*;

use crate::positions::margin_required;

/// Reason a liquidation transition cannot be applied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiquidateError {
    /// `amount == 0` or `amount > notional`.
    InvalidAmount,
    /// A `u64`/`i128` intermediate overflowed.
    Overflow,
}

impl From<LiquidateError> for crate::FructusError {
    fn from(e: LiquidateError) -> Self {
        match e {
            LiquidateError::InvalidAmount => crate::FructusError::InvalidSize,
            LiquidateError::Overflow => crate::FructusError::ArithmeticOverflow,
        }
    }
}

/// Account equity (REQ-A2-1/D6): `deposited + pnl_sum` as a signed `i128`,
/// saturating at the `i128` extremes (hostile inputs can never panic). `pnl_sum`
/// is the signed Σ unrealized PnL over both sides (`positions::pnl` per side).
pub fn account_equity(deposited: u64, pnl_sum: i128) -> i128 {
    (deposited as i128).saturating_add(pnl_sum)
}

/// The account-level cross-margin requirement: the **checked sum** of both
/// sides' ceilings, `margin_required(n_long, bps) + margin_required(n_short,
/// bps)` (REQ-A2-1/D6, no netting). Each side's ceiling is `margin_required`'s
/// (total on `u64 × u16`); `None` only when the `u64` sum itself overflows.
/// `bps` is the initial ratio for the open/withdraw gate and the maintenance
/// ratio for the liquidation trigger.
pub fn account_margin_required(n_long: u64, n_short: u64, bps: u16) -> Option<u64> {
    margin_required(n_long, bps)?.checked_add(margin_required(n_short, bps)?)
}

/// Whether the ACCOUNT is liquidatable (REQ-A2-1/REQ-A2-2): the account has
/// exposure (`n_long + n_short > 0`) and `equity < Σ_side margin_required(n_side,
/// maintenance_bps)` — a **strict** `<` (equality is healthy). A zero-exposure
/// account is never liquidatable. `None` only when the requirement sum
/// overflows `u64`.
pub fn account_liquidatable(
    deposited: u64,
    pnl_sum: i128,
    n_long: u64,
    n_short: u64,
    maintenance_bps: u16,
) -> Option<bool> {
    // No exposure => never liquidatable (the short-circuit). Checked first so
    // the zero-exposure answer is total even when both ceilings are degenerate.
    if n_long == 0 && n_short == 0 {
        return Some(false);
    }
    let required = account_margin_required(n_long, n_short, maintenance_bps)?;
    // Strict `<`: an exactly-maintained account is healthy.
    Some(account_equity(deposited, pnl_sum) < required as i128)
}

/// The account loss booked into the PnL pool by a liquidation:
/// `max(0, −pnl_sum)`, saturated at `u64::MAX` (REQ-A2-2) — the negative-sum
/// convention, independent of the caller's seam clamp
/// (`settlement::apply_liquidation_loss` caps the booked amount at
/// `deposited − reserved_after − reward`).
pub fn account_liquidation_loss(pnl_sum: i128) -> u64 {
    if pnl_sum < 0 {
        // `unsigned_abs` never panics (it covers `i128::MIN`), and the `min`
        // saturates the magnitude at `u64::MAX`.
        pnl_sum.unsigned_abs().min(u64::MAX as u128) as u64
    } else {
        0
    }
}

/// The liquidator penalty on `collateral` at `penalty_bps`: ceiling division
/// `collateral·penalty_bps/10_000` (R-L3). `None` only on overflow. Guarantees
/// `penalty <= collateral` for `penalty_bps <= 10_000`.
pub fn liquidation_penalty(collateral: u64, penalty_bps: u16) -> Option<u64> {
    let exact = (collateral as u128)
        .checked_mul(penalty_bps as u128)?
        .checked_add(9_999)?;
    u64::try_from(exact / 10_000).ok()
}

/// Apply a liquidation of `amount` notional to the TARGETED side of an account
/// (D8), preserving the documented `Position.collateral ==
/// margin_required(notional, initial_margin_bps)` invariant (see `state.rs`) —
/// the SAME invariant that `apply_open_fills` / `apply_close_fills` maintain on
/// the open/close paths.
///
/// * `amount == 0` or `amount > notional` → [`LiquidateError::InvalidAmount`].
/// * The position is backed at the **initial** margin ratio, so liquidating
///   `amount` reduces the surviving exposure to `notional - amount` and the
///   position keeps `remaining = margin_required(notional - amount,
///   initial_margin_bps)` (clamped to the collateral actually held). For a full
///   liquidation (`amount == notional`) the surviving notional is `0` and
///   `margin_required(0, _) == 0` — a closed (zero-notional) position holds
///   **zero** collateral, all of it released.
/// * The collateral freed by the liquidation is `released = position_collateral -
///   remaining`; the liquidator reward is the penalty share of that freed
///   collateral (`liquidation_penalty(released, penalty_bps)`, which never
///   exceeds `released`, so `remaining + reward ≤ position_collateral` — no value
///   is created and the surviving collateral never goes negative).
///
/// Returns the **position's** remaining collateral and the liquidator's reward.
/// The caller derives the remaining notional (`notional − amount`) and credits
/// the reward to the liquidator's collateral ledger. Both return values are
/// always non-negative (never an insolvent negative remaining collateral).
pub fn apply_liquidation(
    position_collateral: u64,
    notional: u64,
    amount: u64,
    initial_margin_bps: u16,
    penalty_bps: u16,
) -> std::result::Result<(u64, u64), LiquidateError> {
    if amount == 0 || amount > notional {
        return Err(LiquidateError::InvalidAmount);
    }
    // Surviving exposure-backed collateral at the INITIAL margin ratio — the
    // documented invariant. `surviving_notional <= notional` and
    // `margin_required` is monotonic non-decreasing in notional, so under the
    // invariant `remaining <= position_collateral`. Clamp to the collateral
    // actually held for non-invariant (arbitrary) callers, so the surviving
    // collateral never exceeds what the position held.
    let surviving_notional = notional - amount; // amount <= notional (checked above)
    let remaining = margin_required(surviving_notional, initial_margin_bps)
        .ok_or(LiquidateError::Overflow)?
        .min(position_collateral);
    // Collateral actually freed by the liquidation.
    let released = position_collateral.saturating_sub(remaining);
    // Liquidator reward = penalty share of the freed collateral.
    // `liquidation_penalty` guarantees `reward <= released`, so
    // `remaining + reward <= remaining + released == position_collateral`.
    let reward = liquidation_penalty(released, penalty_bps).ok_or(LiquidateError::Overflow)?;
    Ok((remaining, reward))
}

#[cfg(test)]
mod tests {
    use super::*;

    use proptest::prelude::*;

    // --- REQ-A2-1: account-level health / margin (RED on the stubs) ---

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        // ACCOUNT-HEALTH-IS-EQUITY-VS-TOTAL-MAINTENANCE: `account_liquidatable`
        // equals `(deposited + Σ upnl < Σ_side m(n_side, mm))`, strict, with the
        // zero-exposure short-circuit (`n_long == n_short == 0 ⇒ false`) and
        // totality on the whole domain (full u64/i128/u16, hostile extremes).
        // The expectation is computed INLINE (the PRD formula), never through
        // the functions under test.
        #[test]
        fn account_health_is_equity_vs_total_maintenance(
            deposited in any::<u64>(),
            pnl_sum in any::<i128>(),
            n_long in any::<u64>(),
            n_short in any::<u64>(),
            maintenance_bps in any::<u16>(),
        ) {
            // The per-side ceiling, inline: ceil(n × bps / 10_000) in u128
            // (total on the whole domain).
            let side_req = |n: u64| -> u128 {
                ((n as u128) * (maintenance_bps as u128)).div_ceil(10_000)
            };
            let expected = match u64::try_from(side_req(n_long) + side_req(n_short)) {
                // The checked requirement sum overflows u64 -> None.
                Err(_) => None,
                Ok(total) => Some(if n_long == 0 && n_short == 0 {
                    // No exposure => never liquidatable (the short-circuit).
                    false
                } else {
                    // equity = deposited + Σ upnl, saturating at the i128 extremes.
                    (deposited as i128).saturating_add(pnl_sum) < (total as i128)
                }),
            };
            prop_assert_eq!(
                account_liquidatable(deposited, pnl_sum, n_long, n_short, maintenance_bps),
                expected,
                "account_liquidatable(deposited={}, pnl_sum={}, n_long={}, n_short={}, mm={}) \
                 must be the strict account formula: zero exposure => false, else \
                 deposited + pnl_sum < Σ m(n_i, mm)",
                deposited,
                pnl_sum,
                n_long,
                n_short,
                maintenance_bps
            );
        }

        // ACCOUNT-MARGIN-SUMS-BOTH-SIDES: the checked sum of both sides' ceilings
        // (no netting — a long and a short both require margin), plus monotonic
        // non-decreasing in EACH side's notional with the other side fixed.
        #[test]
        fn account_margin_sums_both_sides(
            n_long in any::<u64>(),
            n_short in any::<u64>(),
            bps in any::<u16>(),
            delta_long in 0u64..=1_000_000_000_000,
            delta_short in 0u64..=1_000_000_000_000,
        ) {
            // Inline ground truth: the checked sum of two per-side ceilings.
            let side_req = |n: u64| -> u128 {
                ((n as u128) * (bps as u128)).div_ceil(10_000)
            };
            let expected = u64::try_from(side_req(n_long) + side_req(n_short)).ok();
            prop_assert_eq!(
                account_margin_required(n_long, n_short, bps),
                expected,
                "account_margin_required(n_long={}, n_short={}, bps={}) must be the \
                 checked sum of both sides' ceilings",
                n_long,
                n_short,
                bps
            );

            // Monotonic in the long notional (short fixed): the requirement can
            // never fall as a side's notional grows; an overflow at the smaller
            // notional but not at the larger one is impossible.
            let long_hi = n_long.saturating_add(delta_long);
            let req_long_lo = account_margin_required(n_long, n_short, bps);
            let req_long_hi = account_margin_required(long_hi, n_short, bps);
            match (req_long_lo, req_long_hi) {
                (Some(lo), Some(hi)) => prop_assert!(
                    hi >= lo,
                    "account_margin_required must be non-decreasing in the long \
                     notional ({} -> {})",
                    n_long,
                    long_hi
                ),
                (_, None) => {}
                (None, Some(_)) => prop_assert!(
                    false,
                    "requirement overflowed at a smaller long notional than a \
                     non-overflowed one ({} -> {})",
                    n_long,
                    long_hi
                ),
            }

            // Monotonic in the short notional (long fixed).
            let short_hi = n_short.saturating_add(delta_short);
            let req_short_lo = account_margin_required(n_long, n_short, bps);
            let req_short_hi = account_margin_required(n_long, short_hi, bps);
            match (req_short_lo, req_short_hi) {
                (Some(lo), Some(hi)) => prop_assert!(
                    hi >= lo,
                    "account_margin_required must be non-decreasing in the short \
                     notional ({} -> {})",
                    n_short,
                    short_hi
                ),
                (_, None) => {}
                (None, Some(_)) => prop_assert!(
                    false,
                    "requirement overflowed at a smaller short notional than a \
                     non-overflowed one ({} -> {})",
                    n_short,
                    short_hi
                ),
            }
        }

        // ACCOUNT-LOSS-BOOKED-IS-MAX-ZERO-NEGATIVE-PNL: the booked account loss
        // is `max(0, −Σ upnl)`, u64-saturated — the negative-sum convention,
        // independent of the caller's seam clamp.
        #[test]
        fn account_loss_booked_is_max_zero_negative_pnl(pnl_sum in any::<i128>()) {
            // Inline ground truth: |pnl_sum| when negative (saturated at
            // u64::MAX), else 0.
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

    /// REQ-A2-1/D8 deterministic witness: `<` is STRICT at the measure-zero
    /// `equity == requirement` point — a random sweep cannot hit it, so pin the
    /// boundary with hand-computed literals (a `<` → `<=` mutant must fail here).
    ///
    /// Arithmetic (`n_long = 333, n_short = 0, maintenance_bps = 3_000`):
    ///   `requirement = ceil(333 × 3_000 / 10_000) = ceil(99.9) = 100`
    ///   * `deposited = 100, pnl_sum = 0` ⇒ `equity = 100 == requirement` ⇒ healthy
    ///   * `deposited =  99, pnl_sum = 0` ⇒ `equity =  99 = requirement - 1` ⇒ liquidatable
    ///   * `n_long = n_short = 0` ⇒ never liquidatable (short-circuit), any equity
    ///
    /// Two-sided sum: `n_long = n_short = 1, bps = 10_000` ⇒ `ceil(1/10_000) + ceil(1/10_000) = 2`;
    /// `deposited = 2` healthy, `deposited = 1` liquidatable.
    #[test]
    fn account_health_strict_equality_boundary_is_healthy() {
        // ceil(333 × 3_000 / 10_000) = ceil(99.9) = 100 (inexact product).
        assert_eq!(account_margin_required(333, 0, 3_000), Some(100));
        // equity EXACTLY == the total maintenance requirement is HEALTHY: the
        // predicate is `equity < required`, never `<=`.
        assert_eq!(
            account_liquidatable(100, 0, 333, 0, 3_000),
            Some(false),
            "equity == total maintenance must be healthy (strict `<`)"
        );
        // One microunit below the requirement is liquidatable.
        assert_eq!(
            account_liquidatable(99, 0, 333, 0, 3_000),
            Some(true),
            "equity == requirement - 1 must be liquidatable"
        );
        // Zero exposure is never liquidatable, even at negative equity.
        assert_eq!(account_liquidatable(0, 0, 0, 0, 3_000), Some(false));
        assert_eq!(
            account_liquidatable(0, -1_000_000, 0, 0, 3_000),
            Some(false)
        );
        // Two-sided equality across the SUMMED requirement: ceil(1/10_000) = 1
        // per side ⇒ required = 2; equity == 2 is healthy, equity == 1 is not.
        assert_eq!(account_margin_required(1, 1, 10_000), Some(2));
        assert_eq!(account_liquidatable(2, 0, 1, 1, 10_000), Some(false));
        assert_eq!(account_liquidatable(1, 0, 1, 1, 10_000), Some(true));
    }

    // --- R-L3: penalty bounds + monotonicity (`liquidation_penalty` kept) ---

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn penalty_is_zero_at_bps_zero(collateral in 0u64..1_000_000_000_000) {
            prop_assert_eq!(liquidation_penalty(collateral, 0), Some(0));
            prop_assert_eq!(liquidation_penalty(0, 10_000), Some(0));
        }

        #[test]
        fn penalty_never_exceeds_collateral(
            collateral in 0u64..1_000_000_000_000,
            penalty_bps in 0u16..=10_000,
        ) {
            let p = liquidation_penalty(collateral, penalty_bps).unwrap();
            prop_assert!(p <= collateral, "penalty bounded by collateral");
        }

        #[test]
        fn penalty_is_full_at_bps_10000(collateral in 0u64..1_000_000_000_000) {
            prop_assert_eq!(liquidation_penalty(collateral, 10_000), Some(collateral));
        }

        #[test]
        fn penalty_monotonic_in_bps(
            collateral in 1u64..1_000_000_000_000,
            bps_low in 0u16..10_000,
        ) {
            let bps_high = bps_low + 1;
            let lo = liquidation_penalty(collateral, bps_low).unwrap();
            let hi = liquidation_penalty(collateral, bps_high).unwrap();
            prop_assert!(hi >= lo, "penalty non-decreasing in bps");
        }
    }

    // --- R-L3: full / partial liquidation transitions (release math kept) ---

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn full_liquidation_zeroes_exposure(
            notional in 1u64..1_000_000_000_000,
            initial_margin_bps in 1u16..=10_000,
            penalty_bps in 1u16..=10_000,
        ) {
            // A real position is backed at the INITIAL margin ratio (state.rs).
            let position_collateral = margin_required(notional, initial_margin_bps).unwrap();
            let (remaining, reward) = apply_liquidation(
                position_collateral,
                notional,
                notional,
                initial_margin_bps,
                penalty_bps,
            )
            .unwrap();
            // Full liquidation closes the position (notional -> 0): its surviving
            // collateral must be margin_required(0, _) == 0 (all collateral released).
            prop_assert_eq!(remaining, margin_required(0, initial_margin_bps).unwrap());
            prop_assert_eq!(remaining, 0);
            let released = position_collateral - remaining;
            prop_assert_eq!(reward, liquidation_penalty(released, penalty_bps).unwrap());
            prop_assert!(remaining + reward <= position_collateral, "no value created");
        }

        #[test]
        fn partial_liquidation_consumes_only_the_backed_portion(
            notional in 2u64..1_000_000_000_000,
            amount in 1u64..=1_000_000_000_000u64,
            initial_margin_bps in 1u16..=10_000,
            penalty_bps in 1u16..=10_000,
        ) {
            let amount = if amount > notional { notional } else { amount };
            let position_collateral = margin_required(notional, initial_margin_bps).unwrap();
            let (remaining, reward) = apply_liquidation(
                position_collateral,
                notional,
                amount,
                initial_margin_bps,
                penalty_bps,
            )
            .unwrap();
            // The surviving collateral equals margin_required(notional - amount,
            // initial_margin_bps) — the documented invariant (like apply_close_fills).
            prop_assert_eq!(
                remaining,
                margin_required(notional - amount, initial_margin_bps).unwrap()
            );
            let released = position_collateral - remaining;
            prop_assert_eq!(reward, liquidation_penalty(released, penalty_bps).unwrap());
            prop_assert!(remaining + reward <= position_collateral, "no value created");
        }

        #[test]
        fn invalid_amounts_rejected(
            notional in 1u64..1_000_000_000_000,
            initial_margin_bps in 1u16..=10_000,
            penalty_bps in 1u16..=10_000,
        ) {
            let position_collateral = margin_required(notional, initial_margin_bps).unwrap();
            prop_assert_eq!(
                apply_liquidation(position_collateral, notional, 0, initial_margin_bps, penalty_bps),
                Err(LiquidateError::InvalidAmount)
            );
            let too_big = notional.saturating_add(1);
            prop_assert_eq!(
                apply_liquidation(position_collateral, notional, too_big, initial_margin_bps, penalty_bps),
                Err(LiquidateError::InvalidAmount)
            );
        }
    }

    #[test]
    fn penalty_and_collateral_bounds_pinned() {
        // Ceiling division pins.
        assert_eq!(liquidation_penalty(1_000, 500).unwrap(), 50); // 5% of 1000
        assert_eq!(liquidation_penalty(1, 500).unwrap(), 1); // ceil(0.05) = 1
        assert_eq!(liquidation_penalty(0, 500).unwrap(), 0);
        // Boundary: the maximal penalty (max bps on the max collateral) is the
        // whole collateral, and the ceiling arithmetic never overflows past it.
        assert_eq!(liquidation_penalty(u64::MAX, 10_000).unwrap(), u64::MAX);
    }

    #[test]
    fn liquidation_leaves_no_insolvency() {
        // A full liquidation must never leave a negative remaining collateral,
        // and must not create value out of thin air.
        let notional = 1_000_000u64;
        let initial_bps = 2_000u16; // 20% initial margin
        let position_collateral = margin_required(notional, initial_bps).unwrap();
        for penalty_bps in [1u16, 500, 10_000] {
            let (remaining, reward) = apply_liquidation(
                position_collateral,
                notional,
                notional,
                initial_bps,
                penalty_bps,
            )
            .unwrap();
            // Full liquidation closes the position: surviving collateral == 0.
            assert_eq!(remaining, 0);
            // Holder total (remaining) + liquidator reward <= position collateral.
            assert!(remaining + reward <= position_collateral);
        }
    }

    // ==== Adversarial-review invariants for the liquidation transition ====
    // These independently pin the kept release/penalty contract
    // (`liquidation_penalty`, `apply_liquidation`) across the FULL domain, so
    // the implementation's own in-file tests (which share its assumptions)
    // cannot mask a counterexample.

    // Domain band constant (from the design doc): notional is a USDC amount
    // (microunits) far below u64::MAX.
    const NOTIONAL_MAX: u64 = 1_000_000_000_000; // 1e12 (design band)

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // R-L3 penalty exactness: `ceil(collateral*bps/10000)` for a wide band.
        #[test]
        fn liquidation_penalty_exact_ceiling_formula(
            collateral in any::<u64>(),
            penalty_bps in 0u16..=10_000,
        ) {
            let exact = (collateral as u128)
                .checked_mul(penalty_bps as u128)
                .unwrap()
                .checked_add(9_999)
                .unwrap();
            let expected = (exact / 10_000) as u64;
            prop_assert_eq!(liquidation_penalty(collateral, penalty_bps), Some(expected),
                "penalty must be ceil(collateral*bps/10000)");
        }

        #[test]
        fn liquidation_penalty_bounds_and_extremes(
            collateral in any::<u64>(),
            penalty_bps in 0u16..=10_000,
        ) {
            let p = liquidation_penalty(collateral, penalty_bps).unwrap();
            prop_assert!(p <= collateral, "penalty bounded by collateral");
            if penalty_bps == 0 { prop_assert_eq!(p, 0, "0 bps => 0 penalty"); }
            if penalty_bps == 10_000 { prop_assert_eq!(p, collateral, "10_000 bps => full collateral"); }
        }

        #[test]
        fn liquidation_penalty_monotonic_full_collateral(
            collateral in any::<u64>(),
            bps_low in 0u16..10_000,
        ) {
            let bps_high = bps_low + 1;
            let lo = liquidation_penalty(collateral, bps_low).unwrap();
            let hi = liquidation_penalty(collateral, bps_high).unwrap();
            prop_assert!(hi >= lo, "penalty non-decreasing in bps");
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // R-L3/R-L4 apply_liquidation: never negative remaining, no value created,
        // invalid amounts rejected, and a FULL liquidation empties the notional.
        #[test]
        fn apply_liquidation_preserves_collateral(
            position_collateral in any::<u64>(),
            notional in 1u64..NOTIONAL_MAX,
            amount in 1u64..NOTIONAL_MAX,
            initial_margin_bps in 1u16..=10_000,
            penalty_bps in 0u16..=10_000,
        ) {
            let amount = if amount > notional { notional } else { amount };
            let (remaining, reward) =
                apply_liquidation(position_collateral, notional, amount, initial_margin_bps, penalty_bps).unwrap();
            prop_assert!(remaining <= position_collateral, "remaining <= position collateral");
            prop_assert!(reward <= position_collateral, "reward <= position collateral");
            prop_assert!(remaining + reward <= position_collateral,
                "no value created: remaining + reward <= position collateral");
        }

        #[test]
        fn apply_liquidation_invalid_amount_rejected(
            position_collateral in any::<u64>(),
            notional in any::<u64>(),
            initial_margin_bps in any::<u16>(),
            penalty_bps in any::<u16>(),
        ) {
            // amount == 0 => InvalidAmount regardless of everything else.
            prop_assert_eq!(
                apply_liquidation(position_collateral, notional, 0, initial_margin_bps, penalty_bps),
                Err(LiquidateError::InvalidAmount)
            );
            // amount > notional => InvalidAmount.
            let too_big = notional.saturating_add(1).max(1);
            prop_assert_eq!(
                apply_liquidation(position_collateral, notional, too_big, initial_margin_bps, penalty_bps),
                Err(LiquidateError::InvalidAmount)
            );
        }

        #[test]
        fn apply_liquidation_full_releases_all_collateral(
            notional in 1u64..NOTIONAL_MAX,
            initial_margin_bps in 1u16..=10_000,
            penalty_bps in 0u16..=10_000,
        ) {
            // A real position is backed at the INITIAL margin ratio (state.rs
            // invariant). A FULL liquidation (`amount == notional`) closes the
            // position (notional -> 0), so its surviving collateral must be
            // margin_required(0, _) == 0 — all collateral released, never leaving a
            // negative remaining.
            let position_collateral = margin_required(notional, initial_margin_bps).unwrap();
            let (remaining, reward) = apply_liquidation(
                position_collateral,
                notional,
                notional,
                initial_margin_bps,
                penalty_bps,
            )
            .unwrap();
            prop_assert_eq!(remaining, margin_required(0, initial_margin_bps).unwrap());
            prop_assert_eq!(remaining, 0, "full liquidation never leaves negative remaining");
            prop_assert!(remaining + reward <= position_collateral, "no value created");
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // The `liquidate` handler's zero-sum transition: releases `consumed` from
        // the victim's `reserved`, debits the victim's `deposited` by `reward`,
        // credits the liquidator's `deposited` by the same `reward`. For every
        // reachable (notional, amount, im, penalty) with the position backed at
        // the INITIAL margin ratio, the reward is drawn strictly out of the
        // victim's released margin, so Σ(victim + liquidator) deposited is
        // conserved and the victim's ledger never underflows.
        #[test]
        fn liquidation_transition_conserves_and_never_underflows(
            notional in 1u64..NOTIONAL_MAX,
            amount in 1u64..NOTIONAL_MAX,
            im in 1u16..=10_000,
            penalty in 0u16..=10_000,
            free_balance in 0u64..1_000_000_000_000u64,
            liquidator_deposited in any::<u64>(),
        ) {
            let amount = if amount > notional { notional } else { amount };
            // A real position is backed at the INITIAL margin ratio (state.rs).
            let position_collateral = margin_required(notional, im).unwrap();
            let (remaining, reward) =
                apply_liquidation(position_collateral, notional, amount, im, penalty).unwrap();

            let consumed = position_collateral - remaining; // released collateral
            let reserved_before = position_collateral; // single-position victim ledger

            // A valid ledger: deposited = reserved + free (free >= 0), so reserved
            // never exceeds deposited. Both operands are bounded (<= ~2e12 < u64::MAX).
            let victim_deposited = reserved_before.checked_add(free_balance).unwrap();
            let victim_after = victim_deposited - reward; // handler uses checked_sub
            let reserved_after = reserved_before - consumed;
            // The handler credits the liquidator via `checked_add`; a reward that
            // overflows `u64` reverts the transaction (safe: no value is created),
            // so model exactly the handler's accepted path.
            let Some(liquidator_after) = liquidator_deposited.checked_add(reward) else {
                return Ok(());
            };

            prop_assert!(reward <= consumed, "reward drawn from the victim's released margin");
            prop_assert!(victim_after >= reserved_after, "free seam holds after liquidation");
            // Zero-sum: nothing minted, nothing burned (in u128 so the sum cannot
            // overflow the ledger-position invariant).
            prop_assert_eq!(
                (victim_deposited as u128) + (liquidator_deposited as u128),
                (victim_after as u128) + (liquidator_after as u128),
                "a liquidation is a zero-sum transfer across victim + liquidator"
            );
            // The surviving position keeps exactly margin_required(notional-amount, im).
            prop_assert_eq!(remaining, margin_required(notional - amount, im).unwrap());
        }
    }

    /// Regression (critical): a liquidation must be a ZERO-SUM transfer. The
    /// handler credits `liquidator_collateral.deposited += reward` and debits
    /// `user_collateral.deposited -= reward`; that debit is payable only because
    /// `apply_liquidation` guarantees `reward <= released == position_collateral -
    /// remaining` (the reward is drawn out of the victim's released margin, so
    /// Σ deposited across victim + liquidator is conserved; the vault is never
    /// over-issued). Pin the EXACT minimal counterexample the review shrank:
    /// `(notional=2, amount=2 [full], im=2, penalty_bps=500)`.
    #[test]
    fn liquidation_is_zero_sum_deterministic() {
        // position_collateral = margin_required(2, initial_margin_bps=2) = ceil(4/1e4) = 1
        let position_collateral = margin_required(2, 2).unwrap();
        assert_eq!(position_collateral, 1);
        // Full liquidation: remaining = margin_required(0, 2) = 0; released = 1;
        // reward = ceil(1 * 500 / 1e4) = 1.
        let (remaining, reward) = apply_liquidation(position_collateral, 2, 2, 2, 500).unwrap();
        assert_eq!((remaining, reward), (0, 1), "shrank minimal counterexample");
        // The zero-sum guarantee the handler relies on (the operands are `u64`, so
        // non-negativity is type-guaranteed):
        assert!(
            remaining + reward <= position_collateral,
            "no value created: remaining + reward <= position_collateral"
        );
        let released = position_collateral.saturating_sub(remaining);
        assert!(
            reward <= released,
            "reward payable out of the victim's released margin (so victim.deposited -= reward is safe)"
        );
        // Model the handler's ledger transition; Σ deposited must be conserved.
        let (victim_before, liquidator_before) = (10_000u64, 0u64);
        let (victim_after, liquidator_after) = (
            victim_before.checked_sub(reward).unwrap(),
            liquidator_before.checked_add(reward).unwrap(),
        );
        assert_eq!(
            victim_after + liquidator_after,
            victim_before + liquidator_before,
            "liquidation mints nothing: Σ deposited is conserved"
        );
        // Deterministic sweep — fixed seeds, all must conserve.
        for (notional, amount, im) in [(3u64, 2u64, 1_000u16), (7, 5, 2_000)] {
            let pc = margin_required(notional, im).unwrap();
            let (rem, rew) = apply_liquidation(pc, notional, amount, im, 500).unwrap();
            assert!(rem + rew <= pc, "no value created");
            assert!(
                rew <= pc.saturating_sub(rem),
                "reward payable from released margin"
            );
        }
    }
}
