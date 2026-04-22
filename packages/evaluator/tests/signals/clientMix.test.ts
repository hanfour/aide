import { describe, it, expect } from "vitest";
import { collectClientMix } from "../../src/signals/clientMix";
import type { BodyRow } from "../../src/signals/types";

function makeBody(clientUserAgent: string | null): BodyRow {
  return {
    requestId: "req-1",
    stopReason: null,
    clientUserAgent,
    clientSessionId: null,
    requestParams: null,
    responseBody: null,
    requestBody: null,
  };
}

describe("collectClientMix", () => {
  it("returns hit:false and value:0 when bodies is empty", () => {
    const r = collectClientMix({ bodies: [], expect: ["claude-code"], minRatio: 0.5 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("classifies 'Claude-Code/1.0.0' UA as claude-code bucket", () => {
    const bodies = [makeBody("Claude-Code/1.0.0"), makeBody("Claude-Code/1.0.0")];
    const r = collectClientMix({ bodies, expect: ["claude-code"], minRatio: 1.0 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(1);
  });

  it("classifies UA containing 'cursor' as cursor bucket (case-insensitive)", () => {
    const bodies = [makeBody("Cursor/0.40"), makeBody("other-agent")];
    const r = collectClientMix({ bodies, expect: ["cursor"], minRatio: 0.5 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(0.5);
  });

  it("classifies 'anthropic-ai/sdk' as raw-sdk bucket", () => {
    const bodies = [
      makeBody("anthropic-ai/sdk 0.20"),
      makeBody("anthropic-sdk/1.0"),
      makeBody("python-anthropic/1.0"),
    ];
    const r = collectClientMix({ bodies, expect: ["raw-sdk"], minRatio: 0.9 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(1);
  });

  it("classifies unknown UA as 'other' bucket", () => {
    const bodies = [makeBody("my-custom-agent/1.0"), makeBody(null)];
    const r = collectClientMix({ bodies, expect: ["other"], minRatio: 1.0 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(1);
  });

  it("returns hit:false when none of the expected buckets meet minRatio", () => {
    const bodies = [
      makeBody("Claude-Code/1.0"),
      makeBody("random-agent"),
      makeBody("random-agent"),
    ];
    const r = collectClientMix({ bodies, expect: ["cursor"], minRatio: 0.5 });
    expect(r.hit).toBe(false);
    expect(r.value).toBe(0);
  });

  it("returns highest ratio among multiple expected buckets", () => {
    const bodies = [
      makeBody("Claude-Code/1.0"),
      makeBody("Claude-Code/1.0"),
      makeBody("cursor/1.0"),
    ];
    const r = collectClientMix({ bodies, expect: ["claude-code", "cursor"], minRatio: 0.3 });
    expect(r.hit).toBe(true);
    // claude-code ratio = 2/3, cursor ratio = 1/3 → highest = 2/3
    expect(r.value).toBeCloseTo(0.667, 2);
  });

  it("substring match 'claude-code' in middle of UA string", () => {
    const bodies = [makeBody("my-wrapper/claude-code-v2")];
    const r = collectClientMix({ bodies, expect: ["claude-code"], minRatio: 1.0 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(1);
  });
});
