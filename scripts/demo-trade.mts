//! VPS helper — make a REAL fill on the local devstack (proof that /market/candles
//! and /market/trades populate from actual trades; no external data source).
//!
//! What it does (mirrors server/test/kline-e2e.test.ts, against the live devstack):
//!   1. reads the devstack authority key + the server env (FAUCET_MINT);
//!   2. generates a demo trader keypair, funds it (SOL + tUSDC ATA via spl-token);
//!   3. deposits collateral;
//!   4. crosses the MM bot's resting ask with a market buy (open_position, SIDE_BID)
//!      N times → N fills → the server's indexer buckets them into candles.
//!
//! Run: cd scripts && node node_modules/tsx/dist/cli.mjs demo-trade.mts [--count N]
//! Prints one JSON line per submitted signature.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  SIDE_BID,
  buildDepositCollateral,
  buildOpenPosition,
  decodePerpMarket,
  marketPda,
} from "fructus-sdk/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(here, ".devstack", "keys");
const SERVER_ENV = join(here, "..", "deploy", "server.env");
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const DEPOSIT = 5_000_000n; // raw microunits (mirror the harness)
const MINT_AMOUNT = 10_000_000; // raw microunits minted to the demo trader
const SIZE = 1_000_000n; // one MM lot
const AIRDROP_SOL = 10;

const args = process.argv.slice(2);
const countArg = args.indexOf("--count");
const COUNT = countArg >= 0 ? Number(args[countArg + 1] ?? 1) : 1;

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf-8")) as number[]));
}

function run(cmd: string, cmdArgs: string[]): string {
  const result = spawnSync(cmd, cmdArgs, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (${result.status}): ${(result.stderr ?? "").slice(0, 400)}`);
  }
  return result.stdout;
}

function parseJson(out: string): Record<string, unknown> {
  const match = out.match(/\{.*\}/s);
  if (!match) throw new Error(`no JSON in output: ${out.slice(0, 200)}`);
  return JSON.parse(match[0]) as Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function submit(
  connection: Connection,
  instruction: TransactionInstruction,
  signer: Keypair,
): Promise<string> {
  const tx = new Transaction().add(instruction);
  tx.feePayer = signer.publicKey;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash.blockhash;
  tx.sign(signer);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(
    { signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
    "confirmed",
  );
  return signature;
}

async function airdrop(connection: Connection, pubkey: PublicKey, sol: number): Promise<void> {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  for (let i = 0; i < 12 && (await connection.getBalance(pubkey)) < lamports; i++) {
    try {
      await connection.requestAirdrop(pubkey, lamports);
    } catch {
      /* rate-limited; retry */
    }
    await sleep(300);
  }
  const after = await connection.getBalance(pubkey);
  if (after < lamports) throw new Error(`airdrop to ${pubkey.toBase58()} short (got ${after})`);
}

async function main(): Promise<void> {
  const connection = new Connection(RPC, "confirmed");
  const authorityPath = join(KEYS_DIR, "authority.keypair.json");
  const authority = loadKeypair(authorityPath);

  // Collateral mint: whatever the running server was booted with.
  const mintMatch = /^FAUCET_MINT=(.+)$/m.exec(readFileSync(SERVER_ENV, "utf-8"));
  if (!mintMatch) throw new Error(`FAUCET_MINT not found in ${SERVER_ENV}`);
  const mint = new PublicKey(mintMatch[1]!.trim());

  // Market + its synthetic index source, straight from the chain.
  const market = marketPda().address;
  const marketAccount = await connection.getAccountInfo(market);
  if (!marketAccount) throw new Error(`market ${market.toBase58()} not found`);
  const state = decodePerpMarket(marketAccount.data);
  if (!state) throw new Error("could not decode the perp market account");
  const indexSource = state.indexSource;

  const takerPath = join(KEYS_DIR, "demo-trader.keypair.json");
  const taker = Keypair.generate();
  writeFileSync(takerPath, JSON.stringify(Array.from(taker.secretKey)), { mode: 0o600 });
  await airdrop(connection, taker.publicKey, AIRDROP_SOL);

  // ATA + tUSDC via the spl-token CLI (same pattern as the devstack).
  const cfgPath = join(here, ".devstack", "demo-trader.cfg");
  writeFileSync(
    cfgPath,
    [`json_rpc_url: ${RPC}`, 'websocket_url: ""', `keypair_path: ${authorityPath}`, "commitment: confirmed", ""].join("\n"),
  );
  let ata: PublicKey | null = null;
  try {
    const out = run("spl-token", [
      "create-account", mint.toBase58(), "--owner", taker.publicKey.toBase58(),
      "--config", cfgPath, "--fee-payer", authorityPath, "--output", "json",
    ]);
    const parsed = parseJson(out);
    const address = ((parsed.commandOutput ?? parsed) as Record<string, unknown>).address as string | undefined;
    if (address) ata = new PublicKey(address);
  } catch {
    /* ATA probably exists from a previous run */
  }
  if (ata === null) {
    const accounts = await connection.getTokenAccountsByOwner(taker.publicKey, { mint });
    ata = accounts.value[0]?.pubkey ?? null;
  }
  if (ata === null) throw new Error("no tUSDC ATA for the demo trader");
  run("spl-token", ["mint", mint.toBase58(), String(MINT_AMOUNT), ata.toBase58(), "--config", cfgPath, "--output", "json"]);

  const sigs: string[] = [];
  sigs.push(
    await submit(
      connection,
      buildDepositCollateral({
        user: taker.publicKey,
        market,
        userAta: ata,
        collateralMint: mint,
        amount: DEPOSIT,
      }),
      taker,
    ),
  );

  for (let i = 0; i < COUNT; i++) {
    // Market buy (price 0) — crosses the MM bot's resting ask.
    sigs.push(
      await submit(
        connection,
        buildOpenPosition({ owner: taker.publicKey, market, indexSource, side: SIDE_BID, size: SIZE, price: 0n }),
        taker,
      ),
    );
    await sleep(2_000);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        taker: taker.publicKey.toBase58(),
        market: market.toBase58(),
        mint: mint.toBase58(),
        deposit: DEPOSIT.toString(),
        crossings: COUNT,
        signatures: sigs,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`demo-trade failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
