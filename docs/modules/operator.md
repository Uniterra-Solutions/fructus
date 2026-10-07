# Module: Operator Delegation (`set_operator` + `operator_*`)

**Purpose:** A per-`(market, user)` delegation record that lets a hot **operator**
key act for the subject **user** without a wallet signature on every action
(product-v2 A1; D2/D4/D5 — 「每次交易 / 入金 / 出金不用額外簽名」). The subject
binds **once** — a single wallet-signed transaction
`[spl_token approve(Operator PDA, u64::MAX), set_operator(operator)]` — and from
then on the operator alone signs deposits, withdrawals, orders and the position
lifecycle instructions. Every effect is attributed to the **subject**: their
ledger, their position PDAs, their resting orders.

On-chain this is a borsh `Operator` account plus a pure authorization predicate
(`crate::operator::authorized`). The surface is **additive**: the record gates
only the new `operator_*` instructions and never changes the direct,
user-signed paths.

## `Operator` record (PDA + layout)

- PDA seeds `[OPERATOR_SEED, market, user]` with `OPERATOR_SEED = b"operator"` —
  exactly one record per `(market, user)` pair.
- Payload exactly **97 bytes**: `market: Pubkey(32) + user: Pubkey(32) +
  operator: Pubkey(32) + bump: u8(1)`. Full field/offset table:
  [data-models.md](../data-models.md).
- `operator == Pubkey::default()` is the **revoked** state — a pristine
  (never-created) or revoked record authorizes nobody.

## Lifecycle: create / rotate / revoke

`set_operator(operator: Pubkey)` — accounts `[user (Signer, mut), market,
operator_record (mut), system_program]`. Only the **subject user's signature**
mutates the record; every call rewrites `market` / `user` / `operator` / `bump`:

1. **Create** — on the first call the pristine system account at the PDA is
   lazily `create_account`ed (payer = user, rent-exempt, `8 + 97` bytes,
   program-owned).
2. **Rotate** — a live program-owned record is overwritten in place with the new
   operator key.
3. **Revoke** — `Pubkey::default()` stores the revoke state; the account is
   **never closed** (revoke and re-bind happen in place). The revoke transaction
   is `[spl_token approve(0), set_operator(default)]`, clearing the SPL delegate
   and the record together.
4. **Squat guard** — a non-program-owned, non-pristine account at the PDA is
   rejected with `FructusError::OperatorPdaSquatted` and never reclaimed (a
   program cannot mutate an account it does not own).

## Authorization matrix

Every `operator_*` instruction runs the same pure predicate before touching any
state:

```
authorized(signer, record_operator, record_market, record_user, market, user)
  ⇔ record_operator == signer
  ∧ record_operator != Pubkey::default()      (not revoked)
  ∧ record_market  == market                  (scoped to this market)
  ∧ record_user    == user                    (scoped to this subject)
```

Every failure mode — (a) no record at all, (b) a revoked record, (c) a signer
that is not the record's operator, (d) a record for another `(market, user)` —
raises `FructusError::OperatorUnauthorized` with **zero state mutation**, and
the check runs before any book/ledger/pool write. Property-tested over the full
key domain (`OPERATOR-AUTH-MATRIX`).

## The eight instructions

| Instruction | Args | Behavior |
| --- | --- | --- |
| `set_operator` | `operator: Pubkey` | Subject-only create / rotate / revoke of the record (above) |
| `operator_deposit_collateral` | `amount: u64` | Pull USDC subject ATA → vault with the Operator PDA as SPL delegate; credit the **subject's** ledger (lazily created, payer = operator) |
| `operator_withdraw_collateral` | `amount: u64` | Pay vault → the **subject's own** ATA only; same free-collateral seam + equity gate as the direct path |
| `operator_open_position` | `side: u8`, `size: u64`, `price: u64` | Open via the CLOB on the subject's position + ledger (limit when `price > 0`, market-IOC when `price == 0`) |
| `operator_close_position` | `side: u8`, `size: u64` | Market-IOC close of the subject's position (margin released) |
| `operator_place_limit_order` | `side: u8`, `price: u64`, `size: u64` | Rest a limit order owned by the subject |
| `operator_place_market_order` | `side: u8`, `size: u64` | IOC order attributed to the subject |
| `operator_cancel_order` | `seq: u64` | Cancel the subject's resting order (subject-attributed `Cancel` event) |

Per-instruction account lists live in the
[instruction reference](../api-reference.md) (one home per fact); the core
logic is the **same shared core** as the direct handlers — only the signer and
the attribution change.

## SPL approval (the "pull" half)

- **Bind**: `approve(Operator PDA, u64::MAX)` on the subject's USDC ATA makes
  the Operator PDA the spending delegate; `set_operator(operator)` writes the
  record. Both in one wallet-signed transaction (`buildOperatorBindInstructions`
  in the SDK; the server relays it via `POST /bind/prepare` +
  `POST /bind/confirm` — see [api.md](../api.md)).
- **Deposit**: `operator_deposit_collateral` moves `amount` from the subject's
  ATA to the vault with the Operator PDA as delegate (`invoke_signed` over
  `[OPERATOR_SEED, market, user, bump]`); a missing or short SPL approval
  propagates the token program's error and **no ledger mutation persists**
  (both halves are in one atomic transaction).
- **Withdraw needs no approval**: the vault PDA (the vault token account's own
  authority) signs the vault → subject transfer. The Operator PDA is only the
  ATA delegate for deposits.
- **Revoke**: `approve(0)` clears the allowance; the stale record is revoked in
  the same transaction.

## Subject attribution & trust story

- Orders and positions are attributed to the **subject**: `order.owner = user`,
  `position.owner = user` (the position PDA seed is the subject's key), the
  margin ledger touched is the subject's `UserCollateral`.
- The operator can never redirect funds: deposits can only move subject ATA →
  vault, and withdrawals can only pay the **subject's own** token account for
  the market's collateral mint (mint + owner checked in-handler before any
  transfer).
- The delegation is revocable at any time by the subject alone, takes effect
  immediately, and the 97-byte record makes the delegation state trivially
  observable off-chain (SDK `decodeOperator`; `GET /me` reports the operator).

## Dependencies

- Inbound: `lib.rs` (`set_operator`, the seven `operator_*` handlers).
- Outbound: `operator` (`authorized`), `constants` (`OPERATOR_SEED`), `state`
  (`Operator`, `PerpMarket`, `UserCollateral`, `Position`), `collateral` /
  `positions` / `orderbook` / `settlement` (the shared core logic each mirror
  reuses), `error` (`OperatorUnauthorized`, `OperatorPdaSquatted`),
  `anchor-spl` (`token::transfer` with the delegate/PDA signers).

## Patterns & Gotchas

- **Additive surface** — the direct user-signed instructions are unchanged; the
  operator path adds a signer matrix, not a replacement.
- **Pure predicate, thin adapter** — `operator::authorized` is a plain boolean
  over six keys (no Anchor plumbing), property-tested directly; the handlers
  apply it to the on-chain record.
- **Never closes the record** — revoke writes the default key; the PDA stays
  rent-exempt and re-bindable in place.
- **Payer = operator signer** for lazily-created subject accounts (`Position`,
  `UserCollateral`) on the operator paths; the direct paths keep the user as
  payer.
- **Byte-level PDA discipline** — record / ledger / position PDAs are
  seed-derived and byte-checked, so the operator can only ever act on the
  subject's own accounts.
