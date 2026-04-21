"use client";

import { Button } from "@/components/ui/button";

// Three fixed presets. A custom date range picker is out of scope for Plan 4A
// Part 9.6; presets cover the "quick analytics" use case and keep the server
// query planner in a narrow, index-friendly slice of usage_logs.
export type RangePreset = "7d" | "30d" | "90d";

const DAYS: Record<RangePreset, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const LABEL: Record<RangePreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

// Resolve a preset to concrete ISO 8601 bounds. `to` is "now" rather than
// end-of-day so a refresh during the day includes the most recent rows
// without off-by-one gaps. The server accepts z.string().datetime().
export function rangeToDates(r: RangePreset): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - DAYS[r] * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

interface Props {
  value: RangePreset;
  onChange: (v: RangePreset) => void;
}

export function TimeRangePicker({ value, onChange }: Props) {
  const presets: RangePreset[] = ["7d", "30d", "90d"];
  return (
    <div className="inline-flex gap-1 rounded-md border border-border bg-muted/20 p-1">
      {presets.map((p) => (
        <Button
          key={p}
          type="button"
          size="sm"
          variant={p === value ? "default" : "ghost"}
          onClick={() => onChange(p)}
          className="h-7 px-3 text-xs"
        >
          {LABEL[p]}
        </Button>
      ))}
    </div>
  );
}
