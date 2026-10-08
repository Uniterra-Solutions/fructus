//! RED acceptance tests (e2e, hermetic validator) for product-v3 REQ-K-2/K-3:
//! the served candles/trades must equal the indexed truth, fills must carry
//! block times, and bad candles params must 400.
//!
//! RED on today's tree: `/market/trades` + `/market/candles` are stubs that
//! answer `[]` (200), so the "fills must be indexed" flag never flips and the
//! 400-rejection assertions see 200s — all behavioural, never compile errors.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  SIDE_ASK,
  SIDE_BID,
  buildDepositCollateral,
  buildOpenPosition,
  buildPlaceLimitOrder,
} from "fructus-sdk/src/index.js";
import type { ApiResponse, CandlesResponse, TradeView, TradesResponse } from "fructus-sdk/src/api.js";
import { aggregateCandles } from "../src/market-data.js";
import type { FillRow } from "../src/db.js";
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
const DEPOSIT = 5_000_000n;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

let validator: Validator;
let market: MarketEnv;
let server: ServerHandle;
let maker: Keypair;
/** Set by the before hook — asserted inside the tests so RED stays an assertion. */
let indexed = false;

async function getJson(path: string): Promise<{ status: number; body: ApiResponse<unknown> | null }> {
  const res = await fetch(`${server.apiUrl}${path}`);
  const text = await res.text();
  let body: ApiResponse<unknown> | null = null;
  try {
    body = JSON.parse(text) as ApiResponse<unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function fetchTrades(limit = 50): Promise<TradeView[]> {
  const { status, body } = await getJson(`/market/trades?limit=${limit}`);
  assert.equal(status, 200, `GET /market/trades must answer 200 (got ${status})`);
  assert.ok(body !== null && body.ok === true, "trades must use the success envelope");
  return (body as { ok: true; data: TradesResponse }).data.trades;
}

before(async () => {
  validator = await startValidator();
  await createMint(validator);
  market = await initMarket(validator);

  // Seed the indexed truth BEFORE the server boots: a maker rests an ask, a
  // taker crosses it twice → two Fill events, both attributed to the maker.
  maker = Keypair.generate();
  await fundTrader(validator, maker.publicKey, 50_000_000n, "kline-maker");
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
  const taker = Keypair.generate();
  const takerAta = await fundTrader(validator, taker.publicKey, 50_000_000n, "kline-taker");
  await submit(
    validator,
    buildDepositCollateral({
      user: taker.publicKey,
      market: market.market,
      userAta: takerAta,
      collateralMint: validator.mint,
      amount: DEPOSIT,
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

  server = await startServer({ validator });
  indexed = await waitFor(async () => (await fetchTrades()).length >= 2, 45_000);
});

after(async () => {
  await stopAll();
});

test("KLINE-TRADES-E2E-TRUTH: the trades served from a live cross match the indexed fills desc by seq with non-null timeMs", async () => {
  assert.ok(indexed, "the indexer must serve the two seeded fills on /market/trades");
  const trades = await fetchTrades();

  assert.ok(trades.length >= 2, `expected at least the two seeded fills — got ${trades.length}`);
  for (const trade of trades) {
    assert.ok(
      typeof trade.timeMs === "string" && trade.timeMs.length > 0,
      `every newly indexed fill must carry a block time — seq ${trade.seq} has timeMs=${JSON.stringify(trade.timeMs)}`,
    );
  }
  const seqs = trades.map((t) => Number(t.seq));
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => b - a),
    `trades must be descending by seq — got [${seqs.join(",")}]`,
  );

  const head = trades[0];
  assert.equal(head.owner, maker.publicKey.toBase58(), "fills are attributed to the resting maker");
  assert.equal(head.side, 1, "the maker rested an ask");
  assert.equal(head.price, ASK_PRICE.toString());
  assert.equal(head.size, N.toString());
});

test("KLINE-CANDLES-E2E-TRUTH: candles served from a live indexed cross equal the pure aggregation of the indexed fills, timed, at the requested interval", async () => {
  assert.ok(indexed, "the indexer must serve the two seeded fills on /market/trades");
  const trades = await fetchTrades(200);
  const fills: FillRow[] = trades.map((trade) => ({
    seq: Number(trade.seq),
    slot: Number(trade.slot),
    market: market.market.toBase58(),
    owner: trade.owner,
    side: trade.side,
    price: trade.price,
    size: trade.size,
    timeMs: trade.timeMs === null ? null : Number(trade.timeMs),
  }));

  for (const [interval, intervalMs] of [
    ["1m", 60_000],
    ["1d", 86_400_000],
  ] as const) {
    const expected = aggregateCandles(fills, intervalMs, 300);
    assert.ok(expected.length >= 1, "generator sanity: the seeded fills form at least one bucket");

    const { status, body } = await getJson(`/market/candles?interval=${interval}&limit=300`);
    assert.equal(status, 200, `GET /market/candles?interval=${interval} must answer 200 (got ${status})`);
    assert.ok(body !== null && body.ok === true, "candles must use the success envelope");
    const candles = (body as { ok: true; data: CandlesResponse }).data.candles;
    assert.deepEqual(candles, expected, `served candles must equal the pure aggregation (interval ${interval})`);

    const one = await getJson(`/market/candles?interval=${interval}&limit=1`);
    assert.equal(one.status, 200);
    const oneCandles = ((one.body as { ok: true; data: CandlesResponse }).data ?? { candles: [] }).candles;
    assert.equal(oneCandles.length, 1, "limit=1 serves exactly the latest bucket");
    assert.deepEqual(oneCandles[0], expected[expected.length - 1], "the single candle is the latest bucket");
  }
});

test("CANDLES-REJECT-BAD-PARAMS: unknown interval and out-of-range/non-numeric limit are rejected rather than defaulted", async () => {
  for (const query of ["interval=2h", "interval=1m&limit=0", "limit=5"]) {
    const { status, body } = await getJson(`/market/candles?${query}`);
    assert.equal(status, 400, `GET /market/candles?${query} must answer 400 (got ${status})`);
    assert.ok(body !== null && body.ok === false, `must answer the error envelope for ${query}`);
    assert.equal(
      (body as { ok: false; error: { code: string } }).error.code,
      "bad_request",
      `the error code for ${query} must be bad_request`,
    );
  }
});
