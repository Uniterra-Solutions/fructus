//! RED acceptance test for product-v3 REQ-F-3 (portfolio delta application).
//! The `user` WS message carries SIGNED deltas: applying one onto the earlier
//! snapshot must equal the later snapshot on the 7 numeric fields, health,
//! operator and the normalised positions.
//!
//! RED on today's tree: `applyPortfolioDeltas` is a stub returning the snapshot
//! unchanged — the concrete pin below fails behaviourally, never on a
//! compile/import error.
//!
//! Deterministic xorshift64 sweep (repo house style, no PBT dependency):
//! ~200 generated (P0, P1, delta) triples; values are canonical decimal
//! strings, many far beyond 2^53, with signed deltas, closed sides, omitted
//! sides and zero deltas.

import { expect, it } from "vitest";
import { applyPortfolioDeltas } from "../src/state/portfolio.js";
import type { Health, PositionView, UserPortfolio } from "fructus-sdk/src/api.js";

// --- deterministic xorshift64 (repo house style) ----------------------------

const MASK64 = (1n << 64n) - 1n;
let seed = 0x9e3779b97f4a7c15n;
function next64(): bigint {
  seed ^= (seed << 13n) & MASK64;
  seed ^= seed >> 7n;
  seed ^= (seed << 17n) & MASK64;
  seed &= MASK64;
  return seed;
}
const below = (bound: bigint): bigint => ((next64() << 64n) | next64()) % bound;
const int = (n: number): number => Number(below(BigInt(n)));
const bool = (percentTrue = 50): boolean => int(100) < percentTrue;

/** Canonical amounts: small edge values sometimes, otherwise ≥ 2^54 (> 2^53). */
function randAmount(): bigint {
  if (bool(15)) return BigInt(int(1_000));
  return below(1n << BigInt(54 + int(37))) + 1_000_000n;
}

function randSigned(magnitudeBits: number): bigint {
  const magnitude = below(1n << BigInt(magnitudeBits));
  return bool() ? magnitude : -magnitude;
}

/** Signed deltas, zero included (a zero delta is part of the domain). */
function randDelta(): bigint {
  if (bool(25)) return 0n;
  return randSigned(70);
}

// --- fixtures ---------------------------------------------------------------

const NUM_KEYS = [
  "deposited",
  "reserved",
  "claimable",
  "free",
  "equity",
  "requirementInitial",
  "requirementMaint",
] as const;
const POS_KEYS = ["notional", "upnl", "reqInitial", "reqMaint"] as const;
const HEALTHS: Health[] = ["healthy", "liquidatable"];

interface RawNums {
  deposited: bigint;
  reserved: bigint;
  claimable: bigint;
  free: bigint;
  equity: bigint;
  requirementInitial: bigint;
  requirementMaint: bigint;
}
interface RawPos {
  side: 0 | 1;
  notional: bigint;
  upnl: bigint;
  reqInitial: bigint;
  reqMaint: bigint;
}

const ZERO_NUMS: RawNums = {
  deposited: 0n,
  reserved: 0n,
  claimable: 0n,
  free: 0n,
  equity: 0n,
  requirementInitial: 0n,
  requirementMaint: 0n,
};

function mkPortfolio(
  numbers: RawNums,
  positions: RawPos[],
  health: Health,
  operator: { address: string } | null,
): UserPortfolio {
  return {
    wallet: "WALLET11111111111111111111111111111111",
    deposited: numbers.deposited.toString(),
    reserved: numbers.reserved.toString(),
    claimable: numbers.claimable.toString(),
    free: numbers.free.toString(),
    equity: numbers.equity.toString(),
    requirementInitial: numbers.requirementInitial.toString(),
    requirementMaint: numbers.requirementMaint.toString(),
    health,
    operator,
    positions: positions.map((p) => ({
      side: p.side,
      notional: p.notional.toString(),
      upnl: p.upnl.toString(),
      reqInitial: p.reqInitial.toString(),
      reqMaint: p.reqMaint.toString(),
    })),
  };
}

/** Normalisation: sort by side; drop sides whose four contribution fields are all zero. */
function normalizePositions(positions: PositionView[]): PositionView[] {
  return positions
    .filter(
      (p) =>
        !(
          BigInt(p.notional) === 0n &&
          BigInt(p.upnl) === 0n &&
          BigInt(p.reqInitial) === 0n &&
          BigInt(p.reqMaint) === 0n
        ),
    )
    .slice()
    .sort((a, b) => a.side - b.side)
    .map((p) => ({
      side: p.side,
      notional: p.notional,
      upnl: p.upnl,
      reqInitial: p.reqInitial,
      reqMaint: p.reqMaint,
    }));
}

function pickNumbers(p: UserPortfolio) {
  return {
    deposited: p.deposited,
    reserved: p.reserved,
    claimable: p.claimable,
    free: p.free,
    equity: p.equity,
    requirementInitial: p.requirementInitial,
    requirementMaint: p.requirementMaint,
  };
}

/** base + delta, clamped at zero for the non-negative fields (delta adjusted). */
function clampNonNegative(base: bigint, delta: bigint): { value: bigint; delta: bigint } {
  const value = base + delta;
  if (value >= 0n) return { value, delta };
  return { value: 0n, delta: -base };
}

it("PORTFOLIO-DELTA-APPLIES-TO-SNAPSHOT: for generated portfolio pairs, applying the delta messages onto the earlier snapshot equals the later snapshot on every field (sides normalised)", () => {
  // Concrete pin: a positive delta adds exactly.
  const pinSnapshot = mkPortfolio({ ...ZERO_NUMS, deposited: 1_000_000n }, [], "healthy", null);
  const pinDelta = mkPortfolio({ ...ZERO_NUMS, deposited: 25_000_000n }, [], "healthy", null);
  expect(applyPortfolioDeltas(pinSnapshot, pinDelta).deposited).toBe("26000000");

  for (let iteration = 0; iteration < 200; iteration++) {
    const movedSide = (iteration % 2) as 0 | 1;
    const forceCloseSide0 = iteration % 25 === 0; // side 0 fully closed in P1
    const zeroDeltaSide: 0 | 1 | null = (iteration + 1) % 10 === 0 ? ((1 - movedSide) as 0 | 1) : null;

    const p0Positions: RawPos[] = [];
    const p1Positions: RawPos[] = [];
    const deltaPositions: RawPos[] = [];

    for (const side of [0, 1] as const) {
      const mustClose = forceCloseSide0 && side === 0;
      const presentInP0 = mustClose || bool(65);
      const base: RawPos = presentInP0
        ? {
            side,
            notional: randAmount() + 1n,
            upnl: randSigned(70),
            reqInitial: randAmount() + 1n,
            reqMaint: randAmount() + 1n,
          }
        : { side, notional: 0n, upnl: 0n, reqInitial: 0n, reqMaint: 0n };
      if (presentInP0) p0Positions.push({ ...base });

      let deltas: RawPos;
      if (mustClose) {
        // A full close: the delta row carries the negatives, P1 omits the side.
        deltas = {
          side,
          notional: -base.notional,
          upnl: -base.upnl,
          reqInitial: -base.reqInitial,
          reqMaint: -base.reqMaint,
        };
      } else if (zeroDeltaSide === side) {
        deltas = { side, notional: 0n, upnl: 0n, reqInitial: 0n, reqMaint: 0n };
      } else {
        deltas = { side, notional: randDelta(), upnl: randDelta(), reqInitial: randDelta(), reqMaint: randDelta() };
        if (side === movedSide) {
          deltas.notional = below(1n << 70n) + 1n; // guarantee ≥ 1 moved side per generated case
        }
      }

      // notional / reqInitial / reqMaint stay non-negative; upnl is signed.
      const notional = clampNonNegative(base.notional, deltas.notional);
      const reqInitial = clampNonNegative(base.reqInitial, deltas.reqInitial);
      const reqMaint = clampNonNegative(base.reqMaint, deltas.reqMaint);
      deltas = {
        ...deltas,
        side,
        notional: notional.delta,
        reqInitial: reqInitial.delta,
        reqMaint: reqMaint.delta,
      };
      const p1: RawPos = {
        side,
        notional: notional.value,
        upnl: base.upnl + deltas.upnl,
        reqInitial: reqInitial.value,
        reqMaint: reqMaint.value,
      };

      if (POS_KEYS.some((key) => deltas[key] !== 0n)) deltaPositions.push({ ...deltas });
      if (POS_KEYS.some((key) => p1[key] !== 0n)) p1Positions.push({ ...p1 });
    }

    const p0Nums: RawNums = {
      deposited: randAmount(),
      reserved: randAmount(),
      claimable: randAmount(),
      free: randAmount(),
      equity: randSigned(80),
      requirementInitial: randAmount(),
      requirementMaint: randAmount(),
    };
    const deltaNums: RawNums = { ...ZERO_NUMS };
    const p1Nums: RawNums = { ...ZERO_NUMS };
    for (const key of NUM_KEYS) {
      const base = p0Nums[key];
      const rawDelta =
        key === "deposited" ? (bool() ? 1n : -1n) * (below(1n << 70n) + 1n) : randDelta();
      const clamped =
        key === "equity" ? { value: base + rawDelta, delta: rawDelta } : clampNonNegative(base, rawDelta);
      p1Nums[key] = clamped.value;
      deltaNums[key] = clamped.delta;
    }

    const health = HEALTHS[int(2)];
    const operator = bool() ? { address: `OPERATOR-${int(1_000_000)}` } : null;

    const snapshot = mkPortfolio(p0Nums, p0Positions, HEALTHS[int(2)], bool() ? { address: "P0-OP" } : null);
    const later = mkPortfolio(p1Nums, p1Positions, health, operator);
    const deltaRow = mkPortfolio(deltaNums, deltaPositions, health, operator);

    const applied = applyPortfolioDeltas(snapshot, deltaRow);

    expect(pickNumbers(applied)).toEqual(pickNumbers(later));
    expect(applied.health).toBe(later.health);
    expect(applied.operator).toEqual(later.operator);
    expect(normalizePositions(applied.positions)).toEqual(normalizePositions(later.positions));
  }
});
