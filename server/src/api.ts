//! REST surface (REQ-B-7, D14): `node:http` only, no framework. Every response
//! is the unified JSON envelope from `sdk/src/api.ts` (REQ-C-3). Live routes:
//! `/healthz`, the SIWS auth routes, the faucet, the reads (`/me`,
//! `/me/positions`, `/me/history`, `/market`, `/market/book`), the wallet-signed
//! bind relay (`/bind/prepare` → base64 `[approve, set_operator]` transaction;
//! `/bind/confirm` → verified on-chain `Operator` record) and the operator
//! actions (`/actions/*`, delegated to the operator service — the API never
//! signs). `ROUTES` is the exported contract and mirrors
//! `docs/api/openapi.json` (REQ-C-1).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type {
  ActionResponse,
  ApiResponse,
  BindConfirmResponse,
  BindPrepareResponse,
  BookView,
  CandlesResponse,
  HealthzResponse,
  HistoryEntry,
  HistoryResponse,
  MarketView,
  PositionsResponse,
  TradesResponse,
  UserPortfolio,
} from "fructus-sdk/src/api.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  IX_DISCRIMINATORS,
  TOKEN_PROGRAM_ID,
  buildOperatorBindInstructions,
  decodeOperator,
  decodePerpMarket,
  operatorPda,
  type PerpMarketState,
} from "fructus-sdk/src/index.js";
import type { AuthService, SessionInfo } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import {
  BadRequestError,
  FaucetCapError,
  FaucetDisabledError,
  NotImplementedError,
  OperatorUnconfiguredError,
  UnauthorizedError,
} from "./errors.js";
import type { Faucet } from "./faucet.js";
import type { Keeper } from "./keeper.js";
import { aggregateCandles, parseCandlesQuery, parseTradesLimit, toTradeView } from "./market-data.js";
import type { CancelAction, CloseAction, OperatorService, OrderAction } from "./operator.js";

export interface Route {
  method: "GET" | "POST";
  path: string;
  /** JWT-gated (REQ-B-4: everything under /me and /actions). */
  private: boolean;
}

/**
 * Upper bound of fills scanned per candles request (product-v3 REQ-K-2); the
 * time window already bounds the buckets, this keeps the scan generous but finite.
 */
/** Cap on fills scanned per candles request (newest rows win when exceeded). */
export const CANDLES_FILLS_SCAN_LIMIT = 100_000;

/** The contract: exactly the routes of PRD REQ-B-7. */
export const ROUTES: readonly Route[] = [
  { method: "POST", path: "/auth/challenge", private: false },
  { method: "POST", path: "/auth/verify", private: false },
  { method: "POST", path: "/bind/prepare", private: false },
  { method: "POST", path: "/bind/confirm", private: false },
  { method: "GET", path: "/me", private: true },
  { method: "GET", path: "/me/positions", private: true },
  { method: "GET", path: "/me/history", private: true },
  { method: "GET", path: "/market", private: false },
  { method: "GET", path: "/market/book", private: false },
  { method: "GET", path: "/market/candles", private: false },
  { method: "GET", path: "/market/trades", private: false },
  { method: "POST", path: "/actions/deposit", private: true },
  { method: "POST", path: "/actions/withdraw", private: true },
  { method: "POST", path: "/actions/orders", private: true },
  { method: "POST", path: "/actions/orders/cancel", private: true },
  { method: "POST", path: "/actions/positions/close", private: true },
  { method: "POST", path: "/faucet", private: false },
  { method: "GET", path: "/healthz", private: false },
];

export interface ApiServerDeps {
  config: Config;
  db: Db;
  auth: AuthService;
  operator: OperatorService;
  /**
   * Keeper loop instance (D-10). NOT read by the API surface — the keeper is a
   * process concern owned by `index.ts` (start/stop); it is carried in the deps
   * object for boot-wiring parity only. Kept (not removed) because callers
   * construct the full deps set, including `test/review-server-interaction.test.ts`.
   */
  keeper: Keeper;
  /** `null` when the faucet is not configured (D15 → 404). */
  faucet: Faucet | null;
  /** Read models (state.ts), injected so tests can seed them. */
  getPortfolio: (wallet: PublicKey) => UserPortfolio | Promise<UserPortfolio>;
  getMarket: () => MarketView | Promise<MarketView>;
  getBook: () => BookView | Promise<BookView>;
  /** Last indexed slot (REQ-B-10 `/healthz.slot`); omitted ⇒ `null`. */
  getIndexedSlot?: () => number | null;
  /** Chain connection: bind blockhash/market reads and confirm verification. */
  connection: Connection;
  /** Program id the market/PDA derivations are scoped to. */
  programId: PublicKey;
  /** The perp market PDA (`marketPda(programId)`). */
  market: PublicKey;
  /**
   * The configured operator hot key's PUBLIC half — `/bind/prepare` binds it.
   * Only the public key is ever read here; the operator service stays the only
   * component that touches the secret (R-3). Throws
   * `OperatorUnconfiguredError` when `OPERATOR_KEYPAIR` is unset/unreadable.
   */
  getOperatorPubkey: () => PublicKey;
  /** Optional sink for `/actions/*` progress (the WS `tx` push). */
  onAction?: (wallet: PublicKey, action: ActionResponse) => void;
}

export interface ApiServer {
  /** The raw `node:http` server (the WS layer attaches to it). */
  readonly server: Server;
  /** The registered route table (the machine-checkable contract). */
  readonly routes: readonly Route[];
  /** Listen; defaults to `config.port`. Resolves with the bound port. */
  start(port?: number): Promise<number>;
  /** Close the listener (idempotent). */
  close(): Promise<void>;
}

export function createApiServer(deps: ApiServerDeps): ApiServer {
  const server = createServer((req, res) => {
    dispatch(deps, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendError(res, err);
      } else {
        res.destroy();
      }
    });
  });

  return {
    server,
    routes: ROUTES,

    start(port = deps.config.port): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(port, () => {
          server.removeListener("error", onError);
          const address = server.address();
          resolve(address !== null && typeof address === "object" ? address.port : port);
        });
      });
    },

    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function dispatch(deps: ApiServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const route = ROUTES.find((r) => r.method === req.method && r.path === url.pathname);

  if (route === undefined) {
    req.resume();
    sendJson(res, 404, {
      ok: false,
      error: { code: "not_found", message: `no route: ${req.method} ${url.pathname}` },
    } satisfies ApiResponse<never>);
    return;
  }

  if (route.path === "/healthz") {
    // Live (REQ-B-10 smoke surface); `slot` fills in once the indexer runs.
    const data: HealthzResponse = { status: "ok", slot: deps.getIndexedSlot?.() ?? null };
    sendJson(res, 200, { ok: true, data } satisfies ApiResponse<HealthzResponse>);
    return;
  }

  // JWT gate on every private route (REQ-B-4): missing/invalid/expired ⇒ 401
  // `{code:"unauthorized"}` before any handler logic runs.
  let session: SessionInfo | null = null;
  if (route.private) {
    session = authenticate(deps.auth, req);
    if (session === null) {
      req.resume();
      sendJson(res, 401, {
        ok: false,
        error: { code: "unauthorized", message: "missing or invalid session token" },
      } satisfies ApiResponse<never>);
      return;
    }
  }

  switch (`${route.method} ${route.path}`) {
    case "POST /auth/challenge": {
      const body = await readJsonBody(req);
      const wallet = requireString(body, "wallet");
      requirePubkey(wallet, "wallet");
      const data = deps.auth.challenge(wallet, url.hostname.length > 0 ? url.hostname : undefined);
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<typeof data>);
      return;
    }

    case "POST /auth/verify": {
      const body = await readJsonBody(req);
      const wallet = requireString(body, "wallet");
      const signature = requireString(body, "signature");
      const signInInput = requireString(body, "signInInput");
      const data = await deps.auth.verify(wallet, signature, signInInput);
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<typeof data>);
      return;
    }

    // ----------------------------------------------------------------- bind --
    // D4: the server prepares the bind transaction, the WALLET signs and
    // submits it locally (next to nothing to trust), and confirm verifies the
    // resulting on-chain record before reporting `bound`.

    case "POST /bind/prepare": {
      const body = await readJsonBody(req);
      const walletStr = requireString(body, "wallet");
      requirePubkey(walletStr, "wallet");
      const wallet = new PublicKey(walletStr);
      const operator = deps.getOperatorPubkey();
      const marketState = await readMarketState(deps);
      const userAta = associatedTokenAddress(wallet, marketState.collateralMint);
      const transaction = await buildBindTransaction(deps, { wallet, userAta, operator });
      const data: BindPrepareResponse = {
        transaction,
        operator: operator.toBase58(),
        operatorRecord: operatorPda(deps.market, wallet, deps.programId).address.toBase58(),
      };
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<BindPrepareResponse>);
      return;
    }

    case "POST /bind/confirm": {
      const body = await readJsonBody(req);
      const transactionB64 = requireString(body, "transaction");
      const signature = requireString(body, "signature");
      const intent = parseBindIntent(transactionB64, deps.programId);
      await verifyConfirmedTransaction(deps, signature, intent.user);
      const recordAddress = operatorPda(deps.market, intent.user, deps.programId).address;
      const info = await deps.connection.getAccountInfo(recordAddress, "confirmed");
      const record = info === null ? null : decodeOperator(info.data);
      if (record === null) {
        throw new BadRequestError("the Operator record does not exist on chain after the bind transaction");
      }
      if (
        !record.user.equals(intent.user) ||
        !record.market.equals(deps.market) ||
        !record.operator.equals(intent.operator)
      ) {
        throw new BadRequestError("the on-chain Operator record does not match the submitted transaction");
      }
      const revoked = record.operator.equals(PublicKey.default);
      const data: BindConfirmResponse = {
        status: revoked ? "revoked" : "bound",
        operator: revoked ? null : record.operator.toBase58(),
      };
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<BindConfirmResponse>);
      return;
    }

    // ----------------------------------------------------------- reads ------

    case "GET /me": {
      const wallet = new PublicKey((session as SessionInfo).wallet);
      const data = await deps.getPortfolio(wallet);
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<typeof data>);
      return;
    }

    case "GET /me/positions": {
      const wallet = new PublicKey((session as SessionInfo).wallet);
      const portfolio = await deps.getPortfolio(wallet);
      const data: PositionsResponse = { positions: portfolio.positions };
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<PositionsResponse>);
      return;
    }

    case "GET /me/history": {
      const wallet = (session as SessionInfo).wallet;
      const data: HistoryResponse = { entries: historyEntries(deps, wallet) };
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<HistoryResponse>);
      return;
    }

    case "GET /market": {
      const data = await deps.getMarket();
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<typeof data>);
      return;
    }

    case "GET /market/book": {
      const data = await deps.getBook();
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<typeof data>);
      return;
    }

    // product-v3 K-line surface (REQ-K-2/K-3): candles aggregate the timed
    // fills of the market's window; trades read the latest fills off the tape.
    case "GET /market/candles": {
      const query = parseCandlesQuery(url.searchParams);
      if (query === null) {
        throw new BadRequestError(
          "invalid candles query: interval must be one of 1m|5m|15m|1h|4h|1d and limit an integer in 1..1000",
        );
      }
      const market = deps.market.toBase58();
      const latest = deps.db.latestFillTimeMs(market);
      if (latest === null) {
        const data: CandlesResponse = { candles: [] };
        sendJson(res, 200, { ok: true, data } satisfies ApiResponse<CandlesResponse>);
        return;
      }
      const { intervalMs, limit } = query;
      // The compact window ends at the latest timed fill's bucket; never below 0.
      const windowFloor = Math.max(0, Math.floor(latest / intervalMs) * intervalMs - (limit - 1) * intervalMs);
      const fills = deps.db.listFillsSince(market, windowFloor, CANDLES_FILLS_SCAN_LIMIT);
      const data: CandlesResponse = { candles: aggregateCandles(fills, intervalMs, limit) };
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<CandlesResponse>);
      return;
    }

    case "GET /market/trades": {
      const limit = parseTradesLimit(url.searchParams);
      if (limit === null) {
        throw new BadRequestError("invalid trades query: limit must be an integer in 1..200");
      }
      const data: TradesResponse = {
        trades: deps.db.listRecentFills(deps.market.toBase58(), limit).map(toTradeView),
      };
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<TradesResponse>);
      return;
    }

    // -------------------------------------------------------- actions -------
    // REQ-B-5/D4: the API validates the request DTO and delegates to the
    // operator service (per-user FIFO queue, hot-key signing, tx_log). The
    // response is the tx_log row for the attempt — nothing is re-signed here.

    case "POST /actions/deposit": {
      const body = await readJsonBody(req);
      const amount = requireUintString(body, "amount");
      const user = (session as SessionInfo).wallet;
      await runAction(deps, res, user, () => deps.operator.executeDeposit(user, amount));
      return;
    }

    case "POST /actions/withdraw": {
      const body = await readJsonBody(req);
      const amount = requireUintString(body, "amount");
      const user = (session as SessionInfo).wallet;
      await runAction(deps, res, user, () => deps.operator.executeWithdraw(user, amount));
      return;
    }

    case "POST /actions/orders": {
      const body = await readJsonBody(req);
      const kind = body.kind;
      if (kind !== "limit" && kind !== "market") {
        throw new BadRequestError('kind must be "limit" or "market"');
      }
      const side = requireSide(body);
      const size = requireUintString(body, "size");
      const order: OrderAction =
        kind === "limit" ? { kind, side, size, price: requireUintString(body, "price") } : { kind, side, size };
      const user = (session as SessionInfo).wallet;
      await runAction(deps, res, user, () => deps.operator.executeOrder(user, order));
      return;
    }

    case "POST /actions/orders/cancel": {
      const body = await readJsonBody(req);
      const cancel: CancelAction = { side: requireSide(body), seq: requireUintString(body, "seq") };
      const user = (session as SessionInfo).wallet;
      await runAction(deps, res, user, () => deps.operator.executeCancel(user, cancel));
      return;
    }

    case "POST /actions/positions/close": {
      const body = await readJsonBody(req);
      const close: CloseAction = { side: requireSide(body), size: requireUintString(body, "size") };
      const user = (session as SessionInfo).wallet;
      await runAction(deps, res, user, () => deps.operator.executeClose(user, close));
      return;
    }

    case "POST /faucet": {
      if (deps.faucet === null) throw new FaucetDisabledError();
      const body = await readJsonBody(req);
      const wallet = requireString(body, "wallet");
      const data = await deps.faucet.handle({ wallet });
      sendJson(res, 200, { ok: true, data } satisfies ApiResponse<typeof data>);
      return;
    }

    default: {
      // Unreachable while every ROUTES entry has its case above; kept as the
      // not-implemented envelope for any route registered before its handler.
      req.resume();
      throw new NotImplementedError(`${route.method} ${route.path}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Bind helpers (D4)
// ---------------------------------------------------------------------------

/** Read + decode the on-chain perp market (collateral mint for the ATA derivation). */
async function readMarketState(deps: ApiServerDeps): Promise<PerpMarketState> {
  const info = await deps.connection.getAccountInfo(deps.market, "confirmed");
  const state = info === null ? null : decodePerpMarket(info.data);
  if (state === null) {
    throw new BadRequestError(`perp market ${deps.market.toBase58()} is not initialized on chain`);
  }
  return state;
}

/** The canonical associated token account for `(owner, mint)`. */
function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * The wallet-signable bind payload (`BindPrepareResponse.transaction`): the
 * base64 legacy transaction `[spl approve(Operator PDA, u64::MAX), set_operator]`
 * with the subject wallet as fee payer. It is serialized UNSIGNED — the wallet
 * adds its signature (and may re-stamp the blockhash) before submitting.
 */
async function buildBindTransaction(
  deps: ApiServerDeps,
  args: { wallet: PublicKey; userAta: PublicKey; operator: PublicKey },
): Promise<string> {
  const instructions = buildOperatorBindInstructions({
    user: args.wallet,
    market: deps.market,
    operator: args.operator,
    userAta: args.userAta,
    programId: deps.programId,
  });
  const tx = new Transaction().add(...instructions);
  tx.feePayer = args.wallet; // the user pays and signs once (D4)
  tx.recentBlockhash = await latestBlockhash(deps.connection);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

/** Fresh blockhash, or the default one when the RPC is unreachable (the wallet re-stamps). */
async function latestBlockhash(connection: Connection): Promise<string> {
  try {
    return (await connection.getLatestBlockhash("confirmed")).blockhash;
  } catch {
    return PublicKey.default.toBase58();
  }
}

interface BindIntent {
  /** The subject user the set_operator instruction is scoped to. */
  user: PublicKey;
  /** The delegate key the transaction stores. */
  operator: PublicKey;
}

/** Extract the `set_operator` intent from the prepared/confirmed transaction. */
function parseBindIntent(transactionB64: string, programId: PublicKey): BindIntent {
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(transactionB64, "base64"));
  } catch (err) {
    throw new BadRequestError(
      `transaction must be a base64-serialized Solana transaction (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const discriminator = IX_DISCRIMINATORS.set_operator;
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(programId)) continue;
    if (ix.data.length < 8 + 32) continue;
    if (!discriminator.every((byte, index) => ix.data[index] === byte)) continue;
    const user = ix.keys[0]?.pubkey;
    if (user === undefined) continue;
    return { user, operator: new PublicKey(ix.data.subarray(8, 40)) };
  }
  throw new BadRequestError("transaction carries no set_operator instruction (not a bind transaction)");
}

/**
 * The bind transaction must have actually landed: fetch it by signature and
 * require a successful execution paid/signed by the subject user. The on-chain
 * `Operator` record is then the authority for the reported status.
 */
async function verifyConfirmedTransaction(
  deps: ApiServerDeps,
  signature: string,
  user: PublicKey,
): Promise<void> {
  const tx = await deps.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (tx === null) {
    throw new BadRequestError(`transaction ${signature} is not confirmed on chain`);
  }
  const err = tx.meta === null ? null : tx.meta.err;
  if (err !== null && err !== undefined) {
    throw new BadRequestError(`transaction ${signature} failed on chain`);
  }
  const payer = tx.transaction.message.staticAccountKeys[0];
  if (payer === undefined || !payer.equals(user)) {
    throw new BadRequestError("the bind transaction must be paid and signed by the subject user");
  }
}

// ---------------------------------------------------------------------------
// History read (REQ-B-7): indexed fills + funding rows in seq order
// ---------------------------------------------------------------------------

function historyEntries(deps: ApiServerDeps, wallet: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const fill of deps.db.listFills({ owner: wallet })) {
    entries.push({
      kind: "fill",
      seq: String(fill.seq),
      slot: String(fill.slot),
      side: fill.side === 1 ? 1 : 0,
      price: fill.price,
      size: fill.size,
    });
  }
  for (const event of deps.db.listFundingEvents(deps.market.toBase58())) {
    entries.push({ kind: "funding", seq: String(event.seq), slot: String(event.slot), amount: event.amount });
  }
  entries.sort((a, b) => {
    const seqA = BigInt(a.seq);
    const seqB = BigInt(b.seq);
    if (seqA !== seqB) return seqA < seqB ? -1 : 1;
    const slotA = BigInt(a.slot);
    const slotB = BigInt(b.slot);
    return slotA === slotB ? 0 : slotA < slotB ? -1 : 1;
  });
  return entries;
}

// ---------------------------------------------------------------------------
// Action helper (REQ-B-5): validate → delegate → envelope (+ optional `tx` push)
// ---------------------------------------------------------------------------

async function runAction(
  deps: ApiServerDeps,
  res: ServerResponse,
  user: string,
  run: () => Promise<ActionResponse>,
): Promise<void> {
  const action = await run();
  deps.onAction?.(new PublicKey(user), action);
  sendJson(res, 200, { ok: true, data: action } satisfies ApiResponse<ActionResponse>);
}

/** `Authorization: Bearer *** → session, or `null` when absent/invalid. */
function authenticate(auth: AuthService, req: IncomingMessage): SessionInfo | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer (.+)$/i);
  if (match === null) return null;
  return auth.verifyToken(match[1].trim());
}

// ---------------------------------------------------------------------------
// Body + validation helpers
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1_000_000;

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequestError("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        reject(new BadRequestError("request body must be valid JSON"));
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        reject(new BadRequestError("request body must be a JSON object"));
        return;
      }
      resolve(parsed as Record<string, unknown>);
    });
    req.on("error", (err) => reject(err));
  });
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequestError(`${field} must be a non-empty string`);
  }
  return value;
}

/** A decimal string of a raw `u64` amount (the DTO convention: strings, not numbers). */
function requireUintString(body: Record<string, unknown>, field: string): bigint {
  const value = requireString(body, field);
  if (!/^\d+$/.test(value)) {
    throw new BadRequestError(`${field} must be an unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > 0xffff_ffff_ffff_ffffn) {
    throw new BadRequestError(`${field} exceeds the u64 range`);
  }
  return parsed;
}

function requireSide(body: Record<string, unknown>, field = "side"): 0 | 1 {
  const value = body[field];
  if (value !== 0 && value !== 1) {
    throw new BadRequestError(`${field} must be 0 (long) or 1 (short)`);
  }
  return value;
}

function requirePubkey(value: string, field: string): void {
  try {
    void new PublicKey(value);
  } catch {
    throw new BadRequestError(`${field} must be a base58 public key`);
  }
}

// ---------------------------------------------------------------------------
// Error mapping (unified envelope)
// ---------------------------------------------------------------------------

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof FaucetDisabledError) {
    sendJson(res, 404, { ok: false, error: { code: err.code, message: err.message } } satisfies ApiResponse<never>);
    return;
  }
  if (err instanceof FaucetCapError) {
    sendJson(res, 429, { ok: false, error: { code: err.code, message: err.message } } satisfies ApiResponse<never>);
    return;
  }
  if (err instanceof UnauthorizedError) {
    sendJson(res, 401, { ok: false, error: { code: err.code, message: err.message } } satisfies ApiResponse<never>);
    return;
  }
  if (err instanceof BadRequestError) {
    sendJson(res, 400, { ok: false, error: { code: err.code, message: err.message } } satisfies ApiResponse<never>);
    return;
  }
  if (err instanceof OperatorUnconfiguredError) {
    // SEC-10-1: the envelope must never carry the operator keypair path (or any
    // fs detail an upstream message embeds) — log the detail, emit a generic
    // operator-unavailable message.
    console.error(`fructus-server: operator unavailable: ${err.message}`);
    sendJson(res, 501, {
      ok: false,
      error: {
        code: err.code,
        message: "operator actions are unavailable: the operator keypair is not configured or unreadable",
      },
    } satisfies ApiResponse<never>);
    return;
  }
  if (err instanceof NotImplementedError) {
    sendJson(res, 501, { ok: false, error: { code: err.code, message: err.message } } satisfies ApiResponse<never>);
    return;
  }
  // Generic fallback. SEC-10-2: never echo raw internal error text (paths,
  // vendor messages) — the detail stays in the server log. D-07: when the
  // failure is an on-chain program error, surface its FructusError name as the
  // stable machine code instead of the opaque `internal`.
  const detail = err instanceof Error ? err.message : String(err);
  const programError = programErrorName(err);
  if (programError !== null) {
    console.error(`fructus-server: on-chain action failed (${programError}): ${detail}`);
    sendJson(res, 500, {
      ok: false,
      error: { code: programError, message: `on-chain action failed: ${programError}` },
    } satisfies ApiResponse<never>);
    return;
  }
  // F3 · TOKEN-BALANCE-ERROR-IS-4XX: the SPL Token program's `insufficient
  // funds` (error 0x1) is a client-side balance precondition, not an internal
  // fault. Measured: a deposit larger than the wallet's token balance returned
  // the opaque 500 `internal`; it maps to a stable 4xx domain error instead.
  if (isTokenInsufficientFunds(err)) {
    console.error(`fructus-server: on-chain action failed (insufficient token balance): ${detail}`);
    sendJson(res, 400, {
      ok: false,
      error: {
        code: "insufficient_token_balance",
        message: "on-chain action failed: the wallet's token balance is insufficient",
      },
    } satisfies ApiResponse<never>);
    return;
  }
  console.error(`fructus-server: internal error: ${detail}`);
  sendJson(res, 500, {
    ok: false,
    error: { code: "internal", message: "internal error" },
  } satisfies ApiResponse<never>);
}

/**
 * The SPL Token program id — present in the simulation text whenever the token
 * CPI runs; combined with an `insufficient funds` line it identifies the
 * token-balance shortfall (the failing and the invoking programs are distinct
 * log lines, so the two markers are matched across the joined text).
 */
const TOKEN_PROGRAM_ID_B58 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function isTokenInsufficientFunds(err: unknown): boolean {
  const texts: string[] = [];
  const logs = (err as { logs?: unknown }).logs;
  if (Array.isArray(logs)) {
    for (const line of logs) if (typeof line === "string") texts.push(line);
  }
  if (err instanceof Error) texts.push(err.message);
  else if (typeof err === "string") texts.push(err);
  const joined = texts.join("\n");
  return joined.includes(TOKEN_PROGRAM_ID_B58) && /insufficient funds/i.test(joined);
}

// ---------------------------------------------------------------------------
// FructusError mapping (D-07): Anchor program errors → stable envelope codes
// ---------------------------------------------------------------------------

/**
 * `FructusError` variant names in declaration order
 * (`programs/fructus/src/error.rs`); Anchor's `#[error_code]` assigns
 * `ERROR_CODE_OFFSET` (6000) + variant index, so this table is the canonical
 * code → name mapping for the program's custom errors.
 */
const FRUCTUS_ERROR_NAMES = [
  "ApyTooHigh",
  "StaleVersion",
  "InvalidSignature",
  "SignatureMissing",
  "InvalidStakePool",
  "InvalidFundingK",
  "InvalidMaxFunding",
  "InvalidInitialMargin",
  "InvalidMaintenanceMargin",
  "BookFull",
  "BookAlreadyInitialized",
  "BookNotInitialized",
  "InvalidPrice",
  "InvalidSize",
  "OrderNotFound",
  "OrderOwnerMismatch",
  "SelfTrade",
  "InvalidMint",
  "InsufficientFreeCollateral",
  "VaultAlreadyInitialized",
  "VaultNotInitialized",
  "ArithmeticOverflow",
  "PositionNotFound",
  "NotLiquidatable",
  "EventNotFound",
  "InvalidCloseSize",
  "PositionPdaSquatted",
  "OperatorUnauthorized",
  "OperatorPdaSquatted",
] as const;

/** Anchor's custom-error base (`anchor_lang::error::ERROR_CODE_OFFSET`). */
const FRUCTUS_ERROR_OFFSET = 6_000;

/** Map a custom program error number to its FructusError name; unknown → null. */
function fructusErrorNameFromCode(code: number): string | null {
  const index = code - FRUCTUS_ERROR_OFFSET;
  return index >= 0 && index < FRUCTUS_ERROR_NAMES.length ? FRUCTUS_ERROR_NAMES[index] : null;
}

/**
 * Extract the program error from a failed-transaction error: web3.js
 * `SendTransactionError`s carry `logs`, and the same patterns ride the message.
 * Recognized: `custom program error: 0x<hex>`, `Error Code: <NAME>`,
 * `Error Number: <n>`. Anything unrecognized (or non-Fructus) → `null`, and the
 * caller keeps the redacted 500.
 */
function programErrorName(err: unknown): string | null {
  const texts: string[] = [];
  const logs = (err as { logs?: unknown }).logs;
  if (Array.isArray(logs)) {
    for (const line of logs) if (typeof line === "string") texts.push(line);
  }
  if (err instanceof Error) texts.push(err.message);
  else if (typeof err === "string") texts.push(err);

  const knownNames = new Set<string>(FRUCTUS_ERROR_NAMES);
  for (const text of texts) {
    const byName = /Error Code:\s*([A-Za-z][A-Za-z0-9_]*)/.exec(text);
    if (byName !== null && knownNames.has(byName[1])) return byName[1];
    const byHex = /custom program error:\s*0x([0-9a-fA-F]+)/.exec(text);
    if (byHex !== null) {
      const name = fructusErrorNameFromCode(Number.parseInt(byHex[1], 16));
      if (name !== null) return name;
    }
    const byNumber = /Error Number:\s*(\d+)/.exec(text);
    if (byNumber !== null) {
      const name = fructusErrorNameFromCode(Number(byNumber[1]));
      if (name !== null) return name;
    }
  }
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
