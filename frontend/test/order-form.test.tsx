//! REQ-F-5 · PARSE-FORMAT-EXACT + ORDER-FORM-VALIDATION-AND-BODY — frontend red baseline (product-v3).
//! Pins the BigInt-only amount conversion (6-dp protocol scale, u64 max exact,
//! no floating point) and the order form's validation + exact raw submit body.

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { formatAmount, parseAmount } from "../src/lib/amount.js";
import { TradeForm } from "../src/components/TradeForm.js";

afterEach(() => {
  cleanup();
});

it(`PARSE-FORMAT-EXACT: parseAmount("1.5") == "1500000", round-trips formatAmount(parseAmount(x)) for generated 6-dp strings, and rejects malformed/7-dp/overflowing input without floating point`, () => {
  // Accepts — exact raw decimal strings (u64 max must survive a float would mangle it).
  expect(parseAmount("1.5")).toBe("1500000");
  expect(parseAmount("0.000001")).toBe("1");
  expect(parseAmount("0")).toBe("0");
  expect(parseAmount("18446744073709.551615")).toBe("18446744073709551615");

  // Deterministic regression (live counterexample, browser walkthrough 2026-10-08):
  // the integer-only path must scale too — measured parseAmount("100") === "100"
  // (a deposit of 100 landed as 0.0001). The generated sweep skips trailing-zero
  // raws, i.e. exactly formatAmount's integer-form outputs, so pin them here.
  expect(parseAmount("100")).toBe("100000000");
  expect(parseAmount("1")).toBe("1000000");
  expect(parseAmount("100000000")).toBe("100000000000000");
  expect(parseAmount("0.5")).toBe("500000");

  // Rejects — 7 dp, empty, non-numeric, negative, exponent, bare separators, non-ASCII digits.
  const malformed = ["1.0000000", "1.1234567", "", "abc", "-1", "1e6", ".", ",", "١٢٣"];
  for (const input of malformed) {
    expect(parseAmount(input)).toBeNull();
  }

  // Formats — raw → human, trailing zeros trimmed.
  expect(formatAmount("1500000")).toBe("1.5");
  expect(formatAmount("1")).toBe("0.000001");
  expect(formatAmount("0")).toBe("0");
  expect(formatAmount("1000000000")).toBe("1000");
  expect(formatAmount("18446744073709551615")).toBe("18446744073709.551615");

  // Generated sweep (deterministic xorshift): canonical u64 raws round-trip.
  const maxU64 = (1n << 64n) - 1n;
  let state = 0x2545f4914f6cdd1dn;
  let checked = 0;
  for (let i = 0; i < 200; i += 1) {
    state ^= (state << 13n) & maxU64;
    state ^= state >> 7n;
    state ^= (state << 17n) & maxU64;
    state &= maxU64;
    const raw = state.toString();
    if (raw !== "0" && raw.endsWith("0")) continue; // canonical domain: last digit non-zero (or exactly "0")
    checked += 1;
    expect(parseAmount(formatAmount(raw))).toBe(raw);
  }
  expect(checked).toBeGreaterThan(100);
});

it(`ORDER-FORM-VALIDATION-AND-BODY: invalid forms cannot submit; a valid limit submit calls the client with the exact raw body`, () => {
  const spy = vi.fn();
  render(<TradeForm disabled={false} onSubmit={spy} />);

  // Empty size → submit disabled; market mode shows no price input.
  const submitEmpty = screen.queryByTestId("submit-order");
  expect(submitEmpty).not.toBeNull();
  if (!submitEmpty) return;
  expect((submitEmpty as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByTestId("price-input")).toBeNull();

  // Size parses exactly (1.5 → "1500000").
  const sizeInput = screen.queryByTestId("size-input");
  expect(sizeInput).not.toBeNull();
  if (!sizeInput) return;
  fireEvent.change(sizeInput, { target: { value: "1.5" } });

  // Switch to limit → price input appears; price parses exactly (1.25 → "1250000").
  const limitTab = screen.queryByTestId("type-limit");
  expect(limitTab).not.toBeNull();
  if (!limitTab) return;
  fireEvent.click(limitTab);

  const priceInput = screen.queryByTestId("price-input");
  expect(priceInput).not.toBeNull();
  if (!priceInput) return;
  fireEvent.change(priceInput, { target: { value: "1.25" } });

  // Valid limit submit → exactly one call with the raw body (side 0 long).
  const submit = screen.queryByTestId("submit-order");
  expect(submit).not.toBeNull();
  if (!submit) return;
  expect((submit as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(submit);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith({ kind: "limit", side: 0, size: "1500000", price: "1250000" });

  // Flip side → the second call carries side 1 with the same raw size/price.
  const shortTab = screen.queryByTestId("side-short");
  expect(shortTab).not.toBeNull();
  if (!shortTab) return;
  fireEvent.click(shortTab);

  const submit2 = screen.queryByTestId("submit-order");
  expect(submit2).not.toBeNull();
  if (!submit2) return;
  fireEvent.click(submit2);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(spy).toHaveBeenNthCalledWith(2, { kind: "limit", side: 1, size: "1500000", price: "1250000" });

  // 7-dp price is invalid → the form cannot submit (disabled).
  const price = screen.queryByTestId("price-input");
  expect(price).not.toBeNull();
  if (!price) return;
  fireEvent.change(price, { target: { value: "1.0000001" } });

  const submit3 = screen.queryByTestId("submit-order");
  expect(submit3).not.toBeNull();
  if (!submit3) return;
  expect((submit3 as HTMLButtonElement).disabled).toBe(true);
});
