import type { UsageRow, BodyRow } from "../signals/types.js";
import { bucketUserAgent, type UaBucket } from "../signals/uaBucket.js";

export interface Metrics {
  // Raw counts / sums (primary)
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost: number;

  // Derived ratios
  cache_read_ratio: number;
  refusal_rate: number;

  // Distributions
  model_mix: Record<string, number>;
  client_mix: Record<string, number>;

  // Diversity counts
  model_diversity: number;
  tool_diversity: number;
  iteration_count: number;
  client_mix_ratio: number;

  // Coverage / quality
  body_capture_coverage: number;

  // For reporting UI
  period: {
    requestCount: number;
    bodyCount: number;
    distinctUsers?: never;
  };
}

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

function extractMessageCount(requestBody: unknown): number {
  if (requestBody === null || requestBody === undefined) return 0;
  if (typeof requestBody !== "object") return 0;

  const body = requestBody as Record<string, unknown>;
  const messages = body["messages"];

  if (!Array.isArray(messages)) return 0;

  return messages.length;
}

function computeIterationCount(bodyRows: BodyRow[]): number {
  if (bodyRows.length === 0) return 0;

  const sessionMaxMessages = new Map<string, number>();
  let standaloneId = 0;

  for (const body of bodyRows) {
    const sessionKey =
      body.clientSessionId !== null && body.clientSessionId !== undefined
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

  return maxTurns;
}

function computeToolDiversity(bodyRows: BodyRow[]): number {
  const distinctNames = new Set<string>();

  for (const body of bodyRows) {
    const names = extractToolNames(body.responseBody);
    for (const name of names) {
      distinctNames.add(name);
    }
  }

  return distinctNames.size;
}

function computeClientMix(bodyRows: BodyRow[]): Record<UaBucket, number> {
  const counts: Record<UaBucket, number> = {
    "claude-code": 0,
    cursor: 0,
    "raw-sdk": 0,
    other: 0,
  };

  for (const body of bodyRows) {
    const bucket = bucketUserAgent(body.clientUserAgent);
    counts[bucket] += 1;
  }

  return counts;
}

export function aggregate(input: {
  usageRows: UsageRow[];
  bodyRows: BodyRow[];
}): Metrics {
  const { usageRows, bodyRows } = input;

  if (usageRows.length === 0 && bodyRows.length === 0) {
    return {
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost: 0,
      cache_read_ratio: 0,
      refusal_rate: 0,
      model_mix: {},
      client_mix: {},
      model_diversity: 0,
      tool_diversity: 0,
      iteration_count: 0,
      client_mix_ratio: 0,
      body_capture_coverage: 0,
      period: {
        requestCount: 0,
        bodyCount: 0,
      },
    };
  }

  // Token and cost sums
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let totalCost = 0;
  const modelMix: Record<string, number> = {};

  for (const row of usageRows) {
    inputTokens += Number(row.inputTokens);
    outputTokens += Number(row.outputTokens);
    cacheReadTokens += Number(row.cacheReadTokens);
    cacheCreationTokens += Number(row.cacheCreationTokens);
    totalCost += Number(row.totalCost);

    const model = row.requestedModel;
    modelMix[model] = (modelMix[model] ?? 0) + 1;
  }

  // Derived ratios
  const cacheReadDenominator = inputTokens + cacheReadTokens;
  const cacheReadRatio =
    cacheReadDenominator === 0 ? 0 : cacheReadTokens / cacheReadDenominator;

  // Refusal rate
  let refusalCount = 0;
  for (const body of bodyRows) {
    if (body.stopReason === "refusal") refusalCount += 1;
  }
  const refusalRate =
    bodyRows.length === 0 ? 0 : refusalCount / bodyRows.length;

  // Client mix
  const clientMix = computeClientMix(bodyRows);
  const totalBodies = bodyRows.length;
  let maxClientRatio = 0;
  if (totalBodies > 0) {
    for (const count of Object.values(clientMix)) {
      const ratio = count / totalBodies;
      if (ratio > maxClientRatio) maxClientRatio = ratio;
    }
  }

  // Filter out zero-count buckets for cleaner output
  const filteredClientMix: Record<string, number> = {};
  for (const [bucket, count] of Object.entries(clientMix)) {
    if (count > 0) {
      filteredClientMix[bucket] = count;
    }
  }

  // Body capture coverage
  const bodyCoverage =
    usageRows.length === 0 ? 0 : bodyRows.length / usageRows.length;

  return {
    requests: usageRows.length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    total_cost: totalCost,
    cache_read_ratio: cacheReadRatio,
    refusal_rate: refusalRate,
    model_mix: modelMix,
    client_mix: filteredClientMix,
    model_diversity: Object.keys(modelMix).length,
    tool_diversity: computeToolDiversity(bodyRows),
    iteration_count: computeIterationCount(bodyRows),
    client_mix_ratio: maxClientRatio,
    body_capture_coverage: bodyCoverage,
    period: {
      requestCount: usageRows.length,
      bodyCount: bodyRows.length,
    },
  };
}
