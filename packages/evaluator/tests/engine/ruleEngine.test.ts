import { describe, it, expect } from "vitest";
import { scoreWithRules } from "../../src/engine/ruleEngine";
import type { Rubric } from "../../src/rubric/schema";
import type { UsageRow, BodyRow } from "../../src/signals/types";

function mkRubric(sections: Rubric["sections"]): Rubric {
  return { name: "test", version: "1.0.0", locale: "en", sections };
}

describe("scoreWithRules", () => {
  it("returns standard score for section with no superior rules and no hits", () => {
    const rubric = mkRubric([
      {
        id: "interaction",
        name: "Interaction",
        weight: "100%",
        standard: { score: 100, label: "Standard", criteria: [] },
        superior: { score: 120, label: "Superior", criteria: [] },
        signals: [{ type: "cache_read_ratio", id: "cr1", gte: 0.5 }],
      },
    ]);
    const report = scoreWithRules({ rubric, usageRows: [], bodyRows: [] });
    expect(report.totalScore).toBe(100);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(report.sectionScores[0]!.score).toBe(100);
  });

  it("hits superior when all signals hit (no superiorRules)", () => {
    const rubric = mkRubric([
      {
        id: "cache",
        name: "Cache",
        weight: "100%",
        standard: { score: 100, label: "Standard", criteria: [] },
        superior: { score: 120, label: "Superior", criteria: [] },
        signals: [{ type: "cache_read_ratio", id: "cr1", gte: 0.5 }],
      },
    ]);
    const usage: UsageRow[] = [
      {
        requestId: "r1",
        requestedModel: "claude-sonnet-4",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 200,
        cacheCreationTokens: 0,
        totalCost: 0.01,
      },
    ];
    const report = scoreWithRules({ rubric, usageRows: usage, bodyRows: [] });
    expect(report.totalScore).toBe(120);
  });

  it("uses superiorRules: requires minStrongHits + minSupportHits", () => {
    const rubric = mkRubric([
      {
        id: "quality",
        name: "Quality",
        weight: "100%",
        standard: { score: 100, label: "Standard", criteria: [] },
        superior: { score: 120, label: "Superior", criteria: [] },
        signals: [
          { type: "cache_read_ratio", id: "cr1", gte: 0.5 },
          { type: "model_diversity", id: "md1", gte: 2 },
          { type: "tool_diversity", id: "td1", gte: 2 },
        ],
        superiorRules: {
          strongThresholds: ["cr1"],
          supportThresholds: ["md1", "td1"],
          minStrongHits: 1,
          minSupportHits: 2,
        },
      },
    ]);
    // Only cache_read_ratio hits — strong met (1/1) but support = 0 → standard
    const oneHit: UsageRow[] = [
      {
        requestId: "r1",
        requestedModel: "claude-sonnet-4",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 100,
        cacheCreationTokens: 0,
        totalCost: 0.01,
      },
    ];
    expect(scoreWithRules({ rubric, usageRows: oneHit, bodyRows: [] }).totalScore).toBe(100);
  });

  it("applies weights across multiple sections", () => {
    const rubric = mkRubric([
      {
        id: "a",
        name: "A",
        weight: "60%",
        standard: { score: 100, label: "S", criteria: [] },
        superior: { score: 120, label: "Sup", criteria: [] },
        signals: [],
      },
      {
        id: "b",
        name: "B",
        weight: "40%",
        standard: { score: 80, label: "S", criteria: [] },
        superior: { score: 100, label: "Sup", criteria: [] },
        signals: [],
      },
    ]);
    const report = scoreWithRules({ rubric, usageRows: [], bodyRows: [] });
    // 100 × 0.6 + 80 × 0.4 = 92
    expect(report.totalScore).toBeCloseTo(92, 5);
  });

  it("clamps total to [0, 120]", () => {
    const rubric = mkRubric([
      {
        id: "x",
        name: "X",
        weight: "100%",
        standard: { score: 200, label: "S", criteria: [] }, // intentionally weird
        superior: { score: 300, label: "Sup", criteria: [] },
        signals: [],
      },
    ]);
    const report = scoreWithRules({ rubric, usageRows: [], bodyRows: [] });
    expect(report.totalScore).toBe(120);
  });

  it("populates dataQuality coverage correctly", () => {
    const rubric = mkRubric([
      {
        id: "x",
        name: "X",
        weight: "100%",
        standard: { score: 100, label: "S", criteria: [] },
        superior: { score: 120, label: "Sup", criteria: [] },
        signals: [],
      },
    ]);
    const usage: UsageRow[] = [
      {
        requestId: "r1",
        requestedModel: "claude-sonnet-4",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCost: 0.01,
      },
      {
        requestId: "r2",
        requestedModel: "claude-sonnet-4",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCost: 0.01,
      },
    ];
    const bodies: BodyRow[] = [
      {
        requestId: "r1",
        stopReason: "stop",
        clientUserAgent: null,
        clientSessionId: null,
        requestParams: null,
        responseBody: null,
        requestBody: null,
      },
    ];
    const report = scoreWithRules({ rubric, usageRows: usage, bodyRows: bodies });
    expect(report.dataQuality.totalRequests).toBe(2);
    expect(report.dataQuality.capturedRequests).toBe(1);
    expect(report.dataQuality.coverageRatio).toBe(0.5);
  });

  it("keyword signal hits when any body contains term", () => {
    const rubric = mkRubric([
      {
        id: "interaction",
        name: "I",
        weight: "100%",
        standard: { score: 100, label: "S", criteria: [] },
        superior: { score: 120, label: "Sup", criteria: [] },
        signals: [
          {
            type: "keyword",
            id: "kw1",
            in: "request_body",
            terms: ["options"],
            caseSensitive: false,
          },
        ],
      },
    ]);
    const bodies: BodyRow[] = [
      {
        requestId: "r1",
        stopReason: "stop",
        clientUserAgent: null,
        clientSessionId: null,
        requestParams: null,
        responseBody: null,
        requestBody: { text: "What are my options here?" },
      },
    ];
    const report = scoreWithRules({ rubric, usageRows: [], bodyRows: bodies });
    expect(report.totalScore).toBe(120);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(report.sectionScores[0]!.signals[0]!.evidence?.length ?? 0).toBeGreaterThan(0);
  });
});
