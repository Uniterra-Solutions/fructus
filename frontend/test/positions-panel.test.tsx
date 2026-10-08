//! REQ-F-5 · CLOSE-BODY-AND-DEFAULT-SIZE — frontend red baseline (product-v3).
//! Pins the positions panel close flow: row per open side with formatted notional,
//! close input defaulting to the full RAW notional, exact {side, size} submission,
//! and invalid sizes keeping confirm disabled.

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PositionView, UserPortfolio } from "fructus-sdk/src/api.js";
import { PositionsPanel } from "../src/components/PositionsPanel.js";

afterEach(() => {
  cleanup();
});

function mkPortfolio(positions: PositionView[]): UserPortfolio {
  return {
    wallet: "W",
    deposited: "10000000",
    reserved: "0",
    claimable: "0",
    free: "10000000",
    equity: "10000000",
    requirementInitial: "250000",
    requirementMaint: "125000",
    health: "healthy",
    operator: null,
    positions,
  };
}

it(`CLOSE-BODY-AND-DEFAULT-SIZE: the close action defaults to the full raw notional and submits the exact {side, size}`, () => {
  const spy = vi.fn();
  render(
    <PositionsPanel
      portfolio={mkPortfolio([
        { side: 0, notional: "2500000", upnl: "123456", reqInitial: "250000", reqMaint: "125000" },
      ])}
      disabled={false}
      onClose={spy}
    />,
  );

  // One row per open side; notional rendered formatted (raw 2500000 → "2.5"), side byte carried.
  const rows = screen.queryAllByTestId("position-row");
  expect(rows.length).toBeGreaterThan(0);
  if (rows.length === 0) return;
  const row = rows[0];
  expect(row.getAttribute("data-side")).toBe("0");
  const rowText = row.textContent ?? "";
  expect(rowText).toContain("2.5");
  expect(rowText).not.toContain("2500000");

  // Open the close editor → size input defaults to the full RAW notional string.
  const closeButton = screen.queryByTestId("close-position");
  expect(closeButton).not.toBeNull();
  if (!closeButton) return;
  fireEvent.click(closeButton);

  const sizeInput = screen.queryByTestId("close-size");
  expect(sizeInput).not.toBeNull();
  if (!sizeInput) return;
  expect((sizeInput as HTMLInputElement).value).toBe("2500000");

  // Confirm with the default → exact {side 0, full size}.
  const confirm = screen.queryByTestId("close-confirm");
  expect(confirm).not.toBeNull();
  if (!confirm) return;
  fireEvent.click(confirm);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith(0, "2500000");

  // A partial size goes through exactly (editor re-opened if the confirm closed it).
  const openEditor = (): HTMLElement | null => {
    const open = screen.queryByTestId("close-size");
    if (open) return open;
    const button = screen.queryByTestId("close-position");
    if (!button) return null;
    fireEvent.click(button);
    return screen.queryByTestId("close-size");
  };

  spy.mockClear();
  const sizeInput2 = openEditor();
  expect(sizeInput2).not.toBeNull();
  if (!sizeInput2) return;
  fireEvent.change(sizeInput2, { target: { value: "1000000" } });

  const confirm2 = screen.queryByTestId("close-confirm");
  expect(confirm2).not.toBeNull();
  if (!confirm2) return;
  fireEvent.click(confirm2);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith(0, "1000000");

  // Invalid sizes keep confirm disabled.
  for (const bad of ["0", "", "abc"]) {
    const input = openEditor();
    expect(input).not.toBeNull();
    if (!input) return;
    fireEvent.change(input, { target: { value: bad } });

    const confirmBad = screen.queryByTestId("close-confirm");
    expect(confirmBad).not.toBeNull();
    if (!confirmBad) return;
    expect((confirmBad as HTMLButtonElement).disabled).toBe(true);
  }
});
