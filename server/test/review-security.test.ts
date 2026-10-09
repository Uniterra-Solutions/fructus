//! REVIEW-AXIS C security tests — NEW FILE (the security checklist over
//! `server/**` as executable invariants; no existing test or src file is
//! touched).
//!
//! Everything runs in-process: `createApiServer` / `createFaucet` are
//! constructed directly with an in-memory SQLite store; every socket is
//! loopback and every fixture lives under `mkdtemp`. No validator, no devnet.
//!
//! Checklist mapping (prove-or-report):
//!   1 injection          → SEC-SQL-PARAMETERIZED
//!   3 authz / IDOR       → SEC-SESSION-BINDS-TO-WALLET, SEC-WS-TOKEN-GATE
//!   5 deserialization    → SEC-DESERIALIZATION-REJECTS
//!   6 JWT / nonce        → SEC-JWT-STRICT, SEC-NONCE-SINGLE-USE, SEC-WS-TOKEN-GATE
//!   10 info disclosure   → SEC-ERROR-ENVELOPE (redaction pin — SEC-10-1/-2:
//!                           no path / raw internal text in public envelopes)
//!   11 TOCTOU / races    → SEC-NONCE-SINGLE-USE, SEC-FAUCET-CAPS-RACE
//!
//! `SEC-ERROR-ENVELOPE` is a redaction pin (flipped by the F2 fix): the two
//! sub-tests assert that public error envelopes are generic — the operator
//! keypair path and raw internal error text stay OUT of caller-visible bodies,
//! in the server log only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";
import WebSocket from "ws";
import type {
  ActionResponse,
  ApiResponse,
  ChallengeResponse,
  HistoryResponse,
  PositionsResponse,
  SessionResponse,
  UserPortfolio,
} from "fructus-sdk/src/api.js";
import { createApiServer, type ApiServer } from "../src/api.js";
import { createAuth } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { FaucetCapError, OperatorUnconfiguredError } from "../src/errors.js";
import { createFaucet, type Faucet } from "../src/faucet.js";
import type { CancelAction, CloseAction, OperatorService, OrderAction } from "../src/operator.js";
import { attachWs } from "../src/ws.js";

const REVIEW_SECRET = "review-secret";

// ---------------------------------------------------------------------------
// Signers: ed25519 via node:crypto (same DER wrapping as the acceptance suites)
// ---------------------------------------------------------------------------

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

function makeSigner(): SiwsSigner {
  const keypair = Keypair.generate();
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

/** Sign `message` with the signer's ed25519 key; base58 the signature. Verifies locally first. */
function signSiws(signer: SiwsSigner, message: string): string {
  const bytes = Buffer.from(message, "utf8");
  const signature = edSign(null, bytes, signer.privateKey);
  assert.ok(
    edVerify(null, bytes, signer.publicKey, signature),
    "test-vector sanity: the locally produced ed25519 signature must verify against the locally derived key",
  );
  return base58Encode(signature);
}

/** A standard HS256 JWT crafted with the given payload/secret (for strictness probes). */
function craftHs256Jwt(payload: Record<string, unknown>, secret: string, alg = "HS256"): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg, typ: "JWT" });
  const claims = encode(payload);
  const signature = createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url");
  return `${header}.${claims}.${signature}`;
}

// ---------------------------------------------------------------------------
// In-process server + faucet scaffolding
// ---------------------------------------------------------------------------

interface CapturedAction {
  kind: string;
  user: string;
  payload: unknown;
}

interface InProcessServer {
  apiUrl: string;
  db: Db;
  close(): Promise<void>;
}

interface JsonResponse {
  status: number;
  body: ApiResponse<unknown> | null;
  text: string;
}

async function call(
  server: InProcessServer,
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
  assert.equal(body.ok, true, `${what} must use the success envelope (got: ${res.text.slice(0, 200)})`);
  return (body as { ok: true; data: T }).data;
}

function expect401(res: JsonResponse, what: string): void {
  assert.equal(res.status, 401, `${what} must answer 401 (got ${res.status}: ${res.text.slice(0, 200)})`);
  const body = res.body;
  assert.ok(body !== null, `${what} must answer the unified JSON envelope (got: ${res.text.slice(0, 200)})`);
  const failure = body as { ok: false; error: { code: string } };
  assert.equal(failure.ok, false, `${what} must use the failure envelope`);
  assert.equal(failure.error.code, "unauthorized", `${what} must report code "unauthorized"`);
}

function expectStatus(res: JsonResponse, status: number, what: string): void {
  assert.equal(res.status, status, `${what} must answer ${status} (got ${res.status}: ${res.text.slice(0, 200)})`);
  assert.ok(res.body !== null, `${what} must answer the unified JSON envelope (got: ${res.text.slice(0, 200)})`);
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    rpcUrl: "http://127.0.0.1:1",
    databasePath: ":memory:",
    jwtSecret: REVIEW_SECRET,
    operatorKeypairPath: null,
    port: 0,
    keeperIntervalMs: 5_000,
    markSampleIntervalMs: 5_000,
    faucetEnabled: false,
    faucetMint: null,
    faucetMintAuthorityKeypair: null,
    faucetPerWalletCap: 0n,
    faucetGlobalCap: 0n,
    faucetDrip: 0n,
    ...overrides,
  };
}

function makePortfolio(wallet: string, deposited: string): UserPortfolio {
  return {
    wallet,
    deposited,
    reserved: "0",
    claimable: "0",
    free: deposited,
    equity: deposited,
    requirementInitial: "0",
    requirementMaint: "0",
    health: "healthy",
    operator: null,
    positions: [
      { side: 0, notional: `${wallet.length}`, upnl: "0", reqInitial: "0", reqMaint: "0" },
    ],
  };
}

/** Operator stub: records (kind, user, payload) and resolves confirmed. */
function makeOperatorStub(captured: CapturedAction[]): OperatorService {
  const record = (kind: string, user: string, payload: unknown): Promise<ActionResponse> => {
    captured.push({ kind, user, payload });
    return Promise.resolve({
      actionId: `${kind}-${captured.length}`,
      signature: "review-sig",
      status: "confirmed",
    } satisfies ActionResponse);
  };
  return {
    executeDeposit: (user: string, amount: bigint) => record("deposit", user, amount),
    executeWithdraw: (user: string, amount: bigint) => record("withdraw", user, amount),
    executeOrder: (user: string, order: OrderAction) => record("order", user, order),
    executeCancel: (user: string, cancel: CancelAction) => record("cancel", user, cancel),
    executeClose: (user: string, close: CloseAction) => record("close", user, close),
    queueDepth: () => 0,
  };
}

interface MakeServerOptions {
  db?: Db;
  captured?: CapturedAction[];
  getOperatorPubkey?: () => PublicKey;
  getPortfolio?: (wallet: PublicKey) => UserPortfolio;
  faucet?: Faucet | null;
}

async function makeServer(opts: MakeServerOptions = {}): Promise<InProcessServer> {
  const db = opts.db ?? openDb(":memory:");
  const auth = createAuth({ db, jwtSecret: REVIEW_SECRET, domain: "review.test" });
  const operator = makeOperatorStub(opts.captured ?? []);
  const api: ApiServer = createApiServer({
    config: makeConfig(),
    db,
    auth,
    operator,
    keeper: {
      tick: async () => ({ cranked: 0, settledFills: 0, settledFunding: 0, settledClose: 0, liquidated: 0 }),
      start: () => undefined,
      stop: () => undefined,
    },
    faucet: opts.faucet ?? null,
    connection: new Connection("http://127.0.0.1:1", "confirmed"),
    programId: Keypair.generate().publicKey,
    market: Keypair.generate().publicKey,
    getOperatorPubkey: opts.getOperatorPubkey ?? (() => Keypair.generate().publicKey),
    getPortfolio: opts.getPortfolio ?? ((wallet) => makePortfolio(wallet.toBase58(), "0")),
    getMarket: () => ({ mark: null, index: "0", fundingAccumulator: "0", bestBid: null, bestAsk: null }),
    getBook: () => ({ bids: [], asks: [] }),
  });
  const port = await api.start(0);
  return { apiUrl: `http://127.0.0.1:${port}`, db, close: () => api.close() };
}

/** Full SIWS round-trip against an in-process server; returns the JWT. */
async function login(server: InProcessServer, signer: SiwsSigner): Promise<string> {
  const wallet = signer.keypair.publicKey.toBase58();
  const challenge = expectOk<ChallengeResponse>(
    await call(server, "POST", "/auth/challenge", { body: { wallet } }),
    `POST /auth/challenge for ${wallet}`,
  );
  assert.ok(typeof challenge.signInInput === "string" && challenge.signInInput.length > 0, "challenge must carry signInInput");
  const signature = signSiws(signer, challenge.signInInput);
  const session = expectOk<SessionResponse>(
    await call(server, "POST", "/auth/verify", { body: { wallet, signature, signInInput: challenge.signInInput } }),
    `POST /auth/verify for ${wallet}`,
  );
  assert.equal(session.wallet, wallet, "the session must belong to the signing wallet");
  return session.token;
}

// ---------------------------------------------------------------------------
// SEC-SESSION-BINDS-TO-WALLET (checklist 3: authorization / IDOR)
// ---------------------------------------------------------------------------

test("SEC-SESSION-BINDS-TO-WALLET: a session token can only read and act on its own wallet's rows across /me* and every /actions/* route.", async (t) => {
  const walletA = makeSigner();
  const walletB = makeSigner();
  const addressA = walletA.keypair.publicKey.toBase58();
  const addressB = walletB.keypair.publicKey.toBase58();
  const captured: CapturedAction[] = [];
  const server = await makeServer({
    captured,
    getPortfolio: (wallet) => {
      const address = wallet.toBase58();
      return makePortfolio(address, address === addressA ? "111" : "222");
    },
  });

  try {
    const tokenA = await login(server, walletA);

    await t.test("GET /me returns the token's wallet — never the other wallet, never a query-param target", async () => {
      const me = expectOk<UserPortfolio>(await call(server, "GET", "/me", { token: tokenA }), "GET /me with A's token");
      assert.equal(me.wallet, addressA, "GET /me must serve the JWT sub's wallet");
      assert.equal(me.deposited, "111", "GET /me must serve A's seeded row (non-vacuous: B's is 222)");

      // Hostile attempt: target B through the query string — the route ignores it.
      const spoofed = expectOk<UserPortfolio>(
        await call(server, "GET", `/me?wallet=${addressB}&user=${addressB}`, { token: tokenA }),
        "GET /me with a forged wallet query parameter",
      );
      assert.equal(spoofed.wallet, addressA, "a query parameter must not re-target /me");
      assert.equal(spoofed.deposited, "111", "a query parameter must not leak B's rows");
    });

    await t.test("GET /me/positions serves only the token's wallet", async () => {
      const positions = expectOk<PositionsResponse>(
        await call(server, "GET", "/me/positions", { token: tokenA }),
        "GET /me/positions with A's token",
      );
      assert.equal(positions.positions.length, 1, "A's stub portfolio carries exactly one position");
      assert.equal(positions.positions[0]?.notional, String(addressA.length), "the served position must be A's");
      // Non-vacuity control: B's portfolio computes a different notional only
      // when the addresses differ in length; assert the route was called for A
      // by re-deriving A's portfolio and comparing.
      const expectedA = makePortfolio(addressA, "111");
      assert.deepEqual(positions.positions, expectedA.positions, "the served positions must equal A's portfolio");
    });

    await t.test("GET /me/history only lists the token wallet's fills", async () => {
      server.db.insertFill({ seq: 1, slot: 10, market: "m", owner: addressA, side: 0, price: "1", size: "2" });
      server.db.insertFill({ seq: 2, slot: 11, market: "m", owner: addressB, side: 1, price: "3", size: "4" });
      // Non-vacuity: both rows are in the store before the read.
      assert.equal(server.db.listFills().length, 2, "the store must hold both wallets' fills before the scoped read");

      const historyRes = await call(server, "GET", "/me/history", { token: tokenA });
      const history = expectOk<HistoryResponse>(historyRes, "GET /me/history with A's token");
      const seqs = history.entries.map((entry) => entry.seq);
      assert.deepEqual(seqs, ["1"], `history must serve exactly A's fill (got ${JSON.stringify(seqs)})`);
      assert.ok(
        !historyRes.text.includes(addressB),
        "the history body must not mention the other wallet's address",
      );
    });

    await t.test("every /actions/* route executes for the token's wallet even when the body names another", async () => {
      const cases: Array<{ path: string; body: Record<string, unknown> }> = [
        { path: "/actions/deposit", body: { amount: "1000", wallet: addressB, user: addressB } },
        { path: "/actions/withdraw", body: { amount: "1000", wallet: addressB, user: addressB } },
        { path: "/actions/orders", body: { kind: "limit", side: 0, size: "5", price: "7", wallet: addressB, user: addressB } },
        { path: "/actions/orders/cancel", body: { side: 1, seq: "3", wallet: addressB, user: addressB } },
        { path: "/actions/positions/close", body: { side: 0, size: "5", wallet: addressB, user: addressB } },
      ];
      for (const { path, body } of cases) {
        const res = await call(server, "POST", path, { token: tokenA, body });
        expectOk<ActionResponse>(res, `POST ${path} with A's token and a decoy wallet in the body`);
      }
      assert.equal(captured.length, cases.length, "every action route must have reached the operator service");
      for (const action of captured) {
        assert.equal(action.user, addressA, `operator action ${action.kind} must run for the token's wallet, not the body's`);
      }
      assert.ok(
        !JSON.stringify(captured, (_key, value) => (typeof value === "bigint" ? value.toString() : value)).includes(addressB),
        "no captured action payload may carry the decoy wallet",
      );
    });
  } finally {
    await server.close();
    server.db.close();
  }
});

// ---------------------------------------------------------------------------
// SEC-JWT-STRICT (checklist 6: broken auth / session / JWT)
// ---------------------------------------------------------------------------

test("SEC-JWT-STRICT: tampered, expired, wrong-secret and alg-none tokens are rejected; a valid token is the positive control.", async (t) => {
  const signer = makeSigner();
  const wallet = signer.keypair.publicKey.toBase58();
  const other = makeSigner().keypair.publicKey.toBase58();
  const server = await makeServer();

  try {
    const token = await login(server, signer);
    // Positive control: the issued token clears the gate.
    const me = expectOk<UserPortfolio>(await call(server, "GET", "/me", { token }), "GET /me with the freshly issued token");
    assert.equal(me.wallet, wallet, "the positive control must serve the session's wallet");

    await t.test("a re-encoded payload (sub swapped to another wallet) keeps the old signature and is rejected", async () => {
      const [header, payload, signature] = token.split(".");
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
      assert.equal(claims.sub, wallet, "the issued token must carry the wallet as sub");
      const forgedPayload = Buffer.from(JSON.stringify({ ...claims, sub: other })).toString("base64url");
      const forged = `${header}.${forgedPayload}.${signature}`;
      expect401(await call(server, "GET", "/me", { token: forged }), "GET /me with a swapped sub and the old signature");
    });

    await t.test("an expired token is rejected", async () => {
      const expired = craftHs256Jwt({ sub: wallet, exp: Math.floor(Date.now() / 1000) - 60 }, REVIEW_SECRET);
      expect401(await call(server, "GET", "/me", { token: expired }), "GET /me with an expired token");
    });

    await t.test("a token without exp is rejected", async () => {
      const noExp = craftHs256Jwt({ sub: wallet }, REVIEW_SECRET);
      expect401(await call(server, "GET", "/me", { token: noExp }), "GET /me with a token that carries no exp");
    });

    await t.test("a token signed with a different secret is rejected", async () => {
      const foreign = craftHs256Jwt({ sub: wallet, exp: Math.floor(Date.now() / 1000) + 3_600 }, "other-secret");
      expect401(await call(server, "GET", "/me", { token: foreign }), "GET /me with a foreign-secret token");
    });

    await t.test("an alg=none token is rejected", async () => {
      const payload = Buffer.from(
        JSON.stringify({ sub: wallet, exp: Math.floor(Date.now() / 1000) + 3_600 }),
      ).toString("base64url");
      const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${payload}.`;
      expect401(await call(server, "GET", "/me", { token: none }), "GET /me with an alg=none token");
    });

    await t.test("a garbage / multi-segment token is rejected", async () => {
      for (const bad of ["not-a-jwt", "a.b", "a.b.c.d", "...", `${token}.extra`]) {
        expect401(await call(server, "GET", "/me", { token: bad }), `GET /me with token ${JSON.stringify(bad)}`);
      }
    });
  } finally {
    await server.close();
    server.db.close();
  }
});

// ---------------------------------------------------------------------------
// SEC-NONCE-SINGLE-USE (checklists 6 + 11: replay / nonce consume race)
// ---------------------------------------------------------------------------

test("SEC-NONCE-SINGLE-USE: two concurrent verifies of one challenge yield exactly one session; a challenge is bound to its wallet.", async (t) => {
  const signerA = makeSigner();
  const signerB = makeSigner();
  const server = await makeServer();

  try {
    await t.test("concurrent verify of the same challenge: exactly one 200, one 401, one ledger consume", async () => {
      const wallet = signerA.keypair.publicKey.toBase58();
      const challenge = expectOk<ChallengeResponse>(
        await call(server, "POST", "/auth/challenge", { body: { wallet } }),
        "POST /auth/challenge",
      );
      const signature = signSiws(signerA, challenge.signInInput);
      const body = { wallet, signature, signInInput: challenge.signInInput };

      const [first, second] = await Promise.all([
        call(server, "POST", "/auth/verify", { body }),
        call(server, "POST", "/auth/verify", { body }),
      ]);
      const statuses = [first.status, second.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 401], `exactly one concurrent verify may win (got ${JSON.stringify(statuses)})`);

      // The winner's token is a real session; the loser's is nothing.
      const winner = first.status === 200 ? first : second;
      const winnerToken = expectOk<SessionResponse>(winner, "the winning verify").token;
      const me = expectOk<UserPortfolio>(await call(server, "GET", "/me", { token: winnerToken }), "GET /me with the winner's token");
      assert.equal(me.wallet, wallet, "the winner's token belongs to the wallet");

      const row = server.db.raw
        .prepare("SELECT consumed FROM auth_nonces WHERE nonce = ?")
        .get(challenge.nonce) as { consumed?: number } | undefined;
      assert.equal(Number(row?.consumed), 1, "the nonce row must be consumed exactly once");
    });

    await t.test("wallet B's challenge cannot be consumed for wallet A, and A's signature cannot speak for B", async () => {
      const addressB = signerB.keypair.publicKey.toBase58();
      const challenge = expectOk<ChallengeResponse>(
        await call(server, "POST", "/auth/challenge", { body: { wallet: addressB } }),
        "POST /auth/challenge for B",
      );
      const signatureOverB = signSiws(signerA, challenge.signInInput); // A's key over B's message

      // (a) Submitted as wallet A: B's challenge row does not belong to A.
      expect401(
        await call(server, "POST", "/auth/verify", {
          body: { wallet: signerA.keypair.publicKey.toBase58(), signature: signatureOverB, signInInput: challenge.signInInput },
        }),
        "verifying B's challenge as A",
      );

      // (b) Submitted as wallet B: the signature is not B's.
      expect401(
        await call(server, "POST", "/auth/verify", {
          body: { wallet: addressB, signature: signatureOverB, signInInput: challenge.signInInput },
        }),
        "verifying B's challenge with A's signature",
      );

      // (c) Positive control: B's own signature still works after the two failures.
      const signatureB = signSiws(signerB, challenge.signInInput);
      const session = expectOk<SessionResponse>(
        await call(server, "POST", "/auth/verify", {
          body: { wallet: addressB, signature: signatureB, signInInput: challenge.signInInput },
        }),
        "the positive control: B verifies B's challenge",
      );
      assert.equal(session.wallet, addressB, "the session belongs to B");
    });
  } finally {
    await server.close();
    server.db.close();
  }
});

// ---------------------------------------------------------------------------
// SEC-FAUCET-CAPS-RACE (checklist 11: TOCTOU on the faucet caps)
// ---------------------------------------------------------------------------

/** Connection stub: the faucet only needs account-info/blockhash/send/confirm. */
function stubConnection(counters: { sends: number }): Connection {
  const stub = {
    getAccountInfo: async () => null,
    getLatestBlockhash: async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
    }),
    sendRawTransaction: async () => {
      counters.sends += 1;
      return "review-faucet-sig";
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  return stub as unknown as Connection;
}

test("SEC-FAUCET-CAPS-RACE: concurrent faucet calls cannot exceed the per-wallet or global 24 h cap.", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fructus-review-sec-"));
  const authorityPath = join(dir, "authority.json");
  writeFileSync(authorityPath, JSON.stringify(Array.from(Keypair.generate().secretKey)));

  try {
    await t.test("two concurrent requests for one wallet: exactly one drip mints", async () => {
      const db = openDb(":memory:");
      try {
        const counters = { sends: 0 };
        const faucet = createFaucet({
          config: makeConfig({
            faucetEnabled: true,
            faucetMint: Keypair.generate().publicKey.toBase58(),
            faucetMintAuthorityKeypair: authorityPath,
            faucetPerWalletCap: 10n,
            faucetGlobalCap: 1_000n,
            faucetDrip: 10n,
          }),
          connection: stubConnection(counters),
          db,
        });
        const wallet = Keypair.generate().publicKey.toBase58();

        const results = await Promise.allSettled([faucet.handle({ wallet }), faucet.handle({ wallet })]);
        const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ amount: string; ata: string }> => r.status === "fulfilled");
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        assert.equal(fulfilled.length, 1, `exactly one of two concurrent calls may mint (got ${fulfilled.length})`);
        assert.equal(rejected.length, 1, "the other concurrent call must be rejected");
        assert.ok(
          rejected[0]!.reason instanceof FaucetCapError,
          `the rejection must be the cap error (got ${String(rejected[0]!.reason)})`,
        );
        assert.equal(fulfilled[0]!.value.amount, "10", "the accepted call mints exactly one drip");
        assert.equal(db.sumFaucetCredits({ wallet }), 10n, "the 24 h ledger must hold exactly one drip");
        assert.equal(counters.sends, 1, "exactly one mint transaction may be sent");
      } finally {
        db.close();
      }
    });

    await t.test("two concurrent requests for different wallets: exactly one drip against the global cap", async () => {
      const db = openDb(":memory:");
      try {
        const counters = { sends: 0 };
        const faucet = createFaucet({
          config: makeConfig({
            faucetEnabled: true,
            faucetMint: Keypair.generate().publicKey.toBase58(),
            faucetMintAuthorityKeypair: authorityPath,
            faucetPerWalletCap: 1_000n,
            faucetGlobalCap: 10n,
            faucetDrip: 10n,
          }),
          connection: stubConnection(counters),
          db,
        });
        const walletX = Keypair.generate().publicKey.toBase58();
        const walletY = Keypair.generate().publicKey.toBase58();

        const results = await Promise.allSettled([faucet.handle({ wallet: walletX }), faucet.handle({ wallet: walletY })]);
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        assert.equal(fulfilled.length, 1, `exactly one global-budget drip may mint (got ${fulfilled.length})`);
        assert.equal(rejected.length, 1, "the other wallet must be rejected once the global budget is spent");
        assert.ok(rejected[0]!.reason instanceof FaucetCapError, "the rejection must be the cap error");
        assert.equal(db.sumFaucetCredits(), 10n, "the global 24 h ledger must hold exactly one drip");
        assert.equal(counters.sends, 1, "exactly one mint transaction may be sent");
      } finally {
        db.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SEC-SQL-PARAMETERIZED (checklist 1: injection)
// ---------------------------------------------------------------------------

test("SEC-SQL-PARAMETERIZED: hostile strings round-trip as data through every user-reachable query.", async (t) => {
  const hostile = "x'; DROP TABLE faucet_credits; --";
  const tautology = "' OR '1'='1";

  await t.test("the faucet ledger stores and matches hostile wallet strings literally", () => {
    const db = openDb(":memory:");
    try {
      db.insertFaucetCredit(hostile, 1n, Date.now());
      db.insertFaucetCredit("alice", 5n, Date.now());
      assert.equal(db.sumFaucetCredits({ wallet: hostile }), 1n, "the hostile string must round-trip as an exact match");
      assert.equal(db.sumFaucetCredits({ wallet: tautology }), 0n, "a tautology string must not match other rows");
      const count = db.raw.prepare("SELECT count(*) AS n FROM faucet_credits").get() as { n?: number } | undefined;
      assert.equal(Number(count?.n), 2, "the table must survive and hold exactly the two inserted rows");
    } finally {
      db.close();
    }
  });

  await t.test("the fills history read binds the owner parameter", () => {
    const db = openDb(":memory:");
    try {
      db.insertFill({ seq: 1, slot: 1, market: "m", owner: hostile, side: 0, price: "1", size: "2" });
      db.insertFill({ seq: 2, slot: 1, market: "m", owner: "alice", side: 0, price: "1", size: "2" });
      assert.equal(db.listFills({ owner: hostile }).length, 1, "the hostile owner must match exactly its own row");
      assert.equal(db.listFills({ owner: tautology }).length, 0, "a tautology owner must match nothing");
      assert.equal(db.listFills().length, 2, "the table must survive and hold both rows");
    } finally {
      db.close();
    }
  });

  await t.test("a hostile wallet on the wire is rejected before any query", async () => {
    const server = await makeServer();
    try {
      const res = await call(server, "POST", "/auth/challenge", { body: { wallet: hostile } });
      expectStatus(res, 400, "POST /auth/challenge with a hostile wallet string");
      const count = server.db.raw.prepare("SELECT count(*) AS n FROM auth_nonces").get() as { n?: number } | undefined;
      assert.equal(Number(count?.n), 0, "no nonce row may be written for a rejected wallet");
    } finally {
      await server.close();
      server.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// SEC-DESERIALIZATION-REJECTS (checklist 5: insecure deserialization)
// ---------------------------------------------------------------------------

test("SEC-DESERIALIZATION-REJECTS: malformed JSON, wrong body shapes, bad base64 transactions and out-of-range amounts are rejected with 400.", async (t) => {
  const signer = makeSigner();
  const server = await makeServer();

  try {
    const token = await login(server, signer);

    await t.test("raw non-JSON bodies are rejected", async () => {
      const res = await fetch(`${server.apiUrl}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });
      const text = await res.text();
      assert.equal(res.status, 400, `a non-JSON body must be a 400 (got ${res.status}: ${text.slice(0, 160)})`);
      assert.ok(text.includes('"bad_request"'), "the rejection must use the unified error envelope");
    });

    await t.test("a JSON array body is rejected (object only)", async () => {
      expectStatus(
        await call(server, "POST", "/auth/challenge", { body: [1, 2, 3] as unknown }),
        400,
        "POST /auth/challenge with an array body",
      );
    });

    await t.test("malformed base64 transactions on /bind/confirm are rejected before any chain read", async () => {
      const cases: Array<[string, string]> = [
        ["not base64 at all", "###not-base64###"],
        ["base64 of non-transaction bytes", Buffer.from("definitely not a transaction").toString("base64")],
        ["empty string", ""],
      ];
      for (const [what, transaction] of cases) {
        const res = await call(server, "POST", "/bind/confirm", { body: { transaction, signature: "sig" } });
        expectStatus(res, 400, `POST /bind/confirm with ${what}`);
        const failure = res.body as { ok: false; error: { code: string } };
        assert.equal(failure.ok, false, "the rejection must use the failure envelope");
        assert.equal(failure.error.code, "bad_request", "the rejection must report bad_request");
      }
    });

    await t.test("amount/side DTO hostiles on /actions/* are rejected with 400", async () => {
      const amountCases = ["12x", "-1", "1e3", "0x10", "18446744073709551616", "", "1 2"];
      for (const amount of amountCases) {
        const res = await call(server, "POST", "/actions/deposit", { token, body: { amount } });
        expectStatus(res, 400, `POST /actions/deposit with amount ${JSON.stringify(amount)}`);
      }
      const sideCases: unknown[] = [2, -1, "0", null, 1.5];
      for (const side of sideCases) {
        const res = await call(server, "POST", "/actions/positions/close", { token, body: { side, size: "5" } });
        expectStatus(res, 400, `POST /actions/positions/close with side ${JSON.stringify(side)}`);
      }
      // Positive control: a valid amount still reaches the operator service.
      const ok = await call(server, "POST", "/actions/deposit", { token, body: { amount: "1000" } });
      expectOk<ActionResponse>(ok, "POST /actions/deposit with a valid amount");
    });
  } finally {
    await server.close();
    server.db.close();
  }
});

// ---------------------------------------------------------------------------
// SEC-WS-TOKEN-GATE (checklist 3 + 6: session binding on the push channel)
// ---------------------------------------------------------------------------

test("SEC-WS-TOKEN-GATE: the push channel closes unauthenticated sockets with 4401 and routes only to the token's wallet.", async (t) => {
  const db = openDb(":memory:");
  const auth = createAuth({ db, jwtSecret: REVIEW_SECRET, domain: "review.test" });
  const httpServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wsHandle = attachWs({
    server: httpServer,
    auth,
    market: Keypair.generate().publicKey,
    computePortfolio: (wallet) => makePortfolio(wallet.toBase58(), "0"),
    computeBook: () => ({ bids: [], asks: [] }),
    computeMarket: () => ({ mark: null, index: "0", fundingAccumulator: "0", bestBid: null, bestAsk: null }),
  });
  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  /** Connect and resolve with the close code if the server closes within 2 s. */
  function closedWithCode(suffix: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${suffix}`);
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`no close within 2s for ${JSON.stringify(suffix)}`));
      }, 2_000);
      socket.on("close", (code: number) => {
        clearTimeout(timer);
        resolve(code);
      });
      socket.on("error", () => {
        /* the close event still follows */
      });
    });
  }

  try {
    await t.test("no token / garbage token / empty token close with 4401", async () => {
      for (const suffix of ["", "?token=garbage", "?token="]) {
        const code = await closedWithCode(suffix);
        assert.equal(code, 4401, `ws${suffix} must close with 4401 (got ${code})`);
      }
    });

    await t.test("a valid token opens the socket, and pushes reach only its own wallet", async () => {
      const signer = makeSigner();
      const wallet = signer.keypair.publicKey.toBase58();
      const challenge = auth.challenge(wallet);
      const signature = signSiws(signer, challenge.signInInput);
      const session = await auth.verify(wallet, signature, challenge.signInInput);

      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(session.token)}`);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("close", (code: number) => reject(new Error(`valid token closed prematurely with ${code}`)));
        socket.once("error", (err: Error) => reject(err));
      });

      const received: string[] = [];
      socket.on("message", (data: Buffer) => received.push(data.toString("utf8")));

      const otherWallet = makeSigner().keypair.publicKey.toBase58();
      const message = { type: "tx" as const, action: { actionId: "review-1", status: "confirmed" as const } };
      wsHandle.sendToWallet(otherWallet, message); // must not arrive
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(received.length, 0, "a push to a different wallet must not reach this socket");

      wsHandle.sendToWallet(wallet, message);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(received.length, 1, "the wallet's own push must arrive");
      assert.deepEqual(JSON.parse(received[0]!) as unknown, message, "the pushed message must round-trip");

      socket.terminate();
    });
  } finally {
    await wsHandle.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
  }
});

// ---------------------------------------------------------------------------
// SEC-ERROR-ENVELOPE (checklist 10: information disclosure) — REDACTION PIN
// ---------------------------------------------------------------------------

test("SEC-ERROR-ENVELOPE (redaction pin): internal error text — operator keypair path, db path — never reaches callers.", async (t) => {
  // Flipped by the F2 fix (SEC-10-1/-2): the public /bind/prepare route and the
  // generic 500 fallback used to reflect raw internal error text (absolute
  // filesystem paths). Both sub-tests below feed a path-bearing error — the
  // worst case an upstream thrower can produce — and assert the PUBLIC envelope
  // stays generic while the detail is kept for the server log.

  const secretPath = "/root/.fructus-secrets/operator.json";
  const dbPath = "/var/lib/fructus/index.sqlite";

  await t.test("public POST /bind/prepare does NOT reveal the operator keypair file path", async () => {
    // Reproduce the exact message production the un-fixed src/index.ts used at
    // :57-65: a failed readFileSync of the configured keypair path, wrapped in
    // the OperatorUnconfiguredError. The API layer must redact it even when an
    // upstream message still embeds the fs detail.
    let fsDetail = "";
    assert.ok(!existsSync(secretPath), "the review fixture path must not exist before the probe");
    try {
      readFileSync(secretPath, "utf8");
      throw new Error("unreachable: the fixture path unexpectedly exists");
    } catch (err) {
      fsDetail = err instanceof Error ? err.message : String(err);
    }
    assert.ok(fsDetail.includes(secretPath), "the fs error itself is expected to carry the path (Node behavior)");

    const server = await makeServer({
      getOperatorPubkey: () => {
        throw new OperatorUnconfiguredError(`cannot load the operator keypair (${fsDetail})`);
      },
    });
    try {
      const wallet = Keypair.generate().publicKey.toBase58();
      const res = await call(server, "POST", "/bind/prepare", { body: { wallet } });
      expectStatus(res, 501, "POST /bind/prepare with an unreadable operator keypair");
      const failure = res.body as { ok: false; error: { code: string; message: string } };
      assert.equal(failure.error.code, "operator_unconfigured", "the code must be operator_unconfigured");
      assert.ok(
        !failure.error.message.includes(secretPath),
        `SEC-10-1: the public envelope must NOT carry the operator keypair path (message: ${failure.error.message})`,
      );
      assert.ok(
        !failure.error.message.includes(fsDetail),
        `SEC-10-1: the public envelope must NOT echo the raw fs error (message: ${failure.error.message})`,
      );
      assert.ok(
        failure.error.message.includes("unavailable"),
        `SEC-10-1: the envelope must be the generic operator-unavailable message (message: ${failure.error.message})`,
      );
    } finally {
      await server.close();
      server.db.close();
    }
  });

  await t.test("an internal failure on GET /me is redacted in the 500 envelope", async () => {
    const signer = makeSigner();
    const server = await makeServer({
      getPortfolio: (wallet) => {
        if (!wallet) throw new Error("unreachable");
        throw new Error(`sqlite open failed at ${dbPath}`);
      },
    });
    try {
      const token = await login(server, signer);
      const res = await call(server, "GET", "/me", { token });
      expectStatus(res, 500, "GET /me when the state layer throws");
      const failure = res.body as { ok: false; error: { code: string; message: string } };
      assert.equal(failure.error.code, "internal", "the code must be internal");
      assert.ok(
        !failure.error.message.includes(dbPath),
        `SEC-10-2: the 500 envelope must NOT carry the raw internal path (message: ${failure.error.message})`,
      );
      assert.ok(
        !failure.error.message.includes("sqlite open failed"),
        `SEC-10-2: the 500 envelope must NOT echo the raw internal message (message: ${failure.error.message})`,
      );
    } finally {
      await server.close();
      server.db.close();
    }
  });
});
