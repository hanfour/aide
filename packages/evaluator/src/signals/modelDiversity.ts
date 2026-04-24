import type { UsageRow, SignalResult } from "./types.js";

export function collectModelDiversity(input: {
  usage: UsageRow[];
  gte: number;
}): SignalResult {
  const { usage, gte } = input;

  if (usage.length === 0) {
    return { hit: false, value: 0, evidence: [] };
  }

  const distinctModels = new Set(usage.map((u) => u.requestedModel));
  const count = distinctModels.size;

  return { hit: count >= gte, value: count, evidence: [] };
}
