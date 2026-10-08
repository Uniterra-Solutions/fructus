//! WebSocket push surface (REQ-B-7): `/ws?token=…` upgrades, the token is
//! checked against `auth.verifyToken`, and unknown/invalid tokens are closed
//! with code 4401. Authenticated sockets receive the `book`/`mark`/`user`/`tx`
//! messages of `ServerWsMessage` (`sdk/src/api.ts`), fed by the indexer's
//! update event (`indexer.onUpdate`):
//!
//!  - `order_book` changes fan a fresh `book` (+ `mark`) out to every socket;
//!  - `market` changes fan a fresh `mark` out to every socket;
//!  - newly persisted fills (`update.fills`, product-v3 REQ-K-4) fan one
//!    `trade` message per fill out to every socket, ascending by seq;
//!  - a wallet's own account changes (`user_collateral`, `position`, `operator`)
//!    push that wallet's portfolio CHANGE to its sockets only: the delta of the
//!    wallet's portfolio against the state at connect / its last push.
//!
//! `WS-PUSHES-STATE-CHANGES` pins the per-wallet payload as the change: after a
//! 25 tUSDC deposit onto a ledger seeded at 1 tUSDC it requires
//! `portfolio.deposited === "25000000"` — the pushed change ("the deposit inside
//! the test is the pushed change"), never the 26 tUSDC ledger total. The REST
//! reads (`GET /me`) stay the absolute snapshot; a subscribed client applies
//! each pushed change to the state it read at connect.
//!
//! The channel is push-only (the client never sends application messages);
//! closed/errored sockets leave the registry so pushes never touch them.

import type { Server } from "node:http";
import { PublicKey } from "@solana/web3.js";
import { WebSocketServer, type WebSocket } from "ws";
import type { BookView, MarketView, PositionView, ServerWsMessage, UserPortfolio } from "fructus-sdk/src/api.js";
import { operatorPda, positionPda, userCollateralPda } from "fructus-sdk/src/index.js";
import type { AuthService } from "./auth.js";
import type { IndexerUpdate } from "./indexer.js";
import { toTradeView } from "./market-data.js";

/** Close code for a missing / invalid / expired WS token (REQ-B-7). */
export const WS_UNAUTHORIZED = 4401;

export interface WsHandle {
  wss: WebSocketServer;
  /** Fan a push message out to every authenticated socket. */
  broadcast(message: ServerWsMessage): void;
  /** Send a push message to every socket of `wallet`. */
  sendToWallet(wallet: string, message: ServerWsMessage): void;
  /** Fan one indexer update out to the sockets it concerns. */
  onIndexerUpdate(update: IndexerUpdate): void;
  close(): Promise<void>;
}

export interface WsOptions {
  /** The HTTP server the upgrade handler attaches to. */
  server: Server;
  auth: AuthService;
  /** The perp market the subscriptions are scoped to. */
  market: PublicKey;
  /** Read models (state.ts) — the fresh payloads for each push. */
  computePortfolio: (wallet: PublicKey) => UserPortfolio | Promise<UserPortfolio>;
  computeBook: () => BookView | Promise<BookView>;
  computeMarket: () => MarketView | Promise<MarketView>;
}

interface Client {
  socket: WebSocket;
  wallet: string;
}

export function attachWs(opts: WsOptions): WsHandle {
  const wss = new WebSocketServer({ server: opts.server, path: "/ws" });
  const clients = new Map<WebSocket, Client>();
  // Per-wallet delta baseline: the portfolio state the subscribed client starts
  // from (seeded when a socket connects) and the last state pushed after that.
  const baselines = new Map<string, UserPortfolio>();
  // Bumped whenever a push advances a wallet's baseline; a connect-time seed
  // freezes it and skips its own write if a push raced it (newer state wins).
  const baselineVersions = new Map<string, number>();
  const market = opts.market.toBase58();

  wss.on("connection", (socket: WebSocket, request) => {
    const url = new URL(request.url ?? "/ws", "http://localhost");
    const token = url.searchParams.get("token");
    const session = token === null ? null : opts.auth.verifyToken(token);
    if (session === null) {
      // A push path that never gates is not a subscription (REQ-B-7): refuse.
      socket.close(WS_UNAUTHORIZED, "unauthorized");
      return;
    }
    clients.set(socket, { socket, wallet: session.wallet });
    const forget = (): void => {
      clients.delete(socket);
    };
    socket.on("close", forget);
    socket.on("error", forget);

    // Seed the change baseline from the wallet's indexed portfolio at connect
    // (what the client's REST snapshot carries). A failure leaves no baseline:
    // pushes then fall back to the absolute snapshot. A seed that resolves
    // after a push already advanced the baseline must NOT overwrite it — the
    // pushed state is newer, and a stale overwrite double-counts the next
    // delta for the client.
    void (async () => {
      try {
        const version = baselineVersions.get(session.wallet) ?? 0;
        const portfolio = await opts.computePortfolio(new PublicKey(session.wallet));
        if (!clients.has(socket)) return;
        if ((baselineVersions.get(session.wallet) ?? 0) !== version) return;
        baselines.set(session.wallet, portfolio);
      } catch {
        /* no baseline — absolute snapshots only */
      }
    })();
  });

  function send(socket: WebSocket, message: ServerWsMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  function broadcast(message: ServerWsMessage): void {
    for (const client of clients.values()) send(client.socket, message);
  }

  function sendToWallet(wallet: string, message: ServerWsMessage): void {
    for (const client of clients.values()) {
      if (client.wallet === wallet) send(client.socket, message);
    }
  }

  /**
   * The wallet (among the connected ones) whose derived account is `update`'s
   * pubkey — the per-wallet account kinds are keyed by PDA, so the mapping is
   * resolved by deriving each subscribed wallet's PDAs and comparing.
   */
  function walletFor(update: IndexerUpdate): string | null {
    for (const client of clients.values()) {
      if (client.wallet === update.pubkey) return client.wallet;
      let wallet: PublicKey;
      try {
        wallet = new PublicKey(client.wallet);
      } catch {
        continue;
      }
      if (update.kind === "user_collateral") {
        if (userCollateralPda(opts.market, wallet).address.toBase58() === update.pubkey) return client.wallet;
      } else if (update.kind === "position") {
        const long = positionPda(opts.market, wallet, 0).address.toBase58();
        const short = positionPda(opts.market, wallet, 1).address.toBase58();
        if (update.pubkey === long || update.pubkey === short) return client.wallet;
      } else if (update.kind === "operator") {
        if (operatorPda(opts.market, wallet).address.toBase58() === update.pubkey) return client.wallet;
      }
    }
    return null;
  }

  /** Turn one indexed account change into the matching push message(s). */
  async function dispatchUpdate(update: IndexerUpdate): Promise<void> {
    // REQ-K-4: newly persisted fills fan out to every socket as `trade`
    // messages, ascending by seq (the update carries them in order; a
    // re-delivered/duplicate fill never reaches this field).
    if (update.fills !== undefined) {
      for (const fill of update.fills) {
        broadcast({ type: "trade", market, trade: toTradeView(fill) });
      }
    }
    if (update.kind === "order_book") {
      broadcast({ type: "book", market, book: await opts.computeBook() });
      broadcast({ type: "mark", market, mark: await opts.computeMarket() });
      return;
    }
    if (update.kind === "market") {
      broadcast({ type: "mark", market, mark: await opts.computeMarket() });
      return;
    }
    const wallet = walletFor(update);
    if (wallet === null) return; // no subscribed socket of the owning wallet
    const next = await opts.computePortfolio(new PublicKey(wallet));
    const base = baselines.get(wallet);
    baselines.set(wallet, next);
    baselineVersions.set(wallet, (baselineVersions.get(wallet) ?? 0) + 1);
    if (base !== undefined && !portfolioChanged(next, base)) return; // no-op delivery
    sendToWallet(wallet, { type: "user", portfolio: base === undefined ? next : portfolioChange(next, base) });
  }

  return {
    wss,
    broadcast,
    sendToWallet,

    onIndexerUpdate(update: IndexerUpdate): void {
      dispatchUpdate(update).catch((err: unknown) => {
        console.error(`fructus-server: ws push failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },

    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        for (const client of clients.values()) client.socket.terminate();
        clients.clear();
        wss.close(() => resolve());
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Portfolio change (the per-wallet `user` payload)
// ---------------------------------------------------------------------------

const diff = (next: string, base: string): string => (BigInt(next) - BigInt(base)).toString();

/** Did anything the `user` message carries actually move between `base` and `next`? */
function portfolioChanged(next: UserPortfolio, base: UserPortfolio): boolean {
  if (next.deposited !== base.deposited) return true;
  if (next.reserved !== base.reserved) return true;
  if (next.claimable !== base.claimable) return true;
  if (next.free !== base.free) return true;
  if (next.equity !== base.equity) return true;
  if (next.requirementInitial !== base.requirementInitial) return true;
  if (next.requirementMaint !== base.requirementMaint) return true;
  if (next.health !== base.health) return true;
  if (JSON.stringify(next.operator) !== JSON.stringify(base.operator)) return true;
  return JSON.stringify(next.positions) !== JSON.stringify(base.positions);
}

/**
 * The wallet's portfolio CHANGE from `base` to `next` (the per-wallet push
 * payload): every numeric field is the signed delta; `health`/`operator` carry
 * the current state (an enum / delegate has no delta); a side's position view is
 * included only when its contribution actually moved.
 */
function portfolioChange(next: UserPortfolio, base: UserPortfolio): UserPortfolio {
  const positions: PositionView[] = [];
  const sides = new Set<number>();
  for (const position of next.positions) sides.add(position.side);
  for (const position of base.positions) sides.add(position.side);
  for (const side of [...sides].sort((a, b) => a - b)) {
    const after = next.positions.find((position) => position.side === side);
    const before = base.positions.find((position) => position.side === side);
    const view: PositionView = {
      side: side === 1 ? 1 : 0,
      notional: diff(after?.notional ?? "0", before?.notional ?? "0"),
      upnl: diff(after?.upnl ?? "0", before?.upnl ?? "0"),
      reqInitial: diff(after?.reqInitial ?? "0", before?.reqInitial ?? "0"),
      reqMaint: diff(after?.reqMaint ?? "0", before?.reqMaint ?? "0"),
    };
    if (
      view.notional === "0" &&
      view.upnl === "0" &&
      view.reqInitial === "0" &&
      view.reqMaint === "0"
    ) {
      continue; // the side did not move
    }
    positions.push(view);
  }
  return {
    wallet: next.wallet,
    deposited: diff(next.deposited, base.deposited),
    reserved: diff(next.reserved, base.reserved),
    claimable: diff(next.claimable, base.claimable),
    free: diff(next.free, base.free),
    equity: diff(next.equity, base.equity),
    requirementInitial: diff(next.requirementInitial, base.requirementInitial),
    requirementMaint: diff(next.requirementMaint, base.requirementMaint),
    health: next.health,
    operator: next.operator,
    positions,
  };
}
