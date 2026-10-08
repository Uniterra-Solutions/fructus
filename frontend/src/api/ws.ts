//! Push-socket client: `/ws?token=…`, reconnect with backoff.
//! Stub — product-v3 freeze.

import type { ServerWsMessage } from "fructus-sdk/src/api.js";

export type WsStatus = "connecting" | "open" | "closed";

export interface WsClientOptions {
  url: string;
  token: string;
  onMessage: (message: ServerWsMessage) => void;
  onStatus?: (status: WsStatus) => void;
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
  /** Test seam: build the underlying socket (defaults to `new WebSocket(url)`). */
  createSocket?: (url: string) => WebSocket;
}

export interface WsClient {
  close(): void;
}

export function createWsClient(_opts: WsClientOptions): WsClient {
  return {
    close() {
      /* stub */
    },
  };
}
