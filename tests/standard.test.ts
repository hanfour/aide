import { describe, it, expect, vi } from "vitest";
import { join } from "path";
import { loadStandard, getDefaultStandard } from "../src/standard.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("loadStandard", () => {
  it("returns default standard when no path given", () => {
    const std = loadStandard();
    expect(std.name).toBe("OneAD R&D AI-Application Evaluation Standard");
    expect(std.sections.length).toBeGreaterThanOrEqual(2);
  });

  it("loads valid custom standard", () => {
    const std = loadStandard(join(FIXTURES, "valid-standard.json"));
    expect(std.name).toBe("Test Standard");
    expect(std.sections).toHaveLength(1);
    expect(std.sections[0].id).toBe("quality");
    expect(std.sections[0].thresholds.keywordHits).toBe(3);
  });

  it("warns on superiorRules referencing non-existent threshold keys", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const std = loadStandard(join(FIXTURES, "invalid-standard-bad-ref.json"));
    expect(std.name).toBe("Bad Ref Standard");
    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("nonExistentKey"))).toBe(true);
    expect(calls.some((c) => c.includes("alsoMissing"))).toBe(true);
    spy.mockRestore();
  });

  it("falls back to default on malformed file", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const std = loadStandard("/nonexistent/path.json");
    expect(std.name).toBe("OneAD R&D AI-Application Evaluation Standard");
    spy.mockRestore();
  });

  it("applies default noise filters to custom standard", () => {
    const std = loadStandard(join(FIXTURES, "valid-standard.json"));
    // Custom standard should get default noise filters merged
    expect(std.noiseFilters?.prefixes).toContain("<system>");
  });
});

describe("getDefaultStandard", () => {
  it("returns the same object as loadStandard with no path", () => {
    const a = getDefaultStandard();
    const b = loadStandard();
    expect(a).toBe(b);
  });

  it("has valid superiorRules referencing existing thresholds", () => {
    const std = getDefaultStandard();
    for (const sec of std.sections) {
      const thresholdKeys = new Set(Object.keys(sec.thresholds));
      if (sec.superiorRules) {
        for (const ref of [
          ...(sec.superiorRules.strongThresholds ?? []),
          ...(sec.superiorRules.supportThresholds ?? []),
        ]) {
          expect(thresholdKeys.has(ref)).toBe(true);
        }
      }
    }
  });
});
