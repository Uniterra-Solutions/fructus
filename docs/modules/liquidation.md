# Module: Liquidation (account health, TWAP reference, partial/full, liquidate)

**Purpose:** Enforce the maintenance-margin floor on an **under-margin
account** — the account-level, cross-margin model (product-v2 A2/D8) that
supersedes the earlier per-position engine. Unrealized PnL is **index-based**
(trustless `positions::pnl` vs the live pool) — the health metric of R-L2 —
while the order-book **TWAP** is the reserved liquidation reference price plus
the window/staleness guard (R-L1/R-L4).

The health metric is the **account equity**: `equity = deposited + Σ upnl`,
summed over **both** sides of the account (a long and a short do **not** offset
each other — cross margin, NO netting, D6). The account is liquidatable iff it
has exposure (`n_long + n_short > 0`) and its `equity` is **strictly** below
the **total** maintenance requirement `Σ_side margin_required(n_side,
maintenance_bps)` — equality is healthy. The `liquidate(side, amount)`
instruction then liquidates the **targeted side only**: it re-derives that
position's surviving collateral at the **initial** margin ratio (`collateral ==
margin_required(notional, initial_margin_bps)`, the documented invariant) and
pays a penalty (of the released collateral) to the caller — the *liquidator* —
out of the released backing (R-L3). The math is a pure module
(`crate::liquidation`) locked by `proptest`; the `liquidate` adapter in `lib.rs`
applies it to the on-chain `Position` / `UserCollateral` accounts.

**Who runs it (Stage 1).** The instruction carries **no authority gate**: the
guard is the contract's own — account equity strictly below the total
maintenance requirement, plus a TWAP that reaches back a full
`LIQUIDATION_TWAP_WINDOW`. Stage 1 deliberately runs liquidation through the
**protocol's own keeper**, so no outside party has to take over an account.
Opening the trigger to **third-party liquidators** is the planned next stage —
for when order flow outgrows protocol-side throughput; the call path already
supports it, so no program change is needed to switch.

Units: `notional`/`collateral` are USDC microunits; `unrealized_pnl` is signed
`i128` microunits; margin/penalty ratios are basis points (`≤ 10_000`).

## Public API

| Instruction | Signature | Description |
| --- | --- | --- |
| `liquidate` | `(side: u8, amount: u64)` | Permissionless partial/full liquidation of the **targeted side** of an under-margin account (below) |

| Pure function | Signature | Description |
| --- | --- | --- |
| `account_equity` | `(deposited: u64, pnl_sum: i128) -> i128` | `deposited + Σ upnl`, signed, saturating at the i128 extremes (REQ-A2-1) |
| `account_margin_required` | `(n_long: u64, n_short: u64, bps: u16) -> Option<u64>` | Checked sum of both sides' ceilings, `margin_required(n_long, bps) + margin_required(n_short, bps)` — **no netting** (D6) |
| `account_liquidatable` | `(deposited: u64, pnl_sum: i128, n_long: u64, n_short: u64, maintenance_bps: u16) -> Option<bool>` | Zero exposure ⇒ `false`; else `equity < Σ m(n_i, maintenance_bps)`, **strict** `<` — equality is healthy |
| `account_liquidation_loss` | `(pnl_sum: i128) -> u64` | `max(0, −Σ upnl)`, u64-saturated — the loss a liquidation books into the PnL pool |
| `liquidation_penalty` | `(collateral: u64, penalty_bps: u16) -> Option<u64>` | `collateral·penalty_bps/10_000`, **ceiling** (R-L3) |
| `apply_liquidation` | `(position_collateral: u64, notional: u64, amount: u64, initial_margin_bps: u16, penalty_bps: u16) -> Result<(u64, u64), LiquidateError>` | Re-derive the targeted position's surviving collateral at the **initial** margin ratio + pay the penalty; returns `(position_remaining_collateral, liquidator_reward)` (R-L3) |

`LiquidateError::{InvalidAmount, Overflow}` maps to `FructusError::{InvalidSize,
ArithmeticOverflow}`.

## Account health & margin model (REQ-A2-1/D6)

```
upnl_side       = positions::pnl(entry sums, cur index, notional_side, side)    (signed i128, per side)
equity          = deposited + Σ_side upnl                                       (account equity)
requirement(mm) = margin_required(n_long, mm) + margin_required(n_short, mm)    (ceiling each, checked sum)
liquidatable    = (n_long + n_short > 0) ∧ equity < requirement(mm)             (STRICT '<')
```

- `equity == requirement` is **healthy** — an account is liquidated only when it
  is genuinely under-margin.
- A zero-exposure account is never liquidatable (the short-circuit is checked
  first, so the answer is total even for degenerate ceilings).
- **Cross margin, no netting** — both sides require margin independently, so
  the requirement is the sum of the two per-side ceilings. A side that is
  individually healthy can still be liquidated while the account is
  under-margin (its sibling's unrealized losses drag the account below the
  floor) — `LIQUIDATE-TRIGGERS-ON-ACCOUNT-HEALTH` pins exactly that case.
- `account_liquidatable` is monotonic in PnL (more negative ⇒ still
  liquidatable) and in `maintenance_bps` (higher ⇒ still liquidatable); the
  boundary is exclusive.
- `deposited` is the account's credited collateral (`UserCollateral.deposited`)
  and increases equity one-for-one, so a top-up deposit can restore health.

## TWAP reference-price guard (R-L1/R-L4)

The `liquidate` handler computes the order-book TWAP reference
(`orderbook::twap(&observations, LIQUIDATION_TWAP_WINDOW, now_slot)`). A book
that does not reach back a full `LIQUIDATION_TWAP_WINDOW = 16` slots yields no
reference and the liquidation is **refused** (`NotLiquidatable`) — the window +
staleness guard that resists a brief mark spike. `LIQUIDATION_PENALTY_BPS = 500`
(5% of the released collateral) is the liquidator incentive.

In this iteration the TWAP is the **reserved** reference price + guard; the
**health input** itself is the index-based unrealized PnL. See the `[INFERRED]`
note below.

## `liquidate` flow

1. Validate the targeted `position` (bound to the market, `notional > 0`, the
   `side` byte matching the named `side`), verify the victim's
   `user_collateral` PDA from `position.owner`, and bind `other_position` to the
   **opposite side's** Position PDA (byte-equal key; a pristine/missing side
   contributes zero exposure; a system-owned squat ⇒ `PositionPdaSquatted`; a
   program-owned mismatch ⇒ `InvalidAccountData`).
2. Compute the TWAP reference price; guard a book that does not reach back a
   full window (`NotLiquidatable`).
3. Read the live pool rate and compute the index-based `Σ upnl` over **both**
   sides (`position` + `other_position`; pristine/closed sides contribute `0`).
4. Check `account_liquidatable(deposited, Σ upnl, n_long, n_short,
   maintenance_bps)` (strict `<`; `None` — requirement overflow — counts as not
   liquidatable); otherwise `NotLiquidatable`.
5. `apply_liquidation(position.collateral, position.notional, amount,
   initial_margin_bps, LIQUIDATION_PENALTY_BPS)`. This re-derives the targeted
   position's surviving collateral at the **initial** margin ratio (the
   documented `state.rs` invariant: `position.collateral ==
   margin_required(notional, initial_margin_bps)`) and computes a penalty reward
   on the collateral freed by the liquidation (capped so no value is created —
   the vault is never left insolvent).
6. Reduce the targeted `position.notional -= amount` (full `amount == notional`
   zeroes that side's exposure), set `position.collateral = remaining` (`==
   margin_required(notional − amount, initial_margin_bps)`), and release the
   consumed collateral from the victim's `UserCollateral.reserved`
   (`reserved_after = reserved − released`). The **untargeted side's account is
   never touched**.
7. **[Design A]** Book the account loss `max(0, −Σ upnl)` into the PnL pool:
   `apply_liquidation_loss(deposited, reserved_after, loss, reward)`. The booked
   amount is capped at `deposited − reserved_after − reward` (the reward is
   payable first, and other positions' reserved backing is never touched), then
   `market.pnl_pool += booked` and `deposited -= booked`.
8. Debit the victim's `UserCollateral.deposited` by the `reward` and credit the
   liquidator's `UserCollateral.deposited` (`liquidator_collateral`) with the
   same amount (ledger-only margin — no token movement). The reward is a
   **zero-sum transfer out of the victim's released margin** (`released ≥
   reward`), so Σ `deposited` across victim + liquidator + pool is conserved —
   a liquidation never mints collateral (the victim's loss is collected into the
   pool, and the reward is a pure transfer).

## Partial vs full (R-L3)

```
remaining= margin_required(notional − amount, initial_margin_bps)   (invariant)
released = position_collateral − remaining                          (the backing freed)
reward   = liquidation_penalty(released, penalty_bps)               (≤ released)
```

- **Partial** (`amount < notional`): the targeted side's surviving collateral is
  re-derived at the initial margin ratio of its surviving exposure; the victim
  keeps `remaining` and holds the `notional − amount` remaining exposure. The
  other side is untouched (byte-identical), so `reserved == Σ_side m(n_i,
  initial_margin_bps)` still holds after the transition.
- **Full** (`amount == notional`): the targeted side's surviving notional is
  `0`, so `remaining == margin_required(0, _) == 0` — that side's whole backing
  is released. The account is closed only once **both** sides reach zero
  notional.
- **No value created**: `remaining + reward ≤ position_collateral` always; a
  full liquidation never leaves negative remaining collateral. Because the
  reward is drawn **out of** the released backing (`reward ≤ released`), the
  `liquidate` handler debits the victim's `deposited` by the reward while
  crediting the liquidator's — a zero-sum transfer. Combined with [Design A]
  (the account's realized loss is booked into `pnl_pool`), the FULL transition
  conserves Σ(deposited + pool), so the vault is never over-issued.
- `amount == 0` or `amount > notional ⇒ InvalidAmount`.
- `maintenance_bps` is the **health** threshold (`account_liquidatable`), not a
  release parameter; the surviving collateral is always backed at the initial
  margin ratio (exactly as `apply_open_fills` / `apply_close_fills`).

## Dependencies

- Inbound: `lib.rs::liquidate`.
- Outbound: `constants` (`LIQUIDATION_PENALTY_BPS`, `LIQUIDATION_TWAP_WINDOW`),
  `positions` (`margin_required`, `pnl`, `PositionSide`), `settlement`
  (`apply_liquidation_loss`), `orderbook` (`twap`),
  `exchange` (`ExchangeRate` via the stake-pool validation in `lib.rs`), `state`
  (`Position`, `UserCollateral`, `PerpMarket`, `OrderBook`), `error`
  (`NotLiquidatable`).

## Patterns & Gotchas

- **Signed `i128` equity/PnL** — a losing side has a negative unrealized
  contribution that reduces equity; all arithmetic is `checked_*`/`saturating_*`
  (no panicking math, per AGENTS.md).
- **Ceiling divisions** — `account_margin_required` (via `margin_required`) and
  `liquidation_penalty` both round **up**, so the released backing is never
  below the exact requirement and the reward is never truncated below its bps
  share. Penalty is bounded by its underlying collateral (`penalty(bps=0) == 0`,
  `penalty(bps=10_000) == collateral`, monotonic in bps).
- **Strict `<` boundary** — the equals case is healthy; the proptest suite pins
  `equity == requirement ⇒ not liquidatable` and `equity == requirement − 1 ⇒
  liquidatable`.
- **Account trigger, per-side transition** — the trigger reads **both** sides
  (the `other_position` account supplies the sibling's notional/PnL); the write
  set touches only the targeted side's `Position`, the victim's ledger, the
  pool, and the liquidator's ledger.
- **`[INFERRED]`** — the on-chain PnL model uses the **index** (trustless,
  `positions::pnl`) as the health metric; the order-book TWAP is the reserved
  reference price + staleness guard rather than the literal health input.
  `entry_price` (fill yield) is not stored today, so mark-vs-entry PnL is out of
  scope for health; funding keeps `mark ≈ index`. Confirm at review.
- **Ledger-only margin** — collateral is reserved inside
  `UserCollateral.reserved`; liquidation releases it the same way `close_position`
  does, with no token movement on-chain.
