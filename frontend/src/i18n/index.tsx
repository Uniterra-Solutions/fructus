//! Bilingual dictionaries (en / zh-Hant), locale resolution + context (REQ-F-1).
//!
//! The two dictionaries share one key set by construction: `EN_DICTIONARY` is
//! the source of truth, `ZH_HANT_DICTIONARY` is typed as a full translation of
//! it, so a missing/extra key is a compile error as well as a test failure.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { StorageLike } from "../wallet/demoWallet.js";

export type Locale = "en" | "zh-Hant";

export const LOCALES: Locale[] = ["en", "zh-Hant"];
export const LOCALE_STORAGE = "fructus.locale";

const EN_DICTIONARY = {
  "brand.name": "Fructus",
  "gate.bindToTrade": "Bind wallet to start trading",
  "market.mark": "Mark",
  "market.index": "Index",
  "market.funding": "Funding",
  "wallet.connect": "Connect Wallet",
  "wallet.login": "Sign In",
  "wallet.bind": "Bind Operator",
  "wallet.disconnect": "Disconnect",
  "book.title": "Order Book",
  "book.price": "Price",
  "book.size": "Size",
  "book.empty": "No liquidity",
  "form.title": "New Order",
  "form.sideLong": "Long",
  "form.sideShort": "Short",
  "form.typeMarket": "Market",
  "form.typeLimit": "Limit",
  "form.size": "Size",
  "form.price": "Price",
  "form.submit": "Submit",
  "positions.title": "Positions",
  "positions.long": "Long",
  "positions.short": "Short",
  "positions.close": "Close",
  "positions.confirm": "Confirm",
  "positions.empty": "No open positions",
  "account.title": "Account",
  "account.health": "Health",
  "account.healthy": "Healthy",
  "account.liquidatable": "Liquidatable",
  "account.deposited": "Deposited",
  "account.free": "Free",
  "account.equity": "Equity",
  "account.deposit": "Deposit",
  "account.withdraw": "Withdraw",
  "account.faucet": "Faucet",
  "account.bind": "Bind Wallet",
  "account.operator": "Operator",
  "account.unbound": "Not bound",
  "tape.title": "Trades",
  "tape.empty": "No trades yet",
  "chart.title": "Chart",
};

export type TranslationKey = keyof typeof EN_DICTIONARY;

/** Full translation of `EN_DICTIONARY` (the Record type pins the identical key set). */
const ZH_HANT_DICTIONARY: Record<TranslationKey, string> = {
  "brand.name": "息穰",
  "gate.bindToTrade": "綁定錢包開始交易",
  "market.mark": "標記價",
  "market.index": "指數價",
  "market.funding": "資金費率",
  "wallet.connect": "連接錢包",
  "wallet.login": "簽名登入",
  "wallet.bind": "綁定操作員",
  "wallet.disconnect": "斷開連接",
  "book.title": "訂單簿",
  "book.price": "價格",
  "book.size": "數量",
  "book.empty": "暫無流動性",
  "form.title": "新訂單",
  "form.sideLong": "做多",
  "form.sideShort": "做空",
  "form.typeMarket": "市價",
  "form.typeLimit": "限價",
  "form.size": "數量",
  "form.price": "價格",
  "form.submit": "下單",
  "positions.title": "持倉",
  "positions.long": "多頭",
  "positions.short": "空頭",
  "positions.close": "平倉",
  "positions.confirm": "確認",
  "positions.empty": "暫無持倉",
  "account.title": "帳戶",
  "account.health": "健康度",
  "account.healthy": "健康",
  "account.liquidatable": "可清算",
  "account.deposited": "已存入",
  "account.free": "可用保證金",
  "account.equity": "帳戶權益",
  "account.deposit": "存入",
  "account.withdraw": "提取",
  "account.faucet": "領取測試幣",
  "account.bind": "綁定錢包",
  "account.operator": "操作員",
  "account.unbound": "未綁定",
  "tape.title": "成交記錄",
  "tape.empty": "暫無成交",
  "chart.title": "K 線圖",
};

export const DICTIONARIES: Record<Locale, Record<string, string>> = {
  en: EN_DICTIONARY,
  "zh-Hant": ZH_HANT_DICTIONARY,
};

/** Dictionary lookup for one locale; a missing key falls back to the key itself. */
export function translate(locale: Locale, key: string): string {
  const value = DICTIONARIES[locale][key];
  return value !== undefined && value.length > 0 ? value : key;
}

/** Stored value wins when it is a known locale; otherwise `zh*` navigators get zh-Hant, everything else en. */
export function resolveLocale(stored: string | null, navigatorLanguage: string): Locale {
  if (stored === "en" || stored === "zh-Hant") return stored;
  return navigatorLanguage.startsWith("zh") ? "zh-Hant" : "en";
}

export interface LocaleContextValue {
  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: string): string;
}

export const LocaleContext = createContext<LocaleContextValue>({
  locale: "en",
  setLocale: () => undefined,
  t: (key) => translate("en", key),
});

function readNavigatorLanguage(): string {
  return typeof navigator !== "undefined" && typeof navigator.language === "string" ? navigator.language : "";
}

/** window.localStorage when reachable, else an in-memory store (SSR / locked storage). */
function fallbackStorage(): StorageLike {
  if (typeof window !== "undefined") {
    try {
      if (window.localStorage) return window.localStorage;
    } catch {
      /* storage access denied — fall through to memory */
    }
  }
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

export interface LocaleProviderProps {
  children: ReactNode;
  /** Injectable storage (tests / SSR); defaults to window.localStorage. */
  storage?: StorageLike;
}

export function LocaleProvider({ children, storage }: LocaleProviderProps) {
  const [store] = useState<StorageLike>(() => storage ?? fallbackStorage());
  const [locale, setLocaleState] = useState<Locale>(() =>
    resolveLocale(store.getItem(LOCALE_STORAGE), readNavigatorLanguage()),
  );

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      store.setItem(LOCALE_STORAGE, next);
    },
    [store],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t: (key: string) => translate(locale, key) }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

/** en ↔ zh-Hant toggle; persists the choice through the provider's storage. */
export function LocaleToggle() {
  const { locale, setLocale } = useLocale();
  return (
    <button
      type="button"
      data-testid="locale-toggle"
      className="rounded border border-line px-2 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
      onClick={() => setLocale(locale === "en" ? "zh-Hant" : "en")}
    >
      {locale === "en" ? "繁中" : "EN"}
    </button>
  );
}
