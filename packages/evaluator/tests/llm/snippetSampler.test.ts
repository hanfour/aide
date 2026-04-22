import { describe, it, expect } from "vitest";
import { sampleSnippets } from "../../src/llm/snippetSampler";
import type { BodyRow } from "../../src/signals/types";

function mkBody(overrides: Partial<BodyRow> & { requestId: string }): BodyRow {
  return {
    requestId: overrides.requestId,
    stopReason: overrides.stopReason ?? null,
    clientUserAgent: overrides.clientUserAgent ?? null,
    clientSessionId: overrides.clientSessionId ?? null,
    requestParams: overrides.requestParams ?? {},
    requestBody: overrides.requestBody ?? {
      model: "claude-sonnet",
      messages: [],
    },
    responseBody: overrides.responseBody ?? {
      content: [{ type: "text", text: "ok" }],
    },
  };
}

describe("sampleSnippets", () => {
  it("Phase 1: picks refusal bodies first", () => {
    const bodies: BodyRow[] = [
      mkBody({ requestId: "r1", stopReason: "refusal" }),
      mkBody({ requestId: "r2", stopReason: "end_turn" }),
      mkBody({ requestId: "r3", stopReason: "refusal" }),
    ];
    const snippets = sampleSnippets({ bodies });
    const reasons = snippets.map((s) => s.reason);
    expect(reasons.filter((r) => r === "refusal")).toHaveLength(2);
    expect(snippets.find((s) => s.requestId === "r1")).toBeDefined();
    expect(snippets.find((s) => s.requestId === "r3")).toBeDefined();
  });

  it("Phase 2: picks bodies with extended thinking (budget_tokens > 0)", () => {
    const bodies: BodyRow[] = [
      mkBody({
        requestId: "t1",
        requestParams: { thinking: { budget_tokens: 5000 } },
      }),
      mkBody({
        requestId: "t2",
        requestParams: { thinking: { budget_tokens: 0 } },
      }),
      mkBody({ requestId: "t3", requestParams: {} }),
    ];
    const snippets = sampleSnippets({ bodies });
    const thinkingSnippet = snippets.find((s) => s.reason === "thinking");
    expect(thinkingSnippet).toBeDefined();
    expect(thinkingSnippet?.requestId).toBe("t1");
    expect(
      snippets.find((s) => s.requestId === "t2" && s.reason === "thinking"),
    ).toBeUndefined();
  });

  it("Phase 3: picks first and last request of each session", () => {
    const bodies: BodyRow[] = [
      mkBody({ requestId: "s1a", clientSessionId: "sessionA" }),
      mkBody({ requestId: "s1b", clientSessionId: "sessionA" }),
      mkBody({ requestId: "s1c", clientSessionId: "sessionA" }),
      mkBody({ requestId: "s2a", clientSessionId: "sessionB" }),
    ];
    const snippets = sampleSnippets({ bodies });
    const reasonMap = new Map(snippets.map((s) => [s.requestId, s.reason]));
    expect(reasonMap.get("s1a")).toBe("session_first");
    expect(reasonMap.get("s1c")).toBe("session_last");
    // sessionB only has one item so it appears only as session_first
    expect(reasonMap.get("s2a")).toBe("session_first");
    // s1b is the middle body of sessionA — NOT first/last. Phase 5 may pick it
    // as random fill (bodies < MAX_SNIPPETS), but its reason must not be
    // session_first or session_last.
    const s1bReason = reasonMap.get("s1b");
    expect(s1bReason === undefined || s1bReason === "random").toBe(true);
  });

  it("Phase 4: picks bodies with tool_use in response", () => {
    // Arrange so the tool_use body is the MIDDLE of a session — Phase 3 claims
    // first/last, leaving the middle for Phase 4 to attribute as tool_use.
    const bodies: BodyRow[] = [
      mkBody({ requestId: "decoy_first", clientSessionId: "sA" }),
      mkBody({
        requestId: "u1",
        clientSessionId: "sA",
        responseBody: {
          content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
        },
      }),
      mkBody({ requestId: "decoy_last", clientSessionId: "sA" }),
    ];
    const snippets = sampleSnippets({ bodies });
    const toolSnippet = snippets.find((s) => s.reason === "tool_use");
    expect(toolSnippet).toBeDefined();
    expect(toolSnippet?.requestId).toBe("u1");
  });

  it("Phase 5: random fill is deterministic with same seed", () => {
    const bodies: BodyRow[] = Array.from({ length: 30 }, (_, i) =>
      mkBody({ requestId: `r${i}` }),
    );
    const result1 = sampleSnippets({ bodies, seed: 42 });
    const result2 = sampleSnippets({ bodies, seed: 42 });
    expect(result1.map((s) => s.requestId)).toEqual(
      result2.map((s) => s.requestId),
    );
  });

  it("caps output at MAX_SNIPPETS = 20", () => {
    const bodies: BodyRow[] = Array.from({ length: 50 }, (_, i) =>
      mkBody({ requestId: `r${i}` }),
    );
    const snippets = sampleSnippets({ bodies });
    expect(snippets.length).toBeLessThanOrEqual(20);
  });

  it("deduplicates: same body appears only once even if matching multiple phases", () => {
    // r1 is both a refusal AND the first of its session AND has tool_use
    const bodies: BodyRow[] = [
      mkBody({
        requestId: "r1",
        stopReason: "refusal",
        clientSessionId: "sessionX",
        responseBody: {
          content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
        },
      }),
      mkBody({ requestId: "r2", clientSessionId: "sessionX" }),
    ];
    const snippets = sampleSnippets({ bodies });
    const r1Snippets = snippets.filter((s) => s.requestId === "r1");
    expect(r1Snippets).toHaveLength(1);
  });

  it("attaches capturedAt from capturedAtMap when provided", () => {
    const bodies: BodyRow[] = [
      mkBody({ requestId: "r1", stopReason: "refusal" }),
    ];
    const capturedAtMap = new Map([["r1", "2026-04-22T12:00:00Z"]]);
    const snippets = sampleSnippets({ bodies, capturedAtMap });
    expect(snippets[0]?.capturedAt).toBe("2026-04-22T12:00:00Z");
  });

  it("truncates excerpts to 1024 characters with marker", () => {
    const longText = "x".repeat(2000);
    const bodies: BodyRow[] = [
      mkBody({
        requestId: "r1",
        stopReason: "refusal",
        requestBody: { messages: [{ role: "user", content: longText }] },
        responseBody: { content: [{ type: "text", text: longText }] },
      }),
    ];
    const snippets = sampleSnippets({ bodies });
    expect(snippets[0]?.requestExcerpt.length).toBeLessThanOrEqual(1024);
    expect(snippets[0]?.requestExcerpt).toContain("...[truncated]");
    expect(snippets[0]?.responseExcerpt.length).toBeLessThanOrEqual(1024);
    expect(snippets[0]?.responseExcerpt).toContain("...[truncated]");
  });
});
