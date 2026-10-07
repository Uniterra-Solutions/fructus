//! Entry point (REQ-B-1): load config → open the store → construct the modules
//! → start REST + WS → graceful shutdown on SIGINT/SIGTERM. `npm start` /
//! `npm run dev` run this file via tsx.

import { Connection } from "@solana/web3.js";
import { PROGRAM_ID, marketPda } from "fructus-sdk/src/index.js";
import { createApiServer } from "./api.js";
import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
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
  const keeper = createKeeper({ connection, db, programId, intervalMs: config.keeperIntervalMs });
  const faucet = createFaucet({ config, connection });

  const api = createApiServer({
    config,
    db,
    auth,
    operator,
    keeper,
    faucet,
    getPortfolio: (wallet) => computePortfolio(db, wallet, market),
    getMarket: () => computeMarket(db, market),
    getBook: () => computeBook(db, market),
  });
  const ws = attachWs({ server: api.server, auth, db });

  const indexer = createIndexer({
    connection,
    db,
    programId,
    onUpdate: () => {
      /* STUB: routed to ws.broadcast once the push wave lands */
    },
  });

  const port = await api.start(config.port);
  console.log(
    `fructus-server: listening on http://127.0.0.1:${port} (rpc=${config.rpcUrl}, db=${config.databasePath})`,
  );

  indexer.start().catch((err: unknown) => {
    console.error(`fructus-server: indexer start failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  keeper.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`fructus-server: ${signal} received — shutting down`);
    keeper.stop();
    await Promise.allSettled([indexer.stop(), ws.close(), api.close()]);
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(`fructus-server: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
