//! Typed REST client over the fructus server envelope (`/api/*`, D14):
//! every method issues exactly one request, parses `{ok:true,data}` and maps
//! `{ok:false,error}` / non-2xx responses to a typed `ApiError`.

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

interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  /** Bearer token for gated routes (`/me*`, `/actions/*`); absent on public routes. */
  token?: string;
  /** JSON body for POSTs; absent on GETs. */
  body?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createApiClient(baseUrl = "/api", fetchImpl: typeof fetch = fetch): ApiClient {
  async function request<T>(spec: RequestSpec): Promise<T> {
    const headers: Record<string, string> = {};
    if (spec.token !== undefined) headers.Authorization = `Bearer ${spec.token}`;
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";

    const init: RequestInit = { method: spec.method, headers };
    if (spec.body !== undefined) init.body = JSON.stringify(spec.body);

    const response = await fetchImpl(`${baseUrl}${spec.path}`, init);

    let envelope: unknown = null;
    try {
      envelope = await response.json();
    } catch {
      envelope = null;
    }

    if (isRecord(envelope) && envelope.ok === true && response.ok) {
      return envelope.data as T;
    }

    if (isRecord(envelope) && envelope.ok === false) {
      const error = isRecord(envelope.error) ? envelope.error : {};
      throw new ApiError(
        typeof error.code === "string" ? error.code : "unknown_error",
        response.status,
        typeof error.message === "string" ? error.message : `request failed (HTTP ${response.status})`,
      );
    }

    throw new ApiError("invalid_response", response.status, `unexpected response (HTTP ${response.status})`);
  }

  return {
    challenge: (wallet) => request<ChallengeResponse>({ method: "POST", path: "/auth/challenge", body: { wallet } }),
    verify: (payload) => request<SessionResponse>({ method: "POST", path: "/auth/verify", body: payload }),
    bindPrepare: (wallet) => request<BindPrepareResponse>({ method: "POST", path: "/bind/prepare", body: { wallet } }),
    bindConfirm: (transaction, signature) =>
      request<BindConfirmResponse>({ method: "POST", path: "/bind/confirm", body: { transaction, signature } }),
    me: (token) => request<UserPortfolio>({ method: "GET", path: "/me", token }),
    positions: (token) => request<PositionsResponse>({ method: "GET", path: "/me/positions", token }),
    market: () => request<MarketView>({ method: "GET", path: "/market" }),
    book: () => request<BookView>({ method: "GET", path: "/market/book" }),
    candles: (interval, limit) =>
      request<CandlesResponse>({
        method: "GET",
        path: `/market/candles?interval=${interval}${limit !== undefined ? `&limit=${limit}` : ""}`,
      }),
    trades: (limit) =>
      request<TradesResponse>({
        method: "GET",
        path: `/market/trades${limit !== undefined ? `?limit=${limit}` : ""}`,
      }),
    deposit: (token, amount) =>
      request<ActionResponse>({ method: "POST", path: "/actions/deposit", token, body: { amount } }),
    withdraw: (token, amount) =>
      request<ActionResponse>({ method: "POST", path: "/actions/withdraw", token, body: { amount } }),
    placeOrder: (token, payload) =>
      request<ActionResponse>({ method: "POST", path: "/actions/orders", token, body: payload }),
    cancelOrder: (token, payload) =>
      request<ActionResponse>({ method: "POST", path: "/actions/orders/cancel", token, body: payload }),
    closePosition: (token, payload) =>
      request<ActionResponse>({ method: "POST", path: "/actions/positions/close", token, body: payload }),
    faucet: (wallet) => request<FaucetResponse>({ method: "POST", path: "/faucet", body: { wallet } }),
  };
}
