//! RED acceptance tests for product-v3 REQ-K-1 (fill timestamps): the slot
//! clock's per-slot caching + ingestion-clock fallback, and the idempotent
//! `fills.block_time_ms` migration.
//!
//! RED on today's tree: `createSlotClock` is a stub (`timeForSlot → 0`,
//! `getBlockTime` never called) and `openDb` never adds the column — every
//! assertion below fails behaviourally, never on a compile/import error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSlotClock } from "../src/timestamps.js";
import { openDb } from "../src/db.js";

test("FILL-TIME-CACHED-ONCE: each distinct slot is fetched from the block-time source exactly once per process", async () => {
  const fetched: number[] = [];
  const clock = createSlotClock({
    getBlockTime: async (slot) => {
      fetched.push(slot);
      return 1_700_000_000 + slot; // seconds, as the RPC returns them
    },
    now: () => 42,
  });

  const slots = [100, 100, 101, 100, 102, 101, 100];
  const times: number[] = [];
  for (const slot of slots) times.push(await clock.timeForSlot(slot));

  assert.equal(
    fetched.length,
    3,
    `each distinct slot must be fetched exactly once — got ${fetched.length} fetches (${fetched.join(",")}) for 3 distinct slots`,
  );
  assert.deepEqual(
    times,
    [100, 100, 101, 100, 102, 101, 100].map((slot) => (1_700_000_000 + slot) * 1000),
    "timeForSlot must return seconds × 1000 for every occurrence",
  );

  // A second pass over the same slots adds no fetches (cache hit).
  for (const slot of slots) await clock.timeForSlot(slot);
  assert.equal(fetched.length, 3, `a second pass must hit the cache — got ${fetched.length} total fetches`);
});

test("FILL-TIME-FALLBACKS-TO-INGEST-CLOCK: a null or throwing block-time fetch yields exactly the ingestion clock", async () => {
  let nowCalls = 0;
  const clock = createSlotClock({
    getBlockTime: async (slot) => {
      if (slot === 7) return 1_700_000_007;
      if (slot === 8) return null; // unknown — RPC answered null
      throw new Error("rpc exploded"); // slot 9
    },
    now: () => {
      nowCalls += 1;
      return 777;
    },
  });

  const ok = await clock.timeForSlot(7);
  const fromNull = await clock.timeForSlot(8);
  const fromThrow = await clock.timeForSlot(9);

  assert.equal(ok, 1_700_000_007_000, "a known block time converts seconds → ms");
  assert.equal(fromNull, 777, "a null block time must fall back to the ingestion clock");
  assert.equal(fromThrow, 777, "a throwing fetch must fall back to the ingestion clock (never propagate)");
  assert.ok(nowCalls >= 2, `the fallback must consult the injected clock — now() called ${nowCalls} times`);
});

test("FILL-TIME-MIGRATES-OLD-TABLE: opening a store whose fills table predates block_time_ms adds the column and preserves existing rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "fructus-filltime-"));
  const path = join(dir, "old.sqlite");
  try {
    // A pre-migration store: the exact 7-column fills table of product-v2.
    const raw = new DatabaseSync(path);
    raw.exec(
      `CREATE TABLE fills (
        seq INTEGER PRIMARY KEY,
        slot INTEGER NOT NULL,
        market TEXT NOT NULL,
        owner TEXT,
        side INTEGER NOT NULL,
        price TEXT NOT NULL,
        size TEXT NOT NULL
      )`,
    );
    raw
      .prepare("INSERT INTO fills (seq, slot, market, owner, side, price, size) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(1, 500, "MarketX", "OwnerX", 0, "1000000", "2000000");
    raw.close();

    const db = openDb(path);
    const columns = db.raw.prepare("PRAGMA table_info(fills)").all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    assert.ok(
      names.includes("block_time_ms"),
      `openDb must migrate the fills table to carry block_time_ms — columns are ${names.join(",")}`,
    );

    const rows = db.listFills();
    assert.equal(rows.length, 1, "the migration must preserve existing rows");
    assert.equal(rows[0].price, "1000000");
    assert.equal(rows[0].timeMs ?? null, null, "pre-migration rows must surface timeMs null, never a fabricated time");
    db.close();

    // Idempotent: a second open must neither fail nor duplicate anything.
    const db2 = openDb(path);
    assert.equal(db2.listFills().length, 1, "re-opening a migrated store is a no-op");
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
