//! Raw <-> human amount conversion (6-dp protocol scale, BigInt only) — REQ-F-5.
//!
//! Amounts on the wire are decimal strings of raw base units (USDC micro-units);
//! every conversion below uses BigInt arithmetic only — never floats.

/** u64 ceiling: raw amounts above this are not representable on chain. */
const U64_MAX = (1n << 64n) - 1n;

/**
 * Parse a human decimal string (ASCII digits only, at most `dp` fraction digits)
 * into the canonical raw decimal string; `null` when malformed/out of range.
 *
 * Rejects: empty input, non-ASCII digits, signs, exponents, separators, >`dp`
 * fraction digits, and values above the u64 ceiling.
 */
export function parseAmount(input: string, dp = 6): string | null {
  if (!Number.isInteger(dp) || dp < 0) return null;

  const pattern = dp === 0 ? /^(\d+)$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${dp}}))?$`);
  const match = pattern.exec(input);
  if (match === null) return null;

  const whole = match[1];
  const fraction = match[2] ?? "";
  // Scale BOTH paths: an integer-only input ("100") is 100 × 10^dp raw, exactly
  // like a fractional one (the whole part shifts left by `dp` digits); the
  // pre-fix integer branch returned the unscaled whole (live counterexample:
  // parseAmount("100") === "100" — a deposit of 100 landed as 0.0001).
  const raw = BigInt(whole + fraction.padEnd(dp, "0"));
  if (raw > U64_MAX) return null;
  return raw.toString();
}

/**
 * Format a raw decimal string as a human decimal (up to `dp` fraction digits,
 * trailing zeros trimmed; the minimum representation is "0").
 */
export function formatAmount(raw: string, dp = 6): string {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return "0";
  }

  const negative = value < 0n;
  const magnitude = (negative ? -value : value).toString();
  if (dp <= 0) return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;

  const digits = magnitude.padStart(dp + 1, "0");
  const whole = digits.slice(0, digits.length - dp);
  const fraction = digits.slice(digits.length - dp).replace(/0+$/, "");
  const text = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative && text !== "0" ? `-${text}` : text;
}
