//! WebSocket push surface (REQ-B-7): `/ws?token=…` upgrades, the token is
//! checked against `auth.verifyToken`, and unknown/invalid tokens are closed
//! with code 4401. STUB: no push traffic yet — once the sessions land,
//! authenticated sockets are subscribed to `book`/`mark`/`user`/`tx` messages
//! (`ServerWsMessage` in `sdk/src/api.ts`) fed by the indexer's update event.

import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerWsMessage } from "fructus-sdk/src/api.js";
import type { AuthService } from "./auth.js";
import type { Db } from "./db.js";

/** Close code for a missing / invalid / expired WS token (REQ-B-7). */
export const WS_UNAUTHORIZED = 4401;

export interface WsHandle {
  wss: WebSocketServer;
  /** Fan a push message out to every authenticated socket. */
  broadcast(message: ServerWsMessage): void;
  close(): Promise<void>;
}

export interface WsOptions {
  /** The HTTP server the upgrade handler attaches to. */
  server: Server;
  auth: AuthService;
  db: Db;
}

export function attachWs(opts: WsOptions): WsHandle {
  const wss = new WebSocketServer({ server: opts.server, path: "/ws" });

  wss.on("connection", (socket: WebSocket, request) => {
    const url = new URL(request.url ?? "/ws", "http://localhost");
    const token = url.searchParams.get("token");
    const session = token === null ? null : opts.auth.verifyToken(token);
    if (session === null) {
      // STUB behavior is exactly this: verifyToken() returns null until the
      // session wave lands, so every connection closes 4401 for now.
      socket.close(WS_UNAUTHORIZED, "unauthorized");
      return;
    }
    // STUB: subscribe the authenticated socket to book/mark/user/tx pushes.
    // Ping/pong and unsubscribe-on-close also land with the push wave.
    void opts.db;
  });

  return {
    wss,

    broadcast(message: ServerWsMessage): void {
      // STUB: fan out to every open, authenticated socket.
      const payload = JSON.stringify(message);
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(payload);
      }
    },

    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      });
    },
  };
}
