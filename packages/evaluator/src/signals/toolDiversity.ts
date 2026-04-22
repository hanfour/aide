import type { BodyRow, SignalResult } from "./types.js";

function extractToolNames(responseBody: unknown): string[] {
  if (responseBody === null || responseBody === undefined) return [];
  if (typeof responseBody !== "object") return [];

  const body = responseBody as Record<string, unknown>;
  const content = body["content"];

  if (!Array.isArray(content)) return [];

  const names: string[] = [];

  for (const item of content) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry["type"] === "tool_use" && typeof entry["name"] === "string") {
      names.push(entry["name"]);
    }
  }

  return names;
}

export function collectToolDiversity(input: {
  bodies: BodyRow[];
  gte: number;
}): SignalResult {
  const { bodies, gte } = input;

  const distinctNames = new Set<string>();

  for (const body of bodies) {
    const names = extractToolNames(body.responseBody);
    for (const name of names) {
      distinctNames.add(name);
    }
  }

  const count = distinctNames.size;

  return { hit: count >= gte, value: count, evidence: [] };
}
