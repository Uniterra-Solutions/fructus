//! Ops helper — decode + print the live perp-market and yield-oracle state
//! (index baseline, funding epoch, oracle apy/version/staleness).
//!
//! Run: cd scripts && node node_modules/tsx/dist/cli.mjs print-market.mts [rpcUrl]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { decodePerpMarket, marketPda } from "fructus-sdk/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.argv[2] ?? process.env.RPC_URL ?? "http://127.0.0.1:8899";

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

const connection = new Connection(RPC, "confirmed");
const market = marketPda().address;
const marketAccount = await connection.getAccountInfo(market);
if (!marketAccount) throw new Error(`market ${market.toBase58()} not found on ${RPC}`);
const state = decodePerpMarket(marketAccount.data);
if (!state) throw new Error("market account did not decode");

const slot = await connection.getSlot("confirmed");

console.log(
  JSON.stringify(
    {
      rpc: RPC,
      market: market.toBase58(),
      authority: state.authority.toBase58(),
      indexSource: state.indexSource.toBase58(),
      fundingEpoch: state.fundingEpoch.toString(),
      fundingEpochSlots: state.fundingEpochSlots.toString(),
      indexBaseline: { n: state.indexN.toString(), d: state.indexD.toString() },
      baselineRate: state.indexD === 0n ? null : (Number(state.indexN) / Number(state.indexD)).toString(),
      fundingAccumulator: state.fundingAccumulator.toString(),
      currentSlot: slot,
      note: "baselineRate == 1.2 means the synthetic pool (12/10) was snapshotted; realized yield (funding index) stays 0 while the pool rate is static",
    },
    null,
    2,
  ),
);
