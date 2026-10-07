//! Pure operator-delegation authorization predicate (product-v2 A1).
//!
//! This module is deliberately free of Anchor account plumbing (mirroring the
//! `positions.rs` / `collateral.rs` split): the check every `operator_*`
//! handler performs is a pure boolean over plain keys, so `proptest` can
//! exercise the full authorization matrix directly, and the operator adapters
//! in `lib.rs` apply it to the on-chain `Operator` record.
//!
//! All arithmetic-free: no panicking math, no new dependency.

use anchor_lang::prelude::*;

/// Whether `signer` is authorized to act for `(market, user)` under the
/// `Operator` record's fields (REQ-A1-6).
///
/// Authorization holds **iff** all of:
/// * `record_operator == signer` — the signer is the delegated key,
/// * `record_operator != Pubkey::default()` — a revoked record (the field is
///   cleared to `Pubkey::default()` by `set_operator`) authorizes no one, and
///   the all-default tuple of a pristine/missing record fails this too,
/// * `record_market == market` and `record_user == user` — the record is scoped
///   to exactly this `(market, user)` pair.
pub fn authorized(
    signer: &Pubkey,
    record_operator: &Pubkey,
    record_market: &Pubkey,
    record_user: &Pubkey,
    market: &Pubkey,
    user: &Pubkey,
) -> bool {
    record_operator == signer
        && record_operator != &Pubkey::default()
        && record_market == market
        && record_user == user
}

#[cfg(test)]
mod tests {
    use super::authorized;
    use anchor_lang::prelude::*;
    use proptest::prelude::*;

    /// Arbitrary 32-byte keys via `proptest::array::uniform32`, plus the two
    /// boundary shapes the matrix turns on: the all-zero key
    /// (`Pubkey::default()` — the revoke state) and a repeated-byte key. The
    /// boundary branches make those cases actually reachable (a pure uniform
    /// draw hits all-zero with probability 2^-256).
    fn any_pubkey() -> impl Strategy<Value = Pubkey> {
        prop_oneof![
            8 => proptest::array::uniform32(any::<u8>()),
            1 => Just([0u8; 32]),
            1 => any::<u8>().prop_map(|b| [b; 32]),
        ]
        .prop_map(Pubkey::from)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        // REQ-A1-6 / OPERATOR-AUTH-MATRIX: `authorized` holds iff
        // `record_operator == signer != Pubkey::default()` AND
        // `record_market == market` AND `record_user == user` — total over the
        // key domain.
        //
        // Non-vacuity: each record field is drawn either as the ground-truth key
        // it must match (`bind_*`) or as an independent arbitrary key, so all
        // eight bind/not-bind combinations are sampled — the property fails on
        // BOTH a predicate that never authorizes and one that always does. (A
        // generator of six independent uniform keys would never satisfy the
        // equality conjuncts, so the stub's blanket `false` would slip through.)
        #[test]
        fn operator_auth_matrix(
            signer in any_pubkey(),
            market in any_pubkey(),
            user in any_pubkey(),
            raw_record_operator in any_pubkey(),
            raw_record_market in any_pubkey(),
            raw_record_user in any_pubkey(),
            bind_operator in any::<bool>(),
            bind_market in any::<bool>(),
            bind_user in any::<bool>(),
        ) {
            let record_operator = if bind_operator { signer } else { raw_record_operator };
            let record_market = if bind_market { market } else { raw_record_market };
            let record_user = if bind_user { user } else { raw_record_user };

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
                    &user,
                ),
                expected,
                "authorized must be exactly record_operator == signer != default \
                 ∧ record_market == market ∧ record_user == user \
                 (signer={}, record_operator={}, record_market={}, record_user={}, \
                 market={}, user={})",
                signer,
                record_operator,
                record_market,
                record_user,
                market,
                user
            );
        }
    }
}
