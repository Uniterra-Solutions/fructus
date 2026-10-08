//! Connect / logout / bind wallet control (REQ-F-2).

import type { AuthState } from "../state/auth.js";
import type { ShellActions } from "./Shell.js";
import { useLocale } from "../i18n/index.js";

export interface WalletControlProps {
  auth: AuthState;
  actions: Pick<ShellActions, "connect" | "disconnect" | "login" | "bind">;
}

function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function WalletControl({ auth, actions }: WalletControlProps) {
  const { t } = useLocale();
  const buttonClass =
    "rounded border border-line bg-panel2 px-2.5 py-1 text-xs text-ink transition-colors hover:border-accent hover:text-accent";

  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      {auth.wallet !== null ? <span>{shortAddress(auth.wallet)}</span> : null}
      {auth.phase === "disconnected" ? (
        <button type="button" className={buttonClass} onClick={() => actions.connect()}>
          {t("wallet.connect")}
        </button>
      ) : null}
      {auth.phase === "connected" ? (
        <button type="button" className={buttonClass} onClick={() => actions.login()}>
          {t("wallet.login")}
        </button>
      ) : null}
      {auth.phase === "authed" ? (
        <button type="button" className={buttonClass} onClick={() => actions.bind()}>
          {t("wallet.bind")}
        </button>
      ) : null}
      {auth.phase !== "disconnected" ? (
        <button type="button" className={buttonClass} onClick={() => actions.disconnect()}>
          {t("wallet.disconnect")}
        </button>
      ) : null}
    </div>
  );
}
