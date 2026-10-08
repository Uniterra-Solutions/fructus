//! RED acceptance tests for product-v3 REQ-K-3 (trades endpoint): the
//! descending bounded read + the fill→TradeView projection + limit parsing.
//!
//! RED on today's tree: `listRecentFills` is a stub returning `[]`,
//! `parseTradesLimit` returns null for everything and `toTradeView` always
//! projects `timeMs: null` — every assertion fails behaviourally.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db, type FillRow } from "../src/db.js";
import { parseTradesLimit, toTradeView } from "../src/market-data.js";

function row(seq: number, market: string, overrides: Partial<FillRow> = {}): FillRow {
  return {
    seq,
    slot: 1_000 + seq,
    market,
    owner: `Owner${seq}`,
    side: (seq % 2) as 0 | 1,
    price: String(100_000 + seq),
    size: String(1_000_000 + seq),
    ...overrides,
  };
}

function withDb(fn: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fructus-trades-"));
  const db = openDb(join(dir, "t.db"));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("TRADES-LATEST-FIRST-BOUNDED: rows are strictly descending by seq, at most limit, with the exact stored fields", () => {
  withDb((db) => {
    for (let seq = 1; seq <= 9; seq++) db.insertFill(row(seq, "M"));
    db.insertFill(row(50, "OTHER")); // a different market must not leak in

    const top4 = db.listRecentFills("M", 4);
    assert.deepEqual(
      top4.map((r) => r.seq),
      [9, 8, 7, 6],
      "latest-first, bounded, foreign markets excluded",
    );
    const head = top4[0];
    assert.equal(head.slot, 1_009);
    assert.equal(head.market, "M");
    assert.equal(head.owner, "Owner9");
    assert.equal(head.side, 1);
    assert.equal(head.price, String(100_000 + 9));
    assert.equal(head.size, String(1_000_000 + 9));

    assert.deepEqual(db.listRecentFills("M", 1).map((r) => r.seq), [9], "limit 1 keeps exactly the newest");
    assert.deepEqual(db.listRecentFills("M", 100).map((r) => r.seq), [9, 8, 7, 6, 5, 4, 3, 2, 1], "limit above the count serves all");
  });

  // Query parsing: default 50, bounds 1..200, digits only.
  assert.equal(parseTradesLimit(new URLSearchParams("")), 50, "limit defaults to 50");
  assert.equal(parseTradesLimit(new URLSearchParams("limit=7")), 7);
  assert.equal(parseTradesLimit(new URLSearchParams("limit=1")), 1);
  assert.equal(parseTradesLimit(new URLSearchParams("limit=200")), 200);
  for (const bad of ["limit=0", "limit=201", "limit=-1", "limit=abc", "limit=1.5", "limit=1e2", "limit="]) {
    assert.equal(parseTradesLimit(new URLSearchParams(bad)), null, `must reject ${JSON.stringify(bad)}`);
  }
});

test("TRADES-INCLUDE-UNTIMED: a row whose block_time_ms is NULL still appears with timeMs: null", () => {
  withDb((db) => {
    db.insertFill(row(1, "M", { timeMs: null }));
    db.insertFill(row(2, "M", { timeMs: 1_700_000_000_123 }));

    const rows = db.listRecentFills("M", 10);
    assert.deepEqual(rows.map((r) => r.seq), [2, 1]);
    assert.equal(rows[0].timeMs, 1_700_000_000_123, "a timed row round-trips its block time in ms");
    assert.equal(rows[1].timeMs ?? null, null, "an untimed row stays null");
  });

  // The wire projection: exact field mapping incl. the ms → string / null.
  assert.deepEqual(
    toTradeView({ seq: 5, slot: 42, market: "M", owner: "O", side: 1, price: "5", size: "6", timeMs: 1_700_000_000_123 }),
    { seq: "5", slot: "42", timeMs: "1700000000123", owner: "O", side: 1, price: "5", size: "6" },
    "timed fills project their ms as a decimal string",
  );
  assert.deepEqual(
    toTradeView({ seq: 6, slot: 43, market: "M", owner: "O", side: 0, price: "5", size: "6", timeMs: null }),
    { seq: "6", slot: "43", timeMs: null, owner: "O", side: 0, price: "5", size: "6" },
    "untimed fills project timeMs null",
  );
});
