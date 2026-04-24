import type { SignalResult, ThresholdInput } from "./types.js";

export function collectThreshold(input: ThresholdInput): SignalResult {
  const { metricValue, gte, lte, between } = input;

  if (between) {
    const [lo, hi] = between;
    return {
      hit: metricValue >= lo && metricValue <= hi,
      value: metricValue,
      evidence: [],
    };
  }

  let hit = true;
  if (gte !== undefined) hit = hit && metricValue >= gte;
  if (lte !== undefined) hit = hit && metricValue <= lte;

  // If NO predicate specified, treat as no-op (never hits).
  if (gte === undefined && lte === undefined) {
    return { hit: false, value: metricValue, evidence: [] };
  }

  return { hit, value: metricValue, evidence: [] };
}
