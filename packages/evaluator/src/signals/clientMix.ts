import type { BodyRow, SignalResult } from "./types.js";

type ClientBucket = "claude-code" | "cursor" | "raw-sdk" | "other";

function classifyUA(ua: string | null): ClientBucket {
  if (ua === null) return "other";

  const lower = ua.toLowerCase();

  if (lower.includes("claude-code")) return "claude-code";
  if (lower.includes("cursor")) return "cursor";
  if (
    lower.includes("anthropic-ai/sdk") ||
    lower.includes("anthropic-sdk") ||
    lower.includes("python-anthropic")
  ) {
    return "raw-sdk";
  }

  return "other";
}

export function collectClientMix(input: {
  bodies: BodyRow[];
  expect: Array<ClientBucket>;
  minRatio: number;
}): SignalResult {
  const { bodies, expect: expectedBuckets, minRatio } = input;

  if (bodies.length === 0) {
    return { hit: false, value: 0, evidence: [] };
  }

  const counts: Record<ClientBucket, number> = {
    "claude-code": 0,
    cursor: 0,
    "raw-sdk": 0,
    other: 0,
  };

  for (const body of bodies) {
    const bucket = classifyUA(body.clientUserAgent);
    counts[bucket] += 1;
  }

  const total = bodies.length;
  let maxRatio = 0;

  for (const bucket of expectedBuckets) {
    const ratio = counts[bucket] / total;
    if (ratio > maxRatio) maxRatio = ratio;
  }

  return { hit: maxRatio >= minRatio, value: maxRatio, evidence: [] };
}
