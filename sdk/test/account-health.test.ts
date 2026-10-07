import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountEquity,
  accountLiquidatable,
  accountMarginRequired,
  marginRequired,
} from "../src/positions.js";

// SDK-ACCOUNT-HEALTH-MIRRORS-RUST (REQ-A2-5): the TS account-health mirrors
// must replicate the account-level Rust formulas byte-identically —
//   equity        = deposited + Σ upnl                       (account_equity)
//   requirement   = Σ_side marginRequired(n_side, bps)       (account_margin_required)
//   liquidatable  = equity < requirement, strict `<`, with a zero-exposure
//                   short-circuit (`n_long + n_short == 0 ⇒ false`)
// across a seeded deterministic sweep plus pinned specials. `bigint` is exact,
// so the comparison is the plain formula (the Rust `u64`-overflow `None` branch
// is unreachable in the mirror — the same totality convention as `applyPnl`).

const U64_MAX = 0xffffffffffffffffn;

// A deterministic xorshift64 PRNG so a divergence reproduces exactly.
function xorshift(seed: number): () => number {
  let s = BigInt(seed >>> 0) || 1n;
  return () => {
    s ^= s << 13n;
    s ^= s >> 7n;
    s ^= s << 17n;
    s &= 0xffffffffffffffffn;
    return Number(s % 1000000000000000000n);
  };
}

function bigInRange(rng: () => number, lo: bigint, hi: bigint): bigint {
  const span = hi - lo;
  return lo + (BigInt(rng()) % (span + 1n));
}

/** A signed Σ upnl value in the Rust `i128` domain (|magnitude| ≤ 2^127 − 1). */
function signedI128(rng: () => number): bigint {
  const mag = bigInRange(rng, 0n, (1n << 127n) - 1n);
  return rng() % 2 === 0 ? mag : -mag;
}

test("SDK-ACCOUNT-HEALTH-MIRRORS-RUST: accountEquity is the signed deposited + Σ upnl across a 10k seeded sweep.", () => {
  const rng = xorshift(0xa11ce);
  for (let i = 0; i < 10_000; i++) {
    const deposited = bigInRange(rng, 0n, U64_MAX);
    const pnlSum = signedI128(rng);
    assert.equal(
      accountEquity(deposited, pnlSum),
      deposited + pnlSum,
      `accountEquity(deposited=${deposited}, pnlSum=${pnlSum})`,
    );
  }
});

test("SDK-ACCOUNT-HEALTH-MIRRORS-RUST: accountMarginRequired is the checked two-side ceiling sum across a 10k seeded sweep.", () => {
  const rng = xorshift(0xb0b);
  for (let i = 0; i < 10_000; i++) {
    const nLong = bigInRange(rng, 0n, U64_MAX);
    const nShort = bigInRange(rng, 0n, U64_MAX);
    const bps = Number(bigInRange(rng, 0n, 10_000n));
    assert.equal(
      accountMarginRequired(nLong, nShort, bps),
      marginRequired(nLong, bps) + marginRequired(nShort, bps),
      `accountMarginRequired(nLong=${nLong}, nShort=${nShort}, bps=${bps})`,
    );
  }
});

test("SDK-ACCOUNT-HEALTH-MIRRORS-RUST: accountLiquidatable is the strict equity-vs-maintenance predicate across a 10k seeded sweep.", () => {
  const rng = xorshift(0xc0ffee);
  for (let i = 0; i < 10_000; i++) {
    const deposited = bigInRange(rng, 0n, U64_MAX);
    const pnlSum = signedI128(rng);
    const nLong = bigInRange(rng, 0n, U64_MAX);
    const nShort = bigInRange(rng, 0n, U64_MAX);
    const bps = Number(bigInRange(rng, 0n, 10_000n));
    const equity = deposited + pnlSum;
    const requirement = marginRequired(nLong, bps) + marginRequired(nShort, bps);
    const expected = nLong + nShort === 0n ? false : equity < requirement;
    assert.equal(
      accountLiquidatable(deposited, pnlSum, nLong, nShort, bps),
      expected,
      `accountLiquidatable(deposited=${deposited}, pnlSum=${pnlSum}, nLong=${nLong}, nShort=${nShort}, bps=${bps})`,
    );
  }
});

test("SDK-ACCOUNT-HEALTH-MIRRORS-RUST: pinned specials — zero exposure, the equality boundary, a negative equity sum.", () => {
  // Zero exposure is never liquidatable — the short-circuit fires before the
  // comparison (`equity < requirement` would read `-1 < 0` ⇒ true without it).
  assert.equal(accountLiquidatable(0n, -1n, 0n, 0n, 500), false, "zero exposure short-circuits");
  assert.equal(accountLiquidatable(7n, -7n, 0n, 0n, 10_000), false, "zero exposure with zero equity");

  // Strict `<`: equity == requirement is healthy; one microunit under is not.
  const notional = 2_000n;
  const bps = 5_000;
  const req = marginRequired(notional, bps); // ceil(2000 × 5000 / 10_000) = 1000
  assert.equal(req, 1_000n, "the pinned requirement");
  assert.equal(accountLiquidatable(req, 0n, notional, 0n, bps), false, "equity == requirement ⇒ healthy");
  assert.equal(accountLiquidatable(req - 1n, 0n, notional, 0n, bps), true, "one microunit below ⇒ liquidatable");

  // A side that is individually healthy still triggers through its sibling:
  // the account-level requirement SUMS both sides (D6, no netting).
  assert.equal(accountLiquidatable(1_000n, 0n, notional, notional, bps), true, "both sides counted");

  // The negative-sum convention: Σ upnl below −deposited ⇒ negative equity.
  assert.equal(accountEquity(100n, -101n), -1n, "negative equity");
  assert.equal(accountEquity(0n, -1n), -1n, "negative equity without deposits");
  assert.equal(accountLiquidatable(100n, -101n, 10n, 0n, 10_000), true, "negative equity below requirement");

  // u64 extremes stay exact in the bigint mirror.
  assert.equal(accountEquity(U64_MAX, -U64_MAX), 0n, "u64-max equity cancels to zero");
  assert.equal(accountMarginRequired(U64_MAX, U64_MAX, 10_000), 2n * U64_MAX, "two-sided sum exceeds u64 without wrapping");
  assert.equal(accountMarginRequired(0n, 0n, 10_000), 0n, "zero exposure ⇒ zero requirement");
});
