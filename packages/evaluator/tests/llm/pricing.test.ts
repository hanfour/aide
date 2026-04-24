import { describe, it, expect } from "vitest";
import { PRICING, calculateCost } from "../../src/llm/pricing";

describe("calculateCost", () => {
  it("computes haiku cost correctly for 1M in / 1M out", () => {
    // haiku: $0.80/MTok input, $4/MTok output
    // 1M + 1M = $0.80 + $4.00 = $4.80
    expect(calculateCost("claude-haiku-4-5", 1_000_000, 1_000_000)).toBeCloseTo(4.80, 6);
  });

  it("computes sonnet cost for 1M in / 1M out", () => {
    // sonnet: $3/MTok input, $15/MTok output
    expect(calculateCost("claude-sonnet-4-6", 1_000_000, 1_000_000)).toBeCloseTo(18.00, 6);
  });

  it("computes opus cost for 1M in / 1M out", () => {
    // opus: $15/MTok input, $75/MTok output
    expect(calculateCost("claude-opus-4-7", 1_000_000, 1_000_000)).toBeCloseTo(90.00, 6);
  });

  it("scales linearly for smaller token counts", () => {
    // 1k in + 1k out on haiku = $0.80/1000 + $4/1000 = $0.0008 + $0.004 = $0.0048
    expect(calculateCost("claude-haiku-4-5", 1000, 1000)).toBeCloseTo(0.0048, 6);
  });

  it("returns 0 for 0 tokens", () => {
    expect(calculateCost("claude-haiku-4-5", 0, 0)).toBe(0);
  });

  it("handles input-only calls (0 output)", () => {
    expect(calculateCost("claude-haiku-4-5", 1_000_000, 0)).toBeCloseTo(0.80, 6);
  });

  it("throws for unknown model", () => {
    expect(() => calculateCost("gpt-4", 100, 100)).toThrow(/Unknown model for pricing: gpt-4/);
  });

  it("exposes PRICING map with all 3 Claude models", () => {
    expect(Object.keys(PRICING).sort()).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-7",
      "claude-sonnet-4-6",
    ]);
  });
});
