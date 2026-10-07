//! Faucet (D15, REQ-B-8): devnet-only test-USDC mint endpoint. Disabled — and
//! answering 404 — unless `FAUCET_ENABLED=1` and both the mint and the mint
//! authority keypair are configured. Accepted calls mint exactly one
//! `faucetDrip` into the wallet's canonical ATA, guarded by a per-wallet and a
//! global 24 h cap tracked in SQLite; over-cap requests are rejected before any
//! on-chain effect (no ATA is created, nothing is minted).

import { readFileSync } from "node:fs";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "fructus-sdk/src/index.js";
import type { FaucetRequest, FaucetResponse } from "fructus-sdk/src/api.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { BadRequestError, FaucetCapError, FaucetDisabledError } from "./errors.js";

/** Cap window: 24 h (REQ-B-8). */
export const FAUCET_WINDOW_MS = 24 * 60 * 60_000;

/** SPL `TokenInstruction::MintTo` discriminator. */
const TOKEN_IX_MINT_TO = 7;
/** SPL associated-token `Create` discriminator. */
const ATA_IX_CREATE = 0;

export interface Faucet {
  handle(req: FaucetRequest): Promise<FaucetResponse>;
}

export interface FaucetOptions {
  config: Config;
  connection: Connection;
  /** Drip ledger for the 24 h caps (REQ-B-8). */
  db: Db;
}

/** The canonical associated token account for `(mint, owner)`. */
function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Hand-built SPL associated-token `Create` (no spl-token JS dependency). */
function createAtaInstruction(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([ATA_IX_CREATE]),
  });
}

/** Hand-built SPL `MintTo`: data `[7][amount u64 LE]`, accounts `[mint, to, authority]`. */
function mintToInstruction(mint: PublicKey, ata: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(TOKEN_IX_MINT_TO, 0);
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export function createFaucet(opts: FaucetOptions): Faucet {
  const { config, connection, db } = opts;

  // One mint authority per process, loaded lazily from the configured path.
  let authority: Keypair | null = null;
  function loadAuthority(path: string): Keypair {
    if (authority !== null) return authority;
    const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
    authority = Keypair.fromSecretKey(Uint8Array.from(raw));
    return authority;
  }

  // Serialize requests: cap checks and the drip ledger must not race.
  let tail: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function drip(req: FaucetRequest): Promise<FaucetResponse> {
    const { faucetMint, faucetMintAuthorityKeypair } = config;
    if (!config.faucetEnabled || faucetMint === null || faucetMintAuthorityKeypair === null) {
      throw new FaucetDisabledError(); // -> 404, D15
    }

    const walletRaw = req?.wallet;
    if (typeof walletRaw !== "string" || walletRaw.length === 0) {
      throw new BadRequestError("wallet is required");
    }
    let wallet: PublicKey;
    try {
      wallet = new PublicKey(walletRaw);
    } catch {
      throw new BadRequestError("wallet must be a base58 public key");
    }

    let mint: PublicKey;
    try {
      mint = new PublicKey(faucetMint);
    } catch {
      throw new FaucetDisabledError(); // unusable configuration, fail closed
    }
    const minter = loadAuthority(faucetMintAuthorityKeypair);
    const dripAmount = config.faucetDrip;

    // 24 h caps: reject whenever this drip would push either budget over.
    const since = Date.now() - FAUCET_WINDOW_MS;
    const walletSpent = db.sumFaucetCredits({ wallet: walletRaw, since });
    if (walletSpent + dripAmount > config.faucetPerWalletCap) {
      throw new FaucetCapError("per-wallet", walletSpent, dripAmount, config.faucetPerWalletCap);
    }
    const globalSpent = db.sumFaucetCredits({ since });
    if (globalSpent + dripAmount > config.faucetGlobalCap) {
      throw new FaucetCapError("global", globalSpent, dripAmount, config.faucetGlobalCap);
    }

    // Create the ATA when missing and mint the drip in ONE transaction, so an
    // accepted request moves exactly `dripAmount` (once) or nothing.
    const ata = associatedTokenAddress(mint, wallet);
    const tx = new Transaction();
    if ((await connection.getAccountInfo(ata)) === null) {
      tx.add(createAtaInstruction(minter.publicKey, ata, wallet, mint));
    }
    tx.add(mintToInstruction(mint, ata, minter.publicKey, dripAmount));
    tx.feePayer = minter.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(minter);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

    // Credit the ledger only after the drip landed (exactly-once crediting).
    db.insertFaucetCredit(walletRaw, dripAmount, Date.now());

    return { amount: dripAmount.toString(), ata: ata.toBase58() };
  }

  return {
    handle(req: FaucetRequest): Promise<FaucetResponse> {
      return serialized(() => drip(req));
    },
  };
}
