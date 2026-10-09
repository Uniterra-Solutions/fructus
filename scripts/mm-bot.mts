//! Market-maker bot (product-v3 REQ-M-1/M-2): quotes a two-sided ladder from
//! a funded keypair via the SDK builders. The pure quote math lives in
//! `mm-lib.mts`.
//!
//! Env: RPC_URL (required), MM_KEYPAIR (keypair path, required),
//! MM_MARK_URL (server `/market`, default http://127.0.0.1:8787/market),
//! MM_LEVELS, MM_SPREAD_BPS, MM_SIZE, MM_INTERVAL_MS (see mm-lib).
//!
//! Every cycle: read the perp market + order book and the latest mark (the
//! server's latest fill price); `anchor = resolveAnchor(mark, index)` — the
//! ladder follows the latest traded price, falling back to the trustless
//! index rate. A price update makes every desired level differ, so the
//! cancel/place diff (`planRequote`) pulls the whole stale ladder and
//! re-places it around the new anchor immediately; unchanged prices are a
//! no-op. The crossing constraint is evaluated against OTHER makers' orders
//! only (own orders are cancelled first, so they must not block the new
//! ladder). The requote is ONE transaction — every cancel, then every place —
//! signed with the bot keypair once and confirmed once, so the ladder
//! switches old→new wholesale (atomic), never torn. Worst case (8 levels/
//! side): 16 cancels + 16 places = 32 instructions ≈ 1126 bytes, inside the
//! 1232-byte legacy packet limit (pinned by test/mm-bot-batch.test.ts). Log
//! one summary line. Per-cycle errors are logged and the loop continues;
//! SIGINT stops.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  APY_SCALE,
  buildCancelOrder,
  buildPlaceLimitOrder,
  decodeOrderBook,
  decodePerpMarket,
  marketPda,
  midFromBook,
  orderBookPda,
  readExchangeRate,
  type OrderBookState,
  type OrderState,
  type PerpMarketState,
} from "fructus-sdk/src/index.js";
import {
  parseIntervalMs,
  parseQuoteParams,
  planQuotes,
  planRequote,
  resolveAnchor,
  type OwnOrder,
  type QuoteParams,
  type RequotePlan,
} from "./mm-lib.mjs";

// ---------------------------------------------------------------------------
// Config + helpers
// ---------------------------------------------------------------------------

interface BotContext {
  connection: Connection;
  bot: Keypair;
  market: PublicKey;
  orderBook: PublicKey;
  params: QuoteParams;
  intervalMs: number;
  /** Server `/market` endpoint carrying the latest fill price (the mark). */
  markUrl: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Load a Solana keypair from the JSON secret-key array at `path`. */
function loadKeypair(path: string): Keypair {
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf-8")) as number[]);
  return Keypair.fromSecretKey(secret);
}

/**
 * The bot's own resting orders: active book entries whose `owner` is the bot
 * key. Bids first, then asks (per side in book order).
 */
function collectOwnOrders(book: OrderBookState, owner: PublicKey): OwnOrder[] {
  const ofSide = (orders: OrderState[], side: 0 | 1): OwnOrder[] =>
    orders
      .filter((order) => order.active === 1 && order.owner.equals(owner))
      .map((order) => ({
        side,
        seq: order.seq.toString(),
        price: order.price.toString(),
        size: order.size.toString(),
      }));
  return [...ofSide(book.bids, 0), ...ofSide(book.asks, 1)];
}

/** Best resting price on a side EXCLUDING the bot's own orders (`null` when none). */
function bestOtherPrice(orders: OrderState[], owner: PublicKey, side: 0 | 1): bigint | null {
  let best: bigint | null = null;
  for (const order of orders) {
    if (order.active !== 1 || order.owner.equals(owner)) continue;
    if (
      best === null ||
      (side === 0 ? order.price > best : order.price < best) // bids: max, asks: min
    ) {
      best = order.price;
    }
  }
  return best;
}

/**
 * The latest traded price (the mark) from the server's `/market` read: the
 * quote anchor follows real prints. Any failure (server down, no fills yet)
 * yields `null` — the cycle then falls back to the trustless index rate.
 */
async function readMarkPrice(url: string): Promise<bigint | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: boolean; data?: { mark?: string | null } };
    if (body.ok !== true || body.data === undefined) return null;
    const mark = body.data.mark ?? null;
    if (mark === null) return null;
    const value = BigInt(mark);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * The index reference for the quote anchor: the market's last-settlement pool
 * baseline (`index_n / index_d`) scaled to `APY_SCALE` units, or — on a fresh
 * market that has no baseline yet — the live `index_source` stake-pool exchange
 * rate scaled the same way (the devstack seeds a synthetic pool for exactly
 * this). `null` when neither reference is available.
 */
async function readIndexLevel(
  connection: Connection,
  market: PerpMarketState,
): Promise<bigint | null> {
  if (market.indexD > 0n) {
    return (market.indexN * APY_SCALE) / market.indexD;
  }
  const info = await connection.getAccountInfo(market.indexSource, "confirmed");
  if (info === null) return null;
  const rate = readExchangeRate(info.data);
  if (rate === null) return null;
  return (rate.totalLamports * APY_SCALE) / rate.poolTokenSupply;
}

/** Legacy transaction packet limit: 1280-byte MTU − 40 (IPv6 header) − 8 (UDP header). */
const MAX_PACKET_SIZE = 1232;

/**
 * Sign + submit the whole requote batch as ONE transaction and confirm
 * `confirmed`. The batch is atomic: either the ladder switches wholesale or
 * nothing changes. The size guard is structural (an 8-level requote is 32
 * instructions ≈ 1126 bytes); it throws a clear error rather than letting the
 * RPC reject an oversize packet opaquely.
 */
async function submitRequote(
  connection: Connection,
  tx: Transaction,
  bot: Keypair,
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(bot);
  const wire = tx.serialize();
  if (wire.length > MAX_PACKET_SIZE) {
    throw new Error(
      `requote batch does not fit one transaction: ${wire.length} > ${MAX_PACKET_SIZE} bytes ` +
        `(${tx.instructions.length} instructions)`,
    );
  }
  const signature = await connection.sendRawTransaction(wire, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed",
  );
  if (confirmation.value.err !== null && confirmation.value.err !== undefined) {
    throw new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

// ---------------------------------------------------------------------------
// Requote batch assembly (pure — pinned by test/mm-bot-batch.test.ts)
// ---------------------------------------------------------------------------

export interface RequoteKeys {
  market: PublicKey;
  orderBook: PublicKey;
  indexSource: PublicKey;
  owner: PublicKey;
}

/**
 * Assemble one cycle's requote as ONE transaction: every cancel first (free
 * book capacity and drop the bot's own stale orders), then every place (the
 * new ladder, plan order). `null` for an empty plan — a no-op cycle submits
 * nothing, never an empty transaction.
 */
export function buildRequoteTransaction(plan: RequotePlan, keys: RequoteKeys): Transaction | null {
  if (plan.cancels.length === 0 && plan.places.length === 0) return null;
  const instructions: TransactionInstruction[] = [
    ...plan.cancels.map((order) =>
      buildCancelOrder({
        market: keys.market,
        orderBook: keys.orderBook,
        owner: keys.owner,
        seq: BigInt(order.seq),
      }),
    ),
    ...plan.places.map((quote) =>
      buildPlaceLimitOrder({
        market: keys.market,
        orderBook: keys.orderBook,
        indexSource: keys.indexSource,
        owner: keys.owner,
        side: quote.side,
        price: BigInt(quote.price),
        size: BigInt(quote.size),
      }),
    ),
  ];
  const tx = new Transaction().add(...instructions);
  tx.feePayer = keys.owner;
  return tx;
}

// ---------------------------------------------------------------------------
// One quote / requote cycle
// ---------------------------------------------------------------------------

async function runCycle(ctx: BotContext): Promise<void> {
  const [marketInfo, bookInfo] = await ctx.connection.getMultipleAccountsInfo([
    ctx.market,
    ctx.orderBook,
  ]);
  const market = marketInfo === null ? null : decodePerpMarket(marketInfo.data);
  const book = bookInfo === null ? null : decodeOrderBook(bookInfo.data);
  if (market === null || book === null) {
    console.error(
      `[mm] cycle skipped: ${market === null ? "market" : "order book"} account missing or undecodable`,
    );
    return;
  }

  const own = collectOwnOrders(book, ctx.bot.publicKey);
  const mid = midFromBook(book); // null unless the book is two-sided
  const index = await readIndexLevel(ctx.connection, market);
  const mark = await readMarkPrice(ctx.markUrl);
  const anchor = resolveAnchor(mark, index);
  if (anchor <= 0n) {
    console.error(
      `[mm] cycle skipped: no anchor reference (mark=${mark ?? "null"}, index=${index ?? "null"})`,
    );
    return;
  }

  // The crossing constraint must ignore the bot's own resting orders: the
  // requote cancels them first, so they must not block the new ladder.
  const bestBid = bestOtherPrice(book.bids, ctx.bot.publicKey, 0);
  const bestAsk = bestOtherPrice(book.asks, ctx.bot.publicKey, 1);
  const desired = planQuotes(anchor, bestBid, bestAsk, ctx.params);
  const plan = planRequote(own, desired);

  let submitted = 0;
  let failure: string | null = null;
  let signature: string | null = null;

  // ONE transaction per cycle: all cancels, then all places — atomic.
  const tx = buildRequoteTransaction(plan, {
    market: ctx.market,
    orderBook: ctx.orderBook,
    indexSource: market.indexSource,
    owner: ctx.bot.publicKey,
  });
  if (tx !== null) {
    try {
      signature = await submitRequote(ctx.connection, tx, ctx.bot);
      submitted = plan.cancels.length + plan.places.length;
    } catch (err) {
      failure = errorMessage(err);
    }
  }

  const summary =
    `[mm] cycle anchor=${anchor} ownOrders=${own.length} ` +
    `cancels=${plan.cancels.length} places=${plan.places.length} submitted=${submitted} ` +
    `mark=${mark ?? "null"} index=${index ?? "null"} mid=${mid ?? "null"}`;
  if (failure === null) {
    console.log(signature === null ? summary : `${summary} sig=${signature}`);
  } else {
    console.error(`${summary} errors=1 first="${failure}"`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Empty counts as missing: an env var that is set but blank is a config error.
  const rpcUrl = process.env.RPC_URL ?? "";
  const keypairPath = process.env.MM_KEYPAIR ?? "";
  const missing: string[] = [];
  if (rpcUrl === "") missing.push("RPC_URL");
  if (keypairPath === "") missing.push("MM_KEYPAIR");
  if (missing.length > 0) {
    console.error(
      `mm-bot: missing required env: ${missing.join(", ")} (the devstack prints both — or set them yourself)`,
    );
    process.exitCode = 1;
    return;
  }

  const params = parseQuoteParams(process.env);
  if (params === null) {
    console.error(
      "mm-bot: invalid MM_* configuration — MM_LEVELS 1..8, MM_SPREAD_BPS 1..10000, MM_SIZE digits-only > 0",
    );
    process.exitCode = 1;
    return;
  }

  let bot: Keypair;
  try {
    bot = loadKeypair(keypairPath);
  } catch (err) {
    console.error(`mm-bot: cannot load MM_KEYPAIR ${keypairPath}: ${errorMessage(err)}`);
    process.exitCode = 1;
    return;
  }

  const intervalMs = parseIntervalMs(process.env);
  const markUrl = process.env.MM_MARK_URL ?? "http://127.0.0.1:8787/market";
  const connection = new Connection(rpcUrl, "confirmed");
  const market = marketPda().address;
  const ctx: BotContext = {
    connection,
    bot,
    market,
    orderBook: orderBookPda(market).address,
    params,
    intervalMs,
    markUrl,
  };

  console.log(
    `[mm] bot=${bot.publicKey.toBase58()} rpc=${rpcUrl} market=${market.toBase58()} ` +
      `levels=${params.levels} spreadBps=${params.spreadBps} size=${params.size} ` +
      `intervalMs=${intervalMs} markUrl=${markUrl}`,
  );
  console.log("[mm] quoting — Ctrl-C to stop");

  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
    console.log("[mm] SIGINT — stopping");
    process.exit(0);
  });

  while (!stopping) {
    const started = Date.now();
    try {
      await runCycle(ctx);
    } catch (err) {
      console.error(`[mm] cycle error: ${errorMessage(err)}`);
    }
    if (stopping) break;
    const wait = intervalMs - (Date.now() - started);
    await sleep(wait > 0 ? wait : 0);
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  void main();
}
