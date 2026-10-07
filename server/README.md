# fructus-server

Backend service for product-v2 (PRD REQ-B-1..B-10, D11–D16): chain indexer, state layer, SIWS
auth, operator relay, keeper, REST + WebSocket API. One process, `node:http` + `ws`, SQLite via
`node:sqlite`.

> **Status: live.** All 16 routes of the REQ-B-7 contract are implemented in `src/api.ts`
> (`ROUTES`, mirroring `docs/api/openapi.json`): the SIWS auth pair, the wallet-signed bind pair
> (`/bind/prepare` returns the unsigned `[approve, set_operator]` transaction; `/bind/confirm`
> verifies the landed tx and the on-chain `Operator` record), the public reads (`/market`,
> `/market/book`), the faucet and `/healthz`, plus the JWT-gated private set — `/me`,
> `/me/positions`, `/me/history` and the five `/actions/*` answer 401 without a valid session.
> The e2e suite walks the whole product flow against a hermetic `solana-test-validator`
> (see Checks).

## Layout

| Path | Role |
| --- | --- |
| `src/config.ts` | env → `Config` (every key in the table below) |
| `src/db.ts` | `node:sqlite` store: account tables per kind + fills/funding/tx_log/auth_nonces/faucet_credits |
| `src/indexer.ts` | RPC WS `onProgramAccountChange` + 60 s `getProgramAccounts` resync (D12) |
| `src/state.ts` | portfolio / market / book read models (DTOs from `fructus-sdk`) |
| `src/auth.ts` | SIWS challenge + ed25519 verify + HS256 JWT sessions (REQ-B-4) |
| `src/operator.ts` | per-user FIFO action queue, SDK operator builders, `tx_log` (REQ-B-5) |
| `src/keeper.ts` | interval loop: crank → settle funding → settle close → liquidate (REQ-B-6) |
| `src/api.ts` | REST routes table + `node:http` server (REQ-B-7) |
| `src/ws.ts` | `/ws?token=…` push socket; bad token ⇒ close 4401 |
| `src/faucet.ts` | devnet tUSDC mint with 24 h caps (D15) |
| `src/index.ts` | entry: config → db → modules → listen; SIGINT/SIGTERM shutdown |
| `test/harness.ts` | e2e harness: `solana-test-validator` + synthetic stake pool + spawned server |

## Environment

| Key | Default | Meaning |
| --- | --- | --- |
| `RPC_URL` | `http://127.0.0.1:8899` | Solana RPC (HTTP) endpoint |
| `DATABASE_PATH` | `./fructus-server.sqlite` | SQLite file for indexed state |
| `JWT_SECRET` | — (required) | HS256 session signing secret |
| `OPERATOR_KEYPAIR` | — | operator keypair path; unset ⇒ actions unavailable |
| `PORT` | `8787` | HTTP listen port |
| `KEEPER_INTERVAL_MS` | `5000` | keeper loop period |
| `FAUCET_ENABLED` | `0` | `1` enables the faucet (requires the mint + authority keys below) |
| `FAUCET_MINT` | — | tUSDC mint (base58) |
| `FAUCET_MINT_AUTHORITY_KEYPAIR` | — | mint authority keypair path |
| `FAUCET_PER_WALLET_CAP` | `10000000000` | per-wallet 24 h cap, raw microunits (= 10,000 tUSDC) |
| `FAUCET_GLOBAL_CAP` | `1000000000000` | global 24 h cap, raw microunits |
| `FAUCET_DRIP` | `10000000` | per-request mint amount, raw microunits (= 10 tUSDC); the caps calibrate against it |

`.env.example` carries the same table with copy-paste values; `.env` is git-ignored.

## Local bootstrap

```sh
cd sdk && npm install        # the server imports the SDK's sources — install its deps first
cd ../server && npm install  # `@solana/web3.js` must resolve from `sdk/node_modules`
cp .env.example .env         # then set JWT_SECRET (required) and, for actions, OPERATOR_KEYPAIR
npm run typecheck
npm run dev                  # tsx watch; `npm start` for a plain run
curl -s http://127.0.0.1:8787/healthz   # → {"ok":true,"data":{"status":"ok","slot":null}}
```

For the test suites (`test/harness.ts`): the box needs `solana-test-validator` + `spl-token` on
`PATH` and the staged program at `target/deploy/fructus.so` (override with `FRUCTUS_SO_PATH`).
The harness starts the validator with a synthetic stake-pool `index_source`, initializes the
market, funds traders, and can spawn this server against it (`startServer()`), then `stopAll()`.

## Checks

```sh
npm run typecheck           # tsc --noEmit
npm test                    # tsx --test --test-force-exit test/*.test.ts
```

`test/` carries the nine `*.test.ts` suites (`api`, `auth`, `e2e`, `faucet`, `indexer`, `keeper`,
`operator`, `state`, `ws`) plus the shared `harness.ts`. Run the whole set sequentially — the
parallel `node:test` default is a known flake here (the validator-backed suites each spawn their
own validator), so CI pins the concurrency:

```sh
npx tsx --test --test-force-exit --test-concurrency=1 test/*.test.ts   # ci.yml job `server`
```

## Notes

- **Operator**: per-user FIFO action queue; the API validates the request DTOs and delegates —
  only the operator service touches the hot key (`OPERATOR_KEYPAIR`, R-3, never logged). Every
  attempt lands in `tx_log` and is pushed to the actor's socket as a `tx` message. Unset key ⇒
  `/actions/*` and `/bind/prepare` answer 501 `operator_unconfigured`.
- **Keeper**: `tick()` is one bounded pass — crank → settle funding → settle close →
  account-level liquidation (one full close per under-margin account); the interval loop
  (`KEEPER_INTERVAL_MS`) shares one in-flight pass across overlapping firings, and a failing
  sweep is recorded — never rejecting the tick. The keeper reuses the operator hot key
  (Stage-1 R-3); third-party liquidation stays permissionless (D16).
- **Faucet**: requests are serialized; an accepted call mints exactly one `FAUCET_DRIP` into the
  wallet's ATA and is counted against the 24 h budgets only after the tx lands (over-cap ⇒ 429,
  no on-chain effect; disabled ⇒ 404 `faucet_disabled`).
- **Indexer**: WS-first; a full resync runs at start and every 60 s (devnet data is tiny, D12);
  its slot feeds `/healthz` and its updates fan out on the WS push channel. gRPC/Carbon is the
  documented upgrade path.
- `patchStakePool()` in the harness re-genesises the validator ledger (see its docstring) —
  no live account-write RPC exists on stock `solana-test-validator`.
