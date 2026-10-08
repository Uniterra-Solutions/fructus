//! Terminal store: app state + WS message reduction. Pure reducers, tiny pub/sub.
//! `user` pushes carry signed deltas → applied onto the last snapshot;
//! `trade` pushes fold into the candle series (current interval) and the tape.

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
import {
  CANDLE_INTERVAL_MS,
  DEFAULT_CANDLE_LIMIT,
  applyTradeToCandles,
  type CandleInterval,
} from "../lib/candles.js";
import { mergeTrades } from "../lib/tape.js";
import { applyPortfolioDeltas } from "./portfolio.js";
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
export function reduceWsMessage(state: TerminalState, message: ServerWsMessage): TerminalState {
  switch (message.type) {
    case "book":
      return { ...state, book: message.book };
    case "mark":
      return { ...state, market: message.mark };
    case "trade": {
      const intervalMs = CANDLE_INTERVAL_MS[state.interval];
      return {
        ...state,
        candles: applyTradeToCandles(state.candles, message.trade, intervalMs, DEFAULT_CANDLE_LIMIT),
        trades: mergeTrades(state.trades, [message.trade]),
      };
    }
    case "user": {
      // Deltas apply onto the last snapshot; before the bootstrap lands there
      // is no baseline to apply onto, so the push is dropped (the REST read
      // right after login re-snapshots anyway).
      if (state.portfolio === null) return state;
      return { ...state, portfolio: applyPortfolioDeltas(state.portfolio, message.portfolio) };
    }
    case "tx":
      return { ...state, lastAction: message.action };
    default:
      // Forward-compatible: an unknown push type must not clobber the state.
      return state;
  }
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
