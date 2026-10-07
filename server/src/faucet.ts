//! Faucet (D15, REQ-B-8): devnet-only test-USDC mint endpoint. Disabled — and
//! answering 404 — unless `FAUCET_ENABLED=1` and both the mint and the mint
//! authority keypair are configured; caps are per-wallet (10,000 tUSDC) and
//! global (`FAUCET_GLOBAL_CAP`) per 24 h. STUB: `handle()` returns
//! `not_implemented` when enabled and throws `FaucetDisabledError` (404
//! semantics) when disabled; the mint path lands in a later wave.

import type { Connection } from "@solana/web3.js";
import type { FaucetRequest, FaucetResponse } from "fructus-sdk/src/api.js";
import type { Config } from "./config.js";
import { FaucetDisabledError, NotImplementedError } from "./errors.js";

export interface Faucet {
  handle(req: FaucetRequest): Promise<FaucetResponse>;
}

export interface FaucetOptions {
  config: Config;
  connection: Connection;
}

export function createFaucet(opts: FaucetOptions): Faucet {
  return {
    async handle(): Promise<FaucetResponse> {
      // STUB (REQ-B-8). Later wave: create the wallet ATA if missing, check the
      // 24 h per-wallet + global caps (clock-injected rows), mint exactly the
      // amount once to the wallet's ATA, return {amount, ata}.
      const { faucetEnabled, faucetMint, faucetMintAuthorityKeypair } = opts.config;
      if (!faucetEnabled || faucetMint === null || faucetMintAuthorityKeypair === null) {
        throw new FaucetDisabledError(); // -> 404, D15
      }
      void opts.connection;
      throw new NotImplementedError("faucet.handle");
    },
  };
}
