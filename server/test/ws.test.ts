//! RED acceptance test for the WebSocket push surface (REQ-B-7, D14):
//! `WS-PUSHES-STATE-CHANGES` — a subscribed client receives the matching
//! update within one state change.
//!
//! The proposition drives the real server: a hermetic validator seeded through
//! the SDK builders, a real SIWS login token, and a real `ws` client against
//! `/ws?token=…`. State changes are made directly on-chain (user-signed) while
//! the socket is open:
//!  1. a deposit must push a `user` message whose portfolio reflects the new
//!     `deposited` (bounded wait; the failure quotes everything received);
//!  2. a resting limit order must push at least one `book`/`mark` message
//!     reflecting the new level.
//! The negative control first: a socket that cannot authenticate is closed
//! with 4401 — a push path that never gates is not a subscription.
//!
//! RED on today's tree: every route but `/healthz` answers 501 (so the SIWS
//! login leg fails behaviourally), `auth.verifyToken()` returns `null` (every
//! socket closes 4401), and the WS layer pushes nothing.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { WebSocket, type RawData } from "ws";
import type {
  ApiResponse,
  BookView,
  ChallengeResponse,
  MarketView,
  SessionResponse,
  UserPortfolio,
} from "fructus-sdk/src/api.js";
import { buildDepositCollateral, buildPlaceLimitOrder } from "fructus-sdk/src/index.js";
import {
  createMint,
  fundTrader,
  initMarket,
  startServer,
  startValidator,
  stopAll,
  submit,
  type MarketEnv,
  type ServerHandle,
  type Validator,
} from "./harness.js";

after(async () => {
  await stopAll();
});

// ---------------------------------------------------------------------------
// HTTP + SIWS helpers (ed25519 via node:crypto; vectors verified locally first)
// ---------------------------------------------------------------------------

interface JsonResponse {
  status: number;
  body: ApiResponse<unknown> | null;
  text: string;
}

async function call(
  server: ServerHandle,
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: ApiResponse<unknown> | null = null;
  try {
    body = JSON.parse(text) as ApiResponse<unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

function expectOk<T>(res: JsonResponse, what: string): T {
  assert.equal(res.status, 200, `${what} must answer 200 (got ${res.status}: ${res.text.slice(0, 200)})`);
  const body = res.body;
  assert.ok(body !== null, `${what} must answer the unified JSON envelope (got: ${res.text.slice(0, 200)})`);
  assert.equal(body.ok, true, `${what} must use the success envelope (got ${res.text.slice(0, 200)})`);
  return (body as { ok: true; data: T }).data;
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

interface SiwsSigner {
  keypair: Keypair;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

function makeSigner(keypair: Keypair): SiwsSigner {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(keypair.secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(keypair.publicKey.toBytes())]),
    format: "der",
    type: "spki",
  });
  return { keypair, privateKey, publicKey };
}

function signSiws(signer: SiwsSigner, message: string): string {
  const bytes = Buffer.from(message, "utf8");
  const signature = edSign(null, bytes, signer.privateKey);
  assert.ok(
    edVerify(null, bytes, signer.publicKey, signature),
    "test-vector sanity: the locally produced ed25519 signature must verify against the locally derived key",
  );
  return base58Encode(signature);
}

async function login(server: ServerHandle, signer: SiwsSigner): Promise<string> {
  const wallet = signer.keypair.publicKey.toBase58();
  const challenge = expectOk<ChallengeResponse>(
    await call(server, "POST", "/auth/challenge", { body: { wallet } }),
    `POST /auth/challenge for ${wallet}`,
  );
  const signature = signSiws(signer, challenge.signInInput);
  const session = expectOk<SessionResponse>(
    await call(server, "POST", "/auth/verify", { body: { wallet, signature, signInInput: challenge.signInInput } }),
    `POST /auth/verify for ${wallet}`,
  );
  assert.equal(session.wallet, wallet, "the session must belong to the signing wallet");
  return session.token;
}

// ---------------------------------------------------------------------------
// WebSocket client bookkeeping
// ---------------------------------------------------------------------------

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

interface WsSession {
  socket: WebSocket;
  /** Every parsed frame, in arrival order. */
  messages: unknown[];
  /** Set once the socket closes; `null` while open/connecting. */
  closed: { code: number; reason: string } | null;
  opened: boolean;
}

function trackWs(url: string): WsSession {
  const socket = new WebSocket(url);
  const session: WsSession = { socket, messages: [], closed: null, opened: false };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (data: RawData) => {
    const text = rawToString(data);
    try {
      session.messages.push(JSON.parse(text) as unknown);
    } catch {
      session.messages.push({ type: "<unparsable>", raw: text.slice(0, 160) });
    }
  });
  socket.on("close", (code: number, reason: Buffer) => {
    session.closed = { code, reason: reason.toString() };
  });
  socket.on("error", () => {
    /* recorded via `closed`/missing messages; no throw from the emitter */
  });
  return session;
}

/** Compact description of a session for failure messages. */
function describeWs(session: WsSession): string {
  const types = session.messages.map((message) => {
    if (typeof message === "object" && message !== null && "type" in message) {
      return String((message as { type: unknown }).type);
    }
    return typeof message;
  });
  return `opened=${session.opened}, closed=${session.closed === null ? "no" : `${session.closed.code}(${session.closed.reason})`}, messages=[${types.join(", ")}]`;
}

function messageType(message: unknown): string | null {
  if (typeof message !== "object" || message === null || !("type" in message)) return null;
  const type = (message as { type: unknown }).type;
  return typeof type === "string" ? type : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded wait for the socket to open (or be closed first). */
async function waitForOpen(session: WsSession, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.opened) return true;
    if (session.closed !== null) return false;
    await sleep(50);
  }
  return session.opened;
}

/** Bounded wait for a close; returns the close info or `null` on timeout. */
async function waitForClose(session: WsSession, timeoutMs = 10_000): Promise<{ code: number; reason: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.closed !== null) return session.closed;
    await sleep(50);
  }
  return session.closed;
}

/** Bounded wait for the first message (from `startIndex`) matching `match`. */
async function waitForMessage(
  session: WsSession,
  startIndex: number,
  match: (message: unknown) => boolean,
  timeoutMs = 20_000,
): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = session.messages.slice(startIndex).find((message) => match(message));
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return null;
    await sleep(150);
  }
}

// ---------------------------------------------------------------------------
// Shared scenario: validator + seeded trader + a live server
// ---------------------------------------------------------------------------

interface Scenario {
  validator: Validator;
  market: MarketEnv;
  trader: Keypair;
  traderAta: PublicKey;
  server: ServerHandle;
}

/** Direct on-chain change amounts (the WS layer sees them through the indexer). */
const DEPOSIT_AMOUNT = 25_000_000n; // 25 tUSDC
const ORDER_PRICE = 910_000n;
const ORDER_SIZE = 3_000_000n;

let scenarioPromise: Promise<Scenario> | null = null;

function scenario(): Promise<Scenario> {
  scenarioPromise ??= buildScenario();
  return scenarioPromise;
}

async function buildScenario(): Promise<Scenario> {
  const validator = await startValidator();
  await createMint(validator);
  const market = await initMarket(validator);
  const trader = Keypair.generate();
  const traderAta = await fundTrader(validator, trader.publicKey, 100_000_000n, "ws-trader");
  // Seed the ledger on-chain before the server boots, so the indexer's start
  // resync already carries it; the deposit inside the test is the pushed change.
  await submit(
    validator,
    buildDepositCollateral({
      user: trader.publicKey,
      market: market.market,
      userAta: traderAta,
      collateralMint: validator.mint,
      amount: 1_000_000n,
      programId: validator.programId,
    }),
    trader,
  );
  const server = await startServer({ validator });
  return { validator, market, trader, traderAta, server };
}

// ---------------------------------------------------------------------------
// WS-PUSHES-STATE-CHANGES (REQ-B-7)
// ---------------------------------------------------------------------------

test("WS-PUSHES-STATE-CHANGES: a subscribed client receives the matching update within one state change.", async (t) => {
  const s = await scenario();
  const socketUrl = (token: string) => `ws://127.0.0.1:${s.server.port}/ws?token=${encodeURIComponent(token)}`;
  // Holder object (not bare `let`s): closure assignments behind t.test() are
  // not visible to the outer control-flow analysis, which would over-narrow.
  const shared: { session: WsSession | null; wallet: string } = { session: null, wallet: s.trader.publicKey.toBase58() };

  try {
    await t.test("an unknown / invalid token is refused with close code 4401", async () => {
      const rejected = trackWs(socketUrl("not-a-jwt"));
      try {
        const closed = await waitForClose(rejected, 10_000);
        assert.ok(closed !== null, `a socket with an invalid token must be closed (got ${describeWs(rejected)})`);
        assert.equal(
          closed.code,
          4401,
          `an invalid WS token must close with 4401 (REQ-B-7; got ${closed.code}: ${closed.reason}; ${describeWs(rejected)})`,
        );
      } finally {
        rejected.socket.terminate();
      }
    });

    await t.test("a login token opens the socket; an on-chain deposit pushes a `user` message with the new deposited", async () => {
      // Real SIWS login end-to-end (challenge → local ed25519 sign → verify).
      const token = await login(s.server, makeSigner(s.trader));
      assert.ok(token.length > 0, "the login must yield a session token");

      const session = trackWs(socketUrl(token));
      shared.session = session;
      const opened = await waitForOpen(session, 10_000);
      assert.ok(
        opened,
        `a valid session token must open the /ws socket (got ${describeWs(session)}) — ` +
          "auth.verifyToken() must resolve the login token, not close 4401",
      );
      await sleep(300); // let the server register the authenticated socket

      // The state change: a direct, user-signed collateral deposit on-chain.
      const before = session.messages.length;
      await submit(
        s.validator,
        buildDepositCollateral({
          user: s.trader.publicKey,
          market: s.market.market,
          userAta: s.traderAta,
          collateralMint: s.validator.mint,
          amount: DEPOSIT_AMOUNT,
          programId: s.validator.programId,
        }),
        s.trader,
      );

      const pushed = await waitForMessage(
        session,
        before,
        (message) => {
          if (messageType(message) !== "user") return false;
          const portfolio = (message as { portfolio?: UserPortfolio }).portfolio;
          return portfolio !== undefined && portfolio.deposited === DEPOSIT_AMOUNT.toString();
        },
        20_000,
      );
      assert.ok(
        pushed !== null,
        `a deposit must push a \`user\` message whose portfolio.deposited == ${DEPOSIT_AMOUNT} within the bounded wait ` +
          `(got ${describeWs(session)}) — the push layer pushes nothing today`,
      );
      const portfolio = (pushed as { portfolio: UserPortfolio }).portfolio;
      assert.equal(portfolio.wallet, shared.wallet, "the `user` push must belong to the session's wallet");
      assert.equal(
        portfolio.free,
        (BigInt(portfolio.deposited) - BigInt(portfolio.reserved)).toString(),
        "the `user` push must carry a consistent portfolio snapshot (free = deposited − reserved)",
      );
    });

    await t.test("a resting order pushes a `book`/`mark` update reflecting the new level", async () => {
      const session = shared.session;
      assert.ok(session !== null, "requires the authenticated socket from the previous leg");
      const ws = session as WsSession;
      const before = ws.messages.length;

      // The state change: a direct, user-signed resting limit BID.
      await submit(
        s.validator,
        buildPlaceLimitOrder({
          market: s.market.market,
          indexSource: s.validator.indexSource,
          owner: s.trader.publicKey,
          side: 0,
          price: ORDER_PRICE,
          size: ORDER_SIZE,
          programId: s.validator.programId,
        }),
        s.trader,
      );

      const pushed = await waitForMessage(
        ws,
        before,
        (message) => {
          const type = messageType(message);
          return type === "book" || type === "mark";
        },
        20_000,
      );
      assert.ok(
        pushed !== null,
        `a place-order state change must push at least one \`book\`/\`mark\` message within the bounded wait ` +
          `(got ${describeWs(ws)})`,
      );
      if (messageType(pushed) === "book") {
        const book = (pushed as { book: BookView }).book;
        assert.deepEqual(
          book.bids,
          [[ORDER_PRICE.toString(), ORDER_SIZE.toString()]],
          "the pushed `book` must carry the new resting level (the chain-decoded active bids = [[price, size]])",
        );
      } else {
        const mark = (pushed as { mark: MarketView }).mark;
        assert.equal(
          mark.bestBid,
          ORDER_PRICE.toString(),
          "the pushed `mark` must reflect the new best bid (a stale push is not a state change)",
        );
      }
    });
  } finally {
    shared.session?.socket.terminate();
  }
});
