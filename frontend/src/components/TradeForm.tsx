//! Open-position form (Long/Short, Market/Limit). Stub.

import type { PlaceOrderActionRequest } from "fructus-sdk/src/api.js";

export interface TradeFormProps {
  /** False only when the wallet is authed AND bound (REQ-F-2 gate). */
  disabled: boolean;
  onSubmit(request: PlaceOrderActionRequest): void;
}

export function TradeForm(_props: TradeFormProps) {
  return null;
}
