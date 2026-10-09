//! Debug artifact — F3 · TOKEN-BALANCE-ERROR-IS-4XX.
//!
//! Measured counterexample (live walkthrough): a deposit larger than the
//! wallet's token balance failed with the raw SPL Token `insufficient funds`
//! simulation and surfaced as the opaque 500 `internal`. The log lines below
//! are quoted verbatim from that run; the route must answer a stable 4xx
//! domain error instead.

import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, type Connection } from "@solana/web3.js";
import { PROGRAM_ID, marketPda } from "fructus-sdk/src/index.js";
import type { ActionResponse } from "fructus-sdk/src/api.js";
import { createApiServer } from "../src/api.js";
import { createAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { Keeper } from "../src/keeper.js";
import type { OperatorService } from "../src/operator.js";

const JWT_SECRET = "f3-secret";
const MARKET = marketPda(PROGRAM_ID).address;

/** The exact simulation logs from the measured failing deposit. */
const MEASURED_LOGS = [
  "Program 3EsUd5XQ6KChedwL2ho8pv3zrrGGFvMpJEV1PnzN8MD1 invoke [1]",
  "Program log: Instruction: OperatorDepositCollateral",
  "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]",
  "Program log: Error: insufficient funds",
  "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 181 of 179180 compute units",
  "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1",
  "Program 3EsUd5XQ6KChedwL2ho8pv3zrrGGFvMpJEV1PnzN8MD1 failed: custom program error: 0x1",
];
const measuredError = Object.assign(
  new Error(
    "Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1. \nLogs: \n" +
      JSON.stringify(MEASURED_LOGS, null, 2),
  ),
  { logs: MEASURED_LOGS },
);

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function craftJwt(secret: string, payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

interface ApiHarness {
  base: string;
  close: () => Promise<void>;
}

async function startApiHarness(throwable: unknown): Promise<ApiHarness> {
  const db = openDb(":memory:");
  const config = loadConfig({ JWT_SECRET } as unknown as NodeJS.ProcessEnv);
  const auth = createAuth({ db, jwtSecret: JWT_SECRET, domain: "127.0.0.1" });
  const throwing = async (): Promise<ActionResponse> => {
    throw throwable;
  };
  const operator: OperatorService = {
    executeDeposit: throwing,
    executeWithdraw: throwing,
    executeOrder: throwing,
    executeCancel: throwing,
    executeClose: throwing,
    queueDepth: () => 0,
  };
  const keeper: Keeper = {
    tick: async () => ({ cranked: 0, settledFills: 0, settledFunding: 0, settledClose: 0, liquidated: 0 }),
    start() {},
    stop() {},
  };
  const server = createApiServer({
    config,
    db,
    auth,
    operator,
    keeper,
    faucet: null,
    getPortfolio: (w) => ({
      wallet: w.toBase58(),
      deposited: "1000",
      reserved: "0",
      claimable: "0",
      free: "1000",
      equity: "1000",
      requirementInitial: "0",
      requirementMaint: "0",
      health: "healthy",
      operator: null,
      positions: [],
    }),
    getMarket: () => ({ mark: null, index: "0", fundingRate: "0", fundingAccumulator: "0", bestBid: null, bestAsk: null }),
    getBook: () => ({ bids: [], asks: [] }),
    connection: {} as unknown as Connection,
    programId: PROGRAM_ID,
    market: MARKET,
    getOperatorPubkey: () => Keypair.fromSeed(new Uint8Array(32).fill(60)).publicKey,
  });
  const port = await server.start(0);
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test(`TOKEN-BALANCE-ERROR-IS-4XX: an action failing on the wallet's token balance answers a stable 4xx domain error, never the opaque 500 internal`, async () => {
  // Both shapes a caller can present: the SendTransactionError object (with
  // `.logs`) and a bare message-only error carrying the same simulation text.
  const messageOnly = new Error(measuredError.message);
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(61)).publicKey;
  const now = Math.floor(Date.now() / 1_000);
  const token = craftJwt(JWT_SECRET, { sub: wallet.toBase58(), iat: now, exp: now + 600 });

  for (const throwable of [measuredError, messageOnly]) {
    const harness = await startApiHarness(throwable);
    try {
      const res = await fetch(`${harness.base}/actions/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ amount: "100000000" }), // 100 tUSDC — the measured oversized deposit
      });
      const body = (await res.json()) as { ok: boolean; error?: { code: string } };
      assert.equal(res.status, 400, `status must be 4xx (got ${res.status}: ${JSON.stringify(body)})`);
      assert.equal(body.ok, false);
      assert.equal(body.error?.code, "insufficient_token_balance");
    } finally {
      await harness.close();
    }
  }
});

test(`TOKEN-BALANCE-ERROR-IS-4XX: an action failing on the wallet's token balance answers a stable 4xx domain error, never the opaque 500 internal (pinned)`, async () => {
  // The frozen measured counterexample: the exact SendTransactionError
  // (`.logs` + message) and the exact oversized deposit from the live run.
  const harness = await startApiHarness(measuredError);
  try {
    const wallet = Keypair.fromSeed(new Uint8Array(32).fill(62)).publicKey;
    const now = Math.floor(Date.now() / 1_000);
    const token = craftJwt(JWT_SECRET, { sub: wallet.toBase58(), iat: now, exp: now + 600 });
    const res = await fetch(`${harness.base}/actions/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: "100000000" }),
    });
    const body = (await res.json()) as { ok: boolean; error?: { code: string } };
    assert.equal(res.status, 400);
    assert.equal(body.error?.code, "insufficient_token_balance");
  } finally {
    await harness.close();
  }
});
