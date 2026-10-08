//! Terminal store: app state + WS message reduction. Pure reducers, tiny pub/sub.
//! Stub — product-v3 freeze.

import type {
  ActionResponse,
  BookView,
  CandleView,
  MarketView,
  ServerWsMessage,
  TradeView,
  UserPortfolio,
} from "fructus-sdk/src/api.js";
import { initialAuthState, type AuthState } from "./auth.js";
import type { CandleInterval } from "../lib/candles.js";
import type { WsStatus } from "../api/ws.js";

export interface TerminalState {
  book: BookView | null;
  market: MarketView | null;
  candles: CandleView[];
  trades: TradeView[];
  portfolio: UserPortfolio | null;
  auth: AuthState;
  lastAction: ActionResponse | null;
  interval: CandleInterval;
  wsStatus: WsStatus;
}

export function initialState(): TerminalState {
  return {
    book: null,
    market: null,
    candles: [],
    trades: [],
    portfolio: null,
    auth: initialAuthState,
    lastAction: null,
    interval: "1m",
    wsStatus: "closed",
  };
}

/** Route one WS push message through the pure state reducers. */
export function reduceWsMessage(state: TerminalState, _message: ServerWsMessage): TerminalState {
  return state;
}

export interface TerminalStore {
  getState(): TerminalState;
  subscribe(listener: (state: TerminalState) => void): () => void;
  dispatch(update: (state: TerminalState) => TerminalState): void;
}

export function createTerminalStore(): TerminalStore {
  let state = initialState();
  const listeners = new Set<(state: TerminalState) => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(update) {
      state = update(state);
      for (const listener of listeners) listener(state);
    },
  };
}
