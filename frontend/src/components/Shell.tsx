//! Terminal shell: the seven panels + top bar + the trade gate (REQ-F-1, REQ-F-2).

import { useEffect, useState } from "react";
import type {
  BookView,
  CandleView,
  MarketView,
  PlaceOrderActionRequest,
  TradeView,
  UserPortfolio,
} from "fructus-sdk/src/api.js";
import type { AuthState } from "../state/auth.js";
import type { CandleInterval } from "../lib/candles.js";
import { useLocale } from "../i18n/index.js";
import { TopBar } from "./TopBar.js";
import { ChartPanel } from "./ChartPanel.js";
import { OrderBookPanel } from "./OrderBookPanel.js";
import { TradeForm } from "./TradeForm.js";
import { PositionsPanel } from "./PositionsPanel.js";
import { AccountPanel } from "./AccountPanel.js";
import { TradesTape } from "./TradesTape.js";

export interface ShellActions {
  connect(): void;
  disconnect(): void;
  login(): void;
  bind(): void;
  faucet(): void;
  deposit(amount: string): void;
  withdraw(amount: string): void;
  submitOrder(request: PlaceOrderActionRequest): void;
  closePosition(side: 0 | 1, size: string): void;
  setInterval(interval: CandleInterval): void;
}

export interface ShellProps {
  auth: AuthState;
  market: MarketView | null;
  book: BookView | null;
  candles: CandleView[];
  trades: TradeView[];
  portfolio: UserPortfolio | null;
  interval: CandleInterval;
  status: string | null;
  actions: ShellActions;
  /** Optional: mounts the live lightweight-charts controller in the chart panel. */
  chartFetchCandles?: (interval: CandleInterval) => Promise<CandleView[]>;
}

/** Trading controls are enabled only when the wallet is authed AND the operator is bound (REQ-F-2 gate). */
export function tradingEnabled(auth: AuthState): boolean {
  return auth.phase === "bound";
}

export function Shell(props: ShellProps) {
  const { auth, market, book, candles, trades, portfolio, interval, status, actions, chartFetchCandles } = props;
  const { t } = useLocale();
  const [prefill, setPrefill] = useState<{ price: string; side: 0 | 1 } | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
  }, []);

  const gated = !tradingEnabled(auth);
  // The bind CTA is shown for a connected wallet that is not bound yet (authed-or-connected, unbound).
  const showBindCta = auth.phase === "connected" || auth.phase === "authed";

  return (
    <div className="flex min-h-screen flex-col bg-base font-mono text-ink">
      <TopBar market={market} auth={auth} actions={actions} />
      {showBindCta ? (
        <div className="border-b border-line bg-panel2 px-4 py-2">
          <button
            type="button"
            data-testid="bind-cta"
            className="rounded border border-accent px-3 py-1 text-xs text-accent transition-colors hover:bg-panel"
            onClick={() => actions.bind()}
          >
            {t("gate.bindToTrade")}
          </button>
        </div>
      ) : null}
      <main className="grid flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-3">
          <ChartPanel
            candles={candles}
            interval={interval}
            onIntervalChange={actions.setInterval}
            fetchCandles={chartFetchCandles}
            market={market}
          />
          <TradesTape trades={trades} />
        </div>
        <OrderBookPanel book={book} onPriceSelect={(price: string, side: 0 | 1) => setPrefill({ price, side })} />
        <div className="flex min-w-0 flex-col gap-3">
          <TradeForm disabled={gated} prefill={prefill} onSubmit={actions.submitOrder} />
          <PositionsPanel portfolio={portfolio} disabled={gated} onClose={actions.closePosition} />
          <AccountPanel
            portfolio={portfolio}
            authed={auth.phase === "authed" || auth.phase === "bound"}
            bound={auth.phase === "bound"}
            onDeposit={actions.deposit}
            onWithdraw={actions.withdraw}
            onFaucet={actions.faucet}
            onBind={actions.bind}
          />
          {status !== null ? (
            <div className="rounded border border-line bg-panel px-3 py-2 text-xs text-muted">{status}</div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
