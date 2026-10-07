# Module: Collateral Vault (vault token account + UserCollateral ledger)

**Purpose:** USDC custody for the perpetual market: a program-owned vault token
account plus a per-`(market, user)` ledger of `deposited` / `reserved`, with
`deposit_collateral` / `withdraw_collateral` moving funds and updating the ledger
atomically. The free-collateral seam (`free_collateral() = deposited − reserved`)
is the hook the position lifecycle (#5) uses to keep collateral backing open
margin from being withdrawn: every open reserves margin, every close releases
it, and `withdraw_collateral` rejects anything that would push free collateral
negative. Since product-v2 (D9/REQ-A2-3), a withdrawal is additionally gated by
the **account equity** check: the post-withdraw `equity = deposited + Σ upnl`
(over both sides) must stay at or above the reserved (initial-margin)
requirement.

## Public API

| Instruction | Signature | Description |
| --- | --- | --- |
| `initialize_collateral_vault` | `()` | Create the vault token account at `PerpMarket.vault` (authority-gated) |
| `deposit_collateral` | `(amount: u64)` | Move `amount` USDC user ATA → vault; credit the ledger |
| `withdraw_collateral` | `(amount: u64)` | Move `amount` USDC vault → user ATA; debit the ledger |

| Pure function | Signature | Description |
| --- | --- | --- |
| `free_collateral` | `(deposited: u64, reserved: u64) -> Option<u64>` | `deposited.checked_sub(reserved)`; `None` iff `reserved > deposited` |
| `deposit` | `(deposited: u64, amount: u64) -> Option<u64>` | `deposited.checked_add(amount)`; `None` on overflow |
| `withdraw` | `(deposited: u64, reserved: u64, pnl_sum: i128, amount: u64) -> Option<u64>` | `deposited.checked_sub(amount)` gated by `amount <= free_collateral` **and** the equity gate `equity − amount >= reserved`, where `equity = deposited + pnl_sum` (saturating i128) |

## Vault token account

- Located at the PDA already stored in `PerpMarket.vault`, seed
  `[VAULT_SEED]` = `[b"vault"]` (unchanged from issue #2 — it is **not**
  re-derived with a different seed).
- Created by `initialize_collateral_vault` in two CPI steps:
  1. `system_program::create_account` at the vault PDA (payer = signer, program
     owner = SPL Token), and
  2. `token::initialize_account3` with `mint = market.collateral_mint` and
     `authority = vault` — the vault **authorizes itself**.
- The collateral mint must be a Token-program mint with `decimals ==
  USDC_DECIMALS` (`6`), else `InvalidMint`. A second init (vault already holds
  token-account data) fails `VaultAlreadyInitialized`.
- Only the program can move funds out: the vault is a PDA, so transfers sign via
  its bump seeds.

## `UserCollateral` ledger

One PDA per `(market, user)`, seed
`[USER_COLLATERAL_SEED, market.key(), user.key()]` with
`USER_COLLATERAL_SEED = b"user_collateral"`. Both amounts are USDC microunits
(6 decimals).

| Field | Type | Notes |
| --- | --- | --- |
| `deposited` | u64 | USDC credited to the user, microunits |
| `reserved` | u64 | USDC reserved for open positions; `= Σ` position collateral (issue #5) |
| `claimable` | u64 | pending (unfunded) PnL/funding claim (Design A); not directly withdrawable — converted to `deposited` only via claim payout against `PerpMarket.pnl_pool` |
| `bump` | u8 | PDA bump |

- Lazily initialized on **first deposit** (payer = user), all three amount fields
  zero.
- `reserved` is written by the position lifecycle — `open_position` /
  `settle_fill` add `margin_required(notional, im_bps)` per position,
  `close_position` releases it — atomically with the `Position` ledger, and the
  pair is never negative. The layout + offset is in
  [data-models.md](../data-models.md).

## Deposit / withdraw flow

**Deposit** (`deposit_collateral(amount)`, user-signed):

1. Reject `amount == 0` (`InvalidSize`).
2. Lazily system-create the `UserCollateral` PDA on first deposit (payer = user),
   with `claimable = 0`.
3. `token::transfer` `amount` USDC from the user's ATA into the vault (authority
   = the user signer).
4. [Design A] Convert any funded pending claim into `deposited` first
   (`claim_payout(deposited, claimable, pnl_pool)`: `pay = min(claimable, pool)`,
   `deposited += pay`, `claimable -= pay`, `pool -= pay`), then
   `deposited += amount` via `checked_add` (`ArithmeticOverflow` on overflow).

**Withdraw** (`withdraw_collateral(amount)`, user-signed):

1. Reject `amount == 0` (`InvalidSize`).
2. [Design A] Convert any funded pending claim into `deposited` first
   (`claim_payout(...)` as above) — a claim is never directly withdrawable, only
   through this payout.
3. Compute `pnl_sum = Σ upnl` over the user's two sides (index-based; a
   pristine/closed side contributes `0`) and enforce the free-collateral seam
   **plus the equity gate**: `amount <= deposited − reserved` **and**
   `equity − amount >= reserved`, where `equity = deposited + pnl_sum`
   (`InsufficientFreeCollateral` otherwise — nothing moves).
4. `token::transfer` `amount` USDC from the vault to the user's ATA (authority =
   the vault PDA, signing via `[VAULT_SEED, bump]`).
5. `deposited -= amount` via `checked_sub` (`ArithmeticOverflow` on overflow).

Both are atomic — any error unwinds the transfer and the ledger write.

## `free_collateral()` seam

`free_collateral(deposited, reserved) = deposited − reserved` is the single
predicate every withdrawal checks — and, since issue #5, every `open_position`
and `settle_fill` margin check too. It is a pure, property-tested function and
returns `None` only on the invariant violation `reserved > deposited`. With
`reserved = Σ` position collateral, the **same** check rejects withdrawing
collateral that still backs margin, and rejects an open whose margin shortfall
would leave `reserved > deposited` — no new withdrawal path was needed. A
missing ledger (no deposit yet) reports `InsufficientFreeCollateral` rather
than an account-format error.

## Withdraw equity gate (D9/REQ-A2-3)

The free seam alone is not enough once unrealized PnL exists: a user could
withdraw against free ledger balance while an open position bleeds value and
leave the account under-margin. The gate therefore computes the **account
equity** first:

```
equity_post = equity − amount     where equity = deposited + Σ upnl   (saturating i128)
gate:  amount <= free_collateral  ∧  equity_post >= reserved
```

- `Σ upnl` is the index-based unrealized PnL over **both** sides of the
  `(market, user)` account (`positions::pnl` per side; a pristine/missing side
  contributes `0`). The handler reads it from the market-bound `index_source`.
- Refusal is `InsufficientFreeCollateral` and the ledger + vault are untouched
  (the gate runs before the transfer; the post-withdraw `deposited` is computed
  up front).
- `equity − amount == reserved` is allowed (the account sits exactly at the
  initial-margin requirement); one microunit less fails.
- The operator path (`operator_withdraw_collateral`) applies the **same gate**;
  it can never pay anywhere but the subject's own ATA.

## Dependencies

- Inbound: `lib.rs` (`initialize_collateral_vault`, `deposit_collateral`,
  `withdraw_collateral`).
- Outbound: `constants` (`VAULT_SEED`, `USER_COLLATERAL_SEED`,
  `USDC_DECIMALS`), `error`, `state` (`UserCollateral`, `PerpMarket`),
  `anchor-spl` (`token::transfer`, `token::initialize_account3`,
  `associated_token`).

## Patterns & Gotchas

- **Pure accounting, thin adapter** — `collateral.rs` operates on plain `u64`
  values so `proptest` drives the invariants directly; `lib.rs` applies them to
  the on-chain ledger.
- **Vault is self-authorized** — `initialize_account3` sets `authority = vault`
  (the account being initialized), so the explicit two-CPI path is used rather
  than the `#[account(init, token::authority=…)]` shortcut (self-referential in
  the Accounts derive).
- **Deposit/withdraw are permissionless for the owning user**, but vault creation
  is authority-gated (`market.authority`).
- **Plain `token::transfer`, not `transfer_checked`** — the mint is already
  validated at vault initialization, so plain transfer is cheaper and sufficient.
