//! REQ-F-7 · ACCOUNT-PANEL-ACTIONS — frontend red baseline (product-v3).
//! Pins the account panel: deposit/withdraw submit the exact raw bodies, missing
//! (or invalid) amounts keep submit disabled, and the health readout carries the
//! data-health hook (`healthy` / `liquidatable`) the alert styling binds to.

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Health, UserPortfolio } from "fructus-sdk/src/api.js";
import { AccountPanel } from "../src/components/AccountPanel.js";

afterEach(() => {
  cleanup();
});

function mkPortfolio(health: Health): UserPortfolio {
  return {
    wallet: "W",
    deposited: "10000000",
    reserved: "250000",
    claimable: "0",
    free: "9750000",
    equity: "10000000",
    requirementInitial: "250000",
    requirementMaint: "125000",
    health,
    operator: null,
    positions: [],
  };
}

it(`ACCOUNT-PANEL-ACTIONS: deposit and withdraw submit exact raw bodies; missing amounts disable submit; the liquidatable health renders its alert style`, () => {
  const onDeposit = vi.fn();
  const onWithdraw = vi.fn();
  const onFaucet = vi.fn();
  const onBind = vi.fn();

  render(
    <AccountPanel
      portfolio={mkPortfolio("healthy")}
      authed={true}
      bound={true}
      onDeposit={onDeposit}
      onWithdraw={onWithdraw}
      onFaucet={onFaucet}
      onBind={onBind}
    />,
  );

  // Health readout carries the styling hook; healthy here.
  const health = screen.queryByTestId("health");
  expect(health).not.toBeNull();
  if (!health) return;
  expect(health.getAttribute("data-health")).toBe("healthy");

  // Deposit: empty amount → disabled; "1.5" → exact raw body "1500000".
  const depositInput = screen.queryByTestId("deposit-input");
  expect(depositInput).not.toBeNull();
  if (!depositInput) return;
  const depositButton = screen.queryByTestId("deposit-submit");
  expect(depositButton).not.toBeNull();
  if (!depositButton) return;
  expect((depositButton as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(depositInput, { target: { value: "1.5" } });
  expect((depositButton as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(depositButton);
  expect(onDeposit).toHaveBeenCalledTimes(1);
  expect(onDeposit).toHaveBeenCalledWith("1500000");

  // Withdraw: empty amount → disabled; "0.25" → exact raw body "250000".
  const withdrawInput = screen.queryByTestId("withdraw-input");
  expect(withdrawInput).not.toBeNull();
  if (!withdrawInput) return;
  const withdrawButton = screen.queryByTestId("withdraw-submit");
  expect(withdrawButton).not.toBeNull();
  if (!withdrawButton) return;
  expect((withdrawButton as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(withdrawInput, { target: { value: "0.25" } });
  expect((withdrawButton as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(withdrawButton);
  expect(onWithdraw).toHaveBeenCalledTimes(1);
  expect(onWithdraw).toHaveBeenCalledWith("250000");

  // A 7-dp amount is invalid → submit stays disabled, nothing extra submitted.
  fireEvent.change(depositInput, { target: { value: "1.0000001" } });
  expect((depositButton as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(depositButton);
  expect(onDeposit).toHaveBeenCalledTimes(1);

  // Liquidatable portfolios render the alert hook.
  cleanup();
  render(
    <AccountPanel
      portfolio={mkPortfolio("liquidatable")}
      authed={true}
      bound={true}
      onDeposit={onDeposit}
      onWithdraw={onWithdraw}
      onFaucet={onFaucet}
      onBind={onBind}
    />,
  );
  const healthBad = screen.queryByTestId("health");
  expect(healthBad).not.toBeNull();
  if (!healthBad) return;
  expect(healthBad.getAttribute("data-health")).toBe("liquidatable");
});
