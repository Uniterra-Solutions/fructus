//! REQ-F-2 · TRADE-GATED-UNTIL-BOUND — frontend red baseline (product-v3).
//! Pins the gate contract against the stubbed Shell/TradeForm/PositionsPanel:
//! a wallet that is authed but not bound sees the bind CTA and fully disabled
//! trading controls; a confirmed bind lifts the gate.

import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PositionView, UserPortfolio } from "fructus-sdk/src/api.js";
import { Shell, tradingEnabled, type ShellActions } from "../src/components/Shell.js";
import { LocaleProvider } from "../src/i18n/index.js";
import type { AuthState } from "../src/state/auth.js";
import type { StorageLike } from "../src/wallet/demoWallet.js";

afterEach(() => {
  cleanup();
});

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

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

function mkPortfolioWithOnePosition(): UserPortfolio {
  return mkPortfolio([
    { side: 0, notional: "2500000", upnl: "123456", reqInitial: "250000", reqMaint: "125000" },
  ]);
}

const allNoopActions: ShellActions = {
  connect: () => undefined,
  disconnect: () => undefined,
  login: () => undefined,
  bind: () => undefined,
  faucet: () => undefined,
  deposit: () => undefined,
  withdraw: () => undefined,
  submitOrder: () => undefined,
  closePosition: () => undefined,
  setInterval: () => undefined,
};

const disconnected: AuthState = { phase: "disconnected", wallet: null, token: null, operator: null };
const connected: AuthState = { phase: "connected", wallet: "W", token: null, operator: null };
const authedUnbound: AuthState = { phase: "authed", wallet: "W", token: "T", operator: null };
const authedBound: AuthState = { phase: "bound", wallet: "W", token: "T", operator: "OP" };

it(`TRADE-GATED-UNTIL-BOUND: a connected but unbound wallet sees disabled trading controls plus the bind CTA, and a confirmed bind enables them`, () => {
  // (a) the pure gate: only authed AND bound trades.
  expect(tradingEnabled(authedBound)).toBe(true);
  expect(tradingEnabled(authedUnbound)).toBe(false);
  expect(tradingEnabled(connected)).toBe(false);
  expect(tradingEnabled(disconnected)).toBe(false);

  // (b) authed-but-unbound shell: bind CTA visible, trading controls disabled.
  const storage = memoryStorage();
  const view = render(
    <LocaleProvider storage={storage}>
      <Shell
        auth={authedUnbound}
        market={null}
        book={null}
        candles={[]}
        trades={[]}
        portfolio={mkPortfolioWithOnePosition()}
        interval="1m"
        status={null}
        actions={allNoopActions}
      />
    </LocaleProvider>,
  );

  const cta = screen.queryByTestId("bind-cta");
  expect(cta).not.toBeNull();
  if (!cta) return;
  expect((cta.textContent ?? "").trim()).toBe("Bind wallet to start trading");

  const submit = screen.queryByTestId("submit-order");
  expect(submit).not.toBeNull();
  if (!submit) return;
  expect((submit as HTMLButtonElement).disabled).toBe(true);

  const closes = screen.queryAllByTestId("close-position");
  expect(closes.length).toBeGreaterThan(0);
  for (const close of closes) {
    expect((close as HTMLButtonElement).disabled).toBe(true);
  }

  // (c) a confirmed bind lifts the gate.
  view.rerender(
    <LocaleProvider storage={storage}>
      <Shell
        auth={authedBound}
        market={null}
        book={null}
        candles={[]}
        trades={[]}
        portfolio={mkPortfolioWithOnePosition()}
        interval="1m"
        status={null}
        actions={allNoopActions}
      />
    </LocaleProvider>,
  );

  expect(screen.queryByTestId("bind-cta")).toBeNull();

  // The gate lift is proven on the form's own terms: with the gate open AND a valid
  // size the submit is enabled (an empty form stays validity-disabled by design —
  // the state order-form.test.tsx:59 pins; the raw-empty render cannot be enabled).
  const sizeInputBound = screen.queryByTestId("size-input");
  expect(sizeInputBound).not.toBeNull();
  if (!sizeInputBound) return;
  fireEvent.change(sizeInputBound, { target: { value: "1" } });
  const submitBound = screen.queryByTestId("submit-order");
  expect(submitBound).not.toBeNull();
  if (!submitBound) return;
  expect((submitBound as HTMLButtonElement).disabled).toBe(false);

  const closesBound = screen.queryAllByTestId("close-position");
  expect(closesBound.length).toBeGreaterThan(0);
  for (const close of closesBound) {
    expect((close as HTMLButtonElement).disabled).toBe(false);
  }
});
