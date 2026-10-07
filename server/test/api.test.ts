//! RED acceptance tests for the machine-readable contract, the read surface
//! and the shared DTOs (REQ-C-1, REQ-B-7, REQ-C-3; D14, REQ-B-4 sessions):
//!
//!  - `API-CONTRACT-MATCHES-OPENAPI`: `docs/api/openapi.json` and the server's
//!    exported `ROUTES` table name exactly the same paths+methods (bijective),
//!    and every `/actions/*` operation carries a JWT security requirement.
//!  - `API-READS-SERVE-INDEXED-TRUTH` (e2e): with a live `solana-test-validator`
//!    seeded through the SDK builders (deposit + one resting limit order + one
//!    LONG opened as a market taker), the server's `/market`, `/market/book`,
//!    `/me` and `/me/positions` must equal the chain-decoded truth — after a
//!    real SIWS login round-trip.
//!  - `SHARED-DTOS-STAY-IN-SYNC`: runtime shape checkers (hand-written from
//!    `sdk/src/api.ts`) validate every fetched response body; each checker is
//!    positively controlled first (it must reject a deliberately broken
//!    object), so a no-op checker can never pass as evidence.
//!
//! RED on today's tree: `docs/api/openapi.json` is the empty-paths skeleton
//! (the bijection assertion fails, quoting every missing route) and every route
//! but `/healthz` answers `501 not_implemented`, so the read assertions fail
//! behaviourally (expected 200, got 501).
//!
//! Non-vacuity: the seeded scenario serves a non-zero `deposited`, a non-empty
//! bid side, a live LONG position and non-zero requirement fields, so the
//! equality assertions discriminate rather than compare zeros.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import type {
  ApiResponse,
  BookView,
  ChallengeResponse,
  HealthzResponse,
  MarketView,
  PositionsResponse,
  SessionResponse,
  UserPortfolio,
} from "fructus-sdk/src/api.js";
import {
  buildDepositCollateral,
  buildOpenPosition,
  buildPlaceLimitOrder,
  decodeOrderBook,
  decodePerpMarket,
  decodePosition,
  decodeUserCollateral,
  marginRequired,
  pnl,
  positionPda,
  positionSideFromSideByte,
  userCollateralPda,
  type OrderBookState,
  type PerpMarketState,
  type PositionState,
} from "fructus-sdk/src/index.js";
import { ROUTES } from "../src/api.js";
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
// HTTP helper (unified JSON envelope, REQ-B-7)
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
    body = null; // keep the caller's assertion (not a parse throw) as the failure
  }
  return { status: res.status, body, text };
}

/** Assert the success envelope and return `data`. */
function expectOk<T>(res: JsonResponse, what: string): T {
  assert.equal(res.status, 200, `${what} must answer 200 (got ${res.status}: ${res.text.slice(0, 200)})`);
  const body = res.body;
  assert.ok(body !== null, `${what} must answer the unified JSON envelope (got: ${res.text.slice(0, 200)})`);
  assert.equal(body.ok, true, `${what} must use the success envelope (got ${res.text.slice(0, 200)})`);
  return (body as { ok: true; data: T }).data;
}

// ---------------------------------------------------------------------------
// SIWS login (ed25519 via node:crypto; vectors verified locally first)
// ---------------------------------------------------------------------------

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal dependency-free base58 encoder (no bn.js/bs58 import). */
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
    out = "1" + out; // leading zero bytes
  }
  return out;
}

interface SiwsSigner {
  keypair: Keypair;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

function makeSigner(keypair: Keypair = Keypair.generate()): SiwsSigner {
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

/** Full SIWS round-trip: challenge → local signature → verify; returns the JWT. */
async function login(server: ServerHandle, signer: SiwsSigner): Promise<string> {
  const wallet = signer.keypair.publicKey.toBase58();
  const challenge = expectOk<ChallengeResponse>(
    await call(server, "POST", "/auth/challenge", { body: { wallet } }),
    `POST /auth/challenge for ${wallet}`,
  );
  assert.ok(
    typeof challenge.signInInput === "string" && challenge.signInInput.length > 0,
    "the challenge must carry the signInInput the wallet signs",
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
// API-CONTRACT-MATCHES-OPENAPI (REQ-C-1, D14)
// ---------------------------------------------------------------------------

const OPENAPI_URL = new URL("../../docs/api/openapi.json", import.meta.url);

/** `{method} {path}` for every operation an openapi `paths` object documents. */
function documentedOperations(paths: Record<string, unknown>): string[] {
  const methods = ["get", "post", "put", "delete", "patch", "head", "options"] as const;
  const out: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    assert.ok(
      typeof item === "object" && item !== null && !Array.isArray(item),
      `openapi paths["${path}"] must be an operation object (got ${JSON.stringify(item)})`,
    );
    for (const method of methods) {
      if ((item as Record<string, unknown>)[method] !== undefined) out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out;
}

test("API-CONTRACT-MATCHES-OPENAPI: the route table and openapi.json name exactly the same paths+methods; every /actions/* route is JWT-gated.", () => {
  const raw = JSON.parse(readFileSync(OPENAPI_URL, "utf8")) as unknown;
  assert.ok(
    typeof raw === "object" && raw !== null && !Array.isArray(raw),
    `docs/api/openapi.json must be a JSON object (got ${JSON.stringify(raw)})`,
  );
  const doc = raw as Record<string, unknown>;

  assert.equal(typeof doc.openapi, "string", `openapi.json must pin an OpenAPI version (got ${JSON.stringify(doc.openapi)})`);
  assert.ok(
    (doc.openapi as string).startsWith("3."),
    `openapi.json must be an OpenAPI 3.x document (got ${JSON.stringify(doc.openapi)})`,
  );
  const paths = doc.paths;
  assert.ok(
    typeof paths === "object" && paths !== null && !Array.isArray(paths),
    `openapi.json must carry a \`paths\` object (got ${JSON.stringify(paths)})`,
  );

  // Non-vacuity: the route table itself must enumerate the whole surface.
  assert.ok(
    ROUTES.length >= 16,
    `the exported ROUTES table must enumerate every route of REQ-B-7 (expected >= 16, got ${ROUTES.length})`,
  );
  assert.equal(
    new Set(ROUTES.map((route) => `${route.method} ${route.path}`)).size,
    ROUTES.length,
    "the ROUTES table must not contain duplicate method+path entries",
  );

  const routeList = ROUTES.map((route) => `${route.method} ${route.path}`);
  const documented = documentedOperations(paths as Record<string, unknown>);

  // --- bijection: every registered route is documented ---
  const missing = routeList.filter((route) => !documented.includes(route));
  assert.deepEqual(
    missing,
    [],
    `openapi.json must document every route the server registers — missing ${missing.length} of ${routeList.length} ` +
      `operation(s): ${missing.join(", ")}; documented: ${documented.length === 0 ? "(none)" : documented.join(", ")}`,
  );

  // --- bijection: nothing undocumented ---
  const extra = documented.filter((route) => !routeList.includes(route));
  assert.deepEqual(
    extra,
    [],
    `openapi.json must not document operations outside the server's ROUTES table — extra: ${extra.join(", ")}`,
  );

  // --- every /actions/* operation is JWT-gated (REQ-B-4, REQ-C-1) ---
  const actionRoutes = ROUTES.filter((route) => route.path.startsWith("/actions/"));
  assert.ok(
    actionRoutes.length >= 5,
    `the ROUTES table must expose the /actions/* surface (expected >= 5, got ${actionRoutes.length})`,
  );
  const referencedSchemes = new Set<string>();
  for (const route of actionRoutes) {
    const pathItem = (paths as Record<string, unknown>)[route.path] as Record<string, unknown> | undefined;
    const operation = pathItem?.[route.method.toLowerCase()] as Record<string, unknown> | undefined;
    assert.ok(
      operation !== undefined,
      `${route.method} ${route.path} must be documented in openapi.json before its security requirement can be checked`,
    );
    const security = (operation as Record<string, unknown>).security;
    assert.ok(
      Array.isArray(security) && security.length > 0,
      `${route.method} ${route.path} must carry a non-empty \`security\` requirement (JWT-gated, REQ-B-4) in openapi.json ` +
        `(got ${JSON.stringify(security)})`,
    );
    for (const requirement of security as unknown[]) {
      assert.ok(
        typeof requirement === "object" && requirement !== null && Object.keys(requirement).length > 0,
        `${route.method} ${route.path} security requirements must name at least one scheme (got ${JSON.stringify(requirement)})`,
      );
      for (const scheme of Object.keys(requirement as Record<string, unknown>)) referencedSchemes.add(scheme);
    }
  }

  // A security requirement that references nothing is not a real gate: every
  // scheme used by /actions/* must be declared in components.securitySchemes.
  if (referencedSchemes.size > 0) {
    const components = doc.components as Record<string, unknown> | undefined;
    const schemes = components?.securitySchemes as Record<string, unknown> | undefined;
    assert.ok(
      typeof schemes === "object" && schemes !== null,
      `openapi.json must declare components.securitySchemes for the referenced scheme(s) ${[...referencedSchemes].join(", ")}`,
    );
    for (const scheme of referencedSchemes) {
      assert.ok(
        typeof (schemes as Record<string, unknown>)[scheme] === "object",
        `openapi.json components.securitySchemes must define the referenced scheme \`${scheme}\``,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Shared e2e scenario: live validator seeded through the SDK builders
// ---------------------------------------------------------------------------

interface Scenario {
  validator: Validator;
  mint: import("@solana/web3.js").PublicKey;
  market: MarketEnv;
  trader: Keypair;
  traderAta: import("@solana/web3.js").PublicKey;
  server: ServerHandle;
}

/** Seeded values (asserted verbatim below; the scenario is deterministic). */
const DEPOSIT_AMOUNT = 25_000_000n; // 25 tUSDC
const RESTING_BID_PRICE = 900_000n;
const RESTING_BID_SIZE = 5_000_000n;
const COUNTERPARTY_ASK_PRICE = 950_000n;
const OPEN_SIZE = 1_000_000n;

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
  const traderAta = await fundTrader(validator, trader.publicKey, 100_000_000n, "api-trader");

  // Seed state through the SDK builders (all direct, user-signed):
  //  - a collateral deposit (the ledger the reads must serve),
  //  - one resting limit BID (the book level the reads must serve),
  //  - counterparty ASK + a market-taker LONG open, so `/me` and
  //    `/me/positions` have a live position (non-vacuity per ACCEPTANCE.md:
  //    a zero-vs-zero read comparison is not evidence).
  await submit(
    validator,
    buildDepositCollateral({
      user: trader.publicKey,
      market: market.market,
      userAta: traderAta,
      collateralMint: validator.mint,
      amount: DEPOSIT_AMOUNT,
      programId: validator.programId,
    }),
    trader,
  );
  await submit(
    validator,
    buildPlaceLimitOrder({
      market: market.market,
      indexSource: validator.indexSource,
      owner: trader.publicKey,
      side: 0,
      price: RESTING_BID_PRICE,
      size: RESTING_BID_SIZE,
      programId: validator.programId,
    }),
    trader,
  );
  await submit(
    validator,
    buildPlaceLimitOrder({
      market: market.market,
      indexSource: validator.indexSource,
      owner: validator.authority.publicKey,
      side: 1,
      price: COUNTERPARTY_ASK_PRICE,
      size: OPEN_SIZE,
      programId: validator.programId,
    }),
    validator.authority,
  );
  await submit(
    validator,
    buildOpenPosition({
      owner: trader.publicKey,
      market: market.market,
      indexSource: validator.indexSource,
      side: 0,
      size: OPEN_SIZE,
      price: 0n, // market IOC taker
      programId: validator.programId,
    }),
    trader,
  );

  const server = await startServer({ validator });
  return { validator, mint: validator.mint, market, trader, traderAta, server };
}

// ---------------------------------------------------------------------------
// Chain-truth readers (SDK decoders) + readiness wait
// ---------------------------------------------------------------------------

async function readAccount(v: Validator, address: import("@solana/web3.js").PublicKey): Promise<Buffer | null> {
  const info = await v.connection.getAccountInfo(address);
  return info === null ? null : Buffer.from(info.data);
}

async function readMarket(s: Scenario): Promise<PerpMarketState | null> {
  return decodePerpMarket(await readAccount(s.validator, s.market.market));
}

async function readBook(s: Scenario): Promise<OrderBookState | null> {
  return decodeOrderBook(await readAccount(s.validator, s.market.orderBook));
}

async function readCollateral(s: Scenario) {
  return decodeUserCollateral(await readAccount(s.validator, userCollateralPda(s.market.market, s.trader.publicKey, s.validator.programId).address));
}

async function readPosition(s: Scenario, side: number): Promise<PositionState | null> {
  return decodePosition(await readAccount(s.validator, positionPda(s.market.market, s.trader.publicKey, side, s.validator.programId).address));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded wait for the server's indexer to have completed its start resync
 * (`/healthz.slot` non-null, REQ-B-10 DTO). Returns the observed slot, or
 * `null` when the bounded wait elapsed — the assertions below then report the
 * truth either way, with this note in their failure message.
 */
async function waitForIndexerSlot(server: ServerHandle, timeoutMs = 20_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await call(server, "GET", "/healthz");
    if (res.body !== null && res.body.ok === true) {
      const data = res.body.data as HealthzResponse;
      if (data.slot !== null && data.slot !== undefined) return data.slot;
    }
    if (Date.now() >= deadline) return null;
    await sleep(300);
  }
}

/** Expected signed upnl from the decoded position vs the decoded market row (state.test.ts convention). */
function decodedUpnl(position: PositionState, market: PerpMarketState): bigint {
  const side = positionSideFromSideByte(position.side);
  if (side === null) return 0n;
  return pnl(position.entryN, position.entryD, market.indexN, market.indexD, position.notional, side) ?? 0n;
}

// ---------------------------------------------------------------------------
// API-READS-SERVE-INDEXED-TRUTH (REQ-B-7, e2e)
// ---------------------------------------------------------------------------

test("API-READS-SERVE-INDEXED-TRUTH: /me, /me/positions, /market, /market/book equal the indexed state for seeded scenarios.", async () => {
  const s = await scenario();
  const slot = await waitForIndexerSlot(s.server);
  const note = slot === null ? "indexer: /healthz.slot stayed null through the bounded wait" : `indexer slot ${slot}`;

  // --- chain truth, decoded through the SDK ---
  const chainMarket = await readMarket(s);
  assert.ok(chainMarket !== null, "the market account must exist on-chain and decode (decodePerpMarket)");
  const chainBook = await readBook(s);
  assert.ok(chainBook !== null, "the order book account must exist on-chain and decode (decodeOrderBook)");
  const chainCollateral = await readCollateral(s);
  assert.ok(chainCollateral !== null, "the trader's collateral ledger must exist on-chain and decode (decodeUserCollateral)");
  assert.equal(chainCollateral.deposited, DEPOSIT_AMOUNT, "scenario sanity: the chain must carry the seeded deposit");
  const chainLong = await readPosition(s, 0);
  assert.ok(chainLong !== null && chainLong.notional === OPEN_SIZE, "scenario sanity: the chain must carry the seeded LONG position");

  // --- SIWS login of the trader (challenge → local sign → verify) ---
  const token = await login(s.server, makeSigner(s.trader));
  const wallet = s.trader.publicKey.toBase58();

  // --- GET /market ---
  const market = expectOk<MarketView>(await call(s.server, "GET", "/market"), `GET /market [${note}]`);
  assert.equal(
    market.fundingAccumulator,
    chainMarket.fundingAccumulator.toString(),
    `GET /market.fundingAccumulator must equal the chain-decoded market's funding accumulator`,
  );
  // The trustless index derives from the market's last-settlement stake-pool
  // baseline (index_n/index_d); a fresh market has none, and the program's
  // first-settlement rule (`settle_funding`, index_d == 0) yields index 0 —
  // the same value the SDK mirror `expectedIndex(null, …)` returns.
  assert.equal(market.index, "0", `GET /market.index must be the fresh-market trustless index 0 (got ${JSON.stringify(market.index)})`);
  assert.equal(
    market.bestBid,
    chainBook.bestBid.toString(),
    "GET /market.bestBid must equal the chain-decoded book's best bid",
  );
  assert.equal(market.bestBid, RESTING_BID_PRICE.toString(), "GET /market.bestBid must be the seeded resting bid price");
  assert.equal(market.bestAsk, null, "a one-sided book has no best ask — `null`, not a zero string (sdk/src/api.ts)");
  assert.equal(market.mark, null, "one-sided book ⇒ no mid ⇒ mark null (sdk/src/api.ts)");

  // --- GET /market/book ---
  const book = expectOk<BookView>(await call(s.server, "GET", "/market/book"), `GET /market/book [${note}]`);
  const chainBids = chainBook.bids.filter((order) => order.active === 1).map((order) => [order.price.toString(), order.size.toString()]);
  const chainAsks = chainBook.asks.filter((order) => order.active === 1).map((order) => [order.price.toString(), order.size.toString()]);
  assert.equal(chainBids.length, 1, "scenario sanity: the chain book must hold exactly the seeded resting bid");
  assert.equal(chainAsks.length, 0, "scenario sanity: the counterparty ask was consumed by the taker open");
  assert.deepEqual(book.bids, chainBids, "GET /market/book.bids must equal the chain-decoded active bid levels");
  assert.deepEqual(book.asks, chainAsks, "GET /market/book.asks must equal the chain-decoded active ask levels");

  // --- GET /me ---
  const me = expectOk<UserPortfolio>(await call(s.server, "GET", "/me", { token }), `GET /me [${note}]`);
  assert.equal(me.wallet, wallet, "GET /me must serve the session's wallet (JWT sub)");
  assert.equal(me.deposited, chainCollateral.deposited.toString(), "deposited must equal the chain-decoded ledger");
  assert.equal(me.deposited, DEPOSIT_AMOUNT.toString(), "deposited must be the seeded amount");
  assert.equal(me.reserved, chainCollateral.reserved.toString(), "reserved must equal the chain-decoded ledger");
  assert.equal(
    me.reserved,
    marginRequired(chainLong.notional, chainMarket.initialMarginBps).toString(),
    "reserved must equal the chain position's margin requirement",
  );
  assert.equal(me.claimable, chainCollateral.claimable.toString(), "claimable must equal the chain-decoded ledger");
  assert.equal(
    me.free,
    (chainCollateral.deposited - chainCollateral.reserved).toString(),
    "free must equal deposited − reserved (chain-decoded)",
  );
  const expectedUpnl = decodedUpnl(chainLong, chainMarket);
  assert.equal(
    me.equity,
    (chainCollateral.deposited + expectedUpnl).toString(),
    "equity must equal deposited + Σ upnl over the chain-decoded positions",
  );
  assert.equal(
    me.requirementInitial,
    marginRequired(chainLong.notional, chainMarket.initialMarginBps).toString(),
    "requirementInitial must equal Σ m(n_side, initial_bps) over the chain-decoded positions",
  );
  assert.equal(
    me.requirementMaint,
    marginRequired(chainLong.notional, chainMarket.maintenanceMarginBps).toString(),
    "requirementMaint must equal Σ m(n_side, maintenance_bps) over the chain-decoded positions",
  );
  assert.equal(me.health, "healthy", "equity well above the maintenance requirement ⇒ healthy");

  // No Operator record exists for this wallet: the view must be null
  // (sdk/src/api.ts: `null` when the wallet has no record at all).
  assert.equal(me.operator, null, "a wallet with no Operator record must report `operator: null`");

  const longView = me.positions.find((position) => position.side === 0);
  assert.ok(longView !== undefined, "GET /me must carry a view for the chain-decoded LONG side");
  assert.equal(longView.notional, chainLong.notional.toString(), "LONG view notional must equal the chain-decoded position");
  assert.equal(longView.upnl, expectedUpnl.toString(), "LONG view upnl must equal the chain-decoded position's upnl");
  assert.equal(
    longView.reqInitial,
    marginRequired(chainLong.notional, chainMarket.initialMarginBps).toString(),
    "LONG view reqInitial must equal the chain-decoded position's initial requirement",
  );
  assert.equal(
    longView.reqMaint,
    marginRequired(chainLong.notional, chainMarket.maintenanceMarginBps).toString(),
    "LONG view reqMaint must equal the chain-decoded position's maintenance requirement",
  );

  // --- GET /me/positions ---
  const positions = expectOk<PositionsResponse>(
    await call(s.server, "GET", "/me/positions", { token }),
    `GET /me/positions [${note}]`,
  );
  assert.ok(Array.isArray(positions.positions), "positions must be an array (sdk/src/api.ts)");
  const servedLong = positions.positions.find((position) => position.side === 0);
  assert.ok(servedLong !== undefined, "GET /me/positions must carry the chain-decoded LONG side");
  assert.equal(servedLong.notional, chainLong.notional.toString(), "LONG notional must equal the chain-decoded position");
  assert.equal(servedLong.upnl, expectedUpnl.toString(), "LONG upnl must equal the chain-decoded position's upnl");
  // The SHORT side is pristine on-chain: it may be omitted, but if a view is
  // served it must report the zero contribution (sdk/src/api.ts).
  for (const position of positions.positions) {
    assert.ok(position.side === 0 || position.side === 1, `position side must be 0 or 1 (got ${JSON.stringify(position.side)})`);
    if (position.side === 1) {
      assert.equal(position.notional, "0", "the pristine SHORT side must report zero notional");
      assert.equal(position.upnl, "0", "the pristine SHORT side must report zero upnl");
      assert.equal(position.reqInitial, "0", "the pristine SHORT side must report zero initial requirement");
      assert.equal(position.reqMaint, "0", "the pristine SHORT side must report zero maintenance requirement");
    }
  }
});

// ---------------------------------------------------------------------------
// SHARED-DTOS-STAY-IN-SYNC (REQ-C-3): runtime shape checkers
// ---------------------------------------------------------------------------

/** Problems found validating a value against its DTO shape; `[]` = valid. */
type Problems = string[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UINT_STRING = /^\d+$/;
const INT_STRING = /^-?\d+$/;
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function checkUintString(problems: Problems, obj: Record<string, unknown>, field: string): void {
  const value = obj[field];
  if (typeof value !== "string" || !UINT_STRING.test(value)) {
    problems.push(`\`${field}\` must be an unsigned decimal string (got ${JSON.stringify(value)})`);
  }
}

function checkIntString(problems: Problems, obj: Record<string, unknown>, field: string): void {
  const value = obj[field];
  if (typeof value !== "string" || !INT_STRING.test(value)) {
    problems.push(`\`${field}\` must be a signed decimal string (got ${JSON.stringify(value)})`);
  }
}

function checkNullableUintString(problems: Problems, obj: Record<string, unknown>, field: string): void {
  const value = obj[field];
  if (value !== null && (typeof value !== "string" || !UINT_STRING.test(value))) {
    problems.push(`\`${field}\` must be null or an unsigned decimal string (got ${JSON.stringify(value)})`);
  }
}

function checkPubkey(problems: Problems, obj: Record<string, unknown>, field: string): void {
  const value = obj[field];
  if (typeof value !== "string" || !BASE58_PUBKEY.test(value)) {
    problems.push(`\`${field}\` must be a base58 pubkey (got ${JSON.stringify(value)})`);
  }
}

function checkMarketView(value: unknown): Problems {
  if (!isRecord(value)) return [`MarketView must be a JSON object (got ${JSON.stringify(value)})`];
  const problems: Problems = [];
  checkNullableUintString(problems, value, "mark");
  checkUintString(problems, value, "index");
  checkIntString(problems, value, "fundingAccumulator");
  checkNullableUintString(problems, value, "bestBid");
  checkNullableUintString(problems, value, "bestAsk");
  return problems;
}

function checkBookView(value: unknown): Problems {
  if (!isRecord(value)) return [`BookView must be a JSON object (got ${JSON.stringify(value)})`];
  const problems: Problems = [];
  for (const side of ["bids", "asks"] as const) {
    const levels = value[side];
    if (!Array.isArray(levels)) {
      problems.push(`\`${side}\` must be an array of [price, size] levels (got ${JSON.stringify(levels)})`);
      continue;
    }
    levels.forEach((level: unknown, index: number) => {
      if (
        !Array.isArray(level) ||
        level.length !== 2 ||
        typeof level[0] !== "string" ||
        !UINT_STRING.test(level[0]) ||
        typeof level[1] !== "string" ||
        !UINT_STRING.test(level[1])
      ) {
        problems.push(`\`${side}[${index}]\` must be a [price, size] pair of unsigned decimal strings (got ${JSON.stringify(level)})`);
      }
    });
  }
  return problems;
}

function checkPositionView(problems: Problems, value: unknown, path: string): void {
  if (!isRecord(value)) {
    problems.push(`${path} must be a PositionView object (got ${JSON.stringify(value)})`);
    return;
  }
  const side = value.side;
  if (side !== 0 && side !== 1) problems.push(`${path}.side must be 0 or 1 (got ${JSON.stringify(side)})`);
  checkUintString(problems, value, "notional");
  if (value.entryRate !== undefined) checkUintString(problems, value, "entryRate");
  checkIntString(problems, value, "upnl");
  checkUintString(problems, value, "reqInitial");
  checkUintString(problems, value, "reqMaint");
}

function checkUserPortfolio(value: unknown): Problems {
  if (!isRecord(value)) return [`UserPortfolio must be a JSON object (got ${JSON.stringify(value)})`];
  const problems: Problems = [];
  checkPubkey(problems, value, "wallet");
  checkUintString(problems, value, "deposited");
  checkUintString(problems, value, "reserved");
  checkUintString(problems, value, "claimable");
  checkUintString(problems, value, "free");
  checkIntString(problems, value, "equity");
  checkUintString(problems, value, "requirementInitial");
  checkUintString(problems, value, "requirementMaint");
  const health = value.health;
  if (health !== "healthy" && health !== "liquidatable") {
    problems.push(`\`health\` must be "healthy" | "liquidatable" (got ${JSON.stringify(health)})`);
  }
  const operator = value.operator;
  if (operator !== null) {
    if (!isRecord(operator)) {
      problems.push(`\`operator\` must be null or an OperatorView object (got ${JSON.stringify(operator)})`);
    } else {
      const address = operator.address;
      if (address !== null && (typeof address !== "string" || !BASE58_PUBKEY.test(address))) {
        problems.push(`\`operator.address\` must be null or a base58 pubkey (got ${JSON.stringify(address)})`);
      }
    }
  }
  const positions = value.positions;
  if (!Array.isArray(positions)) {
    problems.push(`\`positions\` must be an array (got ${JSON.stringify(positions)})`);
  } else {
    positions.forEach((position, index) => checkPositionView(problems, position, `positions[${index}]`));
  }
  return problems;
}

function checkPositionsResponse(value: unknown): Problems {
  if (!isRecord(value)) return [`PositionsResponse must be a JSON object (got ${JSON.stringify(value)})`];
  const problems: Problems = [];
  const positions = value.positions;
  if (!Array.isArray(positions)) {
    problems.push(`\`positions\` must be an array (got ${JSON.stringify(positions)})`);
  } else {
    positions.forEach((position, index) => checkPositionView(problems, position, `positions[${index}]`));
  }
  return problems;
}

function checkHealthz(value: unknown): Problems {
  if (!isRecord(value)) return [`HealthzResponse must be a JSON object (got ${JSON.stringify(value)})`];
  const problems: Problems = [];
  if (value.status !== "ok") problems.push(`\`status\` must be "ok" (got ${JSON.stringify(value.status)})`);
  if (value.slot !== null && typeof value.slot !== "number") {
    problems.push(`\`slot\` must be null or a number (got ${JSON.stringify(value.slot)})`);
  }
  return problems;
}

function checkChallengeResponse(value: unknown): Problems {
  if (!isRecord(value)) return [`ChallengeResponse must be a JSON object (got ${JSON.stringify(value)})`];
  const problems: Problems = [];
  if (typeof value.signInInput !== "string" || value.signInInput.length === 0) {
    problems.push(`\`signInInput\` must be a non-empty string (got ${JSON.stringify(value.signInInput)})`);
  }
  if (typeof value.nonce !== "string" || value.nonce.length === 0) {
    problems.push(`\`nonce\` must be a non-empty string (got ${JSON.stringify(value.nonce)})`);
  }
  if (typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt))) {
    problems.push(`\`expiresAt\` must be an ISO-8601 string (got ${JSON.stringify(value.expiresAt)})`);
  }
  return problems;
}

function checkSessionResponse(value: unknown): Problems {
  if (!isRecord(value)) return [`SessionResponse must be a JSON object (got ${JSON.stringify(value)})`];
  const problems: Problems = [];
  if (typeof value.token !== "string" || value.token.split(".").length !== 3) {
    problems.push(`\`token\` must be a three-segment JWT (got ${JSON.stringify(value.token)})`);
  }
  checkPubkey(problems, value, "wallet");
  return problems;
}

function checkFaucetResponse(value: unknown): Problems {
  if (!isRecord(value)) return [`FaucetResponse must be a JSON object (got ${JSON.stringify(value)})`];
  const problems: Problems = [];
  checkUintString(problems, value, "amount");
  checkPubkey(problems, value, "ata");
  return problems;
}

function checkActionResponse(value: unknown): Problems {
  if (!isRecord(value)) return [`ActionResponse must be a JSON object (got ${JSON.stringify(value)})`];
  const problems: Problems = [];
  if (typeof value.actionId !== "string" || value.actionId.length === 0) {
    problems.push(`\`actionId\` must be a non-empty string (got ${JSON.stringify(value.actionId)})`);
  }
  if (typeof value.status !== "string" || !["queued", "sent", "confirmed", "failed"].includes(value.status)) {
    problems.push(`\`status\` must be queued | sent | confirmed | failed (got ${JSON.stringify(value.status)})`);
  }
  if (value.signature !== undefined && (typeof value.signature !== "string" || value.signature.length === 0)) {
    problems.push(`\`signature\` must be absent or a non-empty string (got ${JSON.stringify(value.signature)})`);
  }
  return problems;
}

/** Assert a body matches its DTO shape, quoting every problem. */
function expectDto(label: string, checker: (value: unknown) => Problems, value: unknown): void {
  const problems = checker(value);
  assert.deepEqual(problems, [], `${label} must match the sdk/src/api.ts DTO shape — problems: ${problems.join("; ")}`);
}

test("SHARED-DTOS-STAY-IN-SYNC: runtime shape checks validate every e2e response body against the sdk/src/api.ts DTO shapes.", async () => {
  const s = await scenario();
  const slot = await waitForIndexerSlot(s.server);
  const note = slot === null ? "indexer: /healthz.slot stayed null through the bounded wait" : `indexer slot ${slot}`;

  // --- positive controls FIRST: each checker must reject a broken object, so
  // a checker that accepts everything can never count as evidence. ---
  const controls: Array<[string, (value: unknown) => Problems, unknown]> = [
    ["MarketView", checkMarketView, { mark: null, index: 42, fundingAccumulator: "0", bestBid: null, bestAsk: null }],
    ["BookView", checkBookView, { bids: [["900000"]], asks: [] }],
    [
      "UserPortfolio",
      checkUserPortfolio,
      { wallet: "not-a-pubkey", deposited: 25_000_000, reserved: "0", claimable: "0", free: "0", equity: "0", requirementInitial: "0", requirementMaint: "0", health: "healthy", operator: null, positions: [] },
    ],
    ["PositionsResponse", checkPositionsResponse, { positions: [{ side: 2, notional: "1", upnl: "0", reqInitial: "0", reqMaint: "0" }] }],
    ["HealthzResponse", checkHealthz, { status: "degraded", slot: null }],
    ["ChallengeResponse", checkChallengeResponse, { signInInput: "", nonce: 7, expiresAt: "not-a-date" }],
    ["SessionResponse", checkSessionResponse, { token: "not-a-jwt", wallet: "not-a-pubkey" }],
    ["FaucetResponse", checkFaucetResponse, { amount: 42, ata: "not-a-pubkey" }],
    ["ActionResponse", checkActionResponse, { actionId: "", status: "pending" }],
  ];
  for (const [name, checker, broken] of controls) {
    assert.ok(
      checker(broken).length > 0,
      `positive control: the ${name} checker must reject ${JSON.stringify(broken)} — a checker that accepts anything is not evidence`,
    );
  }

  // --- the real fetched bodies ---
  const token = await login(s.server, makeSigner(s.trader));

  const healthz = await call(s.server, "GET", "/healthz");
  expectDto(`GET /healthz [${note}]`, checkHealthz, expectOk<unknown>(healthz, "GET /healthz"));

  const market = expectOk<unknown>(await call(s.server, "GET", "/market"), `GET /market [${note}]`);
  expectDto(`GET /market [${note}]`, checkMarketView, market);

  const book = expectOk<unknown>(await call(s.server, "GET", "/market/book"), `GET /market/book [${note}]`);
  expectDto(`GET /market/book [${note}]`, checkBookView, book);

  const me = expectOk<unknown>(await call(s.server, "GET", "/me", { token }), `GET /me [${note}]`);
  expectDto(`GET /me [${note}]`, checkUserPortfolio, me);

  const positions = expectOk<unknown>(await call(s.server, "GET", "/me/positions", { token }), `GET /me/positions [${note}]`);
  expectDto(`GET /me/positions [${note}]`, checkPositionsResponse, positions);

  // The auth round-trip bodies too (they are e2e responses of this surface).
  const wallet = s.trader.publicKey.toBase58();
  const challenge = expectOk<unknown>(await call(s.server, "POST", "/auth/challenge", { body: { wallet } }), "POST /auth/challenge");
  expectDto("POST /auth/challenge", checkChallengeResponse, challenge);
  const challengeData = challenge as ChallengeResponse;
  const session = expectOk<unknown>(
    await call(s.server, "POST", "/auth/verify", {
      body: { wallet, signature: signSiws(makeSigner(s.trader), challengeData.signInInput), signInInput: challengeData.signInInput },
    }),
    "POST /auth/verify",
  );
  expectDto("POST /auth/verify", checkSessionResponse, session);
});
