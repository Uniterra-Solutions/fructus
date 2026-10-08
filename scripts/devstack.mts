//! Local devstack (product-v3 REQ-V-1): a self-contained, long-running local
//! chain bootstrap — validator + market init + collateral mint + funded keys +
//! printed env blocks for the server and the MM bot.
//!
//! `npm run devstack` (or `npx tsx devstack.mts`):
//!   1. boots `solana-test-validator` with the genesis-loaded
//!      `target/deploy/fructus.so` and a synthetic stake-pool `index_source`
//!      (the `server/test/harness.ts` seeding: account_type byte 1,
//!      total_lamports/pool_token_supply at offsets 258/266);
//!   2. fresh ledger under `scripts/.devstack/<timestamp>/`;
//!   3. generates `authority` / `operator` / `mm` keypairs under
//!      `scripts/.devstack/keys/` (the authority is the funded payer, the
//!      market-init authority, and the self-owned mint authority);
//!   4. creates the 6-dp collateral mint (spl-token), initializes the market /
//!      order book / vault (SDK builders, authority pays);
//!   5. mints tUSDC to the operator + mm ATAs (plus SOL for fees);
//!   6. prints copy-paste env blocks (see `formatEnvBlocks`) and keeps running
//!      until SIGINT/SIGTERM, which stops the validator.
//!
//! `npx tsx devstack.mts --check`: validates the toolchain + planned values and
//! exits 0 — nothing is booted or written.
//!
//! Every step failure exits non-zero with a clear message. This file is
//! deliberately standalone: it imports only the SDK + @solana/web3.js, never
//! `server/test/`.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  PROGRAM_ID,
  STAKE_POOL_PROGRAM_ID,
  USDC_DECIMALS,
  buildInitializeCollateralVault,
  buildInitializeMarket,
  buildInitializeOrderBook,
  marketPda,
  orderBookPda,
  vaultPda,
} from "fructus-sdk/src/index.js";

// ---------------------------------------------------------------------------
// Constants (mirror server/test/harness.ts — keep in sync, do not import it)
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");
const DEFAULT_SO_PATH = join(REPO_ROOT, "target", "deploy", "fructus.so");
const DEVSTACK_ROOT = join(here, ".devstack");
const KEYS_DIR = join(DEVSTACK_ROOT, "keys");
const DEFAULT_RPC_PORT = 8899;

const TOOLS = ["solana-test-validator", "solana", "spl-token"] as const;

/** Market parameters — mirror of the harness `DEFAULT_MARKET`. */
const DEFAULT_MARKET = {
  fundingK: 100_000n,
  maxFunding: 10_000n,
  fundingEpochSlots: 1_000n,
  initialMarginBps: 1_000, // 10x
  maintenanceMarginBps: 500,
};

// Synthetic stake-pool `index_source` values (harness defaults).
const INDEX_TOTAL_LAMPORTS = 12_000_000_000n; // ~12 SOL
const INDEX_POOL_TOKEN_SUPPLY = 10_000_000_000n;

const AUTHORITY_SOL = 120;
const WALLET_SOL = 10;
/** tUSDC minted to each funded wallet (raw 6-dp microunits). */
const WALLET_TUSDC = 100_000_000_000n; // 100,000 tUSDC

// ---------------------------------------------------------------------------
// Env-block printer (pure; pinned by scripts/test/devstack-env.test.ts)
// ---------------------------------------------------------------------------

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
export function formatEnvBlocks(values: DevstackValues): string {
  return [
    "# ---- fructus-server (cd server && npm start) -------------------------------",
    `RPC_URL=${values.rpcUrl}`,
    `DATABASE_PATH=${values.databasePath}`,
    `JWT_SECRET=${values.jwtSecret}`,
    `OPERATOR_KEYPAIR=${values.operatorKeypair}`,
    "PORT=8787",
    "FAUCET_ENABLED=1",
    `FAUCET_MINT=${values.faucetMint}`,
    `FAUCET_MINT_AUTHORITY_KEYPAIR=${values.faucetMintAuthority}`,
    "",
    "# ---- mm-bot (cd scripts && npm run mm) -------------------------------------",
    `RPC_URL=${values.rpcUrl}`,
    `MM_KEYPAIR=${values.mmKeypair}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Small helpers
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
 * RPC URL for the validator: port 8899 when free (the repo-wide default), else
 * an ephemeral port whose derived port block (gossip/faucet/dynamic,
 * +1000..+3100) still fits in u16.
 */
async function pickRpcUrl(): Promise<string> {
  if (await portIsFree(DEFAULT_RPC_PORT)) return `http://127.0.0.1:${DEFAULT_RPC_PORT}`;
  let port = await freePort();
  while (port + 3_100 > 65_535) port = await freePort();
  return `http://127.0.0.1:${port}`;
}

function portOf(rpcUrl: string): number {
  const match = rpcUrl.match(/:(\d+)/);
  if (!match) throw new Error(`cannot parse port from RPC URL: ${rpcUrl}`);
  return Number(match[1]);
}

/** Run a CLI tool synchronously, throwing a clear error on a non-zero exit. */
function run(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: "utf-8" });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().slice(0, 400);
    throw new Error(`${cmd} ${args.join(" ")} failed (${result.status}): ${detail}`);
  }
  return result.stdout;
}

function parseJson(out: string): Record<string, unknown> {
  const match = out.match(/\{.*\}/s);
  if (!match) throw new Error(`no JSON in output: ${out.slice(0, 200)}`);
  return JSON.parse(match[0]) as Record<string, unknown>;
}

/** Whether a CLI tool is on PATH and responds to `--version`. */
function hasCmd(cmd: string): boolean {
  const result = spawnSync(cmd, ["--version"], { encoding: "utf-8" });
  return !result.error && result.status === 0;
}

/** Fresh per-boot directory name (filesystem-safe ISO timestamp). */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeKeypair(path: string, keypair: Keypair): void {
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
}

/**
 * Genesis account-dump JSON for the synthetic stake-pool `index_source`
 * (mirrors the harness): the program reads `account_type` byte 0 == 1 and the
 * u64 LE `total_lamports`/`pool_token_supply` at offsets 258/266.
 */
function writeIndexSourceDump(
  path: string,
  pubkey: PublicKey,
  totalLamports: bigint,
  poolTokenSupply: bigint,
): void {
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

// ---------------------------------------------------------------------------
// Process + RPC helpers
// ---------------------------------------------------------------------------

function killGroup(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, "SIGKILL"); // the process group
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
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
        const tail = logPath !== undefined && existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
        throw new Error(
          `validator RPC ${connection.rpcEndpoint} not ready after ${timeoutMs}ms` +
            (tail ? ` — validator log tail:\n${tail.trim().split("\n").slice(-6).join("\n")}` : ""),
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

/** Submit one instruction (sign + send + confirm) and return its signature. */
async function submit(
  connection: Connection,
  instruction: TransactionInstruction,
  signers: Keypair | Keypair[],
): Promise<string> {
  const list = Array.isArray(signers) ? signers : [signers];
  const tx = new Transaction().add(instruction);
  tx.feePayer = list[0].publicKey;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash.blockhash;
  tx.sign(...list);
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

// ---------------------------------------------------------------------------
// SPL collateral mint + wallet funding (via the `spl-token` CLI)
// ---------------------------------------------------------------------------

/** Create the self-owned 6-dp collateral mint (authority = the CLI config keypair). */
function createMint(configPath: string): PublicKey {
  const out = run("spl-token", [
    "create-token",
    "--decimals",
    String(USDC_DECIMALS),
    "--config",
    configPath,
    "--output",
    "json",
  ]);
  const parsed = parseJson(out);
  const commandOutput = (parsed.commandOutput ?? parsed) as Record<string, unknown>;
  const address =
    (commandOutput.address as string | undefined) ??
    (parsed.address as string | undefined) ??
    (parsed.mintAddress as string | undefined);
  if (!address) throw new Error(`could not parse collateral mint from: ${out.slice(0, 400)}`);
  return new PublicKey(address);
}

/** Create (or look up) `owner`'s ATA for the devstack mint. */
async function ensureAta(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
  authorityPath: string,
  configPath: string,
  label: string,
): Promise<PublicKey> {
  let ata: PublicKey | null = null;
  try {
    const out = run("spl-token", [
      "create-account",
      mint.toBase58(),
      "--owner",
      owner.toBase58(),
      "--config",
      configPath,
      "--fee-payer",
      authorityPath,
      "--output",
      "json",
    ]);
    const parsed = parseJson(out);
    const address = ((parsed.commandOutput ?? parsed) as Record<string, unknown>).address as
      | string
      | undefined;
    if (address) ata = new PublicKey(address);
  } catch {
    /* ATA already exists; fall through to the chain lookup */
  }
  if (ata === null) {
    const accounts = await connection.getTokenAccountsByOwner(owner, { mint });
    ata = accounts.value[0]?.pubkey ?? null;
  }
  if (ata === null) throw new Error(`no ${label} ATA found for mint ${mint.toBase58()}`);
  return ata;
}

/** Mint `amount` raw microunits of `mint` to `ata` (mint authority = CLI config keypair). */
function mintTo(mint: PublicKey, ata: PublicKey, amount: bigint, configPath: string): void {
  run("spl-token", [
    "mint",
    mint.toBase58(),
    amount.toString(),
    ata.toBase58(),
    "--config",
    configPath,
    "--output",
    "json",
  ]);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/** `--check`: validate the toolchain + print planned values; nothing booted/written. */
async function checkMode(): Promise<number> {
  console.log("devstack --check: validating tools + planned values (no boot, nothing written)");

  const toolStatus = TOOLS.map((tool) => ({ tool, ok: hasCmd(tool) }));
  for (const { tool, ok } of toolStatus) {
    console.log(`  tool ${tool}: ${ok ? "ok" : "MISSING"}`);
  }
  const missingTools = toolStatus.filter((t) => !t.ok).map((t) => t.tool);

  const soPath = process.env.FRUCTUS_SO_PATH ?? DEFAULT_SO_PATH;
  const soOk = existsSync(soPath);
  console.log(`  program .so: ${soPath} (${soOk ? "ok" : "MISSING"})`);

  if (missingTools.length > 0 || !soOk) {
    const problems: string[] = [];
    if (missingTools.length > 0) problems.push(`missing tools on PATH: ${missingTools.join(", ")}`);
    if (!soOk) problems.push("program .so missing — build with `anchor build` or set FRUCTUS_SO_PATH");
    console.error(`devstack --check: FAILED — ${problems.join("; ")}`);
    return 1;
  }

  const rpcUrl = await pickRpcUrl();
  const runDir = join(DEVSTACK_ROOT, timestamp());
  const market = marketPda().address;
  console.log("devstack --check: planned values");
  console.log(`  rpcUrl:      ${rpcUrl}`);
  console.log(`  run dir:     ${runDir}`);
  console.log(`  ledger:      ${join(runDir, "ledger")}`);
  console.log(`  database:    ${join(runDir, "devstack.sqlite")}`);
  console.log(`  keys:        ${join(KEYS_DIR, "authority.keypair.json")} (payer + mint authority)`);
  console.log(`               ${join(KEYS_DIR, "operator.keypair.json")}`);
  console.log(`               ${join(KEYS_DIR, "mm.keypair.json")}`);
  console.log(`  programId:   ${PROGRAM_ID.toBase58()}`);
  console.log(`  market PDA:  ${market.toBase58()}`);
  console.log(`  book PDA:    ${orderBookPda(market).address.toBase58()}`);
  console.log(`  vault PDA:   ${vaultPda().address.toBase58()}`);
  console.log("  faucetMint:  (created at boot)   jwtSecret: (generated at boot)");
  return 0;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let validatorProc: ChildProcess | null = null;
let shuttingDown = false;

/** SIGTERM the validator's process group, escalating to SIGKILL after 2 s. */
async function stopValidator(): Promise<void> {
  const proc = validatorProc;
  if (proc === null || proc.pid === undefined) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const pid = proc.pid;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const sigkill = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 2_000);
  await Promise.race([exited, sleep(3_000)]);
  clearTimeout(sigkill);
}

async function boot(): Promise<void> {
  const missingTools = TOOLS.filter((tool) => !hasCmd(tool));
  if (missingTools.length > 0) {
    throw new Error(`missing tools on PATH: ${missingTools.join(", ")}`);
  }

  const soPath = process.env.FRUCTUS_SO_PATH ?? DEFAULT_SO_PATH;
  if (!existsSync(soPath)) {
    throw new Error(`program .so not found: ${soPath} — build with \`anchor build\` or set FRUCTUS_SO_PATH`);
  }

  // Fresh per-boot fixture dir + the shared keys dir.
  const runDir = join(DEVSTACK_ROOT, timestamp());
  const ledgerDir = join(runDir, "ledger");
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(KEYS_DIR, { recursive: true });

  const rpcUrl = await pickRpcUrl();
  const connection = new Connection(rpcUrl, "confirmed");

  // 1. Keypairs: funded authority (payer / market authority / mint authority),
  //    the server operator, and the MM bot.
  const authority = Keypair.generate();
  const operator = Keypair.generate();
  const mm = Keypair.generate();
  const authorityPath = join(KEYS_DIR, "authority.keypair.json");
  const operatorPath = join(KEYS_DIR, "operator.keypair.json");
  const mmPath = join(KEYS_DIR, "mm.keypair.json");
  writeKeypair(authorityPath, authority);
  writeKeypair(operatorPath, operator);
  writeKeypair(mmPath, mm);

  // 2. Synthetic stake-pool `index_source`, loaded at genesis.
  const indexSource = Keypair.generate().publicKey;
  const dumpPath = join(runDir, "index-source.json");
  writeIndexSourceDump(dumpPath, indexSource, INDEX_TOTAL_LAMPORTS, INDEX_POOL_TOKEN_SUPPLY);

  // 3. Validator (port block derived from the RPC port, like the harness).
  const configPath = writeSolanaConfig(runDir, rpcUrl, authorityPath);
  const logPath = join(runDir, "validator.log");
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
    PROGRAM_ID.toBase58(),
    soPath,
    "--account",
    indexSource.toBase58(),
    dumpPath,
  ];
  validatorProc = spawnValidatorProcess(spawnArgs, logPath);
  console.log(`[devstack] validator up on ${rpcUrl} (pid ${validatorProc.pid}, log ${logPath})`);
  validatorProc.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `[devstack] validator exited unexpectedly (code=${code}, signal=${signal}) — see ${logPath}`,
      );
      process.exit(1);
    }
  });
  await waitForRpc(connection, 45_000, logPath);
  await airdrop(connection, authority.publicKey, AUTHORITY_SOL);
  console.log(`[devstack] authority ${authority.publicKey.toBase58()} funded (${AUTHORITY_SOL} SOL)`);

  // 4. Collateral mint (self-owned, 6 dp).
  const mint = createMint(configPath);
  console.log(`[devstack] collateral mint ${mint.toBase58()} (${USDC_DECIMALS} dp)`);

  // 5. Market + order book + collateral vault (authority pays).
  const market = marketPda().address;
  const orderBook = orderBookPda(market).address;
  const vault = vaultPda().address;
  await submit(
    connection,
    buildInitializeMarket({
      indexSource,
      authority: authority.publicKey,
      payer: authority.publicKey,
      collateralMint: mint,
      fundingK: DEFAULT_MARKET.fundingK,
      maxFunding: DEFAULT_MARKET.maxFunding,
      fundingEpochSlots: DEFAULT_MARKET.fundingEpochSlots,
      initialMarginBps: DEFAULT_MARKET.initialMarginBps,
      maintenanceMarginBps: DEFAULT_MARKET.maintenanceMarginBps,
      programId: PROGRAM_ID,
    }),
    authority,
  );
  await submit(
    connection,
    buildInitializeOrderBook({
      market,
      authority: authority.publicKey,
      payer: authority.publicKey,
      programId: PROGRAM_ID,
    }),
    authority,
  );
  await submit(
    connection,
    buildInitializeCollateralVault({
      market,
      authority: authority.publicKey,
      payer: authority.publicKey,
      collateralMint: mint,
      programId: PROGRAM_ID,
    }),
    authority,
  );
  console.log(
    `[devstack] market ${market.toBase58()} book ${orderBook.toBase58()} vault ${vault.toBase58()}`,
  );

  // 6. Funded wallets: operator + mm (SOL for fees; tUSDC to their ATAs).
  const wallets: [string, Keypair][] = [
    ["operator", operator],
    ["mm", mm],
  ];
  for (const [label, keypair] of wallets) {
    await airdrop(connection, keypair.publicKey, WALLET_SOL);
    const ata = await ensureAta(connection, mint, keypair.publicKey, authorityPath, configPath, label);
    mintTo(mint, ata, WALLET_TUSDC, configPath);
    console.log(
      `[devstack] ${label} ${keypair.publicKey.toBase58()} funded: ${WALLET_SOL} SOL + ${WALLET_TUSDC} tUSDC → ${ata.toBase58()}`,
    );
  }

  // 7. Print the copy-paste env blocks, then keep running until a signal.
  const values: DevstackValues = {
    rpcUrl,
    databasePath: join(runDir, "devstack.sqlite"),
    jwtSecret: `devstack-${randomBytes(24).toString("hex")}`,
    operatorKeypair: operatorPath,
    faucetMint: mint.toBase58(),
    faucetMintAuthority: authorityPath,
    mmKeypair: mmPath,
  };

  console.log("");
  console.log("[devstack] ready — copy-paste env for the server and the MM bot:");
  console.log("");
  console.log(formatEnvBlocks(values));
  console.log(`# validator log: ${logPath}`);
  console.log(`# index source:  ${indexSource.toBase58()} (synthetic stake pool)`);
  console.log("# devstack is running — Ctrl-C stops the validator");
  console.log("");

  await new Promise<void>(() => {
    /* stay alive until SIGINT/SIGTERM */
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`devstack: unknown argument(s): ${unknown.join(" ")} (supported: --check)`);
    process.exitCode = 2;
    return;
  }

  if (args.includes("--check")) {
    process.exitCode = await checkMode();
    return;
  }

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[devstack] ${signal} — stopping validator…`);
    void (async () => {
      await stopValidator();
      process.exit(0);
    })();
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  try {
    await boot();
  } catch (err) {
    console.error(`[devstack] failed: ${err instanceof Error ? err.message : String(err)}`);
    shuttingDown = true;
    await stopValidator();
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
