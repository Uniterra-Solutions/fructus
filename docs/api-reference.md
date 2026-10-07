# API Reference (On-chain Instructions)

Program id: `3EsUd5XQ6KChedwL2ho8pv3zrrGGFvMpJEV1PnzN8MD1`

All instructions are Anchor handlers. Accounts are validated by Anchor
constraints + explicit checks in the handler.

| Instruction | Args | Required Accounts | Auth | Effect |
| --- | --- | --- | --- | --- |
| `initialize` | `publisher: Pubkey`, `stale_after_slots: u64`, `initial_apy: u64` | `oracle` (init PDA), `authority` (signer, payer), `system_program` | — | Create oracle; set fields; `initial_apy` must be ≤ `MAX_APY` |
| `update_apy` | `apy: u64`, `version: u64` | `oracle` (mut), `instruction_sysvar` | publisher (ed25519 sig) | Verify sig; `version` must be `> current`; `apy ≤ MAX_APY`; set `apy/version/last_update_slot` |
| `set_stale_window` | `new_stale_after_slots: u64` | `oracle` (mut), `authority` (signer) | `authority` | Update `stale_after_slots` |
| `set_publisher` | `new_publisher: Pubkey` | `oracle` (mut), `authority` (signer) | `authority` | Rotate `publisher` |
| `read_exchange_rate` | — | `stake_pool` (unchecked) | — | Require owner == stake-pool program + `account_type == StakePool`; read + log rate |
| `initialize_market` | `collateral_mint: Pubkey`, `funding_k: u64`, `max_funding: u64`, `funding_epoch_slots: u64`, `initial_margin_bps: u16`, `maintenance_margin_bps: u16` | `market` (init PDA), `index_source` (unchecked), `authority` (signer), `payer` (signer, mut), `system_program` | `authority` (admin) | Create singleton market; validate `index_source` (owner + `StakePool` discriminator) and numeric bounds; derive + store `vault` PDA; set all fields |
| `initialize_order_book` | — | `order_book` (init PDA), `market` (has_one authority), `authority` (signer), `payer` (signer, mut), `system_program` | `authority` == `market.authority` | Create the market-bound `OrderBook` PDA (seed `[b"order_book", market]`); zero the header, cursors, and inline arrays |
| `place_limit_order` | `side: u8`, `price: u64`, `size: u64` | `order_book` (mut), `market`, `index_source` (readonly, market-bound), `owner` (signer) | `owner` (self) | Reject zero `price`/`size`; read the index snapshot; rest the order if non-crossing, otherwise match inline (bounded by `MAX_MATCH_STEPS`); never rest a crossing order. Every `Fill` is stamped with the in-tx snapshot (`entry_total_lamports` / `entry_pool_token_supply`, `settled = 0`) for later maker settlement; position-neutral for the taker |
| `place_market_order` | `side: u8`, `size: u64` | `order_book` (mut), `market`, `index_source` (readonly, market-bound), `owner` (signer) | `owner` (self) | Cross the opposite book best-price-first until filled or exhausted; IOC — unfilled remainder cancelled, never over-fills. `Fill`s stamped with the in-tx index snapshot (`settled = 0`); position-neutral for the taker |
| `cancel_order` | `seq: u64` | `order_book` (mut), `market`, `owner` (signer) | `owner` only | Remove one resting order (owner-only); append a `Cancel` event |
| `crank` | — | `order_book` (mut), `market`, `index_source` (readonly, market-bound), `cranker` (signer) | permissionless | Drain up to `CRANK_BATCH_LEN` (8) events; emit `Fill`/`Cancel`, re-match `Residual` entries; `Fill`s from a resumed residual stamped with the in-tx index snapshot; never matches off-chain |
| `initialize_collateral_vault` | — | `market` (has_one authority), `authority` (signer), `payer` (signer, mut), `vault` (mut, seed `[b"vault"]`), `collateral_mint` (Mint == `market.collateral_mint`), `system_program`, `token_program` | `authority` == `market.authority` | System-create + `initialize_account3` the vault token account with itself as authority; validate mint `decimals == 6`; fail `VaultAlreadyInitialized` on retry |
| `deposit_collateral` | `amount: u64` | `user` (signer, mut), `market` (mut), `user_collateral` (mut, lazily created), `vault` (mut), `user_ata` (mut ATA), `collateral_mint` (Mint), `system_program`, `token_program` | `user` | Lazily create the ledger on first deposit (`claimable = 0`); `token::transfer` ATA → vault; [Design A] convert any funded pending claim into `deposited` (`claim_payout`), then `deposited += amount` (checked) |
| `withdraw_collateral` | `amount: u64` | `user` (signer), `market` (mut), `user_collateral` (mut), `vault` (mut), `user_ata` (mut ATA), `collateral_mint` (Mint), `token_program` | `user` + vault PDA (signs via seeds) | [Design A] convert any funded pending claim into `deposited` (`claim_payout`); enforce `amount <= deposited - reserved`; `token::transfer` vault → ATA; `deposited -= amount` (checked) |
| `open_position` | `side: u8`, `size: u64`, `price: u64` | `order_book` (mut), `market`, `index_source` (readonly, market-bound), `user` (signer), `position` (mut, lazily created, seed `[b"position", market, user, side]`), `user_collateral` (mut, must pre-exist), `system_program` | `user` (self) | Validate args (`side` ∈ {0, 1}, `size > 0`); read the index snapshot; place a limit order (`price != 0`) or market-IOC order (`price == 0`). Taker fills settle inline: lazy-create the `Position`, `notional += size`, entry sums accumulated, margin reserved against free collateral; `Fill` events stamped with the snapshot + `settled = 0` |
| `close_position` | `side: u8`, `size: u64` | `order_book` (mut), `market`, `index_source` (readonly, market-bound), `user` (signer), `position` (mut), `user_collateral` (mut) | `user` (self) | Require `size > 0` (`InvalidSize`), live position (`PositionNotFound`), `size <= notional` (`InvalidCloseSize`); place a market-IOC order on the opposite side; taker fills reduce the position (`notional -= size`, entry unchanged, margin released); no PnL settlement |
| `settle_fill` | `seq: u64` | `order_book` (mut), `market`, `position` (mut, maker, verified against the event-derived PDA), `user_collateral` (mut, maker, must pre-exist), `settler` (signer, payer), `system_program` | permissionless | Book one resting maker's `Fill` with open-intent semantics: locate `seq % EVENT_QUEUE_LEN`, require `event.seq == seq`, `kind == Fill`, `settled == 0` (an already-settled `Fill` is an idempotent no-op); apply the event-carried fill-time snapshot to the maker's `Position` (re-open when `notional == 0`), reserve margin, mark `settled = 1` |
| `settle_funding` | `()` | `market` (mut), `position` (mut), `user_collateral` (mut), `order_book` (readonly), `index_source` (readonly, market-bound) | permissionless | Accrue signed funding over the full elapsed epochs (`cur_epoch − position.last_funding_epoch`): derive the trustless index (`annualize` of the market baseline → live pool rate); `mark` = order-book mid (fallback `index`); `rate = funding_rate(premium, funding_k, max_funding)`; `payment = funding_payment(notional, rate, epochs, side)`; [Design A] route `payment` through the PnL pool (`settle_signed`: payer debit → pool, payee credit ≤ pool, remainder → `claimable`); advance `position.last_funding_epoch`, the market baseline, and `market.funding_accumulator` (nominal) — idempotent when `epochs == 0` — see [modules/funding.md](modules/funding.md) |
| `settle_close` | `()` | `market` (mut), `position` (mut), `user_collateral` (mut), `index_source` (readonly, market-bound) | permissionless | Realize the signed index-based PnL of `closed_notional` into the Design A PnL pool via `positions::pnl` (priced at the **close-time** entry basis `closed_entry_*`) + `settlement::settle_signed` (a loss is collected into `pnl_pool`, a profit is paid only up to the pool, the remainder → `claimable`); reset `closed_notional` + `closed_entry_*` to `0`; `closed_notional == 0` is an idempotent no-op. Depends only on `exchange.rs` data — never the mark oracle (R-S2) |
| `liquidate` | `side: u8`, `amount: u64` | `market` (mut), `position` (mut, the targeted `side`'s Position PDA), `other_position` (the opposite side's Position PDA — a pristine/missing side contributes zero), `user_collateral` (mut, victim ledger), `order_book` (readonly), `index_source` (readonly, market-bound), `liquidator` (signer — the caller, paid the penalty), `liquidator_collateral` (mut) | permissionless — no authority gate; **Stage 1 runs it via the protocol's own keeper** | Account-level trigger (D8): TWAP reference-price guard (a book not reaching back `LIQUIDATION_TWAP_WINDOW` ⇒ `NotLiquidatable`); `Σ upnl` over **both** sides + `account_liquidatable(deposited, Σ upnl, n_long, n_short, maintenance_bps)` (strict `<`) — a side that is individually healthy can still be liquidated while the account is under-margin; transition on the targeted `side` only: `apply_liquidation` re-derives the surviving `Position.collateral` at the **initial** margin ratio (so `collateral == margin_required(notional, initial_margin_bps)` holds, exactly as open/close) and pays `LIQUIDATION_PENALTY_BPS` of the released collateral to the liquidator; reduce `Position.notional`, set `Position.collateral` to the surviving value, release the victim's `reserved`; [Design A] book the account loss `max(0, −Σ upnl)` into `pnl_pool` (`apply_liquidation_loss`, capped at `deposited − reserved_after − reward`); then debit the victim by the booked loss + reward and credit `liquidator_collateral.deposited` by the reward (zero-sum transfer out of the victim's released margin) — see [modules/liquidation.md](modules/liquidation.md) |
| `set_operator` | `operator: Pubkey` | `user` (signer, mut), `market`, `operator_record` (mut, PDA `[OPERATOR_SEED, market, user]`), `system_program` | `user` (only the subject) | Create / rotate / revoke the per-`(market, user)` delegation record: lazy `create_account` on first bind (payer = user, `8 + 97`), overwrite on rotate, `Pubkey::default()` stores the revoke state (account never closed); a non-program-owned squat ⇒ `OperatorPdaSquatted` — see [modules/operator.md](modules/operator.md) |
| `operator_deposit_collateral` | `amount: u64` | `operator` (signer, mut), `user`, `market` (mut), `user_collateral` (mut, lazily created), `operator_record`, `vault` (mut), `user_ata` (mut), `collateral_mint`, `token_program`, `system_program` | record authority (`OperatorUnauthorized` otherwise) | Pull `amount` subject ATA → vault with the Operator PDA as SPL delegate (`invoke_signed`); credit the **subject's** ledger (claim-payout then checked credit; payer = operator); a missing/short SPL approval propagates the token-program error and no ledger mutation persists |
| `operator_withdraw_collateral` | `amount: u64` | `operator` (signer), `user`, `market` (mut), `user_collateral` (mut), `operator_record`, `vault` (mut), `user_ata` (mut), `collateral_mint`, `index_source` (readonly, market-bound), `position_long`, `position_short`, `token_program` | record authority | Pay vault → the **subject's own** ATA only (mint + owner checked in-handler); same free-collateral seam + equity gate as `withdraw_collateral`; the vault PDA signs |
| `operator_open_position` | `side: u8`, `size: u64`, `price: u64` | `operator` (signer, mut), `user`, `market`, `order_book` (mut), `index_source` (readonly, market-bound), `position` (mut, subject's PDA), `user_collateral` (mut), `operator_record`, `system_program` | record authority | Mirror of `open_position` on the subject's accounts: same CLOB routing + inline taker settlement, attributed to the **subject** (`position.owner = user`); lazy `Position` creation (payer = operator) |
| `operator_close_position` | `side: u8`, `size: u64` | `operator` (signer), `user`, `market`, `order_book` (mut), `index_source` (readonly, market-bound), `position` (mut, subject's PDA), `user_collateral` (mut), `operator_record` | record authority | Mirror of `close_position` (market-IOC, `notional -= size`, margin released) on the subject's position |
| `operator_place_limit_order` | `side: u8`, `price: u64`, `size: u64` | `operator` (signer), `user`, `market`, `order_book` (mut), `index_source` (readonly, market-bound), `operator_record` | record authority | Mirror of `place_limit_order`; the resting order is owned by the **subject** |
| `operator_place_market_order` | `side: u8`, `size: u64` | `operator` (signer), `user`, `market`, `order_book` (mut), `index_source` (readonly, market-bound), `operator_record` | record authority | Mirror of `place_market_order` (IOC); fills attributed to the **subject** |
| `operator_cancel_order` | `seq: u64` | `operator` (signer), `user`, `market`, `order_book` (mut), `operator_record` | record authority | Cancel the **subject's** resting order `seq` (owner-only becomes operator-for-subject); appends the subject-attributed `Cancel` event |

## Errors

| Code | Variant | Trigger |
| --- | --- | --- |
| — | `ApyTooHigh` | `apy > 1_000_000` on `initialize` / `update_apy` |
| — | `StaleVersion` | `version <= oracle.version` |
| — | `InvalidSignature` | ed25519 pubkey/message mismatch or malformed instruction |
| — | `SignatureMissing` | no matching ed25519 verify instruction in transaction |
| — | `InvalidStakePool` | wrong owner or discriminator in `read_exchange_rate` / `initialize_market` `index_source` validation |
| — | `InvalidFundingK` | `funding_k` outside `[1, 1_000_000]` on `initialize_market` |
| — | `InvalidMaxFunding` | `max_funding > 1_000_000` on `initialize_market` |
| — | `InvalidInitialMargin` | `initial_margin_bps` outside `(0, 10_000]` on `initialize_market` |
| — | `InvalidMaintenanceMargin` | `maintenance_margin_bps` not in `(0, initial_margin_bps]` on `initialize_market` |
| — | `BookFull` | limit order on a side already at `MAX_ORDERS_PER_SIDE` (16); or a deferred `Residual` that cannot be queued because the event ring is full (backpressure); or a `Fill` that cannot be appended to a full event ring on any fill-producing instruction (fills are never silently dropped — D10) |
| — | `BookAlreadyInitialized` | second `initialize_order_book` (the book account already holds data) |
| — | `BookNotInitialized` | book op (`place_limit_order`/`place_market_order`/`cancel_order`/`crank`) before `initialize_order_book` |
| — | `InvalidPrice` | zero `price`, or a crossing limit that cannot rest |
| — | `InvalidSize` | zero `size` on `place_limit_order`/`place_market_order`/`open_position`/`close_position`, or zero `amount` on deposit/withdraw |
| — | `OrderNotFound` | `cancel_order` on a non-existent or already-filled `seq` |
| — | `OrderOwnerMismatch` | `cancel_order` by a non-owner |
| — | `SelfTrade` | a crossing limit whose only crossable maker is self-owned and nothing else filled |
| — | `InvalidMint` | collateral mint `decimals != 6` on `initialize_collateral_vault` |
| — | `InsufficientFreeCollateral` | `withdraw_collateral` with `amount > deposited - reserved`; or `open_position`/`settle_fill` whose margin shortfall leaves `reserved > deposited` — including a missing `UserCollateral` ledger (the ledger is deposit-created, so a missing ledger is a free-collateral error, not an account-format error) |
| — | `VaultAlreadyInitialized` | second `initialize_collateral_vault` (vault already holds token-account data) |
| — | `VaultNotInitialized` | deposit/withdraw before `initialize_collateral_vault` |
| — | `ArithmeticOverflow` | checked-arithmetic overflow in `next_seq`/cursor increments or `deposited` add/sub |
| — | `PositionNotFound` | `close_position` without a live position (`notional == 0` or no `Position` account) — not raised by the maker-settlement instruction: a `notional == 0` maker position is re-opened (FR-5/A-9b) and a missing ledger reports `InsufficientFreeCollateral` |
| — | `NotLiquidatable` | `liquidate` on an account whose equity is **at or above** its total maintenance requirement (strict `<` — equality is healthy), or whose order-book TWAP does not reach back a full `LIQUIDATION_TWAP_WINDOW` (no liquidation reference price) |
| — | `EventNotFound` | `settle_fill` with no current `Fill` at `seq` — the sequence was never issued or the ring slot was overwritten before settlement (see the liveness bound in [modules/positions.md](modules/positions.md)) |
| — | `InvalidCloseSize` | `close_position` with `size > notional` |
| — | `OperatorUnauthorized` | any `operator_*` instruction whose signer is not the record's live operator — no record, a revoked record, a wrong signer, or a record for another `(market, user)`; zero state mutation |
| — | `OperatorPdaSquatted` | `set_operator` at the operator-record PDA holding a non-program-owned, non-pristine account — the program can never reclaim an account it does not own |

`BookAlreadyInitialized`, `BookNotInitialized`, and `VaultNotInitialized` are
wired with explicit `require!` checks in the handlers: an account is treated as
initialized once it holds non-empty data, so a re-init or a pre-init access fails
with the dedicated variant rather than an Anchor account-constraint error.

## Signature Scheme (`update_apy`)

The transaction must include an `ed25519` program instruction (inline data,
`*_instruction_index == u16::MAX`) whose public key equals `oracle.publisher` and
whose 32-byte message equals:

```
sha256("fructus::update_apy" ‖ oracle_address ‖ apy_le(8) ‖ version_le(8))
```

The program introspects the transaction instruction list (via the instruction
sysvar) and binds that instruction to the expected publisher + message.
