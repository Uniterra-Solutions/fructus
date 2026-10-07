//! Pure collateral-vault accounting: the free-collateral predicate and the
//! deposit/withdraw ledger transitions.
//!
//! This module is deliberately free of Anchor account plumbing (mirroring the
//! `exchange.rs` split): every function takes and returns plain `u64` values so
//! `proptest` can exercise the invariants directly, and the thin
//! `deposit_collateral` / `withdraw_collateral` adapters in `lib.rs` apply them
//! to the on-chain `UserCollateral` ledger.
//!
//! All arithmetic is `checked_*` — there is no panicking math, and no new
//! dependency is introduced. Amounts are USDC microunits (6 decimals).

/// The free-collateral predicate: `deposited - reserved`, the seam the position
/// lifecycle will later use to keep collateral backing open margin from being
/// withdrawn.
///
/// Returns `Some(free)` when `deposited >= reserved`, and `None` when
/// `reserved > deposited` — a ledger invariant violation (the three quantities
/// `deposited`, `reserved`, and `free` are never negative).
///
/// Because `reserved` is stubbed to `0` this iteration, this reduces to
/// `deposited`, which is exactly the `reserved == 0 => free_collateral ==
/// deposited` invariant.
pub fn free_collateral(deposited: u64, reserved: u64) -> Option<u64> {
    deposited.checked_sub(reserved)
}

/// Deposit transition: `deposited + amount`.
///
/// Returns `Some(new_deposited)` on success and `None` on `u64` overflow (the
/// caller maps this to the checked-arithmetic overflow error).
pub fn deposit(deposited: u64, amount: u64) -> Option<u64> {
    deposited.checked_add(amount)
}

/// Withdraw transition: `deposited - amount`, guarded by the free-collateral
/// seam and the account-level equity gate.
///
/// The full v2 contract (REQ-A2-3): succeeds **only** when
/// `amount <= free_collateral(deposited, reserved)` AND
/// `equity - amount >= reserved`, where `equity = deposited as i128 + pnl_sum`
/// — the post-withdraw equity must stay at or above the reserved
/// (initial-margin) requirement. On any refusal (`amount` past the free seam,
/// a `reserved > deposited` invariant violation, or the equity gate) it returns
/// `None` and the caller leaves the ledger untouched. `amount == free` is
/// allowed when the equity gate permits it; on success it returns
/// `Some(deposited - amount)`.
///
/// STUB: the `pnl_sum` equity gate is not applied yet — the body keeps the
/// old ledger-only seam semantics until the cross-margin task lands; the red
/// `withdraw_blocked_below_initial_margin` property test below pins the full
/// contract.
pub fn withdraw(deposited: u64, reserved: u64, pnl_sum: i128, amount: u64) -> Option<u64> {
    // STUB: `pnl_sum` (the signed Σ unrealized-PnL over both sides) is
    // deliberately ignored — the equity gate `equity - amount >= reserved`
    // arrives with the cross-margin margin model (REQ-A2-3).
    let _ = pnl_sum;
    let free = free_collateral(deposited, reserved)?;
    if amount > free {
        return None;
    }
    deposited.checked_sub(amount)
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    // ==== Adversarial-review invariants for collateral.rs (moved from review_tests.rs) ====
    // These pin the vault ledger transitions (free seam / deposit / withdraw)
    // across the FULL `u64` domain, so the vault can never let a user draw more
    // than the free seam nor mint/annihilate the ledger on a round trip.

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        // V-1: free_collateral is exactly `deposited - reserved`, and is `None`
        // (never a negative free) exactly when `reserved > deposited`.
        #[test]
        fn collateral_free_seam_is_exact_full_domain(
            deposited in any::<u64>(),
            reserved in any::<u64>(),
        ) {
            prop_assert_eq!(
                crate::collateral::free_collateral(deposited, reserved),
                deposited.checked_sub(reserved),
                "free == deposited - reserved (None iff reserved > deposited)"
            );
        }

        // V-2: deposit is exactly `deposited + amount` (None on u64 overflow) and is
        // monotonic — a strict increase for any nonzero amount.
        #[test]
        fn collateral_deposit_is_checked_add_full_domain(
            deposited in any::<u64>(),
            amount in any::<u64>(),
        ) {
            prop_assert_eq!(
                crate::collateral::deposit(deposited, amount),
                deposited.checked_add(amount),
                "deposit must be deposited + amount (checked)"
            );
            if amount > 0 && deposited.checked_add(amount).is_some() {
                prop_assert!(
                    crate::collateral::deposit(deposited, amount).unwrap() > deposited,
                    "a nonzero deposit strictly increases deposited"
                );
            }
        }

        // V-3: withdraw succeeds iff `amount <= free`, and the post-withdraw
        // `deposited` is exactly `deposited - amount`.
        #[test]
        fn collateral_withdraw_respects_free_seam_full_domain(
            deposited in any::<u64>(),
            reserved in any::<u64>(),
            amount in any::<u64>(),
        ) {
            let free = deposited.checked_sub(reserved);
            // pnl_sum = 0: at zero PnL the equity gate reduces to the free seam.
            let w = crate::collateral::withdraw(deposited, reserved, 0, amount);
            match free {
                Some(f) if amount <= f => {
                    prop_assert_eq!(
                        w,
                        Some(deposited - amount),
                        "withdraw inside free succeeds and returns deposited - amount"
                    );
                }
                _ => {
                    prop_assert_eq!(
                        w,
                        None,
                        "withdraw at/beyond the free seam (or reserved > deposited) must fail"
                    );
                }
            }
        }

        // V-4 (non-conservation guard): a successful withdraw leaves the ledger
        // still respecting the free seam and never increases `deposited`.
        #[test]
        fn collateral_withdraw_never_breaches_free_or_increases(
            deposited in any::<u64>(),
            reserved in any::<u64>(),
            amount in any::<u64>(),
        ) {
            if let Some(new_deposited) = crate::collateral::withdraw(deposited, reserved, 0, amount) {
                prop_assert!(new_deposited >= reserved, "post-withdraw deposited >= reserved");
                prop_assert!(new_deposited <= deposited, "withdraw never increases deposited");
            }
        }

        // V-5 (conservation): deposit(x) then withdraw the same x (reserved == 0)
        // returns exactly to the original — the vault neither mints nor burns.
        #[test]
        fn collateral_deposit_withdraw_round_trip_conserves(
            deposited in any::<u64>(),
            amount in any::<u64>(),
        ) {
            if let Some(up) = crate::collateral::deposit(deposited, amount) {
                if let Some(down) = crate::collateral::withdraw(up, 0, 0, amount) {
                    prop_assert_eq!(
                        down,
                        deposited,
                        "deposit then withdraw the same amount is the identity"
                    );
                }
            }
        }

        // V-6: the free seam is monotonic in the reserved amount — reserving more
        // can never free up collateral.
        #[test]
        fn collateral_free_seam_monotonic_in_reserved(
            deposited in any::<u64>(),
            r_lo in any::<u64>(),
            r_hi in any::<u64>(),
        ) {
            let (lo, hi) = if r_lo <= r_hi { (r_lo, r_hi) } else { (r_hi, r_lo) };
            let f_lo = crate::collateral::free_collateral(deposited, lo);
            let f_hi = crate::collateral::free_collateral(deposited, hi);
            if let (Some(a), Some(b)) = (f_lo, f_hi) {
                prop_assert!(a >= b, "free is non-increasing in reserved");
            }
        }

        // REQ-A2-3 / WITHDRAW-BLOCKED-BELOW-INITIAL-MARGIN: on top of the
        // ledger-only free seam, a withdrawal must keep the post-withdraw
        // equity (`deposited + pnl_sum - amount`) at or above `reserved` (the
        // initial-margin requirement); otherwise it is refused and the ledger
        // is untouched. The `pnl_sum < 0` cases are exactly where this diverges
        // from the old two-arg seam gate.
        #[test]
        fn withdraw_blocked_below_initial_margin(
            deposited in any::<u64>(),
            reserved in any::<u64>(),
            pnl_sum in any::<i128>(),
            amount in any::<u64>(),
        ) {
            // Spec expectation: the free seam first, then the equity gate.
            // `deposited - amount` is exact in the accepting branch
            // (`amount <= free <= deposited`).
            let expected = deposited.checked_sub(reserved).and_then(|free| {
                if amount > free {
                    return None;
                }
                // Saturating only at magnitudes the comparison already decides
                // (the repo forbids panicking math; the exact i128 sum can
                // overflow only for `pnl_sum` within `u64::MAX` of `i128::MAX`,
                // far above every value the gate can turn on).
                let post_equity = (deposited as i128)
                    .saturating_add(pnl_sum)
                    .saturating_sub(amount as i128);
                if post_equity < reserved as i128 {
                    return None;
                }
                Some(deposited - amount)
            });
            prop_assert_eq!(
                crate::collateral::withdraw(deposited, reserved, pnl_sum, amount),
                expected,
                "withdraw must block when the post-withdraw equity \
                 (deposited + pnl_sum - amount) falls below reserved \
                 (deposited={}, reserved={}, pnl_sum={}, amount={})",
                deposited,
                reserved,
                pnl_sum,
                amount
            );
        }
    }
}
