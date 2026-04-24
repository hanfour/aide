import type { UsageRow, SignalResult } from "./types.js";

export function collectCacheReadRatio(input: {
  usage: UsageRow[];
  gte: number;
}): SignalResult {
  const { usage, gte } = input;

  let totalInput = 0;
  let totalCacheRead = 0;

  for (const row of usage) {
    totalInput += row.inputTokens;
    totalCacheRead += row.cacheReadTokens;
  }

  const denominator = totalInput + totalCacheRead;

  if (denominator === 0) {
    return { hit: false, value: 0, evidence: [] };
  }

  const ratio = totalCacheRead / denominator;

  return { hit: ratio >= gte, value: ratio, evidence: [] };
}
