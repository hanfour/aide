import { describe, it, expect } from "vitest";
import { collectExtendedThinking } from "../../src/signals/extendedThinking";
import type { BodyRow } from "../../src/signals/types";

function makeBody(requestParams: unknown): BodyRow {
  return {
    requestId: "req-1",
    stopReason: null,
    clientUserAgent: null,
    clientSessionId: null,
    requestParams,
    responseBody: null,
    requestBody: null,
  };
}

describe("collectExtendedThinking", () => {
  it("returns hit:false and value:0 when no bodies have thinking budget", () => {
    const bodies = [
      makeBody({ model: "claude-opus-4" }),
      makeBody(null),
    ];
    const r = collectExtendedThinking({ bodies, minCount: 1 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("counts bodies with thinking.budget_tokens > 0", () => {
    const bodies = [
      makeBody({ thinking: { budget_tokens: 5000 } }),
      makeBody({ thinking: { budget_tokens: 1000 } }),
      makeBody({ thinking: { budget_tokens: 0 } }),
    ];
    const r = collectExtendedThinking({ bodies, minCount: 2 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(2);
  });

  it("handles malformed requestParams gracefully (null, non-object, missing thinking)", () => {
    const bodies = [
      makeBody(null),
      makeBody(undefined),
      makeBody("not-an-object"),
      makeBody(42),
      makeBody({ thinking: null }),
      makeBody({ thinking: { budget_tokens: -1 } }),
    ];
    const r = collectExtendedThinking({ bodies, minCount: 1 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("returns hit:true when count exactly meets minCount", () => {
    const bodies = [
      makeBody({ thinking: { budget_tokens: 10000 } }),
    ];
    const r = collectExtendedThinking({ bodies, minCount: 1 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(1);
  });

  it("returns hit:false when count is below minCount", () => {
    const bodies = [
      makeBody({ thinking: { budget_tokens: 5000 } }),
      makeBody({ model: "claude-opus" }),
    ];
    const r = collectExtendedThinking({ bodies, minCount: 2 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(1);
  });
});
