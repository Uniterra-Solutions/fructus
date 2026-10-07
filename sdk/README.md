# fructus-sdk

Typed TypeScript client for the Fructus on-chain program: instruction builders,
typed account decoders, and pure-JS mirrors of the on-chain math, plus the
shared REST/WS DTO types served by `server/` and consumed by `cli/`.

- **Instruction builders** for the full handler surface — core
  (`deposit_collateral` … `liquidate`) and the delegated `operator_*` mirrors,
  plus `buildOperatorBindInstructions` / `buildOperatorRevokeInstructions` for
  the one-time delegation bind.
- **Typed decoders** for every program account: `PerpMarket`, `Position`,
  `UserCollateral`, `OrderBook`, `YieldOracle`, and the 97-byte `Operator`
  record.
- **Pure mirrors** of the on-chain math — funding, PnL / margin
  (`positions.ts`), mark/index, account health — locked byte-identical to the
  Rust by cross-language vector tests.
- **Shared API DTOs** (`src/api.ts`): the REST + WebSocket payload types.
- Optional **transaction v1 (SIMD-0385)** send path (`src/v1.ts`), additive to
  the v0/legacy helpers.

The package is `private: true` and consumed via `file:` links from `cli/` and
`server/`. `npm test` runs the `node:test` suites under `sdk/test/` with
`tsx`; `npm run build` emits `dist/` via `tsc`.

## Browser readiness

`sdk/src/index.ts` is bundleable for the browser: **no module reachable from
the entry imports a `node:` builtin** (enforced by `test/browser.test.ts`,
`SDK-NO-NODE-BUILTINS`). Anchor discriminators come from precomputed constant
tables — no `node:crypto` at runtime; the derivation helpers use a
self-contained FIPS 180-4 SHA-256 in `src/encoding.ts`. The tables are
cross-checked against `node:crypto` sha256 in tests and their sizes are pinned
(`SDK-DISCRIMINATOR-TABLES-MATCH-SHA256`).

The submit helpers (`submitTransaction` / `submitInstruction`) take web3.js
`Keypair[]` — browser integrators should build instructions with this SDK and
sign/send through a wallet adapter.

## Buffer polyfill expectation (bundlers)

The SDK does not import `node:buffer`, but it uses the **`Buffer` global**
throughout serialization and decoding (`Buffer.from` / `Buffer.concat` /
`Buffer.alloc` in `src/encoding.ts`, `src/constants.ts`, `src/instructions.ts`
and the `src/account/` decoders). Because `Buffer` is a global rather than an
import, the `node:`-import scan cannot see it — a bundler still has to provide
it:

- **Node** provides `Buffer` natively; no action needed.
- **Browser bundlers do not polyfill Node globals by default** (vite, esbuild,
  webpack 5, rollup). Configure one to provide `Buffer` — e.g. the `buffer`
  npm package via your bundler's alias / global-injection mechanism.

Expectation: the package assumes a `Buffer` binding is available at runtime in
whatever environment the bundle executes (the runtime's global in Node, a
bundler-provided polyfill in the browser).
