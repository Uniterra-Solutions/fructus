# Fructus Documentation

Fructus is a Solana protocol for trading yield futures — turning the variable
yield of liquid-staking assets (starting with jitoSOL) into a tradeable
instrument. This tree documents the **data module** (the mark-price APY oracle,
trustless settlement reference, off-chain keeper, and fuzz harness) and the
**perpetual-market** account.

## Quick Links

- [Setup](setup.md) · [Architecture](architecture.md) · [API Reference](api-reference.md) · [HTTP + WS API](api.md)
- Back to project [README](../README.md)

## I want to…

| I want to… | Go to |
| --- | --- |
| Build / run / install | [setup.md](setup.md) |
| Understand the system design | [architecture.md](architecture.md) |
| See the on-chain instruction surface | [api-reference.md](api-reference.md) |
| Call the HTTP + WebSocket API (server) | [api.md](api.md) |
| Understand operator delegation | [modules/operator.md](modules/operator.md) |
| See account/field layouts | [data-models.md](data-models.md) |
| Understand the mark-price oracle | [modules/oracle.md](modules/oracle.md) |
| Understand trustless settlement | [modules/settlement.md](modules/settlement.md) |
| Understand the perpetual market | [modules/market.md](modules/market.md) |
| Understand the on-chain order book | [modules/order-book.md](modules/order-book.md) |
| Understand the position lifecycle | [modules/positions.md](modules/positions.md) |
| Understand the funding engine | [modules/funding.md](modules/funding.md) |
| Understand liquidation | [modules/liquidation.md](modules/liquidation.md) |
| Understand the collateral vault | [modules/collateral.md](modules/collateral.md) |
| Understand the off-chain keeper | [modules/publisher.md](modules/publisher.md) |
| Use the SDK / CLI / deploy to devnet | [SDK, CLI & deployment](#sdk-cli--deployment) |
| Run tests / fuzz | [testing.md](testing.md) |
| Learn code conventions | [conventions.md](conventions.md) |
| Follow a task recipe | [workflows.md](workflows.md) |

## Document Index

- [tech-stack.md](tech-stack.md) — languages, frameworks, versions
- [project-structure.md](project-structure.md) — directory map
- [architecture.md](architecture.md) — C4 diagrams + decisions
- [conventions.md](conventions.md) — code rules that differ from defaults
- [modules/oracle.md](modules/oracle.md) — mark-price APY oracle
- [modules/settlement.md](modules/settlement.md) — trustless exchange rate / yield
- [modules/market.md](modules/market.md) — perpetual market + `initialize_market`
- [modules/order-book.md](modules/order-book.md) — order book + matching engine + mark/twap
- [modules/positions.md](modules/positions.md) — position lifecycle (open/close long & short)
- [modules/funding.md](modules/funding.md) — funding engine (premium, funding rate, `settle_funding`)
- [modules/liquidation.md](modules/liquidation.md) — account-level liquidation (health, TWAP reference, `liquidate`)
- [modules/collateral.md](modules/collateral.md) — collateral vault + deposit/withdraw (equity gate)
- [modules/publisher.md](modules/publisher.md) — off-chain keeper
- [modules/operator.md](modules/operator.md) — operator delegation (`set_operator` + `operator_*`)
- [api-reference.md](api-reference.md) — instruction reference + signature scheme
- [api.md](api.md) — HTTP + WebSocket API surface (server)
- [api/ws.md](api/ws.md) — WebSocket push message types
- [data-models.md](data-models.md) — account + derived-rate layouts
- [setup.md](setup.md) — getting started
- [testing.md](testing.md) — test strategy + commands
- [workflows.md](workflows.md) — task recipes

## SDK, CLI & deployment

The on-chain program (issues #2–#8) ships a typed **TypeScript SDK** (`sdk/`), a
**CLI** (`cli/`), and a devnet **end-to-end deployment** step — the offline-built
deliverables of [issues #9–#11](../.plan/20260820/funding-settlement-liquidation-sdk/design.md)
(the design artifact is gitignored, so it lives in the working tree, not the
repo):

- **`sdk/`** — typed TS client mirroring the program: `open`/`close` long & short,
  `deposit`/`withdraw`; query `position`/`mark`/`index`/`funding`; compute expected
  funding + PnL. Ships typed decoders for `PerpMarket`, `Position`,
  `UserCollateral`, `OrderBook`, `YieldOracle` and a cross-language vector test
  freezing the funding formula + account layouts byte-identical with the program.
- **`cli/`** — `open`, `close`, `deposit`, `withdraw`, `position`, `funding`,
  `mark`, `index`; keypair from env/flag (never committed), `.env` handling
  consistent with `publisher/`.
- **Devnet deployment** — `scripts/e2e` runs the full lifecycle
  (deploy → init market → deposit → open → funding → close → settle) via a
  `publisher`-style npm script, with the devnet program id + market address
  documented in the deploy doc.

`[INFERRED]`: these packages are built offline; the actual devnet deploy/verify
is a documented runnable step per the design. The build/tests above cover the
on-chain program; the SDK/CLI/e2e suite is exercised from `sdk/`, `cli/`, and
`scripts/` respectively.

