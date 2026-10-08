# PRD — product-v3: trading terminal frontend + K-line backend

| Field | Value |
| --- | --- |
| Plan | `product-v3`: dark trading terminal (open/close, order book, account binding, K-line), server K-line endpoints (candles/trades + WS trade push), keeper settle-fill sweep, MM bot, local devstack |
| Date | 2026-10-08 |
| Status | Frozen — settled by discussion; not yet implemented |
| Source | User request 2026-10-08 ("走完整PDD流程，實作整個科技感黑色系前端+後端k線端點"), following the approved tooling recommendation (lightweight-charts; server-side candles; MM bot included); clarify round 2026-10-08 (settle-fill sweep: INCLUDED; UI language: bilingual zh-Hant/en); mid-run owner note 2026-10-08: wallet bind-to-trade gating is a required frontend capability ("綁定錢包開始交易") |
| Related | `ACCEPTANCE.md` — per-REQ propositions and evidence |

**Brevity contract.** This document carries ONLY the settled decisions, the requirement list, and what each requirement is measured against. Background and repo facts stay out — the implementer fetches context from the repository itself.

## Decisions (settled; not up for re-discussion)

- **D1 Charting**: TradingView Lightweight Charts v5 (Apache-2.0). Rejected: TV Advanced Charts / Trading Platform — proprietary, company-only application, datafeed+broker integration cost far exceeds a custom panel set for one market.
- **D2 K-line data**: server-side OHLCV aggregation from the indexed `fills` table + a WS `trade` push for live updates. Rejected: client-only aggregation — no history, dies on refresh.
- **D3 Fill timestamps**: every newly indexed fill resolves `block_time_ms` via `getBlockTime(slot)` through a per-slot cache (≤1024 entries, FIFO); RPC null/error falls back to ingestion wall-clock. Rejected: slot-only storage (no wall-clock buckets), ingest-time-only (wrong for backfill).
- **D4 Trade push**: one WS `trade` message per newly indexed fill (ascending seq). Rejected: batched candle pushes (duplicate aggregation logic), polling.
- **D5 Candles shape**: compact non-empty buckets, ascending, `limit`-bounded, window ends at the latest fill's bucket; intervals whitelist `1m/5m/15m/1h/4h/1d`; `limit` 1..1000 default 300. Rejected: padded empty buckets (lightweight-charts renders gaps natively).
- **D6 Trades shape**: descending by seq, `limit` 1..200 default 50.
- **D7 Frontend stack**: Vite + React + TypeScript + Tailwind; hand-rolled fetch hooks + WS-driven store (no query/state library); `@solana/wallet-adapter-react` for extension wallets (Wallet Standard detection) plus an in-page demo burner wallet; wallet-adapter's own UI package rejected (styling clash). Next.js rejected (no SSR need).
- **D8 Bilingual UI**: `en` + `zh-Hant` dictionaries with identical typed key sets; toggle in the top bar; persisted (`fructus.locale`); default: `navigator.language` starts with `zh` → `zh-Hant`, else `en`. (Owner decision 2026-10-08.)
- **D9 Demo wallet**: in-page ed25519 keypair (persisted `fructus.demoKey`), SOL via the validator's `requestAirdrop` over the same-origin `/rpc`, tUSDC via `POST /faucet`. Primarily for the local stack; on devnet it needs a funded SOL balance.
- **D10 MM bot**: standalone `scripts/mm-bot.mts` over the SDK builders. Rejected: server-side MM (product risk, out of the server's role).
- **D11 Settle-fill sweep**: the keeper gains a settle-fill sweep inside `tick()`, ordered crank → settle-fill → funding → close → liquidate. Settles ANY wallet's pending maker fills (permissionless op, operator key as settler). (Owner decision 2026-10-08: INCLUDED.)
- **D12 Devstack**: `scripts/devstack.mts` runs the whole local chain bootstrap (validator + market init + tokens + funded keys + printed env blocks). Rejected: manual documented steps (unverifiable, error-prone).
- **D13 Boundaries**: local commits only — no push, no release, no deploy; no mainnet concerns. UI strings centralized for the two locales listed in D8.
- **D14 Frontend↔SDK**: the frontend imports `fructus-sdk` directly (`file:../sdk`) for DTO types, constants and pure helpers; REST under same-origin `/api/*` (prefix stripped by the dev proxy / demo reverse proxy), WS at `/ws`, RPC at `/rpc`.
- **D15 Testing**: server keeps `node:test`; frontend uses vitest + @testing-library/react + jsdom; property-ish sweeps are hand-rolled deterministic xorshift loops (repo house style) — no new PBT dependency anywhere. CI gains a `frontend` job.

## Requirements

### K-line backend (server/)

#### REQ-K-1 fill timestamps

- **Statement**: the `fills` table gains `block_time_ms INTEGER NULL` (added by an idempotent `openDb` migration); every newly indexed fill stores `getBlockTime(slot) × 1000`, resolved through a per-slot cache of at most 1024 entries (FIFO eviction); a null or failing `getBlockTime` yields the ingestion wall-clock (`Date.now()`); only rows persisted before this change may carry NULL.
- **Rationale**: candles need wall-clock buckets; the indexer only sees slots.
- **Testability**: `FILL-TIME-CACHED-ONCE: each distinct slot is fetched from the block-time source exactly once per process`, `FILL-TIME-FALLBACKS-TO-INGEST-CLOCK: a null or throwing block-time fetch yields exactly the ingestion clock`, `FILL-TIME-MIGRATES-OLD-TABLE: opening a store whose fills table predates block_time_ms adds the column and preserves existing rows`.

#### REQ-K-2 candles endpoint

- **Statement**: public `GET /market/candles?interval=<1m|5m|15m|1h|4h|1d>&limit=<1..1000, default 300>` returns `{ok:true,data:{candles:CandleView[]}}`; `CandleView = {timeMs, open, high, low, close, volume, trades}` (all decimal strings except `trades: number`). Bucket = `floor(timeMs / intervalMs) × intervalMs`; fills with NULL `timeMs` are skipped entirely; per bucket: `open` = price of the first fill by ascending seq, `close` = last, `high/low` = max/min, `volume` = Σ size (raw), `trades` = count. Output: ascending by timeMs, only non-empty buckets, at most `limit`, window ending at the latest timed fill's bucket `B_max` covering buckets `≥ B_max − (limit−1)×intervalMs`; empty market → `{candles:[]}`; invalid `interval`/`limit` → 400 `bad_request`.
- **Rationale**: chart source; D2/D5.
- **Testability**: `CANDLES-BUCKET-AND-OHLC: per-bucket open/high/low/close/volume/trades equal an independently computed grouping of the generated fills`, `CANDLES-COMPACT-ASCENDING-WINDOWED: the array is ascending, holds only non-empty buckets, never exceeds limit, never contains a bucket below B_max − (limit−1)×intervalMs, and its last bucket is B_max`, `CANDLES-SKIP-UNTIMED-FILLS: NULL-time fills never create, extend or bound a bucket`, `CANDLES-REJECT-BAD-PARAMS: unknown interval and out-of-range/non-numeric limit answer 400 bad_request rather than a default`.
- **Out of scope**: historical backfill before the indexer existed (untimed rows stay excluded).

#### REQ-K-3 trades endpoint

- **Statement**: public `GET /market/trades?limit=<1..200, default 50>` returns `{ok:true,data:{trades:TradeView[]}}`; `TradeView = {seq, slot, timeMs|null, owner, side(0|1), price, size}` (decimal strings; `timeMs` may be null for pre-migration rows); descending by `seq`; invalid `limit` → 400 `bad_request`.
- **Rationale**: the tape panel and live-feed reconciliation.
- **Testability**: `TRADES-LATEST-FIRST-BOUNDED: rows are strictly descending by seq, at most limit, with the exact stored fields`, `TRADES-INCLUDE-UNTIMED: a row whose block_time_ms is NULL still appears with timeMs: null`.

#### REQ-K-4 WS trade push

- **Statement**: every newly indexed Fill (one whose row insert actually succeeded) is pushed to all authenticated sockets as `{type:"trade", market:<market>, trade:TradeView}` in ascending seq order; re-delivered/duplicate fills from resyncs push nothing; `ServerWsMessage` (sdk) gains the variant; `docs/api/ws.md` documents it.
- **Rationale**: live tape + live candle updates without polling.
- **Testability**: `WS-TRADE-PUSH-EXACTLY-ONCE: a live cross delivers exactly one trade message per new fill, in ascending seq order, matching the REST trade row, and a forced resync re-delivery adds none`.

#### REQ-K-5 keeper settle-fill sweep

- **Statement**: `keeper.tick()` gains a settle-fill sweep between crank and settle-funding: it reads the current order book ring (written window `[max(0, cursor−32), cursor)`), and for every `kind==Fill && settled==0` event calls `settle_fill(seq)` (operator key as settler), at most 32 attempts per tick; one fill's tx failure is logged and never rejects the tick; an already-settled fill is skipped; `KeeperTickResult` gains `settledFills: number`.
- **Rationale**: maker fills (user limit opens, MM quotes) must book within the 32-event ring window; nothing off-chain did this (owner approved adding it).
- **Testability**: `KEEPER-BOOKS-MAKER-FILLS: with a resting maker limit crossed by a taker, one tick books the maker's position (notional == fill size) and the ring event reads settled`, `KEEPER-SETTLE-IDEMPOTENT: a second tick reports settledFills 0 and changes nothing on chain`.

### Frontend terminal (frontend/)

#### REQ-F-1 app shell, theme, i18n

- **Statement**: `frontend/` is a Vite + React + TS + Tailwind app with a dark tech theme (tokens pinned in `frontend/src/theme.css`: base `#05070B`, panel `#0B1018`, border `#1A2433`, text `#E6EDF7`, muted `#8B98A9`, accent `#22D3EE`, up `#34D399`, down `#F87171`; numerals in JetBrains Mono); `document.documentElement.dataset.theme = "dark"` at boot; the shell renders the top bar (brand, mark/index/funding, locale toggle, wallet control), chart panel, order book panel, trade form, positions panel, account panel, trades tape. i18n per D8: typed dictionaries `en`/`zh-Hant` with identical key sets, `t(key)` lookup, persisted toggle.
- **Rationale**: the requested 科技感黑色系 terminal, bilingual.
- **Testability**: `I18N-DICTIONARIES-IDENTICAL-KEYS: both locale dictionaries expose exactly the same non-empty key set`, `LOCALE-RESOLUTION: a stored locale wins; otherwise navigator.language zh* → zh-Hant; anything else → en`, `SHELL-RENDERS-PANELS: (component test) the app renders its seven panels, sets data-theme="dark", and the locale toggle swaps a known label's language`.

#### REQ-F-2 wallet, auth, bind, demo wallet

- **Statement**: two signer modes — (a) extension wallets via `@solana/wallet-adapter-react` (connect/disconnect, `signMessage`, `signTransaction`), (b) demo burner: generate/load ed25519 `Keypair` persisted in `localStorage.fructus.demoKey`, "reset demo wallet" clears it. Login: `POST /auth/challenge {wallet}` → `signMessage(utf8(signInInput))` (base58) → `POST /auth/verify {wallet, signature, signInInput}` → store `{token, wallet}` in `localStorage.fructus.session` (+ expiry check). Bind: `POST /bind/prepare {wallet}` → deserialize + sign the returned transaction → `sendRawTransaction` via `/rpc` → `POST /bind/confirm {transaction(base64 signed), signature}`. Faucet: `POST /faucet {wallet}` button when authed. UI auth states: disconnected → connected → authed → bound, with `unauthorized` on any authed read falling back to connected. **Trading is gated**: every trading control (order form, position closes) renders disabled with a prominent "bind wallet to start trading" call-to-action until the wallet is authed AND bound; the gate lifts once the bind confirms; disconnect/unauthorized re-engages it.
- **Rationale**: 帳戶綁定 = wallet connect + SIWS + operator delegation, all against the shipped server contract.
- **Testability**: `API-CLIENT-CONTRACT: (table-driven, mocked fetch) every client function issues the exact method/path/request body, attaches the JWT exactly on the gated routes, and maps the error envelope to a typed error`, `DEMO-WALLET-PERSISTS-AND-SIGNS: a generated demo keypair round-trips through storage and its signMessage signatures verify against its public key; reset clears storage`, `AUTH-STATE-FALLBACK: a 401 on an authed read clears the session and lands in connected (not disconnected), while success walks disconnected→connected→authed→bound`, `TRADE-GATED-UNTIL-BOUND: a connected but unbound wallet sees disabled trading controls plus the bind CTA, and a confirmed bind enables them`.

#### REQ-F-3 data pipeline (REST bootstrap + WS store)

- **Statement**: single WS connection to `/ws?token=…`; reconnect backoff ×2 from 500 ms to a 10 s cap; on (re)connect the client refetches snapshots. Reducers (pure): `book` replaces the BookView; `mark` replaces MarketView; `trade` prepends to the tape (dedupe by seq, cap 50) and folds into candles; `user` applies the signed delta portfolio onto the last snapshot; `tx` updates the last action's status. Bootstrap reads: `/market`, `/market/book`, `/market/candles`, `/market/trades`, `/me`.
- **Rationale**: live terminal without a query framework.
- **Testability**: `PORTFOLIO-DELTA-APPLIES-TO-SNAPSHOT: for generated portfolio pairs, applying the delta messages onto the earlier snapshot equals the later snapshot on every field (sides normalised)`, `CANDLE-INCREMENTAL-EQUALS-BATCH: folding trade-by-trade onto candles equals aggregating the whole fill sequence at once (any bucket boundary crossing), and a trade older than the last candle is ignored`, `TAPE-DEDUPES-AND-ORDERS: duplicate and out-of-order trade messages converge to a unique seq-descending tape capped at 50`.

#### REQ-F-4 order book panel

- **Statement**: renders all book levels best-first with 6-dp raw formatting and side colors; a level click pre-fills the order form's limit price (raw) and side (bid → Long, ask → Short); empty sides render a placeholder; the panel updates from WS pushes.
- **Testability**: `BOOK-PANEL-RENDERS-AND-PREFILLS: (component test) given a BookView the rows show formatted values best-first and a click hands the raw price to the form`.

#### REQ-F-5 order form + positions (open / close)

- **Statement**: order form — side (Long/Short), type (Market/Limit), size (decimal USDC, ≤6 dp), price (limit only, ≤6 dp); valid iff size > 0 and (market) or price > 0 (limit); inputs parse exactly to raw BigInt (reject >6 dp, non-numeric, negative, exponent, u64 overflow); submit → `POST /actions/orders {kind, side, size, price?}` with raw decimal strings; status shown from `tx` pushes. Positions panel — one row per open side from `GET /me/positions`: side, notional, upnl (sign-colored), reqInitial; Close opens a size input defaulting to the full notional → `POST /actions/positions/close {side, size}`.
- **Rationale**: 開倉/平倉 end to end.
- **Testability**: `PARSE-FORMAT-EXACT: parseAmount("1.5") == "1500000", round-trips formatAmount(parseAmount(x)) for generated 6-dp strings, and rejects malformed/7-dp/overflowing input without floating point`, `ORDER-FORM-VALIDATION-AND-BODY: (component test) invalid forms cannot submit; a valid limit submit calls the client with the exact raw body`, `CLOSE-BODY-AND-DEFAULT-SIZE: the close action defaults to the full raw notional and submits the exact {side, size}`.

#### REQ-F-6 chart

- **Statement**: lightweight-charts v5 candlestick series fed by `/market/candles`; interval switcher `1m/5m/15m/1h/4h/1d` refetches and continues live folding; mark and index horizontal price lines from `mark` pushes (mark `null` → line hidden); theme colors per REQ-F-1; container resize handled.
- **Testability**: `CHART-CONTROLLER-INTERVAL-SWITCH: (unit test with a mocked lightweight-charts) switching interval refetches with the new interval parameter and replaces the series data; a trade push updates the series with the folded last candle`.

#### REQ-F-7 account panel

- **Statement**: shows deposited / free / equity / health (liquidatable highlighted), operator status (bound address or unbound + Bind button when authed and unbound), deposit and withdraw inputs → `POST /actions/deposit|withdraw {amount}` then refresh, demo faucet button per REQ-F-2.
- **Testability**: `ACCOUNT-PANEL-ACTIONS: (component test) deposit and withdraw submit exact raw bodies; missing amounts disable submit; the liquidatable health renders its alert style`.

### MM bot (scripts/)

#### REQ-M-1 quote engine + script

- **Statement**: `scripts/mm-bot.mts` with a pure, tested module (`scripts/mm-lib.mts`); env: `RPC_URL` (required), `MM_KEYPAIR` (path, required), `MM_LEVELS` (default 2, 1..8 per side), `MM_SPREAD_BPS` (default 50; level k sits at k×spread bps), `MM_SIZE` (raw decimal, default "1000000"), `MM_INTERVAL_MS` (default 15000, minimum 5000). Anchor = floor(mid) when the book is two-sided, else the market index; `bid_k = anchor×(10000−k·s)/10000` floored, `ask_k = anchor×(10000+k·s)/10000` ceiled; a quote whose bid ≥ best ask or ask ≤ best bid is skipped (never cross); each cycle cancels the bot's open orders then places the grid; SDK builders sign with `MM_KEYPAIR`.
- **Rationale**: a book with nothing resting cannot fill; the demo needs two-sided quotes.
- **Testability** (pure module): `MM-QUOTES-NEVER-CROSS-AND-BOUNDED: for generated anchors/books/params, bids < asks strictly, no quote crosses the current book (violating levels are omitted), per-side count ≤ min(levels, capacity), prices are positive integers`, `MM-LADDER-EXACT-OFFSETS: level k sits exactly k×spread bps away (floor/ceil direction) and one-sided books fall back to the index anchor`, `MM-REQUOTE-PLAN-COVERS-OWN-ORDERS: the cancel+place plan cancels exactly the bot's resting orders and places the desired grid`.

#### REQ-M-2 quote liveness (alternative evidence)

- **Statement**: run against the devstack, the bot keeps two-sided quotes visible in `GET /market/book`, survives having one side fully filled (requotes within an interval), and respects the event-rate budget (interval ≥ 5 s, ≤ levels seen per side).
- **Testability**: A-item (browser/curl inspection on the live devstack) — see ACCEPTANCE `A-M-1`.

### Devstack (scripts/)

#### REQ-V-1 local devstack

- **Statement**: `scripts/devstack.mts` (`npm run devstack`): boots `solana-test-validator` with the genesis-loaded `target/deploy/fructus.so` (+ synthetic stake-pool `index_source` at harness offsets 258/266), a fresh ledger under `scripts/.devstack/`, self-owned 6-dp collateral mint, initializes market/book/vault, generates + funds `operator.keypair.json`, mints tUSDC to the operator ATA, and prints copy-paste env blocks for the server and the MM bot (all keys named); failing any step exits non-zero with a clear message; runs until SIGINT. Its env-block printer is a tested pure function.
- **Rationale**: one command must make the whole demo verifiable (and gives the browser walkthrough something real to hit).
- **Testability**: `DEVSTACK-ENV-BLOCK-COMPLETE: the env-block printer emits all required keys for both the server and the bot given generated values`; live run = A-item `A-V-1`.

### Docs & CI

#### REQ-O-1 API docs

- **Statement**: `docs/api/openapi.json` gains both new paths (full schemas, summaries) with its version bumped; the bijection test `API-CONTRACT-MATCHES-OPENAPI` stays green; `docs/api.md` tables gain both routes; `docs/api/ws.md` gains the `trade` row + sample; `server/README.md` route count and notes updated.
- **Testability**: existing `API-CONTRACT-MATCHES-OPENAPI` (regression pin — kept green by updating both sides); A-item `A-O-1` (human reads ws.md/api.md).

#### REQ-O-2 AGENTS.md

- **Statement**: `AGENTS.md` Build & Test gains the frontend / mm-bot / devstack commands; Project Structure gains `frontend/`; Tech Stack npm list updated. (Protected file — edit lands via the approval prompt.)
- **Testability**: A-item `A-O-2` (grep shows the new sections).

#### REQ-O-3 CI

- **Statement**: `.github/workflows/ci.yml` gains a `frontend` job (sdk install → npm ci → typecheck → test → build) and the `ts` matrix runs the scripts package tests.
- **Testability**: A-item `A-O-3` (yaml parses; local equivalents of every job step executed).

#### REQ-O-4 frontend docs

- **Statement**: `frontend/README.md` (stack, run against devstack, test commands, demo wallet note) + a link from `docs/README.md`.
- **Testability**: A-item `A-O-4` (files exist, link resolves).

## Non-goals

- No push/release/deploy; no Caddy/systemd production topology; no mainnet.
- No notifications/alerts, no mobile-optimized layout, no /me/history panel, no order-cancel UI beyond what the operations need (cancel exists server-side; the terminal v1 shows resting orders only through the book).
- No keeper changes beyond the settle-fill sweep; no indexer upgrades (gRPC/Carbon path untouched).
- No MM inventory management / hedging strategy — quoting only.
- No new PBT dependency; no changes to the on-chain program.

## Open questions

- None — the clarify round of 2026-10-08 settled the two open items (settle-fill sweep: included; UI language: bilingual).
