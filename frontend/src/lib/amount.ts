//! Raw <-> human amount conversion (6-dp protocol scale, BigInt only).
//! Stub — product-v3 freeze (real implementation lands in the implement phase).

/** Parse a human decimal string (at most `dp` fraction digits) into the canonical raw decimal string; `null` when invalid. */
export function parseAmount(_input: string, _dp = 6): string | null {
  return null;
}

/** Format a raw decimal string as a human decimal (up to `dp` fraction digits, trailing zeros trimmed). */
export function formatAmount(_raw: string, _dp = 6): string {
  return "";
}
