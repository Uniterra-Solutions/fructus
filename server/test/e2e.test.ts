//! RED acceptance tests for the end-to-end product walk (REQ-B-9, D2/D4/D5)
//! and the operator service (REQ-B-5):
//!
//!  - `E2E-PRODUCT-WALK`: against a live `solana-test-validator` + the v2
//!    program and a real server, the walk
//!    `faucet → SIWS login → bind → deposit → open → close → withdraw`
//!    succeeds with the operator as the SOLE signer of the operator steps;
//!    every step asserts the on-chain state through the SDK decoders and the
//!    `tx_log` row through the server's SQLite store.
//!  - `OPERATOR-SERVICE-SIGNS-AND-CONFIRMS`: a service action lands on-chain
//!    (observed state change) and its `tx_log` row reaches `confirmed` with a
//!    signature — focused on the deposit leg with a fresh trader.
//!
//! The bind leg is driven semantically (REQ-B-9 / D4): `POST /bind/prepare`
//! must return a signable artifact (the DTO pins a base64 transaction —
//! `[spl approve(Operator PDA, u64::MAX), set_operator]`); the test signs it
//! with the user alone, submits it, and asserts the resulting on-chain
//! `Operator` record.
//!
//! RED on today's tree: every route but `/healthz` answers 501, and the SDK
//! operator surface (`buildOperatorBindInstructions`/`decodeOperator`) is still
//! a stub — so the assertions below fail behaviourally (expected 200, got 501).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import {
  Keypair,
  Transaction,
  type PublicKey,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import type {
  ActionResponse,
  ApiResponse,
  BindConfirmResponse,
  BindPrepareResponse,
  ChallengeResponse,
  FaucetResponse,
  SessionResponse,
} from "fructus-sdk/src/api.js";
import {
  buildPlaceLimitOrder,
  decodeOperator,
  decodePerpMarket,
  decodePosition,
  decodeUserCollateral,
  marginRequired,
  operatorPda,
  positionPda,
  userCollateralPda,
  type PerpMarketState,
  type PositionState,
  type UserCollateralState,
} from "fructus-sdk/src/index.js";
import { openDb, type TxLogRow } from "../src/db.js";
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
// Chain + tx_log readers (SDK decoders, node:sqlite)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded poll of a derived value; returns the last observation when unmatched. */
async function waitForValue<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) return value;
    await sleep(250);
  }
}

async function accountData(v: Validator, address: PublicKey): Promise<Buffer | null> {
  const info = await v.connection.getAccountInfo(address);
  return info === null ? null : Buffer.from(info.data);
}

function collateralPda(s: Scenario, trader: PublicKey): PublicKey {
  return userCollateralPda(s.market.market, trader, s.validator.programId).address;
}

function longPositionPda(s: Scenario, trader: PublicKey): PublicKey {
  return positionPda(s.market.market, trader, 0, s.validator.programId).address;
}

async function readCollateral(s: Scenario, trader: PublicKey): Promise<UserCollateralState | null> {
  return decodeUserCollateral(await accountData(s.validator, collateralPda(s, trader)));
}

async function readLongPosition(s: Scenario, trader: PublicKey): Promise<PositionState | null> {
  return decodePosition(await accountData(s.validator, longPositionPda(s, trader)));
}

async function readMarket(s: Scenario): Promise<PerpMarketState | null> {
  return decodePerpMarket(await accountData(s.validator, s.market.market));
}

async function tokenBalance(v: Validator, ata: PublicKey): Promise<bigint> {
  const { value } = await v.connection.getTokenAccountBalance(ata);
  return BigInt(value.amount);
}

/** The server's tx_log row for `actionId` (its own SQLite store, REQ-B-5). */
function readTxLog(dbPath: string, actionId: string): TxLogRow | null {
  const db = openDb(dbPath);
  try {
    return db.getTxLog(actionId);
  } finally {
    db.close();
  }
}

/** Bounded wait for the tx_log row to reach `confirmed`; fails on `failed`. */
async function txLogReachesConfirmed(s: Scenario, actionId: string, signature: string, label: string): Promise<TxLogRow> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const row = readTxLog(s.server.dbPath, actionId);
    if (row !== null) {
      if (row.status === "failed") {
        assert.fail(`${label}: tx_log ${actionId} reached failed (${row.error ?? "no error"})`);
      }
      if (row.status === "confirmed") {
        assert.equal(row.signature, signature, `${label}: the confirmed tx_log row must carry the action's signature`);
        return row;
      }
    }
    if (Date.now() >= deadline) {
      assert.ok(
        row !== null,
        `${label}: no tx_log row for actionId ${actionId} within the bounded wait — the operator service must record every attempt (REQ-B-5)`,
      );
      assert.equal(row.status, "confirmed", `${label}: the tx_log row must reach confirmed (got ${row.status})`);
      return row;
    }
    await sleep(250);
  }
}

/** One `/actions/*` call: envelope + ActionResponse contract + returned values. */
async function serviceAction(
  s: Scenario,
  token: string,
  path: string,
  body: unknown,
  label: string,
): Promise<{ action: ActionResponse; signature: string }> {
  const res = await call(s.server, "POST", path, { token, body });
  const action = expectOk<ActionResponse>(res, `${label} (POST ${path})`);
  assert.ok(
    typeof action.actionId === "string" && action.actionId.length > 0,
    `${label}: the response must carry the tx_log actionId (got ${JSON.stringify(action.actionId)})`,
  );
  assert.ok(
    ["queued", "sent", "confirmed", "failed"].includes(action.status),
    `${label}: status must be an ActionResponse state (got ${JSON.stringify(action.status)})`,
  );
  assert.notEqual(action.status, "failed", `${label}: the action must not fail (error: ${JSON.stringify(action.error)})`);
  assert.ok(
    typeof action.signature === "string" && action.signature.length > 0,
    `${label}: a landed action must carry its base58 signature (got ${JSON.stringify(action.signature)})`,
  );
  return { action, signature: action.signature };
}

/** The confirmed on-chain transaction, fetched over the validator's RPC. */
async function fetchConfirmedTx(v: Validator, signature: string): Promise<VersionedTransactionResponse> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const tx = await v.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx !== null) return tx;
    if (Date.now() >= deadline) {
      assert.fail(`transaction ${signature} must be findable on-chain within the bounded wait`);
    }
    await sleep(250);
  }
}

/** The required signers of a fetched transaction (`accountKeys[0..numRequiredSignatures)`). */
function signerKeysOf(tx: VersionedTransactionResponse): string[] {
  const message = tx.transaction.message;
  return message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58());
}

/**
 * REQ-B-9/D4: the operator key is the SOLE signer of an operator step, and the
 * subject user's key appears as a non-signer at most.
 */
function assertOperatorSoleSigner(
  tx: VersionedTransactionResponse,
  operator: PublicKey,
  user: PublicKey,
  label: string,
): void {
  const message = tx.transaction.message;
  const signers = signerKeysOf(tx);
  assert.deepEqual(
    signers,
    [operator.toBase58()],
    `${label}: the server's OPERATOR key must be the sole signer (got ${JSON.stringify(signers)})`,
  );
  const userIndex = message.staticAccountKeys.findIndex((key) => key.equals(user));
  assert.ok(
    userIndex === -1 || userIndex >= message.header.numRequiredSignatures,
    `${label}: the user key may appear only as a non-signer (found signer index ${userIndex})`,
  );
}

// ---------------------------------------------------------------------------
// Shared scenario: validator + market + server (operator + faucet configured)
// ---------------------------------------------------------------------------

interface Scenario {
  validator: Validator;
  mint: PublicKey;
  market: MarketEnv;
  operator: Keypair;
  server: ServerHandle;
}

let scenarioPromise: Promise<Scenario> | null = null;

function scenario(): Promise<Scenario> {
  scenarioPromise ??= buildScenario();
  return scenarioPromise;
}

async function buildScenario(): Promise<Scenario> {
  const validator = await startValidator();
  await createMint(validator);
  const market = await initMarket(validator);

  // The operator hot key (R-3): generated per run, written under the
  // validator's mkdtemp fixture dir, handed to the server via env.
  const operator = Keypair.generate();
  const operatorPath = join(validator.internals.dir, "operator.json");
  writeFileSync(operatorPath, JSON.stringify(Array.from(operator.secretKey)));

  const server = await startServer({
    validator,
    env: {
      OPERATOR_KEYPAIR: operatorPath,
      FAUCET_ENABLED: "1",
      FAUCET_MINT: validator.mint.toBase58(),
      FAUCET_MINT_AUTHORITY_KEYPAIR: validator.authorityKeypairPath,
    },
  });
  return { validator, mint: validator.mint, market, operator, server };
}

// ---------------------------------------------------------------------------
// Bind helper (D4): prepare → sign locally → submit → confirm → on-chain record
// ---------------------------------------------------------------------------

interface BindResult {
  operator: string;
  operatorRecord: PublicKey;
  signature: string;
}

async function bindViaApi(s: Scenario, token: string, trader: Keypair): Promise<BindResult> {
  const wallet = trader.publicKey.toBase58();
  const prepared = expectOk<BindPrepareResponse>(
    await call(s.server, "POST", "/bind/prepare", { token, body: { wallet } }),
    `POST /bind/prepare for ${wallet}`,
  );
  assert.equal(
    prepared.operator,
    s.operator.publicKey.toBase58(),
    "POST /bind/prepare must bind the server's configured OPERATOR key (the key that later signs the actions)",
  );
  const expectedRecord = operatorPda(s.market.market, trader.publicKey, s.validator.programId).address;
  assert.equal(
    prepared.operatorRecord,
    expectedRecord.toBase58(),
    "POST /bind/prepare must name the (market, wallet) Operator PDA",
  );
  assert.ok(
    typeof prepared.transaction === "string" && prepared.transaction.length > 0,
    `POST /bind/prepare must return a signable artifact (the base64 [approve, set_operator] transaction; got ${JSON.stringify(prepared.transaction)})`,
  );

  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
  } catch (err) {
    assert.fail(
      `POST /bind/prepare must return a base64-serialized transaction (the signable artifact): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (tx.feePayer === undefined) tx.feePayer = trader.publicKey; // the user pays (D4)
  tx.recentBlockhash = (await s.validator.connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(trader);
  assert.ok(
    tx.verifySignatures(),
    "the prepared bind payload must be a signable artifact: with the user's fee-payer-signed transaction it verifies fully",
  );

  const signature = await s.validator.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await s.validator.connection.confirmTransaction(signature, "confirmed");
  assert.deepEqual(
    signerKeysOf(await fetchConfirmedTx(s.validator, signature)),
    [wallet],
    "the bind transaction must be signed by the user ALONE (D4: the bind is signed once by the wallet)",
  );

  const confirmed = expectOk<BindConfirmResponse>(
    await call(s.server, "POST", "/bind/confirm", {
      token,
      body: { transaction: tx.serialize().toString("base64"), signature },
    }),
    "POST /bind/confirm",
  );
  assert.equal(confirmed.status, "bound", `POST /bind/confirm must report the bound status (got ${JSON.stringify(confirmed.status)})`);
  assert.equal(confirmed.operator, s.operator.publicKey.toBase58(), "the confirmed operator must be the server's OPERATOR key");

  // On-chain: signing+submitting the prepared payload must yield the Operator
  // record (market/user/operator fields bound).
  const recordData = await waitForValue(
    () => accountData(s.validator, expectedRecord),
    (data) => data !== null,
  );
  assert.ok(
    recordData !== null,
    `the on-chain Operator record ${expectedRecord.toBase58()} must exist after submitting the prepared bind payload — ` +
      "signing+submitting the artifact must yield the binding state",
  );
  const record = decodeOperator(recordData);
  assert.ok(
    record !== null,
    "decodeOperator must decode the bound 97-byte Operator record (SDK-OPERATOR-DECODER-ROUNDTRIPS; the decoder is a stub today)",
  );
  assert.equal(record.market.toBase58(), s.market.market.toBase58(), "the record must be scoped to the market");
  assert.equal(record.user.toBase58(), wallet, "the record must be scoped to the user");
  assert.equal(record.operator.toBase58(), s.operator.publicKey.toBase58(), "the record must store the operator key");
  return { operator: confirmed.operator, operatorRecord: expectedRecord, signature };
}

// ---------------------------------------------------------------------------
// E2E-PRODUCT-WALK (REQ-B-9)
// ---------------------------------------------------------------------------

test("E2E-PRODUCT-WALK: the bind→deposit→trade→close→withdraw walk succeeds end-to-end with the operator as the sole signer of the operator steps.", async () => {
  const s = await scenario();
  const trader = Keypair.generate();
  const wallet = trader.publicKey.toBase58();
  const traderAta = await fundTrader(s.validator, trader.publicKey, 50_000_000n, "walk-trader");

  // --- 1. faucet (devnet-only guard enabled through the test env) ----------
  const balanceBeforeFaucet = await tokenBalance(s.validator, traderAta);
  const faucet = expectOk<FaucetResponse>(await call(s.server, "POST", "/faucet", { body: { wallet } }), "POST /faucet");
  const drip = BigInt(faucet.amount);
  assert.ok(drip > 0n, `the faucet must mint a positive amount (got ${JSON.stringify(faucet.amount)})`);
  const canonicalAta = await getAssociatedTokenAddress(s.mint, trader.publicKey);
  assert.equal(faucet.ata, canonicalAta.toBase58(), "the faucet must mint into the wallet's canonical ATA");
  const afterFaucet = await waitForValue(
    () => tokenBalance(s.validator, traderAta),
    (balance) => balance === balanceBeforeFaucet + drip,
  );
  assert.equal(
    afterFaucet,
    balanceBeforeFaucet + drip,
    "one faucet call must move exactly the returned amount into the ATA",
  );

  // --- 2. SIWS login -------------------------------------------------------
  const token = await login(s.server, makeSigner(trader));

  // --- 3. bind (user-signed) ----------------------------------------------
  await bindViaApi(s, token, trader);

  // --- 4. operator deposit -------------------------------------------------
  const depositAmount = drip / 2n;
  assert.ok(
    depositAmount >= 1_000_000n,
    `the faucet drip (${drip} micro-USDC) must fund the walk's deposit (needs >= 2 tUSDC) — calibrate the faucet drip`,
  );
  const deposit = await serviceAction(s, token, "/actions/deposit", { amount: depositAmount.toString() }, "deposit");
  const depositRow = await txLogReachesConfirmed(s, deposit.action.actionId, deposit.signature, "deposit");
  assert.equal(depositRow.wallet, wallet, "the tx_log row must be attributed to the acting user");
  assert.ok(typeof depositRow.kind === "string" && depositRow.kind.length > 0, "the tx_log row must carry a kind");
  assertOperatorSoleSigner(await fetchConfirmedTx(s.validator, deposit.signature), s.operator.publicKey, trader.publicKey, "the deposit transaction");
  const afterDeposit = await waitForValue(
    () => readCollateral(s, trader.publicKey),
    (collateral) => collateral !== null && collateral.deposited === depositAmount,
  );
  assert.ok(afterDeposit !== null, "the trader's ledger must exist on-chain after the operator deposit");
  assert.equal(afterDeposit.deposited, depositAmount, "the operator deposit must credit exactly the requested amount");

  // --- 5. operator open (the walk's trade step) ---------------------------
  const chainMarket = await readMarket(s);
  assert.ok(chainMarket !== null, "the market must decode (decodePerpMarket)");
  const size = 1_000_000n;
  const margin = marginRequired(size, chainMarket.initialMarginBps);
  assert.ok(
    depositAmount >= 2n * margin,
    `the deposit (${depositAmount}) must cover the open's margin (${margin}) with headroom`,
  );
  // Counterparty liquidity for the taker open: a resting ask (direct SDK).
  await submit(
    s.validator,
    buildPlaceLimitOrder({
      market: s.market.market,
      indexSource: s.validator.indexSource,
      owner: s.validator.authority.publicKey,
      side: 1,
      price: 950_000n,
      size,
      programId: s.validator.programId,
    }),
    s.validator.authority,
  );
  const open = await serviceAction(s, token, "/actions/orders", { kind: "market", side: 0, size: size.toString() }, "open");
  await txLogReachesConfirmed(s, open.action.actionId, open.signature, "open");
  assertOperatorSoleSigner(await fetchConfirmedTx(s.validator, open.signature), s.operator.publicKey, trader.publicKey, "the open transaction");
  const opened = await waitForValue(
    () => readLongPosition(s, trader.publicKey),
    (position) => position !== null && position.notional === size,
  );
  assert.ok(
    opened !== null,
    "POST /actions/orders must OPEN the trader's position: the program only grows the taker's position through `open_position` " +
      "(the `place_*` instructions are book-only) — expected a LONG position on-chain",
  );
  assert.equal(opened.owner.toBase58(), wallet, "the position must be attributed to the SUBJECT user (not the operator)");
  assert.equal(opened.side, 0, "the opened side must be 0 (Long)");
  assert.equal(opened.notional, size, "the position notional must equal the requested size");
  assert.equal(
    opened.collateral,
    margin,
    "the position's reserved collateral must be the initial-margin requirement (program invariant)",
  );
  const afterOpen = await readCollateral(s, trader.publicKey);
  assert.equal(afterOpen?.reserved, margin, "opening must reserve the margin on the trader's ledger");

  // --- 6. operator close ---------------------------------------------------
  // Counterparty liquidity on the opposite side for the closing IOC.
  await submit(
    s.validator,
    buildPlaceLimitOrder({
      market: s.market.market,
      indexSource: s.validator.indexSource,
      owner: s.validator.authority.publicKey,
      side: 0,
      price: 900_000n,
      size,
      programId: s.validator.programId,
    }),
    s.validator.authority,
  );
  const close = await serviceAction(s, token, "/actions/positions/close", { side: 0, size: size.toString() }, "close");
  await txLogReachesConfirmed(s, close.action.actionId, close.signature, "close");
  assertOperatorSoleSigner(await fetchConfirmedTx(s.validator, close.signature), s.operator.publicKey, trader.publicKey, "the close transaction");
  const closed = await waitForValue(
    () => readLongPosition(s, trader.publicKey),
    (position) => position !== null && position.notional === 0n,
  );
  assert.ok(closed !== null, "the position must still exist on-chain after the close");
  assert.equal(closed.notional, 0n, `closing the full size must reduce the position notional to zero (got ${closed?.notional})`);
  const afterClose = await readCollateral(s, trader.publicKey);
  assert.equal(afterClose?.reserved, 0n, "closing must release the reserved margin");

  // --- 7. operator withdraw ------------------------------------------------
  const withdrawAmount = depositAmount / 2n;
  const balanceBeforeWithdraw = await tokenBalance(s.validator, traderAta);
  const withdraw = await serviceAction(s, token, "/actions/withdraw", { amount: withdrawAmount.toString() }, "withdraw");
  await txLogReachesConfirmed(s, withdraw.action.actionId, withdraw.signature, "withdraw");
  assertOperatorSoleSigner(await fetchConfirmedTx(s.validator, withdraw.signature), s.operator.publicKey, trader.publicKey, "the withdraw transaction");
  const afterWithdrawLedger = await waitForValue(
    () => readCollateral(s, trader.publicKey),
    (collateral) => collateral !== null && collateral.deposited === depositAmount - withdrawAmount,
  );
  assert.equal(
    afterWithdrawLedger?.deposited,
    depositAmount - withdrawAmount,
    "the operator withdraw must debit exactly the requested amount from the ledger",
  );
  const afterWithdrawBalance = await waitForValue(
    () => tokenBalance(s.validator, traderAta),
    (balance) => balance === balanceBeforeWithdraw + withdrawAmount,
  );
  assert.equal(
    afterWithdrawBalance,
    balanceBeforeWithdraw + withdrawAmount,
    "withdrawn tokens can only land in the subject user's own ATA (D5)",
  );
});

// ---------------------------------------------------------------------------
// OPERATOR-SERVICE-SIGNS-AND-CONFIRMS (REQ-B-5)
// ---------------------------------------------------------------------------

test("OPERATOR-SERVICE-SIGNS-AND-CONFIRMS: an action through the service lands on-chain and its tx_log row reaches confirmed with a signature.", async () => {
  const s = await scenario();
  const trader = Keypair.generate();
  const wallet = trader.publicKey.toBase58();
  const traderAta = await fundTrader(s.validator, trader.publicKey, 25_000_000n, "confirm-trader");
  const token = await login(s.server, makeSigner(trader));
  await bindViaApi(s, token, trader);

  const amount = 10_000_000n; // 10 tUSDC
  assert.ok((await tokenBalance(s.validator, traderAta)) >= amount, "scenario sanity: the ATA holds the deposit amount");

  const before = await readCollateral(s, trader.publicKey);
  assert.ok(before === null || before.deposited === 0n, "scenario sanity: the fresh ledger starts at zero");

  const deposit = await serviceAction(s, token, "/actions/deposit", { amount: amount.toString() }, "deposit");

  // The tx_log row: the action id resolves, reaches confirmed with the
  // action's signature, attributed to the user (REQ-B-5).
  const row = await txLogReachesConfirmed(s, deposit.action.actionId, deposit.signature, "deposit");
  assert.equal(row.wallet, wallet, "the tx_log row must be attributed to the acting user");

  // The on-chain state change, decoded with the SDK.
  const after = await waitForValue(
    () => readCollateral(s, trader.publicKey),
    (collateral) => collateral !== null && collateral.deposited === amount,
  );
  assert.ok(after !== null, "the ledger must exist on-chain after the deposit");
  assert.equal(after.deposited, amount, "the service deposit must land exactly the requested amount on-chain");

  // The user never signs an operator step: the operator key is the sole signer.
  const tx = await fetchConfirmedTx(s.validator, deposit.signature);
  assertOperatorSoleSigner(tx, s.operator.publicKey, trader.publicKey, "the deposit transaction");
  assert.equal(tx.meta?.err ?? null, null, "the deposit transaction must have succeeded on-chain");
});
