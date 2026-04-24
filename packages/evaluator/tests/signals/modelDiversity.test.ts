import { describe, it, expect } from "vitest";
import { collectModelDiversity } from "../../src/signals/modelDiversity";
import type { UsageRow } from "../../src/signals/types";

function makeUsage(requestedModel: string): UsageRow {
  return {
    requestId: "req-1",
    requestedModel,
    inputTokens: 100,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCost: 0,
  };
}

describe("collectModelDiversity", () => {
  it("returns hit:false and value:0 when usage is empty", () => {
    const r = collectModelDiversity({ usage: [], gte: 1 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("returns hit:true when exactly 1 distinct model and gte is 1", () => {
    const usage: UsageRow[] = [
      makeUsage("claude-3-5-sonnet"),
      makeUsage("claude-3-5-sonnet"),
    ];
    const r = collectModelDiversity({ usage, gte: 1 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(1);
  });

  it("returns hit:true with value=3 when 3 distinct models", () => {
    const usage: UsageRow[] = [
      makeUsage("claude-opus-4"),
      makeUsage("claude-sonnet-4-5"),
      makeUsage("claude-haiku-4-5"),
      makeUsage("claude-opus-4"),
    ];
    const r = collectModelDiversity({ usage, gte: 3 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(3);
  });

  it("returns hit:false when distinct model count is less than gte", () => {
    const usage: UsageRow[] = [
      makeUsage("claude-opus-4"),
      makeUsage("claude-sonnet-4-5"),
    ];
    const r = collectModelDiversity({ usage, gte: 3 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(2);
  });
});
