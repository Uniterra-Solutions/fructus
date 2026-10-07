//! REVIEW batch B2 — interaction-level adversarial model: keeper × indexer
//! lag (stale-lane decisions, retries, no wedge), WebSocket × reconnect/
//! subscribe races (wallet-scoped delivery, delta composition, no
//! unauthenticated leakage) and API × auth (every private route under every
//! token state, invalid DTOs never reaching the operator).
//!
//! Counterexample tests are marked `(COUNTEREXAMPLE)` and are EXPECTED RED.
//! In-process only: stub `Connection`s, real JWT/SIWS auth, `node:sqlite`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createHmac, sign as edSign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { WebSocket, type RawData } from "ws";
import { IX_DISCRIMINATORS, PROGRAM_ID, marketPda, orderBookPda, userCollateralPda, positionPda } from "fructus-sdk/src/index.js";
import { anchorAccountDiscriminator } from "fructus-sdk/src/encoding.js";
import {
  ORDER_BOOK_LEN,
  OrderBookLayout,
  PERP_MARKET_LEN,
  PerpMarket,
  POSITION_LEN,
  Position,
  USER_COLLATERAL_LEN,
  UserCollateralLayout,
} from "fructus-sdk/src/account/layout.js";
import type { ActionResponse, ServerWsMessage, UserPortfolio } from "fructus-sdk/src/api.js";
import { openDb, type Db } from "../src/db.js";
import { createKeeper } from "../src/keeper.js";
import { createAuth, type AuthService } from "../src/auth.js";
import { attachWs } from "../src/ws.js";
import { createApiServer, ROUTES } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import type { OperatorService } from "../src/operator.js";
import type { Keeper } from "../src/keeper.js";

const MARKET = marketPda(PROGRAM_ID).address;
const BOOK = orderBookPda(MARKET, PROGRAM_ID).address;
const JWT_SECRET = "review-secret";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded wait for a predicate; throws with `label` on timeout. */
async function waitUntil(cond: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(15);
  }
  assert.ok(cond(), `timed out waiting for ${label}`);
}

function u128le(value: bigint): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  buf.writeBigUInt64LE((value >> 64n) & 0xffffffffffffffffn, 8);
  return buf;
}

function marketRow(seed: { indexN?: bigint; indexD?: bigint; maintenanceMarginBps?: number } = {}): Buffer {
  const data = Buffer.alloc(8 + PERP_MARKET_LEN);
  anchorAccountDiscriminator("PerpMarket").copy(data, 0);
  (PublicKey.unique()).toBuffer().copy(data, 8 + PerpMarket.indexSource);
  (PublicKey.unique()).toBuffer().copy(data, 8 + PerpMarket.collateralMint);
  data.writeUInt16LE(1_000, 8 + PerpMarket.initialMarginBps);
  data.writeUInt16LE(seed.maintenanceMarginBps ?? 500, 8 + PerpMarket.maintenanceMarginBps);
  data.writeBigUInt64LE(seed.indexN ?? 1n, 8 + PerpMarket.indexN);
  data.writeBigUInt64LE(seed.indexD ?? 1n, 8 + PerpMarket.indexD);
  data[8 + PerpMarket.bump] = 254;
  return data;
}

function bookRow(readCursor: number, writeCursor: number): Buffer {
  const data = Buffer.alloc(8 + ORDER_BOOK_LEN);
  anchorAccountDiscriminator("OrderBook").copy(data, 0);
  data.writeBigUInt64LE(BigInt(readCursor), 8 + OrderBookLayout.eventReadCursor);
  data.writeBigUInt64LE(BigInt(writeCursor), 8 + OrderBookLayout.eventWriteCursor);
  MARKET.toBuffer().copy(data, 8 + OrderBookLayout.market);
  return data;
}

function positionRow(
  owner: PublicKey,
  side: number,
  fields: { notional?: bigint; entryN?: bigint; entryD?: bigint; closedNotional?: bigint; market?: PublicKey },
): Buffer {
  const data = Buffer.alloc(8 + POSITION_LEN);
  anchorAccountDiscriminator("Position").copy(data, 0);
  (fields.market ?? MARKET).toBuffer().copy(data, 8 + Position.market);
  owner.toBuffer().copy(data, 8 + Position.owner);
  data[8 + Position.side] = side;
  data.writeBigUInt64LE(fields.notional ?? 0n, 8 + Position.notional);
  u128le(fields.entryN ?? 0n).copy(data, 8 + Position.entryN);
  u128le(fields.entryD ?? 0n).copy(data, 8 + Position.entryD);
  data.writeBigUInt64LE(fields.closedNotional ?? 0n, 8 + Position.closedNotional);
  data[8 + Position.bump] = 253;
  return data;
}

function collateralRow(u: { deposited?: bigint; reserved?: bigint }): Buffer {
  const data = Buffer.alloc(8 + USER_COLLATERAL_LEN);
  anchorAccountDiscriminator("UserCollateral").copy(data, 0);
  data.writeBigUInt64LE(u.deposited ?? 0n, 8 + UserCollateralLayout.deposited);
  data.writeBigUInt64LE(u.reserved ?? 0n, 8 + UserCollateralLayout.reserved);
  data[8 + UserCollateralLayout.bump] = 255;
  return data;
}

const KIND_BY_DISCRIMINATOR = new Map(
  Object.entries(IX_DISCRIMINATORS).map(([name, bytes]) => [bytes.join(","), name]),
);

// ---------------------------------------------------------------------------
// Keeper × indexer lag
// ---------------------------------------------------------------------------

function seedPosition(
  db: Db,
  owner: PublicKey,
  side: number,
  fields: { notional?: bigint; entryN?: bigint; entryD?: bigint; closedNotional?: bigint; market?: PublicKey },
): PublicKey {
  const pda = positionPda(fields.market ?? MARKET, owner, side, PROGRAM_ID).address;
  db.upsertAccount("position", pda.toBase58(), positionRow(owner, side, fields), 1);
  return pda;
}

function seedKeeperDb(db: Db): void {
  db.upsertAccount("market", MARKET.toBase58(), marketRow(), 1);
}

test("REVIEW-KEEPER-STALE-INDEX-RETRY: a refused sweep is recorded and retried next tick; no wedge, no double-confirm", async () => {
  const db = openDb(":memory:");
  try {
    seedKeeperDb(db);
    const U = Keypair.fromSeed(new Uint8Array(32).fill(41)).publicKey;
    // Under-margin: m(1_000_000, 500) = 50_000 > deposited 10_000 (upnl 0).
    seedPosition(db, U, 0, { notional: 1_000_000n, entryN: 1n, entryD: 1n });
    db.upsertAccount(
      "user_collateral",
      userCollateralPda(MARKET, U, PROGRAM_ID).address.toBase58(),
      collateralRow({ deposited: 10_000n, reserved: 50_000n }),
      1,
    );

    const dir = mkdtempSync(join(tmpdir(), "review-keeper-"));
    const keeperKp = Keypair.generate();
    const keypairPath = join(dir, "keeper.json");
    writeFileSync(keypairPath, JSON.stringify(Array.from(keeperKp.secretKey)));
    const stub = { sends: [] as Array<{ kind: string; side: number; amount: bigint }>, fail: true };
    const connection = {
      async getAccountInfo(pubkey: PublicKey) {
        if (pubkey.equals(BOOK)) return { data: bookRow(10, 10) };
        return null;
      },
      async getLatestBlockhash() {
        return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 5_000 };
      },
      async sendRawTransaction(raw: Uint8Array) {
        if (stub.fail) throw new Error("custom program error: 0x1771"); // stale-index on-chain refusal
        const ix = Transaction.from(Buffer.from(raw)).instructions[0]!;
        const kind = KIND_BY_DISCRIMINATOR.get(Array.from(ix.data.subarray(0, 8)).join(",")) ?? "unknown";
        stub.sends.push({ kind, side: kind === "liquidate" ? ix.data[8]! : -1, amount: kind === "liquidate" ? ix.data.readBigUInt64LE(9) : 0n });
        return `K${stub.sends.length}`;
      },
      async confirmTransaction() {},
    } as unknown as Connection;
    const keeper = createKeeper({ connection, db, programId: PROGRAM_ID, intervalMs: 60_000, keypairPath });

    // Tick 1: the on-chain gate refuses every sweep (lagging index). Nothing
    // may confirm; every attempt is recorded; the tick must not throw.
    const t1 = await keeper.tick();
    assert.equal(t1.liquidated, 0, "a refused liquidation is not counted as liquidated");
    let rows = db.raw.prepare("SELECT kind, status, error FROM tx_log ORDER BY rowid").all() as unknown as Array<{
      kind: string;
      status: string;
      error: string | null;
    }>;
    assert.ok(rows.length >= 2, "the refused sweeps must still be recorded in tx_log");
    assert.ok(rows.some((r) => r.kind === "liquidate"), "the refused liquidation must be recorded");
    assert.ok(rows.every((r) => r.status === "failed" && r.error !== null), "all refused attempts are failed rows with the error");

    // Tick 2 (gate now passes — the "gate absorbs the retry"): liquidates once.
    stub.fail = false;
    const t2 = await keeper.tick();
    assert.equal(t2.liquidated, 1, "the retry absorbs the gate and liquidates");
    assert.equal(stub.sends.filter((s) => s.kind === "liquidate").length, 1, "exactly one landed liquidation");
    assert.deepEqual(
      stub.sends.filter((s) => s.kind === "liquidate").map((s) => [s.side, s.amount]),
      [[0, 1_000_000n]],
      "the keeper fully closes the largest (only) side it decided on",
    );
    const terminal = db.raw.prepare("SELECT kind, status FROM tx_log ORDER BY rowid").all() as unknown as Array<{
      kind: string;
      status: string;
    }>;
    assert.equal(
      terminal.filter((r) => r.kind === "liquidate" && r.status === "confirmed").length,
      1,
      "exactly one confirmed liquidation for the account (no double-confirm)",
    );

    // Index refresh → the decision follows the new state: no further attempts.
    db.upsertAccount(
      "user_collateral",
      userCollateralPda(MARKET, U, PROGRAM_ID).address.toBase58(),
      collateralRow({ deposited: 1_000_000n, reserved: 50_000n }),
      2,
    );
    const before = stub.sends.filter((s) => s.kind === "liquidate").length;
    const t3 = await keeper.tick();
    assert.equal(t3.liquidated, 0, "a refreshed healthy account is no longer targeted");
    assert.equal(stub.sends.filter((s) => s.kind === "liquidate").length, before, "no liquidation attempt after the index refresh");
  } finally {
    db.close();
  }
});

test("REVIEW-KEEPER-SELECTION: one liquidation per under-margin account per tick, largest-notional side, sweeps bounded", async () => {
  const db = openDb(":memory:");
  try {
    seedKeeperDb(db);
    const U = Keypair.fromSeed(new Uint8Array(32).fill(42)).publicKey;
    const V = Keypair.fromSeed(new Uint8Array(32).fill(43)).publicKey;
    const W = Keypair.fromSeed(new Uint8Array(32).fill(44)).publicKey;
    const F = Keypair.fromSeed(new Uint8Array(32).fill(45)).publicKey;

    // U: two live sides, both under margin; the larger side must be targeted once.
    seedPosition(db, U, 0, { notional: 1_000_000n, entryN: 1n, entryD: 1n });
    seedPosition(db, U, 1, { notional: 500_000n, entryN: 1n, entryD: 1n });
    db.upsertAccount(
      "user_collateral",
      userCollateralPda(MARKET, U, PROGRAM_ID).address.toBase58(),
      collateralRow({ deposited: 10_000n, reserved: 75_000n }),
      1,
    );
    // V: single under-margin long.
    seedPosition(db, V, 0, { notional: 300_000n, entryN: 1n, entryD: 1n });
    db.upsertAccount(
      "user_collateral",
      userCollateralPda(MARKET, V, PROGRAM_ID).address.toBase58(),
      collateralRow({ deposited: 5_000n, reserved: 15_000n }),
      1,
    );
    // W: closed notional only → settle_close, never a liquidation target.
    seedPosition(db, W, 0, { notional: 0n, closedNotional: 42n, entryN: 1n, entryD: 1n });
    db.upsertAccount(
      "user_collateral",
      userCollateralPda(MARKET, W, PROGRAM_ID).address.toBase58(),
      collateralRow({ deposited: 1_000_000n }),
      1,
    );
    // F: a foreign market's position must be ignored entirely.
    const FOREIGN = Keypair.fromSeed(new Uint8Array(32).fill(46)).publicKey;
    seedPosition(db, F, 0, { notional: 7_000_000n, market: FOREIGN });

    const dir = mkdtempSync(join(tmpdir(), "review-keeper2-"));
    const keeperKp = Keypair.generate();
    const keypairPath = join(dir, "keeper.json");
    writeFileSync(keypairPath, JSON.stringify(Array.from(keeperKp.secretKey)));
    const sends: Array<{ kind: string; amount: bigint; side: number }> = [];
    const connection = {
      async getAccountInfo(pubkey: PublicKey) {
        if (pubkey.equals(BOOK)) return { data: bookRow(0, 10) }; // pending events → crank
        return null;
      },
      async getLatestBlockhash() {
        return { blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 5_000 };
      },
      async sendRawTransaction(raw: Uint8Array) {
        const ix = Transaction.from(Buffer.from(raw)).instructions[0]!;
        const kind = KIND_BY_DISCRIMINATOR.get(Array.from(ix.data.subarray(0, 8)).join(",")) ?? "unknown";
        sends.push({ kind, side: kind === "liquidate" ? ix.data[8]! : -1, amount: kind === "liquidate" ? ix.data.readBigUInt64LE(9) : 0n });
        return `K${sends.length}`;
      },
      async confirmTransaction() {},
    } as unknown as Connection;
    const keeper = createKeeper({ connection, db, programId: PROGRAM_ID, intervalMs: 60_000, keypairPath });

    const t = await keeper.tick();
    assert.equal(t.cranked, 1, "pending book events ⇒ one crank");
    assert.equal(t.liquidated, 2, "one liquidation per under-margin account (U, V)");
    assert.equal(t.settledClose, 1, "the closed-notional position settles once");
    assert.equal(
      sends.filter((s) => s.kind === "settle_funding").length,
      3,
      "settle_funding runs once per live position (U long, U short, V long)",
    );
    const liquidations = sends.filter((s) => s.kind === "liquidate");
    assert.deepEqual(
      liquidations.map((s) => [s.side, s.amount]).sort((a, b) => (a[1] < b[1] ? -1 : 1)),
      [
        [0, 300_000n],
        [0, 1_000_000n],
      ],
      "U is liquidated on its larger side (1_000_000), V on its only side (300_000)",
    );
    assert.ok(
      !db.raw
        .prepare("SELECT wallet FROM tx_log WHERE kind = 'liquidate'")
        .all()
        .some((row) => (row as { wallet: string }).wallet === F.toBase58()),
      "a foreign-market position must never be targeted",
    );
    const txRows = db.raw.prepare("SELECT kind FROM tx_log ORDER BY rowid").all() as unknown as Array<{ kind: string }>;
    assert.deepEqual(
      txRows.map((r) => r.kind).sort(),
      ["crank", "liquidate", "liquidate", "settle_close", "settle_funding", "settle_funding", "settle_funding"].sort(),
      "the tick's bounded sweep coverage",
    );

    // Stale index (rows unchanged) ⇒ the same two decisions repeat next tick —
    // retries are the design; the on-chain gate stops any harm.
    const t2 = await keeper.tick();
    assert.equal(t2.liquidated, 2, "an unrefreshed index re-decides the same accounts (retry, not wedge)");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// WS × races
// ---------------------------------------------------------------------------

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = B58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

async function sessionToken(auth: AuthService, keypair: Keypair): Promise<string> {
  const wallet = keypair.publicKey.toBase58();
  const challenge = auth.challenge(wallet, "127.0.0.1");
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(keypair.secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  const signature = edSign(null, Buffer.from(challenge.signInInput, "utf8"), privateKey);
  const session = await auth.verify(wallet, base58Encode(signature), challenge.signInInput);
  return session.token;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function craftJwt(secret: string, payload: Record<string, unknown>, header = { alg: "HS256", typ: "JWT" }): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

function portfolioFixture(wallet: string, deposited: bigint): UserPortfolio {
  return {
    wallet,
    deposited: deposited.toString(),
    reserved: "0",
    claimable: "0",
    free: deposited.toString(),
    equity: deposited.toString(),
    requirementInitial: "0",
    requirementMaint: "0",
    health: "healthy",
    operator: null,
    positions: [],
  };
}

interface WsHarness {
  db: Db;
  auth: AuthService;
  handle: ReturnType<typeof attachWs>;
  url: (token?: string) => string;
  close: () => Promise<void>;
}

async function startWsHarness(
  computePortfolio: (wallet: PublicKey) => UserPortfolio | Promise<UserPortfolio>,
): Promise<WsHarness> {
  const db = openDb(":memory:");
  const auth = createAuth({ db, jwtSecret: JWT_SECRET, domain: "127.0.0.1" });
  const server: Server = createServer();
  const handle = attachWs({
    server,
    auth,
    market: MARKET,
    computePortfolio,
    computeBook: () => ({ bids: [], asks: [] }),
    computeMarket: () => ({ mark: null, index: "0", fundingAccumulator: "0", bestBid: null, bestAsk: null }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    db,
    auth,
    handle,
    url: (token?: string) =>
      `ws://127.0.0.1:${port}/ws${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`,
    close: async () => {
      await handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

interface WsClient {
  socket: WebSocket;
  messages: ServerWsMessage[];
  opened: boolean;
  closed: { code: number; reason: string } | null;
}

function connectWs(url: string): WsClient {
  const socket = new WebSocket(url);
  const client: WsClient = { socket, messages: [], opened: false, closed: null };
  socket.on("open", () => {
    client.opened = true;
  });
  socket.on("message", (data: RawData) => {
    try {
      client.messages.push(JSON.parse(String(data)) as ServerWsMessage);
    } catch {
      /* ignore non-JSON frames */
    }
  });
  socket.on("close", (code: number, reason: Buffer) => {
    client.closed = { code, reason: reason.toString() };
  });
  socket.on("error", () => {});
  return client;
}

test("REVIEW-WS-TOKEN-STATES: none/garbage/tampered/expired/wrong-secret close 4401; a valid session opens", async () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(51));
  const harness = await startWsHarness((w) => portfolioFixture(w.toBase58(), 1_000n));
  try {
    const valid = await sessionToken(harness.auth, wallet);
    const now = Math.floor(Date.now() / 1_000);
    const tampered = (() => {
      const token = craftJwt(JWT_SECRET, { sub: wallet.publicKey.toBase58(), iat: now, exp: now + 600 });
      const [h, p, s] = token.split(".");
      return `${h}.${p}.${s!.slice(0, -1)}${s!.endsWith("A") ? "B" : "A"}`;
    })();
    const cases: Array<[string, string | undefined]> = [
      ["no token", undefined],
      ["garbage token", "not-a-jwt"],
      ["expired token", craftJwt(JWT_SECRET, { sub: wallet.publicKey.toBase58(), exp: now - 10 })],
      ["wrong-secret token", craftJwt("other-secret", { sub: wallet.publicKey.toBase58(), exp: now + 600 })],
      ["tampered token", tampered],
      ["alg=none token", `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify({ sub: wallet.publicKey.toBase58(), exp: now + 600 }))}.`],
    ];
    for (const [label, token] of cases) {
      const client = connectWs(harness.url(token));
      try {
        await waitUntil(() => client.closed !== null, `${label} to be refused`);
        assert.equal(client.closed?.code, 4401, `${label} must close with 4401 (got ${client.closed?.code})`);
        assert.equal(client.messages.length, 0, `${label} must receive no push messages`);
      } finally {
        client.socket.terminate();
      }
    }
    const good = connectWs(harness.url(valid));
    try {
      await waitUntil(() => good.opened, "the valid session to open");
      assert.equal(good.closed, null, "a valid session token must keep the socket open");
    } finally {
      good.socket.terminate();
    }
  } finally {
    await harness.close();
  }
});

test("REVIEW-WS-WALLET-SCOPED-DELIVERY: user pushes reach only the owning wallet; book/mark broadcast to all; unknown accounts push nothing", async () => {
  const wallets = [52, 53, 54].map((fill) => Keypair.fromSeed(new Uint8Array(32).fill(fill)));
  const portfolios = new Map<string, bigint>(wallets.map((kp) => [kp.publicKey.toBase58(), 1_000n]));
  const harness = await startWsHarness((w) => portfolioFixture(w.toBase58(), portfolios.get(w.toBase58()) ?? 1_000n));
  try {
    const [a, b, c] = wallets as [Keypair, Keypair, Keypair];
    const tokenA = await sessionToken(harness.auth, a);
    const tokenB = await sessionToken(harness.auth, b);
    const clientA = connectWs(harness.url(tokenA));
    const clientB = connectWs(harness.url(tokenB));
    try {
      await waitUntil(() => clientA.opened && clientB.opened, "both sockets to open");
      await sleep(50); // baselines seeded

      portfolios.set(a.publicKey.toBase58(), 1_250n);
      harness.handle.onIndexerUpdate({
        kind: "user_collateral",
        pubkey: userCollateralPda(MARKET, a.publicKey, PROGRAM_ID).address.toBase58(),
        slot: 1,
      });
      await waitUntil(() => clientA.messages.length >= 1, "wallet A's user push");
      assert.equal(clientB.messages.length, 0, "wallet B must not receive wallet A's change (no cross-wallet leakage)");
      const push = clientA.messages[0] as { type: string; portfolio: UserPortfolio };
      assert.equal(push.type, "user");
      assert.equal(push.portfolio.wallet, a.publicKey.toBase58(), "the push belongs to the subscribed wallet");

      // An account of a wallet with NO socket pushes nothing anywhere.
      const beforeA = clientA.messages.length;
      const beforeB = clientB.messages.length;
      harness.handle.onIndexerUpdate({
        kind: "user_collateral",
        pubkey: userCollateralPda(MARKET, c.publicKey, PROGRAM_ID).address.toBase58(),
        slot: 2,
      });
      await sleep(80);
      assert.equal(clientA.messages.length, beforeA, "no message for an unsubscribed wallet (A)");
      assert.equal(clientB.messages.length, beforeB, "no message for an unsubscribed wallet (B)");

      // A book change is the one broadcast: both sockets get book (+mark).
      harness.handle.onIndexerUpdate({ kind: "order_book", pubkey: BOOK.toBase58(), slot: 3 });
      await waitUntil(
        () => clientA.messages.some((m) => m.type === "book") && clientB.messages.some((m) => m.type === "book"),
        "both sockets to receive the book broadcast",
      );
      assert.ok(clientA.messages.some((m) => m.type === "mark"), "the book change also fans a mark");
    } finally {
      clientA.socket.terminate();
      clientB.socket.terminate();
    }
  } finally {
    await harness.close();
  }
});

test("REVIEW-WS-DELTA-COMPOSITION: each pushed user payload is exactly the change since the last pushed state", async () => {
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(55));
  const values = [1_000n, 1_250n, 1_400n];
  let calls = 0;
  const harness = await startWsHarness((w) => portfolioFixture(w.toBase58(), values[Math.min(calls++, values.length - 1)]!));
  try {
    const token = await sessionToken(harness.auth, wallet);
    const client = connectWs(harness.url(token));
    try {
      await waitUntil(() => client.opened, "socket open");
      await waitUntil(() => calls >= 1, "baseline seeded");
      const collateral = userCollateralPda(MARKET, wallet.publicKey, PROGRAM_ID).address.toBase58();
      harness.handle.onIndexerUpdate({ kind: "user_collateral", pubkey: collateral, slot: 1 });
      await waitUntil(() => client.messages.length >= 1, "first delta");
      harness.handle.onIndexerUpdate({ kind: "user_collateral", pubkey: collateral, slot: 2 });
      await waitUntil(() => client.messages.length >= 2, "second delta");
      assert.deepEqual(
        client.messages.map((m) => (m as { portfolio: UserPortfolio }).portfolio.deposited),
        ["250", "150"],
        "each push carries the change since the state the client last holds (deltas compose)",
      );
    } finally {
      client.socket.terminate();
    }
  } finally {
    await harness.close();
  }
});

test("REVIEW-WS-SLOW-CONNECT-BASELINE-RACE (COUNTEREXAMPLE): a late baseline overwrite double-counts the next delta", async () => {
  // The `WsOptions.computePortfolio` contract is `UserPortfolio | Promise<...>`
  // — an async read model is a legal caller. If the connect-time baseline
  // resolves AFTER an earlier push already advanced the baseline, the stale
  // snapshot overwrites the newer one and the next delta is computed against
  // the wrong base (a client applying the sequence double-counts).
  const wallet = Keypair.fromSeed(new Uint8Array(32).fill(56));
  let resolveSeed: ((p: UserPortfolio) => void) | null = null;
  let calls = 0;
  const harness = await startWsHarness((w) => {
    calls += 1;
    if (calls === 1) return new Promise<UserPortfolio>((resolve) => (resolveSeed = resolve));
    // S1 = 102, S2 = 103 (the connect snapshot will resolve to S0 = 100).
    return portfolioFixture(w.toBase58(), BigInt(100 + calls));
  });
  try {
    const token = await sessionToken(harness.auth, wallet);
    const client = connectWs(harness.url(token));
    try {
      await waitUntil(() => client.opened, "socket open");
      await waitUntil(() => calls === 1 && resolveSeed !== null, "the connect-time read to be in flight");
      const collateral = userCollateralPda(MARKET, wallet.publicKey, PROGRAM_ID).address.toBase58();

      harness.handle.onIndexerUpdate({ kind: "user_collateral", pubkey: collateral, slot: 1 });
      await waitUntil(() => client.messages.length >= 1, "the first push (absolute, base unknown)");
      resolveSeed!(portfolioFixture(wallet.publicKey.toBase58(), 100n)); // S0 arrives late
      await sleep(30);

      harness.handle.onIndexerUpdate({ kind: "user_collateral", pubkey: collateral, slot: 2 });
      await waitUntil(() => client.messages.length >= 2, "the second push");
      const second = (client.messages[1] as { portfolio: UserPortfolio }).portfolio;
      assert.equal(
        second.deposited,
        "1",
        `after pushing S1 the change to S2 must be S2 − S1 = 103 − 102 = 1; got ${second.deposited} ` +
          "(a stale connect baseline overwrote the newer one)",
      );
    } finally {
      client.socket.terminate();
    }
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------------------
// API × auth + DTO validation
// ---------------------------------------------------------------------------

interface ApiHarness {
  base: string;
  calls: string[];
  auth: AuthService;
  close: () => Promise<void>;
}

async function startApiHarness(): Promise<ApiHarness> {
  const db = openDb(":memory:");
  const config = loadConfig({ JWT_SECRET } as unknown as NodeJS.ProcessEnv);
  const auth = createAuth({ db, jwtSecret: JWT_SECRET, domain: "127.0.0.1" });
  const calls: string[] = [];
  const okAction = (): ActionResponse => ({ actionId: `a${calls.length}`, signature: "sig", status: "confirmed" });
  const operator: OperatorService = {
    executeDeposit: async (user, amount) => {
      calls.push(`deposit:${user}:${amount}`);
      return okAction();
    },
    executeWithdraw: async (user, amount) => {
      calls.push(`withdraw:${user}:${amount}`);
      return okAction();
    },
    executeOrder: async (user, order) => {
      calls.push(`order:${user}:${order.kind}`);
      return okAction();
    },
    executeCancel: async (user, cancel) => {
      calls.push(`cancel:${user}:${cancel.seq}`);
      return okAction();
    },
    executeClose: async (user, close) => {
      calls.push(`close:${user}:${close.size}`);
      return okAction();
    },
    queueDepth: () => 0,
  };
  const keeper: Keeper = {
    tick: async () => ({ cranked: 0, settledFunding: 0, settledClose: 0, liquidated: 0 }),
    start() {},
    stop() {},
  };
  const server = createApiServer({
    config,
    db,
    auth,
    operator,
    keeper,
    faucet: null,
    getPortfolio: (w) => portfolioFixture(w.toBase58(), 1_000n),
    getMarket: () => ({ mark: null, index: "0", fundingAccumulator: "0", bestBid: null, bestAsk: null }),
    getBook: () => ({ bids: [], asks: [] }),
    connection: {} as unknown as Connection,
    programId: PROGRAM_ID,
    market: MARKET,
    getOperatorPubkey: () => Keypair.fromSeed(new Uint8Array(32).fill(60)).publicKey,
  });
  const port = await server.start(0);
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    auth,
    close: () => server.close(),
  };
}

interface HttpJson {
  status: number;
  body: { ok: boolean; data?: unknown; error?: { code: string } } | null;
  text: string;
}

async function httpCall(
  base: string,
  method: "GET" | "POST",
  path: string,
  opts: { token?: string; body?: unknown; rawBody?: string; authHeader?: string } = {},
): Promise<HttpJson> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined || opts.rawBody !== undefined) headers["content-type"] = "application/json";
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.authHeader !== undefined) headers.authorization = opts.authHeader;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let body: HttpJson["body"] = null;
  try {
    body = JSON.parse(text) as HttpJson["body"];
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

const VALID_ACTION_BODIES: Record<string, unknown> = {
  "/actions/deposit": { amount: "1000000" },
  "/actions/withdraw": { amount: "1" },
  "/actions/orders": { kind: "market", side: 0, size: "1000" },
  "/actions/orders/cancel": { side: 0, seq: "1" },
  "/actions/positions/close": { side: 0, size: "1000" },
};

test("REVIEW-API-PRIVATE-ROUTES-TOKEN-MATRIX: every private route 401s under every invalid token state and 2xxes only with a valid one", async () => {
  const harness = await startApiHarness();
  try {
    const wallet = Keypair.fromSeed(new Uint8Array(32).fill(61));
    const valid = await sessionToken(harness.auth, wallet);
    const now = Math.floor(Date.now() / 1_000);
    const expired = craftJwt(JWT_SECRET, { sub: wallet.publicKey.toBase58(), exp: now - 10 });
    const wrongSecret = craftJwt("other-secret", { sub: wallet.publicKey.toBase58(), exp: now + 600 });
    const validToken = craftJwt(JWT_SECRET, { sub: wallet.publicKey.toBase58(), iat: now, exp: now + 600 });
    const tampered = (() => {
      const [h, p, s] = validToken.split(".");
      return `${h}.${p}.${s!.slice(0, -1)}${s!.endsWith("A") ? "B" : "A"}`;
    })();
    const states: Array<[string, string | undefined]> = [
      ["no token", undefined],
      ["garbage token", "not-a-jwt"],
      ["expired token", expired],
      ["wrong-secret token", wrongSecret],
      ["tampered token", tampered],
    ];

    for (const route of ROUTES.filter((r) => r.private)) {
      for (const [label, token] of states) {
        const before = harness.calls.length;
        const res = await httpCall(harness.base, route.method, route.path, {
          token,
          body: route.method === "POST" ? VALID_ACTION_BODIES[route.path] : undefined,
        });
        assert.equal(res.status, 401, `${route.method} ${route.path} with ${label} must 401 (got ${res.status}: ${res.text.slice(0, 120)})`);
        assert.equal(res.body?.error?.code, "unauthorized", `${route.method} ${route.path} with ${label}: unified error envelope`);
        assert.equal(harness.calls.length, before, `${route.method} ${route.path} with ${label} must not reach the operator`);
      }
      const res = await httpCall(harness.base, route.method, route.path, {
        token: valid,
        body: route.method === "POST" ? VALID_ACTION_BODIES[route.path] : undefined,
      });
      assert.equal(res.status, 200, `${route.method} ${route.path} with a valid session must succeed (got ${res.status}: ${res.text.slice(0, 120)})`);
      assert.equal(res.body?.ok, true, `${route.method} ${route.path}: success envelope`);
    }

    // Auth runs BEFORE the body is parsed: a broken body with no token is 401.
    const gated = await httpCall(harness.base, "POST", "/actions/deposit", { rawBody: "{not json" });
    assert.equal(gated.status, 401, "the auth gate must fire before any body parsing");
    const parsed = await httpCall(harness.base, "POST", "/actions/deposit", { token: valid, rawBody: "{not json" });
    assert.equal(parsed.status, 400, "a valid session with a broken body is a 400");

    // Envelope + routing edges.
    const health = await httpCall(harness.base, "GET", "/healthz");
    assert.equal(health.status, 200);
    assert.equal((health.body?.data as { status: string }).status, "ok");
    const unknown = await httpCall(harness.base, "GET", "/nope");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body?.error?.code, "not_found");
    const wrongMethod = await httpCall(harness.base, "GET", "/actions/deposit");
    assert.equal(wrongMethod.status, 404, "a method mismatch is not a route");
  } finally {
    await harness.close();
  }
});

test("REVIEW-API-INVALID-DTOS-REACH-NO-OPERATOR: every malformed action body is rejected 400 before any enqueue", async () => {
  const harness = await startApiHarness();
  try {
    const wallet = Keypair.fromSeed(new Uint8Array(32).fill(62));
    const valid = await sessionToken(harness.auth, wallet);
    const invalid: Array<[string, string, string]> = [
      ["/actions/deposit", "{}", "missing amount"],
      ["/actions/deposit", '{"amount":5}', "amount is a number, not a decimal string"],
      ["/actions/deposit", '{"amount":"-1"}', "negative amount"],
      ["/actions/deposit", '{"amount":"1.5"}', "non-integer amount"],
      ["/actions/deposit", '{"amount":"1e6"}', "exponent amount"],
      ["/actions/deposit", '{"amount":" 1"}', "whitespace amount"],
      ["/actions/deposit", '{"amount":"18446744073709551616"}', "amount above u64::MAX"],
      ["/actions/deposit", "[]", "array body"],
      ["/actions/deposit", "not json at all", "non-JSON body"],
      ["/actions/withdraw", "{}", "missing amount"],
      ["/actions/orders", '{"kind":"LIMIT","side":0,"size":"1","price":"1"}', "unknown kind"],
      ["/actions/orders", '{"kind":"limit","side":0,"size":"1"}', "limit without price"],
      ["/actions/orders", '{"kind":"limit","side":0,"size":"1","price":"-1"}', "negative price"],
      ["/actions/orders", '{"kind":"market","side":2,"size":"1"}', "side out of range"],
      ["/actions/orders", '{"kind":"market","side":"0","size":"1"}', "side as string"],
      ["/actions/orders", '{"kind":"market","side":0,"size":"0x10"}', "hex size"],
      ["/actions/orders/cancel", '{"side":0}', "cancel without seq"],
      ["/actions/orders/cancel", '{"side":0,"seq":"-2"}', "negative seq"],
      ["/actions/orders/cancel", '{"side":1,"seq":"18446744073709551616"}', "seq above u64::MAX"],
      ["/actions/positions/close", '{"size":"1"}', "close without side"],
      ["/actions/positions/close", '{"side":1,"size":"1e5"}', "close with exponent size"],
    ];
    for (const [path, rawBody, label] of invalid) {
      const before = harness.calls.length;
      const res = await httpCall(harness.base, "POST", path, { token: valid, rawBody });
      assert.equal(res.status, 400, `${label} (${path}) must be a 400 (got ${res.status}: ${res.text.slice(0, 120)})`);
      assert.equal(res.body?.error?.code, "bad_request", `${label}: bad_request code`);
      assert.equal(harness.calls.length, before, `${label} must not reach the operator (no enqueue on invalid input)`);
    }

    // Positive controls: valid bodies pass and enqueue exactly once.
    for (const [path, body] of Object.entries(VALID_ACTION_BODIES)) {
      const before = harness.calls.length;
      const res = await httpCall(harness.base, "POST", path, { token: valid, body });
      assert.equal(res.status, 200, `valid body for ${path} must succeed (got ${res.status}: ${res.text.slice(0, 120)})`);
      assert.equal(harness.calls.length, before + 1, `valid body for ${path} enqueues exactly one action`);
    }
    // u64::MAX is a legal amount boundary.
    const maxRes = await httpCall(harness.base, "POST", "/actions/deposit", {
      token: valid,
      rawBody: '{"amount":"18446744073709551615"}',
    });
    assert.equal(maxRes.status, 200, "u64::MAX is inside the accepted amount domain");
  } finally {
    await harness.close();
  }
});
