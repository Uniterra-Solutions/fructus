//! SQLite state store (D11, REQ-B-2/B-3): one generic account table per indexed
//! kind (`pubkey` PK, `data` BLOB, `slot`), plus the history/log tables the
//! indexer, operator service and auth flow write (`fills`, `funding_events`,
//! `tx_log`, `auth_nonces`). `node:sqlite` is a Node >= 22 builtin — no
//! dependency, synchronous API.

import { DatabaseSync } from "node:sqlite";

/** Indexed account kinds — one table each (REQ-B-2). */
export const ACCOUNT_KINDS = [
  "oracle",
  "market",
  "order_book",
  "user_collateral",
  "position",
  "operator",
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export interface AccountRow {
  kind: AccountKind;
  pubkey: string;
  /** Raw account data, byte-identical to the chain. */
  data: Uint8Array;
  slot: number;
}

/** One derived OrderBook fill (REQ-B-2). */
export interface FillRow {
  /** OrderBook event-ring sequence — primary key, fills are seq-ordered. */
  seq: number;
  slot: number;
  market: string;
  /** Owner the fill is attributed to; `null` until decoding lands. */
  owner: string | null;
  /** 0 = long/bid, 1 = short/ask. */
  side: number;
  /** Raw base units, decimal strings (u64). */
  price: string;
  size: string;
  /**
   * Block time of the fill's slot in ms (product-v3 REQ-K-1). `null`/absent
   * only for rows persisted before the block_time_ms migration (those rows are
   * excluded from candles and reported with `timeMs: null` on the tape).
   */
  timeMs?: number | null;
}

/** One mark-price sample feeding the candle series (product-v3 candles v2). */
export interface MarkSampleRow {
  /** ms epoch. */
  timeMs: number;
  /** Raw price, decimal string. */
  price: string;
}

/** One funding-accumulator diff (REQ-B-2). */
export interface FundingEventRow {
  /** Monotonic event seq — primary key. */
  seq: number;
  slot: number;
  market: string;
  /** Signed cumulative delta (decimal i128 string). */
  amount: string;
}

export interface TxLogRow {
  id: string;
  wallet: string;
  kind: string;
  status: "queued" | "sent" | "confirmed" | "failed";
  signature: string | null;
  error: string | null;
  /** ms epoch. */
  createdAt: number;
}

/** Single-use SIWS challenge record (REQ-B-4). */
export interface NonceRow {
  nonce: string;
  wallet: string;
  signInInput: string;
  /** ms epoch. */
  expiresAt: number;
  consumed: boolean;
}

export interface ListFillsOptions {
  owner?: string;
  market?: string;
  limit?: number;
}

export interface Db {
  /** Escape hatch for later waves (transactions, ad-hoc queries). */
  readonly raw: DatabaseSync;

  upsertAccount(kind: AccountKind, pubkey: string, data: Uint8Array, slot: number): void;
  getAccount(kind: AccountKind, pubkey: string): AccountRow | null;
  listAccounts(kind: AccountKind): AccountRow[];

  insertFill(fill: FillRow): void;
  listFills(opts?: ListFillsOptions): FillRow[];
  /** Fills of a market with `timeMs >= minTimeMs`, ascending by seq (product-v3 REQ-K-2). */
  listFillsSince(market: string, minTimeMs: number, limit?: number): FillRow[];
  /** The market's most recent fills, descending by seq (product-v3 REQ-K-3). */
  listRecentFills(market: string, limit: number): FillRow[];
  /** Latest non-null `block_time_ms` for a market; `null` when none exists (product-v3 REQ-K-2). */
  latestFillTimeMs(market: string): number | null;
  /** Latest fill price for a market (most recent seq); `null` when none exists. */
  latestFillPrice(market: string): string | null;

  /** Append one mark-price sample; a same-ms write replaces the previous row (product-v3 candles v2). */
  insertMarkSample(timeMs: number, price: string): void;
  /** Mark samples with `timeMs >= minTimeMs`, ascending (newest rows win past `limit`). */
  listMarkSamplesSince(minTimeMs: number, limit?: number): MarkSampleRow[];
  /** Latest mark-sample timestamp; `null` when none exists. */
  latestMarkSampleTimeMs(): number | null;
  /** Drop samples older than `beforeMs`; returns the deleted row count. */
  pruneMarkSamples(beforeMs: number): number;
  insertFundingEvent(row: FundingEventRow): void;
  listFundingEvents(market: string, limit?: number): FundingEventRow[];

  insertTxLog(row: TxLogRow): void;
  getTxLog(id: string): TxLogRow | null;
  updateTxLog(id: string, patch: Partial<Pick<TxLogRow, "status" | "signature" | "error">>): TxLogRow | null;

  createNonce(row: NonceRow): void;
  getNonce(nonce: string): NonceRow | null;
  /**Single-use consume: returns the row iff it existed, was unconsumed and is unexpired. */
  consumeNonce(nonce: string, now?: number): NonceRow | null;
  deleteExpiredNonces(now?: number): number;

  /** Record one accepted faucet drip (REQ-B-8 exactly-once crediting). */
  insertFaucetCredit(wallet: string, amount: bigint, createdAt: number): void;
  /** Sum of faucet drips in scope (`since` = ms epoch lower bound, inclusive). */
  sumFaucetCredits(filter?: { wallet?: string; since?: number }): bigint;

  close(): void;
}

type Param = string | number | bigint | Uint8Array | null;

function accountTable(kind: AccountKind): string {
  // `kind` comes from the ACCOUNT_KINDS constant, never from user input.
  return kind;
}

function toAccountRow(kind: AccountKind, row: Record<string, unknown>): AccountRow {
  return {
    kind,
    pubkey: row.pubkey as string,
    data: row.data as Uint8Array,
    slot: row.slot as number,
  };
}

function toFillRow(row: Record<string, unknown>): FillRow {
  const blockTime = row.block_time_ms;
  return {
    seq: row.seq as number,
    slot: row.slot as number,
    market: row.market as string,
    owner: row.owner as string | null,
    side: row.side as number,
    price: row.price as string,
    size: row.size as string,
    timeMs: blockTime === null || blockTime === undefined ? null : (blockTime as number),
  };
}

function toTxLogRow(row: Record<string, unknown>): TxLogRow {
  return {
    id: row.id as string,
    wallet: row.wallet as string,
    kind: row.kind as string,
    status: row.status as TxLogRow["status"],
    signature: row.signature as string | null,
    error: row.error as string | null,
    createdAt: row.created_at as number,
  };
}

function toNonceRow(row: Record<string, unknown>): NonceRow {
  return {
    nonce: row.nonce as string,
    wallet: row.wallet as string,
    signInInput: row.sign_in_input as string,
    expiresAt: row.expires_at as number,
    consumed: row.consumed === 1,
  };
}

/**
 * Open (or create) the SQLite store at `path` (":memory:" works) and ensure the
 * full schema. Synchronous by design: `node:sqlite` is sync and the server is a
 * single process.
 */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);

  // The store is shared across processes in the e2e fixtures (the test process
  // opens the server's SQLite file to read `tx_log` rows while the server is
  // writing them), so connections must wait for locks instead of failing with
  // SQLITE_BUSY, and WAL keeps readers from blocking on writers. Both pragmas
  // are no-ops for `:memory:` stores.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");

  const accountTables = ACCOUNT_KINDS.map(
    (kind) =>
      `CREATE TABLE IF NOT EXISTS ${accountTable(kind)} (
         pubkey TEXT PRIMARY KEY,
         data   BLOB NOT NULL,
         slot   INTEGER NOT NULL
       );`,
  ).join("\n");

  db.exec(`
    ${accountTables}

    CREATE TABLE IF NOT EXISTS fills (
      seq    INTEGER PRIMARY KEY,
      slot   INTEGER NOT NULL,
      market TEXT NOT NULL,
      owner  TEXT,
      side   INTEGER NOT NULL,
      price  TEXT NOT NULL,
      size   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS funding_events (
      seq    INTEGER PRIMARY KEY,
      slot   INTEGER NOT NULL,
      market TEXT NOT NULL,
      amount TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tx_log (
      id         TEXT PRIMARY KEY,
      wallet     TEXT NOT NULL,
      kind       TEXT NOT NULL,
      status     TEXT NOT NULL,
      signature  TEXT,
      error      TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_nonces (
      nonce         TEXT PRIMARY KEY,
      wallet        TEXT NOT NULL,
      sign_in_input TEXT NOT NULL,
      expires_at    INTEGER NOT NULL,
      consumed      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS faucet_credits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet     TEXT NOT NULL,
      amount     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mark_samples (
      time_ms INTEGER PRIMARY KEY,
      price   TEXT NOT NULL
    );
  `);

  // product-v3 REQ-K-1: stores deployed before v3 carry the 7-column fills
  // table — add `block_time_ms` in place. Idempotent (column check first), so
  // every open of a fresh or already-migrated store is a no-op.
  const fillColumns = db.prepare("PRAGMA table_info(fills)").all() as Array<{ name: string }>;
  if (!fillColumns.some((column) => column.name === "block_time_ms")) {
    try {
      db.exec("ALTER TABLE fills ADD COLUMN block_time_ms INTEGER;");
    } catch (error) {
      // A concurrent opener can win the check/ALTER race — the column exists
      // either way; anything else is a real failure and rethrows.
      if (!/duplicate column/i.test(String(error))) throw error;
    }
  }

  // Named binding (not `this`) so the helpers stay callable when destructured.
  const api: Db = {
    raw: db,

    upsertAccount(kind, pubkey, data, slot) {
      db.prepare(
        `INSERT INTO ${accountTable(kind)} (pubkey, data, slot) VALUES (?, ?, ?)
         ON CONFLICT(pubkey) DO UPDATE SET data = excluded.data, slot = excluded.slot`,
      ).run(pubkey, data, slot);
    },

    getAccount(kind, pubkey) {
      const row = db
        .prepare(`SELECT pubkey, data, slot FROM ${accountTable(kind)} WHERE pubkey = ?`)
        .get(pubkey);
      return row ? toAccountRow(kind, row) : null;
    },

    listAccounts(kind) {
      return db
        .prepare(`SELECT pubkey, data, slot FROM ${accountTable(kind)} ORDER BY pubkey`)
        .all()
        .map((row) => toAccountRow(kind, row));
    },

    insertFill(fill) {
      db.prepare(
        "INSERT INTO fills (seq, slot, market, owner, side, price, size, block_time_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(fill.seq, fill.slot, fill.market, fill.owner, fill.side, fill.price, fill.size, fill.timeMs ?? null);
    },

    listFills(opts = {}) {
      const where: string[] = [];
      const params: Param[] = [];
      if (opts.owner !== undefined) {
        where.push("owner = ?");
        params.push(opts.owner);
      }
      if (opts.market !== undefined) {
        where.push("market = ?");
        params.push(opts.market);
      }
      params.push(opts.limit ?? 1_000);
      return db
        .prepare(
          `SELECT seq, slot, market, owner, side, price, size, block_time_ms FROM fills
           ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(...params)
        .map((row) => toFillRow(row));
    },

    listFillsSince(market, minTimeMs, limit = 100_000) {
      // Newest-first read (reversed before return): when the window holds more
      // rows than `limit`, the rows kept must be the LATEST ones — the candle
      // window has to end at the true latest bucket (REQ-K-2), which an
      // oldest-first truncation silently breaks past the scan cap.
      return db
        .prepare(
          `SELECT seq, slot, market, owner, side, price, size, block_time_ms FROM fills
           WHERE market = ? AND block_time_ms IS NOT NULL AND block_time_ms >= ?
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(market, minTimeMs, limit)
        .map((row) => toFillRow(row))
        .reverse();
    },

    listRecentFills(market, limit) {
      return db
        .prepare(
          `SELECT seq, slot, market, owner, side, price, size, block_time_ms FROM fills
           WHERE market = ? ORDER BY seq DESC LIMIT ?`,
        )
        .all(market, limit)
        .map((row) => toFillRow(row));
    },

    latestFillTimeMs(market) {
      const row = db
        .prepare("SELECT MAX(block_time_ms) AS max_time FROM fills WHERE market = ?")
        .get(market) as { max_time: number | null } | undefined;
      return row?.max_time ?? null;
    },

    latestFillPrice(market) {
      const row = db
        .prepare("SELECT price FROM fills WHERE market = ? ORDER BY seq DESC LIMIT 1")
        .get(market) as { price: string } | undefined;
      return row?.price ?? null;
    },

    insertMarkSample(timeMs, price) {
      db.prepare("INSERT OR REPLACE INTO mark_samples (time_ms, price) VALUES (?, ?)").run(timeMs, price);
    },

    listMarkSamplesSince(minTimeMs, limit = 100_000) {
      // Newest-first read (reversed before return) for the same reason as
      // `listFillsSince`: past the limit the window must keep the LATEST rows.
      return (
        db
          .prepare(
            `SELECT time_ms AS timeMs, price FROM mark_samples
             WHERE time_ms >= ? ORDER BY time_ms DESC LIMIT ?`,
          )
          .all(minTimeMs, limit) as Array<{ timeMs: number; price: string }>
      ).reverse();
    },

    latestMarkSampleTimeMs() {
      const row = db.prepare("SELECT MAX(time_ms) AS max_time FROM mark_samples").get() as
        | { max_time: number | null }
        | undefined;
      return row?.max_time ?? null;
    },

    pruneMarkSamples(beforeMs) {
      return Number(db.prepare("DELETE FROM mark_samples WHERE time_ms < ?").run(beforeMs).changes);
    },

    insertFundingEvent(row) {
      db.prepare("INSERT INTO funding_events (seq, slot, market, amount) VALUES (?, ?, ?, ?)").run(
        row.seq,
        row.slot,
        row.market,
        row.amount,
      );
    },

    listFundingEvents(market, limit = 1_000) {
      return db
        .prepare(
          "SELECT seq, slot, market, amount FROM funding_events WHERE market = ? ORDER BY seq ASC LIMIT ?",
        )
        .all(market, limit)
        .map((row) => ({
          seq: row.seq as number,
          slot: row.slot as number,
          market: row.market as string,
          amount: row.amount as string,
        }));
    },

    insertTxLog(row) {
      db.prepare(
        `INSERT INTO tx_log (id, wallet, kind, status, signature, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.id, row.wallet, row.kind, row.status, row.signature, row.error, row.createdAt);
    },

    getTxLog(id) {
      const row = db
        .prepare("SELECT id, wallet, kind, status, signature, error, created_at FROM tx_log WHERE id = ?")
        .get(id);
      return row ? toTxLogRow(row) : null;
    },

    updateTxLog(id, patch) {
      const sets: string[] = [];
      const params: Param[] = [];
      if (patch.status !== undefined) {
        sets.push("status = ?");
        params.push(patch.status);
      }
      if (patch.signature !== undefined) {
        sets.push("signature = ?");
        params.push(patch.signature);
      }
      if (patch.error !== undefined) {
        sets.push("error = ?");
        params.push(patch.error);
      }
      if (sets.length > 0) {
        params.push(id);
        db.prepare(`UPDATE tx_log SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      }
      return api.getTxLog(id);
    },

    createNonce(row) {
      db.prepare(
        "INSERT INTO auth_nonces (nonce, wallet, sign_in_input, expires_at, consumed) VALUES (?, ?, ?, ?, ?)",
      ).run(row.nonce, row.wallet, row.signInInput, row.expiresAt, row.consumed ? 1 : 0);
    },

    getNonce(nonce) {
      const row = db
        .prepare("SELECT nonce, wallet, sign_in_input, expires_at, consumed FROM auth_nonces WHERE nonce = ?")
        .get(nonce);
      return row ? toNonceRow(row) : null;
    },

    consumeNonce(nonce, now = Date.now()) {
      const row = api.getNonce(nonce);
      if (row === null || row.consumed || row.expiresAt < now) return null;
      db.prepare("UPDATE auth_nonces SET consumed = 1 WHERE nonce = ?").run(nonce);
      return { ...row, consumed: true };
    },

    deleteExpiredNonces(now = Date.now()) {
      return Number(db.prepare("DELETE FROM auth_nonces WHERE expires_at < ?").run(now).changes);
    },

    insertFaucetCredit(wallet, amount, createdAt) {
      db.prepare("INSERT INTO faucet_credits (wallet, amount, created_at) VALUES (?, ?, ?)").run(
        wallet,
        amount.toString(),
        createdAt,
      );
    },

    sumFaucetCredits(filter = {}) {
      const where: string[] = [];
      const params: Param[] = [];
      if (filter.wallet !== undefined) {
        where.push("wallet = ?");
        params.push(filter.wallet);
      }
      if (filter.since !== undefined) {
        where.push("created_at >= ?");
        params.push(filter.since);
      }
      const rows = db
        .prepare(
          `SELECT amount FROM faucet_credits ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`,
        )
        .all(...params);
      return rows.reduce((total, row) => total + BigInt(row.amount as string), 0n);
    },

    close() {
      db.close();
    },
  };
  return api;
}
