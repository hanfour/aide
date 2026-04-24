import { describe, it, expect } from "vitest";
import { parseLlmResponse } from "../../src/llm/responseParser";

describe("parseLlmResponse", () => {
  it("accepts a valid response object", () => {
    const r = parseLlmResponse({
      narrative: "Strong engagement across refusals and tool usage.",
      evidence: [
        { quote: "can we compare?", requestId: "r1", rationale: "option-seeking" },
      ],
      sectionAdjustments: [
        { sectionId: "interaction", adjustment: 5, rationale: "clear options" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.narrative).toContain("Strong engagement");
      expect(r.evidence).toHaveLength(1);
      expect(r.sectionAdjustments).toHaveLength(1);
    }
  });

  it("accepts a JSON string and parses it", () => {
    const raw = JSON.stringify({
      narrative: "ok",
      evidence: [],
      sectionAdjustments: [],
    });
    const r = parseLlmResponse(raw);
    expect(r.ok).toBe(true);
  });

  it("accepts JSON wrapped in markdown code fences", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        narrative: "fenced",
        evidence: [],
        sectionAdjustments: [],
      }) +
      "\n```";
    const r = parseLlmResponse(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.narrative).toBe("fenced");
  });

  it("returns ok:false on malformed JSON string", () => {
    const r = parseLlmResponse("{not json at all");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/json|parse/i);
  });

  it("returns ok:false on missing narrative", () => {
    const r = parseLlmResponse({ evidence: [], sectionAdjustments: [] });
    expect(r.ok).toBe(false);
  });

  it("returns ok:false on non-numeric adjustment", () => {
    const r = parseLlmResponse({
      narrative: "n",
      evidence: [],
      sectionAdjustments: [
        { sectionId: "x", adjustment: "high" as unknown as number, rationale: "r" },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("clamps adjustment outside [-10, 10] by rejecting", () => {
    const r = parseLlmResponse({
      narrative: "n",
      evidence: [],
      sectionAdjustments: [{ sectionId: "x", adjustment: 50, rationale: "r" }],
    });
    expect(r.ok).toBe(false);
  });

  it("never throws on any input — null, undefined, arrays", () => {
    expect(() => parseLlmResponse(null)).not.toThrow();
    expect(() => parseLlmResponse(undefined)).not.toThrow();
    expect(() => parseLlmResponse([])).not.toThrow();
    expect(() => parseLlmResponse(42)).not.toThrow();
    expect(parseLlmResponse(null).ok).toBe(false);
    expect(parseLlmResponse(undefined).ok).toBe(false);
  });
});
