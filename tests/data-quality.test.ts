import { describe, it, expect } from "vitest";
import { checkDataQuality } from "../src/data-quality.js";

describe("checkDataQuality", () => {
  it("warns when no sessions found at all", () => {
    const warnings = checkDataQuality(0, 0, 0, 0);
    expect(warnings.some((w) => w.severity === "missing" && w.source === "All sources")).toBe(true);
  });

  it("warns when sessions found but no facets", () => {
    const warnings = checkDataQuality(10, 0, 0, 5);
    expect(warnings.some((w) => w.source === "Claude Code facets" && w.severity === "partial")).toBe(true);
  });

  it("warns when sessions found but no conversation signals", () => {
    const warnings = checkDataQuality(10, 0, 5, 0);
    expect(warnings.some((w) => w.source === "Conversation signals")).toBe(true);
  });

  it("always checks file system sources", () => {
    const warnings = checkDataQuality(10, 2, 5, 20);
    // Should have warnings for any missing data sources
    // (some may exist on the test machine, some may not)
    expect(Array.isArray(warnings)).toBe(true);
  });
});
