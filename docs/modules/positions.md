# Module: Position Lifecycle (open/close long & short)

**Purpose:** The trading engine of Fructus — a per-`(market, user, side)`
`Position` account opened and closed through the #3 CLOB (`open_position` /
`close_position`), plus a permissionless `settle_fill` that books resting
makers' fills from the event queue. The lifecycle is **order-driven**: orders
are the only way positions change, and positions result from matched fills.
Margin is **ledger-only** — `Position.collateral` is reserved inside
`UserCollateral.reserved`, so the #4 `free_collateral` seam gates every open
and every withdrawal — and PnL is a pure signed function realized into
collateral by the permissionless `settle_close` (see
[settlement.md](settlement.md)). `close_position` stays **lifecycle-only** (D4):
it records the closed notional for `settle_close` but never realizes PnL itself.
All arithmetic is `u64`/`u128`/`i128` + `checked_*`/`saturating_*`; the
property-testable logic lives in the pure `crate::positions` module (mirroring
`orderbook.rs` / `collateral.rs`).

## Public API

| Instruction | Signature | Description |
| --- | --- | --- |
| `open_position` | `(side: u8, size: u64, price: u64)` | Open (or add to) a position: place a limit order (`price != 0`, rests if non-crossing) or market-IOC order (`price == 0`); taker fills settle inline |
| `close_position` | `(side: u8, size: u64)` | Reduce/close the named side with a market-IOC order on the **opposite** side; lifecycle-only — records `closed_notional` but does **not** settle PnL |
| `settle_fill` | `(seq: u64)` | Permissionless: book one resting maker's `Fill` from the event queue (open-intent, idempotent) |
| `settle_close` | `()` | Permissionless: realize the signed PnL of `closed_notional` into collateral (see [settlement.md](settlement.md)) |

| Pure function | Signature | Description |
| --- | --- | --- |
| `margin_required` | `(notional: u64, initial_margin_bps: u16) -> Option<u64>` | `(notional × bps + 9_999) / 10_000` — **ceiling** division, `u128` intermediates; `None` only on overflow (total on its domain) |
| `accumulate_entry` | `(cur_n_sum: u128, cur_d_sum: u128, add_n: u64, add_d: u64, add_w: u64) -> Option<(u128, u128)>` | Accumulate the entry running sums: `cur_n_sum += add_n × add_w`, `cur_d_sum += add_d × add_w` (checked) |
| `normalize_sums` | `(entry_n_sum: u128, entry_d_sum: u128) -> (u64, u64)` | Shared power-of-two shift (`k = max(0, bitlen(max) − 45)`); the larger sum lands in `[2^44, 2^45)` |
| `signed_yield_change` | `(entry_n_sum: u128, entry_d_sum: u128, cur_n: u64, cur_d: u64) -> Option<i128>` | `(rate_cur / rate_entry − 1) × APY_SCALE` **with sign**, cross-multiplied; `None` on degenerate inputs |
| `pnl` | `(entry_n_sum, entry_d_sum, cur_n, cur_d, notional: u64, side) -> Option<i128>` | `notional × signed_yield_change / APY_SCALE × (+1 Long, −1 Short)`, signed USDC microunits, truncating toward zero |
| `apply_pnl` | `(deposited: u64, pnl: i128) -> Option<u64>` | Add signed PnL to `deposited`: a profit credits (`None` only on a positive overflow); a loss debits **clamped at `0`** so `deposited` never goes negative (the vault is never insolvent — R-S3). This is the **per-account** ledger primitive; settlement wiring (winner paid only up to the collected pool, remainder → `claimable`) goes through the Design A pool `settlement::settle_signed` — never call `apply_pnl` directly on a winner's ledger (the original minting bug) |
| `validate_open_args` | `(side: u8, size: u64) -> Result<()>` | `side` must be `0`/`1` (`ProgramError::InvalidInstructionData` otherwise — the existing `side_from_u8` behavior, no `InvalidSide` variant), `size > 0` (`InvalidSize`) |

## The `Position` account

One PDA per `(market, user, side)`, seed
`[POSITION_SEED, market.key(), user.key(), side]` with
`POSITION_SEED = b"position"`. The `side` byte reuses the book-side encoding —
`0` = Long/Bid, `1` = Short/Ask — so a user may hold long **and** short
simultaneously and `close_position(side)` names its target. Payload (borsh,
after the 8-byte discriminator): `market` (32) · `owner` (32) · `side` (1) ·
`notional` (8) · `entry_n_sum` (16) · `entry_d_sum` (16) · `collateral` (8) ·
`last_funding_epoch` (8) · `closed_notional` (8) · `closed_entry_n_sum` (16) ·
`closed_entry_d_sum` (16) · `open_slot` (8) · `bump` (1),
`LEN = 170`. Full field-level offsets in [data-models.md](../data-models.md).

- Lazily created on first fill/settlement (payer = the user for inline taker
  fills, the settler for `settle_fill`) and **retained** after a full close;
  `notional == 0` means closed.
- A re-open (from `notional == 0`) **resets** `entry_n_sum` / `entry_d_sum` /
  `open_slot` and **re-bases `last_funding_epoch`** to the re-open epoch — the
  new fill becomes the fresh entry and funding never accrues over the closed
  interval — but **leaves `closed_entry_n_sum` / `closed_entry_d_sum` intact**
  so the pending `closed_notional` keeps its own (close-time) entry basis.
  Same-side adds on a live position accumulate the entry sums.
- The account is a plain borsh `#[account]` (well under the 4 KiB zero-copy
  threshold), so it declares native `u128` fields — no per-access byte
  conversion.
- Compare pubkeys at byte level (`as_ref()`/`to_bytes()`), per AGENTS.md.

## Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Closed: no fills yet
    Closed --> Open: open_position / settle_fill (first fill)
    Open --> Open: same-side fills (entry sums accumulate)
    Open --> Closed: close_position (notional → 0)
    Closed --> Open: re-open (entry sums + open_slot reset)
```

1. **Open** — `open_position(side, size, price)`: validate args; read the index
   snapshot from the market-bound `index_source`; load the book; place a limit
   order (`price != 0`, rests if non-crossing) or market-IOC order (`price ==
   0`). Taker fills settle **inline** (the taker's accounts are always in the
   tx): lazy-create the `Position`, `notional += size`, entry sums accumulated,
   margin reserved against free collateral. Every `Fill` event is stamped with
   the in-tx snapshot and `settled = 0` for the maker's later settlement.
2. **Close** — `close_position(side, size)`: require `size > 0`
   (`InvalidSize`), `notional > 0` (`PositionNotFound`), and `size <= notional`
   (`InvalidCloseSize`); place a **market-IOC order on the opposite side**.
   Taker fills reduce the position (`notional -= size`, entry unchanged, margin
   released) and **add `size` to `closed_notional`** (R-S1). Still **no PnL
   settlement** — the lifecycle is closed but the profit/loss stays unrealized
   until a later `settle_close`.
3. **Maker settlement** — `settle_fill(seq)`: locate `slot = seq %
   EVENT_QUEUE_LEN`; if the slot holds a `Fill` with `event.seq == seq` and
   `settled != 0`, return `Ok` (idempotent no-op); otherwise require
   `event.seq == seq`, `kind == Fill`, `settled == 0`; derive the maker's
   `Position` PDA from `event.owner` + `event.side` and verify the supplied
   accounts (a mismatch fails with `ProgramError::InvalidAccountData`); apply
   **open-intent** (below); mark `settled = 1`.
4. **Crank & book-only orders** — `place_limit_order` / `place_market_order` /
   `crank` gain the market-bound `index_source` (readonly) purely to **stamp**
   fills; they never touch a taker's position. Residuals originate only from
   position-neutral `place_limit_order` (D10′), so the crank takes **no
   position accounts** and never settles positions.
5. **Position settlement** — `settle_close()` (R-S2/R-S3): if
   `closed_notional > 0`, realize the **signed** index-based PnL over that
   notional through the Design A PnL pool (via `positions::pnl` +
   `settlement::settle_signed`: a loss is collected into `PerpMarket.pnl_pool`,
   a profit is paid only up to the pool, the remainder becomes `claimable`) and
   reset `closed_notional = 0`. See
   [settlement.md](settlement.md) for the flow; `closed_notional == 0` is an
   idempotent no-op.
6. **Funding & liquidation** — `settle_funding` accrues signed funding over the
   full elapsed epochs (see [funding.md](funding.md)); `liquidate(side, amount)`
   enforces the **account-level** maintenance-margin floor — the account's
   `equity = deposited + Σ upnl` (both sides) against the summed maintenance
   requirement — and transitions only the targeted side (see
   [liquidation.md](liquidation.md)).

### Open-intent maker settlement (D5)

A resting order is unambiguous — a resting bid ⇒ open long, a resting ask ⇒
open short — so the `Fill` event needs **no intent tag**. `settle_fill`
therefore applies open semantics to the maker's position:

- maker's position closed (`notional == 0`) ⇒ **re-open**: `entry_* :=` the
  **event-carried** fill-time snapshot weighted by `event.size`,
  `open_slot :=` the current slot;
- otherwise `notional += size` and the entry sums **accumulate the
  event-carried** snapshot (not the settlement-time rate — D7);
- margin reserved against the maker's free collateral;
- mark `settled = 1`.

Retryable on margin shortfall: the atomic revert leaves the event un-settled.
Resting closes are deferred to a later iteration (they would need an intent
tag), so only open-intent orders rest.

## Margin math (D11)

Reserved collateral is **ledger-only** — no token movement on open or close:

```
margin_required(notional, im_bps) = (notional × im_bps + 9_999) / 10_000   (ceiling, u128)
Position.collateral              = margin_required(notional, market.initial_margin_bps)
UserCollateral.reserved          = Σ Position.collateral  over (long, short)
free                             = deposited − reserved   (the #4 seam — never negative)
```

The ceiling division keeps `collateral ≥ 1` for every `notional ≥ 1`,
`bps ≥ 1`, and implied leverage `notional / collateral ∈ [1, 10_000 / bps]`
exactly — margin is never below the exact requirement. Pinned properties:
monotonic in `notional`; `margin_required(0, _) == 0`; `margin_required(n,
10_000) == n` (exact 1×). Every open (`open_position`, `settle_fill`) and every
withdrawal checks the same `free_collateral` predicate, so a margin shortfall
fails the whole transaction atomically — including a missing `UserCollateral`
ledger, which reports `InsufficientFreeCollateral` (the ledger is
deposit-created, so a missing ledger is a free-collateral error, not an
account-format error).

**Requirement vs equity (product-v2 A2).** `reserved = Σ_side m(n_side,
initial_margin_bps)` is the *requirement* half; the *equity* half is
`equity = deposited + Σ_side upnl` (signed, index-based). Two account-level
gates compare them:

- the **withdraw equity gate** — a withdrawal must leave `equity − amount ≥
  reserved` (else `InsufficientFreeCollateral`; see
  [collateral.md](collateral.md)); and
- the **liquidation trigger** — the account is liquidatable iff it has exposure
  and `equity < Σ_side m(n_side, maintenance_bps)`, strict (see
  [liquidation.md](liquidation.md)).

Margin *reservation itself* stays per-position: both sides' ceilings sum into
`reserved`, and a liquidation transitions only the targeted side while
preserving that sum.

## Entry index & PnL (D6/D12)

The entry index is stored as **notional-weighted running sums** (`entry_n_sum`
/ `entry_d_sum`, `u128`) — exact average-cost accounting with no intermediate
rounding; the entry rate lies strictly between the component fill rates
(weights `fill_size × d_component`). The snapshot rate is
`entry_n_sum / entry_d_sum`, computed at PnL time after a shared power-of-two
normalization (`normalize_sums`: `k = max(0, bitlen(max) − 45)`, the larger sum
lands in `[2^44, 2^45)`), because the raw sums are O(pool size × cumulative
notional) and their direct cross-products overflow `u128` for production LST
pools. The ratio's relative error is bounded by `2^-44 × (1 + max/min)` — at
most ~`2^-34` in the production rate band `[1, 1e3]`, far below `APY_SCALE`'s
1e-6 granularity.

PnL is a **pure signed** function (USDC microunits, `i128`):

```
signed_yield_change = ((cur_n × d_e) − (n_e × cur_d)) × APY_SCALE / (n_e × cur_d)   (sign from the numerator)
pnl = notional × signed_yield_change / APY_SCALE × side                              (+1 Long, −1 Short)
```

Truncation toward zero gives the quantization floor: `pnl == 0` whenever
`notional × |signed_yield_change| < APY_SCALE`. Realizing PnL into
`UserCollateral` is `settle_close` (see [settlement.md](settlement.md)); this
module only computes it (with sign tests: `pnl(Long) > 0 ⟺ rate_cur >
rate_entry`, `pnl(Short)` the exact opposite).

### `closed_notional` + `apply_pnl` (R-S1/R-S2/R-S3)

`close_position` stays lifecycle-only (D4) but **records** every closed fill in
`Position.closed_notional` (`closed_notional += size`, in `apply_close_fills`)
and settles nothing. Since entry running sums are left unchanged on close, the
closed notional's PnL is still determinable from the entry index + the current
rate; `apply_close_fills` additionally **accumulates** the **close-time** entry
basis into `closed_entry_n_sum` / `closed_entry_d_sum` (via
`positions::accumulate_closed_entry`, a **notional-weighted harmonic mean** of
each closed generation's basis), so a re-open (which resets the live `entry_*`)
never reframes a prior closed amount, and a sequence of closes interleaved with
re-opens prices **each** closed generation at **its own** close-time basis.
`settle_close` reads `closed_notional` and, if `> 0`, applies the Design A
PnL-pool routing ([settlement.md](settlement.md)):

```
pnl        = pnl(closed_entry_n_sum, closed_entry_d_sum, cur_n, cur_d, closed_notional, side)  (signed i128)
(deposited', claimable', pool') = settlement::settle_signed(deposited, claimable, pnl_pool, pnl)
// pnl <= 0: apply_debit(deposited, pool, |pnl|)  -> loss collected into the pool (clamped at 0)
// pnl >  0: apply_credit(deposited, claimable, pool, pnl) -> paid = min(pnl, pool); remainder -> claimable
```

`positions::apply_pnl` remains the **pure single-ledger** transition (a profit
credits unbounded, a loss is clamped at `0`); it is deliberately NOT the wiring
`settle_close`/`settle_funding` use anymore — the counterparty-netted
`settlement::settle_signed` is (the Design A fix). `apply_pnl`'s contract:
- `pnl == 0` ⇒ `Some(deposited)` — settled but unchanged.
- `pnl > 0` ⇒ `deposited + pnl`, `None` only on a positive `u64` overflow.
- `pnl < 0` ⇒ `deposited − |pnl|`, **clamped at `0`** so `deposited` never goes
  negative (R-S3). A loss never returns `None`.

`Position.closed_notional` is reset to `0` by `settle_close`; `Position
.last_funding_epoch` is advanced by `settle_funding`.

## Settlement flow

```mermaid
graph LR
    T[taker open/close] -->|inline fills| TP[Taker Position]
    T -->|Fill event + fill-time snapshot, settled=0| R[(event ring)]
    S[settle_fill seq] -->|re-reads Fill at seq % 32| R
    S -->|open-intent, event-carried snapshot| MP[Maker Position]
    S -->|margin reserved| UC[UserCollateral.reserved]
    S -->|settled = 1| R
```

- **Taker-inline**: a taker's fills settle in the taker's own `open_position` /
  `close_position` transaction — the taker's `Position`/`UserCollateral`
  accounts are always in the tx.
- **Maker-deferred**: a resting maker's identity is unknown at tx-build time, so
  `settle_fill` re-reads the `Fill` event and the caller supplies the maker's
  accounts, verified by PDA derivation against `event.owner` + `event.side`.
- **Snapshot discipline**: every fill-producing instruction (the five —
  `open_position`, `close_position`, `place_limit_order`, `place_market_order`,
  `crank`) validates that `index_source` **byte-equals** `market.index_source`
  (plus stake-pool owner/discriminator validation) and reads the snapshot once
  per tx (same slot ⇒ same rate), stamping it verbatim onto every `Fill` it
  emits. `settle_fill` itself is not fill-producing and takes no `index_source`.
- **Idempotency**: `settled` flips to `1` on consumption; a second
  `settle_fill` on the same `seq` is a no-op.
- **Separate close settlement path**: a taker's `close_position` reduces
  `notional` and adds to `closed_notional` inline, but realizes nothing; the
  maker's `settle_fill` is open-intent only. The realized (index-based) PnL of
  closed notional is settled by the later permissionless `settle_close` read
  against the live stake-pool index — never the mark oracle.

## Liveness bound (OQ-1)

An executed fill **always persists its event**: a full event ring fails the
fill-producing transaction with `BookFull` (D10) — fills are never silently
dropped, so a maker can always in principle settle. But an un-settled `Fill` is
settle-able only while its ring slot survives: the 32-entry ring holds the 32
**newest** events, so a maker has at most 32 newer events before its `Fill` is
overwritten and `settle_fill` fails `EventNotFound`. Accepted MVP bound — the
per-position settlement ledger is the over-engineering alternative. In
practice: `settle_fill` promptly (or crank first to drain), and retry on
`EventNotFound` is not possible once overwritten.

## Dependencies

- Inbound: `lib.rs` (`open_position`, `close_position`, `settle_fill`,
  `settle_close`; `settle_funding` / `liquidate` consume the `Position` /
  `UserCollateral` accounts; `place_*`/`crank` only consume the `index_source`
  stamping).
- Outbound: `positions` (pure margin/entry/PnL logic), `constants`
  (`POSITION_SEED`, `EVENT_QUEUE_LEN`, `APY_SCALE`, `MAX_MATCH_STEPS`), `error`
  (`PositionNotFound`, `EventNotFound`, `InvalidCloseSize`, reused
  `InvalidSize`/`InsufficientFreeCollateral`/`BookFull`), `state` (`Position`,
  `UserCollateral`, `PerpMarket`, `OrderBook`, `OutEvent`), `orderbook`
  (matching engine), `collateral` (`free_collateral`), `exchange`
  (`ExchangeRate::read` via the stake-pool validation in `lib.rs`).

## Patterns & Gotchas

- **Pure logic, thin adapter** — `positions.rs` works on plain
  `u64`/`u128`/`i128` values so `proptest` drives the invariants directly;
  `lib.rs` applies them to the on-chain `Position`/`UserCollateral` accounts.
- **Order-driven** — positions only change through matched fills; there is no
  direct position mutation instruction.
- **Close is lifecycle-only** — it reduces `notional`, releases margin, and
  records `closed_notional`, but never realizes PnL; the permissionless
  `settle_close` owns settlement (see [settlement.md](settlement.md)).
- **`closed_notional` is the settlement seam** — entry sums are left unchanged on
  close, so the closed notional's signed PnL is re-derivable from the entry
  index + the current rate; `apply_close_fills` **accumulates** the **close-time**
  basis into `closed_entry_*` as a notional-weighted harmonic mean (each closed
  generation at its own basis; a re-open never reframes it); `apply_pnl` clamps
  a loss at the deposited balance.
- **Entry sums reset on re-open** — from `notional == 0`, the new fill's
  snapshot replaces the sums, `open_slot` is reset to the settlement slot
  (maker re-opens) or the fill slot (inline taker opens), and
  `last_funding_epoch` is re-based to the re-open epoch.
- **`price == 0` is the market signal** for `open_position`, so it has no
  `InvalidPrice` path (unlike `place_limit_order`).
- **Fill events carry the fill-time snapshot, not the settlement-time rate** —
  stamping happens once per tx at the taker's/cranker's index source, and
  `settle_fill` re-reads the event rather than re-reading the pool.
- **Byte-level pubkey compare** per AGENTS.md — no type-identity dependence in
  the PDA-verification checks.
