//! Independent adversarial review of the ACCOUNT-LEVEL liquidation **ledger**
//! transition (product-v2 A2, REQ-A2-2 / proposition
//! `LIQUIDATION-CONSERVES-ACCOUNT-VALUE`; supersedes the per-position suite).
//!
//! The account model (D6/D8): the victim holds a two-side account
//! (`n_target` + `n_other`, every side backed at the initial margin ratio
//! `m(n_i, im)` — the state.rs invariant, with `reserved == Σ_side m(n_i, im)`)
//! plus a signed Σ unrealized PnL (`pnl_sum`). A liquidation of `amount` on the
//! **targeted** side runs, in the handler:
//!
//! ```text
//! (remaining, reward) = apply_liquidation(m(n, im), n, amount, im, penalty)
//! released             = m(n, im) - remaining            // freed margin
//! reserved_after       = Σ m(n_i, im) - released         // == Σ m(n_i', im)
//!
//! loss                 = account_liquidation_loss(pnl_sum)   // max(0, -Σ upnl)
//! booked               = apply_liquidation_loss(deposited, reserved_after, loss, reward)
//! market.pnl_pool                     += booked          // loss collected
//! victim.user_collateral.deposited    -= booked          // loss realized
//! victim.user_collateral.deposited    -= reward          // penalty out
//! liquidator_collateral.deposited     += reward          // penalty in
//! ```
//!
//! The invariant: `booked == min(max(0, −Σ upnl), deposited − reserved_after −
//! reward)` (the account-loss value then the seam clamp), and
//! Σ(victim.deposited + liquidator.deposited + pool) is unchanged — a
//! liquidation transfers value, it never mints it — while
//! `reserved == Σ_side m(n_i, im)` still holds afterwards.
//!
//! RED on the stubs: `account_liquidation_loss` returns `0` for a negative
//! `pnl_sum`, so `booked` (0) cannot equal the inline expectation
//! `min(max(0, −pnl_sum), seam)` (the loss is silently dropped instead of being
//! collected into the pool).

use fructus::liquidation::{account_liquidation_loss, apply_liquidation};
use fructus::positions::margin_required;
use fructus::settlement::apply_liquidation_loss;
use proptest::prelude::*;

const PENALTY_BPS: u16 = 500; // LIQUIDATION_PENALTY_BPS

/// The inline account-loss ground truth: `max(0, −pnl_sum)`, u64-saturated —
/// the convention `account_liquidation_loss` must implement.
fn expected_account_loss(pnl_sum: i128) -> u64 {
    if pnl_sum < 0 {
        pnl_sum.unsigned_abs().min(u64::MAX as u128) as u64
    } else {
        0
    }
}

/// Faithful reproduction of the account-level `liquidate` ledger transition:
/// the two-side account backed at the initial margin ratio, the targeted-side
/// release via `apply_liquidation`, the account-loss booking via
/// `account_liquidation_loss` + `apply_liquidation_loss`, and the zero-sum
/// reward transfer.
struct AccountTransition {
    deposited: u64,
    liquidator_deposited: u64,
    victim_after: u64,
    liquidator_after: u64,
    pool_after: u64,
    reward: u64,
    booked: u64,
    reserved_after: u64,
    /// `min(max(0, −pnl_sum), deposited − reserved_after − reward)` — computed
    /// INLINE (never through the function under test).
    expected_booked: u64,
}

#[allow(clippy::too_many_arguments)]
fn account_transition(
    n_target: u64,
    n_other: u64,
    amount: u64,
    im: u16,
    free: u64,
    liquidator_deposited: u64,
    pnl_sum: i128,
) -> Option<AccountTransition> {
    // A real account is backed at the INITIAL margin ratio (state.rs).
    let targeted_collateral = margin_required(n_target, im)?;
    let reserved_before =
        margin_required(n_target, im)?.checked_add(margin_required(n_other, im)?)?;
    // A valid ledger: deposited = reserved + free (free >= 0), so reserved
    // never exceeds deposited (the free-seam invariant).
    let deposited = reserved_before.checked_add(free)?;

    let (remaining, reward) =
        apply_liquidation(targeted_collateral, n_target, amount, im, PENALTY_BPS).ok()?;
    let released = targeted_collateral.saturating_sub(remaining);
    let reserved_after = reserved_before.checked_sub(released)?;

    // The account-loss value under test, then the handler's seam clamp.
    let loss = account_liquidation_loss(pnl_sum);
    let (victim_after_loss, booked) =
        apply_liquidation_loss(deposited, reserved_after, loss, reward)?;
    // The reward stays a zero-sum transfer out of the victim's released margin;
    // the liquidator's credit can overflow u64 (the handler reverts, so this
    // case is not an accepted path and is skipped).
    let victim_after = victim_after_loss.checked_sub(reward)?;
    let liquidator_after = liquidator_deposited.checked_add(reward)?;
    let pool_after = booked; // market.pnl_pool += booked (starting pool == 0)

    // The independent expectation: the account loss (inline) clamped by the
    // same seam the handler uses.
    let seam = deposited.checked_sub(reserved_after)?.checked_sub(reward)?;
    let expected_booked = expected_account_loss(pnl_sum).min(seam);

    Some(AccountTransition {
        deposited,
        liquidator_deposited,
        victim_after,
        liquidator_after,
        pool_after,
        reward,
        booked,
        reserved_after,
        expected_booked,
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn liquidation_conserves_account_value(
        n_target in 1u64..1_000_000_000_000u64,
        n_other in 0u64..1_000_000_000_000u64,
        amount_unclamped in 1u64..1_000_000_000_000u64,
        im in 2u16..=10_000u16,
        free in 0u64..1_000_000_000_000u64,
        liquidator_deposited in any::<u64>(),
        pnl_sum in any::<i128>(),
    ) {
        let amount = amount_unclamped.min(n_target);
        let Some(t) = account_transition(
            n_target,
            n_other,
            amount,
            im,
            free,
            liquidator_deposited,
            pnl_sum,
        ) else {
            return Ok(());
        };

        // The booked account loss is min(max(0, -pnl_sum), seam).
        prop_assert_eq!(
            t.booked,
            t.expected_booked,
            "booked {} != min(max(0, -{}), deposited - reserved_after - reward) {} \
             — the account loss must be collected into the pool, seam-permitting",
            t.booked,
            pnl_sum,
            t.expected_booked
        );

        // Σ(victim + liquidator + pool) is unchanged: a liquidation transfers
        // value, it never mints it (u128 so the sum cannot overflow).
        prop_assert_eq!(
            (t.victim_after as u128) + (t.liquidator_after as u128) + (t.pool_after as u128),
            (t.deposited as u128) + (t.liquidator_deposited as u128),
            "liquidation must not mint collateral: Σ(deposited + pool) is conserved"
        );

        // reserved == Σ_side m(n_i, im) still holds after the liquidation.
        let expected_reserved = margin_required(n_target - amount, im).expect("total")
            + margin_required(n_other, im).expect("total");
        prop_assert_eq!(
            t.reserved_after,
            expected_reserved,
            "reserved after the liquidation must equal Σ m(n_i, im) \
             (targeted {} -> {}, other {})",
            n_target,
            n_target - amount,
            n_other
        );

        // The victim's free seam is never breached by the loss booking + reward.
        prop_assert!(
            t.victim_after >= t.reserved_after,
            "victim's remaining deposited ({}) must still back the surviving reserved ({})",
            t.victim_after,
            t.reserved_after
        );
    }
}

/// Deterministic minimal witness of the account-level conservation model.
#[test]
fn liquidation_conserves_account_value_witness() {
    // n_target = 100, im = 10% (collateral = 10), n_other = 0, amount = 50,
    // penalty = 500: remaining = m(50, 1000) = 5, released = 5, reward = 1.
    // deposited = 10_000, reserved_before = 10, reserved_after = 5,
    // pnl_sum = -6 => the account loss is 6; seam = 10_000 - 5 - 1 = 9_994.
    let (n_target, n_other, amount, im) = (100u64, 0u64, 50u64, 1_000u16);
    let deposited = 10_000u64;
    let free = deposited - margin_required(n_target, im).expect("total");
    let t = account_transition(n_target, n_other, amount, im, free, 0, -6)
        .expect("valid account transition");

    assert_eq!(t.reward, 1, "penalty on the released collateral");
    assert_eq!(
        t.expected_booked, 6,
        "account loss = -pnl_sum when negative"
    );
    assert_eq!(
        t.booked, t.expected_booked,
        "the booked loss must be the account loss, seam-permitting (RED on the stub)"
    );
    assert_eq!(
        t.victim_after,
        deposited - 6 - 1,
        "victim deposited debited by the booked loss AND the reward"
    );
    assert_eq!(t.liquidator_after, 1, "liquidator credited the reward");
    assert_eq!(
        t.pool_after, 6,
        "the booked loss is collected into the pool"
    );
    assert_eq!(
        t.reserved_after, 5,
        "reserved == m(50, 1000) + m(0, 1000) after the liquidation"
    );
    assert_eq!(
        t.victim_after + t.liquidator_after + t.pool_after,
        deposited,
        "Σ(victim + liquidator + pool) is conserved: the liquidation transfers, it never mints"
    );

    // A positive Σ upnl books zero loss (the other side of the convention).
    let t_win = account_transition(n_target, n_other, amount, im, free, 0, 42)
        .expect("valid account transition");
    assert_eq!(t_win.booked, 0, "no loss booked for a non-negative Σ upnl");
    assert_eq!(t_win.pool_after, 0);
}
