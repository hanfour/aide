import type { BodyRow, SignalResult } from "./types.js";

function extractMessageCount(requestBody: unknown): number {
  if (requestBody === null || requestBody === undefined) return 0;
  if (typeof requestBody !== "object") return 0;

  const body = requestBody as Record<string, unknown>;
  const messages = body["messages"];

  if (!Array.isArray(messages)) return 0;

  return messages.length;
}

export function collectIterationCount(input: {
  bodies: BodyRow[];
  gte: number;
}): SignalResult {
  const { bodies, gte } = input;

  if (bodies.length === 0) {
    return { hit: false, value: 0, evidence: [] };
  }

  // Group by sessionId. Null sessionId bodies are standalone (each is its own 1-entry group).
  const sessionMaxMessages = new Map<string, number>();
  let standaloneId = 0;

  for (const body of bodies) {
    const sessionKey =
      body.clientSessionId !== null
        ? body.clientSessionId
        : `__standalone__${standaloneId++}`;

    const msgCount = extractMessageCount(body.requestBody);
    const current = sessionMaxMessages.get(sessionKey) ?? 0;

    if (msgCount > current) {
      sessionMaxMessages.set(sessionKey, msgCount);
    }
  }

  let maxTurns = 0;

  for (const msgCount of sessionMaxMessages.values()) {
    const turns = Math.ceil(msgCount / 2);
    if (turns > maxTurns) maxTurns = turns;
  }

  return { hit: maxTurns >= gte, value: maxTurns, evidence: [] };
}
