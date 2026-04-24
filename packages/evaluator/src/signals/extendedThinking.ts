import type { BodyRow, SignalResult } from "./types.js";

function hasThinkingBudget(requestParams: unknown): boolean {
  if (requestParams === null || requestParams === undefined) return false;
  if (typeof requestParams !== "object") return false;

  const params = requestParams as Record<string, unknown>;
  const thinking = params["thinking"];

  if (thinking === null || thinking === undefined) return false;
  if (typeof thinking !== "object") return false;

  const thinkingObj = thinking as Record<string, unknown>;
  const budgetTokens = thinkingObj["budget_tokens"];

  return typeof budgetTokens === "number" && budgetTokens > 0;
}

export function collectExtendedThinking(input: {
  bodies: BodyRow[];
  minCount: number;
}): SignalResult {
  const { bodies, minCount } = input;

  const count = bodies.filter((b) => hasThinkingBudget(b.requestParams)).length;

  return { hit: count >= minCount, value: count, evidence: [] };
}
