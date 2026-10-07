//! Entry point (REQ-B-1): load config → open the store → construct the modules
//! → start REST + WS → graceful shutdown on SIGINT/SIGTERM. `npm start` /
//! `npm run dev` run this file via tsx.

import { readFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, marketPda } from "fructus-sdk/src/index.js";
import { createApiServer } from "./api.js";
import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { OperatorUnconfiguredError } from "./errors.js";
import { createFaucet } from "./faucet.js";
import { createIndexer } from "./indexer.js";
import { createKeeper } from "./keeper.js";
import { createOperator } from "./operator.js";
import { computeBook, computeMarket, computePortfolio } from "./state.js";
import { attachWs } from "./ws.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.databasePath);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const programId = PROGRAM_ID;
  const market = marketPda(programId).address;

  // SIWS domain: per-request host, falling back to the configured default
  // (the challenge route threads the real host through in a later wave).
  const auth = createAuth({ db, jwtSecret: config.jwtSecret, domain: "127.0.0.1" });
  const operator = createOperator({
    connection,
    keypairPath: config.operatorKeypairPath,
    db,
    programId,
  });
  // Stage-1 operating model (R-3): the keeper reuses the operator hot key
  // (`OPERATOR_KEYPAIR`) — its crank/settle/liquidate txs are permissionless.
  const keeper = createKeeper({
    connection,
    db,
    programId,
    intervalMs: config.keeperIntervalMs,
    keypairPath: config.operatorKeypairPath,
  });
  const faucet = createFaucet({ config, connection, db });

  // The operator PUBLIC key is all `/bind/prepare` needs (the secret stays in
  // the operator service, R-3); resolved lazily from the configured path and
  // cached for the process lifetime.
  let operatorPubkey: PublicKey | null = null;
  function getOperatorPubkey(): PublicKey {
    if (operatorPubkey !== null) return operatorPubkey;
    const path = config.operatorKeypairPath;
    if (path === null || path === "") {
      throw new OperatorUnconfiguredError("OPERATOR_KEYPAIR is not set");
    }
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!Array.isArray(raw)) throw new Error("keypair file is not a JSON array");
      operatorPubkey = Keypair.fromSecretKey(Uint8Array.from(raw as number[])).publicKey;
    } catch (err) {
      // SEC-10-1: the raw fs error carries the absolute keypair path — keep the
      // detail in the server log only; the public envelope stays generic.
      console.error(
        `fructus-server: cannot load the operator keypair: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new OperatorUnconfiguredError("the operator keypair is not configured or unreadable");
    }
    return operatorPubkey;
  }

  // Devnet-prototype bootstrap (REQ-B-10): the operator hot key pays the fees
  // of its own transactions, so make sure it holds lamports. Best-effort: a
  // requestAirdrop is a no-op where the key is already funded and simply fails
  // (logged) on networks without a faucet — a production deployment pre-funds
  // the key out of band.
  if (config.operatorKeypairPath !== null) {
    try {
      await fundOperator(connection, getOperatorPubkey());
    } catch (err) {
      console.warn(`fructus-server: operator funding skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const api = createApiServer({
    config,
    db,
    auth,
    operator,
    keeper,
    faucet,
    connection,
    programId,
    market,
    getOperatorPubkey,
    getPortfolio: (wallet) => computePortfolio(db, wallet, market),
    getMarket: () => computeMarket(db, market),
    getBook: () => computeBook(db, market),
    getIndexedSlot: () => indexer.lastSlot(),
    // `/actions/*` progress lands on the actor's own sockets as a `tx` push.
    onAction: (wallet, action) => ws.sendToWallet(wallet.toBase58(), { type: "tx", action }),
  });
  const ws = attachWs({
    server: api.server,
    auth,
    market,
    computePortfolio: (wallet) => computePortfolio(db, wallet, market),
    computeBook: () => computeBook(db, market),
    computeMarket: () => computeMarket(db, market),
  });
  const indexer = createIndexer({
    connection,
    db,
    programId,
    // REQ-B-7: every indexed change fans out on the push channel.
    onUpdate: (update) => ws.onIndexerUpdate(update),
  });

  const port = await api.start(config.port);
  console.log(
    `fructus-server: listening on http://127.0.0.1:${port} (rpc=${config.rpcUrl}, db=${config.databasePath})`,
  );

  indexer.start().catch((err: unknown) => {
    console.error(`fructus-server: indexer start failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  keeper.start();

  // D-13: expired `auth_nonces` rows have no reader — sweep them once at boot
  // and then hourly on an unref'd timer so the challenge table cannot grow
  // without bound (an unref'd interval never holds the process open).
  const NONCE_SWEEP_INTERVAL_MS = 60 * 60_000;
  const sweepExpiredNonces = (): void => {
    try {
      const removed = db.deleteExpiredNonces();
      if (removed > 0) console.log(`fructus-server: swept ${removed} expired auth nonce(s)`);
    } catch (err) {
      console.error(`fructus-server: nonce sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  sweepExpiredNonces();
  const nonceSweep = setInterval(sweepExpiredNonces, NONCE_SWEEP_INTERVAL_MS);
  nonceSweep.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`fructus-server: ${signal} received — shutting down`);
    clearInterval(nonceSweep);
    keeper.stop();
    await Promise.allSettled([indexer.stop(), ws.close(), api.close()]);
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Top up the operator hot key from the network faucet when it cannot pay fees
 * (devnet/localnet prototype bootstrap). Never logs key material — the pubkey
 * is public and the signature is on-chain data.
 */
async function fundOperator(connection: Connection, operator: PublicKey): Promise<void> {
  const balance = await connection.getBalance(operator, "confirmed");
  if (balance >= LAMPORTS_PER_SOL) return; // already holds fee money
  const signature = await connection.requestAirdrop(operator, 10 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(signature, "confirmed");
  console.log(`fructus-server: funded the operator hot key for tx fees (${signature})`);
}

main().catch((err: unknown) => {
  console.error(`fructus-server: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
