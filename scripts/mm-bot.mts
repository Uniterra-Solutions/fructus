//! Market-maker bot (product-v3 REQ-M-1/M-2): quotes a two-sided ladder from
//! a funded keypair via the SDK builders. Stub — implemented in the MM wave.
//!
//! Env: RPC_URL (required), MM_KEYPAIR (keypair path, required),
//! MM_LEVELS, MM_SPREAD_BPS, MM_SIZE, MM_INTERVAL_MS (see mm-lib).

import { pathToFileURL } from "node:url";

async function main(): Promise<void> {
  console.error("mm-bot: not implemented (product-v3 freeze stub)");
  process.exitCode = 1;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
