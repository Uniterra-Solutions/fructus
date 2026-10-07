# Fructus

> **Yield futures on Solana — democratizing access to staking-yield hedging.**

Fructus is a Solana-native protocol for trading **yield futures**. It turns the
variable yield of liquid-staking assets into a standalone, tradeable instrument,
so anyone can hedge or speculate on future yield **without understanding
interest-rate swaps**.

The protocol ships in stages (full detail in [Roadmap](#roadmap)):

1. **jitoSOL yield perpetual futures** (MVP)
2. **jitoSOL dated futures** (fixed-expiry contracts)
3. **Protocol engine** — anyone deploys configurable markets via the SDK

## Documentation

Full project documentation lives under [`docs/`](docs/README.md) — architecture,
modules, instruction reference, data models, setup, testing, and workflows.
Agent orientation is in [`AGENTS.md`](AGENTS.md).

## Why Fructus?

Liquid staking (for example, jitoSOL) pays a variable yield. Today, separating
that yield from the underlying asset and trading it is something only
sophisticated desks do. Fructus makes the yield itself a first-class, liquid
product with two goals:

| Goal | What it enables |
| --- | --- |
| **Democratize investing** | Retail users hedge staking risk directly — *short* a yield future to lock in their staking return — with no swaps knowledge required. |
| **Better institutional tooling** | Funds and market makers *long* yield futures to harvest basis, or assemble structured products on top of them. |

## Core concepts

### Yield perpetual futures

A perpetual contract on an asset's **yield rate** rather than its price. A
short position locks in a fixed yield, while a long position speculates that
yield will rise above the current market level. Funding keeps the perp anchored
to the underlying staking yield.

### Yield dated futures

Fixed-expiry contracts that settle against the realized yield of a staking
asset over a defined period (for example, the annualized jitoSOL APY between
two dates). These are the building blocks for terms, calendar spreads, and
structured products.

## Roadmap

### Stage 1 — jitoSOL yield perpetual futures (MVP)

Launch the perp: a perpetual contract on jitoSOL's yield rate, anchored to
realized staking yield by funding. This validates the oracle and settlement
machinery in production with a single, closely-watched instrument.

### Stage 2 — jitoSOL dated futures

Launch fixed-expiry contracts settling against realized jitoSOL APY over a
defined period — the building blocks for terms, calendar spreads, and
structured products.

### Stage 3 — Protocol engine

With both futures forms complete, the protocol stops hand-shipping markets
and becomes an **engine**: fees, data sources, and every other configurable
dimension of a market are declared by its creator via the SDK and deployed
on-chain. Deploying a market costs a **deployment fee** paid to the protocol.

The engine removes the protocol's dependence on the development team for
centralized audit and long-term maintenance, and shifts the revenue model
from per-trade fees to deployment fees:

- **Creator flywheel** — early instruments are deployed by the protocol
  itself; as users grow, more market creators are willing to take on the risk
  of building a futures contract that solves a real pain point. Expansion to
  new assets no longer waits for the core team.
- **Self-sustaining protocol** — deployment fees keep the protocol running
  without taxing every trade.

**Deployment gates.** Market creation is gated by design:

- Deployers must use a wallet that has passed real-world KYC (SAS), keeping
  every market attributable.
- The deployment fee has a floor — it cannot be set too low — acting as a
  capital threshold on top of traceability.

**Dual-track listing.** New markets can launch through either track:

- **Self-funded track** — creators complete their own KYC and pay the
  deployment fee to list a market directly.
- **Idea track** — creators who cannot afford the fee but are convinced of a
  market's value pitch the protocol. The protocol admin reviews the futures
  design and negotiates a fee-share with the proposer; the protocol deploys
  the market, and trading fees are split 50/50 between the protocol and the
  proposer by default, with the split adjustable based on the market's
  expected value.

**Anti-manipulation.** The protocol ships defenses against market abuse:
protocol-level state rollback tooling, an emergency freeze letting the
protocol administrator halt malicious trading, and market-maker incentives
that provide liquidity and raise the cost of a hostile capital attack.

## Use cases

- **Stakers (hedgers):** short yield futures to convert variable staking
  rewards into a fixed, predictable return.
- **Yield farmers:** hedge against APY compression on concentrated positions.
- **Basis traders:** long yield futures against staked exposure to earn the
  spread between implied and realized yield.
- **Structured-product issuers:** use dated yield futures as legos for
  principal-protected notes and yield-enhanced vaults.

## Technology

- **Language:** Rust (on-chain) + TypeScript (off-chain keeper, SDK, CLI, scripts)
- **Chain:** Solana
- **Framework:** Anchor 1.2
- **Key dependencies:** `anchor-lang`, `anchor-spl`, `bytemuck`, `solana-sdk-ids`, `@solana/web3.js`
- **Testing/verification:** `proptest`, `solana-program-test` (CPI), Trident, `tsx --test`
- **Fuzzing:** Trident

## Repository layout

```
.
├── Anchor.toml                 # Anchor workspace configuration
├── Cargo.toml                  # Rust workspace manifest
├── AGENTS.md                   # Agent orientation (build/test/conventions)
├── docs/                       # Project documentation (docs/README.md hub)
├── programs/
│   └── fructus/                # On-chain program (oracle, market, CLOB, vault, positions, funding, liquidation, ed25519)
│       ├── src/
│       └── tests/              # Bank-style CPI integration tests
├── publisher/                  # Off-chain TypeScript APY keeper
├── sdk/                        # Trader TypeScript SDK (builders, decoders, funding/PnL mirrors)
├── cli/                        # Trader CLI over the SDK (open/close/deposit/withdraw/position/funding/mark/index)
├── scripts/                    # Devnet deploy + e2e lifecycle (deploy.sh, e2e.mts)
├── trident-tests/              # On-chain fuzz harness
├── CHANGELOG.md
└── LICENSE
```

## Getting started

> **Prerequisites:** Rust toolchain, Anchor CLI, and `cargo-build-sbf`. See
> [Anchor installation](https://www.anchor-lang.com/docs/installation).

```bash
# Build the on-chain program
anchor build

# Run the on-chain test suite (cargo-nextest; `cargo test` also works)
cargo nextest run --workspace

# Run the off-chain publisher tests
cd publisher && npm test

# Run the trader SDK + CLI suites
cd sdk && npm test && npm run build
cd .. && cd cli && npm test && npm run build

# Offline devnet lifecycle dry-run (RUN_E2E=1 = live)
cd scripts && npm run e2e

# Run the on-chain fuzz smoke test
cd trident-tests && cargo run --bin fuzz_0
```

> **Note:** the program keypair is generated locally at
> `target/deploy/fructus-keypair.json` (gitignored). Keep it safe — it is
> required to deploy and upgrade the program.

## Status

Fructus is in **early development** and is currently a **private** repository. The
**data module** (mark-price APY oracle, trustless settlement reference,
off-chain keeper, fuzz harness), the **perpetual market** account (`PerpMarket` +
`initialize_market`), the **on-chain order book** (CLOB + mark/twap), the
**collateral vault** (USDC deposit/withdraw), the **position lifecycle**
(open/close long & short), the **funding engine** (anchor mark → index), the
**trustless settlement** (`settle_close`, realized-yield PnL), the **operator
delegation** surface (`set_operator` + the `operator_*` actions), and the
**account-level liquidation engine** (cross-margin account health + TWAP
reference + penalty/liquidator incentive) are
implemented and tested; a **trader SDK** (`sdk/`), a **trader CLI** (`cli/`),
and a **devnet deploy + e2e lifecycle script** (`scripts/`) are provided. The
protocol has **not been audited** and is **not deployed to mainnet**. Do not use
it with real funds.

## License

This project is licensed under the [MIT License](LICENSE).
