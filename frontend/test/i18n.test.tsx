//! RED acceptance tests for product-v3 REQ-F-1 (app shell, theme, i18n).
//! Test titles are the ACCEPTANCE.md propositions, verbatim.
//!
//! RED on today's tree: the zh-Hant dictionary is missing keys, `resolveLocale`
//! always answers "en", and `Shell` renders null — every assertion below fails
//! behaviourally (empty/placeholder output vs the pinned values), never on a
//! compile/import error.

import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  DICTIONARIES,
  LOCALES,
  LOCALE_STORAGE,
  LocaleProvider,
  resolveLocale,
} from "../src/i18n/index.js";
import { Shell } from "../src/components/Shell.js";
import type { ShellActions } from "../src/components/Shell.js";
import type { AuthState } from "../src/state/auth.js";

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

/** Map-backed StorageLike (self-contained: test files share no helpers). */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string): string | null => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
  };
}

it("I18N-DICTIONARIES-IDENTICAL-KEYS: both locale dictionaries expose exactly the same non-empty key set", () => {
  // Object literals cannot hold duplicate keys, so comparing the sorted key
  // lists for set-equality is sufficient (no duplicates to worry about).
  const enKeys = Object.keys(DICTIONARIES.en).sort();
  const zhKeys = Object.keys(DICTIONARIES["zh-Hant"]).sort();
  const union = Array.from(new Set([...enKeys, ...zhKeys])).sort();

  expect(Object.keys(DICTIONARIES).sort()).toEqual([...LOCALES].sort());

  const keySetSummary = {
    extraInEn: enKeys.filter((key) => !union.includes(key)),
    extraInZh: zhKeys.filter((key) => !union.includes(key)),
    missingInZh: union.filter((key) => !zhKeys.includes(key)),
    missingInEn: union.filter((key) => !enKeys.includes(key)),
    sameCount: enKeys.length === zhKeys.length,
  };
  expect(keySetSummary).toEqual({
    extraInEn: [],
    extraInZh: [],
    missingInZh: [],
    missingInEn: [],
    sameCount: true,
  });
  expect(zhKeys).toEqual(enKeys);

  const emptyOrNonStringKeys = [
    ...Object.entries(DICTIONARIES.en),
    ...Object.entries(DICTIONARIES["zh-Hant"]),
  ]
    .filter(([, value]) => typeof value !== "string" || value.trim().length === 0)
    .map(([key]) => key);
  expect(emptyOrNonStringKeys).toEqual([]);
});

it("LOCALE-RESOLUTION: a stored locale wins; otherwise navigator.language zh* → zh-Hant; anything else → en", () => {
  const cases: Array<[stored: string | null, navigatorLanguage: string, expected: "en" | "zh-Hant"]> = [
    [null, "zh-TW", "zh-Hant"],
    [null, "zh-CN", "zh-Hant"],
    [null, "zh", "zh-Hant"],
    [null, "en-US", "en"],
    [null, "fr", "en"],
    [null, "", "en"],
    ["en", "zh-TW", "en"],
    ["zh-Hant", "en-US", "zh-Hant"],
    ["zh-Hant", "zh-TW", "zh-Hant"],
    ["garbage", "zh-CN", "zh-Hant"],
    ["garbage", "en", "en"],
    ["garbage", "", "en"],
  ];

  const mismatches = cases
    .map(([stored, navigatorLanguage, expected]) => ({
      stored,
      navigatorLanguage,
      expected,
      got: resolveLocale(stored, navigatorLanguage),
    }))
    .filter((row) => row.got !== row.expected);
  expect(mismatches).toEqual([]);
});

it(`SHELL-RENDERS-PANELS: the shell renders its seven panels, sets data-theme="dark", and the locale toggle swaps a known label's language`, () => {
  const storage = memoryStorage();
  storage.setItem(LOCALE_STORAGE, "en");

  const authConnected: AuthState = { phase: "connected", wallet: "W", token: null, operator: null };
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

  render(
    <LocaleProvider storage={storage}>
      <Shell
        auth={authConnected}
        market={null}
        book={null}
        candles={[]}
        trades={[]}
        portfolio={null}
        interval="1m"
        status={null}
        actions={allNoopActions}
      />
    </LocaleProvider>,
  );

  // Boot side effect: the shell pins the dark theme on <html>.
  expect(document.documentElement.dataset.theme).toBe("dark");

  // The seven landmark panels, by the pinned data-testid contract.
  const panelIds = [
    "top-bar",
    "chart-panel",
    "book-panel",
    "trade-form",
    "positions-panel",
    "account-panel",
    "trades-tape",
  ];
  const missingPanels = panelIds.filter((id) => document.querySelector(`[data-testid="${id}"]`) === null);
  expect(missingPanels).toEqual([]);

  // Stored locale was "en": the bind CTA reads the English label.
  const ctaText = (): string | null =>
    document.querySelector('[data-testid="bind-cta"]')?.textContent ?? null;
  expect(ctaText()).toBe("Bind wallet to start trading");

  // The locale toggle swaps the dictionary in place.
  const toggle = document.querySelector('[data-testid="locale-toggle"]');
  expect(toggle).not.toBeNull();
  fireEvent.click(toggle as Element);
  expect(ctaText()).toBe("綁定錢包開始交易");
});
