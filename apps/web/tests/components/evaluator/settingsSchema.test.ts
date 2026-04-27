import { describe, it, expect } from "vitest";
import {
  settingsSchema,
  type SettingsFormValues,
} from "@/components/evaluator/settingsSchema";

// A baseline that satisfies every required boolean/enum field. Individual
// tests override specific fields to exercise Plan 4C cross-field rules.
const baseValues: SettingsFormValues = {
  contentCaptureEnabled: false,
  retentionDaysOverride: null,
  llmEvalEnabled: false,
  llmEvalAccountId: null,
  llmEvalModel: null,
  captureThinking: false,
  rubricId: null,
  leaderboardEnabled: false,
  llmFacetEnabled: false,
  llmFacetModel: null,
  llmMonthlyBudgetUsd: null,
  llmBudgetOverageBehavior: "degrade",
};

describe("settingsSchema", () => {
  it("parses a baseline valid settings object (no facet, no budget)", () => {
    const result = settingsSchema.safeParse(baseValues);
    expect(result.success).toBe(true);
  });

  it("rejects llmFacetEnabled=true when llmEvalEnabled=false", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmFacetEnabled: true,
      llmFacetModel: "claude-haiku-4-5",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("llmFacetEnabled"),
      );
      expect(issue?.message).toMatch(/requires LLM evaluation/i);
    }
  });

  it("rejects llmFacetEnabled=true when llmFacetModel is null", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmEvalEnabled: true,
      llmFacetEnabled: true,
      llmFacetModel: null,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("llmFacetModel"),
      );
      expect(issue?.message).toMatch(/Choose a facet model/i);
    }
  });

  it("accepts llmFacetEnabled=true when llmEvalEnabled=true and a facet model is chosen", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmEvalEnabled: true,
      llmFacetEnabled: true,
      llmFacetModel: "claude-haiku-4-5",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a finite non-negative budget number", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmMonthlyBudgetUsd: 50,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null as budget (unlimited)", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmMonthlyBudgetUsd: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-number, non-null budget value", () => {
    // The schema is z.union([z.number(), z.null()]) — strings should fail.
    // (Negative numbers are validated server-side and by the form's setValueAs
    //  coercion, not by this client-side schema; the union accepts them.)
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmMonthlyBudgetUsd: "not-a-number" as unknown as number,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid llmBudgetOverageBehavior", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmBudgetOverageBehavior: "invalid" as unknown as "degrade",
    });
    expect(result.success).toBe(false);
  });

  it("accepts both halt and degrade for llmBudgetOverageBehavior", () => {
    expect(
      settingsSchema.safeParse({
        ...baseValues,
        llmBudgetOverageBehavior: "halt",
      }).success,
    ).toBe(true);
    expect(
      settingsSchema.safeParse({
        ...baseValues,
        llmBudgetOverageBehavior: "degrade",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown facet model", () => {
    const result = settingsSchema.safeParse({
      ...baseValues,
      llmEvalEnabled: true,
      llmFacetEnabled: true,
      llmFacetModel: "claude-bogus-9000" as unknown as "claude-haiku-4-5",
    });
    expect(result.success).toBe(false);
  });
});
