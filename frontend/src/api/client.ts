//! Typed REST client over the fructus server envelope (`/api/*`, D14).
//! Stub — product-v3 freeze (real implementation lands in the implement phase).

import type {
  ActionResponse,
  BindConfirmResponse,
  BindPrepareResponse,
  BookView,
  CandlesResponse,
  ChallengeResponse,
  ClosePositionActionRequest,
  CancelOrderActionRequest,
  FaucetResponse,
  MarketView,
  PlaceOrderActionRequest,
  PositionsResponse,
  SessionResponse,
  TradesResponse,
  UserPortfolio,
  VerifyRequest,
} from "fructus-sdk/src/api.js";
import type { CandleInterval } from "../lib/candles.js";

/** Typed error from the server envelope (`{ok:false, error:{code,message}}`). */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  challenge(wallet: string): Promise<ChallengeResponse>;
  verify(request: VerifyRequest): Promise<SessionResponse>;
  bindPrepare(wallet: string): Promise<BindPrepareResponse>;
  bindConfirm(transaction: string, signature: string): Promise<BindConfirmResponse>;
  me(token: string): Promise<UserPortfolio>;
  positions(token: string): Promise<PositionsResponse>;
  market(): Promise<MarketView>;
  book(): Promise<BookView>;
  candles(interval: CandleInterval, limit?: number): Promise<CandlesResponse>;
  trades(limit?: number): Promise<TradesResponse>;
  deposit(token: string, amount: string): Promise<ActionResponse>;
  withdraw(token: string, amount: string): Promise<ActionResponse>;
  placeOrder(token: string, request: PlaceOrderActionRequest): Promise<ActionResponse>;
  cancelOrder(token: string, request: CancelOrderActionRequest): Promise<ActionResponse>;
  closePosition(token: string, request: ClosePositionActionRequest): Promise<ActionResponse>;
  faucet(wallet: string): Promise<FaucetResponse>;
}

export function createApiClient(_baseUrl = "/api", _fetchImpl: typeof fetch = fetch): ApiClient {
  return {
    challenge: async () => ({}) as ChallengeResponse,
    verify: async () => ({}) as SessionResponse,
    bindPrepare: async () => ({}) as BindPrepareResponse,
    bindConfirm: async () => ({}) as BindConfirmResponse,
    me: async () => ({}) as UserPortfolio,
    positions: async () => ({}) as PositionsResponse,
    market: async () => ({}) as MarketView,
    book: async () => ({}) as BookView,
    candles: async () => ({}) as CandlesResponse,
    trades: async () => ({}) as TradesResponse,
    deposit: async () => ({}) as ActionResponse,
    withdraw: async () => ({}) as ActionResponse,
    placeOrder: async () => ({}) as ActionResponse,
    cancelOrder: async () => ({}) as ActionResponse,
    closePosition: async () => ({}) as ActionResponse,
    faucet: async () => ({}) as FaucetResponse,
  };
}
