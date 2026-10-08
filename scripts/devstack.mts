//! Local devstack (product-v3 REQ-V-1): validator + market init + tokens +
//! funded keys + printed env blocks. Stub — implemented in the devstack wave.

import { pathToFileURL } from "node:url";

export interface DevstackValues {
  rpcUrl: string;
  databasePath: string;
  jwtSecret: string;
  operatorKeypair: string;
  faucetMint: string;
  faucetMintAuthority: string;
  mmKeypair: string;
}

/** Render the copy-paste env blocks for the server and the MM bot. */
export function formatEnvBlocks(_values: DevstackValues): string {
  return "";
}

async function main(): Promise<void> {
  console.error("devstack: not implemented (product-v3 freeze stub)");
  process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
