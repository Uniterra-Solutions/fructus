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

test("SDK-ACCOUNT-HEALTH-MIRRORS-RUST: TS account-health mirrors are byte-identical to the Rust formulas across a seeded ≥10k-case sweep.", () => {
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

test("SDK-ACCOUNT-HEALTH-MIRRORS-RUST: TS account-health mirrors are byte-identical to the Rust formulas across a seeded ≥10k-case sweep. accountMarginRequired is the checked two-side ceiling sum.", () => {
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

test("SDK-ACCOUNT-HEALTH-MIRRORS-RUST: TS account-health mirrors are byte-identical to the Rust formulas across a seeded ≥10k-case sweep. accountLiquidatable is the strict equity-vs-maintenance predicate.", () => {
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

test("SDK-ACCOUNT-HEALTH-MIRRORS-RUST: TS account-health mirrors are byte-identical to the Rust formulas across a seeded ≥10k-case sweep. pinned specials — zero exposure, the equality boundary, a negative equity sum.", () => {
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

test("SDK-ACCOUNT-HEALTH-MIRRORS-RUST: TS account-health mirrors are byte-identical to the Rust formulas across a seeded ≥10k-case sweep. pinned independent ceiling vectors for marginRequired on inexact n×bps/10_000 divisions.", () => {
  // Independent pin of the CEILING convention (byte-identical to the Rust
  // `margin_required`'s `(n × bps + 9_999) / 10_000`). Every product below is
  // INEXACT in `/ 10_000`, so the ceiling sits exactly one microunit above the
  // floor; the raw literal expectations (never re-derived through
  // `marginRequired`) fail immediately on a ceiling→floor drift that the
  // sweeps above — which share the helper — cannot see:
  //   ceil(1          × 5_000 / 10_000) = ceil(0.5)          = 1          (floor 0)
  //   ceil(3          × 3_333 / 10_000) = ceil(0.9999)       = 1          (floor 0)
  //   ceil(10_001     × 1     / 10_000) = ceil(1.0001)       = 2          (floor 1)
  //   ceil(333        × 3_000 / 10_000) = ceil(99.9)         = 100        (floor 99)
  //   ceil(999_999_999_999 × 1 / 10_000) = ceil(99_999_999.9999) = 100_000_000 (floor 99_999_999)
  assert.equal(marginRequired(1n, 5_000), 1n, "ceil(0.5) rounds up");
  assert.equal(marginRequired(3n, 3_333), 1n, "ceil(0.9999) rounds up");
  assert.equal(marginRequired(10_001n, 1), 2n, "ceil(1.0001) rounds up");
  assert.equal(marginRequired(333n, 3_000), 100n, "ceil(99.9) rounds up");
  assert.equal(marginRequired(999_999_999_999n, 1), 100_000_000n, "ceil(99_999_999.9999) rounds up");

  // The account-level aggregate inherits the ceiling PER SIDE — under a floor
  // drift this would be 0 + 0 = 0:
  assert.equal(accountMarginRequired(1n, 1n, 1), 2n, "ceil(1/10_000) per side");

  // The strict trigger consumes the ceiling: equity == ceil(99.9) = 100 is
  // healthy; one microunit below is liquidatable.
  assert.equal(accountLiquidatable(100n, 0n, 333n, 0n, 3_000), false, "equity == ceiling ⇒ healthy");
  assert.equal(accountLiquidatable(99n, 0n, 333n, 0n, 3_000), true, "one microunit below the ceiling ⇒ liquidatable");
});
