import { describe, it, expect } from "vitest";
import { aggregate } from "../../src/metrics/aggregator";
import type { UsageRow, BodyRow } from "../../src/signals/types";

function row(partial: Partial<UsageRow> = {}): UsageRow {
  return {
    requestId: "r1",
    requestedModel: "claude-sonnet-4",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCost: 0.01,
    ...partial,
  };
}

function body(partial: Partial<BodyRow> = {}): BodyRow {
  return {
    requestId: "r1",
    stopReason: "stop",
    clientUserAgent: "claude-code/1.0",
    clientSessionId: "s1",
    requestParams: {},
    responseBody: null,
    requestBody: null,
    ...partial,
  };
}

describe("aggregate", () => {
  it("returns all-zero metrics for empty input", () => {
    const m = aggregate({ usageRows: [], bodyRows: [] });
    expect(m.requests).toBe(0);
    expect(m.total_cost).toBe(0);
    expect(m.cache_read_ratio).toBe(0);
    expect(m.body_capture_coverage).toBe(0);
    expect(m.model_mix).toEqual({});
    expect(m.client_mix).toEqual({});
  });

  it("sums token + cost fields correctly", () => {
    const u = [
      row({ inputTokens: 100, outputTokens: 50, totalCost: 0.01 }),
      row({ inputTokens: 200, outputTokens: 75, totalCost: 0.02 }),
    ];
    const m = aggregate({ usageRows: u, bodyRows: [] });
    expect(m.requests).toBe(2);
    expect(m.input_tokens).toBe(300);
    expect(m.output_tokens).toBe(125);
    expect(m.total_cost).toBeCloseTo(0.03, 10);
  });

  it("computes cache_read_ratio as cacheRead / (input + cacheRead)", () => {
    const u = [row({ inputTokens: 100, cacheReadTokens: 900 })];
    const m = aggregate({ usageRows: u, bodyRows: [] });
    expect(m.cache_read_ratio).toBeCloseTo(0.9, 10);
  });

  it("returns 0 cache_read_ratio when denominator is 0", () => {
    const u = [row({ inputTokens: 0, cacheReadTokens: 0 })];
    const m = aggregate({ usageRows: u, bodyRows: [] });
    expect(m.cache_read_ratio).toBe(0);
  });

  it("builds model_mix frequency table and model_diversity count", () => {
    const u = [
      row({ requestedModel: "claude-sonnet-4" }),
      row({ requestedModel: "claude-sonnet-4" }),
      row({ requestedModel: "claude-opus-4" }),
    ];
    const m = aggregate({ usageRows: u, bodyRows: [] });
    expect(m.model_mix).toEqual({ "claude-sonnet-4": 2, "claude-opus-4": 1 });
    expect(m.model_diversity).toBe(2);
  });

  it("buckets client_user_agent and computes client_mix_ratio", () => {
    const b = [
      body({ clientUserAgent: "claude-code/1.0" }),
      body({ clientUserAgent: "claude-code/2.0" }),
      body({ clientUserAgent: "cursor/0.42" }),
      body({ clientUserAgent: null }),
    ];
    const m = aggregate({ usageRows: [], bodyRows: b });
    expect(m.client_mix["claude-code"]).toBe(2);
    expect(m.client_mix["cursor"]).toBe(1);
    expect(m.client_mix["other"]).toBe(1);
    expect(m.client_mix_ratio).toBeCloseTo(0.5, 5); // 2/4
  });

  it("computes refusal_rate", () => {
    const b = [
      body({ stopReason: "refusal" }),
      body({ stopReason: "stop" }),
      body({ stopReason: "stop" }),
      body({ stopReason: "stop" }),
    ];
    const m = aggregate({ usageRows: [], bodyRows: b });
    expect(m.refusal_rate).toBeCloseTo(0.25, 10);
  });

  it("computes body_capture_coverage", () => {
    const u = [row({ requestId: "r1" }), row({ requestId: "r2" })];
    const b = [body({ requestId: "r1" })];
    const m = aggregate({ usageRows: u, bodyRows: b });
    expect(m.body_capture_coverage).toBe(0.5);
  });

  it("computes tool_diversity across bodies", () => {
    const b = [
      body({ responseBody: { content: [{ type: "tool_use", name: "bash" }] } }),
      body({ responseBody: { content: [{ type: "tool_use", name: "read" }, { type: "tool_use", name: "bash" }] } }),
    ];
    const m = aggregate({ usageRows: [], bodyRows: b });
    expect(m.tool_diversity).toBe(2);
  });

  it("computes iteration_count as max ceil(messages.length/2) per session", () => {
    const b = [
      body({
        clientSessionId: "s1",
        requestBody: { messages: [{}, {}, {}, {}, {}, {}] },
      }),
      body({
        clientSessionId: "s2",
        requestBody: { messages: [{}, {}] },
      }),
    ];
    const m = aggregate({ usageRows: [], bodyRows: b });
    expect(m.iteration_count).toBe(3); // max is s1: ceil(6/2) = 3
  });

  it("coerces string totalCost (Drizzle decimal) to number", () => {
    const u = [row({ totalCost: "0.42" as unknown as number })];
    const m = aggregate({ usageRows: u, bodyRows: [] });
    expect(m.total_cost).toBeCloseTo(0.42, 10);
  });
});
