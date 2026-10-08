//! Positions panel with close actions. Stub.

import type { UserPortfolio } from "fructus-sdk/src/api.js";

export interface PositionsPanelProps {
  portfolio: UserPortfolio | null;
  disabled: boolean;
  onClose(side: 0 | 1, size: string): void;
}

export function PositionsPanel(_props: PositionsPanelProps) {
  return null;
}
