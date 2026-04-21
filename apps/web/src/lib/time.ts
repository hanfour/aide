// Shared time helpers for relative/absolute timestamp rendering in UI.
// tRPC without a superjson transformer serializes Dates as ISO strings over
// the wire, so helpers accept `Date | string | null` and normalize.

const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

export function toDate(v: Date | string | null): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatRelative(ts: Date | string | null): string {
  const d = toDate(ts);
  if (!d) return "—";
  const diffMs = d.getTime() - Date.now();
  const absSec = Math.abs(diffMs) / 1000;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, secs] of units) {
    if (absSec >= secs || unit === "second") {
      const value = Math.round(diffMs / 1000 / secs);
      return RELATIVE_TIME_FORMAT.format(value, unit);
    }
  }
  return d.toLocaleString();
}
