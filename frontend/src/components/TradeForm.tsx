//! Open-position form (Long/Short, Market/Limit) — REQ-F-5.

import { useEffect, useState } from "react";
import type { PlaceOrderActionRequest } from "fructus-sdk/src/api.js";
import { formatAmount, parseAmount } from "../lib/amount.js";
import { useLocale } from "../i18n/index.js";

export interface TradeFormProps {
  /** True only when the wallet is NOT authed+bound (REQ-F-2 gate). */
  disabled: boolean;
  onSubmit(request: PlaceOrderActionRequest): void;
  /** Level-click prefill (raw price + side); applied whenever a new object arrives. */
  prefill?: { price: string; side: 0 | 1 } | null;
}

export function TradeForm({ disabled, onSubmit, prefill }: TradeFormProps) {
  const { t } = useLocale();
  const [side, setSide] = useState<0 | 1>(0);
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [sizeText, setSizeText] = useState("");
  const [priceText, setPriceText] = useState("");

  useEffect(() => {
    if (prefill === null || prefill === undefined) return;
    setSide(prefill.side);
    setKind("limit");
    setPriceText(formatAmount(prefill.price));
  }, [prefill]);

  const sizeRaw = parseAmount(sizeText);
  const priceRaw = parseAmount(priceText);
  const sizeValid = sizeRaw !== null && BigInt(sizeRaw) > 0n;
  const priceValid = priceRaw !== null && BigInt(priceRaw) > 0n;
  const valid = sizeValid && (kind === "market" || priceValid);
  const canSubmit = !disabled && valid;

  const submit = (): void => {
    if (!canSubmit || sizeRaw === null) return;
    if (kind === "market") {
      onSubmit({ kind: "market", side, size: sizeRaw });
      return;
    }
    if (priceRaw !== null) {
      onSubmit({ kind: "limit", side, size: sizeRaw, price: priceRaw });
    }
  };

  const tabClass = (active: boolean): string =>
    `flex-1 rounded border px-2 py-1 text-xs transition-colors ${
      active ? "border-accent bg-panel2 text-accent" : "border-line text-muted hover:text-ink"
    }`;
  const inputClass =
    "rounded border border-line bg-panel2 px-2 py-1 font-mono text-sm text-ink outline-none transition-colors focus:border-accent";

  return (
    <section data-testid="trade-form" className="flex min-w-0 flex-col gap-2 rounded border border-line bg-panel p-3">
      <h2 className="text-xs uppercase tracking-wider text-muted">{t("form.title")}</h2>
      <div className="flex gap-1">
        <button
          type="button"
          data-testid="side-long"
          aria-pressed={side === 0}
          className={tabClass(side === 0)}
          onClick={() => setSide(0)}
        >
          {t("form.sideLong")}
        </button>
        <button
          type="button"
          data-testid="side-short"
          aria-pressed={side === 1}
          className={tabClass(side === 1)}
          onClick={() => setSide(1)}
        >
          {t("form.sideShort")}
        </button>
      </div>
      <div className="flex gap-1">
        <button
          type="button"
          data-testid="type-market"
          aria-pressed={kind === "market"}
          className={tabClass(kind === "market")}
          onClick={() => setKind("market")}
        >
          {t("form.typeMarket")}
        </button>
        <button
          type="button"
          data-testid="type-limit"
          aria-pressed={kind === "limit"}
          className={tabClass(kind === "limit")}
          onClick={() => setKind("limit")}
        >
          {t("form.typeLimit")}
        </button>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted">
        {t("form.size")}
        <input
          data-testid="size-input"
          value={sizeText}
          inputMode="decimal"
          placeholder="0.0"
          className={inputClass}
          onChange={(event) => setSizeText(event.target.value)}
        />
      </label>
      {kind === "limit" ? (
        <label className="flex flex-col gap-1 text-xs text-muted">
          {t("form.price")}
          <input
            data-testid="price-input"
            value={priceText}
            inputMode="decimal"
            placeholder="0.0"
            className={inputClass}
            onChange={(event) => setPriceText(event.target.value)}
          />
        </label>
      ) : null}
      <button
        type="button"
        data-testid="submit-order"
        disabled={!canSubmit}
        className={`rounded border px-3 py-1.5 text-sm transition-colors ${
          canSubmit ? "border-accent text-accent hover:bg-panel2" : "border-line text-muted opacity-60"
        }`}
        onClick={submit}
      >
        {t("form.submit")}
      </button>
    </section>
  );
}
