# Testing

## Frameworks

| Layer | Tool | Location |
| --- | --- | --- |
| Property-based (pure logic) | `proptest` | `programs/fructus/src/tests.rs` + per-module `#[cfg(test)]` |
| Signature verification (e2e) | mock instruction sysvar | `programs/fructus/src/tests.rs` |
| Cross-language vector | `node:test` | `publisher/test/message.test.ts` |
| On-chain stateful fuzz | Trident | `trident-tests/fuzz_0/test_fuzz.rs` |

## Commands

```bash
cargo nextest run --workspace             # default: full Rust suite (process-per-test)
cargo nextest run -E 'binary(positions_cpi)'   # one suite (bank CPI in this example)
cargo nextest run funding                 # name filter (substring)
cargo test --workspace --lib              # fallback runner, same assertions, slower
PROPTEST_CASES=100000 cargo nextest run --workspace   # property sweep (local default: 64)
cd publisher && npm test                  # TS suite (8 tests)
cargo build-sbf --arch v0 --tools-version v1.52 --sbf-out-dir target/deploy-v0   # fuzz artifact
cp target/deploy-v0/fructus.so target/deploy/fructus.so    # ... and for bank/e2e
cd trident-tests && cargo run --bin fuzz_0   # fuzz (1000 iters × 100 flows)
```

## Runner

`cargo-nextest` is the default runner ([install](setup.md#prerequisites)); `cargo test`
stays the fallback and is the only runner that executes doctests (this workspace has
none). Nextest gives every test its own process and runs the six test binaries in
parallel instead of one after another, so the run tracks the slowest suite rather than
their sum. Both runners end up in the same place on this suite — the two bank property
tests (2 × 20 cases, each case building a whole `solana-program-test` bank) dominate the
wall clock either way; measured for the 14-test bank binary in one load window: 48.6 s
(nextest) against 54.4 s (`cargo test`), and `-j 2` is worse (62 s), so keep the default
parallelism. What nextest adds is isolation plus legible failures: one red run lists
every red (`fail-fast = false`), a real `leak`/`slow` marker instead of silence, and
`-E` filters that make a per-module run a one-liner.

| Concern | Where it is pinned |
| --- | --- |
| `fail-fast = false` (one red run shows every red), `retries = 0` (never hide flakiness), `slow-timeout = 120s` (mark, do not kill), `leak-timeout = "5s"` | [`.config/nextest.toml`](../.config/nextest.toml) |
| Property-test budgets (per block) and shrink limits | [`Cargo.toml`](../Cargo.toml) profiles + [`programs/fructus/src`](../programs/fructus/src) `#![proptest_config(...)]` + [`.cargo/config.toml`](../.cargo/config.toml) |

nextest inherits `.cargo/config.toml`'s `[env]` exactly like `cargo test`, so the
`PROPTEST_*` knobs behave identically under both. Useful flags: `cargo nextest list`
(enumerate), `--no-capture` (show test output), `-j N` (thread budget).

## Test inventory

Every suite and what it needs (the CI split in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) follows this table):

| Suite | Location | Tests | Needs |
| --- | --- | --- | --- |
| lib property/unit invariants | `programs/fructus/src/**` (`tests.rs` 87, `handlers_tests` 39, `positions` 30, `funding` 24, `liquidation` 21, `state` 9, `settlement` 8, `collateral` 7, `orderbook` 4, `operator` 1) | 230 | — |
| bank CPI · collateral vault | `tests/collateral_cpi.rs` | 6 | fresh `.so` |
| bank CPI · positions | `tests/positions_cpi.rs` | 18 (15 scenarios + 2 property tests × 20 bank cases + the freshness check) | fresh `.so` |
| bank CPI · operator delegation | `tests/operator_cpi.rs` | 8 (7 scenarios + the freshness check) | fresh `.so` |
| review suites | `tests/review_liquidation_{conservation,invariants}.rs` | 4 | — |
| review PBT · product-v2 | `tests/review_pbt_product_v2.rs` + `tests/review_bank_pbt_product_v2.rs` | 20 (15 pure + 5 bank) | fresh `.so` |
| server · product-v2 backend | `server/test` (functional + review files) | 100 | fresh `.so` + `solana-test-validator`; run with `--test-concurrency=1` |
| publisher (off-chain keeper) | `publisher/test` | 9 | — |
| trader SDK | `sdk/test` | 85 | — |
| trader CLI | `cli/test` | 19 | — |
| e2e lifecycle walk (offline dry run) | `scripts/e2e.mts` | walk | — |
| e2e through the real program | `integration/test` (spawns `solana-test-validator`) | 1 | `.so` + `solana-test-validator` |
| stateful fuzz · oracle | `trident-tests/fuzz_0` | 1000 iterations × 100 flows | `target/deploy-v0` `.so` (SBPFv0) |
| stateful fuzz · market | `trident-tests/market` | 10 iterations × 2 flows | `target/deploy-v0` `.so` (broken — see below) |

`declare_id!` pins the program id in `programs/fructus/src/lib.rs` — keep it in
lockstep with `Anchor.toml` (a mismatched id would break every PDA derivation).

**Totals as measured on 7 Oct 2026 (product-v2 verdict)** (`cargo nextest run --workspace` →
286 passed / 0 failed; `npm test` in `publisher/`, `sdk/`, `cli/` → 9 / 86 / 19; `server` →
100 passed): **286 Rust** (230 lib + 6 collateral bank + 18 positions bank + 8 operator bank +
4 review + 20 review PBT), **114 TypeScript** in the trader toolchain, and **100** in the
`server/` suite. Re-run the commands above if you quote these numbers anywhere; earlier
drafts of this table carried 251 Rust / 90 TypeScript, then 265 / 113.

One `.so` serves the bank suites, the validator e2e and the fuzz harness, but it lives
at two paths — `target/deploy/fructus.so` (bank + e2e; a stale one trips
`cpi_binary_is_present_and_fresh`) and `target/deploy-v0/fructus.so` (`Trident.toml`;
its TridentSVM executes SBPFv0 only):

```bash
cargo build-sbf --arch v0 --tools-version v1.52 --sbf-out-dir target/deploy-v0
cp target/deploy-v0/fructus.so target/deploy/fructus.so
```

`--tools-version` is the part that bites: the newer default (v1.54 at the time of
writing) emits a binary that the `solana-program-test` bank *and* TridentSVM fail on at
run time — `initialize_market` traps with

```
Program <id> failed: Access violation in unknown section at address 0x8 of size 48
```

which reads like a protocol bug but is a toolchain mismatch (the arch flag alone does
not fix it). Fingerprints: v1.52 + `--arch v0` → 543,760 B, bank green and `fuzz_0`
laps 1000 × 100 flows; v1.54 + `--arch v0` → 506,464 B, traps. The two builders install
different SBF rustc toolchains and rustup keeps only one, so a bare `cargo build-sbf`
*replaces* the one `anchor build` uses; CI pins the same flags in its `sbf` job.

Deployment is the third axis: current clusters accept **SBPFv3** only (SIMD-0500), so
`scripts/deploy.sh` rebuilds `target/deploy/fructus.so` with `--arch v3` right after
`anchor build` — re-run the block above before the bank suites, or a v3 artifact sits
where they load from.

CI splits the Rust suites per module (`cargo nextest run -E 'binary(fructus) and
test(/^funding::/)'`), gives the bank suites their own runners, and runs the TS suites
and the fuzz targets as their own jobs; `fmt` and `clippy --all-targets -- -D warnings`
gate every push. Reproduce one job locally by copying its `run:` line.

The `market` fuzz target does not run today: it aborts at start-up with a host stack
overflow (`thread '<unknown>' has overflowed its stack`, exit 134) before a single
iteration, and it is not a stack-size problem — a 1 GiB `RUST_MIN_STACK` changes
nothing, and the harness's own 64 MiB wrapper thread is not the one that dies. It is
not the artifact either: it still aborts on trident 0.13.0-rc.4 against the SBPFv0
build on which `fuzz_0` completes its 1000 × 100 flows. CI therefore runs it with
`continue-on-error`, so it stays visible without reddening the workflow; drop
`experimental: true` in the workflow once it is fixed.

## Property-test budget (local speed)

Every `proptest!` block declares its own case budget, so a block that drives the
real program inside a bank can stay cheap while the pure-logic blocks still get a
real sample:

| Where | Local default | Meaning |
| --- | --- | --- |
| `#![proptest_config(...)]`, per block | `64` cases | enough to surface a regression, cheap enough to run on save |
| `tests/positions_cpi.rs` (bank backend) | `20` cases | each case costs ~2 s of bank execution |
| `.cargo/config.toml` (`[env]`) | ≤ `1024` shrink iterations, ≤ `5000` ms | bounds counterexample minimisation repo-wide (proptest's own default is `4 × cases` with no time cap) |

An environment variable exported on the command line always wins over both, so a
deeper run — or one that minimises a failure to the bone — is a one-liner:

```bash
PROPTEST_CASES=100000 cargo nextest run --workspace                      # full sweep
PROPTEST_CASES=100000 cargo nextest run -p fructus -E 'test(/^settlement::/)'   # one module
PROPTEST_MAX_SHRINK_TIME=0 cargo nextest run -p fructus -E 'test(/^settlement::/)'  # shrink until done
```

Persisted failure seeds under `programs/fructus/proptest-regressions/` still
replay first and do not count towards the case budget.

## Invariants (property tests)

- Staleness predicate equals `cur.saturating_sub(last) >= window`; monotonic in `cur`.
- Version strictly increases; replay rejected.
- APY within `[0, 1_000_000]`.
- Canonical message deterministic + input-sensitive; matches a fixed hex vector.
- `ExchangeRate::read` round-trips; rejects zero supply / wrong discriminator.
- `realized_yield` self-yield == 0; monotonic in settle numerator.
- `annualize` identity when period == year; rejects zero period.
- `PerpMarket` init bounds: `funding_k` ∈ [1, 1_000_000]; `max_funding` ≤ 1_000_000;
  `initial_margin_bps` ∈ (0, 10_000]; `maintenance_margin_bps` ∈ (0, initial] —
  asserted as exact interval equivalence plus boundary edges.

## Signature verification (mock sysvar)

`verify_publisher_signature` is exercised end-to-end against a real serialized
instruction list (no validator needed): matching publisher accepted; wrong
publisher / wrong message / missing instruction rejected; unrelated ed25519
instructions skipped.

## Cross-language lock

The publisher's `updateMessage` and the program's `update_message` must produce
the same sha256. Vector: oracle `0x01×32`, apy `71840`, version `1` →
`dd9394a5f5b4b383f2478ae97164cb69b495245a220a1be1d0996a0e0d54c1a0`
(asserted in both Rust and TypeScript).

## Mock policy

- On-chain: no external services — the mock instruction sysvar replaces the runtime.
- Publisher: no mocks; `toScaledApy`/`isStale`/`decodeOracle` are pure and unit-tested.
- Fuzz: uses `TridentSVM` (in-process), signing real ed25519 payloads with a fixed keypair.
