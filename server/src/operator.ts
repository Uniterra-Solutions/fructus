//! Operator service (REQ-B-5, D4/D5): the signer half of the no-signature UX.
//! Builds operator actions via the SDK operator builders, signs with the
//! server-side operator keypair (never logged, R-3), confirms over the RPC
//! (`confirmTransaction`, WS-backed) and records every attempt in `tx_log`.
//!
//! Concurrency contract (`OPERATOR-QUEUE-SERIALIZES-PER-USER`): enqueues are
//! serialized on a per-wallet promise chain — concurrent actions for ONE user
//! execute strictly FIFO (no interleaving, no loss, one transaction at a time);
//! different users run independently. Each attempt inserts its `tx_log` row at
//! enqueue time (status `queued`) with a strictly-increasing `created_at`, and
//! walks it to `confirmed` (signature attached) or `failed` (error attached).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildOperatorCancelOrder,
  buildOperatorClosePosition,
  buildOperatorDepositCollateral,
  buildOperatorOpenPosition,
  buildOperatorPlaceLimitOrder,
  buildOperatorWithdrawCollateral,
  decodePerpMarket,
  marketPda,
  type PerpMarketState,
} from "fructus-sdk/src/index.js";
import type { ActionResponse } from "fructus-sdk/src/api.js";
import type { Db } from "./db.js";
import { BadRequestError, OperatorUnconfiguredError } from "./errors.js";

export interface OrderAction {
  kind: "limit" | "market";
  side: 0 | 1;
  size: bigint;
  /** Required for `kind === "limit"`. */
  price?: bigint;
}

export interface CancelAction {
  side: 0 | 1;
  seq: bigint;
}

export interface CloseAction {
  side: 0 | 1;
  size: bigint;
}

export interface OperatorService {
  executeDeposit(user: string, amount: bigint): Promise<ActionResponse>;
  executeWithdraw(user: string, amount: bigint): Promise<ActionResponse>;
  executeOrder(user: string, order: OrderAction): Promise<ActionResponse>;
  executeCancel(user: string, cancel: CancelAction): Promise<ActionResponse>;
  executeClose(user: string, close: CloseAction): Promise<ActionResponse>;
  /**
   * Pending actions across all users (per-user FIFO queues). Consumed by the
   * review queue-drain evidence (`server/test/review-server-pbt.test.ts`
   * asserts it returns to 0) and stubbed by the API/auth test harnesses.
   */
  queueDepth(): number;
}

export interface OperatorOptions {
  connection: Connection;
  /** Operator keypair path; `null` = unconfigured (actions unavailable). */
  keypairPath: string | null;
  db: Db;
  programId: PublicKey;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Blockhash-expiry / transport hiccups worth one bounded re-submit. */
const RETRYABLE_SUBMIT = /expired|blockhash not found|blockhashnotfound|timed? ?out|fetch failed/i;

/** Max submit attempts per action (PRD REQ-B-5: "blockhash refresh + bounded retries"). */
const MAX_SUBMIT_ATTEMPTS = 3;

/** Max confirmation re-polls for one already-sent signature (ambiguous transport). */
const MAX_CONFIRM_POLLS = 3;

export function createOperator(opts: OperatorOptions): OperatorService {
  const { connection, db, programId } = opts;
  const market = marketPda(programId).address;

  // Operator hot key, loaded lazily once from the configured path (R-3: the
  // secret never leaves this module — it is never logged or echoed).
  let signer: Keypair | null = null;
  function loadSigner(): Keypair {
    if (signer !== null) return signer;
    const path = opts.keypairPath;
    if (path === null || path === "") {
      throw new OperatorUnconfiguredError("OPERATOR_KEYPAIR is not set");
    }
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!Array.isArray(raw)) throw new Error("keypair file is not a JSON array");
      signer = Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
    } catch (err) {
      throw new OperatorUnconfiguredError(`cannot load the operator keypair (${describe(err)})`);
    }
    return signer;
  }

  // Market config (collateral mint, index source) is static per deployment:
  // fetched once over RPC and cached after the first successful decode.
  let marketState: PerpMarketState | null = null;
  async function loadMarket(): Promise<PerpMarketState> {
    if (marketState !== null) return marketState;
    const info = await connection.getAccountInfo(market, "confirmed");
    const decoded = info === null ? null : decodePerpMarket(info.data);
    if (decoded === null) {
      throw new Error(`perp market ${market.toBase58()} is not initialized on chain`);
    }
    marketState = decoded;
    return decoded;
  }

  // Strictly increasing `tx_log.created_at`: concurrent enqueues can land in
  // the same millisecond, and the FIFO evidence pins `created_at` to creation
  // order.
  let lastCreatedAt = 0;
  function nextCreatedAt(): number {
    const now = Date.now();
    lastCreatedAt = now > lastCreatedAt ? now : lastCreatedAt + 1;
    return lastCreatedAt;
  }

  // Per-user FIFO chains: each wallet owns one promise tail; every enqueue
  // appends after it. `prev.then(task, task)` runs the task regardless of the
  // previous action's outcome — one failure never blocks the wallet's queue.
  const chains = new Map<string, Promise<void>>();
  /** Enqueued-but-unsettled actions; backs `queueDepth()` (see the interface). */
  let pending = 0;
  function enqueue<T>(user: string, task: () => Promise<T>): Promise<T> {
    pending += 1;
    const prev = chains.get(user) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.then(
      () => {
        pending -= 1;
        if (chains.get(user) === tail) chains.delete(user);
      },
      () => {
        pending -= 1;
        if (chains.get(user) === tail) chains.delete(user);
      },
    );
    chains.set(user, tail);
    return next;
  }

  /**
   * Sign + send + confirm one instruction. Retries re-sign ONLY while nothing
   * has been accepted: once `sendRawTransaction` returns a signature the tx
   * may already have landed, so a failure after that (e.g. a transport error
   * from `confirmTransaction`) is AMBIGUOUS. Re-signing with a fresh blockhash
   * would make a second, cluster-undedupable landing (double-apply); instead
   * the sent signature is reconciled in place — bounded `confirmTransaction`
   * re-polls — and, if it still cannot be confirmed, reported as an
   * unconfirmed submission, never re-submitted.
   */
  async function submit(instruction: TransactionInstruction, kp: Keypair): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      let sent: { signature: string; blockhash: string; lastValidBlockHeight: number };
      try {
        const tx = new Transaction().add(instruction);
        tx.feePayer = kp.publicKey;
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.sign(kp);
        const signature = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        sent = { signature, blockhash, lastValidBlockHeight };
      } catch (err) {
        if (attempt >= MAX_SUBMIT_ATTEMPTS || !RETRYABLE_SUBMIT.test(describe(err))) {
          throw err;
        }
        // Transient (expired blockhash / transport): nothing was accepted by
        // the send call, so a fresh blockhash and signature are safe to retry.
        continue;
      }
      for (let poll = 1; ; poll++) {
        try {
          await connection.confirmTransaction(
            { signature: sent.signature, blockhash: sent.blockhash, lastValidBlockHeight: sent.lastValidBlockHeight },
            "confirmed",
          );
          return sent.signature;
        } catch (err) {
          if (poll >= MAX_CONFIRM_POLLS || !RETRYABLE_SUBMIT.test(describe(err))) {
            throw new Error(
              `transaction ${sent.signature} was submitted but could not be confirmed (${describe(err)})`,
            );
          }
          // Ambiguous transport failure: re-poll the SAME signature.
        }
      }
    }
  }

  interface ActionContext {
    operator: PublicKey;
    user: PublicKey;
    marketState: PerpMarketState;
  }

  /** The canonical associated token account for `(owner, mint)`. */
  function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0];
  }

  function parseWallet(user: string): PublicKey {
    try {
      return new PublicKey(user);
    } catch {
      throw new BadRequestError("user must be a base58 public key");
    }
  }

  /**
   * Enqueue one action: insert the `tx_log` row immediately (creation order ==
   * enqueue order), then run it FIFO on the user's chain — signing with the
   * operator key and confirming over the RPC. Resolves with the confirmed
   * `ActionResponse`; rejects (with the tx_log row at `failed`) otherwise.
   */
  function runAction(
    user: string,
    kind: string,
    build: (ctx: ActionContext) => TransactionInstruction,
  ): Promise<ActionResponse> {
    const actionId = randomUUID();
    db.insertTxLog({
      id: actionId,
      wallet: user,
      kind,
      status: "queued",
      signature: null,
      error: null,
      createdAt: nextCreatedAt(),
    });

    return enqueue(user, async () => {
      try {
        const kp = loadSigner();
        const wallet = parseWallet(user);
        const state = await loadMarket();
        const instruction = build({ operator: kp.publicKey, user: wallet, marketState: state });
        const signature = await submit(instruction, kp);
        db.updateTxLog(actionId, { status: "confirmed", signature });
        return { actionId, signature, status: "confirmed" } satisfies ActionResponse;
      } catch (err) {
        db.updateTxLog(actionId, { status: "failed", error: describe(err) });
        throw err instanceof Error ? err : new Error(describe(err));
      }
    });
  }

  return {
    executeDeposit(user, amount) {
      return runAction(user, "deposit", ({ operator, user: wallet, marketState: state }) =>
        buildOperatorDepositCollateral({
          operator,
          user: wallet,
          market,
          userAta: associatedTokenAddress(wallet, state.collateralMint),
          collateralMint: state.collateralMint,
          amount,
          programId,
        }),
      );
    },

    executeWithdraw(user, amount) {
      return runAction(user, "withdraw", ({ operator, user: wallet, marketState: state }) =>
        buildOperatorWithdrawCollateral({
          operator,
          user: wallet,
          market,
          userAta: associatedTokenAddress(wallet, state.collateralMint),
          collateralMint: state.collateralMint,
          indexSource: state.indexSource,
          amount,
          programId,
        }),
      );
    },

    executeOrder(user, order) {
      return runAction(user, "order", ({ operator, user: wallet, marketState: state }) => {
        if (order.kind === "limit") {
          if (order.price === undefined) {
            throw new BadRequestError("limit orders require a price");
          }
          return buildOperatorPlaceLimitOrder({
            operator,
            user: wallet,
            market,
            indexSource: state.indexSource,
            side: order.side,
            price: order.price,
            size: order.size,
            programId,
          });
        }
        // A market order is the taker ENTRY for the subject: the program grows
        // a position only through `open_position` / `operator_open_position`
        // (the `place_*` handlers are book-only and never touch the margin
        // ledger). The walk's OPEN step pins this route to the operator open
        // path with a market taker (`price 0` ⇒ IOC).
        return buildOperatorOpenPosition({
          operator,
          user: wallet,
          market,
          indexSource: state.indexSource,
          side: order.side,
          size: order.size,
          price: 0n,
          programId,
        });
      });
    },

    executeCancel(user, cancel) {
      return runAction(user, "cancel", ({ operator, user: wallet }) =>
        buildOperatorCancelOrder({
          operator,
          user: wallet,
          market,
          seq: cancel.seq,
          programId,
        }),
      );
    },

    executeClose(user, close) {
      return runAction(user, "close", ({ operator, user: wallet, marketState: state }) =>
        buildOperatorClosePosition({
          operator,
          user: wallet,
          market,
          indexSource: state.indexSource,
          side: close.side,
          size: close.size,
          programId,
        }),
      );
    },

    queueDepth: () => pending,
  };
}
