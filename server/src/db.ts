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
  return {
    seq: row.seq as number,
    slot: row.slot as number,
    market: row.market as string,
    owner: row.owner as string | null,
    side: row.side as number,
    price: row.price as string,
    size: row.size as string,
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
  `);

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
        "INSERT INTO fills (seq, slot, market, owner, side, price, size) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(fill.seq, fill.slot, fill.market, fill.owner, fill.side, fill.price, fill.size);
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
          `SELECT seq, slot, market, owner, side, price, size FROM fills
           ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY seq ASC LIMIT ?`,
        )
        .all(...params)
        .map((row) => toFillRow(row));
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
