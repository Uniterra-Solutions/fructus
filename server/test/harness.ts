//! Self-contained e2e test harness for the server suites. Adapted from
//! `integration/src/harness.ts` (the needed subset), but deliberately standalone
//! — nothing here imports `fructus-integration` or `fructus-cli`.
//!
//! It provides:
//!  - `startValidator()` — a hermetic `solana-test-validator` (`--reset`) running
//!    the deployed Fructus program (`.so` from `target/deploy` or
//!    `FRUCTUS_SO_PATH`), seeded at genesis with a synthetic SPL stake-pool
//!    `index_source` (`--account`: `account_type` byte 1, `total_lamports` /
//!    `pool_token_supply` at offsets 258/266), plus a funded authority and a
//!    solana-CLI config bound to the validator;
//!  - `createMint()` (6 dp collateral mint via `spl-token`), `initMarket()`,
//!    `fundTrader()`, `submit()`;
//!  - `patchStakePool()` — re-seed the synthetic pool (see docstring: stock
//!    `solana-test-validator` has no live account-write RPC, so this re-genesises
//!    the ledger);
//!  - `startServer()` — boots the `fructus-server` package against the validator
//!    with a temp SQLite file, and waits for `/healthz`;
//!  - `stopAll()` — kills every spawned process group and removes the fixtures.
//!
//! All fixtures live under `mkdtemp` dirs; nothing outside them is written.
//! `--test-force-exit`-friendly: an `exit` hook kills any process that is still
//! tracked.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PROGRAM_ID,
  STAKE_POOL_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_DECIMALS,
  buildInitializeCollateralVault,
  buildInitializeMarket,
  buildInitializeOrderBook,
  marketPda,
  orderBookPda,
  vaultPda,
} from "fructus-sdk/src/index.js";

/** `server/` package root (this file lives at `server/test/`). */
const SERVER_ROOT = new URL("..", import.meta.url).pathname;
/** Repo root (holds `target/deploy/fructus.so`). */
const REPO_ROOT = new URL("../..", import.meta.url).pathname;

export const DEFAULT_SO_PATH = join(REPO_ROOT, "target", "deploy", "fructus.so");
export const DEFAULT_RPC_URL = "http://127.0.0.1:8899";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Market parameters (same ballpark as the integration harness + AGENTS.md). */
export interface MarketParams {
  fundingK: bigint;
  maxFunding: bigint;
  fundingEpochSlots: bigint;
  initialMarginBps: number;
  maintenanceMarginBps: number;
}

export const DEFAULT_MARKET: MarketParams = {
  fundingK: 100_000n,
  maxFunding: 10_000n,
  fundingEpochSlots: 1_000n,
  initialMarginBps: 1_000, // 10x
  maintenanceMarginBps: 500,
};

export interface MarketEnv {
  market: PublicKey;
  orderBook: PublicKey;
  vault: PublicKey;
}

/** @internal restart bookkeeping for `patchStakePool()`. */
interface ValidatorInternals {
  dir: string;
  ledgerDir: string;
  dumpPath: string;
  logPath: string;
  spawnArgs: string[];
  proc: ChildProcess;
}

export interface Validator {
  rpcUrl: string;
  connection: Connection;
  programId: PublicKey;
  indexSource: PublicKey;
  indexTotalLamports: bigint;
  indexPoolTokenSupply: bigint;
  /** Funded authority keypair (signs `initialize_*` + cranks). */
  authority: Keypair;
  /** SPL collateral mint; a placeholder until `createMint(v)` runs. */
  mint: PublicKey;
  /** solana-CLI config file bound to this validator. */
  configPath: string;
  authorityKeypairPath: string;
  /** @internal */
  internals: ValidatorInternals;
  /** Kill the validator and delete its fixture dir (best-effort). */
  stop(): void;
}

export interface StartValidatorOptions {
  /** Defaults to the first free localhost port (8899 preferred). */
  rpcUrl?: string;
  authority?: Keypair;
  indexTotalLamports?: bigint;
  indexPoolTokenSupply?: bigint;
  programId?: PublicKey;
  /** Defaults to `FRUCTUS_SO_PATH` or `target/deploy/fructus.so`. */
  soPath?: string;
}

export interface StartServerOptions {
  /** Validator to point the server at; `rpcUrl` wins if both are given. */
  validator?: Validator;
  rpcUrl?: string;
  /** HTTP port; defaults to a free ephemeral port. */
  port?: number;
  /** Extra env overrides merged over the harness defaults. */
  env?: Record<string, string>;
}

export interface ServerHandle {
  apiUrl: string;
  port: number;
  dbPath: string;
  proc: ChildProcess;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Process bookkeeping
// ---------------------------------------------------------------------------

const liveValidators = new Set<Validator>();
const liveServers = new Set<ServerHandle>();

function killGroup(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    process.kill(-proc.pid!, "SIGKILL"); // the process group
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function stopProcess(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const done = () => resolve();
    proc.once("exit", done);
    killGroup(proc);
    const timer = setTimeout(done, 3_000);
    timer.unref();
  });
}

// Best-effort cleanup if the test process force-exits without stopAll().
process.once("exit", () => {
  for (const server of liveServers) killGroup(server.proc);
  for (const validator of liveValidators) killGroup(validator.internals.proc);
});

/** Kill every validator/server this harness started and delete their fixtures. */
export async function stopAll(): Promise<void> {
  for (const server of [...liveServers]) {
    try {
      await server.stop();
    } catch {
      /* best-effort */
    }
  }
  for (const validator of [...liveValidators]) {
    try {
      validator.stop();
    } catch {
      /* best-effort */
    }
  }
  liveServers.clear();
  liveValidators.clear();
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** OS-assigned free port on 127.0.0.1. */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * RPC URL for a new validator: 8899 when free (the repo-wide default), else an
 * ephemeral port whose derived port block (gossip/faucet/dynamic, +1000..+3100)
 * still fits in u16.
 */
async function pickRpcUrl(): Promise<string> {
  if (await portIsFree(8899)) return DEFAULT_RPC_URL;
  let port = await freePort();
  while (port + 3_100 > 65_535) port = await freePort();
  return `http://127.0.0.1:${port}`;
}

function portOf(rpcUrl: string): number {
  const match = rpcUrl.match(/:(\d+)/);
  if (!match) throw new Error(`cannot parse port from RPC URL: ${rpcUrl}`);
  return Number(match[1]);
}

// ---------------------------------------------------------------------------
// Account-dump + config writers
// ---------------------------------------------------------------------------

function writeIndexSourceDump(
  path: string,
  pubkey: PublicKey,
  totalLamports: bigint,
  poolTokenSupply: bigint,
): void {
  // SPL StakePool account layout (with the AccountType discriminator): the
  // program reads byte0 == 1 and u64 LE at 258/266 (see exchange.rs).
  const space = 1024;
  const data = new Uint8Array(space);
  data[0] = 1; // AccountType::StakePool
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setBigUint64(258, totalLamports, true);
  view.setBigUint64(266, poolTokenSupply, true);
  writeFileSync(
    path,
    JSON.stringify({
      pubkey: pubkey.toBase58(),
      account: {
        lamports: 5_000_000_000, // 5 SOL, rent-exempt for 1 KiB
        data: [Buffer.from(data).toString("base64"), "base64"],
        owner: STAKE_POOL_PROGRAM_ID.toBase58(),
        executable: false,
        rentEpoch: 0,
      },
    }),
  );
}

function writeSolanaConfig(dir: string, rpcUrl: string, keypairPath: string): string {
  const configPath = join(dir, "solana.cfg");
  writeFileSync(
    configPath,
    [
      `json_rpc_url: ${rpcUrl}`,
      'websocket_url: ""',
      `keypair_path: ${keypairPath}`,
      "commitment: confirmed",
      "",
    ].join("\n"),
  );
  return configPath;
}

function writeKeypair(path: string, keypair: Keypair): void {
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
}

// ---------------------------------------------------------------------------
// Process + RPC helpers
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function parseJson(out: string): Record<string, unknown> {
  const match = out.match(/\{.*\}/s);
  if (!match) throw new Error(`no JSON in output: ${out.slice(0, 200)}`);
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function logTail(logPath: string, lines = 8): string {
  if (!existsSync(logPath)) return "";
  return readFileSync(logPath, "utf-8").trim().split("\n").slice(-lines).join("\n");
}

function spawnValidatorProcess(args: string[], logPath: string): ChildProcess {
  const logFd = openSync(logPath, "a");
  return spawn("solana-test-validator", args, {
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
}

async function waitForRpc(connection: Connection, timeoutMs = 45_000, logPath?: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await connection.getLatestBlockhash("confirmed");
      return;
    } catch {
      if (Date.now() - start > timeoutMs) {
        const tail = logPath ? logTail(logPath, 6) : "";
        throw new Error(
          `validator RPC ${connection.rpcEndpoint} not ready after ${timeoutMs}ms` +
            (tail ? ` — validator log tail:\n${tail}` : "") +
            `\n(a validator dies before binding when another one already holds its gossip/` +
            `dynamic port block — check for a stray solana-test-validator)`,
        );
      }
      await sleep(400);
    }
  }
}

async function airdrop(connection: Connection, pubkey: PublicKey, sol: number): Promise<void> {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if ((await connection.getBalance(pubkey)) >= lamports) return;
  for (let i = 0; i < 12 && (await connection.getBalance(pubkey)) < lamports; i++) {
    try {
      await connection.requestAirdrop(pubkey, lamports);
    } catch {
      /* rate-limited; retry */
    }
    await sleep(300);
  }
  const after = await connection.getBalance(pubkey);
  if (after < lamports) {
    throw new Error(`airdrop to ${pubkey.toBase58()} did not reach ${sol} SOL (got ${after / LAMPORTS_PER_SOL})`);
  }
}

// ---------------------------------------------------------------------------
// Validator lifecycle
// ---------------------------------------------------------------------------

export async function startValidator(opts: StartValidatorOptions = {}): Promise<Validator> {
  const soPath = opts.soPath ?? process.env.FRUCTUS_SO_PATH ?? DEFAULT_SO_PATH;
  if (!existsSync(soPath)) {
    throw new Error(
      `program .so not found: ${soPath} — stage target/deploy/fructus.so first, or set FRUCTUS_SO_PATH`,
    );
  }

  const programId = opts.programId ?? PROGRAM_ID;
  const rpcUrl = opts.rpcUrl ?? (await pickRpcUrl());
  const authority = opts.authority ?? Keypair.generate();
  const indexTotalLamports = opts.indexTotalLamports ?? 12_000_000_000n; // ~12 SOL
  const indexPoolTokenSupply = opts.indexPoolTokenSupply ?? 10_000_000_000n;

  const dir = mkdtempSync(join(tmpdir(), "fructus-server-val-"));
  const ledgerDir = join(dir, "ledger");
  const authorityKeypairPath = join(dir, "authority.json");
  writeKeypair(authorityKeypairPath, authority);

  // Synthetic stake-pool `index_source`, loaded at genesis.
  const indexSource = Keypair.generate().publicKey;
  const dumpPath = join(dir, "index-source.json");
  writeIndexSourceDump(dumpPath, indexSource, indexTotalLamports, indexPoolTokenSupply);

  const configPath = writeSolanaConfig(dir, rpcUrl, authorityKeypairPath);
  const logPath = join(dir, "validator.log");

  // The RPC port is caller-controlled, but the validator's other defaults
  // (gossip 8000, faucet 9900, dynamic range 8000-8020) collide with any other
  // validator on the machine. Keep every port in a block derived from the RPC
  // port, and keep the log for the failure path.
  const rpcPort = portOf(rpcUrl);
  const spawnArgs = [
    "--ledger",
    ledgerDir,
    "--reset",
    "--rpc-port",
    String(rpcPort),
    "--gossip-port",
    String(rpcPort + 1_000),
    "--faucet-port",
    String(rpcPort + 2_000),
    "--dynamic-port-range",
    `${rpcPort + 3_000}-${rpcPort + 3_100}`,
    "--bpf-program",
    programId.toBase58(),
    soPath,
    "--account",
    indexSource.toBase58(),
    dumpPath,
  ];

  const proc = spawnValidatorProcess(spawnArgs, logPath);
  const connection = new Connection(rpcUrl, "confirmed");
  await waitForRpc(connection, 45_000, logPath);
  await airdrop(connection, authority.publicKey, 120);

  const validator: Validator = {
    rpcUrl,
    connection,
    programId,
    indexSource,
    indexTotalLamports,
    indexPoolTokenSupply,
    authority,
    mint: PublicKey.unique(), // placeholder; createMint(v) sets the real one
    configPath,
    authorityKeypairPath,
    internals: { dir, ledgerDir, dumpPath, logPath, spawnArgs, proc },
    stop() {
      killGroup(proc);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      liveValidators.delete(validator);
    },
  };
  liveValidators.add(validator);
  return validator;
}

/**
 * Re-seed the synthetic stake-pool account to `totalLamports` and restart the
 * validator so the (rewritten) genesis `--account` dump is re-read.
 *
 * BEWARE, this re-genesises the ledger: stock `solana-test-validator` (agave
 * 4.2) has NO live account-write RPC — `setAccount` / `writeAccount` /
 * `setAccountInfo` / `setAccountData` all answer "Method not found" (probed
 * empirically), and `--account` dumps are silently ignored when the ledger
 * already exists. Therefore any prior chain state (market, positions,
 * balances, the mint) is gone after a patch: callers re-run `createMint(v)` +
 * `initMarket(v)` (+ their scenario setup) afterwards, or seed the value via
 * `startValidator({ indexTotalLamports })` before setup.
 *
 * Upgrade path for a truly live patch (later wave, if a test needs drift
 * without a re-genesis): deploy a minimal writer program AT the stake-pool
 * program id via `--bpf-program` and invoke it to rewrite the account bytes in
 * place — the synthetic account stays owned by the stake-pool program id, so
 * the program-side owner check still passes.
 */
export async function patchStakePool(v: Validator, totalLamports: bigint): Promise<void> {
  writeIndexSourceDump(v.internals.dumpPath, v.indexSource, totalLamports, v.indexPoolTokenSupply);
  await stopProcess(v.internals.proc);
  v.internals.proc = spawnValidatorProcess(v.internals.spawnArgs, v.internals.logPath);
  await waitForRpc(v.connection, 45_000, v.internals.logPath);
  await airdrop(v.connection, v.authority.publicKey, 120);
  v.indexTotalLamports = totalLamports;
}

// ---------------------------------------------------------------------------
// Market + collateral bootstrap (via the SDK builders)
// ---------------------------------------------------------------------------

/** Associated token account address for `mint` owned by `owner`. */
export async function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Create the SPL collateral mint (6 dp) and remember it on the validator. */
export async function createMint(v: Validator): Promise<PublicKey> {
  const out = run("spl-token", [
    "create-token",
    "--decimals",
    String(USDC_DECIMALS),
    "--config",
    v.configPath,
    "--output",
    "json",
  ]);
  const parsed = parseJson(out);
  const commandOutput = (parsed.commandOutput ?? parsed) as Record<string, unknown>;
  const address = (commandOutput.address as string) ?? (parsed.address as string) ?? (parsed.mintAddress as string);
  if (!address) throw new Error(`could not parse collateral mint from: ${out}`);
  const mint = new PublicKey(address);
  v.mint = mint;
  return mint;
}

/** Ensure `owner` has an ATA for the validator's mint and mint `micro` units to it. */
export async function fundTrader(
  v: Validator,
  owner: PublicKey,
  micro: bigint,
  label = "trader",
): Promise<PublicKey> {
  // The trader is the fee payer AND the rent payer for its `UserCollateral`
  // account on deposit, so it must hold SOL.
  await airdrop(v.connection, owner, 10);
  let ata: PublicKey | undefined;
  try {
    const out = run("spl-token", [
      "create-account",
      v.mint.toBase58(),
      "--owner",
      owner.toBase58(),
      "--config",
      v.configPath,
      "--fee-payer",
      v.authorityKeypairPath,
      "--output",
      "json",
    ]);
    const parsed = parseJson(out);
    const address = ((parsed.commandOutput ?? parsed) as Record<string, unknown>).address as string | undefined;
    if (address) ata = new PublicKey(address);
  } catch {
    /* ATA already exists; fall through to chain lookup */
  }
  if (!ata) {
    const accounts = await v.connection.getTokenAccountsByOwner(owner, { mint: v.mint });
    ata = accounts.value[0]?.pubkey;
  }
  if (!ata) throw new Error(`[fundTrader] no ${label} ATA found for ${v.mint.toBase58()}`);
  run("spl-token", [
    "mint",
    v.mint.toBase58(),
    (micro + 10n ** BigInt(USDC_DECIMALS)).toString(),
    ata.toBase58(),
    "--config",
    v.configPath,
    "--output",
    "json",
  ]);
  return ata;
}

/** Submit one instruction (sign + send + confirm) and return its signature. */
export async function submit(
  v: Validator,
  ix: TransactionInstruction,
  signers: Keypair | Keypair[],
): Promise<string> {
  const list = Array.isArray(signers) ? signers : [signers];
  const tx = new Transaction().add(ix);
  tx.feePayer = list[0].publicKey;
  const blockhash = await v.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash.blockhash;
  tx.sign(...list);
  const signature = await v.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await v.connection.confirmTransaction(
    { signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
    "confirmed",
  );
  return signature;
}

/** Initialize the perp market + order book + collateral vault. */
export async function initMarket(v: Validator, params: MarketParams = DEFAULT_MARKET): Promise<MarketEnv> {
  const market = marketPda(v.programId).address;
  const orderBook = orderBookPda(market, v.programId).address;
  const vault = vaultPda(v.programId).address;

  await submit(
    v,
    buildInitializeMarket({
      indexSource: v.indexSource,
      authority: v.authority.publicKey,
      payer: v.authority.publicKey,
      collateralMint: v.mint,
      fundingK: params.fundingK,
      maxFunding: params.maxFunding,
      fundingEpochSlots: params.fundingEpochSlots,
      initialMarginBps: params.initialMarginBps,
      maintenanceMarginBps: params.maintenanceMarginBps,
      programId: v.programId,
    }),
    v.authority,
  );

  await submit(
    v,
    buildInitializeOrderBook({
      market,
      authority: v.authority.publicKey,
      payer: v.authority.publicKey,
      programId: v.programId,
    }),
    v.authority,
  );

  await submit(
    v,
    buildInitializeCollateralVault({
      market,
      authority: v.authority.publicKey,
      payer: v.authority.publicKey,
      collateralMint: v.mint,
      programId: v.programId,
    }),
    v.authority,
  );

  return { market, orderBook, vault };
}

// ---------------------------------------------------------------------------
// Server process
// ---------------------------------------------------------------------------

async function waitForHealthz(apiUrl: string, logPath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${apiUrl}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) {
      const tail = logTail(logPath);
      throw new Error(
        `server at ${apiUrl} not healthy after ${timeoutMs}ms` + (tail ? ` — server log tail:\n${tail}` : ""),
      );
    }
    await sleep(250);
  }
}

/**
 * Boot the `fructus-server` package (child process, `tsx src/index.ts`) against
 * the validator, with a temp SQLite file, and wait for `GET /healthz`.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const rpcUrl = opts.rpcUrl ?? opts.validator?.rpcUrl ?? DEFAULT_RPC_URL;
  const port = opts.port ?? (await freePort());
  const dir = mkdtempSync(join(tmpdir(), "fructus-server-run-"));
  const dbPath = join(dir, "index.sqlite");
  const logPath = join(dir, "server.log");

  const tsx = join(SERVER_ROOT, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) {
    throw new Error(`tsx not found at ${tsx} — run \`npm install\` in server/ first`);
  }

  const logFd = openSync(logPath, "a");
  const proc = spawn(tsx, ["src/index.ts"], {
    cwd: SERVER_ROOT,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      JWT_SECRET: "harness-secret",
      RPC_URL: rpcUrl,
      FAUCET_ENABLED: "0",
      ...opts.env,
    },
  });

  const apiUrl = `http://127.0.0.1:${port}`;
  let handle: ServerHandle;
  handle = {
    apiUrl,
    port,
    dbPath,
    proc,
    async stop(): Promise<void> {
      await stopProcess(proc);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      liveServers.delete(handle);
    },
  };
  liveServers.add(handle);

  try {
    await waitForHealthz(apiUrl, logPath, 30_000);
  } catch (err) {
    await handle.stop();
    throw err;
  }
  return handle;
}
