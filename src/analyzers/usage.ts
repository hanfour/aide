import dayjs from "dayjs";
import type {
  ClaudeCodeSession,
  ClaudeCodeCostRecord,
  CodexSession,
  UsageOverview,
} from "../types.js";

type ClaudeModelUsage = { sessions: number; tokens: number; cost: number };

function allocateTokensByWeight(totalTokens: number, weights: number[]): number[] {
  if (totalTokens <= 0 || weights.length === 0) {
    return weights.map(() => 0);
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const normalizedWeights =
    totalWeight > 0 ? weights : weights.map(() => 1);
  const normalizedTotal = normalizedWeights.reduce((sum, weight) => sum + weight, 0);

  const rawAllocations = normalizedWeights.map(
    (weight) => (totalTokens * weight) / normalizedTotal,
  );
  const allocations = rawAllocations.map((value) => Math.floor(value));
  let remaining = totalTokens - allocations.reduce((sum, value) => sum + value, 0);

  const byFraction = rawAllocations
    .map((value, idx) => ({ idx, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (const item of byFraction) {
    if (remaining <= 0) break;
    allocations[item.idx] += 1;
    remaining -= 1;
  }

  return allocations;
}

export function analyzeUsage(
  claudeSessions: ClaudeCodeSession[],
  claudeCosts: ClaudeCodeCostRecord[],
  codexSessions: CodexSession[],
  since: string,
  until: string,
): UsageOverview {
  // ── Claude Code aggregation ──

  const ccActiveDays = new Set<string>();
  const ccModels: Record<string, ClaudeModelUsage> = {};
  const ccProjects: Record<string, { sessions: number; tokens: number }> = {};
  const ccToolUsage: Record<string, number> = {};
  const ccDailyActivity: Record<string, { sessions: number; tokens: number }> = {};
  const claudeSessionTokens = new Map<string, number>();
  const costRowsBySession = new Map<string, ClaudeCodeCostRecord[]>();

  let ccTotalInput = 0;
  let ccTotalOutput = 0;
  let ccTotalDuration = 0;

  for (const s of claudeSessions) {
    const day = dayjs(s.startTime).format("YYYY-MM-DD");
    ccActiveDays.add(day);

    ccTotalInput += s.inputTokens;
    ccTotalOutput += s.outputTokens;
    ccTotalDuration += s.durationMinutes;
    claudeSessionTokens.set(s.sessionId, s.inputTokens + s.outputTokens);

    // Daily activity
    const daily = ccDailyActivity[day] ?? { sessions: 0, tokens: 0 };
    daily.sessions += 1;
    daily.tokens += s.inputTokens + s.outputTokens;
    ccDailyActivity[day] = daily;

    // Project aggregation
    const projName = s.projectPath.split("/").pop() ?? s.projectPath;
    const proj = ccProjects[projName] ?? { sessions: 0, tokens: 0 };
    proj.sessions += 1;
    proj.tokens += s.inputTokens + s.outputTokens;
    ccProjects[projName] = proj;

    // Tool usage aggregation
    for (const [tool, count] of Object.entries(s.toolCounts)) {
      ccToolUsage[tool] = (ccToolUsage[tool] ?? 0) + count;
    }
  }

  // Cost by model from SQLite
  let ccTotalCost = 0;
  const ccModelSessions = new Map<string, Set<string>>();
  for (const c of claudeCosts) {
    ccTotalCost += c.totalCostUsd;
    const model = ccModels[c.model] ?? { sessions: 0, tokens: 0, cost: 0 };
    model.cost += c.totalCostUsd;
    ccModels[c.model] = model;

    const modelSessions = ccModelSessions.get(c.model) ?? new Set<string>();
    modelSessions.add(c.sessionId);
    ccModelSessions.set(c.model, modelSessions);

    const sessionRows = costRowsBySession.get(c.sessionId) ?? [];
    sessionRows.push(c);
    costRowsBySession.set(c.sessionId, sessionRows);
  }

  for (const [model, sessionIds] of ccModelSessions) {
    const usage = ccModels[model];
    usage.sessions = sessionIds.size;
  }

  // Estimate per-model tokens by session using cost share, then message count share as fallback.
  for (const s of claudeSessions) {
    const totalTokens = claudeSessionTokens.get(s.sessionId) ?? 0;
    const sessionCosts = costRowsBySession.get(s.sessionId) ?? [];

    if (sessionCosts.length === 0) {
      const unknown = ccModels.unknown ?? { sessions: 0, tokens: 0, cost: 0 };
      unknown.sessions += 1;
      unknown.tokens += totalTokens;
      ccModels.unknown = unknown;
      continue;
    }

    const weights = sessionCosts.map((row) =>
      row.totalCostUsd > 0 ? row.totalCostUsd : row.messageCount,
    );
    const allocatedTokens = allocateTokensByWeight(totalTokens, weights);

    for (const [idx, row] of sessionCosts.entries()) {
      const model = ccModels[row.model] ?? { sessions: 0, tokens: 0, cost: 0 };
      model.tokens += allocatedTokens[idx];
      ccModels[row.model] = model;
    }
  }

  const topProjects = Object.entries(ccProjects)
    .map(([path, data]) => ({ path, ...data }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10);

  // ── Codex aggregation ──

  const cxActiveDays = new Set<string>();
  const cxModels: Record<string, { sessions: number; tokens: number }> = {};
  const cxDailyActivity: Record<string, { sessions: number; tokens: number }> = {};
  let cxTotalTokens = 0;

  for (const s of codexSessions) {
    const day = dayjs.unix(s.createdAt).format("YYYY-MM-DD");
    cxActiveDays.add(day);
    cxTotalTokens += s.tokensUsed;

    const model = cxModels[s.model] ?? { sessions: 0, tokens: 0 };
    model.sessions += 1;
    model.tokens += s.tokensUsed;
    cxModels[s.model] = model;

    const daily = cxDailyActivity[day] ?? { sessions: 0, tokens: 0 };
    daily.sessions += 1;
    daily.tokens += s.tokensUsed;
    cxDailyActivity[day] = daily;
  }

  return {
    claudeCode: {
      totalSessions: claudeSessions.length,
      totalInputTokens: ccTotalInput,
      totalOutputTokens: ccTotalOutput,
      totalCostUsd: ccTotalCost,
      totalDurationMinutes: ccTotalDuration,
      activeDays: ccActiveDays.size,
      models: ccModels,
      topProjects,
      toolUsage: ccToolUsage,
      dailyActivity: ccDailyActivity,
    },
    codex: {
      totalSessions: codexSessions.length,
      totalTokensUsed: cxTotalTokens,
      models: cxModels,
      activeDays: cxActiveDays.size,
      dailyActivity: cxDailyActivity,
    },
    period: { since, until },
  };
}
