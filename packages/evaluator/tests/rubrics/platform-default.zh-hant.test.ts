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

const zhHantRubric = JSON.parse(
  readFileSync(
    join(__dirname, "../../rubrics/platform-default.zh-hant.json"),
    "utf-8",
  ),
) as unknown;

describe("platform-default.zh-hant rubric", () => {
  it("validates against rubricSchema", () => {
    expect(() => rubricSchema.parse(zhHantRubric)).not.toThrow();
  });

  it("locale field is 'zh-Hant'", () => {
    const r = rubricSchema.parse(zhHantRubric);
    expect(r.locale).toBe("zh-Hant");
  });

  it("has 2 sections with weights summing to 100%", () => {
    const r = rubricSchema.parse(zhHantRubric);
    const total = r.sections.reduce(
      (acc, s) => acc + Number(s.weight.replace("%", "")),
      0,
    );
    expect(total).toBe(100);
  });

  it("has same 2 section IDs as en rubric", () => {
    const r = rubricSchema.parse(zhHantRubric);
    const ids = r.sections.map((s) => s.id);
    expect(ids).toEqual(["interaction", "riskControl"]);
  });

  it("interaction section has same 3 signal IDs as en rubric", () => {
    const r = rubricSchema.parse(zhHantRubric);
    const section = r.sections.find((s) => s.id === "interaction")!;
    const ids = section.signals.map((s) => s.id).sort();
    expect(ids).toEqual([
      "interaction_keywords",
      "iterative_exploration",
      "multi_tool_usage",
    ]);
  });

  it("riskControl section has same 3 signal IDs as en rubric", () => {
    const r = rubricSchema.parse(zhHantRubric);
    const section = r.sections.find((s) => s.id === "riskControl")!;
    const ids = section.signals.map((s) => s.id).sort();
    expect(ids).toEqual(["low_refusal_rate", "performance_keywords", "security_keywords"]);
  });

  it("both sections have superiorRules defined", () => {
    assertPlatformDefaultStructure(zhHantRubric);
  });

  it("scores 100 (standard) with no data — parity with en rubric", () => {
    expect(scoreStandard(zhHantRubric)).toBe(100);
  });

  it("scores >= 110 (superior path) when strong signals fire — parity with en rubric", () => {
    expect(scoreSuperior(zhHantRubric)).toBeGreaterThanOrEqual(110);
  });

  it("section names are translated to 繁體中文", () => {
    const r = rubricSchema.parse(zhHantRubric);
    const interactionSection = r.sections.find((s) => s.id === "interaction")!;
    const riskSection = r.sections.find((s) => s.id === "riskControl")!;
    expect(interactionSection.name).toBe("AI 交互與決策");
    expect(riskSection.name).toBe("AI 識別與風險控管");
  });
});
