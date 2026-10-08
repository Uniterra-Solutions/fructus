//! Mark / index / funding readout (REQ-F-1).

import type { MarketView } from "fructus-sdk/src/api.js";
import { formatAmount } from "../lib/amount.js";
import { useLocale } from "../i18n/index.js";

export interface MarketStatsProps {
  market: MarketView | null;
}

export function MarketStats({ market }: MarketStatsProps) {
  const { t } = useLocale();
  const cells: Array<[label: string, value: string]> = [
    [t("market.mark"), market !== null && market.mark !== null ? formatAmount(market.mark) : "—"],
    [t("market.index"), market !== null ? formatAmount(market.index) : "—"],
    [t("market.funding"), market !== null ? formatAmount(market.fundingAccumulator) : "—"],
  ];

  return (
    <dl className="flex flex-wrap items-center gap-4 text-xs">
      {cells.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <dt className="text-muted">{label}</dt>
          <dd className="text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
