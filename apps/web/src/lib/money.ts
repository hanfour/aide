// Decimal helpers for cost/money values.
//
// The API returns numeric(20,10) cost columns as strings (see usage router) to
// preserve full precision. `Number(value)` silently truncates past ~15
// significant digits — for a gateway that aggregates millions of requests
// that's a real correctness hazard. Always route cost arithmetic through
// Decimal.js here, and only convert to a formatted string at the render edge.

import Decimal from "decimal.js";

export function toDecimal(v: string | number | null | undefined): Decimal {
  if (v == null) return new Decimal(0);
  return new Decimal(v);
}

export function formatUsd(
  v: string | number | null | undefined,
  fractionDigits = 2,
): string {
  const d = toDecimal(v);
  // Format the integer part with thousands separators — Intl.NumberFormat
  // would coerce to number and lose precision, so we stringify manually.
  const fixed = d.toFixed(fractionDigits);
  const dot = fixed.indexOf(".");
  const intPart = dot >= 0 ? fixed.slice(0, dot) : fixed;
  const fracPart = dot >= 0 ? fixed.slice(dot + 1) : "";
  const sign = intPart.startsWith("-") ? "-" : "";
  const digits = sign ? intPart.slice(1) : intPart;
  const withSep = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${withSep}${fracPart ? `.${fracPart}` : ""}`;
}

export function sumUsd(
  values: Array<string | number | null | undefined>,
): string {
  return values
    .reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new Decimal(0))
    .toString();
}
