import { describe, it, expect } from "vitest";
import { truncate } from "../../src/capture/truncate.js";

describe("truncate", () => {
  it("passes through when under overall cap", () => {
    const r = truncate({
      requestBody: "small",
      responseBody: "also small",
    });
    expect(r.bodyTruncated).toBe(false);
    expect(r.toolResultTruncated).toBe(false);
    expect(r.requestBody).toBe("small");
    expect(r.responseBody).toBe("also small");
  });

  it("caps individual tool_result content blocks at perToolResultCap", () => {
    const bigTool = "x".repeat(20_000);
    const responseBody = JSON.stringify({
      content: [
        { type: "tool_result", tool_use_id: "t1", content: bigTool },
        { type: "text", text: "hello" },
      ],
    });
    const r = truncate({
      requestBody: "{}",
      responseBody,
      perToolResultCap: 16384,
    });
    expect(r.toolResultTruncated).toBe(true);
    const parsed = JSON.parse(r.responseBody);
    expect(parsed.content[0].content.length).toBeLessThanOrEqual(16384);
    expect(parsed.content[0].content).toContain("...[truncated]");
    // Text block untouched
    expect(parsed.content[1].text).toBe("hello");
  });

  it("drops responseBody tail first when over overall cap", () => {
    const r = truncate({
      requestBody: "req",
      responseBody: "x".repeat(300_000),
      overallCap: 100_000,
    });
    expect(r.bodyTruncated).toBe(true);
    expect(r.responseBody).toContain("...[truncated]");
    expect(r.requestBody).toBe("req");
  });

  it("drops thinking before attemptErrors (flipped priority)", () => {
    // Setup where responseBody reduction alone isn't enough
    const r = truncate({
      requestBody: "r",
      responseBody: "x".repeat(50_000),
      thinkingBody: "y".repeat(80_000),
      attemptErrors: "debug-context",
      overallCap: 10_000,
    });
    expect(r.bodyTruncated).toBe(true);
    // thinking should be dropped before errors
    expect(r.thinkingBody).toBeNull();
    expect(r.attemptErrors).toBe("debug-context");
  });

  it("drops attemptErrors last as last resort", () => {
    const r = truncate({
      requestBody: "r",
      responseBody: "x".repeat(50_000),
      thinkingBody: "y".repeat(50_000),
      attemptErrors: "z".repeat(50_000),
      overallCap: 1_000,
    });
    expect(r.bodyTruncated).toBe(true);
    expect(r.attemptErrors).toBeNull(); // Last to drop
  });

  it("leaves non-JSON bodies alone for tool_result capping", () => {
    const r = truncate({
      requestBody: "not json at all {",
      responseBody: "also not json",
    });
    expect(r.toolResultTruncated).toBe(false);
    expect(r.requestBody).toBe("not json at all {");
  });

  it("handles null thinkingBody and attemptErrors", () => {
    const r = truncate({
      requestBody: "a",
      responseBody: "b",
      thinkingBody: null,
      attemptErrors: null,
    });
    expect(r.thinkingBody).toBeNull();
    expect(r.attemptErrors).toBeNull();
  });

  it("UTF-8 safe truncation preserves character boundaries", () => {
    // Chinese characters are 3 bytes each in UTF-8
    const chinese = "測試".repeat(100_000);
    const r = truncate({
      requestBody: "r",
      responseBody: chinese,
      overallCap: 1000,
    });
    // Truncated output must be valid UTF-8 (no partial characters)
    expect(() =>
      Buffer.from(r.responseBody, "utf8").toString("utf8"),
    ).not.toThrow();
    expect(Buffer.byteLength(r.responseBody)).toBeLessThanOrEqual(1000 + 20); // Some slack for marker
  });
});
