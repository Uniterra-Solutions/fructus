# ACCEPTANCE — product-v2

**Evidence standard.** Property-based tests are the primary instrument, using the libraries the
repositories ALREADY have — `proptest` (Rust) and the repo's seeded deterministic `node:test`
sweeps (TypeScript) — never add a dependency to make a plan testable. A deterministic sample is
allowed only as a regression added beside a confirmed counterexample; it never replaces the
property. "Run it once and look" is not evidence — it is either an alternative-evidence item
`A-<item>-<n>` (runnable command + what a human inspects) or it is nothing. The REQ set below
EQUALS the REQ set of `PRD.md`. Rust test functions carry the proposition name in snake_case (the
repo lints `non_snake_case`); TypeScript `node:test` titles carry the full `UPPERCASE-NAME:
sentence` verbatim.

**Non-vacuity discipline.** Every counter/absence proposition first establishes a
non-empty/discriminating baseline (≥1 row served / ≥1 hit / ≥1 mutation observed) and only then
asserts its invariant. A zero-vs-zero comparison never counts as proof. Negative propositions
carry a positive control.

**Mock discipline.** Zero real network, zero real funds: the Rust bank suites run
`solana-program-test` in-process; the server e2e suites spawn a hermetic `solana-test-validator`
(the repo's existing integration pattern) seeded with a synthetic stake pool; SIWS/JWT vectors are
fixed; faucet caps are clock-injected. No devnet/mainnet contact anywhere in the suite. Fixtures
under `mkdtemp`; the real home, profile and repo data stay read-only for the whole run.

**Red-phase env.** Red runs use `PROPTEST_DISABLE_FAILURE_PERSISTENCE=1` (no stray
`*.proptest-regressions` sidecars). Rust builds on this box: `CARGO_BUILD_JOBS=2` +
`--build-jobs 2`; the bank suites need the SBF artifact staged fresh:
`cargo build-sbf --arch v0 --tools-version v1.52 --sbf-out-dir target/deploy-v0` then
`cp target/deploy-v0/fructus.so target/deploy/fructus.so`.

**Frozen-test amendments.** Main-agent-only register (`AMEND-PV-#`), each with a quoted
measurement; see below.

- `AMEND-PV-1` — `operator_cancel_order` event parity. The W1 shard omitted the `Cancel` event to
  satisfy a frozen ring read ("a faithful mirror puts CANCEL at slot 0 and the fill at slot 1 —
  observed failure `left: 1, right: 0`"); the main agent restored the event (parity with the
  direct `cancel_order`; the server indexer folds this ring) and amended
  `operator_cpi::operator_orders_attribute_to_the_user` to read the fill at slot 1 and
  additionally pin the subject-attributed cancel event. Verified after: operator_cpi 8/8,
  workspace 251P / 14F, zero new reds; `.so` sha 824300d3.

- `AMEND-PV-2` — B2-F1 (indexer ring-width gap) adjudicated as CONTRADICTING the frozen
  acceptance model. The review counterexample demanded a skip-ahead policy; the fixer PROVED it
  unsatisfiable together with the frozen sweep ("case 0: folded 114, expected 307" + the
  out-of-order hostile; its decision state is state-isomorphic with sweep cases whose gap a late
  bridge must recover; bridges arrive up to 43 deliveries late). The requirement suite never
  moved: the counterexample test was amended (main agent) to pin the accepted semantics —
  buffer-and-wait, delivered events never dropped, full in-order drain on an out-of-order
  bridge — retitled `REVIEW-INDEXER-GAP-WIDER-THAN-RING-WAITS-FOR-A-BRIDGE-AND-RECOVERS`.
  Residual limitation (verdict register): a strictly unrecoverable gap stalls pending growth
  until a bridge; the frozen model deliberately tolerates arbitrarily late bridges.

## Run state (main agent maintains — update at every phase boundary and commit wave; read this
block FIRST after a compaction, a new session or a skill edit)

- Phase: **review** — implementation green at `2d758bc`; adversarial review wave in flight
- Freeze sha: `a741b28` (boundary); implement sha: `2d758bc`; record commits follow
- Shards: baseline captured (Rust 251/251 green, log `baseline-nextest.log`; TS sdk 62 / cli 19 /
  publisher 9 green). **Wave A ✓** (S_P1 Rust stubs A + S3 SDK stubs; spot-checks re-run by main
  agent pass; `market (mut)` reconciled in stubs+PRD). **Wave B ✓** (R-ACC: liquidation
  supersession — full lib reds = exactly the 5 intended, zero unintended; S4: server skeleton
  compiles, boots, harness live-verified). **Wave C dispatched**: S_P2 (5 operator order stubs,
  lib.rs) + T7 (sdk tests + account-health seams) + T8 (indexer/state tests) + T9 (auth/faucet
  tests). **Wave C ✓** (S_P2 order stubs +360/−0; T7 sdk tests 20 red/3 pins; T8 indexer 11 red +
  state 4 red incl. a reference-implementation-validated fold contract; T9 auth 14 red + faucet 6
  red; hygiene checks clean). SBF `.so` rebuild in flight (v0/v1.52 → both staging paths).
  **Wave D dispatched**: T10 (operator queue + keeper funding-drain e2e) + T11 (api/ws/e2e walk +
  openapi skeleton). SBF `.so` rebuilt ✓ (10:09, v0/v1.52, both staging paths, sha 32d71b86…,
  includes all stubs). **T1 ✓** (operator_cpi.rs bank suite: 7 red + 1 guard, all reds at the
 intended stub points — OperatorUnauthorized / missing record; auth matrix 28 exact-error legs).
 **T2 dispatched** (positions_cpi account-level edits + new scenarios). **T10 ✓** (operator
 queue e2e red; keeper funding-drain e2e red — numbers probed: −100_000/epoch, deposit 1_050_000
 vs maintenance 500_000, 6 epochs → liquidatable; liquidator ledger prerequisite discovered).
 **T11 ✓** (api contract red 16/16 missing; reads/ws/e2e red; openapi.json skeleton created;
 bind payload pinned as base64 tx; market-order = walk's open step). **TS audit ✓** (main-agent
 independent re-run of all 15 TS commands: counts match shard reports exactly; zero
 skip/only/todo; no stray processes). **T2 ✓** (positions_cpi: 18 run / 13 pass / 5 fail — the 4
 new scenarios + updated pbt RED at the stub points; all old greens restored incl.
 withdrawal_blocked_by_reserved). **R-EDITS dispatched** (collateral_cpi helper + src/tests.rs
 doc audits — the FINAL authoring shard). **R-EDITS ✓** (collateral_cpi 6/6 green; tests.rs 87
 run / 84 pass / 3 intended doc-reds + 1 pin; clippy/fmt/check clean; both `.so` staged copies
 mtime-touched with sha verified unchanged). **FREEZE ✓** — main-agent re-ran every shard command
 (Rust audit: workspace 265 run / 243 pass / 22 fail — 22 reds = 8 lib + 14 bank, all intended,
 zero unintended, zero sidecars; TS audit: all 15 commands match shard reports; clippy / fmt /
 check clean; `.so` sha 32d71b86 fresh). Boundary commit `a741b28` (56 files, +14,678/−592).
 Evidence: `evidence/{rust-audit,ts-audit}/`.
 - Open findings: none
 - Impl-wave flags (from shards): T7 `OperatorBindParams`/`OperatorRevokeParams` need `userAta`;
 T9 faucet caps calibrate to a measured drip; T10 `KeeperOptions` needs a keypair channel
 (`keypairPath`); T11 `/bind/prepare` = base64 transaction; `/market` zero-absences: `index`
 "0" fresh, `bestAsk`/`mark` null one-sided. `fructus` skill (solana/fructus) exists and must be
 updated to the v2 facts at run end.
- Holds / waivers: D6 (hedge-mode, no netting) + D17 (in-place deploy attempt) recorded as
  **defaulted — vetoable until implementation begins** (user not reached at plan time; first
  clarify round cancelled without answers)
- Next action: **REVIEW fixes applied** — F1/F2/F3/F4/F5 delivered (B2-F2/F3/F4 fixed; B2-F1 amended
  per AMEND-PV-2; SEC-10 fixes + FructusError mapping + nonce sweep + JWT alg; CI `server` job +
  operator_cpi matrix; docs corrections + sdk README; A-F1/F2/F3/A-F4 strengthened with
  bite-proofs). Next: main-agent fix verification → commits per lane → ONE final full-suite run
  (Rust ~286, sdk 86, server ~100, cli 19, publisher 9) → verdict report → close-out (docs counts
  A-PV-2, fructus skill update, handover bundle).

## Run commands (each executed once before being written here — at red-baseline collection)

| Suite (`--filter` / path) | Exact command | Collects (glob) | PBT library present |
| --- | --- | --- | --- |
| Rust lib · `operator.rs` | `cargo nextest run -E 'binary(fructus) and test(/^operator::/)'` | `programs/fructus/src/operator.rs` `#[cfg(test)]` | proptest (workspace) |
| Rust lib · `liquidation.rs` | `cargo nextest run -E 'binary(fructus) and test(/^liquidation::/)'` | `programs/fructus/src/liquidation.rs` | proptest |
| Rust lib · `collateral.rs` | `cargo nextest run -E 'binary(fructus) and test(/^collateral::/)'` | `programs/fructus/src/collateral.rs` | proptest |
| Rust lib · `state.rs` | `cargo nextest run -E 'binary(fructus) and test(/^state::/)'` | `programs/fructus/src/state.rs` | proptest |
| Rust lib · `tests.rs` (doc audits) | `cargo nextest run -E 'binary(fructus) and test(/^tests::/)'` | `programs/fructus/src/tests.rs` | proptest |
| Rust bank · operator | `cargo nextest run -E 'binary(operator_cpi)'` | `programs/fructus/tests/operator_cpi.rs` | — (bank) |
| Rust bank · positions | `cargo nextest run -E 'binary(positions_cpi)'` | `programs/fructus/tests/positions_cpi.rs` | proptest (2 blocks) |
| Rust bank · collateral | `cargo nextest run -E 'binary(collateral_cpi)'` | `programs/fructus/tests/collateral_cpi.rs` | — (bank) |
| Rust review · invariants | `cargo nextest run -E 'binary(review_liquidation_invariants)'` | `programs/fructus/tests/review_liquidation_invariants.rs` | proptest |
| Rust review · conservation | `cargo nextest run -E 'binary(review_liquidation_conservation)'` | `programs/fructus/tests/review_liquidation_conservation.rs` | proptest |
| TS sdk (per file) | `cd sdk && npx tsx --test test/<file>.test.ts` | `sdk/test/<file>.test.ts` | seeded deterministic sweeps |
| TS server (per file) | `cd server && npx tsx --test --test-force-exit test/<file>.test.ts` | `server/test/<file>.test.ts` | seeded deterministic sweeps |
| TS cli (regression) | `cd cli && npm test` | `cli/test/*.test.ts` | — |
| Full verdict (once, at implement end) | `CARGO_BUILD_JOBS=2 cargo nextest run --workspace --build-jobs 2` + the TS suites + `cargo fmt --check` + `cargo clippy --workspace --all-targets -- -D warnings` | everything | — |

## Propositions and acceptance rows

| REQ | Proposition (test title) | Generator domain | Counterexample shape | Test site (file : title) | Run command | Baseline |
| --- | --- | --- | --- | --- | --- | --- |
| `REQ-A1-1` | `OPERATOR-LAYOUT-PINNED: the Operator payload is exactly 97 bytes and its PDA round-trips through create_program_address.` | fixed vectors (fresh keypairs, extreme bytes) + LEN const arithmetic | payload ≠ 97; PDA derived with bump mismatch | `src/state.rs : operator_len_pins_the_borsh_payload` + `: operator_pda_seed_round_trip` | `cargo nextest run -E 'binary(fructus) and test(/^state::/)'` | green (pin) |
| `REQ-A1-2` | `SET-OPERATOR-CREATES-ROTATES-REVOKES: set_operator lazily creates, overwrites and revokes the record, revoke state stored as Pubkey::default(), never closes.` | bank: create → rotate → revoke → re-bind sequence; squatted-PDA case | record missing after create; stale operator after rotate; account closed on revoke; squat not rejected | `tests/operator_cpi.rs : set_operator_creates_rotates_revokes` | `cargo nextest run -E 'binary(operator_cpi)'` | red |
| `REQ-A1-2` | `SET-OPERATOR-IS-USER-ONLY: only the subject user's signature mutates the record.` | bank: stranger + operator-key attempts | non-user mutation succeeds | `tests/operator_cpi.rs : set_operator_is_user_only` | same | red |
| `REQ-A1-3` | `OPERATOR-DEPOSIT-MOVES-FUNDS-FOR-USER: with the bind approval, operator_deposit_collateral moves USDC user→vault and credits the ledger, operator key as the only signer.` | bank: bound user, approve, deposit; repeated deposits; claim-payout case | balances/ledger unchanged; extra signature required; credit to operator | `tests/operator_cpi.rs : operator_deposit_moves_funds_for_user` | same | red |
| `REQ-A1-3` | `OPERATOR-DEPOSIT-REQUIRES-APPROVAL: without SPL approval ≥ amount the instruction fails and all balances are unchanged.` | bank: no approve / short allowance / post-revoke allowance | deposit succeeds without approval; partial state left | `tests/operator_cpi.rs : operator_deposit_requires_approval` | same | red |
| `REQ-A1-4` | `OPERATOR-WITHDRAW-PAYS-ONLY-THE-USER: withdrawn tokens can only land in the subject user's ATA; a foreign destination fails.` | bank: own-ATA success; foreign-owner ATA + wrong-mint ATA failure cases | funds reach a foreign account | `tests/operator_cpi.rs : operator_withdraw_pays_only_the_user` | same | red |
| `REQ-A1-5` | `OPERATOR-ORDERS-ATTRIBUTE-TO-THE-USER: an order placed, opened, closed or cancelled by the operator mutates exactly the subject's position/ledger/book rows.` | bank: limit rests; market opens; cancel; close; each asserts subject ownership | order.owner == operator; position under operator key; ledger of operator | `tests/operator_cpi.rs : operator_orders_attribute_to_the_user` | same | red |
| `REQ-A1-6` | `OPERATOR-AUTH-MATRIX: authorized ⇔ record exists ∧ record.operator == signer ≠ default ∧ record.market == market ∧ record.user == user — total over all inputs.` | proptest full domain (signer/market/user/record fields as arbitrary pubkeys incl. default) + bank matrix over all 8 instructions | predicate returns true for any failing combination; unauthorized op mutates state | `src/operator.rs : operator_auth_matrix` + `tests/operator_cpi.rs : operator_auth_matrix_rejects_unauthorized` | both commands above | red |
| `REQ-A1-7` | `SDK-OPERATOR-BUILDERS-ENCODE-THE-SURFACE: each operator builder emits the exact discriminator, argument bytes and account meta list the program declares.` | fixed vectors per builder (incl. bind/revoke helper composition) | wrong discriminator/metas/flags | `sdk/test/operator.test.ts` | `cd sdk && npx tsx --test test/operator.test.ts` | red |
| `REQ-A1-7` | `SDK-OPERATOR-DECODER-ROUNDTRIPS: decodeOperator round-trips the 97-byte layout byte-exactly (incl. truncation hostiles).` | fixed bytes + short/long buffers | field drift | `sdk/test/operator-layout.test.ts` | `cd sdk && npx tsx --test test/operator-layout.test.ts` | red |
| `REQ-A1-8` | `DOCS-OPERATOR-SURFACE-COMPLETE: api-reference.md names every new instruction; data-models.md carries the Operator row.` | source-embedding scan | instruction name missing; row missing | `src/tests.rs : docs_operator_surface_complete` | `cargo nextest run -E 'binary(fructus) and test(/^tests::/)'` | red |
| `REQ-A2-1` | `ACCOUNT-HEALTH-IS-EQUITY-VS-TOTAL-MAINTENANCE: account_liquidatable equals (deposited + Σ upnl < Σ_side m(n_side, mm)), strict, zero-exposure ⇒ false, total.` | proptest full u64/i128/u16 domain | predicate differs anywhere | `src/liquidation.rs : account_health_is_equity_vs_total_maintenance` | `cargo nextest run -E 'binary(fructus) and test(/^liquidation::/)'` | red |
| `REQ-A2-1` | `ACCOUNT-MARGIN-SUMS-BOTH-SIDES: account_margin_required is the checked sum of both sides' ceilings, monotonic in each notional.` | proptest full domain | sum wrong; overflow behavior wrong | `src/liquidation.rs : account_margin_sums_both_sides` | same | red |
| `REQ-A2-2` | `LIQUIDATE-TRIGGERS-ON-ACCOUNT-HEALTH: liquidation succeeds iff the account's equity is below its TOTAL maintenance requirement; individually-healthy sides included.` | bank: two-side account (a) one side weak; (b) both healthy; (c) zero other side | wrong trigger basis; refusal when due | `tests/positions_cpi.rs : liquidate_triggers_on_account_health` | `cargo nextest run -E 'binary(positions_cpi)'` | red |
| `REQ-A2-2` | `LIQUIDATION-CONSERVES-ACCOUNT-VALUE: over any liquidation Σ(victim + liquidator + pool) is unchanged and reserved == Σ m(n_i, im) afterwards.` | proptest handler-model (both sides) + bank scenario | value created/destroyed; reserved drift | `tests/review_liquidation_conservation.rs` (replaced) | `cargo nextest run -E 'binary(review_liquidation_conservation)'` | red |
| `REQ-A2-2` | `ACCOUNT-LOSS-BOOKED-IS-MAX-ZERO-NEGATIVE-PNL: the booked account loss equals max(0, −Σ upnl), u64-saturated — the negative-sum convention, independent of the seam clamp.` | proptest full i128 domain | wrong sign handling; saturation wrong | `src/liquidation.rs : account_loss_booked_is_max_zero_negative_pnl` | `cargo nextest run -E 'binary(fructus) and test(/^liquidation::/)'` | red |
| `REQ-A2-2` | `LIQUIDATION-SURVIVOR-BACKED-AT-INITIAL-MARGIN: after a partial liquidation of the targeted side the surviving side holds exactly m(n−amount, im) (full ⇒ zero), and release+reward ≤ collateral.` | proptest full domain + deterministic witness | wrong release/reward; value created | `tests/review_liquidation_invariants.rs` (replaced) | `cargo nextest run -E 'binary(review_liquidation_invariants)'` | pin (release math unchanged; file replaced for the account framing) |
| `REQ-A2-2` | `LIQUIDATE-RELEASES-ONLY-THE-TARGETED-SIDE: only the targeted side's notional/collateral change; the other side is byte-identical.` | bank: partial + full on one side | other-side mutation; wrong release amount | `tests/positions_cpi.rs : liquidate_releases_only_the_targeted_side` | positions command | red |
| `REQ-A2-3` | `WITHDRAW-BLOCKED-BELOW-INITIAL-MARGIN: a withdrawal leaving equity < initial requirement fails and moves nothing; one keeping ≥ it succeeds.` | proptest pure gate (full domain) + bank (negative PnL, boundary ±1, pristine sides) | gate passes wrongly; tokens moved on failure; pristine side mishandled | `src/collateral.rs : withdraw_blocked_below_initial_margin` + `tests/positions_cpi.rs : withdraw_blocked_below_initial_margin` | collateral + positions commands | red |
| `REQ-A2-4` | `DEPOSIT-IMPROVES-ACCOUNT-HEALTH: depositing raises equity one-for-one; a sufficient deposit flips account_liquidatable to false.` | bank: underwater → deposit → heal; boundary (±1 unit) | predicate unchanged; non-monotone | `tests/positions_cpi.rs : deposit_improves_account_health` | positions command | red |
| `REQ-A2-5` | `SDK-ACCOUNT-HEALTH-MIRRORS-RUST: TS account-health mirrors are byte-identical to the Rust formulas across a seeded ≥10k-case sweep.` | seeded xorshift sweep + pinned specials | any divergence | `sdk/test/account-health.test.ts` | `cd sdk && npx tsx --test test/account-health.test.ts` | red |
| `REQ-A2-6` | `NO-PER-POSITION-LIQUIDATION-REMAINS: source scan finds no per-position liquidatable/equity path (positive control: account-level definitions exist).` | source-embedding scan over src/ + tests/ | stale per-position fn/tests remain | `src/tests.rs : no_per_position_liquidation_remains` | tests command | green (pin) |
| `REQ-A2-7` | `DOCS-ACCOUNT-MARGIN-MODEL: liquidation.md, positions.md, api-reference.md carry the account-level model + new liquidate signature.` | source-embedding scan | stale per-position text; missing signature | `src/tests.rs : docs_account_margin_model` | tests command | red |
| `REQ-B-2` | `INDEXER-EVENT-DIFF-NO-LOSS-NO-DUP: folding any snapshot sequence (out-of-order, duplicated, wrapped, gapped→resync) yields each fill/funding event exactly once in seq order.` | seeded sequences + hostile specials (empty, wrap, gap, dup) | lost/dup events; order violations | `server/test/indexer.test.ts` | `cd server && npx tsx --test --test-force-exit test/indexer.test.ts` | red |
| `REQ-B-2` | `INDEXER-STATE-MATCHES-CHAIN: after resync against a live validator, every indexed account decodes byte-identically to a direct RPC read.` | e2e: seeded validator state | mismatch | `server/test/indexer.test.ts` (e2e section) | same | red |
| `REQ-B-3` | `STATE-HEALTH-MATCHES-PROGRAM-TRIGGER: the server's liquidatable flag equals the program's account-level predicate for every generated account set.` | seeded sweep vs Rust-derived expectation | divergence | `server/test/state.test.ts` | `cd server && npx tsx --test --test-force-exit test/state.test.ts` | red |
| `REQ-B-4` | `AUTH-SIWS-ROUNDTRIP-AND-REJECTIONS: correct signatures yield sessions; wrong keys, tampered messages, replayed nonces, expired challenges are rejected.` | fixed vectors + hostiles (tamper, replay, expiry, malformed base58) | accepts bad / rejects good | `server/test/auth.test.ts` | `cd server && npx tsx --test --test-force-exit test/auth.test.ts` | red |
| `REQ-B-4` | `AUTH-SESSION-GATES-ROUTES: every private route 401s without a valid token and succeeds with one.` | route table enumeration (no-token / garbage / expired / valid) | unguarded route | `server/test/auth.test.ts` | same | red |
| `REQ-B-5` | `OPERATOR-SERVICE-SIGNS-AND-CONFIRMS: an action through the service lands on-chain and its tx_log row reaches confirmed with a signature.` | e2e: deposit + order through the service | no state change; missing log | `server/test/e2e.test.ts` | `cd server && npx tsx --test --test-force-exit test/e2e.test.ts` | red |
| `REQ-B-5` | `OPERATOR-QUEUE-SERIALIZES-PER-USER: concurrent enqueues for one user execute FIFO without interleaving or loss.` | e2e: N=5 concurrent enqueues for one user; completeness via on-chain sum; FIFO via tx_log order | reorder/interleave/loss | `server/test/operator.test.ts` | `cd server && npx tsx --test --test-force-exit test/operator.test.ts` | red |
| `REQ-B-6` | `KEEPER-SETTLES-AND-LIQUIDATES: with a two-sided book (premium ≠ 0) the long bleeds funding until under-margin; repeated tick() calls settle funding and liquidate with no manual submission.` | e2e: two-sided book + funding epochs elapse; tick loop to quiescence (no live pool mutation — see R-5) | no-op / stuck | `server/test/keeper.test.ts` | `cd server && npx tsx --test --test-force-exit test/keeper.test.ts` | red |
| `REQ-B-7` | `API-READS-SERVE-INDEXED-TRUTH: /me, /me/positions, /market, /market/book equal the indexed state for seeded scenarios.` | e2e seeded state | divergence | `server/test/api.test.ts` | `cd server && npx tsx --test --test-force-exit test/api.test.ts` | red |
| `REQ-B-7` | `WS-PUSHES-STATE-CHANGES: a subscribed client receives the matching update within one state change.` | e2e: connect, mutate, await | no/stale message | `server/test/ws.test.ts` | `cd server && npx tsx --test --test-force-exit test/ws.test.ts` | red |
| `REQ-B-8` | `FAUCET-CAPS-ENFORCED: requests beyond the per-wallet budget are rejected; accepted calls move exactly the minted amount once.` | clock-injected caps; repeated requests; boundary | over-cap passes; double-mint | `server/test/faucet.test.ts` | `cd server && npx tsx --test --test-force-exit test/faucet.test.ts` | red |
| `REQ-B-9` | `E2E-PRODUCT-WALK: the bind→deposit→trade→close→withdraw walk succeeds end-to-end with the operator as the sole signer of the operator steps.` | e2e full walk (incl. SIWS login + faucet) | any step fails; extra signer needed | `server/test/e2e.test.ts` | same as B-5 | red |
| `REQ-C-1` | `API-CONTRACT-MATCHES-OPENAPI: the route table and openapi.json name exactly the same paths+methods; every /actions/* route is JWT-gated.` | parse openapi.json + route table | mismatch; unguarded action | `server/test/api.test.ts` | same | red |
| `REQ-C-2` | `SDK-NO-NODE-BUILTINS: no module reachable from sdk/src/index.ts imports a node: builtin (positive control: the module graph is non-empty).` | import-graph scan | any node: import | `sdk/test/browser.test.ts` | `cd sdk && npx tsx --test test/browser.test.ts` | red |
| `REQ-C-2` | `SDK-DISCRIMINATOR-TABLES-MATCH-SHA256: every table entry equals sha256("global:"|"account:"+name)[0..8]; sizes pinned.` | all entries vs node:crypto | mismatch; missing entry | `sdk/test/browser.test.ts` | same | green (pin) |
| `REQ-C-3` | `SHARED-DTOS-STAY-IN-SYNC: runtime shape checks validate every e2e response body against the sdk/src/api.ts DTO shapes (typecheck gate is the compile half).` | e2e responses + fixtures | drift | `server/test/api.test.ts` | same | red |
| `REQ-C-4` | `DOCS-API-SURFACE-COMPLETE: docs/api.md names every route path and WS message type; the index links resolve.` | source-embedding scan | missing path/message | `src/tests.rs : docs_api_surface_complete` | tests command | red |

## Red baseline

- Must be RED on today's tree: every row above whose Baseline cell says red (none of those surfaces
  exists yet; stubs make failures behavioural assertion failures); cells marked green (pin) are
  guards on surfaces the freeze delta touches without breaking.
- Already GREEN on today's tree (regression pins; must stay green through the freeze delta):
  the pre-existing suites — `src/tests.rs`, per-module `#[cfg(test)]`, both bank suites, both
  review suites, `publisher`/`sdk`/`cli` TS suites. Total measured at plan time: 251 Rust + 90 TS
  (see run log `baseline-nextest.log`).
- Collateral pass (once, pre-freeze; smallest suite covering every touched surface): **DONE** —
  Rust workspace `265 run / 243 pass / 22 fail` (intended 22 = 8 lib + 14 bank; 0 unintended);
  TS 15/15 commands re-run by the main agent, counts match shard reports. Evidence:
  `evidence/{rust-audit,ts-audit}/`.
- Evidence: `~/.hermes/cache/scratch/fructus-run/evidence/` (red-baseline logs, per-shard
  commands captured OUTSIDE the repo), captured 2026-10-07; freeze sha `a741b28`.

## Alternative evidence (non-PBT)

| ID | Command | What the human inspects | Discharges |
| --- | --- | --- | --- |
| `A-PV-1` | `bash scripts/deploy-upgrade.md` steps / `cat scripts/upgrade-devnet.md` | the upgrade runbook: v3 build command, `solana program deploy` upgrade path, keypair requirements, no-wipe confirmation | D17 |
| `A-PV-2` | `cargo nextest run --workspace` + `cd publisher|sdk|cli|server && npm test` (fresh counts) | measured test counts written into docs/testing.md + AGENTS.md attempt | D19 |
| `A-PV-3` | `cat server/README.md` then run its commands once | server runbook executes as documented (env keys, bootstrap, keeper start) | REQ-B-10 |
| `A-PV-4` | `cat .github/workflows/ci.yml` | the `server` job + new bank suite entries exist and match the documented commands | REQ-B-10 |
| `A-PV-5` | edit `AGENTS.md` (invariant text) | approval-gated update attempted at the end; parked if not approved | D19 |

## Gaps and risks

- `R-1` The devnet upgrade executes only if the owner's keypair material lands on this machine
  (D17 defaulted); otherwise the run closes with the bundle + runbook handed over.
- `R-2` The server e2e suites depend on `solana-test-validator` behaving on this box (the
  integration harness is proven in CI; local behaviour is observed at red-baseline collection).
- `R-3` The operator service holds a hot key by design; on the devnet prototype it lives in
  `server/.env` (git-ignored). Production hardening (KMS, policy limits) is out of scope.
- `R-4` No audit: the operator surface is exercised by the bank/e2e suites and the review wave,
  but the run does not claim audit readiness.
- `R-5` The stock `solana-test-validator` has no account-write RPC: the keeper e2e produces its
  under-margin account by funding accrual (two-sided book ⇒ premium ≠ 0 ⇒ the long bleeds), and
  `patchStakePool` is genesis-dump + restart (static scenario seeding only).
