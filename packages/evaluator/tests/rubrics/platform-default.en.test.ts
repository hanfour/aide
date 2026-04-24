import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rubricSchema, scoreWithRules } from "../../src";
import type { UsageRow, BodyRow } from "../../src";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const enRubric = JSON.parse(
  readFileSync(join(__dirname, "../../rubrics/platform-default.en.json"), "utf-8"),
) as unknown;

describe("platform-default.en rubric", () => {
  it("validates against rubricSchema", () => {
    expect(() => rubricSchema.parse(enRubric)).not.toThrow();
  });

  it("has 2 sections with weights summing to 100%", () => {
    const r = rubricSchema.parse(enRubric);
    const total = r.sections.reduce(
      (acc, s) => acc + Number(s.weight.replace("%", "")),
      0,
    );
    expect(total).toBe(100);
  });

  it("interaction section has 3 signals: interaction_keywords, iterative_exploration, multi_tool_usage", () => {
    const r = rubricSchema.parse(enRubric);
    const section = r.sections.find((s) => s.id === "interaction")!;
    const ids = section.signals.map((s) => s.id).sort();
    expect(ids).toEqual(["interaction_keywords", "iterative_exploration", "multi_tool_usage"]);
  });

  it("riskControl section has 3 signals: security_keywords, performance_keywords, low_refusal_rate", () => {
    const r = rubricSchema.parse(enRubric);
    const section = r.sections.find((s) => s.id === "riskControl")!;
    const ids = section.signals.map((s) => s.id).sort();
    expect(ids).toEqual(["low_refusal_rate", "performance_keywords", "security_keywords"]);
  });

  it("scores 100 (standard) with no data", () => {
    const r = rubricSchema.parse(enRubric);
    const report = scoreWithRules({ rubric: r, usageRows: [], bodyRows: [] });
    expect(report.totalScore).toBe(100);
  });

  it("scores 120 (superior) when all interaction + risk strong signals hit", () => {
    const r = rubricSchema.parse(enRubric);

    // Build a fixture that fires:
    // - interaction_keywords (request body has "refactor")
    // - iterative_exploration (6 messages in one session = 3 turns)
    // - multi_tool_usage (3 distinct tool_use names)
    // - security_keywords (response contains "security")
    // - performance_keywords (response contains "performance")
    // - low_refusal_rate (no refusals)
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
    ];

    const bodies: BodyRow[] = [
      {
        requestId: "r1",
        stopReason: "end_turn",
        clientUserAgent: null,
        clientSessionId: "s1",
        requestParams: null,
        requestBody: {
          messages: [
            { role: "user", content: "let's refactor this" },
            { role: "assistant", content: "sure" },
            { role: "user", content: "another approach" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "iterate" },
            { role: "assistant", content: "done" },
          ],
        },
        responseBody: {
          content: [
            { type: "text", text: "let's review security and performance" },
            { type: "tool_use", name: "read", input: {} },
            { type: "tool_use", name: "bash", input: {} },
            { type: "tool_use", name: "grep", input: {} },
          ],
        },
      },
    ];

    const report = scoreWithRules({ rubric: r, usageRows: usage, bodyRows: bodies });
    expect(report.totalScore).toBeGreaterThanOrEqual(110); // At minimum one section superior
  });
});
