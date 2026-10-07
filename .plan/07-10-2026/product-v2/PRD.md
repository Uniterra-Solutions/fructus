# PRD — product-v2: operator delegation, cross-margin accounts, backend service, trader interfaces

| Field | Value |
| --- | --- |
| Plan | `product-v2`: workstreams A–C (operator layer, cross-margin margin model, backend service, frontend-facing interfaces) |
| Date | 2026-10-07 |
| Status | Frozen — settled by discussion; not yet implemented |
| Source | Owner directive 2026-10-07: 「按照我們總結出來的完整實作方案，走完整PDD流程實作A-C」 (A–D workstream breakdown of the same date); prior sessions defined the product context (devnet product prototype, CEX-style UX: no-signature deposit/withdraw/trade after wallet binding, automatic margin management, cross margin). |
| Related | `ACCEPTANCE.md` — per-REQ propositions and evidence |

**Brevity contract.** This document carries ONLY the settled decisions, the requirement list, and
what each requirement is measured against. Background, current-state narratives and repo facts
stay out — the implementer fetches context from the repository itself.

## Decisions (settled; not up for re-discussion)

- **D1 Scope = A–C only**: A1 operator layer, A2 cross-margin model, B backend service, C interfaces.
  Rejected: frontend UI and the D workstream (MM bot, demo choreography) — a separate later run.
- **D2 Operator surface is ADDITIVE**: 8 new instructions (`set_operator` + 7 `operator_*`) with new
  `Accounts` structs; the existing 21 instructions and their structs stay byte-identical on the
  direct path. Rejected: reworking the 7 existing handlers to dual-signer (`authority == user ||
  operator`) — would churn every existing bank/SDK call site and entangle the delegation auth
  surface with the direct path.
- **D3 Operator record**: new `Operator` PDA per `(market, user)`, seeds
  `[OPERATOR_SEED = b"operator", market, user]`, borsh fields `{market, user, operator, bump}`,
  `LEN = 97`. `set_operator(Pubkey)`: user-signed; lazy-create on first call; overwrite = rotate;
  `Pubkey::default()` = revoke (record kept, `operator` field cleared). Rejected: extending
  `UserCollateral` (LEN = 25 pinned, layout freeze); closing the record on revoke (rent churn, no
  benefit).
- **D4 Operator deposit pull**: the bind transaction is `[spl_token approve(Operator PDA, u64::MAX),
  set_operator(platform key)]`, signed once by the user; `operator_deposit_collateral` transfers
  `user_ata → vault` with the Operator PDA as SPL delegate via `invoke_signed`, crediting the
  subject user's ledger. Rejected: bounded allowance with periodic re-approve — breaks the
  no-extra-signature UX; the PDA constraint already bounds the attack surface.
- **D5 Operator withdraw destination**: vault USDC can only ever reach the subject user's own ATA
  (mint + owner checked in-handler); an operator can never redirect funds.
- **D6 Cross margin = hedge-mode style account-level model (NO netting)** — *defaulted: user not
  reached at plan time; recommended option; vetoable until implementation begins*. Requirement =
  `Σ_side margin_required(n_side, bps)`; equity = `deposited + Σ_side upnl`. Rejected: net
  (long−short) margin — redefines settlement/liquidation interaction of the two legs; deferred
  to a future plan.
- **D7 No account-layout changes** in A2: `Position.collateral` stays `≡ margin_required(notional,
  initial_margin_bps)` (now the *requirement contribution*); `UserCollateral.reserved` stays the
  checked sum over sides. The devnet state survives the upgrade (no re-init). Rejected: layout
  redesign with a state wipe — unnecessary for the semantics above.
- **D8 Account-level liquidation**: `liquidate(side, amount)` takes BOTH side positions
  (`position` + `other_position`) and triggers on
  `equity < Σ_side margin_required(n_side, maintenance_bps)` (strict `<`). The partial/full
  transition applies to the targeted side only: released margin `= m(n, im) − m(n−amount, im)`,
  reward `= penalty(released, 500)`; the victim's unrealized loss `max(0, −Σ upnl)` is booked into
  the pool with the existing clamp `deposited − reserved_after − reward` (extends the Stage-1
  operating model). TWAP window/staleness guard unchanged.
- **D9 Withdraw gains an equity gate**: `withdraw_collateral` requires BOTH
  `amount ≤ deposited − reserved` AND `equity − amount ≥ reserved` (post-withdraw equity at or
  above the initial requirement), where `equity = deposited + Σ_side upnl`. New accounts:
  `index_source`, `position_long`, `position_short` (pristine/missing sides = zero contribution).
  Rejected: ledger-only gate (lets a user self-drain to forced liquidation; CEX-parity requires
  blocking).
- **D10 Opens/places are NOT equity-gated** in v2: `open_position` / `place_*` keep the free-seam
  check only. A keeper cleans up any account that opens itself into liquidatability.
- **D11 Backend = new top-level `server/` package** (TypeScript ESM, `tsx`, `node:test`), single
  process; storage `node:sqlite` (Node ≥ 22 builtin — verified working on this box); `ws` is the
  only new runtime dependency; HTTP via `node:http` (no framework); auth SIWS (ed25519 via
  `node:crypto`) + JWT (HMAC-SHA256). Fixtures under `mkdtemp`. Rejected: Postgres (overkill for
  the devnet prototype), Fastify/Express (dependency weight), SSE (weaker fit for trading push).
- **D12 Indexer reads the chain over RPC WebSocket first**: `programSubscribe` for all program
  accounts + `getProgramAccounts` resync on start and every 60 s (devnet data is tiny). gRPC /
  Carbon is the documented upgrade path, not this iteration. (Owner directive: 「後端對鏈用ws先就好了」.)
- **D13 SDK browser path**: Anchor discriminators become precomputed constant tables (instructions
  + account types) instead of runtime `node:crypto` hashing; a Node-side test cross-checks every
  table entry against `sha256` and pins the table size. Rejected: `@noble/hashes` dependency —
  needless for a fixed constant set.
- **D14 API = REST (JSON) + WebSocket push**; routes `/auth/*`, `/bind/*`, `/me*`, `/market*`,
  `/actions/*`, `/faucet`, `/healthz`; DTO types live in `sdk/src/api.ts` and are imported by the
  server (single source of truth for the future frontend). The machine-readable contract is
  `docs/api/openapi.json` (JSON, zero-dep parseable) + `docs/api/ws.md`.
- **D15 Faucet**: devnet-only test-USDC mint endpoint, per-wallet and global daily caps; disabled
  unless `FAUCET_ENABLED=1` and a mint authority keypair are configured.
- **D16 Keeper = protocol-side automation** (Stage-1 model): interval loop that cranks the event
  queue, sweeps `settle_funding` / `settle_close`, and liquidates below-maintenance accounts via
  the new account-level trigger. Third-party liquidation remains permissionless (unchanged).
- **D17 Deployment**: prepare the upgrade bundle (v3 build command + `solana program deploy
  --upgrade-authority` runbook, since `anchor` CLI is not installed on the build box); execute the
  devnet upgrade in-run IF the owner's keypair material is on the machine, else hand the bundle
  over — *defaulted: user not reached; vetoable until implementation begins*. The upgrade is
  backward-compatible: no state wipe.
- **D18 Local commits only** (PDD discipline); plan documents live at `.plan/07-10-2026/product-v2/`
  and are force-added (`git add -f`) because the repo ignores `.plan/`.
- **D19 Docs sync is part of the deliverable**: `docs/api-reference.md` (+8 instructions, changed
  `liquidate`/`withdraw` rows), new `docs/modules/operator.md`, `docs/modules/liquidation.md`
  rewrite (account-level model), `docs/data-models.md` (Operator row), `docs/api.md` +
  `docs/api/openapi.json` + `docs/api/ws.md`, `docs/README.md` index, `CHANGELOG.md`, and the
  measured test counts refreshed at the end. `AGENTS.md` invariant text updates are approval-gated
  (protected file) — attempt at the end, park if not approved.
- **D20 Margins of change stay inside declared files**: no `.github/workflows/ci.yml` job rework
  beyond adding the `server` job and the new bank suite to the bank job's filters; no changes to
  the publisher, the stake-pool offsets, the oracle message format, or the trident harness.

## Requirements

### item A1 — Operator delegation (on-chain + SDK)

#### REQ-A1-1 Operator account layout and PDA

- **Statement**: `Operator` is a borsh account `{market: Pubkey, user: Pubkey, operator: Pubkey,
  bump: u8}`, payload exactly 97 bytes; PDA seeds `[b"operator", market, user]` (new constant
  `OPERATOR_SEED`); seed round-trip holds for arbitrary keys.
- **Rationale**: D3 — additive per-(market, user) delegation record.
- **Testability**: `OPERATOR-LAYOUT-PINNED: the Operator payload is exactly 97 bytes and its PDA
  round-trips through create_program_address.`

#### REQ-A1-2 `set_operator` instruction

- **Statement**: `set_operator(operator: Pubkey)` — accounts `[user (Signer, mut), market,
  operator_record (mut, seeds [OPERATOR_SEED, market, user], bump), system_program]`. First call
  lazily creates the record (payer = user, rent = `8 + 97`); existing program-owned record is
  overwritten (rotate); `Pubkey::default()` stores the revoke state; every call writes
  `market`/`user`/`bump`; a non-program-owned non-pristine account at the PDA ⇒
  `FructusError::OperatorPdaSquatted` (new).
- **Rationale**: D3, D4.
- **Testability**: `SET-OPERATOR-CREATES-ROTATES-REVOKES: set_operator lazily creates, overwrites
  and revokes the record, with the revoke state stored as Pubkey::default() and no account close.`
  `SET-OPERATOR-IS-USER-ONLY: only the subject user's signature mutates the record.`

#### REQ-A1-3 `operator_deposit_collateral`

- **Statement**: new instruction, `(amount: u64)`; transfers `amount` from the subject's ATA to the
  vault with the Operator PDA as SPL delegate (`invoke_signed`), credits the subject's ledger
  (claim-payout then checked credit; lazily creates the ledger, payer = operator signer); requires
  a matching `Operator` record (`operator == signer`, market/user match, not revoked) else
  `FructusError::OperatorUnauthorized` (new); zero amount ⇒ `InvalidSize`; missing/short SPL
  approval ⇒ the token program's error propagates and no ledger mutation persists. Account order:
  `[operator (Signer, mut), user, market, user_collateral (mut), operator_record, vault (mut),
  user_ata (mut), collateral_mint, token_program, system_program]`.
- **Rationale**: D4 — the deposit half of 「入金不用額外簽名」.
- **Testability**: `OPERATOR-DEPOSIT-MOVES-FUNDS-FOR-USER: with the bind approval in place,
  operator_deposit_collateral moves USDC from the user's ATA into the vault and credits the
  ledger, with the operator key as the only signer.`
  `OPERATOR-DEPOSIT-REQUIRES-APPROVAL: without an SPL approval ≥ amount, the instruction fails and
  all balances are unchanged.`

#### REQ-A1-4 `operator_withdraw_collateral`

- **Statement**: new instruction, `(amount: u64)`; pays the vault → the subject user's own ATA
  only (mint + owner verified in-handler); same equity gate as REQ-A2-3; the vault PDA (the vault
  token account's authority) signs the token transfer — the Operator PDA is only the ATA delegate
  for deposits (W1 deviation #2). Account order: `[operator (Signer), user, market, user_collateral (mut),
  operator_record, vault (mut), user_ata (mut), collateral_mint, index_source, position_long,
  position_short, token_program]`.
- **Rationale**: D5 + 「出金不用額外簽名」.
- **Testability**: `OPERATOR-WITHDRAW-PAYS-ONLY-THE-USER: the withdrawn tokens can only land in the
  subject user's ATA — a foreign destination account fails the handler's owner/mint checks.`

#### REQ-A1-5 Operator order instructions

- **Statement**: five new instructions mirror the direct counterparts with the operator as signer
  and the subject as order owner / position seed:
  `operator_open_position(side, size, price)`, `operator_close_position(side, size)`,
  `operator_place_limit_order(side, price, size)`, `operator_place_market_order(side, size)`,
  `operator_cancel_order(seq)`. Behaviour otherwise identical (same core logic as the direct
  handlers, extracted into shared internal functions). Account orders in the Appendix. Orders and
  positions are attributed to the SUBJECT (`position.owner = subject`, `order.owner = subject`).
- **Rationale**: D2, 「每次交易不用額外簽名」.
- **Testability**: `OPERATOR-ORDERS-ATTRIBUTE-TO-THE-USER: an order placed, opened, closed or
  cancelled by the operator mutates exactly the subject's position/ledger/book rows.`

#### REQ-A1-6 Authorization matrix

- **Statement**: every `operator_*` instruction rejects: (a) no record, (b) a revoked record
  (`operator == Pubkey::default()`), (c) `signer ≠ record.operator`, (d) a record for another
  market — all with `OperatorUnauthorized` and zero state mutation. Pure predicate:
  `operator::authorized(signer, record_operator, record_market, record_user, market, user)
  -> bool`.
- **Rationale**: D2/D3 — the delegation trust boundary.
- **Testability**: `OPERATOR-AUTH-MATRIX: authorized(s) ⇔ record exists ∧ record.operator ==
  signer ≠ default ∧ record.market == market ∧ record.user == user, total over all inputs.`
  (proptest) + a bank matrix scenario over all 7 instructions.

#### REQ-A1-7 SDK operator surface

- **Statement**: `sdk/` adds `operatorPda(market, user)`, `decodeOperator` (layout + decoder),
  builders `buildSetOperator`, `buildOperatorDepositCollateral`, `buildOperatorWithdrawCollateral`,
  `buildOperatorOpenPosition`, `buildOperatorClosePosition`, `buildOperatorPlaceLimitOrder`,
  `buildOperatorPlaceMarketOrder`, `buildOperatorCancelOrder`, and the bind/revoke helpers
  `buildOperatorBindInstructions({user, market, operator, approveAmount})` →
  `[spl approve, set_operator]` and `buildOperatorRevokeInstructions({...})` →
  `[spl approve(0), set_operator(default)]` (web3 `TransactionInstruction[]`, wallet-signable).
  Existing builder signatures and encodings unchanged.
- **Rationale**: D4; the frontend and the backend both consume this surface.
- **Testability**: `SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact
  discriminator, argument bytes and account meta list (keys, order, signer/writable flags) the
  program's Accounts struct declares.` `SDK-OPERATOR-DECODER-ROUNDTRIPS: decodeOperator round-trips
  the 97-byte layout byte-exactly.`

#### REQ-A1-8 Operator documentation

- **Statement**: `docs/api-reference.md` gains the 8 instruction rows with account lists and error
  cells; new `docs/modules/operator.md` (model, bind/rotate/revoke flow, trust story, allowances);
  `docs/data-models.md` gains the `Operator` row (97 bytes, seed, field offsets).
- **Rationale**: D19; repo "one home per fact".
- **Testability**: `DOCS-OPERATOR-SURFACE-COMPLETE: a source-embedding audit test finds every new
  instruction name in docs/api-reference.md and the Operator layout row in data-models.md.`

### item A2 — Cross-margin account model

#### REQ-A2-1 Account-level margin/health pure model

- **Statement**: `liquidation.rs` provides `account_equity(deposited: u64, pnl_sum: i128) -> i128`
  (= `deposited + pnl_sum`, saturating), `account_margin_required(n_long: u64, n_short: u64,
  bps: u16) -> Option<u64>` (checked sum of the two `margin_required` ceilings), and
  `account_liquidatable(deposited, pnl_sum, n_long, n_short, maintenance_bps) -> Option<bool>` =
  `(n_long + n_short == 0) ⇒ false`, else `equity < Σ m(n_i, mm)` strict. The per-position
  `liquidatable` / `equity` functions are deleted (superseded).
- **Rationale**: D6, D8.
- **Testability**: `ACCOUNT-HEALTH-IS-EQUITY-VS-TOTAL-MAINTENANCE: account_liquidatable equals
  (deposited + Σ upnl < Σ_side m(n_side, mm)), strict, with the zero-exposure short-circuit and
  totality on the whole domain.` `ACCOUNT-MARGIN-SUMS-BOTH-SIDES: account_margin_required is the
  checked sum of both sides' ceilings and monotonic in each notional.`

#### REQ-A2-2 Account-level `liquidate`

- **Statement**: `liquidate(side: u8, amount: u64)`; accounts gain `other_position`
  (the opposite side's Position PDA; pristine/missing ⇒ zero contribution; program-owned mismatch
  ⇒ `InvalidAccountData`; squatted ⇒ `PositionPdaSquatted`). Trigger: the ACCOUNT-level predicate
  above (else `NotLiquidatable`); TWAP window guard unchanged. Transition on `side`:
  `released = position.collateral − min(m(n − amount, im), position.collateral)`;
  `position.collateral := m(n − amount, im)`; `notional −= amount`; `reserved −= released`;
  `reward = penalty(released, 500)`; `loss = max(0, −Σ upnl)` booked via `apply_liquidation_loss`
  (clamp `deposited − reserved_after − reward`); victim.deposited `−= booked` then `−= reward`;
  liquidator.deposited `+= reward`. Zero-sum (Σ deposits + pool conserved) and
  `reserved == Σ m(n_i, im)` are invariants.
- **Rationale**: D8 — this is the "全倉" liquidation semantic.
- **Testability**: `LIQUIDATE-TRIGGERS-ON-ACCOUNT-HEALTH: liquidation succeeds iff the account's
  equity is below its TOTAL maintenance requirement — a side that is individually healthy can
  still be liquidated while the account is under-margin.` (bank) `LIQUIDATION-CONSERVES-ACCOUNT-VALUE:
  over any liquidation Σ(victim + liquidator + pool) is unchanged and reserved equals Σ m(n_i, im)
  afterwards.` (proptest + bank) `LIQUIDATE-RELEASES-ONLY-THE-TARGETED-SIDE: only the targeted
  side's notional and collateral change; the other side is byte-identical.`

#### REQ-A2-3 Withdraw equity gate

- **Statement**: `collateral::withdraw(deposited, reserved, pnl_sum: i128, amount) -> Option<u64>`
  (signature change; supersedes the old two-arg gate): `None` unless
  `amount ≤ deposited − reserved` AND `equity − amount ≥ reserved`; else `Some(deposited − amount)`.
  `WithdrawCollateral` (direct) accounts gain `index_source`, `position_long`, `position_short`
  before `token_program`; the handler claim-payouts first, computes `Σ upnl` from both sides
  (pristine ⇒ 0), applies the gate (fail ⇒ `InsufficientFreeCollateral`, no transfer), then pays.
- **Rationale**: D9.
- **Testability**: `WITHDRAW-BLOCKED-BELOW-INITIAL-MARGIN: a withdrawal that would leave
  equity < the initial requirement fails and moves nothing; one that keeps equity ≥ it succeeds.`
  (bank + proptest over the pure gate)

#### REQ-A2-4 Top-up restores health

- **Statement**: an additional `deposit_collateral` increases equity one-for-one; a
  below-maintenance account becomes healthy (not liquidatable) once the deposit closes the gap.
  (No new code path — it is the observable consequence of REQ-A2-1/D7.)
- **Rationale**: 「自動變全倉保證金」 — top-up is the product's core margin-management primitive.
- **Testability**: `DEPOSIT-IMPROVES-ACCOUNT-HEALTH: depositing into an under-margin account
  raises equity one-for-one and a sufficient deposit flips the account-level liquidatable
  predicate to false.` (bank scenario)

#### REQ-A2-5 SDK account-health mirrors

- **Statement**: `sdk/` adds `accountEquity`, `accountMarginRequired`, `accountLiquidatable`
  mirrors (byte-identical formulas), updates `buildLiquidate({market, position, otherPosition,
  userCollateral, orderBook, indexSource, liquidator, liquidatorCollateral, side, amount})`, and
  updates `buildWithdrawCollateral` to the new account set.
- **Rationale**: keeper + future UI need the same truth server-side.
- **Testability**: `SDK-ACCOUNT-HEALTH-MIRRORS-RUST: the TS account-health mirrors are
  byte-identical to the Rust formulas across a seeded deterministic sweep (≥10k cases).`

#### REQ-A2-6 Supersession is complete

- **Statement**: the per-position liquidation path (`liquidation::liquidatable`, `equity`, the
  maintenance-parameter-carrying `apply_liquidation` signature) and its tests are deleted in the
  same change that adds the account-level successors; the two `review_liquidation_*` suites are
  replaced by account-level equivalents (same purposes: surviving-collateral invariant,
  conservation); no per-position liquidation vocabulary remains in the program or docs.
- **Rationale**: PDD philosophy #7/—— superseded claims are replaced, never grandfathered.
- **Testability**: `NO-PER-POSITION-LIQUIDATION-REMAINS: a source scan finds no per-position
  liquidatable/equity path outside the account-level definitions.` (source-embedding audit test)
  + the replaced review suites being the live pins.

#### REQ-A2-7 Liquidation/positions documentation

- **Statement**: `docs/modules/liquidation.md` rewritten to the account-level model (trigger,
  transition, booking, Stage-1 keeper note, TWAP guard); `docs/modules/positions.md` margin
  section updated (requirement vs equity); `docs/api-reference.md` `liquidate` row updated
  `(side, amount)` + accounts; `docs/modules/collateral.md` withdraw gate updated.
- **Rationale**: D19.
- **Testability**: `DOCS-ACCOUNT-MARGIN-MODEL: source-embedding audit finds the account-level
  formulas (`account_liquidatable` semantics) and the new `liquidate` signature in the named
  docs.`

### item B — Backend service (`server/`)

#### REQ-B-1 Server package scaffold

- **Statement**: new top-level `server/` package: `package.json` (name `fructus-server`, private,
  ESM, `tsx`; deps `@solana/web3.js ^1.99`, `fructus-sdk file:../sdk`, `ws ^8`, `fructus-integration
  file:../integration` (harness reuse); devDeps tsx/typescript/@types/node), strict `tsconfig.json`,
  `npm test` = `tsx --test --test-force-exit test/*.test.ts`, `npm run typecheck`, `npm start`/`dev`;
  modules under `server/src/` (config, db, indexer, state, auth, operator, keeper, api, ws, faucet,
  entry). `.env.example` documents every env key.
- **Rationale**: D11; repo conventions (publisher/sdk/cli package shape).
- **Testability**: run-command table entry (suite collects and executes > 0 tests) — no PBT claim.

#### REQ-B-2 Indexer (RPC WebSocket)

- **Statement**: `server/src/indexer.ts` ingests ALL program accounts via
  `connection.onProgramAccountChange` (WS, commitment `confirmed`), decodes via SDK decoders, and
  upserts into SQLite tables (`oracle`, `market`, `order_book`, `user_collateral`, `position`,
  `operator`); maintains a `fills` history derived from OrderBook event-ring diffs (exactly-once,
  seq-ordered) and a `funding` history from `PerpMarket.funding_accumulator` diffs; full
  `getProgramAccounts` resync at start and every 60 s; emits an in-process update event for the WS
  layer. Hostile inputs: out-of-order updates, duplicate deliveries, ring wrap, gaps, socket
  restarts.
- **Rationale**: D12; the frontend needs indexed truth, not raw RPC poking.
- **Testability**: `INDEXER-EVENT-DIFF-NO-LOSS-NO-DUP: folding any sequence (including
  out-of-order, duplicated and wrapped snapshots) yields each fill/funding event exactly once in
  seq order.` (pure, deterministic sweep) `INDEXER-STATE-MATCHES-CHAIN: after resync against a
  running validator the indexed state for every account decodes byte-identically to a direct RPC
  read.` (e2e)

#### REQ-B-3 Server-side state layer

- **Statement**: `server/src/state.ts` computes per-user portfolio
  (`deposited, reserved, claimable, free, positions[{side, notional, upnl, req_initial,
  req_maint}], equity, requirement_initial, requirement_maint, health: 'healthy'|'liquidatable'`)
  and market snapshot (mark/mid, index, funding accumulator, book levels) from indexed state via
  the SDK mirrors.
- **Rationale**: single truth for /me, /market, keeper decisions and the future frontend.
- **Testability**: `STATE-HEALTH-MATCHES-PROGRAM-TRIGGER: the server's liquidatable flag equals
  the program's account-level predicate for every generated account set` (property test) `and
  against a live validator` (e2e).

#### REQ-B-4 SIWS auth + sessions

- **Statement**: `POST /auth/challenge` returns a SIWS `signInInput` (domain = request host,
  nonce, issued-at, expiration ≤ 5 min; nonce single-use); `POST /auth/verify` verifies the
  ed25519 signature over the canonical message, consumes the nonce, and issues a JWT (HS256,
  `exp` = 24 h; secret from `JWT_SECRET`). All `/me*` and `/actions/*` routes require
  `Authorization: Bearer`; invalid/expired ⇒ 401 with the unified error envelope.
- **Rationale**: D14; the standard bind/login flow researched for this product.
- **Testability**: `AUTH-SIWS-ROUNDTRIP-AND-REJECTIONS: correct signatures yield sessions; wrong
  keys, tampered messages, replayed nonces and expired challenges are rejected.` `AUTH-SESSION-GATES-ROUTES:
  every private route 401s without a valid token and 200s with one.`

#### REQ-B-5 Operator service

- **Statement**: `server/src/operator.ts` exposes `executeDeposit(user, amount)`,
  `executeWithdraw(user, amount)`, `executeOrder(user, {kind: 'limit'|'market', side, size,
  price?})`, `executeCancel(user, {side, seq})`, `executeClose(user, {side, size})`; builds via
  the SDK operator builders; signs with `OPERATOR_KEYPAIR` (server-side only, never logged;
  separate from any upgrade authority); per-user FIFO queue with blockhash refresh + bounded
  retries; confirms via WS; records each attempt in a `tx_log` table (`signature, status, error`)
  exposed on the action responses.
- **Rationale**: D4/D5 — the signer half of the no-signature UX.
- **Testability**: `OPERATOR-SERVICE-SIGNS-AND-CONFIRMS: an action submitted through the service
  lands on-chain (observed state change) and its tx_log row reaches `confirmed` with a
  signature.` (e2e) `OPERATOR-QUEUE-SERIALIZES-PER-USER: concurrent enqueues for one user execute
  FIFO without interleaving or lost actions.` (unit, stub connection)

#### REQ-B-6 Keeper loop

- **Statement**: `server/src/keeper.ts` provides `tick()` (one bounded pass: crank → settle
  funding sweeps → settle-close sweeps → liquidation sweep) and an interval loop wrapper
  (`KEEPER_INTERVAL_MS`, default 5000; rate-limited, idempotent, per-action tx_log rows).
  Liquidation targets only accounts the state layer marks liquidatable, one action per account
  per tick.
- **Rationale**: D16; Stage-1 operating model.
- **Testability**: `KEEPER-SETTLES-AND-LIQUIDATES: with a drifted index and an under-margin
  account on a live validator, repeated tick() calls settle funding and liquidate the account
  with no manual instruction submission.` (e2e, deterministic tick driving)

#### REQ-B-7 REST + WS surface

- **Statement**: REST routes exactly: `POST /auth/challenge`, `POST /auth/verify`,
  `POST /bind/prepare` (returns the bind tx message for the user wallet to sign),
  `POST /bind/confirm`, `GET /me`, `GET /me/positions`, `GET /me/history`, `GET /market`,
  `GET /market/book`, `POST /actions/deposit`, `POST /actions/withdraw`, `POST /actions/orders`,
  `POST /actions/orders/cancel`, `POST /actions/positions/close`, `POST /faucet`, `GET /healthz`.
  JSON envelope `{ok: true, data}` / `{ok: false, error: {code, message}}`; error codes map
  FructusError names + transport errors. WS `/ws?token=…` pushes `{type: 'book'|'mark'|'user'|'tx',
  ...}` messages; unknown token ⇒ close 4401.
- **Rationale**: D14 — the frontend contract.
- **Testability**: `API-READS-SERVE-INDEXED-TRUTH: /me, /me/positions, /market, /market/book equal
  the indexed state for seeded scenarios.` `WS-PUSHES-STATE-CHANGES: a subscribed client receives
  the matching update within one state change.` (e2e)

#### REQ-B-8 Faucet

- **Statement**: `POST /faucet {wallet}` mints test USDC to the wallet's ATA; caps: per-wallet
  10,000 tUSDC / 24 h + global cap `FAUCET_GLOBAL_CAP` / 24 h; disabled (404) unless
  `FAUCET_ENABLED=1` and `FAUCET_MINT_AUTHORITY_KEYPAIR` configured; idempotency via nonce rows
  is NOT required — caps are the guard.
- **Rationale**: D15 — onboarding for the devnet prototype.
- **Testability**: `FAUCET-CAPS-ENFORCED: requests beyond the per-wallet budget are rejected;
  accepted calls move exactly the minted amount once.` (unit + e2e-lite)

#### REQ-B-9 End-to-end product walk

- **Statement**: a scripted e2e test performs the full walk against a live `solana-test-validator`
  + the v2 program: user wallet binds (`approve` + `set_operator`) → SIWS login → operator
  deposit → operator open → operator close → user withdraw → faucet — asserting on-chain state
  after every step. Only the operator key signs the operator steps.
- **Rationale**: the product's definition of done for A–C.
- **Testability**: `E2E-PRODUCT-WALK: the bind→deposit→trade→withdraw walk succeeds end-to-end
  with the operator as the sole signer of the operator steps.` (e2e)

#### REQ-B-10 Ops surface + CI

- **Statement**: `server/README.md` runbook (env keys, local validator bootstrap, keeper start,
  resync), `.env.example`; `scripts/` gains nothing new for run — runbook only; CI gains one
  `server` job (npm ci → typecheck → test) and the new bank suite `operator_cpi` is added to the
  bank-CPI job filters (and `positions_cpi`'s new scenarios run within the existing job).
- **Rationale**: D20; keep the repo coherent.
- **Testability**: A-item — `cat .github/workflows/ci.yml` inspect job; runbook command run once.

### item C — Interfaces

#### REQ-C-1 Machine-readable API contract

- **Statement**: `docs/api/openapi.json` describes every REST route + schema; `docs/api/ws.md`
  describes the push messages; a server test parses `openapi.json` and asserts the registered
  routes ⇔ documented paths (bijective), and that every `/actions/*` route is JWT-gated.
- **Rationale**: D14; contract-first for the frontend.
- **Testability**: `API-CONTRACT-MATCHES-OPENAPI: the server's registered route table and
  openapi.json name exactly the same paths and methods.`

#### REQ-C-2 SDK browser safety

- **Statement**: no module reachable from `sdk/src/index.ts` imports a `node:` builtin; Anchor
  discriminators come from precomputed tables (instructions + account types) whose entries are
  cross-checked against `node:crypto` sha256 in tests and whose sizes are pinned; the README
  documents the Buffer polyfill expectation for bundlers.
- **Rationale**: D13 — the frontend cannot bundle `node:crypto`.
- **Testability**: `SDK-NO-NODE-BUILTINS: a source scan over sdk/src (module graph from index.ts)
  finds zero `node:` imports.` `SDK-DISCRIMINATOR-TABLES-MATCH-SHA256: every table entry equals
  sha256("global:"|"account:" + name)[0..8]; table sizes are pinned to the program's instruction
  count.`

#### REQ-C-3 Shared DTO types

- **Statement**: `sdk/src/api.ts` exports the DTO types for every REST response and WS message;
  the server imports them (`import type`) and fails typecheck on drift; runtime shape tables keep
  the server honest in tests.
- **Rationale**: single source of truth for the frontend round.
- **Testability**: `SHARED-DTOS-STAY-IN-SYNC: a runtime shape table derived from the DTO fixtures
  validates every e2e response body` (the typecheck gate is the compile-time half).

#### REQ-C-4 Interface documentation

- **Statement**: `docs/api.md` documents the HTTP + WS surface, the bind/revoke flow, the SIWS
  login flow and the faucet (with sequence diagrams in mermaid); `docs/README.md` indexes
  `docs/api.md` + `docs/api/*` + `docs/modules/operator.md`; README links stay one-home-per-fact.
- **Rationale**: D19 — 「為前端做好準備」 is documentation + contract, not code.
- **Testability**: `DOCS-API-SURFACE-COMPLETE: source-embedding audit finds every route path and
  WS message type in docs/api.md.`

## Non-goals

- Frontend UI code, wallet adapters, any React/Next.js work (next run).
- MM bot / market-making; demo choreography (workstream D).
- Net-margin (long−short) treatment; equity-gated opens; portfolio margin across markets.
- gRPC / Carbon indexing; Postgres; Redis; horizontal scaling; multi-process split.
- Audit readiness, mainnet, multi-market, advanced risk policies (auto-manage policy engine beyond
  the keeper's settle/liquidate duties).
- Changes to the publisher, the oracle message format, the stake-pool offsets, the Trident
  harness, the PoC sandbox.

## Open questions

None outstanding. Two decisions are defaulted (D6, D17; user not reached at plan time) and are
vetoable until implementation begins — both were surfaced in the plan-time report.

## Appendix — instruction surfaces added/changed by this plan

Legend: `S` = `Signer`, `U` = `UncheckedAccount` (with the listed anchor `seeds`/`bump`
constraint; data-level checks in the handler per the REQs). All borsh args little-endian.

### New instructions (8)

| Instruction | Args | Accounts (order) |
| --- | --- | --- |
| `set_operator` | `operator: Pubkey` | `user (S, mut)`, `market`, `operator_record (U, mut, seeds [OPERATOR_SEED, market, user], bump)`, `system_program` |
| `operator_deposit_collateral` | `amount: u64` | `operator (S, mut)`, `user (U)`, `market (mut)`, `user_collateral (U, mut, seeds [USER_COLLATERAL_SEED, market, user], bump)`, `operator_record (U, seeds [OPERATOR_SEED, market, user], bump)`, `vault (U, mut, seeds [VAULT_SEED], bump)`, `user_ata (U, mut)`, `collateral_mint (address = market.collateral_mint)`, `token_program`, `system_program` |
| `operator_withdraw_collateral` | `amount: u64` | `operator (S)`, `user (U)`, `market (mut)`, `user_collateral (Account<UserCollateral>, mut, seeds [USER_COLLATERAL_SEED, market, user], bump)`, `operator_record (U, seeds [OPERATOR_SEED, market, user], bump)`, `vault (U, mut, seeds [VAULT_SEED], bump)`, `user_ata (U, mut)`, `collateral_mint (address = market.collateral_mint)`, `index_source (U, address = market.index_source)`, `position_long (U)`, `position_short (U)`, `token_program` |
| `operator_open_position` | `side: u8, size: u64, price: u64` | `operator (S, mut)`, `user (U)`, `market`, `order_book (U, mut, seeds [ORDER_BOOK_SEED, market], bump)`, `index_source (U, address = market.index_source)`, `position (U, mut, seeds [POSITION_SEED, market, user, side], bump)`, `user_collateral (U, mut, seeds [USER_COLLATERAL_SEED, market, user], bump)`, `operator_record (U, seeds [OPERATOR_SEED, market, user], bump)`, `system_program` |
| `operator_close_position` | `side: u8, size: u64` | `operator (S)`, `user (U)`, `market`, `order_book (U, mut, seeds [ORDER_BOOK_SEED, market], bump)`, `index_source (U, address = market.index_source)`, `position (U, mut, seeds [POSITION_SEED, market, user, side], bump)`, `user_collateral (U, mut, seeds [USER_COLLATERAL_SEED, market, user], bump)`, `operator_record (U, seeds [OPERATOR_SEED, market, user], bump)` |
| `operator_place_limit_order` | `side: u8, price: u64, size: u64` | `operator (S)`, `user (U)`, `market`, `order_book (U, mut, seeds [ORDER_BOOK_SEED, market], bump)`, `index_source (U, address = market.index_source)`, `operator_record (U, seeds [OPERATOR_SEED, market, user], bump)` |
| `operator_place_market_order` | `side: u8, size: u64` | `operator (S)`, `user (U)`, `market`, `order_book (U, mut, seeds [ORDER_BOOK_SEED, market], bump)`, `index_source (U, address = market.index_source)`, `operator_record (U, seeds [OPERATOR_SEED, market, user], bump)` |
| `operator_cancel_order` | `seq: u64` | `operator (S)`, `user (U)`, `market`, `order_book (U, mut, seeds [ORDER_BOOK_SEED, market], bump)`, `operator_record (U, seeds [OPERATOR_SEED, market, user], bump)` |

Behavioural notes: the subject `user` keys every PDA (positions, ledger, record) and every
owner/attribution field (`order.owner = user`, `position.owner = user`); the operator is the only
signer and must equal `operator_record.operator` (not revoked). `user_ata` is validated in-handler
against (`market.collateral_mint`, subject owner). Lazy creates: `operator_record` (payer = user),
`user_collateral` + `position` in deposit/open (payer = operator), mirroring the direct
counterparts. `market` is `mut` on `operator_deposit_collateral` /
`operator_withdraw_collateral` because claim-payout writes `PerpMarket.pnl_pool` (mirrors the
direct deposit/withdraw rows).

### Changed instructions (2)

| Instruction | Args (new) | Accounts (new order) |
| --- | --- | --- |
| `liquidate` | `side: u8, amount: u64` | `market (mut)`, `position (Account<Position>, mut)`, `other_position (U)`, `user_collateral (Account<UserCollateral>, mut)`, `order_book (U, seeds [ORDER_BOOK_SEED, market], bump)`, `index_source (U, address = market.index_source)`, `liquidator (S)`, `liquidator_collateral (Account<UserCollateral>, mut, seeds [USER_COLLATERAL_SEED, market, liquidator], bump)` |
| `withdraw_collateral` | `amount: u64` (unchanged) | `user (S)`, `market (mut)`, `user_collateral (Account<UserCollateral>, mut)`, `vault (U, mut, seeds [VAULT_SEED], bump)`, `user_ata (mut)`, `collateral_mint (address = market.collateral_mint)`, `index_source (U, address = market.index_source)`, `position_long (U)`, `position_short (U)`, `token_program` |

Unchanged direct instructions (`deposit_collateral`, `open_position`, `close_position`,
`place_limit_order`, `place_market_order`, `cancel_order`) keep their current account order and
signatures byte-for-byte.
