//! REVIEW batch B2 — process-level integration: boot the real server against a
//! hermetic validator, mutate, RESTART against the same SQLite store, and
//! verify replay/idempotency (no double-credit, tx_log consistency) plus the
//! faucet's caps under concurrent HTTP requests and across a restart.
//!
//! Everything runs on a throwaway `solana-test-validator` + `mkdtemp` fixtures
//! via `test/harness.ts`; no devnet/mainnet contact.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, sign as edSign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, Transaction, type VersionedTransactionResponse } from "@solana/web3.js";
import type {
  ActionResponse,
  ApiResponse,
  BindConfirmResponse,
  BindPrepareResponse,
  ChallengeResponse,
  FaucetResponse,
  SessionResponse,
  UserPortfolio,
} from "fructus-sdk/src/api.js";
import {
  SIDE_ASK,
  buildDepositCollateral,
  buildOpenPosition,
  decodeUserCollateral,
  userCollateralPda,
} from "fructus-sdk/src/index.js";
import { openDb } from "../src/db.js";
import {
  createMint,
  fundTrader,
  getAssociatedTokenAddress,
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

const JWT_SECRET = "review-secret";
const OWNER = Keypair.fromSeed(new Uint8Array(32).fill(71));
const MAKER = Keypair.fromSeed(new Uint8Array(32).fill(72));

interface Scenario {
  validator: Validator;
  mint: PublicKey;
  market: MarketEnv;
  ownerAta: PublicKey;
}

let scenarioPromise: Promise<Scenario> | null = null;
function scenario(): Promise<Scenario> {
  scenarioPromise ??= buildScenario();
  return scenarioPromise;
}

async function buildScenario(): Promise<Scenario> {
  const validator = await startValidator();
  const mint = await createMint(validator);
  const market = await initMarket(validator);
  const ownerAta = await fundTrader(validator, OWNER.publicKey, 30_000_000n, "review-owner");
  await fundTrader(validator, MAKER.publicKey, 10_000_000n, "review-maker");

  // One Fill event in the ring: the owner's market buy crosses the maker's ask.
  await submit(
    validator,
    buildOpenPosition({
      owner: MAKER.publicKey,
      market: market.market,
      indexSource: validator.indexSource,
      side: SIDE_ASK,
      size: 2_000_000n,
      price: 100_001n,
      programId: validator.programId,
    }),
    MAKER,
  );
  await submit(
    validator,
    buildDepositCollateral({
      user: OWNER.publicKey,
      market: market.market,
      userAta: ownerAta,
      collateralMint: mint,
      amount: 1_050_000n,
      programId: validator.programId,
    }),
    OWNER,
  );
  await submit(
    validator,
    buildOpenPosition({
      owner: OWNER.publicKey,
      market: market.market,
      indexSource: validator.indexSource,
      side: 0, // bid
      size: 1_000_000n,
      price: 0n, // market/IOC — crosses the resting ask
      programId: validator.programId,
    }),
    OWNER,
  );
  return { validator, mint, market, ownerAta };
}

// ---------------------------------------------------------------------------
// HTTP + SIWS helpers
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
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
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
  assert.equal(res.body?.ok, true, `${what}: success envelope (got ${res.text.slice(0, 200)})`);
  return (res.body as { ok: true; data: T }).data;
}

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

function signSiws(keypair: Keypair, message: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(keypair.secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  return base58Encode(edSign(null, Buffer.from(message, "utf8"), privateKey));
}

async function login(server: ServerHandle, keypair: Keypair): Promise<string> {
  const wallet = keypair.publicKey.toBase58();
  const challenge = expectOk<ChallengeResponse>(
    await call(server, "POST", "/auth/challenge", { body: { wallet } }),
    `POST /auth/challenge for ${wallet}`,
  );
  const signature = signSiws(keypair, challenge.signInInput);
  const session = expectOk<SessionResponse>(
    await call(server, "POST", "/auth/verify", { body: { wallet, signature, signInInput: challenge.signInInput } }),
    `POST /auth/verify for ${wallet}`,
  );
  return session.token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) {
      assert.fail(`${label}: bounded wait exceeded (last value ${JSON.stringify(value)})`);
    }
    await sleep(250);
  }
}

/** Read from the server's SQLite store (short-lived connection per read). */
function withDb<T>(dbPath: string, fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function portfolioDeposited(server: ServerHandle, token: string): () => Promise<string> {
  return async () => {
    const res = await call(server, "GET", "/me", { token });
    if (res.status !== 200 || res.body?.ok !== true) return `<status ${res.status}>`;
    return (res.body as { ok: true; data: UserPortfolio }).data.deposited;
  };
}

interface FillShape {
  seq: number;
  owner: string | null;
}

function readFills(dbPath: string): FillShape[] {
  return withDb(dbPath, (db) => db.listFills().map((row) => ({ seq: row.seq, owner: row.owner })));
}

// ---------------------------------------------------------------------------
// REQ-B-2/B-5 — process restart: replay is idempotent, actions are exactly-once
// ---------------------------------------------------------------------------

test("REVIEW-PROC-RESTART-REPLAY-IDEMPOTENT: no double-face of fills, tx_log survives, post-restart changes index — no double-credit", async () => {
  const s = await scenario();
  const v = s.validator;
  const dir = mkdtempSync(join(tmpdir(), "review-proc-"));
  const dbPath = join(dir, "index.sqlite");
  const fixtureDir = mkdtempSync(join(tmpdir(), "review-proc-op-"));
  const operator = Keypair.generate();
  const operatorPath = join(fixtureDir, "operator.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(operatorPath, JSON.stringify(Array.from(operator.secretKey)));

  const env = {
    JWT_SECRET,
    DATABASE_PATH: dbPath,
    OPERATOR_KEYPAIR: operatorPath,
    KEEPER_INTERVAL_MS: "3600000", // keep the keeper dormant for the test window
  };
  let server: ServerHandle = await startServer({ validator: v, env });
  try {
    const ownerToken = await login(server, OWNER);
    // --- run 1: indexer + bind + one operator action -----------------------
    await waitFor(portfolioDeposited(server, ownerToken), (d) => d === "1050000", "run 1: /me reflects the seeded deposit");
    const healthz = expectOk<{ status: string; slot: number | null }>(
      await call(server, "GET", "/healthz"),
      "GET /healthz",
    );
    assert.ok(healthz.slot !== null, "the indexer must report an indexed slot once started");

    const fillsRun1 = await waitFor(async () => readFills(dbPath), (rows) => rows.length >= 1, "run 1: the crossing fill to be indexed");
    assert.deepEqual(
      fillsRun1.map((row) => row.seq),
      [...new Set(fillsRun1.map((row) => row.seq))],
      "run 1: each fill seq indexed exactly once",
    );
    // The fill must be attributable to the maker's or the taker's wallet.
    assert.ok(
      fillsRun1.every((row) => row.owner === OWNER.publicKey.toBase58() || row.owner === MAKER.publicKey.toBase58()),
      "the fill is attributed to one of the two traders",
    );

    // D4 bind (wallet-signed once): prepare → sign → submit → confirm.
    const prepared = expectOk<BindPrepareResponse>(
      await call(server, "POST", "/bind/prepare", { body: { wallet: OWNER.publicKey.toBase58() } }),
      "POST /bind/prepare",
    );
    const bindTx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
    bindTx.sign(OWNER);
    const bindSig = await v.connection.sendRawTransaction(bindTx.serialize());
    await v.connection.confirmTransaction(bindSig, "confirmed");
    const confirmed = expectOk<BindConfirmResponse>(
      await call(server, "POST", "/bind/confirm", { body: { transaction: prepared.transaction, signature: bindSig } }),
      "POST /bind/confirm",
    );
    assert.equal(confirmed.status, "bound", "the bind confirm must report the on-chain record");

    const action1 = expectOk<ActionResponse>(
      await call(server, "POST", "/actions/deposit", { token: ownerToken, body: { amount: "1000000" } }),
      "run 1: POST /actions/deposit",
    );
    assert.equal(action1.status, "confirmed", "the operator deposit must confirm");
    await waitFor(portfolioDeposited(server, ownerToken), (d) => d === "2050000", "run 1: /me reflects the operator deposit (1050000 + 1000000)");
    await waitFor(
      async () => withDb(dbPath, (db) => db.getTxLog(action1.actionId)),
      (row) => row !== null && row.status === "confirmed",
      "run 1: the tx_log row",
    );

    const fillsBefore = readFills(dbPath);
    const txRowsBefore = withDb(dbPath, (db) => db.raw.prepare("SELECT id, status, signature FROM tx_log ORDER BY rowid").all()) as unknown as Array<{
      id: string;
      status: string;
      signature: string | null;
    }>;
    assert.equal(txRowsBefore.length, 1, "exactly one tx_log row before the restart");

    // --- restart against the same store -------------------------------------
    await server.stop();
    server = await startServer({ validator: v, env });
    await waitFor(portfolioDeposited(server, ownerToken), (d) => d === "2050000", "run 2: reads serve the replayed state");

    const fillsAfter = readFills(dbPath);
    assert.deepEqual(fillsAfter, fillsBefore, "replay after restart must not insert, drop or re-slot any fill");
    const txRowsAfter = withDb(dbPath, (db) => db.raw.prepare("SELECT id, status, signature FROM tx_log ORDER BY rowid").all()) as unknown as Array<{
      id: string;
      status: string;
      signature: string | null;
    }>;
    assert.deepEqual(txRowsAfter, txRowsBefore, "the tx_log rows survive a restart byte-identically");

    // --- run 2: a new direct change is indexed, then a second action --------
    await submit(
      v,
      buildDepositCollateral({
        user: OWNER.publicKey,
        market: s.market.market,
        userAta: s.ownerAta,
        collateralMint: s.mint,
        amount: 500_000n,
        programId: v.programId,
      }),
      OWNER,
    );
    await waitFor(portfolioDeposited(server, ownerToken), (d) => d === "2550000", "run 2: the post-restart direct deposit is indexed");

    const action2 = expectOk<ActionResponse>(
      await call(server, "POST", "/actions/deposit", { token: ownerToken, body: { amount: "500000" } }),
      "run 2: POST /actions/deposit",
    );
    assert.equal(action2.status, "confirmed");
    assert.notEqual(action2.actionId, action1.actionId, "the post-restart action gets its own tx_log row");
    await waitFor(portfolioDeposited(server, ownerToken), (d) => d === "3050000", "run 2: the second operator deposit is indexed");

    const finalRows = withDb(dbPath, (db) => db.raw.prepare("SELECT id, status, signature FROM tx_log ORDER BY rowid").all()) as unknown as Array<{
      id: string;
      status: string;
      signature: string | null;
    }>;
    assert.equal(finalRows.length, 2, "exactly one tx_log row per submitted action (none lost, none duplicated)");
    assert.equal(new Set(finalRows.map((r) => r.id)).size, 2);
    assert.ok(finalRows.every((r) => r.status === "confirmed" && r.signature !== null));

    // The decisive no-double-credit assertion is on-chain: 1_050_000 + 1_000_000
    // + 500_000 (direct) + 500_000 (operator) — every credit exactly once.
    const collateral = userCollateralPda(s.market.market, OWNER.publicKey, v.programId).address;
    const chainInfo = await v.connection.getAccountInfo(collateral, "confirmed");
    assert.ok(chainInfo !== null, "the on-chain ledger must exist");
    const chainState = decodeUserCollateral(chainInfo!.data);
    assert.equal(chainState?.deposited, 3_050_000n, "on-chain deposited must equal the sum of all credits once each");

    // Indexed account bytes are byte-identical to the chain after the restart.
    const indexed = withDb(dbPath, (db) => db.getAccount("user_collateral", collateral.toBase58()));
    assert.ok(indexed !== null, "the ledger is indexed");
    assert.ok(Buffer.from(indexed!.data).equals(chainInfo!.data), "indexed bytes equal the chain read");

    await server.stop();
  } finally {
    await server.stop().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// REQ-B-8 — faucet caps under concurrent requests, across a restart
// ---------------------------------------------------------------------------

async function tokenAmount(v: Validator, ata: PublicKey): Promise<bigint | null> {
  try {
    const { value } = await v.connection.getTokenAccountBalance(ata);
    return BigInt(value.amount);
  } catch {
    return null;
  }
}

async function faucetPost(server: ServerHandle, wallet: string): Promise<JsonResponse> {
  return call(server, "POST", "/faucet", { body: { wallet } });
}

test("REVIEW-PROC-FAUCET-CONCURRENT-EXACTLY-ONCE: parallel drips stop exactly at the caps and the ledger survives a restart", async () => {
  const s = await scenario();
  const dir = mkdtempSync(join(tmpdir(), "review-faucet-proc-"));
  const dbPath = join(dir, "faucet.sqlite");
  const env = {
    JWT_SECRET,
    DATABASE_PATH: dbPath,
    FAUCET_ENABLED: "1",
    FAUCET_MINT: s.mint.toBase58(),
    FAUCET_MINT_AUTHORITY_KEYPAIR: s.validator.authorityKeypairPath,
    FAUCET_DRIP: "10000000",
    FAUCET_PER_WALLET_CAP: "20000000",
    FAUCET_GLOBAL_CAP: "40000000",
    KEEPER_INTERVAL_MS: "3600000",
  };
  let server = await startServer({ validator: s.validator, env });
  try {
    const w1 = Keypair.generate().publicKey.toBase58();
    // 6 concurrent requests for one wallet, a 2-drip budget ⇒ exactly 2 accept.
    const wave1 = await Promise.all(Array.from({ length: 6 }, () => faucetPost(server, w1)));
    const accepted1 = wave1.filter((res) => res.status === 200);
    const rejected1 = wave1.filter((res) => res.status === 429);
    const ledgerAfterWave = withDb(dbPath, (db) => db.raw.prepare("SELECT wallet, amount FROM faucet_credits").all());
    assert.equal(
      accepted1.length,
      2,
      `exactly 2 of 6 concurrent requests may fit the per-wallet budget (got ${accepted1.length}: ` +
        `${wave1.map((r) => r.status).join(",")}; ledger ${JSON.stringify(ledgerAfterWave)})`,
    );
    assert.equal(rejected1.length, 4, "the rest are 429 cap rejections");
    for (const res of rejected1) {
      assert.equal((res.body as { ok: false; error: { code: string } }).error.code, "faucet_cap_exceeded", "cap rejection code");
    }
    assert.equal(
      accepted1.map((res) => (res.body as { ok: true; data: FaucetResponse }).data.amount).every((a) => a === "10000000"),
      true,
      "each accepted drip mints exactly one configured drip",
    );
    const w1Ata = await getAssociatedTokenAddress(s.mint, new PublicKey(w1));
    assert.equal(await waitFor(() => tokenAmount(s.validator, w1Ata), (b) => b === 20_000_000n, "wallet 1's ATA"), 20_000_000n, "the two accepted drips land once each (no double-mint)");

    // Global cap: wallet 2 takes the remainder exactly (spent + drip == cap).
    const w2 = Keypair.generate().publicKey.toBase58();
    const w2a = await faucetPost(server, w2);
    const w2b = await faucetPost(server, w2);
    assert.equal(w2a.status, 200, "wallet 2 first drip within the global budget");
    assert.equal(w2b.status, 200, "wallet 2 second drip lands exactly on the global cap");
    const w2Ata = await getAssociatedTokenAddress(s.mint, new PublicKey(w2));
    assert.equal(await waitFor(() => tokenAmount(s.validator, w2Ata), (b) => b === 20_000_000n, "wallet 2's ATA"), 20_000_000n);

    // A fresh wallet is rejected and receives nothing.
    const w3 = Keypair.generate().publicKey.toBase58();
    const w3res = await faucetPost(server, w3);
    assert.equal(w3res.status, 429, "global budget exhausted ⇒ a fresh wallet is rejected");
    assert.equal(await tokenAmount(s.validator, await getAssociatedTokenAddress(s.mint, new PublicKey(w3))), null, "a rejected request creates no ATA and mints nothing");

    // Restart against the same store: the caps must persist (no reset ⇒ no
    // second helping, no double-credit).
    await server.stop();
    server = await startServer({ validator: s.validator, env });
    const replay = await faucetPost(server, w1);
    assert.equal(replay.status, 429, "the drip ledger must survive the restart (per-wallet cap still enforced)");
    assert.equal(
      await tokenAmount(s.validator, w1Ata),
      20_000_000n,
      "the wallet's balance is unchanged after the restart",
    );
    // The ledger equals the accepted drips exactly.
    const total = withDb(dbPath, (db) => db.sumFaucetCredits({}));
    assert.equal(total, 40_000_000n, "the faucet ledger accounts for exactly the accepted drips");
  } finally {
    await server.stop().catch(() => {});
  }
});
