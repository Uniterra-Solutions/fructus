//! Account panel: collateral, health, deposit/withdraw, faucet, bind — REQ-F-7.

import { useState } from "react";
import type { UserPortfolio } from "fructus-sdk/src/api.js";
import { formatAmount, parseAmount } from "../lib/amount.js";
import { useLocale } from "../i18n/index.js";

export interface AccountPanelProps {
  portfolio: UserPortfolio | null;
  authed: boolean;
  bound: boolean;
  onDeposit(amount: string): void;
  onWithdraw(amount: string): void;
  onFaucet(): void;
  onBind(): void;
}

function amountValid(text: string): boolean {
  const raw = parseAmount(text);
  return raw !== null && BigInt(raw) > 0n;
}

export function AccountPanel({
  portfolio,
  authed,
  bound,
  onDeposit,
  onWithdraw,
  onFaucet,
  onBind,
}: AccountPanelProps) {
  const { t } = useLocale();
  const [depositText, setDepositText] = useState("");
  const [withdrawText, setWithdrawText] = useState("");

  const depositRaw = parseAmount(depositText);
  const withdrawRaw = parseAmount(withdrawText);
  const depositReady = authed && amountValid(depositText);
  const withdrawReady = authed && amountValid(withdrawText);

  const health = portfolio !== null ? portfolio.health : null;
  const healthLabel =
    health === "liquidatable" ? t("account.liquidatable") : health === "healthy" ? t("account.healthy") : "—";

  const inputClass =
    "min-w-0 flex-1 rounded border border-line bg-panel2 px-2 py-1 font-mono text-xs text-ink outline-none transition-colors focus:border-accent";
  const actionClass = (ready: boolean): string =>
    `rounded border px-2.5 py-1 text-xs transition-colors ${
      ready ? "border-accent text-accent hover:bg-panel2" : "border-line text-muted opacity-60"
    }`;

  return (
    <section data-testid="account-panel" className="flex min-w-0 flex-col gap-2 rounded border border-line bg-panel p-3">
      <header className="flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wider text-muted">{t("account.title")}</h2>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted">{t("account.health")}</span>
          <span
            data-testid="health"
            data-health={health ?? "unknown"}
            className={
              health === "liquidatable"
                ? "rounded border border-down px-1.5 py-0.5 text-down"
                : "rounded border border-line px-1.5 py-0.5 text-up"
            }
          >
            {healthLabel}
          </span>
        </div>
      </header>

      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div className="flex flex-col">
          <dt className="text-muted">{t("account.deposited")}</dt>
          <dd className="text-right text-ink">{portfolio !== null ? formatAmount(portfolio.deposited) : "—"}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-muted">{t("account.free")}</dt>
          <dd className="text-right text-ink">{portfolio !== null ? formatAmount(portfolio.free) : "—"}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-muted">{t("account.equity")}</dt>
          <dd className="text-right text-ink">{portfolio !== null ? formatAmount(portfolio.equity) : "—"}</dd>
        </div>
      </dl>

      <div className="flex items-center gap-2">
        <input
          data-testid="deposit-input"
          value={depositText}
          inputMode="decimal"
          placeholder={t("account.deposit")}
          className={inputClass}
          onChange={(event) => setDepositText(event.target.value)}
        />
        <button
          type="button"
          data-testid="deposit-submit"
          disabled={!depositReady}
          className={actionClass(depositReady)}
          onClick={() => {
            if (depositReady && depositRaw !== null) onDeposit(depositRaw);
          }}
        >
          {t("account.deposit")}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input
          data-testid="withdraw-input"
          value={withdrawText}
          inputMode="decimal"
          placeholder={t("account.withdraw")}
          className={inputClass}
          onChange={(event) => setWithdrawText(event.target.value)}
        />
        <button
          type="button"
          data-testid="withdraw-submit"
          disabled={!withdrawReady}
          className={actionClass(withdrawReady)}
          onClick={() => {
            if (withdrawReady && withdrawRaw !== null) onWithdraw(withdrawRaw);
          }}
        >
          {t("account.withdraw")}
        </button>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted">{t("account.operator")}</span>
        <span className="min-w-0 flex-1 truncate text-ink">
          {portfolio !== null && portfolio.operator !== null && portfolio.operator.address !== null
            ? portfolio.operator.address
            : t("account.unbound")}
        </span>
        {authed ? (
          <button
            type="button"
            className={actionClass(true)}
            onClick={() => onFaucet()}
          >
            {t("account.faucet")}
          </button>
        ) : null}
        {authed && !bound ? (
          <button
            type="button"
            className={actionClass(true)}
            onClick={() => onBind()}
          >
            {t("account.bind")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
