import { describe, it, expect } from "vitest";
import { collectCacheReadRatio } from "../../src/signals/cacheReadRatio";
import type { UsageRow } from "../../src/signals/types";

function makeUsage(inputTokens: number, cacheReadTokens: number): UsageRow {
  return {
    requestId: "req-1",
    requestedModel: "claude-sonnet-4-5",
    inputTokens,
    outputTokens: 0,
    cacheReadTokens,
    cacheCreationTokens: 0,
    totalCost: 0,
  };
}

describe("collectCacheReadRatio", () => {
  it("returns hit:false and value:0 when all tokens are zero", () => {
    const r = collectCacheReadRatio({ usage: [makeUsage(0, 0)], gte: 0.5 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("returns hit:true when cache read ratio is high", () => {
    const usage: UsageRow[] = [makeUsage(100, 900)];
    const r = collectCacheReadRatio({ usage, gte: 0.8 });
    expect(r.hit).toBe(true);
    expect(r.value).toBeCloseTo(0.9);
  });

  it("returns hit:false when cache read ratio is low", () => {
    const usage: UsageRow[] = [makeUsage(900, 100)];
    const r = collectCacheReadRatio({ usage, gte: 0.5 });
    expect(r.hit).toBe(false);
    expect(r.value).toBeCloseTo(0.1);
  });

  it("returns hit:false and value:0 when usage is empty", () => {
    const r = collectCacheReadRatio({ usage: [], gte: 0.5 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("aggregates tokens across multiple rows", () => {
    const usage: UsageRow[] = [makeUsage(200, 300), makeUsage(100, 400)];
    // total input = 300, total cache = 700, denom = 1000, ratio = 0.7
    const r = collectCacheReadRatio({ usage, gte: 0.6 });
    expect(r.hit).toBe(true);
    expect(r.value).toBeCloseTo(0.7);
  });
});
