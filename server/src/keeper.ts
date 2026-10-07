//! Keeper loop (REQ-B-6, D16): protocol-side automation. `tick()` is one
//! bounded pass — crank the event queue → settle-funding sweep → settle-close
//! sweep → liquidation sweep. Liquidation targets only accounts the state
//! layer (`server/src/state.ts`'s read model over the indexed rows) marks
//! liquidatable, one full-close action per account per tick; third-party
//! liquidation stays permissionless.
//!
//! Every sweep phase is a signed (permissionless) transaction from the keeper
//! keypair (`keypairPath`, `solana-keygen` JSON, never logged); each action is
//! recorded in `tx_log` with its outcome, and a refused/timed-out action is
//! recorded and swallowed — a failing sweep never rejects the tick.
//! `start()` is the interval wrapper (`KEEPER_INTERVAL_MS`, default 5000);
//! overlapping interval firings share one in-flight pass.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  accountLiquidatable,
  buildCrank,
  buildLiquidate,
  buildSettleClose,
  buildSettleFunding,
  decodeOrderBook,
  decodePerpMarket,
  decodePosition,
  decodeUserCollateral,
  marketPda,
  orderBookPda,
  pnl,
  positionPda,
  positionSideFromSideByte,
  userCollateralPda,
  type PerpMarketState,
  type PositionState,
} from "fructus-sdk/src/index.js";
import type { Db } from "./db.js";

/** Per-tick phase counters. */
export interface KeeperTickResult {
  cranked: number;
  settledFunding: number;
  settledClose: number;
  liquidated: number;
}

export interface Keeper {
  /** One bounded pass; safe to drive manually from tests (e2e tick driving). */
  tick(): Promise<KeeperTickResult>;
  /** Start the interval loop (idempotent). */
  start(): void;
  /** Stop the interval loop (idempotent). */
  stop(): void;
}

export interface KeeperOptions {
  connection: Connection;
  db: Db;
  programId: PublicKey;
  /** Loop period, ms (KEEPER_INTERVAL_MS). */
  intervalMs: number;
  /**
   * Keeper keypair path (`solana-keygen` JSON array; never logged). The keeper
   * signs every sweep transaction with it; `null` ⇒ ticks are inert (the
   * configured deployment owns the key).
   */
  keypairPath: string | null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One live side of an account's state-layer read model. */
interface LivePosition {
  /** Position PDA (base58), from the indexed row. */
  pubkey: string;
  state: PositionState;
}

/** One account-level liquidation candidate (state-layer decision). */
interface LiquidationTarget {
  owner: PublicKey;
  /** The live side to fully close (largest notional when both sides are live). */
  position: LivePosition;
}

export function createKeeper(opts: KeeperOptions): Keeper {
  const { connection, db, programId } = opts;
  const market = marketPda(programId).address;
  const orderBook = orderBookPda(market, programId).address;

  // Keeper hot key, loaded lazily once (never logged).
  let signer: Keypair | null = null;
  let signerLoaded = false;
  function loadSigner(): Keypair | null {
    if (signerLoaded) return signer;
    signerLoaded = true;
    const path = opts.keypairPath;
    if (path === null || path === "") return null;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!Array.isArray(raw)) throw new Error("keypair file is not a JSON array");
      signer = Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
    } catch (err) {
      console.error(`fructus-server: keeper keypair unavailable: ${describe(err)}`);
      signer = null;
    }
    return signer;
  }

  // Strictly increasing `tx_log.created_at` (same rationale as the operator).
  let lastCreatedAt = 0;
  function nextCreatedAt(): number {
    const now = Date.now();
    lastCreatedAt = now > lastCreatedAt ? now : lastCreatedAt + 1;
    return lastCreatedAt;
  }

  function decodeRow<T>(row: { data: Uint8Array } | null, decode: (data: Buffer) => T | null): T | null {
    return row === null ? null : decode(Buffer.from(row.data));
  }

  /** Market state: the indexed row when present, else a direct RPC read. */
  async function loadMarket(): Promise<PerpMarketState | null> {
    const indexed = decodeRow(db.getAccount("market", market.toBase58()), decodePerpMarket);
    if (indexed !== null) return indexed;
    const info = await connection.getAccountInfo(market, "confirmed");
    return info === null ? null : decodePerpMarket(info.data);
  }

  /** All indexed live Position rows of this market. */
  function readPositions(): LivePosition[] {
    const out: LivePosition[] = [];
    for (const row of db.listAccounts("position")) {
      const state = decodePosition(Buffer.from(row.data));
      if (state === null || !state.market.equals(market)) continue;
      out.push({ pubkey: row.pubkey, state });
    }
    return out;
  }

  /**
   * Sign + send + confirm one keeper instruction. Returns the signature, or
   * throws (the caller records the attempt).
   */
  async function send(instruction: TransactionInstruction, kp: Keypair): Promise<string> {
    const tx = new Transaction().add(instruction);
    tx.feePayer = kp.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(kp);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    return signature;
  }

  /** Run one sweep action and record its `tx_log` row; never throws. */
  async function sweepAction(
    kind: string,
    wallet: string,
    instruction: TransactionInstruction,
    kp: Keypair,
  ): Promise<boolean> {
    const id = randomUUID();
    db.insertTxLog({
      id,
      wallet,
      kind,
      status: "sent",
      signature: null,
      error: null,
      createdAt: nextCreatedAt(),
    });
    try {
      const signature = await send(instruction, kp);
      db.updateTxLog(id, { status: "confirmed", signature });
      return true;
    } catch (err) {
      db.updateTxLog(id, { status: "failed", error: describe(err) });
      return false;
    }
  }

  /** True when the on-chain book has drained events (cheap read; errors ⇒ skip). */
  async function eventsPending(): Promise<boolean> {
    try {
      const info = await connection.getAccountInfo(orderBook, "confirmed");
      if (info === null) return false;
      const book = decodeOrderBook(info.data);
      if (book === null) return false;
      return book.eventReadCursor < book.eventWriteCursor;
    } catch {
      return false;
    }
  }

  /**
   * The state-layer liquidation sweep (REQ-B-6): group the indexed live
   * positions by account, evaluate the account-level predicate
   * (`accountLiquidatable` over `deposited + Σ upnl` vs the both-side
   * maintenance requirement — the `state.ts` read model) and return one full
   * liquidation target per under-margin account.
   */
  function liquidationTargets(
    positions: LivePosition[],
    state: PerpMarketState,
  ): LiquidationTarget[] {
    const byOwner = new Map<string, { owner: PublicKey; rows: LivePosition[] }>();
    for (const position of positions) {
      if (position.state.notional === 0n) continue; // no live exposure
      const owner = position.state.owner.toBase58();
      const entry = byOwner.get(owner) ?? { owner: position.state.owner, rows: [] };
      entry.rows.push(position);
      byOwner.set(owner, entry);
    }

    const targets: LiquidationTarget[] = [];
    for (const { owner, rows } of byOwner.values()) {
      const collateral = decodeRow(
        db.getAccount(
          "user_collateral",
          userCollateralPda(market, owner, programId).address.toBase58(),
        ),
        decodeUserCollateral,
      );
      if (collateral === null) continue; // no ledger to release into — never target

      let pnlSum = 0n;
      let notionalLong = 0n;
      let notionalShort = 0n;
      let best: LivePosition | null = null;
      for (const row of rows) {
        const side = positionSideFromSideByte(row.state.side);
        if (side === null) continue;
        pnlSum +=
          pnl(
            row.state.entryN,
            row.state.entryD,
            state.indexN,
            state.indexD,
            row.state.notional,
            side,
          ) ?? 0n;
        if (row.state.side === 0) notionalLong += row.state.notional;
        else notionalShort += row.state.notional;
        if (best === null || row.state.notional > best.state.notional) best = row;
      }
      if (best === null) continue;

      if (
        accountLiquidatable(
          collateral.deposited,
          pnlSum,
          notionalLong,
          notionalShort,
          state.maintenanceMarginBps,
        )
      ) {
        targets.push({ owner, position: best });
      }
    }
    return targets;
  }

  async function tick(): Promise<KeeperTickResult> {
    const result: KeeperTickResult = { cranked: 0, settledFunding: 0, settledClose: 0, liquidated: 0 };
    const kp = loadSigner();
    if (kp === null) return result;
    const state = await loadMarket();
    if (state === null) return result;
    const indexSource = state.indexSource;
    const positions = readPositions();

    // 1. Crank the event queue (only when events are pending).
    if (await eventsPending()) {
      const crank = buildCrank({ market, indexSource, cranker: kp.publicKey, programId });
      if (await sweepAction("crank", kp.publicKey.toBase58(), crank, kp)) result.cranked += 1;
    }

    // 2. Settle-funding sweep: every live position's elapsed epochs.
    for (const position of positions) {
      if (position.state.notional === 0n) continue;
      const instruction = buildSettleFunding({
        market,
        position: new PublicKey(position.pubkey),
        userCollateral: userCollateralPda(market, position.state.owner, programId).address,
        indexSource,
        programId,
      });
      if (await sweepAction("settle_funding", position.state.owner.toBase58(), instruction, kp)) {
        result.settledFunding += 1;
      }
    }

    // 3. Settle-close sweep: positions carrying an unsettled closed notional.
    for (const position of positions) {
      if (position.state.closedNotional === 0n) continue;
      const instruction = buildSettleClose({
        market,
        position: new PublicKey(position.pubkey),
        userCollateral: userCollateralPda(market, position.state.owner, programId).address,
        indexSource,
        programId,
      });
      if (await sweepAction("settle_close", position.state.owner.toBase58(), instruction, kp)) {
        result.settledClose += 1;
      }
    }

    // 4. Liquidation sweep: one full-close action per under-margin account.
    for (const target of liquidationTargets(positions, state)) {
      const { position, owner } = target;
      const otherSide = position.state.side === 0 ? 1 : 0;
      const instruction = buildLiquidate({
        market,
        position: new PublicKey(position.pubkey),
        otherPosition: positionPda(market, owner, otherSide, programId).address,
        userCollateral: userCollateralPda(market, owner, programId).address,
        indexSource,
        liquidator: kp.publicKey,
        side: position.state.side,
        amount: position.state.notional,
        programId,
      });
      if (await sweepAction("liquidate", owner.toBase58(), instruction, kp)) {
        result.liquidated += 1;
      }
    }

    return result;
  }

  // One in-flight pass at a time (rate limit): overlapping firings share it.
  let inFlight: Promise<KeeperTickResult> | null = null;
  async function runTick(): Promise<KeeperTickResult> {
    if (inFlight !== null) return inFlight;
    inFlight = tick().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  let timer: NodeJS.Timeout | null = null;

  return {
    tick: runTick,

    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void runTick().catch((err: unknown) => {
          console.error(`fructus-server: keeper tick failed: ${describe(err)}`);
        });
      }, opts.intervalMs);
      timer.unref();
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
