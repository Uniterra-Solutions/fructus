//! Bilingual dictionaries (en / zh-Hant), locale resolution + context.
//! Stub — product-v3 freeze.

import { createContext, useContext, type ReactNode } from "react";
import type { StorageLike } from "../wallet/demoWallet.js";

export type Locale = "en" | "zh-Hant";

export const LOCALES: Locale[] = ["en", "zh-Hant"];
export const LOCALE_STORAGE = "fructus.locale";

export const DICTIONARIES: Record<Locale, Record<string, string>> = {
  en: {
    "brand.name": "Fructus",
    "gate.bindToTrade": "Bind wallet to start trading",
    "form.submit": "Submit",
  },
  "zh-Hant": {
    "brand.name": "息穰",
  },
};

/** Stored value wins; otherwise `zh*` navigators get zh-Hant, everything else en. */
export function resolveLocale(_stored: string | null, _navigatorLanguage: string): Locale {
  return "en";
}

export function translate(_locale: Locale, key: string): string {
  return key;
}

export interface LocaleContextValue {
  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: string): string;
}

export const LocaleContext = createContext<LocaleContextValue>({
  locale: "en",
  setLocale: () => undefined,
  t: (key) => key,
});

export function LocaleProvider({ children }: { children: ReactNode; storage?: StorageLike }) {
  return <LocaleContext.Provider value={{ locale: "en", setLocale: () => undefined, t: (key) => key }}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

export function LocaleToggle() {
  return null;
}
