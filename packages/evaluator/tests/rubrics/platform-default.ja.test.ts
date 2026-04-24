import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rubricSchema } from "../../src";
import {
  assertPlatformDefaultStructure,
  scoreStandard,
  scoreSuperior,
} from "./platform-default-helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const jaRubric = JSON.parse(
  readFileSync(
    join(__dirname, "../../rubrics/platform-default.ja.json"),
    "utf-8",
  ),
) as unknown;

describe("platform-default.ja rubric", () => {
  it("validates against rubricSchema", () => {
    expect(() => rubricSchema.parse(jaRubric)).not.toThrow();
  });

  it("locale field is 'ja'", () => {
    const r = rubricSchema.parse(jaRubric);
    expect(r.locale).toBe("ja");
  });

  it("has 2 sections with weights summing to 100%", () => {
    const r = rubricSchema.parse(jaRubric);
    const total = r.sections.reduce(
      (acc, s) => acc + Number(s.weight.replace("%", "")),
      0,
    );
    expect(total).toBe(100);
  });

  it("has same 2 section IDs as en rubric", () => {
    const r = rubricSchema.parse(jaRubric);
    const ids = r.sections.map((s) => s.id);
    expect(ids).toEqual(["interaction", "riskControl"]);
  });

  it("interaction section has same 3 signal IDs as en rubric", () => {
    const r = rubricSchema.parse(jaRubric);
    const section = r.sections.find((s) => s.id === "interaction")!;
    const ids = section.signals.map((s) => s.id).sort();
    expect(ids).toEqual([
      "interaction_keywords",
      "iterative_exploration",
      "multi_tool_usage",
    ]);
  });

  it("riskControl section has same 3 signal IDs as en rubric", () => {
    const r = rubricSchema.parse(jaRubric);
    const section = r.sections.find((s) => s.id === "riskControl")!;
    const ids = section.signals.map((s) => s.id).sort();
    expect(ids).toEqual(["low_refusal_rate", "performance_keywords", "security_keywords"]);
  });

  it("both sections have superiorRules defined", () => {
    assertPlatformDefaultStructure(jaRubric);
  });

  it("scores 100 (standard) with no data — parity with en rubric", () => {
    expect(scoreStandard(jaRubric)).toBe(100);
  });

  it("scores >= 110 (superior path) when strong signals fire — parity with en rubric", () => {
    expect(scoreSuperior(jaRubric)).toBeGreaterThanOrEqual(110);
  });

  it("section names are translated to 日本語", () => {
    const r = rubricSchema.parse(jaRubric);
    const interactionSection = r.sections.find((s) => s.id === "interaction")!;
    const riskSection = r.sections.find((s) => s.id === "riskControl")!;
    expect(interactionSection.name).toBe("AI対話と意思決定");
    expect(riskSection.name).toBe("AI識別とリスク管理");
  });

  it("interaction_keywords include Japanese variants (オプション, 代替案, リファクタリング)", () => {
    const r = rubricSchema.parse(jaRubric);
    const section = r.sections.find((s) => s.id === "interaction")!;
    const kwSignal = section.signals.find((s) => s.id === "interaction_keywords")!;
    expect(kwSignal.type).toBe("keyword");
    if (kwSignal.type === "keyword") {
      expect(kwSignal.terms).toContain("オプション");
      expect(kwSignal.terms).toContain("代替案");
      expect(kwSignal.terms).toContain("リファクタリング");
    }
  });

  it("security_keywords include Japanese variants (セキュリティ, 脆弱性)", () => {
    const r = rubricSchema.parse(jaRubric);
    const section = r.sections.find((s) => s.id === "riskControl")!;
    const kwSignal = section.signals.find((s) => s.id === "security_keywords")!;
    expect(kwSignal.type).toBe("keyword");
    if (kwSignal.type === "keyword") {
      expect(kwSignal.terms).toContain("セキュリティ");
      expect(kwSignal.terms).toContain("脆弱性");
    }
  });

  it("performance_keywords include Japanese variants (パフォーマンス, ボトルネック)", () => {
    const r = rubricSchema.parse(jaRubric);
    const section = r.sections.find((s) => s.id === "riskControl")!;
    const kwSignal = section.signals.find((s) => s.id === "performance_keywords")!;
    expect(kwSignal.type).toBe("keyword");
    if (kwSignal.type === "keyword") {
      expect(kwSignal.terms).toContain("パフォーマンス");
      expect(kwSignal.terms).toContain("ボトルネック");
    }
  });
});
