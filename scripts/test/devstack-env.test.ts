//! RED acceptance test for the devstack env-block printer (product-v3 REQ-V-1,
//! ACCEPTANCE row DEVSTACK-ENV-BLOCK-COMPLETE): `formatEnvBlocks` must render
//! the copy-paste env blocks for the server and the MM bot — every required key
//! (RPC_URL, DATABASE_PATH, JWT_SECRET, OPERATOR_KEYPAIR, FAUCET_ENABLED,
//! FAUCET_MINT, FAUCET_MINT_AUTHORITY_KEYPAIR, MM_KEYPAIR) and every given
//! value, for a fixed sentinel set and for 20 deterministic generated sets.
//!
//! FAUCET_ENABLED is a literal (not a DevstackValues field) and must read 1,
//! tolerating either quoting style: `FAUCET_ENABLED=1` / `FAUCET_ENABLED="1"`.
//!
//! RED on today's tree: devstack.mts is a freeze stub (`formatEnvBlocks` → "")
//! — the non-empty guard below fails as a clean assertion before any key is
//! checked, never as a compile/import error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEnvBlocks } from "../devstack.mjs";
import type { DevstackValues } from "../devstack.mjs";

// ---------------------------------------------------------------------------
// Seeded PRNG (repo house style: deterministic xorshift64 sweeps, no deps)
// ---------------------------------------------------------------------------

function xorshift(seed: number): () => number {
  let s = BigInt(seed >>> 0) || 1n;
  return () => {
    s ^= s << 13n;
    s ^= s >> 7n;
    s ^= s << 17n;
    s &= 0xffffffffffffffffn;
    return Number(s % 1000000000000000000n);
  };
}

/** base58-ish alphanumeric tag (deterministic, no deps). */
function randAlnum(rng: () => number, n: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[Number(BigInt(rng()) % BigInt(alphabet.length))];
  }
  return out;
}

const REQUIRED_KEYS = [
  "RPC_URL",
  "DATABASE_PATH",
  "JWT_SECRET",
  "OPERATOR_KEYPAIR",
  "FAUCET_ENABLED",
  "FAUCET_MINT",
  "FAUCET_MINT_AUTHORITY_KEYPAIR",
  "MM_KEYPAIR",
] as const;

/** Every required key, every given value, and FAUCET_ENABLED=1 must appear. */
function assertEnvBlockComplete(out: string, values: DevstackValues, ctx: string): void {
  assert.ok(out.length > 0, `env block must be non-empty (${ctx})`);
  for (const key of REQUIRED_KEYS) {
    assert.ok(out.includes(key), `missing env key ${key} (${ctx})`);
  }
  for (const [name, value] of Object.entries(values)) {
    assert.ok(out.includes(value), `missing ${name} value ${value} (${ctx})`);
  }
  assert.match(out, /^FAUCET_ENABLED=?"?1"?/m, `FAUCET_ENABLED must be 1 (${ctx})`);
}

// ---------------------------------------------------------------------------
// DEVSTACK-ENV-BLOCK-COMPLETE
// ---------------------------------------------------------------------------

test("DEVSTACK-ENV-BLOCK-COMPLETE: the env-block printer emits all required keys for both the server and the bot given generated values", () => {
  // fixed sentinel set: every value is a unique marker, so a stale or
  // mis-wired value cannot hide behind another
  const sentinels: DevstackValues = {
    rpcUrl: "http://127.0.0.1:8899",
    databasePath: "./devstack.sqlite",
    jwtSecret: "dev-secret-sentinel",
    operatorKeypair: "/tmp/ds/operator.keypair.json",
    faucetMint: "MintSentinel111111111111111111111111111111",
    faucetMintAuthority: "/tmp/ds/mint-authority.keypair.json",
    mmKeypair: "/tmp/ds/mm.keypair.json",
  };
  const sentinelOut = formatEnvBlocks(sentinels);
  assert.ok(sentinelOut.length > 0, "formatEnvBlocks returned an empty string");
  assertEnvBlockComplete(sentinelOut, sentinels, "sentinels");

  // 20 deterministic distinct generated value sets (PRNG-built paths/mints)
  const rng = xorshift(0xde75ac);
  const tags = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const tag = `${i}-${randAlnum(rng, 8)}`;
    const values: DevstackValues = {
      rpcUrl: `http://127.0.0.1:${8899 + i}`,
      databasePath: `./devstack-${tag}.sqlite`,
      jwtSecret: `secret-${tag}`,
      operatorKeypair: `/tmp/ds-${tag}/operator-${randAlnum(rng, 8)}.keypair.json`,
      faucetMint: `Mint${tag}${randAlnum(rng, 16)}`,
      faucetMintAuthority: `/tmp/ds-${tag}/mint-authority-${randAlnum(rng, 8)}.keypair.json`,
      mmKeypair: `/tmp/ds-${tag}/mm-${randAlnum(rng, 8)}.keypair.json`,
    };
    tags.add(tag);
    assertEnvBlockComplete(formatEnvBlocks(values), values, `generated set ${i}`);
  }
  assert.equal(tags.size, 20, "the 20 generated sets must be distinct");
});
