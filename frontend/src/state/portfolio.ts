//! Portfolio delta application (the `user` WS message carries signed deltas).
//! Stub — product-v3 freeze.

import type { UserPortfolio } from "fructus-sdk/src/api.js";

/** Apply one pushed portfolio delta onto the last held snapshot. */
export function applyPortfolioDeltas(snapshot: UserPortfolio, _delta: UserPortfolio): UserPortfolio {
  return snapshot;
}
