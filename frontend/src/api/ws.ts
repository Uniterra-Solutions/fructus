//! Push-socket client: `/ws?token=…`, reconnect with ×2 backoff from a base
//! (default 500 ms) capped (default 10 s) and reset on a successful open;
//! `close()` stops permanently (no resurrection, even mid-backoff).

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

export function createWsClient(opts: WsClientOptions): WsClient {
  const baseMs = opts.reconnectBaseMs ?? 500;
  const capMs = opts.reconnectCapMs ?? 10_000;
  const createSocket = opts.createSocket ?? ((url: string): WebSocket => new WebSocket(url));

  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const report = (status: WsStatus): void => {
    opts.onStatus?.(status);
  };

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) return;
    const delay = Math.min(baseMs * 2 ** attempt, capMs);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (stopped) return;
    report("connecting");
    const next = createSocket(`${opts.url}?token=${encodeURIComponent(opts.token)}`);
    socket = next;

    next.onopen = () => {
      if (stopped || next !== socket) return;
      attempt = 0;
      report("open");
    };

    next.onmessage = (event: MessageEvent) => {
      if (stopped) return;
      const raw: unknown = event.data;
      if (typeof raw !== "string") return;
      try {
        opts.onMessage(JSON.parse(raw) as ServerWsMessage);
      } catch {
        /* malformed frame: drop it */
      }
    };

    next.onerror = () => {
      /* surface as a close event; reconnect policy lives in onclose */
    };

    next.onclose = () => {
      if (stopped || next !== socket) return;
      socket = null;
      report("closed");
      scheduleReconnect();
    };
  }

  function close(): void {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const current = socket;
    socket = null;
    if (current !== null) {
      // Detach first so a synchronously-firing close() cannot resurrect the client.
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      try {
        current.close();
      } catch {
        /* already closed */
      }
    }
    report("closed");
  }

  connect();

  return { close };
}
