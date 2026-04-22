import { describe, it, expect } from "vitest";
import { rubricSchema } from "../src/rubric/schema";

describe("rubricSchema", () => {
  const valid = {
    name: "test",
    version: "1.0.0",
    sections: [
      {
        id: "interaction",
        name: "Interaction",
        weight: "50%",
        standard: { score: 100, label: "Standard", criteria: ["c1"] },
        superior: { score: 120, label: "Superior", criteria: ["c2"] },
        signals: [
          {
            type: "keyword",
            id: "kw1",
            in: "request_body",
            terms: ["option", "compare"],
          },
          {
            type: "threshold",
            id: "th1",
            metric: "cache_read_ratio",
            gte: 0.2,
          },
        ],
      },
    ],
  };

  it("accepts valid rubric", () => {
    expect(() => rubricSchema.parse(valid)).not.toThrow();
  });

  it("rejects non-percent weight", () => {
    const bad = {
      ...valid,
      sections: [{ ...valid.sections[0], weight: "0.5" }],
    };
    expect(() => rubricSchema.parse(bad)).toThrow();
  });

  it("rejects unknown signal type", () => {
    const bad = {
      ...valid,
      sections: [
        {
          ...valid.sections[0],
          signals: [{ type: "weird", id: "x" }],
        },
      ],
    };
    expect(() => rubricSchema.parse(bad)).toThrow();
  });

  it("accepts all 9 signal types as discriminated union", () => {
    const allTypes = {
      ...valid,
      sections: [
        {
          ...valid.sections[0],
          signals: [
            {
              type: "keyword",
              id: "k1",
              in: "both",
              terms: ["a"],
            },
            {
              type: "threshold",
              id: "t1",
              metric: "cache_read_ratio",
              gte: 0.1,
            },
            { type: "refusal_rate", id: "rr1", lte: 0.1 },
            {
              type: "client_mix",
              id: "cm1",
              expect: ["claude-code"],
              minRatio: 0.5,
            },
            { type: "model_diversity", id: "md1", gte: 2 },
            { type: "cache_read_ratio", id: "crr1", gte: 0.2 },
            { type: "extended_thinking_used", id: "et1", minCount: 1 },
            { type: "tool_diversity", id: "td1", gte: 2 },
            { type: "iteration_count", id: "ic1", gte: 3 },
          ],
        },
      ],
    };
    expect(() => rubricSchema.parse(allTypes)).not.toThrow();
  });

  it("accepts optional superiorRules with default minStrongHits/minSupportHits", () => {
    const withRules = {
      ...valid,
      sections: [
        {
          ...valid.sections[0],
          superiorRules: {
            strongThresholds: ["kw1"],
            supportThresholds: ["th1"],
          },
        },
      ],
    };
    const parsed = rubricSchema.parse(withRules);
    expect(parsed.sections[0]?.superiorRules?.minStrongHits).toBe(1);
    expect(parsed.sections[0]?.superiorRules?.minSupportHits).toBe(1);
  });

  it("locale defaults to 'en'", () => {
    const parsed = rubricSchema.parse(valid);
    expect(parsed.locale).toBe("en");
  });
});
