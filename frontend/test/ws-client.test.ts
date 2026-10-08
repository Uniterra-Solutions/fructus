//! REQ-F-3 (reconnect/backoff half) · WS-RECONNECT-BACKOFF — frontend red baseline (product-v3).
//! Pins: immediate connect to `url?token=…`, status transitions, parsed message
//! delivery, ×2 backoff from 500 ms capped at 10 s with reset on open, and a
//! permanent stop after close().

import { afterEach, expect, it, vi } from "vitest";
import { createWsClient } from "../src/api/ws.js";

type Listener = (event: unknown) => void;

class FakeSocket {
  readonly url: string;
  private readonly listeners = new Map<string, Listener[]>();
  onopen: Listener | null = null;
  onclose: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((entry) => entry !== listener));
  }

  close(): void {
    // The client owns reconnect policy; the fake only records that close() happened.
  }

  /** Dispatch a lifecycle event to both addEventListener and on* handlers. */
  emit(type: "open" | "close" | "error"): void {
    const event = { type };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    if (type === "open" && this.onopen) this.onopen(event);
    if (type === "close" && this.onclose) this.onclose(event);
    if (type === "error" && this.onerror) this.onerror(event);
  }

  emitMessage(data: string): void {
    const event = { data };
    for (const listener of this.listeners.get("message") ?? []) listener(event);
    if (this.onmessage) this.onmessage(event);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

it(`WS-RECONNECT-BACKOFF: the client connects immediately to url?token=…, reports connecting→open, delivers parsed messages, reconnects on a ×2 backoff from a 500 ms base capped at 10 s (reset on open), and close() stops it permanently`, () => {
  vi.useFakeTimers();

  const sockets: FakeSocket[] = [];
  const onMessage = vi.fn();
  const onStatus = vi.fn();

  const client = createWsClient({
    url: "ws://test/ws",
    token: "tok",
    onMessage,
    onStatus,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });

  const last = (): FakeSocket => sockets[sockets.length - 1];

  // Connects immediately, token attached.
  expect(sockets.length).toBe(1);
  if (sockets.length === 0) return;
  expect(sockets[0].url).toBe("ws://test/ws?token=tok");
  expect(onStatus).toHaveBeenCalledWith("connecting");

  // Open flips the status; messages arrive parsed.
  sockets[0].emit("open");
  expect(onStatus).toHaveBeenLastCalledWith("open");

  sockets[0].emitMessage('{"type":"book","market":"m","book":{"bids":[],"asks":[]}}');
  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith({ type: "book", market: "m", book: { bids: [], asks: [] } });

  // Backoff ×2 from the 500 ms base…
  last().emit("close");
  vi.advanceTimersByTime(499);
  expect(sockets.length).toBe(1);
  vi.advanceTimersByTime(1);
  expect(sockets.length).toBe(2);

  last().emit("close");
  vi.advanceTimersByTime(999);
  expect(sockets.length).toBe(2);
  vi.advanceTimersByTime(1);
  expect(sockets.length).toBe(3);

  last().emit("close");
  vi.advanceTimersByTime(1999);
  expect(sockets.length).toBe(3);
  vi.advanceTimersByTime(1);
  expect(sockets.length).toBe(4);

  last().emit("close");
  vi.advanceTimersByTime(3999);
  expect(sockets.length).toBe(4);
  vi.advanceTimersByTime(1);
  expect(sockets.length).toBe(5);

  last().emit("close");
  vi.advanceTimersByTime(7999);
  expect(sockets.length).toBe(5);
  vi.advanceTimersByTime(1);
  expect(sockets.length).toBe(6);

  // …capped at 10 s: the would-be 16 s wait is clamped, not honoured.
  last().emit("close");
  vi.advanceTimersByTime(9999);
  expect(sockets.length).toBe(6);
  vi.advanceTimersByTime(1);
  expect(sockets.length).toBe(7);

  // A successful open resets the backoff to the base.
  last().emit("open");
  last().emit("close");
  vi.advanceTimersByTime(499);
  expect(sockets.length).toBe(7);
  vi.advanceTimersByTime(1);
  expect(sockets.length).toBe(8);

  // close() stops reconnecting for good.
  client.close();
  const stopped = sockets.length;
  last().emit("close");
  vi.advanceTimersByTime(60_000);
  expect(sockets.length).toBe(stopped);
});
