//! Terminal shell: the seven panels + top bar. Stub — product-v3 freeze.

import { useEffect } from "react";
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
import { LocaleToggle } from "../i18n/index.js";
import { TopBar } from "./TopBar.js";
import { ChartPanel } from "./ChartPanel.js";
import { OrderBookPanel } from "./OrderBookPanel.js";
import { TradeForm } from "./TradeForm.js";
import { PositionsPanel } from "./PositionsPanel.js";
import { AccountPanel } from "./AccountPanel.js";
import { TradesTape } from "./TradesTape.js";

// Stub (product-v3 freeze): the panel imports are the real wiring surface —
// referenced here so the import set survives until the frontend wave.
void LocaleToggle;
void TopBar;
void ChartPanel;
void OrderBookPanel;
void TradeForm;
void PositionsPanel;
void AccountPanel;
void TradesTape;

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
}

/** Trading controls are enabled only when the wallet is authed AND the operator is bound (REQ-F-2 gate). */
export function tradingEnabled(_auth: AuthState): boolean {
  return false; // stub
}

export function Shell(_props: ShellProps) {
  useEffect(() => {
    /* stub: sets document.documentElement.dataset.theme = "dark" */
  }, []);
  return null;
}
