# Module: Liquidation (health, TWAP reference, partial/full, liquidate)

**Purpose:** Enforce the maintenance-margin floor on an under-margin position.
Unrealized PnL is **index-based** (trustless `positions::pnl` vs the live pool) —
the health metric of R-L2 — while the order-book **TWAP** is the reserved
liquidation reference price plus the window/staleness guard (R-L1/R-L4). A
position is liquidatable iff its equity is **strictly** below the maintenance
margin; the `liquidate` instruction then re-derives the position's surviving
collateral at the **initial** margin ratio (`collateral ==
margin_required(notional, initial_margin_bps)`, the documented invariant) and pays
a penalty (of the released collateral) to the caller — the *liquidator* — out of
the position's collateral (R-L3). The math is a pure module (`crate::liquidation`)
locked by `proptest`; the `liquidate` adapter in `lib.rs` applies it to the
on-chain `Position` / `UserCollateral` accounts.

**Who runs it (Stage 1).** The instruction carries **no authority gate**: the guard
is the contract's own — equity strictly below the maintenance margin, plus a TWAP
that reaches back a full `LIQUIDATION_TWAP_WINDOW`. Stage 1 deliberately runs
liquidation through the **protocol's own keeper**, so no outside party has to take
over a position. Opening the trigger to **third-party liquidators** is the planned
next stage — for when order flow outgrows protocol-side throughput; the call path
already supports it, so no program change is needed to switch.

Units: `notional`/`collateral` are USDC microunits; `unrealized_pnl` is signed
`i128` microunits; margin/penalty ratios are basis points (`≤ 10_000`).

## Public API

| Instruction | Signature | Description |
| --- | --- | --- |
| `liquidate` | `(amount: u64)` | Permissionless partial/full liquidation of an under-margin position (below) |

| Pure function | Signature | Description |
| --- | --- | --- |
| `equity` | `(collateral: u64, unrealized_pnl: i128) -> i128` | `collateral + unrealized_pnl`, signed (R-L2) |
| `maintenance_margin` | `(notional: u64, maintenance_bps: u16) -> Option<u64>` | `margin_required(notional, bps)`, **ceiling** (R-L2) |
| `liquidatable` | `(collateral: u64, unrealized_pnl: i128, notional: u64, maintenance_bps: u16) -> Option<bool>` | `equity < maintenance_margin`, **strict** `<` — equality is healthy (R-L2) |
| `liquidation_penalty` | `(collateral: u64, penalty_bps: u16) -> Option<u64>` | `collateral·penalty_bps/10_000`, **ceiling** (R-L3) |
| `apply_liquidation` | `(position_collateral: u64, notional: u64, amount: u64, initial_margin_bps: u16, maintenance_bps: u16, penalty_bps: u16) -> Result<(u64, u64), LiquidateError>` | Re-derive the surviving collateral at the **initial** margin ratio + pay the penalty; returns `(position_remaining_collateral, liquidator_reward)` (R-L3) |

`LiquidateError::{InvalidAmount, Overflow}` maps to `FructusError::{InvalidSize,
ArithmeticOverflow}`.

## Health & margin model (R-L2)

```
unrealized_pnl = positions::pnl(entry sums, cur index, notional, side)   (signed i128)
equity          = collateral + unrealized_pnl
maintenance     = margin_required(notional, maintenance_margin_bps)      (ceiling)
liquidatable    = equity < maintenance                                   (STRICT '<')
```

- `equity == maintenance` is **healthy** — a position is liquidated only when it
  is genuinely under-margin.
- A zero-notional position has no exposure and is never liquidatable.
- The `maintenance_margin` reuses `positions::margin_required` (ceiling division,
  `u128` intermediates) — the same formula that reserves initial margin, at the
  lower maintenance ratio.
- `liquidatable` is monotonic in PnL (more negative ⇒ still liquidatable) and in
  `maintenance_bps` (higher ⇒ still liquidatable); the boundary is exclusive.

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

1. Bind the victim's `position`/`user_collateral` to the market + the user's
   PDAs (byte-level; `PositionNotFound` / `InvalidAccountData` on mismatch) and
   require `position.notional > 0`.
2. Compute the TWAP reference price; guard a book that does not reach back a full
   window (`NotLiquidatable`).
3. Read the live pool rate, compute the index-based unrealized PnL over the
   **whole** `position.notional`, and check `liquidatable(...)` (strict `<`);
   otherwise `NotLiquidatable`.
4. `apply_liquidation(position.collateral, notional, amount, initial_margin_bps,
   maintenance_bps, LIQUIDATION_PENALTY_BPS)`. This re-derives the surviving
   collateral at the **initial** margin ratio (the documented `state.rs`
   invariant: `position.collateral == margin_required(notional,
   initial_margin_bps)`) and computes a penalty reward on the collateral freed
   by the liquidation (capped so no value is created — the vault is never left
   insolvent).
5. Reduce `position.notional -= amount` (full `amount == notional` zeroes the
   exposure), set `position.collateral = remaining` (`== margin_required(notional
   − amount, initial_margin_bps)`), and release the consumed collateral from the
   victim's `UserCollateral.reserved` (`reserved_after = reserved − consumed`).
6. **[Design A]** Book the victim's realized loss into the PnL pool:
   `apply_liquidation_loss(deposited, reserved_after, loss, reward)` where
   `loss = |pnl|` (the index-based unrealized PnL, negative when liquidatable).
   The booked amount is capped at `deposited − reserved_after − reward` (the
   reward is payable first, and other positions' reserved backing is never
   touched), then `market.pnl_pool += booked` and `deposited -= booked`.
7. Debit the victim's `UserCollateral.deposited` by the `reward` and credit the
   liquidator's `UserCollateral.deposited` (`liquidator_collateral`) with the
   same amount (ledger-only margin — no token movement). The reward is a
   **zero-sum transfer out of the victim's released margin** (`consumed ≥
   reward`), so Σ `deposited` across victim + liquidator + pool is conserved —
   a liquidation never mints collateral (the victim's loss is collected into the
   pool, and the reward is a pure transfer).

## Partial vs full (R-L3)

```
remaining= margin_required(notional − amount, initial_margin_bps)   (invariant)
released = position_collateral − remaining                          (the backing freed)
reward   = liquidation_penalty(released, penalty_bps)               (≤ released)
```

- **Partial** (`amount < notional`): the surviving collateral is re-derived at
  the initial margin ratio of the surviving exposure; the victim keeps
  `remaining` and the caller keeps the `notional − amount` remaining exposure.
- **Full** (`amount == notional`): the surviving notional is `0`, so
  `remaining == margin_required(0, _) == 0` — a closed (zero-notional) position
  holds **zero** collateral and the whole backing is released.
- **No value created**: `remaining + reward ≤ position_collateral` always; a
  full liquidation never leaves negative remaining collateral. Because the
  reward is drawn **out of** the released backing (`reward ≤ released`), the
  `liquidate` handler debits the victim's `deposited` by the reward while
  crediting the liquidator's — a zero-sum transfer. Combined with [Design A]
  (the victim's realized loss is booked into `pnl_pool`), the FULL transition
  conserves Σ(deposited + pool), so the vault is never over-issued.
- `amount == 0` or `amount > notional ⇒ InvalidAmount`.
- `maintenance_bps` is the **health** threshold (`liquidatable`), not a release
  parameter; the surviving collateral is always backed at the initial margin
  ratio (exactly as `apply_open_fills` / `apply_close_fills`).

## Dependencies

- Inbound: `lib.rs::liquidate`.
- Outbound: `constants` (`LIQUIDATION_PENALTY_BPS`, `LIQUIDATION_TWAP_WINDOW`),
  `positions` (`margin_required`, `pnl`, `PositionSide`), `settlement`
  (`apply_liquidation_loss`), `orderbook` (`twap`),
  `exchange` (`ExchangeRate` via the stake-pool validation in `lib.rs`), `state`
  (`Position`, `UserCollateral`, `PerpMarket`, `OrderBook`), `error`
  (`NotLiquidatable`).

## Patterns & Gotchas

- **Signed `i128` equity/PnL** — a losing long has a negative unrealized
  contribution that reduces equity; all arithmetic is `checked_*`/`saturating_*`
  (no panicking math, per AGENTS.md).
- **Ceiling divisions** — `maintenance_margin` and `liquidation_penalty` both
  round **up**, so the released backing is never below the exact requirement and
  the reward is never truncated below its bps share. Penalty is bounded by its
  underlying collateral (`penalty(bps=0) == 0`, `penalty(bps=10_000) ==
  collateral`, monotonic in bps).
- **Strict `<` boundary** — the equals case is healthy; the proptest suite pins
  `equity == maintenance ⇒ not liquidatable` and `equity == maintenance − 1 ⇒
  liquidatable`.
- **`[INFERRED]`** — the on-chain PnL model uses the **index** (trustless,
  `positions::pnl`) as the health metric; the order-book TWAP is the reserved
  reference price + staleness guard rather than the literal health input.
  `entry_price` (fill yield) is not stored today, so mark-vs-entry PnL is out of
  scope for health; funding keeps `mark ≈ index`. Confirm at review.
- **Ledger-only margin** — collateral is reserved inside
  `UserCollateral.reserved`; liquidation releases it the same way `close_position`
  does, with no token movement on-chain.
