//! Regression (confirmed counterexample, product-v3 review 2026-10-08):
//! with more in-window fills than the candles scan cap, the fetch must keep
//! the NEWEST rows. An oldest-first truncation silently ended the window early
//! and broke REQ-K-2's `last bucket == B_max` contract — measured with 100,002
//! in-window fills: the served window closed at `1699999980000` while the true
//! latest bucket was one interval later (`last bucket == B_max`: false).

import assert from "node:assert/strict";
import test from "node:test";
import { CANDLES_FILLS_SCAN_LIMIT } from "../src/api.js";
import { openDb } from "../src/db.js";
import { aggregateCandles, fillPoints } from "../src/market-data.js";

const MARKET = "Market1111111111111111111111111111111111111";
// Bucket width and origin chosen so seq 100_000 ends bucket 16_999 and seq
// 100_001 opens bucket 17_000 — the boundary sits exactly on t(100_001).
const INTERVAL_MS = 100_001_000;
const BUCKET_BOUNDARY = 17_000 * INTERVAL_MS;
const BASE = BUCKET_BOUNDARY - 100_001_000;

test(
  "CANDLES-KEEPS-NEWEST-AT-SCAN-CAP: with more in-window fills than the scan cap the window still ends at the true latest bucket",
  () => {
    const db = openDb(":memory:");
    try {
      const total = CANDLES_FILLS_SCAN_LIMIT + 2;
      for (let seq = 1; seq <= total; seq += 1) {
        db.insertFill({
          seq,
          slot: seq,
          market: MARKET,
          owner: "Owner1111111111111111111111111111111111111",
          side: 0,
          price: "1206000",
          size: "500000",
          timeMs: BASE + seq * 1_000,
        });
      }

      const latest = db.latestFillTimeMs(MARKET);
      assert.notEqual(latest, null, "fixture sanity: fills were persisted with times");
      const latestMs = latest as number;
      const bMax = Math.floor(latestMs / INTERVAL_MS) * INTERVAL_MS;
      assert.equal(bMax, BUCKET_BOUNDARY, "fixture sanity: the newest fill sits in bucket 17_000");

      const windowFloor = bMax - 2 * INTERVAL_MS; // limit = 3 buckets
      const fills = db.listFillsSince(MARKET, windowFloor, CANDLES_FILLS_SCAN_LIMIT);
      assert.equal(fills.length, CANDLES_FILLS_SCAN_LIMIT, "the scan cap bounds the read");
      assert.deepEqual(
        [fills[0]?.seq, fills[fills.length - 1]?.seq],
        [3, total],
        "the NEWEST rows survive truncation, ascending",
      );

      const candles = aggregateCandles(fillPoints(fills), INTERVAL_MS, 3);
      assert.equal(candles.length, 2, "empty buckets are not served");
      assert.equal(
        BigInt(candles[candles.length - 1]?.timeMs ?? "0"),
        BigInt(bMax),
        "the window ends at the true latest bucket (an oldest-first truncation ends at bucket 16_999)",
      );
      assert.equal(
        candles[0]?.trades,
        CANDLES_FILLS_SCAN_LIMIT - 2,
        "the two oldest fills fell outside the newest-first cap — the oldest bucket loses its head, not its tail",
      );
      assert.equal(candles[1]?.trades, 2, "the newest bucket carries the two newest fills");
      assert.ok(
        BigInt(candles[0]?.timeMs ?? "0") < BigInt(candles[1]?.timeMs ?? "0"),
        "buckets stay ascending",
      );
    } finally {
      db.close();
    }
  },
);
