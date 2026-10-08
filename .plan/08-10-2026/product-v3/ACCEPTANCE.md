# ACCEPTANCE — product-v3

**Evidence standard.** Property-based tests are the primary instrument, using the testing stacks the
repository ALREADY has — `node:test` for server/scripts, `vitest` for the new frontend package
(its own scaffold dependency set, settled in D7/D15) — never add a PBT library. Property sweeps are
hand-rolled deterministic xorshift loops (repo house style). A deterministic sample is allowed only
as a regression added beside a confirmed counterexample; it never replaces the property. "Run it
once and look" is either an alternative-evidence item `A-*` (runnable command + what a human
inspects) or it is nothing. The REQ set below EQUALS the REQ set of `PRD.md`.

## Run state (main agent maintains — update at every phase boundary and commit wave; read this block FIRST after a compaction, a new session or a skill edit)

- Phase: plan
- Freeze sha: pending
- Shards: — (the red suite is authored: server 6 files · frontend 13 files · scripts 2 files)
- Open findings: none
- Holds / waivers: none
- Next action: scaffold stubs with real signatures (server + frontend + scripts) → author red suite → run every row command once → collateral pass (server api + keeper suites; nothing else touched) → commit docs, then freeze commit (`test: product-v3 (red baseline)`) and record sha here.

## Run commands (each executed once before being written here)

| Suite (—) | Exact command | Collects (glob) | PBT library present |
| --- | --- | --- | --- |
| server · fill-time (unit) | `cd server && npx tsx --test --test-force-exit test/fill-time.test.ts` | the file | none (hand-rolled; repo style) |
| server · candles (unit) | `cd server && npx tsx --test --test-force-exit test/candles.test.ts` | the file | none |
| server · market-trades (unit) | `cd server && npx tsx --test --test-force-exit test/market-trades.test.ts` | the file | none |
| server · kline e2e | `cd server && npx tsx --test --test-force-exit test/kline-e2e.test.ts` | the file | none (validator-backed) |
| server · ws trade push (e2e) | `cd server && npx tsx --test --test-force-exit test/ws-trade.test.ts` | the file | none |
| server · keeper settle (e2e) | `cd server && npx tsx --test --test-force-exit test/keeper-settle.test.ts` | the file | none |
| frontend · unit/component | `cd frontend && npx vitest run test/<file>` (per-file; whole suite: `npm test`) | `test/**/*.test.{ts,tsx}` | none |
| frontend · typecheck | `cd frontend && npm run typecheck` | — | — |
| frontend · build | `cd frontend && npm run build` | — | — |
| scripts · mm/devstack | `cd scripts && npx tsx --test --test-force-exit test/mm-lib.test.ts test/devstack-env.test.ts` | both files | none |
| server · full verdict | `cd server && npx tsx --test --test-force-exit --test-concurrency=1 test/*.test.ts` | all server suites | — |

## Propositions and acceptance rows (one row per REQ)

| REQ | Proposition (test title, verbatim) | Generator domain | Counterexample shape | Test site (file : title) | Run command | Baseline |
| --- | --- | --- | --- | --- | --- | --- |
| `REQ-K-1` | `FILL-TIME-CACHED-ONCE: each distinct slot is fetched from the block-time source exactly once per process` | slot sequences with duplicates + interleaving; fetch returning seconds; cache eviction crossings | same slot fetched twice (call-count > distinct slots) | `server/test/fill-time.test.ts : FILL-TIME-CACHED-ONCE` | server · fill-time | red |
| `REQ-K-1` | `FILL-TIME-FALLBACKS-TO-INGEST-CLOCK: a null or throwing block-time fetch yields exactly the ingestion clock` | fetch → null / throw / slower-than-now; injected `now()` | fallback ≠ injected now (or fetch not attempted) | `server/test/fill-time.test.ts : FILL-TIME-FALLBACKS-TO-INGEST-CLOCK` | server · fill-time | red |
| `REQ-K-1` | `FILL-TIME-MIGRATES-OLD-TABLE: opening a store whose fills table predates block_time_ms adds the column and preserves existing rows` | pre-migration table with rows (incl. NULL owner, huge u64) | rows lost, column absent, non-idempotent second open | `server/test/fill-time.test.ts : FILL-TIME-MIGRATES-OLD-TABLE` | server · fill-time | red |
| `REQ-K-2` | `CANDLES-BUCKET-AND-OHLC: per-bucket open/high/low/close/volume/trades equal an independently computed grouping of the generated fills` | fills across bucket edges, equal timestamps, huge/small u64, gaps, null times mixed in | any of o/h/l/c/volume/trades off by one fill or one bucket | `server/test/candles.test.ts : CANDLES-BUCKET-AND-OHLC` | server · candles | red |
| `REQ-K-2` | `CANDLES-COMPACT-ASCENDING-WINDOWED: the array is ascending, holds only non-empty buckets, never exceeds limit, never contains a bucket below B_max − (limit−1)×intervalMs, and its last bucket is B_max` | counts straddling the limit; buckets exactly on the window edge; single bucket; empty input | padded empty bucket, out-of-window bucket, >limit, wrong last bucket | `server/test/candles.test.ts : CANDLES-COMPACT-ASCENDING-WINDOWED` | server · candles | red |
| `REQ-K-2` | `CANDLES-SKIP-UNTIMED-FILLS: NULL-time fills never create, extend or bound a bucket` | all-null fills; null at head/mid/tail; null with the largest seq | bucket formed by a null-time fill; B_max from a null row | `server/test/candles.test.ts : CANDLES-SKIP-UNTIMED-FILLS` | server · candles | red |
| `REQ-K-2` | `CANDLES-REJECT-BAD-PARAMS: unknown interval and out-of-range/non-numeric limit are rejected rather than defaulted` | `2h`, `60m`, empty, `abc`, `0`, `-1`, `1001`, huge float | silently defaulted value; accepted garbage | `server/test/candles.test.ts : CANDLES-REJECT-BAD-PARAMS` (+ e2e 400 in kline-e2e) | server · candles; server · kline e2e | red |
| `REQ-K-2` | `KLINE-CANDLES-E2E-TRUTH: candles served from a live indexed cross equal the pure aggregation of the indexed fills, timed, at the requested interval` | live: resting limit + taker market cross; both intervals | served candles ≠ pure aggregation; empty despite fills | `server/test/kline-e2e.test.ts : KLINE-CANDLES-E2E-TRUTH` | server · kline e2e | red |
| `REQ-K-3` | `TRADES-LATEST-FIRST-BOUNDED: rows are strictly descending by seq, at most limit, with the exact stored fields` | limits 1..N; equal slots; null time rows; duplicate seq insertion rejected | ascending order, over-limit, field drift vs stored row | `server/test/market-trades.test.ts : TRADES-LATEST-FIRST-BOUNDED` | server · market-trades | red |
| `REQ-K-3` | `TRADES-INCLUDE-UNTIMED: a row whose block_time_ms is NULL still appears with timeMs: null` | mixed null/timed rows | null-time row dropped or timeMs coerced | `server/test/market-trades.test.ts : TRADES-INCLUDE-UNTIMED` | server · market-trades | red |
| `REQ-K-3` | `KLINE-TRADES-E2E-TRUTH: the trades served from a live cross match the indexed fills desc by seq with non-null timeMs` | live cross | wrong ordering/count/fields | `server/test/kline-e2e.test.ts : KLINE-TRADES-E2E-TRUTH` | server · kline e2e | red |
| `REQ-K-4` | `WS-TRADE-PUSH-EXACTLY-ONCE: a live cross delivers exactly one trade message per new fill, in ascending seq order, matching the REST trade row, and a forced resync re-delivery adds none` | 1..k fills; duplicate ring re-delivery (forced resync); reconnect mid-stream | duplicate push; missing push; wrong payload; out-of-order | `server/test/ws-trade.test.ts : WS-TRADE-PUSH-EXACTLY-ONCE` | server · ws trade push | red |
| `REQ-K-5` | `KEEPER-BOOKS-MAKER-FILLS: with a resting maker limit crossed by a taker, one tick books the maker's position (notional == fill size) and the ring event reads settled` | maker sizes; both sides; taker sizes ≥ / < maker size | position not booked; settled flag still 0; tick rejected | `server/test/keeper-settle.test.ts : KEEPER-BOOKS-MAKER-FILLS` | server · keeper settle | red |
| `REQ-K-5` | `KEEPER-SETTLE-IDEMPOTENT: a second tick reports settledFills 0 and changes nothing on chain` | immediate second tick; further fills between ticks | double-book; second tick error; settledFills > 0 | `server/test/keeper-settle.test.ts : KEEPER-SETTLE-IDEMPOTENT` | server · keeper settle | red |
| `REQ-F-1` | `I18N-DICTIONARIES-IDENTICAL-KEYS: both locale dictionaries expose exactly the same non-empty key set` | — (structural) | missing/extra key in either locale; empty value | `frontend/test/i18n.test.tsx : I18N-DICTIONARIES-IDENTICAL-KEYS` | frontend · unit | red |
| `REQ-F-1` | `LOCALE-RESOLUTION: a stored locale wins; otherwise navigator.language zh* → zh-Hant; anything else → en` | stored en/zh/garbage; nav zh-TW/zh-CN/en-US/fr/empty | stored ignored; zh → en; garbage → crash | `frontend/test/i18n.test.tsx : LOCALE-RESOLUTION` | frontend · unit | red |
| `REQ-F-1` | `SHELL-RENDERS-PANELS: the shell renders its seven panels, sets data-theme="dark", and the locale toggle swaps a known label's language` | locale en/zh; portfolio null/present; market null | panel missing; theme attr absent; toggle no-op | `frontend/test/i18n.test.tsx : SHELL-RENDERS-PANELS` | frontend · unit | red |
| `REQ-F-2` | `API-CLIENT-CONTRACT: every client function issues the exact method/path/request body, attaches the JWT exactly on the gated routes, and maps the error envelope to a typed error` | table over all 14 endpoints; 200/400/401/501 envelopes | wrong path/method/body; JWT on public route or missing on gated; envelope mis-mapped | `frontend/test/api-client.test.ts : API-CLIENT-CONTRACT` | frontend · unit | red |
| `REQ-F-2` | `DEMO-WALLET-PERSISTS-AND-SIGNS: a generated demo keypair round-trips through storage and its signMessage signatures verify against its public key; reset clears storage` | fresh store; existing store; corrupted store JSON | regenerated on reload; invalid signature; reset leaves key | `frontend/test/demo-wallet.test.ts : DEMO-WALLET-PERSISTS-AND-SIGNS` | frontend · unit | red |
| `REQ-F-2` | `AUTH-STATE-FALLBACK: a 401 on an authed read clears the session and lands in connected (not disconnected), while success walks disconnected→connected→authed→bound` | event sequences incl. bind-before-login, logout, expired session | 401 → disconnected; bind skips authed; stuck state | `frontend/test/auth-flow.test.ts : AUTH-STATE-FALLBACK` | frontend · unit | red |
| `REQ-F-2` | `TRADE-GATED-UNTIL-BOUND: a connected but unbound wallet sees disabled trading controls plus the bind CTA, and a confirmed bind enables them` | auth phases (disconnected/connected/authed/bound) × portfolio states | controls enabled while unbound; CTA missing when authed-unbound; still disabled after bind | `frontend/test/trade-gate.test.tsx : TRADE-GATED-UNTIL-BOUND` | frontend · unit | red |
| `REQ-F-3` | `PORTFOLIO-DELTA-APPLIES-TO-SNAPSHOT: for generated portfolio pairs, applying the delta messages onto the earlier snapshot equals the later snapshot on every field (sides normalised)` | signed bigint debt/collateral deltas; side closes; omitted sides; zero deltas; hostile i128 strings | any field off; closing side retained; position side dropped wrongly | `frontend/test/portfolio-delta.test.ts : PORTFOLIO-DELTA-APPLIES-TO-SNAPSHOT` | frontend · unit | red |
| `REQ-F-3` | `CANDLE-INCREMENTAL-EQUALS-BATCH: folding trade-by-trade onto candles equals aggregating the whole fill sequence at once (any bucket boundary crossing), and a trade older than the last candle is ignored` | sequences crossing bucket edges; equal stamps; duplicate seq; older-than-last stragglers; u64 extremes | folded result ≠ batch; straggler mutates last candle | `frontend/test/candles-fold.test.ts : CANDLE-INCREMENTAL-EQUALS-BATCH` | frontend · unit | red |
| `REQ-F-3` | `TAPE-DEDUPES-AND-ORDERS: duplicate and out-of-order trade messages converge to a unique seq-descending tape capped at 50` | duplicates, shuffled, gaps, >50 arrivals | dupes kept; order broken; cap violated | `frontend/test/tape.test.ts : TAPE-DEDUPES-AND-ORDERS` | frontend · unit | red |
| `REQ-F-3` | `WS-RECONNECT-BACKOFF: the client connects immediately to url?token=…, reports connecting→open, delivers parsed messages, reconnects on a ×2 backoff from a 500 ms base capped at 10 s (reset on open), and close() stops it permanently` | timer sweeps over every backoff step (500→1000→2000→4000→8000→cap), the cap boundary, reset-on-open, stop() races | connected late or doubling the socket; wrong first delay; the 16 s wait honoured instead of clamped to 10 s; no reset after a successful open; resurrection after close() | `frontend/test/ws-client.test.ts : WS-RECONNECT-BACKOFF` | frontend · unit | red |
| `REQ-F-4` | `BOOK-PANEL-RENDERS-AND-PREFILLS: given a BookView the rows show formatted values best-first and a click hands the raw price to the form` | full/one-sided/empty book; extreme prices | mis-ordered rows; raw↔display mix-up; click no-op | `frontend/test/book-panel.test.tsx : BOOK-PANEL-RENDERS-AND-PREFILLS` | frontend · unit | red |
| `REQ-F-5` | `PARSE-FORMAT-EXACT: parseAmount("1.5") == "1500000", round-trips formatAmount(parseAmount(x)) for generated 6-dp strings, and rejects malformed/7-dp/overflowing input without floating point` | 6-dp strings incl. "0.000001", huge u64 boundary, "1.0000000", "", "abc", "-1", "1e6", ".", ",", unicode digits | float precision loss; >6 dp accepted; overflow wraps | `frontend/test/order-form.test.tsx : PARSE-FORMAT-EXACT` | frontend · unit | red |
| `REQ-F-5` | `ORDER-FORM-VALIDATION-AND-BODY: invalid forms cannot submit; a valid limit submit calls the client with the exact raw body` | empty/zero/negative/7-dp fields; market vs limit; both sides | submit enabled while invalid; body drift (float, missing price) | `frontend/test/order-form.test.tsx : ORDER-FORM-VALIDATION-AND-BODY` | frontend · unit | red |
| `REQ-F-5` | `CLOSE-BODY-AND-DEFAULT-SIZE: the close action defaults to the full raw notional and submits the exact {side, size}` | partial sizes; full notional; invalid size | wrong side byte; scaled/rounded size | `frontend/test/positions-panel.test.tsx : CLOSE-BODY-AND-DEFAULT-SIZE` | frontend · unit | red |
| `REQ-F-6` | `CHART-CONTROLLER-INTERVAL-SWITCH: switching interval refetches with the new interval parameter and replaces the series data; a trade push updates the series with the folded last candle` | all six intervals; trades before data; duplicate trades | stale interval used; setData skipped; update with unfolded candle | `frontend/test/chart-controller.test.ts : CHART-CONTROLLER-INTERVAL-SWITCH` | frontend · unit | red |
| `REQ-F-7` | `ACCOUNT-PANEL-ACTIONS: deposit and withdraw submit exact raw bodies; missing amounts disable submit; the liquidatable health renders its alert style` | empty/valid/7-dp amounts; healthy/liquidatable | float body; enabled invalid; no styling hook | `frontend/test/account-panel.test.tsx : ACCOUNT-PANEL-ACTIONS` | frontend · unit | red |
| `REQ-M-1` | `MM-QUOTES-NEVER-CROSS-AND-BOUNDED: for generated anchors/books/params, bids < asks strictly, no quote crosses the current book (violating levels are omitted), per-side count ≤ min(levels, capacity), prices are positive integers` | one-sided/empty/tight/extreme books; anchor near tick edges; levels 1..8; spread 1..1000 bps | crossing quote; zero/negative price; over-capacity; non-integer | `scripts/test/mm-lib.test.ts : MM-QUOTES-NEVER-CROSS-AND-BOUNDED` | scripts · mm/devstack | red |
| `REQ-M-1` | `MM-LADDER-EXACT-OFFSETS: level k sits exactly k×spread bps away (floor/ceil direction) and one-sided books fall back to the index anchor` | exact bps math incl. rounding remainders; one-sided books | rounding direction flipped; mid kept when one-sided | `scripts/test/mm-lib.test.ts : MM-LADDER-EXACT-OFFSETS` | scripts · mm/devstack | red |
| `REQ-M-1` | `MM-REQUOTE-PLAN-COVERS-OWN-ORDERS: the cancel+place plan cancels exactly the bot's resting orders and places the desired grid` | own orders subset; foreign orders present; none resting | foreign order cancelled; own order kept; grid size mismatch | `scripts/test/mm-lib.test.ts : MM-REQUOTE-PLAN-COVERS-OWN-ORDERS` | scripts · mm/devstack | red |
| `REQ-V-1` | `DEVSTACK-ENV-BLOCK-COMPLETE: the env-block printer emits all required keys for both the server and the bot given generated values` | path/values generated per run | missing key; stale value; wrong quoting | `scripts/test/devstack-env.test.ts : DEVSTACK-ENV-BLOCK-COMPLETE` | scripts · mm/devstack | red |

## Red baseline

- Must be RED on today's tree: every proposition in the table above (35 propositions across 21 files; `CANDLES-REJECT-BAD-PARAMS` is asserted at both its unit and e2e sites → 36 red tests).
- Already GREEN on today's tree (regression pins): `API-CONTRACT-MATCHES-OPENAPI` (existing; kept green by updating `docs/api/openapi.json` and `ROUTES` together in the freeze commit), all pre-existing server/sdk/cli/publisher/interfaces suites.
- Collateral pass (once, pre-freeze; smallest suites covering every surface the stubs touch —
  `ROUTES`+openapi → `api.test.ts`; `KeeperTickResult` → `keeper.test.ts`; the sdk type is
  erased → `sdk` suite; scripts config edits → the offline e2e dry-run):
  36 intended red / api.test.ts + keeper.test.ts + sdk (86/86) + scripts dry-run all green / 0 unintended.
- Evidence: `/root/.hermes/cache/scratch/red/` (per-file red logs + collateral logs), captured 2026-10-08; freeze sha `<sha>`.

## Alternative evidence (non-PBT)

| ID | Command | What the human inspects | Discharges |
| --- | --- | --- | --- |
| `A-F-1` | run devstack + server + mm-bot + `frontend` dev server; browser walkthrough (demo wallet → faucet → bind → deposit → limit + market open → book/chart/tape live → close) | screenshots of each step; positions and book match chain state | `REQ-F-2`..`REQ-F-7` end-to-end |
| `A-F-2` | open the app | dark theme tokens applied; 科技感 look (panels, mono numerals, accents) | `REQ-F-1` |
| `A-M-1` | `cd scripts && npm run mm` against the devstack | two-sided quotes in `GET /market/book`; survives a full-side fill; requotes within one interval | `REQ-M-2` |
| `A-V-1` | `cd scripts && npm run devstack` | clean boot log, initialized market, printed env blocks copy-paste ready, non-zero exit on failure | `REQ-V-1` |
| `A-O-1` | read `docs/api/ws.md` + `docs/api.md` | `trade` row + sample present; candles/trades documented | `REQ-O-1` |
| `A-O-2` | `grep -n "frontend" AGENTS.md` | Build & Test + Structure entries present | `REQ-O-2` |
| `A-O-3` | parse `ci.yml` (yq) + run the frontend job's local equivalents | valid YAML; `frontend` job present; commands green locally | `REQ-O-3` |
| `A-O-4` | read `frontend/README.md` + `docs/README.md` link | instructions complete; link resolves | `REQ-O-4` |

## Gaps and risks

- `R-1` The browser walkthrough (`A-F-1`) depends on the live local stack on this box; the validator RPC stays unauthenticated (demo scope, per prior decision).
- `R-2` `getBlockTime` freshness on a just-confirmed slot can lag/null on some RPCs; the fallback masks it at the cost of occasional ingest-clock buckets (bounded to that fill).
- `R-3` GitHub CI cannot be exercised from here — `A-O-3` covers YAML validity + local equivalents only.
- `R-4` Chart interactions (zoom/drag/tooltips) are visual-only — `A-F-2` scope, no assertions.
- `R-5` MM bot is proved on quote math + liveness; adversarial market regimes (extreme drift, book races) are not simulated.
- `R-6` Settle sweep failures log-and-retry until the ring wraps (`EventNotFound`) — by design, not asserted beyond idempotence.
