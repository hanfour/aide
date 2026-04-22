import { describe, it, expect } from "vitest";
import { collectToolDiversity } from "../../src/signals/toolDiversity";
import type { BodyRow } from "../../src/signals/types";

function makeBody(responseBody: unknown): BodyRow {
  return {
    requestId: "req-1",
    stopReason: null,
    clientUserAgent: null,
    clientSessionId: null,
    requestParams: null,
    responseBody,
    requestBody: null,
  };
}

describe("collectToolDiversity", () => {
  it("returns hit:false and value:0 when bodies is empty", () => {
    const r = collectToolDiversity({ bodies: [], gte: 1 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("returns hit:false and value:0 when responseBody has no tool_use entries", () => {
    const bodies = [
      makeBody({ content: [{ type: "text", text: "hello" }] }),
      makeBody(null),
      makeBody("not-an-object"),
    ];
    const r = collectToolDiversity({ bodies, gte: 1 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("counts 1 distinct tool name", () => {
    const bodies = [
      makeBody({
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: {} },
          { type: "text", text: "done" },
        ],
      }),
    ];
    const r = collectToolDiversity({ bodies, gte: 1 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(1);
  });

  it("counts 3 distinct tool names across multiple bodies", () => {
    const bodies = [
      makeBody({
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: {} },
          { type: "tool_use", id: "t2", name: "write_file", input: {} },
        ],
      }),
      makeBody({
        content: [
          { type: "tool_use", id: "t3", name: "bash", input: {} },
          { type: "tool_use", id: "t4", name: "read_file", input: {} },
        ],
      }),
    ];
    const r = collectToolDiversity({ bodies, gte: 3 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(3);
  });

  it("handles missing or non-array content field gracefully", () => {
    const bodies = [
      makeBody({}),
      makeBody({ content: null }),
      makeBody({ content: "not-an-array" }),
    ];
    const r = collectToolDiversity({ bodies, gte: 1 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });
});
