import type { BodyRow, SignalResult } from "./types.js";

export function collectRefusalRate(input: {
  bodies: BodyRow[];
  lte: number;
}): SignalResult {
  const { bodies, lte } = input;

  if (bodies.length === 0) {
    return { hit: true, value: 0, evidence: [] };
  }

  const refusalCount = bodies.filter((b) => b.stopReason === "refusal").length;
  const ratio = refusalCount / bodies.length;

  return { hit: ratio <= lte, value: ratio, evidence: [] };
}
