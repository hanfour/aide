// ── Data source types ──

export interface ClaudeCodeSession {
  sessionId: string;
  projectPath: string;
  startTime: string;
  durationMinutes: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCounts: Record<string, number>;
  languages: Record<string, number>;
  gitCommits: number;
  inputTokens: number;
  outputTokens: number;
  firstPrompt: string;
  userInterruptions: number;
  toolErrors: number;
  toolErrorCategories: Record<string, number>;
  usesTaskAgent: boolean;
  usesMcp: boolean;
  linesAdded: number;
  linesRemoved: number;
  filesModified: number;
  messageHours: number[];
}

export interface ClaudeCodeFacet {
  sessionId: string;
  underlyingGoal: string;
  goalCategories: Record<string, number>;
  outcome: string;
  userSatisfactionCounts: Record<string, number>;
  claudeHelpfulness: string;
  sessionType: string;
  frictionCounts: Record<string, number>;
  frictionDetail: string;
  primarySuccess: string;
  briefSummary: string;
}

export interface ClaudeCodeCostRecord {
  sessionId: string;
  model: string;
  totalCostUsd: number;
  totalDurationMs: number;
  messageCount: number;
}

export interface ClaudeCodeConversationSignal {
  sessionId: string;
  timestamp: string;
  type: string; // matches section id from EvalStandard
  content: string;
  keywords: string[];
}

export interface CodexSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  modelProvider: string;
  cwd: string;
  title: string;
  tokensUsed: number;
  gitBranch: string | null;
  gitOriginUrl: string | null;
  firstUserMessage: string;
  cliVersion: string;
}

export interface CodexConversationSignal {
  sessionId: string;
  timestamp: string;
  type: string; // matches section id from EvalStandard
  content: string;
  keywords: string[];
}

export interface CodexUserMessage {
  timestamp: string;
  text: string;
}

export interface CodexSessionInsight {
  sessionId: string;
  userMessages: CodexUserMessage[];
  toolCallCount: number;
  toolCalls: Record<string, number>;
  errorCount: number;
}

// ── Analysis types ──

export interface UsageOverview {
  claudeCode: {
    totalSessions: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    totalDurationMinutes: number;
    activeDays: number;
    models: Record<string, { sessions: number; tokens: number; cost: number }>;
    topProjects: Array<{ path: string; sessions: number; tokens: number }>;
    toolUsage: Record<string, number>;
    dailyActivity: Record<string, { sessions: number; tokens: number }>;
  };
  codex: {
    totalSessions: number;
    totalTokensUsed: number;
    models: Record<string, { sessions: number; tokens: number }>;
    activeDays: number;
    dailyActivity: Record<string, { sessions: number; tokens: number }>;
  };
  period: { since: string; until: string };
}

// (Section results and report are defined below with CLI types)

// ── Evaluation standard (user-configurable) ──

export interface EvalSectionDef {
  id: string;
  name: string;
  weight: string;
  standard: { score: number; label: string; criteria: string[] };
  superior: { score: number; label: string; criteria: string[] };
  keywords: string[];
  thresholds: Record<string, number>;
  superiorRules?: {
    mode?: "any" | "grouped";
    strongThresholds?: string[];
    supportThresholds?: string[];
    minStrongMatched?: number;
    minSupportMatched?: number;
  };
}

export interface EvalStandard {
  name: string;
  description?: string;
  sections: EvalSectionDef[];
  noiseFilters?: {
    prefixes?: string[];
    templatePhrases?: string[];
    minLength?: number;
  };
}

// ── CLI types ──

export interface CliOptions {
  since?: string;
  until?: string;
  format: "text" | "json" | "markdown" | "html";
  output?: string;
  standard?: string;
  previous?: boolean;
  engineer?: string;
  department?: string;
}

export interface ReportMeta {
  engineer?: string;
  department?: string;
}

export interface DataQualityWarning {
  source: string;
  severity: "missing" | "partial" | "error";
  message: string;
}

export interface EvalReport {
  generatedAt: string;
  period: { since: string; until: string };
  standardName: string;
  locale: "en" | "zh-TW";
  meta?: ReportMeta;
  usage: UsageOverview;
  sections: EvalSectionResult[];
  dataWarnings: DataQualityWarning[];
  managementSummary: {
    headline: string;
    overallAssessment: string;
    observations: string[];
    recommendations: string[];
  };
}

export interface EvalSectionResult {
  id: string;
  name: string;
  weight: string;
  score: number;
  label: string;
  reason: string;
  metThresholds: string[];
  usageEvidence: string[];
  scoreEvidence: string[];
  signals: Array<{
    type: string;
    description: string;
    sessionId: string;
    detail: string;
  }>;
  metrics: Record<string, number>;
  summary: string;
}
