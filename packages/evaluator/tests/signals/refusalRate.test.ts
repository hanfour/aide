import { describe, it, expect } from "vitest";
import { collectRefusalRate } from "../../src/signals/refusalRate";
import type { BodyRow } from "../../src/signals/types";

function makeBody(stopReason: string | null): BodyRow {
  return {
    requestId: "req-1",
    stopReason,
    clientUserAgent: null,
    clientSessionId: null,
    requestParams: null,
    responseBody: null,
    requestBody: null,
  };
}

describe("collectRefusalRate", () => {
  it("returns hit:true and value:1 when all bodies are refusals", () => {
    const bodies: BodyRow[] = [
      makeBody("refusal"),
      makeBody("refusal"),
    ];
    const r = collectRefusalRate({ bodies, lte: 1 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(1);
  });

  it("returns hit:true and value:0 when no bodies are refusals", () => {
    const bodies: BodyRow[] = [
      makeBody("end_turn"),
      makeBody("max_tokens"),
    ];
    const r = collectRefusalRate({ bodies, lte: 0.5 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(0);
  });

  it("computes ratio correctly for mixed stop reasons", () => {
    const bodies: BodyRow[] = [
      makeBody("refusal"),
      makeBody("end_turn"),
      makeBody("end_turn"),
      makeBody("end_turn"),
    ];
    const r = collectRefusalRate({ bodies, lte: 0.3 });
    expect(r.hit).toBe(true);
    expect(r.value).toBeCloseTo(0.25);
  });

  it("returns hit:false when ratio exceeds lte", () => {
    const bodies: BodyRow[] = [
      makeBody("refusal"),
      makeBody("refusal"),
      makeBody("end_turn"),
    ];
    const r = collectRefusalRate({ bodies, lte: 0.5 });
    expect(r.hit).toBe(false);
    expect(r.value).toBeCloseTo(0.667, 2);
  });

  it("returns hit:true and value:0 when bodies array is empty", () => {
    const r = collectRefusalRate({ bodies: [], lte: 0.5 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(0);
  });

  it("only counts literal 'refusal' as refusal (not other stop reasons)", () => {
    const bodies: BodyRow[] = [
      makeBody("stop"),
      makeBody(null),
      makeBody("end_turn"),
    ];
    const r = collectRefusalRate({ bodies, lte: 0.1 });
    expect(r.hit).toBe(true);
    expect(r.value).toBe(0);
  });
});
