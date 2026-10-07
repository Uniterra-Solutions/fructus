# fructus-server

Backend service for product-v2 (PRD REQ-B-1..B-10, D11–D16): chain indexer, state layer, SIWS
auth, operator relay, keeper, REST + WebSocket API. One process, `node:http` + `ws`, SQLite via
`node:sqlite`.

> **Status: SKELETON (draft runbook).** Interfaces are real; behavior lands in later waves.
> Today only `GET /healthz` is live — every other route answers
> `501 {"ok":false,"error":{"code":"not_implemented",…}}`. The ops wave (REQ-B-10) finalizes
> this runbook; the route contract itself lives in `src/api.ts` (`ROUTES`) and mirrors
> `docs/api/openapi.json`.

## Layout

| Path | Role |
| --- | --- |
| `src/config.ts` | env → `Config` (all keys below) |
| `src/db.ts` | `node:sqlite` store: account tables per kind + fills/funding/tx_log/auth_nonces |
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
| `FAUCET_ENABLED` | `0` | `1` enables the faucet (needs the two keys below) |
| `FAUCET_MINT` | — | tUSDC mint (base58) |
| `FAUCET_MINT_AUTHORITY_KEYPAIR` | — | mint authority keypair path |
| `FAUCET_PER_WALLET_CAP` | `10000000000` | per-wallet 24 h cap, raw microunits (= 10,000 tUSDC) |
| `FAUCET_GLOBAL_CAP` | `1000000000000` | global 24 h cap, raw microunits |

`.env.example` carries the same table with copy-paste values; `.env` is git-ignored.

## Local bootstrap

```sh
cd server
npm install
cp .env.example .env        # then set JWT_SECRET (required) and, for actions, OPERATOR_KEYPAIR
npm run typecheck
npm run dev                 # tsx watch; `npm start` for a plain run
curl -s http://127.0.0.1:8787/healthz   # → {"ok":true,"data":{"status":"ok","slot":null}}
```

For the e2e harness (`test/harness.ts`, used by the later test shards): the box needs
`solana-test-validator` + `spl-token` on `PATH` and the staged program at
`target/deploy/fructus.so` (override with `FRUCTUS_SO_PATH`). The harness starts the validator
with a synthetic stake-pool `index_source`, initializes the market, funds traders, and can spawn
this server against it (`startServer()`), then `stopAll()`.

## Checks

```sh
npm run typecheck           # tsc --noEmit
npm test                    # tsx --test --test-force-exit test/*.test.ts (shards land in later waves)
```

## Notes

- Keeper: interval loop (`KEEPER_INTERVAL_MS`); `tick()` is one bounded pass
  (crank → settle funding → settle close → liquidate). Third-party liquidation stays
  permissionless (D16).
- Indexer: WS-first; a full resync runs at start and every 60 s (devnet data is tiny, D12).
  gRPC/Carbon is the documented upgrade path.
- `patchStakePool()` in the harness re-genesises the validator ledger (see its docstring) —
  no live account-write RPC exists on stock `solana-test-validator`.
