//! Server-side state reads (REQ-B-3): the portfolio / market / book read models
//! computed from the indexed rows via the SDK mirrors (`fructus-sdk`). STUBS
//! return the zero DTOs so downstream layers (API, keeper, WS) can be wired and
//! typed today; the real fold lands in a later wave.

import type { PublicKey } from "@solana/web3.js";
import type { BookView, MarketView, UserPortfolio } from "fructus-sdk/src/api.js";
import type { Db } from "./db.js";

/**
 * Per-user portfolio (REQ-B-3): `deposited/reserved/claimable/free`, per-side
 * `notional/upnl/reqInitial/reqMaint`, `equity` vs `requirementInitial` /
 * `requirementMaint`, and `health` from the account-level predicate
 * (`accountLiquidatable` mirror, REQ-A2-1 / STATE-HEALTH-MATCHES-PROGRAM-TRIGGER).
 */
export function computePortfolio(db: Db, wallet: PublicKey, market: PublicKey): UserPortfolio {
  // STUB: fold `user_collateral` + both `position` rows + the `operator`
  // record through the SDK margin/upnl mirrors.
  void db;
  void market;
  return {
    wallet: wallet.toBase58(),
    deposited: "0",
    reserved: "0",
    claimable: "0",
    free: "0",
    equity: "0",
    requirementInitial: "0",
    requirementMaint: "0",
    health: "healthy",
    operator: null,
    positions: [],
  };
}

/** Market snapshot (REQ-B-3): mark/mid, index, funding accumulator, best bid/ask. */
export function computeMarket(db: Db, market: PublicKey): MarketView {
  // STUB: decode the `market` + `order_book` rows; mark = mid or TWAP fallback.
  void db;
  void market;
  return {
    mark: null,
    index: "0",
    fundingAccumulator: "0",
    bestBid: null,
    bestAsk: null,
  };
}

/** L2 book view (REQ-B-3/B-7): `[price, size]` levels, best first. */
export function computeBook(db: Db, market: PublicKey): BookView {
  // STUB: aggregate the OrderBook rows per side, best first.
  void db;
  void market;
  return { bids: [], asks: [] };
}
