//! Top bar: brand, market stats, locale toggle, wallet control. Stub.

import type { MarketView } from "fructus-sdk/src/api.js";
import type { AuthState } from "../state/auth.js";
import type { ShellActions } from "./Shell.js";
import { MarketStats } from "./MarketStats.js";
import { LocaleToggle } from "../i18n/index.js";
import { WalletControl } from "./WalletControl.js";

// Stub (product-v3 freeze): real wiring surface — kept referenced until the frontend wave.
void MarketStats;
void LocaleToggle;
void WalletControl;

export interface TopBarProps {
  market: MarketView | null;
  auth: AuthState;
  actions: Pick<ShellActions, "connect" | "disconnect" | "login" | "bind">;
}

export function TopBar(_props: TopBarProps) {
  return null;
}
