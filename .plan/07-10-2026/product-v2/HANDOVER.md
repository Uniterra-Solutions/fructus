# HANDOVER — product-v2 run (2026-10-07)

## State
- HEAD `7f4ada3`; all commits LOCAL (never pushed): `a741b28` (freeze boundary) -> `2d758bc`
  (implement) -> `8de548f` + 6 review-fix commits (`2cc4d52` `c7b3629` `cdeaacd` `219acd7`
  `468ba93` `7f4ada3`).
- Final verdict green (main agent, post-fix): Rust **286/286**; sdk **86/86**; cli 19/19;
  publisher 9/9; server **100/100** (sequential); clippy/fmt/check clean.
- **DEPLOYED 2026-10-07**: in-place upgrade executed (tx `3My7hpqT…`, Finalized; on-chain dump
  sha `2755e7f3` byte-identical to the suite-validated artifact; data 660,960 bytes). Live smoke
  PASSED (`set_operator` tx `3uCxujbv…`, Operator PDA `3frUKPbx…` decodes). The upgrade was
  additive — no account layout changed, no wipe needed.

## Deploy bundle (owner action)
1. Place on this machine (never via chat): the program's upgrade-authority keypair
   (e.g. `~/.config/solana/fructus-upgrade.json`) + a funded devnet wallet for fees.
2. Rebuild the artifact (already staged, but rebuild after any further src change):
   ```bash
   cd programs/fructus
   CARGO_BUILD_JOBS=2 cargo-build-sbf --arch v0 --tools-version v1.52 --sbf-out-dir /root/data/fructus/target/deploy-v0
   cp /root/data/fructus/target/deploy-v0/fructus.so /root/data/fructus/target/deploy/fructus.so
   ```
3. In-place upgrade on devnet (program id `3EsUd5XQ6KChedwL2ho8pv3zrrGGFvMpJEV1PnzN8MD1`):
   ```bash
   solana program deploy --url devnet --upgrade-authority <upgrade-keypair.json> \
     --program-id <fructus-program-keypair.json> /root/data/fructus/target/deploy/fructus.so
   ```
   (See `scripts/README.md` for the devnet walk record; `scripts/deploy.sh` documents the
   anchor-era flow — cargo-build-sbf is the tool that works on this box.)
4. Boot the backend against devnet: `server/.env` (git-ignored) — RPC_URL (devnet), PROGRAM_ID,
   the market PDA, OPERATOR_KEYPAIR (hot key — keep separate from the upgrade authority, R-3),
   JWT_SECRET (>= 32 chars), FAUCET_* as desired. `cd server && npm ci && npm run typecheck &&
   npx tsx --test --test-force-exit --test-concurrency=1 test/*.test.ts` should stay green
   against devnet-shaped config; then `tsx src/index.ts`.
5. Smoke: `/healthz` (slot advances), SIWS login, `/bind/prepare` -> wallet signs -> `/bind/confirm`,
   `/actions/deposit`, `/actions/orders`, `/me` reads, WS pushes.

## Known gaps / follow-ups
- Residual risks L1-L6 in the ACCEPTANCE Run state (notably: no audit; web3.js advisories;
  ring-gap stall limitation; per-process caps).
- Optional next: `@solana/web3.js` v3 upgrade (clears 4 moderate advisories; breaking),
  audit, multi-process hardening (DB-level guards), frontend build on the SDK.
