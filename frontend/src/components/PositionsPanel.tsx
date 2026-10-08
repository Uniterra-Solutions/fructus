//! Positions panel with close actions — REQ-F-5.

import { useState } from "react";
import type { UserPortfolio } from "fructus-sdk/src/api.js";
import { formatAmount } from "../lib/amount.js";
import { useLocale } from "../i18n/index.js";

export interface PositionsPanelProps {
  portfolio: UserPortfolio | null;
  disabled: boolean;
  onClose(side: 0 | 1, size: string): void;
}

/** u64 ceiling — close sizes are raw base units, validated as such. */
const U64_MAX = (1n << 64n) - 1n;

/**
 * The close editor speaks RAW base units (default = the full raw notional —
 * CLOSE-BODY-AND-DEFAULT-SIZE pins input "2500000" → body "2500000"), so it
 * validates digits-only and passes the canonical raw string through; it must
 * NOT re-scale through the human-amount parser.
 */
function rawSize(text: string): string | null {
  if (!/^\d+$/.test(text)) return null;
  const value = BigInt(text);
  if (value <= 0n || value > U64_MAX) return null;
  return value.toString();
}

export function PositionsPanel({ portfolio, disabled, onClose }: PositionsPanelProps) {
  const { t } = useLocale();
  const [closing, setClosing] = useState<{ side: 0 | 1; text: string } | null>(null);
  const positions = portfolio !== null ? portfolio.positions : [];

  const closeRaw = closing !== null ? rawSize(closing.text) : null;
  const closeValid = closeRaw !== null;

  const confirmClose = (): void => {
    if (closing === null || !closeValid || closeRaw === null) return;
    onClose(closing.side, closeRaw);
  };

  return (
    <section data-testid="positions-panel" className="flex min-w-0 flex-col gap-2 rounded border border-line bg-panel p-3">
      <h2 className="text-xs uppercase tracking-wider text-muted">{t("positions.title")}</h2>
      {positions.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted">{t("positions.empty")}</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {positions.map((position) => {
            const upnl = BigInt(position.upnl);
            const upnlPositive = upnl >= 0n;
            return (
              <li
                key={position.side}
                data-testid="position-row"
                data-side={position.side}
                className="grid grid-cols-[64px_1fr_1fr_auto] items-center gap-2 rounded border border-line bg-panel2 px-2 py-1.5 text-xs"
              >
                <span className={position.side === 0 ? "text-up" : "text-down"}>
                  {position.side === 0 ? t("positions.long") : t("positions.short")}
                </span>
                <span className="text-right text-ink">{formatAmount(position.notional)}</span>
                <span className={`text-right ${upnlPositive ? "text-up" : "text-down"}`}>
                  {upnlPositive ? "+" : ""}
                  {formatAmount(position.upnl)}
                </span>
                <button
                  type="button"
                  data-testid="close-position"
                  disabled={disabled}
                  className="rounded border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-down hover:text-down disabled:opacity-60"
                  onClick={() => setClosing({ side: position.side, text: position.notional })}
                >
                  {t("positions.close")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {closing !== null ? (
        <div className="flex items-center gap-2 rounded border border-line bg-panel2 px-2 py-2">
          <input
            data-testid="close-size"
            value={closing.text}
            inputMode="decimal"
            className="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1 font-mono text-xs text-ink outline-none focus:border-accent"
            onChange={(event) => setClosing({ side: closing.side, text: event.target.value })}
          />
          <button
            type="button"
            data-testid="close-confirm"
            disabled={disabled || !closeValid}
            className={`rounded border px-2 py-1 text-xs transition-colors ${
              !disabled && closeValid ? "border-down text-down hover:bg-panel" : "border-line text-muted opacity-60"
            }`}
            onClick={confirmClose}
          >
            {t("positions.confirm")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
