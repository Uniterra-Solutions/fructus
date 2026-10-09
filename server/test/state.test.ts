//! RED acceptance test for the server state layer (D11/D12, REQ-B-3):
//! `STATE-HEALTH-MATCHES-PROGRAM-TRIGGER` — `computePortfolio`'s aggregates and
//! `health` flag must equal the program's account-level predicate for every
//! generated account set.
//!
//! Rust reference (programs/fructus/src/liquidation.rs + positions.rs):
//!  - `equity = deposited + Σ_side upnl` (signed; upnl = `positions::pnl` of the
//!    position's entry running sums vs the market row's `index_n`/`index_d`,
//!    the only in-DB rate snapshot the server can see);
//!  - `requirementInitial = Σ_side marginRequired(n_side, initial_bps)` and
//!    `requirementMaint = Σ_side marginRequired(n_side, maintenance_bps)` —
//!    cross-margin, NO netting;
//!  - `liquidatable ⇔ (n_long + n_short > 0) ∧ equity < requirementMaint`
//!    (strict `<`; zero exposure ⇒ false; pristine sides contribute zero).
//!
//! Rows are built through the real `server/src/db.ts` helpers in the exact raw
//! account shapes (SDK layout offsets + Anchor discriminator) that the indexer
//! writes, at the canonical PDA pubkeys `computePortfolio` must find.
//!
//! RED on today's tree: `computePortfolio` is a zero-DTO STUB — every test
//! below fails on an assertion, never on a compile/import error.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { APY_SCALE } from "fructus-sdk/src/constants.js";
import {
  PERP_MARKET_LEN,
  POSITION_LEN,
  USER_COLLATERAL_LEN,
  PerpMarket,
  Position,
  UserCollateralLayout,
} from "fructus-sdk/src/account/layout.js";
import { anchorAccountDiscriminator } from "fructus-sdk/src/encoding.js";
import { PROGRAM_ID, marketPda, positionPda, userCollateralPda } from "fructus-sdk/src/index.js";
import type { UserPortfolio } from "fructus-sdk/src/api.js";
import { openDb, type Db } from "../src/db.js";
import { computePortfolio } from "../src/state.js";

const DISCRIMINATOR = 8;
const WALLET = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
const MARKET = marketPda(PROGRAM_ID).address;

// ---------------------------------------------------------------------------
// Seeded PRNG (same style as sdk/test/review-invariants.test.ts)
// ---------------------------------------------------------------------------

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

function pick(rng: () => number, m: number): number {
  return Number(BigInt(rng()) % BigInt(m));
}

function bigInRange(rng: () => number, lo: bigint, hi: bigint): bigint {
  return lo + (BigInt(rng()) % (hi - lo + 1n));
}

// ---------------------------------------------------------------------------
// Raw account buffers (payload offsets from sdk/src/account/layout.ts)
// ---------------------------------------------------------------------------

function u128LE(value: bigint): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  buf.writeBigUInt64LE(value >> 64n, 8);
  return buf;
}

function marketRow(seed: PortfolioSeed): Buffer {
  const data = Buffer.alloc(DISCRIMINATOR + PERP_MARKET_LEN);
  anchorAccountDiscriminator("PerpMarket").copy(data, 0);
  data.writeUInt16LE(seed.initialMarginBps, DISCRIMINATOR + PerpMarket.initialMarginBps);
  data.writeUInt16LE(seed.maintenanceMarginBps, DISCRIMINATOR + PerpMarket.maintenanceMarginBps);
  data.writeBigUInt64LE(seed.indexN, DISCRIMINATOR + PerpMarket.indexN);
  data.writeBigUInt64LE(seed.indexD, DISCRIMINATOR + PerpMarket.indexD);
  data[DISCRIMINATOR + PerpMarket.bump] = 254;
  return data;
}

function userCollateralRow(deposited: bigint, reserved: bigint, claimable: bigint): Buffer {
  const data = Buffer.alloc(DISCRIMINATOR + USER_COLLATERAL_LEN);
  anchorAccountDiscriminator("UserCollateral").copy(data, 0);
  data.writeBigUInt64LE(deposited, DISCRIMINATOR + UserCollateralLayout.deposited);
  data.writeBigUInt64LE(reserved, DISCRIMINATOR + UserCollateralLayout.reserved);
  data.writeBigUInt64LE(claimable, DISCRIMINATOR + UserCollateralLayout.claimable);
  data[DISCRIMINATOR + UserCollateralLayout.bump] = 255;
  return data;
}

interface SideSeed {
  notional: bigint;
  entryN: bigint;
  entryD: bigint;
}

function positionRow(side: number, seed: SideSeed): Buffer {
  const data = Buffer.alloc(DISCRIMINATOR + POSITION_LEN);
  anchorAccountDiscriminator("Position").copy(data, 0);
  MARKET.toBuffer().copy(data, DISCRIMINATOR + Position.market);
  WALLET.toBuffer().copy(data, DISCRIMINATOR + Position.owner);
  data[DISCRIMINATOR + Position.side] = side;
  data.writeBigUInt64LE(seed.notional, DISCRIMINATOR + Position.notional);
  u128LE(seed.entryN).copy(data, DISCRIMINATOR + Position.entryN);
  u128LE(seed.entryD).copy(data, DISCRIMINATOR + Position.entryD);
  data[DISCRIMINATOR + Position.bump] = 253;
  return data;
}

interface PortfolioSeed {
  deposited: bigint;
  reserved: bigint;
  claimable: bigint;
  long: SideSeed;
  short: SideSeed;
  /** Market `index_n`/`index_d`: the rate snapshot upnl is priced against. */
  indexN: bigint;
  indexD: bigint;
  initialMarginBps: number;
  maintenanceMarginBps: number;
}

function seedPortfolio(db: Db, seed: PortfolioSeed): void {
  db.upsertAccount("market", MARKET.toBase58(), marketRow(seed), 1);
  db.upsertAccount(
    "user_collateral",
    userCollateralPda(MARKET, WALLET).address.toBase58(),
    userCollateralRow(seed.deposited, seed.reserved, seed.claimable),
    1,
  );
  db.upsertAccount(
    "position",
    positionPda(MARKET, WALLET, 0).address.toBase58(),
    positionRow(0, seed.long),
    1,
  );
  db.upsertAccount(
    "position",
    positionPda(MARKET, WALLET, 1).address.toBase58(),
    positionRow(1, seed.short),
    1,
  );
}

// ---------------------------------------------------------------------------
// Inline expected formulas (independent re-derivation of positions.rs::
// margin_required / pnl, not imports of the mirrors under test)
// ---------------------------------------------------------------------------

/** `ceil(notional × bps / 10_000)` — Rust `positions::margin_required`. */
function expectedMargin(notional: bigint, bps: number): bigint {
  return (notional * BigInt(bps) + 9_999n) / 10_000n;
}

/**
 * Signed position PnL in USDC microunits (Rust `positions::pnl`): normalize the
 * entry running sums by the shared power-of-two shift, cross-multiply against
 * the current rate, scale by APY_SCALE, and apply the side sign. A pristine or
 * degenerate side contributes zero.
 */
function expectedPnl(side: SideSeed, indexN: bigint, indexD: bigint, sideByte: 0 | 1): bigint {
  const { notional, entryN, entryD } = side;
  if (notional === 0n || entryN === 0n || entryD === 0n || indexN === 0n || indexD === 0n) {
    return 0n;
  }
  const maxSum = entryN > entryD ? entryN : entryD;
  const shift = BigInt(Math.max(0, maxSum.toString(2).length - 45));
  const nE = entryN >> shift;
  const dE = entryD >> shift;
  if (nE === 0n || dE === 0n) {
    return 0n;
  }
  const change = ((indexN * dE - nE * indexD) * APY_SCALE) / (nE * indexD);
  const scaled = (notional * change) / APY_SCALE;
  return sideByte === 0 ? scaled : -scaled;
}

function expectedPortfolio(seed: PortfolioSeed): {
  upnlLong: bigint;
  upnlShort: bigint;
  equity: bigint;
  requirementInitial: bigint;
  requirementMaint: bigint;
  health: "healthy" | "liquidatable";
} {
  const upnlLong = expectedPnl(seed.long, seed.indexN, seed.indexD, 0);
  const upnlShort = expectedPnl(seed.short, seed.indexN, seed.indexD, 1);
  const equity = seed.deposited + upnlLong + upnlShort;
  const requirementInitial =
    expectedMargin(seed.long.notional, seed.initialMarginBps) +
    expectedMargin(seed.short.notional, seed.initialMarginBps);
  const requirementMaint =
    expectedMargin(seed.long.notional, seed.maintenanceMarginBps) +
    expectedMargin(seed.short.notional, seed.maintenanceMarginBps);
  const exposure = seed.long.notional + seed.short.notional > 0n;
  return {
    upnlLong,
    upnlShort,
    equity,
    requirementInitial,
    requirementMaint,
    health: exposure && equity < requirementMaint ? "liquidatable" : "healthy",
  };
}

function assertPortfolio(portfolio: UserPortfolio, seed: PortfolioSeed, label: string): void {
  const expected = expectedPortfolio(seed);
  assert.equal(portfolio.wallet, WALLET.toBase58(), `${label}: wallet`);
  assert.equal(portfolio.deposited, seed.deposited.toString(), `${label}: deposited`);
  assert.equal(portfolio.reserved, seed.reserved.toString(), `${label}: reserved`);
  assert.equal(portfolio.claimable, seed.claimable.toString(), `${label}: claimable`);
  assert.equal(portfolio.free, (seed.deposited - seed.reserved).toString(), `${label}: free = deposited - reserved`);
  assert.equal(portfolio.equity, expected.equity.toString(), `${label}: equity = deposited + Σ upnl`);
  assert.equal(
    portfolio.requirementInitial,
    expected.requirementInitial.toString(),
    `${label}: requirementInitial = Σ m(n_i, initial_bps)`,
  );
  assert.equal(
    portfolio.requirementMaint,
    expected.requirementMaint.toString(),
    `${label}: requirementMaint = Σ m(n_i, maintenance_bps)`,
  );
  assert.equal(
    portfolio.health,
    expected.health,
    `${label}: health must equal the account-level predicate (strict <, zero-exposure false)`,
  );

  for (const [side, sideSeed, upnl] of [
    [0, seed.long, expected.upnlLong],
    [1, seed.short, expected.upnlShort],
  ] as const) {
    if (sideSeed.notional === 0n) {
      // Zero-notional sides (pristine or fully closed) are never served.
      assert.equal(
        portfolio.positions.find((p) => p.side === side),
        undefined,
        `${label}: side ${side} must be omitted (zero notional)`,
      );
      continue;
    }
    const view = portfolio.positions.find((p) => p.side === side);
    assert.ok(view !== undefined, `${label}: position view missing for side ${side}`);
    assert.equal(view!.notional, sideSeed.notional.toString(), `${label}: side ${side} notional`);
    assert.equal(view!.upnl, upnl.toString(), `${label}: side ${side} upnl`);
    assert.equal(
      view!.reqInitial,
      expectedMargin(sideSeed.notional, seed.initialMarginBps).toString(),
      `${label}: side ${side} reqInitial`,
    );
    assert.equal(
      view!.reqMaint,
      expectedMargin(sideSeed.notional, seed.maintenanceMarginBps).toString(),
      `${label}: side ${side} reqMaint`,
    );
  }
}

// ---------------------------------------------------------------------------
// STATE-HEALTH-MATCHES-PROGRAM-TRIGGER
// ---------------------------------------------------------------------------

test("STATE-HEALTH-MATCHES-PROGRAM-TRIGGER: the server's liquidatable flag equals the program's account-level predicate for every generated account set.", () => {
  const db = openDb(":memory:");
  try {
    for (let caseIdx = 0; caseIdx < 400; caseIdx++) {
      const rng = xorshift(0x5eed ^ (caseIdx * 7919));
      const hi = 100_000_000_000_000_000n; // < 2^57, so the entry sums stay realistic
      const initialMarginBps = 10 + pick(rng, 9_991);
      const deposited = bigInRange(rng, 0n, 1_000_000_000_000n);
      const longOpen = pick(rng, 100) >= 15;
      const shortOpen = pick(rng, 100) >= 15;
      const seed: PortfolioSeed = {
        deposited,
        reserved: bigInRange(rng, 0n, 10_000_000n),
        claimable: bigInRange(rng, 0n, 10_000_000n),
        long: longOpen
          ? {
              notional: bigInRange(rng, 1n, 1_000_000_000n),
              entryN: bigInRange(rng, 1n, hi),
              entryD: bigInRange(rng, 1n, hi),
            }
          : { notional: 0n, entryN: 0n, entryD: 0n },
        short: shortOpen
          ? {
              notional: bigInRange(rng, 1n, 1_000_000_000n),
              entryN: bigInRange(rng, 1n, hi),
              entryD: bigInRange(rng, 1n, hi),
            }
          : { notional: 0n, entryN: 0n, entryD: 0n },
        indexN: bigInRange(rng, 1n, hi),
        indexD: bigInRange(rng, 1n, hi),
        initialMarginBps,
        maintenanceMarginBps: 1 + pick(rng, initialMarginBps), // maintenance <= initial
      };

      seedPortfolio(db, seed);
      const portfolio = computePortfolio(db, WALLET, MARKET);
      assertPortfolio(portfolio, seed, `state case ${caseIdx}`);
    }
  } finally {
    db.close();
  }
});

test("STATE-HEALTH-MATCHES-PROGRAM-TRIGGER: the server's liquidatable flag equals the program's account-level predicate for every generated account set. equity == requirementMaint is healthy; one microunit below is liquidatable.", () => {
  const db = openDb(":memory:");
  try {
    const base: Omit<PortfolioSeed, "deposited"> = {
      reserved: 10_000n,
      claimable: 7n,
      long: { notional: 1_000_000n, entryN: 1_000_000n, entryD: 1_000_000n },
      short: { notional: 0n, entryN: 0n, entryD: 0n },
      indexN: 1_000_000n, // entry == index ⇒ upnl exactly 0
      indexD: 1_000_000n,
      initialMarginBps: 1_000,
      maintenanceMarginBps: 500,
    };
    // m(1_000_000, 500) = 50_000 ; m(1_000_000, 1_000) = 100_000

    const atBoundary: PortfolioSeed = { ...base, deposited: 50_000n };
    seedPortfolio(db, atBoundary);
    const p1 = computePortfolio(db, WALLET, MARKET);
    assert.equal(p1.equity, "50000", "equity = deposited when upnl is 0");
    assert.equal(p1.requirementInitial, "100000", "initial requirement uses initial_bps");
    assert.equal(p1.requirementMaint, "50000", "maintenance requirement uses maintenance_bps");
    assert.equal(p1.free, "40000", "free = deposited - reserved");
    assert.equal(p1.claimable, "7", "claimable passes through");
    assert.equal(p1.health, "healthy", "equity == requirementMaint must be healthy (strict <)");

    const belowBoundary: PortfolioSeed = { ...base, deposited: 49_999n };
    seedPortfolio(db, belowBoundary);
    const p2 = computePortfolio(db, WALLET, MARKET);
    assert.equal(p2.equity, "49999");
    assert.equal(p2.health, "liquidatable", "one microunit below the maintenance requirement must liquidate");

    // A deposit moves equity one-for-one and flips the account healthy.
    const toppedUp: PortfolioSeed = { ...base, deposited: 2_000_000n };
    seedPortfolio(db, toppedUp);
    const p3 = computePortfolio(db, WALLET, MARKET);
    assert.equal(p3.equity, "2000000", "deposits raise equity one-for-one (REQ-A2-4 consequence)");
    assert.equal(p3.health, "healthy");
  } finally {
    db.close();
  }
});

test("STATE-HEALTH-MATCHES-PROGRAM-TRIGGER: the server's liquidatable flag equals the program's account-level predicate for every generated account set. both sides sum without netting; zero exposure is never liquidatable.", () => {
  const db = openDb(":memory:");
  try {
    // Equal-and-opposite sides do NOT offset: the requirement is the sum.
    const bothSides: PortfolioSeed = {
      deposited: 75_000n,
      reserved: 0n,
      claimable: 0n,
      long: { notional: 1_000_000n, entryN: 1_000_000n, entryD: 1_000_000n },
      short: { notional: 1_000_000n, entryN: 1_000_000n, entryD: 1_000_000n },
      indexN: 1_000_000n,
      indexD: 1_000_000n,
      initialMarginBps: 1_000,
      maintenanceMarginBps: 500,
    };
    seedPortfolio(db, bothSides);
    const p1 = computePortfolio(db, WALLET, MARKET);
    assert.equal(p1.requirementMaint, "100000", "m(1e6,500) + m(1e6,500) — no netting");
    assert.equal(p1.requirementInitial, "200000", "m(1e6,1000) + m(1e6,1000)");
    assert.equal(p1.equity, "75000");
    assert.equal(p1.health, "liquidatable", "75_000 < 100_000 total maintenance");

    // Zero exposure ⇒ healthy, zero requirements, even with an extreme index.
    const flat: PortfolioSeed = {
      deposited: 0n,
      reserved: 0n,
      claimable: 0n,
      long: { notional: 0n, entryN: 0n, entryD: 0n },
      short: { notional: 0n, entryN: 0n, entryD: 0n },
      indexN: 2_000_000n,
      indexD: 1_000_000n,
      initialMarginBps: 1_000,
      maintenanceMarginBps: 500,
    };
    seedPortfolio(db, flat);
    const p2 = computePortfolio(db, WALLET, MARKET);
    assert.equal(p2.equity, "0", "pristine sides contribute zero upnl");
    assert.equal(p2.requirementInitial, "0");
    assert.equal(p2.requirementMaint, "0");
    assert.equal(p2.health, "healthy", "zero exposure ⇒ never liquidatable");
  } finally {
    db.close();
  }
});

test("STATE-HEALTH-MATCHES-PROGRAM-TRIGGER: the server's liquidatable flag equals the program's account-level predicate for every generated account set. signed upnl (long negative, short positive) drives equity and health.", () => {
  const db = openDb(":memory:");
  try {
    // Index halves (1e12/1e12 → 1e12/2e12) ⇒ change = -APY_SCALE/2.
    // A long loses notional/2; a short gains notional/2 (exact opposites).
    const downside = { indexN: 1_000_000_000_000n, indexD: 2_000_000_000_000n };

    const longOnly: PortfolioSeed = {
      deposited: 140_000n,
      reserved: 0n,
      claimable: 0n,
      long: {
        notional: 3_000_000n,
        entryN: 1_000_000_000_000n,
        entryD: 1_000_000_000_000n,
      },
      short: { notional: 0n, entryN: 0n, entryD: 0n },
      indexN: downside.indexN,
      indexD: downside.indexD,
      initialMarginBps: 1_000,
      maintenanceMarginBps: 500,
    };
    seedPortfolio(db, longOnly);
    const p1 = computePortfolio(db, WALLET, MARKET);
    assert.equal(p1.equity, "-1360000", "negative upnl must yield a signed equity (140_000 - 1_500_000)");
    assert.equal(p1.requirementMaint, "150000");
    assert.equal(p1.health, "liquidatable", "equity < total maintenance ⇒ liquidatable");
    assertPortfolio(p1, longOnly, "long downside");

    const shortOnly: PortfolioSeed = {
      ...longOnly,
      deposited: 0n,
      long: { notional: 0n, entryN: 0n, entryD: 0n },
      short: {
        notional: 3_000_000n,
        entryN: 1_000_000_000_000n,
        entryD: 1_000_000_000_000n,
      },
    };
    seedPortfolio(db, shortOnly);
    const p2 = computePortfolio(db, WALLET, MARKET);
    assert.equal(p2.equity, "1500000", "the short side gains exactly what the long loses");
    assert.equal(p2.health, "healthy", "1_500_000 >= 150_000 maintenance");
    assertPortfolio(p2, shortOnly, "short upside");

    const view = p2.positions.find((p) => p.side === 1);
    assert.ok(view !== undefined, "short side view present");
    assert.equal(view!.upnl, "1500000", "side-1 upnl carries the positive sign");
  } finally {
    db.close();
  }
});
