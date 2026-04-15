import { describe, it, expect } from "vitest";
import { analyzeSection } from "../src/analyzers/section.js";
import type {
  ClaudeCodeSession,
  ClaudeCodeFacet,
  ClaudeCodeConversationSignal,
  CodexSession,
  CodexConversationSignal,
  CodexSessionInsight,
  EvalSectionDef,
} from "../src/types.js";

function makeSession(overrides: Partial<ClaudeCodeSession> = {}): ClaudeCodeSession {
  return {
    sessionId: "s1",
    projectPath: "/test",
    startTime: "2026-04-01T10:00:00Z",
    durationMinutes: 30,
    userMessageCount: 5,
    assistantMessageCount: 5,
    toolCounts: { Bash: 10, Read: 5 },
    languages: {},
    gitCommits: 1,
    inputTokens: 1000,
    outputTokens: 2000,
    firstPrompt: "test prompt",
    userInterruptions: 0,
    toolErrors: 0,
    toolErrorCategories: {},
    usesTaskAgent: false,
    usesMcp: false,
    linesAdded: 50,
    linesRemoved: 10,
    filesModified: 3,
    messageHours: [10],
    ...overrides,
  };
}

function makeSection(overrides: Partial<EvalSectionDef> = {}): EvalSectionDef {
  return {
    id: "test",
    name: "Test Section",
    weight: "50%",
    standard: { score: 100, label: "Standard", criteria: ["basic"] },
    superior: { score: 120, label: "Superior", criteria: ["advanced"] },
    keywords: ["refactor", "optimize"],
    thresholds: { keywordHits: 3 },
    ...overrides,
  };
}

const emptyFacets = new Map<string, ClaudeCodeFacet>();
const emptySignals: ClaudeCodeConversationSignal[] = [];
const emptyCodex: CodexSession[] = [];
const emptyCodexInsights = new Map<string, CodexSessionInsight>();
const emptyCodexSignals: CodexConversationSignal[] = [];

describe("analyzeSection", () => {
  it("returns standard score with no sessions", () => {
    const result = analyzeSection(
      makeSection(),
      [], emptyFacets, emptySignals,
      emptyCodex, emptyCodexInsights, emptyCodexSignals,
    );
    expect(result.score).toBe(100);
    expect(result.summary).toContain("No sessions found");
  });

  it("returns standard score when thresholds not met", () => {
    const result = analyzeSection(
      makeSection({ thresholds: { keywordHits: 100 } }),
      [makeSession()],
      emptyFacets,
      [],
      emptyCodex, emptyCodexInsights, emptyCodexSignals,
    );
    expect(result.score).toBe(100);
    expect(result.label).toBe("Standard");
  });

  it("returns superior score when threshold met (any mode)", () => {
    const signals: ClaudeCodeConversationSignal[] = [
      { sessionId: "s1", timestamp: "", type: "test", content: "refactor this", keywords: ["refactor"] },
      { sessionId: "s1", timestamp: "", type: "test", content: "optimize here", keywords: ["optimize"] },
      { sessionId: "s1", timestamp: "", type: "test", content: "refactor again", keywords: ["refactor"] },
    ];
    const result = analyzeSection(
      makeSection({ thresholds: { keywordHits: 3 } }),
      [makeSession()],
      emptyFacets,
      signals,
      emptyCodex, emptyCodexInsights, emptyCodexSignals,
    );
    expect(result.score).toBe(120);
    expect(result.label).toBe("Superior");
  });

  it("explains when thresholds met but grouped rule insufficient", () => {
    const signals: ClaudeCodeConversationSignal[] = [
      { sessionId: "s1", timestamp: "", type: "test", content: "refactor", keywords: ["refactor"] },
      { sessionId: "s1", timestamp: "", type: "test", content: "optimize", keywords: ["optimize"] },
      { sessionId: "s1", timestamp: "", type: "test", content: "refactor more", keywords: ["refactor"] },
    ];
    const section = makeSection({
      thresholds: { keywordHits: 3, securityCount: 5 },
      superiorRules: {
        mode: "grouped",
        strongThresholds: ["securityCount"],
        supportThresholds: ["keywordHits"],
        minStrongMatched: 1,
        minSupportMatched: 1,
      },
    });
    const result = analyzeSection(
      section,
      [makeSession()],
      emptyFacets,
      signals,
      emptyCodex, emptyCodexInsights, emptyCodexSignals,
    );
    expect(result.score).toBe(100);
    expect(result.scoreEvidence.some((e) => e.includes("Not sufficient for Superior"))).toBe(true);
  });

  it("collects facet-based signals", () => {
    const facets = new Map<string, ClaudeCodeFacet>([
      ["s1", {
        sessionId: "s1",
        underlyingGoal: "build feature",
        goalCategories: {},
        outcome: "fully_achieved",
        userSatisfactionCounts: {},
        claudeHelpfulness: "very_helpful",
        sessionType: "iterative_refinement",
        frictionCounts: { buggy_code: 2 },
        frictionDetail: "found bugs",
        primarySuccess: "good_debugging",
        briefSummary: "built and debugged",
      }],
    ]);
    const result = analyzeSection(
      makeSection(),
      [makeSession()],
      facets,
      emptySignals,
      emptyCodex, emptyCodexInsights, emptyCodexSignals,
    );
    expect(result.metrics["iterativeSessions"]).toBe(1);
    expect(result.metrics["bugsCaught"]).toBe(2);
    expect(result.signals.some((s) => s.type === "iterative_refinement")).toBe(true);
    expect(result.signals.some((s) => s.type === "bugs_caught")).toBe(true);
  });

  it("records deep engagement sessions", () => {
    const deepSession = makeSession({
      userMessageCount: 15,
      toolCounts: { Bash: 25 },
    });
    const result = analyzeSection(
      makeSection(),
      [deepSession],
      emptyFacets,
      emptySignals,
      emptyCodex, emptyCodexInsights, emptyCodexSignals,
    );
    expect(result.signals.some((s) => s.type === "deep_engagement")).toBe(true);
  });
});
