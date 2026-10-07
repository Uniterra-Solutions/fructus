//! Keeper loop (REQ-B-6, D16): protocol-side automation. `tick()` is one
//! bounded pass — crank the event queue → settle-funding sweep → settle-close
//! sweep → liquidation sweep (account-level trigger, one action per account per
//! tick; third-party liquidation stays permissionless). `start()` is the
//! interval wrapper (`KEEPER_INTERVAL_MS`, default 5000). STUB: `tick()`
//! reports zeroes until the action wave lands.

import type { Connection, PublicKey } from "@solana/web3.js";
import type { Db } from "./db.js";

/** Per-tick phase counters (all zero until the pass is implemented). */
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
}

export function createKeeper(opts: KeeperOptions): Keeper {
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<KeeperTickResult> => {
    // STUB (REQ-B-6): crank → settle_funding sweep → settle_close sweep →
    // liquidation sweep, targeting only accounts the state layer marks
    // liquidatable, one action per account per tick, each with a `tx_log` row.
    // Bounded + rate-limited + idempotent.
    void opts;
    return { cranked: 0, settledFunding: 0, settledClose: 0, liquidated: 0 };
  };

  return {
    tick,

    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void tick();
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
