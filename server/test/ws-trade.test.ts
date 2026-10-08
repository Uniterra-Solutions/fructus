//! RED acceptance test (e2e, hermetic validator) for product-v3 REQ-K-4:
//! every newly indexed fill is pushed exactly once as a `trade` message, in
//! ascending seq order, matching the REST row — and further ring updates
//! (a fresh resting order) re-deliver nothing.
//!
//! RED on today's tree: the WS layer has no `trade` dispatch at all, so no
//! trade message ever arrives — the assertions fail behaviourally.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { Keypair, type TransactionInstruction } from "@solana/web3.js";
import WebSocket, { type RawData } from "ws";
import type { ApiResponse, ChallengeResponse, SessionResponse, TradeView, TradesResponse } from "fructus-sdk/src/api.js";
import {
  SIDE_ASK,
  SIDE_BID,
  buildPlaceLimitOrder,
  buildDepositCollateral,
  buildOpenPosition,
} from "fructus-sdk/src/index.js";
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

const ASK_PRICE = 100_001n;
const N = 2_000_000n;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// SIWS helpers (ed25519 via node:crypto — the ws.test.ts pattern)
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
  assert.ok(res.body !== null && res.body.ok === true, `${what} must use the success envelope`);
  return (res.body as { ok: true; data: T }).data;
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
  assert.ok(edVerify(null, bytes, signer.publicKey, signature), "test-vector sanity: signature verifies");
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
// WS client bookkeeping
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
  messages: unknown[];
  opened: boolean;
}

function trackWs(url: string): WsSession {
  const socket = new WebSocket(url);
  const session: WsSession = { socket, messages: [], opened: false };
  socket.on("open", () => {
    session.opened = true;
  });
  socket.on("message", (data: RawData) => {
    try {
      session.messages.push(JSON.parse(rawToString(data)) as unknown);
    } catch {
      session.messages.push({ type: "<unparsable>" });
    }
  });
  socket.on("error", () => {
    /* asserted via missing messages */
  });
  return session;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(150);
  }
}

function tradeMessages(session: WsSession, market: string): Array<{ type: string; market: string; trade: TradeView }> {
  return session.messages.filter(
    (message): message is { type: string; market: string; trade: TradeView } =>
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "trade" &&
      (message as { market?: unknown }).market === market,
  );
}

// ---------------------------------------------------------------------------

let validator: Validator;
let market: MarketEnv;
let server: ServerHandle;
let maker: Keypair;
let taker: Keypair;
let session: WsSession;
let opened = false;
const marketB58 = (): string => market.market.toBase58();

async function fetchTrades(limit = 50): Promise<TradeView[]> {
  const res = await call(server, "GET", `/market/trades?limit=${limit}`);
  return expectOk<TradesResponse>(res, "GET /market/trades").trades;
}

async function seededCross(): Promise<void> {
  await submit(
    validator,
    buildPlaceLimitOrder({
      market: market.market,
      indexSource: validator.indexSource,
      owner: maker.publicKey,
      side: SIDE_ASK,
      price: ASK_PRICE,
      size: 2n * N,
      programId: validator.programId,
    }),
    maker,
  );
  const takerAta = await fundTrader(validator, taker.publicKey, 50_000_000n, "ws-taker");
  await submit(
    validator,
    buildDepositCollateral({
      user: taker.publicKey,
      market: market.market,
      userAta: takerAta,
      collateralMint: validator.mint,
      amount: 5_000_000n,
      programId: validator.programId,
    }),
    taker,
  );
  for (let i = 0; i < 2; i++) {
    await submit(
      validator,
      buildOpenPosition({
        owner: taker.publicKey,
        market: market.market,
        indexSource: validator.indexSource,
        side: SIDE_BID,
        size: N,
        price: 0n,
        programId: validator.programId,
      }),
      taker,
    );
  }
}

before(async () => {
  validator = await startValidator();
  await createMint(validator);
  market = await initMarket(validator);
  server = await startServer({ validator });

  maker = Keypair.generate();
  taker = Keypair.generate();
  await fundTrader(validator, maker.publicKey, 50_000_000n, "ws-maker");

  const token = await login(server, makeSigner(Keypair.generate()));
  session = trackWs(`${server.apiUrl.replace(/^http/, "ws")}/ws?token=${token}`);
  opened = await waitFor(() => session.opened, 10_000);
});

after(async () => {
  session.socket.terminate();
  await stopAll();
});

test("WS-TRADE-PUSH-EXACTLY-ONCE: a live cross delivers exactly one trade message per new fill, in ascending seq order, matching the REST trade row, and a forced resync re-delivery adds none", async () => {
  assert.ok(opened, "the authenticated socket must open before the cross");

  // The cross happens AFTER the socket is connected — the fills must arrive
  // as pushes, not as a REST bootstrap.
  await seededCross();

  const indexed = await (async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if ((await fetchTrades()).length >= 2) return true;
      if (Date.now() >= deadline) return false;
      await sleep(500);
    }
  })();
  assert.ok(indexed, "the indexer must serve the two seeded fills on /market/trades");

  const rest = await fetchTrades(200);
  assert.ok(rest.length >= 2, `generator sanity: at least two fills — got ${rest.length}`);

  const arrived = await waitFor(() => tradeMessages(session, marketB58()).length === rest.length, 30_000);
  assert.ok(
    arrived,
    `every fill must be pushed as a trade message — got ${tradeMessages(session, marketB58()).length} for ${rest.length} fills`,
  );

  // Exactly once: a short grace must not produce more messages.
  await sleep(1_000);
  const pushed = tradeMessages(session, marketB58());
  assert.equal(pushed.length, rest.length, `exactly one trade message per fill — got ${pushed.length} for ${rest.length}`);

  // Ascending seq order, same set as REST, identical payloads.
  const pushedSeqs = pushed.map((m) => m.trade.seq);
  assert.deepEqual(
    pushedSeqs,
    [...pushedSeqs].sort((a, b) => Number(a) - Number(b)),
    `trade pushes must arrive in ascending seq order — got [${pushedSeqs.join(",")}]`,
  );
  const restAscending = [...rest].reverse(); // REST is desc; push order is asc
  assert.deepEqual(pushedSeqs, restAscending.map((t) => t.seq), "the pushed seq set equals the REST trade set");
  for (const message of pushed) {
    const row = restAscending.find((t) => t.seq === message.trade.seq);
    assert.deepEqual(message.trade, row, `the pushed payload for seq ${message.trade.seq} must equal the REST row`);
  }

  // A fresh ring update (a non-crossing resting order) re-delivers nothing:
  // gate on the book push it must produce, then confirm no trade message rode along.
  const watermark = session.messages.length;
  await submit(
    validator,
    buildPlaceLimitOrder({
      market: market.market,
      indexSource: validator.indexSource,
      owner: maker.publicKey,
      side: SIDE_ASK,
      price: ASK_PRICE + 5_000n,
      size: 1n * N,
      programId: validator.programId,
    }),
    maker,
  );
  const sawBookPush = await (async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const hasBook = session.messages
        .slice(watermark)
        .some((m) => typeof m === "object" && m !== null && (m as { type?: unknown }).type === "book");
      if (hasBook) return true;
      if (Date.now() >= deadline) return false;
      await sleep(150);
    }
  })();
  assert.ok(sawBookPush, "the extra resting order must surface as a book push (indexer liveness)");
  await sleep(500);
  assert.equal(
    tradeMessages(session, marketB58()).length,
    rest.length,
    "subsequent ring updates (no new fills) must not re-deliver trade pushes",
  );
});
