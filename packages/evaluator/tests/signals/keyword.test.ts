import { describe, it, expect } from "vitest";
import { collectKeyword } from "../../src/signals/keyword";

describe("collectKeyword", () => {
  it("finds case-insensitive match and captures ±80 chars context", () => {
    const body = "This is a long request about OPTIONS and alternatives.";
    const r = collectKeyword({ body, terms: ["options"] });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(1);
    expect(r.evidence.length).toBe(1);
    expect(r.evidence[0]!.quote).toContain("OPTIONS");
  });

  it("respects caseSensitive flag", () => {
    const body = "Keyword TEST here";
    const insensitive = collectKeyword({ body, terms: ["test"] });
    const sensitive = collectKeyword({
      body,
      terms: ["test"],
      caseSensitive: true,
    });
    expect(insensitive.hit).toBe(true);
    expect(sensitive.hit).toBe(false);
  });

  it("returns no hit and empty evidence when body is empty", () => {
    const r = collectKeyword({ body: "", terms: ["x"] });
    expect(r.hit).toBe(false);
    expect(r.evidence.length).toBe(0);
  });

  it("counts multiple occurrences of same term", () => {
    const body = "foo foo foo bar";
    const r = collectKeyword({ body, terms: ["foo"] });
    expect(r.value).toBe(3);
  });

  it("finds all terms across multiple search passes", () => {
    const body = "alpha beta gamma";
    const r = collectKeyword({ body, terms: ["alpha", "gamma"] });
    expect(r.value).toBe(2);
  });

  it("attaches requestId to evidence when provided", () => {
    const r = collectKeyword({
      body: "has foo",
      terms: ["foo"],
      requestId: "req-123",
    });
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.evidence[0]!.requestId).toBe("req-123");
  });
});
