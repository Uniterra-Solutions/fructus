//! Top bar: brand, market stats, locale toggle, wallet control (REQ-F-1).

import type { MarketView } from "fructus-sdk/src/api.js";
import type { AuthState } from "../state/auth.js";
import type { ShellActions } from "./Shell.js";
import { MarketStats } from "./MarketStats.js";
import { LocaleToggle } from "../i18n/index.js";
import { WalletControl } from "./WalletControl.js";
import { useLocale } from "../i18n/index.js";

export interface TopBarProps {
  market: MarketView | null;
  auth: AuthState;
  actions: Pick<ShellActions, "connect" | "disconnect" | "login" | "bind">;
}

export function TopBar({ market, auth, actions }: TopBarProps) {
  const { t } = useLocale();
  return (
    <header
      data-testid="top-bar"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-panel px-4 py-2"
    >
      <div className="flex items-center gap-4">
        <span className="text-sm font-semibold tracking-[0.3em] text-accent">{t("brand.name")}</span>
        <MarketStats market={market} />
      </div>
      <div className="flex items-center gap-3">
        <LocaleToggle />
        <WalletControl auth={auth} actions={actions} />
      </div>
    </header>
  );
}
