//! Server configuration (D11, REQ-B-1): every knob is an env var, parsed once
//! at boot. `.env.example` documents the same set for humans.

export interface Config {
  /** Solana RPC endpoint (HTTP). */
  rpcUrl: string;
  /** SQLite file backing the indexed state (`node:sqlite`). */
  databasePath: string;
  /** HS256 session-JWT secret (REQ-B-4). Required — boot fails without it. */
  jwtSecret: string;
  /** Operator keypair path; `null` when unset (operator actions unavailable). */
  operatorKeypairPath: string | null;
  /** HTTP listen port. */
  port: number;
  /** Keeper loop period, ms (REQ-B-6). */
  keeperIntervalMs: number;
  /** Faucet enabled flag (D15, REQ-B-8). */
  faucetEnabled: boolean;
  /** Faucet tUSDC mint (base58); `null` when unset. */
  faucetMint: string | null;
  /** Faucet mint-authority keypair path; `null` when unset. */
  faucetMintAuthorityKeypair: string | null;
  /** Per-wallet 24 h cap, raw microunits. */
  faucetPerWalletCap: bigint;
  /** Global 24 h cap, raw microunits. */
  faucetGlobalCap: bigint;
  /** Per-request mint amount (raw microunits); the caps calibrate against it. */
  faucetDrip: bigint;
}

export const DEFAULT_RPC_URL = "http://127.0.0.1:8899";
export const DEFAULT_DATABASE_PATH = "./fructus-server.sqlite";
export const DEFAULT_PORT = 8787;
export const DEFAULT_KEEPER_INTERVAL_MS = 5_000;
/** 10,000 tUSDC (6 dp) — REQ-B-8 per-wallet 24 h cap. */
export const DEFAULT_FAUCET_PER_WALLET_CAP = 10_000_000_000n;
/** 1,000,000 tUSDC (6 dp) — global 24 h cap when the env does not say otherwise. */
export const DEFAULT_FAUCET_GLOBAL_CAP = 1_000_000_000_000n;
/** 10 tUSDC (6 dp) — per-request faucet drip when `FAUCET_DRIP` is unset. */
export const DEFAULT_FAUCET_DRIP = 10_000_000n;

function optional(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return value === undefined || value === "" ? null : value;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = optional(env, key);
  if (value === null) throw new Error(`loadConfig: missing required env var ${key}`);
  return value;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = optional(env, key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`loadConfig: ${key} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function bigintEnv(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  const raw = optional(env, key);
  if (raw === null) return fallback;
  try {
    const value = BigInt(raw);
    if (value < 0n) throw new Error("negative");
    return value;
  } catch {
    throw new Error(`loadConfig: ${key} must be a non-negative integer string, got ${JSON.stringify(raw)}`);
  }
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
  const raw = optional(env, key);
  if (raw === null) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Parse the process environment into the server `Config` (throws on invalid input). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    rpcUrl: optional(env, "RPC_URL") ?? DEFAULT_RPC_URL,
    databasePath: optional(env, "DATABASE_PATH") ?? DEFAULT_DATABASE_PATH,
    jwtSecret: required(env, "JWT_SECRET"),
    operatorKeypairPath: optional(env, "OPERATOR_KEYPAIR"),
    port: intEnv(env, "PORT", DEFAULT_PORT),
    keeperIntervalMs: intEnv(env, "KEEPER_INTERVAL_MS", DEFAULT_KEEPER_INTERVAL_MS),
    faucetEnabled: boolEnv(env, "FAUCET_ENABLED"),
    faucetMint: optional(env, "FAUCET_MINT"),
    faucetMintAuthorityKeypair: optional(env, "FAUCET_MINT_AUTHORITY_KEYPAIR"),
    faucetPerWalletCap: bigintEnv(env, "FAUCET_PER_WALLET_CAP", DEFAULT_FAUCET_PER_WALLET_CAP),
    faucetGlobalCap: bigintEnv(env, "FAUCET_GLOBAL_CAP", DEFAULT_FAUCET_GLOBAL_CAP),
    faucetDrip: bigintEnv(env, "FAUCET_DRIP", DEFAULT_FAUCET_DRIP),
  };
}
