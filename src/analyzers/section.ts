import type {
  ClaudeCodeSession,
  ClaudeCodeFacet,
  ClaudeCodeConversationSignal,
  CodexSession,
  CodexConversationSignal,
  CodexSessionInsight,
  EvalSectionDef,
  EvalSectionResult,
} from "../types.js";

type Signal = EvalSectionResult["signals"][number];

// ── Constants ──

const DEEP_SESSION_MIN_MESSAGES = 10;
const DEEP_SESSION_MIN_TOOLS = 20;
const CODEX_ITERATIVE_MIN_MESSAGES = 3;
const CODEX_DEEP_MIN_TOOL_CALLS = 10;
const CODEX_DEEP_MIN_TOKENS = 50_000;

const SECURITY_KEYWORDS = [
  "security",
  "vulnerability",
  "injection",
  "xss",
  "csrf",
  "authentication",
  "authorization",
  "credential",
  "sanitize",
  "security review",
  "risk assessment",
  "安全",
  "漏洞",
  "注入",
];

const PERFORMANCE_KEYWORDS = [
  "performance",
  "bottleneck",
  "memory leak",
  "optimize",
  "latency",
  "cache invalidat",
  "slow query",
  "timeout",
  "n+1",
  "效能",
  "瓶頸",
  "記憶體洩漏",
];

// ── Threshold description ──

function describeThreshold(
  key: string,
  metrics: Record<string, number>,
): string {
  const value = metrics[key] ?? 0;
  const labels: Record<string, string> = {
    iterativeRatio: "iterative evidence ratio reached threshold",
    correctionCount: `${value} active corrections`,
    keywordHits: `${value} decision/risk keyword hits`,
    avgToolUses: `${value} average tool uses per session`,
    securityCount: `${value} security signals`,
    performanceCount: `${value} performance signals`,
    bugsCaught: `${value} AI bugs caught`,
    frictionSessions: `${value} friction sessions`,
    codexErrorSessions: `${value} Codex error-handling sessions`,
  };

  return labels[key] ?? `${key}: ${value}`;
}

// ── Superior score determination ──

function shouldScoreGroupedSuperior(
  metThresholdKeys: Set<string>,
  strongThresholds: string[],
  supportThresholds: string[],
  minStrongMatched: number,
  minSupportMatched: number,
): boolean {
  const metStrongCount = strongThresholds.filter((key) =>
    metThresholdKeys.has(key),
  ).length;
  const metSupportCount = supportThresholds.filter((key) =>
    metThresholdKeys.has(key),
  ).length;

  return (
    metStrongCount >= minStrongMatched && metSupportCount >= minSupportMatched
  );
}

function shouldScoreSuperior(
  section: EvalSectionDef,
  metThresholdKeys: Set<string>,
): boolean {
  const rules = section.superiorRules;
  if (!rules || rules.mode === "any" || !rules.mode) {
    return metThresholdKeys.size > 0;
  }

  if (rules.mode === "grouped") {
    return shouldScoreGroupedSuperior(
      metThresholdKeys,
      rules.strongThresholds ?? Object.keys(section.thresholds),
      rules.supportThresholds ?? [],
      rules.minStrongMatched ?? 1,
      rules.minSupportMatched ?? 0,
    );
  }

  return metThresholdKeys.size > 0;
}

// ── Signal collectors ──

interface FacetResult {
  signals: Signal[];
  iterativeSessions: number;
  multiTaskSessions: number;
  frictionSessions: number;
  bugsCaught: number;
}

function collectFacetSignals(
  facets: Map<string, ClaudeCodeFacet>,
): FacetResult {
  const signals: Signal[] = [];
  let iterativeSessions = 0;
  let multiTaskSessions = 0;
  let frictionSessions = 0;
  let bugsCaught = 0;

  for (const [sid, facet] of facets) {
    if (facet.sessionType === "iterative_refinement") {
      iterativeSessions++;
      signals.push({
        type: "iterative_refinement",
        description: "Session shows iterative guidance pattern (A → B → C)",
        sessionId: sid,
        detail: facet.briefSummary,
      });
    }

    if (facet.sessionType === "multi_task") {
      multiTaskSessions++;
      signals.push({
        type: "multi_task",
        description: "Session involves coordinating multiple AI tasks",
        sessionId: sid,
        detail: facet.underlyingGoal,
      });
    }

    if (
      facet.outcome === "fully_achieved" &&
      (facet.claudeHelpfulness === "very_helpful" ||
        facet.claudeHelpfulness === "extremely_helpful")
    ) {
      signals.push({
        type: "effective_outcome",
        description: "Session fully achieved with high AI helpfulness",
        sessionId: sid,
        detail: `Goal: ${facet.underlyingGoal} | Outcome: ${facet.outcome}`,
      });
    }

    const frictionKeys = Object.keys(facet.frictionCounts);
    if (frictionKeys.length > 0) {
      frictionSessions++;
      if (facet.frictionCounts["buggy_code"]) {
        bugsCaught += facet.frictionCounts["buggy_code"];
        signals.push({
          type: "bugs_caught",
          description: `Caught ${facet.frictionCounts["buggy_code"]} AI-generated bugs`,
          sessionId: sid,
          detail: facet.frictionDetail,
        });
      }
      if (facet.frictionCounts["wrong_approach"]) {
        signals.push({
          type: "wrong_approach_caught",
          description: "Identified and corrected wrong AI approach",
          sessionId: sid,
          detail: facet.frictionDetail,
        });
      }
    }

    if (facet.primarySuccess === "good_debugging") {
      signals.push({
        type: "good_debugging",
        description: "Session recognized for effective debugging",
        sessionId: sid,
        detail: facet.briefSummary,
      });
    }
  }

  return {
    signals,
    iterativeSessions,
    multiTaskSessions,
    frictionSessions,
    bugsCaught,
  };
}

interface ClaudeSessionResult {
  signals: Signal[];
  totalToolUses: number;
  correctionCount: number;
}

function collectClaudeSessionSignals(
  sessions: ClaudeCodeSession[],
): ClaudeSessionResult {
  const signals: Signal[] = [];
  let totalToolUses = 0;
  let correctionCount = 0;

  for (const s of sessions) {
    const toolCount = Object.values(s.toolCounts).reduce((a, b) => a + b, 0);
    totalToolUses += toolCount;
    correctionCount += s.userInterruptions;

    if (
      s.userMessageCount >= DEEP_SESSION_MIN_MESSAGES &&
      toolCount >= DEEP_SESSION_MIN_TOOLS
    ) {
      signals.push({
        type: "deep_engagement",
        description: `Deep session: ${s.userMessageCount} user messages, ${toolCount} tool uses`,
        sessionId: s.sessionId,
        detail: s.firstPrompt.slice(0, 150),
      });
    }

    if (s.toolErrors > 0) {
      signals.push({
        type: "tool_errors_handled",
        description: `Handled ${s.toolErrors} tool errors in session`,
        sessionId: s.sessionId,
        detail: Object.entries(s.toolErrorCategories)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", "),
      });
    }
  }

  return { signals, totalToolUses, correctionCount };
}

interface CodexResult {
  signals: Signal[];
  totalToolUses: number;
  iterativeSessions: number;
  deepSessions: number;
  errorSessions: number;
  followUpCount: number;
  multiTurnSessions: number;
}

function collectCodexSignals(
  codexSessions: CodexSession[],
  codexInsights: Map<string, CodexSessionInsight>,
  sectionId: string,
  sectionCodexSignalSessionIds: Set<string>,
): CodexResult {
  const signals: Signal[] = [];
  let totalToolUses = 0;
  let iterativeSessions = 0;
  let deepSessions = 0;
  let errorSessions = 0;
  let followUpCount = 0;
  let multiTurnSessions = 0;

  for (const session of codexSessions) {
    const insight = codexInsights.get(session.id);
    const userMessageCount = insight?.userMessages.length ?? 0;
    const followUps = Math.max(0, userMessageCount - 1);
    const toolCallCount = insight?.toolCallCount ?? 0;
    const errorCount = insight?.errorCount ?? 0;

    totalToolUses += toolCallCount;
    followUpCount += followUps;

    if (userMessageCount >= 2) {
      multiTurnSessions++;
      signals.push({
        type: "codex_multi_turn",
        description: `Codex thread has ${userMessageCount} user prompts`,
        sessionId: session.id,
        detail: session.title || session.firstUserMessage.slice(0, 150),
      });
    }

    if (
      userMessageCount >= CODEX_ITERATIVE_MIN_MESSAGES &&
      (sectionId !== "interaction" ||
        sectionCodexSignalSessionIds.has(session.id))
    ) {
      iterativeSessions++;
      signals.push({
        type: "codex_iterative_refinement",
        description: `Codex thread shows iterative guidance with ${userMessageCount} user prompts`,
        sessionId: session.id,
        detail: session.title || session.firstUserMessage.slice(0, 150),
      });
    }

    if (
      toolCallCount >= CODEX_DEEP_MIN_TOOL_CALLS ||
      session.tokensUsed >= CODEX_DEEP_MIN_TOKENS
    ) {
      deepSessions++;
      signals.push({
        type: "codex_deep_engagement",
        description: `Codex deep thread: ${toolCallCount} tool calls, ${session.tokensUsed.toLocaleString("en-US")} tokens`,
        sessionId: session.id,
        detail: session.title || session.firstUserMessage.slice(0, 150),
      });
    }

    if (errorCount > 0) {
      errorSessions++;
      signals.push({
        type: "codex_tool_errors_handled",
        description: `Codex thread handled ${errorCount} logged errors`,
        sessionId: session.id,
        detail: session.title || session.firstUserMessage.slice(0, 150),
      });
    }
  }

  return {
    signals,
    totalToolUses,
    iterativeSessions,
    deepSessions,
    errorSessions,
    followUpCount,
    multiTurnSessions,
  };
}

// ── Keyword signal categorization ──

interface KeywordCounts {
  signals: Signal[];
  securityCount: number;
  performanceCount: number;
  codexKeywordSessions: number;
}

function collectKeywordSignals(
  sectionId: string,
  claudeSignals: ClaudeCodeConversationSignal[],
  codexSignals: CodexConversationSignal[],
): KeywordCounts {
  const signals: Signal[] = [];
  let securityCount = 0;
  let performanceCount = 0;

  const matchesCategory = (
    keyword: string,
    categoryKeywords: string[],
  ): boolean => {
    const lower = keyword.toLowerCase();
    return categoryKeywords.some(
      (ck) => lower.includes(ck) || ck.includes(lower),
    );
  };

  for (const sig of claudeSignals) {
    const isSecHit = sig.keywords.some((k) =>
      matchesCategory(k, SECURITY_KEYWORDS),
    );
    const isPerfHit = sig.keywords.some((k) =>
      matchesCategory(k, PERFORMANCE_KEYWORDS),
    );
    if (isSecHit) securityCount++;
    if (isPerfHit) performanceCount++;

    signals.push({
      type: `keyword_${sectionId}`,
      description: `Keyword match: [${sig.keywords.join(", ")}]`,
      sessionId: sig.sessionId,
      detail: sig.content,
    });
  }

  const codexSignalSessionIds = new Set<string>();
  for (const sig of codexSignals) {
    codexSignalSessionIds.add(sig.sessionId);

    const isSecHit = sig.keywords.some((k) =>
      matchesCategory(k, SECURITY_KEYWORDS),
    );
    const isPerfHit = sig.keywords.some((k) =>
      matchesCategory(k, PERFORMANCE_KEYWORDS),
    );

    signals.push({
      type: `codex_keyword_${sectionId}`,
      description: `Codex thread keyword match: [${sig.keywords.join(", ")}]`,
      sessionId: sig.sessionId,
      detail: sig.content,
    });
  }

  return {
    signals,
    securityCount,
    performanceCount,
    codexKeywordSessions: codexSignalSessionIds.size,
  };
}

// ── Evidence builders ──

function buildEvidenceParts(params: {
  iterativeSessions: number;
  codexIterativeSessions: number;
  codexMultiTurnSessions: number;
  multiTaskSessions: number;
  correctionCount: number;
  codexFollowUpCount: number;
  bugsCaught: number;
  securityCount: number;
  performanceCount: number;
  codexSignalCount: number;
  codexDeepSessions: number;
}): string[] {
  const parts: string[] = [];
  if (params.iterativeSessions > 0)
    parts.push(`${params.iterativeSessions} iterative refinement sessions`);
  if (params.codexIterativeSessions > 0)
    parts.push(`${params.codexIterativeSessions} Codex iterative threads`);
  if (params.codexMultiTurnSessions > 0)
    parts.push(`${params.codexMultiTurnSessions} Codex multi-turn threads`);
  if (params.multiTaskSessions > 0)
    parts.push(`${params.multiTaskSessions} multi-task sessions`);
  if (params.correctionCount > 0)
    parts.push(`${params.correctionCount} active corrections`);
  if (params.codexFollowUpCount > 0)
    parts.push(`${params.codexFollowUpCount} Codex follow-up prompts`);
  if (params.bugsCaught > 0) parts.push(`${params.bugsCaught} AI bugs caught`);
  if (params.securityCount > 0)
    parts.push(`${params.securityCount} security discussions`);
  if (params.performanceCount > 0)
    parts.push(`${params.performanceCount} performance discussions`);
  if (params.codexSignalCount > 0)
    parts.push(`${params.codexSignalCount} Codex keyword signals`);
  if (params.codexDeepSessions > 0)
    parts.push(`${params.codexDeepSessions} deep Codex threads`);
  return parts;
}

function buildUsageEvidence(params: {
  claudeSessionCount: number;
  codexSessionCount: number;
  avgToolUses: number;
  codexDeepSessions: number;
  frictionSessions: number;
}): string[] {
  const evidence: string[] = [];
  if (params.claudeSessionCount > 0)
    evidence.push(
      `${params.claudeSessionCount} Claude Code sessions in period`,
    );
  if (params.codexSessionCount > 0)
    evidence.push(`${params.codexSessionCount} Codex threads in period`);
  if (params.avgToolUses > 0)
    evidence.push(`Average ${params.avgToolUses} tool uses per session/thread`);
  if (params.codexDeepSessions > 0)
    evidence.push(
      `${params.codexDeepSessions} deep Codex threads with high tool/token depth`,
    );
  if (params.frictionSessions > 0)
    evidence.push(`${params.frictionSessions} friction sessions were recorded`);
  return evidence;
}

function buildScoreEvidence(
  section: EvalSectionDef,
  metThresholds: string[],
  metThresholdKeys: Set<string>,
  isSuperior: boolean,
  metrics: Record<string, number>,
): string[] {
  const evidence = metThresholds.map((key) => describeThreshold(key, metrics));

  if (metThresholdKeys.size > 0 && !isSuperior) {
    const rules = section.superiorRules;
    if (rules?.mode === "grouped") {
      const strong = rules.strongThresholds ?? Object.keys(section.thresholds);
      const support = rules.supportThresholds ?? [];
      const metStrong = strong.filter((k) => metThresholdKeys.has(k));
      const metSupport = support.filter((k) => metThresholdKeys.has(k));
      evidence.push(
        `Thresholds met [${metThresholds.join(", ")}] but grouped rule requires ` +
          `>=${rules.minStrongMatched ?? 1} strong (met ${metStrong.length}/${strong.length}: [${metStrong.join(", ")}]) ` +
          `and >=${rules.minSupportMatched ?? 0} support (met ${metSupport.length}/${support.length}: [${metSupport.join(", ")}]). ` +
          `Not sufficient for Superior.`,
      );
    }
  }

  return evidence;
}

function buildSummary(params: {
  totalSessions: number;
  claudeSessionCount: number;
  codexSessionCount: number;
  iterativeSessions: number;
  codexIterativeSessions: number;
  codexMultiTurnSessions: number;
  multiTaskSessions: number;
  frictionSessions: number;
  bugsCaught: number;
  keywordHits: number;
  codexFollowUpCount: number;
  avgToolUses: number;
}): string {
  const parts: string[] = [];
  parts.push(`${params.totalSessions} sessions analyzed.`);
  if (params.claudeSessionCount > 0)
    parts.push(`${params.claudeSessionCount} Claude Code sessions.`);
  if (params.codexSessionCount > 0)
    parts.push(`${params.codexSessionCount} Codex threads.`);
  if (params.iterativeSessions > 0)
    parts.push(`${params.iterativeSessions} iterative refinement sessions.`);
  if (params.codexIterativeSessions > 0)
    parts.push(`${params.codexIterativeSessions} iterative Codex threads.`);
  if (params.codexMultiTurnSessions > 0)
    parts.push(`${params.codexMultiTurnSessions} multi-turn Codex threads.`);
  if (params.multiTaskSessions > 0)
    parts.push(`${params.multiTaskSessions} multi-task sessions.`);
  if (params.frictionSessions > 0)
    parts.push(
      `${params.frictionSessions} friction sessions (AI issues caught).`,
    );
  if (params.bugsCaught > 0) parts.push(`${params.bugsCaught} AI bugs caught.`);
  if (params.keywordHits > 0)
    parts.push(`${params.keywordHits} keyword signals detected.`);
  if (params.codexFollowUpCount > 0)
    parts.push(`${params.codexFollowUpCount} Codex follow-up prompts.`);
  parts.push(`Avg ${params.avgToolUses} tool uses/session.`);
  return parts.join(" ");
}

// ── Main section analyzer ──

/**
 * Generic section analyzer.
 *
 * Collects evidence from facets, sessions, and conversation signals,
 * then determines standard vs superior score based on section thresholds.
 */
export function analyzeSection(
  section: EvalSectionDef,
  claudeSessions: ClaudeCodeSession[],
  facets: Map<string, ClaudeCodeFacet>,
  claudeSignals: ClaudeCodeConversationSignal[],
  codexSessions: CodexSession[],
  codexInsights: Map<string, CodexSessionInsight>,
  codexSignals: CodexConversationSignal[],
): EvalSectionResult {
  const totalSessions = claudeSessions.length + codexSessions.length;

  if (totalSessions === 0) {
    return {
      id: section.id,
      name: section.name,
      weight: section.weight,
      score: section.standard.score,
      label: section.standard.label,
      reason: "No sessions found in the evaluation period.",
      metThresholds: [],
      usageEvidence: [],
      scoreEvidence: [],
      signals: [],
      metrics: {},
      summary: "No sessions found in the evaluation period.",
    };
  }

  // ── Collect signals from all sources ──

  const sectionClaudeSignals = claudeSignals.filter(
    (s) => s.type === section.id,
  );
  const sectionCodexSignals = codexSignals.filter((s) => s.type === section.id);
  const sectionCodexSignalSessionIds = new Set(
    sectionCodexSignals.map((s) => s.sessionId),
  );

  const facetResult = collectFacetSignals(facets);
  const claudeResult = collectClaudeSessionSignals(claudeSessions);
  const codexResult = collectCodexSignals(
    codexSessions,
    codexInsights,
    section.id,
    sectionCodexSignalSessionIds,
  );
  const keywordResult = collectKeywordSignals(
    section.id,
    sectionClaudeSignals,
    sectionCodexSignals,
  );

  const collectedSignals: Signal[] = [
    ...facetResult.signals,
    ...claudeResult.signals,
    ...codexResult.signals,
    ...keywordResult.signals,
  ];

  const totalToolUses = claudeResult.totalToolUses + codexResult.totalToolUses;
  const avgToolUses =
    totalSessions > 0 ? Math.round(totalToolUses / totalSessions) : 0;

  // ── Store metrics ──

  const metrics: Record<string, number> = {
    sessions: totalSessions,
    claudeSessions: claudeSessions.length,
    codexSessions: codexSessions.length,
    iterativeSessions: facetResult.iterativeSessions,
    codexIterativeSessions: codexResult.iterativeSessions,
    codexMultiTurnSessions: codexResult.multiTurnSessions,
    multiTaskSessions: facetResult.multiTaskSessions,
    correctionCount: claudeResult.correctionCount,
    codexFollowUpCount: codexResult.followUpCount,
    avgToolUses,
    keywordHits: sectionClaudeSignals.length + sectionCodexSignals.length,
    codexKeywordSessions: keywordResult.codexKeywordSessions,
    frictionSessions: facetResult.frictionSessions,
    bugsCaught: facetResult.bugsCaught,
    securityCount: keywordResult.securityCount,
    performanceCount: keywordResult.performanceCount,
    codexDeepSessions: codexResult.deepSessions,
    codexErrorSessions: codexResult.errorSessions,
  };

  // ── Score determination via thresholds ──

  const metThresholdKeys = new Set<string>();

  for (const [key, threshold] of Object.entries(section.thresholds)) {
    if (key === "iterativeRatio") {
      const ratio =
        totalSessions > 0
          ? (facetResult.iterativeSessions +
              facetResult.multiTaskSessions +
              codexResult.iterativeSessions) /
            totalSessions
          : 0;
      if (ratio >= threshold) metThresholdKeys.add(key);
    } else if ((metrics[key] ?? 0) >= threshold) {
      metThresholdKeys.add(key);
    }
  }

  const isSuperior = shouldScoreSuperior(section, metThresholdKeys);
  const metThresholds = [...metThresholdKeys];
  const score = isSuperior ? section.superior.score : section.standard.score;
  const label = isSuperior ? section.superior.label : section.standard.label;

  // ── Build evidence and reason ──

  const criteriaList = isSuperior
    ? section.superior.criteria
    : section.standard.criteria;
  const evidenceParts = buildEvidenceParts({
    iterativeSessions: facetResult.iterativeSessions,
    codexIterativeSessions: codexResult.iterativeSessions,
    codexMultiTurnSessions: codexResult.multiTurnSessions,
    multiTaskSessions: facetResult.multiTaskSessions,
    correctionCount: claudeResult.correctionCount,
    codexFollowUpCount: codexResult.followUpCount,
    bugsCaught: facetResult.bugsCaught,
    securityCount: keywordResult.securityCount,
    performanceCount: keywordResult.performanceCount,
    codexSignalCount: sectionCodexSignals.length,
    codexDeepSessions: codexResult.deepSessions,
  });

  const reason =
    `${label} (${score}%): ` +
    criteriaList[0] +
    (evidenceParts.length > 0
      ? ". Evidence: " + evidenceParts.join("; ")
      : "") +
    ".";

  return {
    id: section.id,
    name: section.name,
    weight: section.weight,
    score,
    label,
    reason,
    metThresholds,
    usageEvidence: buildUsageEvidence({
      claudeSessionCount: claudeSessions.length,
      codexSessionCount: codexSessions.length,
      avgToolUses,
      codexDeepSessions: codexResult.deepSessions,
      frictionSessions: facetResult.frictionSessions,
    }),
    scoreEvidence: buildScoreEvidence(
      section,
      metThresholds,
      metThresholdKeys,
      isSuperior,
      metrics,
    ),
    signals: collectedSignals,
    metrics,
    summary: buildSummary({
      totalSessions,
      claudeSessionCount: claudeSessions.length,
      codexSessionCount: codexSessions.length,
      iterativeSessions: facetResult.iterativeSessions,
      codexIterativeSessions: codexResult.iterativeSessions,
      codexMultiTurnSessions: codexResult.multiTurnSessions,
      multiTaskSessions: facetResult.multiTaskSessions,
      frictionSessions: facetResult.frictionSessions,
      bugsCaught: facetResult.bugsCaught,
      keywordHits: sectionClaudeSignals.length + sectionCodexSignals.length,
      codexFollowUpCount: codexResult.followUpCount,
      avgToolUses,
    }),
  };
}
