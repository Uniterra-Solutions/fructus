//! Shared DTO types for the product-v2 REST + WebSocket API (D14, REQ-C-3).
//!
//! Single source of truth: the backend (`server/`) imports these with
//! `import type` and fails typecheck on drift; the future frontend consumes the
//! same shapes. Amounts, rates, accumulators and seqs are **decimal strings**
//! of raw base units (USDC microunits, u64/i128, `1e9`-scaled rates) — JSON
//! numbers cannot carry them exactly. `null` means "not available yet"
//! (e.g. no two-sided book, no operator record).
//!
//! Types only: nothing here executes, so the module stays bundler-safe.

// --- Envelope ---------------------------------------------------------------

/** Error payload inside the failure arm of the envelope. */
export interface ApiError {
  /** Stable machine code (FructusError name or transport error, e.g. `OperatorUnauthorized`). */
  code: string;
  message: string;
}

/** Unified JSON envelope for every REST response (REQ-B-7). */
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: ApiError };

// --- Auth (SIWS + sessions, REQ-B-4) ----------------------------------------

/** `POST /auth/challenge` response: the SIWS message for the wallet to sign. */
export interface ChallengeResponse {
  /** Canonical SIWS sign-in input (domain = request host, nonce, issued-at, expiry). */
  signInInput: string;
  /** The single-use nonce embedded in `signInInput`. */
  nonce: string;
  /** ISO-8601 challenge expiry (≤ 5 min from issuance). */
  expiresAt: string;
}

/** `POST /auth/verify` request body. */
export interface VerifyRequest {
  /** Base58 wallet address. */
  wallet: string;
  /** Base58 ed25519 signature over the challenge's `signInInput`. */
  signature: string;
  /** Echo of the challenge's `signInInput` (the exact signed text). */
  signInInput: string;
}

/** `POST /auth/verify` response: the issued session (JWT, 24 h). */
export interface SessionResponse {
  /** Bearer token for `Authorization: Bearer …`. */
  token: string;
  wallet: string;
}

// --- Operator bind (D4, REQ-B-7) --------------------------------------------

/** `POST /bind/prepare` response: the wallet-signable bind transaction. */
export interface BindPrepareResponse {
  /** Base64 serialized (unsigned) transaction: `[spl approve, set_operator]`. */
  transaction: string;
  /** The operator key being bound. */
  operator: string;
  /** The `Operator` record PDA for `(market, wallet)`. */
  operatorRecord: string;
}

/** `POST /bind/confirm` request body. */
export interface BindConfirmRequest {
  /** The signed transaction, base64 serialized. */
  transaction: string;
  /** Base58 signature after submission. */
  signature: string;
}

/** `POST /bind/confirm` response. */
export interface BindConfirmResponse {
  /** `bound` after `set_operator(operator)`; `revoked` after rotate-to-default. */
  status: "bound" | "revoked";
  /** The bound operator address, or `null` when revoked. */
  operator: string | null;
}

// --- Portfolio (`/me*`, REQ-B-3) --------------------------------------------

/** Account health per the account-level predicate (REQ-A2-1). */
export type Health = "healthy" | "liquidatable";

/** One side's position view; a pristine side reports zero contribution. */
export interface PositionView {
  /** `0` = Long/Bid, `1` = Short/Ask. */
  side: 0 | 1;
  notional: string;
  /** Volume-weighted entry rate of the open notional. */
  entryRate?: string;
  /** Unrealized PnL (incl. pending funding); signed. */
  upnl: string;
  /** Initial-margin requirement contribution of this side. */
  reqInitial: string;
  /** Maintenance-margin requirement contribution of this side. */
  reqMaint: string;
}

/** The wallet's operator delegation state. */
export interface OperatorView {
  /** The bound operator address; `null` when not bound or revoked. */
  address: string | null;
}

/** `GET /me` portfolio. */
export interface UserPortfolio {
  wallet: string;
  deposited: string;
  reserved: string;
  claimable: string;
  /** Withdrawable collateral: `deposited − reserved`. */
  free: string;
  /** `deposited + Σ upnl`; signed. */
  equity: string;
  /** `Σ_side m(n_side, initial_bps)`. */
  requirementInitial: string;
  /** `Σ_side m(n_side, maintenance_bps)`. */
  requirementMaint: string;
  health: Health;
  /** `null` when the wallet has no `Operator` record at all. */
  operator: OperatorView | null;
  positions: PositionView[];
}

/** `GET /me/positions` response. */
export interface PositionsResponse {
  positions: PositionView[];
}

/** One row of `GET /me/history` (indexed fills/funding in seq order). */
export interface HistoryEntry {
  kind: "fill" | "funding";
  seq: string;
  slot: string;
  /** Fill-only fields. */
  side?: 0 | 1;
  price?: string;
  size?: string;
  /** Signed funding amount (funding rows). */
  amount?: string;
}

/** `GET /me/history` response. */
export interface HistoryResponse {
  entries: HistoryEntry[];
}

// --- Market (`/market*`, REQ-B-7) -------------------------------------------

/** `GET /market` snapshot. */
export interface MarketView {
  /** Mark rate (mid or TWAP fallback); `null` until a two-sided book exists. */
  mark: string | null;
  /** Trustless index rate from the stake-pool exchange rate. */
  index: string;
  /** Signed cumulative funding (i128). */
  fundingAccumulator: string;
  bestBid: string | null;
  bestAsk: string | null;
}

/** `GET /market/book`: L2 levels as `[price, size]`, best first. */
export interface BookView {
  bids: [string, string][];
  asks: [string, string][];
}

/** One aggregated candle for `GET /market/candles` (product-v3 REQ-K-2). */
export interface CandleView {
  /** Bucket start (ms epoch), decimal string. */
  timeMs: string;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Sum of raw fill sizes over the bucket. */
  volume: string;
  /** Fill count in the bucket. */
  trades: number;
}

/** `GET /market/candles` response. */
export interface CandlesResponse {
  candles: CandleView[];
}

/** One market trade print for `GET /market/trades` (product-v3 REQ-K-3). */
export interface TradeView {
  seq: string;
  slot: string;
  /** Block time in ms; `null` only for pre-migration rows. */
  timeMs: string | null;
  owner: string;
  side: 0 | 1;
  price: string;
  size: string;
}

/** `GET /market/trades` response. */
export interface TradesResponse {
  trades: TradeView[];
}

// --- Actions (`/actions/*`, REQ-B-5) ----------------------------------------

/** `POST /actions/deposit` body. */
export interface DepositActionRequest {
  amount: string;
}

/** `POST /actions/withdraw` body. */
export interface WithdrawActionRequest {
  amount: string;
}

/** `POST /actions/orders` body (limit or market). */
export interface PlaceOrderActionRequest {
  kind: "limit" | "market";
  side: 0 | 1;
  size: string;
  /** Required iff `kind === "limit"`. */
  price?: string;
}

/** `POST /actions/orders/cancel` body. */
export interface CancelOrderActionRequest {
  side: 0 | 1;
  seq: string;
}

/** `POST /actions/positions/close` body. */
export interface ClosePositionActionRequest {
  side: 0 | 1;
  size: string;
}

/** Union of every action-request body (the routes themselves split per REQ-B-7). */
export type ActionRequest =
  | DepositActionRequest
  | WithdrawActionRequest
  | PlaceOrderActionRequest
  | CancelOrderActionRequest
  | ClosePositionActionRequest;

/** Response for every `/actions/*` route: the `tx_log` row for the attempt. */
export interface ActionResponse {
  actionId: string;
  /** Base58 signature once broadcast. */
  signature?: string;
  status: "queued" | "sent" | "confirmed" | "failed";
  /** Failure reason when `status === "failed"`. */
  error?: string;
}

// --- Faucet + health (REQ-B-8, REQ-B-10) ------------------------------------

/** `POST /faucet` body. */
export interface FaucetRequest {
  wallet: string;
}

/** `POST /faucet` response. */
export interface FaucetResponse {
  /** Raw units minted. */
  amount: string;
  /** The wallet's ATA the mint landed in. */
  ata: string;
}

/** `GET /healthz` response. */
export interface HealthzResponse {
  status: "ok";
  /** Last indexed slot; `null` before the first resync. */
  slot: number | null;
}

// --- WebSocket push (`/ws?token=…`, REQ-B-7) --------------------------------

/** Server → client WebSocket push messages; unknown tokens close with 4401. */
export type ServerWsMessage =
  | { type: "book"; market: string; book: BookView }
  | { type: "mark"; market: string; mark: MarketView }
  | { type: "user"; portfolio: UserPortfolio }
  | { type: "tx"; action: ActionResponse }
  | { type: "trade"; market: string; trade: TradeView };
