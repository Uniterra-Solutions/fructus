//! RED acceptance test for product-v3 REQ-F-2 (typed REST client contract).
//! Table-driven over every ApiClient method: exact URL + init, JWT exactly on
//! the gated routes, and the error envelope mapped to a typed ApiError.
//!
//! RED on today's tree: every `createApiClient` method resolves a placeholder
//! `{}` without ever calling fetch — the first assertion (fetch called exactly
//! once) fails on every row, never on a compile/import error.

import { expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../src/api/client.js";
import type { ApiClient } from "../src/api/client.js";

const TOKEN = "tok.abc.123";
const WALLET = "WALLET11111111111111111111111111111111";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/** fetch double resolving one fixed envelope payload. */
function mkFetch(payload: unknown, status = 200) {
  return vi.fn(async (_input: FetchInput, _init?: FetchInit): Promise<Response> => {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

/** Read a request header from whatever HeadersInit shape the client passed. */
function headerValue(init: FetchInit, name: string): string | null {
  const raw = init?.headers as unknown;
  if (raw === undefined || raw === null) return null;
  if (typeof Headers !== "undefined" && raw instanceof Headers) return raw.get(name);
  if (Array.isArray(raw)) {
    for (const entry of raw as [string, string][]) {
      if (String(entry[0]).toLowerCase() === name) return String(entry[1]);
    }
    return null;
  }
  if (typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (key.toLowerCase() === name) return value === undefined ? null : String(value);
    }
  }
  return null;
}

interface Row {
  name: string;
  url: string;
  method: "GET" | "POST";
  /** Expected Authorization value; null = the header must be absent. */
  auth: string | null;
  /** Exact JSON body for POSTs. */
  body?: unknown;
  call(client: ApiClient): Promise<unknown>;
  payload: unknown;
}

const ROWS: Row[] = [
  {
    name: "challenge",
    url: "/api/auth/challenge",
    method: "POST",
    auth: null,
    body: { wallet: WALLET },
    call: (client) => client.challenge(WALLET),
    payload: {
      signInInput: "fructus wants you to sign in",
      nonce: "nonce-1",
      expiresAt: "2026-10-08T10:00:00.000Z",
    },
  },
  {
    name: "verify",
    url: "/api/auth/verify",
    method: "POST",
    auth: null,
    body: { wallet: WALLET, signature: "SIG_B58", signInInput: "SIGN-IN-INPUT" },
    call: (client) => client.verify({ wallet: WALLET, signature: "SIG_B58", signInInput: "SIGN-IN-INPUT" }),
    payload: { token: TOKEN, wallet: WALLET },
  },
  {
    name: "bindPrepare",
    url: "/api/bind/prepare",
    method: "POST",
    auth: null,
    body: { wallet: WALLET },
    call: (client) => client.bindPrepare(WALLET),
    payload: { transaction: "BASE64-TX", operator: "OPERATOR111", operatorRecord: "OPREC111" },
  },
  {
    name: "bindConfirm",
    url: "/api/bind/confirm",
    method: "POST",
    auth: null,
    body: { transaction: "BASE64-SIGNED-TX", signature: "TX-SIG-B58" },
    call: (client) => client.bindConfirm("BASE64-SIGNED-TX", "TX-SIG-B58"),
    payload: { status: "bound", operator: "OPERATOR111" },
  },
  {
    name: "me",
    url: "/api/me",
    method: "GET",
    auth: TOKEN,
    call: (client) => client.me(TOKEN),
    payload: {
      wallet: WALLET,
      deposited: "1000000",
      reserved: "0",
      claimable: "0",
      free: "1000000",
      equity: "1000000",
      requirementInitial: "0",
      requirementMaint: "0",
      health: "healthy",
      operator: null,
      positions: [],
    },
  },
  {
    name: "positions",
    url: "/api/me/positions",
    method: "GET",
    auth: TOKEN,
    call: (client) => client.positions(TOKEN),
    payload: { positions: [] },
  },
  {
    name: "market",
    url: "/api/market",
    method: "GET",
    auth: null,
    call: (client) => client.market(),
    payload: { mark: null, index: "1000000000", fundingRate: "0", fundingAccumulator: "0", bestBid: null, bestAsk: null },
  },
  {
    name: "book",
    url: "/api/market/book",
    method: "GET",
    auth: null,
    call: (client) => client.book(),
    payload: { bids: [["1000000", "500000"]], asks: [["1100000", "600000"]] },
  },
  {
    name: "candles(1m)",
    url: "/api/market/candles?interval=1m",
    method: "GET",
    auth: null,
    call: (client) => client.candles("1m"),
    payload: {
      candles: [{ timeMs: "60000", open: "10", high: "12", low: "10", close: "12", volume: "3", trades: 2 }],
    },
  },
  {
    name: "candles(5m,120)",
    url: "/api/market/candles?interval=5m&limit=120",
    method: "GET",
    auth: null,
    call: (client) => client.candles("5m", 120),
    payload: { candles: [] },
  },
  {
    name: "trades()",
    url: "/api/market/trades",
    method: "GET",
    auth: null,
    call: (client) => client.trades(),
    payload: {
      trades: [
        { seq: "7", slot: "100", timeMs: "1699999999000", owner: "OWNER", side: 1, price: "1000000", size: "500000" },
      ],
    },
  },
  {
    name: "trades(30)",
    url: "/api/market/trades?limit=30",
    method: "GET",
    auth: null,
    call: (client) => client.trades(30),
    payload: { trades: [] },
  },
  {
    name: "deposit",
    url: "/api/actions/deposit",
    method: "POST",
    auth: TOKEN,
    body: { amount: "1500000" },
    call: (client) => client.deposit(TOKEN, "1500000"),
    payload: { actionId: "act-deposit", status: "queued" },
  },
  {
    name: "withdraw",
    url: "/api/actions/withdraw",
    method: "POST",
    auth: TOKEN,
    body: { amount: "250000" },
    call: (client) => client.withdraw(TOKEN, "250000"),
    payload: { actionId: "act-withdraw", status: "queued" },
  },
  {
    name: "placeOrder",
    url: "/api/actions/orders",
    method: "POST",
    auth: TOKEN,
    body: { kind: "limit", side: 0, size: "1000000", price: "1000000" },
    call: (client) =>
      client.placeOrder(TOKEN, { kind: "limit", side: 0, size: "1000000", price: "1000000" }),
    payload: { actionId: "act-order", status: "queued" },
  },
  {
    name: "cancelOrder",
    url: "/api/actions/orders/cancel",
    method: "POST",
    auth: TOKEN,
    body: { side: 1, seq: "7" },
    call: (client) => client.cancelOrder(TOKEN, { side: 1, seq: "7" }),
    payload: { actionId: "act-cancel", status: "queued" },
  },
  {
    name: "closePosition",
    url: "/api/actions/positions/close",
    method: "POST",
    auth: TOKEN,
    body: { side: 0, size: "500000" },
    call: (client) => client.closePosition(TOKEN, { side: 0, size: "500000" }),
    payload: { actionId: "act-close", status: "queued" },
  },
  {
    name: "faucet",
    url: "/api/faucet",
    method: "POST",
    auth: null,
    body: { wallet: WALLET },
    call: (client) => client.faucet(WALLET),
    payload: { amount: "1000000000", ata: "ATA111" },
  },
];

it("API-CLIENT-CONTRACT: every client function issues the exact method/path/request body, attaches the JWT exactly on the gated routes, and maps the error envelope to a typed error", async () => {
  // Harness precondition: the fetch double needs the Response global.
  expect(typeof Response).toBe("function");

  for (const row of ROWS) {
    const fetchMock = mkFetch({ ok: true, data: row.payload });
    const client = createApiClient("/api", fetchMock);

    const result = await row.call(client);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(row.url);
    expect(init?.method).toBe(row.method);

    if (row.auth === null) {
      expect(headerValue(init, "authorization")).toBeNull();
    } else {
      expect(headerValue(init, "authorization")).toBe(`Bearer ${row.auth}`);
    }

    if (row.method === "POST") {
      expect(headerValue(init, "content-type")).toBe("application/json");
      expect(typeof init?.body).toBe("string");
      expect(JSON.parse(String(init?.body))).toEqual(row.body);
    } else {
      expect(init?.body ?? null).toBeNull();
    }

    expect(result).toEqual(row.payload);
  }

  // Error envelope → typed ApiError {code, status, message}.
  const errorCases = [
    { envelope: { ok: false, error: { code: "bad_request", message: "x" } }, status: 400 },
    { envelope: { ok: false, error: { code: "unauthorized", message: "y" } }, status: 401 },
  ];
  for (const errorCase of errorCases) {
    const fetchMock = mkFetch(errorCase.envelope, errorCase.status);
    const client = createApiClient("/api", fetchMock);

    const outcome = await client.me(TOKEN).then(
      (value) => ({ resolved: true as const, value }),
      (error: unknown) => ({ resolved: false as const, error }),
    );

    expect(outcome.resolved).toBe(false);
    const typedError = (outcome as { resolved: false; error: unknown }).error;
    expect(typedError).toBeInstanceOf(ApiError);
    const apiError = typedError as ApiError;
    expect({ code: apiError.code, status: apiError.status, message: apiError.message }).toEqual({
      code: errorCase.envelope.error.code,
      status: errorCase.status,
      message: errorCase.envelope.error.message,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
});
