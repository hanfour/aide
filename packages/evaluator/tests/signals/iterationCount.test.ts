import { describe, it, expect } from "vitest";
import { collectIterationCount } from "../../src/signals/iterationCount";
import type { BodyRow } from "../../src/signals/types";

function makeBody(
  clientSessionId: string | null,
  messages: Array<{ role: string; content: unknown }> | null | unknown,
): BodyRow {
  return {
    requestId: "req-" + Math.random(),
    stopReason: null,
    clientUserAgent: null,
    clientSessionId,
    requestParams: null,
    responseBody: null,
    requestBody: messages === null ? null : { messages },
  };
}

describe("collectIterationCount", () => {
  it("returns hit:false and value:0 when bodies is empty", () => {
    const r = collectIterationCount({ bodies: [], gte: 1 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("counts a single-turn session (2 messages = 1 turn)", () => {
    const bodies = [
      makeBody("session-1", [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]),
    ];
    const r = collectIterationCount({ bodies, gte: 1 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(1);
  });

  it("counts a multi-turn session (6 messages = 3 turns)", () => {
    // The body with the longest messages array represents the final state of the session
    const bodies = [
      makeBody("session-1", [
        { role: "user", content: "msg1" },
        { role: "assistant", content: "resp1" },
        { role: "user", content: "msg2" },
        { role: "assistant", content: "resp2" },
        { role: "user", content: "msg3" },
        { role: "assistant", content: "resp3" },
      ]),
    ];
    const r = collectIterationCount({ bodies, gte: 3 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(3);
  });

  it("picks max turn count across multiple sessions", () => {
    const bodies = [
      makeBody("session-a", [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ]),
      makeBody("session-b", [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3" },
        { role: "assistant", content: "a3" },
      ]),
    ];
    const r = collectIterationCount({ bodies, gte: 3 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(3);
  });

  it("treats null sessionId bodies as standalone 1-turn sessions", () => {
    const bodies = [
      makeBody(null, [{ role: "user", content: "standalone" }]),
      makeBody(null, [{ role: "user", content: "another" }]),
    ];
    const r = collectIterationCount({ bodies, gte: 1 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(1);
  });

  it("handles malformed requestBody gracefully (null, no messages, non-array messages)", () => {
    const bodies = [
      makeBody("session-1", null),
      {
        requestId: "req-bad",
        stopReason: null,
        clientUserAgent: null,
        clientSessionId: "session-2",
        requestParams: null,
        responseBody: null,
        requestBody: { messages: "not-an-array" },
      } satisfies BodyRow,
      {
        requestId: "req-bad2",
        stopReason: null,
        clientUserAgent: null,
        clientSessionId: "session-3",
        requestParams: null,
        responseBody: null,
        requestBody: {},
      } satisfies BodyRow,
    ];
    const r = collectIterationCount({ bodies, gte: 1 });
    // All malformed: each session has 0 turns; max = 0
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("for a session with multiple bodies, uses longest messages array across entries", () => {
    const bodies = [
      makeBody("session-1", [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ]),
      makeBody("session-1", [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
      ]),
    ];
    const r = collectIterationCount({ bodies, gte: 2 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(2);
  });
});
