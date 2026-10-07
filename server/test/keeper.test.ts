//! RED acceptance test for the keeper loop's funding-drain scenario (REQ-B-6,
//! D16): `KEEPER-SETTLES-AND-LIQUIDATES: with a two-sided book (premium ≠ 0)
//! the long bleeds funding until under-margin; repeated tick() calls settle
//! funding and liquidate with no manual submission.` (e2e: two-sided book +
//! funding epochs elapse; tick loop to quiescence — R-5: the stock
//! `solana-test-validator` has no live account-write RPC, so the under-margin
//! account is produced by funding accrual, never by patching the index).
//!
//! Scenario numbers (all fixed-point units mirror the program):
//!   market: fundingK = 100_000, maxFunding = 10_000, fundingEpochSlots = 2
//!           (2 slots ≈ 0.8 s per epoch at 400 ms slots), initialMarginBps =
//!           1_000 (10×), maintenanceMarginBps = 500 (20×).
//!   book:   walletS rests a 2N ask at 100_001; walletB rests an N bid at
//!           99_999 ⇒ best ask 100_001, best bid 99_999, mid = 100_000.
//!   long:   N = 10 tUSDC notional; deposit = 1_050_000 (marginRequired(N,
//!           1_000 bps) = 1_000_000, so 5% above the initial-margin
//!           requirement); opens N with a market order crossing the ask; the
//!           ask keeps a 2N − N = N remainder, so the book stays two-sided.
//!
//!   Funding drain (why it crosses maintenance):
//!     mark = mid = 100_000; index = 0 (the synthetic stake pool is static, so
//!     realized yield — and the first-settlement index when market.index_d ==
//!     0 — are 0) ⇒ premium = 100_000.
//!     rate = clamp(fundingK·premium/APY_SCALE, ±maxFunding)
//!          = clamp(100_000·100_000/1_000_000 = 10_000, ±10_000) = 10_000.
//!     payment/epoch = notional·rate/APY_SCALE × flow
//!                   = 10_000_000·10_000/1_000_000 × (−1, long pays) = −100_000.
//!     maintenance = marginRequired(N, 500 bps) = 500_000.
//!     gap = 1_050_000 − 500_000 = 550_000 ⇒ 6 full epochs (−600_000) drain
//!     `deposited` to 450_000 < 500_000 ⇒ account_liquidatable (equity =
//!     deposited + Σ pnl, and Σ pnl stays 0 while the pool rate is static).
//!     6 epochs ≈ 4.8 s of chain time; the program additionally needs a full
//!     16-slot TWAP window before a liquidation reference exists (≈ 6.4 s from
//!     the first book observation) — both comfortably inside the bounded loop.
//!     (Probed against the live program: each settled epoch moves `deposited`
//!     by exactly −100_000 and the accumulator reaches −600_000 at the
//!     crossing; a liquidation attempt passes account decoding + the TWAP
//!     guard once the keeper-role liquidator has its own `UserCollateral`
//!     ledger — prepared in setup below.)
//!
//! The maker fill is deliberately NOT settled (the task's "if needed"): a
//! settled short is the long's exact funding counterparty, and the keeper's
//! sweep folds both sides into the SAME `market.funding_accumulator`, netting
//! it back toward zero. Keeping the long the only live position makes the
//! funding evidence deterministic (the accumulator is strictly negative).
//!
//! After setup the test only calls `keeper.tick()` and reads state — no manual
//! instruction submission. RED on today's tree: `tick()` is an inert STUB
//! (`{cranked: 0, settledFunding: 0, settledClose: 0, liquidated: 0}`), so the
//! first assertion (funding accumulator advanced) quotes the failure. Fails
//! via assertions, never on a compile/import error.
//!
//! Style: `node:test` + `assert/strict`, harness-driven validator, `try/finally
//! stopAll()`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import {
  ACCOUNT_DISCRIMINATORS,
  SIDE_ASK,
  SIDE_BID,
  buildDepositCollateral,
  buildOpenPosition,
  buildPlaceLimitOrder,
  decodePerpMarket,
  decodePosition,
  decodeUserCollateral,
  marginRequired,
  positionPda,
  userCollateralPda,
} from "fructus-sdk/src/index.js";
import { openDb, type AccountKind, type Db } from "../src/db.js";
import { createKeeper } from "../src/keeper.js";
import {
  DEFAULT_MARKET,
  createMint,
  fundTrader,
  initMarket,
  startValidator,
  stopAll,
  submit,
} from "./harness.js";

// --- pinned scenario numbers (see the header arithmetic) --------------------
const FUNDING_EPOCH_SLOTS = 2n; // ≈ 0.8 s per epoch
const MAX_FUNDING = DEFAULT_MARKET.maxFunding; // 10_000
const INITIAL_MARGIN_BPS = DEFAULT_MARKET.initialMarginBps; // 1_000
const MAINTENANCE_MARGIN_BPS = DEFAULT_MARKET.maintenanceMarginBps; // 500

const N = 10_000_000n; // long notional (10 tUSDC)
const BID_PRICE = 99_999n;
const ASK_PRICE = 100_001n; // mid = (99_999 + 100_001) / 2 = 100_000
const DEPOSIT = 1_050_000n; // just above marginRequired(N, 1_000 bps) = 1_000_000
const DRAIN_GAP = DEPOSIT - marginRequired(N, MAINTENANCE_MARGIN_BPS); // 550_000

// Bounded manual tick driving ("small real sleeps between ticks").
const TICK_SLEEP_MS = 250;
const MAX_TICKS = 90;
const LOOP_BUDGET_MS = 60_000;

const KIND_BY_TYPE_NAME: Record<string, AccountKind> = {
  YieldOracle: "oracle",
  PerpMarket: "market",
  OrderBook: "order_book",
  UserCollateral: "user_collateral",
  Position: "position",
  Operator: "operator",
};
const KIND_BY_DISCRIMINATOR = new Map<string, AccountKind>(
  Object.entries(ACCOUNT_DISCRIMINATORS).map(([name, bytes]) => [
    bytes.join(","),
    KIND_BY_TYPE_NAME[name] as AccountKind,
  ]),
);

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Seed the store exactly the way the indexer's resync does (screen by Anchor
 * account discriminator, store byte-identical data) so the keeper's state
 * layer has the market / book / position / ledger rows to target.
 */
async function seedDbFromChain(db: Db, connection: Connection, programId: PublicKey): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  const accounts = await connection.getProgramAccounts(programId, { commitment: "confirmed" });
  let seeded = 0;
  for (const { pubkey, account } of accounts) {
    const kind = KIND_BY_DISCRIMINATOR.get(account.data.subarray(0, 8).join(","));
    if (kind === undefined) continue;
    db.upsertAccount(kind, pubkey.toBase58(), account.data, slot);
    seeded++;
  }
  return seeded;
}

interface LongSnapshot {
  deposited: bigint;
  notional: bigint;
  lastFundingEpoch: bigint;
  /** Raw account data, reused for the indexer-emulation refresh. */
  positionData: Buffer;
  collateralData: Buffer;
}

async function readLong(
  connection: Connection,
  position: PublicKey,
  collateral: PublicKey,
): Promise<LongSnapshot | null> {
  const [positionInfo, collateralInfo] = await connection.getMultipleAccountsInfo([
    position,
    collateral,
  ]);
  if (positionInfo === null || collateralInfo === null) return null;
  const pos = decodePosition(positionInfo.data);
  const col = decodeUserCollateral(collateralInfo.data);
  if (pos === null || col === null) return null;
  return {
    deposited: col.deposited,
    notional: pos.notional,
    lastFundingEpoch: pos.lastFundingEpoch,
    positionData: positionInfo.data,
    collateralData: collateralInfo.data,
  };
}

test("KEEPER-SETTLES-AND-LIQUIDATES: with a two-sided book (premium ≠ 0) the long bleeds funding until under-margin; repeated tick() calls settle funding and liquidate with no manual submission.", async () => {
  const validator = await startValidator();
  const db = openDb(":memory:");
  const fixtureDir = mkdtempSync(join(tmpdir(), "fructus-keeper-"));
  try {
    await createMint(validator);
    const env = await initMarket(validator, {
      fundingK: DEFAULT_MARKET.fundingK, // 100_000 — see the rate arithmetic in the header
      maxFunding: MAX_FUNDING,
      fundingEpochSlots: FUNDING_EPOCH_SLOTS,
      initialMarginBps: INITIAL_MARGIN_BPS,
      maintenanceMarginBps: MAINTENANCE_MARGIN_BPS,
    });

    // --- keeper signer (the sweep's fee payer + liquidator) -----------------
    // The program's `liquidate` account set requires the LIQUIDATOR's own
    // `UserCollateral` ledger to exist (Anchor `AccountNotInitialized`
    // otherwise — probed against the live program), so the keeper-role keypair
    // is funded with collateral tokens and gets a small ledger in setup. The
    // keeper itself submits nothing during setup.
    const keeperKeypair = Keypair.generate();
    const keeperKeypairPath = join(fixtureDir, "keeper.json");
    writeFileSync(keeperKeypairPath, JSON.stringify(Array.from(keeperKeypair.secretKey)));
    const keeperAta = await fundTrader(validator, keeperKeypair.publicKey, 5_000_000n, "keeper");
    await submit(
      validator,
      buildDepositCollateral({
        user: keeperKeypair.publicKey,
        market: env.market,
        userAta: keeperAta,
        collateralMint: validator.mint,
        amount: 1_000_000n,
        programId: validator.programId,
      }),
      keeperKeypair,
    );

    // --- two-sided book: walletS rests the ask, walletB the bid -------------
    const walletS = Keypair.generate();
    const walletB = Keypair.generate();
    await fundTrader(validator, walletS.publicKey, 1_000_000n, "wallet-s");
    await fundTrader(validator, walletB.publicKey, 1_000_000n, "wallet-b");
    await submit(
      validator,
      buildPlaceLimitOrder({
        market: env.market,
        indexSource: validator.indexSource,
        owner: walletS.publicKey,
        side: SIDE_ASK,
        price: ASK_PRICE,
        size: 2n * N,
        programId: validator.programId,
      }),
      walletS,
    );
    await submit(
      validator,
      buildPlaceLimitOrder({
        market: env.market,
        indexSource: validator.indexSource,
        owner: walletB.publicKey,
        side: SIDE_BID,
        price: BID_PRICE,
        size: N,
        programId: validator.programId,
      }),
      walletB,
    );

    // --- the long: deposit just above initial margin, then open -------------
    const longUser = Keypair.generate();
    const longAta = await fundTrader(validator, longUser.publicKey, 20_000_000n, "long");
    await submit(
      validator,
      buildDepositCollateral({
        user: longUser.publicKey,
        market: env.market,
        userAta: longAta,
        collateralMint: validator.mint,
        amount: DEPOSIT,
        programId: validator.programId,
      }),
      longUser,
    );
    // price == 0 ⇒ market/IOC: crosses walletS's resting ask, fills N at the
    // maker price (100_001), no remainder rests; walletS's ask keeps its 2N −
    // N = N remainder so mid (and thus the mark) stays 100_000.
    await submit(
      validator,
      buildOpenPosition({
        owner: longUser.publicKey,
        market: env.market,
        indexSource: validator.indexSource,
        side: SIDE_BID,
        size: N,
        price: 0n,
        programId: validator.programId,
      }),
      longUser,
    );

    const longPositionPda = positionPda(env.market, longUser.publicKey, SIDE_BID, validator.programId).address;
    const longCollateralPda = userCollateralPda(env.market, longUser.publicKey, validator.programId).address;

    const opened = await readLong(validator.connection, longPositionPda, longCollateralPda);
    assert.ok(
      opened !== null && opened.notional === N && opened.deposited === DEPOSIT,
      `setup must leave the long open with notional ${N} and deposited ${DEPOSIT} — got ${JSON.stringify(opened, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
    );

    // --- seed the store the way the indexer would ---------------------------
    const seeded = await seedDbFromChain(db, validator.connection, validator.programId);
    assert.ok(seeded >= 4, `indexer-style seeding must find >= 4 program accounts (market, book, position, ledger) — got ${seeded}`);

    // --- keeper instance ----------------------------------------------------
    // `KeeperOptions` carries no signer today even though every sweep phase is
    // a signed (permissionless) transaction; hand the keeper the same
    // `keypairPath` channel `createOperator` takes — built NON-freshly so this
    // call site compiles with and without the option (no excess-property
    // check), leaving the signer wiring to the implementation wave.
    const keeperOptions = {
      connection: validator.connection,
      db,
      programId: validator.programId,
      intervalMs: TICK_SLEEP_MS,
      keypairPath: keeperKeypairPath,
    };
    const keeper = createKeeper(keeperOptions);

    const marketBefore = await validator.connection.getAccountInfo(env.market);
    const accumulatorBefore = marketBefore === null ? null : decodePerpMarket(marketBefore.data)?.fundingAccumulator ?? null;

    // --- bounded tick loop: NO manual instruction submission ----------------
    let ticks = 0;
    let sawUnderMargin = false;
    let liquidatedObserved = false;
    let minDeposited = DEPOSIT;
    let consecutiveTickErrors = 0;
    const tickErrors: string[] = [];
    const deadline = Date.now() + LOOP_BUDGET_MS;

    while (ticks < MAX_TICKS && Date.now() < deadline && !liquidatedObserved) {
      try {
        await keeper.tick();
        consecutiveTickErrors = 0;
      } catch (err) {
        // A refused liquidation (e.g. the TWAP window not yet reached) or a
        // transient tx error must not stop the loop — record and keep driving.
        consecutiveTickErrors++;
        if (tickErrors.length < 3) tickErrors.push(`tick ${ticks}: ${errMessage(err)}`);
        if (consecutiveTickErrors >= 10) break;
      }
      ticks++;

      const snap = await readLong(validator.connection, longPositionPda, longCollateralPda);
      if (snap !== null) {
        if (snap.deposited < minDeposited) minDeposited = snap.deposited;
        if (
          snap.notional > 0n &&
          snap.deposited < marginRequired(snap.notional, MAINTENANCE_MARGIN_BPS)
        ) {
          sawUnderMargin = true;
        }
        if (snap.notional < N) liquidatedObserved = true;
      }

      // Emulate the running indexer (D12): refresh the rows the keeper's state
      // layer reads from the post-tick chain state. Not an instruction
      // submission — the production deploy runs the indexer alongside.
      if (snap !== null) {
        const slot = await validator.connection.getSlot("confirmed");
        db.upsertAccount("position", longPositionPda.toBase58(), snap.positionData, slot);
        db.upsertAccount("user_collateral", longCollateralPda.toBase58(), snap.collateralData, slot);
      }

      if (!liquidatedObserved) await sleep(TICK_SLEEP_MS);
    }
    keeper.stop();

    // --- final reads + assertions -------------------------------------------
    const marketInfo = await validator.connection.getAccountInfo(env.market);
    const finalMarket = marketInfo === null ? null : decodePerpMarket(marketInfo.data);
    const finalSnap = await readLong(validator.connection, longPositionPda, longCollateralPda);
    const txLogRows = db.raw
      .prepare("SELECT id, kind, status, created_at FROM tx_log ORDER BY rowid ASC")
      .all() as unknown as Array<{ id: string; kind: string; status: string; created_at: number }>;

    const accumulator = finalMarket?.fundingAccumulator ?? 0n;
    const drainedByFunding = accumulator < 0n ? -accumulator : 0n; // the long pays ⇒ negative
    const notes =
      `ticks=${ticks} accumulatorBefore=${accumulatorBefore} ` +
      `tickErrors=[${tickErrors.join(" | ")}] sawUnderMargin=${sawUnderMargin} ` +
      `minDeposited=${minDeposited} liquidatedObserved=${liquidatedObserved}`;

    // (1) Funding settled by the keeper.
    assert.ok(
      finalMarket !== null && finalMarket.fundingAccumulator < 0n,
      "keeper tick() calls must settle the long's funding: market.funding_accumulator must advance " +
        `from its initial 0 into the negative (the long pays on a positive premium) — got ${
          finalMarket === null ? "no market account" : finalMarket.fundingAccumulator.toString()
        }. ${notes}`,
    );

    // (2) The drain crossed the maintenance line per the LOCAL state math:
    //     the accumulated funding payments exceed the deposit-above-maintenance
    //     gap, so equity (= deposited + Σ pnl, Σ pnl = 0 on the static pool)
    //     went strictly below marginRequired(N, 500 bps) ⇒ liquidatable.
    assert.ok(
      drainedByFunding > DRAIN_GAP,
      `the long must bleed funding strictly below its maintenance margin per the local state math — ` +
        `funding payments accumulated (${drainedByFunding}) must exceed DEPOSIT − marginRequired(N, ` +
        `${MAINTENANCE_MARGIN_BPS} bps) = ${DEPOSIT} − ${marginRequired(N, MAINTENANCE_MARGIN_BPS)} = ${DRAIN_GAP}. ${notes}`,
    );

    // (3) The keeper liquidated the drained account (no manual submission).
    assert.ok(
      finalSnap !== null && finalSnap.notional < N,
      `the keeper must liquidate the drained long: Position.notional must be reduced below ${N} ` +
        `(a full liquidation ⇒ 0) with no manual instruction submission after setup — got ` +
        `${finalSnap === null ? "no position account" : finalSnap.notional.toString()}. ${notes}`,
    );

    // (4) At least one keeper tx_log row.
    assert.ok(
      txLogRows.length >= 1,
      `the keeper must record at least one tx_log row for its sweep actions — got ${txLogRows.length} ` +
        `row(s) ${JSON.stringify(txLogRows)}. ${notes}`,
    );
  } finally {
    db.close();
    rmSync(fixtureDir, { recursive: true, force: true });
    await stopAll();
  }
});
