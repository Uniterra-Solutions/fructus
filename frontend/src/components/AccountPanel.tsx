//! Account panel: collateral, health, deposit/withdraw, faucet, bind. Stub.

import type { UserPortfolio } from "fructus-sdk/src/api.js";

export interface AccountPanelProps {
  portfolio: UserPortfolio | null;
  authed: boolean;
  bound: boolean;
  onDeposit(amount: string): void;
  onWithdraw(amount: string): void;
  onFaucet(): void;
  onBind(): void;
}

export function AccountPanel(_props: AccountPanelProps) {
  return null;
}
