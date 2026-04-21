"use client";

import Decimal from "decimal.js";
import { formatUsd, toDecimal } from "@/lib/money";

// Intentionally NOT using recharts or any chart library — a horizontal bar is
// enough for "top N models by cost" and saves a ~90 KB dependency. The full
// stacked-area treatment is deferred; "or similar" in the plan permits a
// simpler representation.

const MAX_ROWS = 10;

interface ByModelRow {
  model: string;
  costUsd: string;
}

interface Props {
  byModel: ByModelRow[];
}

export function UsageChart({ byModel }: Props) {
  const rows = byModel.slice(0, MAX_ROWS);

  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No model activity in this range.
      </div>
    );
  }

  // Use Decimal for the max so we never coerce a $1B+ total to a lossy
  // JS number. `.gt(0)` guards against all-zero cost windows where every
  // bar would otherwise divide by zero.
  const max = rows.reduce<Decimal>(
    (acc, r) => Decimal.max(acc, toDecimal(r.costUsd)),
    new Decimal(0),
  );

  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const cost = toDecimal(r.costUsd);
        const pct = max.gt(0)
          ? cost.div(max).mul(100).toFixed(2)
          : "0.00";
        return (
          <div key={r.model} className="flex items-center gap-3 text-xs">
            <div className="w-40 truncate font-mono text-foreground">
              {r.model}
            </div>
            <div className="relative h-5 flex-1 overflow-hidden rounded-md bg-muted/40">
              <div
                className="h-full rounded-md bg-primary/25"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="w-24 text-right font-mono tabular-nums text-muted-foreground">
              {formatUsd(r.costUsd)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
