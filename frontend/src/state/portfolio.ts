//! Portfolio delta application (the `user` WS message carries signed deltas).

import type { PositionView, UserPortfolio } from "fructus-sdk/src/api.js";

/** Apply one pushed portfolio delta onto the last held snapshot (pure). */
export function applyPortfolioDeltas(snapshot: UserPortfolio, delta: UserPortfolio): UserPortfolio {
  // Positions: snapshot rows for every held side, then per-field bigint adds for
  // every side the delta mentions (new sides start from zeros).
  const bySide = new Map<0 | 1, PositionView>();
  for (const position of snapshot.positions) {
    bySide.set(position.side, {
      side: position.side,
      notional: position.notional,
      upnl: position.upnl,
      reqInitial: position.reqInitial,
      reqMaint: position.reqMaint,
    });
  }
  for (const incoming of delta.positions) {
    const base =
      bySide.get(incoming.side) ??
      ({ side: incoming.side, notional: "0", upnl: "0", reqInitial: "0", reqMaint: "0" } as const);
    bySide.set(incoming.side, {
      side: incoming.side,
      notional: (BigInt(base.notional) + BigInt(incoming.notional)).toString(),
      upnl: (BigInt(base.upnl) + BigInt(incoming.upnl)).toString(),
      reqInitial: (BigInt(base.reqInitial) + BigInt(incoming.reqInitial)).toString(),
      reqMaint: (BigInt(base.reqMaint) + BigInt(incoming.reqMaint)).toString(),
    });
  }

  // Normalise: drop fully-closed sides, then sort by side ascending.
  const positions = [...bySide.values()]
    .filter(
      (position) =>
        !(
          BigInt(position.notional) === 0n &&
          BigInt(position.upnl) === 0n &&
          BigInt(position.reqInitial) === 0n &&
          BigInt(position.reqMaint) === 0n
        ),
    )
    .sort((a, b) => a.side - b.side);

  return {
    wallet: snapshot.wallet,
    deposited: (BigInt(snapshot.deposited) + BigInt(delta.deposited)).toString(),
    reserved: (BigInt(snapshot.reserved) + BigInt(delta.reserved)).toString(),
    claimable: (BigInt(snapshot.claimable) + BigInt(delta.claimable)).toString(),
    free: (BigInt(snapshot.free) + BigInt(delta.free)).toString(),
    equity: (BigInt(snapshot.equity) + BigInt(delta.equity)).toString(),
    requirementInitial: (BigInt(snapshot.requirementInitial) + BigInt(delta.requirementInitial)).toString(),
    requirementMaint: (BigInt(snapshot.requirementMaint) + BigInt(delta.requirementMaint)).toString(),
    health: delta.health,
    operator: delta.operator,
    positions,
  };
}
