//! Operator service (REQ-B-5, D4/D5): the signer half of the no-signature UX.
//! Builds operator actions via the SDK operator builders, signs with the
//! server-side operator keypair (never logged, R-3), confirms over WS, and
//! records every attempt in `tx_log`. STUBS reject with `not_implemented`; the
//! per-user FIFO queue skeleton is outlined below.

import type { Connection, PublicKey } from "@solana/web3.js";
import type { ActionResponse } from "fructus-sdk/src/api.js";
import type { Db } from "./db.js";
import { NotImplementedError } from "./errors.js";

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
  /** Pending actions across all users (per-user FIFO queues). */
  queueDepth(): number;
}

export interface OperatorOptions {
  connection: Connection;
  /** Operator keypair path; `null` = unconfigured (actions unavailable). */
  keypairPath: string | null;
  db: Db;
  programId: PublicKey;
}

export function createOperator(opts: OperatorOptions): OperatorService {
  // STUB (REQ-B-5, D4/D5). Later wave wires:
  //  - per-user FIFO: one chained promise per wallet (`queues`), so concurrent
  //    enqueues for one user execute FIFO without interleaving
  //    (OPERATOR-QUEUE-SERIALIZES-PER-USER); different users run independently;
  //  - each action: SDK operator builder for `opts.programId` (deposit /
  //    withdraw / open / close / limit / market / cancel), fresh blockhash,
  //    sign with the keypair loaded once from `opts.keypairPath`, send, confirm
  //    over WS, bounded retries on blockhash expiry;
  //  - every attempt is a `tx_log` row; the returned `ActionResponse` mirrors
  //    it (`queued` -> `sent` -> `confirmed`/`failed`).
  void opts;
  const queues = new Map<string, Promise<unknown>>();

  const notImplemented = (action: string): Promise<never> =>
    Promise.reject(new NotImplementedError(action));

  return {
    executeDeposit: () => notImplemented("operator.executeDeposit"),
    executeWithdraw: () => notImplemented("operator.executeWithdraw"),
    executeOrder: () => notImplemented("operator.executeOrder"),
    executeCancel: () => notImplemented("operator.executeCancel"),
    executeClose: () => notImplemented("operator.executeClose"),
    queueDepth: () => queues.size,
  };
}
