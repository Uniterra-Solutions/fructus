# Fructus — Solana yield-futures protocol (on-chain order book + collateral vault)

## Build & Test

- `cargo nextest run --workspace` — the Rust suite (lib invariants + bank-style CPI
  tests). Default runner: one process per test, so the bank suites run in parallel —
  roughly half the wall clock of `cargo test` here. Profile pinned in
  `.config/nextest.toml` (no fail-fast, no retries, slow tests marked not killed)
- `cargo nextest run -E '<filter>'` — subset (`-E 'binary(positions_cpi)'`,
  `-E 'test(funding)'`); a bare positional arg matches test names (`cargo nextest run funding`)
- `cargo test --workspace` — fallback runner (same assertions, slower); the only thing it
  adds is doctests, and this workspace has none
- `PROPTEST_CASES=100000 cargo nextest run --workspace` — property sweep; every block
  declares its own local budget (`#![proptest_config(...)]`: **64 cases**, 20 for the bank
  CPI block) and the shrink budget is bounded repo-wide in `.cargo/config.toml` (≤1024
  iterations / 5 s) — an env var you export beats both
- Local dev/test builds carry **no debug info** (`[profile.dev] debug = false` in
  `Cargo.toml`): the link step and `target/` shrink a lot; backtraces keep symbol
  names but lose line numbers
- `anchor build` — compile program to `.so` (needs `cargo-build-sbf`); rebuild before
  running CPI tests — `tests/collateral_cpi.rs` loads the SBF binary and a stale
  `.so` fails the `cpi_binary_is_present_and_fresh` guard. Build with **platform-tools
  v1.52**: `anchor build` picks it, while a bare `cargo build-sbf` installs the newer
  default (v1.54) — and rustup keeps only one SBF toolchain, so it *replaces* the good
  one and the bank then traps (`Access violation in unknown section` out of
  `initialize_market`). The fuzzer reads its own copy at `target/deploy-v0/fructus.so`
  (`Trident.toml`; TridentSVM executes SBPFv0 only) — stage both with
  `cargo build-sbf --arch v0 --tools-version v1.52 --sbf-out-dir target/deploy-v0`
  plus a `cp` into `target/deploy`. Devnet takes **SBPFv3** (SIMD-0500) and
  `scripts/deploy.sh` overwrites `target/deploy` with one, so rebuild the v0
  artifact before the bank suites. CI pins the same flags (docs/testing.md)
- `cd publisher && npm test` — publisher suite (8 tests, cross-language vector)
- `cd sdk && npm test` — trader SDK suite (52 tests; funding/PnL/layout vector)
- `cd cli && npm test` — trader CLI suite (16 smoke + R-1 regression)
- `cd scripts && npm run e2e` — offline devnet lifecyle dry-run (`RUN_E2E=1` = live)
- `cd scripts && npm run setup` — self-contained devnet bootstrap: wallets +
  airdrop SOL + self-owned collateral mint + own SPL stake pool (`INDEX_SOURCE`),
  then validate + print the e2e env (`--preflight` = check only)
- `cd scripts && npm run devstack` — one-command LOCAL stack: `solana-test-validator` +
  market/book/vault init + collateral mint + funded operator/MM keys; prints
  copy-paste env blocks for the server and the MM bot (runs until SIGINT)
- `cd scripts && npm run mm` — market-maker bot against the devstack (needs
  `RPC_URL` + `MM_KEYPAIR` from the devstack output)
- `cd integration && npm test` — SDK/CLI -> protocol integration PBT: drives the
  real program (solana-test-validator + SDK builders) and asserts on-chain
  invariants (`--test-force-exit`)
- `cd server && npm test` — product-v2 backend suites (`api`, `auth`, `indexer`,
  `keeper`, `ws`, …) plus the product-v3 set (`fill-time`, `candles`,
  `market-trades`, `kline-e2e`, `ws-trade`, `keeper-settle`); validator-backed —
  run sequentially (`--test-concurrency=1`, as CI does)
- `cd frontend && npm test` — product-v3 trading terminal suite (vitest + jsdom);
  `npm run typecheck` and `npm run build` sit beside it
- `cd trident-tests && cargo run --bin fuzz_0` — on-chain stateful fuzz smoke run
  (1000 iterations × 100 flows; needs its SBPFv0 artifact at `target/deploy-v0` —
  `--bin market` still aborts at start-up; docs/testing.md has the build command)
- `cargo fmt --check` — format check (the pre-commit hook runs `cargo fmt --all` for you)
- `.github/workflows/ci.yml` — `cargo fmt --check` and `cargo clippy --workspace
  --all-targets -- -D warnings` gates, the lib suites split per module, and separate
  jobs for the bank CPI suites / TS packages / validator e2e / Trident fuzz (all
  sharing one SBF `.so` build artifact)
- Git hooks: `git config core.hooksPath .githooks` (once per clone) enables the
  pre-commit `cargo fmt --all` hook

## Tech Stack

- **Language**: Rust (MSRV 1.89) + TypeScript (ESM, Node ≥ 18)
- **Framework**: anchor-lang 1.2.0 / anchor-spl 1.2.0
- **Solana crates**: `solana-sdk-ids` 3.1, `solana-instructions-sysvar` 3.0, `sha2` 0.11,
  `bytemuck` 1.17 (zero-copy accounts)
- **npm deps (publisher/sdk/cli/scripts/server/frontend)**: `@solana/web3.js` ^1.95, `tsx`;
  frontend: React 19 + Vite + Tailwind v4 + `lightweight-charts` v5
- **Testing**: `proptest` 1, `solana-instruction` 3.0 (dev), `solana-program-test` 3.1 (dev), Trident 0.12
- **Package managers**: cargo (root + `trident-tests/`) and npm (`publisher/`, `sdk/`, `cli/`,
  `scripts/`, `server/`, `frontend/`)

## Project Structure

- `programs/fructus/src/` — on-chain Anchor program: oracle (`state`, `ed25519`),
  settlement (`exchange`), CLOB order book + mark/twap (`orderbook`), collateral vault
  (`collateral`), position lifecycle (`positions`), **funding engine (`funding`)**,
  **liquidation engine (`liquidation`)**, top-level instructions (`lib`), pure-logic
  invariants + adversarial review invariants (`tests`, per-module `#[cfg(test)]`)
- `programs/fructus/tests/` — bank-style CPI integration tests (`collateral_cpi.rs`, `positions_cpi.rs`)
- `publisher/` — off-chain TypeScript APY keeper (fetch → sign → submit)
- `sdk/` — trader TypeScript SDK (instruction builders, typed account decoders, funding/PnL mirrors)
- `cli/` — trader CLI over the SDK (open/close/deposit/withdraw/position/funding/mark/index)
- `server/` — product-v2 backend: indexer, state, SIWS auth, operator relay, keeper (incl. the
  product-v3 settle-fill sweep), REST + WS API (product-v3: candles/trades reads + `trade` push)
- `frontend/` — product-v3 trading terminal: Vite + React + TS + Tailwind (dark theme, bilingual,
  lightweight-charts v5) — see [frontend/README.md](frontend/README.md)
- `scripts/` — devnet deploy + e2e lifecycle (`deploy.sh`, `e2e.mts`), local devstack + MM bot
  (`devstack.mts`, `mm-bot.mts`/`mm-lib.mts`), `Anchor.toml` devnet profile
- `trident-tests/` — fuzz harness (separate cargo workspace)
- `docs/` — documentation hub ([docs/README.md](docs/README.md))
- `target/`, `*/node_modules`, `*/dist/`, `.review/` — build/review artifacts (gitignored)

## Key Constraints

- **Never depend on the `solana-program` umbrella crate** — use granular 3.x crates.
  Compare pubkeys at byte level (`as_ref()` / `to_bytes()`), not by type (anchor 1.x
  "Address" migration makes the types version-fragile).
- **Fixed-point APY/yield scale is `1_000_000`** (`APY_SCALE`); use `u128` + `checked_*`
  / `saturating_*` arithmetic — no panicking math. **Funding / premium / realized PnL are
  signed half the time: use `i128` + `checked_*`/`saturating_*`**, never `u128`/`saturating`.
- **Funding sign convention**: `premium = mark − index`; `funding_rate =
  clamp(funding_k·premium/APY_SCALE, ±max_funding)`; `premium > 0 ⇒ **longs pay shorts**`
  (long flow `−1`, short flow `+1`, exact opposites). Epoch = `slot / funding_epoch_slots`;
  settlement is idempotent (same epoch ⇒ no-op).
- **Design A no-mint invariant** — all PnL/funding settlement goes through
  `programs/fructus/src/settlement.rs`: a loser's debit is **collected** into
  `PerpMarket.pnl_pool` (clamped at `deposited`), a winner is paid **only up to
  the pool** (`min(credit, pool)`), and the unfunded remainder becomes a
  **pending claim** (`UserCollateral.claimable`, never directly withdrawable —
  only via `claim_payout` at deposit/withdraw). `pool ≥ 0` ⟺ `Σ deposited ≤
  vault real balance` (no mint); `liquidate` also books the victim's realized
  loss into the pool, capped at `deposited − reserved_after − reward` (never
  touches other positions' reserved backing; reward payable first).
  `positions::apply_pnl` stays a per-account pure transition — **never wire it
  directly onto a winner's ledger** (that is the original minting bug).
- **Position collateral invariant** = `position.collateral ==
  margin_required(notional, initial_margin_bps)`, maintained on open
  (`apply_open_fills`), close (`apply_close_fills`), **AND** liquidate
  (`apply_liquidation` re-derives the surviving collateral at the initial margin
  ratio). `maintenance_margin_bps` is the health threshold (`liquidatable`, strict
  `<`), never the release ratio. Any liquidation change must keep the surviving
  collateral equal to `margin_required(notional − amount, initial_margin_bps)` and
  never create value (`remaining + reward ≤ position_collateral`). A fully
  liquidated (`notional == 0`) position holds **zero** collateral.
- **Liquidation reward is zero-sum**: the `liquidate` handler **debits** the
  victim's `UserCollateral.deposited` by the reward and credits the liquidator's
  by the same amount (the reward is drawn out of the victim's released margin,
  `reward ≤ position_collateral − remaining`), so Σ `deposited` across victim +
  liquidator is conserved — a liquidation never mints collateral.
- **Close is priced at its own (close-time) entry basis**: `apply_close_fills`
  captures `closed_notional`'s basis into `closed_entry_n_sum` /
  `closed_entry_d_sum`; `settle_close` prices it against those (never the live
  `entry_*`, which a re-open resets). A re-open also **re-bases
  `last_funding_epoch`** to the re-open epoch so funding never accrues over a
  closed interval. `Position::LEN = 170`; any layout change must be mirrored in
  `sdk/src/account/{layout,decode}.ts` + `docs/{data-models,modules/positions,
  modules/settlement}.md`.
- **Canonical signed message** = `sha256("fructus::update_apy" ‖ oracle ‖ apy_le ‖ version_le)`.
  Rust `update_message` and TS `updateMessage` must stay byte-identical; any change
  updates the cross-language vector test on both sides.
- **Cross-language funding/PnL mirrors** — `sdk/src/{funding,positions,mark-index}.ts`
  and `cli` must stay byte-identical to Rust `funding.rs`/`positions.rs`/`orderbook.rs`
  (sign, clamp, truncate-toward-zero, annualize, `mid().unwrap_or(index)` fallback).
- **`trident-tests/fuzz_0/{types.rs,fuzz_accounts.rs}` are generated** — edit only
  `test_fuzz.rs`.
- Stake-pool offsets are 258/266 (with `account_type` prefix) — do not "fix" to 257/265.
- **Large accounts (> 4 KiB) must be `#[account(zero_copy)]`** — borsh deserialization
  overflows the SBF 4 KiB stack. Access via `AccountLoader::load_mut()`/`load_init()`
  (no `.exit()`); sub-structs use `#[zero_copy]` with `#[repr(C)]`, reordered fields +
  explicit `_pad` (bytemuck `Pod` forbids implicit padding); `bool` → `u8`, `u128` →
  `[u8; 16]`.
- **`OrderBook` must stay under the 10 KiB per-tx data-growth cap**
  (`MAX_PERMITTED_DATA_INCREASE`) — `initialize_order_book`'s inner-CPI allocation
  fails with `InvalidRealloc` for a larger account (breaks on-chain init; the bank
  CPI tests seed the account manually to avoid it). Current layout:
  `MAX_ORDERS_PER_SIDE = 16`, `EVENT_QUEUE_LEN = 32`, `TWAP_OBSERVATIONS = 16` →
  `OrderBook::LEN = 6_232` (account = `8 + LEN = 6_240` B). Any capacity/size change
  must keep `8 + OrderBook::LEN ≤ 10_240` and be mirrored in `sdk/src/constants.ts` +
  `account/{layout,decode}.ts` + `docs/{data-models,modules/order-book}.md`.
- **Devnet deploy** — `scripts/deploy.sh` builds + deploys and records the program id /
  `PerpMarket` PDA; align `[programs.devnet]` with `declare_id!` (PDA derivation depends
  on the program id). A real deploy needs the program keypair + a funded devnet wallet.

## Testing

- Local runs go through `cargo-nextest` (`.config/nextest.toml`); `cargo test` is the
  fallback runner and the doctest runner (this workspace has no doctests). Both read the
  per-block prop-test budgets and the shrink limits below.
- Pure logic → `proptest` invariants in `programs/fructus/src/tests.rs` and the per-module
  `#[cfg(test)]` (funding/liquidation/positions/collateral); the adversarial-review probes live
  in those same per-module `#[cfg(test)]` blocks and in `tests.rs`.
- Case budget is declared **per block** (`#![proptest_config(ProptestConfig::with_cases(64))]`
  is the local default; the bank CPI block uses 20 because each case drives a bank for
  ~2 s). Shrink limits are repo-wide in `.cargo/config.toml`
  (`PROPTEST_MAX_SHRINK_ITERS` / `PROPTEST_MAX_SHRINK_TIME`). One run can override
  everything through the `PROPTEST_*` env vars (`PROPTEST_CASES=100000 cargo test`).
- Signature verification → mock instruction sysvar (`construct_instructions_data`).
- Cross-language consistency → shared hex vector (Rust + TS) + SDK/cli vector tests.
- Stateful on-chain → Trident `trident-tests/`.
- Vault CPI / bank-style → `solana-program-test` in `programs/fructus/tests/` (needs a
  freshly built `.so`).

## Git Workflow

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- Commit in dependency order: `docs:`/`chore:` → `refactor:` → `feat:`/`fix:` → `test:`.

## Documentation

- `docs/` — architecture, modules, API, data models, setup, testing, workflows
  ([docs/README.md](docs/README.md)).
- Keep "one home per fact": root `README.md` links in; it does not duplicate deep content.
- Mark inferred rationale `[INFERRED]` — never present inference as fact.

## Boundaries

**Always:**

- Run `cargo nextest run --workspace` before committing program changes (and `anchor build`
  so the CPI guard stays green).
- Add/adjust property tests for any changed pure logic (`proptest`).
- Keep the cross-language message vector (oracle) and the funding/PnL mirrors in sync
  across Rust + TypeScript.

**Ask first:**

- Adding new Solana/Anchor dependencies (version-sensitivity is high).
- Changing the stake-pool offsets or the canonical message format.
- Deploying/upgrading the program or rotating the publisher key.

**Never:**

- Commit `.env`, keypairs (`*.keypair.json`), `target/`, `dist/`, `.review/`, or secrets.
- Edit generated files (`trident-tests/fuzz_0/types.rs`, `fuzz_accounts.rs`).
- Skip pre-commit hooks with `--no-verify` without explicit request.
