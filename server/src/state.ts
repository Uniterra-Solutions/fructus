//! Server-side state reads (REQ-B-3): the portfolio / market / book read models
//! computed from the indexed rows via the SDK mirrors (`fructus-sdk`). The
//! `health` flag equals the program's account-level predicate
//! (`positions::account_liquidatable`: strict `<` against the maintenance
//! requirement, zero exposure ⇒ healthy) — STATE-HEALTH-MATCHES-PROGRAM-TRIGGER.

import { PublicKey } from "@solana/web3.js";
import {
  accountLiquidatable,
  decodeOperator,
  decodeOrderBook,
  decodePerpMarket,
  decodePosition,
  decodeUserCollateral,
  marginRequired,
  mid,
  operatorPda,
  orderBookPda,
  pnl,
  positionPda,
  positionSideFromSideByte,
  userCollateralPda,
  type BookView,
  type MarketView,
  type PerpMarketState,
  type PositionView,
  type UserPortfolio,
} from "fructus-sdk/src/index.js";
import type { AccountKind, Db } from "./db.js";

function decoded(db: Db, kind: AccountKind, pubkey: string): Buffer | null {
  const row = db.getAccount(kind, pubkey);
  return row === null ? null : Buffer.from(row.data);
}

/**
 * Per-user portfolio (REQ-B-3): `deposited/reserved/claimable/free`, per-side
 * `notional/upnl/reqInitial/reqMaint`, `equity` vs `requirementInitial` /
 * `requirementMaint`, and `health` from the account-level predicate
 * (`accountLiquidatable` mirror, REQ-A2-1 / STATE-HEALTH-MATCHES-PROGRAM-TRIGGER).
 */
export function computePortfolio(db: Db, wallet: PublicKey, market: PublicKey): UserPortfolio {
  const marketRow = decoded(db, "market", market.toBase58());
  const marketState = marketRow === null ? null : decodePerpMarket(marketRow);

  const collateralRow = decoded(db, "user_collateral", userCollateralPda(market, wallet).address.toBase58());
  const collateral = collateralRow === null ? null : decodeUserCollateral(collateralRow);
  const deposited = collateral?.deposited ?? 0n;
  const reserved = collateral?.reserved ?? 0n;
  const claimable = collateral?.claimable ?? 0n;

  const indexN = marketState?.indexN ?? 0n;
  const indexD = marketState?.indexD ?? 0n;
  const initialMarginBps = marketState?.initialMarginBps ?? 0;
  const maintenanceMarginBps = marketState?.maintenanceMarginBps ?? 0;

  const positions: PositionView[] = [];
  let pnlSum = 0n;
  let notionalLong = 0n;
  let notionalShort = 0n;
  for (const side of [0, 1] as const) {
    const row = decoded(db, "position", positionPda(market, wallet, side).address.toBase58());
    if (row === null) continue; // pristine side (no Position account yet) — omitted
    const position = decodePosition(row);
    if (position === null) continue;
    // Defensive: the row must actually belong to this (market, wallet) account.
    if (!position.market.equals(market) || !position.owner.equals(wallet)) continue;
    if (position.side !== 0 && position.side !== 1) continue; // invalid side byte — never a view

    const sideEnum = positionSideFromSideByte(position.side);
    const sidePnl =
      sideEnum === null
        ? 0n
        : (pnl(position.entryN, position.entryD, indexN, indexD, position.notional, sideEnum) ?? 0n);
    pnlSum += sidePnl;
    if (position.side === 0) notionalLong += position.notional;
    else notionalShort += position.notional;

    positions.push({
      side: position.side === 1 ? 1 : 0,
      notional: position.notional.toString(),
      upnl: sidePnl.toString(),
      reqInitial: marginRequired(position.notional, initialMarginBps).toString(),
      reqMaint: marginRequired(position.notional, maintenanceMarginBps).toString(),
    });
  }

  const equity = deposited + pnlSum;
  const requirementInitial =
    marginRequired(notionalLong, initialMarginBps) + marginRequired(notionalShort, initialMarginBps);
  const requirementMaint =
    marginRequired(notionalLong, maintenanceMarginBps) + marginRequired(notionalShort, maintenanceMarginBps);

  const operatorRow = decoded(db, "operator", operatorPda(market, wallet).address.toBase58());
  const operatorState = operatorRow === null ? null : decodeOperator(operatorRow);
  const operator =
    operatorState === null
      ? null
      : {
          address: operatorState.operator.equals(PublicKey.default)
            ? null
            : operatorState.operator.toBase58(),
        };

  return {
    wallet: wallet.toBase58(),
    deposited: deposited.toString(),
    reserved: reserved.toString(),
    claimable: claimable.toString(),
    free: (deposited - reserved).toString(),
    equity: equity.toString(),
    requirementInitial: requirementInitial.toString(),
    requirementMaint: requirementMaint.toString(),
    health: accountLiquidatable(deposited, pnlSum, notionalLong, notionalShort, maintenanceMarginBps)
      ? "liquidatable"
      : "healthy",
    operator,
    positions,
  };
}

/** Market snapshot (REQ-B-3): mark/mid, index, funding accumulator, best bid/ask. */
export function computeMarket(db: Db, market: PublicKey): MarketView {
  const marketRow = decoded(db, "market", market.toBase58());
  const marketState = marketRow === null ? null : decodePerpMarket(marketRow);
  if (marketState === null) {
    return { mark: null, index: "0", fundingAccumulator: "0", bestBid: null, bestAsk: null };
  }

  const bookRow = decoded(db, "order_book", orderBookPda(market).address.toBase58());
  const book = bookRow === null ? null : decodeOrderBook(bookRow);
  // On-chain, an empty side caches `best_bid`/`best_ask` as 0 and the mid
  // requires BOTH sides (`orderbook::mid`) — the DTO surfaces both as `null`.
  const bestBidValue = book?.bestBid ?? 0n;
  const bestAskValue = book?.bestAsk ?? 0n;
  const mark = mid(bestBidValue, bestAskValue);

  return {
    mark: mark === null ? null : mark.toString(),
    // The trustless index level: the market's last-settlement stake-pool rate
    // (`index_n`/`index_d`) scaled to the 1e6 price convention. `0` marks an
    // un-set baseline (no settlement yet) — see `indexLevel`.
    index: indexLevel(marketState).toString(),
    fundingAccumulator: marketState.fundingAccumulator.toString(),
    bestBid: bestBidValue === 0n ? null : bestBidValue.toString(),
    bestAsk: bestAskValue === 0n ? null : bestAskValue.toString(),
  };
}

/**
 * The trustless index level: the market's last-settlement stake-pool rate
 * (`index_n`/`index_d`), scaled to the 1e6 convention the mark/book use.
 * `index_d == 0` marks an un-set baseline — the funding engine writes it at
 * the first `settle_funding`, and the pair then tracks the pool per epoch.
 * (The funding ENGINE's `index` argument is the annualized realized yield
 * since that baseline; the terminal draws the rate level itself.)
 */
export function indexLevel(marketState: PerpMarketState): bigint {
  return marketState.indexD === 0n ? 0n : (marketState.indexN * 1_000_000n) / marketState.indexD;
}

/**
 * One mark sample for the candle series (product-v3 candles v2): the book mid,
 * else the pool-rate index, else the last trade — so the series keeps printing
 * while the book is one-sided or empty. `null` = no price source yet.
 */
export function samplePrice(db: Db, market: PublicKey): string | null {
  const view = computeMarket(db, market);
  if (view.mark !== null) return view.mark;
  if (view.index !== "0") return view.index;
  return db.latestFillPrice(market.toBase58());
}

/** L2 book view (REQ-B-3/B-7): `[price, size]` levels, best first. */
export function computeBook(db: Db, market: PublicKey): BookView {
  const bookRow = decoded(db, "order_book", orderBookPda(market).address.toBase58());
  const book = bookRow === null ? null : decodeOrderBook(bookRow);
  if (book === null) return { bids: [], asks: [] };
  const level = (order: { price: bigint; size: bigint }): [string, string] => [
    order.price.toString(),
    order.size.toString(),
  ];
  // The on-chain book stores orders insertion-ordered; the served view is
  // sorted best-first: highest bid first, lowest ask first (REQ-B-3/REQ-F-4).
  const byPrice = (a: [string, string], b: [string, string]): number => {
    const left = BigInt(a[0]);
    const right = BigInt(b[0]);
    return left === right ? 0 : left < right ? -1 : 1;
  };
  return {
    bids: book.bids
      .filter((order) => order.active === 1)
      .map(level)
      .sort((a, b) => byPrice(b, a)),
    asks: book.asks.filter((order) => order.active === 1).map(level).sort(byPrice),
  };
}
