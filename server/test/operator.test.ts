//! RED acceptance test for the operator relay's per-user FIFO queue (REQ-B-5,
//! D4/D5): `OPERATOR-QUEUE-SERIALIZES-PER-USER: concurrent enqueues for one
//! user execute FIFO without interleaving or loss.` (e2e: N=5 concurrent
//! enqueues for one user; completeness via on-chain sum; FIFO via tx_log order.)
//!
//! Flow:
//!  1. hermetic validator + market bootstrap (`test/harness.ts`);
//!  2. the user wallet executes the D4 bind flow — a REAL hand-built SPL
//!     `approve` of the Operator PDA (`[OPERATOR_SEED, market, user]`) as the
//!     ATA delegate with the `u64::MAX` allowance, plus the SDK
//!     `buildSetOperator` instruction (`[approve, set_operator]` is the bind
//!     transaction; they are submitted as two transactions so the real approve
//!     leg is not dragged down by today's stubbed set_operator);
//!  3. the operator service (`createOperator`) is booted against the validator
//!     with the operator keypair file written by the test, and N=5
//!     `executeDeposit` calls for the ONE user are fired CONCURRENTLY;
//!  4. assertions: all 5 promises report a settle outcome; the user's on-chain
//!     `UserCollateral.deposited` equals `5 × amount` (completeness — nothing
//!     lost, nothing double-applied); and the `tx_log` rows for the wallet are
//!     in creation order with strictly increasing `created_at`, every row
//!     `confirmed` with a distinct signature (per-user FIFO — zero
//!     interleaving-induced failures).
//!
//! RED on today's tree: `createOperator(...)` rejects every action with
//! `NotImplementedError` and never writes `tx_log`; the SDK `set_operator`
//! builder emits a discriminator-only instruction and the program's
//! `set_operator` is a no-op — the bind leg and all 5 deposits fail, and the
//! completeness assertion below quotes exactly that. Fails via assertions,
//! never on a compile/import error.
//!
//! Style: `node:test` + `assert/strict`, harness-driven validator, `try/finally
//! stopAll()`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  buildSetOperator,
  decodeUserCollateral,
  operatorPda,
  userCollateralPda,
} from "fructus-sdk/src/index.js";
import { openDb } from "../src/db.js";
import { createOperator } from "../src/operator.js";
import {
  DEFAULT_MARKET,
  createMint,
  fundTrader,
  initMarket,
  startValidator,
  stopAll,
  submit,
} from "./harness.js";

/** Concurrency degree (ACCEPTANCE: N=5 concurrent enqueues for one user). */
const N = 5;
/** Per-deposit amount: 1 tUSDC (6 dp). Completeness target: N × AMOUNT. */
const AMOUNT = 1_000_000n;
const TOTAL = AMOUNT * BigInt(N);
/** D4 approve allowance (`u64::MAX`). */
const U64_MAX = (1n << 64n) - 1n;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Hand-built SPL Token `Approve` (no spl-token JS dependency, mirroring the
 * on-chain D4 flow): data `[4][amount u64 LE]`, accounts
 * `[source (writable), delegate, owner (signer)]`. The delegate is the
 * Operator PDA — the program later signs the SPL `transfer_checked` for
 * `operator_deposit_collateral` with the PDA seeds.
 */
function splApproveOperatorIx(
  userAta: PublicKey,
  delegate: PublicKey,
  owner: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(4, 0); // TokenInstruction::Approve
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** Airdrop `sol` SOL (the operator pays the deposit-transaction fees). */
async function fundSol(connection: Connection, pubkey: PublicKey, sol: number): Promise<void> {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if ((await connection.getBalance(pubkey)) >= lamports) return;
  for (let i = 0; i < 12 && (await connection.getBalance(pubkey)) < lamports; i++) {
    try {
      await connection.requestAirdrop(pubkey, lamports);
    } catch {
      /* rate-limited; retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const got = await connection.getBalance(pubkey);
  assert.ok(got >= lamports, `airdrop to ${pubkey.toBase58()} did not reach ${sol} SOL (got ${got})`);
}

test("OPERATOR-QUEUE-SERIALIZES-PER-USER: N=5 concurrent enqueues for one user execute FIFO without interleaving or loss", async () => {
  const validator = await startValidator();
  const db = openDb(":memory:");
  const fixtureDir = mkdtempSync(join(tmpdir(), "fructus-operator-"));
  try {
    await createMint(validator);
    const env = await initMarket(validator, DEFAULT_MARKET);

    // --- operator signer + subject user -----------------------------------
    const operator = Keypair.generate();
    // `createOperator` takes a keypair *path* (`solana-keygen` JSON array,
    // never logged — R-3); write it under the test's mkdtemp fixture dir.
    const operatorKeypairPath = join(fixtureDir, "operator.json");
    writeFileSync(operatorKeypairPath, JSON.stringify(Array.from(operator.secretKey)));
    await fundSol(validator.connection, operator.publicKey, 10);

    const user = Keypair.generate();
    const userAddress = user.publicKey.toBase58();
    const userAta = await fundTrader(validator, user.publicKey, 20_000_000n, "operator-user");
    const collateralPda = userCollateralPda(env.market, user.publicKey, validator.programId).address;
    const operatorRecordPda = operatorPda(env.market, user.publicKey, validator.programId).address;

    // --- D4 bind flow: [approve(Operator PDA, u64::MAX), set_operator] ------
    // Submitting as two transactions (the composed bind tx in one) keeps the
    // real approve leg intact while the still-stubbed `set_operator` fails.
    // Failures are recorded — they are part of the returned failure story, not
    // a hard throw, so the concurrency leg below always runs.
    const bindNotes: string[] = [];
    try {
      await submit(
        validator,
        splApproveOperatorIx(userAta, operatorRecordPda, user.publicKey, U64_MAX),
        user,
      );
    } catch (err) {
      bindNotes.push(`spl-approve failed: ${errMessage(err)}`);
    }
    try {
      await submit(
        validator,
        buildSetOperator({
          user: user.publicKey,
          market: env.market,
          operator: operator.publicKey,
          programId: validator.programId,
        }),
        user,
      );
    } catch (err) {
      bindNotes.push(`set_operator failed: ${errMessage(err)}`);
    }

    // --- boot the operator service against the validator -------------------
    const operatorService = createOperator({
      connection: validator.connection,
      keypairPath: operatorKeypairPath,
      db,
      programId: validator.programId,
    });

    // --- fire N concurrent enqueues for the ONE user -----------------------
    const calls = Array.from({ length: N }, () => operatorService.executeDeposit(userAddress, AMOUNT));
    const settled = await Promise.allSettled(calls);

    // Every enqueue reports an outcome (none hangs); each rejection is a
    // failed action and must show up in the completeness assertion below.
    assert.equal(
      settled.length,
      N,
      "all N concurrent enqueues must settle and report an outcome (none may hang)",
    );
    const failures = settled.flatMap((outcome, i) =>
      outcome.status === "rejected" ? [`#${i}: ${errMessage(outcome.reason)}`] : [],
    );

    // --- completeness via the on-chain sum ---------------------------------
    const collateralInfo = await validator.connection.getAccountInfo(collateralPda);
    const deposited =
      collateralInfo === null
        ? null
        : (decodeUserCollateral(collateralInfo.data)?.deposited ?? null);
    assert.equal(
      deposited,
      TOTAL,
      `on-chain UserCollateral.deposited must equal N×amount = ${TOTAL} — the per-user queue ` +
        `must lose nothing and double-apply nothing. Got ${deposited}; ` +
        `${N - failures.length}/${N} executeDeposit calls fulfilled` +
        (failures.length > 0 ? `; rejections: ${failures.join(" | ")}` : "") +
        (bindNotes.length > 0 ? `; bind: ${bindNotes.join(" | ")}` : ""),
    );

    // --- FIFO via tx_log order (per-user queue evidence) --------------------
    interface TxLogReadRow {
      id: string;
      wallet: string;
      kind: string;
      status: string;
      signature: string | null;
      created_at: number;
    }
    const rows = db.raw
      .prepare(
        "SELECT id, wallet, kind, status, signature, created_at FROM tx_log WHERE wallet = ? ORDER BY rowid ASC",
      )
      .all(userAddress) as unknown as TxLogReadRow[];
    assert.equal(
      rows.length,
      N,
      `tx_log must hold one row per enqueued action for the user — got ${rows.length}, ` +
        `statuses: ${rows.map((r) => `${r.kind}/${r.status}`).join(", ")}`,
    );
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        Number(rows[i].created_at) > Number(rows[i - 1].created_at),
        `tx_log rows must be in creation order with strictly increasing created_at — row ${i} ` +
          `(${rows[i].id}, ${rows[i].created_at}) is not newer than row ${i - 1} ` +
          `(${rows[i - 1].id}, ${rows[i - 1].created_at})`,
      );
    }
    assert.ok(
      rows.every((r) => r.status === "confirmed" && r.signature !== null),
      `every tx_log row must reach confirmed with a signature (zero interleaving-induced failures) — ` +
        `got ${rows.map((r) => `${r.kind}:${r.status}${r.signature === null ? " (no signature)" : ""}`).join(", ")}`,
    );
    assert.equal(
      new Set(rows.map((r) => r.signature)).size,
      N,
      "each enqueue must confirm its own distinct signature (no duplicated or lost action)",
    );
  } finally {
    db.close();
    rmSync(fixtureDir, { recursive: true, force: true });
    await stopAll();
  }
});
