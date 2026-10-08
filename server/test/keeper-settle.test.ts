//! RED acceptance tests (e2e, hermetic validator) for product-v3 REQ-K-5:
//! the keeper's settle-fill sweep books a resting maker's fill and is
//! idempotent on re-runs.
//!
//! RED on today's tree: `tick()` has no settle-fill phase, so the maker's
//! Position never appears and `settledFills` stays 0 — the assertions fail
//! behaviourally, never on a compile/import error.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import {
  SIDE_ASK,
  SIDE_BID,
  buildDepositCollateral,
  buildOpenPosition,
  buildPlaceLimitOrder,
  decodeOrderBook,
  decodePosition,
  decodeUserCollateral,
  marginRequired,
  orderBookPda,
  positionPda,
  userCollateralPda,
  type OutEventState,
} from "fructus-sdk/src/index.js";
import { createKeeper } from "../src/keeper.js";
import { openDb, type Db } from "../src/db.js";
import {
  createMint,
  fundTrader,
  initMarket,
  startValidator,
  stopAll,
  submit,
  type MarketEnv,
  type Validator,
} from "./harness.js";

const N = 2_000_000n; // the fill size
const ASK_PRICE = 100_001n;
const MAKER_DEPOSIT = 2_000_000n; // free collateral must cover marginRequired(N, 1000 bps) = 200_000

let validator: Validator;
let market: MarketEnv;
let db: Db;
let fixtureDir: string;
let maker: Keypair;
let orderBook: string;

/** The maker's fill events in the ring (filtered by owner+size+price so the unwritten default slots never match). */
async function makerFillEvents(settled: number): Promise<OutEventState[]> {
  const info = await validator.connection.getAccountInfo(orderBookPda(market.market, validator.programId).address, "confirmed");
  assert.ok(info !== null, "the order book account must exist");
  const book = decodeOrderBook(info.data);
  assert.ok(book !== null, "the order book must decode");
  return book.events.filter(
    (event) =>
      event.kind === 0 &&
      event.settled === settled &&
      event.owner.equals(maker.publicKey) &&
      event.size === N &&
      event.price === ASK_PRICE,
  );
}

async function readMakerPosition(): Promise<{ notional: bigint } | null> {
  const pda = positionPda(market.market, maker.publicKey, SIDE_ASK, validator.programId).address;
  const info = await validator.connection.getAccountInfo(pda, "confirmed");
  if (info === null) return null;
  const position = decodePosition(info.data);
  return position === null ? null : { notional: position.notional };
}

async function readMakerReserved(): Promise<bigint> {
  const pda = userCollateralPda(market.market, maker.publicKey, validator.programId).address;
  const info = await validator.connection.getAccountInfo(pda, "confirmed");
  assert.ok(info !== null, "the maker's ledger must exist (deposit-created in setup)");
  const collateral = decodeUserCollateral(info.data);
  assert.ok(collateral !== null, "the maker's ledger must decode");
  return collateral.reserved;
}

let keeper: ReturnType<typeof createKeeper>;

before(async () => {
  validator = await startValidator();
  await createMint(validator);
  market = await initMarket(validator);
  orderBook = orderBookPda(market.market, validator.programId).address.toBase58();

  fixtureDir = mkdtempSync(join(tmpdir(), "fructus-keeper-settle-"));
  const keeperKeypair = Keypair.generate();
  const keeperKeypairPath = join(fixtureDir, "keeper.json");
  writeFileSync(keeperKeypairPath, JSON.stringify(Array.from(keeperKeypair.secretKey)));
  await fundTrader(validator, keeperKeypair.publicKey, 5_000_000n, "keeper");

  // The maker: deposit (the ledger must pre-exist for settle_fill), rest an ask.
  maker = Keypair.generate();
  const makerAta = await fundTrader(validator, maker.publicKey, 50_000_000n, "settle-maker");
  await submit(
    validator,
    buildDepositCollateral({
      user: maker.publicKey,
      market: market.market,
      userAta: makerAta,
      collateralMint: validator.mint,
      amount: MAKER_DEPOSIT,
      programId: validator.programId,
    }),
    maker,
  );
  await submit(
    validator,
    buildPlaceLimitOrder({
      market: market.market,
      indexSource: validator.indexSource,
      owner: maker.publicKey,
      side: SIDE_ASK,
      price: ASK_PRICE,
      size: N,
      programId: validator.programId,
    }),
    maker,
  );

  // The taker crosses the resting ask — the maker's fill sits in the ring,
  // deliberately NOT settled (that is exactly what the sweep must do).
  const taker = Keypair.generate();
  const takerAta = await fundTrader(validator, taker.publicKey, 50_000_000n, "settle-taker");
  await submit(
    validator,
    buildDepositCollateral({
      user: taker.publicKey,
      market: market.market,
      userAta: takerAta,
      collateralMint: validator.mint,
      amount: 2_000_000n,
      programId: validator.programId,
    }),
    taker,
  );
  await submit(
    validator,
    buildOpenPosition({
      owner: taker.publicKey,
      market: market.market,
      indexSource: validator.indexSource,
      side: SIDE_BID,
      size: N,
      price: 0n,
      programId: validator.programId,
    }),
    taker,
  );

  const unsettled = await makerFillEvents(0);
  assert.equal(unsettled.length, 1, "setup must leave exactly one unsettled maker fill in the ring");

  db = openDb(":memory:");
  keeper = createKeeper({
    connection: validator.connection,
    db,
    programId: validator.programId,
    intervalMs: 250,
    keypairPath: keeperKeypairPath,
  });
});

after(async () => {
  db.close();
  rmSync(fixtureDir, { recursive: true, force: true });
  await stopAll();
});

test("KEEPER-BOOKS-MAKER-FILLS: with a resting maker limit crossed by a taker, one tick books the maker's position (notional == fill size) and the ring event reads settled", async () => {
  const pre = await readMakerPosition();
  assert.ok(pre === null || pre.notional === 0n, "the maker must not be booked before the sweep");

  const result = await keeper.tick();
  assert.ok(
    result.settledFills >= 1,
    `the settle-fill sweep must book the maker's fill — got settledFills=${result.settledFills}`,
  );

  const position = await readMakerPosition();
  assert.ok(position !== null, "the maker's Position account must exist after the sweep");
  assert.equal(position.notional, N, "the maker's short must carry exactly the fill size");

  const reserved = await readMakerReserved();
  assert.equal(reserved, marginRequired(N, 1_000), "the sweep must reserve the initial margin against the maker's ledger");

  const settled = await makerFillEvents(1);
  assert.equal(settled.length, 1, "the ring event must read settled after the sweep");
  assert.equal((await makerFillEvents(0)).length, 0, "no unsettled maker fill may remain");
});

test("KEEPER-SETTLE-IDEMPOTENT: a second tick reports settledFills 0 and changes nothing on chain", async () => {
  // Deliberately sequenced after the booking test: the fill is settled by then.
  const before = await readMakerPosition();
  assert.ok(before !== null && before.notional === N, "the previous tick must have booked the maker");

  const result = await keeper.tick();
  assert.equal(result.settledFills, 0, "an already-settled fill must never be re-attempted");

  const after = await readMakerPosition();
  assert.ok(after !== null && after.notional === N, "idempotence: the position is unchanged");
  assert.equal((await makerFillEvents(1)).length, 1, "the ring event stays settled exactly once");
});
