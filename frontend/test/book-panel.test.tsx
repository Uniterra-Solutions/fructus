//! REQ-F-4 · BOOK-PANEL-RENDERS-AND-PREFILLS — frontend red baseline (product-v3).
//! Pins the order-book panel contract: formatted (raw/1e6, trailing-zero-trimmed)
//! values best-first, one-sided/empty handling, and level clicks handing the RAW
//! price + side to the form (bid → long 0, ask → short 1).

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BookView } from "fructus-sdk/src/api.js";
import { OrderBookPanel } from "../src/components/OrderBookPanel.js";

afterEach(() => {
  cleanup();
});

/** All non-empty texts inside an element (row text plus every descendant) — tolerant of cell layout, so "1" vs "0.5" stay distinguishable even without separators. */
function textsOf(el: HTMLElement): string[] {
  const texts = [(el.textContent ?? "").trim()];
  el.querySelectorAll("*").forEach((node) => {
    texts.push((node.textContent ?? "").trim());
  });
  return texts.filter((text) => text.length > 0);
}

it(`BOOK-PANEL-RENDERS-AND-PREFILLS: given a BookView the rows show formatted values best-first and a click hands the raw price to the form`, () => {
  const spy = vi.fn();
  const book: BookView = {
    bids: [
      ["1000000", "500000"],
      ["999000", "1000000"],
    ],
    asks: [["1001000", "700000"]],
  };
  render(<OrderBookPanel book={book} onPriceSelect={spy} />);

  const bids = screen.queryAllByTestId("book-bid");
  expect(bids.length).toBe(2);
  if (bids.length < 2) return;

  const asks = screen.queryAllByTestId("book-ask");
  expect(asks.length).toBe(1);
  if (asks.length < 1) return;

  // Best-first: the 1000000 bid renders formatted ("1" price, "0.5" size), never raw.
  const firstBidJoined = textsOf(bids[0]).join(" | ");
  expect(firstBidJoined).toContain("0.5");
  expect(firstBidJoined).toMatch(/(?:^|[^\d.])1(?:[^\d.]|$)/);
  const firstBidRaw = bids[0].textContent ?? "";
  expect(firstBidRaw).not.toContain("1000000");
  expect(firstBidRaw).not.toContain("500000");

  // Input order is preserved: the 999000 level is the second row (formats to "0.999").
  expect(textsOf(bids[1]).join(" | ")).toContain("0.999");

  // Ask side formats the same way.
  const firstAskJoined = textsOf(asks[0]).join(" | ");
  expect(firstAskJoined).toContain("1.001");
  expect(firstAskJoined).toContain("0.7");
  const firstAskRaw = asks[0].textContent ?? "";
  expect(firstAskRaw).not.toContain("1001000");
  expect(firstAskRaw).not.toContain("700000");

  // Click prefill: RAW price string + side (bid → 0 long, ask → 1 short).
  fireEvent.click(bids[0]);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith("1000000", 0);

  spy.mockClear();
  fireEvent.click(asks[0]);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith("1001000", 1);

  // Empty book → placeholder, no rows.
  cleanup();
  render(<OrderBookPanel book={{ bids: [], asks: [] }} onPriceSelect={spy} />);
  expect(screen.queryByTestId("book-empty")).not.toBeNull();
  expect(screen.queryAllByTestId("book-bid").length).toBe(0);
  expect(screen.queryAllByTestId("book-ask").length).toBe(0);

  // One-sided book still renders its side's rows (and only them).
  cleanup();
  render(<OrderBookPanel book={{ bids: [["1000000", "500000"]], asks: [] }} onPriceSelect={spy} />);
  expect(screen.queryAllByTestId("book-bid").length).toBe(1);
  expect(screen.queryAllByTestId("book-ask").length).toBe(0);
});
