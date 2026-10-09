//! Debug artifact — F1 · CROSSING-LIMIT-BOOKS-TAKER.
//!
//! Measured counterexample (live walkthrough): a limit buy that crossed the
//! MM's resting ask filled on-chain (fill event seq 2) but the subject's
//! position and collateral stayed flat — the operator routed limit orders
//! through the book-only `buildOperatorPlaceLimitOrder`, which never books the
//! taker. The fix submits every order through `operator_open_position` (the
//! program's `match_open_taker` rests a non-crossing limit and books the taker
//! inline when it crosses).
//!
//! The class guard below sweeps the order domain (crossing buy/sell, resting,
//! market); the `(pinned)` case freezes the exact live counterexample.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { PROGRAM_ID, buildOperatorOpenPosition, marketPda } from "fructus-sdk/src/index.js";
import { anchorAccountDiscriminator } from "fructus-sdk/src/encoding.js";
import { PERP_MARKET_LEN, PerpMarket } from "fructus-sdk/src/account/layout.js";
import { openDb } from "../src/db.js";
import { createOperator, type OperatorService } from "../src/operator.js";

const MARKET = marketPda(PROGRAM_ID).address;
const INDEX_SOURCE = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey;
const USER = Keypair.fromSeed(new Uint8Array(32).fill(31)).publicKey;

function marketRow(): Buffer {
  const data = Buffer.alloc(8 + PERP_MARKET_LEN);
  anchorAccountDiscriminator("PerpMarket").copy(data, 0);
  INDEX_SOURCE.toBuffer().copy(data, 8 + PerpMarket.indexSource);
  Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey.toBuffer().copy(data, 8 + PerpMarket.collateralMint);
  data.writeUInt16LE(1_000, 8 + PerpMarket.initialMarginBps);
  data.writeUInt16LE(500, 8 + PerpMarket.maintenanceMarginBps);
  data.writeBigUInt64LE(1n, 8 + PerpMarket.indexN);
  data.writeBigUInt64LE(1n, 8 + PerpMarket.indexD);
  data[8 + PerpMarket.bump] = 254;
  return data;
}

interface OperatorHarness {
  operator: OperatorService;
  sent: Transaction[];
  signer: Keypair;
}

function operatorHarness(): OperatorHarness {
  const dir = mkdtempSync(join(tmpdir(), "limit-routing-"));
  const signer = Keypair.generate();
  const keypairPath = join(dir, "operator.json");
  writeFileSync(keypairPath, JSON.stringify(Array.from(signer.secretKey)));
  const sent: Transaction[] = [];
  const connection = {
    async getAccountInfo(pubkey: PublicKey) {
      if (pubkey.equals(MARKET)) return { data: marketRow() };
      return null;
    },
    async getLatestBlockhash() {
      return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 999_999 };
    },
    async sendRawTransaction(raw: Uint8Array) {
      sent.push(Transaction.from(Buffer.from(raw)));
      return PublicKey.unique().toBase58();
    },
    async confirmTransaction() {
      return {};
    },
  } as unknown as Connection;
  const operator = createOperator({ connection, keypairPath, db: openDb(":memory:"), programId: PROGRAM_ID });
  return { operator, sent, signer };
}

function assertOpenPosition(
  tx: Transaction,
  expected: { side: number; size: bigint; price: bigint },
  operatorPubkey: PublicKey,
): void {
  const instruction = tx.instructions[0];
  assert.ok(instruction, "the action tx carries one instruction");
  const expectedIx = buildOperatorOpenPosition({
    operator: operatorPubkey,
    user: USER,
    market: MARKET,
    indexSource: INDEX_SOURCE,
    side: expected.side,
    size: expected.size,
    price: expected.price,
    programId: PROGRAM_ID,
  });
  assert.deepEqual(
    [...instruction.data],
    [...expectedIx.data],
    "instruction args (side, size, price) are verbatim",
  );
  assert.equal(instruction.programId.toBase58(), PROGRAM_ID.toBase58(), "the fructus program");
  assert.deepEqual(
    instruction.keys.map((meta) => meta.pubkey.toBase58()),
    expectedIx.keys.map((meta) => meta.pubkey.toBase58()),
    "account metas match the operator_open_position shape",
  );
}

test(`CROSSING-LIMIT-BOOKS-TAKER: every order is submitted through operator_open_position — a crossing limit books the taker inline, a non-crossing limit rests, a market order stays the price-0 IOC`, async () => {
  const { operator, sent, signer } = operatorHarness();
  const limitOrders = [
    { side: 0 as const, size: 500_000n, price: 1_212_000n }, // crossing buy (the live counterexample's shape)
    { side: 1 as const, size: 750_000n, price: 1_194_000n }, // crossing sell
    { side: 0 as const, size: 1_000_000n, price: 900_000n }, // resting bid
  ];
  for (const order of limitOrders) {
    const before = sent.length;
    const result = await operator.executeOrder(USER.toBase58(), { kind: "limit", ...order });
    assert.equal(result.status, "confirmed");
    assert.equal(sent.length, before + 1, "exactly one submitted tx per action");
    assertOpenPosition(sent[sent.length - 1] as Transaction, order, signer.publicKey);
  }
  const marketBefore = sent.length;
  await operator.executeOrder(USER.toBase58(), { kind: "market", side: 0, size: 500_000n });
  assert.equal(sent.length, marketBefore + 1);
  assertOpenPosition(sent[sent.length - 1] as Transaction, { side: 0, size: 500_000n, price: 0n }, signer.publicKey);
});

test(`CROSSING-LIMIT-BOOKS-TAKER: every order is submitted through operator_open_position — a crossing limit books the taker inline, a non-crossing limit rests, a market order stays the price-0 IOC (pinned)`, async () => {
  // The frozen live counterexample: buy 0.5 @ 1.212 crossing the MM's ask —
  // filled on-chain but never booked (pre-fix this submitted a book-only
  // `place_limit_order` and the assertion below went red).
  const { operator, sent, signer } = operatorHarness();
  await operator.executeOrder(USER.toBase58(), { kind: "limit", side: 0, size: 500_000n, price: 1_212_000n });
  assert.equal(sent.length, 1);
  assertOpenPosition(sent[0] as Transaction, { side: 0, size: 500_000n, price: 1_212_000n }, signer.publicKey);
});
